package com.dsharnessmobile.shell

import java.net.ServerSocket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ST-12（F-APK-04）回归：`stateJson()` 背后的轻量真源探测与其 TTL 复用。
 *
 * 缺陷形态：`wirelessDebugOn` 直接回读 `paired` 偏好、`connected` 只读 prefs——关掉系统
 * 无线调试或重启手机后展示面长期「已授权」。判据：关闭后 ≤3s 降级，因此探测缓存 TTL 必须
 * 小于页面轮询周期（3s），且失败不得被旧的成功值遮盖。
 */
class AdbLiveProbeTest {

  @Test
  fun ttlReusesTheProbeInsideTheWindowAndReprobesAfterIt() {
    var calls = 0
    var now = 1_000L
    val probe = LiveProbe(2_000L) { now }
    assertTrue(probe.value { calls++; true })
    probe.value { calls++; true }
    assertEquals("TTL 内不得重复探测", 1, calls)
    now += 1_999L
    probe.value { calls++; true }
    assertEquals("TTL 内不得重复探测（边界内）", 1, calls)
    now += 2L
    probe.value { calls++; true }
    assertEquals("TTL 过期必须重探（真源优先）", 2, calls)
  }

  @Test
  fun failureReplacesThePreviousSuccessInsteadOfBeingMasked() {
    var now = 0L
    var live = true
    val probe = LiveProbe(500L) { now }
    assertTrue(probe.value { live })
    now += 600L
    live = false
    assertFalse("关掉无线调试后必须立刻降级（不得复用旧 true）", probe.value { live })
    now += 600L
    assertFalse(probe.value { live })
  }

  @Test
  fun invalidateForcesTheNextProbeImmediately() {
    var calls = 0
    val now = { 5_000L }
    val probe = LiveProbe(60_000L, now)
    probe.value { calls++; true }
    probe.value { calls++; true }
    assertEquals(1, calls)
    probe.invalidate()
    probe.value { calls++; false }
    assertEquals("invalidate 后必须重探（重新配对/回收场景）", 2, calls)
  }

  @Test
  fun tcpProbeDistinguishesAListeningLoopbackPortFromAClosedOne() {
    val server = ServerSocket(0)
    val port = server.localPort
    try {
      assertTrue("监听中的 loopback 端口必须可达", tcpProbe("127.0.0.1", port, 1_000))
    } finally {
      server.close()
    }
    assertFalse("关闭后的端口必须不可达（这就是「无线调试关掉」的判据）", tcpProbe("127.0.0.1", port, 1_000))
  }
}
