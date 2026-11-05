package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.view.View
import androidx.test.platform.app.InstrumentationRegistry
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

/** The real foreground monitor must observe an already authorized, late healthy attempt. */
class LateColdStartDeviceTest {
  @Test fun lateHealthyAttemptRevealsPageWithoutResettingRetryBudget() = fixture { activity ->
    RepairState.resetProcessStateForTest()
    RepairState.spendColdStartAutoAttempt()
    onMain { activity.engineFlow.startMonitor() }
    assertTrue("Late healthy page becomes visible", waitVisible(activity))
    assertTrue("HTTP alone does not clear the durable gate", RepairState.required(activity))
    assertEquals(2, RepairState.retries(activity))
    onMain { activity.engineFlow.onPageReadyReported("[dsh-boot-ready] fixture") }
    assertFalse("Page-ready evidence completes health convergence", RepairState.required(activity))
    assertEquals(0, RepairState.retries(activity))
  }

  @Test fun resumedAttemptRestartsPassiveObservation() = fixture { activity ->
    RepairState.resetProcessStateForTest()
    RepairState.spendColdStartAutoAttempt()
    onMain {
      instrumentation.callActivityOnPause(activity)
      instrumentation.callActivityOnResume(activity)
    }
    assertTrue("Resume observes the existing attempt", waitVisible(activity))
    assertTrue(RepairState.required(activity))
    assertEquals(2, RepairState.retries(activity))
  }

  @Test fun newlyArmedRepairStillBlocksAnOtherwiseHealthyEndpoint() = fixture { activity ->
    RepairState.resetProcessStateForTest()
    RepairState.spendColdStartAutoAttempt()
    RepairState.requireRepair(activity)
    onMain { activity.engineFlow.startMonitor() }
    assertFalse("A new failure must not bypass the repair gate", waitVisible(activity, 1_500))
    assertTrue(RepairState.required(activity))
    assertEquals(2, RepairState.retries(activity))
  }

  @Test fun repairArmedDuringTheHttpProbeRejectsItsLateUiCallback() = fixture { activity ->
    RepairState.resetProcessStateForTest()
    RepairState.spendColdStartAutoAttempt()
    val hold = ProbeHold()
    heldProbe = hold
    onMain { activity.engineFlow.startMonitor() }
    assertTrue("The health request is in flight", hold.entered.await(3, TimeUnit.SECONDS))
    RepairState.requireRepair(activity)
    hold.release.countDown()
    assertFalse("A late successful response cannot override the new gate", waitVisible(activity, 1_500))
    assertTrue(RepairState.required(activity))
    assertEquals(2, RepairState.retries(activity))
  }

  private class ProbeHold {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
  }
  @Volatile private var heldProbe: ProbeHold? = null

  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private fun onMain(action: () -> Unit) = instrumentation.runOnMainSync(action)

  private fun waitVisible(activity: MainActivity, budgetMs: Long = 6_000): Boolean {
    val end = android.os.SystemClock.elapsedRealtime() + budgetMs
    while (android.os.SystemClock.elapsedRealtime() < end) {
      var visible = false
      onMain { visible = activity.webView.visibility == View.VISIBLE }
      if (visible) return true
      Thread.sleep(50)
    }
    return false
  }

  private fun fixture(action: (MainActivity) -> Unit) {
    val context = instrumentation.targetContext
    val prefs = context.getSharedPreferences("native-repair", Context.MODE_PRIVATE)
    val original = prefs.all
    val shutdown = EngineService.isUserShutdownPersisted(context)
    val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
    val serving = Thread {
      while (!server.isClosed) {
        try {
          server.accept().use { socket ->
            socket.soTimeout = 2_000
            val reader = socket.getInputStream().bufferedReader()
            while (true) { if (reader.readLine().isNullOrEmpty()) break }
            heldProbe?.let { hold ->
              heldProbe = null
              hold.entered.countDown()
              hold.release.await(5, TimeUnit.SECONDS)
            }
            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".toByteArray())
          }
        } catch (_: java.io.IOException) { }
      }
    }.apply { isDaemon = true; start() }
    var activity: MainActivity? = null
    try {
      RepairState.requireRepair(context)
      RepairState.setRetries(context, 2)
      EngineService.setUserShutdown(context, false)
      activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
      instrumentation.waitForIdleSync()
      val current = activity
      onMain {
        current.engineFlow.stopMonitoring()
        RepairState.active = false
        RepairState.retryPending = false
        current.userClosedEngine = false
        current.engineManager.lastStartRefusalCode = null
        EngineEndpoint.adoptConfirmedPort(server.localPort)
        val url = EngineEndpoint.url + "/"
        current.webView.loadDataWithBaseURL(url, "<html><body>Late engine fixture</body></html>", "text/html", "UTF-8", url)
        current.showGuide()
      }
      val done = CountDownLatch(1)
      onMain { current.webView.evaluateJavascript("document.readyState") { done.countDown() } }
      assertTrue(done.await(5, TimeUnit.SECONDS))
      action(current)
    } finally {
      activity?.let { current -> onMain { current.engineFlow.stopMonitoring(); current.finish() } }
      instrumentation.waitForIdleSync()
      RepairState.resetProcessStateForTest()
      RepairState.active = false
      RepairState.retryPending = false
      prefs.edit().clear().apply {
        original.forEach { (key, value) -> when (value) {
          is Boolean -> putBoolean(key, value)
          is Int -> putInt(key, value)
        } }
      }.commit()
      EngineService.setUserShutdown(context, shutdown)
      EngineEndpoint.adoptConfirmedPort(0)
      heldProbe?.release?.countDown()
      heldProbe = null
      server.close()
      serving.join(2_000)
    }
  }
}
