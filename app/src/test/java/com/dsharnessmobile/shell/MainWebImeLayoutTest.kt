package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class MainWebImeLayoutTest {
  @Test fun fullHeightWindowConsumesTheAnimatedInset() {
    assertEquals(80, remainingImeOverlap(800, 720, 80))
    assertEquals(300, remainingImeOverlap(800, 500, 300))
  }

  @Test fun alreadyResizedWindowConsumesOnlyRemainingOverlap() {
    assertEquals(40, remainingImeOverlap(540, 500, 300))
    assertEquals(0, remainingImeOverlap(500, 500, 300))
    assertEquals(0, remainingImeOverlap(475, 500, 300))
  }

  @Test fun hidingImeClearsTheMargin() {
    assertEquals(0, remainingImeOverlap(800, 500, 0))
  }
}
