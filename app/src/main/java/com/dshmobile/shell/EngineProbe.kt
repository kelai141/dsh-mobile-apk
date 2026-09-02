package com.dsharnessmobile.shell

import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import org.json.JSONObject

/**
 * Probes the local dsh web engine (127.0.0.1:3080) from the shell side.
 *
 * #118 (2026-09): every connection to the local engine port must bypass the
 * system HTTP proxy. `URL.openConnection()` defaults to the `ProxySelector`
 * issued by ConnectivityService: on WiFi with a configured system proxy, a
 * loopback request is sent to the proxy gateway (which cannot reach back),
 * so the probe times out even though the engine is healthy (WebView and
 * curl bypass the proxy — the "web page opens but the app says engine is
 * down" contradiction). All connect/read paths here therefore pass
 * `Proxy.NO_PROXY` explicitly.
 */
object EngineProbe {

  const val ENGINE_URL = "http://127.0.0.1:3080"

  private const val ENGINE_HOST = "127.0.0.1"
  private const val ENGINE_PORT = 3080

  /**
   * One-shot reachability probe. Safe on any thread (never the main thread).
   * @param timeoutMs connect+read budget per attempt.
   * @return JSON: {running: Boolean, latencyMs: Int, error?: String}
   *   error distinguishes "timeout" (request swallowed by a proxy / slow
   *   engine) from "refused" (port not open — engine actually down).
   */
  fun check(timeoutMs: Int = 800): JSONObject {
    val start = System.currentTimeMillis()
    return try {
      // Proxy.NO_PROXY: bypass the system proxy selector (see class doc, #118).
      val conn = URL(ENGINE_URL).openConnection(Proxy.NO_PROXY) as HttpURLConnection
      conn.connectTimeout = timeoutMs
      conn.readTimeout = timeoutMs
      conn.requestMethod = "GET"
      try {
        val code = conn.responseCode
        JSONObject()
          .put("running", code == 200)
          .put("latencyMs", System.currentTimeMillis() - start)
      } finally {
        conn.disconnect()
      }
    } catch (e: Exception) {
      val err = when (e) {
        is SocketTimeoutException -> "timeout"
        is ConnectException -> "refused"
        else -> (e.message ?: "unknown")
      }
      JSONObject().put("running", false).put("error", err)
    }
  }

  /**
   * Port-level reachability: a TCP connect to the engine port succeeds means
   * the engine process is alive — independent of HTTP readiness. Used by the
   * cooldown window and the engineProcessAlive() fallback so a slow engine
   * (HTTP not yet answering) is never mistaken for a dead one (#118 root 3).
   * @param timeoutMs TCP connect budget.
   * @return true when the port accepts connections.
   */
  fun portReachable(timeoutMs: Int = 1000): Boolean {
    return try {
      val sock = Socket(Proxy.NO_PROXY)
      try {
        sock.connect(InetSocketAddress(ENGINE_HOST, ENGINE_PORT), timeoutMs)
        true
      } finally {
        try { sock.close() } catch (_: Exception) {}
      }
    } catch (_: Exception) {
      false
    }
  }
}