package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The durable native-repair gate (`native-repair/required`) is a prefs fact, not startup
 * ownership. Automatic entry must keep respecting it; only an explicit user retry clears it.
 * These tests pin both sides so a future "helpful" reset cannot turn retries into a loop.
 */
class RepairGateTest {
  @Test fun `passive observation finishes only the authorized cold attempt behind a stale gate`() {
    assertTrue(mayObserveColdStart(required = false, attemptInFlight = false))
    assertTrue(mayObserveColdStart(required = false, attemptInFlight = true))
    assertTrue(mayObserveColdStart(required = true, attemptInFlight = true))
    assertFalse(mayObserveColdStart(required = true, attemptInFlight = false))
    assertFalse("Observing must not grant a retry", shouldScheduleAutomaticRetry(true, 2, false))
  }
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test
  fun `automatic startup stays blocked while the durable gate is set`() {
    assertEquals(StartupEntryDecision.BLOCKED_FOR_REPAIR, startupEntryDecision(required = true, explicitUserRetry = false))
    assertEquals(StartupEntryDecision.START, startupEntryDecision(required = true, explicitUserRetry = true))
    assertEquals(StartupEntryDecision.START, startupEntryDecision(required = false, explicitUserRetry = false))
  }

  @Test
  fun `cold start auto attempt is one-shot per process and only for a stale gate`() {
    RepairState.resetProcessStateForTest()
    try {
      assertTrue("上一进程落的门：查询必须放行且不消耗", RepairState.coldStartAutoAttemptAvailable(required = true))
      assertTrue("两道闸门可先后查询同一次尝试（不消耗）", RepairState.coldStartAutoAttemptAvailable(required = true))
      assertFalse("门不存在时无尝试可言", RepairState.coldStartAutoAttemptAvailable(required = false))
      RepairState.spendColdStartAutoAttempt()
      assertFalse("花掉后本进程不再有自动尝试", RepairState.coldStartAutoAttemptAvailable(required = true))
    } finally {
      RepairState.resetProcessStateForTest()
    }
  }

  @Test
  fun `automatic retry remains bounded and never clears the durable gate`() {
    assertFalse("required 时不得自动重试", shouldScheduleAutomaticRetry(required = true, retries = 0, retryPending = false))
    assertFalse("已有排队重试时不得叠加", shouldScheduleAutomaticRetry(required = false, retries = 0, retryPending = true))
    assertTrue(shouldScheduleAutomaticRetry(required = false, retries = 0, retryPending = false))
    assertTrue(shouldScheduleAutomaticRetry(required = false, retries = 1, retryPending = false))
    assertFalse("两次后必须停手", shouldScheduleAutomaticRetry(required = false, retries = 2, retryPending = false))
  }

  @Test
  fun `page-reported boot-ready clears the durable gate regardless of cold-start budget`() {
    // 小米 14 实锤（2026-10-25）：五轮启动页面每一轮都活着并上报 [dsh-boot-ready]（上游
    // ErrorBoundary 兜住了 slot entry 的 React #130），但旧守卫「required 且冷启尝试已花掉
    // 即整条丢弃」让门永不清、用户每轮看到「引擎仍无法启动」，直到手清 native-repair。
    val fn = source("EngineStartFlow.kt")
      .substringAfter("fun onPageReadyReported").substringBefore("fun onPageStallReported")
    assertFalse("ready 到达不得因持久门被丢弃（冷启额度归零也不行）",
      fn.contains("RepairState.coldStartAttemptInFlight()"))
    assertTrue("门在场时 ready 必须清门并留痕",
      fn.contains("RepairState.reset(activity)") && fn.contains("repair gate cleared by page-reported boot-ready"))
    assertTrue("插件树失败在场时仍丢弃 ready（失败终态优先，语义保留）",
      fn.contains("if (clientPluginTreeFailed) return"))
  }

  @Test
  fun `only the explicit retry clears required and the retry budget`() {
    val start = source("EngineStartFlow.kt").substringAfter("fun start()").substringBefore("resetBootStall()")
    assertTrue("自动 start 过闸门只能查询每进程一次的冷启自动尝试（不消耗）",
      start.contains("explicitUserRetry = RepairState.coldStartAutoAttemptAvailable(activity)"))
    assertTrue("放行后必须显式花掉这一次尝试", start.contains("RepairState.spendColdStartAutoAttempt()"))
    assertFalse("自动 start 不得清除持久闸门", start.contains("beginUserRetry"))

    val main = source("MainActivity.kt")
    val explicit = main.substringAfter("internal fun retryEngineExplicitly()").substringBefore("private fun applyRepairRequiredGuide")
    assertTrue(explicit.contains("if (!RepairState.beginUserRetry(this))"))
    assertTrue(explicit.contains("engineFlow.engineRetryCount = 0"))
    assertTrue(explicit.contains("startEngineFlow(splash = true)"))

    val state = source("RepairState.kt")
    val clear = state.substringAfter("private fun clearGate")
    assertTrue("必须同时清 required 与 retries", clear.contains("putBoolean(\"required\", false)") && clear.contains("putInt(\"retries\", 0)"))
  }

  @Test
  fun `foreground and cold start do not open the assistant on their own`() {
    val main = source("MainActivity.kt")
    assertFalse("MainActivity 不得自行拉起 RepairActivity", main.contains("RepairActivity::class.java"))
    val resume = main.substringAfter("override fun onResume()").substringBefore("if (recoverPageIfPending())")
    assertTrue("回前台保留故障页", resume.contains("applyRepairRequiredGuide()"))
    assertTrue("回前台的主按钮仍可重试", source("GuidePageRenderer.kt").contains("activity.retryEngineExplicitly()"))
  }

  @Test
  fun `assistant keeps retry reachable and isolates model failure from diagnostics`() {
    val repair = source("RepairActivity.kt")
    assertTrue("模型读取失败只更新横幅", repair.contains("val modelFailure = try"))
    assertTrue("诊断读取失败单独处理", repair.contains("val diagnosticsFailure = try"))
    assertFalse("模型缺失不得再整页 require() 失败", repair.contains("require(connections.isNotEmpty())"))
    assertTrue("重新读取模型配置必须直接读本地来源", repair.contains("RepairModelConfig.loadDetailed(applicationContext)"))
    assertTrue("返回启动页并重试使用进程内一次性标志（#682：intent action 可被外部应用冒充）", repair.contains("MainActivity.pendingSelfRetry = true"))
    val ordinaryBack = repair.substringAfter("private fun returnToLauncher()").substringBefore("private fun cancelWork")
    assertFalse("普通返回不能消耗一次显式重试", ordinaryBack.contains("RepairState.reset") || ordinaryBack.contains("beginUserRetry"))
    assertTrue("必须有打开控制台入口", repair.contains("ConsoleActivity::class.java"))
  }

  @Test
  fun `assistant actions keep Chinese and English copy together`() {
    val repair = source("RepairActivity.kt")
    for (pair in listOf(
      "重新读取模型配置" to "Reload model configuration",
      "打开控制台" to "Open console",
      "返回启动页重试引擎" to "Back and retry engine",
    )) {
      val idx = repair.indexOf("\"" + pair.first + "\"")
      assertTrue("缺少入口文案：${pair.first}", idx >= 0)
      val call = repair.substring((idx - 40).coerceAtLeast(0), (idx + pair.first.length + 120).coerceAtMost(repair.length))
      assertTrue("入口必须和英文同处一个调用：${pair.first}", call.contains(pair.second))
    }
    val main = source("MainActivity.kt")
    assertTrue(main.contains("Automatic retries are used up. Retry the engine first"))
    val chrome = source("GuideChrome.kt")
    assertFalse("独立助手按钮不能被永久藏起", chrome.contains("repairButton.visibility = View.GONE"))
  }
}
