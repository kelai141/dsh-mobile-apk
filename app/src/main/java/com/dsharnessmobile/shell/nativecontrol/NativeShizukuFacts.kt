package com.dsharnessmobile.shell.nativecontrol

import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次观测所属的连接票据：绑定代次 + 本地失效计数。
 *
 * 调用方必须在**发起 RPC 之前**取票，回读完成后用同一张票发布；票已失效即丢弃结果。
 * 只带代次不够：断连、重置、看门狗回收、探活失败都可能发生在**同一代次内**，
 * 那时代次没变，靠 [epoch] 才能认出「这是上一条连接的迟到结果」。
 */
internal data class LinkToken(val generation: Long, val epoch: Long, val takenAtMs: Long)

/**
 * Shizuku 事实的**非阻塞**入口：只读进程内同代缓存，不启动 Binder、不做 I/O、不读文件。
 *
 * ── 为什么不能拿 status() 当事实源 ───────────────────────────────────────────────
 * ShizukuTransport.status 是**自愈路径**：它先跑绑定看门狗（可能移除远端 UserService），
 * 再按需发起绑定，失败达阈值时还会起线程抓 logcat。这些动作在「取事实 → 决策 → 派发」
 * 的同一条调用链上都必须被禁止：一次事实读取若顺带建连或抓日志，就把只读变成了
 * 有副作用且可能阻塞数秒。
 *
 * 所以事实面与状态面在这里分家：本类只在**既有连接/探针事件**发生时记账（连接回调、
 * 断连、重置、看门狗回收、status() 已完成的读、功能探测落地、真实 uid 回读），读取侧
 * 永远只是加锁拷一份内存快照。
 *
 * ── 语义纪律 ─────────────────────────────────────────────────────────────────
 * 1. **unknown 不等于 no**：没观测过、观测过期、被新一代覆盖，一律报 unknown。
 * 2. **同连接**：每条连接级事实都带发布时的 [LinkToken]；票对不上就整条丢弃，
 *    迟到的成功不能把已断开的连接写回 yes。
 * 3. **app 授权与远端身份分开**：granted 只说本应用是否拿到 Shizuku 授权；
 *    serverUid 只说实际执行进程是 2000 / 0 / 其它。二者互不推导（uid 0 不代表已授权）。
 *    远端身份只采用真实绑定的 UserService 读到的 uid，不采用客户端的 Shizuku.getUid()
 *    （本机实测撤权后仍返回 0，不能当事实）。
 * 4. **服务不在或授权失去 = 立刻降级**：探活为 no/unknown、授权为 no/unknown 时，
 *    依赖它们的连接级事实同步清除，并推进 [LinkToken.epoch]，使在飞的结果被拒。
 * 5. 专属能力只来自当前 Binder 的明确握手，不能由通用就绪状态推断。
 * 6. **过期即 unknown**：按**观测时刻**计 TTL，反复读快照不会续命。
 *
 * 输出形状与 Rust 端 phone-control-core 的 ShizukuFactsWire 逐字段对应
 * （deny_unknown_fields：多余键会被整份拒绝，新增字段必须同步 Rust）。
 */
internal class NativeShizukuFacts(
  private val clock: () -> Long = { SystemClock.elapsedRealtime() },
  private val ttlMs: Long = DEFAULT_TTL_MS,
) {

  /** 一条带观测时刻的原始事实。 */
  private class Timed<T>(val value: T, val atMs: Long)

  private val lock = Any()

  /** 已记账的代次；从未记录时为 [Long.MIN_VALUE]。 */
  private var currentGeneration = Long.MIN_VALUE

  /** 本地失效计数：同一代次内的清除也必须让在飞结果失效。 */
  private var epoch = 0L

  // 设备/应用级事实：代次前进时保留（它们不随某条连接消失），仍受 TTL 与失效规则约束。
  private var installed: Timed<Boolean>? = null
  private var running: Timed<Boolean>? = null
  private var granted: Timed<Boolean>? = null

  // 连接级事实：代次前进或失效即作废，旧值不得冒充现状。
  private var bound: Timed<Boolean>? = null
  private var functionalReady: Timed<Boolean>? = null
  private var serverUid: Timed<Int>? = null
  private var realTap: Timed<Boolean>? = null

  /**
   * 为指定绑定代次取一张当前票（连接回调自带代次时用）。
   *
   * 票自带取票时刻：观测时刻一律由**取票**决定，不受 RPC 返回时间的抖动影响。
   */
  fun tokenAt(generation: Long): LinkToken = synchronized(lock) { LinkToken(generation, epoch, clock()) }

  /** 取当前票（不推进任何状态）。 */
  fun token(): LinkToken = synchronized(lock) { LinkToken(currentGeneration, epoch, clock()) }

  /** 已记账的代次；从未记录时为 null（诊断/判据用）。 */
  fun generation(): Long? = synchronized(lock) {
    if (currentGeneration == Long.MIN_VALUE) null else currentGeneration
  }

  /**
   * 记录连接面观测。[installed] / [running] 为 null 都表示**未知**（探活或包名查询抛异常），
   * 必须覆盖旧值——这次没探到不能继续显示上次的结论。
   *
   * 服务确认不在（no）或探不到（unknown）时，绑定与依赖它们的授权事实同步降级：
   * binder 都没了，granted=yes / bound=yes 已经不能代表现状。
   */
  fun onLink(token: LinkToken, installed: Boolean?, running: Boolean?) = synchronized(lock) {
    if (!open(token)) return
    // 同一连接内迟到的旧观测不得覆盖较新的观测（否则会拿旧结论做清除/恢复）。
    val previous = this.running
    if (previous != null && token.takenAtMs < previous.atMs) return
    val now = token.takenAtMs
    this.installed = installed?.let { Timed(it, now) }
    this.running = running?.let { Timed(it, now) }
    if (running == false) {
      // 服务确认没跑：依赖它的连接与授权事实同时作废（binder 不在，bound=yes 已经没有意义）。
      this.granted = null
      this.bound = Timed(false, now)
      this.functionalReady = null
      this.serverUid = null
      realTap = null
      invalidate()
    } else if (running == null) {
      // 探不到：不能断言 no，也不能沿用上次的 yes。
      this.granted = null
      clearConnection()
      invalidate()
    }
  }

  /** 记录本应用的 Shizuku 授权观测（null = 查询抛异常，未知）。失去授权即清连接事实。 */
  fun onGranted(token: LinkToken, granted: Boolean?) = synchronized(lock) {
    if (!open(token)) return
    val existing = this.granted
    // 同一连接内迟到的旧观测整体丢弃：既不能覆盖较新的观测，也不能触发清除
    // （撤权时仍可能有在飞的 authorized 查询，它带回的 yes 会晚于 no 落地）。
    if (existing != null && token.takenAtMs < existing.atMs) return
    this.granted = granted?.let { Timed(it, token.takenAtMs) }
    if (granted != true) {
      clearConnection()
      invalidate()
    }
  }

  /** 记录绑定观测：连接回调成功 / ping 失败 / 断连都属于肯定观测。 */
  fun onBound(token: LinkToken, bound: Boolean) = synchronized(lock) {
    if (!open(token)) return
    val existing = this.bound
    if (existing != null && token.takenAtMs < existing.atMs) return
    this.bound = Timed(bound, token.takenAtMs)
    // 连接没起来时，上一条连接留下的就绪结论与身份不能继续挂着。
    if (!bound) {
      functionalReady = null
      serverUid = null
      realTap = null
      invalidate()
    }
  }

  /**
   * 记录一次功能探测落地。[probedAtMs] 必须是**探测自身**的观测时刻：
   * 用发布时刻会把一次旧探测不断续命（读路径不能刷新 TTL）。
   *
   * 同一连接内并发探测可能乱序返回：比已记录结果更早的观测不得覆盖较新的观测。
   */
  fun onProbe(token: LinkToken, ok: Boolean, probedAtMs: Long) = synchronized(lock) {
    if (!open(token)) return
    val existing = functionalReady
    if (existing != null && probedAtMs < existing.atMs) return
    functionalReady = Timed(ok, probedAtMs)
  }

  /** 记录真实 UserService 读到的远端 uid（null 或负值 = 读不到，未知）。 */
  fun onServerUid(token: LinkToken, uid: Int?) = synchronized(lock) {
    if (!open(token)) return
    val existing = serverUid
    if (existing != null && token.takenAtMs < existing.atMs) return
    serverUid = uid?.takeIf { it >= 0 }?.let { Timed(it, token.takenAtMs) }
  }

  fun onRealTapCapability(token: LinkToken, supported: Boolean?) = synchronized(lock) {
    if (!open(token)) return
    val existing = realTap
    if (existing != null && token.takenAtMs < existing.atMs) return
    realTap = supported?.let { Timed(it, token.takenAtMs) }
  }

  fun permitsRealTap(token: LinkToken): Boolean = synchronized(lock) {
    val now = clock()
    token.generation == currentGeneration && token.epoch == epoch && readyForRealTap(now)
  }

  private fun readyForRealTap(now: Long): Boolean =
    listOf(installed, running, granted, bound, functionalReady, realTap).all { tri(it, now) == "yes" } &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, now) } == true

  /**
   * 连接断开的肯定观测（断连回调 / 用户重置 / 看门狗回收僵尸绑定）。
   *
   * [generation] 必须是**换代之后**的代次：这条记录属于新代，不是被作废的旧代。
   * 调用方须在与绑定状态机同一临界区内调用，避免与回调交错。
   */
  fun onConnectionLost(generation: Long) = synchronized(lock) {
    if (generation < currentGeneration) return
    currentGeneration = generation
    bound = Timed(false, clock())
    functionalReady = null
    serverUid = null
    realTap = null
    invalidate()
  }

  /** 新一次绑定已发起（发起前已确认未绑定）：此刻不处于绑定态。 */
  fun onBindStarted(generation: Long) = synchronized(lock) {
    if (generation < currentGeneration) return
    currentGeneration = generation
    bound = Timed(false, clock())
    functionalReady = null
    serverUid = null
    realTap = null
    invalidate()
  }

  /** 非阻塞快照：只读缓存，不做任何 Binder/IO/状态机调用，也不刷新 TTL。 */
  fun snapshot(): JSONObject = snapshotAt(clock())

  /** 把本快照挂到事实文档的 shizuku 键下（调用方负责其余字段）。 */
  fun attachTo(facts: JSONObject): JSONObject = facts.put("shizuku", snapshot())

  /**
   * 事实入口装饰器：其余字段原样取自 [inner]，只补上 shizuku 键。
   * 既有采集器一行不用改，也不会因为接入 Shizuku 多一次 Binder 调用。
   */
  fun factsEntry(inner: NativeControlDispatcher.Facts): NativeControlDispatcher.Facts =
    NativeControlDispatcher.Facts { attachTo(inner.capture()) }

  internal fun snapshotAt(now: Long): JSONObject = synchronized(lock) {
    val tap = readyForRealTap(now)
    JSONObject()
      .put("installed", tri(installed, now))
      .put("running", tri(running, now))
      .put("granted", tri(granted, now))
      .put("bound", tri(bound, now))
      .put("functionalReady", tri(functionalReady, now))
      .put("serverUid", serverUidJson(now))
      .put("supportedOps", if (tap) JSONObject().put("state", "known").put("ops", JSONArray().put("click"))
        else JSONObject().put("state", "unknown"))
      .put("displaySupport", if (tap) JSONObject().put("state", "known").put("values", JSONObject().put("0", true))
        else JSONObject().put("state", "unknown"))
  }

  /**
   * 票准入（调用方必须持锁）。
   *
   * - 代次**落后**：旧代迟到回调，整条丢弃。
   * - 代次**前进**：丢弃连接面事实后接受（设备级事实不随连接消失）。
   * - epoch 不符：同一代次内已发生清除，这条结果属于此前那条连接，丢弃。
   */
  private fun open(token: LinkToken): Boolean {
    if (token.epoch != epoch || token.generation < currentGeneration) return false
    if (token.generation > currentGeneration) {
      currentGeneration = token.generation
      clearConnection()
    }
    return true
  }

  private fun clearConnection() {
    bound = null
    functionalReady = null
    serverUid = null
    realTap = null
  }

  private fun invalidate() {
    epoch += 1
  }

  private fun fresh(atMs: Long, now: Long): Boolean = now - atMs in 0..ttlMs

  private fun tri(value: Timed<Boolean>?, now: Long): String = when {
    value == null || !fresh(value.atMs, now) -> "unknown"
    value.value -> "yes"
    else -> "no"
  }

  /** 远端身份三档严格分开：0 = root0，2000 = shell2000，其它正值 = other(uid)，其余一律 unknown。 */
  private fun serverUidJson(now: Long): JSONObject {
    val observed = serverUid
    if (observed == null || !fresh(observed.atMs, now)) return JSONObject().put("kind", "unknown")
    return when (observed.value) {
      0 -> JSONObject().put("kind", "root0")
      2000 -> JSONObject().put("kind", "shell2000")
      else -> JSONObject().put("kind", "other").put("uid", observed.value)
    }
  }

  companion object {
    /**
     * 事实有效期：与既有功能探测缓存同口径（30s）。过期不是 no，而是 unknown——
     * 读侧只报「我还知道什么」，不替 Rust 猜。
     */
    const val DEFAULT_TTL_MS = 30_000L

    /** 进程内唯一实例：发布方是 ShizukuTransport 的既有事件点，读取方是原生事实采集。 */
    val shared = NativeShizukuFacts()
  }
}
