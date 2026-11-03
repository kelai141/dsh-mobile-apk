package com.dsharnessmobile.shell

/**
 * tier-2 在途 JS 回执的**回收判据**（issue #1362）。
 *
 * ## 缺陷形态
 *
 * `pendingJs[seq]` 的唯一出表路径是「收到回执」与「立刻失败」两种。渲染进程被 LMK 杀掉、
 * service 断连、或 `destroy()` 里 `remote.disconnect()` 时**回执永远不到**，条目连同闭包
 * （捕获 `Tab` 及其 `view`）永久驻留；调用方只吃到 `onMain` 的 2s 闩超时，
 * 对外表现为「快照偶发超时」而不是明确错误。
 *
 * ## 两类失效，处置不同
 *
 * - **页面已死**（`destroy()` / 断连）：清理即可——回执不可能再来；
 * - **页面还在但永不回执**（渲染进程活着却卡住）：清理后再堆，**必须有上限**，
 *   否则同一页面会持续堆积。
 *
 * ## 上限取 64 的依据
 *
 * 实测/推理（本文件只有 5 个 `evaluateOnTab` 调用点：viewport 探针、control 表达式、snapshot、
 * resolveRef、通用脚本）：
 *
 * - **典型值 1–2 条**：控制队列是**串行**的（一次一个 op），而每个调用方都在等回执；
 *   最常见的并发组合是「viewport 探针 + 一次 snapshot」。
 * - **最坏值**：调用方各自 2s 闩超时，所以堆积速率 ≈ 1 条 / 2s —— 64 条 ≈ **2 分钟**的
 *   连续挂死。这已经远超任何正常突发（正常突发是个位数），又远小于「一天 8 小时后台挂死」
 *   会堆到的量级（那会是上万条）。
 *
 * 所以 64 是「比真实突发高一个量级、比长期泄漏低两个量级」的折中；不是拍脑袋的 64。
 *
 * ## 回收必须留痕
 *
 * [BrowserHost] 每次回收都写一行 `dsh-browser` 日志（条数 + 原因）。**静默回收**会让以后
 * 分不清「没堆」与「堆了但被回收」——那正是本 issue 想避免的那种不可观测。
 */
internal object PendingJsDrain {
  /** 单次在途回执上限。依据见类注释（典型 1–2、最坏 ≈1 条/2s，64 ≈ 2 分钟挂死）。 */
  const val MAX_INFLIGHT = 64

  /**
   * 入队前是否该先回收。
   *
   * @param inflight 当前在途条数（**入队前**）。
   * @returns true = 已达上限，调用方应先 drain 再入队。
   */
  fun shouldReclaim(inflight: Int): Boolean = inflight >= MAX_INFLIGHT
}
