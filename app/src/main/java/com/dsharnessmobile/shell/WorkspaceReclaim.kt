package com.dsharnessmobile.shell

/**
 * 隔离浏览器工作台的**回收与淘汰计划**（issue #1364；2026-11-04 按维护者裁定重定时机）。
 *
 * ## 缺陷形态
 *
 * `workspaces` 只增不减：`dropWorkspace` 的调用点原本只有三个（关工作区 / 关目标会话的标签 /
 * `destroy()` 全清）。会话切走或删除都不触发回收，于是**常驻 WebView 数 = 开过浏览器的会话数**，
 * 渲染进程随使用历史线性增长，低内存设备更容易被 LMK 回收。
 *
 * ## 时机：以删除为主，切换只做上限淘汰
 *
 * 第一版把「切换」当成主回收点（切走即回收非当前工作台）。那是**用户可感知的退化**：
 * 切走再切回来页面就重建，后台浏览状态（滚动位置、表单、正在播放的媒体）全丢。
 *
 * 现在的规则：
 * 1. **主回收点 = 会话删除**：删了就回收、无延迟（入口 `BrowserHost.dropWorkspaceForSession`）；
 * 2. **切换只淘汰超上限的**：保留 current + 最近使用的 [RECENT_KEEP] 个非当前工作区，
 *    只有第 [MAX_LIVE] 个存活工作区出现时才淘汰最久未用的那个；
 * 3. 淘汰与回收都要留痕（`workspace evicted: reason=cap key=<k> age=<ms>`）。
 *
 * ## 上限 4 的依据
 *
 * - **内存量级**：tier-2 下每个工作区有自己的隔离 WebView / 渲染进程；Android WebView 渲染进程
 *   常驻内存典型 **60–150 MB**（含 V8 堆与 GPU 资源）。4 个 ⇒ **约 240–600 MB**，已接近低端机
 *   （1–2 GB RAM）能承受的上限，再多就是拿 LMK 换功能。
 * - **用户实际并行会话数**：一手操作是「当前会话 + 偶尔对照一个」，再多是偶发；3 个非当前额度
 *   覆盖「同一话题开两三条支线」这种真实用法。
 * - 所以 4 =「current + 3 个最近用过的」既覆盖真实并行，又把最坏情况从**无界**压到 4 个渲染进程。
 *
 * 数值锁在判据里（`WorkspaceReclaimTest`）：改它必须同时改这段依据。
 */
internal object WorkspaceReclaim {
  /** 非当前工作区保留额度。 */
  const val RECENT_KEEP = 3

  /** 存活工作区上限 = current + [RECENT_KEEP]。 */
  const val MAX_LIVE = RECENT_KEEP + 1

  /**
   * 超上限时该淘汰的键（**只淘汰，不动 current 与匿名**）。
   *
   * 淘汰顺序 = 最久未用优先（`lastUsedAt` 小者先走；缺时间戳的按 0 处理 = 最先淘汰）。
   *
   * @param keys 全部会话键。
   * @param currentKey 当前工作台键（永不淘汰）。
   * @param anonymousKey 匿名键（永不淘汰）。
   * @param lastUsedAt 键 → 最近使用时刻（毫秒）。
   * @returns 需要淘汰的键（最久未用在前）。
   */
  fun evictPlan(
    keys: List<String>,
    currentKey: String?,
    anonymousKey: String,
    lastUsedAt: Map<String, Long>,
  ): List<String> {
    val candidates = keys.filter { it != currentKey && it != anonymousKey }
    if (candidates.size <= RECENT_KEEP) return emptyList()
    val byAge = candidates.sortedWith(compareBy({ lastUsedAt[it] ?: 0L }, { it }))
    return byAge.take(candidates.size - RECENT_KEEP)
  }

  /**
   * 会话被删除后仍应存在的键（**只有被删的那个消失，其余不受影响**）。
   *
   * @param keys 删除前的全部键。
   * @param deletedKey 被删除的会话键。
   * @param anonymousKey 匿名键。
   * @returns 删除后仍应存在的键。
   */
  fun afterSessionDelete(keys: List<String>, deletedKey: String, anonymousKey: String): List<String> =
    keys.filter { it != deletedKey || it == anonymousKey }
}
