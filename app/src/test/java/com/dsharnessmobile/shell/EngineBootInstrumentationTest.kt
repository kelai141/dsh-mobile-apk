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
    // T2 定稿口径（尾字段 singles/loopP99Ms 不得影响解析）。
    val line = "[perf] TOTAL calls=2 totalMs=17007 instances=1 firstAt=125ms singles=0 loopP99Ms=12 loopSamples=5000"
    assertEquals(17007L, LogCollector.parseComposeTotalMs(line))
    assertEquals(17007L, LogCollector.parseComposeTotalMs("noise\n" + line + "\ntail"))
    assertEquals("多条 TOTAL 取最后一条", 42L,
      LogCollector.parseComposeTotalMs(line + "\n[perf] TOTAL calls=3 totalMs=42 instances=1 firstAt=9ms singles=0"))
    assertNull("无探针在场不得编造数值", LogCollector.parseComposeTotalMs("engine ready on 3080"))
    assertNull(LogCollector.parseComposeTotalMs(""))
    assertNull("形态不符（缺 calls）不认", LogCollector.parseComposeTotalMs("[perf] TOTAL totalMs=17007"))
  }

  @Test
  fun composeSourceDistinguishesAbsentProbeFromZeroSample() {
    // 这正是 -1 混过 42 个样本的教训：必须能区分「探针完全没装」与「探针装了但没耗时口径」。
    // 分流按 T2 定稿的**行内特征字段**（不用宽泛前缀 —— `[perf] TOTAL` 与 `[perf] boot singles=`
    // 同以 `[perf] ` 开头，混为一谈就会把拒因指错层）。
    assertEquals("none", LogCollector.composeProbeSource("engine ready on 3080"))
    assertEquals("preload-total", LogCollector.composeProbeSource("[perf] TOTAL calls=1 totalMs=700 instances=1 firstAt=4000ms"))
    // preload 已装但 TOTAL 未到（TOTAL 是 process.on('exit') 汇总，启动窗口内通常还没打印）：
    // 必须与「完全没装」区分，否则会误报「探针未装」。
    assertEquals("preload-compose-only",
      LogCollector.composeProbeSource("[perf] compose #1 at=4000ms dur=700ms instances=1 records=56 singles=0"))
    // A5/A3 都在产但都不含耗时：必须报出「口径在场但不足」，而不是 none（否则拒因指错层）。
    assertEquals("a5-singles", LogCollector.composeProbeSource("[perf] boot singles=0 records=56"))
    assertEquals("a5-singles", LogCollector.composeProbeSource("[perf] boot singles=n/a records=56"))
    assertEquals("a5-singles", LogCollector.composeProbeSource("[perf] single #1 at=9100ms singles=1"))
    assertEquals("a3-cache-only", LogCollector.composeProbeSource("client-modules: combo cache (A3) state=loaded entries=73 hits=56 misses=0"))
    // A5/A3 在场时**仍不得**产出 totalMs（不得用缓存/计数规模冒充 compose 耗时）。
    assertNull("A3 行不含耗时，不得冒充 totalMs",
      LogCollector.parseComposeTotalMs("client-modules: combo cache (A3) state=loaded entries=73 hits=56 misses=0"))
    assertNull("A5 行不含耗时，不得冒充 totalMs", LogCollector.parseComposeTotalMs("[perf] boot singles=0 records=56"))
    assertNull("preload 的逐次 compose 行也不含累计耗时，不得冒充 totalMs",
      LogCollector.parseComposeTotalMs("[perf] compose #1 at=4000ms dur=700ms instances=1 records=56"))
  }

  @Test
  fun t2FinalProbeLineFormatsAreAllRecognised() {
    // T2（块F）定稿的四条引擎侧行格式，逐字锁死——四条里三条不含耗时，只有 TOTAL 能给值。
    // 这不是「文本在场」判据：每条都断言**分流结果**（若把 A3 归成 none，本测试判红）。
    val total = "[perf] TOTAL calls=1 totalMs=700 instances=1 firstAt=4000ms singles=0 loopP99Ms=12 loopSamples=5000 comboCache=loaded hits=56 misses=0"
    val compose = "[perf] compose #1 at=4000ms dur=700ms instances=1 records=56 singles=0 comboCache=loaded hits=56 misses=0"
    val boot = "[perf] boot singles=0 records=56"
    val single = "[perf] single #1 at=9100ms singles=1"
    assertEquals("preload-total", LogCollector.composeProbeSource(total))
    assertEquals("preload-compose-only", LogCollector.composeProbeSource(compose))
    assertEquals("a5-singles", LogCollector.composeProbeSource(boot))
    assertEquals("a5-singles", LogCollector.composeProbeSource(single))
    assertEquals(700L, LogCollector.parseComposeTotalMs(total))
    for (line in listOf(compose, boot, single)) {
      assertNull("只有 TOTAL 能产出耗时值，不得从别的行编造：$line",
        LogCollector.parseComposeTotalMs(line))
    }
    // 整批同时在场时：取值口径优先 TOTAL（唯一有耗时者）。
    val all = listOf(compose, boot, single, total).joinToString("\n")
    assertEquals("preload-total", LogCollector.composeProbeSource(all))
    assertEquals(700L, LogCollector.parseComposeTotalMs(all))
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
  fun bootSegmentsLineCarriesFirstHttpFieldsForC1() {
    // C1（0.14.1 块F）：首个 HTTP 响应必须与 LISTEN 同时在场，且「首个响应 − LISTEN」同源派生。
    val line = LogCollector.bootSegmentsLine(1_000_000L, 1_003_000L, 700L, firstHttpMs = 1_005_500L)
    assertTrue("t_first_http 必须在场", line.contains("t_first_http=1005500"))
    assertTrue("t_first_http_ms 必须是相对 boot_start 的派生值", line.contains("t_first_http_ms=5500"))
    assertTrue("t_http_minus_listen_ms 必须与 C1 硬判据同口径", line.contains("t_http_minus_listen_ms=2500"))
    assertTrue("compose 口径标签必须在场", line.contains("t_compose_source="))
  }

  @Test
  fun firstHttpUnknownIsMinusOneAndBudgetJudgementIsPure() {
    val line = LogCollector.bootSegmentsLine(1_000_000L, 1_003_000L, 700L)
    assertTrue("首个响应未知时必须显式 -1，绝不省字段", line.contains("t_first_http=-1"))
    assertTrue(line.contains("t_first_http_ms=-1"))
    assertTrue(line.contains("t_http_minus_listen_ms=-1"))
    // C1 的纯函数判据：LISTEN 快、首个响应慢（远超 1000 ms）必须判 false。
    assertTrue("正常情形（滞后 500ms）应在预算内",
      LogCollector.httpWithinListenBudget(1_003_500L, 1_003_000L))
    assertFalse("LISTEN 快但首个响应慢（滞后 4500ms）必须判超预算",
      LogCollector.httpWithinListenBudget(1_007_500L, 1_003_000L))
    assertFalse("起止任一未知不得判绿（不得把 -1 当通过）",
      LogCollector.httpWithinListenBudget(0L, 1_003_000L))
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
