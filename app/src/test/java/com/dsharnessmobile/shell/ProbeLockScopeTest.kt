package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * issue #1558：探测**不得在持锁期间跑 binder**。
 *
 * 缺陷形态：`probeIfNeeded` 把 `synchronized(probeLock)` 包到整个探测上，而 `kickFunctionalProbe`
 * 与 `status()` 用同一把锁 ⇒ Shizuku 用户服务挂起（`run()` 秒级）时，UI 线程的
 * `shizukuStatus()` 会在等锁时被一起拖住（ANR 风险）。
 *
 * 判据全部是行为：用一个**会阻塞的 run()**，断言探测进行中读侧不被阻塞、且不重复打 binder。
 */
class ProbeLockScopeTest {

  /** 探测进行中，读侧（current/isFresh/shouldProbe）必须立即可用，不得等锁。 */
  @Test
  fun readsAreNotBlockedWhileProbeRuns() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val cache = FunctionalProbeCache(ttlMs = 30_000L, clock = { 1_000L })
    val probe = Thread({
      cache.probeIfNeeded({
        entered.countDown()
        release.await(10, TimeUnit.SECONDS)
        42
      })
    }, "probe")
    probe.start()
    assertTrue("探测必须真的进到 run()", entered.await(5, TimeUnit.SECONDS))

    // 关键判据：此刻探测正卡在 run() 里；读侧必须能在**很短的时间**内返回。
    val done = CountDownLatch(1)
    val result = arrayOf<Any?>(null)
    val reader = Thread({
      result[0] = cache.current()
      cache.isFresh()
      cache.shouldProbe()
      done.countDown()
    }, "reader")
    reader.start()
    assertTrue(
      "读侧被探测阻塞了：锁覆盖了 binder 调用（issue #1558）",
      done.await(2, TimeUnit.SECONDS),
    )
    assertTrue("探测未完成前读侧应看到 probed=false", (result[0] as FunctionalProbeSnapshot).probed.not())

    release.countDown()
    probe.join(5_000L)
    reader.join(5_000L)
    assertEquals(42, cache.current().protocolVersion)
  }

  /** 占位期间另一路 probeIfNeeded 不得重复打 binder，直接拿到现有快照。 */
  @Test
  fun concurrentProbeDoesNotCallBinderTwice() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val binderCalls = AtomicInteger(0)
    val cache = FunctionalProbeCache(ttlMs = 30_000L, clock = { 1_000L })
    val first = Thread({
      cache.probeIfNeeded({
        entered.countDown()
        release.await(10, TimeUnit.SECONDS)
        binderCalls.incrementAndGet()
        7
      })
    }, "first")
    first.start()
    assertTrue(entered.await(5, TimeUnit.SECONDS))

    // 第二路：探测在途，必须立刻返回且**不**打 binder
    val secondDone = CountDownLatch(1)
    val secondSnapshot = arrayOf<FunctionalProbeSnapshot?>(null)
    val second = Thread({
      secondSnapshot[0] = cache.probeIfNeeded({ binderCalls.incrementAndGet(); 9 })
      secondDone.countDown()
    }, "second")
    second.start()
    assertTrue("第二路不该被阻塞", secondDone.await(2, TimeUnit.SECONDS))
    assertEquals("在途时第二路不得打 binder", 0, binderCalls.get())
    assertTrue("在途时第二路拿到的是现有快照", secondSnapshot[0]!!.probed.not())

    release.countDown()
    first.join(5_000L)
    second.join(5_000L)
    assertEquals("一起探测只有一次 binder 调用", 1, binderCalls.get())
    assertEquals(7, cache.current().protocolVersion)
    assertEquals(1, cache.probeCalls)
  }

  /** 失败也要释放占位：否则一次异常会把缓存永久钉在「在途中」。 */
  @Test
  fun failedProbeReleasesInFlightAndCanRetry() {
    var now = 1_000L
    val cache = FunctionalProbeCache(ttlMs = 30_000L, clock = { now })
    val first = cache.probeIfNeeded({ throw IllegalStateException("binder 挂了") })
    assertTrue("失败也要记为已探测", first.probed)
    assertTrue(first.error.contains("binder 挂了"))
    // TTL 内不重探（失败也照样计入 TTL：否则 binder 挂掉时会每次轮询都打一遍）
    val ranEarly = AtomicBoolean(false)
    cache.probeIfNeeded({ ranEarly.set(true); 5 })
    assertTrue("TTL 内失败结果也要被复用，不得立刻重试", ranEarly.get().not())
    // 越过 TTL 必须能重试——且占位确实已释放（否则永远探不了）
    now += 31_000L
    val ran = AtomicBoolean(false)
    val second = cache.probeIfNeeded({ ran.set(true); 5 })
    assertTrue("占位必须已释放，否则第二次永远不会真的探", ran.get())
    assertEquals(5, second.protocolVersion)
  }
}