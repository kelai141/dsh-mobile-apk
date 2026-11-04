package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1357 回归：看门狗的拍长记账必须用单调时钟。
 *
 * 缺陷形态：`tickMs = now - lastWatchdogTickAt` 用的是墙钟；系统时间前跳时 tickMs 变得极大，
 * 而 `tickUnits` 封顶 6 个标准拍 ⇒ 两次观测即可把 DEGRADED_HTTP 推满 12 拍熔断。
 * 唤醒锁用的却是 `elapsedRealtime`——两处不同域。
 */
class WatchdogMonotonicClockTest {

  private fun tick(): String {
    val src = File(File("src/main/java/com/dsharnessmobile/shell"), "EngineService.kt").readText()
    val start = src.indexOf("private fun watchdogTick(")
    assertTrue("找不到 watchdogTick", start > 0)
    return src.substring(start, start + 1400)
  }

  @Test
  fun `拍长必须来自单调时钟`() {
    val body = tick()
    assertTrue("必须取 elapsedRealtime", body.contains("android.os.SystemClock.elapsedRealtime()"))
    assertTrue("tickMs 必须用单调时钟计算", body.contains("mono - epoch.lastWatchdogTickAt"))
    assertTrue("记账点必须写单调时钟", body.contains("epoch.lastWatchdogTickAt = mono"))
  }

  @Test
  fun `不得再用墙钟算拍长`() {
    val body = tick()
    assertTrue(
      "不得出现「墙钟 now 直接参与 tickMs」的旧写法",
      !body.contains("else now - epoch.lastWatchdogTickAt"),
    )
  }
}
