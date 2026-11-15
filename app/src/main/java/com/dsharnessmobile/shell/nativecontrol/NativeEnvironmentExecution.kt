package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import com.dsharnessmobile.shell.ShizukuTransport
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException

/**
 * prepareEnvironment：只关 / 恢复三项框架动画倍率，没有任何输入法逻辑。
 *
 * 旧 android_env_prepare 里有效的那部分能力（三项动画倍率关掉再恢复）留在这里，但换了信任模型：
 *  - 通道固定为 Shizuku 服务端 shell 2000，经 ShizukuTransport.runController 的固定 argv 执行
 *    （只有 settings get global / settings put global，不接受模型拼命令）；
 *  - 原值由本应用 UID 先落盘再写；没有可信原值就不恢复，用户后来自己改过的值也不覆盖；
 *  - 写前消费一次授权门，之后每一步都 refreshFacts + validateDispatch 复核仍在 dispatching，
 *    超时或撤权后立即停止写入；
 *  - 部分写或回读失败一律 unknown，禁止自动重试；单 worker、无队列、有界。
 */
internal class NativeEnvironmentExecution(
  private val next: NativeControlDispatcher.Platform,
  private val settings: SettingsChannel,
  private val channel: ChannelState,
  private val store: OriginalStore,
  private val dispatch: DispatchCheck,
  private val deadlineMs: Long = DEFAULT_DEADLINE_MS,
  private val clock: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) : NativeControlDispatcher.Platform {

  /** 生产装配：只有 context 与下游适配器，其余依赖都取壳侧真源。 */
  constructor(context: Context, next: NativeControlDispatcher.Platform) : this(
    next = next,
    settings = { argv, gate -> ShizukuTransport.runController(context.applicationContext, argv, gate) },
    channel = ChannelState { NativeEnvironmentExecution.shizukuShellReady() },
    store = PrefsOriginalStore(context.applicationContext),
    dispatch = DispatchCheck { callId -> NativeEnvironmentExecution.stillDispatching(callId) },
  )

  /** 只有 Rust 的 prepareEnvironment 计划（控制内存、Shizuku 后端、无屏幕）归本适配器。 */
  private fun isEnvironment(plan: JSONObject): Boolean =
    plan.optString("operation") == "prepareEnvironment" &&
      plan.optString("target") == "controlMemory" &&
      plan.optString("backend") == "shizuku" &&
      noScreen(plan)

  override fun implements(plan: JSONObject): Boolean = isEnvironment(plan) || next.implements(plan)

  /** 控制内存计划没有屏幕：键缺席、JSON null、空串都算「无屏幕」。 */
  private fun noScreen(plan: JSONObject): Boolean =
    !plan.has("screenId") || plan.isNull("screenId") || plan.optString("screenId").isEmpty()

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    if (!isEnvironment(plan)) return next.execute(callId, plan, args, refreshFacts, authorize)
    val restore = args.opt("restore")
    if (restore != null && restore !is Boolean) {
      return CompletableFuture.completedFuture(refusal("invalid-restore"))
    }
    return try {
      worker.supplyAsync({
        if (restore == true) restore(callId, refreshFacts, authorize)
        else disable(callId, refreshFacts, authorize)
      })
    } catch (_: RejectedExecutionException) {
      // 单 worker 无队列：忙就明确拒绝，绝不排队、绝不重试。
      CompletableFuture.completedFuture(refusal("environment-busy"))
    }
  }

  // ── 关闭三项动画 ────────────────────────────────────────────────────────────

  private fun disable(callId: String, refreshFacts: () -> Boolean, authorize: () -> Boolean): JSONObject {
    if (!channel.ready()) return refusal("shizuku-unavailable")
    val start = clock()
    // 1. 先读原值。任何一项读不到就无法承诺可恢复：一项都不写。
    val originals = LinkedHashMap<String, String>()
    for (key in KEYS) {
      if (expired(start)) return refusal("environment-deadline")
      val value = read(key) ?: return refusal("environment-read-failed")
      if (!isTrustedScale(value)) return refusal("environment-original-untrusted")
      originals[key] = value
    }
    // 2. 写前消费授权门（一次）。门是单发的：重复调用不能再获得许可。
    if (!authorize()) return refusal("authorize-denied")
    // 3. 逐项：复核仍在 dispatching，再保存可信原值、写 0、回读 0。
    var written = 0
    var saved = 0
    for (key in KEYS) {
      val original = originals.getValue(key)
      if (!stillAllowed(start, callId, refreshFacts)) return partial(written, saved, "environment-dispatch-lost")
      // 记录策略：
      //  - 没有记录 ⇒ 存当前值；
      //  - 有记录且当前值就是我们写下的 0 ⇒ 保留记录（重复关闭不能把真原值覆盖成 0）；
      //  - 有记录但当前值非 0 且与记录不同 ⇒ 用户后来自己改过，记录改为他现在用的值，
      //    这样 restore 恢复的是用户的最新选择，而不是过期旧值。
      val remembered = store.trusted(key)
      if (remembered.isNullOrEmpty() || (original != DISABLED && original != remembered)) {
        if (!store.remember(key, original)) {
          return if (written == 0) refusal("environment-store-unavailable")
          else partial(written, saved, "environment-store-unavailable")
        }
        saved += 1
      }
      val write = write(key, DISABLED)
      if (!acknowledged(write)) return partial(written + 1, saved, "environment-write-unknown")
      written += 1
      if (read(key) != DISABLED) return partial(written, saved, "environment-readback-mismatch")
    }
    return JSONObject().put("ok", true).put("code", "environment-prepared").put("executed", "yes")
      .put("data", JSONObject().put("operation", "disable").put("keys", JSONArray(KEYS))
        .put("written", written).put("originalsSaved", saved))
  }

  // ── 恢复三项动画 ────────────────────────────────────────────────────────────

  private fun restore(callId: String, refreshFacts: () -> Boolean, authorize: () -> Boolean): JSONObject {
    if (!channel.ready()) return refusal("shizuku-unavailable")
    val start = clock()
    // 1. 只认本应用自己保存过、且形态可信的原值；没有就如实说无事可做。
    val trusted = LinkedHashMap<String, String>()
    for (key in KEYS) {
      val original = store.trusted(key)
      if (!original.isNullOrEmpty() && isTrustedScale(original)) trusted[key] = original
    }
    if (trusted.isEmpty()) return JSONObject().put("ok", true).put("executed", "no")
      .put("code", "environment-nothing-to-restore")
      .put("data", JSONObject().put("operation", "restore").put("restored", 0))
    // 2. 只有当前仍是我们写下的 0 才恢复；用户后来改过值的一律不动。
    val current = LinkedHashMap<String, String>()
    for (key in trusted.keys) {
      if (expired(start)) return refusal("environment-deadline")
      current[key] = read(key) ?: return refusal("environment-read-failed")
    }
    val restorable = trusted.keys.filter { current[it] == DISABLED }
    val modified = trusted.keys.filter { current[it] != DISABLED }
    if (restorable.isEmpty()) {
      // 用户已经自己设过值：清掉我们的记录，不再替他改。
      for (key in modified) store.forget(key)
      return JSONObject().put("ok", true).put("executed", "no").put("code", "environment-user-modified")
        .put("data", JSONObject().put("operation", "restore").put("restored", 0)
          .put("skipped", JSONArray(modified)))
    }
    // 3. 写前消费授权门（一次），之后逐项复核。
    if (!authorize()) return refusal("authorize-denied")
    var restored = 0
    for (key in restorable) {
      val original = trusted.getValue(key)
      if (!stillAllowed(start, callId, refreshFacts)) return partial(restored, 0, "environment-dispatch-lost")
      val write = write(key, original)
      if (!acknowledged(write)) return partial(restored + 1, 0, "environment-write-unknown")
      restored += 1
      if (read(key) != original) return partial(restored, 0, "environment-readback-mismatch")
      store.forget(key)
    }
    for (key in modified) store.forget(key)
    return JSONObject().put("ok", true).put("code", "environment-restored").put("executed", "yes")
      .put("data", JSONObject().put("operation", "restore").put("restored", restored)
        .put("skipped", JSONArray(modified)))
  }

  // ── 单步 ────────────────────────────────────────────────────────────────────

  /** 仍在 dispatching 才允许下一步写入：先刷新事实，再让 Rust 复核本次计划。 */
  private fun stillAllowed(start: Long, callId: String, refreshFacts: () -> Boolean): Boolean =
    !expired(start) && refreshFacts() && dispatch.stillDispatching(callId)

  private fun expired(start: Long): Boolean = clock() - start >= deadlineMs

  private fun read(key: String): String? {
    val reply = run(arrayOf(SETTINGS, "get", "global", key))
    if (!acknowledged(reply)) return null
    return reply.optString("stdout").trim().takeIf { it.isNotEmpty() }
  }

  private fun write(key: String, value: String): JSONObject =
    run(arrayOf(SETTINGS, "put", "global", key, value))

  private fun run(argv: Array<String>): JSONObject = try {
    settings.run(argv, null)
  } catch (_: Throwable) {
    JSONObject().put("ok", false).put("code", "environment-channel-failed").put("executed", "unknown")
  }

  /** 回执必须带确定执行证据：完整读取、退出码 0、没有 unknown / 重放标记。 */
  private fun acknowledged(reply: JSONObject): Boolean =
    reply.optString("executed") != "unknown" && !reply.optBoolean("noReplay") &&
      reply.has("exitCode") && reply.optInt("exitCode", -1) == 0 &&
      !reply.optBoolean("exitTimedOut") && !reply.optBoolean("drainTimedOut") &&
      !reply.optBoolean("truncated") && reply.optString("readError").isEmpty()

  private fun partial(done: Int, saved: Int, code: String): JSONObject =
    JSONObject().put("ok", false).put("code", code).put("reason", code)
      .put("executed", if (done > 0) "unknown" else "no")
      .put("noReplay", true)
      .put("data", JSONObject().put("keysAttempted", done).put("originalsSaved", saved))

  private fun refusal(code: String): JSONObject =
    JSONObject().put("ok", false).put("code", code).put("reason", code).put("executed", "no")

  /** 通道状态：只有实测到 shell 2000 且功能就绪才算配置好。 */
  internal fun interface ChannelState {
    fun ready(): Boolean
  }

  /** 固定 argv 的 settings 通道（生产实现是 ShizukuTransport.runController）。 */
  internal fun interface SettingsChannel {
    fun run(argv: Array<String>, gate: (() -> Boolean)?): JSONObject
  }

  /** 本次调用是否仍在 dispatching（生产实现是 Rust 的 validateDispatch）。 */
  internal fun interface DispatchCheck {
    fun stillDispatching(callId: String): Boolean
  }

  /** 三项动画的原始值。应用 UID 私有存储；没有可信记录就不恢复。 */
  internal interface OriginalStore {
    fun trusted(key: String): String?
    fun remember(key: String, original: String): Boolean
    fun forget(key: String)
  }

  companion object {
    internal const val OPERATION = "prepareEnvironment"
    internal const val SETTINGS = "/system/bin/settings"
    internal const val DISABLED = "0"
    /** 三项固定键，顺序即读写顺序；不接受调用方增删。 */
    internal val KEYS = listOf("window_animation_scale", "transition_animation_scale", "animator_duration_scale")
    /** 总预算：三个 get + 三个 put + 三个回读都在这一次调用里完成。 */
    internal const val DEFAULT_DEADLINE_MS = 20_000L

    /** 原值必须是有限的十进制倍率；"null" / 空 / 其它形态都不可信，不写也不恢复。 */
    internal fun isTrustedScale(value: String): Boolean =
      value.length <= 16 && Regex("""^(?:0|[1-9]\d{0,6})(?:\.\d{1,4})?$""").matches(value)

    /** 生产通道判定：Shizuku 服务端必须是 shell 2000 且功能就绪。 */
    internal fun shizukuShellReady(): Boolean {
      val facts = NativeShizukuFacts.shared.snapshot()
      return facts.optString("functionalReady") == "yes" &&
        facts.optJSONObject("serverUid")?.optString("kind") == "shell2000"
    }

    /** 生产复核：与调度器同一条 Rust 入口，只读、不阻塞写日志。 */
    internal fun stillDispatching(callId: String): Boolean = try {
      val check = JSONObject(NativeControlCore.exchangeNonblocking(JSONObject()
        .put("protocolVersion", 1).put("kind", "validateDispatch").put("callId", callId).toString()))
      check.optBoolean("valid") && check.optString("dispatch") == "permitted"
    } catch (_: Throwable) {
      false
    }

    /** 单 worker、无队列：忙就拒绝，避免把写操作排成一串。 */
    private val worker = NativeOperationWorker("dsh-native-environment")
  }
}

/** 原值的持久面：仍是应用 UID 私有的 SharedPreferences，键名固定且有界。 */
internal class PrefsOriginalStore(private val context: Context) : NativeEnvironmentExecution.OriginalStore {
  private fun prefs() = context.getSharedPreferences("dsh_native_environment", Context.MODE_PRIVATE)

  override fun trusted(key: String): String? {
    if (key !in NativeEnvironmentExecution.KEYS) return null
    return try {
      prefs().getString("original." + key, null)
    } catch (_: Throwable) {
      null
    }
  }

  override fun remember(key: String, original: String): Boolean {
    if (key !in NativeEnvironmentExecution.KEYS || !NativeEnvironmentExecution.isTrustedScale(original)) return false
    return try {
      prefs().edit().putString("original." + key, original).putInt("schema", 1).commit()
    } catch (_: Throwable) {
      false
    }
  }

  override fun forget(key: String) {
    if (key !in NativeEnvironmentExecution.KEYS) return
    try {
      prefs().edit().remove("original." + key).commit()
    } catch (_: Throwable) {
      // 记录删不掉只会让下一次恢复再判一次；不影响本次结论，也不去重试写设置。
    }
  }
}
