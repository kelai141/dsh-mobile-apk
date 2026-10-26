package com.dsharnessmobile.shell

import java.io.ByteArrayInputStream
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import org.junit.Assert.*
import org.junit.Test

class UpdateCheckDeadlineTest {
  private class Clock(var time: Long = 0) {
    fun deadline(active: () -> Boolean = { true }) = UpdateCheckDeadline.start({ time }, active)
  }

  private class Connection(url: URL, val code: Int, val body: String = "ok") : HttpURLConnection(url) {
    var closed = false
    var beforeHeaders: () -> Unit = {}
    var beforeBody: () -> Unit = {}
    override fun connect() = Unit
    override fun disconnect() { closed = true }
    override fun usingProxy() = false
    override fun getResponseCode(): Int { beforeHeaders(); return code }
    override fun getHeaderField(name: String?): String? = if (name == "Location") "https://github.com/next" else null
    override fun getInputStream(): java.io.InputStream {
      beforeBody()
      return ByteArrayInputStream(body.toByteArray())
    }
  }

  private fun timeout(block: () -> Unit) {
    try { block(); fail("Expected deadline rejection") } catch (_: InterruptedIOException) { }
  }

  @Test fun fallbackStillHasTimeAfterFiveSlowSources() {
    val clock = Clock()
    val deadline = clock.deadline()
    for (seconds in listOf(8, 15, 15, 8, 30)) {
      val source = deadline.source(seconds * 1000)
      clock.time += seconds * 2000 - 1
      assertEquals(1L, source.remainingMs())
    }
    assertTrue(clock.time > 120_000)
    assertTrue(deadline.remainingMs() >= 30_000)
    clock.time += 29_999
    assertTrue(deadline.remainingMs() > 0)
  }

  @Test fun sourceDoesNotResetTheOverallDeadline() {
    val clock = Clock()
    val deadline = clock.deadline()
    clock.time = UpdateCheckDeadline.TOTAL_MS - 7
    assertEquals(7, deadline.source(30_000).timeoutMs(30_000))
    clock.time += 7
    timeout { deadline.source(30_000).remainingMs() }
  }

  @Test fun sourceBudgetIncludesBothPhasesAndRedirects() {
    val clock = Clock()
    val source = clock.deadline().source(8000)
    clock.time = 15_999
    assertEquals(1, source.timeoutMs(8000))
    clock.time++
    timeout { source.remainingMs() }
  }

  @Test fun cancellationRejectsAnOtherwiseLiveBudget() {
    var active = true
    val deadline = Clock().deadline { active }
    active = false
    timeout { deadline.remainingMs() }
  }

  @Test fun redirectCannotAcquireAFreshSourceBudget() {
    val clock = Clock()
    val connections = mutableListOf<Connection>()
    timeout {
      UpdateChecker.fetchText("https://github.com/start", 8000, null, clock.deadline()) { url ->
        Connection(url, 302).apply {
          beforeHeaders = { clock.time += 8000 }
          connections.add(this)
        }
      }
    }
    assertEquals(2, connections.size)
    assertTrue(connections.all { it.closed })
  }

  @Test fun lateBodyCannotBeReturnedAsSuccessfulMetadata() {
    val clock = Clock()
    val connection = Connection(URL("https://github.com/start"), 200).apply {
      beforeBody = { clock.time += UpdateCheckDeadline.TOTAL_MS }
    }
    timeout { UpdateChecker.fetchText(connection.url.toString(), 8000, null, clock.deadline()) { connection } }
    assertTrue(connection.closed)
  }

  @Test fun exhaustedBudgetDoesNotOpenAnotherRequest() {
    val clock = Clock()
    val deadline = clock.deadline()
    clock.time = UpdateCheckDeadline.TOTAL_MS
    var opened = false
    timeout {
      UpdateChecker.fetchText("https://github.com/start", 8000, null, deadline) {
        opened = true
        Connection(it, 200)
      }
    }
    assertFalse(opened)
  }

  @Test fun successfulMetadataStillClosesItsConnection() {
    val connection = Connection(URL("https://github.com/start"), 200, "metadata")
    assertEquals("metadata", UpdateChecker.fetchText(connection.url.toString(), 8000, null, Clock().deadline()) { connection })
    assertTrue(connection.closed)
  }

  @Test fun blockedHeadersAreDisconnectedAtTheSourceDeadline() {
    val released = java.util.concurrent.CountDownLatch(1)
    val timerDisconnected = java.util.concurrent.atomic.AtomicBoolean(false)
    val connection = object : HttpURLConnection(URL("https://github.com/start")) {
      override fun connect() = Unit
      override fun usingProxy() = false
      override fun disconnect() {
        if (Thread.currentThread().name == "dsh-update-metadata-deadline") timerDisconnected.set(true)
        released.countDown()
      }
      override fun getResponseCode(): Int {
        assertTrue(released.await(5, java.util.concurrent.TimeUnit.SECONDS))
        return 200
      }
    }
    timeout { UpdateChecker.fetchText(connection.url.toString(), 250, null, UpdateCheckDeadline.start()) { connection } }
    assertTrue("The scheduled expiry must close the blocked connection", timerDisconnected.get())
  }

  @Test fun expiredResultIsRejectedEvenBeforeTheWatchdogRuns() {
    val controller = ApkUpdateController(android.app.Activity())
    val type = ApkUpdateController::class.java
    val state = type.getDeclaredField("state").apply { isAccessible = true }.get(controller) as ApkUpdateState
    assertTrue(state.beginCheck())
    val epoch = type.getDeclaredMethod("advanceEpoch").apply { isAccessible = true }.invoke(controller) as Int
    val clock = Clock()
    type.getDeclaredField("checkDeadline").apply { isAccessible = true }.set(controller, clock.deadline())
    clock.time = UpdateCheckDeadline.TOTAL_MS
    controller.publishCheckResult(UpdateChecker.CheckResult.Available("v9.9.9", "app.apk", "https://example.invalid/app.apk", "ab", 1L), epoch)
    assertEquals(ApkUpdateState.STATE_FAILED, controller.stateName())
    assertNull(controller.invariantViolation())
  }
}
