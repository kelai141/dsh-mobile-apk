package com.dsharnessmobile.shell

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 无障碍控制队列客户端（0.13.5 W4，PRD-0.13.2 §3.3 B2）。
 *
 * 方向：引擎侧是服务端（`/api/android/ui/pending` + `/api/android/ui/result`），
 * 本类在壳侧**长轮询**取活并回填结果。长轮询（默认 5s）比 500ms 短轮询更轻：
 * 空闲时每 5 秒一次请求，有活时引擎侧立即唤醒 → 延迟接近 0。
 *
 * 失败关闭：取活/回填任何异常只记录并退避重试，不猜测、不重放动作。
 * 引擎未起时退避到 10s，避免空转耗电。
 *
 * 0.13.8 F1b（协议 V2 / 降级阶梯 L1）：
 * - 回填信封带 `pv`（协议版本）与 `caps`（能力声明：ops 列表 + view 支持）——引擎据此把
 *   「新壳 + 老引擎」变成一次带指引的失败，而不是静默空树（§S4）；
 * - `snapshot` 请求的 `view` 由引擎下推（args.view），壳侧照做；
 * - 回填 413（too_large）不沉默也不退避：按 L1 阶梯自动改 `view="target"` 重跑一次，
 *   仍超限则如实回填失败（L4「放弃但必须回填」，绝不静默）。
 *
 * 0.13.8 #181：
 * - 已执行 reqId 去重（有界 LRU）：重连/重投场景下同一请求绝不执行两次；
 * - 非 2xx 不再静默丢弃——读 errorStream 与 X-DSH-Control-* 响应头并记日志
 *   （409 = 双 settle 竞态的观测点；413 = 回填超限，真因首次可见）；
 * - 通用 catch 补日志（原先完全吞掉）。
 */
class ControlPoller(private val service: DeviceControlService) {

  companion object {
    private const val TAG = "dsh-a11y"
    private const val BASE = "http://127.0.0.1:3080"
    private const val LONG_POLL_MS = 5000
    private const val CONNECT_TIMEOUT_MS = 2000
    private const val READ_TIMEOUT_MS = 9000
    private const val IDLE_BACKOFF_MS = 1000L
    private const val MAX_BACKOFF_MS = 10_000L
    /** 已执行 reqId 去重集合容量（有界 LRU；4s 内的 in-flight 窗口远用不满 64 条）。 */
    private const val EXECUTED_LRU_CAPACITY = 64
  }

  private val running = AtomicBoolean(false)
  private var thread: Thread? = null
  private var heartbeatThread: Thread? = null
  private val executed = object : LinkedHashMap<String, Boolean>(EXECUTED_LRU_CAPACITY, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean = size > EXECUTED_LRU_CAPACITY
  }

  fun start() {
    if (!running.compareAndSet(false, true)) return
    thread = Thread({ loop() }, "dsh-control-poller").also {
      it.isDaemon = true
      it.start()
    }
    // 0.13.8 E3（V2 D2）：心跳与执行解耦——原实现心跳只在轮询循环里刷新，慢建树
    // 会把「服务在忙」误判成「掉线」并翻转 ADB 通道。独立心跳线程 2s 一拍，
    // 与动作执行完全并行；busy 态对引擎保持可见（ready/busy 语义）。
    heartbeatThread = Thread({
      while (running.get()) {
        try {
          DeviceControlService.heartbeat(service)
        } catch (_: Throwable) {
        }
        sleep(2_000)
      }
    }, "dsh-a11y-heartbeat").also {
      it.isDaemon = true
      it.start()
    }
  }

  fun stop() {
    running.set(false)
    thread?.interrupt()
    thread = null
    heartbeatThread?.interrupt()
    heartbeatThread = null
  }

  private fun loop() {
    var backoff = IDLE_BACKOFF_MS
    val token = DeviceControlService.token(service)
    while (running.get()) {
      try {
        val poll = post(
          "/api/android/ui/pending",
          JSONObject().put("token", token).put("waitMs", LONG_POLL_MS),
        )
        if (poll.body == null || !poll.body.optBoolean("ok", false)) {
          sleep(backoff)
          backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
          continue
        }
        backoff = IDLE_BACKOFF_MS
        // 心跳由独立线程维护（E3 解耦）；轮询本身也顺带证明通道活着（lastTakeAt）
        val request = poll.body.optJSONObject("req") ?: continue
        execute(token, request)
      } catch (interrupted: InterruptedException) {
        return
      } catch (error: Exception) {
        // 0.13.8 #181：通用异常不再静默吞掉——退避照旧，但原因必须可查
        LogCollector.log(TAG, "poll loop error: " + (error.message ?: error.javaClass.simpleName))
        sleep(backoff)
        backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
      }
    }
  }

  private fun execute(token: String, request: JSONObject) {
    val reqId = request.optString("reqId", "")
    if (reqId.isEmpty()) return
    // 0.13.8 #181：同一 reqId 只执行一次（有界 LRU；引擎侧 in-flight 门禁之外的壳侧兜底）
    val firstRun = synchronized(executed) { executed.put(reqId, true) == null }
    if (!firstRun) {
      LogCollector.log(TAG, "duplicate delivery skipped (reqId=$reqId) — engine re-delivered an in-flight request")
      return
    }
    val op = request.optString("op", "")
    val args = request.optJSONObject("args") ?: JSONObject()
    var outcome = runOp(op, args)
    var envelope = envelope(token, reqId, outcome)
    var posted = post("/api/android/ui/result", envelope)
    // L1 降级阶梯（§S1.4）：回填超限先收窄口径重跑一次——snapshot 才有 view 可选，
    // 其余 op 的结果体量由工具层控制。仍超限则把失败如实回填（L4：放弃但必须回填）。
    if (posted.tooLarge && op == "snapshot") {
      LogCollector.log(TAG, "result too_large ($op) — L1 fallback: retry with view=target")
      args.put("view", "target")
      outcome = runOp(op, args)
      envelope = envelope(token, reqId, outcome)
      posted = post("/api/android/ui/result", envelope)
      if (posted.tooLarge) {
        LogCollector.log(TAG, "result still too_large after L1 fallback ($op) — reporting failure upstream")
      }
    }
    if (posted.body == null && posted.httpCode > 0) {
      // 回填失败不能沉默：模型侧会看到超时，日志里必须留下真因（L4）
      LogCollector.log(TAG, "result post failed for $op (HTTP ${posted.httpCode} ${posted.controlCode})")
    }
  }

  /** 执行一次 op，归一成 {ok, data|error} 结果体。 */
  private fun runOp(op: String, args: JSONObject): JSONObject = try {
    val result = service.handle(op, args)
    val err = result.optString("__error", "")
    if (err.isNotEmpty()) JSONObject().put("ok", false).put("error", err)
    else JSONObject().put("ok", true).put("data", result)
  } catch (error: Throwable) {
    JSONObject().put("ok", false).put("error", "壳侧执行异常：" + (error.message ?: error.javaClass.simpleName))
  }

  /** 回填信封（§S2.2）：`pv` + `caps` 让引擎知道对面是懂协议的壳（版本协商 §S4）。 */
  private fun envelope(token: String, reqId: String, outcome: JSONObject): JSONObject = JSONObject()
    .put("token", token)
    .put("reqId", reqId)
    .put("ok", outcome.optBoolean("ok", false))
    .put("pv", ControlProtocolV2.PV)
    .put(
      "caps",
      JSONObject()
        .put("ops", org.json.JSONArray(ControlProtocolV2.SUPPORTED_OPS as Collection<*>))
        .put("view", org.json.JSONArray(listOf("all", "target")))
        .put("gz", false),
    )
    .put("data", outcome.opt("data"))
    .put("error", outcome.optString("error", ""))

  /**
   * POST JSON 并解析响应；非 2xx 读 errorStream + X-DSH-Control-* 头后返回 null（调用方退避）。
   * 0.13.8 P0-1：非 2xx 的真因（401/403/413/409 + 字节数/上限）首次进日志，不再静默。
   */
  /** POST 结果：成功带响应体；失败带 HTTP 状态与 `X-DSH-Control-Code`（阶梯判定用）。 */
  private class PostResult(val body: JSONObject?, val httpCode: Int, val controlCode: String) {
    val ok: Boolean get() = body != null
    val tooLarge: Boolean get() = httpCode == 413 || controlCode == "too_large"
  }

  private fun post(path: String, body: JSONObject): PostResult {
    val connection = URL(BASE + path).openConnection(Proxy.NO_PROXY) as HttpURLConnection
    return try {
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
      val code = connection.responseCode
      if (code !in 200..299) {
        val errText = connection.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
        val ctrlCode = connection.headerFields?.get("x-dsh-control-code")?.firstOrNull() ?: ""
        val bytes = connection.headerFields?.get("x-dsh-control-bytes")?.firstOrNull() ?: ""
        val limit = connection.headerFields?.get("x-dsh-control-limit")?.firstOrNull() ?: ""
        LogCollector.log(
          TAG,
          "POST $path -> HTTP $code" +
            (if (ctrlCode.isNotEmpty()) " code=$ctrlCode bytes=$bytes limit=$limit" else "") +
            (if (errText.isNotEmpty()) " body=" + errText.take(200) else ""),
        )
        PostResult(null, code, ctrlCode)
      } else {
        val text = BufferedReader(InputStreamReader(connection.inputStream, Charsets.UTF_8)).use { it.readText() }
        PostResult(if (text.isEmpty()) JSONObject() else JSONObject(text), code, "")
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun sleep(ms: Long) {
    try {
      Thread.sleep(ms)
    } catch (interrupted: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }
}
