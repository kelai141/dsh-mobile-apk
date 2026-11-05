package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class ConsoleImeOverlapTest {
  @Test fun unresizedViewReportsTheFullKeyboardOverlap() {
    assertEquals(522, consoleImeOverlap(900, 378, 522))
  }
  @Test fun resizedViewDoesNotChargeForTheKeyboardAgain() {
    assertEquals(0, consoleImeOverlap(378, 378, 522))
  }
  @Test fun partiallyResizedViewReportsOnlyTheRemainingOverlap() {
    assertEquals(222, consoleImeOverlap(600, 378, 522))
  }
  @Test fun hiddenKeyboardDoesNotTurnNavigationBarsIntoImeOverlap() {
    assertEquals(0, consoleImeOverlap(900, 852, 0))
  }
  @Test fun positionedWindowUsesScreenRelativeBounds() {
    assertEquals(200, consoleImeOverlap(800, 600, 300))
  }
  @Test fun missingAndNonOverlappingFramesAreSafe() {
    assertEquals(0, consoleImeOverlap(0, 378, 522))
    assertEquals(0, consoleImeOverlap(900, 0, 522))
    assertEquals(0, consoleImeOverlap(300, 378, 522))
    assertEquals(0, consoleImeOverlap(900, 378, -1))
  }
}
