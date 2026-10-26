package com.dsharnessmobile.shell

import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.*
import org.junit.Test

class UpdateCheckDeadlineDeviceTest {
  @Test fun expiryDisconnectsARequestBlockedInHeaders() {
    val released = CountDownLatch(1)
    val timerClosed = AtomicBoolean(false)
    val connection = object : HttpURLConnection(URL("https://github.com/start")) {
      override fun connect() = Unit
      override fun usingProxy() = false
      override fun disconnect() {
        if (Thread.currentThread().name == "dsh-update-metadata-deadline") timerClosed.set(true)
        released.countDown()
      }
      override fun getResponseCode(): Int {
        assertTrue(released.await(5, TimeUnit.SECONDS))
        return 200
      }
    }
    try {
      UpdateChecker.fetchText(connection.url.toString(), 250, null, UpdateCheckDeadline.start()) { connection }
      fail("Expired metadata must not return")
    } catch (_: InterruptedIOException) { }
    assertTrue(timerClosed.get())
  }

  @Test fun redirectHopsShareOneSourceBudget() {
    var time = 0L
    var opened = 0
    var closed = 0
    try {
      UpdateChecker.fetchText("https://github.com/start", 8000, null, UpdateCheckDeadline.start({ time })) { url ->
        opened++
        object : HttpURLConnection(url) {
          override fun connect() = Unit
          override fun disconnect() { closed++ }
          override fun usingProxy() = false
          override fun getResponseCode(): Int { time += 8000; return 302 }
          override fun getHeaderField(name: String?): String? = if (name == "Location") "https://github.com/next" else null
        }
      }
      fail("Redirect must not reset its deadline")
    } catch (_: InterruptedIOException) { }
    assertEquals(2, opened)
    assertEquals(opened, closed)
  }

  @Test fun expiredSuccessCannotBeatTheMainThreadWatchdog() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
    val controller = ApkUpdateController(activity)
    try {
      val type = ApkUpdateController::class.java
      val state = type.getDeclaredField("state").apply { isAccessible = true }.get(controller) as ApkUpdateState
      assertTrue(state.beginCheck())
      val epoch = type.getDeclaredMethod("advanceEpoch").apply { isAccessible = true }.invoke(controller) as Int
      var time = 0L
      type.getDeclaredField("checkDeadline").apply { isAccessible = true }.set(controller, UpdateCheckDeadline.start({ time }))
      time = UpdateCheckDeadline.TOTAL_MS
      controller.publishCheckResult(UpdateChecker.CheckResult.Available("v9.9.9", "app.apk", "https://example.invalid/app.apk", "ab", 1L), epoch)
      assertEquals(ApkUpdateState.STATE_FAILED, controller.stateName())
      assertNull(controller.invariantViolation())
    } finally {
      controller.release()
      instrumentation.runOnMainSync { activity.finish() }
    }
  }
}
