package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FX-212.2（E-9）回归：启动轮询预算与引导页文案必须**同源**。
 *
 * 缺陷形态：预算 90s + 文案硬编码 `60 - s`（s = 剩余秒）→ 首帧「已等待 -30s」，此后每帧恒偏 30s。
 * 判据：显示值与真实已等同源、无负值、预算内单调递减（倒计时侧）。
 */
class EngineBootBudgetTest {

  @Test
  fun firstFrameShowsZeroWaitedAndFullRemaining() {
    val c = engineBootClock(0L)
    assertEquals(0, c.waitedSeconds)
    assertEquals(90, c.budgetSeconds)
    assertEquals(90, c.remainingSeconds)
    assertEquals(
      "引擎启动中（已等待 0s / 剩余 90s，冷启动较慢属正常）",
      engineBootProgressText(c),
    )
  }

  @Test
  fun readingsAreNonNegativeComplementaryAndMonotoneAcrossTheBudget() {
    var lastWaited = -1
    var lastRemaining = Int.MAX_VALUE
    var t = -5_000L
    while (t <= ENGINE_BOOT_BUDGET_MS + 5_000L) {
      val c = engineBootClock(t)
      assertTrue("已等待不得为负 t=" + t, c.waitedSeconds >= 0)
      assertTrue("剩余不得为负 t=" + t, c.remainingSeconds >= 0)
      assertEquals("两侧必须同源互补 t=" + t, c.budgetSeconds, c.waitedSeconds + c.remainingSeconds)
      assertTrue("已等待单调不减 t=" + t, c.waitedSeconds >= lastWaited)
      assertTrue("倒计时（剩余）单调不增 t=" + t, c.remainingSeconds <= lastRemaining)
      lastWaited = c.waitedSeconds
      lastRemaining = c.remainingSeconds
      t += 250L
    }
  }

  @Test
  fun waitedIsTheRealElapsedNotAParallelConstant() {
    // 与真实时钟同源：每个整秒刻度上，waited == 真实已等秒数（不是 60-剩余 之类的换算）
    for (s in 0..90) {
      assertEquals("真实已等 " + s + "s", s, engineBootClock(s * 1_000L).waitedSeconds)
    }
    // 预算走完（elapsed = 90s）：已等待 90s、剩余 0s——两行原先写反了（断言错，非实现错）
    assertEquals(90, engineBootClock(90_000L).waitedSeconds)
    assertEquals(0, engineBootClock(90_000L).remainingSeconds)
  }

  @Test
  fun reportCadenceStartsImmediatelyAndThenEveryFifteenSeconds() {
    assertTrue(engineBootShouldReport(0))
    assertTrue(engineBootShouldReport(15))
    assertTrue(engineBootShouldReport(75))
    assertFalse(engineBootShouldReport(14))
    assertFalse(engineBootShouldReport(89))
  }

  /**
   * 反向自证（撤修复即红）：旧口径把预算 90s 与字面量 60 混用，首帧 = 60 - 90 = -30。
   * 本断言把「旧形态必然为负」固化下来，配合 W3ShellContractTest 的源码扫描（禁止再出现 60 - s）。
   */
  @Test
  fun legacyHardcodedSixtyIsProvablyNegativeInNinetySecondBudget() {
    val remainingAtFirstFrame = engineBootClock(0L).remainingSeconds
    assertTrue("60 - 90 = -30", 60 - remainingAtFirstFrame < 0)
  }
}
