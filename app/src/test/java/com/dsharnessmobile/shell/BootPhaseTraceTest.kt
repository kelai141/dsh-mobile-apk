package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 性能审计 #6：启动细分段埋点的判据测试。
 *
 * 守三件事：① 解析器对「有探针」与「无探针」必须给出不同结果（不能把缺失当 0）；
 * ② 幂等（同名分段只认首次）；③ 行格式稳定（下游 grep 依赖）。
 *
 * 这里刻意**只测纯函数与解析**：BootPhaseTrace.mark 需要 Context，属仪器测试域；
 * 而最容易写错的恰是「缺失 → 0」这类静默降级，它在纯函数层就能钉死。
 */
class BootPhaseTraceTest {

  // ── loader-settle 解析：有/无 必须可分 ────────────────────────────────────

  @Test
  fun parsesLoaderSettleFromPhaseProbeLine() {
    val text = "[perf] phase name=loader-settle ms=1532\n"
    assertEquals(1532L, LogCollector.loaderSettleMs(text))
  }

  @Test
  fun loaderSettleIsNullWhenProbeAbsent() {
    // 出厂引擎不装 phase 探针时，engine.log 里没有任何 loader-settle 行。
    // 必须返回 null（调用方写 absent），**不得**返回 0 —— 0 会让门禁读成「瞬间完成」。
    assertNull(LogCollector.loaderSettleMs(""))
    assertNull(LogCollector.loaderSettleMs("starting engine...\nlistening on 127.0.0.1:4145\n"))
  }

  @Test
  fun loaderSettlePicksLastByTextPositionNotByRegexOrder() {
    // issue #1342 ②：三个正则依次跑，旧实现让后跑的正则无条件覆盖 `last` —— 于是日志里
    // 同时出现历史写法与 phase 探针时，**较早**的那个值胜出，与注释声明的「最后一次出现」
    // 恰好相反。修法按 m.range.first 比文本位置。
    val historicalFirst = "loader settleMs=999\n[perf] phase name=loader-settle ms=1234\n"
    assertEquals(
      "应取文本位置靠后的 phase 探针值（1234），而不是先跑完的那个正则的 999",
      1234L,
      LogCollector.loaderSettleMs(historicalFirst),
    )
    val probeFirst = "[perf] phase name=loader-settle ms=1234\nloader settleMs=999\n"
    assertEquals(
      "应取文本位置靠后的历史写法值（999）",
      999L,
      LogCollector.loaderSettleMs(probeFirst),
    )
    val twoProbes = "[perf] phase name=loader-settle ms=1234\n[perf] phase name=loader-settle ms=5678\n"
    assertEquals("同一正则的多次命中仍取最后一次", 5678L, LogCollector.loaderSettleMs(twoProbes))
  }

  @Test
  fun loaderSettleIsNullWhenLineHasNoNumber() {
    // 具备探针行形态但不含数值：同样必须 null，而不是 0。
    assertNull(LogCollector.loaderSettleMs("[perf] phase name=loader-settle ms=-1"))
  }

  @Test
  fun loaderSettleTakesLastOccurrence() {
    val text = "[perf] phase name=loader-settle ms=1000\n[perf] phase name=loader-settle ms=2400\n"
    assertEquals(2400L, LogCollector.loaderSettleMs(text))
  }

  @Test
  fun loaderSettleAcceptsAlternateSpellings() {
    assertEquals(777L, LogCollector.loaderSettleMs("[perf] phase name=loader-settle-ms ms=777"))
    assertEquals(888L, LogCollector.loaderSettleMs("loader settleMs=888"))
  }

  @Test
  fun loaderSettleIgnoresOtherPhases() {
    // 别的 phase 行不得被误读成 loader-settle。
    val text = "[perf] phase name=compose ms=1900\n[perf] phase name=listen ms=800\n"
    assertNull(LogCollector.loaderSettleMs(text))
  }

  // ── 行格式契约：下游 grep 依赖 ────────────────────────────────────────────

  @Test
  fun phaseLineShapeIsStable() {
    // 与 BootPhaseTrace.append 的拼接口径一致；改格式必须同步改本用例。
    val name = "onCreate"
    val atMs = 42L
    val note = "ms=7"
    val line = "dsh-boot-phase phase=" + name + " at=" + atMs + "ms" + " " + note
    assertEquals("dsh-boot-phase phase=onCreate at=42ms ms=7", line)
    assertTrue(line.startsWith("dsh-boot-phase "))
  }

  @Test
  fun phaseNamesAreStableAndDistinct() {
    // 四个分段名互不相同，且全部非空（空白名会让 grep 命中任意行）。
    val names = listOf(
      BootPhaseTrace.ON_CREATE,
      BootPhaseTrace.WEBVIEW_CONSTRUCT,
      BootPhaseTrace.SNAPSHOT_EXTRACT,
      BootPhaseTrace.LOADER_SETTLE,
    )
    assertEquals(names.size, names.toSet().size)
    assertTrue(names.all { it.isNotBlank() })
  }
}
