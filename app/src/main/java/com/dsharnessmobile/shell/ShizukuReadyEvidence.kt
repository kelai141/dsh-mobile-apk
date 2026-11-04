package com.dsharnessmobile.shell

/**
 * Shizuku「就绪」的**功能性证据**与**失败留痕**（issue #1476）。
 *
 * 背景：`status()` 原来只验证 binder 活着（`binderAlive()` + `service.pingBinder()`），
 * 而 binder 代理活着**不等于** UserService 可用——进程已死但代理未失效、被系统限额、起来又崩，
 * 都会让面板报「已就绪」而 `exec` 一调就抛。用户看到的是「面板 ready、命令 timeout」这种对立。
 *
 * 这里只放**纯判据**，不碰 binder、不碰 Context：
 * - [FunctionalProbeCache]：功能探测结果 + TTL 缓存（2s 轮询不能每次都打 binder）；
 * - [startFailureDiagnostic]：静默失败（无 logcat 特征）也要有一条结构化诊断；
 * - [readinessVerdict]：把「binder 活 / 已授权 / 已绑定 / 功能探测」合成一个可测的结论。
 */

/** 功能探测结果的一档快照。 */
internal data class FunctionalProbeSnapshot(
  /** 是否已探测过（false = 从未探测）。 */
  val probed: Boolean,
  /** 最近一次探测是否成功。 */
  val ok: Boolean,
  /** 最近一次探测的协议版本；-1 = 探测失败。 */
  val protocolVersion: Int,
  /** 最近一次探测的失败原因（成功时为空串）。 */
  val error: String,
  /** 最近一次探测的时刻（调用方时钟，毫秒）。 */
  val atMs: Long,
)

/**
 * 功能探测的 TTL 缓存。
 *
 * 为什么需要 TTL：`status()` 在设置页与面板被 **2s 轮询**，而功能探测是一次真 binder 往返
 * （`protocolVersion()`）。不缓存会把 binder 打成高频调用；缓存太久又会让「刚坏掉」瞒很久。
 * 取 30s：2s 轮询下等于 15 次轮询探一次，坏掉后最迟 30s 内被发现。
 *
 * **TTL 过期不等于 not-ready**：过期时沿用上一次结果并标记 `stale`，同时异步补一次探测——
 * 否则 30s 一到面板会闪一下（用户可见的假抖动）。
 *
 * @param ttlMs 缓存有效期（毫秒）。
 * @param clock 可注入时钟（JVM 单测用）。
 */
internal class FunctionalProbeCache(
  private val ttlMs: Long = FunctionalProbeCache.DEFAULT_TTL_MS,
  private val clock: () -> Long,
) {
  /**
   * 真正发起过多少次探测（判据用它做**计数断言**，而不是看源码）。
   *
   * issue #1512：原来是裸 `var`，`probeCalls += 1` 在多线程下会丢计数；改原子量。
   */
  private val calls = java.util.concurrent.atomic.AtomicInteger(0)
  val probeCalls: Int get() = calls.get()

  /**
   * 最近一次快照。
   *
   * issue #1512：由探测线程写、`status()` 的调用线程读，**必须 `@Volatile`**——
   * 否则弱内存下读侧可能长期看到 `probed=false`（表现为面板永久 `shizuku-probe-pending`
   * 且每轮都重新 kick，把 binder 反复打）。
   */
  @Volatile
  private var snapshot = FunctionalProbeSnapshot(
    probed = false, ok = false, protocolVersion = -1, error = "", atMs = 0L,
  )

  /** 单飞锁：`shouldProbe` 判断与写回必须是同一个原子区，否则两路都看到过期就都会打 binder。 */
  private val probeLock = Any()

  /** 最近一次快照（不触发探测）。 */
  fun current(): FunctionalProbeSnapshot = snapshot

  /** 快照是否仍在 TTL 内（从未探测过时视为不新鲜）。 */
  fun isFresh(now: Long = clock()): Boolean =
    snapshot.probed && now - snapshot.atMs in 0..ttlMs

  /** 是否该发起一次探测：从未探测，或已过 TTL。 */
  fun shouldProbe(now: Long = clock()): Boolean = !isFresh(now)

  /**
   * 一次探测：**只在 TTL 过期或从未探测时**真的调用 [run]。
   *
   * @param run 真正打 binder 的探测（返回协议版本；抛异常表示失败）。
   * @returns 探测后的快照。
   */
  fun probeIfNeeded(run: () -> Int, now: Long = clock()): FunctionalProbeSnapshot = synchronized(probeLock) {
    // 读侧（current/isFresh）**不加锁**、只读 @Volatile 快照；锁只保护「判断 + 写回」这段。
    if (!shouldProbe(now)) return snapshot
    calls.incrementAndGet()
    snapshot = try {
      val pv = run()
      FunctionalProbeSnapshot(probed = true, ok = true, protocolVersion = pv, error = "", atMs = now)
    } catch (t: Throwable) {
      FunctionalProbeSnapshot(
        probed = true, ok = false, protocolVersion = -1,
        error = t.javaClass.simpleName + ": " + (t.message ?: ""), atMs = now,
      )
    }
    snapshot
  }

  companion object {
    /** 30s：2s 轮询下 15 次探一次；坏掉后最迟 30s 被发现，且不会每次轮询都打 binder。 */
    const val DEFAULT_TTL_MS = 30_000L
  }
}

/** 就绪判据的输入事实（全部由调用方喂，纯数据）。 */
internal data class ReadyFacts(
  val binderAlive: Boolean,
  val granted: Boolean,
  val version: Int,
  val bound: Boolean,
  val probe: FunctionalProbeSnapshot,
)

/** 就绪判据的结论。 */
internal data class ReadyVerdict(
  val ok: Boolean,
  val code: String,
  /** 功能探测是否只是**缓存命中**（TTL 内），供诊断面如实标注。 */
  val probeFromCache: Boolean,
  /** 功能探测是否已过期（沿用上次结果，正在异步补测）。 */
  val probeStale: Boolean,
)

/**
 * 把四类事实合成一个就绪结论（纯函数，JVM 单测直接钉）。
 *
 * 关键点：**binder 活着不算就绪**——必须有功能探测成功的证据；探测失败给专用 code，
 * 不与「未绑定」「版本过低」混成一个。TTL 过期时沿用上次结果（不闪），但标注 stale。
 *
 * @param now 当前时刻（与 [FunctionalProbeSnapshot.atMs] 同时钟）。
 * @param ttlMs 探测结果的 TTL。
 */
internal fun readinessVerdict(facts: ReadyFacts, now: Long, ttlMs: Long = FunctionalProbeCache.DEFAULT_TTL_MS): ReadyVerdict {
  if (!facts.binderAlive) return ReadyVerdict(false, "shizuku-not-running", false, false)
  if (facts.version < 12) return ReadyVerdict(false, "shizuku-prev11", false, false)
  if (!facts.granted) return ReadyVerdict(false, "shizuku-denied", false, false)
  if (!facts.bound) return ReadyVerdict(false, ShizukuBindCodes.NOT_BOUND, false, false)
  val probe = facts.probe
  if (!probe.probed) {
    // 从未探测过：不能凭 binder 就宣称就绪（调用方会立刻异步补一次探测）。
    return ReadyVerdict(false, READY_PROBE_PENDING, false, false)
  }
  val stale = now - probe.atMs !in 0..ttlMs
  if (!probe.ok) return ReadyVerdict(false, READY_PROBE_FAILED, false, stale)
  return ReadyVerdict(true, "shizuku-ready", probeFromCache = !stale, probeStale = stale)
}

/** 功能探测失败（UserService 在 binder 上不可用）。 */
internal const val READY_PROBE_FAILED = "shizuku-user-service-unresponsive"

/** 尚未完成首次功能探测。 */
internal const val READY_PROBE_PENDING = "shizuku-probe-pending"

/**
 * 启动失败的结构化诊断（issue #1476 第 3 点）。
 *
 * 缺陷形态：`startFailed` 之后只去 logcat 抓**已知崩溃特征**（联发科 `makeApplicationInner` NPE 等）。
 * 「bind 无回调」这类静默失败在 logcat 里没有任何特征行 ⇒ 诊断为空，用户什么也看不到。
 *
 * 所以：抓不到特征时也要有一条**自证**的诊断，写清尝试次数与已等时长。
 *
 * @param attempts 已发起的绑定次数。
 * @param ageMs 当前这次尝试已等待的毫秒数。
 * @param excerpt logcat 摘录（空 = 没有任何特征）。
 */
internal fun startFailureDiagnostic(attempts: Int, ageMs: Long, excerpt: String): String {
  val trimmed = excerpt.trim()
  if (trimmed.isNotEmpty()) return trimmed
  return "无回调超时（attempts=" + attempts + ", age=" + ageMs + "ms, 无 logcat 特征）"
}
