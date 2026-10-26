package com.dsharnessmobile.shell

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Rect
import android.os.Build
import android.os.IBinder
import android.view.MotionEvent
import android.view.SurfaceControlViewHost
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/**
 * BrowserHost 的兼容档执行位（tier-2，process-suffix）：持有 :browser 渲染进程的
 * 绑定连接、每个 tab 的 SurfacePackage、宿主 SurfaceView 与手动输入转发。
 *
 * 生命周期：构造即发起绑定（仅当 MULTI_PROFILE 缺位且 API>=29 时由 BrowserHost 创建）；
 * 绑定完成后 start() 下发受保护引擎端口快照；引擎换代时 BrowserHost 调 refreshEndpoint()
 * 重发。进程死亡走 onServiceDisconnected → 状态退回 unbound，由 BrowserHost 决定重连。
 *
 * 输入（spike 实锤：原生 child-surface 转发不生效）：宿主 SurfaceView 的触摸经
 * [forwardMotion] 换算成远端视图坐标后跨 Binder 重放；坐标换算 = 平移宿主矩形原点 +
 * 缩放到该 tab 投影尺寸。
 *
 * 线程模型：触摸转发 [forwardMotion] 是 oneway（issue #540）——宿主 SurfaceView 的触摸
 * 回调只做一次非阻塞 Binder 投递就返回，**不再有 UI 线程上的同步 Binder 往返**；触摸回调
 * 恒返回「已消费」，投递是否真被远端处理不可知（合帧与重放由渲染进程负责）。其余原语
 * （evaluateJs/dispatchTap/dispatchKey/capture/tabState）仍同步执行，因为它们需要回执。
 * 回调到达 binder 线程后立即转存，派发统一走构造时给定的 listener（由 BrowserHost 指定
 * 线程语义）。
 */
internal class RemoteRendererHost(
  context: Context,
  private val allowAnonymousEngineAccess: Boolean,
  private val listener: Listener,
) : IBrowserRendererCallback.Stub() {

  interface Listener {
    /** 页面事件（JSON，type=pageStarted|pageFinished|title|loadError|sslError|renderGone|scroll）。 */
    fun onRendererEvent(tabId: String, event: JSONObject)

    /** evaluateJs 结果（seq 对应请求序号）。 */
    fun onRendererJsResult(tabId: String, seq: Int, result: JSONObject)
  }

  companion object {
    private const val BIND_TIMEOUT_S = 12L
  }

  private val appContext = context.applicationContext
  @Volatile var renderer: IBrowserRenderer? = null
    private set
  @Volatile var binding = false
    private set
  private var connection: ServiceConnection? = null

  /**
   * 绑定就绪闸门。M-r1（2026-10-25 审计）：**每次 connect 重建**——CountDownLatch 是一次性的，
   * 旧实现首个实例 countDown 之后永远敞开，此后 disconnect→connect 的 awaitBound 会立即
   * 返回 true（哪怕新一次 bindService 失败），把「没绑上」谎报成「绑上了」。
   */
  @Volatile private var bindLatch = CountDownLatch(1)

  /** tabId → 最新投影句柄（远端每次 ensureTab/relayout 后刷新）。 */
  val surfacePackages = ConcurrentHashMap<String, SurfaceControlViewHost.SurfacePackage>()

  /** tabId → 投影尺寸（px），输入坐标换算用。 */
  val projectionSizes = ConcurrentHashMap<String, Pair<Int, Int>>()

  private val jsSeq = AtomicInteger(1)

  /** 宿主 SurfaceView（由 BrowserHost 挂进 root；本类负责触摸转发）。 */
  var hostSurface: SurfaceView? = null
    private set

  val ready: Boolean get() = renderer != null

  // ── 绑定与握手 ────────────────────────────────────────────────────────

  @Synchronized fun connect(onBound: () -> Unit = {}) {
    if (renderer != null || binding) return
    binding = true
    // M-r1：新一次绑定使用新闸门（旧闸门可能已被上一轮 countDown 永久敞开）。
    bindLatch = CountDownLatch(1)
    // #13（2026-10-25 审计）：若上一条 ServiceConnection 仍在（重连/竞态路径），先解绑再建新
    // 连接——否则每次重连泄漏一条旧绑定，且服务重启时旧回调会再次投递。
    connection?.let { stale -> runCatching { appContext.unbindService(stale) } }
    val conn = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        renderer = IBrowserRenderer.Stub.asInterface(service)
        binding = false
        bindLatch.countDown()
        runCatching {
          renderer?.start(this@RemoteRendererHost, startConfig())
        }
        // #13：BIND_AUTO_CREATE 下渲染进程死亡后系统会重启服务并**重新投递本回调**——
        // 把「回来了」的事实播报给宿主，让它清掉断线时烙下的降级标记；没有这一条，
        // 自动恢复的绑定也救不回已降级的面板（直到重启应用）。
        listener.onRendererEvent("", JSONObject().put("type", "rendererConnected"))
        onBound()
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        renderer = null
        releaseSurfacePackages()
        projectionSizes.clear()
        listener.onRendererEvent("", JSONObject().put("type", "rendererDisconnected"))
      }
    }
    connection = conn
    val ok = appContext.bindService(
      Intent(appContext, BrowserProcessService::class.java),
      conn,
      Context.BIND_AUTO_CREATE,
    )
    if (!ok) {
      binding = false
      connection = null
    }
  }

  /**
   * 丢弃全部投影句柄。M-r2（2026-10-25 审计）：SurfacePackage 持有跨进程 Surface 资源，
   * 旧实现只 `clear()` 表——native 句柄不释放，渲染进程侧的 buffer 生产者也停不下来
   * （直到 GC 玄学回收）。API 33+ 有显式 [SurfaceControlViewHost.SurfacePackage.release]。
   */
  private fun releaseSurfacePackages() {
    if (Build.VERSION.SDK_INT >= 33) {
      for (pkg in surfacePackages.values) runCatching { pkg.release() }
    }
    surfacePackages.clear()
  }

  /** 引擎换代/首绑时下发受保护端口快照（未确认=0，渲染进程将拒绝一切引擎端口回环）。 */
  fun refreshEndpoint() {
    renderer?.let { runCatching { it.start(this, startConfig()) } }
  }

  private fun startConfig(): String = JSONObject()
    .put("allowAnonymousEngineAccess", allowAnonymousEngineAccess)
    .put("enginePort", EngineEndpoint.port)
    .toString()

  fun awaitBound(timeoutS: Long = BIND_TIMEOUT_S): Boolean = bindLatch.await(timeoutS, TimeUnit.SECONDS)

  fun disconnect() {
    connection?.let { runCatching { appContext.unbindService(it) } }
    connection = null
    renderer = null
    releaseSurfacePackages()
    projectionSizes.clear()
  }

  // ── 回调（binder 线程）───────────────────────────────────────────────

  override fun onSurfacePackage(tabId: String?, pkg: SurfaceControlViewHost.SurfacePackage?) {
    if (tabId != null && pkg != null) {
      surfacePackages[tabId] = pkg
      hostSurface?.let { surface -> surface.post { surface.setChildSurfacePackage(pkg) } }
    }
  }

  override fun onEvent(tabId: String?, eventJson: String?) {
    if (tabId != null && eventJson != null) listener.onRendererEvent(tabId, JSONObject(eventJson))
  }

  override fun onJsResult(tabId: String?, seq: Int, resultJson: String?) {
    if (tabId != null && seq != 0 && resultJson != null) {
      listener.onRendererJsResult(tabId, seq, JSONObject(resultJson))
    }
  }

  // ── 宿主面 ──────────────────────────────────────────────────────────

  /** 把宿主 SurfaceView 挂到 root（置底，应用覆盖层在其上）；触摸经本类转发。 */
  fun attachHostSurface(root: ViewGroup) {
    if (hostSurface?.parent === root) return
    detachHostSurface()
    // SurfaceView 默认位于窗口内容之下（Z-ordered below），正是需要的投影档；
    // 触摸由本类经 AIDL 转发（原生 child-surface 转发不生效，spike 实锤）。
    val surface = SurfaceView(appContext).apply {
      setOnTouchListener { _, event -> forwardMotionOfActiveTab(this, event) }
    }
    root.addView(surface, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    hostSurface = surface
  }

  fun detachHostSurface() {
    hostSurface?.let { surface ->
      surface.visibility = View.INVISIBLE
      (surface.parent as? ViewGroup)?.removeView(surface)
    }
    hostSurface = null
  }

  /** 显示指定 tab 的投影（换包 + SurfaceView 可见）。 */
  fun showTab(tabId: String) {
    surfacePackages[tabId]?.let { pkg -> hostSurface?.post {
      hostSurface?.setChildSurfacePackage(pkg)
      hostSurface?.setVisibility(View.VISIBLE)
    } }
  }

  fun hideSurface() {
    // setChildSurfacePackage(null) 编译面不接受 null、clearChildSurfacePackage 仅 API 31+；
    // 用可见性开关隐藏（SurfaceView 不可见即不打洞不显示子面），全 API 适用。
    hostSurface?.setVisibility(View.INVISIBLE)
  }

  /** 记录该 tab 的投影几何（ensureTab/relayout 后由 BrowserHost 同步），供输入换算。 */
  fun setProjectionSize(tabId: String, widthPx: Int, heightPx: Int) {
    projectionSizes[tabId] = widthPx to heightPx
  }

  // ── 输入转发 ────────────────────────────────────────────────────────

  /** 宿主 SurfaceView 收到的触摸 → 换算到「当前投影 tab」的视图坐标 → 远端重放。 */
  private var activeInputTab: String? = null

  fun setActiveInputTab(tabId: String?) {
    activeInputTab = tabId
  }

  private fun forwardMotionOfActiveTab(surface: SurfaceView, event: MotionEvent): Boolean {
    val tabId = activeInputTab ?: return false
    val api = renderer ?: return false
    // 没有投影尺寸就无法换算坐标，这类事件只能留给上层（返回 false 表示未消费）。
    val size = projectionSizes[tabId] ?: return false
    val rect = visibleRect(surface)
    if (rect.isEmpty || rect.width() <= 0 || rect.height() <= 0) return false
    val mapped = MotionEvent.obtain(event)
    try {
      mapped.offsetLocation(-rect.left.toFloat(), -rect.top.toFloat())
      val scaleX = size.first.toFloat() / rect.width()
      val scaleY = size.second.toFloat() / rect.height()
      mapped.setLocation(mapped.x * scaleX, mapped.y * scaleY)
      // oneway：投递即返回，没有返回值可读（Binder 已死才可能抛异常，异常也只吞掉）。
      runCatching {
        api.forwardMotion(
          tabId, mapped.actionMasked, mapped.downTime, mapped.eventTime,
          mapped.x, mapped.y, mapped.pressure, mapped.size, mapped.metaState,
        )
      }
    } finally {
      mapped.recycle()
    }
    // 有 tabId 且拿到投影尺寸就按「已消费」返回：一次 MOVE 若回 false，系统会认为
    // 本次手势被放弃，后续 MOVE 直接不再派发——手势就断在半路。
    return true
  }

  private fun visibleRect(surface: View): Rect {
    val rect = Rect()
    val location = IntArray(2)
    surface.getLocationInWindow(location)
    rect.set(location[0], location[1], location[0] + surface.width, location[1] + surface.height)
    return rect
  }

  // ── 原语透传（BrowserHost 在主线程调用）──────────────────────────────

  fun nextSeq(): Int = jsSeq.incrementAndGet()

  fun evaluateJs(tabId: String, script: String, seq: Int): Boolean =
    runCatching { renderer?.evaluateJs(tabId, script, seq) == true }.getOrDefault(false)

  fun dispatchTap(tabId: String, x: Float, y: Float): Boolean =
    runCatching { renderer?.dispatchTap(tabId, x, y) == true }.getOrDefault(false)

  fun dispatchKey(tabId: String, keyCode: Int): Boolean =
    runCatching { renderer?.dispatchKey(tabId, keyCode) == true }.getOrDefault(false)

  /**
   * 截图 → 字节（自建管道、读远端 PNG；失败回 null）。
   *
   * 读端必须与 `capture` 的 binder 调用**并发**跑（issue #607 修）：远端在调用内同步
   * `bitmap.compress` 写管道，而管道缓冲只有 64KiB——「先等 capture 返回、再开始读」会让
   * 远端写阻塞在半途、宿主等 binder 永不读，双端互等（宿主主线程随即 ANR）。
   *
   * 每个出口（成功 / 回执失败 / 异常 / join 超时 / 被中断）都必须把读线程和两个文件描述符
   * 一起收干净：远端在回执失败或超时放弃后**仍可能持有写端**，直接 return 会把它留成孤儿
   * 读线程，每失败一次积一个线程加一对 fd。取消有界与轮询细节见 [CapturePipeDrain]。
   */
  fun capturePng(tabId: String, maxWidth: Int, maxHeight: Int): ByteArray? = runCatching {
    val api = renderer ?: return@runCatching null
    val pipe = android.os.ParcelFileDescriptor.createPipe()
    val readerStream = android.os.ParcelFileDescriptor.AutoCloseInputStream(pipe[0])
    // 空闲排空（30s）是失败/超时路径的保险丝：接不到任何新字节就放弃读线程，
    // 不顺带拒绝「回执为真但 PNG 为 0 字节」这种正常情形。
    val drained = CapturePipeDrain.drain(
      read = { buffer, cancelled ->
        val poll = android.system.StructPollfd().apply {
          fd = pipe[0].fileDescriptor
          events = (android.system.OsConstants.POLLIN or android.system.OsConstants.POLLHUP).toShort()
        }
        var idleMs = 0L
        while (!cancelled.get()) {
          val ready = android.system.Os.poll(arrayOf(poll), CapturePipeDrain.POLL_INTERVAL_MS)
          if (ready < 0) throw java.io.IOException("capture pipe poll failed")
          if (ready > 0 || cancelled.get()) break
          idleMs += CapturePipeDrain.POLL_INTERVAL_MS.toLong()
          if (idleMs >= CapturePipeDrain.DEFAULT_JOIN_TIMEOUT_MS) throw java.io.IOException("capture pipe idle timeout")
        }
        if (cancelled.get()) return@drain CapturePipeDrain.EOF
        val errors = android.system.OsConstants.POLLERR or android.system.OsConstants.POLLNVAL
        if (poll.revents.toInt() and errors != 0) throw java.io.IOException("capture pipe failed")
        readerStream.read(buffer)
      },
      // 宿主自己的写端：capture 一返回就得关，否则读端永远等不到 EOF。
      closeWriter = { runCatching { pipe[1].close() } },
      // 收尾时再关一次写端（幂等）并放掉读端，打断轮询中的读线程。
      closeReader = {
        runCatching { pipe[1].close() }
        runCatching { readerStream.close() }
      },
      startCapture = { api.capture(tabId, pipe[1], maxWidth, maxHeight) },
    )
    // 空载荷判据来自 #582 的既有语义（回执为真却拿到 0 字节按失败处理），本 PR 只做线程与
    // 描述符回收，**没有**改这个语义——下面这条 takeIf 在 #582 之前就在线上了。
    drained?.takeIf { it.isNotEmpty() }
  }.getOrNull()

  /** tab 状态快照（JSON；远端不可达回 null）。 */
  fun tabState(tabId: String): JSONObject? = runCatching {
    renderer?.tabState(tabId)?.let { JSONObject(it) }
  }.getOrNull()
}
