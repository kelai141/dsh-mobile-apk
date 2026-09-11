package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * Engine /api browser-auth carrier (0.13.3 W2, decision D3 = P0 + P1 faithful route).
 *
 * Upstream 0.1.2-rc.1 fences every /api request behind a signed browser cookie
 * (401; no Authorization/query bypass, no loopback exemption, no kill switch —
 * docs/ENGINE-0.1.2-rc1-AUTH-CLIENT-RESEARCH.md §1.5). The shell is the only
 * machine client that must speak HTTP to the engine, so it carries the cookie:
 *
 * - P0 (primary): parse the official launch-token URL line from engine.log
 *   (`dsh web: http://127.0.0.1:3080/?token=…`, printed once per engine
 *   process; web-app printUrl :211) and exchange it once at `GET /?token=` —
 *   the engine answers 303 + Set-Cookie. The cookie is opaque to us.
 * - P1 (fallback): mint the cookie ourselves from the persistent signing
 *   secret in `files/home/.dsh/.credentials.yaml`
 *   (records["client-connection/browser-session"].payload.secret) — exact
 *   algorithm per research §1.4: value `v1.<b64url(payload)>.<b64url(HMAC-SHA256(secret, body))>`,
 *   name `dsh-auth-<b64url(sha256(authority))>`, authority `127.0.0.1:3080`.
 *   javax.crypto/MessageDigest standard parts only.
 *
 * Because the signing secret persists across engine restarts, a cookie keeps
 * working across restarts; normally we exchange once (first launch / key
 * rotation) and reuse.
 *
 * SECURITY: the token, the cookie value and the credentials secret are never
 * logged (the credentials file also holds user API keys). Only status lines
 * and response codes are logged.
 */
object EngineAuth {

  private const val TAG = "dsh-engine-auth"
  private const val PREFS = "dsh_engine_auth"
  private const val KEY_COOKIE = "cookie"
  const val AUTHORITY = "127.0.0.1:3080"
  const val BASE_URL = "http://$AUTHORITY"
  private const val COOKIE_NAME_PREFIX = "dsh-auth-"
  private const val TOKEN_LINE = "dsh web: "
  internal val TOKEN_RE = Regex("""dsh web: \S*/\?token=([A-Za-z0-9_\-]{40,})""")
  private const val SECRET_RECORD_KEY = "client-connection/browser-session"

  @Volatile private var cached: String? = null

  /**
   * 日志出口脱敏（0.13.8 #184，唯一正则来源 = TOKEN_RE）：把启动令牌行替换为
   * `?token=***`，保留 URL 形状与其余信息，不整行删除。
   * 硬约束：只允许作用于**副本/落盘/展示出口**（日志、诊断包、引导页摘录），
   * 绝不能改写 filesDir/engine.log 本体——壳侧鉴权链（tokenFromLog）依赖该行。
   */
  fun redact(text: String): String = text.replace(TOKEN_RE, "dsh web: ***?token=***")

  @Volatile private var appContext: Context? = null

  /**
   * Bind the application context once (MainActivity.onCreate) so Context-less
   * callers (EngineProbe is a Kotlin object) can still attach cookies.
   */
  fun initContext(context: Context) {
    appContext = context.applicationContext
  }

  private fun ctx(): Context? = appContext

  /** Current cookie (memory cache first), or null when none is stored. */
  fun cookie(context: Context): String? {
    cached?.let { if (stillValid(it)) return it }
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val stored = prefs.getString(KEY_COOKIE, null)
    if (stored != null && stillValid(stored)) {
      cached = stored
      return stored
    }
    return null
  }

  /**
   * Set the Cookie header on an /api connection when a cookie is available.
   * Uses the context bound by [initContext]; a no-op before that or without
   * a stored cookie. Callers keep their own Proxy.NO_PROXY and timeouts.
   */
  fun attach(conn: HttpURLConnection) {
    val c = ctx() ?: return
    val cookie = cookie(c) ?: return
    conn.setRequestProperty("Cookie", cookie)
  }

  /**
   * Context-explicit variant for callers that hold a Context and must not
   * depend on initContext ordering.
   */
  fun attach(context: Context, conn: HttpURLConnection) {
    val cookie = cookie(context) ?: return
    conn.setRequestProperty("Cookie", cookie)
  }

  /**
   * Cookie for the mux WS handshake (W3): refresh-on-miss (the upgrade goes
   * through the same auth fence). Null when no cookie can be produced — the
   * handshake will be refused 401 and the reconnect loop retries after the
   * next successful refresh.
   */
  fun attachMux(): String? {
    val c = ctx() ?: return null
    return cookie(c) ?: refresh(c)
  }

  /**
   * A 401 from any /api call: drop the stored cookie and refresh once.
   * @return the new cookie, or null when refresh failed (caller keeps going;
   * the next periodic caller retries).
   */
  fun handleUnauthorized(context: Context): String? {
    invalidate(context)
    return refresh(context)
  }

  /** Drop the stored cookie (key rotation / data clear / 401). */
  fun invalidate(context: Context) {
    cached = null
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().remove(KEY_COOKIE).apply()
  }

  /**
   * Best-effort cookie refresh: P0 token exchange, P1 mint fallback.
   * Safe on any background thread; synchronous and never throws.
   * @return a fresh cookie, or null (refresh failed — retried by later callers).
   */
  fun refresh(context: Context): String? {
    val app = context.applicationContext
    synchronized(this) {
      cookie(app)?.let { return it }
      val exchanged = exchangeFromLogToken(app)
      if (exchanged != null) {
        store(app, exchanged)
        Log.i(TAG, "cookie acquired via token exchange")
        return exchanged
      }
      val minted = mintFromCredentials(app)
      if (minted != null) {
        store(app, minted)
        Log.i(TAG, "cookie minted from credentials grant")
        return minted
      }
      Log.w(TAG, "cookie refresh failed (no token line, exchange error, or credentials record absent)")
      return null
    }
  }

  /** The launch token from the newest engine.log generation, when present. */
  fun tokenFromLog(context: Context): String? = tokenFromLog(File(context.filesDir, "engine.log"))

  // ── P0: engine.log token → 303 Set-Cookie ──────────────────────────────

  private fun exchangeFromLogToken(app: Context): String? {
    val token = tokenFromLog(File(app.filesDir, "engine.log")) ?: return null
    return exchange(app, token)
  }

  private fun tokenFromLog(log: File): String? {
    // Newest generation first: engine.log, engine.log.1, engine.log.2 (0.13.1 W3 rotation).
    // Tail only — the URL line prints at boot; no need to scan a whole file.
    for (f in arrayOf(log, File(log.parentFile, "engine.log.1"), File(log.parentFile, "engine.log.2"))) {
      if (!f.exists()) continue
      try {
        val bytes = f.inputStream().use { input ->
          val tail = ByteArray(64 * 1024)
          val skipped = input.channel.size() - tail.size
          if (skipped > 0) input.channel.position(skipped)
          val read = input.read(tail)
          tail.copyOf(if (read > 0) read else 0)
        }
        val text = String(bytes, StandardCharsets.UTF_8)
        val last = TOKEN_RE.findAll(text).lastOrNull()?.groupValues?.get(1)
        if (last != null) return last
      } catch (_: Exception) {
        // unreadable generation: try the next one
      }
    }
    return null
  }

  private fun exchange(context: Context, token: String): String? {
    var conn: HttpURLConnection? = null
    return try {
      conn = URL("$BASE_URL/?token=$token").openConnection(Proxy.NO_PROXY) as HttpURLConnection
      conn.instanceFollowRedirects = false // capture the 303 Set-Cookie ourselves
      conn.connectTimeout = 4000
      conn.readTimeout = 4000
      val code = conn.responseCode
      if (code != 303) {
        Log.w(TAG, "token exchange unexpected status: $code")
        return null
      }
      val cookies = conn.headerFields?.get("Set-Cookie") ?: return null
      cookies.firstOrNull { it.startsWith(COOKIE_NAME_PREFIX) }
        ?.substringBefore(';')
        ?.takeIf { it.contains('=') }
    } catch (e: Exception) {
      Log.w(TAG, "token exchange failed: ${e.javaClass.simpleName}")
      null
    } finally {
      conn?.disconnect()
    }
  }

  // ── P1: mint from the persisted credentials grant ───────────────────────

  /**
   * Extract the browser-session grant secret from .credentials.yaml WITHOUT
   * loading the file into logs. The scan is scoped to the
   * `client-connection/browser-session` record block so other records' API-key
   * secrets are never matched.
   */
  private fun credentialsSecret(context: Context): ByteArray? {
    val file = File(File(context.filesDir, "home"), ".dsh/.credentials.yaml")
    if (!file.exists()) return null
    return try {
      val lines = file.readLines(StandardCharsets.UTF_8)
      var inRecords = false
      var inRecord = false
      var secret: String? = null
      for (raw in lines) {
        if (!inRecords) {
          if (raw.startsWith("records:")) inRecords = true
          continue
        }
        if (inRecord) {
          // The record block ends at the next same-indentation (2-space) key.
          if (raw.startsWith("  ") && !raw.startsWith("   ")) break
          val m = Regex("""^\s*secret:\s*([A-Za-z0-9_\-]+)\s*(#.*)?$""").find(raw)
          if (m != null) { secret = m.groupValues[1]; break }
        } else if (raw.startsWith("  $SECRET_RECORD_KEY:")) {
          inRecord = true
        }
      }
      secret?.let { Base64.getUrlDecoder().decode(it) }
    } catch (_: Exception) {
      null
    }
  }

  private fun mintFromCredentials(context: Context): String? {
    val secret = credentialsSecret(context) ?: return null
    if (secret.size != 32) {
      Log.w(TAG, "credentials grant secret has unexpected length")
      return null
    }
    return try {
      val name = cookieName(AUTHORITY)
      val now = System.currentTimeMillis()
      val expiresAt = now + 30L * 24 * 60 * 60 * 1000 // maxAge default 30d; <= boundary passes
      val payload = JSONObject()
        .put("version", 1)
        .put("authority", AUTHORITY)
        .put("issuedAt", now)
        .put("expiresAt", expiresAt)
      val body = Base64.getUrlEncoder().withoutPadding()
        .encode(payload.toString().toByteArray(StandardCharsets.UTF_8))
        .toString(StandardCharsets.US_ASCII)
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(secret, "HmacSHA256"))
      val sig = Base64.getUrlEncoder().withoutPadding().encode(mac.doFinal(body.toByteArray(StandardCharsets.UTF_8)))
        .toString(StandardCharsets.US_ASCII)
      "$name=v1.$body.$sig"
    } catch (e: Exception) {
      Log.w(TAG, "cookie mint failed: ${e.javaClass.simpleName}")
      null
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private fun cookieName(authority: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(authority.toByteArray(StandardCharsets.UTF_8))
    return COOKIE_NAME_PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
  }

  /** Cheap self-check: decode the payload segment and verify expiry. */
  private fun stillValid(cookie: String): Boolean {
    val parts = cookie.substringAfter('=').split('.')
    if (parts.size != 3 || parts[0] != "v1") return false
    return try {
      val payload = JSONObject(String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8))
      payload.optLong("expiresAt", 0L) > System.currentTimeMillis()
    } catch (_: Exception) {
      false
    }
  }

  private fun store(context: Context, cookie: String) {
    cached = cookie
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putString(KEY_COOKIE, cookie).apply()
  }
}
