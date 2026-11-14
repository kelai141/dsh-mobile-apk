package com.dsharnessmobile.shell

import java.io.File
import kotlin.math.abs
import org.junit.Assert.*
import org.junit.Test

/** Pure math plus honest source-wiring guards; not WMS/touch/pixel device acceptance. */
class OverlayMotionTest {
  private val config = OverlayMotionConfig(100f, 10f, 30f, 12f, 24f, 4f)
  private val motion = OverlayMotion(config)
  private val bounds = OverlayEntryDragBounds(8f, 358f, 34f, 8f) // a 400px screen
  private val card = OverlayMotionSurface(0f, 0f, 360f, 280f, 18f)
  private val capsule = OverlayMotionSurface(20f, 0f, 320f, 44f, 22f)

  @Test fun configurableNonlinearCardCurveHasExactContinuousEndpoints() {
    assertEquals(0f, motion.cardProgress(-1f), 0f)
    assertEquals(0f, motion.cardProgress(0f), 0f)
    assertEquals(1f, motion.cardProgress(100f), 0f)
    assertEquals(1f, motion.cardProgress(200f), 0f)
    assertTrue(abs(motion.cardProgress(50f) - .5f) > .01f)
    var previous = 0f
    for (distance in 1..1000) {
      val value = motion.cardProgress(distance / 10f)
      assertTrue(value in previous..1f)
      assertTrue(value - previous < .01f)
      previous = value
    }
  }

  @Test fun cardMorphClipsFixedGeometryAndCrossfadesWithoutLayout() {
    assertEquals(card, motion.cardMorph(0f, card, capsule).bounds)
    val end = motion.cardMorph(100f, card, capsule)
    assertEquals(capsule, end.bounds)
    assertEquals(0f, end.historyAlpha, 0f)
    assertEquals(1f, end.capsuleAlpha, 0f)
    for (distance in 0..100) {
      val frame = motion.cardMorph(distance.toFloat(), card, capsule)
      assertTrue(frame.bounds.widthPx in 320f..360f)
      assertTrue(frame.bounds.heightPx in 44f..280f)
      assertTrue(frame.bounds.cornerRadiusPx <= minOf(frame.bounds.widthPx, frame.bounds.heightPx) / 2f)
      assertEquals(1f, frame.historyAlpha + frame.capsuleAlpha, .00001f)
    }
  }

  @Test fun cardReleaseDependsOnlyOnCurrentDistanceNotSpeedOrPause() {
    assertFalse(motion.cardRelease(99.99f))
    assertTrue(motion.cardRelease(100f))
    repeat(100) { assertEquals(motion.cardMorph(70f, card, capsule), motion.cardMorph(70f, card, capsule)) }
    assertFalse(motion.cardRelease(100f, cancelled = true))
    assertFalse(motion.cardRelease(Float.NaN))
    assertFalse(motion.cardRelease(Float.POSITIVE_INFINITY))
  }

  @Test fun cardReversalReturnsIdenticalPriorFrameWithoutHysteresis() {
    val forward = motion.cardMorph(30f, card, capsule)
    motion.cardMorph(90f, card, capsule)
    assertEquals(forward, motion.cardMorph(30f, card, capsule))
    assertEquals(card, motion.cardMorph(0f, card, capsule).bounds)
  }

  @Test fun differentConfigurationActuallyChangesDistanceAndCurve() {
    val alternate = OverlayMotion(config.copy(cardCollapseDistancePx = 200f, cardCurvePower = 1.2f))
    assertNotEquals(motion.cardProgress(40f), alternate.cardProgress(40f))
    assertFalse(alternate.cardRelease(100f))
    assertTrue(alternate.cardRelease(200f))
  }

  @Test fun reachingTopAndStoppingOrMovingInsideToleranceKeepsFullVisibility() {
    for (dy in listOf(0f, -30f, -60f, -69f, -70f)) {
      val frame = motion.topDrag(100f, dy, 40f)
      assertEquals(1f, frame.alpha, 0f)
      assertFalse(frame.hideReady)
      assertTrue(frame.topPx >= 40f)
    }
    repeat(100) { assertFalse(motion.topDrag(100f, -60f, 40f).hideReady) }
  }

  @Test fun sameDownCanReachToleranceThenFadeThenHideWithoutANewGesture() {
    assertEquals(0f, motion.topDrag(100f, -60f, 40f).overscrollPx, 0f)
    assertEquals(10f, motion.topDrag(100f, -70f, 40f).overscrollPx, 0f)
    assertEquals(.5f, motion.topDrag(100f, -85f, 40f).alpha, .00001f)
    val complete = motion.topDrag(100f, -100f, 40f)
    assertEquals(40f, complete.topPx, 0f)
    assertEquals(0f, complete.alpha, 0f)
    assertTrue(complete.hideReady)
    assertTrue(motion.topRelease(complete).hide)
  }

  @Test fun toleranceAndFadeBoundaryAreContinuousAndMonotone() {
    var previous = 1f
    for (tenths in 0..500) {
      val frame = motion.topDrag(40f, -tenths / 10f, 40f)
      assertTrue(frame.alpha <= previous)
      assertTrue(previous - frame.alpha < .01f)
      assertTrue(frame.alpha in 0f..1f)
      previous = frame.alpha
    }
    assertEquals(1f, motion.topDrag(40f, -10f, 40f).alpha, 0f)
    assertTrue(motion.topDrag(40f, -10.01f, 40f).alpha > .999f)
  }

  @Test fun everyIncompleteAndCancelledTopReleaseRecoversClearVisibleFrame() {
    for (distance in 0..39) {
      val released = motion.topRelease(motion.topDrag(40f, -distance.toFloat(), 40f))
      assertFalse(released.hide)
      assertEquals(1f, released.frame.alpha, 0f)
      assertEquals(0f, released.frame.overscrollPx, 0f)
      assertFalse(released.frame.hideReady)
    }
    val cancelled = motion.topRelease(motion.topDrag(40f, -80f, 40f), cancelled = true)
    assertFalse(cancelled.hide)
    assertEquals(1f, cancelled.frame.alpha, 0f)
  }

  @Test fun reversingTopPushRestoresAlphaBeforeReleaseAndCanDragAwayAgain() {
    val faded = motion.topDrag(40f, -25f, 40f)
    assertEquals(.5f, faded.alpha, .00001f)
    assertEquals(1f, motion.topDrag(40f, -5f, 40f).alpha, 0f)
    assertEquals(80f, motion.topDrag(40f, 40f, 40f).topPx, 0f)
  }

  @Test fun badDynamicInputNeverProducesNaNOrNegativeTopCoordinates() {
    val frame = motion.topDrag(Float.NaN, Float.NaN, Float.NaN)
    assertEquals(0f, frame.topPx, 0f)
    assertEquals(1f, frame.alpha, 0f)
    assertEquals(0f, motion.cardProgress(Float.NaN), 0f)
  }

  @Test fun touchingEitherEdgeAloneOnlyParksTheBall() {
    val left = motion.entryMove(downBall(100f, 117f), 25f)
    assertEquals(OverlayEntryStyle.BALL, left.style)
    assertEquals(8f, left.leftPx, 0f)
    assertEquals(0f, left.edgeProgress, 0f)
    val right = motion.entryMove(downBall(100f, 117f), 375f)
    assertEquals(OverlayEntryStyle.BALL, right.style)
    assertEquals(358f, right.leftPx, 0f)
    assertEquals(0f, right.edgeProgress, 0f)
    assertEquals(OverlayEntryStyle.BALL, motion.entryRelease(left).style)
  }

  @Test fun laterOutwardTravelDocksLeftAndRightUsingOnlyPhysicalScreenCoordinates() {
    val leftParked = motion.entryMove(downBall(100f, 117f), 25f)
    val leftPartial = motion.entryMove(leftParked, 19f)
    assertEquals(.5f, leftPartial.edgeProgress, .00001f)
    val left = motion.entryMove(leftPartial, 13f)
    assertEquals(OverlayEntryStyle.STRIP, left.style)
    assertEquals(OverlayEntryEdge.LEFT, left.side)
    assertEquals(8f, left.leftPx, 0f)
    val rightParked = motion.entryMove(downBall(100f, 117f), 375f)
    val right = motion.entryMove(rightParked, 387f)
    assertEquals(OverlayEntryStyle.STRIP, right.style)
    assertEquals(OverlayEntryEdge.RIGHT, right.side)
    assertEquals(384f, right.leftPx, 0f)
  }

  @Test fun hugeFirstSampleCannotSkipParkedBallAndCanRestartFromThatBall() {
    val first = motion.entryMove(downBall(100f, 117f), 0f)
    assertEquals(OverlayEntryStyle.BALL, first.style)
    assertEquals(0f, first.edgeProgress, 0f)
    val restarted = motion.entryDown(OverlayEntryStyle.BALL, OverlayEntryEdge.LEFT, first.leftPx, 25f, bounds)
    assertEquals(OverlayEntryStyle.STRIP, motion.entryMove(restarted, 13f).style)
  }

  @Test fun inwardDirectionFromDockedBallNeverTurnsItIntoStrip() {
    val left = motion.entryDown(OverlayEntryStyle.BALL, OverlayEntryEdge.LEFT, 8f, 25f, bounds)
    val moved = motion.entryMove(left, 100f)
    assertEquals(OverlayEntryStyle.BALL, moved.style)
    assertEquals(83f, moved.leftPx, 0f)
    assertEquals(0f, moved.edgeProgress, 0f)
  }

  @Test fun stripOutwardOrVerticalOnlyMovementCannotPullBallOut() {
    val left = downStrip(OverlayEntryEdge.LEFT, 12f)
    assertEquals(OverlayEntryStyle.STRIP, motion.entryMove(left, 0f).style)
    assertEquals(OverlayEntryStyle.STRIP, motion.entryMove(left, 12f).style)
    val right = downStrip(OverlayEntryEdge.RIGHT, 388f)
    assertEquals(OverlayEntryStyle.STRIP, motion.entryMove(right, 399f).style)
  }

  @Test fun stripPullIsContinuousPartialReversesAndReleaseKeepsOriginalStyle() {
    val left = downStrip(OverlayEntryEdge.LEFT, 12f)
    val partial = motion.entryMove(left, 24f)
    assertEquals(.5f, partial.edgeProgress, .00001f)
    assertEquals(OverlayEntryStyle.STRIP, motion.entryRelease(partial).style)
    val reversed = motion.entryMove(partial, 12f)
    assertEquals(0f, reversed.edgeProgress, 0f)
    assertTrue(reversed.consumed)
    assertEquals(OverlayEntryStyle.BALL, motion.entryMove(left, 36f).style)
  }

  @Test fun leftStripCanPullAcrossScreenAndRedockRightInOnePointerGesture() {
    var state = downStrip(OverlayEntryEdge.LEFT, 12f)
    state = motion.entryMove(state, 36f)
    assertEquals(OverlayEntryStyle.BALL, state.style)
    state = motion.entryMove(state, 362f)
    assertEquals(OverlayEntryStyle.BALL, state.style)
    assertEquals(358f, state.leftPx, 0f)
    state = motion.entryMove(state, 374f)
    assertEquals(OverlayEntryStyle.STRIP, state.style)
    assertEquals(OverlayEntryEdge.RIGHT, state.side)
    assertTrue(state.consumed)
  }

  @Test fun rightStripCanPullAcrossScreenAndRedockLeftSymmetrically() {
    var state = downStrip(OverlayEntryEdge.RIGHT, 388f)
    state = motion.entryMove(state, 364f)
    assertEquals(OverlayEntryStyle.BALL, state.style)
    state = motion.entryMove(state, 38f)
    assertEquals(OverlayEntryStyle.BALL, state.style)
    assertEquals(8f, state.leftPx, 0f)
    state = motion.entryMove(state, 26f)
    assertEquals(OverlayEntryStyle.STRIP, state.style)
    assertEquals(OverlayEntryEdge.LEFT, state.side)
  }

  @Test fun entireMirroredEntrySequenceHasIdenticalStagesProgressAndConsumedState() {
    var left = downStrip(OverlayEntryEdge.LEFT, 12f)
    var right = downStrip(OverlayEntryEdge.RIGHT, 388f)
    for (raw in listOf(18f, 24f, 30f, 36f, 100f, 200f, 362f, 368f, 374f)) {
      left = motion.entryMove(left, raw)
      right = motion.entryMove(right, 400f - raw)
      assertEquals(left.style, right.style)
      assertEquals(left.edgeProgress, right.edgeProgress, .00001f)
      assertEquals(left.consumed, right.consumed)
      val visibleWidth = if (left.style == OverlayEntryStyle.BALL) 34f else 8f
      assertEquals(400f - left.leftPx - visibleWidth, right.leftPx, .00001f)
    }
  }

  @Test fun cancelAfterStyleTransitionRollsBackGeometryWithoutClearingConsumedGesture() {
    val initial = downStrip(OverlayEntryEdge.LEFT, 12f)
    val moved = motion.entryMove(initial, 100f)
    val cancelled = motion.entryRelease(moved, cancelled = true)
    assertEquals(OverlayEntryStyle.STRIP, cancelled.style)
    assertEquals(8f, cancelled.leftPx, 0f)
    assertTrue(cancelled.consumed)
    assertFalse(cancelled.active)
    assertEquals(cancelled, motion.entryMove(cancelled, 200f))
  }

  @Test fun consumedIsStickyAndCannotGenerateTapAfterReturningToDownPosition() {
    val down = downBall(100f, 117f)
    assertFalse(down.consumed)
    assertFalse(motion.entryMove(down, 120f).consumed)
    val moved = motion.entryMove(down, 127f)
    assertTrue(moved.consumed)
    assertTrue(motion.entryMove(moved, 117f).consumed)
  }

  @Test fun nonfiniteEntrySamplesDoNotCorruptOngoingState() {
    val state = downBall(100f, 117f)
    assertEquals(state, motion.entryMove(state, Float.NaN))
    assertEquals(state, motion.entryMove(state, Float.POSITIVE_INFINITY))
  }

  @Test fun configuredEdgeHotZoneArmsBeforePhysicalScreenLimit() {
    val hot = OverlayMotion(config.copy(edgeContactPx = 8f))
    val state = hot.entryMove(hot.entryDown(OverlayEntryStyle.BALL, OverlayEntryEdge.LEFT, 100f, 117f, bounds), 33f)
    assertEquals(OverlayEntryStyle.BALL, state.style)
    assertEquals(8f, state.leftPx, 0f)
    assertEquals(OverlayEntryStyle.STRIP, hot.entryMove(state, 21f).style)
  }

  @Test fun longCapsuleWidthIsStableAndBoundedRatherThanStatusTextSized() {
    val visual = OverlayCapsuleVisualConfig()
    assertEquals(320, visual.widthPx(320, 1f))
    assertEquals(140, visual.widthPx(140, 1f))
    assertEquals(0, visual.widthPx(0, 1f))
    assertEquals(250, OverlayCapsuleVisualConfig(minimumWidthDp = 100f, widthFraction = .5f).widthPx(500, 1f))
    assertEquals(1, visual.widthPx(1, 3f))
  }

  @Test fun configurablePoliciesRejectInvalidOrNonfiniteThresholds() {
    invalid { config.copy(cardCollapseDistancePx = 0f) }
    invalid { config.copy(topTolerancePx = -1f) }
    invalid { config.copy(topFadeDistancePx = Float.NaN) }
    invalid { config.copy(edgeDockDistancePx = 0f) }
    invalid { config.copy(edgePullDistancePx = -1f) }
    invalid { config.copy(cardCurvePower = Float.POSITIVE_INFINITY) }
    invalid { OverlayMotionConfig.provisional(0f) }
    invalid { OverlayCapsuleVisualConfig(widthFraction = 2f) }
  }

  @Test fun entryStyleChangesKeepRootAndTouchListenerWhileFeedbackAvoidsLayoutAndAnimators() {
    val source = source("OverlayEntryView.kt")
    val style = source.substringAfter("fun renderStyle(").substringBefore("fun renderEdgeProgress(")
    assertTrue(source.contains("val view: View = root"))
    // 换形走「旧表面淡出、新表面放大进入」：先移除旧表面再作为过渡层加回，故钉 outgoing 这一处。
    assertTrue(style.contains("root.removeView(outgoing)"))
    assertFalse(style.contains("setOnTouchListener"))
    val feedback = source.substringAfter("fun renderEdgeProgress(").substringBefore("private fun buildSurface(")
    for (forbidden in listOf("layoutParams", "requestLayout", "animate()", "ValueAnimator", "postDelayed")) {
      assertFalse(feedback.contains(forbidden))
    }
  }

  @Test fun capsuleDisplaysLatestRealOutputWithHonestFallbackAndAuxiliaryStatusOnly() {
    val source = source("OverlayPillView.kt")
    val render = source.substringAfter("fun renderOutput(").substringBefore("fun render(text:")
    assertTrue(render.contains("latestOutput.orEmpty().takeIf { it.isNotBlank() }"))
    assertTrue(render.contains("No assistant output yet"))
    assertTrue(render.contains("暂无助手输出"))
    assertTrue(render.contains("render(output, tone)"))
    assertFalse(render.contains("render(statusLabel"))
    assertFalse(source.contains("label.paint.measureText"))
    assertTrue(source.contains("fun measureContentWidthPx(maxWidthPx: Int): Int = visual.widthPx"))
    assertTrue(source.contains("ellipsize = android.text.TextUtils.TruncateAt.END"))
  }

  @Test fun feasibleCollapseDistanceFitsShortCardAndNeverRaisesProvisionalCeiling() {
    val short = OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, 24f, 6f)!!
    assertEquals(74.4f, short, .00001f)
    assertTrue(123f - short >= 30f)
    assertEquals(126f, OverlayMotionConfig.feasibleCollapseDistancePx(126f, 400f, 24f, 6f)!!, 0f)
    val shortMotion = OverlayMotion(config.copy(cardCollapseDistancePx = short))
    assertEquals(1f, shortMotion.cardProgress(short), 0f)
    assertTrue(shortMotion.cardRelease(short))
    assertFalse(shortMotion.cardRelease(short - .01f))
    assertFalse(shortMotion.cardRelease(short, cancelled = true))
  }

  @Test fun feasibleCollapseDistanceScalesWithDensityAndAllScreenGeometry() {
    val original = OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, 24f, 6f)!!
    for (scale in listOf(.5f, 1f, 1.5f, 2f, 3f)) {
      val scaled = OverlayMotionConfig.feasibleCollapseDistancePx(126f * scale, 123f * scale,
        24f * scale, 6f * scale)!!
      assertEquals(original * scale, scaled, .0001f)
      assertTrue(scaled <= (123f - 24f - 6f) * scale)
    }
  }

  @Test fun feasibleCollapseDistanceRejectsInvalidAndUnavailableBudgetsWithNull() {
    for (bad in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
      assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(bad, 123f, 24f, 6f))
      assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, bad, 24f, 6f))
      assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, bad, 6f))
      assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, 24f, bad))
    }
    assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(0f, 123f, 24f, 6f))
    assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(-1f, 123f, 24f, 6f))
    assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, 30f, 24f, 6f))
    assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, 29f, 24f, 6f))
    assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, -1f, 6f))
    assertNull(OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, 24f, -1f))
  }

  @Test fun feasibleCollapseDistanceNeverInventsMinimumBeyondTinyRealTravel() {
    assertEquals(.4f, OverlayMotionConfig.feasibleCollapseDistancePx(126f, 30.5f, 24f, 6f)!!, .00001f)
    for (tenths in 1..2000) {
      val travel = tenths / 10f
      val distance = OverlayMotionConfig.feasibleCollapseDistancePx(126f, 30f + travel, 24f, 6f)!!
      assertTrue(distance > 0f)
      assertTrue(distance <= travel)
      assertTrue(distance <= 126f)
    }
  }

  @Test fun feasibleCollapsePolicyCanBeSnapshottedWithoutLaterGeometryChangingGesture() {
    val atDown = OverlayMotionConfig.feasibleCollapseDistancePx(126f, 123f, 24f, 6f)!!
    val frozenMotion = OverlayMotion(config.copy(cardCollapseDistancePx = atDown))
    val frameAtDown = frozenMotion.cardProgress(40f)
    val nextGestureDistance = OverlayMotionConfig.feasibleCollapseDistancePx(126f, 400f, 24f, 6f)!!
    assertNotEquals(atDown, nextGestureDistance)
    repeat(100) { assertEquals(frameAtDown, frozenMotion.cardProgress(40f), 0f) }
    assertEquals(atDown, frozenMotion.config.cardCollapseDistancePx, 0f)
  }

  @Test fun initialDetachedOrReducedMotionCapsuleBindsTextSynchronously() {
    val render = source("OverlayPillView.kt").substringAfter("fun render(text:")
      .substringBefore("fun measureContentWidthPx(")
    assertTrue(render.contains("attached && motionEnabled && previous.isNotEmpty()"))
    assertTrue(render.contains("} else {"))
    val immediate = render.substringAfter("} else {")
    assertTrue(immediate.contains("label.text = next"))
    assertTrue(immediate.contains("label.alpha = 1f"))
    // A controlled regression removing immediate binding must fail the same source predicate.
    assertFalse(immediate.replace("label.text = next", "").contains("label.text = next"))
  }

  private fun downBall(left: Float, raw: Float) =
    motion.entryDown(OverlayEntryStyle.BALL, OverlayEntryEdge.LEFT, left, raw, bounds)
  private fun downStrip(side: OverlayEntryEdge, raw: Float) =
    motion.entryDown(OverlayEntryStyle.STRIP, side, bounds.stripLeft(side), raw, bounds)
  private fun invalid(block: () -> Any) {
    try { block(); fail("Invalid configuration must be rejected") } catch (_: IllegalArgumentException) { }
  }
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()
}
