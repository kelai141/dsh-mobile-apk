package com.dsharnessmobile.shell

import kotlin.math.sqrt

/**
 * 入口手势裁决结果。
 *
 * 为什么把拖动拆成 START/MOVE/END 三档：渲染层要分别做「起拖时抬起视觉反馈」、
 * 「拖动中跟手位移」、「松手后吸边/回弹」，三者动画不同，合成一个 DRAG 就没法区分。
 */
internal enum class EntryGesture { NONE, TAP, DOUBLE_TAP, LONG_PRESS, DRAG_START, DRAG_MOVE, DRAG_END }

/** Outside与入口DOWN属于同次触摸时只收一次，不能按被outside改变后的可见态误重开。 */
internal fun overlayEntryTapShouldOpen(cardVisibleAtDown: Boolean, outsideClosedSameDown: Boolean): Boolean =
  !cardVisibleAtDown && !outsideClosedSameDown

/**
 * 悬浮入口（球/细条）的单/双/长按/拖动裁决器。
 *
 * 为什么需要它：Android 的 GestureDetector 把「单击」判定的责任留给调用方、
 * 长按又会与拖动赛跑，且这些判定散在 OnTouchListener 里根本没法单测。
 * 这里只做纯判定：输入位移与时间，输出一个 [EntryGesture]，调用方照做即可。
 *
 * 时间与位移都由调用方从 MotionEvent 换算后传入，本类不碰任何 Android 类型。
 *
 * @param touchSlopPx 超过该位移才算拖动（ViewConfiguration.getScaledTouchSlop 的像素值）。
 * @param doubleTapTimeoutMs 双击窗口；未拖动的第二次抬起距第一次抬起不超过它即判双击。
 * @param longPressTimeoutMs 长按到期时间（ViewConfiguration.getLongPressTimeout）。
 */
internal class OverlayGestureRouter(
  private val touchSlopPx: Float,
  private val doubleTapTimeoutMs: Long,
  private val longPressTimeoutMs: Long,
) {
  /** 本次手势是否已跨过 touchSlop（拖动进行中）。 */
  private var dragging = false

  /** 本次手势是否已经派发过长按（一次性）。 */
  private var longPressFired = false

  /** 本次手势按下时刻；用于长按到期判定。 */
  private var downAtMs = 0L

  /** 是否有一次「按下」尚未结束；reset/抬起/长按派发后置 false。 */
  private var downActive = false

  /** 上一次「未拖动的抬起」时刻；null = 当前没有可配对的单击候选。 */
  private var lastTapUpAtMs: Long? = null

  /** 是否有一个单击在等待双击窗口过去（调用方在窗口结束时调 [resolvePendingTap]）。 */
  private var pendingTap = false

  /**
   * 按下：开启一次新手势。
   *
   * 为什么这里不清 pendingTap / lastTapUpAtMs：第二次按下的目的可能正是组成双击，
   * 若在按下时就清掉配对信息，双击永远不可能成立（双击判定必须保留上一次抬起时刻）。
   */
  fun onDown(atMs: Long) {
    downAtMs = atMs
    downActive = true
    dragging = false
    longPressFired = false
  }

  /**
   * 移动：只有位移真正超过 touchSlop 才升级为拖动。
   *
   * 为什么阈值内返回 NONE：手指按住时的自然抖动若被当成拖动，
   * 长按与单击都会被自己打断——「未超过 slop 不判拖动、也不打断长按候选」是设计口径。
   *
   * @param dxPx 相对按下点的横向位移（px）。
   * @param dyPx 相对按下点的纵向位移（px）。
   * @returns 首次越过阈值给 DRAG_START，之后给 DRAG_MOVE，阈值内给 NONE。
   */
  fun onMove(dxPx: Float, dyPx: Float): EntryGesture {
    if (!downActive) return EntryGesture.NONE
    if (dragging) return EntryGesture.DRAG_MOVE
    if (distance(dxPx, dyPx) <= touchSlopPx) return EntryGesture.NONE
    dragging = true
    // 已经拖起来的手势不再可能是单击/双击/长按：清掉配对信息，
    // 避免松手后调用方还按旧时间窗口判出一次双击。
    pendingTap = false
    lastTapUpAtMs = null
    return EntryGesture.DRAG_START
  }

  /**
   * 抬起：决定这次手势是拖动结束、双击还是「待定单击」。
   *
   * 为什么未拖动的第一次抬起返回 NONE 而不是 TAP：此时还不知道会不会有第二次点击，
   * 立刻发 TAP 会让双击先闪一次单击动作（例如先展开再收起）。
   * 调用方等 [doubleTapTimeoutMs] 后调 [resolvePendingTap] 取迟到的那次 TAP。
   *
   * @param dxPx 抬起时相对按下点的横向位移。
   * @param dyPx 抬起时相对按下点的纵向位移。
   * @param atMs 抬起时刻 ms。
   */
  fun onUp(dxPx: Float, dyPx: Float, atMs: Long): EntryGesture {
    if (!downActive) return EntryGesture.NONE
    downActive = false
    val wasDragging = dragging || distance(dxPx, dyPx) > touchSlopPx
    dragging = false
    if (wasDragging) {
      pendingTap = false
      lastTapUpAtMs = null
      return EntryGesture.DRAG_END
    }
    if (longPressFired) {
      // 长按已经消费了这次手势：抬起不得再产生单击/双击（一次手势一个动作）。
      longPressFired = false
      return EntryGesture.NONE
    }
    val last = lastTapUpAtMs
    if (last != null && atMs >= last && atMs - last <= doubleTapTimeoutMs) {
      // 双击成立：两枚单击都已被消费掉，不得再留一个待定单击。
      pendingTap = false
      lastTapUpAtMs = null
      return EntryGesture.DOUBLE_TAP
    }
    lastTapUpAtMs = atMs
    pendingTap = true
    return EntryGesture.NONE
  }

  /**
   * 长按到期回调：只有「没在拖、且没派发过」才成立。
   *
   * 为什么要检查 atMs - downAtMs：调用方可能因主线程卡顿晚到回调，
   * 也会在同一次手势里重复调用，只有真正到期且未消化的那次才该派发。
   */
  fun onLongPress(atMs: Long): EntryGesture {
    if (!downActive) return EntryGesture.NONE
    if (dragging) return EntryGesture.NONE
    if (longPressFired) return EntryGesture.NONE
    if (atMs - downAtMs < longPressTimeoutMs) return EntryGesture.NONE
    longPressFired = true
    // 长按已消费本次手势：清掉单击候选，避免窗口到期后再补发一次 TAP。
    pendingTap = false
    lastTapUpAtMs = null
    return EntryGesture.LONG_PRESS
  }

  /**
   * 双击窗口结束后的结算：把「待定单击」兑现成 TAP。
   *
   * 为什么用 >= 而不是 >：窗口长度就是 doubleTapTimeoutMs，恰好到点时
   * 已经不可能再有同一次双击，继续等只会让单击更迟才响应。
   */
  fun resolvePendingTap(atMs: Long): EntryGesture {
    val last = lastTapUpAtMs
    if (!pendingTap || last == null) return EntryGesture.NONE
    if (atMs - last < doubleTapTimeoutMs) return EntryGesture.NONE
    pendingTap = false
    lastTapUpAtMs = null
    return EntryGesture.TAP
  }

  /** 当前手势是否处于拖动中（用于渲染层决定是否跟随位移）。 */
  fun isDragging(): Boolean = dragging

  /**
   * 重置全部状态：手势被系统打断（ACTION_CANCEL）、窗口重建或入口形态切换时调用。
   *
   * 为什么连待定单击也清掉：形态切换后旧的手势时间窗口不再有意义，
   * 留着会在新窗口上凭空补发一次 TAP。
   */
  fun reset() {
    dragging = false
    longPressFired = false
    downActive = false
    downAtMs = 0L
    lastTapUpAtMs = null
    pendingTap = false
  }

  /** 相对按下点的欧氏距离；用浮点而非平方比较，小位移边界才与 touchSlop 同口径。 */
  private fun distance(dxPx: Float, dyPx: Float): Float =
    sqrt(dxPx * dxPx + dyPx * dyPx)
}

/** 有界原始坐标末速补偿：部分系统在UP后VT归零，停住或反向绝不复用陈旧上推。 */
internal class OverlayReleaseVelocity {
  private val samples = ArrayList<Pair<Long, Float>>()
  private var movedAt = Long.MIN_VALUE
  private var lastDirection = 0f
  fun reset(at: Long, y: Float) { samples.clear(); samples.add(at to y); movedAt = Long.MIN_VALUE; lastDirection = 0f }
  fun add(at: Long, y: Float) {
    val last = samples.lastOrNull()
    if (last != null && at < last.first) { reset(at, y); return }
    if (last != null && y != last.second) { movedAt = at; lastDirection = y - last.second }
    samples.add(at to y)
    while (samples.size > 2 && samples[1].first < at - 100L) samples.removeAt(0)
    while (samples.size > 32) samples.removeAt(0)
  }
  override fun toString(): String = "samples=$samples movedAt=$movedAt"
  fun resolve(tracked: Float, upAt: Long): Float {
    if (tracked != 0f && tracked.isFinite()) return tracked
    if (movedAt == Long.MIN_VALUE || upAt - movedAt !in 0..80) return 0f
    val last = samples.lastOrNull() ?: return 0f
    // 稀疏输入可能只有DOWN/UP（如120ms的短甩），保留窗口前一采样但跨度不得超过200ms。
    val first = samples.firstOrNull { it.first >= upAt - 200 && it.first < last.first } ?: return 0f
    val elapsed = last.first - first.first
    val delta = last.second - first.second
    if (delta * lastDirection <= 0f) return 0f // 同窗末段反向：不能把旧上推净差当成末速。
    return if (elapsed > 0) delta * 1000f / elapsed else 0f
  }
}
