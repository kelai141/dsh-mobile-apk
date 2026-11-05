package com.dsharnessmobile.shell

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleOutputBatcherTest {
  @Test fun promptArrivesWhileTheProducerWaitsForInput() {
    val delivered = CountDownLatch(1)
    val chunks = Collections.synchronizedList(mutableListOf<String>())
    ConsoleOutputBatcher(16 * 1024, 20) { chunks.add(it); delivered.countDown() }.use { output ->
      output.append("password: ")
      assertTrue("idle input must not keep the prompt buffered", delivered.await(2, TimeUnit.SECONDS))
      assertEquals(listOf("password: "), chunks.toList())
    }
  }

  @Test fun sizeThresholdPublishesInOrderWithoutWaitingForTheDeadline() {
    val chunks = mutableListOf<String>()
    ConsoleOutputBatcher(4, 60_000) { chunks.add(it) }.use { output ->
      output.append("ab")
      assertTrue(chunks.isEmpty())
      output.append("cd")
      assertEquals(listOf("abcd"), chunks)
      output.append("ef")
    }
    assertEquals(listOf("abcd", "ef"), chunks)
  }

  @Test fun closeDrainsOnceAndRejectsLateAppends() {
    val chunks = mutableListOf<String>()
    val output = ConsoleOutputBatcher(16 * 1024, 60_000) { chunks.add(it) }
    output.append("tail")
    output.close()
    output.close()
    output.append("stale")
    output.flush()
    assertEquals(listOf("tail"), chunks)
  }

  @Test fun forcedFlushDoesNotDeliverTheSameBurstAgainAtItsOldDeadline() {
    val chunks = Collections.synchronizedList(mutableListOf<String>())
    val firstDeadline = CountDownLatch(1)
    ConsoleOutputBatcher(16 * 1024, 20) {
      chunks.add(it)
      if (it == "next") firstDeadline.countDown()
    }.use { output ->
      output.append("first")
      output.flush()
      output.append("next")
      assertTrue(firstDeadline.await(2, TimeUnit.SECONDS))
    }
    assertEquals(listOf("first", "next"), chunks.toList())
  }
}
