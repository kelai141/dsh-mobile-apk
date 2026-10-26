package com.dsharnessmobile.shell

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #607 的回归面：tier-2 截图管道读线程的**生命周期**。
 *
 * 缺陷形态（#582 的 I-7A 版本，已被 #614 指认）：`capturePng` 在回执失败、异常、
 * join 超时三个出口都直接 `return null`，既不置取消标记也不关读端，读线程就这样留在管道
 * 上阻塞——远端继续持有写端时它永不退出。每失败一次积一个线程加一对 fd。
 *
 * 这些用例用 [CapturePipeDrain] 做**真实线程审计**（`Thread.getAllStackTraces()` 里按
 * [CapturePipeDrain.READER_NAME] 找线程），不是读源码形状：判据是「方法返回后线程确实没了」。
 */
class CapturePipeDrainTest {

  companion object {
    /**
     * 每例的超时是**判据的一部分**：读线程没被收掉时，方法会一直等下去——那种回归不能让 CI
     * 挂住不返回，必须在有限时间内判红。
     */
    private const val TEST_TIMEOUT_MS = 20_000L
  }

  private fun readers(): Set<Thread> =
    Thread.getAllStackTraces().keys.filter { it.isAlive && it.name == CapturePipeDrain.READER_NAME }.toSet()

  /** 每例前后都清场，避免上一例残留把下一例的差值抹平。 */
  private fun assertNoLeak(before: Set<Thread>) {
    val leaked = readers() - before
    for (thread in leaked) thread.join(2_000)
    assertTrue("返回后不得遗留读线程：" + leaked.size + " 个仍存活", (readers() - before).isEmpty())
  }

  @Test(timeout = TEST_TIMEOUT_MS)
  fun largePayloadIsDrainedWhileCaptureIsStillWriting() {
    val before = readers()
    val expected = ByteArray(256 * 1024) { (it % 251).toByte() }
    val offset = AtomicInteger(0)
    val firstRead = CountDownLatch(1)
    val drained = CapturePipeDrain.drain(
      read = { buffer, _ ->
        firstRead.countDown()
        val at = offset.get()
        if (at >= expected.size) {
          CapturePipeDrain.EOF
        } else {
          val n = minOf(buffer.size, expected.size - at)
          System.arraycopy(expected, at, buffer, 0, n)
          offset.addAndGet(n)
          n
        }
      },
      closeWriter = {},
      closeReader = {},
      startCapture = {
        // 关键判据：发起 capture 时读端必须**已经在读**。若读端要在 capture 返回后才开始，
        // PNG 超过管道缓冲（64KiB）时双端就会互等（#607 的 I-7A 死锁形态）。
        assertTrue(
          "发起 capture 前读线程必须已经开始排空（否则 64KiB 管道死锁）",
          firstRead.await(2, TimeUnit.SECONDS),
        )
        true
      },
    )
    assertArrayEquals(expected, drained)
    assertNoLeak(before)
  }

  /**
   * 反证（对应 #607 实测的第二种形态）：远端回执 true 之后仍然**不结束写入**。
   * 旧语义下等待有界、但读线程被留下；这里要求返回 null **且**线程被收干净。
   */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun joinTimeoutReturnsNullAndReclaimsTheReader() {
    val before = readers()
    val fixture = RetainedWriterFixture()
    val drained = CapturePipeDrain.drain(
      read = fixture.read,
      closeWriter = {},
      closeReader = {},
      startCapture = {
        // 回执在「读线程已经读写端」之后才返回：这才是远端持有写端的真实次序。
        assertTrue("读线程必须先进入读取", fixture.entered.await(2, TimeUnit.SECONDS))
        true
      },
      joinTimeoutMs = 200,
    )
    assertNull("join 超时必须拒收（可能只是半张 PNG）", drained)
    assertTrue("取消标记必须在返回前置位", fixture.cancelledSeen.get())
    assertNoLeak(before)
  }

  /** 反证一：#607 实测的第一种形态——远端回执 false，但写端仍被它持有。 */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun falseReceiptReturnsNullAndReclaimsTheReader() {
    val before = readers()
    val fixture = RetainedWriterFixture()
    val drained = CapturePipeDrain.drain(
      read = fixture.read,
      closeWriter = {},
      closeReader = {},
      startCapture = {
        assertTrue("读线程必须先进入读取", fixture.entered.await(2, TimeUnit.SECONDS))
        false
      },
    )
    assertNull(drained)
    assertTrue("回执失败也必须取消读线程", fixture.cancelledSeen.get())
    assertNoLeak(before)
  }

  /**
   * binder 抛异常：异常原样上抛（保留堆栈给调用方记账），但读线程与读端必须已经收干净。
   * `capturePng` 外层是 `runCatching`，所以对它的调用方仍然表现为「截图失败」。
   */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun exceptionalReceiptPropagatesButStillReclaimsTheReader() {
    val before = readers()
    val fixture = RetainedWriterFixture()
    val thrown = try {
      CapturePipeDrain.drain(
        read = fixture.read,
        closeWriter = {},
      closeReader = {},
        startCapture = {
          assertTrue("读线程必须先进入读取", fixture.entered.await(2, TimeUnit.SECONDS))
          throw IllegalStateException("fixture capture failure")
        },
      )
      null
    } catch (t: IllegalStateException) {
      t
    }
    assertNotNull("binder 异常必须原样上抛（不得被静默吞成 null）", thrown)
    assertTrue("binder 抛异常也必须取消读线程", fixture.cancelledSeen.get())
    assertNoLeak(before)
  }

  /** 「远端一直持有写端」的最小复现：读实现只在被取消后退出，并记录它看到了取消标记。 */
  private class RetainedWriterFixture {
    val entered = CountDownLatch(1)
    val cancelledSeen = AtomicBoolean(false)

    val read: (ByteArray, AtomicBoolean) -> Int = { _, cancelled ->
      entered.countDown()
      while (!cancelled.get()) Thread.sleep(10)
      cancelledSeen.set(true)
      CapturePipeDrain.EOF
    }
  }

  /**
   * 设备层实测踩到的回归（#627 自测）：`closeWriter` 必须在 `startCapture` 返回后**立刻**被调用。
   *
   * 宿主自己还握着写端时，读端永远等不到 EOF——256KiB 的正常载荷会被 join 超时误判成失败。
   * 判据用真实语义：写端开着就不返回 EOF（真实管道在这里阻塞），关掉才返回 EOF。
   */
  @Test
  fun writerIsClosedRightAfterCaptureSoTheReaderSeesEof() {
    val before = readers()
    val expected = ByteArray(128 * 1024) { (it % 241).toByte() }
    val writerOpen = AtomicBoolean(true)
    val offset = AtomicInteger(0)
    val drained = CapturePipeDrain.drain(
      read = { buffer, _ ->
        val at = offset.get()
        if (at < expected.size) {
          val n = minOf(buffer.size, expected.size - at)
          System.arraycopy(expected, at, buffer, 0, n)
          offset.addAndGet(n)
          n
        } else if (writerOpen.get()) {
          // 写端还开着：真实管道在这里阻塞，这里用短睡眠模拟「没有新数据」。
          Thread.sleep(5)
          0
        } else {
          CapturePipeDrain.EOF
        }
      },
      closeWriter = { writerOpen.set(false) },
      closeReader = {},
      startCapture = { true },
      joinTimeoutMs = 2_000,
    )
    assertArrayEquals("写端必须及时关闭，否则 128KiB 正常载荷会被误判成超时", expected, drained)
    assertNoLeak(before)
  }

  /** 读端失败（例如 POLLERR）必须判失败，不能把半截字节当截图交出去。 */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun readFailureIsNeverReportedAsASuccessfulCapture() {
    val before = readers()
    val drained = CapturePipeDrain.drain(
      read = { _, _ -> throw IOException("fixture pipe failure") },
      closeWriter = {},
      closeReader = {},
      startCapture = { true },
      joinTimeoutMs = 2_000,
    )
    assertNull("读失败必须返回 null", drained)
    assertNoLeak(before)
  }

  /** 中断信号属于调用方：必须原样保留，不得被内部 join 吞掉。 */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun interruptionIsPreservedAndTheReaderIsReclaimed() {
    val before = readers()
    Thread.currentThread().interrupt()
    val drained = try {
      CapturePipeDrain.drain(
        read = { _, cancelled ->
          while (!cancelled.get()) Thread.sleep(5)
          CapturePipeDrain.EOF
        },
        closeWriter = {},
      closeReader = {},
        startCapture = { true },
        joinTimeoutMs = 5_000,
      )
    } finally {
      val stillInterrupted = Thread.interrupted()
      assertEquals("调用方线程的中断信号必须在返回后仍然置位", true, stillInterrupted)
    }
    assertNull(drained)
    assertNoLeak(before)
  }

  /**
   * 空 PNG 的语义边界（口径锁定，不在此处改语义）。
   *
   * 时间线要说清：`takeIf { it.isNotEmpty() }` 是 **#582 就有的既有语义**，不是本 PR（线程回收）
   * 引入的收紧，也不是 #614 新增的。远端声称成功却一个字节都没有，只可能来自压缩失败或写端
   * 提前关闭——前者远端会把回执折成 false，后者读端会抛异常，两条都到不了这里。
   *
   * 本条用例锁的是**分层**：`drain` 只负责线程生命周期、原样交回 0 字节；「0 字节按失败」
   * 统一在 `capturePng` 折叠。要改语义就必须显式改这条用例并说明理由。
   */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun emptyPayloadIsReportedAsIsAndFilteringHappensInCapturePng() {
    val before = readers()
    val drained = CapturePipeDrain.drain(
      read = { _, _ -> CapturePipeDrain.EOF },
      closeWriter = {},
      closeReader = {},
      startCapture = { true },
    )
    assertNotNull("drain 只负责线程生命周期，空结果原样返回", drained)
    assertEquals("空载荷长度为 0", 0, drained!!.size)
    assertNoLeak(before)
  }

  /** 收尾失败只能靠取消有界兜底：closeReader 抛异常不得让线程留下、也不得掩盖原结果。 */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun closeFailureDoesNotLeakTheReader() {
    val before = readers()
    val drained = CapturePipeDrain.drain(
      read = { _, cancelled ->
        while (!cancelled.get()) Thread.sleep(5)
        CapturePipeDrain.EOF
      },
      closeWriter = {},
      closeReader = { throw IllegalStateException("fixture close failure") },
      startCapture = { false },
    )
    assertNull(drained)
    assertNoLeak(before)
  }

  /** 每次收尾都必须真的调用 closeReader，否则管道两端会被远端与宿主各自持有到 GC。 */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun closeReaderIsAlwaysInvokedOncePerCall() {
    val before = readers()
    val closed = AtomicInteger(0)
    val drained = CapturePipeDrain.drain(
      read = { buffer, _ -> if (buffer.isEmpty()) CapturePipeDrain.EOF else CapturePipeDrain.EOF },
      closeWriter = {},
      closeReader = { closed.incrementAndGet() },
      startCapture = { true },
    )
    assertNotNull(drained)
    assertEquals("closeReader 必须被调用恰好一次", 1, closed.get())
    assertNoLeak(before)
  }

  /** 取消收尾耗时必须有界：远端死持写端时也不能把宿主线程卡住超过取消预算。 */
  @Test(timeout = TEST_TIMEOUT_MS)
  fun cancellationIsBoundedWhenTheReaderIgnoresIt() {
    val before = readers()
    val started = CountDownLatch(1)
    val startedAt = System.nanoTime()
    val drained = CapturePipeDrain.drain(
      read = { _, _ ->
        started.countDown()
        // 完全不响应取消：取消路径必须靠有界 join 兜底，而不是靠读实现配合。
        Thread.sleep(3_000)
        CapturePipeDrain.EOF
      },
      closeWriter = {},
      closeReader = {},
      startCapture = { false },
      cancelJoinTimeoutMs = 300,
    )
    val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
    assertNull(drained)
    assertTrue("取消必须在预算附近收口，实测 " + elapsedMs + "ms", elapsedMs < 2_000)
    for (thread in readers() - before) thread.join(5_000)
    assertFalse("取消后读线程必须不再存活", readers().any { it.isAlive })
  }
}
