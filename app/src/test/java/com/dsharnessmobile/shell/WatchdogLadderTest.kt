package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #175 + #210 回归：DEGRADED_HTTP 阶梯的纯计数函数 + 一拍看门狗的副作用顺序/退避口径。
 *
 * 覆盖（源文档 §3.3 B1）：
 * - FX-210.2：退避用 effectiveFailureCount（半死连续拍数递增，非恒 5s）；
 * - FX-210.3：状态无关副作用（onEngineProbe / 标记消费 / 唤醒锁）先于一切早退——含熔断打开那一拍；
 * - FX-210.4：HEALTHY/DEGRADED_HTTP/DEGRADED_LOG/DEAD 四态都消费任务完成标记；
 * - FX-210.1：恢复入口先于探活早退（服务路径与 Activity 路径的共同前置）。
 */
class WatchdogLadderTest {

  @Before
  fun resetWatchdog() {
    WatchdogV2.reset()
  }

  @Test
  fun degradedHttpCountsIncrementally() {
    assertEquals(1, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_HTTP, 0))
    assertEquals(6, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_HTTP, 5))
    assertEquals(7, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_HTTP, 6))
  }

  @Test
  fun otherStatesResetTheCounter() {
    assertEquals(0, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.HEALTHY, 5))
    assertEquals(0, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEAD, 5))
    // DEGRADED_LOG 不得触发重启：清零是硬约束
    assertEquals(0, WatchdogV2.nextDegradedCount(WatchdogV2.ProbeState.DEGRADED_LOG, 5))
  }

  @Test
  fun thresholdIsSixTicks30Seconds() {
    assertTrue("阈值 6 拍 = 30s，须远小于 90s 冷启动窗口", WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS == 6)
    assertTrue(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS < WatchdogV2.MAX_CONSEC_FAILURES)
  }

  // ── FX-210.2：半死退避必须随拍数递增 ─────────────────────────────

  @Test
  fun backoffEscalatesUnderDegradedHttpInsteadOfStayingFiveSeconds() {
    val delays = ArrayList<Long>()
    repeat(6) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
      delays += WatchdogV2.nextDelayMs()
    }
    assertEquals(
      "半死阶梯与 DEAD 共用 effectiveFailureCount（#210.2）",
      listOf(5_000L, 10_000L, 20_000L, 40_000L, 80_000L, 80_000L),
      delays,
    )
    assertTrue("退避不得恒定 5s", delays.toSet().size > 1)
  }

  @Test
  fun backoffForDeathStillEscalates() {
    val delays = ArrayList<Long>()
    repeat(6) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEAD)
      delays += WatchdogV2.nextDelayMs()
    }
    assertEquals(listOf(5_000L, 10_000L, 20_000L, 40_000L, 80_000L, 80_000L), delays)
  }

  // ── FX-210.3 / FX-210.4：前置副作用与状态无关 ────────────────────

  @Test
  fun preludeSideEffectsRunInEveryProbeState() {
    for (state in WatchdogV2.ProbeState.values()) {
      WatchdogV2.reset()
      var feeds = 0
      var consumed = 0
      var wakes = 0
      val healthyFlags = ArrayList<Boolean>()
      WatchdogV2.planTick(
        state = state,
        now = 0L,
        nextRestartAllowedAt = 0L,
        engineReady = true,
        engineProcessAlive = false,
        bootAgeMs = 999_999L,
        restartDeadConfirmations = 2,
        feedProbe = { feeds++; healthyFlags += it },
        consumeMarkers = { consumed++ },
        refreshWake = { wakes++ },
        undoReady = { false },
      )
      assertEquals("state=" + state + " onEngineProbe 次数", 1, feeds)
      assertEquals("state=" + state + " consumeTaskDoneMarkers 次数（#210.4 四态都要消费）", 1, consumed)
      assertEquals("state=" + state + " 唤醒锁续期次数", 1, wakes)
      assertEquals("state=" + state + " healthy 口径", state == WatchdogV2.ProbeState.HEALTHY, healthyFlags.single())
    }
  }

  @Test
  fun preludeStillRunsWhenTheCircuitBreakerIsOpen() {
    var feeds = 0
    var consumed = 0
    var wakes = 0
    fun tick() = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEAD,
      now = 0L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = false,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      feedProbe = { feeds++ },
      consumeMarkers = { consumed++ },
      refreshWake = { wakes++ },
      undoReady = { false },
    )

    repeat(WatchdogV2.MAX_CONSEC_FAILURES) { tick() }
    assertTrue("12 拍后熔断必须打开", WatchdogV2.tripped())
    assertEquals(WatchdogV2.MAX_CONSEC_FAILURES, feeds)

    var undoProbed = false
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEAD,
      now = 0L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = false,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      feedProbe = { feeds++ },
      consumeMarkers = { consumed++ },
      refreshWake = { wakes++ },
      // undo 本轮修复后**先于**熔断求值（见下 undoRemainsReachableOnceTheCircuitBreakerIsOpen）。
      // 本用例只锁「前置副作用在熔断打开那一拍仍执行」，故把 undo 传为不可用，使熔断分支可达。
      undoReady = { undoProbed = true; false },
    )
    assertEquals(WatchdogV2.TickAction.HOLD, plan.action)
    assertTrue("熔断分支必须给出可读原因", plan.logs.any { it.contains("circuit open") })
    assertEquals("熔断早退也不得跳过 onEngineProbe（#210.3）", WatchdogV2.MAX_CONSEC_FAILURES + 1, feeds)
    assertEquals("熔断早退也不得跳过标记消费（#210.4）", WatchdogV2.MAX_CONSEC_FAILURES + 1, consumed)
    assertEquals("熔断早退也不得跳过唤醒锁续期", WatchdogV2.MAX_CONSEC_FAILURES + 1, wakes)
    assertTrue("undo 闸门必须先被求值（修复后它排在熔断之前）", undoProbed)
  }

  // ── 0.14.1：熔断锁存盲区（undo 与 restart 在「半死引擎」下双双永久失效）────
  //
  // 存量缺陷：`tripped()` 曾排在 boot-window 与 `undoReady()` 之前，且一旦为真即**永久** HOLD，
  // 只有 HEALTHY 探活或 EngineStartFlow 的唯一一处 reset 能解。熔断在 60s 打开（12 拍 x 5s），
  // 而托管子进程的启动预算是 90s → 「子进程存活、HTTP 永不健康」这条路径上计数器先撞满，
  // `undoReady()` 此后**再也不被求值**：自动 undo 与自动重启同时永久失效。
  //
  // 下面三条是配套防线：
  //  1) undoRemainsReachableOnceTheCircuitBreakerIsOpen —— 正向：熔断打开后 undo 仍可介入（本修复的判绿点，
  //     修复前该断言得到 HOLD(circuit-open)，即判红）；
  //  2) halfDeadEngineStillReachesUndoAfterTheBootWindowExpires —— 真实半死场景（子进程存活 + bootAge 递增）；
  //  3) circuitBreakerStillBlocksBlindRestartWhenUndoIsUnavailable —— 反向对照：熔断的保护能力**未被削掉**。

  /** 生产 `planTick` 的逐拍驱动（DEAD 状态、可配 undo 闸门）。 */
  private fun deadTick(
    undoReady: () -> Boolean,
    engineProcessAlive: Boolean = false,
    bootAgeMs: Long = 999_999L,
  ) = WatchdogV2.planTick(
    state = WatchdogV2.ProbeState.DEAD,
    now = 0L,
    nextRestartAllowedAt = 0L,
    engineReady = true,
    engineProcessAlive = engineProcessAlive,
    bootAgeMs = bootAgeMs,
    restartDeadConfirmations = 2,
    feedProbe = {},
    consumeMarkers = {},
    refreshWake = {},
    undoReady = undoReady,
  )

  /** 连拍至熔断打开（undo 不可用），返回打开后的 plan。 */
  private fun openCircuitWithUndoUnavailable(): WatchdogV2.TickPlan {
    repeat(WatchdogV2.MAX_CONSEC_FAILURES) { deadTick(undoReady = { false }) }
    assertTrue("前置：12 拍后熔断必须已打开", WatchdogV2.tripped())
    return deadTick(undoReady = { false })
  }

  @Test
  fun undoRemainsReachableOnceTheCircuitBreakerIsOpen() {
    WatchdogV2.reset()
    openCircuitWithUndoUnavailable()
    var undoProbed = false
    // 熔断已打开；undo 闸门放行 —— 修复前返回 HOLD(circuit-open)（判红），修复后必须 UNDO。
    val plan = deadTick(undoReady = { undoProbed = true; true })
    assertTrue("undo 闸门必须被求值（不得被熔断早退吞掉）", undoProbed)
    assertEquals(
      "熔断打开后 undo 仍必须能介入：熔断只该禁止盲目重启，不该锁死配置回滚（0.14.1 锁存盲区）",
      WatchdogV2.TickAction.UNDO,
      plan.action,
    )
  }

  @Test
  fun halfDeadEngineStillReachesUndoAfterTheBootWindowExpires() {
    WatchdogV2.reset()
    // 真实半死形态：子进程存活（端口可连 / HTTP 全败 → DEGRADED_HTTP），bootAge 随拍递增。
    // 引擎从未被重启过，故启动时间为 0，bootAgeMs == now。
    var armedAt: Long? = null
    var undoProbed = 0
    var undoAtTick = 0
    var firstDisruptive: WatchdogV2.TickAction? = null
    for (tick in 1..30) {
      val now = tick * 5_000L
      val plan = WatchdogV2.planTick(
        state = WatchdogV2.ProbeState.DEGRADED_HTTP,
        now = now,
        nextRestartAllowedAt = 0L,
        engineReady = true,
        engineProcessAlive = true,
        bootAgeMs = now,
        restartDeadConfirmations = 2,
        feedProbe = {},
        consumeMarkers = {},
        refreshWake = {},
        // 用**生产闸门** UndoGate.decide 驱动：两阶段 arm/watch 语义即为线上语义。
        undoReady = {
          undoProbed++
          when (UndoGate.decide(WatchdogV2.effectiveFailureCount(), now, null, armedAt)) {
            UndoGate.GateDecision.ARM -> { armedAt = now; false }
            UndoGate.GateDecision.EXECUTE -> true
            else -> false
          }
        },
      )
      if (plan.action == WatchdogV2.TickAction.UNDO) { undoAtTick = tick; firstDisruptive = plan.action; break }
      if (plan.action == WatchdogV2.TickAction.RESTART) firstDisruptive = plan.action
    }
    assertTrue("半死引擎下 undo 闸门必须被求值（修复前恒为 0 次）", undoProbed > 0)
    assertEquals(
      "托管子进程存活但 HTTP 永不健康时，undo 仍必须在启动预算用尽后介入，不得被熔断永久锁死",
      WatchdogV2.TickAction.UNDO,
      firstDisruptive,
    )
    assertTrue("undo 必须在观察窗（15s）走完之后、且晚于 boot 预算（90s）才放行", undoAtTick * 5_000L > 90_000L)
  }

  @Test
  fun circuitBreakerStillBlocksBlindRestartWhenUndoIsUnavailable() {
    WatchdogV2.reset()
    val plan = openCircuitWithUndoUnavailable()
    // 反向对照（反假绿必需）：undo 不可用时熔断必须继续拦住盲目重启——修复不得削掉保护能力。
    assertEquals("熔断打开且 undo 不可用时必须 HOLD，不得 RESTART", WatchdogV2.TickAction.HOLD, plan.action)
    assertTrue("熔断分支必须给出可读原因", plan.logs.any { it.contains("circuit open") })
  }

  @Test
  fun bootWindowStillGuardsALiveChildFromUndo() {
    WatchdogV2.reset()
    // 启动预算内（bootAge < 90s）的存活子进程属冷启动，undo 不得打断它——这条保护不得因本次修复失守。
    var undoProbed = false
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEAD,
      now = 60_000L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 30_000L,
      restartDeadConfirmations = 1,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { undoProbed = true; true },
    )
    assertEquals("boot 预算内必须推迟破坏性恢复", WatchdogV2.TickAction.HOLD, plan.action)
    assertTrue(plan.logs.any { it.contains("boot window") })
    assertFalse("boot 预算内连 undo 闸门都不该被求值", undoProbed)
  }

  // ── 状态机分支 ────────────────────────────────────────────────

  @Test
  fun healthyAndDegradedLogStayIdleAndNeverRestart() {
    for (state in listOf(WatchdogV2.ProbeState.HEALTHY, WatchdogV2.ProbeState.DEGRADED_LOG)) {
      WatchdogV2.reset()
      repeat(20) {
        val plan = WatchdogV2.planTick(
          state = state,
          now = 0L,
          nextRestartAllowedAt = 0L,
          engineReady = true,
          engineProcessAlive = false,
          bootAgeMs = 999_999L,
          restartDeadConfirmations = 2,
          feedProbe = {},
          consumeMarkers = {},
          refreshWake = {},
          undoReady = { true },
        )
        assertEquals("state=" + state + " 必须恒为 IDLE（重启会打断活动 turn）", WatchdogV2.TickAction.IDLE, plan.action)
      }
      assertEquals("DEGRADED_LOG 不得积累半死计数", 0, WatchdogV2.consecutiveDegradedHttp)
    }
  }

  @Test
  fun degradedHttpLadderEscalatesToRestartOnTheSixthTick() {
    var firstRestartTick = 0
    val delays = ArrayList<Long>()
    for (tick in 1..WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      val plan = WatchdogV2.planTick(
        state = WatchdogV2.ProbeState.DEGRADED_HTTP,
        now = tick * 5_000L,
        nextRestartAllowedAt = 0L,
        engineReady = true,
        engineProcessAlive = false,
        bootAgeMs = 999_999L,
        restartDeadConfirmations = 2,
        feedProbe = {},
        consumeMarkers = {},
        refreshWake = {},
        undoReady = { false },
      )
      if (plan.action == WatchdogV2.TickAction.RESTART && firstRestartTick == 0) firstRestartTick = tick
      delays += WatchdogV2.nextDelayMs()
    }
    assertEquals("半死第 6 拍（30s）升级为受控重启", WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS, firstRestartTick)
    assertEquals(
      "升级前的退避必须随拍数递增（#210.2）",
      listOf(5_000L, 10_000L, 20_000L, 40_000L, 80_000L, 80_000L),
      delays,
    )
  }

  @Test
  fun deadSamplesObserveBeforeRestartAndRespectBootWindow() {
    val observing = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEAD,
      now = 0L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = false,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { false },
    )
    assertEquals(WatchdogV2.TickAction.HOLD, observing.action)
    assertTrue(observing.logs.any { it.contains("confirmed-dead sample 1/2") })

    // 启动冷却窗判定在「确认死亡观察窗」之后（与 0.13.8 原实现同序）：
    // 用 confirmations=1 直接进入冷却窗分支。
    WatchdogV2.reset()
    val bootWindow = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEAD,
      now = 10_000L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 1_000L,
      restartDeadConfirmations = 1,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { false },
    )
    assertEquals(WatchdogV2.TickAction.HOLD, bootWindow.action)
    assertTrue(bootWindow.logs.any { it.contains("boot window") })
  }

  @Test
  fun restartIsThrottledUntilTheBackoffWindowExpires() {
    WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEAD)
    WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEAD)
    WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEAD)
    val throttled = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEAD,
      now = 1_000L,
      nextRestartAllowedAt = 60_000L,
      engineReady = true,
      engineProcessAlive = false,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { false },
    )
    assertEquals(WatchdogV2.TickAction.HOLD, throttled.action)
    assertTrue(throttled.logs.any { it.contains("restart deferred") })
  }

  // ── FX-210.1：恢复入口先于探活早退 ──────────────────────────────

  @Test
  fun startupRecoveryRunsBeforeTheProbeEarlyExit() {
    val order = ArrayList<String>()
    val running = startupRecoverThenProbe(
      recover = { order += "recover" },
      probeRunning = { order += "probe"; true },
    )
    assertTrue("探活命中时调用方走早退分支", running)
    assertEquals("恢复入口必须先于探活（否则 .snapshot-transaction 判据永不消费）", listOf("recover", "probe"), order)
  }

  @Test
  fun startupRecoveryAlsoRunsWhenTheProbeThrowsOrMisses() {
    var recovered = false
    val running = startupRecoverThenProbe(
      recover = { recovered = true },
      probeRunning = { false },
    )
    assertFalse(running)
    assertTrue(recovered)
  }
}
