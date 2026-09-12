package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.14.0-preview / 性能 §7.2 壳侧插桩回归（P-AC-03 + P-AC-04）。
 *
 * - C1（P-AC-03）：UV_THREADPOOL_SIZE = min(8, cores) 的取值逻辑（注入那一半由
 *   W3ShellContractTest 的源码扫描锁定）；
 * - P-AC-04：启动分段三字段 t_boot_start / t_listen / t_compose_total 的解析与格式化——
 *   探针口径必须与 scripts/perf/count-compose.mjs 的 TOTAL totalMs= 同源（判据差 <5%），
 *   「未知」用 -1 而不是 0，且任何输入都不得派生负数。
 */
class EngineBootInstrumentationTest {

  @Test
  fun uvThreadPoolSizeIsMinOfEightAndCoresWithFloorOne() {
    assertEquals(1, uvThreadPoolSize(1))
    assertEquals(2, uvThreadPoolSize(2))
    assertEquals(4, uvThreadPoolSize(4))
    assertEquals(6, uvThreadPoolSize(6))
    assertEquals(8, uvThreadPoolSize(8))
    assertEquals("超过 8 核不再放大（避免线程池反噬）", 8, uvThreadPoolSize(16))
    assertEquals("退化输入按 1 处理（不得出现 0/负线程池）", 1, uvThreadPoolSize(0))
    assertEquals(1, uvThreadPoolSize(-4))
  }

  @Test
  fun composeTotalIsParsedFromTheProbeLine() {
    val line = "[perf] TOTAL calls=2 totalMs=17007 instances=1 firstAt=125ms"
    assertEquals(17007L, LogCollector.parseComposeTotalMs(line))
    assertEquals(17007L, LogCollector.parseComposeTotalMs("noise\n" + line + "\ntail"))
    assertEquals("多条 TOTAL 取最后一条", 42L, LogCollector.parseComposeTotalMs(line + "\n[perf] TOTAL calls=3 totalMs=42 instances=1 firstAt=9ms"))
    assertNull("无探针在场不得编造数值", LogCollector.parseComposeTotalMs("engine ready on 3080"))
    assertNull(LogCollector.parseComposeTotalMs(""))
    assertNull("形态不符（缺 calls）不认", LogCollector.parseComposeTotalMs("[perf] TOTAL totalMs=17007"))
  }

  @Test
  fun bootSegmentsLineCarriesAllThreeFields() {
    val line = LogCollector.bootSegmentsLine(1_000_000L, 1_012_500L, 8_400L)
    assertTrue("t_boot_start 必须在场", line.contains("t_boot_start=1000000"))
    assertTrue("t_listen 必须在场", line.contains("t_listen=1012500"))
    assertTrue("t_compose_total 必须在场", line.contains("t_compose_total=8400"))
    assertTrue("t_listen_ms 是派生等待（可对齐 measure-steady 的 engineListenMs）", line.contains("t_listen_ms=12500"))
    assertTrue("统一标记（设备侧 grep 用）", line.startsWith("dsh-boot-segments "))
  }

  @Test
  fun unknownListenUsesMinusOneNotZero() {
    val line = LogCollector.bootSegmentsLine(1_000_000L, 0L, -1L)
    assertTrue(line.contains("t_listen=-1"))
    assertTrue("0 是「立刻应答」的合法值，不能当「未知」", line.contains("t_listen_ms=-1"))
    assertTrue(line.contains("t_compose_total=-1"))
  }

  @Test
  fun bootStartOnlyLineStillCarriesAllThreeFields() {
    // markBootStart 立即落盘的那一行（引擎还没 listen、也没装探针）也必须三字段在场：
    // 「三字段均在场」这条判据不依赖启动是否走完，未知一律显式 -1。
    val line = LogCollector.bootSegmentsLine(0L, 0L, -1L)
    assertTrue(line.contains("t_boot_start=-1"))
    assertTrue(line.contains("t_listen=-1"))
    assertTrue(line.contains("t_listen_ms=-1"))
    assertTrue(line.contains("t_compose_total=-1"))
  }

  @Test
  fun derivedWaitIsNeverNegative() {
    // 墙钟被 NTP 回拨（listen < bootStart）时不得输出负等待
    val line = LogCollector.bootSegmentsLine(2_000_000L, 1_999_000L, -1L)
    assertTrue(line.contains("t_listen_ms=0"))
    assertFalse("不得出现负等待", line.contains("t_listen_ms=-"))
    assertTrue("t_listen 本身仍是真实值", line.contains("t_listen=1999000"))
  }
}
