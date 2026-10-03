package com.dsharnessmobile.shell

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One bounded caller settlement for native ownership maintenance; no model command entrypoint. */
internal object RootOwnershipJobs {
  /** 状态锁：只守下面的字段，临界区必须短——**禁止**在其内做探测/binder/IO（#319）。 */
  private val lock = Any()
  /** 入口串行锁：串行化 start() 的「清算探测 → 复核 → 置 running」；探测最长约 15s 只挡其他 start()。 */
  private val entryLock = Any()
  private var running = false
  private var startedAt = 0L
  private var completedAt = 0L
  private var result: JSONObject? = null
  private var latch = CountDownLatch(0)

  fun state(context: Context? = ShellAppContext.get()): JSONObject {
    val lease = RootMaintenanceLease.outstanding(context)
    return synchronized(lock) {
      val pending = running || lease != null
      val start = if (running || lease == null) startedAt else lease.optLong("startedAt", startedAt)
      val end = if (pending) SystemClock.elapsedRealtime() else completedAt
      val elapsed = if (start == 0L) 0L else (end - start).coerceAtLeast(0L)
      JSONObject().put("running", pending).put("startedAt", start).put("completedAt", if (pending) 0L else completedAt)
        .put("overdue", lease?.optBoolean("unknown") == true || (pending && elapsed > 30_000L)).put("elapsedMs", elapsed)
        .put("operation", lease?.optString("operation") ?: "ownership")
        .apply { result?.let { put("result", JSONObject(it.toString())) }; lease?.let { put("lease", it) } }
    }
  }

  private fun start(context: Context, reuseRecent: Boolean = false): Boolean {
    val app = context.applicationContext
    val done: CountDownLatch
    // 入口临界区由 entryLock 串行化；[lock] 只守状态字段、永不跨探测/binder 持有，
    // 因此 state() 与 root 状态桥调用不会被下面最长 15s 的真绑定探测挡住（#319）。
    synchronized(entryLock) {
      synchronized(lock) { if (running) return false }
      // 入口级清算：只有**确实存在残留租约**时才付探测成本（含 binder 调用）；且此刻本进程
      // 没有在跑的维护（上面的 running 已挡住在跑的情形，清算内的 fence 复核挡住跨入口的并发）。
      // `running` 只会在 entryLock 内被置 true ⇒ 探测、复核与置 running 仍是一段不与别的
      // start() 交错的入口临界区（工作线程只会把它置回 false，不会破坏这个不变量）。
      if (RootMaintenanceLease.outstanding(app) != null) {
        ShizukuTransport.clearLeaseWhenNoRootChannel(app)
        if (RootMaintenanceLease.outstanding(app) != null) return false
      }
      synchronized(lock) {
        // Activity and foreground Service can start together; reuse only a very recent settlement.
        if (reuseRecent && result != null && SystemClock.elapsedRealtime() - completedAt < 5_000L) return false
        running = true; startedAt = SystemClock.elapsedRealtime(); completedAt = 0L; result = null
        done = CountDownLatch(1); latch = done
      }
    }
    Thread({
      val settled = try { ShizukuTransport.autoHealOwnershipDirect(app) }
      catch (failure: Throwable) { JSONObject().put("ok", false).put("code", "repair-native-failed")
        .put("reason", "repair-native-failed").put("failures", 1).put("remaining", -1) }
      synchronized(lock) {
        result = JSONObject(settled.toString()); completedAt = SystemClock.elapsedRealtime(); running = false
      }
      done.countDown()
    }, "dsh-owner-maintenance").apply { isDaemon = true }.start()
    return true
  }

  /** UI request returns immediately; existing root-status polling observes the one shared result. */
  fun request(context: Context): JSONObject {
    val started = start(context)
    if (!started && synchronized(lock) { !running }) {
      RootMaintenanceLease.outstanding(context)?.let { return state(context).put("ok", false)
        .put("code", it.optString("code")).put("reason", it.optString("reason")).put("guidance", it.optString("guidance")) }
    }
    return state(context).put("ok", true).put("code", if (started) "repair-started" else "repair-running")
      .put("reason", if (started) "repair-started" else "repair-running")
  }

  /** Startup caller is time-bounded; a blocked Binder remains fenced until its worker truly settles. */
  fun runBlocking(context: Context, reuseRecent: Boolean = false): JSONObject {
    start(context, reuseRecent)
    if (synchronized(lock) { !running }) RootMaintenanceLease.outstanding(context)?.let { return it }
    val wait = synchronized(lock) { latch }
    val finished = try { wait.await(30, TimeUnit.SECONDS) }
    catch (_: InterruptedException) { Thread.currentThread().interrupt(); false }
    if (!finished) return JSONObject().put("ok", false).put("code", "repair-result-unknown")
      .put("reason", "repair-result-unknown").put("failures", 1).put("remaining", -1)
      .put("guidance", "属主维护结果仍不明，请勿重复操作；等待结果或复制诊断日志。")
    RootMaintenanceLease.outstanding(context)?.let { return it }
    return synchronized(lock) { result?.let { JSONObject(it.toString()) } }
      ?: JSONObject().put("ok", false).put("code", "repair-result-unknown").put("reason", "repair-result-unknown")
  }
}
