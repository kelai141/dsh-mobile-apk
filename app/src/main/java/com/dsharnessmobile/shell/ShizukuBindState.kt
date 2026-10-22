package com.dsharnessmobile.shell

import org.json.JSONObject

/**
 * Shizuku UserService 绑定状态机（**纯逻辑**，JVM 可直接测；不触碰 Android / Shizuku 类）。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────────────────
 * 0.14.1 设备实锤（Redmi K70E，0.14.1-preview）：Shizuku 授权后 UI 永久停在「正在建立 shell UserService」。
 *
 * 缺陷本体不是「建连慢」，而是**绑定闩没有任何超时**：
 *  - `binding` 的复位点只有两处——`Shizuku.bindUserService` **同步抛异常**，或 `onServiceConnected` /
 *    `onServiceDisconnected` **回调**。若 Shizuku 侧既不抛也不回调（进程状态异常、被系统杀掉后
 *    binder 未注销、启动方式与 uid 不匹配等），`binding` 就**永久为 true**；
 *  - 此后 `kickBind` 在 `if (binding) return` 处直接返回，**再也不会发起任何绑定尝试**；
 *  - `ensureBound` 每轮空等满预算后回「正在建立」——**一句文案盖住了三种不同状态**。
 *
 * 于是症状必然是「卡住」而不是「失败」，且在进程生命周期内不可自愈：重启 App 也一样，因为根因
 * （bind 不回调）没变，而 UI 报的还是「正在建立」。这与坑 161（把「尚未探测」渲染成「未就绪」）
 * 同族：**文案与事实脱钩**，让模型据此放弃一条其实可用的通道。
 *
 * 本类把「何时算超时」「超时后如何复位」「当前该报什么」三件事从 Android 面剥离，
 * 使每条判据都能以行为对照在 JVM 上判红（见 `ShizukuBindStateTest`）。
 * 生产面**不存在**测试注入点——测试只构造本纯类，不需要 Robolectric。
 *
 * 并发语义：内部 `lock` 保护全部字段；`@Volatile` 单独用不够——「读 binding 再写 lastError」这组
 * 复合操作在 `ensureBound` 与回调之间必须原子（否则会出现「binding=false 但 lastError 还是
 * connecting」，status() 就会报「尚未发起」而其实刚好正在发起）。
 */
internal class ShizukuBindState(private val watchdogMs: Long) {

  internal companion object {
    /** issue #471：连续启动失败达到该次数后升级为「启动失败」态（暴露真实原因，不再无声重试）。 */
    const val START_FAILURE_THRESHOLD = 3

    /** 指数退避基数：首次失败后 15s 再自动重试。 */
    const val RETRY_BASE_MS = 15_000L

    /** 指数退避上限：无论失败多少次，自动重试间隔不超过 5 分钟。 */
    const val RETRY_CAP_MS = 300_000L
  }

  private val lock = Any()
  private var bindingFlag = false
  private var bindingSince = 0L
  private var attemptCount = 0
  private var generation = 0L

  /** 每次发起或作废连接都换代；旧回调不能改写新一轮的记账。 */
  val currentGeneration: Long get() = synchronized(lock) { generation }
  private var error = ShizukuBindCodes.NOT_BOUND

  /**
   * 连续启动失败次数（issue #471）：绑定超时 / 发起即抛 / 无效 binder 各记一次。
   * 连接成功或用户显式重置后清零；断连不算启动失败（那条通道此前确实起来过）。
   */
  private var failureCount = 0

  /** 下一次允许**自动**重试的时刻（elapsedRealtime 口径）；0 = 未排期。 */
  private var nextAttemptAt = 0L

  /** 是否确有一次绑定在飞（**只有它才配得上「正在建立」这四个字**）。 */
  val binding: Boolean get() = synchronized(lock) { bindingFlag }

  /** 已发起的绑定次数（反证用：看门狗复位后第二次调用必须**确实再次发起**）。 */
  val attempts: Int get() = synchronized(lock) { attemptCount }

  /** 最近一次失败/进行中的结构化 code（空串 = 已连上且 binder 有效）。 */
  val lastError: String get() = synchronized(lock) { error }

  /** 连续启动失败次数（issue #471：UI / 诊断据此判断是否已到阈值）。 */
  val failures: Int get() = synchronized(lock) { failureCount }

  /** 连续失败是否已达 [START_FAILURE_THRESHOLD]：此时 status() 报启动失败并给出真实原因。 */
  val startFailed: Boolean get() = synchronized(lock) { failureCount >= START_FAILURE_THRESHOLD }

  /** 自动重试是否已解禁（退避窗口已过，或尚无失败记录）。**只约束自动重试**，不挡用户显式动作。 */
  fun canAutoRetry(now: Long): Boolean = synchronized(lock) { nextAttemptAt == 0L || now >= nextAttemptAt }

  /** 距离下一次自动重试还差的毫秒数；0 = 现在就可以重试（未排期或已到点）。 */
  fun autoRetryAfterMs(now: Long): Long = synchronized(lock) { (nextAttemptAt - now).coerceAtLeast(0L) }

  /** 记一次启动失败并按指数退避排下一次自动重试（[now] <= 0 时只记账不排期）。 */
  private fun recordFailure(now: Long) {
    failureCount += 1
    nextAttemptAt = if (now > 0L) now + retryDelayMs(failureCount) else 0L
  }

  private fun clearFailures() {
    failureCount = 0
    nextAttemptAt = 0L
  }

  /** 当前这次绑定的已等待毫秒数；未在绑定中返回 -1（**不得**用 0 冒充，0 是合法等待值）。 */
  fun attemptAgeMs(now: Long): Long = synchronized(lock) { if (bindingFlag) now - bindingSince else -1L }

  /**
   * 看门狗：一次绑定超过 [watchdogMs] 仍无任何回调/异常，判定这次尝试已死并复位。
   *
   * 返回 true = 本次确实回收了一次僵尸绑定（调用方据此释放等待闩并记日志）。
   * 幂等：已复位后再调用返回 false（否则每轮轮询都会重复记一条日志）。
   */
  fun reapIfStale(now: Long): Boolean = synchronized(lock) {
    if (!bindingFlag || now - bindingSince <= watchdogMs) return false
    bindingFlag = false
    generation += 1
    error = ShizukuBindCodes.BIND_TIMEOUT
    recordFailure(now)
    true
  }

  /**
   * 尝试发起一次绑定。已在飞且未超时返回 false（不重复抖动）；
   * **调用方必须先跑 [reapIfStale]**——否则僵尸 attempt 会永远挡住新尝试，正是本缺陷的形态。
   */
  fun beginAttempt(now: Long): Boolean = synchronized(lock) {
    if (bindingFlag) return false
    bindingFlag = true
    bindingSince = now
    attemptCount += 1
    generation += 1
    error = ShizukuBindCodes.CONNECTING
    true
  }

  /** `onServiceConnected`：binder 无效时**不得**当成连上（与 bound 判据同口径）。 */
  fun onConnected(
    binderValid: Boolean,
    callbackGeneration: Long = currentGeneration,
    now: Long = 0L,
  ): Boolean = synchronized(lock) {
    if (callbackGeneration != generation || !bindingFlag) return false
    bindingFlag = false
    if (binderValid) {
      error = ""
      clearFailures()
    } else {
      error = ShizukuBindCodes.INVALID_BINDER
      recordFailure(now)
    }
    true
  }

  fun onDisconnected(callbackGeneration: Long = currentGeneration): Boolean = synchronized(lock) {
    if (callbackGeneration != generation) return false
    bindingFlag = false
    generation += 1
    error = ShizukuBindCodes.DISCONNECTED
    true
  }

  /** 发起即抛异常：必须复位，否则那个永不回调的闩会把后续调用全挡死。 */
  fun onBindThrew(
    errorCode: String,
    callbackGeneration: Long = currentGeneration,
    now: Long = 0L,
  ): Boolean = synchronized(lock) {
    if (callbackGeneration != generation) return false
    bindingFlag = false
    generation += 1
    error = errorCode
    recordFailure(now)
    true
  }

  /**
   * 用户显式「重置链接」：把绑定态清空，使下一次 [beginAttempt] 必然放行。
   *
   * ── 为什么不能只清自己进程的标志位（本按钮的承重墙）────────────────────────────
   * 现场：Shizuku 已授权的情况下从「可创建」跳成「需要准备」，**重新授权与重启 App 均无效**。
   * 「App 重启无效」是决定性证据——它排除了「我们进程内标志位脏了」（那会被重启清掉），
   * 指向 **Shizuku 侧的 UserService 实例处于坏态**（绑定请求发出后既不回调也不抛，成为僵尸）。
   * 因此真正的修复动作在 [ShizukuTransport.resetConnection]：调 `Shizuku.unbindUserService(…, remove = true)`
   * 让 Shizuku 管理器**移除**这个 UserService，下次绑定重建一个干净的。本方法只负责把**我们这一侧**的
   * 记账复位到「可以重新发起」——两者缺一，按钮都不会真的有效。
   *
   * 语义边界（不得与四个既有 mutator 混淆）：既有 mutator 描述「一次尝试的结果」，本方法描述
   * 「用户主动放弃当前通道」；它不假装连上、也不假装失败，而是回到「尚未发起」的可重试起点，
   * 同时用 [ShizukuBindCodes.RESET] 让 UI 如实说「已重置」而不是「正在建立」。
   */
  fun onReset() = synchronized(lock) {
    bindingFlag = false
    generation += 1
    error = ShizukuBindCodes.RESET
    // 用户显式重置是一次「重新来过」：退避窗口随之解除，否则点了重置还要干等几分钟。
    clearFailures()
    Unit
  }
}

/**
 * 指数退避（issue #471）：第 n 次连续失败后等待 `15s * 2^(n-1)`，上限 5 分钟。
 *
 * 现场（issue #471）：联发科 ROM 上 UserService 子进程启动即崩，客户端每 ~20s 重试一次，
 * 676+ 次全失败且界面永远只说「通道建立中」。退避把注定失败的重试从「20s 一次」降到
 * 「15s → 30s → 60s → … → 300s」，同时让 UI 有机会把真实原因呈现出来。
 */
internal fun retryDelayMs(failures: Int): Long {
  if (failures <= 0) return 0L
  val exponent = (failures - 1).coerceAtMost(5)
  return (ShizukuBindState.RETRY_BASE_MS shl exponent).coerceAtMost(ShizukuBindState.RETRY_CAP_MS)
}

/** 绑定面的结构化 code（跨层契约：插件 `shellFailureText` 按 `CONNECTING` 分流）。 */
internal object ShizukuBindCodes {
  /** 可立即重试的瞬时态——**只有 [ShizukuBindState.binding] 为真时才能报它**。 */
  const val CONNECTING = "shizuku-user-service-connecting"

  /** 尚未发起过绑定（不是失败，也不是「正在建立」）。 */
  const val NOT_BOUND = "shizuku-user-service-not-bound"

  /** 绑定在看门狗阈值内没有任何回调/异常 → 已复位，可直接重试。 */
  const val BIND_TIMEOUT = "shizuku-user-service-bind-timeout"

  /** 回调了但 binder 不可用（UserService 启动失败）。 */
  const val INVALID_BINDER = "shizuku-user-service-invalid-binder"

  const val DISCONNECTED = "shizuku-user-service-disconnected"

  /**
   * 连续 [ShizukuBindState.START_FAILURE_THRESHOLD] 次启动失败（issue #471）。
   * 这不是「正在建立」，也不是一次瞬时绑定失败——用户服务反复启动即崩，需要看真实原因。
   */
  const val START_FAILED = "shizuku-user-service-start-failed"

  /**
   * 用户主动「重置链接」后的态：绑定记账已清空，Shizuku 侧旧 UserService 已被请求移除。
   * 这不是失败，也不是「正在建立」——它是「已重置，可重新发起」的可重试起点。
   */
  const val RESET = "shizuku-user-service-reset"

  fun bindFailed(t: Throwable): String = "shizuku-user-service-bind-failed:" + t.javaClass.simpleName
}

/**
 * 未就绪时的引导文案（**三态化**，纯函数便于逐条断言）。
 *
 * 三态的区分是本缺陷的核心：「尚未发起」/「正在建立（确有 bind 在飞）」/「已失败（带 code）」是
 * 三件不同的事，此前都由同一句「正在建立」承担，于是用户既不知道该重试还是该排查，
 * 也不知道它到底有没有在动。`binding` 为真才允许说「正在建立」。
 *
 * @param code 当前结构化 code（[ShizukuBindState.lastError] 的口径）。
 * @param binding 是否确有一次绑定在飞。
 * @param ageMs 当前这次绑定的已等待毫秒；未在绑定中传 -1。
 * @param watchdogMs 看门狗阈值（用于把「还要等多久」写进文案）。
 */
internal fun shizukuBindGuidance(code: String, binding: Boolean, ageMs: Long, watchdogMs: Long, english: Boolean = false): String {
  val watchdogSec = watchdogMs / 1000
  if (binding) {
    val waitedSec = if (ageMs >= 0L) ageMs / 1000 else 0L
    return if (english) {
      "Connecting the Shizuku shell channel (${waitedSec}s of ${watchdogSec}s). " +
        "Retry the same command shortly; no need to check the settings page."
    } else {
      "Shizuku shell 通道正在建立（已等待 ${waitedSec}s，上限 ${watchdogSec}s）；" +
        "请稍候直接重试同一命令，无需去设置页排查。"
    }
  }
  if (english) return when {
    code == ShizukuBindCodes.BIND_TIMEOUT ->
      "The Shizuku shell channel timed out after ${watchdogSec}s. Binding was reset; retry now. " +
        "If it keeps timing out, check that Shizuku is still running (start it again over USB or wireless debugging)."
    code == ShizukuBindCodes.NOT_BOUND ->
      "Shizuku is granted but the channel was never bound. Retry the same command or open Phone control to bind it."
    code == ShizukuBindCodes.DISCONNECTED ->
      "The Shizuku UserService disconnected. Retry the same command to reconnect."
    code == ShizukuBindCodes.INVALID_BINDER ->
      "Shizuku returned an invalid binder (the UserService probably failed to start). Check Shizuku is running and retry."
    code == ShizukuBindCodes.START_FAILED ->
      "The Shizuku UserService failed to start repeatedly; automatic retries are backing off. " +
        "Open Phone control to read the captured startup log. If you use Shizuku 13.6.0, " +
        "downgrade to 13.5.4 or switch to the ADB channel."
    code.startsWith("shizuku-user-service-bind-failed") ->
      "Shizuku refused the channel ($code). Check that Shizuku is running and this app is still granted, then retry."
    code == ShizukuBindCodes.RESET ->
      "The Shizuku channel was reset and will rebuild on its own; retry the same command too. " +
        "If it stays down, check that Shizuku is still running."
    else ->
      "The Shizuku shell channel is not ready ($code). Check Phone control for status and guidance."
  }
  return when {
    code == ShizukuBindCodes.BIND_TIMEOUT ->
      "Shizuku shell 通道建立超时（${watchdogSec}s 内未收到绑定回调）。绑定状态已复位，" +
        "可直接重试；若反复超时，请确认 Shizuku 服务仍在运行——非 root 设备需用有线/无线调试重新启动它" +
        "（重启设备后必须再启动一次），或在 Shizuku 应用内确认其服务未被系统回收。"
    code == ShizukuBindCodes.NOT_BOUND ->
      "Shizuku 已授权，但尚未发起通道绑定。重试同一命令（或打开设置页「手机控制」）即会发起绑定。"
    code == ShizukuBindCodes.DISCONNECTED ->
      "Shizuku UserService 已断开。重试同一命令会重新建立连接。"
    code == ShizukuBindCodes.INVALID_BINDER ->
      "Shizuku 返回的 binder 无效（UserService 很可能启动失败）。请在 Shizuku 应用内确认其服务仍在运行后重试。"
    code == ShizukuBindCodes.START_FAILED ->
      "Shizuku 用户服务连续启动失败，自动重试已进入退避。请在设置页「手机控制」展开诊断日志查看真实原因；" +
        "若使用 Shizuku 13.6.0，可降级到 13.5.4，或改用 ADB 通道。"
    code.startsWith("shizuku-user-service-bind-failed") ->
      "Shizuku 拒绝建立通道（$code）。请确认 Shizuku 服务仍在运行、本应用仍被授权后重试。"
    // ── 重置后的态（三态诚实：说清「已做什么 / 现在什么态 / 还不行怎么办」）──────────
    // 措辞纪律：不得承诺「一定能修好」——Shizuku 服务本身已死时，本按钮救不活它
    // （那条路走 status() 既有的 shizuku-not-running 分支）。这里只说我们这一侧做了什么、
    // 以及用户下一步能做什么。
    code == ShizukuBindCodes.RESET ->
      "Shizuku 通道已重置（旧 UserService 已请求移除，绑定态已清空）。本页每 2 秒自动重扫，" +
        "通道会自行重建；也可直接重试同一命令。若长时间仍未就绪，请确认 Shizuku 服务仍在运行" +
        "（非 root 设备重启后需用有线/无线调试再次启动）。"
    else ->
      "Shizuku shell 通道未就绪（$code）。请在设置页「手机控制」查看状态与引导。"
  }
}
/**
 * 「重置链接」**动作**的响应组装（纯函数，JVM 可直接测——与 [shizukuBindGuidance] 同族的顶层函数）。
 *
 * ── 为什么要单独一个函数（0.14.2 设备实测缺陷的修法）────────────────────────────
 * 缺陷形态：`resetConnection` 此前直接返回 [ShizukuTransport.status] 快照，而重置**生效后**
 * 通道尚未绑定，快照的 `ok` 是 `false`；UI 的 `settleLinkCall` 判 `ok === true` 才算成功 ⇒
 * 界面把「重置成功、通道待重建」渲染成「重置 Shizuku 连接失败」。
 * 真因是**一个字段被两件事共用**：只读快照的 `ok`（=通道能不能用）被拿去回答动作的成败。
 *
 * 本函数把两件事拆到两个字段上，缺一即错：
 *   - `ok`    = **动作**已执行（恒 true，本函数只被「重置已走完」的路径调用）；
 *   - `reset` = 本次是重置动作（true，供调用方区分于状态查询）；
 *   - 其余**就绪面事实**（`code` / `lastError` / `bound` / `binding` / `guidance` / …）
 *     **原样保留**——它们仍如实说「通道此刻未就绪」。
 *
 * 反证（若有人只把 `ok` 置 true 而丢掉就绪字段，或只改文案不动 `ok`，本函数的对应断言判红）：
 * 见 `ShizukuBindStateTest` 的 `resetResponseReportsTheActionWhileKeepingReadinessFacts`。
 *
 * @param status - [ShizukuTransport.status] 的就绪快照（本函数会就地补两个动作面字段）。
 * @returns 动作面响应；就绪面字段一个不丢、一个不改。
 */
internal fun shizukuResetResponse(status: JSONObject): JSONObject =
  status.put("ok", true).put("reset", true)

// ══════════════════════════════════════════════════════════════════════════════
// issue #471：连续启动失败的诊断与引导（联发科 ROM + Shizuku 13.6.0）
// ══════════════════════════════════════════════════════════════════════════════
//
// 现场：MTK ROM 在 `LoadedApk.makeApplicationInner` 里调用 `Application.getProcessName()`
// （Shizuku 以 app_process 启动子进程时返回 null）后 `.equals()` 崩溃；子进程
// `com.dsharnessmobile.shell:dsh-vdisplay` 随即 `System.exit(1)`，Shizuku 30s 后判 not started。
// 客户端看到的只是「绑定不回调」——真实原因只存在于 logcat 的子进程堆栈里。
//
// 因此连续失败达阈值后，客户端主动截取一段 logcat（有界 + 过滤）随 status 暴露给 UI；
// 下面的纯函数负责「从日志认出现场」与「把现场翻成下一步动作」。

/** 启动失败的已知形态。 */
internal enum class ShizukuStartFailureKind { NONE, ROM_LOADED_APK_NPE, PROCESS_EXITED, UNKNOWN }

/** 诊断截取时保留的行特征：用户服务启动链、进程崩溃与 ROM 注入栈。 */
private val START_FAILURE_TOKENS = listOf(
  "dsh-vdisplay", "ShizukuServiceStarter", "makeApplicationInner", "LoadedApk",
  "FATAL EXCEPTION", "System.exit", "NullPointerException", "ShizukuUserService",
  "rikka.shizuku",
)

/**
 * 从 logcat 原文识别启动失败形态（纯函数）。
 *
 * 判据纪律：`ROM_LOADED_APK_NPE` 必须同时指向 ROM 注入栈（`makeApplicationInner`，
 * 或 `LoadedApk` + `NullPointerException`），不能只凭一句 `System.exit` 就归罪 ROM——
 * 那样会把任何用户服务的普通崩溃都误导到「降级 Shizuku」。
 */
internal fun classifyShizukuStartFailure(logs: String): ShizukuStartFailureKind {
  if (logs.isBlank()) return ShizukuStartFailureKind.NONE
  if ("makeApplicationInner" in logs ||
    ("LoadedApk" in logs && "NullPointerException" in logs)
  ) {
    return ShizukuStartFailureKind.ROM_LOADED_APK_NPE
  }
  if ("FATAL EXCEPTION" in logs || "System.exit" in logs || "has died" in logs) {
    return ShizukuStartFailureKind.PROCESS_EXITED
  }
  return ShizukuStartFailureKind.UNKNOWN
}

/**
 * 截取诊断日志尾部：只留与用户服务启动相关的行，行数与字节双重有界。
 *
 * 命中行之后最多紧跟 [STACK_CARRY] 条堆栈续行（`at ...` / `Caused by:` / `... N more`）。
 * 没有这条规则，`java.lang.NullPointerException` 之后的所有帧都会被过滤掉——而「哪个方法
 * 抛的、被谁调用」正是本 issue 需要暴露给用户的现场。
 */
internal fun shizukuDiagnosticsExcerpt(
  rawLogcat: String,
  maxLines: Int = 40,
  maxChars: Int = 6_000,
): String {
  val kept = ArrayList<String>()
  var carry = 0
  for (line in rawLogcat.lineSequence()) {
    if (START_FAILURE_TOKENS.any { token -> token in line }) {
      kept.add(line)
      carry = STACK_CARRY
      continue
    }
    if (carry > 0 && isStackContinuation(line)) {
      kept.add(line)
      carry -= 1
      continue
    }
    carry = 0
  }
  if (kept.isEmpty()) {
    return "logcat 中没有匹配到 UserService 启动失败记录" +
      "（已查找 dsh-vdisplay / ShizukuServiceStarter / LoadedApk / FATAL EXCEPTION）。"
  }
  val tail = kept.takeLast(maxLines.coerceAtLeast(1)).joinToString("\n")
  return if (tail.length <= maxChars) tail else tail.takeLast(maxChars)
}

/** 命中行后允许携带的堆栈续行数。 */
private const val STACK_CARRY = 12

/** logcat 前缀后可能紧跟栈帧（`E/AndroidRuntime( 200):     at ...`），两种线程格式都要认。 */
private val STACK_FRAME_LINE = Regex(
  """:\s+at\s+[\w.$]+\(|^\s*at\s+[\w.$]+\(|:\s+Caused by:|^\s*Caused by:|:\s+\.\.\. \d+ more|^\s*\.\.\. \d+ more""",
)

private fun isStackContinuation(line: String): Boolean =
  STACK_FRAME_LINE.containsMatchIn(line) ||
    // 异常头行本身不带匹配 token 时也要留下，否则后面的帧会全部断掉。
    Regex("""(java|android|dalvik)\.[\w.$]+(Exception|Error)""").containsMatchIn(line)

/**
 * 连续启动失败的引导文案（纯函数，中英双语，英文不得混入中文）。
 *
 * @param kind 从诊断日志识别出的形态。
 * @param failures 连续失败次数。
 * @param retryAfterMs 距离下一次自动重试的毫秒数（指数退避）。
 */
internal fun shizukuStartFailureGuidance(
  kind: ShizukuStartFailureKind,
  failures: Int,
  retryAfterMs: Long,
  english: Boolean = false,
): String {
  val retrySec = (retryAfterMs.coerceAtLeast(0L) + 999L) / 1000L
  val nextZh = if (retrySec > 0L) "下一次自动重试在 ${retrySec}s 后。" else "现在可以点「重置链接」后手动重试。"
  val nextEn = if (retrySec > 0L) "The next automatic retry is in ${retrySec}s." else "You can tap Reset link and retry now."
  if (english) {
    return when (kind) {
      ShizukuStartFailureKind.ROM_LOADED_APK_NPE ->
        "The Shizuku UserService crashed on all $failures consecutive starts: the system ROM threw " +
          "a NullPointerException in LoadedApk.makeApplicationInner and the child process called System.exit(1). " +
          "This is a known conflict between Shizuku 13.6.0 and some MediaTek ROMs; automatic retries cannot fix it. " +
          "Downgrade Shizuku to 13.5.4 (the temporary workaround) and restart this app, or switch to the ADB channel " +
          "(wireless debugging). $nextEn"
      ShizukuStartFailureKind.PROCESS_EXITED ->
        "The Shizuku UserService exited right after starting, on all $failures consecutive attempts " +
          "(the child process crash stack is in the startup log on this page). If you use Shizuku 13.6.0, " +
          "try downgrading to 13.5.4, or switch to the ADB channel. $nextEn"
      ShizukuStartFailureKind.NONE, ShizukuStartFailureKind.UNKNOWN ->
        "The Shizuku UserService failed to start $failures times in a row; the diagnosed startup log is shown " +
          "on this page (collection can take a few seconds; refresh status if it is not there yet). " +
          "If you use Shizuku 13.6.0 on a MediaTek device, try downgrading to 13.5.4 or switch to the ADB channel. $nextEn"
    }
  }
  return when (kind) {
    ShizukuStartFailureKind.ROM_LOADED_APK_NPE ->
      "Shizuku 用户服务连续 $failures 次启动即崩溃：系统 ROM 在 LoadedApk.makeApplicationInner 处抛出" +
        " NullPointerException，子进程随后 System.exit(1)。这是 Shizuku 13.6.0 与部分联发科（MTK）ROM 的" +
        "已知冲突，自动重试不会恢复。请把 Shizuku 降级到 13.5.4（临时规避）后重启本应用，或改用 ADB 通道" +
        "（无线调试）。$nextZh"
    ShizukuStartFailureKind.PROCESS_EXITED ->
      "Shizuku 用户服务连续 $failures 次启动后立即退出（子进程崩溃堆栈见本页诊断日志）。" +
        "若使用 Shizuku 13.6.0，请尝试降级到 13.5.4，或改用 ADB 通道。$nextZh"
    ShizukuStartFailureKind.NONE, ShizukuStartFailureKind.UNKNOWN ->
      "Shizuku 用户服务连续 $failures 次启动失败，诊断日志会显示在本页（截取需要数秒，暂未出现可点" +
        "「刷新状态」）。若使用 Shizuku 13.6.0 且设备为联发科，可降级到 13.5.4 或改用 ADB 通道。$nextZh"
  }
}
