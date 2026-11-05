package com.dsharnessmobile.shell

/**
 * WebView 渲染进程冻结看门狗的**状态机**（issue #1513；修复 #1355 的判据缺口）。
 *
 * 为什么单独成文件：#1355 的回归判据原来对着源码文本切片，而且切错了作用域——它切的是
 * startFreezeWatchdog() 到 startUpdateCheck() 那 16 行，而**置位点**（检测到冻结）与**唯一复位点**
 * （页面应答回调）都在 freezeRunnable 里。于是把 freezeReloaded = false 挪进冻结分支
 * （每拍都复位 ⇒ 每 10 秒 reload 一次的循环）时，那条用例仍然绿。
 *
 * 这里把那一拍的状态转换抽成纯类：tick(now) 返回本拍该做什么（心跳 / reload / 什么都不做），
 * onAck 是页面应答（= 页面真活，重开自愈预算），onPageLoaded 只重置计时**不复位闸门**
 * （onPageFinished 只代表文档加载完，此时 JS 可能仍然死着，在那里复位就是 reload 循环）。
 * 判据（FreezeRecoveryReArmTest）用可注入时钟直接跑这些转换，不再看源码文本。
 */
internal class FreezeRecoveryGate(
  /** 页面加载后多久之内不判冻结（与旧实现同值 45s）。 */
  private val pageGraceMs: Long = PAGE_GRACE_MS,
  /** 最近一次 JS 应答距今超过多久才算「无响应」（与旧实现同值 20s）。 */
  private val ackGraceMs: Long = ACK_GRACE_MS,
) {
  /** 本拍该做的动作。 */
  enum class Action { NONE, PING, RELOAD }

  /** 最近一次页面加载（onPageFinished）的时刻。 */
  var pageLoadedAt: Long = 0L
    private set

  /** 最近一次 JS 应答（或判定冻结）的时刻——冻结窗口按它算。 */
  var jsAckAt: Long = 0L
    private set

  /** 是否有一次心跳在飞（防同一拍重复发）。 */
  var pingOutstanding: Boolean = false
    private set

  /** 本轮冻结是否已经 reload 过（复位**只**发生在 [onAck]）。 */
  var freezeReloaded: Boolean = false
    private set

  /** 页面加载事件：只重置计时，**不复位** [freezeReloaded]（onPageFinished 不等于页面真活）。 */
  fun onPageLoaded(now: Long) {
    pageLoadedAt = now
    jsAckAt = now
    pingOutstanding = false
  }

  /** 页面应答（evaluateJavascript("1") 的回调）：页面真活，重开冻结自愈预算（#1355 的正解）。 */
  fun onAck(now: Long) {
    jsAckAt = now
    pingOutstanding = false
    freezeReloaded = false
  }

  /** 心跳发出即失败（evaluateJavascript 抛错）：解除在飞标记，下一拍可重发。 */
  fun onPingFailed() {
    pingOutstanding = false
  }

  /** 停止监控（pause / destroy / renderer-loss）：清在飞标记，保留闸门状态。 */
  fun onStopped() {
    pingOutstanding = false
  }

  /** 冻结持续时长（诊断日志用）。 */
  fun frozenMs(now: Long): Long = now - jsAckAt

  /**
   * 一拍转换。
   *
   * - 冻结（页面已加载超 [pageGraceMs] 且超 [ackGraceMs] 无应答）：本轮未 reload 过就返回
   *   [Action.RELOAD] 并置位；已 reload 过则返回 [Action.NONE]——**绝不顺手复位**，否则每拍都 reload；
   * - 未冻结：没有心跳在飞就返回 [Action.PING]（发一条心跳）；
   * - 其余 [Action.NONE]。
   */
  fun tick(now: Long): Action {
    if (isFrozen(now)) {
      val reload = !freezeReloaded
      freezeReloaded = true
      jsAckAt = now
      pingOutstanding = false
      return if (reload) Action.RELOAD else Action.NONE
    }
    if (pingOutstanding) return Action.NONE
    pingOutstanding = true
    return Action.PING
  }

  /**
   * 是否已判冻结：两个窗口都要过。
   *
   * 为什么页面窗口不是多余的：渲染进程在页面**刚加载**时本来就慢（解压/装配），只看应答窗
   * 会把「正常冷启动」判成冻结并 reload，那正是 reload 环的另一半。
   */
  private fun isFrozen(now: Long): Boolean =
    now - pageLoadedAt > pageGraceMs && now - jsAckAt > ackGraceMs

  companion object {
    /** 页面加载后的观察窗（与旧实现同值，勿只改一处）。 */
    const val PAGE_GRACE_MS = 45_000L

    /** JS 应答宽限（与旧实现同值）。 */
    const val ACK_GRACE_MS = 20_000L
  }
}
