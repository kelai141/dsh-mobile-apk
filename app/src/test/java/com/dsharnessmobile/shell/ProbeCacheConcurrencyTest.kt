package com.dsharnessmobile.shell

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1512：`FunctionalProbeCache` 的 `snapshot` 无 `@Volatile`、计数是裸 `var`——
 * 探测线程写、`status()` 的调用线程读，弱内存下读侧可能长期看到 `probed=false`
 * （面板永久 `shizuku-probe-pending`，且每轮都重新 kick，把 binder 反复打）。
 *
 * 判据是**行为**：真起 16 个线程同时要探测，只能有一次真正落到 binder。
 */
class ProbeCacheConcurrencyTest {

  @Test
  fun concurrentProbesCollapseToOneBinderCall() {
    val cache = FunctionalProbeCache(ttlMs = 30_000L) { 1_000L }
    val binderCalls = AtomicInteger(0)
    val threads = 16
    val start = CountDownLatch(1)
    val done = CountDownLatch(threads)
    repeat(threads) {
      Thread({
        start.await()
        cache.probeIfNeeded({ binderCalls.incrementAndGet(); 2 }, now = 1_000L)
        done.countDown()
      }, "probe-$it").start()
    }
    start.countDown()
    assertTrue("16 路并发必须在 5s 内结束", done.await(5, TimeUnit.SECONDS))
    assertEquals("并发的 16 路只能真正探一次（单飞）", 1, cache.probeCalls)
    assertEquals("binder 只能被打一次", 1, binderCalls.get())
    assertEquals("读侧必须看到探测已落地（可见性）", true, cache.current().probed)
  }

  @Test
  fun expiredWindowProbesAgainExactlyOnce() {
    val cache = FunctionalProbeCache(ttlMs = 30_000L) { 1_000L }
    val binderCalls = AtomicInteger(0)
    cache.probeIfNeeded({ binderCalls.incrementAndGet(); 2 }, now = 1_000L)
    cache.probeIfNeeded({ binderCalls.incrementAndGet(); 2 }, now = 20_000L) // TTL 内
    assertEquals("TTL 内不得再打 binder", 1, binderCalls.get())
    cache.probeIfNeeded({ binderCalls.incrementAndGet(); 2 }, now = 31_002L) // 越过 TTL
    assertEquals("TTL 过期后补探一次", 2, binderCalls.get())
    assertEquals(2, cache.probeCalls)
  }
}