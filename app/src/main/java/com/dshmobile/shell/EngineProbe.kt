package com.dsharnessmobile.shell

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** Probes the local dsh web engine (127.0.0.1:3080) from the shell side. */
object EngineProbe {

  const val ENGINE_URL = "http://127.0.0.1:3080"

  /**
   * One-shot reachability probe. Safe on any thread (never the main thread).
   * @param timeoutMs connect+read budget per attempt.
   * @returns JSON: {running: Boolean, latencyMs: Int, error?: String}
   */
  fun check(timeoutMs: Int = 800): JSONObject {
    return try {
      val conn = URL(ENGINE_URL).openConnection() as HttpURLConnection
      conn.connectTimeout = timeoutMs
      conn.readTimeout = timeoutMs
      conn.requestMethod = "GET"
      val start = System.currentTimeMillis()
      val code = conn.responseCode
      conn.disconnect()
      JSONObject()
        .put("running", code == 200)
        .put("latencyMs", System.currentTimeMillis() - start)
    } catch (e: Exception) {
      JSONObject().put("running", false).put("error", e.message ?: "unknown")
    }
  }
}
