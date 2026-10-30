package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 虚拟屏只读浮窗（0.14.0 用户定例）：应用切到后台时，把虚拟屏画面以小窗浮在系统上。
 *
 * 语义（与侧栏查看器同一套）：
 * - 只读：不做触控注入，窗口只接收自身手势（拖动 / 边角缩放 / 点按出「叉」/ 贴边内滑收起）。
 * - 尺寸：默认宽 = 屏幕短边 30%（同时是最小值），上限 50%；缩放保持虚拟屏宽高比。
 * - 「叉」与贴边内滑都只**收起**（变成贴边把手，点它恢复），绝不销毁虚拟屏——销毁会打断模型操作。
 * - 只在应用退到后台时出现；回前台立即隐藏，并把 Surface 交还侧栏查看器。
 * - 悬浮窗权限缺失 / 开关关闭 / 无虚拟屏：fail-closed 返回 false，不抛错、不假装显示。
 */
internal class VdisplayFloat(private val activity: MainActivity) {

  companion object {
    /** 浮窗在查看器仲裁里的固定身份。 */
    private const val VIEWER_ID = "float"
    private const val MIN_RATIO = 0.30
    private const val MAX_RATIO = 0.50
    private const val CLOSE_SIZE_DP = 34
    private const val GRIP_SIZE_DP = 30
    private const val HANDLE_WIDTH_DP = 22
    private const val HANDLE_HEIGHT_DP = 64
    private const val COLLAPSE_SWIPE_DP = 28
    /** 屏存活看护节拍（1s：不销毁屏、只读一次 activeSize）。 */
    private const val ALIVE_CHECK_MS = 1000L
    private const val SURFACE_COLOR = 0x66202024
    private val HANDLE_COLOR = 0xCC202024.toInt()
    private const val GRIP_COLOR = 0x59FFFFFF
  }

  private val wm: WindowManager get() = activity.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private val density: Float get() = activity.resources.displayMetrics.density
  private val touchSlop: Int by lazy { ViewConfiguration.get(activity).scaledTouchSlop }

  private var container: FrameLayout? = null
  private var surfaceView: SurfaceView? = null
  private var grip: View? = null
  private var closeView: TextView? = null
  private var closeParams: WindowManager.LayoutParams? = null
  private var params: WindowManager.LayoutParams? = null
  private var attached = false
  private var collapsed = false
  private var closeVisible = false
  /** 虚拟屏宽高比（height / width），缩放时保持。 */
  private var aspect = 16.0 / 9.0
  private var restoredWidth = 0
  private var restoredHeight = 0
  private var edge = Gravity.RIGHT
  private var downRawX = 0f
  private var downRawY = 0f
  private var downX = 0
  private var downY = 0
  private var dragging = false

  /**
   * 屏存活看护（0.14.11，D3）：浮窗原本只在 onStop 出现、只在 onStart 消失，中间没有任何
   * 「屏还在不在」的判据。于是 AI 在后台把虚拟屏 destroy / 空闲回收 / 强制销毁之后，浮窗继续
   * 显示 SurfaceFlinger 保留的最后一帧——用户看到一张已经不存在的画面，而且浮窗上的「叉」
   * 只把它收成贴边把手，关不掉。这里用 1s 节拍比对真源 activeSize()：屏没了就收场，
   * 屏换了尺寸就跟着重算宽高比。
   */
  private val aliveHandler = Handler(Looper.getMainLooper())
  private var aliveCheck: Runnable? = null

  /**
   * 显示浮窗（幂等；仅主线程调用——MainActivity.onStop）。
   * @return 是否处于可见状态（权限/开关/虚拟屏任一不满足即 false）。
   */
  fun show(): Boolean {
    if (!VdisplayPrefs.floatEnabled(activity)) return false
    if (!Settings.canDrawOverlays(activity)) return false
    val size = VdisplayController.activeSize() ?: return false
    aspect = size.second.toDouble() / size.first.toDouble().coerceAtLeast(1.0)
    val existing = container
    if (existing != null) {
      if (collapsed) expand() else attachSurface()
      startAliveWatch()
      return true
    }
    val metrics = displayMetrics()
    val shortSide = minOf(metrics.widthPixels, metrics.heightPixels)
    val width = (shortSide * MIN_RATIO).roundToInt().coerceAtLeast(dp(120))
    val height = (width * aspect).roundToInt().coerceAtLeast(dp(160))
    val built = buildViews()
    val p = WindowManager.LayoutParams(
      width,
      height,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = (metrics.widthPixels - width - dp(12)).coerceAtLeast(0)
      y = dp(96)
    }
    params = p
    try {
      wm.addView(built, p)
    } catch (_: Throwable) {
      params = null
      return false
    }
    container = built
    attachSurface()
    startAliveWatch()
    return true
  }

  /** 屏存活看护：屏没了立刻 hide（不留在死屏最后一帧），换尺寸就重算比例。 */
  private fun startAliveWatch() {
    stopAliveWatch()
    val tick = object : Runnable {
      override fun run() {
        if (container == null) { aliveCheck = null; return }
        val size = VdisplayController.activeSize()
        if (size == null) {
          // 屏已被销毁/回收：浮窗必须跟着收场（用户无法从这个窗口里收掉它）。
          hide()
          return
        }
        val next = size.second.toDouble() / size.first.toDouble().coerceAtLeast(1.0)
        if (abs(next - aspect) > 0.01) {
          aspect = next
          applyAspect()
        }
        aliveHandler.postDelayed(this, ALIVE_CHECK_MS)
      }
    }
    aliveCheck = tick
    aliveHandler.postDelayed(tick, ALIVE_CHECK_MS)
  }

  private fun stopAliveWatch() {
    aliveCheck?.let { aliveHandler.removeCallbacks(it) }
    aliveCheck = null
  }

  /** 按当前 aspect 重算高（宽沿用窗口现值，夹在本窗允许的比例区间内）。 */
  private fun applyAspect() {
    val p = params ?: return
    val view = container ?: return
    val metrics = displayMetrics()
    val shortSide = minOf(metrics.widthPixels, metrics.heightPixels)
    val width = p.width.coerceIn((shortSide * MIN_RATIO).roundToInt().coerceAtLeast(dp(120)),
      (shortSide * MAX_RATIO).roundToInt())
    p.width = width
    p.height = (width * aspect).roundToInt().coerceAtLeast(dp(120))
    runCatching { wm.updateViewLayout(view, p) }
  }

  /** 回前台：隐藏浮窗并把 Surface 交还侧栏查看器（幂等；仅主线程调用）。 */
  fun hide() {
    stopAliveWatch()
    hideClose()
    releaseSurface()
    container?.let { view -> runCatching { wm.removeView(view) } }
    container = null
    surfaceView = null
    grip = null
    params = null
    collapsed = false
    attached = false
  }

  /** 随 Activity 销毁（幂等）。 */
  fun destroy() = hide()

  // ── 视图与 Surface ────────────────────────────────────────────────────────

  private fun buildViews(): FrameLayout {
    val frame = FrameLayout(activity)
    val surface = SurfaceView(activity).apply {
      holder.addCallback(object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) { attachSurface() }
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
          if (!attached) attachSurface()
        }
        override fun surfaceDestroyed(holder: SurfaceHolder) { releaseSurface() }
      })
    }
    frame.addView(surface, FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    ))
    val gripView = View(activity).apply { background = roundRect(GRIP_COLOR, dp(6).toFloat()) }
    frame.addView(gripView, FrameLayout.LayoutParams(dp(GRIP_SIZE_DP), dp(GRIP_SIZE_DP), Gravity.BOTTOM or Gravity.END).apply {
      rightMargin = dp(4)
      bottomMargin = dp(4)
    })
    surfaceView = surface
    grip = gripView
    frame.setOnTouchListener(::onFrameTouch)
    gripView.setOnTouchListener(::onGripTouch)
    return frame
  }

  private fun attachSurface() {
    val surface = surfaceView?.holder?.surface ?: return
    if (!surface.isValid) return
    val result = VdisplayController.attachViewerSurface(activity, VIEWER_ID, null, surface)
    attached = result.optBoolean("ok")
  }

  private fun releaseSurface() {
    if (!attached) return
    VdisplayController.releaseViewerSurface(activity, VIEWER_ID)
    attached = false
  }

  // ── 手势 ──────────────────────────────────────────────────────────────────

  private fun onFrameTouch(view: View, event: MotionEvent): Boolean {
    if (collapsed) {
      if (event.actionMasked == MotionEvent.ACTION_UP) expand()
      return true
    }
    val p = params ?: return false
    val metrics = displayMetrics()
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = event.rawX
        downRawY = event.rawY
        downX = p.x
        downY = p.y
        dragging = false
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.rawX - downRawX
        val dy = event.rawY - downRawY
        if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) dragging = true
        if (!dragging) return true
        // 贴边后再向边框方向滑一下 = 收起（把手保留）。
        if (p.x <= 0 && dx < -dp(COLLAPSE_SWIPE_DP)) { collapse(); return true }
        if (p.x + p.width >= metrics.widthPixels && dx > dp(COLLAPSE_SWIPE_DP)) { collapse(); return true }
        p.x = (downX + dx).roundToInt().coerceIn(0, (metrics.widthPixels - p.width).coerceAtLeast(0))
        p.y = (downY + dy).roundToInt().coerceIn(0, (metrics.heightPixels - p.height).coerceAtLeast(0))
        runCatching { wm.updateViewLayout(view, p) }
        if (closeVisible) positionClose()
        return true
      }
      MotionEvent.ACTION_UP -> {
        if (!dragging) toggleClose()
        return true
      }
    }
    return false
  }

  private fun onGripTouch(view: View, event: MotionEvent): Boolean {
    val p = params ?: return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = event.rawX
        downRawY = event.rawY
        downX = p.width
        downY = p.height
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dw = event.rawX - downRawX
        val dh = event.rawY - downRawY
        val metrics = displayMetrics()
        val shortSide = minOf(metrics.widthPixels, metrics.heightPixels)
        val minWidth = (shortSide * MIN_RATIO).roundToInt()
        val maxWidth = (shortSide * MAX_RATIO).roundToInt()
        val byWidth = downX + dw.roundToInt()
        val byHeight = (downY + dh.roundToInt()) / aspect.toFloat()
        val target = if (abs(dw) >= abs(dh)) byWidth else byHeight.roundToInt()
        val width = target.coerceIn(minWidth, maxWidth.coerceAtLeast(minWidth))
        val height = (width * aspect).roundToInt().coerceAtLeast(dp(120))
        p.width = width
        p.height = height
        p.x = p.x.coerceIn(0, (metrics.widthPixels - width).coerceAtLeast(0))
        p.y = p.y.coerceIn(0, (metrics.heightPixels - height).coerceAtLeast(0))
        runCatching { wm.updateViewLayout(container, p) }
        if (closeVisible) positionClose()
        return true
      }
      MotionEvent.ACTION_UP -> return true
    }
    return false
  }

  // ── 叉 / 收起 / 恢复 ───────────────────────────────────────────────────────

  private fun toggleClose() {
    if (closeVisible) hideClose() else showClose()
  }

  private fun showClose() {
    val p = params ?: return
    val size = dp(CLOSE_SIZE_DP)
    val view = closeView ?: TextView(activity).apply {
      text = "✕"
      setTextColor(Color.WHITE)
      textSize = 16f
      gravity = Gravity.CENTER
      background = roundRect(HANDLE_COLOR, size / 2f)
      setOnClickListener { hideClose(); collapse() }
    }.also { closeView = it }
    val cp = WindowManager.LayoutParams(
      size,
      size,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }
    closeParams = cp
    closeVisible = true
    positionClose()
    if (view.parent === null) runCatching { wm.addView(view, cp) }
  }

  private fun positionClose() {
    val p = params ?: return
    val cp = closeParams ?: return
    cp.x = (p.x + p.width / 2 - cp.width / 2).coerceAtLeast(0)
    cp.y = (p.y - cp.height - dp(6)).coerceAtLeast(0)
    closeView?.let { view -> if (view.parent !== null) runCatching { wm.updateViewLayout(view, cp) } }
  }

  private fun hideClose() {
    closeVisible = false
    closeView?.let { view -> if (view.parent !== null) runCatching { wm.removeView(view) } }
  }

  /** 收起：只保留贴边把手（不销毁虚拟屏；Surface 交还，避免小窗空转）。 */
  private fun collapse() {
    val view = container ?: return
    val p = params ?: return
    if (collapsed) return
    hideClose()
    releaseSurface()
    collapsed = true
    restoredWidth = p.width
    restoredHeight = p.height
    val metrics = displayMetrics()
    edge = if (p.x + p.width / 2 < metrics.widthPixels / 2) Gravity.LEFT else Gravity.RIGHT
    p.width = dp(HANDLE_WIDTH_DP)
    p.height = dp(HANDLE_HEIGHT_DP)
    p.x = if (edge == Gravity.LEFT) 0 else metrics.widthPixels - p.width
    p.y = p.y.coerceIn(0, (metrics.heightPixels - p.height).coerceAtLeast(0))
    surfaceView?.visibility = View.GONE
    grip?.visibility = View.GONE
    view.background = roundRect(HANDLE_COLOR, dp(10).toFloat())
    runCatching { wm.updateViewLayout(view, p) }
  }

  /** 恢复：还原尺寸/位置并重新接管 Surface。 */
  private fun expand() {
    val view = container ?: return
    val p = params ?: return
    if (!collapsed) return
    collapsed = false
    p.width = restoredWidth
    p.height = restoredHeight
    val metrics = displayMetrics()
    p.x = if (edge == Gravity.LEFT) 0 else metrics.widthPixels - p.width
    p.y = p.y.coerceIn(0, (metrics.heightPixels - p.height).coerceAtLeast(0))
    view.background = null
    surfaceView?.visibility = View.VISIBLE
    grip?.visibility = View.VISIBLE
    runCatching { wm.updateViewLayout(view, p) }
    attachSurface()
  }

  // ── 环境 ──────────────────────────────────────────────────────────────────

  private fun dp(value: Int): Int = (value * density).roundToInt()

  private fun roundRect(color: Int, radius: Float): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
  }

  @Suppress("DEPRECATION")
  private fun displayMetrics(): DisplayMetrics {
    val metrics = DisplayMetrics()
    (activity.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
    return metrics
  }
}
