package com.dsharnessmobile.shell

import org.junit.Assert.*
import org.junit.Test

class OverlayCardHandleIntentTest {
  private fun intent() = OverlayCardHandleIntent(500L, 8f)
  @Test fun deliberateHeldSlowPushCollapsesWithoutFlingVelocity() {
    val i = intent(); i.down(0); i.move(550, -10f); i.move(900, -80f)
    assertEquals(OverlayCardHandleAction.COLLAPSE, i.release(1200, -80f, -40f, 1.5f, false))
  }
  @Test fun slowPushWithoutFirstHoldingDoesNotPretendToBeHeld() {
    val i = intent(); i.down(0); i.move(50, -20f); i.move(700, -80f)
    assertEquals(OverlayCardHandleAction.NONE, i.release(900, -80f, -40f, 1.5f, false))
  }
  @Test fun insufficientHeldDistanceReturnsWithoutCollapsingExpandedCard() {
    val i = intent(); i.down(0); i.move(600, -40f)
    assertEquals(OverlayCardHandleAction.NONE, i.release(900, -40f, 0f, 1.5f, true))
  }
  @Test fun fastUpShortcutStillWorksWithoutHolding() {
    val i = intent(); i.down(0); i.move(20, -80f)
    assertEquals(OverlayCardHandleAction.COLLAPSE, i.release(50, -80f, -1000f, 1.5f, false))
  }
  @Test fun downwardExpansionAndShortExpandedRestoreAreDistinct() {
    val i = intent(); i.down(0); i.move(20, 40f)
    assertEquals(OverlayCardHandleAction.EXPAND, i.release(200, 40f, 20f, 1.5f, false))
    i.down(500); i.move(520, -40f)
    assertEquals(OverlayCardHandleAction.RESTORE, i.release(700, -40f, -20f, 1.5f, true))
  }
  @Test fun cancellationAndDuplicateReleaseCannotCommit() {
    val i = intent(); i.down(0); i.cancel()
    assertEquals(OverlayCardHandleAction.NONE, i.release(800, -90f, -1000f, 1.5f, false))
    i.down(1000)
    assertEquals(OverlayCardHandleAction.COLLAPSE, i.release(1800, -90f, 0f, 1.5f, false))
    assertEquals(OverlayCardHandleAction.NONE, i.release(1900, -90f, 0f, 1.5f, false))
  }
}
