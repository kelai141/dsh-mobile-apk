package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import kotlin.math.hypot

/**
 * 状态药丸（§3.1 W4 / §4.2 PILL）：44dp 高、全圆角、单行文本 + 6dp 语义色点。
 *
 * 为什么这里只做「上报手势」而不做「消散」：
 * 消散阈值（起点贴顶、累计上推 >=48dp、末速度 >=500dp/s，§9.4）是**几何 + 手势**的联合判定，
 * 属于纯逻辑层 OverlayWindowFrames/GestureRouter 的可测职责。视图层若自己判，阈值就会有两份
 * 口径，且动画里销毁窗口的时机无法单测。因此本类只把阶段、累计位移、速度交给服务。
 *
 * 拖动位移语义（全 UI 统一契约）：dxPx/dyPx 都是**相对 ACTION_DOWN 的累计位移**；
 * 速度是 VelocityTracker 的 y 分量 px/s（向下为正，上推为负）。
 *
 * 本类不做窗口管理；44dp 是可视高度，窗口尺寸由服务侧几何函数给定。无 elevation：overlay
 * 窗口阴影投射不到窗口外（§7.4），层次只靠 94% 底色 + 1dp 描边。
 */
internal class OverlayPillView(
  private val context: Context,
  private val listener: OverlayPillListener,
) {

  private val density = context.resources.displayMetrics.density
  private val colorChip = ContextCompat.getColor(context, R.color.ds_chip)
  private val colorBorder = ContextCompat.getColor(context, R.color.ds_border)
  private val colorTextPrimary = ContextCompat.getColor(context, R.color.ds_text_primary)
  private val colorTextSecondary = ContextCompat.getColor(context, R.color.ds_text_secondary)
  private val colorWarn = ContextCompat.getColor(context, R.color.ds_warn)
  private val colorDanger = ContextCompat.getColor(context, R.color.ds_danger)

  private val toneDot = View(context).apply {
    background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(colorTextSecondary)
    }
  }

  private val label = TextView(context).apply {
    tag = "overlay-pill-label"
    textSize = 13f
    setTextColor(colorTextPrimary)
    maxLines = 1
    ellipsize = android.text.TextUtils.TruncateAt.END
  }

  /** 药丸根视图：唯一供服务塞进窗口的 View（窗口宽 = 内容宽，高 = 44dp）。 */
  val view: View = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = dp(44)
    background = GradientDrawable().apply {
      cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
      // 94% 不透明度：药丸是单行短文本，比卡片更亮一点才能在任意桌面背景上读得清。
      setColor(withAlpha(colorChip, 0.94f))
      setStroke(dp(1), colorBorder)
    }
    setPadding(dp(14), 0, dp(14), 0)
    addView(toneDot, LinearLayout.LayoutParams(dp(6), dp(6)).apply { marginEnd = dp(8) })
    addView(label, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    attachTouch()
  }

  /** 更新文案与语义色（幂等：和当前值相同则不动，避免事件风暴下的无效重绘）。 */
  fun render(text: String, tone: OverlayUiTone) {
    val next = overlaySingleLine(text)
    measuredText = next
    if (label.text?.toString() != next) label.text = next
    view.contentDescription = next
    val dotColor = when (tone) {
      OverlayUiTone.IDLE -> colorTextSecondary
      // WORKING 与 WAITING 同为琥珀：两者都是「需要用户看一眼」的中性提醒；
      // 拆两种颜色会让用户以为多了一种状态，而语义差异已经在文案里。
      OverlayUiTone.WORKING -> colorWarn
      OverlayUiTone.WAITING -> colorWarn
      OverlayUiTone.ERROR -> colorDanger
    }
    (toneDot.background as? GradientDrawable)?.setColor(dotColor)
  }

  /**
   * 药丸窗口该有多宽（像素）：内边距 + 色点 + 间距 + 当前文本单行宽度，再夹到
   * [minPillWidthPx, maxWidthPx]。
   *
   * 为什么由视图层测而不是服务层猜：文本宽度依赖字体、系统字号缩放（1.3x/1.5x）与语言，
   * 只有 Paint 知道。服务侧只负责传上限（屏宽 * 0.8，再经 OverlayWindowFrames.pillWidthPx
   * 收口）并在返回值不合理时用自己的下限兜底。
   *
   * @param maxWidthPx 调用方给的上限；<=0 表示调用方尚无有效几何，返回 0 交给其兜底。
   */
  fun measureContentWidthPx(maxWidthPx: Int): Int {
    if (maxWidthPx <= 0) return 0
    val textWidth = label.paint.measureText(measuredText)
    val padding = dp(14) * 2
    val dot = dp(6) + dp(8)
    val content = padding + dot + kotlin.math.ceil(textWidth).toInt()
    val lower = minPillWidthPx.coerceAtMost(maxWidthPx)
    return content.coerceIn(lower, maxWidthPx)
  }

  /** 出现：120ms alpha 0->1（§4.4）。动画关闭时立即到终态。 */
  fun fadeIn() {
    view.animate().cancel()
    if (!DsUi.animationsEnabled(context)) {
      view.alpha = 1f
      view.scaleX = 1f
      view.scaleY = 1f
      return
    }
    view.alpha = 0f
    view.animate().alpha(1f).setDuration(120L).setInterpolator(DecelerateInterpolator()).start()
  }

  /**
   * 消散：160ms alpha->0 + scale 1->0.92（§4.4）。
   *
   * 回调 onEnd 在动画关闭时必须**同步**调用：服务的窗口收口链依赖它把药丸窗移除，
   * 若关闭动画时漏调，屏上会留一个 alpha=0 但仍在吃触摸的窗口（残窗同形缺陷）。
   */
  fun fadeOutAndShrink(onEnd: () -> Unit) {
    view.animate().cancel()
    if (!DsUi.animationsEnabled(context)) {
      view.alpha = 0f
      view.scaleX = 0.92f
      view.scaleY = 0.92f
      onEnd()
      return
    }
    view.animate()
      .alpha(0f)
      .scaleX(0.92f)
      .scaleY(0.92f)
      .setDuration(160L)
      .setInterpolator(AccelerateInterpolator())
      .withEndAction { onEnd() }
      .start()
  }

  /** 拖动过程中的整体透明度（服务做「拖远变淡」时用；只改整窗 alpha，不改内容布局）。 */
  fun setContentAlpha(a: Float) {
    view.alpha = a.coerceIn(0f, 1f)
  }

  private var dragging = false
  private var downRawX = 0f
  private var downRawY = 0f
  private var lastDx = 0f
  private var lastDy = 0f
  private var tracker: VelocityTracker? = null

  /** 最近一次 render 的待测文本（measureContentWidthPx 只测文本，不触发排版）。 */
  private var measuredText = ""

  /** 药丸最小宽度：再窄就会让 6dp 色点 + 一行字看起来像个圆点而不是状态条。 */
  private val minPillWidthPx = dp(88)

  private val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true

    override fun onSingleTapUp(e: MotionEvent): Boolean {
      // 拖动过的手势不算点击：否则「往上推消散」的结束帧会顺带把卡片唤出来。
      if (!dragging) listener.onPillTap()
      return true
    }
  })

  private fun attachTouch() {
    val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    view.setOnTouchListener { _, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          tracker?.recycle()
          tracker = VelocityTracker.obtain().apply { addMovement(ev) }
          downRawX = ev.rawX
          downRawY = ev.rawY
          lastDx = 0f
          lastDy = 0f
          dragging = false
          gestureDetector.onTouchEvent(ev)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          tracker?.addMovement(ev)
          val dx = ev.rawX - downRawX
          val dy = ev.rawY - downRawY
          lastDx = dx
          lastDy = dy
          if (!dragging && hypot(dx.toDouble(), dy.toDouble()) > touchSlop.toDouble()) dragging = true
          // 先让 detector 看到 MOVE：它据此取消潜在的单击候选。
          gestureDetector.onTouchEvent(ev)
          if (dragging) listener.onPillDrag(OverlayDragPhase.MOVE, dx, dy, 0f)
          true
        }
        MotionEvent.ACTION_UP -> {
          val t = tracker
          t?.addMovement(ev)
          t?.computeCurrentVelocity(1000)
          // 速度取「当前主方向」：药丸可四向自由拖动，只报 y 会在纯横向拖动时给出 0，
          // 服务侧就分不清「慢」和「横向甩」。符号约定：向右/向下为正。
          val vx = t?.xVelocity ?: 0f
          val vy = t?.yVelocity ?: 0f
          val velocity = if (kotlin.math.abs(vx) > kotlin.math.abs(vy)) vx else vy
          // 先喂 detector（onSingleTapUp 在本调用内同步触发）；此时 dragging 仍为真，
          // 拖动收尾不会被误判为点击。
          gestureDetector.onTouchEvent(ev)
          if (dragging) listener.onPillDrag(OverlayDragPhase.UP, lastDx, lastDy, velocity)
          t?.recycle()
          tracker = null
          dragging = false
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          gestureDetector.onTouchEvent(ev)
          if (dragging) listener.onPillDrag(OverlayDragPhase.CANCEL, lastDx, lastDy, 0f)
          tracker?.recycle()
          tracker = null
          dragging = false
          true
        }
        else -> false
      }
    }
  }

  private fun withAlpha(color: Int, fraction: Float): Int =
    (color and 0x00FFFFFF) or ((fraction.coerceIn(0f, 1f) * 255f).toInt() shl 24)

  private fun dp(value: Int): Int = (value * density).toInt()
}
