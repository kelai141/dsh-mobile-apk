package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.DisplayMetrics
import android.view.WindowManager
import android.util.Log
import android.view.Display
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject

/**
 * App-owned PUBLIC VirtualDisplay lifecycle with a live display registry.
 *
 * The display is created in the ordinary app process so its output surface remains app-owned. The
 * Shizuku UserService is still required before creation because it is the only supported transport
 * for later cross-display launch/input/task actions. No virtual alias ever maps to display 0.
 *
 * 0.14.0 batch: the controller now owns a realtime [screenRegistry] (DisplayManager truth plus
 * stable product aliases), a controller-owned [selectedAlias], and independent per-viewer bounds
 * records. A viewer Surface is never silently attached to two viewers: the first viewer that binds
 * a target owns it until it releases, and a second viewer gets `viewer-target-occupied`.
 */
object VdisplayController {
  private const val TAG = "dsh-vdisplay"
  private const val FLAG_PUBLIC = 1 shl 0
  /** 非系统应用创建虚拟屏的**必备** flag（缺它会被当作镜像而索要投屏权限）。见 create() 注释。 */
  private const val FLAG_OWN_CONTENT_ONLY = 1 shl 3
  private const val FLAG_SUPPORTS_TOUCH = 1 shl 6
  private const val FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8
  private const val DEFAULT_WIDTH = 480
  private const val DEFAULT_HEIGHT = 800
  /** 本版上限 1 屏（0.14.0 用户拍板）；多屏设计保留（MAX 提高即可放开）。 */
  private const val MAX_VIRTUAL_DISPLAYS = 1
  private const val MIN_EDGE = 240
  private const val MAX_EDGE = 4096

  /**
   * 跨屏拉起的落点回读命令（**固定字面量**：不含任何模型可控文本，故可经 `sh -c` 执行）。
   *
   * 为什么必须服务端过滤（2026-09-19 设备实测）：直接 `dumpsys activity activities` 有 42 KB，
   * 会被 `ShizukuUserService` 的 16 KiB stdout 上限截断；而 display 段按号**递增**排列
   * ⇒ 截断掉的恰好是虚拟屏那一段，回读会得出「没落在虚拟屏」的**反向错误结论**。
   * 过滤后实测 1,969 B（保留 `Display #<n>` 分组锚点与 `ActivityRecord` 行）。
   */
  private const val ACTIVITY_DISPLAY_PROBE =
    "dumpsys activity activities | grep -E '^ *Display #|ActivityRecord'"
  /** 随内容旋转：游戏等强制横屏应用在虚拟屏上真横屏运行（VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT）。 */
  private const val FLAG_ROTATES_WITH_CONTENT = 1 shl 7

  /** One owned VirtualDisplay plus its fallback output and viewer ownership. */
  private class Record(
    val alias: String,
    val display: VirtualDisplay,
    val reader: ImageReader,
    val thread: HandlerThread,
    val width: Int,
    val height: Int,
    val densityDpi: Int,
    var viewerId: String? = null,
    var viewerSurface: Surface? = null,
    /** 归属会话（0.14.0 按会话隔离：每块屏只服务创建它的会话）。 */
    val owner: String? = null,
    /** 最近一次被本会话使用（创建/选择/启动/取树）的时间戳，供空闲回收判定。 */
    var lastUsedAt: Long = android.os.SystemClock.elapsedRealtime(),
  )

  private val lock = Any()
  private val records = LinkedHashMap<String, Record>()
  // 序号不再是单调计数器：分配时扫描最小空闲号（见 create 内的分配逻辑）。
  /** 会话归属（0.14.0）：建屏时绑定发起会话；非归属会话的生命周期操作一律拒绝。 */
  private var ownerSessionId: String? = null
  /** Controller-owned presentation target; only an owned virtual alias can be selected. */
  private var selectedAlias: String? = null

  /**
   * 空闲回收（0.14.0 用户要求：「对话数分钟不运行且虚拟屏无操作则 kill 掉，否则一直占用资源」）。
   *
   * 为什么必须有：虚拟屏是**真实系统资源**——一块 VirtualDisplay 会持有一个 display、一个
   * ImageReader、一个 HandlerThread，并在系统里长期占位。此前**没有任何回收路径**：
   * 只有显式 vdDestroy 或设置页强制销毁才会释放。对话被关闭/AI 不再操作后，它们会一直挂着。
   *
   * 判定口径：以「最后一次被本会话使用」为基准（创建/选择/启动/取树都会刷新）。
   * 阈值取 10 分钟——足够长，不会打断正常的多轮操作；足够短，不会让废弃会话长期占资源。
   */
  private const val IDLE_RECLAIM_MS = 10 * 60 * 1000L

  /** 刷新某块屏（或全部）的使用时间；由所有会「用到屏」的操作调用。 */
  private fun touch(alias: String?) = synchronized(lock) {
    val now = android.os.SystemClock.elapsedRealtime()
    if (alias == null) records.values.forEach { it.lastUsedAt = now }
    else records[alias]?.lastUsedAt = now
  }

  /**
   * 回收空闲虚拟屏。返回被回收的别名列表（供调用方记日志/回报）。
   *
   * 由宿主（MainActivity 的周期任务）调用；也可在每次控制 op 入口顺手调用（低成本）。
   */
  fun reclaimIdle(context: Context): List<String> = synchronized(lock) {
    val now = android.os.SystemClock.elapsedRealtime()
    val stale = records.values.filter { now - it.lastUsedAt >= IDLE_RECLAIM_MS }.map { it.alias }
    for (alias in stale) {
      val record = records.remove(alias) ?: continue
      runCatching { record.display.release() }
      runCatching { record.reader.close() }
      runCatching { record.thread.quitSafely() }
      record.viewerId?.let { viewerBounds.remove(it) }
      Log.i(TAG, "reclaimed idle alias=$alias (idle ${(now - record.lastUsedAt) / 1000}s)")
    }
    if (stale.isNotEmpty()) {
      if (selectedAlias != null && !records.containsKey(selectedAlias)) selectedAlias = records.keys.firstOrNull()
      if (records.isEmpty()) ownerSessionId = null
      generation += 1
      lastCode = "vdisplay-reclaimed"
      lastGuidance = "已回收空闲虚拟屏：${stale.joinToString(", ")}（${IDLE_RECLAIM_MS / 60000} 分钟未使用）。"
    }
    stale
  }
  /** Independent bounds record per viewer id (no shared global geometry). */
  private val viewerBounds = LinkedHashMap<String, JSONObject>()
  private var generation = 0L
  private var lastCode = "vdisplay-idle"
  private var lastGuidance = "虚拟屏尚未创建。"

  /** Android display id of one owned virtual display (VirtualDisplay.getDisplay().getDisplayId()). */
  private val Record.displayId: Int get() = this.display.display.displayId

  private fun ops(): JSONArray = JSONArray(listOf("vdCreate", "vdDestroy", "vdLaunch", "vdMoveTask", "vdInfo"))

  /** Owned record for one alias, or null. */
  private fun recordOf(alias: String?): Record? = synchronized(lock) {
    if (alias == null) return null
    records[alias]
  }

  /** Android display id for one owned virtual alias, or null when the alias is unknown/not owned. */
  fun displayIdForAlias(alias: String?): Int? = synchronized(lock) {
    if (alias == null) return null
    // #671：按别名取屏 = 本会话正在使用这块屏（a11y 操作/launch 落点），刷新空闲计时——
    // 旧实现 touch() 全仓零调用，空闲回收退化为「建屏后 10 分钟必回收」。
    touch(alias)
    records[alias]?.displayId
  }

  /** Owned alias for one virtual Android display id, or null. Never maps display 0. */
  fun aliasForDisplayId(displayId: Int): String? = synchronized(lock) {
    if (displayId == Display.DEFAULT_DISPLAY) return null
    val hit = records.values.firstOrNull { it.displayId == displayId }?.alias
    hit?.let { touch(it) }
    hit
  }

  /** Owned virtual aliases ordered by allocation (the model-facing `virtual-N` set). */
  fun activeAliases(): List<String> = synchronized(lock) { records.keys.toList() }

  /**
   * 某虚拟屏的**内容尺寸**（虚拟屏自己的像素宽高）。
   *
   * 为什么宿主侧需要它：虚拟屏按等比例缩放创建（默认 0.5 → 约为真实屏的一半），其宽高比与
   * 侧栏舞台的宽高比**通常不同**（实测 360x640 对 434x682）。把 SurfaceView 直接撑满舞台会
   * 让内容只渲染在自己那部分、右侧/下方留出黑边（用户报「未自动拉伸适配」+「黑边」）。
   * 正确做法 = 按**内容宽高比**在舞台内等比放大并居中（letterbox 反向：能填满就填满，
   * 不拉伸变形）。
   */
  fun contentSizeForAlias(alias: String?): Pair<Int, Int>? {
    // 锁内只做 record 选择（Display 活值查询可能触碰 binder，绝不放 controller 锁内）。
    // 兜底顺序（0.14.0 设备实锤修正）：`alias` 来自**页面**上报的 `snap.selected`，在面板刚打开、
    // 状态还没拉到、或该屏刚被销毁时会为空/失效。此前直接返回 null，宿主侧 `applyStageBounds()`
    // 便退回「按舞台宽高比」拉伸 → 用户看到的「自适应缩放不对 / 黑边」。
    //
    // 内容宽高比与「谁被选中」无关，只与「哪块屏存在」有关，所以这里按
    // 指定别名 → 当前选中 → 唯一活跃屏 依次退化；只要本机还有虚拟屏，就能给出正确的宽高比。
    val record = synchronized(lock) {
      val hit = (alias?.let { records[it] })
        ?: records[selectedAlias]
        ?: records.values.firstOrNull()
        ?: return null
      // #671：宿主正在渲染这块屏的内容 = 使用中，刷新空闲计时。
      touch(hit.alias)
      hit
    }
    return liveOrSnapshotSize(record)
  }

  private fun selectedRecord(): Record? = synchronized(lock) { records[selectedAlias] }

  /**
   * Realtime display registry: every DisplayManager display with a stable product alias.
   *
   * `real` is the physical default display (id 0). Owned virtual displays get `virtual-N` aliases;
   * any other display (external/HDMI/overlay) gets `display-<id>`. Only owned virtual displays are
   * selectable presentation sources; the real screen is explicitly not mirrorable.
   */
  fun screens(context: Context): JSONArray {
    val manager = context.applicationContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val aliasRecord = synchronized(lock) { records.values.toList() }
    val out = JSONArray()
    for (display in manager.displays) {
      val id = display.displayId
      val owned = aliasRecord.firstOrNull { it.displayId == id }
      val alias = when {
        id == Display.DEFAULT_DISPLAY -> "real"
        owned != null -> owned.alias
        else -> "display-$id"
      }
      val kind = when {
        id == Display.DEFAULT_DISPLAY -> "physical"
        owned != null -> "virtual"
        (display.flags and Display.FLAG_PRESENTATION) != 0 -> "presentation"
        else -> "unknown"
      }
      val selectable = owned != null
      val reason = when {
        id == Display.DEFAULT_DISPLAY -> "真实屏幕是用户前台画面，不允许镜像或作为查看器目标。"
        owned != null -> UserCopy.APP_NAME + " 创建的虚拟屏，可作为查看器目标。"
        else -> "非 " + UserCopy.APP_NAME + " 创建的显示器没有受控输出 Surface，不能作为查看器目标。"
      }
      val metrics = DisplayMetrics()
      @Suppress("DEPRECATION")
      display.getRealMetrics(metrics)
      val viewerId = owned?.viewerId
      val state = runCatching { display.state }.getOrDefault(Display.STATE_UNKNOWN)
      out.put(
        JSONObject()
          .put("alias", alias)
          .put("displayId", id)
          .put("kind", kind)
          .put("label", if (id == Display.DEFAULT_DISPLAY) "真实屏幕" else "虚拟屏幕 " + alias.removePrefix("virtual-"))
          .put("state", when (state) {
            Display.STATE_ON -> "on"
            Display.STATE_OFF -> "off"
            Display.STATE_DOZE, Display.STATE_DOZE_SUSPEND -> "doze"
            else -> "unknown"
          })
          .put("width", metrics.widthPixels)
          .put("height", metrics.heightPixels)
          .put("densityDpi", metrics.densityDpi)
          .put("selectable", selectable)
          .put("reason", reason)
          .put("generation", synchronized(lock) { generation }),
      )
      if (viewerId != null) out.getJSONObject(out.length() - 1).put("viewerId", viewerId)
    }
    return out
  }

  /** Current public state for the Files-sidebar panel and controller responses. */
  fun status(context: Context): JSONObject {
    val appContext = context.applicationContext
    // 读路径解耦（0.14.0 缺陷修复）：设置页「刷新 Shizuku 状态」与面板轮询都走这里。
    // 若已授权但 UserService 尚未绑定，触发一次**后台**绑定并立即返回当前状态——下一次
    // 轮询（2s）即收敛为 ready。绝不在此阻塞等待（本函数在 UI/控制队列高频路径上）。
    ShizukuTransport.kickBind(appContext)
    val privileged = ShizukuTransport.status(appContext)
    val active = synchronized(lock) { records.values.toList() }
    val selected = synchronized(lock) { selectedAlias }
    val out = JSONObject()
      .put("enabled", true)
      .put("ops", ops())
      .put("transports", JSONArray(listOf("shizuku")))
      .put("generation", synchronized(lock) { generation })
      .put("screens", screens(context))
      .put("selected", selected ?: JSONObject.NULL)
      .put("ownerSessionId", ownerSessionId ?: "")
      .put("viewers", viewerStatus())
    val first = active.firstOrNull { it.alias == selected } ?: active.firstOrNull()
    if (first != null) {
      if (selected == null || records[selected] == null) {
        synchronized(lock) { selectedAlias = first.alias }
        out.put("selected", first.alias)
      }
      return out.put("ok", true).put("state", "active").put("code", "vdisplay-active")
        .put("displayId", first.displayId)
        .put("aliases", JSONArray(active.map { it.alias }))
        .put("guidance", "虚拟屏幕 ${first.alias.removePrefix("virtual-")} 已激活（Android displayId=${first.displayId}）。")
    }
    if (privileged.optBoolean("ok")) {
      return out.put("ok", true).put("state", "ready").put("code", "vdisplay-ready")
        .put("guidance", "Shizuku 已授权且 shell UserService 已就绪；可创建虚拟屏幕 1。")
    }
    return out.put("ok", false).put("state", "blocked")
      .put("code", privileged.optString("code", lastCode))
      .put("guidance", privileged.optString("guidance", lastGuidance))
  }

  /** Viewer ownership + independent bounds records, for the panel and for arbitration tests. */
  private fun viewerStatus(): JSONArray {
    val out = JSONArray()
    synchronized(lock) {
      for ((viewerId, bounds) in viewerBounds) {
        val owner = records.values.firstOrNull { it.viewerId == viewerId }
        out.put(
          JSONObject()
            .put("viewerId", viewerId)
            .put("target", owner?.alias ?: JSONObject.NULL)
            .put("presenting", owner != null && owner.viewerSurface != null)
            .put("bounds", bounds),
        )
      }
    }
    return out
  }

  /**
   * One Surface can only be owned by a single viewer at a time.
   *
   * The arbitration is a pure function so it can be unit-tested without an Android display:
   * a free target attaches, the same viewer may re-attach idempotently, and any other viewer is
   * refused with `viewer-target-occupied` instead of silently stealing or sharing the surface.
   */
  internal object ViewerArbitration {
    /** Verdict for one bind request. */
    enum class Verdict { ATTACH, OCCUPIED }

    /** @return ATTACH when [requestingViewerId] may own the target; OCCUPIED for a foreign owner. */
    fun decide(ownerViewerId: String?, requestingViewerId: String): Verdict =
      if (ownerViewerId == null || ownerViewerId == requestingViewerId) Verdict.ATTACH else Verdict.OCCUPIED
  }

  /** Create one non-mirrored public display on a user gesture or controller operation. */
  fun create(context: Context, args: JSONObject? = null): JSONObject {
    val appContext = context.applicationContext
    val session = args?.optString("session", "")?.takeIf { it.isNotBlank() }
    // 0.14.0 用户口径修正：**隔离「可见性/操作」，但共享「物理资源」**。
    //
    // 为什么不是「每会话一块屏」：虚拟屏是**全局稀缺资源**（本版上限 MAX_VIRTUAL_DISPLAYS = 1，
    // 一块 VirtualDisplay 在系统里真实占位）。若按会话各持一块，第 2 个会话必然撞上限。
    // 我自己上一版就犯了这个错：幂等判断写成「本会话是否已有屏」，于是
    //   面板先建屏(owner=null) → 模型再建(owner=X) 被算作「本会话没有屏」→ 尝试建第 2 块 → 报上限。
    //
    // 正确的隔离边界：
    //   - 资源：**全局唯一**（上限就是上限，谁建都算同一块）；
    //   - 归属：只用于「呈现给谁看」（面板按会话显示），**不再用于拒绝操作**；
    //   - 销毁：任何会话都能关（用户明确要求，否则创建者消失后没人能关）。
    //
    // 因此幂等判断回到「本机是否已有屏」——存在即复用，无论它当初由谁创建。
    val existing = synchronized(lock) { records.size }
    if (existing > 0) return status(appContext)
    val bound = ShizukuTransport.ensureBound(appContext)
    if (!bound.optBoolean("ok")) return status(appContext)
      .put("code", bound.optString("code", "shizuku-not-ready"))
      .put("guidance", bound.optString("guidance", "Shizuku 未就绪。"))

    // #520：旧版此处曾有 `existing >= MAX_VIRTUAL_DISPLAYS → vdisplay-limit` 分支，但它被上面的
    // 幂等复用早退（existing > 0 即 return）挡成死代码——MAX=1 时上限语义由「存在即复用」表达，
    // vdisplay-limit 错误码永不返回。刻意删除而非保留：未来把 MAX 调大时，放行面在这里补回
    // 上限分支并同步幂等早退条件（复用仅应发生在「未达上限」时），而不是让两个入口互相矛盾。
    val real = DisplayMetrics()
    @Suppress("DEPRECATION")
    (appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(real)
    val scale = (args?.optDouble("scale", VdisplayPrefs.scale(appContext)) ?: VdisplayPrefs.scale(appContext))
      .coerceIn(0.4, 1.0)
    val width = (args?.optInt("width", 0) ?: 0).takeIf { it > 0 }?.coerceIn(MIN_EDGE, MAX_EDGE)
      ?: Math.round(real.widthPixels * scale).toInt().coerceIn(MIN_EDGE, MAX_EDGE)
    val height = (args?.optInt("height", 0) ?: 0).takeIf { it > 0 }?.coerceIn(MIN_EDGE, MAX_EDGE)
      ?: Math.round(real.heightPixels * scale).toInt().coerceIn(MIN_EDGE, MAX_EDGE)

    synchronized(lock) {
      var nextReader: ImageReader? = null
      var nextThread: HandlerThread? = null
      try {
        val dpi = (args?.optInt("densityDpi", 0) ?: 0).takeIf { it > 0 }?.coerceIn(120, 640)
          ?: Math.round(real.densityDpi * scale).toInt().coerceIn(120, 640)
        nextThread = HandlerThread("dsh-vdisplay-reader").also { it.start() }
        nextReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        nextReader.setOnImageAvailableListener({ source ->
          // This is not a pixel transport. Drain and close frames so the owned output surface stays
          // healthy while the visual viewer surface is attached separately.
          runCatching { source.acquireLatestImage()?.close() }
        }, Handler(nextThread.looper))
        // flags 组合（0.14.0 模拟器两轮实锤，两个方向都踩过，**不要再改**）：
        //
        //   ✅ `PUBLIC | OWN_CONTENT_ONLY | SUPPORTS_TOUCH | DESTROY_CONTENT_ON_REMOVAL | ROTATES_WITH_CONTENT`
        //   ❌ 去掉 OWN_CONTENT_ONLY → 创建直接抛：
        //        SecurityException: Requires ADD_MIRROR_DISPLAY, CAPTURE_VIDEO_OUTPUT or
        //        CAPTURE_SECURE_VIDEO_OUTPUT permission, or an appropriate MediaProjection token
        //        ... please use the flag VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY.
        //      即：不带该 flag，系统按「屏幕共享/镜像」处理，而镜像需要投屏权限（我们没有）。
        //      该 flag 是**非系统应用创建虚拟屏的必备条件**，故必须保留。
        //
        // 实测 dumpsys 的最终形态：`FLAG_ROTATES_WITH_CONTENT, FLAG_OWN_CONTENT_ONLY,
        // FLAG_DESTROY_CONTENT_ON_REMOVAL`（**没有 FLAG_PUBLIC**——Android 13+ 起 PUBLIC 只对系统应用生效，
        // 应用自建的虚拟屏一律为 private，只能显示 owner 自己的窗口）。
        //
        // 这条结论的直接后果见 launchApp()。**2026-09-19 判定性实测更正**：原文写「private 屏上
        // **无法把第三方应用拉进来**（SafeActivityOptions.checkPermissions 拒；已验证 uid 2000 与
        // uid 10053 两条路都被拒）」——该结论在 MuMu x86_64 / API 35 上**不成立**：第三方应用
        // `com.endday.game` 经 `am start --display 2` 成功落在 display 2（普通 adb shell uid 2000
        // 与壳侧 UserService 两条路都试过）。故按实测改写为：**本机型成立、其它 ROM 待复核**；
        // 判定落点不靠这条前提，而由 launchApp 的落点回读（displaysRunning）如实回报。
        val flags = FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_SUPPORTS_TOUCH or
          FLAG_DESTROY_CONTENT_ON_REMOVAL or FLAG_ROTATES_WITH_CONTENT
        val manager = appContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        // 序号分配（0.14.0 用户实报修正）：**复用已释放的序号**，而不是单调递增。
        //
        // 旧实现每建一块就 `nextAliasIndex += 1` 且从不回收，于是反复建/销毁会得到
        // virtual-1 → virtual-2 → virtual-3 …（实测复现）。三步后果：
        //   1) 序号无限膨胀，模型看到的别名与「本机有几块屏」脱节；
        //   2) 上限只有 1 块时，界面显示「虚拟屏 3」却切不回之前那块，用户无法理解；
        //   3) 与用户对「编号 = 当前屏幕的标识」的直觉冲突。
        //
        // 现在从 1 起找**最小的未占用序号**（被销毁的号立刻可复用），因此稳定表现为：
        // 没有屏时新建恒为 virtual-1；有 1 块时第二块才是 virtual-2（但上限 1，见 MAX_）。
        val alias = run {
          var candidate = 1
          while (records.containsKey("virtual-$candidate")) candidate += 1
          "virtual-$candidate"
        }
        val created = manager.createVirtualDisplay(
          "DSH $alias",
          width,
          height,
          dpi,
          nextReader.surface,
          flags,
        ) ?: throw IllegalStateException("DisplayManager returned null VirtualDisplay")
        records[alias] = Record(alias, created, nextReader, nextThread, width, height, dpi, owner = session)
        if (selectedAlias == null) selectedAlias = alias
        if (ownerSessionId == null && session != null) ownerSessionId = session
        generation += 1
        lastCode = "vdisplay-active"
        lastGuidance = "$alias 已创建。"
        Log.i(TAG, "created alias=$alias displayId=${created.display.displayId} size=${width}x$height dpi=$dpi generation=$generation")
        return status(appContext)
      } catch (t: Throwable) {
        runCatching { nextReader?.close() }
        runCatching { nextThread?.quitSafely() }
        lastCode = if (t is SecurityException) "vd-denied-flags" else "vd-create-failed"
        lastGuidance = t.javaClass.simpleName + ": " + (t.message ?: "")
        Log.w(TAG, "create failed $lastGuidance")
        return status(appContext).put("code", lastCode).put("guidance", lastGuidance)
      }
    }
  }

  /** Explicitly remove one display; DESTROY_CONTENT_ON_REMOVAL prevents third-party task migration. */
  fun destroy(context: Context, args: JSONObject? = null): JSONObject = synchronized(lock) {
    val session = args?.optString("session", "")?.takeIf { it.isNotBlank() }
    // 销毁权限（用户明确要求）：**任何会话都能销毁**（模型与人都能关掉）。
    //
    // 为什么不能按归属收窄：虚拟屏是**有上限的稀缺系统资源**（当前上限 1 块）。若只允许创建者
    // 销毁，那么「创建它的那个对话被关闭/切走」之后，这块屏就**永远没人能关**——只能靠用户去设置页
    // 强制销毁。隔离的目的是「各会话看不到、不阻塞」，不是「把资源锁死」。
    //
    // 选择顺序：显式 target → 本会话自己的屏 → 当前选中 → 任意一块（保证只要存在就能关掉）。
    val requested = args?.optString("target", "").orEmpty().ifBlank { selectedAlias }
    val alias = requested?.takeIf { records.containsKey(it) }
      ?: records.values.firstOrNull { it.owner == session }?.alias
      ?: records.keys.firstOrNull()
      ?: return status(context.applicationContext)
    val record = records.remove(alias) ?: return status(context.applicationContext)
    runCatching { record.display.release() }
    runCatching { record.reader.close() }
    runCatching { record.thread.quitSafely() }
    record.viewerId?.let { viewerBounds.remove(it) }
    if (selectedAlias == alias) selectedAlias = records.keys.firstOrNull()
    if (records.isEmpty()) ownerSessionId = null
    generation += 1
    lastCode = "vdisplay-destroyed"
    lastGuidance = "$alias 已销毁；不会回退或迁移到真实屏幕。"
    Log.i(TAG, "destroyed alias=$alias generation=$generation remaining=${records.size}")
    status(context.applicationContext)
  }

  /**
   * Select the controller-owned presentation target. The real screen is not mirrorable and is
   * rejected with `screen-not-selectable`; an unknown alias is `screen-not-found`.
   */
  fun select(context: Context, alias: String?): JSONObject {
    val normalized = alias?.trim().orEmpty()
    val record = recordOf(normalized)
      ?: return status(context.applicationContext).put("ok", false)
        .put("code", if (normalized == ScreenTargets.REAL) "screen-not-selectable" else "screen-not-found")
        .put("guidance", if (normalized == ScreenTargets.REAL) {
          "真实屏幕不允许镜像，不能作为查看器目标。"
        } else {
          "没有名为 $normalized 的 " + UserCopy.APP_NAME + " 虚拟屏；先创建虚拟屏。"
        })
    synchronized(lock) {
      selectedAlias = record.alias
      generation += 1
    }
    Log.i(TAG, "selected target=${record.alias}")
    return status(context.applicationContext)
  }

  /**
   * Attach one viewer Surface to a target with viewer arbitration.
   *
   * A display's output Surface can only be owned by one viewer at a time. A second viewer binding
   * the same target gets `viewer-target-occupied` instead of silently sharing/replacing the surface.
   */
  fun attachViewerSurface(context: Context, viewerId: String, alias: String?, surface: Surface): JSONObject {
    val id = viewerId.trim().ifBlank { "files-sidebar" }
    val requested = alias?.trim().orEmpty().ifBlank { synchronized(lock) { selectedAlias } }
    val record = recordOf(requested)
      ?: return status(context.applicationContext).put("ok", false)
        .put("code", if (requested == ScreenTargets.REAL) "screen-not-selectable" else "screen-not-found")
        .put("viewerId", id)
        .put("guidance", "既没有目标虚拟屏，也没有可回退的真实屏。先创建并选择虚拟屏。")
    synchronized(lock) {
      val owner = record.viewerId
      if (ViewerArbitration.decide(owner, id) == ViewerArbitration.Verdict.OCCUPIED) {
        return status(context.applicationContext).put("ok", false)
          .put("code", "viewer-target-occupied")
          .put("viewerId", id)
          .put("owner", owner)
          .put("target", record.alias)
          .put("guidance", "虚拟屏 ${record.alias} 正由查看器 $owner 显示；同一 Surface 不能同时挂到两个查看器。")
      }
      record.viewerId = id
      record.viewerSurface = surface
      selectedAlias = record.alias
      runCatching { record.display.setSurface(surface) }
      generation += 1
    }
    Log.i(TAG, "viewer=$id attached to ${record.alias} displayId=${record.displayId}")
    return status(context.applicationContext)
  }

  /** Release one viewer's ownership and fall back to the owned ImageReader output. */
  fun releaseViewerSurface(context: Context, viewerId: String, surface: Surface? = null): JSONObject {
    val id = viewerId.trim().ifBlank { "files-sidebar" }
    synchronized(lock) {
      for (record in records.values) {
        if (record.viewerId != id) continue
        if (surface != null && record.viewerSurface !== surface) continue
        record.viewerId = null
        record.viewerSurface = null
        runCatching { record.display.setSurface(record.reader.surface) }
      }
      generation += 1
    }
    Log.i(TAG, "viewer=$id released")
    return status(context.applicationContext)
  }

  /** Store one viewer's independent geometry record (diagnostics + multi-window arbitration). */
  fun setViewerBounds(viewerId: String, bounds: JSONObject) {
    val id = viewerId.trim().ifBlank { "files-sidebar" }
    synchronized(lock) { viewerBounds[id] = bounds }
  }

  /**
   * Fixed display-scoped input proof. A successful result means the shell UserService accepted a
   * low-level key injection targeted at the dynamic virtual display rather than display 0.
   */
  fun sendBackProbe(context: Context, args: JSONObject? = null): JSONObject {
    val target = args?.optString("target", "").orEmpty().ifBlank { null }
    val record = selectedRecord() ?: recordOf(target)
      ?: return status(context.applicationContext).put("ok", false).put("code", "screen-not-ready")
        .put("guidance", "虚拟屏幕尚未创建，无法测试跨屏输入。")
    val id = record.displayId
    val result = ShizukuTransport.runController(
      context.applicationContext,
      arrayOf("/system/bin/input", "-d", id.toString(), "keyevent", "4"),
    )
    val out = status(context.applicationContext)
    out.put("input", result)
    return if (result.optBoolean("ok")) {
      out.put("guidance", "Shizuku 已向 ${record.alias} 注入返回键（displayId=$id）；真实屏未作为回退目标。")
    } else {
      out.put("ok", false).put("code", "vd-input-failed")
        .put("guidance", "虚拟屏输入失败：" + result.optString("stdout", result.optString("guidance", "")))
    }
  }

  /**
   * Minimal fixed-action proof: launch Android Settings onto the selected virtual display through
   * the shell UserService. This command contains no model/user supplied shell text.
   */
  fun launchSettingsProbe(context: Context, args: JSONObject? = null): JSONObject {
    requireOwner("vdLaunch", args?.optString("session", "")?.takeIf { it.isNotBlank() })?.let { return it }
    val target = args?.optString("target", "").orEmpty().ifBlank { null }
    val record = selectedRecord() ?: recordOf(target)
      ?: return status(context.applicationContext).put("ok", false).put("code", "screen-not-ready")
        .put("guidance", "虚拟屏幕尚未创建，无法拉起测试应用。")
    touch(record.alias) // #671：往这块屏送任务 = 使用中。
    val id = record.displayId
    val result = ShizukuTransport.runController(
      context.applicationContext,
      arrayOf("am", "start", "--display", id.toString(), "-a", "android.settings.SETTINGS"),
    )
    val out = status(context.applicationContext)
    out.put("launch", result)
    if (result.optBoolean("ok")) {
      out.put("guidance", "Android 设置已由 Shizuku 拉起到 ${record.alias}（displayId=$id）。")
    } else {
      out.put("ok", false).put("code", "vd-launch-failed")
        .put("guidance", "虚拟屏已创建，但 shell 拉起测试应用失败：" + result.optString("stdout", result.optString("guidance", "")))
    }
    return out
  }

  /**
   * 向指定屏幕注入输入（坐标 / 按键 / 文本）——虚拟屏「坐标模式」的真实执行面。
   *
   * 为什么必须有（0.14.0 用户实报）：`android_ui_click` 的 guidance 明确告诉模型「纯 Shizuku 下
   * 只能坐标操作，用 nx/ny 或 x/y」，但**真实执行面只有 `/system/bin/input`（无屏幕维度）**；
   * 于是 virtual-only 范围下那条路被范围门正确拒掉，模型收到的却是「请改用坐标」——**指引指向
   * 一条不存在的路**。提示与能力不一致，比直接拒绝更糟。
   *
   * 本函数补上 `input -d <displayId>` 这一段（displayId 来自原生注册表，绝不为 0）。
   *
   * 载荷约束：verb 只接受白名单枚举；坐标/键码为 Int；文本按 UTF-8 作为**单个 argv 元素**传递
   * （不经 shell 解析，因此无需转义，也不存在中文被误解码的问题）。
   *
   * @param verb - tap / swipe / keyevent / text。
   * @param args - tap{x,y} / swipe{x,y,x2,y2,duration} / keyevent{keycode} / text{text}。
   * @param target - 虚拟屏别名；缺省取当前选中/第一块。
   * @returns 结果对象（ok/code/guidance/screenId/displayId）。
   */
  fun input(context: Context, verb: String, args: JSONObject, target: String? = null): JSONObject {
    val appContext = context.applicationContext
    // An explicit target is authoritative; never redirect its input to the selected display.
    val record = (if (target != null) recordOf(target) else selectedRecord())
      ?: return status(appContext).put("ok", false).put("code", "screen-not-ready")
        .put("guidance", "虚拟屏幕尚未创建，无法向其注入输入；可先 android_vdisplay_create。")
    val scope = ScreenScopePrefs.current(appContext)
    val denial = scope.inputDenial(record.alias)
    if (denial != null) {
      return JSONObject()
        .put("ok", false).put("code", denial).put("reason", denial)
        .put("scope", scope.wire).put("screenId", record.alias).put("displayId", record.displayId)
        .put("guidance", "当前屏幕范围为 ${scope.wire}，拒绝向 ${record.alias} 注入输入。")
    }
    val id = record.displayId
    val argv = ArrayList<String>(12)
    argv += arrayOf("/system/bin/input", "-d", id.toString())
    when (verb) {
      "tap" -> argv += arrayOf("tap", args.optInt("x", -1).toString(), args.optInt("y", -1).toString())
      "swipe" -> {
        val duration = args.optInt("duration", 300).coerceIn(1, 20_000)
        argv += arrayOf(
          "swipe",
          args.optInt("x", -1).toString(), args.optInt("y", -1).toString(),
          args.optInt("x2", -1).toString(), args.optInt("y2", -1).toString(),
          duration.toString(),
        )
      }
      "keyevent" -> argv += arrayOf("keyevent", args.optInt("keycode", -1).toString())
      "text" -> {
        val text = args.optString("text", "")
        if (text.isEmpty() || text.length > 500) {
          return JSONObject().put("ok", false).put("code", "invalid-text")
            .put("guidance", "text 长度需为 1-500。")
        }
        argv += arrayOf("text", text)
      }
      else -> return JSONObject().put("ok", false).put("code", "unknown-input-verb")
        .put("guidance", "verb 必须是 tap / swipe / keyevent / text。")
    }
    val result = ShizukuTransport.runController(appContext, argv.toTypedArray())
    val out = JSONObject()
      .put("displayId", id)
      .put("screenId", record.alias)
      .put("generation", synchronized(lock) { generation })
    return if (result.optBoolean("ok")) {
      out.put("ok", true).put("code", "vd-input-ok").put("verb", verb)
        .put("guidance", "已在 ${record.alias}（displayId=$id）注入 $verb；真实屏前台不受影响。")
    } else {
      out.put("ok", false).put("code", "vd-input-failed").put("verb", verb)
        .put("guidance", "虚拟屏输入失败：" + result.optString("stdout", result.optString("error", "")))
    }
  }

  /**
   * 把任意应用拉起到指定屏幕（模型面 `android_app_launch { screenId }` 的落点）。
   *
   * 为什么必须单独有这一条（0.14.0 用户实报）：`android_app_launch` 走的是引擎侧特权 shell 的
   * `monkey -p <pkg>`——那条命令**没有屏幕维度**，永远落在真实屏上。于是「在虚拟屏里开个应用」
   * 这件事在工具面根本无法表达：模型只能看着一块空虚拟屏。
   *
   * 权限主体（关键）：**必须由壳侧自己发起**。`monkey` 没有屏幕维度；`am start --display` 虽然正确，
   * 但 uid 2000（Shizuku shell）不是这块 VirtualDisplay 的 owner，会被 SafeActivityOptions 拒绝。
   * 壳侧持有该屏，用 `ActivityOptions.setLaunchDisplayId` 直接拉起即可。
   *
   * 载荷约束：包名按 Android 包名文法**白名单校验**；displayId 取自原生注册表（Int）。
   *
   * @param pkg - 目标包名（须匹配 Android 包名文法）。
   * @param target - 虚拟屏别名；缺省取当前选中/第一块。
   * @returns 结果对象（ok/code/guidance/screenId/displayId）。
   */
  fun launchApp(context: Context, pkg: String, target: String? = null): JSONObject {
    val appContext = context.applicationContext
    if (!Regex("^[a-zA-Z][\\w.]*$").matches(pkg)) {
      return JSONObject().put("ok", false).put("code", "invalid-package")
        .put("guidance", "包名不合法：$pkg（须为 Android 包名文法，如 com.example.app）。")
    }
    val record = selectedRecord() ?: recordOf(target)
      ?: return status(appContext).put("ok", false).put("code", "screen-not-ready")
        .put("guidance", "虚拟屏幕尚未创建，无法在其上拉起应用；可先 android_vdisplay_create。")
    touch(record.alias) // #671：往这块屏送任务 = 使用中。
    val id = record.displayId
    // 拉起路径（0.14.0 模拟器逐条实测，**四条路只有最后一条成立**）：
    //
    //   ① `monkey -p <pkg> --display <id>`            → Error: Unknown option: --display（monkey 无屏幕维度）
    //   ② `am start --display <id>` 经 Shizuku(uid 2000) → SecurityException: Permission Denial ... uid=2000
    //   ③ 进程内 `ActivityOptions.setLaunchDisplayId`   → SecurityException: Permission Denial ... uid=10053
    //      （owner 本人也拒；SafeActivityOptions.checkPermissions 依据的是 START_ACTIVITIES_FROM_BACKGROUND
    //       等特权，普通应用没有）
    //   ④ ✅ `am start --display <id> -n <component>` 经**特权 shell 通道**（Shizuku UserService）
    //      → 实测成功：Settings 成为该 display 上的 task，a11y 也能看到它的窗口。
    //
    // 注意 ① 与 ④ 的区别不是「命令」而是**经由谁来执行**：同一台设备、同一个 uid=2000，
    // 经 UserService 的 binder 调用（`runController`）走的是特权路径，直接 adb shell 拼字符串则被拒。
    // 因此这里用 `runController`（固定 argv，包名已白名单校验，模型可控内容不进 shell 文本）。
    // 先解析 launcher 组件，再拉起——两步都是固定 argv。
    val resolved = ShizukuTransport.runController(
      appContext,
      arrayOf("cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg),
    )
    val component = resolved.optString("stdout", "")
      .lineSequence().map { it.trim() }.lastOrNull { it.contains("/") } ?: ""
    if (!resolved.optBoolean("ok") || component.isEmpty() || !component.startsWith("$pkg/")) {
      return status(appContext).put("ok", false).put("code", "vd-launch-unresolved")
        .put("displayId", id).put("screenId", record.alias)
        .put("guidance", "无法解析 " + pkg + " 的启动组件（可能未安装或无 launcher 入口）：" + component)
    }
    val result = ShizukuTransport.runController(
      appContext,
      arrayOf("am", "start", "--display", id.toString(), "-n", component),
    )
    val amTail = result.optString("stdout", result.optString("error", "")).trim().takeLast(400)
    val out = status(appContext).put("displayId", id).put("screenId", record.alias)
    if (!result.optBoolean("ok")) {
      return out.put("ok", false).put("code", "vd-launch-failed")
        .put("guidance", "虚拟屏已创建，但跨屏拉起失败（am 退出码非 0）：" + amTail)
    }
    // ── 落点回读（C1；0.14.1 设备实测缺陷）──────────────────────────────────────
    //
    // **退出码 0 不等于落在目标屏。** 2026-09-19 设备实测：目标包已在真实屏有 task 时，
    // `am start --display 2` 依旧回 0，同时打印
    //   Warning: Activity not started, intent has been delivered to currently running top-most instance.
    // 修复前本函数在这条路径上无条件报「已拉起到 virtual-N；真实屏前台不变」——**假成功**，
    // 用户的「在虚拟屏里启动软件却跳到真实屏」正是它。判据改为**设备事实**：按 displayId 分组
    // 读回该包的 ActivityRecord（见 [displaysRunning]）。
    //
    // 三态如实回报（与 A1 的同一条纪律：不确定就说不知道，不得说成功）：
    //   - 包在目标屏  → ok=true  vd-launched
    //   - 包只在别的屏 → ok=false vd-launch-denied（带 landedDisplayIds）
    //   - 读不到       → ok=true  vd-launched-unverified（明写「不构成落点证明」并给出复核手段）
    val probe = ShizukuTransport.runShell(appContext, ACTIVITY_DISPLAY_PROBE, 15_000)
    if (!probe.optBoolean("ok")) {
      return out.put("ok", true).put("code", "vd-launched-unverified")
        .put("guidance", "已请求把 " + pkg + " 拉起到 " + record.alias + "（displayId=" + id + "），但**落点回读不可用**"
          + "（" + probe.optString("code", probe.optString("error", "dumpsys 调用失败")) + "）——本次不构成落点证明。"
          + "请用 android_ui_dump { screenId=\"" + record.alias + "\" } 复核该屏内容。" + amTail)
    }
    val landed = displaysRunning(pkg, probe.optString("stdout", ""))
    out.put("landedDisplayIds", org.json.JSONArray(landed.toList()))
    if (landed.isEmpty()) {
      return out.put("ok", true).put("code", "vd-launched-unverified")
        .put("guidance", "已请求把 " + pkg + " 拉起到 " + record.alias + "（displayId=" + id + "），但回读里找不到该包的任何 "
          + "ActivityRecord（应用可能已崩溃/退出）——本次不构成落点证明，请用 android_ui_dump 复核该屏内容。" + amTail)
    }
    if (!landed.contains(id)) {
      return out.put("ok", false).put("code", "vd-launch-denied")
        .put("guidance", "拉起未落在虚拟屏：" + pkg + " 实际出现在 displayId=" + landed.joinToString(",")
          + "（目标是 " + id + "）。可能原因：该应用已在真实屏有任务并被系统带到前台（am 仍回退出码 0）。"
          + "可先 android_ui_global home 回到桌面，或改用该应用在虚拟屏内的启动入口重试。" + amTail)
    }
    out.put("ok", true).put("code", "vd-launched")
      .put("guidance", "已把 " + pkg + " 拉起到 " + record.alias + "（displayId=" + id + "，组件 " + component
        + "）；落点已回读确认，真实屏前台不变。")
    return out
  }

  /**
   * 从 `dumpsys activity activities` 的输出里解析「某包当前出现在哪些 display」。
   *
   * 纯函数（无 IO、无全局态）⇒ 直接单测（含真实设备输出样本）。
   *
   * 输出形态（API 35 / MuMu x86_64 实测，按屏分组、`Display #<n>` 是分组锚点）：
   * ```
   * Display #0 (activities from top to bottom):
   *     topResumedActivity=ActivityRecord{... u0 com.x/.MainActivity t123}
   * Display #2 (activities from top to bottom):
   *     topResumedActivity=ActivityRecord{... u0 com.y/.MainActivity t494}
   * ```
   * 判据刻意收窄到 `ActivityRecord{` 行 + `包名/` 精确前缀：Task 行里的 `A=10051:com.x`
   * 是 **affinity** 不是落点，拿它判会得出错误结论。解析不出任何分组时返回空集——
   * 调用方据此报「回读不可用」，**绝不据此判成功**（空集与「不在目标屏」是两件事，见 [launchApp]）。
   */
  internal fun displaysRunning(pkg: String, activitiesDump: String): Set<Int> {
    val out = LinkedHashSet<Int>()
    if (pkg.isBlank()) return out
    val header = Regex("""^\s*Display #([0-9]+)""")
    val member = Regex("""(^|[\s:])""" + Regex.escape(pkg) + """/""")
    var current = -1
    for (line in activitiesDump.lineSequence()) {
      val hit = header.find(line)
      if (hit != null) {
        current = hit.groupValues[1].toIntOrNull() ?: -1
        continue
      }
      if (current < 0 || !line.contains("ActivityRecord{")) continue
      if (member.containsMatchIn(line)) out += current
    }
    return out
  }

  /** 归属校验（不含绑定）：非归属会话的生命周期操作一律拒绝；旧调用（不带会话）放行。 */
  private fun requireOwner(op: String, session: String?): JSONObject? {
    val current = ownerSessionId ?: return null
    if (session == null || session == current) return null
    return JSONObject().put("ok", false).put("code", "vdisplay-session-busy").put("op", op)
      .put("ownerSessionId", current)
      .put("guidance", "虚拟屏正由另一个会话使用；请回到该会话，或由用户在设置页强制销毁。")
  }

  /** 当前选中（或第一块）虚拟屏的分辨率；无屏返回 null（浮窗按此保持宽高比）。 */
  internal fun activeSize(): Pair<Int, Int>? {
    // 锁内只做 record 选择，活值查询放锁外（与 contentSizeForAlias 同一纪律）。
    val record = synchronized(lock) { records[selectedAlias] ?: records.values.firstOrNull() }
      ?: return null
    return liveOrSnapshotSize(record)
  }

  /**
   * 活值优先的内容尺寸：Display 活值 → 建屏快照兜底，经 [VdisplayLetterbox.chooseLiveOrSnapshot] 决策。
   *
   * 为什么必须活值（0.14.10 issue ① 设备锤定）：虚拟屏带 FLAG_ROTATES_WITH_CONTENT，建屏后
   * 方向可随内容翻转（dumpsys 实测 mCurrentLayerStackRect 由 675x1200 翻成 1200x675），而
   * Record.width/height 是建屏瞬间的快照、全仓无任何回写路径——按快照算的 frame 与活内容
   * 渲染方向相反时画面整体拉伸。读取与 screens() 同一模式（Display 缓存读 +
   * @Suppress(DEPRECATION)）；查询异常/非法时回退快照。
   */
  private fun liveOrSnapshotSize(record: Record): Pair<Int, Int> {
    val metrics = DisplayMetrics()
    val live: Pair<Int, Int>? = runCatching {
      @Suppress("DEPRECATION")
      record.display.display.getRealMetrics(metrics)
      metrics.widthPixels to metrics.heightPixels
    }.getOrNull()
    return VdisplayLetterbox.chooseLiveOrSnapshot(live?.first, live?.second, record.width, record.height)
  }

  /** 设置页「强制销毁」：无视会话归属销毁全部虚拟屏（用户三连点确认后调用）。 */
  fun forceDestroy(context: Context): JSONObject = synchronized(lock) {
    val aliases = records.keys.toList()
    for (alias in aliases) {
      val record = records.remove(alias) ?: continue
      runCatching { record.display.release() }
      runCatching { record.reader.close() }
      runCatching { record.thread.quitSafely() }
      record.viewerId?.let { viewerBounds.remove(it) }
    }
    selectedAlias = null
    ownerSessionId = null
    generation += 1
    lastCode = "vdisplay-destroyed"
    lastGuidance = "已强制销毁全部虚拟屏（无归属限制）。"
    Log.i(TAG, "force-destroyed ${aliases.size} display(s) generation=$generation")
    status(context.applicationContext)
  }
}

/** 虚拟屏分辨率档位（0.5 / 0.75 / 1.0，默认 0.75；densityDpi 同比例缩放）与退后台浮窗开关。
 *  均由设置页「手机控制」写入。 */
internal object VdisplayPrefs {
  private const val PREFS = "dsh-vdisplay"
  private const val KEY_SCALE = "resolutionScale"
  private const val KEY_FLOAT = "floatEnabled"

  fun scale(context: Context): Double {
    val stored = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getFloat(KEY_SCALE, 0.75f)
    return stored.toDouble().coerceIn(0.4, 1.0)
  }

  fun setScale(context: Context, value: Double) {
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putFloat(KEY_SCALE, value.coerceIn(0.4, 1.0).toFloat()).apply()
  }

  fun floatEnabled(context: Context): Boolean =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_FLOAT, true)

  fun setFloatEnabled(context: Context, enabled: Boolean) {
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(KEY_FLOAT, enabled).apply()
  }
}
