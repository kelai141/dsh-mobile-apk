package com.dsharnessmobile.shell

import org.json.JSONObject

/**
 * `browserJs` 回执的世代判据（issue #1611）。
 *
 * 缺陷形态：`snapshotOp` / `textOp` / `measurePage` / `resolveRef` 都比对 `tab.generation`，
 * 只有 `browserJsOp` 拿到 `raw` 后只查 `targetProblem`、**不查世代**。触发路径是表达式自身
 * 触发导航，或页面 meta-refresh / 定时跳转落在 8 秒窗口内：旧文档的返回值以**新文档**的身份
 * 交付——`pageReply` 现读 `url/loadState/pageGeneration`，于是回执里 `pageGeneration` 是 N+1
 * 而 `value` 是第 N 代的产物。模型据此把上一页的读数当成当前页的事实（tier-2 反而安全，
 * `PendingJsDispatch` 会按世代丢弃）。
 *
 * 为什么把**整份回执**放在这里而不是只放一个布尔：模型看到的只有这份 JSON。判据留一半在
 * 调用方（`BrowserHost`）里，「拒绝分支长什么样」就没有任何单测能驱动；放进来之后，
 * `BrowserJsReplyGuardTest` 断言的就是**模型真正收到的东西**（ok / reason / pageGeneration）。
 */
internal object BrowserJsReplyGuard {

  /** 与 snapshotOp / textOp 逐字同形的拒绝码（模型面已认这个字符串）。 */
  const val STALE_PAGE_GENERATION = "stale-page-generation"

  /**
   * 结算一次 `evaluateOnTab` 回调。
   *
   * @param problem `targetProblem` 的结论（页已关闭/换了视图）；非空时优先，因为它是更具体的
   *   原因——模型据此知道「这个 tab 没了」，而不是「重读一次就好」。
   * @param startedGeneration 发起求值前读到的 `tab.generation`。
   * @param currentGeneration 回调到达时读到的 `tab.generation`。
   * @param value 页面返回的原始值（仅在世代一致时才会被交付）。
   * @param pageReply 成功回执的骨架（调用方给的 `pageReply(target)`，含 url/loadState 等）。
   * @param reject 拒绝回执的构造器（调用方给的 `targetFailure`）。
   * @returns 交付给模型的回执 JSON。
   */
  fun settle(
    problem: String?,
    startedGeneration: Long,
    currentGeneration: Long,
    value: String,
    pageReply: () -> JSONObject,
    reject: (String) -> JSONObject,
  ): JSONObject {
    if (problem != null) return reject(problem)
    if (startedGeneration != currentGeneration) return reject(STALE_PAGE_GENERATION)
    return pageReply().put("ok", true).put("value", value)
  }
}
