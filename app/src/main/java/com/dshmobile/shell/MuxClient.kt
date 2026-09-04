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
 * 极简 WebSocket 客户端（0.13.2 悬浮球审批/提问原生应答通道，方案 B）：
 * 连引擎 mux 下行流 ws://127.0.0.1:3080/api/events.mux，只收 server-request 帧
 * （approval/requested|resolved、question/requested|resolved），应答走 HTTP
 * POST /api/respond（OverlayService 侧）。
 *
 * 协议事实（以 dsh 0.1.1-rc.2 源码 packages/host/apiproxy + packages/client/connection 核实）：
 * - mux 走网络只有 WebSocket（GET 直连 426，无 SSE 回退）；
 * - 回环 Host 即过信任围栏（DNS-rebinding 防务），无 token/子协议要求；
 * - 单向 downlink：客户端发「业务消息」会被 close(1008)——本端只发控制帧（pong/close，masked）；
 * - 每次重开连接自动重放全部仍 pending 的 requested 帧（rpcId 不变）→ 断线重连即状态收敛；
 * - 服务端帧恒不掩码；ping 由对端 ws 库自动 pong，本端仍兜底回 pong。
 *
 * 断线 1s 起步指数退避重连（上限 10s）；close() 终止。onFrame 在客户端线程回调（上层自行 post 主线程）。
 */
class MuxClient(
  private val host: String,
  private val port: Int,
  private val path: String,
  private val onFrame: (String) -> Unit,
) {
  companion object {
    private const val TAG = "dsh-overlay-mux"
    private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    private const val MAX_FRAME = 8 * 1024 * 1024
  }

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
    var first = true
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
    val out = s.getOutputStream()
    out.write((
      "GET $path HTTP/1.1\r\nHost: $host:$port\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n"
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
    if (!status.contains(" 101")) throw Exception("handshake refused: $status")
    if (accept != expectedAccept(key)) throw Exception("bad sec-websocket-accept")
    Log.i(TAG, "mux connected")
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
        0x9 -> sendFrame(out, 0xA, payload) // ping → pong（控制帧，不触发 downlink-only 关闭）
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

  /** 控制帧发送（client→server 必须掩码）。仅 pong/close——绝不发业务帧（downlink-only）。 */
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
