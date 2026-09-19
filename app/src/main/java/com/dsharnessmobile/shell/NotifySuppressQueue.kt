package com.dsharnessmobile.shell

import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * 前台抑制待投队列（0.14.1 块J FIX-1：「抑制 = 丢弃」改为「抑制 = 延后」）。
 *
 * 背景（详见 docs/0.14.1-preview-NOTIFY-REALTIME-AND-STATE-SYNC.md §3.1 假设②）：旧实现在
 * `NotifyCenter.deliverEvent` 命中前台抑制时直接 `return Result.SUPPRESSED_FOREGROUND`——**终态、无入队、
 * 无补投**，而消费侧 `NotifyStore.drain` 已推进字节偏移，于是那一条永久消失。用户体感即「必须划到后台
 * 才推送」。本对象补上被丢掉的那半边：命中抑制时把条目**延后**，回到后台（或用户关掉抑制）时补投。
 *
 * 三条纪律（每条对着一个可预见的退化）：
 *  1. **TTL**：延后条目超 [TTL_MS] 即丢弃并记探针——否则「退后台瞬间弹一堆陈旧汇报」。
 *  2. **覆盖式去重**：同 key（默认按会话）后写覆盖前写——与 `NotificationManager.notify` 的覆盖式
 *     notificationId 语义一致，不会为同一会话堆积多条。
 *  3. **有界**：容量 [MAX_PENDING] + 单次补投上限 [MAX_DELIVER_PER_FLUSH] + 队列空即停的自续 tick，
 *     因此不会出现「无界内存」或「一次弹爆通知栏」。
 *
 * 生效前提：仅在用户**显式**把 `NotifyCenter.suppressForeground` 打开时可达（0.14.1 起其默认值为
 * false，见 NotifyCenter.DEFAULT_SUPPRESS_FOREGROUND）。默认路径上本队列恒为空。
 */
object NotifySuppressQueue {

  const val TAG = "dsh-notify"

  /** 延后条目存活上限：超时即丢弃（防退后台弹一堆陈旧汇报）。 */
  const val TTL_MS = 5 * 60 * 1000L

  /** 队列容量上限：保留最新的 N 条（同 key 已合并）。 */
  const val MAX_PENDING = 8

  /** 单次补投上限：其余留到下一次 tick，避免退后台瞬间弹一串。 */
  const val MAX_DELIVER_PER_FLUSH = 3

  /** 自续 tick 间隔：队列非空期间每 [FLUSH_TICK_MS] 复评一次（前台则继续等）。 */
  const val FLUSH_TICK_MS = 30_000L

  /** 一条被延后的通知。[key] 是覆盖式去重键。 */
  data class Pending(val key: String, val entry: NotifyEntry, val enqueuedAt: Long)

  /** 纯函数：延后条目是否已过 TTL。 */
  fun isExpired(enqueuedAt: Long, now: Long, ttlMs: Long = TTL_MS): Boolean = now - enqueuedAt >= ttlMs

  /**
   * 纯函数：把一条新条目并入队列。同 key 覆盖（后写覆盖前写且移到队尾）、清掉已过期项、
   * 超出容量时保留最新 [max] 条。
   */
  fun merge(
    existing: List<Pending>,
    entry: NotifyEntry,
    key: String,
    now: Long,
    ttlMs: Long = TTL_MS,
    max: Int = MAX_PENDING,
  ): List<Pending> {
    val kept = existing.filterNot { it.key == key || isExpired(it.enqueuedAt, now, ttlMs) }
    val next = kept + Pending(key, entry, now)
    return if (next.size <= max) next else next.takeLast(max)
  }

  /**
   * 纯函数：本次补投的条目（最新 [limit] 条，队尾优先）+ 需要丢弃的计数。
   * 顺序取队尾（最新）优先，保证「用户最关心的是刚做完的那一轮」。
   */
  fun takeForFlush(
    queue: List<Pending>,
    now: Long,
    ttlMs: Long = TTL_MS,
    limit: Int = MAX_DELIVER_PER_FLUSH,
  ): Pair<List<Pending>, Int> {
    val expired = queue.count { isExpired(it.enqueuedAt, now, ttlMs) }
    val live = queue.filterNot { isExpired(it.enqueuedAt, now, ttlMs) }
    val deliver = if (live.size <= limit) live else live.takeLast(limit)
    return deliver to expired
  }

  private val lock = Any()

  @Volatile
  private var queue: List<Pending> = emptyList()

  @Volatile
  private var tickScheduled = false

  /** 主线程 Handler 惰性创建（JVM 单测只碰纯函数，不碰 Looper）。 */
  private val handler: Handler by lazy { Handler(Looper.getMainLooper()) }

  fun pendingCount(): Int = queue.size

  /** 探针用：上一次丢弃的原因（无丢弃时为 null）。 */
  @Volatile
  var lastDropReason: String? = null
    private set

  /** 入队（命中前台抑制时由 NotifyCenter 调用）。 */
  fun enqueue(context: Context, entry: NotifyEntry, key: String) {
    val app = context.applicationContext
    val now = System.currentTimeMillis()
    synchronized(lock) { queue = merge(queue, entry, key, now) }
    NotifyProbe.log(app, TAG, "suppress deferred (foreground): kind=" + entry.kind + " key=" + key +
      " pending=" + pendingCount() + " ttlMs=" + TTL_MS)
    scheduleTick(app)
  }

  /** 丢弃全部延后条目（用户关掉抑制时先补投，测试清理时直接清空）。 */
  fun reset() {
    synchronized(lock) { queue = emptyList() }
    tickScheduled = false
  }

  /**
   * 补投：应用已不在前台（或用户关掉抑制）时把延后条目交回正常投递路径
   * （[NotifyCenter.deliverDeferred] 以 foreground=false 调用，不再命抑制判定）。
   * @return 实际投递条数
   */
  fun flush(context: Context): Int {
    val app = context.applicationContext
    val now = System.currentTimeMillis()
    val (deliver, expired) = synchronized(lock) {
      val taken = takeForFlush(queue, now)
      val rest = queue.filterNot { taken.first.contains(it) }
      queue = rest.filterNot { isExpired(it.enqueuedAt, now) }
      taken
    }
    if (expired > 0) {
      lastDropReason = "ttl-expired"
      NotifyProbe.log(app, TAG, "suppress deferred dropped (ttl expired): count=" + expired + " ttlMs=" + TTL_MS)
    }
    var posted = 0
    for (item in deliver) {
      when (NotifyCenter.deliverDeferred(app, item.entry)) {
        NotifyCenter.Result.POSTED -> posted++
        else -> {
          // 补投未成功：放回队列（仍受 TTL 约束），下一轮再试。
          synchronized(lock) {
            queue = merge(queue, item.entry, item.key, item.enqueuedAt)
          }
        }
      }
    }
    if (posted > 0 || expired > 0) {
      NotifyProbe.log(app, TAG, "suppress deferred flushed posted=" + posted + " expired=" + expired +
        " pending=" + pendingCount())
    }
    if (pendingCount() > 0) scheduleTick(app) else tickScheduled = false
    return posted
  }

  /** 队列非空期间的自续 tick：前台则继续等，后台则补投。队列一空即停（有界）。 */
  private fun scheduleTick(context: Context) {
    val app = context.applicationContext
    if (tickScheduled) return
    tickScheduled = true
    try {
      handler.postDelayed({
        tickScheduled = false
        if (pendingCount() == 0) return@postDelayed
        if (NotifyStore.isForeground(app)) scheduleTick(app) else flush(app)
      }, FLUSH_TICK_MS)
    } catch (t: Throwable) {
      tickScheduled = false
      NotifyProbe.log(app, TAG, "suppress deferred tick not scheduled: " + t)
    }
  }
}
