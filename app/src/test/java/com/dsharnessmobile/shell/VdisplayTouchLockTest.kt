package com.dsharnessmobile.shell

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VdisplayTouchLockTest {

  @Test
  fun touchWaitsForTheRecordMonitor() {
    val controllerClass = VdisplayController::class.java
    val lockField = controllerClass.getDeclaredField("lock").apply { isAccessible = true }
    val touch = controllerClass.getDeclaredMethod("touch", String::class.java).apply { isAccessible = true }
    val monitor = lockField.get(VdisplayController) ?: error("controller lock was missing")
    val started = CountDownLatch(1)
    val finished = CountDownLatch(1)
    val worker = Thread {
      started.countDown()
      try {
        touch.invoke(VdisplayController, "missing")
      } catch (_: Throwable) {
        // Android's elapsedRealtime stub is unavailable in a local JVM test.
      } finally {
        finished.countDown()
      }
    }

    synchronized(monitor) {
      worker.start()
      assertTrue("touch worker did not start", started.await(2, TimeUnit.SECONDS))
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (worker.state != Thread.State.BLOCKED && worker.isAlive && System.nanoTime() < deadline) {
        Thread.yield()
      }
      assertEquals("touch must wait on the records monitor", Thread.State.BLOCKED, worker.state)
    }

    assertTrue("touch should continue after the monitor is released", finished.await(2, TimeUnit.SECONDS))
  }
}
