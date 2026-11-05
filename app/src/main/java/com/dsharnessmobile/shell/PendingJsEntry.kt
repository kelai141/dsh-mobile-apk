package com.dsharnessmobile.shell

/**
 * tier-2（隔离渲染进程）`evaluateJs` 的在途回执条目（issue #1363）。
 *
 * ## 缺陷形态
 *
 * 回执只按 `seq` 取回调，**不看 tab 死活、也不看世代**：
 * ```
 * main.post { pendingJs.remove(seq)?.invoke(result.optString("value")) }
 * ```
 * 而 `closeTabOp` 已经 `generation.incrementAndGet()` + `view.destroy()` + `tabs.remove`。
 * 在途 `seq` 仍在表里，于是关闭之后到达的回执照旧把 url / title / scrollY 写回 ——
 * 模型侧 `browser_snapshot` 还能读到那个「幽灵页」，并据此继续操作。
 *
 * 全文件唯一带世代守卫的是 `:1322`（另一条路径），JS 回执这条路没有。
 *
 * ## 修法
 *
 * 入队时记 `(tabId, generation)`；派发前比对当前 tab 的世代，不同代**丢弃**（不出表后调用回调）。
 * 判据落在下面这个纯函数上，JVM 单测可以直接钉住「旧世代被丢弃」。
 *
 * @property tabId 发起求值时所在的 tab。
 * @property generation 发起求值时该 tab 的世代（`Tab.generation.get()`）。
 * @property callback 回执回调（在主线程派发）。
 */
internal data class PendingJsEntry(
  val tabId: String,
  val generation: Long,
  val callback: (String?) -> Unit,
)

/**
 * 回执派发决策（纯函数）。
 *
 * 刻意分成三态而不是一个 bool：`DISCARD_TAB_GONE`（tab 已关）与
 * `DISCARD_STALE_GENERATION`（tab 还在但换过代）在排障时含义完全不同——
 * 前者是正常的关闭竞态，后者说明有人在旧页面上继续操作。
 */
internal object PendingJsDispatch {
  enum class Decision {
    DELIVER,
    DISCARD_TAB_GONE,
    DISCARD_STALE_GENERATION,
  }

  /**
   * @param entry 入队时记录的条目。
   * @param replyTabId 回执到达时上报的 tabId（渲染侧自己报的，可能与条目不一致）。
   * @param liveGeneration 该 tab **当前**的世代；`null` = tab 已不在。
   */
  fun decide(entry: PendingJsEntry, replyTabId: String, liveGeneration: Long?): Decision {
    if (liveGeneration == null) return Decision.DISCARD_TAB_GONE
    if (replyTabId != entry.tabId) return Decision.DISCARD_TAB_GONE
    if (liveGeneration != entry.generation) return Decision.DISCARD_STALE_GENERATION
    return Decision.DELIVER
  }
}
