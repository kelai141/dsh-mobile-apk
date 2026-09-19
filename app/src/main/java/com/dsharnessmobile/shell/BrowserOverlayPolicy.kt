package com.dsharnessmobile.shell

/**
 * 原生浏览器覆盖层的可见性判据（单一真源，纯函数，可 JVM 单测）。
 *
 * 为什么必须独立成函数并带上「保鲜期」
 * ------------------------------------
 * 0.14.0 的判据是 `requestedVisible && stageVisible`，两者都是**每工作台粘滞的布尔量**：
 *   - `requestedVisible` 由 `show()/hide()` 置位；
 *   - `stageVisible` 由一次有效的 `setStageBounds(visible=true)` 置位，只有下一次
 *     `setStageBounds(visible=false)` 才会清掉。
 *
 * 于是存在一类**没有任何在场 UI 的幽灵覆盖层**（用户实报「收起侧边栏浏览器不卸载」）：
 * 某个会话的侧栏面板挂载过、下推过 `visible=true`，随后组件卸载（关标签页 / 切会话 /
 * 换到别的对话），而它的 `hide()` 只清了 `currentWorkspace` 的 `requestedVisible`——
 * 若那一刻 `currentWorkspace` 已经**不是**它（`controlOp` 的 `switchTo`、`dropWorkspace`
 * 的 `currentWorkspace = workspaces.values.lastOrNull()` 都会改当前工作台），该工作台的
 * `requestedVisible/stageVisible` 就双双留成 true。之后任何一次 `switchTo` 回到它
 * （模型在那边 `browser_open`、下一条控制 op、丢弃当前工作台）都会让它的 WebView 直接
 * `VISIBLE` 盖在聊天上；而**没有任何组件在场去下推 `visible=false`**，用户怎么收起侧栏
 * 都不会消失——收起只是一个前端动作，撤不掉原生侧的粘滞状态。
 *
 * 修法不是去补某一条卸载路径（那是无穷枚举），而是把判据改成**fail-closed**：
 * 「只有在场的 UI 发布者**刚刚**宣称过舞台可见」才画。发布者每 300ms 下一拍
 * （`browser-tab.tsx`：rAF 事件通道 + 300ms 兜底轮询），所以 5 倍周期（1500ms）内没有
 * 新下推，就说明**发布者已经不在场**——不管它是因为什么原因不在场。
 *
 * 停画**不影响 AI 的工作面**：INVISIBLE 保留布局盒（`applyVisibility` 的既有口径），
 * 页面排版尺寸由 `layoutDetached()` 保障，模型侧的 snapshot/click/type 照常可用。
 */
internal object BrowserOverlayPolicy {

  /** 舞台下推的保鲜期（ms）：侧栏面板的下推周期为 300ms，取 5 倍。 */
  // 审查 N-3：TTL 必须 **> `onMain` 的主线程预算（2s）**，否则主线程一忙（冷启动建页、截图 PNG
  // 编码、recycleView 重建）就会让「面板下推」的消息排在看门狗之后执行 ⇒ 在场的覆盖层被判
  // 「发布者已消失」→ 停画一下再回来（低端机上表现为「侧栏浏览器偶尔闪一下」）。
  // 取 4s = 2× 预算，且仍是面板下推周期（300ms）的 13 倍——发布者真消失时收敛依然很快。
  const val STAGE_BOUNDS_TTL_MS = 4_000L

  /** 保鲜看门狗周期（ms）：TTL 过期后最多再晚一拍停画。 */
  const val STAGE_BOUNDS_WATCHDOG_MS = 500L

  /** 从未下推过 bounds 的年龄（必然过期，且不会随 uptime 回绕误判为新鲜）。 */
  const val NEVER_PUBLISHED_AGE_MS = Long.MAX_VALUE

  /**
   * 覆盖层是否应当绘制。
   *
   * @param isCurrent - 该工作台是否就是当前工作台（非当前的一律不画）。
   * @param requestedVisible - 调用方（前端 `show()`）是否请求过可见。
   * @param stageVisible - 最近一次有效 `setStageBounds` 是否判定舞台可见。
   * @param boundsAgeMs - 距最近一次 bounds 下推的毫秒数（[NEVER_PUBLISHED_AGE_MS] = 从未）。
   * @param ttlMs - 保鲜期；`<= 0` 视为「不接受任何记忆状态」（此时永不绘制）。
   * @returns 仅当四项同时成立才为 true；任一条件缺失都判**不画**（fail-closed）。
   */
  fun visible(
    isCurrent: Boolean,
    requestedVisible: Boolean,
    stageVisible: Boolean,
    boundsAgeMs: Long,
    ttlMs: Long,
  ): Boolean {
    if (!isCurrent || !requestedVisible || !stageVisible) return false
    if (ttlMs <= 0L) return false
    if (boundsAgeMs < 0L || boundsAgeMs == NEVER_PUBLISHED_AGE_MS) return false
    return boundsAgeMs <= ttlMs
  }

  /**
   * 工作台记忆状态里记录的 bounds 年龄。
   * @param publishedAtMs - 最近一次 bounds 下推的 `uptimeMillis`；`<= 0` = 从未下推。
   * @param nowMs - 当前 `uptimeMillis`。
   * @returns 年龄；从未下推时返回 [NEVER_PUBLISHED_AGE_MS]。
   */
  fun boundsAge(publishedAtMs: Long, nowMs: Long): Long {
    if (publishedAtMs <= 0L) return NEVER_PUBLISHED_AGE_MS
    val age = nowMs - publishedAtMs
    // uptime 不会回退，但设备休眠/时钟实现差异下仍取 saturating 语义：负值按 0（刚下推）处理，
    // 绝不因为一次异常的时间差把在场的页面误判成「过期」。
    return age.coerceAtLeast(0L)
  }

  /** 看门狗是否应当停画：只在「记忆态说自己可见」但保鲜期已过时才动手。 */
  fun shouldDropStaleStage(stageVisible: Boolean, boundsAgeMs: Long, ttlMs: Long): Boolean =
    stageVisible && (ttlMs <= 0L || boundsAgeMs > ttlMs || boundsAgeMs == NEVER_PUBLISHED_AGE_MS)
}
