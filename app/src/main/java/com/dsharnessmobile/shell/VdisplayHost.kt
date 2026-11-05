package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.View
import android.view.SurfaceView
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Native SurfaceView projected over the trusted virtual-screen sidebar stage.
 *
 * The page supplies CSS-pixel geometry only from the DSH WebView. This host maps it to the root
 * frame, owns the Surface lifecycle, and never gives the displayed third-party activity a bridge.
 *
 * 0.14.0 batch: each host instance owns one viewer id, publishes independent bounds (including the
 * controller-owned presentation target), and binds its surface through
 * [VdisplayController.attachViewerSurface] so one Surface is never silently attached to two viewers.
 * Closing the stage releases ownership without destroying the display or its task; reopening binds
 * the same viewer id again and reattaches the surface.
 */
internal class VdisplayHost(
  private val root: FrameLayout,
  private val dshWebView: WebView,
) {
  private data class StageBounds(
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    val viewportWidth: Double,
    val viewportHeight: Double,
    val visible: Boolean,
    val target: String?,
    val viewerId: String?,
  )

  /** Stable per-instance viewer identity: two Activities in multi-window get distinct owners. */
  private val viewerId = "viewer-" + Integer.toHexString(System.identityHashCode(this))
  private val main = Handler(Looper.getMainLooper())
  private var view: SurfaceView? = null
  private var stageBounds: StageBounds? = null
  private var stageVisible = false
  private var attached = false
  private var lastReason = ""

  // ── 冻结态（双守卫之二，0.14.10）──────────────────────────────────────────
  // bindSurface 被仲裁拒绝后置位：限频窗口内 applyStageBounds 保持 GONE、纯计算早退，
  // 断根「occupied 态 GONE<->VISIBLE 每帧翻转」的自激循环（现状供能腿二）。
  private var bindRefused = false
  private var lastRefusedAtMs = 0L

  // ── 全屏浮钮（issue「至少」口径：root 内叠原生按钮，不引新窗口、不动窗口类型、不碰 back 分发）──
  private var fullscreen = false
  private var fullscreenButton: TextView? = null

  private val rootLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyStageBounds() }

  private val displayManager: DisplayManager =
    root.context.applicationContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager

  /**
   * Display 活值变化的触发点（0.14.10 新增）：FLAG_ROTATES_WITH_CONTENT 的屏方向翻转与虚拟屏
   * 重建都从这里进来，重算收敛到 applyStageBounds 单一幂等入口。
   */
  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) {
      onMain {
        // 虚拟屏重建的确定性信号：立即解冻（不走限频），随后重算几何。
        if (bindRefused) {
          bindRefused = false
          lastReason = ""
        }
        applyStageBounds()
      }
    }

    override fun onDisplayChanged(displayId: Int) {
      // 方向翻转后 Display 活值对调：重算几何（冻结态下走既有限频守卫）。
      onMain { applyStageBounds() }
    }

    override fun onDisplayRemoved(displayId: Int) {
      // 不挂逻辑（方案定例）：无屏无画面，冻结无妨；重建由 onDisplayAdded 强信号解冻。
    }
  }

  init {
    root.addOnLayoutChangeListener(rootLayoutListener)
    displayManager.registerDisplayListener(displayListener, main)
  }

  private companion object {
    /** 冻结态限频窗口：距上次被拒 <30s 不重试；过窗允许一次（被拒刷新时间戳，成功清冻结）。 */
    const val REBIND_BACKOFF_MS = 30_000L
    const val FULLSCREEN_BUTTON_WIDTH_DP = 64
    const val FULLSCREEN_BUTTON_HEIGHT_DP = 28
    /** 半透明深色圆角（同 VdisplayFloat 把手的低饱和深色系）。 */
    val FULLSCREEN_BUTTON_COLOR = 0x99000000.toInt()
  }

  fun setStageBounds(raw: String): String = onMain {
    try {
      val value = JSONObject(raw)
      val bounds = StageBounds(
        left = value.optDouble("left", 0.0),
        top = value.optDouble("top", 0.0),
        width = value.optDouble("width", 0.0),
        height = value.optDouble("height", 0.0),
        viewportWidth = value.optDouble("viewportWidth", 0.0),
        viewportHeight = value.optDouble("viewportHeight", 0.0),
        visible = value.optBoolean("visible", false),
        target = value.optString("target", "").takeIf { it.isNotBlank() },
        viewerId = value.optString("viewerId", "").takeIf { it.isNotBlank() },
      )
      stageBounds = bounds
      VdisplayController.setViewerBounds(viewerId, value)
      if (!bounds.visible) {
        releaseSurface()
      } else {
        ensureView()
      }
      applyStageBounds()
      JSONObject().put("ok", true).put("visible", stageVisible)
        .put("presenting", attached)
        .put("viewerId", viewerId)
        .put("reason", lastReason)
        .toString()
    } catch (t: Throwable) {
      JSONObject().put("ok", false).put("reason", "invalid-vdisplay-stage-bounds")
        .put("detail", t.javaClass.simpleName).toString()
    }
  } ?: JSONObject().put("ok", false).put("reason", "main-thread-timeout").toString()

  fun destroy() {
    onMain {
      displayManager.unregisterDisplayListener(displayListener)
      root.removeOnLayoutChangeListener(rootLayoutListener)
      releaseSurface()
      view?.let { surface ->
        surface.holder.removeCallback(callback)
        root.removeView(surface)
      }
      view = null
      fullscreenButton?.let { root.removeView(it) }
      fullscreenButton = null
      fullscreen = false
      Unit
    }
  }

  /** 退后台：交出 Surface 给浮窗，但保留视图与几何（回前台可原样恢复）。 */
  fun detachForBackground() {
    onMain {
      releaseSurface()
      Unit
    }
  }

  /** 回前台：视图与几何仍在且 Surface 有效时重新绑定侧栏工位。 */
  fun reattach() {
    onMain {
      val surface = view?.holder?.surface
      if (stageBounds?.visible == true && surface != null && surface.isValid && !attached) {
        bindSurface(surface)
      }
      Unit
    }
  }

  /**
   * 壳侧自有重算供能（0.14.10）：MainActivity 前台 reaper 兼任限频重试触发——页面轮询不在
   * 前台/未挂载时，冻结态仍有壳侧保底供能。幂等，重算走 applyStageBounds 单一入口。
   */
  fun recheck() {
    onMain { applyStageBounds() }
  }

  private val callback = object : SurfaceHolder.Callback {
    override fun surfaceCreated(holder: SurfaceHolder) { bindSurface(holder.surface) }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
      if (width > 0 && height > 0) {
        if (attached) VdisplayController.attachViewerSurface(root.context, viewerId, stageBounds?.target, holder.surface)
        else bindSurface(holder.surface)
      }
    }
    override fun surfaceDestroyed(holder: SurfaceHolder) { releaseSurface() }
  }

  /**
   * Bind this viewer's surface to the requested target. On `viewer-target-occupied` the stage stays
   * hidden and reports the arbitration reason instead of stealing the surface.
   */
  private fun bindSurface(surface: android.view.Surface) {
    val result = VdisplayController.attachViewerSurface(root.context, viewerId, stageBounds?.target, surface)
    attached = result.optBoolean("ok")
    lastReason = if (attached) "" else result.optString("code", "attach-failed")
    if (attached) {
      // 成功绑定即时解冻（含 reattach 回前台路径）。
      bindRefused = false
    } else {
      // 仲裁拒绝（viewer-target-occupied / screen-not-found / attach-failed …）：置冻结并记
      // 时间戳，applyStageBounds 据此限频重试；onDisplayAdded 与下一次成功绑定立即解冻。
      bindRefused = true
      lastRefusedAtMs = android.os.SystemClock.elapsedRealtime()
      view?.visibility = View.GONE
    }
  }

  private fun releaseSurface() {
    if (!attached) return
    VdisplayController.releaseViewerSurface(root.context, viewerId)
    attached = false
  }

  private fun ensureView(): SurfaceView {
    view?.let { return it }
    return SurfaceView(root.context).also { created ->
      created.visibility = View.GONE
      created.holder.addCallback(callback)
      root.addView(created, FrameLayout.LayoutParams(1, 1))
      view = created
    }
  }

  private fun applyStageBounds() {
    val bounds = stageBounds
    val cssWidth = bounds?.viewportWidth ?: 0.0
    val cssHeight = bounds?.viewportHeight ?: 0.0
    if (bounds == null || !bounds.visible || cssWidth <= 0.0 || cssHeight <= 0.0 ||
      bounds.width <= 1.0 || bounds.height <= 1.0 || root.width <= 0 || root.height <= 0 ||
      dshWebView.width <= 0 || dshWebView.height <= 0
    ) {
      stageVisible = false
      resetFullscreen()
      view?.visibility = View.GONE
      return
    }
    // ── 冻结态限频守卫（双守卫之二）──────────────────────────────────────────
    // 被仲裁拒绝后 30s 内保持 GONE、纯计算早退：不重试、不翻转可见性、不触碰控制器
    // （现状每帧 attachViewerSurface 拿锁并构造全量 status JSON 的供能腿在此断根）。
    // stageVisible 如实回报 false，reason 保留 bindSurface 写入的拒绝码。
    if (bindRefused) {
      val sinceRefused = android.os.SystemClock.elapsedRealtime() - lastRefusedAtMs
      if (sinceRefused < REBIND_BACKOFF_MS) {
        stageVisible = false
        if (view?.visibility != View.GONE) view?.visibility = View.GONE
        fullscreenButton?.let { if (it.visibility != View.GONE) it.visibility = View.GONE }
        return
      }
      // 过窗：放行到下方唯一 retry 路径（被拒则 bindSurface 刷新时间戳，成功则清冻结）。
    }
    val surface = ensureView()
    // 等比适配统一 scale（0.14.10 issue ③ 修复）：只取 X 基准（viewWidth/cssWidth），不再用
    // dshWebView.height 派生 scaleY——IME 弹起时页面 css 视口高度经 padding 缩短会让 scaleY
    // 虚增、舞台盒纵向放大（「半截画面」）。cssWidth 非法时 uniformScale 返回 0。
    val scale = VdisplayLetterbox.uniformScale(dshWebView.width, cssWidth)
    if (scale <= 0.0) {
      stageVisible = false
      resetFullscreen()
      view?.visibility = View.GONE
      return
    }
    // 舞台矩形：页面 CSS 舞台 coerce 进 root（既有 coerce 行为的等价抽取）；全屏时取 root 全域
    // （contain 数学不变，黑边留在全屏域内）。
    val stage = if (fullscreen) {
      VdisplayLetterbox.Frame(0, 0, root.width, root.height)
    } else {
      VdisplayLetterbox.stageRectInRoot(
        (bounds.left * scale).toInt(),
        (bounds.top * scale).toInt(),
        (bounds.width * scale).toInt(),
        (bounds.height * scale).toInt(),
        root.width,
        root.height,
      )
    }
    // 内容尺寸活值优先（0.14.10 issue ① 修复）：虚拟屏可随内容旋转，建屏快照只代表建屏瞬间；
    // 活值来自 Display.getRealMetrics，异常/非法回退快照（VdisplayController.liveOrSnapshotSize）。
    // 无屏/非法时按舞台比例兜底 = 满舞台（与既有 content==null 兜底一致）。
    val content = VdisplayController.contentSizeForAlias(bounds.target)
    val frame = if (content != null && content.first > 0 && content.second > 0) {
      VdisplayLetterbox.containFrame(stage, content.first, content.second)
    } else {
      stage
    }
    // ── 几何落盘守卫（双守卫之一）────────────────────────────────────────────
    // 四元组（width/height/leftMargin/topMargin）全等则跳过 setLayoutParams，断根
    // 「每帧无条件 requestLayout -> onLayoutChange -> applyStageBounds」的自激供能腿之一。
    val lp = surface.layoutParams
    val geometryUnchanged = lp is FrameLayout.LayoutParams &&
      lp.width == frame.width && lp.height == frame.height &&
      lp.leftMargin == frame.left && lp.topMargin == frame.top
    if (!geometryUnchanged) {
      surface.layoutParams = FrameLayout.LayoutParams(frame.width, frame.height).apply {
        leftMargin = frame.left
        topMargin = frame.top
      }
    }
    // Make the SurfaceView visible so its Surface is created; binding/arbitration happens in
    // surfaceCreated. An occupied target is hidden again by bindSurface with a structured reason
    // and per-frame retries are throttled behind the frozen-state guard above (30s per attempt;
    // onDisplayAdded unfreezes immediately).
    stageVisible = true
    if (surface.visibility != View.VISIBLE) surface.visibility = View.VISIBLE
    // D5（0.14.11）：屏被销毁 / 空闲回收 / 强制销毁时 controller 的 records 被清掉，而宿主的
    // attached 只在 releaseViewerSurface / surfaceDestroyed 复位 ⇒ 这条 if (!attached) 永远不成立，
    // 重建出来的屏再也挂不上（侧栏永久停在旧帧，用户只能收起/展开侧栏或切前后台）。
    // 每帧读一次真源（只读、幂等）：本 viewer 已不再持有任何 Surface 时先把 attached 归零。
    if (attached && !VdisplayController.holdsViewerSurface(viewerId)) attached = false
    if (!attached) surface.holder.surface?.takeIf { it.isValid }?.let { bindSurface(it) }
    updateFullscreenButton(frame)
  }

  // ── 全屏浮钮（issue「至少」口径）───────────────────────────────────────────

  /** 点击切换 fullscreen；几何重算走 applyStageBounds 单一幂等入口。 */
  private fun toggleFullscreen() {
    fullscreen = !fullscreen
    applyStageBounds()
  }

  /** 懒创建半透明圆角浮钮；elevation 抬到 SurfaceView 之上保证可点可读。 */
  private fun ensureFullscreenButton(): TextView {
    fullscreenButton?.let { return it }
    val density = root.resources.displayMetrics.density
    val button = TextView(root.context).apply {
      text = UiText.t(root.context, "全屏", "Fullscreen")
      textSize = 12f
      setTextColor(Color.WHITE)
      gravity = Gravity.CENTER
      background = GradientDrawable().apply {
        setColor(FULLSCREEN_BUTTON_COLOR)
        cornerRadius = 10 * density
      }
      elevation = 16f * density
      setOnClickListener { toggleFullscreen() }
    }
    root.addView(
      button,
      FrameLayout.LayoutParams(
        (FULLSCREEN_BUTTON_WIDTH_DP * density).toInt(),
        (FULLSCREEN_BUTTON_HEIGHT_DP * density).toInt(),
      ),
    )
    fullscreenButton = button
    return button
  }

  /**
   * 浮钮可见性与位置：presenting 且未冻结时可见，位置跟随 frame 右上角（四元组全等跳过，
   * 同 SurfaceView 的防自激守卫）。
   */
  private fun updateFullscreenButton(frame: VdisplayLetterbox.Frame) {
    val button = if (attached && !bindRefused) ensureFullscreenButton() else fullscreenButton
    if (button == null) return
    if (!attached || bindRefused) {
      if (button.visibility != View.GONE) button.visibility = View.GONE
      return
    }
    val label = UiText.t(
      root.context,
      if (fullscreen) "退出全屏" else "全屏",
      if (fullscreen) "Exit fullscreen" else "Fullscreen",
    )
    if (button.text.toString() != label) button.text = label
    val density = root.resources.displayMetrics.density
    val width = (FULLSCREEN_BUTTON_WIDTH_DP * density).toInt()
    val height = (FULLSCREEN_BUTTON_HEIGHT_DP * density).toInt()
    val left = (frame.left + frame.width - width).coerceIn(0, (root.width - width).coerceAtLeast(0))
    val top = frame.top.coerceIn(0, (root.height - height).coerceAtLeast(0))
    if (button.visibility != View.VISIBLE) button.visibility = View.VISIBLE
    val lp = button.layoutParams
    val unchanged = lp is FrameLayout.LayoutParams &&
      lp.width == width && lp.height == height &&
      lp.leftMargin == left && lp.topMargin == top
    if (!unchanged) {
      button.layoutParams = FrameLayout.LayoutParams(width, height).apply {
        leftMargin = left
        topMargin = top
      }
    }
  }

  /** 画面收起（visible=false）：重置全屏态并隐藏浮钮（方案定例）。 */
  private fun resetFullscreen() {
    fullscreen = false
    fullscreenButton?.let { if (it.visibility != View.GONE) it.visibility = View.GONE }
  }

  private fun <T> onMain(block: () -> T): T? {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    var result: T? = null
    val latch = CountDownLatch(1)
    main.post { try { result = block() } finally { latch.countDown() } }
    return if (latch.await(2, TimeUnit.SECONDS)) result else null
  }
}
