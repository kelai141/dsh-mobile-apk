package com.dsharnessmobile.shell

import kotlin.math.abs
import kotlin.math.pow

/**
 * Distance-only motion policy. All distances are pixels supplied by the owner of screen geometry.
 * provisional() is a starting point for device tuning, NOT a confirmed product threshold.
 * No clock, velocity, Android dependency, recurring work, layout or window mutation lives here.
 */
internal data class OverlayMotionConfig(
  val cardCollapseDistancePx: Float,
  val topTolerancePx: Float,
  val topFadeDistancePx: Float,
  val edgeDockDistancePx: Float,
  val edgePullDistancePx: Float,
  val dragSlopPx: Float,
  val edgeContactPx: Float = 0f,
  val cardCurvePower: Float = 0.85f,
  val fadeCurvePower: Float = 1f,
) {
  init {
    require(cardCollapseDistancePx.isFinite() && cardCollapseDistancePx > 0f)
    require(topTolerancePx.isFinite() && topTolerancePx >= 0f)
    require(topFadeDistancePx.isFinite() && topFadeDistancePx > 0f)
    require(edgeDockDistancePx.isFinite() && edgeDockDistancePx > 0f)
    require(edgePullDistancePx.isFinite() && edgePullDistancePx > 0f)
    require(dragSlopPx.isFinite() && dragSlopPx >= 0f)
    require(edgeContactPx.isFinite() && edgeContactPx >= 0f)
    require(cardCurvePower.isFinite() && cardCurvePower > 0f)
    require(fadeCurvePower.isFinite() && fadeCurvePower > 0f)
  }

  companion object {
    /**
     * Bound provisional collapse travel to the visible path above the handle TOP, so every DOWN
     * inside it can complete without negative/off-screen coordinates. Capture once at DOWN.
     * The 80% factor is provisional reserve, not a validated interaction threshold. No invented
     * minimum may exceed a tiny real budget; unavailable/invalid geometry leaves the card intact.
     */
    fun feasibleCollapseDistancePx(provisionalPx: Float, handleTopYPx: Float,
      safeTopPx: Float, reservePx: Float): Float? {
      if (!provisionalPx.isFinite() || provisionalPx <= 0f || !handleTopYPx.isFinite() ||
        !safeTopPx.isFinite() || safeTopPx < 0f || !reservePx.isFinite() || reservePx < 0f) return null
      val travel = handleTopYPx - safeTopPx - reservePx
      if (!travel.isFinite() || travel <= 0f) return null
      val distance = minOf(provisionalPx, travel * .8f)
      return distance.takeIf { it.isFinite() && it > 0f }
    }

    /** Provisional values only; pass ViewConfiguration.scaledTouchSlop when integrating. */
    fun provisional(density: Float, dragSlopPx: Float = 8f * density): OverlayMotionConfig {
      require(density.isFinite() && density > 0f)
      // Dock travel stays below the provisional 34dp ball radius: a center-start outward
      // stroke reaches it using on-screen coordinates; no negative rawX is required.
      return OverlayMotionConfig(84f * density, 12f * density, 28f * density,
        12f * density, 24f * density, dragSlopPx, edgeContactPx = 8f * density)
    }
  }
}

/** A clip/outline in the SAME local coordinate system as a fixed, already-measured card root. */
internal data class OverlayMotionSurface(
  val leftPx: Float,
  val topPx: Float,
  val widthPx: Float,
  val heightPx: Float,
  val cornerRadiusPx: Float,
) {
  init {
    require(leftPx.isFinite() && topPx.isFinite())
    require(widthPx.isFinite() && widthPx >= 0f && heightPx.isFinite() && heightPx >= 0f)
    require(cornerRadiusPx.isFinite() && cornerRadiusPx >= 0f)
  }
}

internal data class OverlayCardMorphFrame(
  val bounds: OverlayMotionSurface,
  val progress: Float,
  val shapeProgress: Float,
  val historyAlpha: Float,
  val capsuleAlpha: Float,
)

internal data class OverlayTopDragFrame(
  val topPx: Float,
  val overscrollPx: Float,
  val fadeProgress: Float,
  val alpha: Float,
  val hideReady: Boolean,
)

internal data class OverlayTopRelease(val hide: Boolean, val frame: OverlayTopDragFrame)
internal enum class OverlayEntryEdge { LEFT, RIGHT }

/** Bounds describe BALL left coordinates. Strip coordinates are derived at the selected edge. */
internal data class OverlayEntryDragBounds(
  val minLeftPx: Float,
  val maxLeftPx: Float,
  val ballWidthPx: Float,
  val stripWidthPx: Float,
) {
  init {
    require(minLeftPx.isFinite() && minLeftPx >= 0f && maxLeftPx.isFinite() && maxLeftPx >= minLeftPx)
    require(ballWidthPx.isFinite() && ballWidthPx > 0f)
    require(stripWidthPx.isFinite() && stripWidthPx > 0f && stripWidthPx <= ballWidthPx)
  }

  fun ballLeft(side: OverlayEntryEdge): Float = if (side == OverlayEntryEdge.LEFT) minLeftPx else maxLeftPx
  fun stripLeft(side: OverlayEntryEdge): Float = if (side == OverlayEntryEdge.LEFT) minLeftPx
    else maxLeftPx + ballWidthPx - stripWidthPx
}

/**
 * One pointer gesture, retained even across a terminal entry-view replacement. consumed is sticky:
 * the router must suppress pending click/double-click/long-press once it becomes true.
 * edgeProgress is 0..1 for the current stage (BALL -> dock or STRIP -> pull out).
 */
internal data class OverlayEntryDragState(
  val style: OverlayEntryStyle,
  val side: OverlayEntryEdge,
  val leftPx: Float,
  val edgeProgress: Float,
  val consumed: Boolean,
  val active: Boolean,
  val bounds: OverlayEntryDragBounds,
  internal val initialStyle: OverlayEntryStyle,
  internal val initialSide: OverlayEntryEdge,
  internal val initialLeftPx: Float,
  internal val originRawX: Float,
  internal val lastRawX: Float,
  internal val anchorRawX: Float,
  internal val anchorLeftPx: Float,
  internal val armedEdge: OverlayEntryEdge?,
  internal val edgeAnchorRawX: Float,
)

/** Provisional long-capsule sizing; caller remains the sole owner of actual WM geometry. */
internal data class OverlayCapsuleVisualConfig(
  val heightDp: Float = 44f,
  val minimumWidthDp: Float = 220f,
  val widthFraction: Float = 1f,
) {
  init {
    require(heightDp.isFinite() && heightDp > 0f)
    require(minimumWidthDp.isFinite() && minimumWidthDp > 0f)
    require(widthFraction.isFinite() && widthFraction > 0f && widthFraction <= 1f)
  }
  fun widthPx(maxWidthPx: Int, density: Float): Int {
    if (maxWidthPx <= 0) return 0
    require(density.isFinite() && density > 0f)
    return maxOf((minimumWidthDp * density).toInt(), (maxWidthPx * widthFraction).toInt())
      .coerceIn(1, maxWidthPx)
  }
}

internal class OverlayMotion(val config: OverlayMotionConfig) {
  /** Already nonlinear: a renderer should not ease this a second time. */
  fun cardProgress(upwardDistancePx: Float): Float = curve(unit(upwardDistancePx / config.cardCollapseDistancePx), config.cardCurvePower)

  /** No fling/elapsed-time requirement. CANCEL never commits, including at the complete distance. */
  fun cardRelease(upwardDistancePx: Float, cancelled: Boolean = false): Boolean =
    !cancelled && upwardDistancePx.isFinite() && upwardDistancePx >= config.cardCollapseDistancePx

  /** Optional full geometry projection; does not measure history or resize any window. */
  fun cardMorph(upwardDistancePx: Float, card: OverlayMotionSurface, capsule: OverlayMotionSurface): OverlayCardMorphFrame {
    val progress = unit(upwardDistancePx / config.cardCollapseDistancePx)
    val shape = cardProgress(upwardDistancePx)
    val width = lerp(card.widthPx, capsule.widthPx, shape)
    val height = lerp(card.heightPx, capsule.heightPx, shape)
    val radius = lerp(card.cornerRadiusPx, capsule.cornerRadiusPx, shape).coerceAtMost(minOf(width, height) / 2f)
    return OverlayCardMorphFrame(
      OverlayMotionSurface(lerp(card.leftPx, capsule.leftPx, shape), lerp(card.topPx, capsule.topPx, shape), width, height, radius),
      progress, shape, 1f - shape, shape,
    )
  }

  /**
   * dy is cumulative from DOWN. Reaching the top consumes only travel-to-top, not tolerance/fade.
   * The same DOWN can continue through tolerance and fade; reversing the finger reverses the fade.
   */
  fun topDrag(startTopPx: Float, dyPx: Float, topLimitPx: Float): OverlayTopDragFrame {
    val limit = finiteOr(topLimitPx, 0f).coerceAtLeast(0f)
    val start = finiteOr(startTopPx, limit).coerceAtLeast(limit)
    val desired = start + finiteOr(dyPx, 0f)
    val overscroll = (limit - desired).coerceAtLeast(0f)
    val rawFade = unit((overscroll - config.topTolerancePx) / config.topFadeDistancePx)
    val fade = curve(rawFade, config.fadeCurvePower)
    return OverlayTopDragFrame(desired.coerceAtLeast(limit), overscroll, fade, 1f - fade, rawFade >= 1f)
  }

  /** Incomplete/cancelled pushes recover a fully visible clamped surface, never half-alpha residue. */
  fun topRelease(frame: OverlayTopDragFrame, cancelled: Boolean = false): OverlayTopRelease =
    if (!cancelled && frame.hideReady) OverlayTopRelease(true, frame.copy(alpha = 0f, fadeProgress = 1f))
    else OverlayTopRelease(false, frame.copy(overscrollPx = 0f, fadeProgress = 0f, alpha = 1f, hideReady = false))

  fun entryDown(style: OverlayEntryStyle, side: OverlayEntryEdge, startLeftPx: Float,
    rawX: Float, bounds: OverlayEntryDragBounds): OverlayEntryDragState {
    val raw = finiteOr(rawX, 0f)
    val left = if (style == OverlayEntryStyle.STRIP) bounds.stripLeft(side)
      else finiteOr(startLeftPx, bounds.minLeftPx).coerceIn(bounds.minLeftPx, bounds.maxLeftPx)
    val edge = if (style == OverlayEntryStyle.BALL) contact(left, bounds) else null
    return OverlayEntryDragState(style, edge ?: side, left, 0f, false, true, bounds,
      style, side, left, raw, raw, raw, left, edge, raw)
  }

  fun entryMove(state: OverlayEntryDragState, rawX: Float): OverlayEntryDragState {
    if (!state.active || !rawX.isFinite()) return state
    val consumed = state.consumed || abs(rawX - state.originRawX) > config.dragSlopPx
    if (state.style == OverlayEntryStyle.STRIP) {
      val inward = (rawX - state.anchorRawX) * inwardSign(state.side)
      val progress = curve(unit(inward / config.edgePullDistancePx), 1f)
      if (inward < config.edgePullDistancePx) return state.copy(lastRawX = rawX, consumed = consumed, edgeProgress = progress)
      // Place the restored ball inside the screen, preserving any extra travel in this sample.
      val left = (state.bounds.ballLeft(state.side) + inward * inwardSign(state.side))
        .coerceIn(state.bounds.minLeftPx, state.bounds.maxLeftPx)
      val edge = contact(left, state.bounds)
      return state.copy(style = OverlayEntryStyle.BALL, leftPx = left, edgeProgress = 0f, consumed = true,
        lastRawX = rawX, anchorRawX = rawX, anchorLeftPx = left, armedEdge = edge, edgeAnchorRawX = rawX,
        side = edge ?: state.side)
    }

    val desired = state.anchorLeftPx + rawX - state.anchorRawX
    val left = desired.coerceIn(state.bounds.minLeftPx, state.bounds.maxLeftPx)
    val edge = contact(left, state.bounds)
    if (edge == null) return state.copy(leftPx = left, edgeProgress = 0f, consumed = consumed,
      lastRawX = rawX, armedEdge = null)
    // First contact only arms the edge. A huge first sample cannot skip the docked-ball stage.
    if (edge != state.armedEdge) return state.copy(leftPx = state.bounds.ballLeft(edge), side = edge,
      edgeProgress = 0f, consumed = consumed, lastRawX = rawX, armedEdge = edge, edgeAnchorRawX = rawX)
    val outward = (rawX - state.edgeAnchorRawX) * -inwardSign(edge)
    val progress = curve(unit(outward / config.edgeDockDistancePx), 1f)
    if (outward < config.edgeDockDistancePx) return state.copy(leftPx = state.bounds.ballLeft(edge),
      side = edge, edgeProgress = progress, consumed = consumed, lastRawX = rawX)
    return state.copy(style = OverlayEntryStyle.STRIP, side = edge, leftPx = state.bounds.stripLeft(edge),
      edgeProgress = 0f, consumed = true, lastRawX = rawX, anchorRawX = rawX,
      anchorLeftPx = state.bounds.ballLeft(edge), armedEdge = null, edgeAnchorRawX = rawX)
  }

  /** CANCEL rolls back only entry geometry, not service/session/draft state. */
  fun entryRelease(state: OverlayEntryDragState, cancelled: Boolean = false): OverlayEntryDragState =
    if (cancelled) state.copy(style = state.initialStyle, side = state.initialSide, leftPx = state.initialLeftPx,
      edgeProgress = 0f, active = false, armedEdge = null)
    else state.copy(edgeProgress = 0f, active = false, armedEdge = null)

  private fun contact(left: Float, bounds: OverlayEntryDragBounds): OverlayEntryEdge? = when {
    left <= bounds.minLeftPx + config.edgeContactPx -> OverlayEntryEdge.LEFT
    left >= bounds.maxLeftPx - config.edgeContactPx -> OverlayEntryEdge.RIGHT
    else -> null
  }
  private fun inwardSign(side: OverlayEntryEdge): Float = if (side == OverlayEntryEdge.LEFT) 1f else -1f
  private fun curve(value: Float, power: Float): Float {
    val t = value.pow(power)
    return t * t * (3f - 2f * t)
  }
  private fun unit(value: Float): Float = if (value.isNaN()) 0f else value.coerceIn(0f, 1f)
  private fun finiteOr(value: Float, fallback: Float): Float = if (value.isFinite()) value else fallback
  private fun lerp(start: Float, end: Float, progress: Float): Float = start + (end - start) * progress
}
