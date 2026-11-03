package com.dsharnessmobile.shell

/**
 * 隔离浏览器工作台的**回收计划**（issue #1364）。
 *
 * ## 缺陷形态
 *
 * `workspaces` 只增不减：`dropWorkspace` 的调用点只有三个（关工作区 / 关目标会话的标签 /
 * `destroy()` 全清）。会话被删除、切走、面板永久收起都不触发回收，于是
 * **常驻 WebView 数 = 开过浏览器的会话数 = 常驻渲染进程数**，内存随使用历史线性增长，
 * 低内存设备更容易被 LMK 回收。
 *
 * ## 回收计划（纯函数）
 *
 * 只回收「**非当前**且**非匿名**」的工作台：
 *
 * - **当前**会话正在被操作/呈现，删了就是「切回来页面没了」；
 * - **匿名**工作台（`__anonymous__`）被非会话调用反复复用同一份状态，回收它会让每次调用
 *   都新建页面、凭空丢失。
 *
 * 抽成纯函数是为了让判据能**双向**证明：给一个非 current 的可删工作区，它必须**出现在计划里**
 * （证明「真的会删」而不是「根本没调用」），同时 current 与匿名**不得出现**（证明「跳过」）。
 * 只断言「目录还在」在两种实现下都绿，区分不了这两件事。
 */
internal object WorkspaceReclaim {
  /**
   * 计算要回收的会话键。
   *
   * @param keys 当前 `workspaces` 里的全部会话键。
   * @param currentKey 当前工作台对应的会话键；null = 尚无当前。
   * @param anonymousKey 匿名工作台的键（`BrowserHost.ANONYMOUS_SESSION`）。
   * @returns 需要回收的键（顺序沿用入参顺序）。
   */
  fun plan(keys: List<String>, currentKey: String?, anonymousKey: String): List<String> =
    keys.filter { it != currentKey && it != anonymousKey }

  /**
   * 回收后的键集合（供判据直接断言终态）。
   *
   * @param keys 回收前的全部键。
   * @param currentKey 当前工作台键。
   * @param anonymousKey 匿名键。
   * @returns 回收后仍应存在的键。
   */
  fun remainingKeys(keys: List<String>, currentKey: String?, anonymousKey: String): List<String> =
    keys.filter { key -> !plan(keys, currentKey, anonymousKey).contains(key) }
}
