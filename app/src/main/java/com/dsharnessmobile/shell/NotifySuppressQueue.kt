package com.dsharnessmobile.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

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

  internal sealed class JournalRead {
    data class Valid(val pending: List<Pending>, val settled: Map<String, Long>) : JournalRead()
    data class Invalid(val original: String, val reason: String) : JournalRead()
  }

  const val TAG = "dsh-notify"

  /** 延后条目存活上限：超时即丢弃（防退后台弹一堆陈旧汇报）。 */
  const val TTL_MS = 5 * 60 * 1000L

  /** 普通报告队列容量（同 key 合并）。Interactive events have no capacity eviction. */
  const val MAX_PENDING = 8

  /** Maximum unexpired waiting questions/approvals retained durably. */
  const val MAX_INTERACTIVE = 256

  /** 单次补投上限：其余留到下一次 tick，避免退后台瞬间弹一串。 */
  const val MAX_DELIVER_PER_FLUSH = 3

  /** 自续 tick 间隔：队列非空期间每 [FLUSH_TICK_MS] 复评一次（前台则继续等）。 */
  const val FLUSH_TICK_MS = 30_000L

  /** 一条被延后的通知。[key] 是覆盖式去重键。 */
  data class Pending(val key: String, val entry: NotifyEntry, val enqueuedAt: Long)

  /** 纯函数：延后条目是否已过 TTL。 */
  fun isExpired(enqueuedAt: Long, now: Long, ttlMs: Long = TTL_MS): Boolean = now - enqueuedAt >= ttlMs

  /** Interactive entries never expire from waiting for a user answer. */
  internal fun expiredAt(item: Pending, now: Long): Boolean =
    if (NotifyCenter.Face.of(item.entry.kind.lowercase())?.interactive == true) false
    else isExpired(item.enqueuedAt, now)

  private fun interactive(entry: NotifyEntry): Boolean =
    NotifyCenter.Face.of(entry.kind.lowercase())?.interactive == true

  /** Pure settlement predicate: a resolved or locally answered waiting item must not replay. */
  internal fun shouldRetire(item: Pending, resolveEventId: String, answeredEventId: String): Boolean =
    item.entry.eventId.isNotBlank() &&
      (item.entry.eventId == resolveEventId || item.entry.eventId == answeredEventId)

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
    val kept = existing.filterNot {
      it.key == key || (!interactive(it.entry) && isExpired(it.enqueuedAt, now, ttlMs))
    }
    val next = kept + Pending(key, entry, now)
    val ordinaryCount = next.count { !interactive(it.entry) }
    if (ordinaryCount <= max) return next
    // Capacity evicts only ordinary reports. An interactive item is never dropped to make room,
    // because the engine has no timeout and that would strand its task.
    val overflow = ordinaryCount - max
    val evicted = next.filter { !interactive(it.entry) }.take(overflow).toSet()
    return next.filterNot { it in evicted }
  }

  /** Admission keeps rescued oversized journals intact until delivery drains them. */
  internal fun admit(existing: List<Pending>, entry: NotifyEntry, key: String, now: Long): List<Pending>? {
    if (interactive(entry) && existing.count { interactive(it.entry) } >= MAX_INTERACTIVE) return null
    if (existing.count { !interactive(it.entry) } > MAX_PENDING) {
      return if (interactive(entry)) existing + Pending(key, entry, now) else null
    }
    return merge(existing, entry, key, now)
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
    fun expiredAt(p: Pending) = if (interactive(p.entry)) false else isExpired(p.enqueuedAt, now, ttlMs)
    val expired = queue.count { expiredAt(it) }
    val live = queue.filterNot { expiredAt(it) }
    val deliver = if (live.size <= limit) live else live.takeLast(limit)
    return deliver to expired
  }

  private val lock = Any()

  @Volatile
  private var queue: List<Pending> = emptyList()

  private const val JOURNAL_KEY = "notify.deferred.v1"
  private const val BACKUP_PREFIX = "notify.deferred.backup."
  private const val BACKUP_TIME_PREFIX = "notify.deferred.backupAt."
  private const val MAX_SETTLED = 32
  private var settled: Map<String, Long> = emptyMap()
  private var loaded = false
  private var journalWritable = true
  private var appContext: Context? = null
  /** Original bytes waiting for a durable backup; writes stay locked until it commits. */
  private var pendingRecoveryRaw: String? = null

  /** Stable identity includes all display fields, including reports without an eventId. */
  internal fun identity(entry: NotifyEntry): String = MessageDigest.getInstance("SHA-256")
    .digest(canonicalJson(encodeEntry(entry)).toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun canonicalJson(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") {
      JSONObject.quote(it) + ":" + canonicalJson(value.get(it))
    }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonicalJson(value.get(it)) }
    is String -> JSONObject.quote(value)
    null, JSONObject.NULL -> "null"
    else -> value.toString()
  }

  internal fun encodeEntry(e: NotifyEntry): JSONObject = JSONObject().apply {
    put("kind", e.kind); put("title", e.title); put("text", e.text); put("event", e.event)
    put("dedupeKey", e.dedupeKey); put("sessionId", e.sessionId); put("eventId", e.eventId)
    put("count", e.count); put("done", e.done); put("total", e.total); put("current", e.current)
    put("outcome", e.outcome); put("outcomeLabel", e.outcomeLabel); put("summary", e.summary)
    put("body", e.body); put("durationMs", e.durationMs); put("durationLabel", e.durationLabel)
    put("toolCount", e.toolCount); put("turn", e.turn); put("popup", e.popup)
    put("presentedFiles", JSONArray(e.presentedFiles)); put("toolName", e.toolName); put("reason", e.reason)
    if (e.target != null) put("target", e.target)
    put("questions", JSONArray(e.questions.map { q -> JSONObject().apply {
      put("id", q.id); put("header", q.header); put("question", q.question); put("options", JSONArray(q.options))
    } }))
  }

  /** Strict encoder for the live journal; recovery writes must use encodeSalvagedJournal. */
  internal fun encodeJournal(pending: List<Pending>, done: Map<String, Long>): String {
    return encodeJournalAny(pending, done)
  }

  /** Recovery can exceed the normal queue bound while draining the backup in batches. */
  internal fun encodeSalvagedJournal(pending: List<Pending>, done: Map<String, Long>): String =
    encodeJournalAny(pending, done)

  private fun encodeJournalAny(pending: List<Pending>, done: Map<String, Long>): String = JSONObject().apply {
    put("version", 1)
    put("pending", JSONArray(pending.map { p -> JSONObject().apply {
      put("key", p.key); put("at", p.enqueuedAt); put("entry", encodeEntry(p.entry))
    } }))
    put("settled", JSONObject(done))
  }.toString()

  internal fun decodeJournal(raw: String): Pair<List<Pending>, Map<String, Long>> {
    val root = JSONObject(raw)
    require(root.getInt("version") == 1) { "unsupported deferred journal" }
    val pending = root.getJSONArray("pending")
    val entries = (0 until pending.length()).map { i ->
      val p = pending.getJSONObject(i)
      Pending(p.getString("key"), requireNotNull(NotifyStore.parseEntry(p.getJSONObject("entry").toString())), p.getLong("at"))
    }
    val interactiveCount = entries.count { interactive(it.entry) }
    val ordinaryCount = entries.size - interactiveCount
    require(ordinaryCount <= MAX_PENDING && interactiveCount <= MAX_INTERACTIVE) { "oversize deferred journal" }
    val done = root.getJSONObject("settled")
    require(done.length() <= MAX_SETTLED) { "oversize deferred settlements" }
    return entries to done.keys().asSequence().associateWith { done.getLong(it) }
  }

  internal fun readJournal(raw: String?): JournalRead {
    if (raw == null) return JournalRead.Valid(emptyList(), emptyMap())
    return try {
      val state = decodeJournal(raw)
      JournalRead.Valid(state.first, state.second)
    } catch (t: Exception) {
      JournalRead.Invalid(raw, t.message ?: t.javaClass.simpleName)
    }
  }

  data class Salvage(val pending: List<Pending>, val settled: Map<String, Long>, val damaged: Int, val oversized: Int)

  /**
   * Read individual records for a journal that failed strict decode. Valid records are retained,
   * including recovering more than [MAX_PENDING] waiting events; delivery drains them in bounded
   * batches. Damaged records are counted, never silently treated as absent, and the original raw
   * text is backed up before any later journal write replaces it.
   */
  internal fun salvageJournal(raw: String?): Salvage {
    if (raw == null) return Salvage(emptyList(), emptyMap(), 0, 0)
    return try {
      val root = JSONObject(raw)
      val pending = root.optJSONArray("pending") ?: JSONArray()
      var damaged = 0
      val entries = (0 until pending.length()).mapNotNull { i ->
        try {
          val p = pending.getJSONObject(i)
          Pending(p.getString("key"), requireNotNull(NotifyStore.parseEntry(p.getJSONObject("entry").toString())), p.getLong("at"))
        } catch (_: Exception) {
          damaged++
          null
        }
      }
      val settled = root.optJSONObject("settled") ?: JSONObject()
      val done = settled.keys().asSequence().mapNotNull { key ->
        try { key to settled.getLong(key) } catch (_: Exception) { null }
      }.toMap()
      val interactiveCount = entries.count { interactive(it.entry) }
      val ordinaryCount = entries.size - interactiveCount
      Salvage(entries, done, damaged, (ordinaryCount - MAX_PENDING).coerceAtLeast(0) +
        (interactiveCount - MAX_INTERACTIVE).coerceAtLeast(0))
    } catch (_: Exception) {
      Salvage(emptyList(), emptyMap(), 1, 0)
    }
  }

  internal fun backupKey(raw: String): String = BACKUP_PREFIX + MessageDigest.getInstance("SHA-256")
    .digest(raw.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }

  /** Backup commit is the only gate that may unlock journal writes. */
  internal fun backupJournal(raw: String, write: (String, String) -> Boolean): Boolean =
    try { write(backupKey(raw), raw) } catch (_: Throwable) { false }

  private fun retryRecoveryBackup(app: Context): Boolean {
    val raw = pendingRecoveryRaw ?: return journalWritable
    val ok = backupJournal(raw) { key, value ->
      val prefs = NotifyCenter.prefs(app)
      // Commit the backup, read it back, and only then permit the live key to be replaced.
      prefs.edit().putString(key, value).putLong(BACKUP_TIME_PREFIX + key, System.currentTimeMillis()).commit() &&
        prefs.getString(key, null) == value
    }
    if (ok) {
      pendingRecoveryRaw = null
      journalWritable = true
      NotifyProbe.log(app, TAG, "suppress deferred original journal backed up; writes resumed")
    } else {
      journalWritable = false
      NotifyProbe.log(app, TAG, "suppress deferred journal backup failed; writes remain locked")
    }
    return ok
  }

  private fun load(app: Context) {
    if (loaded) return
    val raw = NotifyCenter.prefs(app).getString(JOURNAL_KEY, null)
    when (val state = readJournal(raw)) {
      is JournalRead.Valid -> {
        queue = state.pending
        settled = state.settled
      }
      is JournalRead.Invalid -> {
        val salvaged = salvageJournal(raw)
        queue = salvaged.pending
        settled = salvaged.settled
        journalWritable = false
        pendingRecoveryRaw = raw
        NotifyProbe.log(app, TAG, "suppress deferred journal strict decode failed; pending=" + salvaged.pending.size +
          " damaged=" + salvaged.damaged + " reason=" + state.reason)
        // Backup first. Only a successful commit of the original bytes may unlock journal writes.
        if (retryRecoveryBackup(app) && salvaged.damaged > 0) {
          NotifyProbe.log(app, TAG, "suppress deferred salvage kept valid records; original retained at " + backupKey(state.original))
        }
      }
    }
    appContext = app
    loaded = true
  }

  /** Commit first: a failed disk write must never turn into a consumed source event. */
  private fun persist(app: Context, pending: List<Pending>, done: Map<String, Long>): Boolean =
    commitJournalIfAllowed(pending, done, journalWritable) { raw ->
      NotifyCenter.prefs(app).edit().putString(JOURNAL_KEY, raw).commit()
    }

  internal fun commitJournal(pending: List<Pending>, done: Map<String, Long>, write: (String) -> Boolean): Boolean {
    return commitJournalIfAllowed(pending, done, journalWritable, write)
  }

  internal fun commitJournalIfAllowed(
    pending: List<Pending>, done: Map<String, Long>, allowed: Boolean, write: (String) -> Boolean,
  ): Boolean {
    if (!allowed) return false
    val encoded = if (pending.size > MAX_PENDING) encodeSalvagedJournal(pending, done) else encodeJournal(pending, done)
    if (!write(encoded)) return false
    queue = pending
    settled = done
    return true
  }

  internal fun isSettled(context: Context, entry: NotifyEntry): Boolean = synchronized(lock) {
    load(context.applicationContext)
    settled[identity(entry)]?.let { !isExpired(it, System.currentTimeMillis()) } ?: false
  }

  internal fun isPending(context: Context, entry: NotifyEntry): Boolean = synchronized(lock) {
    load(context.applicationContext)
    queue.any { identity(it.entry) == identity(entry) }
  }

  /** Whether an engine resolve can be settled; if the journal cannot be written it may not be. */
  fun canSettleInteractive(context: Context): Boolean = synchronized(lock) {
    load(context.applicationContext)
    if (!journalWritable) retryRecoveryBackup(context.applicationContext)
    journalWritable
  }

  /**
   * Engine resolve/answer settlement removes the waiting event by its stable identity. The live
   * journal is committed first; a failed write leaves the durable item so the source can retry.
   */
  fun settleInteractive(context: Context, eventId: String, kind: String = ""): Boolean {
    if (eventId.isBlank()) return false
    val app = context.applicationContext
    val now = System.currentTimeMillis()
    synchronized(lock) {
      load(app)
      if (!journalWritable) retryRecoveryBackup(app)
      if (!journalWritable) return false
      val matches = { it: Pending ->
        it.entry.eventId == eventId && (kind.isBlank() || it.entry.kind.equals(kind, ignoreCase = true))
      }
      val remaining = queue.filterNot(matches)
      if (remaining.size == queue.size) return true
      val removed = queue.filter(matches)
      val done = (settled + removed.associate { identity(it.entry) to now })
        .entries.toList().takeLast(MAX_SETTLED).associate { it.key to it.value }
      if (!persist(app, remaining, done)) return false
    }
    NotifyProbe.log(app, TAG, "suppress deferred interactive settled: eventId=" + eventId)
    return true
  }

  fun restore(context: Context) {
    val app = context.applicationContext
    try {
      synchronized(lock) {
        load(app)
        if (!journalWritable) retryRecoveryBackup(app)
      }
      // 补投派到 [flushExecutor]（2026-10-26 评审）：这里的调用方是 EngineService.onCreate /
      // 动作广播 receiver 的**主线程**，而 flush 的 journal commit + 通知 binder 投递是成批 IO。
      if (pendingCount() > 0) {
        if (!NotifyStore.isForeground(app) || !NotifyCenter.suppressForeground(app)) flushAsync(app) else scheduleTick(app)
      }
    } catch (t: Throwable) {
      NotifyProbe.log(app, TAG, "suppress deferred restore failed: " + t.message)
    }
  }

  @Volatile
  private var tickScheduled = false

  /** 主线程 Handler 惰性创建（JVM 单测只碰纯函数，不碰 Looper）。 */
  private val handler: Handler by lazy { Handler(Looper.getMainLooper()) }

  /**
   * flush 执行器：tick 由主线程 Handler **调度**，落盘（journal 大字符串的 prefs.commit）、
   * 通知 binder 投递与逐条结果回写一律派到这里（2026-10-25 审计：旧实现整个 flush 跑在主
   * Looper，队列非空期间每 30s 一轮成批磁盘 IO/binder——主线程 ANR 面。同仓先例见
   * NotifyDecisionQueue.scheduleRetry 与 NotifyActionReceiver 的后台 flush 线程）。
   */
  private val flushExecutor by lazy {
    java.util.concurrent.Executors.newSingleThreadExecutor { r ->
      Thread(r, "dsh-notify-suppress-flush").apply { isDaemon = true }
    }
  }

  fun pendingCount(): Int = queue.size

  /** A deferred event must remain queued until it is actually settled. */
  internal fun isSettledResult(result: NotifyCenter.Result): Boolean = when (result) {
    NotifyCenter.Result.POSTED, NotifyCenter.Result.DUPLICATE_SUPPRESSED,
    NotifyCenter.Result.RESOLVED -> true
    else -> false
  }

  /** 探针用：上一次丢弃的原因（无丢弃时为 null）。 */
  @Volatile
  var lastDropReason: String? = null
    private set

  /** 入队（命中前台抑制时由 NotifyCenter 调用）。 */
  fun enqueue(context: Context, entry: NotifyEntry, key: String): Boolean {
    val app = context.applicationContext
    val now = System.currentTimeMillis()
    synchronized(lock) {
      load(app)
      if (!journalWritable) retryRecoveryBackup(app)
      if (!journalWritable) return false
      val done = settled.filterValues { !isExpired(it, now) }
      if (done.containsKey(identity(entry))) return true
      // Source replay must not extend the TTL or move an older report behind its successor.
      if (queue.any { identity(it.entry) == identity(entry) }) return true
      val next = admit(queue, entry, key, now)
      if (next == null) {
        lastDropReason = "deferred-capacity"
        NotifyProbe.log(app, TAG, "suppress deferred full; event not enqueued (source cursor retained)")
        return false
      }
      // Only ordinary entries that were actually removed by the report policy can be settled here.
      val removed = queue.filterNot { next.contains(it) }
        .filter { !interactive(it.entry) }
        .associate { identity(it.entry) to now }
      val completed = (done + removed).entries.toList().takeLast(MAX_SETTLED).associate { it.key to it.value }
      if (!persist(app, next, completed)) return false
    }
    NotifyProbe.log(app, TAG, "suppress deferred (foreground): kind=" + entry.kind + " key=" + key +
      " pending=" + pendingCount() + " ttlMs=" + TTL_MS)
    scheduleTick(app)
    return true
  }

  /** 丢弃全部延后条目（用户关掉抑制时先补投，测试清理时直接清空）。 */
  fun reset() {
    synchronized(lock) {
      val app = appContext
      if (!journalWritable) return
      if (app != null && !persist(app, emptyList(), emptyMap())) return
      queue = emptyList()
      settled = emptyMap()
    }
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
    try {
      synchronized(lock) {
        load(app)
        if (!journalWritable) retryRecoveryBackup(app)
        if (!journalWritable) return 0
        val (deliver, expired) = takeForFlush(queue, now)
        val expiredIdentities = queue.filter { expiredAt(it, now) }.associate { identity(it.entry) to now }
        val doneAtExpiry = (settled.filterValues { !isExpired(it, now) } + expiredIdentities)
          .entries.toList().takeLast(MAX_SETTLED).associate { it.key to it.value }
        if (!persist(app, queue.filterNot { expiredAt(it, now) }, doneAtExpiry)) {
          scheduleTick(app)
          return 0
        }
        if (expired > 0) {
          lastDropReason = "ttl-expired"
          NotifyProbe.log(app, TAG, "suppress deferred dropped (ttl expired): count=" + expired + " ttlMs=" + TTL_MS)
        }
        var posted = 0
        for (item in deliver) {
          val result = NotifyCenter.deliverDeferred(app, item.entry)
          if (result == NotifyCenter.Result.POSTED) posted++
          // A duplicate is already visible; a deferred retry is still queued. Neither is a
          // successful settlement of this durable item.
          if (isSettledResult(result)) {
            // DEFERRED_RETRY is deliberately absent: the item remains queued and is replayed by
            // the next tick. UNKNOWN_KIND/DISABLED/PERMISSION_DENIED also remain until a later
            // attempt can deliver them; dropping them here would lose the only answer surface.
            val done = (settled + (identity(item.entry) to now)).entries.toList().takeLast(MAX_SETTLED)
              .associate { it.key to it.value }
            if (!persist(app, queue.filterNot { it == item }, done)) {
              NotifyProbe.log(app, TAG, "suppress deferred settlement failed; durable pending retained")
              break
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
    } catch (t: Throwable) {
      NotifyProbe.log(app, TAG, "suppress deferred flush failed: " + t.message)
      if (pendingCount() > 0) scheduleTick(app)
      return 0
    }
  }

  /**
   * Retry durable interactions before consuming new source lines. This is intentionally narrower
   * than [flush]: it does not wait for a foreground transition, so granting notification or
   * overlay access can deliver a waiting question immediately.
   */
  fun retryRetained(context: Context): Int = flush(context)

  /**
   * 把一次 flush 派到 [flushExecutor]（2026-10-26 评审）。
   *
   * 调用方可能是主线程：[restore] 由 `EngineService.onCreate` / 动作广播 receiver 触发，
   * [NotifyCenter.onSuppressForegroundChanged] 由设置页开关触发。flush 的 journal commit 与
   * 通知 binder 投递属于成批 IO，不能吃 receiver 的 10s 预算，也不该卡设置页。
   */
  fun flushAsync(context: Context) {
    val app = context.applicationContext
    try {
      flushExecutor.execute {
        try {
          flush(app)
        } catch (t: Throwable) {
          NotifyProbe.log(app, TAG, "suppress deferred flush (async) failed: " + t.message)
        }
      }
    } catch (_: java.util.concurrent.RejectedExecutionException) {
      // executor 永不 shutdown；被外部关停时放弃本轮，队列仍在，下次 enqueue/tick 会再来。
    }
  }

  /** 队列非空期间的自续 tick：前台则继续等，后台则补投。队列一空即停（有界）。
   *  调度归主 Handler，**执行**（prefs 读 + flush 的落盘/通知投递）派 [flushExecutor]。 */
  private fun scheduleTick(context: Context) {
    val app = context.applicationContext
    if (tickScheduled) return
    tickScheduled = true
    try {
      handler.postDelayed({
        tickScheduled = false
        if (pendingCount() == 0) return@postDelayed
        try {
          flushExecutor.execute {
            try {
              if (NotifyStore.isForeground(app) && NotifyCenter.suppressForeground(app)) scheduleTick(app) else flush(app)
            } catch (t: Throwable) {
              // 执行体只可能在 flush 之外抛（flush 自带异常边界）。不能让它静默断掉自续链：
              // 否则队列非空却再也没有下一拍。补一拍，最坏是每 30 秒重试一次。
              NotifyProbe.log(app, TAG, "suppress deferred tick failed: " + t.message)
              if (pendingCount() > 0) scheduleTick(app)
            }
          }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
          // executor 从不 shutdown，这里只防御被外部关停：本轮放弃，队列仍在。
        }
      }, FLUSH_TICK_MS)
    } catch (t: Throwable) {
      tickScheduled = false
      NotifyProbe.log(app, TAG, "suppress deferred tick not scheduled: " + t)
    }
  }
}
