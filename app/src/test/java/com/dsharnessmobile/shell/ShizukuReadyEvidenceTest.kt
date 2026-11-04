package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1476：Shizuku「就绪」必须有**功能证据**，失败必须留痕。
 *
 * 缺陷形态：`status()` 只验 binder 活着（`pingBinder()`），而 binder 代理活着不等于 UserService 可用；
 * 于是面板报「已就绪」，`adb_shell` 一调就抛。同时失败只作为返回值给调用方，面板看不到、事后查不到。
 */
class ShizukuReadyEvidenceTest {

  // ── 判据 1：lastShellFailure 必须带 code / elapsedMs ──────────────────────────

  @Test
  fun shellFailureIsRecordedWithCodeAndElapsed() {
    ShizukuTransport.recordShellFailure("shell-transport-failed", "IllegalStateException: boom")
    val snapshot = ShizukuTransport.lastShellFailureSnapshot()
    assertNotNull("失败必须留痕（否则面板永远是 ready）", snapshot)
    assertEquals("shell-transport-failed", snapshot!!.optString("code"))
    // JVM 单测里 SystemClock.elapsedRealtime() 返回 0（无 Robolectric），故只断言**字段在场**。
    assertTrue("必须带 elapsedMs（单调时钟）", snapshot.has("elapsedMs"))
    assertTrue("必须带可读原因", snapshot.optString("message").contains("boom"))
  }

  // ── 判据 2：功能探测失败 → ok=false 且 code ≠ shizuku-ready ────────────────

  private fun facts(probe: FunctionalProbeSnapshot) = ReadyFacts(
    binderAlive = true, granted = true, version = 13, bound = true, probe = probe,
  )

  @Test
  fun failedProbeIsNotReady() {
    val snapshot = FunctionalProbeSnapshot(
      probed = true, ok = false, protocolVersion = -1,
      error = "IllegalStateException: the shell service did not start", atMs = 1_000L,
    )
    val verdict = readinessVerdict(facts(snapshot), now = 2_000L)
    assertFalse("探测失败不得报 ready", verdict.ok)
    assertNotEquals("shizuku-ready", verdict.code)
    assertEquals(READY_PROBE_FAILED, verdict.code)
  }

  @Test
  fun okProbeIsReady() {
    val snapshot = FunctionalProbeSnapshot(true, true, 2, "", 1_000L)
    val verdict = readinessVerdict(facts(snapshot), now = 2_000L)
    assertTrue(verdict.ok)
    assertEquals("shizuku-ready", verdict.code)
    assertTrue("TTL 内应标注来自缓存", verdict.probeFromCache)
  }

  @Test
  fun neverProbedIsNotReady() {
    val verdict = readinessVerdict(facts(FunctionalProbeSnapshot(false, false, -1, "", 0L)), now = 1_000L)
    assertFalse("从未探测过不得宣称就绪", verdict.ok)
    assertEquals(READY_PROBE_PENDING, verdict.code)
  }

  @Test
  fun staleProbeKeepsLastKnownGoodInsteadOfFlashing() {
    val snapshot = FunctionalProbeSnapshot(true, true, 2, "", 1_000L)
    val verdict = readinessVerdict(facts(snapshot), now = 1_000L + FunctionalProbeCache.DEFAULT_TTL_MS + 1)
    assertTrue("TTL 过期不得直接变 not-ready（会闪）", verdict.ok)
    assertTrue("但必须标注 stale，让诊断面如实说", verdict.probeStale)
    assertFalse(verdict.probeFromCache)
  }

  // ── 判据 3：TTL 内命中缓存 → **不再调用 binder**（计数断言） ────────────────

  @Test
  fun cacheHitsDoNotCallBinder() {
    var now = 1_000L
    var binderCalls = 0
    val cache = FunctionalProbeCache(ttlMs = 30_000L) { now }
    repeat(10) {
      cache.probeIfNeeded({ binderCalls += 1; 2 })
      now += 1_000L // 仍在 TTL 内
    }
    assertEquals("TTL 内只应探测一次", 1, cache.probeCalls)
    assertEquals("binder 只被打一次", 1, binderCalls)
    now += 31_000L // 越过 TTL
    cache.probeIfNeeded({ binderCalls += 1; 2 })
    assertEquals("TTL 过期后补探一次", 2, cache.probeCalls)
    assertEquals(2, binderCalls)
  }

  @Test
  fun failedProbeIsCachedTooSoPollingDoesNotHammerBinder() {
    var now = 1_000L
    var binderCalls = 0
    val cache = FunctionalProbeCache(ttlMs = 30_000L) { now }
    repeat(5) {
      cache.probeIfNeeded({ binderCalls += 1; throw IllegalStateException("no callback") })
      now += 1_000L
    }
    assertEquals(1, cache.probeCalls)
    assertEquals(1, binderCalls)
    assertFalse(cache.current().ok)
    assertTrue(cache.current().error.contains("no callback"))
  }

  // ── 判据 4：无 logcat 特征时诊断非空且含 attempts= ──────────────────────────

  @Test
  fun silentFailureStillHasStructuredDiagnostic() {
    val text = startFailureDiagnostic(attempts = 3, ageMs = 20_000L, excerpt = "   ")
    assertTrue("静默失败也必须有一条诊断", text.isNotBlank())
    assertTrue("必须写清尝试次数：" + text, text.contains("attempts=3"))
    assertTrue("必须写清已等时长：" + text, text.contains("age=20000ms"))
  }

  @Test
  fun logcatExcerptWinsWhenPresent() {
    assertEquals("LoadedApk NPE", startFailureDiagnostic(1, 1L, "LoadedApk NPE"))
  }

  // ── 接线：status() 必须真的用上这三样 ───────────────────────────────────────

  @Test
  fun statusWiresTheEvidence() {
    var root: File? = File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !File(root, "app/src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt").isFile) {
      root = root.parentFile
    }
    requireNotNull(root) { "找不到仓库根" }
    val src = File(root!!, "app/src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt").readText()
    assertTrue("status() 必须带 lastShellFailure", src.contains("lastShellFailure?.let { out.put(\"lastShellFailure\", it) }"))
    assertTrue("status() 必须带 functionalProbe", src.contains("out.put(\"functionalProbe\", probeJson())"))
    assertTrue("ready 判定必须走 readinessVerdict", src.contains("readinessVerdict("))
    assertTrue("静默失败诊断必须接上", src.contains("startFailureDiagnostic(bindState.attempts"))
    assertTrue("shellFailure 必须留痕", src.contains("recordShellFailure(\"shell-transport-failed\""))
    assertTrue("unavailableShell 必须留痕", src.contains("recordShellFailure(\"shizuku-user-service-not-bound\""))
  }
}