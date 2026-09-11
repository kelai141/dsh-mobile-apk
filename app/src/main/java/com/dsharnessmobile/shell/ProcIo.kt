package com.dsharnessmobile.shell

import java.util.concurrent.TimeUnit

/**
 * 子进程有界 I/O（0.13.8 #173）。
 *
 * 缺陷根因：先 `readText()`（读到 EOF 才返回）后 `waitFor(timeout)`——超时参数只作用于
 * 已阻塞完之后，形同不存在；挂起点落在 `synchronized` 内时升级为全局锁死
 * （AdbState.adbPing 锁内挂起 → 所有 ADB 调用与看门狗强制重启全部冻结）。
 *
 * 铁律（grep 门禁 scripts/check-bounded-io.mjs 强制）：壳侧 Kotlin 一切子进程输出
 * 读取必须经 [readBounded]，禁止裸 `inputStream.readText()`/`readBytes()`。
 * 注意：`redirectErrorStream(true)` 下若先 waitFor 再读，子进程写满管道缓冲（约 64KB）
 * 会死锁——所以读必须并发，不能简单挪到 waitFor 之后。
 */
internal object ProcIo {

  /**
   * 并发排水 + 有界等待：读线程消费 stdout（防管道写满死锁），`waitFor(timeoutS)`
   * 超时即 `destroyForcibly()`（挂起的 adb client 对 SIGTERM 不可依赖）+ 有界 join。
   * 返回 null = 超时（调用方按既有超时语义处理）。
   */
  fun readBounded(proc: Process, timeoutS: Long): String? {
    val holder = arrayOfNulls<ByteArray>(1)
    val drainer = Thread {
      holder[0] = try {
        proc.inputStream.readBytes()
      } catch (_: Throwable) {
        ByteArray(0)
      }
    }.apply { isDaemon = true }
    drainer.start()
    val done = try {
      proc.waitFor(timeoutS, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    }
    if (!done) {
      proc.destroyForcibly()
      drainer.join(1_000)
      return null
    }
    drainer.join(5_000)
    return String(holder[0] ?: ByteArray(0), Charsets.UTF_8)
  }
}
