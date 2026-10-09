package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** #342: distinguish known failures; a foreign port must never send users into profile repair. */
class Issue342StartupDiagnosticTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText().lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  @Test fun `known failures have distinct user explanations`() {
    val codes = listOf(EngineManager.REFUSAL_PORT_FOREIGN, EngineManager.REFUSAL_PRIVATE_STORAGE_DENIED,
      EngineManager.REFUSAL_STORAGE_FULL, EngineManager.REFUSAL_RUNTIME_UNAVAILABLE, null)
    assertEquals(5, codes.map(::startupFailureHintResource).toSet().size)
    assertEquals(R.string.ds_start_unknown, startupFailureHintResource("unrecognized-future-code"))
  }

  @Test fun `only foreign port substitutes retry for safe mode`() {
    assertTrue(startupFailureUsesRetry(EngineManager.REFUSAL_PORT_FOREIGN))
    listOf(null, EngineManager.REFUSAL_PRIVATE_STORAGE_DENIED, EngineManager.REFUSAL_STORAGE_FULL,
      EngineManager.REFUSAL_LIVE_RUNTIME_INCOMPLETE).forEach { assertFalse(startupFailureUsesRetry(it)) }
  }

  @Test fun `foreign refusal has no auto undo retry or ownership repair`() {
    val flow = source("EngineStartFlow.kt")
    val failure = flow.substringAfter("val refusalCode = activity.engineManager.lastStartRefusalCode")
      .substringBefore("val pollBudgetMs")
    val guard = "if (refusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return@Thread"
    assertTrue(failure.contains(guard))
    assertTrue(failure.indexOf(guard) < failure.indexOf("maybeAutoUndo(generation)"))
    assertTrue(failure.indexOf(guard) < failure.indexOf("scheduleEngineRetry(generation)"))
    val guide = source("GuidePageRenderer.kt")
    assertTrue(guide.contains("if (phase == GuidePhase.Error && startupOwnershipRepairAllowed) autoRepairOwnershipOnFailure()"))
    assertTrue(guide.contains("lastGuidePhase == GuidePhase.Error && !startupRetryAction"))
    assertTrue(guide.contains("phase == GuidePhase.Error && !startupOwnershipRepairAllowed"))
  }

  @Test fun `confirmed permission and space diagnostics survive ownership repair`() {
    listOf(EngineManager.REFUSAL_PORT_FOREIGN, EngineManager.REFUSAL_PRIVATE_STORAGE_DENIED,
      EngineManager.REFUSAL_STORAGE_FULL).forEach { assertFalse(startupFailureAllowsOwnershipRepair(it)) }
    assertTrue(startupFailureAllowsOwnershipRepair(null))
    assertTrue(startupFailureAllowsOwnershipRepair(EngineManager.REFUSAL_LIVE_RUNTIME_INCOMPLETE))
    assertTrue(source("GuidePageRenderer.kt").contains("lastGuidePhase == GuidePhase.Error && startupOwnershipRepairAllowed"))
  }

  @Test fun `monitor cannot replace foreign port error with unrelated web page`() {
    val monitor = source("EngineStartFlow.kt").substringAfter("private val engineMonitorRunnable")
      .substringBefore("private val freezeHandler")
    assertTrue(monitor.contains("lastStartRefusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return"))
    assertTrue(monitor.contains("lastStartRefusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return@runOnUiThread"))
    assertEquals(2, Regex("if \\(flowOwnership.running\\)").findAll(monitor).count())
  }

  @Test fun `retry ownership prevents monitor promotion until startup completes`() {
    val owner = StartupFlowOwnership()
    assertFalse(owner.running)
    val token = owner.begin()!!
    assertTrue(owner.running)
    owner.finish(token)
    assertFalse(owner.running)
    val retry = owner.begin()!!
    owner.finish(token)
    assertTrue(owner.running)
    owner.finish(retry)
    assertFalse(owner.running)
  }

  @Test fun `all foreign port branches record structured cause and clear stale cause`() {
    val start = source("EngineManager.kt").substringAfter("fun startEngine(").substringBefore("fun settingsDocumentPath")
    assertEquals(4, Regex("lastStartRefusalCode = REFUSAL_PORT_FOREIGN").findAll(start).count())
    assertTrue(start.indexOf("lastStartRefusal = null") < start.indexOf("snapshotFingerprintProblem()"))
    assertTrue(start.indexOf("lastStartRefusalCode = null") < start.indexOf("snapshotFingerprintProblem()"))
  }

  @Test fun `private write diagnosis requires syscall denial plus private directory evidence`() {
    val policy = source("EngineManager.kt").substringAfter("internal fun startupExceptionCode")
      .substringBefore("fun settingsDocumentPath")
    assertTrue(policy.contains("filterIsInstance<android.system.ErrnoException>()"))
    assertTrue(policy.contains("listOf(context.filesDir, homeDir)"))
    assertTrue(policy.contains("android.system.Os.access"))
    assertTrue(policy.contains("if (privateWriteDenied) return REFUSAL_PRIVATE_STORAGE_DENIED"))
    assertFalse(policy.contains(".message"))
    assertFalse(policy.contains("MANAGE_EXTERNAL_STORAGE"))
  }
}
