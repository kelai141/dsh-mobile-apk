package com.dsharnessmobile.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * 通知应答器（0.14.0-preview §6.3.1 / NT-11..14）：**独立于悬浮球**的 $events 流。
 *
 * 为什么另开一条流：唯一 startMux() 调用点在 OverlayService.kt（悬浮球），关掉悬浮球后
 * 引擎的提问/审批不产生任何可见提示、也没有 clientId 可结算。网关语义允许再开一条：
 * 新流 open 时把所有 pending waterfall 重放给新 client（gateway index.ts:421/:510），
 * 首个应答者结算、其余收 cancel（:522-541/:565-576），重复应答幂等 no-op（:527-529）。
 * 因此本文件**不需要改引擎**，也不复用 OverlayPanel 的 clientId。
 *
 * 与悬浮球的分工：两条流同时在线时谁先答谁生效；本侧收到 cancel 帧即撤通知（NT-13）。
 *
 * 动作处理器全程不 startActivity（trampoline 禁令）；投递经 [postResult]（必须后台线程调用）。
 */
object NotifyBridge {

  const val TAG = "dsh-notify-mux"
  const val STREAM_ID = "dsh-notify-responder"
  private const val HOST = "127.0.0.1"
  private const val PORT = 3080
  private const val PATH = "/api/remote.mux"

  /** 投递终局（NT-17：失败必须可见，不得只写日志）。 */
  enum class PostStatus {
    /** HTTP 200：网关已受理（首个应答者结算）。 */
    OK,
    /** 流未 ready（无 clientId）——等重试。 */
    NOT_READY,
    /** 网关判定该 eventId 不在交付表（引擎重启后失效）——撤通知并提示，不重试。 */
    STALE,
    /** 网络/服务端错误——按退避重试。 */
    FAILED,
  }

  /** 一条在架交互（诊断与对账用）。 */
  class Pending(
    val eventId: String,
    val kind: String,
    val agentId: String,
    val toolName: String,
    val summary: String,
  ) {
    @Volatile var state: String = "pending"
    @Volatile var generation: Int = 0
  }

  private var mux: MuxClient? = null
  private var appContext: Context? = null

  @Volatile
  private var clientId = ""

  @Volatile
  private var generation = 0

  private val pending = LinkedHashMap<String, Pending>()

  private val handler: Handler by lazy { Handler(Looper.getMainLooper()) }

  // ── DEF-NOTIFY-02 可观测性：设备复验靠 files/notify-responder.log 判定断在哪一段 ──
  // 「未启动 / 已启动但未 ready / ready 但无 waterfall / 有 waterfall 但投递被拒」四种断点
  // 各自留下不同行，不再依赖调试日志采集器是否开启。
  @Volatile private var frames = 0
  @Volatile private var waterfalls = 0
  @Volatile private var lastFrameAt = 0L
  private var heartbeat: Thread? = null

  private fun probe(msg: String) {
    NotifyProbe.log(appContext, TAG, msg)
  }

  /** 幂等启动（进程级）。 */
  @Synchronized
  fun start(context: Context) {
    if (mux != null) return
    appContext = context.applicationContext
    try {
      mux = MuxClient(HOST, PORT, PATH, { text -> onFrame(text) }, STREAM_ID)
    } catch (t: Throwable) {
      probe("responder start FAILED: " + t)
      return
    }
    probe("responder started (streamId=" + STREAM_ID + ")")
    // 触发点自愈（真缺陷修复）：进程死亡会带走重试定时器；启动路径必须重评滞留决策的预算，
    // 否则「引擎/应答流一直不就绪」时决策会永久滞留 pending（既不补投也不出现可见失败）。
    NotifyDecisionQueue.ensureScheduled(context)
    if (heartbeat == null) {
      val t = Thread {
        var waited = 0L
        while (true) {
          // 未 ready 时前 2 分钟每 5s 一条（覆盖连接建立期），之后每 5 分钟一条
          val step = if (!isReady() && waited < 120_000L) 5_000L else 300_000L
          try {
            Thread.sleep(step)
          } catch (_: InterruptedException) {
            break
          }
          waited += step
          probe(
            "alive ready=" + isReady() + " frames=" + frames + " waterfalls=" + waterfalls +
              " pending=" + pendingSnapshot().size,
          )
        }
      }
      t.isDaemon = true
      t.name = "notify-probe"
      t.start()
      heartbeat = t
    }
  }

  @Synchronized
  fun stop() {
    mux?.close()
    mux = null
    clientId = ""
    synchronized(pending) { pending.clear() }
  }

  fun isReady(): Boolean = clientId.isNotEmpty()

  fun pendingSnapshot(): List<Pending> = synchronized(pending) { pending.values.toList() }

  /** 标记已提交（幂等状态机 pending -> submitted）。 */
  fun markSubmitted(eventId: String) {
    synchronized(pending) { pending[eventId]?.state = "submitted" }
  }

  /**
   * 标记已结算并撤通知（cancel 帧 / 本地投递成功后的收尾）。
   *
   * DEF-NOTIFY-03（设备实测）：网关只给**其它**持有者发 cancel 帧，提交者自己不会收到——
   * 通知栏回复成功后若不本地结算，通知会一直停在「正在发送」并留着可再点的回复框。
   * 因此这里**无条件撤通知**（不依赖 pending 表是否还有该条目：进程重启后 map 会丢）。
   *
   * @param kind 交互类型（question/approval）；缺省取 pending 表里的记录，再兜底 question
   * @return pending 表里是否确有该条目（false = 已被撤/从未登记，仍已撤通知）
   */
  fun markSettled(context: Context, eventId: String, kind: String? = null): Boolean {
    val p = synchronized(pending) { pending.remove(eventId) }
    val k = kind ?: p?.kind ?: "question"
    p?.state = "settled"
    // DEF-NOTIFY-03b：经 RemoteInput 回复过的通知会被平台锁住（LIFETIME_EXTENDED_BY_DIRECT_REPLY），
    // 直接 cancel 无效——必须重投一次再撤，故统一走 settleInteractive。
    NotifyCenter.settleInteractive(context, k, eventId)
    LogCollector.log(TAG, "settled(eventId=" + eventId + " kind=" + k + " tracked=" + (p != null) + ")")
    return p != null
  }

  private fun faceOf(kind: String): NotifyCenter.Face =
    if (kind == "approval") NotifyCenter.Face.APPROVAL else NotifyCenter.Face.QUESTION

  // ── 下行帧 ──────────────────────────────────────────────────────────────

  internal fun onFrame(text: String) {
    val ctx = appContext ?: return
    frames++
    lastFrameAt = System.currentTimeMillis()
    val j = try { JSONObject(text) } catch (_: Exception) {
      probe("bad frame (not json): " + text.take(80))
      return
    }
    val frameType = j.optString("type")
    try {
      when (frameType) {
        "item" -> {
          val value = j.optJSONObject("value") ?: return
          handleValue(ctx, value)
        }
        "end", "error" -> {
          // 服务端终止流：重建连接（MuxClient 的重连循环处理 socket 错误，这里处理 end 帧）
          probe("stream " + frameType + " -> reconnect")
          val old = mux
          mux = null
          clientId = ""
          old?.close()
          // 退避 1s 再重连：服务端连续发 end 时不许热循环（旧实现立即重连，会打满 CPU/日志）
          handler.postDelayed({ start(ctx) }, 1_000)
        }
        else -> probe("frame type=" + frameType)
      }
    } catch (t: Throwable) {
      // DEF-NOTIFY-02：单帧异常绝不能杀死 MuxClient 的读线程——旧实现里异常会冒到 frameLoop，
      // 整条应答流反复重连，之后所有提问/审批通知一起消失（只留一行 Log.w）。
      // 这里吞掉并落探针，连接保持，后续帧照常处理。
      probe("frame handling THREW type=" + frameType + ": " + t)
    }
  }

  private fun handleValue(context: Context, value: JSONObject) {
    when (value.optString("type")) {
      "ready" -> {
        clientId = value.optString("clientId", "")
        val gen = ++generation
        probe("ready gen=" + gen + " clientIdSet=" + clientId.isNotEmpty())
        // 断线宽限期对账：引擎只重发仍 pending 的事件，未被重发的旧条目判过期（同 OverlayPanel 语义）
        val stale = synchronized(pending) { pending.keys.toList() }
        handler.postDelayed({
          var dropped = 0
          for (id in stale) {
            val p = synchronized(pending) { pending[id] }
            if (p != null && p.generation < gen) {
              markSettled(context, id)
              dropped++
            }
          }
          if (dropped > 0) LogCollector.log(TAG, "stale interactions dropped after reconnect: " + dropped)
        }, 3_000)
        // 引擎就绪 -> 补投耐久队列（NT-17：停引擎后动作在 <=60s 内送达）
        Thread { NotifyDecisionQueue.flush(context) }.apply { isDaemon = true }.start()
      }
      "waterfall" -> {
        val event = value.optString("event")
        val eventId = value.optString("eventId")
        val agentId = value.optString("agentId")
        val request = value.optJSONObject("request") ?: run {
          probe("waterfall without request payload: event=" + event + " eventId=" + eventId)
          return
        }
        if (eventId.isEmpty()) return
        waterfalls++
        probe("waterfall event=" + event + " eventId=" + eventId + " agentIdLen=" + agentId.length)
        val gen = generation
        when (event) {
          "approval/request" -> {
            val toolName = request.optString("toolName", "")
            val reason = request.optString("reason", "")
            synchronized(pending) {
              pending[eventId] = Pending(eventId, "approval", agentId, toolName, reason).also { it.generation = gen }
            }
            val posted = NotifyCenter.notifyEvent(
              context,
              NotifyEntry(kind = "approval", eventId = eventId, toolName = toolName, reason = reason, target = agentId),
              foreground = NotifyStore.isForeground(context),
            )
            probe("notify kind=approval eventId=" + eventId + " result=" + posted)
          }
          "user-questions/request" -> {
            val questions = parseQuestions(request.optJSONArray("questions"))
            val first = questions.firstOrNull()
            synchronized(pending) {
              pending[eventId] = Pending(eventId, "question", agentId, "", first?.question ?: "").also { it.generation = gen }
            }
            val posted = NotifyCenter.notifyEvent(
              context,
              NotifyEntry(kind = "question", eventId = eventId, questions = questions, target = agentId),
              foreground = NotifyStore.isForeground(context),
            )
            probe("notify kind=question eventId=" + eventId + " questions=" + questions.size + " result=" + posted)
          }
          else -> Unit
        }
      }
      "cancel" -> {
        // 引擎侧权威：该待答已结清（谁答的都算）——撤通知（NT-13 的核心判据）
        val id = value.optString("eventId")
        if (id.isNotEmpty()) {
          val settled = markSettled(context, id)
          probe("cancel(eventId=" + id + ") settled=" + settled)
        }
      }
    }
  }

  /** waterfall request 的 questions 数组 → 通知条目（只重建展示所需字段）。 */
  fun parseQuestions(arr: JSONArray?): List<NotifyQuestion> {
    if (arr == null) return emptyList()
    val out = ArrayList<NotifyQuestion>(arr.length())
    for (i in 0 until arr.length()) {
      val q = arr.optJSONObject(i) ?: continue
      val options = ArrayList<String>()
      q.optJSONArray("options")?.let { opts ->
        for (k in 0 until opts.length()) {
          val o = opts.optJSONObject(k)
          val label = if (o != null) o.optString("label", "") else opts.optString(k, "")
          if (label.isNotEmpty()) options.add(label)
        }
      }
      out.add(
        NotifyQuestion(
          id = q.optString("id", "q" + i),
          header = q.optString("header", ""),
          question = q.optString("question", ""),
          options = options,
        ),
      )
    }
    return out
  }

  // ── 上行投递（必须在后台线程调用）────────────────────────────────────────

  /**
   * POST /api/$events/result（与 OverlayPanel 同协议：client-request 信封 + args.{clientId,eventId,outcome}）。
   * 用本流自己的 clientId——首个应答者结算，另一方收 cancel。
   */
  fun postResult(eventId: String, outcome: JSONObject): PostStatus {
    val cid = clientId
    val ctx = appContext
    if (cid.isEmpty() || ctx == null) return PostStatus.NOT_READY
    return try {
      val payload = JSONObject()
        .put("args", JSONObject().put("clientId", cid).put("eventId", eventId).put("outcome", outcome))
      val envelope = JSONObject()
        .put("type", "client-request")
        .put("rpcId", "notify-event-" + System.currentTimeMillis())
        .put("method", "\$events/result")
        .put("payload", payload)
      var code = -1
      for (attempt in 0..1) {
        val conn = URL("http://" + HOST + ":" + PORT + "/api/\$events/result")
          .openConnection(Proxy.NO_PROXY) as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 3000
        conn.readTimeout = 8000
        conn.setRequestProperty("content-type", "application/json")
        EngineAuth.attach(ctx, conn)
        conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
        code = conn.responseCode
        if (code == 401 && attempt == 0) {
          conn.disconnect()
          EngineAuth.handleUnauthorized(ctx)
          continue
        }
        conn.disconnect()
        break
      }
      when (code) {
        200 -> PostStatus.OK
        404, 410 -> PostStatus.STALE
        else -> {
          LogCollector.log(TAG, "postResult failed: eventId=" + eventId + " code=" + code)
          PostStatus.FAILED
        }
      }
    } catch (t: Throwable) {
      LogCollector.log(TAG, "postResult error: eventId=" + eventId + " " + t.message)
      PostStatus.FAILED
    }
  }
}
