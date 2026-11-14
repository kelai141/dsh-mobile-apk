package com.dsharnessmobile.shell

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One bounded caller settlement for native ownership maintenance; no model command entrypoint. */
internal object RootOwnershipJobs {
  /** 状态锁：只守下面的字段，临界区必须短——**禁止**在其内做探测/binder/IO（issue #319）。 */
  private val lock = Any()
  /** 上次维护「报过问题」的持久记录；独立于租约 prefs，避免租约 clear() 顺手抹掉这条证据。 */
  private const val FOLLOW_UP_PREFS = "dsh_root_maintenance_followup"
  private const val KEY_FOLLOW_UP = "needsFollowUp"
  /** 入口串行锁：串行化 start() 的「清算探测 → 复核 → 置 running」；最长约 15s 的真绑定探测只挡其他 start()（#319；方案来自 PR #322 @Ni-ShuWu）。 */
  private val entryLock = Any()
  private var running = false
  private var startedAt = 0L
  private var completedAt = 0L
  /** 本次（最近一次）维护的唯一操作 ID；空串 = 从未启动过。启动时即分配，不等到结算。 */
  private var operationId = ""
  private var result: JSONObject? = null
  private var latch = CountDownLatch(0)
  /** 最近一次「worker 起不来」的作业 ID；空串 = 本次没有发生启动失败。每次尝试开头清空。 */
  private var failedLaunchId = ""
  /** 本进程内记下的复查需求（持久写入同时生效）；null = 本次进程还没有新结论。 */
  @Volatile private var followUpProblem: Boolean? = null

  /** 一次成功启动的凭据：本次 ID 与它自己的完成闩。两者成对，杜绝跨作业配错。 */
  private class Launch(val id: String, val latch: CountDownLatch)

  /**
   * 结果归属判据（纯函数，JVM 可直测）：PRD 5.2 / AC-08 的「历史完成记录不代表本次完成」。
   *
   * 回执/状态只有在**其结果自身的 operationId 与当前租约（或最近一次任务）相符**时才可当成本次结果。
   * 空 ID 一律不认（fail-closed）：没有 ID 的结果无法自证属于哪一次。
   */
  internal fun resultBelongsToRequest(resultOperationId: String?, expectedOperationId: String?): Boolean =
    !resultOperationId.isNullOrEmpty() && resultOperationId == expectedOperationId

  /**
   * 启动扫描的入口判据（纯函数）：PRD 5.2「属主修复是异常恢复，不应成为启动常态依赖」。
   *
   * 只有在**存在残留租约**（上次没结算）或**上次维护确实报告过问题**时才在启动路径上扫描；
   * 健康状态下启动既不探测 root 通道，也不做有界遍历。
   */
  internal fun startupScanRequired(hasLease: Boolean, lastReportedProblem: Boolean): Boolean =
    hasLease || lastReportedProblem

  /** 上次维护是否如实报告过需要复查的问题（失败计数、未验证变更、截断、或结果不明）。 */
  internal fun reportedProblem(value: JSONObject?): Boolean {
    if (value == null) return false
    if (value.optBoolean("unknown")) return true
    if (!value.optBoolean("ok", true)) return true
    return value.optInt("failures", 0) > 0 || value.optInt("unverifiedMutations", 0) > 0 ||
      value.optBoolean("truncated") || value.optBoolean("deadlineExceeded")
  }

  /**
   * 本次维护之后该记下什么（纯函数）：null = 没有新证据，保持原记录。
   *
   * `skipped` 族结果说明维护压根没跑（无 root 路 / 通道不明），既不能当成修好，也不能当成
   * 新失败：保持上次的记录，等下一次真的跑过再改写。
   */
  internal fun followUpUpdate(result: JSONObject?): Boolean? {
    if (result == null) return null
    if (result.optString("skipped").isNotEmpty()) return null
    return reportedProblem(result)
  }

  /**
   * 启动失败的归属判据（纯函数）：只有**失败的正是这一次作业**、且结果确实是 worker 起不来时才认。
   *
   * 用途：`request()` 在 start() 返回 null 时不能一律回「运行中」——线程构造/启动失败时并没有
   * 任何工作在跑，那样会把一次确定失败伪装成进行中，调用方随之永远等不到结果。
   */
  internal fun launchFailure(result: JSONObject?, failedLaunchId: String, currentOperationId: String): JSONObject? {
    if (failedLaunchId.isEmpty() || failedLaunchId != currentOperationId) return null
    val value = result ?: return null
    if (value.optString("operationId") != failedLaunchId) return null
    if (value.optString("code") != "repair-worker-unavailable") return null
    return value
  }

  /**
   * 上次维护报过问题的持久记录。
   *
   * 为什么必须持久化：进程重启后内存里的 result 为空，只看内存就会把「上次失败」误判成健康，
   * 启动随之跳过维护——那正是 PRD 5.2 不允许的不准确健康检查。读失败按「需要复查」处理（fail-closed）。
   */
  private object FollowUp {
    fun remembered(context: Context): Boolean {
      followUpProblem?.let { return it }
      return try {
        context.applicationContext.getSharedPreferences(FOLLOW_UP_PREFS, Context.MODE_PRIVATE)
          .getBoolean(KEY_FOLLOW_UP, false)
      } catch (_: Throwable) {
        true
      }
    }

    /** 只在新结论明确时改写；写入成功与否都先落内存，避免本进程按旧结论继续判断。 */
    fun record(context: Context, problem: Boolean?) {
      if (problem == null) return
      followUpProblem = problem
      try {
        context.applicationContext.getSharedPreferences(FOLLOW_UP_PREFS, Context.MODE_PRIVATE)
          .edit().putBoolean(KEY_FOLLOW_UP, problem).commit()
      } catch (_: Throwable) {
        // 写不进时本进程仍按内存结论走；跨进程只能靠下一次维护改写。
      }
    }
  }

  fun state(context: Context? = ShellAppContext.get()): JSONObject {
    val lease = RootMaintenanceLease.outstanding(context)
    return synchronized(lock) {
      val pending = running || lease != null
      val start = if (running || lease == null) startedAt else lease.optLong("startedAt", startedAt)
      val end = if (pending) SystemClock.elapsedRealtime() else completedAt
      val elapsed = if (start == 0L) 0L else (end - start).coerceAtLeast(0L)
      val leaseId = lease?.optString("operationId").orEmpty()
      val expectedId = if (lease != null) leaseId else operationId
      val resultId = result?.optString("operationId").orEmpty()
      val certified = RootMaintenanceLease.isCanonicalOperationId(resultId)
      // 有租约在飞时，只承认与租约 ID 相符的结果；无 ID 或 ID 不符一律视为历史结果，不冒充本次。
      // 租约自身没有 ID 时无法证明在飞任务的归属 ⇒ 结果一律不认证（fail-closed）。
      val current = result != null && certified && resultBelongsToRequest(resultId, expectedId)
      JSONObject().put("running", pending).put("startedAt", start).put("completedAt", if (pending) 0L else completedAt)
        .put("overdue", lease?.optBoolean("unknown") == true || (pending && elapsed > 30_000L)).put("elapsedMs", elapsed)
        .put("operation", lease?.optString("operation") ?: "ownership")
        // 本次结果自证：operationId 缺失或与租约不符时，result 不得被当成本次任务的结果。
        .put("operationId", expectedId)
        .put("resultSelfCertified", certified)
        .apply {
          if (current) result?.let { put("result", JSONObject(it.toString())) }
          else if (result != null) put("resultStale", true)
          lease?.let { put("lease", it) }
        }
    }
  }

  /**
   * 启动一次维护；返回**本次**的 (操作 ID, 完成闩)，未启动返回 null。
   *
   * ID 在置 running 之前就分配并写入 [operationId]：调用方在运行中轮询时拿到的就是本次 ID，
   * 不会出现「任务在跑但状态里没有 ID」的空窗。
   * @param reuseRecent 启动路径传 true：5 秒内刚结算过就复用，避免 Activity 与服务同时冷启各扫一遍。
   * @param startup 启动路径传 true：没有残留租约、上次也没报问题时**不扫描**（PRD 5.2）。
   */
  private fun start(context: Context, reuseRecent: Boolean = false, startup: Boolean = false): Launch? {
    val app = context.applicationContext
    val done: CountDownLatch
    val jobId: String
    synchronized(entryLock) {
      synchronized(lock) { if (running) return null }
      // 入口级清算：只有**确实存在残留租约**时才付探测成本（含 binder 调用）；且此刻本进程
      // 没有在跑的维护（上面的 running 已挡住在跑的情形，锁内的 fence 复核挡住跨入口的并发）。
      // 放在本锁内 ⇒ 与下面置 running=true 是一段临界区，不会与别的 start() 交错。
      if (RootMaintenanceLease.outstanding(app) != null) {
        ShizukuTransport.clearLeaseWhenNoRootChannel(app)
        if (RootMaintenanceLease.outstanding(app) != null) return null
      }
      // 健康判据要读持久记录（prefs IO），必须在状态锁外取，再进锁做纯内存判定。
      // 只有启动路径需要这条判据：手动请求维护本来就该跑。
      val followUp = startup && FollowUp.remembered(app)
      synchronized(lock) {
        // Activity and foreground Service can start together; reuse only a very recent settlement.
        if (reuseRecent && result != null && SystemClock.elapsedRealtime() - completedAt < 5_000L) return null
        // 启动不扫描：健康设备上「没有残留租约 + 上次也没报问题」就不该做有界遍历，
        // 属主修复只是异常恢复。这里在**置 running 之前**判定，避免空转一次维护。
        // 走到这里时残留租约已在上面的入口清算中处理过：此刻「没有租约」是确定事实。
        // 「上次报过问题」同时看本进程结果与持久记录：进程重启后内存为空，持久记录仍能如实触发复查。
        if (startup && !startupScanRequired(
            hasLease = false, lastReportedProblem = reportedProblem(result) || followUp)) {
          return null
        }
        val random = java.security.SecureRandom()
        jobId = RootMaintenanceLease.newOperationId { random.nextLong() }
        running = true; startedAt = SystemClock.elapsedRealtime(); completedAt = 0L; result = null
        operationId = jobId
        failedLaunchId = ""
        done = CountDownLatch(1); latch = done
      }
    }
    // C5：**构造**（含 lambda 对象与 isDaemon）与 start 都要在 try 内。只包 start 的话，构造阶段的
    // OOM / SecurityException 会带着 running=true 与未归零的 latch 逃出去，后续每次 start 都短路、
    // 每次 runBlocking 都白等 30 秒。
    val worker = try {
      Thread({
        // 本次 job 的唯一 ID：先分配，再用它包住整段维护。深处的 beginOperation 会采用它，
        // 于是无论哪条通道（su / shizuku），回执上的 ID 都与本次任务一致。
        val settled = try {
          RootMaintenanceLease.withOperationId(jobId) { ShizukuTransport.autoHealOwnershipDirect(app) }
        }
        catch (failure: Throwable) { JSONObject().put("ok", false).put("code", "repair-native-failed")
          .put("reason", "repair-native-failed").put("failures", 1).put("remaining", -1) }
        // 结果自证：本次 ID 由这里盖上。通道即使没带 ID，也不会被当成本次之外的历史结果。
        val stamped = JSONObject(settled.toString()).apply {
          if (!RootMaintenanceLease.isCanonicalOperationId(optString("operationId"))) put("operationId", jobId)
        }
        // 复查需求先落盘再发布结果：启动路径读到结果时持久判据已同步，不会短暂误判为健康。
        FollowUp.record(app, followUpUpdate(stamped))
        synchronized(lock) {
          result = stamped; completedAt = SystemClock.elapsedRealtime(); running = false
        }
        done.countDown()
      }, "dsh-owner-maintenance").apply { isDaemon = true }
    } catch (_: Throwable) {
      null
    }
    val launched = try {
      when (worker) {
        null -> false
        else -> { worker.start(); true }
      }
    } catch (_: Throwable) {
      false
    }
    if (!launched) {
      val failure = JSONObject().put("ok", false).put("code", "repair-worker-unavailable")
        .put("reason", "repair-worker-unavailable").put("failures", 1).put("remaining", -1)
        .put("operationId", jobId)
      // worker 起不来也是一次确定的失败：持久记下，下一次启动必须复查。
      FollowUp.record(app, true)
      synchronized(lock) {
        running = false; completedAt = SystemClock.elapsedRealtime()
        result = failure; failedLaunchId = jobId
      }
      done.countDown()
      return null
    }
    return Launch(jobId, done)
  }

  /** UI request returns immediately; existing root-status polling observes the one shared result. */
  fun request(context: Context): JSONObject {
    val started = start(context)
    if (started == null) {
      // worker 构造/启动失败时并没有任何工作在跑：必须回报本次的确定失败（带 ID），
      // 不得回「repair-running」让调用方去等一个永远不会有的结果。
      val failed = synchronized(lock) { launchFailure(result, failedLaunchId, operationId) }
      if (failed != null) {
        return JSONObject(failed.toString()).put("ok", false)
          .put("code", failed.optString("code")).put("reason", failed.optString("reason"))
          .put("operationId", failed.optString("operationId"))
          .put("guidance", "属主维护线程无法启动，本次没有执行任何操作；请稍后重试，持续失败请重启应用。")
      }
    }
    if (started == null && synchronized(lock) { !running }) {
      RootMaintenanceLease.outstanding(context)?.let { return state(context).put("ok", false)
        .put("code", it.optString("code")).put("reason", it.optString("reason")).put("guidance", it.optString("guidance")) }
    }
    return state(context).put("ok", true).put("code", if (started != null) "repair-started" else "repair-running")
      .put("reason", if (started != null) "repair-started" else "repair-running")
  }

  /** Startup caller is time-bounded; a blocked Binder remains fenced until its worker truly settles. */
  fun runBlocking(context: Context, reuseRecent: Boolean = false): JSONObject {
    var launch = start(context, reuseRecent, startup = true)
    if (launch == null) {
      RootMaintenanceLease.outstanding(context)?.let { return it }
      // 另一个入口（Activity / 前台服务）已在跑：加入**它这一次**，等它的闩、只认它的 ID。
      // (running, operationId, latch) 必须在同一临界区取，否则会把 A 的闩配 B 的 ID。
      val joined = synchronized(lock) { if (running) Launch(operationId, latch) else null }
      if (joined != null) launch = joined
    }
    if (launch == null) {
      // 本次没有启动维护。只有**刚结算且 ID 相符**的结果才允许复用（Activity 与 Service 同时冷启的
      // 合并窗口）；超过窗口或 ID 不符一律不认，否则历史结果会冒充本次结论。
      val (recent, expected) = synchronized(lock) {
        val age = if (completedAt == 0L) Long.MAX_VALUE else SystemClock.elapsedRealtime() - completedAt
        (if (reuseRecent && age >= 0 && age < 5_000L) result?.let { JSONObject(it.toString()) } else null) to operationId
      }
      if (recent != null && resultBelongsToRequest(recent.optString("operationId"), expected))
        return recent
      return JSONObject().put("ok", true).put("checked", 0).put("healed", 0).put("failures", 0)
        .put("skipped", "no-maintenance-required")
    }
    val finished = try { launch.latch.await(30, TimeUnit.SECONDS) }
    catch (_: InterruptedException) { Thread.currentThread().interrupt(); false }
    if (!finished) return JSONObject().put("ok", false).put("code", "repair-result-unknown")
      .put("reason", "repair-result-unknown").put("failures", 1).put("remaining", -1)
      .put("guidance", "属主维护结果仍不明，请勿重复操作；等待结果或复制诊断日志。")
    RootMaintenanceLease.outstanding(context)?.let { return it }
    return synchronized(lock) {
      val value = result
      // 只认本次等待的这一个 ID：中途有别的入口换代，也不把新任务的结果交出去。
      if (value != null && !resultBelongsToRequest(value.optString("operationId"), launch.id)) null
      else value?.let { JSONObject(it.toString()) }
    }
      ?: JSONObject().put("ok", false).put("code", "repair-result-unknown").put("reason", "repair-result-unknown")
  }
}
