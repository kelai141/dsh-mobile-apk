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
  private val bindLatch = CountDownLatch(1)

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
    val conn = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        renderer = IBrowserRenderer.Stub.asInterface(service)
        binding = false
        bindLatch.countDown()
        runCatching {
          renderer?.start(this@RemoteRendererHost, startConfig())
        }
        onBound()
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        renderer = null
        surfacePackages.clear()
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
    surfacePackages.clear()
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

  /** 截图 → 字节（自建管道、读远端 PNG；失败回 null）。 */
  fun capturePng(tabId: String, maxWidth: Int, maxHeight: Int): ByteArray? = runCatching {
    val api = renderer ?: return@runCatching null
    val pipe = android.os.ParcelFileDescriptor.createPipe()
    try {
      if (!api.capture(tabId, pipe[1], maxWidth, maxHeight)) return@runCatching null
    } finally {
      pipe[1].close()
    }
    java.io.FileInputStream(pipe[0].fileDescriptor).use { it.readBytes() }
  }.getOrNull()

  /** tab 状态快照（JSON；远端不可达回 null）。 */
  fun tabState(tabId: String): JSONObject? = runCatching {
    renderer?.tabState(tabId)?.let { JSONObject(it) }
  }.getOrNull()
}
