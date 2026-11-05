package com.dsharnessmobile.shell

/**
 * 触摸事件流的合帧整形器（纯 Kotlin，只用基本类型，无任何 Android 依赖，可直接 JVM 单测）。
 *
 * 背景（issue #540）：tier-2 浏览器兼容档的 [IBrowserRenderer.forwardMotion] 是 oneway
 * （不阻塞调用方，也没有返回值），渲染进程若把每条事件都单独 post 到主线程，一次滑动
 * （约 20 余条 MOVE）就会在主线程排满队。本类把「按序到达的事件流」整形为待发队列：
 *  - DOWN / UP / CANCEL 一律保序保留，绝不合并、绝不因上限丢弃；
 *  - 连续 MOVE 合帧：新 MOVE 覆盖队列尾部尚未被取走的 MOVE（只留最后一条）；
 *  - 队列有上限（默认 64 条）；超限时优先丢最老的 MOVE，队列里一条 MOVE 都没有时
 *    拒绝新事件（宁可少一条，也不丢 DOWN/UP 结构）。
 *
 * 线程安全：所有入口内置锁，允许 binder 线程入队、主线程取走。
 */
class MotionCoalescer(
  private val capacity: Int = DEFAULT_CAPACITY,
  private val moveAction: Int = DEFAULT_MOVE_ACTION,
) {

  /**
   * 一条待重放的触摸样本。字段与 AIDL `forwardMotion` 的标量参数一一对应，
   * 渲染侧据此重建 [android.view.MotionEvent]。
   */
  data class Sample(
    val action: Int,
    val downTime: Long,
    val eventTime: Long,
    val x: Float,
    val y: Float,
    val pressure: Float,
    val size: Float,
    val metaState: Int,
  )

  private val pending = ArrayList<Sample>(capacity.coerceAtLeast(1))

  /**
   * 入队。
   *
   * @return true = 已进入待发队列（可能覆盖了上一条 MOVE）；false = 队列满且没有 MOVE
   *         可丢，本条被拒绝（此时队列内容原样不动）。
   */
  @Synchronized
  fun offer(sample: Sample): Boolean {
    val last = pending.lastOrNull()
    if (last != null && last.action == moveAction && sample.action == moveAction) {
      // 连续 MOVE 合帧：直接覆盖队列尾部那条尚未被取走的 MOVE。
      pending[pending.size - 1] = sample
      return true
    }
    if (pending.size >= capacity.coerceAtLeast(1)) {
      val oldestMove = pending.indexOfFirst { it.action == moveAction }
      // 没有 MOVE 可丢就拒绝入队：结构事件（DOWN/UP/CANCEL）不得被上限挤掉。
      if (oldestMove < 0) return false
      pending.removeAt(oldestMove)
    }
    pending.add(sample)
    return true
  }

  /** 取走全部待发事件（保持入队顺序）并清空队列。 */
  @Synchronized
  fun drain(): List<Sample> {
    if (pending.isEmpty()) return emptyList()
    val out = ArrayList<Sample>(pending)
    pending.clear()
    return out
  }

  @Synchronized
  fun clear() {
    pending.clear()
  }

  @Synchronized
  fun size(): Int = pending.size

  @Synchronized
  fun isEmpty(): Boolean = pending.isEmpty()

  companion object {
    /** 单 tab 待发上限（足够覆盖一次快速滑动，又不会让主线程一帧重放几十条）。 */
    const val DEFAULT_CAPACITY = 64

    /** 与 `MotionEvent.ACTION_MOVE` 同值。本类不依赖 Android，故由调用方显式传入真常量。 */
    const val DEFAULT_MOVE_ACTION = 2
  }
}

/**
 * tabId → [MotionCoalescer] 的按 tab 注册表：每个 tab 一条独立事件流，tab 消失即 [forget]。
 *
 * 自带锁：binder 线程 [offer] 与主线程 [drainAll] 可并发；[drainAll] 的 tab 顺序为首次
 * 入队顺序，tab 内顺序为入队顺序。
 */
class TabMotionQueues(
  private val capacity: Int = MotionCoalescer.DEFAULT_CAPACITY,
  private val moveAction: Int = MotionCoalescer.DEFAULT_MOVE_ACTION,
) {

  private val queues = LinkedHashMap<String, MotionCoalescer>()

  @Synchronized
  fun offer(tabId: String, sample: MotionCoalescer.Sample): Boolean =
    queues.getOrPut(tabId) { MotionCoalescer(capacity, moveAction) }.offer(sample)

  /** 取走所有 tab 的待发事件；没有待发事件的 tab 不出现在结果里。 */
  @Synchronized
  fun drainAll(): List<Pair<String, List<MotionCoalescer.Sample>>> {
    if (queues.isEmpty()) return emptyList()
    val out = ArrayList<Pair<String, List<MotionCoalescer.Sample>>>(queues.size)
    for ((tabId, queue) in queues) {
      val samples = queue.drain()
      if (samples.isNotEmpty()) out.add(tabId to samples)
    }
    return out
  }

  /** tab 消失（destroyTab / 渲染进程崩溃）即清，防旧事件在新 tab 上重放。 */
  @Synchronized
  fun forget(tabId: String) {
    queues.remove(tabId)
  }

  @Synchronized
  fun clear() {
    queues.clear()
  }

  @Synchronized
  fun pendingCount(tabId: String): Int = queues[tabId]?.size() ?: 0
}
