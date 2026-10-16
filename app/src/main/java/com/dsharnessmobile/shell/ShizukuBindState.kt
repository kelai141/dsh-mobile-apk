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

  private val lock = Any()
  private var bindingFlag = false
  private var bindingSince = 0L
  private var attemptCount = 0
  private var generation = 0L

  /** 每次发起或作废连接都换代；旧回调不能改写新一轮的记账。 */
  val currentGeneration: Long get() = synchronized(lock) { generation }
  private var error = ShizukuBindCodes.NOT_BOUND

  /** 是否确有一次绑定在飞（**只有它才配得上「正在建立」这四个字**）。 */
  val binding: Boolean get() = synchronized(lock) { bindingFlag }

  /** 已发起的绑定次数（反证用：看门狗复位后第二次调用必须**确实再次发起**）。 */
  val attempts: Int get() = synchronized(lock) { attemptCount }

  /** 最近一次失败/进行中的结构化 code（空串 = 已连上且 binder 有效）。 */
  val lastError: String get() = synchronized(lock) { error }

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
  fun onConnected(binderValid: Boolean, callbackGeneration: Long = currentGeneration): Boolean = synchronized(lock) {
    if (callbackGeneration != generation || !bindingFlag) return false
    bindingFlag = false
    error = if (binderValid) "" else ShizukuBindCodes.INVALID_BINDER
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
  fun onBindThrew(errorCode: String, callbackGeneration: Long = currentGeneration): Boolean = synchronized(lock) {
    if (callbackGeneration != generation) return false
    bindingFlag = false
    generation += 1
    error = errorCode
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
    Unit
  }
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
internal fun shizukuBindGuidance(code: String, binding: Boolean, ageMs: Long, watchdogMs: Long): String {
  val watchdogSec = watchdogMs / 1000
  if (binding) {
    val waitedSec = if (ageMs >= 0L) ageMs / 1000 else 0L
    return "Shizuku shell 通道正在建立（已等待 ${waitedSec}s，上限 ${watchdogSec}s）；" +
      "请稍候直接重试同一命令，无需去设置页排查。"
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
