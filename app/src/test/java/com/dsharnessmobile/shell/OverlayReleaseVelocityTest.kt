package com.dsharnessmobile.shell

import org.junit.Assert.*
import org.junit.Test

class OverlayReleaseVelocityTest {
  @Test fun zeroTrackerUsesRecentRawMotion() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(20, 180f); v.add(80, 80f); v.add(90, 60f)
    assertTrue(v.resolve(0f, 90) < -1000f)
  }
  @Test fun sparseShortFlickRetainsDownSample() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(120, 60f)
    assertTrue(v.resolve(0f, 120) < -1000f)
  }
  @Test fun nonzeroTrackerRemainsAuthoritative() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(80, 20f)
    assertEquals(-600f, v.resolve(-600f, 80), 0f)
  }
  @Test fun holdBeforeReleaseNeverUsesOldFlick() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(50, 20f); v.add(200, 20f)
    assertEquals(0f, v.resolve(0f, 200), 0f)
  }
  @Test fun horizontalOnlyNeverBecomesUpwardVelocity() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(50, 200f)
    assertEquals(0f, v.resolve(0f, 50), 0f)
  }
  @Test fun downwardFinalMovementCannotBecomeUpwardFlick() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(50, 80f); v.add(150, 80f); v.add(180, 140f)
    assertTrue(v.resolve(0f, 180) > 0f)
  }
  @Test fun reversalInsideSameWindowCannotReuseUpwardNetMotion() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(50, 80f); v.add(80, 120f)
    assertEquals(0f, v.resolve(0f, 80), 0f)
  }
  @Test fun resetClearsPreviousGesture() {
    val v = OverlayReleaseVelocity(); v.reset(0, 200f); v.add(50, 20f); v.reset(100, 20f); v.add(120, 20f)
    assertEquals(0f, v.resolve(0f, 120), 0f)
  }
  @Test fun sameTimestampCannotDivideByZero() {
    val v = OverlayReleaseVelocity(); v.reset(10, 200f); v.add(10, 20f)
    assertEquals(0f, v.resolve(0f, 10), 0f)
  }
}
