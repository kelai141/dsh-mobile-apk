package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 控制队列客户端（0.13.5 W4，PRD-0.13.2 §3.3 B2；0.14.0 起由 [ControlCarrier] 持有）。
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
 * 0.14.0（承载拆离）：op 执行与心跳都改走注入面（[ControlCarrier]），不再绑定无障碍服务实例——
 * 无障碍关闭时 browser 与 vd 两组 op 仍可用；`caps.a11y` 如实上报无障碍处理器是否在场。
 *
 * 0.13.8 #181：
 * - 已执行 reqId 去重（有界 LRU）：重连/重投场景下同一请求绝不执行两次；
 * - 非 2xx 不再静默丢弃——读 errorStream 与 X-DSH-Control-* 响应头并记日志
 *   （409 = 双 settle 竞态的观测点；413 = 回填超限，真因首次可见）；
 * - 通用 catch 补日志（原先完全吞掉）。
 */
class ControlPoller(
  private val context: Context,
  private val handler: (String, JSONObject) -> JSONObject,
  private val capsExtra: () -> JSONObject = { JSONObject() },
  private val heartbeat: () -> Unit = { DeviceControlService.heartbeat(context) },
) {

  companion object {
    private const val TAG = "dsh-a11y"
    private val BASE: String get() = EngineEndpoint.url
    private const val LONG_POLL_MS = 5000
    private const val CONNECT_TIMEOUT_MS = 2000
    private const val READ_TIMEOUT_MS = 9000
    private const val IDLE_BACKOFF_MS = 1000L
    private const val MAX_BACKOFF_MS = 10_000L
    /** 已执行 reqId 去重集合容量（有界 LRU；4s 内的 in-flight 窗口远用不满 64 条）。 */
    private const val EXECUTED_LRU_CAPACITY = 64

    /**
     * 无障碍心跳节拍（0.14.10 §6.5）：2 秒 -> 5 秒。
     *
     * 为什么 5 秒够用：消费方（引擎侧 dsh-android-bridge）的新鲜窗口是
     * A11Y_FRESH_MS = 20_000（plugins/dsh-android-bridge/src/index.ts），5 秒一拍仍有
     * 4 倍余量。而每次心跳都是一次 SharedPreferences 的 edit().apply()（真要落盘），
     * 2 秒一拍等于每 2 秒一次无谓写盘——审计把这条列为可收敛的唤醒与 I/O。
     */
    internal const val HEARTBEAT_INTERVAL_MS = 5_000L

    /**
     * 心跳循环（0.14.10 §6.5）：节拍与等待均可注入 —— JVM 单测用假等待断言节奏，
     * 不 sleep 真实时间（用户口径明确要求）。
     *
     * 放在 companion 而不是实例方法：本循环只用参数，不碰实例状态；而 JVM 单测无法构造
     * Android Context，放实例上就永远测不到「先发一次心跳再等一拍」这个顺序契约。
     *
     * 顺序与旧实现一致：**先发一次心跳再等一拍**——服务刚连上时引擎侧立刻看到新鲜心跳，
     * 不会因为首拍多等 5 秒而被误判成「通道没起来」。
     */
    internal fun runHeartbeatLoop(
      isRunning: () -> Boolean,
      heartbeat: () -> Unit,
      intervalMs: Long = HEARTBEAT_INTERVAL_MS,
      waitMs: (Long) -> Unit = { ms ->
        try {
          Thread.sleep(ms)
        } catch (_: InterruptedException) {
          // 停机中断：置回中断位，外层 while 会因 running=false 退出。
          Thread.currentThread().interrupt()
        }
      },
    ) {
      while (isRunning()) {
        try {
          heartbeat()
        } catch (_: Throwable) {
        }
        waitMs(intervalMs)
      }
    }
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
    // 会把「服务在忙」误判成「掉线」并翻转 ADB 通道。独立心跳线程按
    // HEARTBEAT_INTERVAL_MS 一拍（0.14.10 §6.5 起由 2 秒降到 5 秒），与动作执行完全并行；
    // busy 态对引擎保持可见（ready/busy 语义）。
    heartbeatThread = Thread({
      runHeartbeatLoop(isRunning = { running.get() }, heartbeat = heartbeat)
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
    val token = DeviceControlService.token(context)
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
    // §6.2：控制请求在途 = 唤醒锁活动租约的三类事件之一。写在执行前后各一次，
    // 让整个执行窗（可能跨数十秒的建树/截屏）都算活动，而不是只有开始那一刻。
    noteWakeActivity()
    var outcome = try {
      runOp(op, args)
    } finally {
      noteWakeActivity()
    }
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
    val result = handler(op, args)
    val err = result.optString("__error", "")
    if (err.isNotEmpty()) JSONObject().put("ok", false).put("error", err)
    else JSONObject().put("ok", true).put("data", result)
  } catch (error: Throwable) {
    JSONObject().put("ok", false).put("error", "壳侧执行异常：" + (error.message ?: error.javaClass.simpleName))
  }

  /** 回填信封（§S2.2）：`pv` + `caps` 让引擎知道对面是懂协议的壳（版本协商 §S4）。 */
  private fun envelope(token: String, reqId: String, outcome: JSONObject): JSONObject {
    val caps = JSONObject()
      .put("ops", org.json.JSONArray(ControlProtocolV2.SUPPORTED_OPS as Collection<*>))
      .put("view", org.json.JSONArray(listOf("all", "target")))
      .put("gz", false)
    // 0.14.0 承载拆离：caps 追加承载者事实（如 a11y 处理器是否在场）——扩展键不覆盖协议键。
    val extra = capsExtra()
    for (key in extra.keys()) caps.put(key, extra.get(key))
    return JSONObject()
      .put("token", token)
      .put("reqId", reqId)
      .put("ok", outcome.optBoolean("ok", false))
      .put("pv", ControlProtocolV2.PV)
      .put("caps", caps)
      .put("data", outcome.opt("data"))
      .put("error", outcome.optString("error", ""))
  }

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

  /**
   * §6.2：控制请求在途时刷新唤醒锁活动租约。
   *
   * 为什么由本类刷新而不是等看门狗下一拍：看门狗一拍最长 20 秒（健康态降频后），
   * 若一条 op 正好跨越租约到期点，唤醒锁会在一段真在干活的时间里被放掉。这里直接
   * 记租约；引擎服务若在跑，同一入口会顺手把锁重取回来（有事件立即重取）。
   */
  private fun noteWakeActivity() {
    try {
      WatchdogV2.WakeActivityLease.note()
      EngineService.instance?.noteWakeActivity()
    } catch (_: Throwable) {
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
