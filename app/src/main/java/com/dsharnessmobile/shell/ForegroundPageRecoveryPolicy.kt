package com.dsharnessmobile.shell

/** Activity page recovery only; engine task/service watchdogs do not use this policy. */
internal class ForegroundPageRecoveryPolicy {
  enum class Recovery { NONE, RELOAD, RECREATE, NATIVE_ERROR }

  @Volatile var foreground = false
    private set
  @Volatile var generation = 0L
    private set
  @Volatile var rendererGone = false
    private set
  private var pending = Recovery.NONE
  private var loadErrorRetryUsed = false
  /** 预算所属的引擎启动世代；null = 还没有世代信息（旧调用点）。 */
  private var loadErrorRetryEpoch: Long? = null
  var rendererRecreationAttempted = false
    private set

  fun restoreRecreationBudget(alreadyAttempted: Boolean) {
    rendererRecreationAttempted = alreadyAttempted
  }

  fun resume() {
    generation++
    foreground = true
  }

  fun pause() {
    foreground = false
    generation++
  }

  fun accepts(expectedGeneration: Long): Boolean = foreground && !rendererGone && generation == expectedGeneration

  /**
   * 一次失败的引擎导航在**每个引擎启动世代**里获得一次自动重试（issue #1345）。
   *
   * 旧实现是「整个 Activity 生命周期只有一次」：预算只被 [pageReady]（页面真的加载成功）或
   * 用户手动 reload 复位。冷启动引擎要 5–45s 才 listen，第一次自动重试很可能又撞 refused；
   * 那一次会再次置 enginePageFailed，而 pageReady() 永远不会跑 —— 预算**永久耗尽**，
   * 监控每 30s 转一圈都什么都不做，用户停在错误页上再也回不来。
   *
   * 现在把预算绑到**启动世代**：换代（下一次 startEngine）就重开一次。
   * 这不放松「一次」这条约束——同一世代仍然只试一次，只是不再跨世代黏住。
   */
  fun claimLoadErrorRetry(epoch: Long): Boolean {
    if (!foreground || rendererGone) return false
    if (loadErrorRetryEpoch != epoch) {
      loadErrorRetryEpoch = epoch
      loadErrorRetryUsed = false
    }
    if (loadErrorRetryUsed) return false
    loadErrorRetryUsed = true
    return true
  }

  /** 兼容旧调用点：不带世代 = 沿用当前世代。 */
  fun claimLoadErrorRetry(): Boolean = claimLoadErrorRetry(loadErrorRetryEpoch ?: 0L)

  /**
   * 本世代的一次预算是否已用完（**无副作用**，供 [EnginePageRetryPolicy] 做纯决策）。
   *
   * @param epoch 当前引擎启动世代。
   */
  fun retryBudgetSpent(epoch: Long): Boolean = loadErrorRetryEpoch == epoch && loadErrorRetryUsed

  fun pageReady() {
    if (!rendererGone) {
      loadErrorRetryUsed = false
      rendererRecreationAttempted = false
    }
  }

  fun userReloadRequested() {
    if (rendererGone) {
      pending = Recovery.RECREATE // Explicit native retry may recover after the automatic budget is spent.
    } else {
      loadErrorRetryUsed = false
      requestReload()
    }
  }

  fun requestReload() {
    if (pending != Recovery.RECREATE && !rendererGone) pending = Recovery.RELOAD
  }

  fun rendererLost() {
    if (rendererGone) return
    rendererGone = true
    pending = if (rendererRecreationAttempted) Recovery.NATIVE_ERROR else Recovery.RECREATE
    rendererRecreationAttempted = true
  }

  /** Multiple background failures coalesce; renderer recreation supersedes a stale reload. */
  fun takeRecovery(): Recovery {
    if (!foreground) return Recovery.NONE
    return pending.also { pending = Recovery.NONE }
  }
}
