package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundPageRecoveryPolicyTest {
  @Test fun pausedCallbacksStayStaleAfterAQuickResume() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    val generation = policy.generation
    assertTrue(policy.accepts(generation))
    policy.pause()
    assertFalse(policy.accepts(generation))
    policy.resume()
    assertFalse(policy.accepts(generation))
    assertTrue(policy.accepts(policy.generation))
  }

  @Test fun repeatedBackgroundReloadRequestsProduceOneQuietResumeAction() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    policy.pause()
    repeat(10) { policy.requestReload() }
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
    policy.resume()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RELOAD, policy.takeRecovery())
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
  }

  @Test fun backgroundRendererEvictionDefersAndSupersedesQueuedReloads() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    val generation = policy.generation
    policy.pause()
    policy.requestReload()
    policy.rendererLost()
    repeat(10) { policy.requestReload() }
    assertTrue(policy.rendererGone)
    assertFalse(policy.accepts(generation))
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
    policy.resume()
    assertFalse(policy.accepts(policy.generation))
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RECREATE, policy.takeRecovery())
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
  }

  @Test fun foregroundRendererLossRecreatesOnlyOnce() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    policy.rendererLost()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RECREATE, policy.takeRecovery())
    policy.requestReload()
    policy.rendererLost() // Duplicate callbacks cannot arm a second recreation.
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
  }

  @Test fun automaticLoadErrorRetryIsBoundedAcrossPauseResumeUntilRealPageReadiness() {
    val policy = ForegroundPageRecoveryPolicy()
    assertFalse(policy.claimLoadErrorRetry())
    policy.resume()
    assertTrue(policy.claimLoadErrorRetry())
    repeat(10) { assertFalse(policy.claimLoadErrorRetry()) }
    policy.pause()
    policy.resume()
    assertFalse(policy.claimLoadErrorRetry())
    policy.pageReady()
    assertTrue(policy.claimLoadErrorRetry())
  }

  @Test fun readinessFromADeadRendererCannotRearmNavigation() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    policy.rendererLost()
    policy.pageReady()
    assertFalse(policy.claimLoadErrorRetry())
    policy.requestReload()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RECREATE, policy.takeRecovery())
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
  }

  @Test fun explicitBackgroundRefreshDefersWithoutSpendingTheForegroundRetry() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    assertTrue(policy.claimLoadErrorRetry())
    policy.pause()
    policy.userReloadRequested()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
    policy.resume()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RELOAD, policy.takeRecovery())
    assertTrue(policy.claimLoadErrorRetry())
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
  }

  @Test fun repeatedCrashesBeforeReadinessStopAtTheNativeGuideAcrossActivityRecreation() {
    val first = ForegroundPageRecoveryPolicy()
    first.resume()
    first.rendererLost()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RECREATE, first.takeRecovery())
    val recreated = ForegroundPageRecoveryPolicy()
    recreated.restoreRecreationBudget(first.rendererRecreationAttempted)
    recreated.resume()
    recreated.rendererLost()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NATIVE_ERROR, recreated.takeRecovery())
    recreated.requestReload()
    recreated.rendererLost()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, recreated.takeRecovery())
    recreated.userReloadRequested()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RECREATE, recreated.takeRecovery())
  }

  @Test fun successfulRecreatedPageAllowsALaterIndependentRendererEvictionToRecover() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.restoreRecreationBudget(true)
    policy.resume()
    policy.pageReady()
    assertFalse(policy.rendererRecreationAttempted)
    policy.pause()
    policy.rendererLost()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.NONE, policy.takeRecovery())
    policy.resume()
    assertEquals(ForegroundPageRecoveryPolicy.Recovery.RECREATE, policy.takeRecovery())
  }
  // ── issue #1345：预算按**引擎启动世代**计，不再跨世代黏住 ────────────────────

  @Test fun loadErrorBudgetIsSpentPerEpochNotPerActivityLifetime() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    // 第 1 世代：一次
    assertTrue(policy.claimLoadErrorRetry(1L))
    assertFalse(policy.claimLoadErrorRetry(1L))
    // 同世代反复调仍然是 false —— 「一次」这条约束没有被放松
    repeat(10) { assertFalse(policy.claimLoadErrorRetry(1L)) }
    // 换代（引擎重启）后重开一次。这正是旧实现缺的复位点：冷启动第一次重试很可能
    // 又撞 refused，那之后预算永久耗尽，用户停在错误页上再也回不来。
    assertTrue(policy.claimLoadErrorRetry(2L))
    assertFalse(policy.claimLoadErrorRetry(2L))
    assertTrue(policy.claimLoadErrorRetry(3L))
  }

  @Test fun budgetSpentReportsPerEpochWithoutConsuming() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    assertFalse(policy.retryBudgetSpent(1L))
    assertTrue(policy.claimLoadErrorRetry(1L))
    assertTrue(policy.retryBudgetSpent(1L))
    // 换代后本世代不欠账
    assertFalse(policy.retryBudgetSpent(2L))
    // 查询本身不得消耗预算
    assertFalse(policy.retryBudgetSpent(2L))
    assertTrue(policy.claimLoadErrorRetry(2L))
  }

  @Test fun pausedPolicyStillRefusesEvenWithAFreshEpoch() {
    val policy = ForegroundPageRecoveryPolicy()
    policy.resume()
    assertTrue(policy.claimLoadErrorRetry(1L))
    policy.pause()
    assertFalse(policy.claimLoadErrorRetry(2L))
  }

}
