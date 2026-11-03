package com.dsharnessmobile.shell

import com.dsharnessmobile.shell.EnginePageRetryPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * issue #1345：引擎页「要不要自动再试」的三态决策表。
 *
 * 缺陷本体在**优先级**上，不在单个条件上：旧实现把「预算用完」和「现在还不到时候」混成同一个 false，
 * 于是「第一次自动重试也失败」之后，监控每 30s 转一圈都静默什么都不做，用户停在
 * ERR_CONNECTION_REFUSED 上再也回不来。所以这里逐条钉住「谁先判」。
 */
class EnginePageRetryPolicyTest {
  private fun decide(
    pageFailed: Boolean = true,
    httpAnswered: Boolean = true,
    foreground: Boolean = true,
    rendererGone: Boolean = false,
    userClosedEngine: Boolean = false,
    budgetSpentForEpoch: Boolean = false,
    sinceLastAttemptMs: Long = 60_000L,
    minIntervalMs: Long = 30_000L,
  ): Decision = EnginePageRetryPolicy.decide(
    pageFailed, httpAnswered, foreground, rendererGone, userClosedEngine,
    budgetSpentForEpoch, sinceLastAttemptMs, minIntervalMs,
  )

  @Test fun allConditionsMetAndBudgetAvailableRetries() {
    assertEquals(Decision.RETRY, decide())
  }

  @Test fun engineHasNotAnsweredYetWaitsInsteadOfBurningTheBudget() {
    // 引擎还没应答就 reload，只会再吃一次 refused 并把本世代预算烧掉——必须等。
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(httpAnswered = false))
  }

  @Test fun nothingToRecoverWaits() {
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(pageFailed = false))
  }

  @Test fun backgroundOrDeadRendererOrUserClosedEngineNeverAutoReloads() {
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(foreground = false))
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(rendererGone = true))
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(userClosedEngine = true))
  }

  @Test fun tooSoonWaitsRegardlessOfBudget() {
    // 间隔判定优先于预算：还没到下一次尝试时间时，不该报「这代放弃了」（那是两回事）。
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(sinceLastAttemptMs = 1_000L))
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(sinceLastAttemptMs = 1_000L, budgetSpentForEpoch = true))
  }

  @Test fun budgetSpentInThisEpochReportsGiveUpNotWait() {
    // 这一态是给日志/诊断用的：能区分「等条件」与「这代试过了」。
    assertEquals(Decision.GIVE_UP_BUDGET_SPENT, decide(budgetSpentForEpoch = true))
  }

  @Test fun noPageToRecoverOutranksSpentBudget() {
    // 没有失败页时，即便预算用完也不该报「放弃」——无事可做不是放弃。
    assertEquals(Decision.WAIT_ENGINE_NOT_READY, decide(pageFailed = false, budgetSpentForEpoch = true))
  }
}
