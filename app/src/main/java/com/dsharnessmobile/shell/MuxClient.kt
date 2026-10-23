package com.dsharnessmobile.shell

import android.os.SystemClock
import android.util.Base64
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 极简 WebSocket 客户端（0.13.3 W3 传输面重做，0.13.2 版为 /api/events.mux 单向下行）：
 * 连引擎网关流复用器 ws://127.0.0.1:4145/api/remote.mux（dsh-api-gateway，
 * REMOTE_STREAM_MUX_PATH），open `$events` 逻辑流转发审批/提问 waterfall 帧与
 * api-session/status emit 帧。应答走 HTTP POST /api/$events/result（OverlayPanel）。
 *
 * 协议事实（以 0.1.2-rc.1 dsh-api-gateway/lib/{index,client}.js 核实）：
 * - WS upgrade 请求过 connection.requestRejection → 必须带浏览器 Cookie（W2 EngineAuth；
 *   每次连接尝试现取，401 类拒绝由重连循环自然吃到刷新后的 cookie）。
 * - 客户端唯一合法消息：`{type:"open",streamId,endpoint,payload}`（exactKeys）与
 *   `{type:"cancel",streamId}`；本端连上后发一次
 *   `{type:"open",streamId:"dsh-overlay-<pid>",endpoint:"$events",payload:{args:{}}}`。
 * - 服务端帧：`{type:"item",streamId,value}`（value=流事件）/{type:"end"}/{type:"error"}；
 *   $events 首 item value = `{type:"ready",clientId,host:{home}}`（clientId 据此记录）。
 *   事件 item value：`{type:"waterfall",event,eventId,agentId,request}`（approval/request、
 *   user-questions/request）与 `{type:"emit",event,args}`（api-session/status 等）。
 * - 心跳：网关 setInterval 发 WS ping，客户端 pong 缺席会被 terminate——本端 ping→pong 兜底保留。
 * - 服务端帧恒不掩码；客户端帧（含 open 文本帧）必须掩码。
 *
 * 断线 1s 起步指数退避重连（上限 10s）；close() 终止。onFrame 在客户端线程回调（上层自行 post 主线程）。
 */
class MuxClient(
  private val host: String,
  private val port: Int,
  private val path: String,
  private val onFrame: (String) -> Unit,
  /** $events 流的 streamId（gateway 仅要求非空字符串；单连接内唯一即可）。
   *  默认 = 既有悬浮球流；通知应答器用 dsh-notify-responder 另开一条（§6.3.1）。 */
  streamId: String = STREAM_ID,
) {
  companion object {
    private const val TAG = "dsh-overlay-mux"
    private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    private const val MAX_FRAME = 8 * 1024 * 1024
    /** $events 流的默认 streamId（悬浮球）。 */
    const val STREAM_ID = "dsh-overlay-events"
  }

  private val streamOpen =
    "{\"type\":\"open\",\"streamId\":\"" + streamId + "\",\"endpoint\":\"\$events\",\"payload\":{\"args\":{}}}"

  @Volatile
  private var running = true
  private var socket: Socket? = null
  private val textBuf = ByteArrayOutputStream()

  init {
    Thread { loop() }.apply { isDaemon = true; name = "overlay-mux" }.start()
  }

  fun close() {
    running = false
    try { socket?.close() } catch (_: Exception) {}
  }

  /**
   * 重连循环（0.14.10 审计 §6.6 重做退避与节流）。
   *
   * 旧实现有**三个**缺陷，且互相掩盖：
   *  ① `backoff` 在失败分支里**从不被读取的起点**上翻倍：catch 里只打日志，随后 sleep 的是
   *     **上一轮**的 backoff，sleep 完才翻倍 —— 首败 sleep 1s、次败 sleep 2s，看起来对，
   *     但「失败耗时本身」（connect 3s 超时 + 握手读）从不计入间隔，于是引擎未监听时
   *     两次尝试的真实间隔 ≈ 失败耗时 + backoff，看起来「退避没拉开」；
   *  ② 冷启动窗口的起步间隔太短：引擎从 spawn 到 LISTEN 实测 6.4-9.1 秒（审计 §3.1），
   *     而 1s 起步意味着这 7 秒里白建 7 次 socket、白打 7 行日志；
   *  ③ 注释里写着「首败 + 每分钟一条节流」，代码里却是**每次失败都 Log.w**——注释承诺的
   *     节流从未落地。
   *
   * 现在的口径（三条各自可被单测反证，见 MuxBackoffPolicyTest）：
   *  - 退避**按失败次数**算（[muxBackoffMs]），与「上一次尝试是什么时候」无关——后者正是旧
   *    实现的错误来源；
   *  - 起步间隔 [MUX_BACKOFF_FIRST_MS]（引擎未就绪时的冷启动窗口）；
   *  - 日志节流由 [muxShouldLogFailure] 决定：首次一条，之后每分钟一条，其余静默。
   *
   * **不变**：正常收到 close 帧（[connectAndServe] 正常返回）⇒ 立刻重置失败计数并快速重连。
   * 那是服务端主动收流，与「引擎根本没起来」是两回事，不该一起退避。
   */
  private fun loop() {
    var failures = 0
    var lastLoggedAt = 0L
    while (running) {
      var gracefulClose = false
      try {
        connectAndServe()
        // connectAndServe 正常返回 = 本端 close() 之后 frameLoop 的 while(running) 自行退出。
        if (!running) return
        gracefulClose = true
      } catch (closed: MuxServerClosedException) {
        // **服务端主动收流**（close 帧）：与「引擎没起来」是两回事，保持快速重连不变。
        if (!running) return
        gracefulClose = true
        Log.i(TAG, "mux server closed the stream; reconnecting")
      } catch (e: Exception) {
        if (!running) return
        failures++
        // 失败必须可见，但**不得**每次失败都打：引擎冷启动前的 refused 是预期噪音（审计 §6.6）。
        val now = SystemClock.elapsedRealtime()
        if (muxShouldLogFailure(failures, lastLoggedAt, now)) {
          lastLoggedAt = now
          Log.w(TAG, "mux attempt failed (#" + failures + ", retry in " + muxBackoffMs(failures) / 1000 + "s): " + e.message)
        }
      }
      if (!running) return
      val delay = muxReconnectDelayMs(failures, gracefulClose)
      if (gracefulClose) {
        // 正常收流 ⇒ 失败计数归零，下一轮若真连不上重新从起步档退避。
        failures = 0
        lastLoggedAt = 0L
      }
      try { Thread.sleep(delay) } catch (_: InterruptedException) { return }
    }
  }

  private fun connectAndServe() {
    // Capture one immutable endpoint per connection, rather than the constructor's old port.
    val activePort = if (host == EngineEndpoint.HOST) EngineEndpoint.port else port
    if (activePort <= 0) throw java.io.IOException("engine endpoint is not bound")
    val s = Socket()
    s.connect(InetSocketAddress(host, activePort), 3000)
    socket = s
    val key = Base64.encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) }, Base64.NO_WRAP)
    // W3：upgrade 同过 connection 鉴权栅栏——握手带浏览器 Cookie（现取，重连吃到刷新后的值）。
    // 雷区 5：不带 Origin/sec-fetch-site（多余的头反而触发 Host 栅栏交叉校验失败）。
    val cookie = EngineAuth.attachMux() ?: ""
    val cookieHeader = if (cookie.isNotEmpty()) "Cookie: $cookie\r\n" else ""
    val out = s.getOutputStream()
    out.write((
      "GET $path HTTP/1.1\r\nHost: $host:$activePort\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n" + cookieHeader + "\r\n"
      ).toByteArray(Charsets.US_ASCII))
    out.flush()
    val ins = BufferedInputStream(s.getInputStream())
    var status = ""
    var accept: String? = null
    while (true) {
      val line = readLine(ins) ?: throw Exception("handshake eof")
      if (line.isEmpty()) break
      if (status.isEmpty()) status = line
      else {
        val ci = line.indexOf(':')
        if (ci > 0 && line.substring(0, ci).trim().lowercase() == "sec-websocket-accept") {
          accept = line.substring(ci + 1).trim()
        }
      }
    }
    val code = muxHandshakeStatusCode(status)
    if (code != 101) {
      // ST-13（F-APK-03）：握手被拒走的是同一道 cookie 栅栏（connection.requestRejection）。
      // 旧实现只 throw：重连循环会拿着**服务端已作废、本地却仍未过期**的 cookie 无限重试
      // （EngineAuth.stillValid 只看 expiresAt），表现为「手动失效 cookie 后审批卡/提问卡
      // 再也不弹，必须重启 App」。现在按状态码走 handleUnauthorized：丢缓存 + 强制刷新。
      if (muxRefusalNeedsAuthRefresh(code)) {
        Log.w(TAG, "mux handshake refused " + code + ": invalidating + refreshing engine cookie")
        EngineAuth.handleUnauthorizedBound()
      }
      throw Exception("handshake refused: $status")
    }
    if (accept != expectedAccept(key)) throw Exception("bad sec-websocket-accept")
    // 连上即 open $events 流（服务端无 open 不会转发任何事件）
    sendFrame(out, 0x1, streamOpen.toByteArray(Charsets.UTF_8))
    Log.i(TAG, "mux connected ($path, \$events open, streamId=" + streamOpen.length + "b)")
    frameLoop(ins, out)
  }

  private fun expectedAccept(key: String): String {
    val d = MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.US_ASCII))
    return Base64.encodeToString(d, Base64.NO_WRAP)
  }

  private fun readLine(ins: BufferedInputStream): String? {
    val buf = ByteArrayOutputStream(64)
    while (true) {
      val b = ins.read()
      if (b < 0) return if (buf.size() == 0) null else buf.toString("US-ASCII")
      if (b == '\n'.code) break
      if (b != '\r'.code) buf.write(b)
    }
    return buf.toString("US-ASCII")
  }

  private fun frameLoop(ins: BufferedInputStream, out: java.io.OutputStream) {
    while (running) {
      val b0 = ins.read(); if (b0 < 0) throw Exception("eof")
      val b1 = ins.read(); if (b1 < 0) throw Exception("eof")
      val fin = b0 and 0x80 != 0
      val opcode = b0 and 0x0F
      val masked = b1 and 0x80 != 0
      var len = (b1 and 0x7F).toLong()
      if (len == 126L) {
        val h = ins.read(); val l = ins.read()
        if (h < 0 || l < 0) throw Exception("eof")
        len = ((h and 0xFF).toLong() shl 8) or (l and 0xFF).toLong()
      } else if (len == 127L) {
        len = 0
        for (i in 0 until 8) {
          val b = ins.read(); if (b < 0) throw Exception("eof")
          len = (len shl 8) or (b.toLong() and 0xFF)
        }
      }
      if (len > MAX_FRAME) throw Exception("frame too big: $len")
      val mask = if (masked) ByteArray(4).also { readN(ins, it) } else null
      val payload = ByteArray(len.toInt()).also { readN(ins, it) }
      if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
      when (opcode) {
        0x1 -> { textBuf.reset(); textBuf.write(payload); if (fin) emitText() }
        0x0 -> { textBuf.write(payload); if (fin) emitText() }
        // 服务端**正常**收流（close 帧）：这不是「连不上」，必须与失败分开处理——
        // 见 [MuxServerClosedException] 与重连循环里的快速重连分支。
        0x8 -> { sendFrame(out, 0x8, payload); throw MuxServerClosedException("server close") }
        0x9 -> sendFrame(out, 0xA, payload) // ping → pong（网关心跳，缺席会被 terminate）
        0xA -> {} // pong：忽略
        else -> {}
      }
    }
  }

  private fun emitText() {
    val s = String(textBuf.toByteArray(), Charsets.UTF_8)
    textBuf.reset()
    onFrame(s)
  }

  private fun readN(ins: BufferedInputStream, buf: ByteArray) {
    var off = 0
    while (off < buf.size) {
      val n = ins.read(buf, off, buf.size - off)
      if (n < 0) throw Exception("eof")
      off += n
    }
  }

  /** 客户端帧（open 控制消息/pong/close）——一律掩码。 */
  private fun sendFrame(out: java.io.OutputStream, opcode: Int, payload: ByteArray) {
    try {
      val mask = ByteArray(4).also { SecureRandom().nextBytes(it) }
      val head = ByteArrayOutputStream(8)
      head.write(0x80 or opcode)
      if (payload.size <= 125) head.write(0x80 or payload.size)
      else {
        head.write(0x80 or 126)
        head.write((payload.size shr 8) and 0xFF)
        head.write(payload.size and 0xFF)
      }
      head.write(mask)
      val masked = ByteArray(payload.size)
      for (i in payload.indices) masked[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
      synchronized(out) { out.write(head.toByteArray()); out.write(masked); out.flush() }
    } catch (_: Exception) {}
  }
}

/**
 * ST-13（F-APK-03）：握手响应行 → HTTP 状态码。解析不出返回 0（= 不按鉴权失败处理，
 * 仍走既有 throw + 退避重连）。
 */
internal fun muxHandshakeStatusCode(statusLine: String): Int {
  val parts = statusLine.trim().split(' ')
  if (parts.size < 2) return 0
  return parts[1].toIntOrNull() ?: 0
}

/**
 * ST-13：哪些非 101 状态码表示「cookie 被服务端作废」——必须丢 cookie 并强制刷新一次
 * （401 Unauthorized / 403 Forbidden；407 是代理鉴权，本机 loopback 直连不会出现）。
 * 其余非 101（如 404 path 变更、500 网关异常）与 cookie 无关，刷新只会白白换一次 cookie。
 */
internal fun muxRefusalNeedsAuthRefresh(code: Int): Boolean = code == 401 || code == 403

// ── 0.14.10 审计 §6.6：退避与日志节流（纯判据，JVM 可反证）────────────────────────────
//
// 现场（审计 §6.6）：新机 20:46:10 / 11 / 13 连续三次 ECONNREFUSED，三次间隔都很短，
// 说明「退避没有真正拉开」——原因是旧实现把「失败的耗时」（connect 超时 3s + 握手读）与
// 退避间隔混在一起看，而退避本身是从 1s 起步、只在 sleep **之后**翻倍。

/**
 * 引擎未就绪时的**起步退避**：2 秒。
 *
 * 为什么是 2-5 秒量级而不是 1 秒（审计 §6.6 的建议，依据是 §3.1 的实测）：热启动从 spawn 到
 * LISTEN 实测 6.4-9.1 秒，首装首启 31.8 秒。1 秒起步意味着冷启动窗口里白建 7 次以上 socket、
 * 白写 7 行日志；2 秒起步把这段噪音砍半，而「引擎已就绪但连接抖动」的恢复延迟仍在可接受范围
 * （退避首档就是 2s，不是 10s）。
 */
internal const val MUX_BACKOFF_FIRST_MS = 2_000L

/** 退避上限：10 秒（沿用原值，不改既有最坏恢复时间）。 */
internal const val MUX_BACKOFF_CAP_MS = 10_000L

/**
 * 连续失败 [failures] 次之后，下一次尝试前应等待的毫秒数。
 *
 * **按失败次数算，不按「上次尝试时间」算**——这正是审计 §6.6 点出的修法。按次数算是纯函数：
 * 同样的失败次数永远得到同样的间隔，不受失败本身耗时的影响（旧实现让 connect 超时混进间隔里，
 * 于是「退避看起来没生效」）。
 *
 * 序列：2s / 4s / 8s / 10s / 10s …（起步 2s、翻倍、上限 10s）。
 * [failures] <= 0（还没失败过、或刚被正常 close 重置）返回 0：**不等待**，快速重连。
 */
internal fun muxBackoffMs(failures: Int): Long {
  if (failures <= 0) return 0L
  var ms = MUX_BACKOFF_FIRST_MS
  var i = 1
  while (i < failures && ms < MUX_BACKOFF_CAP_MS) {
    ms = (ms * 2).coerceAtMost(MUX_BACKOFF_CAP_MS)
    i++
  }
  return ms
}

/**
 * 服务端**正常**收流（WS close 帧）——不是故障。
 *
 * 为什么要单独成类：旧实现把 close 帧与「连不上」都抛成 `Exception`，于是「正常收流 ⇒ 快速重连」
 * 这条语义只靠「backoff 还没翻倍」偶然成立。分开之后，两条路径的退避策略可以各自被断言
 * （见 [muxReconnectDelayMs]），也就不会被「按失败次数退避」的改造顺手改成 2 秒。
 */
internal class MuxServerClosedException(message: String) : Exception(message)

/**
 * 正常收流后的快速重连间隔：1 秒（与旧实现「1s 起步」的最优情形一致）。
 *
 * **必须严格小于** [MUX_BACKOFF_FIRST_MS]：正常收流意味着引擎健康、只是这条流结束了，
 * 用「引擎未就绪」的 2 秒档去等它，等于把正常语义降级成故障语义。
 */
internal const val MUX_FAST_RECONNECT_MS = 1_000L

/**
 * 下一次重连前应等待的毫秒数（审计 §6.6 的完整口径）。
 *
 * @param failures 连续失败计数（0 = 没失败过）
 * @param gracefulClose true = 服务端正常收流（走快速重连，不计失败）
 */
internal fun muxReconnectDelayMs(failures: Int, gracefulClose: Boolean): Long =
  if (gracefulClose) MUX_FAST_RECONNECT_MS else muxBackoffMs(failures)

/** 失败日志的节流窗口：每分钟最多一条（首次不限）。 */
internal const val MUX_FAILURE_LOG_INTERVAL_MS = 60_000L

/**
 * 本拍失败是否该打日志（审计 §6.6 第三条：注释里承诺的「首败 + 每分钟一条」真正落地）。
 *
 * - 第 1 次失败：**必打**（「连不上」这件事本身必须有痕迹，否则出问题时日志里一行都没有）；
 * - 之后：距上次打日志不足 [MUX_FAILURE_LOG_INTERVAL_MS] 一律静默；
 * - [lastLoggedAt] <= 0 表示「本次运行还没打过」：此时也放行（进程刚起、单调时钟基线重置）。
 *
 * @param failures 本次连接尝试的连续失败计数（从 1 起）
 * @param lastLoggedAt 上一次打日志的**单调**时刻（[SystemClock.elapsedRealtime]；0 = 还没打过）
 * @param now 当前单调时刻
 */
internal fun muxShouldLogFailure(
  failures: Int,
  lastLoggedAt: Long,
  now: Long,
  intervalMs: Long = MUX_FAILURE_LOG_INTERVAL_MS,
): Boolean {
  if (failures <= 1) return true
  if (lastLoggedAt <= 0L) return true
  return now - lastLoggedAt >= intervalMs
}
