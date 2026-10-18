package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 壳侧路由与失败面编排的回归（CONTRACT §1/§3/§4/§6/§8）。
 *
 * 为什么必须有它：本改动横跨**三处壳侧咽喉**，每一处坏掉都只在设备上表现为
 * 「用户永远停在坏页面」或「自动回滚永不触发」，而两者都不可从 UI 反推——
 *
 * - [LogCollector] 的契约行分流（前缀逐字一致 / failedIds 解析）；
 * - [MainActivity] 的控制台分支顺序与「不吞第三方日志」；
 * - [EngineStartFlow] 的 latch、防弹回闸门与一次性回滚编排。
 *
 * 其中编排部分需要 Activity/WebView，无法在 JVM 里实例化，故用「纯函数直测 +
 * 生产源码结构断言（剥注释后）」两层：前者证判据，后者证**接线**（块J FIX-4 的教训：
 * 能力在、入口无 = 未完成）。
 */
class ClientPluginFailRouteTest {

  /**
   * 剥掉 Kotlin 注释后的「真代码」文本（先块注释、再行注释）。
   *
   * 为什么必须剥：本仓已实测过「判据命中了注释里的同一个词」造成的假红假绿
   * （见 BootPageConsoleRouteTest 的同名工具）。源码结构断言只看会执行的行。
   */
  private fun codeOnly(src: String): String =
    src.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .lineSequence()
      .joinToString("\n") { line -> line.substringBefore("//") }

  private fun src(name: String): String =
    java.io.File("src/main/java/com/dsharnessmobile/shell/" + name).readText()

  // ── §1 契约行前缀：必须与页面侧 BOOT_FAILED_PREFIX 逐字一致 ──────────────────
  @Test
  fun pluginFailPrefixMatchesThePageSideConstantVerbatim() {
    assertEquals("[dsh-boot-failed]", LogCollector.PAGE_PLUGIN_FAIL_PREFIX)
  }

  // ── §3 失败行识别：行首前缀判定（trimStart 后 startsWith）─────────────────────
  @Test
  fun pluginFailLineIsRecognisedByLeadingPrefixOnly() {
    val line = "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail detail=reason=x failedIds=live2d-pet pageSideRuntime={}"
    assertTrue(LogCollector.isClientPluginTreeFailureMessage(line))
    assertTrue("前导空白不得让契约行漏判", LogCollector.isClientPluginTreeFailureMessage("  " + line))
    assertFalse("就绪行不是失败行", LogCollector.isClientPluginTreeFailureMessage("[dsh-boot-ready] dsh-boot-diag"))
    assertFalse("卡住行不是失败行", LogCollector.isClientPluginTreeFailureMessage("[dsh-boot-stall] dsh-boot-diag"))
    assertFalse("仅子串出现不得命中（前缀必须在行首）",
      LogCollector.isClientPluginTreeFailureMessage("see [dsh-boot-failed] for details"))
    assertFalse("空行不得命中", LogCollector.isClientPluginTreeFailureMessage(""))
  }

  // ── §3 failedIds 解析（含 '-'、空、超限、截断）──────────────────────────────
  @Test
  fun failedIdsAreParsedCommaSeparatedWithoutQuotesOrSpaces() {
    val line = "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=live2d-pet,@scope/pkg,third.one pageSideRuntime={}"
    assertEquals(listOf("live2d-pet", "@scope/pkg", "third.one"), LogCollector.clientFailedIdsOf(line))
  }

  @Test
  fun emptyPlaceholderAndMissingFieldYieldNoIds() {
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=- pageSideRuntime={}"))
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail pageSideRuntime={}"))
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds= pageSideRuntime={}"))
    assertEquals(emptyList<String>(), LogCollector.clientFailedIdsOf(""))
    assertEquals(emptyList<String>(), LogCollector.clientFailedIdsOf("no field here"))
  }

  @Test
  fun illegalAndOverlongIdsAreRejectedInsteadOfFabricated() {
    // 形状不合法（与页面侧同款过滤口径）：引号包裹、含空格、等号起头。
    // 注意：字段值以空白结束（契约保证「无引号无空格」），因此这里只放**不含空格**的坏项。
    val dirty = "[dsh-boot-failed] dsh-boot-diag failedIds='quoted',=x,ok-one pageSideRuntime={}"
    assertEquals(listOf("ok-one"), LogCollector.clientFailedIdsOf(dirty))
    // 超长 id（>120）必须被拒——它是 fold 截断的典型残骸，传进外科拔除就是误删风险。
    val longId = "a".repeat(121)
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedIds=" + longId + " pageSideRuntime={}"))
    val maxId = "a".repeat(120)
    assertEquals(listOf(maxId),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedIds=" + maxId + " pageSideRuntime={}"))
  }

  @Test
  fun atMostEightIdsSurvive() {
    val nine = (1..9).joinToString(",") { "id-" + it }
    val ids = LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedIds=" + nine + " pageSideRuntime={}")
    assertEquals(8, ids.size)
    assertEquals("id-1", ids.first())
    assertEquals("id-8", ids.last())
  }

  @Test
  fun truncatedTrailingIdIsNotGuessed() {
    // fold 截断把最后一个 id 劈成半截：半截仍是合法形状时必须**原样返回**（不猜、不补），
    // 由上层 clientPullCandidate 的「必须唯一命中」判据兜底。
    val truncated = "[dsh-boot-failed] dsh-boot-diag failedIds=good-one,live2d-pet@dsh-android/dsh-live2d-pe"
    assertEquals(listOf("good-one", "live2d-pet@dsh-android/dsh-live2d-pe"), LogCollector.clientFailedIdsOf(truncated))
    // 字段本身被截断（连 failedIds= 都没写全）：空列表，绝不臆造。
    assertEquals(emptyList<String>(), LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedId"))
  }

  // ── §3 routePageConsole 第三分支（source 仍 page-console，排在 ready/stall 之后）──
  @Test
  fun pluginFailLineRoutesToPageConsoleAsThirdBranch() {
    val line = "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=x pageSideRuntime={}"
    val route = LogCollector.routePageConsole(line)
    assertEquals("page-console", route?.source)
    assertTrue("detail 必须原样透传（壳侧不再序列化，避免两处格式漂移）", route!!.detail.startsWith("[dsh-boot-failed]"))
    // 既有两条分支语义不变（顺序契约：ready/stall 先生效）。
    assertEquals("page-console", LogCollector.routePageConsole("[dsh-boot-ready] x")?.source)
    assertEquals("page-console", LogCollector.routePageConsole("[dsh-boot-stall] x")?.source)
  }

  @Test
  fun multiLineFailureLineIsFolded() {
    val route = LogCollector.routePageConsole("[dsh-boot-failed] dsh-boot-diag\nmore\nlines")
    assertEquals("page-console", route?.source)
    assertFalse(route!!.detail.contains("\n"))
  }

  // ── §8 路由不得吞掉第三方日志 ────────────────────────────────────────────────
  @Test
  fun unrelatedConsoleLinesAreNeverConsumed() {
    assertNull(LogCollector.routePageConsole("Uncaught TypeError: x is not a function"))
    assertNull(LogCollector.routePageConsole(""))
    assertNull(LogCollector.routePageConsole("prefix [dsh-boot-failed]"))
  }

  // ── §3 分支顺序与消费语义（源码结构断言）──────────────────────────────────────
  @Test
  fun consoleBranchOrderIsReadyThenStallThenClientFailThenRenderError() {
    val code = codeOnly(src("MainActivity.kt"))
    val onConsole = code.substringAfter("override fun onConsoleMessage(").substringBefore("override fun onShowFileChooser")
    val ready = onConsole.indexOf("isPageReadyMessage(")
    val stall = onConsole.indexOf("isPageStallMessage(")
    val clientFail = onConsole.indexOf("isClientPluginTreeFailureMessage(")
    val renderErr = onConsole.indexOf("isRenderErrorMessage(")
    assertTrue("顺序必须是 ready → stall → client-fail → render-error",
      ready in 0 until stall && stall < clientFail && clientFail < renderErr)
    val clientBlock = onConsole.substring(clientFail, renderErr)
    assertTrue("必须调用 onClientPluginTreeFailed", clientBlock.contains("engineFlow.onClientPluginTreeFailed("))
    assertTrue("契约行必须落 page-console 诊断", clientBlock.contains("LogCollector.writeBootDiag("))
    assertTrue("client-fail 返回 true（已消费）", clientBlock.contains("true"))
    assertTrue("render-error 仍返回 false（不吞页面报错）", onConsole.substring(renderErr).contains("false"))
    assertTrue("未命中必须交回默认 console 行为", onConsole.contains("else -> false"))
  }

  @Test
  fun renderErrorExclusionSetHasThreePrefixes() {
    val code = codeOnly(src("MainActivity.kt"))
    val fn = code.substringAfter("internal fun isRenderErrorMessage(").substringBefore("\n  }")
    assertTrue("必须排除就绪前缀", fn.contains("isPageReadyMessage("))
    assertTrue("必须排除卡住前缀", fn.contains("isPageStallMessage("))
    assertTrue("排除集必须扩到三个前缀（CONTRACT §3）", fn.contains("isClientPluginTreeFailureMessage("))
  }

  // ── §4 latch 置位/清除与双通道落盘（源码结构断言）────────────────────────────
  @Test
  fun latchIsDeclaredAndDefaultsToFalse() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    assertTrue("latch 必须默认 false（健康启动零动作）",
      Regex("@Volatile private var clientPluginTreeFailed = false").containsMatchIn(code))
    assertTrue("一次性回滚预算必须默认未花",
      Regex("@Volatile private var clientPluginTreeRecoverySpent = false").containsMatchIn(code))
    assertTrue("必须暴露只读访问器 clientPluginTreeFailedLatch",
      code.contains("internal val clientPluginTreeFailedLatch: Boolean get() = clientPluginTreeFailed"))
    assertTrue("必须提供 clearClientPluginTreeFailureLatch",
      code.contains("internal fun clearClientPluginTreeFailureLatch()"))
  }

  @Test
  fun onClientPluginTreeFailedWritesBothChannelsAndLatches() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val fn = code.substringAfter("fun onClientPluginTreeFailed(").substringBefore("fun resetPageReadyState(")
    assertTrue("必须落 boot-fail（stage=client-plugin-tree-failed）",
      fn.contains("LogCollector.writeBootFail(activity, \"client-plugin-tree-failed\""))
    assertTrue("必须有 Log.e 双通道", fn.contains("Log.e("))
    assertTrue("必须先置 latch 再呈现", fn.indexOf("clientPluginTreeFailed = true") < fn.indexOf("presentClientPluginFailure"))
    assertTrue("失败必须进入同一份两次重试预算", fn.contains("scheduleEngineRetry(currentStartGeneration, clientFailure = true)"))
  }

  @Test
  fun recoveryUsesTheSameRetryBudgetWithoutUndoGate() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    assertFalse("页面失败不得继续自动调用 UndoGate.execute", code.contains("UndoGate.execute(activity, engine, candidate)"))
    assertFalse("页面失败不得继续进入配置回滚线程", code.contains("maybeRecoverFromClientPluginTreeFailure("))
    assertTrue("页面失败必须复用两次重试预算", code.contains("scheduleEngineRetry(currentStartGeneration, clientFailure = true)"))
    assertTrue("页面失败重试前必须停止本壳托管的引擎", code.contains("stopOwnedEngine()"))
    assertTrue("死引擎空端口不得跳过剩余重试", code.contains("!activity.engineManager.stopOwnedEngine() &&\n            EngineProbe.portReachable(500)"))
  }

  /**
   * 设备实测 #2（DEVICE-FINDING-2）回归：**数据修好不等于屏幕修好**。
   *
   * 真机事实：拔除确实执行了（undo-gate 出现 pulled plugin、patch 与基线逐字节相同），
   * 但屏幕 3 分钟仍停在旧的 "Failed to load plugins" 页，手动冷启动才恢复。
   *
   * 真因：成功分支只调 showWeb()，而 MainActivity.showWeb() 只在 enginePageFailed == true 时才
   * reload——本场景失败的是**插件装配**而非导航传输，enginePageFailed == false，于是 showWeb()
   * 只执行 guideRenderer.showWeb()：把**已经持有旧失败文档**的 WebView 重新露出来，从不重新导航。
   * 而客户端插件清单是文档加载时拉的，引擎重启不会让旧文档重拉，用户看到的仍是坏的。
   *
   * 判据：成功分支必须**同时**出现 reloadEnginePage()（真正 webView.reload()）与 showWeb()，
   * 设备当年的 reload 顺序已由旧自动 undo 链退役；现在这里守住「不得把旧链带回来」。
   */
  @Test
  fun retiredAutomaticRecoveryCannotReturnThroughTheOldUndoThread() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    assertFalse("页面失败不得继续调用 UndoGate.execute", code.contains("UndoGate.execute"))
    assertFalse("页面失败不得继续启动旧的自动回滚线程", code.contains("maybeRecoverFromClientPluginTreeFailure("))
    assertTrue("页面失败必须复用两次重试预算", code.contains("scheduleEngineRetry(currentStartGeneration, clientFailure = true)"))
    assertTrue("重试前必须停止本壳托管的旧引擎", code.contains("stopOwnedEngine()"))
  }

  @Test
  fun boundedEngineReadinessWaitStillHasAConcreteBudget() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    assertTrue("原生修复的重启等待仍需有界", code.contains("awaitEngineHttpReady("))
    assertTrue("有界等待必须复用既有预算常量", code.contains("ENGINE_BOOT_BUDGET_MS"))
  }

  /**
   * [awaitEngineHttpReady] 的**有界性**逐条反证（纯函数：注入时钟/睡眠/探针，无真实 IO）。
   *
   * 为什么必须有：这条等待最危险的形态是「变成无限等」——它跑在回滚的后台线程上，一旦不受预算
   * 约束就会把恢复流程永久挂住。因此对「超预算必返回、进程死必提前收手、换代必提前收手、
   * 就绪即返回」四种收敛路径各断言一条。
   */
  @Test
  fun engineReadinessWaitIsBoundedAndConverges() {
    // ① 迟迟不就绪：到预算即停（不是无限循环），且确实轮询过。
    var clock = 0L
    var probes = 0
    val notReady = awaitEngineHttpReady(
      budgetMs = 5_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; false }, processAlive = { true }, current = { true },
    )
    assertFalse("超预算必须返回 false（有界，不得无限等）", notReady)
    assertTrue("必须真的轮询过（不是一次都没试就放弃）", probes >= 5)

    // ② 第 3 拍就绪：立即返回 true，不再空等。
    clock = 0L; probes = 0
    val ready = awaitEngineHttpReady(
      budgetMs = 30_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; probes >= 3 }, processAlive = { true }, current = { true },
    )
    assertTrue("引擎就绪必须返回 true", ready)
    assertEquals("就绪即停（不得走满预算）", 3, probes)

    // ③ 进程已死：再等也不会就绪，提前收手（不空耗满预算）。
    clock = 0L; probes = 0
    val dead = awaitEngineHttpReady(
      budgetMs = 90_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; false }, processAlive = { false }, current = { true },
    )
    assertFalse("进程已死必须提前收手", dead)
    assertTrue("必须远早于 90s 预算就收手（实测 clock=" + clock + "）", clock < 10_000L)

    // ④ 世代已换代（Activity 销毁/新启动）：立刻收手，避免对着废弃世代做动作。
    clock = 0L; probes = 0
    val stale = awaitEngineHttpReady(
      budgetMs = 90_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; false }, processAlive = { true }, current = { false },
    )
    assertFalse("换代必须立刻收手", stale)
    assertEquals("换代后不得再探活", 0, probes)
  }

  // ── §4 防弹回闸门（latch 期内 showWeb / 监控 / 冻结看门狗早退）────────────────
  @Test
  fun showWebIsBlockedWhileLatchIsSet() {
    val code = codeOnly(src("MainActivity.kt"))
    val fn = code.substringAfter("internal fun showWeb()").substringBefore("internal fun reloadEnginePage()")
    assertTrue("showWeb 必须查 latch", fn.contains("engineFlow.clientPluginTreeFailedLatch"))
    assertTrue("必须早退而非继续展示", Regex("clientPluginTreeFailedLatch\\) return").containsMatchIn(fn))
    // 反证（CONTRACT §0）：这条闸门必须先于 enginePageFailed/claimLoadErrorRetry 那一支生效，
    // 否则 latch 期内仍会走「加载失败 → 自动重载」——正是被点名的重载环。
    val latchAt = fn.indexOf("clientPluginTreeFailedLatch")
    val retryAt = fn.indexOf("claimLoadErrorRetry()")
    assertTrue("latch 闸门必须排在 enginePageFailed 重载支之前", latchAt in 0 until retryAt)
  }

  @Test
  fun monitorAndFreezeWatchdogsExitEarlyWhileLatchIsSet() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val monitor = code.substringAfter("private val engineMonitorRunnable").substringBefore("private val freezeHandler")
    assertTrue("前台监控必须查 latch", monitor.contains("if (clientPluginTreeFailed) return"))
    val freeze = code.substringAfter("private val freezeRunnable").substringBefore("fun startMonitor()")
    assertTrue("冻结看门狗必须查 latch", freeze.contains("if (clientPluginTreeFailed) return"))
    // 反证：latch 闸门不得写成 enginePageFailed（CONTRACT §0 点名的重载环形态）。
    assertFalse("latch 闸门不得写成 enginePageFailed",
      Regex("if \\(activity\\.enginePageFailed\\) return").containsMatchIn(monitor + freeze))
  }

  @Test
  fun explicitOutletsClearTheLatch() {
    val flow = codeOnly(src("EngineStartFlow.kt"))
    val start = flow.substringAfter("fun start() {").substringBefore("val token = flowOwnership.begin()")
    assertTrue("start() 入口必须清 latch（用户显式重试/安全模式路径）", start.contains("clearClientPluginTreeFailureLatch()"))
    val activity = codeOnly(src("MainActivity.kt"))
    val outlet = activity.substringAfter("internal fun startEngineFlow()").substringBefore("internal fun applyGuidePhase(")
    assertTrue("显式启动出口必须清 latch", outlet.contains("clearClientPluginTreeFailureLatch()"))
  }

  // ── §4 onResume 消费挂起呈现 ─────────────────────────────────────────────────
  @Test
  fun onResumeConsumesPendingClientPluginFailurePresentation() {
    val code = codeOnly(src("MainActivity.kt"))
    assertTrue("必须声明挂起标记", code.contains("pendingClientPluginFailurePresentation"))
    val resume = code.substringAfter("override fun onResume()").substringBefore("override fun onPause()")
    assertTrue("onResume 必须消费它", resume.contains("if (pendingClientPluginFailurePresentation)"))
    assertTrue("消费时必须落地错误相位", resume.contains("GuidePhase.Error"))
    assertTrue("必须复用同一文案串", resume.contains("R.string.ds_client_plugin_fail_hint"))
  }

  // ── §4/§6 纯判据与文案 ──────────────────────────────────────────────────────
  @Test
  fun recoveryRouteIsExhaustiveAndConservative() {
    assertEquals(ClientPluginFailureRoute.CLIENT_PULL,
      clientPluginFailureRoute(PluginMounts.FailedEntry("live2d-pet", "dsh-live2d-pets"), false))
    assertEquals(ClientPluginFailureRoute.KNOWN_GOOD,
      clientPluginFailureRoute(null, true))
    assertEquals("点不出名且清单已变 ⇒ 不动作（绝不抹掉用户插件）",
      ClientPluginFailureRoute.NO_ACTION, clientPluginFailureRoute(null, false))
  }

  @Test
  fun failedIdsParseFeedsTheRouteDecision() {
    // 端到端纯面：契约行 → id 列表 → 路线判定。三跳全部可离线反证。
    val ids = LogCollector.clientFailedIdsOf(
      "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=- pageSideRuntime={}")
    assertEquals(emptyList<String>(), ids)
    assertEquals(ClientPluginFailureRoute.KNOWN_GOOD, clientPluginFailureRoute(null, true))
    assertEquals(ClientPluginFailureRoute.NO_ACTION, clientPluginFailureRoute(null, false))
  }

  @Test
  fun userFacingCopyMatchesTheContractAndHasNoEmoji() {
    val xml = java.io.File("src/main/res/values/strings.xml").readText()
    assertTrue("必须新增标题串", xml.contains("<string name=\"ds_client_plugin_fail_title\">插件装配失败</string>"))
    val hint = "<string name=\"ds_client_plugin_fail_hint\">界面插件没能装载（%1\$s）。已尝试自动回退；仍失败可点下方「安全模式启动」：只摘第三方插件、保留本应用插件，并把含报错原文的修复指令复制到剪贴板。</string>"
    assertTrue("提示串必须与 CONTRACT §6 逐字一致", xml.contains(hint))
    // 禁 emoji（AGENTS.md 铁律 7）：代理对与常见符号区段一律不得出现在资源里。
    val emoji = Regex("[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF\\uFE0F]")
    assertFalse("文案不得含 emoji", emoji.containsMatchIn(xml))
  }
}
