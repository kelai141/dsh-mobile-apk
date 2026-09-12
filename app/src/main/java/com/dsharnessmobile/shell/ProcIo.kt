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
  internal class BoundedDrain(val text: String, val truncated: Boolean)

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
  ) {
    val timedOut: Boolean get() = exitTimedOut || drainTimedOut

    /** 机器可读的形态标记（写日志/诊断用）。 */
    fun marker(): String = when {
      exitTimedOut && drainTimedOut -> "$TIMEOUT_FLAG:exit+drain"
      exitTimedOut -> "$TIMEOUT_FLAG:exit"
      drainTimedOut -> "$TIMEOUT_FLAG:drain"
      truncated -> TRUNCATED_FLAG
      else -> "ok"
    }

    /** 超时态的调用方文本：沿用既有超时识别语 + 形态/已读量（与真空输出不同形）。 */
    fun timeoutText(prefix: String): String =
      prefix + " [" + marker() + "; partial=" + text.length + "B]"

    /** 诊断/日志用文本：超时态附形态标记（解析路径请直接用 [text]）。 */
    fun textWithMarkers(): String =
      if (timedOut) text + "\n[" + marker() + "; partial=" + text.length + "B]\n" else text
  }

  /**
   * 并发排水 + 有界等待：读线程消费 stdout（防管道写满死锁），`waitFor(timeoutS)`
   * 超时即 `destroyForcibly()`（挂起的 adb client 对 SIGTERM 不可依赖）+ 有界 join。
   * @return 三态结果（#211.1）；超时不再与真空输出同形。
   */
  fun readBounded(proc: Process, timeoutS: Long, limitBytes: Int = MAX_OUTPUT_BYTES): ProcResult {
    val limit = limitBytes.coerceAtLeast(1)
    val holder = AtomicReference<BoundedDrain?>(null)
    val drainer = Thread {
      holder.set(
        try {
          drainBounded(proc.inputStream, limit)
        } catch (_: Throwable) {
          BoundedDrain("", truncated = false)
        },
      )
    }.apply { isDaemon = true }
    drainer.start()
    val done = try {
      proc.waitFor(timeoutS, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    }
    if (!done) proc.destroyForcibly()
    // exit 超时后 join 只给 1s（进程刚被强杀）；正常退出给 5s 收尾（0.13.8 #173 原值）。
    drainer.join(if (done) 5_000L else 1_000L)
    val drain = holder.get()
    val truncated = drain?.truncated == true
    val raw = drain?.text ?: ""
    val text = if (truncated) raw + "\n[" + TRUNCATED_FLAG + ": output exceeded " + limit + " bytes]\n" else raw
    return ProcResult(
      text = text,
      exitTimedOut = !done,
      drainTimedOut = drainer.isAlive,
      truncated = truncated,
    )
  }

  /**
   * 有界排水：读到上限后**继续消费但丢弃**直至 EOF（子进程写满约 64KB 管道缓冲会死锁，
   * 所以不能在超限时停止读取），超限置 truncated（#211.1）。
   */
  internal fun drainBounded(input: InputStream, limitBytes: Int = MAX_OUTPUT_BYTES): BoundedDrain {
    val limit = limitBytes.coerceAtLeast(1)
    val sink = ByteArrayOutputStream(minOf(limit, 64 * 1024))
    val buf = ByteArray(8 * 1024)
    var truncated = false
    while (true) {
      val n = try {
        input.read(buf)
      } catch (_: Throwable) {
        break
      }
      if (n < 0) break
      if (n == 0) continue
      val room = limit - sink.size()
      if (room <= 0) {
        truncated = true
        continue
      }
      val take = minOf(n, room)
      sink.write(buf, 0, take)
      if (take < n) truncated = true
    }
    return BoundedDrain(String(sink.toByteArray(), Charsets.UTF_8), truncated)
  }
}
