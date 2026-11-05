package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1476：Shizuku「就绪」必须有**功能证据**，失败必须留痕。
 *
 * issue #1506：探测**未完成** = 三态里的 unknown，不得渲染成「未就绪」（坑 161）。
 *
 * issue #1529：接线判据原来全是源码文本切片（verdict 结果被丢弃、probeJson() 返回空对象、
 * elapsedMs 写墙钟也全绿）。现在一律改成**行为/计数**断言：直接跑接线函数、断言它落下的 JSON
 * 与调用计数，于是「verdict 被丢弃」「elapsedMs 改成墙钟」「未探测完折成 false」都会红。
 */
class ShizukuReadyEvidenceTest {

  private fun facts(probe: FunctionalProbeSnapshot) = ReadyFacts(
    binderAlive = true, granted = true, version = 13, bound = true, probe = probe,
  )

  // ── 判据 1：lastShellFailure 的 elapsedMs 必须来自**单调时钟**（不是只看字段在场） ──

  @Test
  fun shellFailureElapsedComesFromMonotonicClockNotWallClock() {
    val original = ShizukuTransport.monotonicClock
    try {
      ShizukuTransport.monotonicClock = { 42_000L }
      ShizukuTransport.recordShellFailure("shell-transport-failed", "IllegalStateException: boom")
      val first = ShizukuTransport.lastShellFailureSnapshot()
      assertNotNull("失败必须留痕（否则面板永远是 ready）", first)
      assertEquals("shell-transport-failed", first!!.optString("code"))
      assertEquals("elapsedMs 必须原样取自单调时钟（改成墙钟会得到毫秒级 epoch）", 42_000L, first.getLong("elapsedMs"))
      assertTrue("必须带可读原因", first.optString("message").contains("boom"))
      ShizukuTransport.monotonicClock = { 43_500L }
      ShizukuTransport.recordShellFailure("shizuku-user-service-not-bound", "again")
      assertEquals(
        "每次留痕都必须用单调时钟的当前值",
        43_500L,
        ShizukuTransport.lastShellFailureSnapshot()!!.getLong("elapsedMs"),
      )
    } finally {
      ShizukuTransport.monotonicClock = original
    }
  }

  // ── 判据 2：探测结果 → 三态（issue #1506） ────────────────────────────────

  @Test
  fun pendingProbeIsUnknownNotNotReady() {
    val verdict = readinessVerdict(facts(FunctionalProbeSnapshot(false, false, -1, "", 0L)), now = 1_000L)
    assertNull("尚未探测完必须是三态里的「未知」，折成 false 就是坑 161 的缺陷", readinessState(verdict))
    assertEquals("但 code 仍要如实说明「正在探」", READY_PROBE_PENDING, verdict.code)
  }

  @Test
  fun failedProbeMapsToFalseAndSuccessMapsToTrue() {
    val failed = readinessVerdict(facts(FunctionalProbeSnapshot(true, false, -1, "boom", 1_000L)), now = 2_000L)
    assertEquals(false as Boolean?, readinessState(failed))
    val ok = readinessVerdict(facts(FunctionalProbeSnapshot(true, true, 2, "", 1_000L)), now = 2_000L)
    assertEquals(true as Boolean?, readinessState(ok))
  }

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

  // ── 判据 4：status() 的就绪尾巴（接线行为，不是源码文本） ──────────────────

  /** 生产接线的一次调用：返回落下的 JSON + 本拍催探测的次数。 */
  private fun statusJson(probe: FunctionalProbeSnapshot, now: Long = 2_000L): Pair<JSONObject, Int> {
    var kicks = 0
    val out = statusReadinessJson(
      out = JSONObject().put("running", true).put("bound", true),
      facts = facts(probe),
      now = now,
      kickProbe = { kicks += 1 },
      failureGuidance = { verdict -> "failure:" + verdict.code },
      readyGuidance = "ready-now",
    )
    return out to kicks
  }

  @Test
  fun successProbe_writesReadyStatusJsonWithoutKicking() {
    val (out, kicks) = statusJson(FunctionalProbeSnapshot(true, true, 2, "", 1_000L))
    assertTrue("探测成功必须 ok=true", out.getBoolean("ok"))
    assertEquals("shizuku-ready", out.getString("code"))
    assertEquals("guidance 必须用就绪文案", "ready-now", out.getString("guidance"))
    assertEquals(true as Boolean?, readinessTriState(out))
    assertEquals(READY_STATE_READY, out.getString("readyState"))
    assertEquals("TTL 内的结果不得重复催探测", 0, kicks)
    assertEquals("既有字段必须原样保留", true, out.getBoolean("running"))
  }

  @Test
  fun failedProbe_writesDedicatedNotReadyJson() {
    val (out, kicks) = statusJson(FunctionalProbeSnapshot(true, false, -1, "boom", 1_000L))
    assertFalse("探测失败不得报 ok", out.getBoolean("ok"))
    assertEquals("失败必须用自己的 code，不得与未绑定/版本过低混成一个", READY_PROBE_FAILED, out.getString("code"))
    assertEquals("failure:" + READY_PROBE_FAILED, out.getString("guidance"))
    assertEquals(false as Boolean?, readinessTriState(out))
    assertEquals(READY_STATE_NOT_READY, out.getString("readyState"))
    assertEquals("TTL 内的失败结果不得每拍重探", 0, kicks)
  }

  @Test
  fun pendingProbe_writesUnknownJsonAndKicksTheProbe() {
    val (out, kicks) = statusJson(FunctionalProbeSnapshot(false, false, -1, "", 0L), now = 1_000L)
    assertFalse("未探测完不得宣称就绪", out.getBoolean("ok"))
    assertEquals(READY_PROBE_PENDING, out.getString("code"))
    assertTrue("ready 必须是 JSON null（三态的未知），不能是 false", out.isNull("ready"))
    assertEquals(READY_STATE_UNKNOWN, out.getString("readyState"))
    assertNotEquals("未知不得被写成 not-ready", READY_STATE_NOT_READY, out.getString("readyState"))
    assertEquals("未知档必须催一次探测（否则永远收敛不了）", 1, kicks)
  }

  @Test
  fun staleProbe_kicksOnceAndKeepsLastKnownGood() {
    val (out, kicks) = statusJson(
      FunctionalProbeSnapshot(true, true, 2, "", 1_000L),
      now = 1_000L + FunctionalProbeCache.DEFAULT_TTL_MS + 1,
    )
    assertTrue("沿用上次结果，面板不得闪", out.getBoolean("ok"))
    assertEquals(READY_STATE_READY, out.getString("readyState"))
    assertEquals("TTL 过期必须补探一次", 1, kicks)
  }

  // ── 判据 5：functionalProbe 快照不得是空对象（issue #1529） ────────────────

  @Test
  fun functionalProbeJsonCarriesRealFacts() {
    val p = FunctionalProbeSnapshot(true, true, 3, "", 1_000L)
    val json = functionalProbeJson(p, now = 2_000L)
    assertTrue("快照不得是空对象", json.length() >= 6)
    assertTrue(json.getBoolean("probed"))
    assertTrue(json.getBoolean("ok"))
    assertEquals(3, json.getInt("protocolVersion"))
    assertEquals(1_000L, json.getLong("atMs"))
    assertFalse(json.getBoolean("stale"))
    assertTrue(json.getBoolean("fromCache"))
    assertEquals(FunctionalProbeCache.DEFAULT_TTL_MS, json.getLong("ttlMs"))
    val stale = functionalProbeJson(p, now = 1_000L + FunctionalProbeCache.DEFAULT_TTL_MS + 1)
    assertTrue("过期必须如实标注", stale.getBoolean("stale"))
    assertFalse(stale.getBoolean("fromCache"))
    val never = functionalProbeJson(FunctionalProbeSnapshot(false, false, -1, "", 0L), now = 1_000L)
    assertFalse("从未探测不得标成过期", never.getBoolean("stale"))
    assertFalse(never.getBoolean("fromCache"))
  }

  // ── 判据 6：首次探测的有界同步短等（issue #1506 的执行面） ────────────────

  @Test
  fun awaitFirstProbe_givesUpAfterBudgetAndKicksExactlyOnce() {
    var kicks = 0
    var waited = 0L
    val result = awaitFirstProbe(
      kick = { kicks += 1 },
      snapshot = { FunctionalProbeSnapshot(false, false, -1, "", 0L) },
      budgetMs = 100L,
      awaitTick = { waited += it },
    )
    assertFalse("预算内没探到就如实给未知", result.probed)
    assertEquals("探测只该被催一次（单飞）", 1, kicks)
    assertEquals("必须用满且只用满预算，不得无限等", 100L, waited)
  }

  @Test
  fun awaitFirstProbe_returnsAsSoonAsTheBackgroundProbeLands() {
    var snapshots = 0
    var waited = 0L
    val result = awaitFirstProbe(
      kick = { },
      snapshot = {
        snapshots += 1
        if (snapshots >= 3) FunctionalProbeSnapshot(true, true, 2, "", 0L)
        else FunctionalProbeSnapshot(false, false, -1, "", 0L)
      },
      budgetMs = 100L,
      awaitTick = { waited += it },
    )
    assertTrue("探测一落地就必须返回", result.probed)
    assertEquals(2, result.protocolVersion)
    assertTrue("必须远早于预算（实测 waited=" + waited + "ms）", waited < 100L)
  }

  @Test
  fun awaitFirstProbe_neverBlocksTheUiThread() {
    var kicks = 0
    var ticks = 0
    val result = awaitFirstProbe(
      kick = { kicks += 1 },
      snapshot = { FunctionalProbeSnapshot(false, false, -1, "", 0L) },
      blockingAllowed = false,
      budgetMs = 100L,
      awaitTick = { ticks += 1 },
    )
    assertFalse(result.probed)
    assertEquals("主线程也必须催一次异步探测", 1, kicks)
    assertEquals("主线程一个切片都不许等", 0, ticks)
  }

  @Test
  fun awaitFirstProbe_doesNotWaitWhenAProbeAlreadyExists() {
    var kicks = 0
    var ticks = 0
    val existing = FunctionalProbeSnapshot(true, true, 2, "", 0L)
    val result = awaitFirstProbe(
      kick = { kicks += 1 },
      snapshot = { existing },
      budgetMs = 100L,
      awaitTick = { ticks += 1 },
    )
    assertTrue(result.ok)
    assertEquals("已有结果不得重复催探测", 0, kicks)
    assertEquals(0, ticks)
  }

  // ── 判据 7：caps 消费面读三态；旧快照按旧口径 ────────────────────────────

  @Test
  fun readinessTriStateReadsThreeStatesAndLegacySnapshots() {
    val (readyOut, _) = statusJson(FunctionalProbeSnapshot(true, true, 2, "", 1_000L))
    assertEquals(true as Boolean?, readinessTriState(readyOut))
    val (failedOut, _) = statusJson(FunctionalProbeSnapshot(true, false, -1, "boom", 1_000L))
    assertEquals(false as Boolean?, readinessTriState(failedOut))
    val (pendingOut, _) = statusJson(FunctionalProbeSnapshot(false, false, -1, "", 0L), now = 1_000L)
    assertNull("未探测完必须读成 null（caps 三态），不能读成 false", readinessTriState(pendingOut))
    assertEquals(
      "旧快照（无 readyState）按 ok 走旧口径",
      false as Boolean?,
      readinessTriState(JSONObject().put("ok", false).put("code", "shizuku-denied")),
    )
    assertNull("连 ok 都没有的快照只能算未知", readinessTriState(JSONObject()))
  }

  // ── 判据 8：无 logcat 特征时诊断非空且含 attempts= ──────────────────────────

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
}
