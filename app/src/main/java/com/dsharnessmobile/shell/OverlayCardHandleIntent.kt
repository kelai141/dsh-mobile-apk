package com.dsharnessmobile.shell

import kotlin.math.abs

/** 白条长按拖动与快甩共用裁决；速度只限制快甩，不限制明确长按后的上推。 */
internal class OverlayCardHandleIntent(private val holdMs: Long, private val slopPx: Float) {
  private var downAt = -1L
  private var movedBeforeHold = false
  private var active = false

  fun down(at: Long) { downAt = at; movedBeforeHold = false; active = true }
  fun move(at: Long, dyPx: Float) {
    if (active && at - downAt < holdMs && abs(dyPx) > slopPx) movedBeforeHold = true
  }
  fun held(at: Long): Boolean = active && !movedBeforeHold && at - downAt >= holdMs
  fun cancel() { active = false }

  fun release(at: Long, dyPx: Float, velocityPxPerS: Float, density: Float, expanded: Boolean): OverlayCardHandleAction {
    if (!active) return OverlayCardHandleAction.NONE
    val hold = held(at)
    active = false
    val d = density.coerceAtLeast(.1f)
    return when {
      dyPx <= -48f * d && (hold || velocityPxPerS <= -500f * d) -> OverlayCardHandleAction.COLLAPSE
      dyPx >= 24f * d -> OverlayCardHandleAction.EXPAND
      dyPx <= -24f * d && expanded && !hold -> OverlayCardHandleAction.RESTORE
      else -> OverlayCardHandleAction.NONE
    }
  }
}

internal enum class OverlayCardHandleAction { NONE, COLLAPSE, EXPAND, RESTORE }
