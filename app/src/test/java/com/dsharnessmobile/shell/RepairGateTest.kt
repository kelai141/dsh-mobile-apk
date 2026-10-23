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
  fun `automatic retry remains bounded and never clears the durable gate`() {
    assertFalse("required 时不得自动重试", shouldScheduleAutomaticRetry(required = true, retries = 0, retryPending = false))
    assertFalse("已有排队重试时不得叠加", shouldScheduleAutomaticRetry(required = false, retries = 0, retryPending = true))
    assertTrue(shouldScheduleAutomaticRetry(required = false, retries = 0, retryPending = false))
    assertTrue(shouldScheduleAutomaticRetry(required = false, retries = 1, retryPending = false))
    assertFalse("两次后必须停手", shouldScheduleAutomaticRetry(required = false, retries = 2, retryPending = false))
  }

  @Test
  fun `only the explicit retry clears required and the retry budget`() {
    val start = source("EngineStartFlow.kt").substringAfter("fun start()").substringBefore("resetBootStall()")
    assertTrue("自动 start 必须以 explicitUserRetry = false 过闸门",
      start.contains("startupEntryDecision(RepairState.required(activity), explicitUserRetry = false)"))
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
    assertTrue("返回启动页并重试使用一次性动作", repair.contains("MainActivity.ACTION_RETRY_ENGINE"))
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
