package com.dsharnessmobile.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 决策耐久队列（0.14.0-preview §6.3.1 / NT-14、NT-17）：
 * 通知栏动作**先落盘再投递**，失败可见、指数退避 <=60s、requestId LRU 去重。
 *
 * 为什么必须先落盘：动作接收器（NotifyActionReceiver）的 onReceive 预算只有 10s（超时 ANR，
 * goAsync 不延长），而引擎可能未就绪 / 正好在重启。落盘后由重试器补投，进程被杀也不丢决策。
 *
 * 幂等三层（§5.4.3）：
 *  ① 本地 requestId LRU（同一次点击重复触发只投一次）；
 *  ② 网关对已结算事件的重复应答是 no-op（上游 gateway index.ts:527-529）；
 *  ③ 通知侧 pending -> submitted -> settled 状态机（NotifyBridge 收 cancel 帧落 settled）。
 *
 * 落盘格式：files/notify-decisions.ndjson，逐行 JSON 追加；状态变更也追加一行（同 requestId
 * 后写覆盖前写），load 时折叠；文件超限时压缩为「未完成项」。
 */
object NotifyDecisionQueue {

  const val TAG = "dsh-notify"
  const val FILE_NAME = "notify-decisions.ndjson"
  const val COMPACT_BYTES = 256 * 1024

  /** 退避上限 60s（NT-17 的「<=60 s 内送达」判据来源：退避阶梯本身封顶 60s）。 */
  const val MAX_BACKOFF_MS = 60_000L
  const val BASE_BACKOFF_MS = 2_000L
  const val MAX_ATTEMPTS = 6

  /**
   * NOT_READY（引擎/应答流尚未就绪）的**墙钟预算**：从决策入队时刻（ts）起算，到期转 FAILED
   * 并落到可见的「提交失败，点击重试」。独立于 HTTP 失败的 MAX_ATTEMPTS 计数。
   *
   * 为什么是 5 分钟而不是 60s：**引擎冷启动实测可超过 60s**——NT-17A 设备实测在
   * [ENGINE_COLD_START_OBSERVED_MS]（约 110s）内应答流一直 ready=false，期间决策必须保持
   * 等待而不是被判失败。预算必须显著大于实测冷启动上限（单测用断言锁死这条关系）。
   */
  const val NOT_READY_BUDGET_MS = 5 * 60 * 1000L

  /** 设备实测的引擎冷启动/网关就绪上限（NT-17A，2026-09-13：ready=false 持续约 110s）。 */
  const val ENGINE_COLD_START_OBSERVED_MS = 110_000L

  /** NOT_READY 的处置（纯函数单测用）。 */
  enum class WaitAction { RETRY, FAIL }

  /** 纯函数：按入队时刻与当前时刻判 NOT_READY 是继续等待还是判失败。 */
  fun notReadyAction(ts: Long, now: Long): WaitAction =
    if (now - ts >= NOT_READY_BUDGET_MS) WaitAction.FAIL else WaitAction.RETRY

  /**
   * 触发点重评计划（纯函数）：进程重启后滞留的 pending 决策在**下一个触发点**必须按预算重新判定。
   *
   * 背景（2026-09-13 设备实测的真缺陷）：预算评估只发生在 flush 里，而 flush 只由「重试定时器 /
   * ready / 动作广播」触发——**进程死亡会带走重试定时器**；若此后引擎/应答流一直不就绪，就没有任何
   * flush 触发点，预算永远不会被评估 ⇒ 决策永久滞留 pending，既不补投也不出现「提交失败，点击重试」。
   * 所以任何启动/装载触发点都要调 [ensureScheduled]（用本函数决定要不要立刻重评与续排重试）。
   */
  data class ResumePlan(val expired: List<String>, val waiting: List<String>)

  fun resumePlan(decisions: List<Decision>, now: Long): ResumePlan {
    val expired = ArrayList<String>()
    val waiting = ArrayList<String>()
    for (d in decisions) {
      if (d.state == State.SUBMITTED.wire || d.state == State.SETTLED.wire || d.state == State.EXPIRED.wire) continue
      if (notReadyAction(d.ts, now) == WaitAction.FAIL) expired.add(d.requestId) else waiting.add(d.requestId)
    }
    return ResumePlan(expired, waiting)
  }

  enum class State(val wire: String) {
    PENDING("pending"),
    SUBMITTED("submitted"),
    SETTLED("settled"),
    FAILED("failed"),
    EXPIRED("expired");

    companion object {
      fun of(wire: String): State = values().firstOrNull { it.wire == wire } ?: PENDING
    }
  }

  /** 一条待投递决策。[outcomeJson] 是 $events/result 的 outcome 对象序列化结果。 */
  data class Decision(
    val requestId: String,
    val eventId: String,
    val kind: String,
    val outcomeJson: String,
    val ts: Long,
    val state: String = State.PENDING.wire,
    val attempts: Int = 0,
    /** NOT_READY（未就绪）等待的独立计数：与 [attempts]（HTTP 失败计数）分开，退避互不污染。 */
    val waitAttempts: Int = 0,
  )

  // ── 纯逻辑（JVM 单测）──────────────────────────────────────────────────

  /** requestId = sha1(eventId|kind|outcome) 前 16 位十六进制（同决策恒同 ID -> LRU 语义成立）。 */
  fun requestIdFor(eventId: String, kind: String, outcomeJson: String): String {
    val digest = MessageDigest.getInstance("SHA-1")
      .digest((eventId + "|" + kind + "|" + outcomeJson).toByteArray(Charsets.UTF_8))
    val sb = StringBuilder()
    for (b in digest) {
      sb.append(String.format(java.util.Locale.US, "%02x", b))
      if (sb.length >= 16) break
    }
    return sb.toString().take(16)
  }

  /** 指数退避：2s -> 4s -> ... 封顶 60s（attempt 从 0 计）。 */
  fun retryDelayMs(attempt: Int): Long {
    val n = attempt.coerceIn(0, 8)
    return (BASE_BACKOFF_MS shl n).coerceAtMost(MAX_BACKOFF_MS)
  }

  fun serialize(d: Decision): String = JSONObject()
    .put("requestId", d.requestId)
    .put("eventId", d.eventId)
    .put("kind", d.kind)
    .put("outcome", d.outcomeJson)
    .put("ts", d.ts)
    .put("state", d.state)
    .put("attempts", d.attempts)
    .put("waitAttempts", d.waitAttempts)
    .toString()

  fun parse(line: String): Decision? {
    val j = try { JSONObject(line) } catch (_: Exception) { return null }
    val id = j.optString("requestId", "")
    if (id.isEmpty()) return null
    return Decision(
      requestId = id,
      eventId = j.optString("eventId", ""),
      kind = j.optString("kind", ""),
      outcomeJson = j.optString("outcome", "{}"),
      ts = j.optLong("ts", 0L),
      state = j.optString("state", State.PENDING.wire),
      attempts = j.optInt("attempts", 0),
      waitAttempts = j.optInt("waitAttempts", 0),
    )
  }

  /** 逐行折叠：同 requestId 后写覆盖前写（append-only 状态机的读侧）。 */
  fun fold(lines: List<String>): List<Decision> {
    val byId = LinkedHashMap<String, Decision>()
    for (line in lines) {
      val t = line.trim()
      if (t.isEmpty()) continue
      val d = parse(t) ?: continue
      byId[d.requestId] = d
    }
    return byId.values.toList()
  }

  /** 去重 LRU（同 requestId 只接受一次）。 */
  class Lru(private val capacity: Int = 64) {
    private val seen = LinkedHashSet<String>()

    @Synchronized
    fun accept(requestId: String): Boolean {
      if (seen.contains(requestId)) return false
      seen.add(requestId)
      while (seen.size > capacity) {
        val it = seen.iterator()
        it.next()
        it.remove()
      }
      return true
    }

    @Synchronized
    fun contains(requestId: String): Boolean = seen.contains(requestId)

    @Synchronized
    fun clear() {
      seen.clear()
    }
  }

  private val lru = Lru()

  // ── 落盘 ────────────────────────────────────────────────────────────────

  fun file(context: Context): File = File(context.filesDir, FILE_NAME)

  @Synchronized
  fun enqueue(context: Context, decision: Decision): Boolean {
    if (!lru.accept(decision.requestId)) {
      LogCollector.log(TAG, "decision ignored (requestId LRU): " + decision.requestId)
      return false
    }
    return try {
      val f = file(context)
      f.appendText(serialize(decision) + "\n")
      LogCollector.log(TAG, "decision queued: " + decision.requestId + " kind=" + decision.kind + " eventId=" + decision.eventId)
      if (f.length() > COMPACT_BYTES) compact(context)
      true
    } catch (t: Throwable) {
      LogCollector.log(TAG, "decision enqueue failed: " + t.message)
      false
    }
  }

  fun load(context: Context): List<Decision> {
    val f = file(context)
    if (!f.exists()) return emptyList()
    return try { fold(f.readLines()) } catch (_: Throwable) { emptyList() }
  }

  /** 状态变更：追加一行同 requestId 的新状态（读侧折叠）。 */
  @Synchronized
  fun mark(
    context: Context,
    decision: Decision,
    state: State,
    attempts: Int = decision.attempts,
    waitAttempts: Int = decision.waitAttempts,
  ) {
    try {
      file(context).appendText(
        serialize(decision.copy(state = state.wire, attempts = attempts, waitAttempts = waitAttempts)) + "\n",
      )
    } catch (t: Throwable) {
      LogCollector.log(TAG, "decision mark failed: " + t.message)
    }
  }

  /** 压缩：只保留未完成项（临时文件 + rename 原子替换）。 */
  @Synchronized
  fun compact(context: Context) {
    try {
      val f = file(context)
      val keep = load(context).filter { it.state == State.PENDING.wire || it.state == State.FAILED.wire }
      val tmp = File(f.parentFile, FILE_NAME + ".tmp")
      tmp.writeText(keep.joinToString("") { serialize(it) + "\n" })
      if (!tmp.renameTo(f)) f.writeText(tmp.readText())
      tmp.delete()
      LogCollector.log(TAG, "decision file compacted, kept=" + keep.size)
    } catch (t: Throwable) {
      LogCollector.log(TAG, "decision compact failed: " + t.message)
    }
  }

  // ── 投递 ────────────────────────────────────────────────────────────────

  /** 投递结果（NT-17 的三种可见终局）。 */
  enum class Flush { DELIVERED, WAITING, FAILED, EMPTY }

  /** 主线程 Handler 惰性创建（JVM 单测不碰 Looper）。 */
  private val handler: Handler by lazy { Handler(Looper.getMainLooper()) }

  @Volatile
  private var scheduled = false

  /**
   * NOT_READY（应答流/引擎未就绪）的统一处置：预算内 -> 独立计数 + 指数退避重排；
   * 超出墙钟预算 -> FAILED + 可见「提交失败，点击重试」。
   *
   * @return true = 已判失败（否则仍在等待）
   */
  private fun handleNotReady(context: Context, d: Decision, now: Long): Boolean {
    return when (notReadyAction(d.ts, now)) {
      WaitAction.FAIL -> {
        mark(context, d, State.FAILED, d.attempts, d.waitAttempts)
        NotifyCenter.postDeliveryFailure(context, d.kind, d.eventId, "提交失败", "提交失败，点击重试")
        LogCollector.log(
          TAG,
          "decision NOT_READY budget exhausted (" + NOT_READY_BUDGET_MS + "ms): " + d.requestId,
        )
        true
      }
      WaitAction.RETRY -> {
        val w = d.waitAttempts + 1
        mark(context, d, State.PENDING, d.attempts, w)
        scheduleRetry(context, w)
        LogCollector.log(TAG, "decision waiting (waitAttempts=" + w + "): " + d.requestId)
        false
      }
    }
  }

  /**
   * 尝试投递全部未完成决策（在**后台线程**调用）。
   * - 引擎/应答流未就绪 -> 独立退避等待，**超墙钟预算才** FAILED（引擎冷启动可 >60s）；
   * - HTTP 失败 -> 既有 MAX_ATTEMPTS 退避，耗尽 -> FAILED（通知改「提交失败，点击重试」）。
   */
  fun flush(context: Context): Flush {
    val pending = load(context).filter { it.state == State.PENDING.wire || it.state == State.FAILED.wire }
    if (pending.isEmpty()) return Flush.EMPTY
    val now = System.currentTimeMillis()
    if (!NotifyBridge.isReady()) {
      var failed = false
      for (d in pending) if (handleNotReady(context, d, now)) failed = true
      LogCollector.log(TAG, "decision flush waiting (bridge not ready): " + pending.size + " pending")
      return if (failed) Flush.FAILED else Flush.WAITING
    }
    var anyFailed = false
    for (d in pending) {
      val status = try {
        NotifyBridge.postResult(d.eventId, JSONObject(d.outcomeJson))
      } catch (_: Exception) {
        NotifyBridge.PostStatus.FAILED
      }
      when (status) {
        NotifyBridge.PostStatus.OK -> {
          mark(context, d, State.SUBMITTED, d.attempts)
          NotifyBridge.markSubmitted(d.eventId)
          // DEF-NOTIFY-03（设备实测）：提交成功必须**立即本地结算**——网关只给其它持有者发 cancel，
          // 提交者不会收到；不结算则通知停在「正在发送」（NT-16 判据）。
          NotifyBridge.markSettled(context, d.eventId, d.kind)
          LogCollector.log(TAG, "decision delivered: " + d.requestId)
        }
        NotifyBridge.PostStatus.NOT_READY -> {
          // 同一套预算/退避（独立计数）；到期转 FAILED 并可见
          if (handleNotReady(context, d, System.currentTimeMillis())) anyFailed = true
          return if (anyFailed) Flush.FAILED else Flush.WAITING
        }
        NotifyBridge.PostStatus.STALE -> {
          // 引擎重启导致 eventId 不在交付表：撤通知 + 明确提示，不重试、不静默
          markExpired(context, d)
          anyFailed = true
        }
        NotifyBridge.PostStatus.FAILED -> {
          val attempts = d.attempts + 1
          if (attempts >= MAX_ATTEMPTS) {
            mark(context, d, State.FAILED, attempts)
            NotifyCenter.postDeliveryFailure(context, d.kind, d.eventId, "提交失败", "提交失败，点击重试")
            anyFailed = true
            LogCollector.log(TAG, "decision failed after " + attempts + " attempts: " + d.requestId)
          } else {
            mark(context, d, State.PENDING, attempts)
            scheduleRetry(context, attempts)
            LogCollector.log(TAG, "decision retry scheduled attempt=" + attempts + " id=" + d.requestId)
          }
        }
      }
    }
    return if (anyFailed) Flush.FAILED else Flush.DELIVERED
  }

  /** 明确失效（引擎重启导致 eventId 不在交付表里）：撤通知 + 提示，不静默。 */
  fun markExpired(context: Context, decision: Decision) {
    mark(context, decision, State.EXPIRED)
    NotifyCenter.postDeliveryFailure(context, decision.kind, decision.eventId, "该请求已失效", "该请求已失效（引擎已重启），请重新发起")
  }

  /** 指数退避重试（<=60s）；同一时刻只排一个。 */
  @Synchronized
  fun scheduleRetry(context: Context, attempt: Int) {
    if (scheduled) return
    val delay = retryDelayMs(attempt)
    scheduled = true
    try {
      handler.postDelayed({
        scheduled = false
        Thread { flush(context.applicationContext) }.apply { isDaemon = true }.start()
      }, delay)
    } catch (t: Throwable) {
      scheduled = false
      LogCollector.log(TAG, "retry scheduling failed: " + t.message)
    }
    LogCollector.log(TAG, "decision retry in " + delay + "ms (attempt=" + attempt + ")")
  }

  /**
   * 触发点自愈（真缺陷修复，2026-09-13）：任何启动/装载路径都要重新评估滞留决策的预算并续排重试。
   *
   * 为什么必须后台线程：调用点在 EngineService.onCreate / 动作接收器（主线程），而 flush 里有
   * 文件 IO 与（可能就绪时的）同步 HTTP POST —— 主线程会 ANR / NetworkOnMainThread。
   */
  fun ensureScheduled(context: Context) {
    val app = context.applicationContext
    val t = Thread {
      try {
        val plan = resumePlan(load(app), System.currentTimeMillis())
        if (plan.expired.isEmpty() && plan.waiting.isEmpty()) return@Thread
        LogCollector.log(TAG, "resume trigger: expired=" + plan.expired.size + " waiting=" + plan.waiting.size)
        // flush 把到期的转 FAILED（含可见「提交失败，点击重试」）、未到期的续排退避
        flush(app)
        val pending = load(app).filter { it.state == State.PENDING.wire || it.state == State.FAILED.wire }
        if (pending.isNotEmpty() && !scheduled) scheduleRetry(app, pending.maxOf { it.waitAttempts })
      } catch (t2: Throwable) {
        LogCollector.log(TAG, "resume trigger failed: " + t2.message)
      }
    }
    t.isDaemon = true
    t.name = "notify-resume"
    t.start()
  }

  /** 重置（测试 / 停机清理用）。 */
  @Synchronized
  fun reset() {
    lru.clear()
    scheduled = false
  }
}
