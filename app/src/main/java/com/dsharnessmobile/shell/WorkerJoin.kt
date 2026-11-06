package com.dsharnessmobile.shell

/**
 * 停机等待执行线程的**纯逻辑**（issue #1601）。
 *
 * 缺陷形态：[ControlPoller.stop] 只置 running=false + interrupt() 就清引用。阻塞点在 runOp →
 * ShizukuTransport 的 Binder 调用上，interrupt() 打断不了（那条链路上没有任何可中断点）。于是
 * EngineService 重建或无障碍服务重连时，`ensureStarted` 见 poller==null 就新建一个，**旧线程仍在跑
 * 当前 op**——两条特权命令并发执行，而 reqId 去重 LRU 是实例级的，新实例 map 为空，同一条请求
 * 被投递两次就执行两次。
 *
 * 为什么抽成独立对象：等待语义（有界、不吞中断位、自己不在等待自己）可以被真实线程直接测——
 * 放在 ControlPoller 里就要 Android Context，JVM 单测永远够不着，判据只能退化成源码文本切片。
 */
internal object WorkerJoin {

  /**
   * 有界等待 [worker] 结束。
   *
   * @param worker 目标线程（null = 从未启动，视为已结束）。
   * @param timeoutMs 等待上界；执行线程可能正卡在一条不可中断的长 op 上，停机路径不能无限挂住。
   * @return true = 线程已结束（或本来就没有线程）；false = 上界到了仍在跑（调用方必须如实留痕）。
   */
  fun joinQuietly(worker: Thread?, timeoutMs: Long): Boolean {
    if (worker == null) return true
    // 自己等自己会等到超时，且那条路径本来就是「当前线程就是执行线程」（同步调用 stop）。
    if (worker === Thread.currentThread()) return true
    try {
      worker.join(timeoutMs)
    } catch (_: InterruptedException) {
      // 停机路径不吞中断位：置回去让调用栈上的人知道被打断了。
      Thread.currentThread().interrupt()
      return !worker.isAlive
    }
    return !worker.isAlive
  }
}
