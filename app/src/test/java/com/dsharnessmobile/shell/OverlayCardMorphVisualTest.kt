package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Pure interpolation and production wiring regression; lead owns actual native screen validation. */
class OverlayCardMorphVisualTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test fun historyAndCapsuleNeverShareVisibleTextAtAnyProgress() {
    for (step in 0..10000) {
      val frame = overlayCardMorphTextAlpha(step / 10000f)
      assertTrue(frame.historyAlpha in 0f..1f)
      assertTrue(frame.capsuleAlpha in 0f..1f)
      assertTrue("History and capsule must never overlap: " + step, frame.historyAlpha == 0f || frame.capsuleAlpha == 0f)
    }
  }

  @Test fun historyAndHandleDisappearEarlyBeforeCapsuleAppears() {
    assertEquals(OverlayCardMorphTextAlpha(1f, 0f), overlayCardMorphTextAlpha(0f))
    assertEquals(OverlayCardMorphTextAlpha(0f, 0f), overlayCardMorphTextAlpha(0.3f))
    assertEquals(OverlayCardMorphTextAlpha(0f, 0f), overlayCardMorphTextAlpha(0.4f))
    assertEquals(OverlayCardMorphTextAlpha(0f, 0f), overlayCardMorphTextAlpha(0.5f))
    assertEquals(OverlayCardMorphTextAlpha(0f, 1f), overlayCardMorphTextAlpha(1f))
    assertEquals(0.5f, overlayCardMorphTextAlpha(0.15f).historyAlpha, 0.00001f)
    assertEquals(0.5f, overlayCardMorphTextAlpha(0.75f).capsuleAlpha, 0.00001f)
  }

  @Test fun alphaPhasesAreContinuousMonotoneAndSafeForRebound() {
    var previous = overlayCardMorphTextAlpha(0f)
    for (step in 1..10000) {
      val frame = overlayCardMorphTextAlpha(step / 10000f)
      assertTrue(frame.historyAlpha <= previous.historyAlpha)
      assertTrue(frame.capsuleAlpha >= previous.capsuleAlpha)
      assertTrue(kotlin.math.abs(frame.historyAlpha - previous.historyAlpha) < 0.001f)
      assertTrue(kotlin.math.abs(frame.capsuleAlpha - previous.capsuleAlpha) < 0.001f)
      previous = frame
    }
    for (step in 10000 downTo 0) {
      val frame = overlayCardMorphTextAlpha(step / 10000f)
      assertTrue(frame.historyAlpha == 0f || frame.capsuleAlpha == 0f)
    }
    assertEquals(overlayCardMorphTextAlpha(0f), overlayCardMorphTextAlpha(Float.NaN))
    assertEquals(overlayCardMorphTextAlpha(0f), overlayCardMorphTextAlpha(-10f))
    assertEquals(overlayCardMorphTextAlpha(1f), overlayCardMorphTextAlpha(10f))
  }

  @Test fun phaseTuningMustNotPermitOverlappingWindows() {
    for ((outEnd, inStart) in listOf(0.7f to 0.5f, 0f to 0.5f, 0.3f to 1f)) {
      var rejected = false
      try { overlayCardMorphTextAlpha(0.5f, outEnd, inStart) } catch (_: IllegalArgumentException) { rejected = true }
      assertTrue("Invalid phase tuning must not reintroduce overlap", rejected)
    }
    for (step in 0..1000) {
      val frame = overlayCardMorphTextAlpha(step / 1000f, 0.25f, 0.6f)
      assertTrue(frame.historyAlpha == 0f || frame.capsuleAlpha == 0f)
    }
  }

  @Test fun actualCardAndPillUseSolidTokenSurfaceAndSeparatePhaseAlphas() {
    val card = source("OverlayCardView.kt")
    val surface = card.substringAfter("private inner class CardSurface").substringBefore("private inner class CapsuleOutput")
    assertTrue(surface.contains("surfaceFillPaint.color = colorSurface"))
    assertTrue(surface.contains("surfaceFillPaint.alpha = 255"))
    assertFalse(surface.contains("statusDotPaint"))
    assertFalse(surface.contains("withAlpha(colorSurface"))
    val output = card.substringAfter("private inner class CapsuleOutput").substringBefore("private val cardSurface")
    assertTrue(output.contains("if (morphCapsuleAlpha <= 0f) return"))
    assertTrue(output.contains("capsulePaint.alpha = (morphCapsuleAlpha * 255).toInt()"))
    assertFalse(output.contains("morphProgress * 255"))
    assertTrue(output.contains("statusDotPaint.alpha = (morphCapsuleAlpha * 255).toInt()"))
    assertFalse(output.contains("surfaceFillPaint"))
    assertFalse(output.contains("surfaceBorderPaint"))
    val apply = card.substringAfter("fun applyMorph(").substringBefore("fun resetMorph()")
    assertTrue(apply.contains("overlayCardMorphTextAlpha(morphProgress)"))
    assertTrue(apply.contains("val historyAlpha = textAlpha.historyAlpha"))
    assertTrue(apply.contains("morphCapsuleAlpha = textAlpha.capsuleAlpha"))
    for (child in listOf("headerRow", "scrollView", "handleHit")) assertTrue(apply.contains(child + ".alpha = historyAlpha"))
    val reset = card.substringAfter("fun resetMorph()").substringBefore("fun setHandleOffsetPx(")
    assertTrue(reset.contains("morphCapsuleAlpha = 0f"))
    val pill = source("OverlayPillView.kt")
    assertTrue(pill.contains("setColor(colorChip)"))
    assertFalse(pill.contains("withAlpha(colorChip"))
  }

  @Test fun controlledNegativeOldSimultaneousFadeCannotPassNoOverlapInvariant() {
    val progress = 0.5f
    val old = OverlayCardMorphTextAlpha(1f - progress, progress)
    assertTrue(old.historyAlpha > 0f && old.capsuleAlpha > 0f)
    val repaired = overlayCardMorphTextAlpha(progress)
    assertTrue(repaired.historyAlpha == 0f || repaired.capsuleAlpha == 0f)
  }
}
