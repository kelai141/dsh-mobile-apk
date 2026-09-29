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
 *
 * ── M.1（apk issue #272）：本文件同时持有「引擎可用性」的两条语义判据 ────────────────
 *
 * 3080 端口上「有东西在听」与「这是我们的引擎」是两件事。旧实现 `EngineManager.startEngine`
 * 只要 `portReachable()` 为真就**静默 return true**（当作「已有引擎可用」），不启动、不报错；
 * 任何占用 3080 的非本引擎进程都会让壳层永久停在假象里，用户永远进不去且无任何提示。
 *
 * 另一条同族缺陷：`check()` 把 401 与 200/303 一律算 `running=true`。无 cookie 时 GET /
 * **本来就返回 401**（引擎的鉴权栅栏），所以「需要重新认证」被当成「健康」⇒ 壳侧自愈链
 * （handleUnauthorized → refresh → reload）永不触发。
 *
 * 两条判据都放在本 object 内（`EngineProbe.EngineAvailability` 这类限定名是调用方的既有风格，
 * 顶层声明会让限定名解析不到）。
 *
 * ── 正交分层（本文件最容易被后人改错的一点，务必先读）─────────────────────────
 * **健康位**（`check()` 的 `running`）与**认证态**（`auth`）是两个正交事实，不得互相污染：
 *
 *   · `running` 的判据是 200/401/303 —— 口径**故意保持不变**。它同时被
 *     `WatchdogV2.assessProbe` 当作健康位消费，而那条链的下游是 DEGRADED_HTTP 阶梯：
 *     连续 6 拍（30s）会升级为**破坏性**受控重启（强杀活引擎 + 回滚用户配置）。
 *     若把 401 从 `running` 里摘掉，一个只是「需要重新认证」的健康引擎会在 30 秒后被强杀——
 *     正是 decision D3/W2 明令禁止的（`a 401 must never make the watchdog kill a healthy engine`）。
 *   · `auth` 是本轮（M.1 / apk #272）新增的**正交**字段：ok / required / unknown。
 *     需要「401 ⇒ 重新认证」语义的调用方（EngineStartFlow 的启动轮询、MainActivity 的页面自愈）
 *     读 `auth`，而不是要求 `running` 改变。
 *
 * 这样 WatchdogV2 一行都不用改，破坏性阶梯语义完全不动——「修缺陷」不制造安全回归。
 */
object EngineProbe {
  enum class EngineAvailability {
    /** 本进程托管的子进程还活着（最强证据，句柄在手）。 */
    OUR_PROCESS,
    /** HTTP 应答且可佐证是我们自己的引擎（200 已认证 / 303 令牌交换 / 401+本代 token 行）。 */
    OUR_HTTP,
    /** 端口能连、但既非本进程托管、日志/指纹也对不上 ⇒ 有别的进程占着 3080。 */
    PORT_FOREIGN,
    /** 端口不可连。 */
    DOWN,
  }

  /** 401 的语义（M.1）：不是「健康」，是「我们的引擎在，但当前 cookie 不被接受」。 */
  enum class EngineAuthState { OK, REQUIRED, UNKNOWN }

  /**
   * Classify observed listener evidence. HTTP status is never an ownership proof by itself:
   * only a tracked child or a current-generation shell token line can establish ownership.
   */
  internal fun classifyEngineAvailability(
    httpCode: Int,
    managedAlive: Boolean,
    logHasTokenLine: Boolean,
    portReachable: Boolean,
  ): EngineAvailability {
    if (managedAlive) return EngineAvailability.OUR_PROCESS
    if (logHasTokenLine && httpCode in setOf(200, 303, 401, 403)) return EngineAvailability.OUR_HTTP
    if (portReachable || httpCode >= 0) return EngineAvailability.PORT_FOREIGN
    return EngineAvailability.DOWN
  }

  /** The second port observation immediately before spawn is authoritative for this attempt. */
  internal fun classifyPreSpawnPort(portReachable: Boolean): EngineAvailability =
    if (portReachable) EngineAvailability.PORT_FOREIGN else EngineAvailability.DOWN

  /** A forced restart may stop only the exact managed child, never an inferred listener. */
  internal fun canStopTrackedEngine(availability: EngineAvailability, managedAlive: Boolean): Boolean =
    managedAlive && availability != EngineAvailability.PORT_FOREIGN

  /** Exact local engine origin comparison, independent of Android Uri for JVM policy tests. */
  internal fun isEngineOrigin(url: String): Boolean = try {
    val uri = java.net.URI(url)
    uri.scheme.equals("http", ignoreCase = true) &&
      uri.host.equals("127.0.0.1", ignoreCase = true) && uri.port == 3080 && uri.rawUserInfo == null
  } catch (_: Exception) {
    false
  }

  /** Automatic cookie recovery is narrowly limited to owned main-frame engine 401 responses. */
  internal fun shouldAutoRecoverAuth(
    statusCode: Int,
    isMainFrame: Boolean,
    url: String,
    availability: EngineAvailability,
  ): Boolean = statusCode == 401 && isMainFrame && isEngineOrigin(url) &&
    (availability == EngineAvailability.OUR_PROCESS || availability == EngineAvailability.OUR_HTTP)

  /** 403 is reportable for an owned engine, but never an auth-refresh trigger. */
  internal fun isOwnedEngineForbidden(
    statusCode: Int,
    isMainFrame: Boolean,
    url: String,
    availability: EngineAvailability,
  ): Boolean = statusCode == 403 && isMainFrame && isEngineOrigin(url) &&
    (availability == EngineAvailability.OUR_PROCESS || availability == EngineAvailability.OUR_HTTP)

  /**
   * 纯判据：401 的语义化（JVM 单测）。
   *
   * 为什么单独一个函数而不是内联：这条判据是 (b) 的核心——「401 = 需要重新认证」必须与
   * 「401 = 引擎健康」在本仓只存在一种解释，否则两处会各自漂移回旧语义。
   */
  internal fun classifyAuthState(httpCode: Int): EngineAuthState = when (httpCode) {
    200, 303 -> EngineAuthState.OK
    401 -> EngineAuthState.REQUIRED
    else -> EngineAuthState.UNKNOWN
  }



  const val ENGINE_URL = "http://127.0.0.1:3080"

  private const val ENGINE_HOST = "127.0.0.1"
  private const val ENGINE_PORT = 3080

  /**
   * One-shot reachability probe. Safe on any thread (never the main thread).
   * @param timeoutMs connect+read budget per attempt.
   * @return JSON: {running: Boolean, code: Int, auth: String, listening: Boolean, latencyMs: Int, error?: String}
   *   running = 200/401/303（引擎 HTTP 层活着；判据口径保持不变，看门狗依赖它）。
   *   code/auth 把 401（需要重新认证）从「健康」里单独暴露出来（M.1）。
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
      // 0.13.3 W2: /api is behind browser auth, but GET / is public (only index
      // with ?token= exchanges). Sending the cookie when we have one yields a
      // 200; without it the engine answers 401.
      //
      // M.1（apk #272）语义修正：**保留** `running` 的原口径（200/401/303 = 引擎活着），
      // 另外把「401」单独报出来。为什么不动 `running` 的分母——
      // `WatchdogV2.assessProbe` 是 `if (!running) return if (portReachable) DEGRADED_HTTP else DEAD`，
      // 而 DEGRADED_HTTP 连续 6 拍会升级为**破坏性**受控重启（强杀活引擎 + 回滚用户配置）。
      // 一旦把 401 从 running 里摘掉，一个只是「需要重新认证」的健康引擎就会在 30s 后被强杀——
      // 正是原注释里 decision D3/W2 明令禁止的（「a 401 must never make the watchdog kill a healthy engine」）。
      // 所以新增的是**正交**字段，不是改写 running：
      //   running   = 200/401/303（引擎 HTTP 层活着；口径不变，看门狗语义不变）
      //   code      = 原始响应码（调用方可自行判别）
      //   auth      = ok / required / unknown（401 ⇒ required ⇒ 触发重新认证 + reload）
      //   listening = 是否拿到了 HTTP 应答
      EngineAuth.attach(conn)
      try {
        val code = conn.responseCode
        val auth = classifyAuthState(code)
        // running 口径不变（200/401/303）——见上方 D3/W2 说明。
        val running = code == 200 || code == 401 || code == 303
        JSONObject()
          .put("running", running)
          .put("code", code)
          .put("auth", when (auth) {
            EngineAuthState.OK -> "ok"
            EngineAuthState.REQUIRED -> "required"
            EngineAuthState.UNKNOWN -> "unknown"
          })
          .put("listening", true)
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
      JSONObject().put("running", false).put("listening", false)
        .put("auth", "unknown").put("error", err)
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
