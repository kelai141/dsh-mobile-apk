package com.dsharnessmobile.shell.nativecontrol

import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit.SECONDS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeOperationWorkerTest {
  @Test fun rejectsWorkInFlightButAcceptsTheNextActionAsSoonAsTheFirstSettles() {
    val worker = NativeOperationWorker("native-worker-test")
    val entered = CountDownLatch(1)
    val finish = CountDownLatch(1)
    val first = worker.supplyAsync {
      entered.countDown()
      check(finish.await(5, SECONDS))
      20
    }
    val next = first.thenCompose { value -> worker.supplyAsync { value + 22 } }
    try {
      assertTrue(entered.await(5, SECONDS))
      assertThrows(RejectedExecutionException::class.java) { worker.supplyAsync { error("ran while busy") } }
    } finally {
      finish.countDown()
    }
    assertEquals(42, next.get(5, SECONDS))
  }

  @Test fun boundedQueueRunsAcceptedBrowserWorkInOrder() {
    val worker = NativeOperationWorker("browser-worker-test", queued = 2)
    val entered = CountDownLatch(1)
    val finish = CountDownLatch(1)
    val order = mutableListOf<Int>()
    val first = worker.supplyAsync {
      entered.countDown()
      check(finish.await(5, SECONDS))
      order.add(1)
    }
    try {
      assertTrue(entered.await(5, SECONDS))
      val second = worker.supplyAsync { order.add(2) }
      val third = worker.supplyAsync { order.add(3) }
      assertThrows(RejectedExecutionException::class.java) { worker.supplyAsync { order.add(4) } }
      finish.countDown()
      first.get(5, SECONDS)
      second.get(5, SECONDS)
      third.get(5, SECONDS)
      assertEquals(listOf(1, 2, 3), order)
    } finally {
      finish.countDown()
    }
  }
}
