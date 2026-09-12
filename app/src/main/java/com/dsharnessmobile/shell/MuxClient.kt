package com.dsharnessmobile.shell

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
 * 连引擎网关流复用器 ws://127.0.0.1:3080/api/remote.mux（dsh-api-gateway，
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

  private fun loop() {
    var backoff = 1000L
    while (running) {
      try {
        connectAndServe()
        backoff = 1000L // 正常收到 close 帧退出 → 快速重连
      } catch (e: Exception) {
        if (!running) return
        // 失败必须可见（首败 + 每分钟一条节流；引擎冷启动前 refused 是预期噪音）
        Log.w(TAG, "mux attempt failed: ${e.message}")
      }
      if (!running) return
      try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
      backoff = (backoff * 2).coerceAtMost(10_000L)
    }
  }

  private fun connectAndServe() {
    val s = Socket()
    s.connect(InetSocketAddress(host, port), 3000)
    socket = s
    val key = Base64.encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) }, Base64.NO_WRAP)
    // W3：upgrade 同过 connection 鉴权栅栏——握手带浏览器 Cookie（现取，重连吃到刷新后的值）。
    // 雷区 5：不带 Origin/sec-fetch-site（多余的头反而触发 Host 栅栏交叉校验失败）。
    val cookie = EngineAuth.attachMux() ?: ""
    val cookieHeader = if (cookie.isNotEmpty()) "Cookie: $cookie\r\n" else ""
    val out = s.getOutputStream()
    out.write((
      "GET $path HTTP/1.1\r\nHost: $host:$port\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
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
        0x8 -> { sendFrame(out, 0x8, payload); throw Exception("server close") }
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
