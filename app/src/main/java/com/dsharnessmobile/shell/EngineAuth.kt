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
  /**
   * **脱敏专用**正则（与 [TOKEN_RE] 刻意分开，0.14.1 单测实测抓出的缺陷）：
   * [TOKEN_RE] 带 `{40,}` 长度下限——那是**提取**令牌时防误命中用的（短串可能是普通文本），
   * 但把它复用到**脱敏**出口就是 fail-open：令牌短于 40 位时正则不命中 → 原样落盘/展示 → **泄漏**。
   * 脱敏必须**只要形态像就一律打码**（宁可多打，不可漏打），故此处不设长度下限。
   * 实测反证：`token=SECRETTOKENVALUE1234567890`（26 位）旧实现完全不替换。
   * 硬约束不变：只作用于副本/落盘/展示出口，**绝不**改写 `filesDir/engine.log` 本体
   * （鉴权链 `tokenFromLog` 依赖该行，它用 [TOKEN_RE] 提取，两者互不影响）。
   */
  private val REDACT_RE = Regex("""([?&]token=)[A-Za-z0-9_\-]+""")
  private const val SECRET_RECORD_KEY = "client-connection/browser-session"

  /**
   * 引擎 cookie 时窗的**兜底默认**（天）。
   *
   * M.1（apk #272）实测结论（决定本常量存在的原因，勿照抄报告）：
   * `cookieMaxAgeDays` **不在 settings.yaml 里**——它是 `@deepseek-ai/dsh-client-connection`
   * 插件的 cordis config 项（`dsh/packages/client/connection/src/index.ts:105/113`：
   * `cookieMaxAgeDays: z.natural().min(1).default(30)`）。我们的 profile 未覆盖该行
   * （`scripts/profile-web.cordis.patch.yml` 零命中 connection），web-app bundle 也只配了
   * `trustedHosts` ⇒ 引擎实际走 schema 默认 30 天。
   *
   * 该值**无法**从壳侧配置文件读到（settings.yaml 里根本没有），但它**可从引擎自己的应答观测**：
   * `GET /?token=` 的 Set-Cookie 带 `Max-Age=<秒>`（设备实测 `Max-Age=2592000` = 30 天）。
   * 故本常量只作「还没观测到过」时的兜底，真实值以 [observedMaxAgeMs] 为准。
   */
  internal const val DEFAULT_COOKIE_MAX_AGE_DAYS = 30L

  /**
   * 本地提前量：壳侧自铸 cookie 的 expiresAt 比引擎允许的时窗**早**这么久失效。
   *
   * 方向很重要（写错就是本缺陷的原形）：壳侧比引擎**早**失效 ⇒ 我们会主动 refresh，
   * 用户永远看不到 401；若壳侧比引擎**晚**失效 ⇒ 我们以为还有效而引擎已拒绝，
   * 于是 401 页面卡死且 handleUnauthorized 也无从触发。故必须取减号。
   */
  internal const val COOKIE_EXPIRY_SAFETY_MARGIN_MS = 60L * 60 * 1000

  /**
   * 纯函数：从 Set-Cookie 头解析 `Max-Age=<秒>`（毫秒）。解析不出返回 null。
   *
   * 为什么以响应头为真源而不是读配置：见 [DEFAULT_COOKIE_MAX_AGE_DAYS] 的实测结论——
   * 配置项不在壳侧可读的文件里，而引擎每次令牌交换都把**它自己实际使用的**时窗写在响应头里。
   * @param setCookie 单条 Set-Cookie 头值。
   * @returns Max-Age 毫秒；无该属性或非法时 null。
   */
  internal fun maxAgeFromSetCookie(setCookie: String?): Long? {
    if (setCookie == null) return null
    // Kotlin 原始串里 \s 就是空白：写成 \\s 会去匹配字面反斜杠（本行曾犯此错，被单测抓住）
    val m = Regex("""(?i)(?:^|;)\s*max-age\s*=\s*(\d+)""").find(setCookie) ?: return null
    val seconds = m.groupValues[1].toLongOrNull() ?: return null
    if (seconds <= 0L) return null
    return seconds * 1000L
  }

  /**
   * 纯函数：自铸 cookie 应使用的时窗（毫秒）。
   *
   * @param observedMs 观测到的引擎时窗（[maxAgeFromSetCookie] 的结果）；null = 尚未观测到。
   * @returns 观测值减安全边距；无观测值时用默认 30 天减安全边距；下限 1 分钟（永不为负）。
   */
  internal fun mintedMaxAgeMs(observedMs: Long?): Long {
    val base = observedMs ?: (DEFAULT_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    return (base - COOKIE_EXPIRY_SAFETY_MARGIN_MS).coerceAtLeast(60_000L)
  }

  /**
   * 纯判据：日志文件是否可能属于当前引擎代次。
   *
   * 未知代次一律拒绝；mtime 只是必要条件，token 提取还要求当前 engine.log 的 creation time
   * 不早于本代起点，避免触碰旧日志后刷新 mtime 就伪装成新代。轮转文件 engine.log.1/.2
   * 永远不作为当前代 token 来源。
   */
  internal fun logBelongsToCurrentGeneration(
    logModifiedMs: Long,
    generationStartMs: Long,
    slackMs: Long = 5_000L,
  ): Boolean {
    if (generationStartMs <= 0L || logModifiedMs <= 0L) return false
    return logModifiedMs >= generationStartMs - slackMs
  }

  @Volatile private var cached: String? = null

  /**
   * 本代引擎 spawn 起点（epoch ms）；0 = 未知，token 提取必须 fail closed。
   *
   * 由 [EngineManager.startWithArgs] 在 rotate 之后、spawn 之前标记；用进程内字段而非 prefs，
   * 因为代次是进程事实，跨进程读到旧值比没有更危险。
   */
  @Volatile private var generationStartAt: Long = 0L

  /**
   * 日志出口脱敏（0.13.8 #184；0.14.1 改为用 [REDACT_RE]）：把启动令牌替换为
   * `token=***`，保留 URL 形状与其余信息，不整行删除。
   * **不得**改回用 [TOKEN_RE] 脱敏：它的 `{40,}` 下限会让短令牌漏网（fail-open，已实测）。
   * 硬约束：只允许作用于**副本/落盘/展示出口**（日志、诊断包、引导页摘录），
   * 绝不能改写 filesDir/engine.log 本体——壳侧鉴权链（tokenFromLog）依赖该行。
   */
  fun redact(text: String): String = text.replace(REDACT_RE, "$1***")

  @Volatile private var appContext: Context? = null

  /**
   * Bind the application context once (MainActivity.onCreate) so Context-less
   * callers (EngineProbe is a Kotlin object) can still attach cookies.
   */
  fun initContext(context: Context) {
    appContext = context.applicationContext
    // ST-10：同一绑定点也把进程级上下文交给 ShellAppContext——桥 getImmersiveMode() 没有
    // Context 形参，这是它读壳侧权威值的唯一入口（MainActivity.onCreate 已先于桥安装调用）。
    ShellAppContext.bind(context)
  }

  private fun ctx(): Context? = appContext

  /**
   * 标记「本代引擎已 spawn」（由 EngineManager 在 spawn 点调用）。
   *
   * 这是 token 归属校验的时间锚点：只接受本时刻之后被写过的 engine.log 代次。
   * @param atMs spawn 时刻（epoch ms）。
   */
  fun markGenerationStart(atMs: Long) {
    generationStartAt = atMs
    // 换代会作废内存里的 cookie 缓存吗？**不会**：cookie 由持久签名密钥签发，跨重启有效
    // （类注释已述）。这里只重置「本代起点」，不动 cookie。
  }

  /** 观测到的引擎 cookie 时窗（毫秒）；null = 尚未观测到。 */
  @Volatile private var observedMaxAgeMs: Long? = null

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
   * A 401/403 from any /api call **or from the mux WS handshake** (ST-13, F-APK-03):
   * drop the stored cookie and refresh once, bypassing the cache short-circuit.
   * @return the new cookie, or null when refresh failed (caller keeps going;
   * the next periodic caller retries).
   */
  fun handleUnauthorized(context: Context): String? = refresh(context, force = true)

  /**
   * Context-less 401/403 entry: MuxClient runs on a plain socket thread and only has
   * the app context bound by [initContext]. Same semantics as [handleUnauthorized].
   */
  fun handleUnauthorizedBound(): String? = ctx()?.let { refresh(it, force = true) }

  /** Drop the stored cookie (key rotation / data clear / 401). */
  fun invalidate(context: Context) {
    cached = null
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().remove(KEY_COOKIE).apply()
  }

  /**
   * Best-effort cookie refresh: P0 token exchange, P1 mint fallback.
   * Safe on any background thread; synchronous and never throws.
   *
   * FX-210.5 硬约束：本函数内含同步 HTTP（交换 4s connect + 4s read）并持本对象锁，
   * 锁排队可叠加到 ~16s——**禁止在主线程调用**（壳侧 onCreate/onResume 调用点已迁后台）。
   * 失败态以结构化原因（reason/latencyMs）进壳侧开发日志，绝不落 token/cookie 值。
   * @return a fresh cookie, or null (refresh failed — retried by later callers).
   */
  fun refresh(context: Context): String? = refresh(context, force = false)

  /**
   * @param force true = 该 cookie 已被服务端拒绝（401/403）：本地 expiresAt 检查**不构成**
   *   复用理由。旧实现的短路 `cookie(app)?.let { return it }` 会把被拒 cookie 原样返回，
   *   让 handleUnauthorized 形同空转——手动失效 cookie 后审批卡/提问卡不再弹出，只能重启
   *   App（ST-13 判据：≤10s 恢复）。force 时先 invalidate（内存 + prefs）再重取。
   */
  internal fun refresh(context: Context, force: Boolean): String? {
    val startedAt = System.currentTimeMillis()
    val app = context.applicationContext
    synchronized(this) {
      val cachedCookie = cookie(app)
      if (mayReuseCachedCookie(force, cachedCookie)) return cachedCookie
      if (force) invalidate(app)
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
      LogCollector.log(
        TAG,
        "cookie refresh failed: reason=no-token-line-or-exchange-error-or-missing-credentials latencyMs=" +
          (System.currentTimeMillis() - startedAt),
      )
      return null
    }
  }

  /** The launch token from the active engine.log only, when its generation is proven. */
  fun tokenFromLog(context: Context): String? =
    tokenFromCurrentLog(File(context.filesDir, "engine.log"), generationStartAt)

  // ── P0: current engine.log token → 303 Set-Cookie ──────────────────────

  private fun exchangeFromLogToken(app: Context): String? {
    val token = tokenFromCurrentLog(File(app.filesDir, "engine.log"), generationStartAt) ?: return null
    return exchange(app, token)
  }

  /** Production extractor, also exercised with real temporary files by JVM tests. */
  internal fun tokenFromCurrentLog(log: File, generationStartMs: Long): String? {
    if (!log.isFile || generationStartMs <= 0L) return null
    val attributes = try {
      java.nio.file.Files.readAttributes(log.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java)
    } catch (_: Exception) {
      return null
    }
    val modifiedMs = attributes.lastModifiedTime().toMillis()
    val createdMs = attributes.creationTime().toMillis()
    if (!logBelongsToCurrentGeneration(modifiedMs, generationStartMs)) return null
    if (!logBelongsToCurrentGeneration(createdMs, generationStartMs)) return null

    return try {
      // Rotated logs are diagnostics only; they can never prove the current generation.
      val bytes = log.inputStream().use { input ->
        val tail = ByteArray(64 * 1024)
        val skipped = input.channel.size() - tail.size
        if (skipped > 0) input.channel.position(skipped)
        val read = input.read(tail)
        tail.copyOf(if (read > 0) read else 0)
      }
      TOKEN_RE.findAll(String(bytes, StandardCharsets.UTF_8)).lastOrNull()?.groupValues?.get(1)
    } catch (_: Exception) {
      null
    }
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
        LogCollector.log(TAG, "token exchange failed: reason=unexpected-status-" + code)
        return null
      }
      val cookies = conn.headerFields?.get("Set-Cookie") ?: return null
      val ours = cookies.firstOrNull { it.startsWith(COOKIE_NAME_PREFIX) } ?: return null
      // M.1（#272）缺陷 d：引擎把**它自己实际使用的**时窗写在 Set-Cookie 的 Max-Age 上
      // （设备实测 Max-Age=2592000 = 30 天）。这是壳侧唯一能拿到真值的观测点，
      // 记下来供自铸 cookie 复用（配置项 cookieMaxAgeDays 不在壳侧可读文件里，见常量注释）。
      maxAgeFromSetCookie(ours)?.let { observedMaxAgeMs = it }
      ours.substringBefore(';').takeIf { it.contains('=') }
    } catch (e: Exception) {
      Log.w(TAG, "token exchange failed: ${e.javaClass.simpleName}")
      LogCollector.log(TAG, "token exchange failed: reason=" + e.javaClass.simpleName)
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
      // M.1（#272）缺陷 d：旧实现硬编码 30 天，与引擎配置无联动——用户把 cookieMaxAgeDays 调小
      // 即被静默否决（引擎的校验是 `expiresAt - issuedAt <= maxAgeMilliseconds`，见
      // dsh/packages/client/connection/src/browser-auth.ts:299）。现在取**观测到的**引擎时窗
      // 减去安全边距（[COOKIE_EXPIRY_SAFETY_MARGIN_MS]，方向是「壳侧更早失效」——
      // 这样我们会主动 refresh，用户永远看不到 401；反过来就会卡死在 401 页面）。
      val maxAgeMs = mintedMaxAgeMs(observedMaxAgeMs)
      val expiresAt = now + maxAgeMs
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

  /** ST-13：是否允许用缓存短路——force（服务端已拒绝过该 cookie）时一律不允许，
   *  哪怕本地 stillValid() 仍为 true。单测锁定该语义（缓存短路正是缺陷形态之一）。 */
  internal fun mayReuseCachedCookie(force: Boolean, cached: String?): Boolean = !force && cached != null

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
