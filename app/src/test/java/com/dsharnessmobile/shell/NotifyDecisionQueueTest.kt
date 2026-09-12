package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 决策耐久队列回归（§6.3.1 / NT-14、NT-17）：requestId 幂等、指数退避 <=60s、
 * append-only 状态折叠（后写覆盖前写）。
 */
class NotifyDecisionQueueTest {

  @Test
  fun requestId_同决策恒同ID_不同决策不同ID() {
    val a = NotifyDecisionQueue.requestIdFor("e1", "approval", "{\"kind\":\"result\",\"value\":\"allowed-once\"}")
    val b = NotifyDecisionQueue.requestIdFor("e1", "approval", "{\"kind\":\"result\",\"value\":\"allowed-once\"}")
    val c = NotifyDecisionQueue.requestIdFor("e1", "approval", "{\"kind\":\"result\",\"value\":\"rejected\"}")
    val d = NotifyDecisionQueue.requestIdFor("e2", "approval", "{\"kind\":\"result\",\"value\":\"allowed-once\"}")
    assertEquals(a, b)
    assertEquals(16, a.length)
    assertFalse(a == c)
    assertFalse(a == d)
  }

  @Test
  fun 指数退避封顶60s且单调() {
    assertEquals(2_000L, NotifyDecisionQueue.retryDelayMs(0))
    assertEquals(4_000L, NotifyDecisionQueue.retryDelayMs(1))
    assertEquals(8_000L, NotifyDecisionQueue.retryDelayMs(2))
    var prev = 0L
    for (attempt in 0..12) {
      val d = NotifyDecisionQueue.retryDelayMs(attempt)
      assertTrue("delay 必须单调不减: " + attempt, d >= prev)
      assertTrue("delay 必须 <= 60s: " + d, d <= NotifyDecisionQueue.MAX_BACKOFF_MS)
      prev = d
    }
    assertEquals(60_000L, NotifyDecisionQueue.retryDelayMs(9))
  }

  @Test
  fun 序列化解析往返() {
    val d = NotifyDecisionQueue.Decision("rid", "e1", "question", "{\"kind\":\"result\"}", 123L, "pending", 2)
    val back = NotifyDecisionQueue.parse(NotifyDecisionQueue.serialize(d))
    assertNotNull(back)
    assertEquals(d, back)
    assertNull(NotifyDecisionQueue.parse("garbage"))
    assertNull(NotifyDecisionQueue.parse("{\"eventId\":\"e1\"}"))
  }

  @Test
  fun fold_同requestId后写覆盖前写() {
    val lines = listOf(
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("r1", "e1", "question", "{}", 1L, "pending", 0)),
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("r2", "e2", "approval", "{}", 2L, "pending", 0)),
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("r1", "e1", "question", "{}", 1L, "submitted", 1)),
    )
    val folded = NotifyDecisionQueue.fold(lines)
    assertEquals(2, folded.size)
    val r1 = folded.first { it.requestId == "r1" }
    assertEquals("submitted", r1.state)
    assertEquals(1, r1.attempts)
  }

  @Test
  fun lru_同requestId只接受一次且容量有界() {
    val lru = NotifyDecisionQueue.Lru(2)
    assertTrue(lru.accept("a"))
    assertFalse(lru.accept("a"))
    assertTrue(lru.accept("b"))
    assertTrue(lru.accept("c"))
    // 容量 2：最旧的 a 已被挤出，可再次接受（LRU 是防连点，不承担永久去重）
    assertTrue(lru.accept("a"))
    assertTrue(lru.contains("a"))
  }


  // ── NOT_READY 墙钟预算（2026-09-13 设备实测后的修复口径）────────────────

  @Test
  fun 预算必须显著大于实测引擎冷启动上限_且不照60s卡死() {
    assertTrue(
      "预算必须大于实测冷启动上限",
      NotifyDecisionQueue.NOT_READY_BUDGET_MS > NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS,
    )
    assertTrue("实测上限本身就要 >60s", NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS > 60_000L)
    assertTrue("预算必须 >60s", NotifyDecisionQueue.NOT_READY_BUDGET_MS > 60_000L)
    assertEquals(300_000L, NotifyDecisionQueue.NOT_READY_BUDGET_MS)
  }

  @Test
  fun NOT_READY_预算内等待_到期才失败() {
    val ts = 1_800_000_000_000L
    assertEquals(NotifyDecisionQueue.WaitAction.RETRY, NotifyDecisionQueue.notReadyAction(ts, ts))
    assertEquals(
      "冷启动实测上限处仍必须等待（不因引擎慢启动误判失败）",
      NotifyDecisionQueue.WaitAction.RETRY,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS),
    )
    assertEquals(
      NotifyDecisionQueue.WaitAction.RETRY,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.NOT_READY_BUDGET_MS - 1),
    )
    assertEquals(
      "到期即判失败（落到可见的「提交失败，点击重试」）",
      NotifyDecisionQueue.WaitAction.FAIL,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.NOT_READY_BUDGET_MS),
    )
    assertEquals(
      NotifyDecisionQueue.WaitAction.FAIL,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.NOT_READY_BUDGET_MS + 60_000L),
    )
  }

  @Test
  fun NOT_READY_独立计数参与退避且封顶60s() {
    var prev = 0L
    for (w in 0..10) {
      val d = NotifyDecisionQueue.retryDelayMs(w)
      assertTrue("NOT_READY 退避必须单调不减：w=" + w, d >= prev)
      assertTrue("NOT_READY 退避必须 <=60s：w=" + w, d <= NotifyDecisionQueue.MAX_BACKOFF_MS)
      prev = d
    }
    assertEquals(60_000L, NotifyDecisionQueue.retryDelayMs(10))
  }

  @Test
  fun 预算窗口内退避至少能排若干次() {
    var total = 0L
    var w = 0
    while (total < NotifyDecisionQueue.NOT_READY_BUDGET_MS && w < 100) {
      total += NotifyDecisionQueue.retryDelayMs(w)
      w++
    }
    assertTrue("退避阶梯必须在预算内至少能排若干次", w >= 5)
    assertTrue("累加必须能走到预算（不然预算就没意义）", total >= NotifyDecisionQueue.NOT_READY_BUDGET_MS)
  }

  @Test
  fun waitAttempts_序列化往返与默认值() {
    val d = NotifyDecisionQueue.Decision("rid2", "e2", "question", "{}", 42L, "pending", 1, 3)
    val back = NotifyDecisionQueue.parse(NotifyDecisionQueue.serialize(d))
    assertNotNull(back)
    assertEquals(3, back!!.waitAttempts)
    assertEquals(1, back.attempts)
    assertEquals(d, back)
    // 老行（无 waitAttempts 字段）必须默认 0，不得解析失败
    val legacy = NotifyDecisionQueue.parse(
      "{\"requestId\":\"r\",\"eventId\":\"e\",\"kind\":\"question\",\"outcome\":\"{}\",\"ts\":1,\"state\":\"pending\",\"attempts\":2}",
    )
    assertEquals(0, legacy!!.waitAttempts)
    assertEquals(2, legacy.attempts)
  }

  // ── 触发点自愈（真缺陷：进程死亡带走重试定时器 → 预算永不被评估）──────────

  @Test
  fun 重启后触发点按预算重评_滞留pending不会被永久搁置() {
    val now = 1_800_000_000_000L
    fun d(id: String, ts: Long, st: String) =
      NotifyDecisionQueue.Decision(id, "e-" + id, "approval", "{}", ts, st, 0, 8)
    val budget = NotifyDecisionQueue.NOT_READY_BUDGET_MS
    val cold = NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS
    val plan = NotifyDecisionQueue.resumePlan(
      listOf(
        d("expired", now - budget - 1_000L, "pending"),
        d("failed-kept", now - budget - 1_000L, "failed"),
        d("slow-boot", now - cold, "pending"),
        d("fresh", now - 1_000L, "pending"),
        d("submitted", now - budget - 1_000L, "submitted"),
        d("settled", now, "settled"),
        d("expired-state", now, "expired"),
      ),
      now,
    )
    assertTrue("已超预算的滞留决策必须重评为到期", plan.expired.contains("expired"))
    assertTrue("FAILED 也要重评（否则重启后永远不再尝试）", plan.expired.contains("failed-kept"))
    assertTrue("冷启动实测上限内不算到期（不许慢启动误判）", plan.waiting.contains("slow-boot"))
    assertTrue(plan.waiting.contains("fresh"))
    assertFalse(plan.expired.contains("submitted"))
    assertFalse(plan.waiting.contains("submitted"))
    assertFalse(plan.expired.contains("settled"))
    assertFalse(plan.expired.contains("expired-state"))
    assertEquals(2, plan.expired.size)
    assertEquals(2, plan.waiting.size)
  }

  @Test
  fun 空队列的重评计划为空() {
    val plan = NotifyDecisionQueue.resumePlan(emptyList(), 1L)
    assertTrue(plan.expired.isEmpty())
    assertTrue(plan.waiting.isEmpty())
  }

  @Test
  fun 状态枚举闭集() {
    assertEquals("pending", NotifyDecisionQueue.State.PENDING.wire)
    assertEquals("submitted", NotifyDecisionQueue.State.SUBMITTED.wire)
    assertEquals("settled", NotifyDecisionQueue.State.SETTLED.wire)
    assertEquals("failed", NotifyDecisionQueue.State.FAILED.wire)
    assertEquals("expired", NotifyDecisionQueue.State.EXPIRED.wire)
    assertEquals(NotifyDecisionQueue.State.PENDING, NotifyDecisionQueue.State.of("unknown-state"))
    assertEquals(NotifyDecisionQueue.State.SETTLED, NotifyDecisionQueue.State.of("settled"))
  }
}
