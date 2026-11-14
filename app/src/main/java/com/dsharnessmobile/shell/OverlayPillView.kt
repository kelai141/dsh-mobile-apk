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
 * 最新真实 Agent 输出长胶囊（§3.1 W4 / §9.2），单行省略 + 辅助语义色点。
 *
 * 为什么这里只做「上报手势」而不做「消散」：
 * 到顶、宽容区、按距离渐淡与不足回弹由 OverlayMotion 统一判定，不要求高速或另一次 DOWN。
 * 本类只上报阶段和累计位移；速度字段仅兼容旧监听接口，不作为视图侧隐藏门。
 *
 * 拖动位移语义（全 UI 统一契约）：dxPx/dyPx 都是**相对 ACTION_DOWN 的累计位移**；
 * 速度是 VelocityTracker 的 y 分量 px/s（向下为正，上推为负）。
 *
 * 本类不做窗口管理；尺寸由可配置 visual 与服务几何共同给定，数值待实测。无 elevation：overlay
 * 窗口阴影投射不到窗口外（§7.4），层次只靠实色 surface token + 1dp 描边，避免下层正文透入。
 */
internal class OverlayPillView(
  private val context: Context,
  private val listener: OverlayPillListener,
  private val visual: OverlayCapsuleVisualConfig = OverlayCapsuleVisualConfig(),
) {

  private val density = context.resources.displayMetrics.density
  private val colorChip = ContextCompat.getColor(context, R.color.ds_surface)
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
    includeFontPadding = false
    gravity = Gravity.CENTER_VERTICAL
    ellipsize = android.text.TextUtils.TruncateAt.END
  }

  private var attached = false
  private var motionEnabled = false
  private var unregisterMotionListener: (() -> Unit)? = null
  private var animationGeneration = 0
  private var finiteTargetAlpha: Float? = null
  private var finiteTargetScale = 1f
  private var finiteEnd: (() -> Unit)? = null
  private var textGeneration = 0

  /** 有界长胶囊根视图；文本只省略，不驱动逐帧或逐字窗口 resize。 */
  val view: View = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = (visual.heightDp * density).toInt().coerceAtLeast(1)
    background = GradientDrawable().apply {
      cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
      // 实色中性色保证任意下层应用背景上的真实输出可读，不做高成本折射。
      setColor(colorChip)
      setStroke(dp(1), colorBorder)
    }
    setPadding(dp(14), 0, dp(14), 0)
    addView(toneDot, LinearLayout.LayoutParams(dp(6), dp(6)).apply { marginEnd = dp(8) })
    addView(label, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
    attachTouch(this)
  }

  init {
    view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        attached = true
        motionEnabled = DsUi.animationsEnabled(context)
        unregisterMotionListener?.invoke()
        unregisterMotionListener = DsUi.registerMotionListener(context) {
          motionEnabled = DsUi.animationsEnabled(context)
          if (!motionEnabled) finishAnimations()
        }
      }

      override fun onViewDetachedFromWindow(v: View) {
        attached = false
        unregisterMotionListener?.invoke()
        unregisterMotionListener = null
        // 移窗不是动画完成：丢弃旧 onEnd，不能让它在下一次召回后移除新窗口。
        cancelFiniteAnimation()
        finishTextTransition()
        view.alpha = 1f
        view.scaleX = 1f
        view.scaleY = 1f
      }
    })
  }

  /** Caller must pass genuine latest assistant output; status is auxiliary, never a substitute. */
  fun renderOutput(latestOutput: String?, tone: OverlayUiTone, statusLabel: String = "") {
    val output = latestOutput.orEmpty().takeIf { it.isNotBlank() }
      ?: UiText.t(context, "暂无助手输出", "No assistant output yet")
    render(output, tone)
    val status = overlaySingleLine(statusLabel)
    if (status.isNotEmpty()) view.contentDescription = "${view.contentDescription}; $status"
  }

  /** 兼容文字入口；业务层应优先使用 renderOutput，不能把运行/空闲文案冒充正文。 */
  fun render(text: String, tone: OverlayUiTone) {
    val next = text.trim().replace(Regex("\\s+"), " ")
    if (measuredText != next) {
      val previous = measuredText
      measuredText = next
      finishTextTransition()
      if (attached && motionEnabled && previous.isNotEmpty() && finiteTargetAlpha != 0f) {
        label.text = previous
        val generation = textGeneration
        // 换文案：旧文案 60ms 退场、新文案 90ms 进场（时长取自 OverlayMotionSpec）。
        label.animate().alpha(0f).setDuration(OverlayMotionSpec.labelOutMs(reduced = false)).withEndAction {
          if (generation != textGeneration || !attached) return@withEndAction
          label.text = measuredText
          label.animate().alpha(1f).setDuration(OverlayMotionSpec.labelInMs(reduced = false))
            .withEndAction(null).start()
        }.start()
      } else {
        // First render, detached views and reduced motion must bind synchronously.
        label.text = next
        label.alpha = 1f
      }
    }
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

  /** 长胶囊宽度只由配置/可用几何决定；新输出不使它退回短状态 pill 或逐字抖动。 */
  fun measureContentWidthPx(maxWidthPx: Int): Int = visual.widthPx(maxWidthPx, density)

  /** 出现：120ms alpha 0->1（§4.4，时长取 [OverlayMotionSpec.pillInMs]）。动画关闭时立即到终态。 */
  fun fadeIn() {
    cancelFiniteAnimation()
    // 消散后同一实例可能被召回；启用动画时也必须撤销之前的 0.92 缩放。
    view.scaleX = 1f
    view.scaleY = 1f
    finiteTargetAlpha = 1f
    finiteTargetScale = 1f
    if (!attached || !motionEnabled) {
      finishAnimations()
      return
    }
    view.alpha = 0f
    val generation = animationGeneration
    // 时长取自 OverlayMotionSpec：动效关闭时是 0ms，那次动画不会启动。
    val durationMs = OverlayMotionSpec.pillInMs(reduced = !motionEnabled)
    if (durationMs <= 0L) { finishAnimations(); return }
    view.animate().alpha(1f).setDuration(durationMs).setInterpolator(DecelerateInterpolator())
      .withEndAction { if (generation == animationGeneration) finishAnimations() }.start()
  }

  /**
   * 消散：160ms alpha->0 + scale 1->0.92（§4.4，时长与幅度取 [OverlayMotionSpec]）。
   *
   * 回调 onEnd 在动画关闭时必须**同步**调用：服务的窗口收口链依赖它把药丸窗移除，
   * 若关闭动画时漏调，屏上会留一个 alpha=0 但仍在吃触摸的窗口（残窗同形缺陷）。
   */
  fun fadeOutAndShrink(onEnd: () -> Unit) {
    cancelFiniteAnimation()
    finiteTargetAlpha = 0f
    finiteTargetScale = OverlayMotionSpec.PILL_OUT_SCALE
    finiteEnd = onEnd
    if (!attached || !motionEnabled) {
      finishAnimations()
      return
    }
    val generation = animationGeneration
    val durationMs = OverlayMotionSpec.pillOutMs(reduced = !motionEnabled)
    if (durationMs <= 0L) { finishAnimations(); return }
    view.animate()
      .alpha(0f)
      .scaleX(OverlayMotionSpec.PILL_OUT_SCALE)
      .scaleY(OverlayMotionSpec.PILL_OUT_SCALE)
      .setDuration(durationMs)
      .setInterpolator(AccelerateInterpolator())
      .withEndAction { if (generation == animationGeneration) finishAnimations() }
      .start()
  }

  /** 有限动画立即终态；消散完成回调先摘除再调用，因此重复 finish 不会重复移窗。 */
  fun finishAnimations() {
    finishTextTransition()
    val alpha = finiteTargetAlpha ?: return
    val scale = finiteTargetScale
    val onEnd = finiteEnd
    cancelFiniteAnimation()
    view.alpha = alpha
    view.scaleX = scale
    view.scaleY = scale
    onEnd?.invoke()
  }

  private fun finishTextTransition() {
    textGeneration += 1
    label.animate().withEndAction(null).cancel()
    label.text = measuredText
    label.alpha = 1f
  }

  private fun cancelFiniteAnimation() {
    animationGeneration += 1
    finiteEnd = null
    finiteTargetAlpha = null
    view.animate().withEndAction(null).cancel()
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

  private val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true

    override fun onSingleTapUp(e: MotionEvent): Boolean {
      // 拖动过的手势不算点击：否则「往上推消散」的结束帧会顺带把卡片唤出来。
      if (!dragging) listener.onPillTap()
      return true
    }
  })

  private fun attachTouch(hit: View) {
    val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    val releaseVelocity = OverlayReleaseVelocity()
    hit.setOnTouchListener { _, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          tracker?.recycle()
          tracker = VelocityTracker.obtain().apply { addRawMovement(this, ev) }
          downRawX = ev.rawX
          downRawY = ev.rawY
          releaseVelocity.reset(ev.eventTime, ev.rawY)
          lastDx = 0f
          lastDy = 0f
          dragging = false
          // 服务必须先捕获窗口 DOWN 起点；否则首次 MOVE 会把药丸按默认原点定位。
          listener.onPillDrag(OverlayDragPhase.DOWN, 0f, 0f, 0f)
          gestureDetector.onTouchEvent(ev)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          tracker?.let { addRawMovement(it, ev) }
          releaseVelocity.add(ev.eventTime, ev.rawY)
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
          t?.let { addRawMovement(it, ev) }
          t?.computeCurrentVelocity(1000)
          // UP 可能比最后一个 MOVE 更远，也可能是首个越过 slop 的事件；必须取抬手坐标。
          val dx = ev.rawX - downRawX
          val dy = ev.rawY - downRawY
          if (!dragging && hypot(dx.toDouble(), dy.toDouble()) > touchSlop.toDouble()) dragging = true
          // 消散只认向上速度：横向甩动的负 vx 不能冒充上推。
          releaseVelocity.add(ev.eventTime, ev.rawY)
          val velocity = releaseVelocity.resolve(t?.yVelocity ?: 0f, ev.eventTime)
          // 先喂 detector（onSingleTapUp 在本调用内同步触发）；此时 dragging 仍为真，
          // 拖动收尾不会被误判为点击。
          gestureDetector.onTouchEvent(ev)
          if (dragging) listener.onPillDrag(OverlayDragPhase.UP, dx, dy, velocity)
          t?.recycle()
          tracker = null
          dragging = false
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          gestureDetector.onTouchEvent(ev)
          listener.onPillDrag(OverlayDragPhase.CANCEL, lastDx, lastDy, 0f)
          tracker?.recycle()
          tracker = null
          dragging = false
          true
        }
        else -> false
      }
    }
  }

  /** 窗口/把手跟手会改变局部坐标原点；速度必须在屏幕原始坐标系里计算。 */
  private fun addRawMovement(tracker: VelocityTracker, event: MotionEvent) {
    val raw = MotionEvent.obtain(event)
    raw.offsetLocation(event.rawX - event.x, event.rawY - event.y)
    tracker.addMovement(raw)
    raw.recycle()
  }

  private fun dp(value: Int): Int = (value * density).toInt()
}
