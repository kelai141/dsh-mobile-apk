package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * tier-2 截图管道的**有界并发排空**（issue #607，承接 #582 的 I-7A）。
 *
 * 为什么必须并发：远端 `BrowserProcessService.RemoteTab.capture` 在 binder 调用内**同步**
 * 把 PNG `compress` 写进管道，而 Linux 管道缓冲只有 64KiB。若先等 `capture` 返回再开始读，
 * PNG 超过缓冲时远端写阻塞在半途、宿主等 binder 永不读，两端互等（宿主主线程随即 ANR）。
 * 所以读线程必须在发起 `capture` **之前**就已经在读了。
 *
 * 为什么必须有界取消：远端在回执失败、或宿主等超时放弃之后，仍可能**继续持有写端**。
 * 此时读线程会一直阻塞在管道上，旧实现直接 return 把它留成孤儿——每失败一次积一个线程
 * 加两个文件描述符。这里给每个出口都补上「取消标记 + 关读端 + 有界 join」。
 *
 * 为什么读循环要轮询：对端仍持有写端时，关掉本端的文件描述**不能**可靠打断另一个线程里
 * 已经阻塞的 `read()`（该对象被睡眠线程引用）。所以生产实现的 `read` 用有界 `poll` 轮询，
 * 让取消有界；本对象的生命周期部分不依赖 Android，可 JVM 直测。
 *
 * 线程模型：调用方线程同步等待，读线程是 daemon。字节只在读线程正常收尾后才交给调用方。
 */
internal object CapturePipeDrain {

  /** 正常收尾上限：capture 正常在毫秒级返回；超它说明远端仍在磨，拒收半张 PNG。 */
  const val DEFAULT_JOIN_TIMEOUT_MS = 15_000L

  /** 取消收尾上限：给读实现走完一次轮询周期并退出。 */
  const val CANCEL_JOIN_TIMEOUT_MS = 500L

  /** 读线程名（设备取证按此名筛线程，改名会打断既有排查手法）。 */
  const val READER_NAME = "dsh-shot-pipe-reader"

  /** 单次 `poll` 等待上限（毫秒）：取消粒度，也是空闲超时的计时步长。 */
  const val POLL_INTERVAL_MS = 100

  /** 读端已到 EOF（写端全部关闭）。 */
  internal const val EOF = -1

  private const val CHUNK = 64 * 1024

  /**
   * 有界排空一次截图管道。
   *
   * @param read 在**读线程**上执行的单次阻塞读：返回读到的字节数，[EOF] 表示写端已关。
   *   实现必须自行响应 `cancelled`（生产实现用有界 `poll` 轮询，否则取消无界）。
   *   抛异常 = 读失败（例如管道 `POLLERR`），按失败结算。
   * @param closeWriter 在 `startCapture` 返回（或抛出）后**立刻**调用，用于关掉**本端**的写端。
   *   这是读端能拿到 EOF 的唯一条件：宿主自己还握着 `pipe[1]` 时，远端那边关没关都不算数，
   *   `read` 会一直阻塞到 join 超时（设备层实测踩到：256KiB 正常载荷被判成 null）。
   * @param closeReader 收尾时放掉读端；允许重复调用、允许抛异常。
   * @param startCapture 读线程就绪后调用，返回远端回执（true = 远端声称已写完）。
   *   它抛出的异常**原样向上抛**（保留堆栈，调用方自己决定怎么记账），但其线程与描述符
   *   一定已在 finally 里收干净。只有它返回 true 才结算字节。
   * @return 远端回执为真、读端正常读完且无读失败时返回完整字节；其余一律 null。
   */
  fun drain(
    read: (buffer: ByteArray, cancelled: AtomicBoolean) -> Int,
    closeWriter: () -> Unit,
    closeReader: () -> Unit,
    startCapture: () -> Boolean,
    joinTimeoutMs: Long = DEFAULT_JOIN_TIMEOUT_MS,
    cancelJoinTimeoutMs: Long = CANCEL_JOIN_TIMEOUT_MS,
  ): ByteArray? {
    val cancelled = AtomicBoolean(false)
    val readFailed = AtomicBoolean(false)
    val ready = CountDownLatch(1)
    val drained = ByteArrayOutputStream()
    val reader = Thread {
      ready.countDown()
      try {
        val buffer = ByteArray(CHUNK)
        while (!cancelled.get()) {
          val n = read(buffer, cancelled)
          if (n < 0) break
          if (n == 0) continue
          drained.write(buffer, 0, n)
        }
      } catch (_: Throwable) {
        // 取消引起的异常不算读失败（关读端本身会抛）；其余一律记失败，由调用方拒收。
        if (!cancelled.get()) readFailed.set(true)
      }
    }.apply {
      isDaemon = true
      name = READER_NAME
    }

    var interrupted = false
    try {
      // 关键顺序：读线程先跑起来，再发起 capture（否则 64KiB 管道必死锁）。
      reader.start()
      try {
        ready.await()
      } catch (_: InterruptedException) {
        interrupted = true
        return null
      }
      val captured = try {
        startCapture()
      } finally {
        // 本端写端必须在这里关：否则读端等不到 EOF，正常截图会被 join 超时误判成失败。
        runCatching { closeWriter() }
      }
      if (!captured) return null
      try {
        reader.join(joinTimeoutMs)
      } catch (_: InterruptedException) {
        interrupted = true
        return null
      }
      if (reader.isAlive) return null
      if (readFailed.get()) return null
      return drained.toByteArray()
    } finally {
      cancelled.set(true)
      runCatching { closeReader() }
      awaitReader(reader, cancelJoinTimeoutMs) { interrupted = true }
      if (interrupted) Thread.currentThread().interrupt()
    }
  }

  /**
   * 取消后的有界收尾：读实现响应 `cancelled` 时应在一个轮询周期内退出；真不响应就
   * 再补一次 interrupt（读实现里是阻塞 IO，interrupt 会把它叫醒）。无论如何都有界返回。
   */
  private inline fun awaitReader(reader: Thread, timeoutMs: Long, onInterrupted: () -> Unit) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (reader.isAlive) {
      val remaining = deadline - System.nanoTime()
      if (remaining <= 0) {
        reader.interrupt()
        return
      }
      try {
        reader.join(TimeUnit.NANOSECONDS.toMillis(remaining).coerceAtLeast(1))
      } catch (_: InterruptedException) {
        onInterrupted()
      }
    }
  }
}