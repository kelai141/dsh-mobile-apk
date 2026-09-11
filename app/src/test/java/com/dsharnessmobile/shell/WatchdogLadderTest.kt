package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #175 回归：DEGRADED_HTTP 阶梯的纯计数函数——HTTP 型半死连续 N 拍升级受控重启；
 * 其它状态（HEALTHY/DEGRADED_LOG/DEAD）一律清零（DEGRADED_LOG 绝不触发重启）。
 */
class WatchdogLadderTest {

  @Test
  fun degradedHttpCountsIncrementally() {
    assertEquals(1, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_HTTP, 0))
    assertEquals(6, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_HTTP, 5))
    assertEquals(7, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_HTTP, 6))
  }

  @Test
  fun otherStatesResetTheCounter() {
    assertEquals(0, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.HEALTHY, 5))
    assertEquals(0, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEAD, 5))
    // DEGRADED_LOG 不得触发重启：清零是硬约束
    assertEquals(0, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_LOG, 5))
  }

  @Test
  fun thresholdIsSixTicks30Seconds() {
    assertTrue("阈值 6 拍 = 30s，须远小于 90s 冷启动窗口", WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS == 6)
    assertTrue(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS < WatchdogV2.MAX_CONSEC_FAILURES)
  }
}
