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
internal data class LinkToken(val generation: Long, val epoch: Long, val takenAtMs: Long) {
  fun sameConnectionAs(other: LinkToken): Boolean = generation == other.generation && epoch == other.epoch
}

/**
 * 一次 per-display 能力观测。
 *
 * [bits] 是 AIDL `nativeDisplayCapabilities` 当场测出来的位图：
 * bit 0 = 焦点编辑器文本、bit 1 = 原始树、bit 2 = 节点动作、bit 3 = 原始帧。
 * 本类不推导未测的位，也不把某块屏的能力算到另一块屏头上。
 */
internal data class DisplayCapabilities(val alias: String, val bits: Int)

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
  private var realText: Timed<Boolean>? = null
  private var realTree: Timed<Boolean>? = null
  private var featureBits: Timed<Int>? = null

  /**
   * per-display 实测能力：displayId -> (alias, bits)。
   *
   * 只能由 [onDisplayCapabilities] 在**同一条连接**上写入；整表随连接失效一起清空，
   * 绝不让旧连接测到的虚拟屏能力继续对新一代连接可见。
   */
  private var displayBits: Timed<Map<Int, DisplayCapabilities>>? = null

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
      realText = null
      realTree = null
      featureBits = null
      displayBits = null
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
      realText = null
      realTree = null
      featureBits = null
      displayBits = null
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

  /**
   * 记录实测的焦点编辑器文本能力（bit 1）。未知不得由点按能力推导，也不得由就绪状态推导。
   * 同一连接内迟到的旧观测不覆盖较新的观测。
   */
  fun onRealTextCapability(token: LinkToken, supported: Boolean?) = synchronized(lock) {
    if (!open(token)) return
    val existing = realText
    if (existing != null && token.takenAtMs < existing.atMs) return
    realText = supported?.let { Timed(it, token.takenAtMs) }
  }

  /**
   * 记录实测的原始 UI 树读取能力（bit 2）。未知不得由点按/文本能力或就绪状态推导。
   * 同一连接内迟到的旧观测不覆盖较新的观测。
   */
  fun onRealTreeCapability(token: LinkToken, supported: Boolean?) = synchronized(lock) {
    if (!open(token)) return
    val existing = realTree
    if (existing != null && token.takenAtMs < existing.atMs) return
    realTree = supported?.let { Timed(it, token.takenAtMs) }
  }

  fun onNativeFeatures(token: LinkToken, bits: Int?) = synchronized(lock) {
    if (!open(token)) return
    if (featureBits?.let { token.takenAtMs < it.atMs } == true) return
    featureBits = bits?.let { Timed(it, token.takenAtMs) }
  }

  fun permitsFeature(token: LinkToken, bit: Int): Boolean = synchronized(lock) {
    token.generation == currentGeneration && token.epoch == epoch && readyFeature(bit, clock())
  }

  private fun readyFeature(bit: Int, now: Long): Boolean =
    listOf(installed, running, granted, bound, functionalReady).all { tri(it, now) == "yes" } &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, now) } == true &&
      featureBits?.let { fresh(it.atMs, now) && it.value and bit != 0 } == true

  fun permitsRealTap(token: LinkToken): Boolean = synchronized(lock) {
    val now = clock()
    token.generation == currentGeneration && token.epoch == epoch && readyForRealTap(now)
  }

  /** 文本派发同样要求整条连接就绪、真实 uid2000 与已实测的 bit 1；不认识的能力不会放行。 */
  fun permitsRealText(token: LinkToken): Boolean = synchronized(lock) {
    val now = clock()
    token.generation == currentGeneration && token.epoch == epoch && readyForRealText(now)
  }

  /** 树读取要求整条连接就绪、真实 uid2000 与已实测的 bit 2；三种能力互不推导。 */
  fun permitsRealTree(token: LinkToken): Boolean = synchronized(lock) {
    val now = clock()
    token.generation == currentGeneration && token.epoch == epoch && readyForRealTree(now)
  }

  /**
   * 记录一轮 per-display 实测能力。[displays] 是本次**真正测过**的屏；null 表示这一轮没测成
   * （观测未知，不得沿用上一轮的结论）。
   *
   * 整表覆盖：某块虚拟屏这一轮测不到 / 已销毁，就必须从表里消失，不能让上一次的位继续生效。
   */
  fun onDisplayCapabilities(token: LinkToken, displays: Map<Int, DisplayCapabilities>?) =
    synchronized(lock) {
      if (!open(token)) return@synchronized
      if (displayBits?.let { token.takenAtMs < it.atMs } == true) return@synchronized
      displayBits = displays?.let { Timed(LinkedHashMap(it), token.takenAtMs) }
    }

  /**
   * 某块屏上的某个 op 现在是否可派发。
   *
   * display 0 只认真实屏的实测位；其它 display 只认同一连接上按该 displayId 测出来的位，
   * 并且要求 alias 与当前注册一致——绝不用别块屏的能力代替目标屏。
   */
  fun permitsDisplay(token: LinkToken, displayId: Int, alias: String, operation: String): Boolean =
    synchronized(lock) {
      if (token.generation != currentGeneration || token.epoch != epoch) return@synchronized false
      val now = clock()
      if (!shellReady(now)) return@synchronized false
      val measured = displayOpsAt(now)[displayId] ?: return@synchronized false
      if (displayId != 0 && displayAlias(now, displayId) != alias) return@synchronized false
      when (operation) {
        // "read" 是节点动作前的只读核对，不是独立 op：它要求该屏测到节点能力。
        "read" -> "nodeText" in measured
        else -> operation in measured
      }
    }

  /** 当前连接已实测的屏与它们的 op（诊断/探针用；不刷新 TTL）。 */
  fun measuredDisplayOperations(): Map<Int, List<String>> = synchronized(lock) {
    displayOpsAt(clock())
  }

  /**
   * 坐标手势（input -d &lt;displayId&gt;）的准入：必须是该屏自己测到的 bit 16。
   * 节点位也能点，但那是「按 window/path 的节点动作」，不能替代坐标落点。
   */
  fun permitsCoordinateGesture(token: LinkToken, displayId: Int, alias: String): Boolean =
    synchronized(lock) {
      if (token.generation != currentGeneration || token.epoch != epoch) return@synchronized false
      if (!shellReady(clock())) return@synchronized false
      if (displayId == 0) return@synchronized readyFeature(16, clock())
      val measured = measuredDisplays(clock())[displayId] ?: return@synchronized false
      measured.alias == alias && measured.bits and 16 != 0
    }

  /**
   * 焦点编辑器文本的准入：display 0 看实测的 bit 1；虚拟屏看该屏自己的 bit 0。
   *
   * 事实面按 op 名发布时，「setText」既要覆盖节点 setText 也要覆盖焦点文本，二者同名但通道不同。
   * 所以真正的区分放在这里：焦点文本只认文本位，节点 setText 走节点位。
   */
  fun permitsFocusedText(token: LinkToken, displayId: Int, alias: String): Boolean =
    synchronized(lock) {
      if (token.generation != currentGeneration || token.epoch != epoch) return@synchronized false
      if (!shellReady(clock())) return@synchronized false
      if (displayId == 0) return@synchronized readyForRealText(clock())
      val measured = measuredDisplays(clock())[displayId] ?: return@synchronized false
      measured.alias == alias && measured.bits and 1 != 0
    }

  /**
   * 服务端回执的取票核对：同一条连接、票据仍有效、远端仍是真实 uid2000。
   * 回执只能在其派发所属连接上被接受，不能跨代写入。
   */
  internal fun sameRealShellConnection(token: LinkToken): Boolean = synchronized(lock) {
    token.generation == currentGeneration && token.epoch == epoch &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, clock()) } == true
  }

  /** 与 [sameRealShellConnection] 同一判据；多屏路径用这个名字表达「同一条 shell 连接」。 */
  internal fun sameShellConnection(token: LinkToken): Boolean = sameRealShellConnection(token)

  private fun shellReady(now: Long): Boolean =
    listOf(installed, running, granted, bound, functionalReady).all { tri(it, now) == "yes" } &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, now) } == true

  /** 真实屏（display 0）当前可派的 op；每条都来自各自实测的位，互不推导。 */
  private fun realOps(now: Long): List<String> = buildList {
    if (readyForRealTap(now)) add("click")
    if (readyForRealText(now)) add("setText")
    if (readyForRealTree(now)) add("snapshot")
    if (readyFeature(8, now)) addAll(listOf("screenshot", "readRegion"))
    if (readyFeature(16, now)) addAll(listOf("longClick", "scroll", "swipe", "keyEvent", "global", "launchApp"))
    if (readyFeature(32, now)) add("nodeText")
  }

  /**
   * 虚拟屏的 op 只由该屏实测的位图展开。五个位互相独立：
   * 1 = 焦点编辑器文本、2 = 原始树、4 = 节点读数/动作、8 = 原始帧、16 = 坐标手势。
   * 节点 setText 属于节点位，焦点文本属于文本位，两者不能互相顶替。
   */
  private fun virtualOps(bits: Int): List<String> = buildList {
    if (bits and 1 != 0) add("setText")
    if (bits and 2 != 0) add("snapshot")
    // 节点位覆盖「按 window/path」的节点读数与动作（click/longClick/scroll/setText/nodeText）。
    // 坐标形态的 click/longClick/scroll 由位 16 单独发布；两处都出现时只保留一份。
    if (bits and 4 != 0) for (operation in listOf("click", "longClick", "scroll", "setText", "nodeText")) {
      if (operation !in this) add(operation)
    }
    if (bits and 8 != 0) addAll(listOf("screenshot", "readRegion"))
    // 位 16 = coordinate/key gestures：click/longClick/scroll 的坐标形态 + swipe + keyEvent。
    // global 也由这一位发布（虚拟屏只有 back 能带目标 display 成立）；
    // home/recents/notifications 的拒绝在执行侧按动作逐条给出明确错误码，绝不落到真实屏。
    if (bits and 16 != 0) addAll(listOf("click", "longClick", "scroll", "swipe", "keyEvent", "global"))
  }

  private fun measuredDisplays(now: Long): Map<Int, DisplayCapabilities> =
    displayBits?.takeIf { fresh(it.atMs, now) }?.value ?: emptyMap()

  private fun displayAlias(now: Long, displayId: Int): String? =
    measuredDisplays(now)[displayId]?.alias

  /** displayId -> 当前可派 op。display 0 只来自真实屏实测位，其它只来自该屏实测位。 */
  private fun displayOpsAt(now: Long): Map<Int, List<String>> {
    val out = LinkedHashMap<Int, List<String>>()
    val real = realOps(now)
    if (real.isNotEmpty()) out[0] = real
    for ((id, capability) in measuredDisplays(now)) {
      if (id <= 0) continue
      // 一块屏测过就如实出现，哪怕这一轮四位全零：全零是「测过、但都不支持」，不是 unknown。
      out[id] = virtualOps(capability.bits)
    }
    return out
  }

  private fun readyForRealTap(now: Long): Boolean =
    listOf(installed, running, granted, bound, functionalReady, realTap).all { tri(it, now) == "yes" } &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, now) } == true

  private fun readyForRealText(now: Long): Boolean =
    listOf(installed, running, granted, bound, functionalReady, realText).all { tri(it, now) == "yes" } &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, now) } == true

  private fun readyForRealTree(now: Long): Boolean =
    listOf(installed, running, granted, bound, functionalReady, realTree).all { tri(it, now) == "yes" } &&
      serverUid?.let { it.value == 2000 && fresh(it.atMs, now) } == true

  /**
   * 连接断开的肯定观测（断连回调 / 用户重置 / 看门狗回收僵尸绑定）。
   *
   * [generation] 必须是**换代之后**的代次：这条记录属于新代，不是被作废的旧代。
   * 调用方须在与绑定状态机同一临界区内调用，避免与回调交错。
   */
  fun onConnectionLost(generation: Long) = synchronized(lock) {
    if (generation < currentGeneration) return@synchronized
    currentGeneration = generation
    bound = Timed(false, clock())
    functionalReady = null
    serverUid = null
    realTap = null
    realText = null
    realTree = null
    featureBits = null
    displayBits = null
    invalidate()
  }

  /** 新一次绑定已发起（发起前已确认未绑定）：此刻不处于绑定态。 */
  fun onBindStarted(generation: Long) = synchronized(lock) {
    if (generation < currentGeneration) return@synchronized
    currentGeneration = generation
    bound = Timed(false, clock())
    functionalReady = null
    serverUid = null
    realTap = null
    realText = null
    realTree = null
    featureBits = null
    displayBits = null
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
    val perDisplay = displayOpsAt(now)
    // supportedOps 是各屏可派 op 的并集（Rust 只在缺 displayOperations 时才回落到它）。
    // 列表顺序固定，便于判据与诊断对齐；内容只来自各屏实测，不补默认项。
    val union = JSONArray()
    for (operation in KNOWN_OPERATIONS) {
      if (perDisplay.values.any { operation in it }) union.put(operation)
    }
    // displayOperations 是实时 per-display 真源：只列出本次真正测过的屏，绝不补默认值。
    val displayOperations = JSONObject()
    for ((displayId, operations) in perDisplay.entries.sortedBy { it.key }) {
      val ordered = JSONArray()
      for (operation in KNOWN_OPERATIONS) if (operation in operations) ordered.put(operation)
      displayOperations.put(displayId.toString(), ordered)
    }
    val displayValues = JSONObject()
    for (displayId in perDisplay.keys.sorted()) displayValues.put(displayId.toString(), true)
    val facts = JSONObject()
      .put("installed", tri(installed, now))
      .put("running", tri(running, now))
      .put("granted", tri(granted, now))
      .put("bound", tri(bound, now))
      .put("functionalReady", tri(functionalReady, now))
      .put("serverUid", serverUidJson(now))
      .put("supportedOps", if (union.length() > 0)
        JSONObject().put("state", "known").put("ops", union)
        else JSONObject().put("state", "unknown"))
      .put("displaySupport", if (perDisplay.isNotEmpty())
        JSONObject().put("state", "known").put("values", displayValues)
        else JSONObject().put("state", "unknown"))
    // 一个屏都没测过时整键缺席：Rust 只有在该键存在时才把它当唯一真源。
    if (perDisplay.isNotEmpty()) facts.put("displayOperations", displayOperations)
    facts
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
    realText = null
    realTree = null
    featureBits = null
    displayBits = null
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
    /** 事实面与判据共用的固定 op 顺序；不含任何未实测项。 */
    /**
     * 事实面与判据共用的固定 op 顺序；不含任何未实测项。
     *
     * 顺序把同一类动作聚在一起：坐标手势 → 键事件 → 文本 → 树 → 图像 → 全局/启动。
     */
    private val KNOWN_OPERATIONS = listOf("click", "longClick", "scroll", "swipe", "keyEvent",
      "setText", "nodeText", "global", "snapshot", "screenshot", "readRegion", "launchApp")

    /**
     * 事实有效期：与既有功能探测缓存同口径（30s）。过期不是 no，而是 unknown——
     * 读侧只报「我还知道什么」，不替 Rust 猜。
     */
    const val DEFAULT_TTL_MS = 30_000L

    /** 进程内唯一实例：发布方是 ShizukuTransport 的既有事件点，读取方是原生事实采集。 */
    val shared = NativeShizukuFacts()
  }
}
