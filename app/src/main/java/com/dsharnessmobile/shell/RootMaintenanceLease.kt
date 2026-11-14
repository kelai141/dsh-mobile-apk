package com.dsharnessmobile.shell

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONObject
import java.io.File

/** Durable admission quarantine, not proof that a su client kill terminated a privileged helper. */
internal object RootMaintenanceLease {
  private const val PREFS = "dsh_root_execution_lease"
  private const val KEY_EPOCH = "epoch"
  private const val KEY_STARTED = "startedAt"
  private const val KEY_OPERATION = "operation"
  private const val KEY_DISPATCHED = "dispatched"
  private const val KEY_DISPATCHED_AT = "dispatchedAt"
  /** PRD §5.2 / AC-08：一次维护的**唯一操作 ID**，随租约落盘，回执凭它自证属于本次。 */
  private const val KEY_OPERATION_ID = "operationId"
  private val lock = Any()
  private var initialized = false
  private var pendingEpoch: String? = null
  private var startedAt = 0L
  private var operation = ""
  private var dispatched = ""
  private var dispatchedAt = 0L
  private var operationId = ""
  private var owner: Thread? = null
  private var unknown = false
  /** 本次 job 预分配的 ID（由调用方线程设置）；beginOperation 优先采用它。 */
  private val jobId = ThreadLocal<String?>()

  /**
   * 在 [block] 执行期间为「本线程发起的维护」预置唯一操作 ID。
   *
   * 用途：调用方（RootOwnershipJobs）先知道本次 ID，再让深处的 beginOperation 采用它；
   * 这样即使某条通道的结果自己不带 ID，调用方仍能把本次 ID 盖上去，不会把本次结果误判成历史。
   */
  fun <T> withOperationId(id: String, block: () -> T): T {
    val previous = jobId.get()
    jobId.set(id)
    return try {
      block()
    } finally {
      if (previous == null) jobId.remove() else jobId.set(previous)
    }
  }

  /**
   * 唯一操作 ID 的纯生成器（可注入随机源，便于 JVM 判据）。
   *
   * 形态：32 位小写十六进制。只允许 [0-9a-f]，与 [isCanonicalOperationId] 严格对应；
   * 碰撞概率可忽略，且 ID 只用于「是不是同一次任务」的自证，不是认证凭据。
   */
  internal fun newOperationId(random: () -> Long): String {
    // 按位截断取低 32 位。不能用 minOf(random, 0xFFFFFFFF)：随机值几乎总大于上限，
    // 截断会退化成常量（本函数曾因此产出全 f 的 ID，被单测抓住）。
    fun chunk(): String = (random() and 0xFFFF_FFFFL).toString(16).padStart(8, '0')
    return chunk() + chunk() + chunk() + chunk()
  }

  /** 唯一操作 ID 的形态判据（纯函数）：长度固定、全小写十六进制、非全零占位不符。 */
  internal fun isCanonicalOperationId(value: String?): Boolean =
    value != null && value.length == 32 && value.all { it in '0'..'9' || it in 'a'..'f' }

  /**
   * 结算准入（纯函数）：只有**原 owner 线程 + 租约未被判为 unknown +（给了期望 ID 时）ID 相符**
   * 才能清租约。
   *
   * 期望 ID 为 null 表示调用方未携带本次 ID（旧调用的兼容形态）：此时仍执行原有的
   * owner/unknown 双重校验，**不放松**任何一条。
   */
  internal fun finishAllowed(
    ownerMatches: Boolean,
    leaseUnknown: Boolean,
    currentId: String,
    expectedId: String?,
  ): Boolean {
    if (!ownerMatches || leaseUnknown) return false
    if (expectedId.isNullOrEmpty()) return true
    // 带期望 ID 时，租约上的 ID 必须非空且逐字相符。
    return currentId.isNotEmpty() && expectedId == currentId
  }

  /** A missing epoch cannot authorize clearing an earlier process's pending work. */
  internal fun newBoot(saved: String?, current: String?): Boolean =
    !saved.isNullOrBlank() && !current.isNullOrBlank() &&
      saved.substringBefore(':') in setOf("boot-id", "boot-count") &&
      saved.substringBefore(':') == current.substringBefore(':') && saved != current

  private fun bootEpoch(context: Context): String? {
    val uuid = try {
      File("/proc/sys/kernel/random/boot_id").inputStream().use { input ->
        val bytes = ByteArray(80)
        val count = input.read(bytes)
        if (count > 0) String(bytes, 0, count, Charsets.US_ASCII).trim() else ""
      }
    } catch (_: Exception) { "" }
    if (Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").matches(uuid)) return "boot-id:" + uuid.lowercase()
    val count = try { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1) }
    catch (_: Exception) { -1 }
    return count.takeIf { it >= 0 }?.let { "boot-count:$it" }
  }

  private fun restore(context: Context) {
    if (initialized) return
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    pendingEpoch = prefs.getString(KEY_EPOCH, null)
    startedAt = prefs.getLong(KEY_STARTED, 0L)
    operation = prefs.getString(KEY_OPERATION, "privileged-operation").orEmpty()
    dispatched = prefs.getString(KEY_DISPATCHED, "").orEmpty()
    dispatchedAt = prefs.getLong(KEY_DISPATCHED_AT, 0L)
    operationId = prefs.getString(KEY_OPERATION_ID, "").orEmpty()
    if (pendingEpoch != null && newBoot(pendingEpoch, bootEpoch(context)) && prefs.edit().clear().commit()) {
      pendingEpoch = null; startedAt = 0L; operation = ""; dispatched = ""; dispatchedAt = 0L; operationId = ""
    }
    unknown = pendingEpoch != null
    initialized = true
  }

  /** Persist before dispatch. If durability cannot be established, do not launch privileged work. */
  fun begin(context: Context, operation: String): JSONObject? = beginOperation(context, operation).second

  /**
   * 同 [begin]，但同时回传**本次**唯一操作 ID（PRD 5.2 / AC-08）。
   *
   * ID 与租约在同一次 commit 内落盘：先持久化再派发，回执凭 ID 自证属于本次任务，
   * 历史结果不可能冒充它。被拒绝时 second 为拒绝 JSON、first 为 null。
   */
  fun beginOperation(context: Context, operation: String, id: String? = null): Pair<String?, JSONObject?> =
    synchronized(lock) {
    restore(context)
    if (pendingEpoch != null) return@synchronized (null to refusalLocked())
    val epoch = bootEpoch(context)
      ?: return@synchronized (null to JSONObject().put("ok", false)
        .put("code", "root-maintenance-epoch-unavailable").put("reason", "root-maintenance-epoch-unavailable")
        .put("guidance", "无法确认设备启动标识，本次不派发特权工作。"))
    val random = java.security.SecureRandom()
    val chosenId = (id ?: jobId.get() ?: newOperationId { random.nextLong() })
      .takeIf { isCanonicalOperationId(it) }
      ?: return@synchronized (null to JSONObject().put("ok", false).put("code", "invalid-operation-id")
        .put("reason", "invalid-operation-id").put("guidance", "操作标识不合法，本次不派发特权工作。"))
    val started = SystemClock.elapsedRealtime().coerceAtLeast(1L)
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.edit().putString(KEY_EPOCH, epoch).putLong(KEY_STARTED, started)
        .putString(KEY_OPERATION, operation.take(64))
        .putString(KEY_DISPATCHED, "").putLong(KEY_DISPATCHED_AT, 0L)
        .putString(KEY_OPERATION_ID, chosenId).commit()) {
      return@synchronized (null to JSONObject().put("ok", false).put("code", "root-maintenance-lease-unavailable")
        .put("reason", "root-maintenance-lease-unavailable").put("guidance", "特权执行租约不能持久化，本次不派发。"))
    }
    pendingEpoch = epoch; startedAt = started; this.operation = operation.take(64)
    operationId = chosenId
    dispatched = ""; dispatchedAt = 0L
    owner = Thread.currentThread(); unknown = false
    chosenId to null
  }

  /** 当前租约的唯一操作 ID（无租约时为空串）。 */
  fun operationId(context: Context?): String = synchronized(lock) {
    if (context == null) return@synchronized operationId
    restore(context)
    if (pendingEpoch == null) "" else operationId
  }

  /** 当前线程预置的 job ID（未预置为 null）。仅供调用方自检与判据。 */
  internal fun currentJobId(): String? = jobId.get()

  /**
   * 记录「特权工作已经真正派发出去」——这是**自动清算的唯一否决证据**（2026-10-02 复审第 2 点）：
   * `synchronized` 只证明本进程内互斥，**证明不了外部 su 子进程 / Shizuku UserService 已经退出**。
   * 所以租约一旦带上这个标记，就再也不能仅凭「当前通道看起来不存在」被自动清掉，只能走用户显式出口。
   *
   * 写不进也**不放行**：标记失败的后果是「以后可能误清」，因此改为把租约置为结果不明（保守方向）。
   * @returns 标记是否成功落盘。
   */
  fun markDispatched(context: Context, transport: String): Boolean = synchronized(lock) {
    restore(context)
    if (pendingEpoch == null) return@synchronized true
    val written = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString(KEY_DISPATCHED, transport.take(24))
      .putLong(KEY_DISPATCHED_AT, System.currentTimeMillis())
      .commit()
    if (!written) {
      unknown = true
      return@synchronized false
    }
    dispatched = transport.take(24); dispatchedAt = System.currentTimeMillis()
    true
  }

  /**
   * Only the original acknowledged caller may clear its lease; ordinary timeout/error is not acknowledgement.
   *
   * [expectedOperationId] 给出时，租约上的 ID 必须相符才能清——这正是「历史运行不能清除本次失败」
   * 的落地：迟到的旧任务即便线程身份对得上，也清不掉新任务的隔离。
   */
  fun finish(context: Context, expectedOperationId: String? = null): Boolean = synchronized(lock) {
    restore(context)
    val allowed = pendingEpoch != null && finishAllowed(
      ownerMatches = owner === Thread.currentThread(),
      leaseUnknown = unknown,
      currentId = operationId,
      expectedId = expectedOperationId,
    )
    if (!allowed) return@synchronized false
    val cleared = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    if (cleared) {
      pendingEpoch = null; startedAt = 0L; operation = ""; owner = null; unknown = false
      dispatched = ""; dispatchedAt = 0L; operationId = ""
    } else unknown = true
    cleared
  }

  fun markUnknown(context: Context, detail: String): JSONObject = synchronized(lock) {
    restore(context)
    unknown = true
    refusalLocked().put("detail", detail.take(96))
  }


  /**
   * issue #658：**陈旧租约**的自动清算阈值（仅对「从未派发」的租约生效）。
   *
   * 取值依据（不是拍数字）：
   *  - 合法的一次 root 维护都是 su 一次性命令（setenforce / chmod / mount / 绑定 UserService），
   *    实测**亚秒到数秒**量级；引擎启动的世代所有权重试预算本身是 3000ms。
   *  - 5 分钟 = 最长合法操作的两个数量级以上余量，也不足一次冷启动超时（90s）的四倍。
   *  - 副作用：清掉后会允许重新派发。但**只有 dispatched 为空时才允许**——那意味着 `begin()` 之后
   *    根本没走到 `markDispatched`，按构造**不存在在飞的特权工作**，所以清它不会与任何东西串行冲突；
   *    这正是 #658 里「worker 取租约后崩溃、租约永留」的形态。
   *  - 不清的代价：引擎一直保持「等待属主维护」直到整机重启（#658 描述的不可自愈）。
   */
  internal const val STALE_LEASE_TTL_MS = 5L * 60_000L

  /** 租约年龄（毫秒，基于 `elapsedRealtime`，故只在同一次启动内有效；跨启动的陈旧租约由 [restore] 的 newBoot 清掉）。 */
  internal fun ageMs(context: Context?, nowElapsed: Long = SystemClock.elapsedRealtime()): Long = synchronized(lock) {
    if (context == null) return@synchronized if (pendingEpoch == null) 0L else (nowElapsed - startedAt).coerceAtLeast(0L)
    restore(context)
    if (pendingEpoch == null) 0L else (nowElapsed - startedAt).coerceAtLeast(0L)
  }

  /**
   * issue #658：租约是否**陈旧且从未派发**——此时自动清算不会与在飞特权工作冲突。
   * `dispatched` 非空或 `unknown` 一律**不算陈旧**（[markDispatched] 的注释解释了为什么这两种只能人工清）。
   */
  internal fun stale(context: Context, nowElapsed: Long = SystemClock.elapsedRealtime()): Boolean = synchronized(lock) {
    restore(context)
    staleLease(
      hasLease = pendingEpoch != null,
      dispatched = dispatched.isNotEmpty(),
      leaseUnknown = unknown,
      ageMs = (nowElapsed - startedAt).coerceAtLeast(0L),
    )
  }

  /**
   * [stale] 的**纯判据**（不碰 Context/prefs，供 JVM 单测直接钉两个方向）。
   *
   * `dispatched` 或 `leaseUnknown` 为真时**恒不陈旧** —— 这两种租约只能人工清（见 [markDispatched]）。
   */
  internal fun staleLease(hasLease: Boolean, dispatched: Boolean, leaseUnknown: Boolean, ageMs: Long): Boolean =
    hasLease && !dispatched && !leaseUnknown && ageMs >= STALE_LEASE_TTL_MS

  /** null means no pending lease. Same-boot app recreation/restart never proves helper termination. */
  fun outstanding(context: Context?): JSONObject? = synchronized(lock) {
    if (context == null) return@synchronized if (pendingEpoch != null) refusalLocked() else null
    restore(context)
    if (pendingEpoch == null) null else refusalLocked()
  }

  /**
   * 残留租约的自救出口，且是**带前提复核的原子清算**：调用方须先证实「通道确实不存在 **且** 这条租约
   * 从未派发过特权工作」（[ShizukuTransport.autoClearAllowed]）——此时隔离没有可串行化的对象，
   * 留着只会把启动挂成「等待属主维护」直到整机重启。
   *
   * **不能**用它来处理「已派发但结果不明」的租约：本模块的锁只覆盖本进程，**证明不了**外部 su
   * 子进程或 Shizuku UserService 已经退出（文件头那句就是这个意思）。那种租约只能由用户在明示
   * 「终止无法证明」后手工清除（[ShizukuTransport.forceClearMaintenanceLease]）。
   *
   * 与 [finish] 不同：不要求原 owner 线程，因为前提已保证不可能有「本应用发起的」在飞特权工作。
   * 但 `guard` 在**本模块的锁内**求值，与 `begin()` 共用同一临界区，因此「判断—清除」不会与
   * worker 取租约交错，也不会清掉刚拿到的租约。
   * @param guard 附加前提；在本临界区内求值，false 则不做任何动作。
   * @returns 是否真的清掉了一条残留租约。
   */
  fun clearWhenNoRootChannel(context: Context, guard: () -> Boolean): Boolean = synchronized(lock) {
    restore(context)
    if (pendingEpoch == null) return@synchronized true
    if (!guard()) return@synchronized false
    // commit 失败（存储写不动）会把租约永久留下——正是「无重试即永久等待」的那条路径。
    // 有界重试一次；仍失败如实返回 false（调用方/引导页可再次触发，绝不假装已清）。
    var cleared = false
    for (attempt in 1..2) {
      cleared = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().clear().commit()
      if (cleared) break
    }
    if (cleared) {
      pendingEpoch = null; startedAt = 0L; operation = ""; owner = null; unknown = false
      dispatched = ""; dispatchedAt = 0L; operationId = ""
    }
    cleared
  }

  /** 当前租约是否带「已派发」证据（自动清算的否决项之一）。 */
  fun dispatched(context: Context): Boolean = synchronized(lock) {
    restore(context)
    dispatched.isNotEmpty()
  }

  /**
   * 租约自身的**结算/持久化状态是否不可信**（`unknown`）——自动清算的第二个否决项（复审第四轮）：
   * 「没有派发证据」≠「证明没有派发」。`markDispatched` 写不进（证据没落盘）、或本进程**恢复**了别的
   * 进程留下的租约，都会让 `dispatched=false` 变得**不可采信** ⇒ 一律不清。
   */
  fun unknown(context: Context): Boolean = synchronized(lock) {
    restore(context)
    unknown
  }

  private fun refusalLocked(): JSONObject = JSONObject().put("ok", false)
    .put("code", if (unknown) "repair-result-unknown" else "root-maintenance-busy")
    .put("reason", if (unknown) "repair-result-unknown" else "root-maintenance-busy")
    .put("operation", operation).put("operationId", operationId).put("startedAt", startedAt)
    // issue #658：`startedAt` 是 elapsedRealtime，人读不了；补一个「租约已挂多久」，让引导页能讲清。
    .put("leaseAgeMs", (SystemClock.elapsedRealtime() - startedAt).coerceAtLeast(0L)).put("staleTtlMs", STALE_LEASE_TTL_MS).put("unknown", unknown)
    .put("dispatched", dispatched.isNotEmpty()).put("dispatchedVia", dispatched).put("dispatchedAt", dispatchedAt)
    .put("failures", 1).put("remaining", -1)
    .put("guidance", if (unknown) "特权工作结果不明，已暂停新派发与维护；不能以重启应用或杀 su 客户端当作结算。请重启设备后再试。"
      else "特权工作尚未结算，请等待；本次不重复派发。")
}
