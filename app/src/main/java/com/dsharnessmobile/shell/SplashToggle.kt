package com.dsharnessmobile.shell

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import android.widget.FrameLayout

/**
 * Pill toggle for the startup settings page.
 *
 * The native Switch draws a M3 track on some ROMs and a stock Holo track on others; this
 * control keeps the shell's own monochrome tokens and a 48dp touch target. It exposes
 * `isChecked`, `contentDescription` and `STATE_CHECKED` so accessibility and tests read
 * it like any other switch.
 */
internal class SplashToggle(private val context: Context) : FrameLayout(context) {
  private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val thumbPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val track = RectF()
  private val thumb = RectF()
  private var progress = 0f
  private var animator: ValueAnimator? = null

  var isChecked: Boolean = false
    private set

  /** Invoked after the visual state settles; the caller decides whether to persist. */
  var onChanged: ((Boolean) -> Unit)? = null

  private val onColor = context.getColor(R.color.ds_accent)
  private val offColor = context.getColor(R.color.ds_hairline)
  private val thumbOn = context.getColor(R.color.ds_bg)
  private val thumbOff = context.getColor(R.color.ds_surface)

  init {
    // ViewGroup 默认带 WILL_NOT_DRAW：若不显式清掉，onDraw 根本不会被调用，
    // 轨道与滑块都不画，只剩一个看不见但可点的热区（用户观感就是「按了没反应」）。
    setWillNotDraw(false)
    isClickable = true
    isFocusable = true
    minimumWidth = dp(64)
    minimumHeight = dp(48)
    layoutParams = LayoutParams(dp(64), dp(48))
    background = DsUi.ripple(DsUi.roundRect(android.graphics.Color.TRANSPARENT, dp(24).toFloat()), context.getColor(R.color.ds_accent_soft))
    setOnClickListener {
      setChecked(!isChecked, notify = true)
    }
  }

  fun setChecked(value: Boolean, notify: Boolean) {
    val next = value
    val changed = next != isChecked
    isChecked = next
    refreshStateDescription()
    animator?.cancel()
    val enabled = DsUi.animationsEnabled(context)
    if (!enabled) {
      progress = if (next) 1f else 0f
      invalidate()
    } else {
      animator = ValueAnimator.ofFloat(progress, if (next) 1f else 0f).apply {
        duration = 160L
        addUpdateListener { progress = it.animatedValue as Float; invalidate() }
        start()
      }
    }
    if (changed && notify) onChanged?.invoke(next)
  }

  private fun refreshStateDescription() {
    contentDescription = UiText.t(
      context,
      if (isChecked) "已开启" else "已关闭",
      if (isChecked) "On" else "Off",
    )
    stateDescription = contentDescription
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val h = dp(32).toFloat()
    val w = dp(56).toFloat()
    val left = (width - w) / 2f
    val top = (height - h) / 2f
    track.set(left, top, left + w, top + h)
    trackPaint.color = blend(offColor, onColor, progress)
    canvas.drawRoundRect(track, h / 2f, h / 2f, trackPaint)

    val inset = dp(3).toFloat()
    val size = h - inset * 2
    val travel = track.width() - size - inset * 2
    val cx = track.left + inset + travel * progress
    thumb.set(cx, track.top + inset, cx + size, track.top + inset + size)
    thumbPaint.color = blend(thumbOff, thumbOn, progress)
    canvas.drawOval(thumb, thumbPaint)
  }

  override fun setOnClickListener(l: OnClickListener?) {
    super.setOnClickListener(l)
    isClickable = true
  }

  // 注意：不要从 drawableState 推导 isChecked。这个控件不是 Checkable，也没有把
  // state_checked 写进 drawable state；按下时 ripple 改变 drawable state 会触发
  // drawableStateChanged，若在那里把 isChecked 置回 false，每次点击都会从 false 变成
  // true——开关就永远关不掉（0.14.9 真机实锤）。状态由 isChecked + onSaveInstanceState 管。

  override fun onSaveInstanceState(): android.os.Parcelable {
    val base = super.onSaveInstanceState()
    return android.os.Bundle().apply {
      putParcelable("super", base)
      putBoolean("checked", isChecked)
    }
  }

  override fun onRestoreInstanceState(state: android.os.Parcelable?) {
    if (state is android.os.Bundle) {
      super.onRestoreInstanceState(state.getParcelable("super"))
      isChecked = state.getBoolean("checked", false)
      progress = if (isChecked) 1f else 0f
      refreshStateDescription()
      invalidate()
      return
    }
    super.onRestoreInstanceState(state)
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private fun blend(from: Int, to: Int, t: Float): Int {
    val a = from ushr 24 and 0xFF
    val r = from shr 16 and 0xFF
    val g = from shr 8 and 0xFF
    val b = from and 0xFF
    val a2 = to ushr 24 and 0xFF
    val r2 = to shr 16 and 0xFF
    val g2 = to shr 8 and 0xFF
    val b2 = to and 0xFF
    val mix = { x: Int, y: Int -> (x + (y - x) * t).toInt().coerceIn(0, 255) }
    return (mix(a, a2) shl 24) or (mix(r, r2) shl 16) or (mix(g, g2) shl 8) or mix(b, b2)
  }

  companion object {
    /** Convenience factory that wires the pill into a right-aligned settings row. */
    fun create(context: Context, checked: Boolean, onChange: (Boolean) -> Unit): SplashToggle =
      SplashToggle(context).apply {
        setChecked(checked, notify = false)
        onChanged = onChange
      }
  }
}
