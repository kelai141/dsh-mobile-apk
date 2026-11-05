package com.dsharnessmobile.shell

/**
 * 内置浏览器「该复用哪个标签」的判定（issue #1318）。
 *
 * 缺陷形态：`navigateOp` 只要调用方传 `newTab: true` 就新建，于是模型在一次任务里反复打开
 * 同一个地址会把侧边栏灌满（每个标签都是一个渲染进程，平板上内存与算力开销陡增）。
 * `MAX_TABS = 8` 只是最后一道闸——到了上限就 `tab-limit` 失败，体验同样是坏的。
 *
 * 这里把「复用 vs 新建」抽成纯函数：判定只依赖（URL、已有标签的 URL、调用方意图），
 * 不碰 WebView，所以能在 JVM 单测里把两个方向都钉住。
 */
internal object BrowserTabReuse {

  /**
   * 选一个可复用的标签。
   *
   * @param wantsNewTab 调用方是否显式要求新标签（`newTab: true`）。
   * @param requestedTabId 调用方指定的标签 id；非空时**不参与复用**（那是明确的「导航到这个标签」）。
   * @param targetUrl 本次要打开的 URL（已按 workspace 口径规范化）。
   * @param existingTabs 现有标签的 (id, 规范化后的 URL)，按创建顺序。
   * @returns 可复用的标签 id；`null` 表示应当新建/按 id 导航。
   */
  fun reusableTabId(
    wantsNewTab: Boolean,
    requestedTabId: String?,
    targetUrl: String?,
    existingTabs: List<Pair<String, String>>,
  ): String? {
    // 只有「明确要求新开、且没点名某个标签」时才考虑复用；
    // 点名了标签就按点名走（意图优先于去重），不点名也不要求新开则走默认标签。
    if (!wantsNewTab || requestedTabId != null) return null
    if (targetUrl == null) return null
    return existingTabs.firstOrNull { it.second == targetUrl }?.first
  }
}