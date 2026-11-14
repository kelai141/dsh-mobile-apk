package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * 子进程有界 I/O（0.13.8 #173；三态语义 #211.1）。
 *
 * 缺陷根因（已实证）：先 `readText()`（读到 EOF 才返回）后 `waitFor(timeout)`——超时参数只作用于
 * 已阻塞完之后，形同不存在；挂起点落在 `synchronized` 内时升级为全局锁死
 * （AdbState.adbPing 锁内挂起 → 所有 ADB 调用与看门狗强制重启全部冻结）。
 *
 * #211.1 三态：旧实现把「排水超时」与「真空输出」都返回 ""——调用方无法区分
 * 「CLI 挂了、状态未知」与「CLI 说没有」，UndoGate 因此把超时误判成「无快照可回滚」。
 * 现在统一返回 [ProcResult]：timedOut（exit/drain 分别标注，附已读部分）+ truncated。
 * 只区分 null/非 null 不解决问题（E-1）。
 *
 * 铁律（grep 门禁 scripts/check-bounded-io.mjs 强制）：壳侧 Kotlin 一切子进程输出
 * 读取必须经 [readBounded]，禁止裸 `inputStream.readText()`/`readBytes()`。
 * 注意：`redirectErrorStream(true)` 下若先 waitFor 再读，子进程写满管道缓冲（约 64KB）
 * 会死锁——所以读必须并发，不能简单挪到 waitFor 之后。
 */
internal object ProcIo {

  /** 单次读取上限（超限置 truncated，但继续排水防子进程写满管道死锁）。 */
  const val MAX_OUTPUT_BYTES = 1 shl 20

  /** 超时态稳定标记：调用方以 contains 判定「状态未知」而非「真空输出」。 */
  const val TIMEOUT_FLAG = "io-timeout"

  /** 截断标记（写进返回文本尾部，超限不再静默）。 */
  const val TRUNCATED_FLAG = "io-truncated"

  /** 有界排水结果。 */
  internal class BoundedDrain(val text: String, val truncated: Boolean, val readError: String? = null)

  /**
   * 一次子进程读取的结果。三态可区分（#211.1）：
   * - 正常：timedOut=false（text 可为空 = 真空输出）
   * - 超时：timedOut=true（text = 已读部分，可能为空；exit/drain 两阶段分别标注）
   * - 截断：truncated=true（输出超过上限，text 尾部带 [TRUNCATED_FLAG] 标注）
   */
  internal class ProcResult(
    val text: String,
    val exitTimedOut: Boolean,
    val drainTimedOut: Boolean,
    val truncated: Boolean,
    val cleanupIncomplete: Boolean = false,
    val readError: String? = null,
    /** Natural process exit code; null after timeout or when the exit status cannot be read. */
    val exitCode: Int? = null,
  ) {
    val timedOut: Boolean get() = exitTimedOut || drainTimedOut
    val complete: Boolean get() = !timedOut && !cleanupIncomplete && readError == null

    /** 机器可读的形态标记（写日志/诊断用）。 */
    fun marker(): String = when {
      exitTimedOut && drainTimedOut -> "$TIMEOUT_FLAG:exit+drain"
      exitTimedOut -> "$TIMEOUT_FLAG:exit"
      drainTimedOut -> "$TIMEOUT_FLAG:drain"
      cleanupIncomplete -> "$TIMEOUT_FLAG:cleanup-incomplete"
      readError != null -> "$TIMEOUT_FLAG:read-error"
      truncated -> TRUNCATED_FLAG
      else -> "ok"
    }

    /** 超时态的调用方文本：沿用既有超时识别语 + 形态/已读量（与真空输出不同形）。 */
    fun timeoutText(prefix: String): String =
      prefix + " [" + marker() + "; partial=" + text.length + "B]"

    /** 诊断/日志用文本：超时态附形态标记（解析路径请直接用 [text]）。 */
    fun textWithMarkers(): String =
      if (!complete) text + "\n[" + marker() + "; partial=" + text.length + "B]\n" else text
  }

  /**
   * 并发排水 + 有界等待：读线程消费 stdout（防管道写满死锁），`waitFor(timeoutS)`
   * 超时即 `destroyForcibly()`（挂起的 adb client 对 SIGTERM 不可依赖）+ 有界 join。
   * @return 三态结果（#211.1）；超时不再与真空输出同形。
   */
  fun readBounded(proc: Process, timeoutS: Long, limitBytes: Int = MAX_OUTPUT_BYTES): ProcResult =
    readBoundedMillis(proc, timeoutS.coerceIn(0, Long.MAX_VALUE / 1000) * 1000, limitBytes)

  fun readBoundedMillis(proc: Process, timeoutMs: Long, limitBytes: Int = MAX_OUTPUT_BYTES): ProcResult {
    val limit = limitBytes.coerceIn(1, MAX_OUTPUT_BYTES)
    val state = DrainState(limit)
    val drainer = Thread({
      try { drainInto(proc.inputStream, state) }
      catch (failure: Throwable) { state.fail(failure) }
    }, "dsh-proc-drain").apply { isDaemon = true }
    drainer.start()
    val wait = awaitCompletion(proc, drainer, timeoutMs)
    // Only short memory operations take this lock; never read/close a stream under it.
    val drain = state.snapshot()
    val text = if (drain.truncated) drain.text + "\n[" + TRUNCATED_FLAG +
      ": output exceeded " + limit + " bytes]\n" else drain.text
    val exitCode = if (wait.exitTimedOut) null else runCatching { proc.exitValue() }.getOrNull()
    return ProcResult(text, wait.exitTimedOut, wait.drainTimedOut, drain.truncated,
      wait.cleanupIncomplete, drain.readError ?: wait.waitError, exitCode)
  }

  internal class WaitResult(
    val exitTimedOut: Boolean,
    val drainTimedOut: Boolean,
    val cleanupIncomplete: Boolean,
    val waitError: String? = null,
  )

  /**
   * Reap/close are potentially blocking too. Only daemon workers invoke them; the caller joins
   * against one cleanup budget. Closing a pipe or killing its parent does NOT settle descendants.
   * This records local cleanup only; a timed-out privileged operation must remain quarantined.
   */
  internal fun awaitCompletion(proc: Process, drainer: Thread, timeoutMs: Long,
    normalDrainMs: Long = 5_000L, timeoutDrainMs: Long = 1_000L, cleanupMs: Long = 200L): WaitResult {
    var interrupted = Thread.interrupted()
    var waitError: String? = null
    val failures = AtomicReference<String?>(null)
    val workers = ArrayList<Thread>(4)
    fun launch(name: String, action: () -> Unit) {
      val worker = Thread({
        try { action() }
        catch (failure: Throwable) { failures.compareAndSet(null, errorText(failure)) }
      }, name).apply { isDaemon = true }
      workers.add(worker)
      worker.start()
    }
    fun join(thread: Thread, durationMs: Long) {
      if (interrupted || durationMs <= 0) return // join(0) is an unbounded wait.
      try { thread.join(durationMs) }
      catch (_: InterruptedException) { interrupted = true }
    }
    try {
      val done = if (interrupted) false else try {
        proc.waitFor(timeoutMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) { interrupted = true; false }
      catch (failure: Throwable) { waitError = errorText(failure); false }
      if (!done) launch("dsh-proc-kill") { proc.destroyForcibly() }
      join(drainer, if (done) normalDrainMs else timeoutDrainMs)
      val drainTimedOut = drainer.isAlive
      // Separate workers: a stuck destroy/close must not prevent the other close attempts.
      launch("dsh-proc-close-stdout") { proc.inputStream.close() }
      launch("dsh-proc-close-stderr") { proc.errorStream.close() }
      launch("dsh-proc-close-stdin") { proc.outputStream.close() }
      val cleanupStart = System.nanoTime()
      val cleanupBudget = cleanupMs.coerceIn(0, 10_000L) * 1_000_000L
      for (worker in workers + drainer) {
        val remaining = cleanupBudget - (System.nanoTime() - cleanupStart)
        if (remaining <= 0 || interrupted) break
        join(worker, ((remaining + 999_999L) / 1_000_000L).coerceAtLeast(1))
      }
      return WaitResult(!done, drainTimedOut,
        drainer.isAlive || workers.any { it.isAlive } || failures.get() != null,
        waitError)
    } finally {
      if (interrupted) Thread.currentThread().interrupt()
    }
  }

  internal fun errorText(failure: Throwable): String =
    failure.javaClass.simpleName + ": " + (failure.message ?: "").take(512)

  private class DrainState(private val limit: Int) {
    private val sink = ByteArrayOutputStream(minOf(limit, 64 * 1024))
    private var truncated = false
    private var readError: String? = null
    @Synchronized fun accept(buf: ByteArray, n: Int) {
      val take = minOf(n, limit - sink.size())
      if (take > 0) sink.write(buf, 0, take)
      if (take < n) truncated = true
    }
    @Synchronized fun fail(failure: Throwable) { readError = errorText(failure) }
    @Synchronized fun snapshot(): BoundedDrain =
      BoundedDrain(String(sink.toByteArray(), Charsets.UTF_8), truncated, readError)
  }

  private fun drainInto(input: InputStream, state: DrainState) {
    val buf = ByteArray(8 * 1024)
    while (true) {
      val n = input.read(buf)
      if (n < 0) return
      if (n > 0) state.accept(buf, n)
    }
  }

  /** Keep draining after the cap; a read exception is not EOF or a known-empty result. */
  internal fun drainBounded(input: InputStream, limitBytes: Int = MAX_OUTPUT_BYTES): BoundedDrain {
    val state = DrainState(limitBytes.coerceIn(1, MAX_OUTPUT_BYTES))
    try { drainInto(input, state) }
    catch (failure: Throwable) { state.fail(failure) }
    return state.snapshot()
  }
}
