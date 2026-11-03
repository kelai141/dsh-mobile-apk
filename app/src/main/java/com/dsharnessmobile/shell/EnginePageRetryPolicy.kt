package com.dsharnessmobile.shell

/**
 * 引擎页「加载失败后要不要自动再试」的**纯决策**（issue #1345）。
 *
 * ## 缺陷形态（issue #1345 实测反馈：重启后停在 ERR_CONNECTION_REFUSED，永不恢复）
 *
 * 自愈路径存在，但被三层条件串起来，任何一层没满足就**静默不重试**：
 *
 * 1. 只在监控循环里触发（`EngineStartFlow` 的 tick）：要求 `webViewReady && guideViewReady && !userClosedEngine`；
 * 2. 只在 `httpAlive` 时才算（仅 TCP 端口通不够）；
 * 3. `retryFailedEnginePage()` 里还要 `pageRecovery.claimLoadErrorRetry()` —— 而那是**一次性预算**，
 *    只被 `pageReady()`（页面真的加载成功）或用户手动 reload 复位。
 *
 * 第 3 条就是缺的**复位点**：冷启动引擎要 5–45s 才 listen，第一次自动重试很可能又撞上 refused；
 * 这次失败会再次置 `enginePageFailed`，而 `pageReady()` 永远不会跑 —— 于是**这一次之后预算永久耗尽**，
 * 监控每 30s 转一圈都什么都不做，用户就停死在错误页上。引擎后代（新启动世代）本该允许再试，
 * 旧实现没有把预算绑到世代上。
 *
 * ## 三态
 *
 * - [Decision.RETRY]：条件齐备且本世代预算未用完 —— 现在就重载；
 * - [Decision.WAIT_ENGINE_NOT_READY]：**不重试**，因为现在重试也会失败（引擎未应答 / 页面还没失败 /
 *   不在前台 / 渲染器已失 / 距上次尝试太近）。这是「等」，不是「放弃」；
 * - [Decision.GIVE_UP_BUDGET_SPENT]：本世代的一次预算已用完。**换代（新启动世代）才会重开**——
 *   这一态刻意与上一态分开：把「等一等」和「这代不试了」混成一个 bool 是这条缺陷的成因。
 */
internal object EnginePageRetryPolicy {
  enum class Decision {
    RETRY,
    WAIT_ENGINE_NOT_READY,
    GIVE_UP_BUDGET_SPENT,
  }

  /**
   * @param pageFailed 当前是否停在引擎错误页（`enginePageFailed`）。
   * @param httpAnswered 本 tick 是否拿到了真实 HTTP 应答（仅端口通不算）。
   * @param foreground App 是否在前台（`pageRecovery.foreground`）。
   * @param rendererGone 渲染进程是否已失（`pageRecovery.rendererGone`）。
   * @param userClosedEngine 用户是否主动关过引擎 —— 关过就不再自动拉页面。
   * @param budgetSpentForEpoch 本启动世代的一次预算是否已用完。
   * @param sinceLastAttemptMs 距上次重试的毫秒数。
   * @param minIntervalMs 两次重试的最小间隔。
   */
  fun decide(
    pageFailed: Boolean,
    httpAnswered: Boolean,
    foreground: Boolean,
    rendererGone: Boolean,
    userClosedEngine: Boolean,
    budgetSpentForEpoch: Boolean,
    sinceLastAttemptMs: Long,
    minIntervalMs: Long,
  ): Decision {
    // 没有需要恢复的页面：无事可做，按「等」处理（不是放弃）。
    if (!pageFailed) return Decision.WAIT_ENGINE_NOT_READY
    // 引擎还没应答：现在 reload 只会再吃一次 refused，把预算白白烧掉。
    if (!httpAnswered) return Decision.WAIT_ENGINE_NOT_READY
    // 不在前台 / 渲染器已失 / 用户主动关过：不允许自动拉页面。
    if (!foreground || rendererGone || userClosedEngine) return Decision.WAIT_ENGINE_NOT_READY
    // 太频繁：等下一个 tick。
    if (sinceLastAttemptMs < minIntervalMs) return Decision.WAIT_ENGINE_NOT_READY
    // 走到这里条件齐备；只剩预算。
    if (budgetSpentForEpoch) return Decision.GIVE_UP_BUDGET_SPENT
    return Decision.RETRY
  }
}
