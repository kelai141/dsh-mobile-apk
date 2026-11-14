package com.dsharnessmobile.shell

import android.animation.TimeInterpolator
import android.view.View
import android.view.ViewPropertyAnimator

/** 纯规格的缓动曲线映射成系统插值器：数值只在 OverlayMotionSpec 里定义，这里不写第二份。 */
internal fun OverlayEasing.interpolator(): TimeInterpolator = TimeInterpolator { t -> transform(t) }

/**
 * 一次性「出现」过渡的执行器（卡片行/标签、抽屉列表行共用）。
 *
 * 为什么独立成类而不是散在各 View 里：
 *  1. 每个落点都要同一套「起手 alpha=0 + 上移几 dp → 归位」的数值，散写必然漂移；
 *  2. 需要**在任何时刻**都能一次性收口（系统关动画、视图移出窗口），收口必须同时取消动画并写终态，
 *     否则取消中的属性动画会把 alpha 停在中间值，留下半透明的行；
 *  3. 只在 attached 且动效开启时启动；关闭动效时同步写终态，不留一帧。
 *
 * 纪律：只动 alpha 与 translationY（渲染属性，不改 layout/窗口几何），不产生常驻动画。
 */
internal class OverlayRevealPlayer(private val risePx: Float) {

  private class Entry(val view: View, val animator: ViewPropertyAnimator)

  private val running = ArrayList<Entry>()

  /** 是否还有未收口的出现过渡（负控/排查用）。 */
  fun isRunning(): Boolean = running.isNotEmpty()

  /**
   * 播放一次出现过渡。
   *
   * @param view 要出现的行/标签（它的父层级已可见，本方法不改可见性）。
   * @param index 同一批出现里的序号，只用于错峰延迟；单个标签传 0。
   * @param enabled 是否允许动画（调用方必须同时判 attached 与动效开关）。
   */
  fun reveal(view: View, index: Int, enabled: Boolean) {
    if (!enabled) {
      settle(view)
      return
    }
    val duration = OverlayMotionSpec.rowAppearMs(reduced = false)
    if (duration <= 0L) {
      settle(view)
      return
    }
    cancelFor(view)
    view.alpha = 0f
    view.translationY = -risePx
    val animator = view.animate()
      .alpha(1f)
      .translationY(0f)
      .setStartDelay(OverlayMotionSpec.stagedDelayMs(index, reduced = false))
      .setDuration(duration)
      .setInterpolator(OverlayEasing.DECELERATE.interpolator())
    val entry = Entry(view, animator)
    running.add(entry)
    animator.withEndAction { running.remove(entry) }
    animator.start()
  }

  /** 立即到终态：取消动画并写 alpha=1 / 位移 0，供关动效与移出窗口使用。 */
  fun settleAll() {
    val pending = running.toList()
    running.clear()
    for (entry in pending) {
      entry.animator.withEndAction(null).cancel()
      settleInternal(entry.view)
    }
  }

  /** 单个视图立即到终态（行被隐藏时调用，避免下次出现继承半透明残留）。 */
  fun settle(view: View) {
    cancelFor(view)
    view.animate().withEndAction(null).cancel()
    view.alpha = 1f
    view.translationY = 0f
  }

  private fun settleInternal(view: View) {
    view.animate().withEndAction(null).cancel()
    view.alpha = 1f
    view.translationY = 0f
  }

  private fun cancelFor(view: View) {
    val iterator = running.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      if (entry.view === view) {
        entry.animator.withEndAction(null).cancel()
        iterator.remove()
      }
    }
  }
}
