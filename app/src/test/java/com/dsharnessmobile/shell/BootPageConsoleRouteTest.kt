package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块L L-2 回归（0.14.1）：页面控制台行 → 壳侧 boot 诊断的分流纯函数。
 *
 * 为什么必须有它：页面侧 `dsh-host-web-compat/lib/index.js` 一直在打印
 * `[dsh-boot-stall] dsh-boot-diag …` 与（本轮新增的）`[dsh-boot-ready] …`，但**全壳
 * 此前零 onConsoleMessage 实现**，`files/boot-diag.log` 的 `source=page-console` 恒 0 行。
 * 跨层契约的两半必须各有一个可离线跑的判据，否则「加了但没接上」只会在设备上表现为
 * 永远 `pageSideRuntime=unavailable`（正是本次缺陷的形态，也是块J FIX-4 的教训）。
 *
 * 另含 L-1 的运行时取值判据：从页面自报行里按 `pageSideRuntime=` 取值，取不到必须显式
 * unavailable（不得臆造、不得留空）。
 */
class BootPageConsoleRouteTest {

  /**
   * 剥掉 Kotlin 注释后的「真代码」文本（**顺序：先块注释、再行注释**）。
   *
   * 为什么需要：源码契约断言若直接对整份文本跑正则，会命中**注释里出现的同一个词**
   * （本轮实测：修复后的 `startFreezeWatchdog` 里恰好有一行注释写着「不要在这里
   * resetBootStall()」，于是「实现正确」被判成「判据回归」= 假红）。
   * 判据必须只看会执行的代码。
   */
  private fun codeOnly(src: String): String =
    src.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .lineSequence()
      .joinToString("\n") { line -> line.substringBefore("//") }

  // ── 前缀契约：必须与页面侧常量逐字一致 ────────────────────────────────────────
  // 页面侧 BOOT_STALL_PREFIX='[dsh-boot-stall]' / BOOT_READY_PREFIX='[dsh-boot-ready]'
  // （dsh-host-web-compat/lib/index.js）。此处逐字断言，任一侧改动而另一侧未跟即判红。
  @Test
  fun prefixesMatchThePageSideConstantsVerbatim() {
    assertEquals("[dsh-boot-stall]", LogCollector.PAGE_STALL_PREFIX)
    assertEquals("[dsh-boot-ready]", LogCollector.PAGE_READY_PREFIX)
  }

  // ── 就绪行（L-1 判据真源）────────────────────────────────────────────────────
  @Test
  fun readyLineIsRecognisedAndRoutedToPageConsole() {
    val line = "[dsh-boot-ready] dsh-boot-diag source=page-ready pageSideRuntime={\"readyAt\":1,\"waitedMs\":2}"
    assertTrue("就绪行必须被识别（L-1 的判据真源）", LogCollector.isPageReadyMessage(line))
    assertFalse("就绪行不是卡住行", LogCollector.isPageStallMessage(line))
    val route = LogCollector.routePageConsole(line)
    assertEquals("page-console", route?.source)
    assertTrue(route!!.detail.startsWith("[dsh-boot-ready]"))
  }

  // ── 卡住行（L-2 载荷）────────────────────────────────────────────────────────
  @Test
  fun stallLineCarriesTheFourRuntimeFieldsThrough() {
    val runtime = "{\"pendingEntries\":\"unavailable\",\"failedEntries\":[],\"graphLoaded\":true,\"waitingForMs\":41000}"
    val line = "[dsh-boot-stall] dsh-boot-diag source=page-stall pageSideRuntime=$runtime detail=tookMs=40001"
    assertTrue(LogCollector.isPageStallMessage(line))
    assertFalse(LogCollector.isPageReadyMessage(line))
    val route = LogCollector.routePageConsole(line)
    assertEquals("page-console", route?.source)
    // 四字段必须原样透传（壳侧不解析再序列化，避免两处格式漂移）
    assertTrue(route!!.detail.contains("pendingEntries"))
    assertTrue(route.detail.contains("failedEntries"))
    assertTrue(route.detail.contains("graphLoaded"))
    assertTrue(route.detail.contains("waitingForMs"))
  }

  // ── 不吞第三方日志：未命中前缀必须交回默认处理 ─────────────────────────────────
  @Test
  fun unrelatedConsoleLinesAreNotConsumed() {
    assertNull("第三方页面的普通 error 不得被消费", LogCollector.routePageConsole("Uncaught TypeError: x is not a function"))
    assertNull("空行不得被消费", LogCollector.routePageConsole(""))
    assertNull("仅前缀子串（无前缀开头）不得命中", LogCollector.routePageConsole("see [dsh-boot-stall] for details"))
    assertFalse(LogCollector.isPageReadyMessage("prefix [dsh-boot-ready]"))
    assertFalse(LogCollector.isPageStallMessage("prefix [dsh-boot-stall]"))
  }

  // ── 换行折叠：壳侧落盘是单行，未折叠的换行会截断整条诊断 ────────────────────────
  @Test
  fun multiLineConsoleTextIsFoldedToASingleLine() {
    val route = LogCollector.routePageConsole("[dsh-boot-stall] dsh-boot-diag source=page-stall\nmore\nlines")
    assertEquals("page-console", route?.source)
    assertFalse("必须折叠换行", route!!.detail.contains("\n"))
  }

  // ── L-1：pageSideRuntime 取值（取不到必须显式 unavailable，绝不臆造）───────────
  @Test
  fun runtimeIsExtractedVerbatimWhenPresent() {
    val json = "{\"pendingEntries\":\"requires-upstream-loader-context-export\",\"graphLoaded\":true}"
    val line = "[dsh-boot-stall] dsh-boot-diag source=page-stall pageSideRuntime=$json detail=tookMs=1"
    assertEquals(json, extractRuntimeForTest(line))
  }

  @Test
  fun runtimeFallsBackToUnavailableWhenAbsentOrEmpty() {
    assertEquals(LogCollector.PAGE_RUNTIME_UNAVAILABLE,
      extractRuntimeForTest("[dsh-boot-stall] dsh-boot-diag source=page-stall detail=tookMs=1"))
    assertEquals(LogCollector.PAGE_RUNTIME_UNAVAILABLE,
      extractRuntimeForTest("[dsh-boot-stall] pageSideRuntime= detail=x"))
    assertEquals(LogCollector.PAGE_RUNTIME_UNAVAILABLE, extractRuntimeForTest(""))
    // unavailable 是**字符串常量**，必须与「空数组」区分（空数组是本次误导的根源）
    assertEquals("unavailable", LogCollector.PAGE_RUNTIME_UNAVAILABLE)
  }

  /**
   * [EngineStartFlow.extractPageSideRuntime] 是实例方法，但只用到传入的行；用最小反射构造
   * 不可行（需要 Activity），故这里复刻同一取法做纯函数对照——**同一算法两处实现会漂移**，
   * 因此本用例同时从 EngineStartFlow.kt 源码断言该算法在场（见下一个用例）。
   */
  private fun extractRuntimeForTest(line: String): String {
    val key = "pageSideRuntime="
    val at = line.indexOf(key)
    if (at < 0) return LogCollector.PAGE_RUNTIME_UNAVAILABLE
    val rest = line.substring(at + key.length)
    val end = rest.indexOf(" detail=")
    val value = (if (end < 0) rest else rest.substring(0, end)).trim()
    return if (value.isEmpty()) LogCollector.PAGE_RUNTIME_UNAVAILABLE else value
  }

  @Test
  fun shellSideExtractorIsWiredInEngineStartFlow() {
    // 反证「加了但没接上」：断言生产代码里确实存在该取值口，且 writeBootDiag 真被以
    // pageSideRuntime 形式调用（page-console 通路）。
    val src = java.io.File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").readText()
    assertTrue("必须实现 extractPageSideRuntime", src.contains("fun extractPageSideRuntime("))
    assertTrue("必须把页面自报的 runtime 透传给 writeBootDiag", src.contains("pageSideRuntime = runtime"))
    assertTrue("必须实现页面就绪处理（L-1 判据真源）", src.contains("fun onPageReadyReported("))
    assertTrue("必须实现页面卡住处理（L-2 载荷）", src.contains("fun onPageStallReported("))
    // L-1 反证：旧判据（webViewReady 当页面未就绪）必须已被移除
    assertFalse("不得再用 webViewReady 当「页面未就绪」的判据（L-1 误报根因）",
      src.contains("activity.webViewReady && !activity.userClosedEngine &&"))
    // L-1 反证 2：onPageFinished 路径不得再复位 boot-stall 计时（同 epoch 重复报根因）。
    // **0.14.1 更正（单测实测抓出的假红）**：原实现直接对**整份源码文本**跑正则
    //   `fun startFreezeWatchdog\(\)[\s\S]{0,600}?resetBootStall\(\)`
    // ——而修复后的函数体里**恰好有一行注释**写着「// **不要**在这里 resetBootStall()：
    // 本函数由 onPageFinished 调用…」。正则只匹配文本、不看语法，于是命中了**注释里的那个词**，
    // 把「实现正确」判成「判据回归」（假红）。判据必须strip 注释后再匹配：`codeOnly()` 是
    // 本文件既有的剥注释工具（先剥块注释再剥行注释），用它取「真代码」。
    assertFalse("startFreezeWatchdog 不得再 resetBootStall（onPageFinished 复位 = 重复报根因）",
      Regex("fun startFreezeWatchdog\\(\\)[\\s\\S]{0,600}?resetBootStall\\(\\)")
        .containsMatchIn(codeOnly(src)))
  }

  @Test
  fun shellSideConsumerIsWiredInMainActivity() {
    // L-2 的核心反证：全壳必须有 onConsoleMessage 实现（此前 grep 零命中）。
    val src = java.io.File("src/main/java/com/dsharnessmobile/shell/MainActivity.kt").readText()
    assertTrue("必须覆写 onConsoleMessage", src.contains("override fun onConsoleMessage("))
    assertTrue("必须分流到就绪处理", src.contains("engineFlow.onPageReadyReported("))
    assertTrue("必须分流到卡住处理", src.contains("engineFlow.onPageStallReported("))
    assertTrue("必须用壳侧前缀常量（两侧契约单点）", src.contains("LogCollector.isPageReadyMessage("))
    assertTrue("必须用壳侧前缀常量（两侧契约单点）", src.contains("LogCollector.isPageStallMessage("))
    assertTrue("必须导入 ConsoleMessage", src.contains("import android.webkit.ConsoleMessage"))
  }

  @Test
  fun pageSidePublishesTheReadyLineAndTheFourFields() {
    // 跨仓对照：页面侧必须真的打印 [dsh-boot-ready]，且把四字段放进 pageSideRuntime。
    // 页面侧在协调仓 dsh-host-web-compat/lib/index.js（本仓镜像在 dsh-host-web-compat/）。
    val candidates = listOf(
      java.io.File("dsh-host-web-compat/lib/index.js"),
      java.io.File("../dsh-host-web-compat/lib/index.js"),
    )
    val src = candidates.firstOrNull { it.exists() }?.readText()
      ?: return   // 仓外单独跑单测时跳过（设备门禁与 check-plugin-tests 会各自覆盖）
    assertTrue("页面侧必须声明就绪前缀", src.contains("BOOT_READY_PREFIX='[dsh-boot-ready]'"))
    assertTrue("页面侧必须发布就绪行", src.contains("publishReady"))
    assertTrue("页面侧必须发布四字段（含 pendingEntries）", src.contains("pendingEntries"))
    assertTrue("页面侧必须发布四字段（含 failedEntries）", src.contains("failedEntries"))
    assertTrue("页面侧必须发布四字段（含 graphLoaded）", src.contains("graphLoaded"))
    assertTrue("页面侧必须发布四字段（含 waitingForMs）", src.contains("waitingForMs"))
  }
}
