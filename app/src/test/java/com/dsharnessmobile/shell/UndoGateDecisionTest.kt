package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * UndoGate 闸门纯决策回归（0.14.1）。
 *
 * 为什么需要本文件：本闸门是「自动 undo 到底会不会跑」的**唯一判据**，而它原先整体依赖
 * Context + 文件系统，导致这段决定「是否自救」的逻辑在全仓**零测试覆盖**——`planTick` 的熔断
 * 锁存盲区正是同类「恢复判据无防线」的产物（一个不会失败的判断不是防线）。
 * 0.14.1 把四态判定抽成 [UndoGate.decide]，此处直接断言，不依赖 Android 运行期。
 *
 * 覆盖五态：IDLE / SUPPRESS / ARM / WAIT / EXECUTE，以及两阶段 arm → watch 的边界值。
 */
class UndoGateDecisionTest {

  private val t0 = 1_000_000L

  @Test
  fun belowTriggerThresholdStaysIdle() {
    // 阈值是 6：5 拍（半死阶梯真实会先到的一档）必须不动作，避免误伤正常慢启动。
    assertEquals(
      UndoGate.GateDecision.IDLE,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES - 1,
        nowMs = t0,
        lastUndoAtMs = null,
        armedAtMs = null,
      ),
    )
  }

  @Test
  fun firstConfirmedDeathArmsInsteadOfExecuting() {
    // 首次达阈值只起观察窗：留给引擎自愈的最后机会（正常慢启动上限 45s+）。
    assertEquals(
      UndoGate.GateDecision.ARM,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES,
        nowMs = t0,
        lastUndoAtMs = null,
        armedAtMs = null,
      ),
    )
  }

  @Test
  fun insideTheWatchWindowItWaits() {
    assertEquals(
      UndoGate.GateDecision.WAIT,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES + 4,
        nowMs = t0 + UndoGate.WATCH_MS - 1,
        lastUndoAtMs = null,
        armedAtMs = t0,
      ),
    )
  }

  @Test
  fun exactlyAtTheWatchWindowBoundaryItExecutes() {
    // 边界值（WATCH_MS 整）：条件为 `now - armedAt < WATCH_MS` 才 WAIT，故整点即放行。
    assertEquals(
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES + 4,
        nowMs = t0 + UndoGate.WATCH_MS,
        lastUndoAtMs = null,
        armedAtMs = t0,
      ),
    )
  }

  @Test
  fun afterTheWatchWindowItExecutes() {
    assertEquals(
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES + 10,
        nowMs = t0 + UndoGate.WATCH_MS + 1,
        lastUndoAtMs = null,
        armedAtMs = t0,
      ),
    )
  }

  @Test
  fun insideTheRetryWindowItIsSuppressedEvenWithAStaleArm() {
    // 防循环：一次成功执行后的 30 分钟窗口内不得再自动执行（无论观察窗是否走完）。
    assertEquals(
      UndoGate.GateDecision.SUPPRESS,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES + 10,
        nowMs = t0 + UndoGate.RETRY_WINDOW_MS - 1,
        lastUndoAtMs = t0,
        armedAtMs = t0 - UndoGate.WATCH_MS,
      ),
    )
  }

  @Test
  fun exactlyAtTheRetryWindowBoundaryItIsNoLongerSuppressed() {
    assertEquals(
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES,
        nowMs = t0 + UndoGate.RETRY_WINDOW_MS,
        lastUndoAtMs = t0,
        armedAtMs = t0 - UndoGate.WATCH_MS,
      ),
    )
  }

  @Test
  fun retryWindowOutranksArming() {
    // 抑制期优先于起窗：不得靠"重新 arm"绕过防循环窗口。
    assertEquals(
      UndoGate.GateDecision.SUPPRESS,
      UndoGate.decide(
        consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES,
        nowMs = t0 + 1_000L,
        lastUndoAtMs = t0,
        armedAtMs = null,
      ),
    )
  }

  @Test
  fun idleOutranksEveryLaterStage() {
    // 未达阈值时，即使残留 arm 文件也不得误触发（旧实现会读 arm 文件后走 WAIT/EXECUTE 分支）。
    assertEquals(
      UndoGate.GateDecision.IDLE,
      UndoGate.decide(
        consecutiveFailures = 0,
        nowMs = t0 + UndoGate.WATCH_MS + UndoGate.RETRY_WINDOW_MS,
        lastUndoAtMs = null,
        armedAtMs = t0,
      ),
    )
  }

  @Test
  fun twoPhaseSequenceArmsThenExecutes() {
    // 端到端两阶段语义（与 onProbeFailure 的落盘路径同序）：ARM → WAIT → EXECUTE。
    val threshold = UndoGate.TRIGGER_CONSEC_FAILURES
    assertEquals(UndoGate.GateDecision.ARM, UndoGate.decide(threshold, t0, null, null))
    val armedAt = t0
    assertEquals(UndoGate.GateDecision.WAIT, UndoGate.decide(threshold, t0 + 5_000L, null, armedAt))
    assertEquals(UndoGate.GateDecision.EXECUTE, UndoGate.decide(threshold, t0 + UndoGate.WATCH_MS, null, armedAt))
  }

  @Test
  fun watchWindowCannotBeRestartedByRepeatedArming() {
    // 回归：观察窗起点由 arm 文件承载；重复调用不得把窗口无限顺延（否则永不 EXECUTE）。
    // 边界口径与实现一致：`now - armedAt < WATCH_MS` 才 WAIT，故「恰好 WATCH_MS」已 EXECUTE。
    val armedAt = t0
    val threshold = UndoGate.TRIGGER_CONSEC_FAILURES
    // 窗口内（未到点）：仍是 WAIT。循环上界必须停在窗口**内**——曾误写成 repeat(10) 推进到
    // +50s，第 3 次(+15s) 就已越界，断言必然不成立（测试写错，非实现错）。
    for (k in 1..2) { // +5s / +10s，均 < WATCH_MS(15s)
      assertEquals(
        "第 $k 次窗口内调用必须仍为 WAIT（窗口未到点）",
        UndoGate.GateDecision.WAIT,
        UndoGate.decide(threshold, armedAt + k * 5_000L, null, armedAt),
      )
    }
    // 窗口内**反复**观察同一个 armedAt：不得把窗口重置/顺延（幂等，仍是 WAIT）。
    repeat(3) {
      assertEquals(
        "同一 armedAt 被反复观察不得改变窗口语义",
        UndoGate.GateDecision.WAIT,
        UndoGate.decide(threshold, armedAt + UndoGate.WATCH_MS - 1, null, armedAt),
      )
    }
    // 边界：恰好到 WATCH_MS → EXECUTE（证明窗口没被无限顺延）。
    assertEquals(
      "恰好到 WATCH_MS 必须 EXECUTE，不得因反复调用永远 WAIT",
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(threshold, armedAt + UndoGate.WATCH_MS, null, armedAt),
    )
    // 再往后仍然 EXECUTE（窗口不会被重置回 WAIT）。
    assertEquals(
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(threshold, armedAt + 10 * UndoGate.WATCH_MS, null, armedAt),
    )
  }
}
