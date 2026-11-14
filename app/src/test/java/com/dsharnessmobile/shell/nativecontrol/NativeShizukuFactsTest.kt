package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 原生 Shizuku 事实缓存的行为判据。
 *
 * 每个用例对应一条必须成立的性质：未知不降级为否、app 授权与远端身份分开、
 * 同连接（代次 + 失效计数）记账、过期即未知、读路径不续命、迟到结果不回写。
 */
class NativeShizukuFactsTest {
  private var now = 1_000L
  private val facts = NativeShizukuFacts(clock = { now })

  private fun snap() = facts.snapshot()
  private fun tri(name: String) = snap().getString(name)
  private fun uidKind() = snap().getJSONObject("serverUid")

  /** 一条已绑定、已授权、探测成功的健康连接。 */
  private fun healthy(generation: Long = 1): LinkToken {
    val token = facts.tokenAt(generation)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)
    facts.onBound(token, true)
    facts.onProbe(token, true, now)
    facts.onServerUid(token, 2000)
    return token
  }

  @Test fun coldCacheReportsUnknownRatherThanNo() {
    val snapshot = snap()
    for (field in listOf("installed", "running", "granted", "bound", "functionalReady")) {
      assertEquals(field + " 冷启动不得写成 no", "unknown", snapshot.getString(field))
    }
    assertEquals("unknown", uidKind().getString("kind"))
    assertEquals("unknown", snapshot.getJSONObject("supportedOps").getString("state"))
    assertEquals("unknown", snapshot.getJSONObject("displaySupport").getString("state"))
  }

  @Test fun observedLinkPublishesExactWireShapeAndKeepsExecutionSurfaceUnknown() {
    healthy()

    val snapshot = snap()
    assertEquals(
      setOf("installed", "running", "granted", "bound", "functionalReady", "serverUid", "supportedOps", "displaySupport"),
      snapshot.keys().asSequence().toSet(),
    )
    assertEquals("yes", snapshot.getString("installed"))
    assertEquals("yes", snapshot.getString("running"))
    assertEquals("yes", snapshot.getString("granted"))
    assertEquals("yes", snapshot.getString("bound"))
    assertEquals("yes", snapshot.getString("functionalReady"))
    assertEquals("shell2000", snapshot.getJSONObject("serverUid").getString("kind"))
    // 没有执行面证据：专属操作与屏幕支持不得由其它布尔值推断出来。
    assertEquals("unknown", snapshot.getJSONObject("supportedOps").getString("state"))
    assertEquals("unknown", snapshot.getJSONObject("displaySupport").getString("state"))
  }

  @Test fun tapRequiresSameConnectionShellIdentityAndLiveHandshake() {
    val token = healthy()
    assertFalse(facts.permitsRealTap(token))
    facts.onRealTapCapability(token, true)
    assertTrue(facts.permitsRealTap(token))
    assertEquals("click", snap().getJSONObject("supportedOps").getJSONArray("ops").getString(0))
    assertEquals(setOf("0"), snap().getJSONObject("displaySupport").getJSONObject("values").keys().asSequence().toSet())
    facts.onServerUid(token, 0)
    assertFalse(facts.permitsRealTap(token))
    facts.onServerUid(token, 2000)
    assertTrue(facts.permitsRealTap(token))
    facts.onBound(token, false)
    facts.onRealTapCapability(token, true)
    facts.onBound(token, true)
    assertFalse(facts.permitsRealTap(token))
    assertEquals("unknown", snap().getJSONObject("supportedOps").getString("state"))
    val current = healthy()
    facts.onRealTapCapability(current, true)
    assertTrue(facts.permitsRealTap(current))
    now += NativeShizukuFacts.DEFAULT_TTL_MS + 1
    assertFalse(facts.permitsRealTap(current))
  }

  @Test fun serverUidKeepsShellRootAndOtherStrictlyApart() {
    val token = facts.tokenAt(1)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)

    facts.onServerUid(token, 2000)
    assertEquals("shell2000", uidKind().getString("kind"))
    assertFalse("shell2000 不应带 uid 字段", uidKind().has("uid"))

    facts.onServerUid(token, 0)
    assertEquals("root0", uidKind().getString("kind"))
    // 远端以 0 运行不等于本应用已授权：两个事实各自记录。
    assertEquals("yes", tri("granted"))

    facts.onServerUid(token, 10101)
    assertEquals("other", uidKind().getString("kind"))
    assertEquals(10101, uidKind().getInt("uid"))
  }

  @Test fun unreadableUidIsUnknownNotZero() {
    val token = facts.tokenAt(1)
    facts.onLink(token, true, true)
    facts.onServerUid(token, -1)
    assertEquals("unknown", uidKind().getString("kind"))
    facts.onServerUid(token, null)
    assertEquals("unknown", uidKind().getString("kind"))
    assertFalse("拿不到可靠 UID 时不得回落到 root0", uidKind().optString("kind") == "root0")
  }

  @Test fun probeFailureAndUnseenProbeStayDistinct() {
    val token = facts.tokenAt(1)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)
    facts.onBound(token, true)
    assertEquals("unknown", tri("functionalReady"))
    facts.onProbe(token, false, now)
    assertEquals("no", tri("functionalReady"))
    // 绑定在、探测失败：两条事实各自独立，不能互改。
    assertEquals("yes", tri("bound"))
  }

  @Test fun runningProbeExceptionIsUnknownAndClearsDependentFacts() {
    val token = healthy()
    // 同代内探活抛异常：不能沿用上次的 yes，依赖 binder 的连接面事实同步作废。
    facts.onLink(token, null, null)
    assertEquals("unknown", tri("running"))
    assertEquals("unknown", tri("installed"))
    assertEquals("unknown", tri("granted"))
    assertEquals("unknown", tri("bound"))
    assertEquals("unknown", uidKind().getString("kind"))

    val next = facts.token()
    facts.onLink(next, true, false)
    assertEquals("no", tri("running"))
    assertEquals("no", tri("bound"))
  }

  @Test fun losingGrantClearsBoundFactsAndRejectsLateSuccess() {
    val token = healthy()
    facts.onGranted(token, false)
    assertEquals("no", tri("granted"))
    assertEquals("unknown", tri("bound"))
    assertEquals("unknown", tri("functionalReady"))
    assertEquals("unknown", uidKind().getString("kind"))

    // 反证：撤权前发出的 uid/probe/bound 结果迟到，不得把通道写回可用。
    facts.onServerUid(token, 2000)
    facts.onProbe(token, true, now)
    facts.onBound(token, true)
    assertEquals("unknown", uidKind().getString("kind"))
    assertEquals("unknown", tri("functionalReady"))
    assertEquals("unknown", tri("bound"))
  }

  @Test fun staleObservationsExpireToUnknown() {
    healthy()
    now += NativeShizukuFacts.DEFAULT_TTL_MS - 1
    assertEquals("TTL 边界内仍是肯定观测", "yes", tri("bound"))
    now += 2
    for (field in listOf("installed", "running", "granted", "bound", "functionalReady")) {
      assertEquals(field + " 过期后必须是 unknown", "unknown", tri(field))
    }
    assertEquals("unknown", uidKind().getString("kind"))
  }

  @Test fun readingStatusDoesNotRefreshProbeTtl() {
    val token = healthy()
    val probedAt = now
    // 模拟每 2s 一次的 status 轮询：反复用同一份探测结果发布。
    repeat(20) {
      now += 2_000
      facts.onProbe(token, true, probedAt)
      facts.snapshot()
    }
    assertEquals("读路径不得给旧探测续命", "unknown", tri("functionalReady"))

    // 重新探测一次即恢复：TTL 只由探测自身的观测时刻决定。
    facts.onProbe(token, true, now)
    assertEquals("yes", tri("functionalReady"))
  }

  @Test fun outOfOrderProbesInSameGenerationKeepTheNewestObservation() {
    val token = healthy()
    // 同一连接内两次并发探测：先发出的失败结果晚到，不得盖掉后发出的成功结果。
    val older = facts.tokenAt(1)
    now += 1_000
    val newer = facts.tokenAt(1)
    facts.onProbe(newer, true, newer.takenAtMs)
    facts.onProbe(older, false, older.takenAtMs)
    assertEquals("yes", tri("functionalReady"))

    // 反向：更晚的观测当然可以覆盖。
    now += 1_000
    val latest = facts.tokenAt(1)
    facts.onProbe(latest, false, latest.takenAtMs)
    assertEquals("no", tri("functionalReady"))
    assertEquals(token.generation, facts.generation())
  }

  @Test fun newerLinkObservationBeatsLateOlderOne() {
    val older = facts.tokenAt(1)
    now += 10
    val newer = facts.tokenAt(1)
    facts.onLink(newer, true, false)
    assertEquals("no", tri("running"))
    // 更早取票的那次探活（结果是 yes）晚到：必须丢弃，否则会把已停的服务写回运行中。
    facts.onLink(older, true, true)
    assertEquals("no", tri("running"))
    assertEquals("unknown", tri("granted"))
  }

  @Test fun linkInvalidationMakesPreexistingTicketUnusable() {
    // 模拟 status()：ping 之前取票，ping 回来发现服务不在 ⇒ onLink 清事实并推进失效计数。
    val runningTicket = facts.tokenAt(1)
    facts.onLink(runningTicket, true, false)
    // 反证：若后续逻辑复用这张已被作废的票（例如拿它发布 granted/bound），必须被拒绝。
    facts.onGranted(runningTicket, true)
    facts.onBound(runningTicket, true)
    assertEquals("unknown", tri("granted"))
    assertEquals("no", tri("bound"))
    // 每次发布前现取的票则会被接受。
    val fresh = facts.tokenAt(1)
    facts.onLink(fresh, true, true)
    facts.onGranted(facts.tokenAt(1), true)
    assertEquals("yes", tri("granted"))
  }

  @Test fun generationAdvanceInvalidatesConnectionFacts() {
    healthy()

    // 新一代开始：上一条连接的绑定/探测/身份不能冒充现状……
    facts.onLink(facts.tokenAt(2), true, true)
    assertEquals("unknown", tri("bound"))
    assertEquals("unknown", tri("functionalReady"))
    assertEquals("unknown", uidKind().getString("kind"))
    // ……但设备级事实不随连接消失。
    assertEquals("yes", tri("installed"))
    assertEquals("yes", tri("running"))

    // 旧代票整体失效：迟到的 connected 回调不能把 bound 拉回 yes。
    facts.onBound(LinkToken(1, facts.token().epoch, now), true)
    assertEquals("unknown", tri("bound"))
  }

  @Test fun lateCallbackFromPreviousConnectionCannotWriteBackYes() {
    healthy(2)
    val stale = facts.token()
    facts.onConnectionLost(facts.tokenAt(3).generation)
    assertEquals("no", tri("bound"))

    // 反证：已断开之后，上一条连接的「连接成功 / 探测成功 / uid」迟到。
    facts.onBound(stale, true)
    facts.onProbe(stale, true, now)
    facts.onServerUid(stale, 2000)
    assertEquals("no", tri("bound"))
    assertEquals("unknown", tri("functionalReady"))
    assertEquals("unknown", uidKind().getString("kind"))
    assertEquals(3L, facts.generation())
  }

  @Test fun lossAndResetUseThePostAdvanceGeneration() {
    val token = healthy(5)
    // 断连/重置都已换代：必须用换代后的代次发布，否则会被当成迟到回调丢弃。
    facts.onConnectionLost(6)
    assertEquals("no", tri("bound"))
    assertEquals("unknown", tri("functionalReady"))
    assertEquals("unknown", uidKind().getString("kind"))
    // 授权与应用在场是独立事实，断连不改写它们。
    assertEquals("yes", tri("granted"))
    assertEquals("yes", tri("running"))

    // 用旧代发布无效（这正是「锁外拿旧代」会踩的坑）。
    facts.onConnectionLost(token.generation)
    facts.onServerUid(token, 2000)
    assertEquals("unknown", uidKind().getString("kind"))
  }

  @Test fun newBindAttemptIsNotBoundYet() {
    healthy(3)
    facts.onBindStarted(4)
    assertEquals("no", tri("bound"))
    assertEquals("unknown", tri("functionalReady"))
    assertEquals("unknown", uidKind().getString("kind"))
  }

  @Test fun readsDoNotMutateTheCacheOrAdvanceTheGeneration() {
    healthy(7)
    val before = snap().toString()
    val epochBefore = facts.token().epoch
    repeat(5) {
      now += 1
      snap()
    }
    assertEquals("读路径不得改写事实（within TTL）", before, snap().toString())
    assertEquals(7L, facts.generation())
    assertEquals("读路径不得推进失效计数", epochBefore, facts.token().epoch)
  }

  @Test fun factsEntryAddsOnlyTheShizukuKey() {
    val token = facts.tokenAt(1)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)
    val inner = NativeControlDispatcher.Facts {
      JSONObject().put("scope", "virtual-only").put("screens", JSONObject())
    }
    val merged = facts.factsEntry(inner).capture()
    assertEquals("virtual-only", merged.getString("scope"))
    assertTrue(merged.has("screens"))
    assertEquals("yes", merged.getJSONObject("shizuku").getString("granted"))
    assertEquals(3, merged.length())
    assertNull(merged.opt("a11y"))
  }

  @Test fun cacheSourceHasNoBinderThreadOrIoSurface() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeShizukuFacts.kt").readText()
    for (forbidden in listOf("import rikka", "Thread(", "ProcessBuilder", "loadLibrary", "java.io", "import com.dsharnessmobile.shell.")) {
      assertFalse("事实缓存不得出现 " + forbidden, source.contains(forbidden))
    }
  }

  /** 工作目录可能是仓根、apk 模块根或 Gradle 测试工作目录：向上找到含 settings.gradle.kts 的根。 */
  private fun repoFile(path: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) {
        val hit = File(dir, path)
        if (hit.isFile) return hit
      }
      dir = dir.parentFile
    }
    throw AssertionError("找不到 " + path + "（工作目录 = " + File(".").absolutePath + "）")
  }
}
