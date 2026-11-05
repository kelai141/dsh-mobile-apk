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

  // ── M.3 F（issue #274 ①）：破坏性自愈的证据门 ──────────────────────────────────
  //
  // 真因：assessProbe 在 HTTP 超 2.5s 预算时给 DEGRADED_HTTP（注释自承实测出现过 3061ms），
  // 连续 6 拍（30s）即升级为受控重启 —— 而那条路径会**回滚用户配置 + 强杀活引擎**。
  // 长 turn / 慢磁盘足以误触发。一次慢响应不该有这种权限。
  //
  // 判据取**正向证据**（不是「缺少强证据」）：logSignature 常态为 null，拿它做前提会挡掉
  // 必需的阶梯行为。详见 planTick 内注释与 DEGRADED_SLOW_GRACE_TICKS。

  /** 强证据判据（纯函数）：只有这三类日志形态才算。 */
  @Test
  fun onlyStrongLogEvidenceJustifiesDestructiveRecovery() {
    assertTrue("EADDRINUSE = 我们自己起不来，等下去不会好", WatchdogV2.strongEvidenceForDestructiveRecovery("Error: listen EADDRINUSE :::3080"))
    assertTrue("插件树装配失败 = 引擎没起来，不自愈", WatchdogV2.strongEvidenceForDestructiveRecovery("plugin tree failed to load"))
    assertTrue("uncaught = 进程已不可信", WatchdogV2.strongEvidenceForDestructiveRecovery("UncaughtException: boom"))
    // 2026-10-26 评审：判据字面量与 logSignatureOf 同一份，不得放宽成「任何含 uncaught 的行」。
    assertFalse("普通日志里出现 uncaught 字样不得放行", WatchdogV2.strongEvidenceForDestructiveRecovery("plugin log: handled uncaught promise rejection"))
    // 反证：普通日志 / 空 / null 一律**不**构成破坏性动作的理由。
    assertFalse("普通日志不得放行", WatchdogV2.strongEvidenceForDestructiveRecovery("turn started"))
    assertFalse("空串不得放行", WatchdogV2.strongEvidenceForDestructiveRecovery(""))
    assertFalse("null 不得放行", WatchdogV2.strongEvidenceForDestructiveRecovery(null))
    assertFalse("只是慢（无日志证据）不得放行", WatchdogV2.strongEvidenceForDestructiveRecovery("dsh web: listening on 3080"))
  }

  /**
   * 纯函数（2026-10-26 评审）：证据只认**上一次 HEALTHY 之后**的字节。
   *
   * 真因：同一代日志可以先出现 EADDRINUSE、随后引擎换临时端口重试成功转 HEALTHY（spawn 前
   * 预探活只有 300ms 快照）；那句 EADDRINUSE 会留在 4KB 窗口里。若此后一次长 turn 让探活
   * 超时，陈旧证据会把「解除慢探活否决」从 90 秒提前到 30 秒，强杀一个健康但忙的引擎。
   */
  @Test
  fun evidenceWindowStartsAfterTheLastHealthyPoint() {
    val cap = 4096
    assertEquals("没有健康点：常规尾部窗口", 1000L, WatchdogV2.tailWindowStart(5096L, cap, 0L))
    assertEquals("健康点之后的字节才作数", 5000L, WatchdogV2.tailWindowStart(6000L, cap, 5000L))
    assertEquals("健康点就是文件末尾：没有新字节，窗口为空", 6000L, WatchdogV2.tailWindowStart(6000L, cap, 6000L))
    assertEquals("水位超过当前长度（轮转/重建）：整份都算新的", 0L, WatchdogV2.tailWindowStart(800L, cap, 5000L))
    assertEquals("空文件：从 0 读", 0L, WatchdogV2.tailWindowStart(0L, cap, 1234L))
  }

  /** 纯函数：只有 HEALTHY 抬水位；文件变短（轮转/重建）一律跟到新长度。 */
  @Test
  fun healthyMarkAdvancesOnlyOnHealthyAndFollowsRotation() {
    val healthy = WatchdogV2.ProbeState.HEALTHY
    val degraded = WatchdogV2.ProbeState.DEGRADED_HTTP
    assertEquals("健康拍抬到当前长度", 6000L, WatchdogV2.nextHealthyLogMark(healthy, 6000L, 1000L))
    assertEquals("非健康拍不动水位", 1000L, WatchdogV2.nextHealthyLogMark(degraded, 6000L, 1000L))
    assertEquals("日志变短（轮转/重建）跟到新长度", 800L, WatchdogV2.nextHealthyLogMark(degraded, 800L, 5000L))
  }

  @Test
  fun foreignPortHolderDisqualifiesDestructiveRecovery() {
    assertTrue("端口确认非本进程持有 ⇒ 重启我们毫无意义", WatchdogV2.portOwnedByOtherProcess(false))
    assertFalse("端口归我们 ⇒ 不因这条否决", WatchdogV2.portOwnedByOtherProcess(true))
    assertFalse("未知（拿不到归属）保守按「可能是我们」处理，不因测量失败放宽破坏性动作", WatchdogV2.portOwnedByOtherProcess(null))
  }



  /**
   * 反证（F，核心）：**只是慢**（探活超时）时，破坏性动作必须被压住 —— 这是 #274 的靶子。
   * 前置：进程存活 + 阶梯到时 + slowProbe。
   */
  @Test
  fun merelySlowProbeWithholdsDestructiveRecovery() {
    repeat(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
    }
    var undoAsked = false
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEGRADED_HTTP,
      now = 999_999L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true, // 进程还活着：强杀它就是破坏性动作
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      slowProbe = true, // 本次探活只是超时（引擎在忙 / 磁盘慢）
      portOwnedByApp = true,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { undoAsked = true; true },
    )
    assertEquals(
      "只是慢（超时）时必须 HOLD：不得强杀活引擎、不得回滚用户配置",
      WatchdogV2.TickAction.HOLD,
      plan.action,
    )
    assertFalse("连 undo 都不该问（undo 会回滚用户配置）", undoAsked)
    assertTrue("必须留可诊断叙述: " + plan.logs, plan.logs.any { it.contains("slow engine") })
  }

  /**
   * 接线（F，2026-10-25 审计）：EADDRINUSE 强证据必须经**原文尾**喂入——
   * 旧接线把 logSignature（三态折叠：plugin-tree/uncaught/null）喂给了
   * strongEvidenceForDestructiveRecovery，EADDRINUSE 连签名都不产生，三个证据分支死了两个，
   * 仅 uncaught 侥幸存活。纯函数用例（onlyStrongLogEvidenceJustifiesDestructiveRecovery）
   * 直接喂原文全绿，掩盖了接线错误——本用例锁 planTick 层。
   */
  @Test
  fun eaddrinuseTailReleasesTheSlowProbeHoldAtPlanTickLevel() {
    repeat(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
    }
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEGRADED_HTTP,
      now = 999_999L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      slowProbe = true, // 与 merelySlowProbe 用例同前置：只是慢
      portOwnedByApp = true,
      logSignature = null, // EADDRINUSE 不产生签名——这正是旧接线饿死的形态
      logTail = "Error: listen EADDRINUSE :::3080",
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { false }, // 生产口径（EngineService.kt: undoReady 恒 false）
    )
    // 生产面无自动 undo，落到的是 RESTART 与 force=true 这条分支——断言必须断到这里，
    // 否则只断言「不是 HOLD」会被 UNDO 蒙混过关（2026-10-26 评审）。
    assertEquals(
      "EADDRINUSE 原文在场时必须直接走受控重启（自己起不来，等下去不会好）",
      WatchdogV2.TickAction.RESTART,
      plan.action,
    )
    assertTrue("托管子进程仍在场 ⇒ 必须 force 换进程", plan.force)
  }

  /** 接线（F，同上）：插件树装配失败的原文尾同样必须解除慢探活 HOLD。 */
  @Test
  fun pluginTreeTailReleasesTheSlowProbeHoldAtPlanTickLevel() {
    repeat(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
    }
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEGRADED_HTTP,
      now = 999_999L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      slowProbe = true,
      portOwnedByApp = true,
      logSignature = "plugin-tree",
      logTail = "Error: client plugin tree failed to load",
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { false },
    )
    assertEquals(
      "插件树失败原文在场时必须直接走受控重启（引擎没起来且不会自愈）",
      WatchdogV2.TickAction.RESTART,
      plan.action,
    )
    assertTrue("托管子进程仍在场 ⇒ 必须 force 换进程", plan.force)
  }

  /** 反证（F）：端口**由他进程持有**时必须 HOLD —— 重启我们不解决问题。 */
  @Test
  fun foreignPortHolderWithholdsDestructiveRecovery() {
    repeat(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
    }
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEGRADED_HTTP,
      now = 999_999L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      slowProbe = false,
      portOwnedByApp = false, // 端口是别人的
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { true },
    )
    assertEquals("端口非本进程持有时不得做破坏性动作", WatchdogV2.TickAction.HOLD, plan.action)
    assertTrue("必须点名真因: " + plan.logs, plan.logs.any { it.contains("another process") })
  }

  /**
   * 正证（F，**防死局**）：慢的否决是**有界宽限**，不是永久封锁。
   * 慢若持续到宽限拍数（3 倍阶梯）仍无改善，必须放行破坏性动作 ——
   * 否则真卡死的引擎永远救不回来（那正是 0.14.1 锁存盲区回归要防的死局）。
   */
  @Test
  fun persistentSlownessIsEventuallyTreatedAsStuck() {
    repeat(WatchdogV2.DEGRADED_SLOW_GRACE_TICKS) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
    }
    assertTrue(
      "前置：已到宽限上界",
      WatchdogV2.consecutiveDegradedHttp >= WatchdogV2.DEGRADED_SLOW_GRACE_TICKS,
    )
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEGRADED_HTTP,
      now = 999_999L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      slowProbe = true, // 一直超时
      portOwnedByApp = true,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { true },
    )
    assertEquals(
      "宽限用尽后必须放行恢复动作（否则留下「引擎卡死且永不重试」的死局）",
      WatchdogV2.TickAction.UNDO,
      plan.action,
    )
  }

  /** 正证（F）：error=refused（端口没开）**不算慢** —— 那是真的死，必须能走恢复流程。 */
  @Test
  fun refusedProbeIsNotSlowAndStillRecovers() {
    repeat(WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      WatchdogV2.recordProbe(WatchdogV2.ProbeState.DEGRADED_HTTP)
    }
    val plan = WatchdogV2.planTick(
      state = WatchdogV2.ProbeState.DEGRADED_HTTP,
      now = 999_999L,
      nextRestartAllowedAt = 0L,
      engineReady = true,
      engineProcessAlive = true,
      bootAgeMs = 999_999L,
      restartDeadConfirmations = 2,
      slowProbe = false, // refused != slow
      portOwnedByApp = true,
      feedProbe = {},
      consumeMarkers = {},
      refreshWake = {},
      undoReady = { true },
    )
    assertEquals("端口没开 = 真的死，不得被「慢」这条挡住", WatchdogV2.TickAction.UNDO, plan.action)
  }

  /**
   * 正证（F）：第 6 拍的既定语义仍在（既有回归的显式复述，防我改坏）。
   * 用**未知**端口归属（= 生产默认口径）与已死子进程，避开与「端口确属他人」那条的正交情形。
   */
  @Test
  fun sixthTickStillRestartsWhenTheChildIsAlreadyGoneAndOwnershipIsUnknown() {
    // 不预热计数：阶梯由 planTick 自己的前置段逐拍累积（与既有回归同构），
    // 否则第 1 拍就已「到时」，断言会变成在验另一件事。
    var firstRestartTick = 0
    for (tick in 1..WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS) {
      val plan = WatchdogV2.planTick(
        state = WatchdogV2.ProbeState.DEGRADED_HTTP,
        now = tick * 5_000L,
        nextRestartAllowedAt = 0L,
        engineReady = true,
        engineProcessAlive = false, // 没有活进程可杀 ⇒ 不具破坏性，不该被拦
        bootAgeMs = 999_999L,
        restartDeadConfirmations = 2,
        slowProbe = true, // 即便探活超时
        portOwnedByApp = null, // 未知归属：不否决（这是生产默认口径）
        feedProbe = {},
        consumeMarkers = {},
        refreshWake = {},
        undoReady = { false },
      )
      if (plan.action == WatchdogV2.TickAction.RESTART && firstRestartTick == 0) firstRestartTick = tick
    }
    assertEquals(
      "进程已不在场时不具破坏性：第 6 拍 RESTART 的既定语义必须仍然成立",
      WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS,
      firstRestartTick,
    )
  }
}
