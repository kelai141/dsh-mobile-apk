package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Call-site contracts for the startup video.
 *
 * The failure modes here are wiring failures, not logic failures: a missing ready hook
 * leaves the video covering the app forever, and an autostart gate that only guards one
 * of the three automatic entry points makes the toggle look broken after a resume.
 */
class SplashWiringContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name)
    return file.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun pageReadyConsoleLineDismissesTheVideo() {
    val code = codeOnly(source("MainActivity.kt"))
    val start = code.indexOf("LogCollector.isPageReadyMessage(text)")
    assertTrue("ready branch must exist", start >= 0)
    val branch = code.substring(start, minOf(start + 400, code.length))
    assertTrue("ready must dismiss the splash video", branch.contains("onSplashPageReady()"))
  }

  @Test
  fun errorAndRecoveringPhasesRemoveTheView() {
    val code = codeOnly(source("MainActivity.kt"))
    val start = code.indexOf("internal fun applyGuidePhase")
    assertTrue(start >= 0)
    val body = code.substring(start, minOf(start + 1200, code.length))
    assertTrue(body.contains("GuidePhase.Error"))
    assertTrue(body.contains("GuidePhase.Recovering"))
    assertTrue(body.contains("finishSplash("))
  }

  @Test
  fun autostartGateCoversCreateAndResume() {
    val code = codeOnly(source("MainActivity.kt"))
    // onCreate path
    val create = code.indexOf("override fun onCreate")
    val createBody = code.substring(create, minOf(create + 9000, code.length))
    assertTrue("onCreate must read the autostart preference", createBody.contains("SplashStore.autoStart(this)"))
    // onResume path
    val resume = code.indexOf("override fun onResume")
    val resumeBody = code.substring(resume, minOf(resume + 6000, code.length))
    assertTrue("onResume must honour autostart", resumeBody.contains("autoStart"))
  }

  @Test
  fun toggleActuallyDrawsItsTrack() {
    val raw = source("SplashToggle.kt")
    // ViewGroup 默认 WILL_NOT_DRAW，自定义 onDraw 必须显式清掉，否则只剩隐形热区。
    assertTrue("toggle must clear ViewGroup WILL_NOT_DRAW", raw.contains("setWillNotDraw(false)"))
  }

  @Test
  fun coldStartAutostartOverridesPersistedShutdown() {
    val code = codeOnly(source("MainActivity.kt"))
    val create = code.indexOf("override fun onCreate")
    val createBody = code.substring(create, minOf(create + 3000, code.length))
    assertTrue(
      "cold start with autostart on must clear the persisted user shutdown",
      createBody.contains("savedInstanceState == null && autoStartOnOpen") &&
        createBody.contains("EngineService.setUserShutdown(this, false)"),
    )
  }

  @Test
  fun refreshDeferralIsNotReportedAsFailure() {
    val code = codeOnly(source("EngineStartFlow.kt"))
    val start = code.indexOf("refreshSnapshot(")
    assertTrue(start >= 0)
    val body = code.substring(start, minOf(start + 5000, code.length))
    val deferred = body.indexOf("lastRefreshDeferred")
    val failure = body.indexOf("snapshot-refresh-failed")
    assertTrue("refresh deferred branch must exist", deferred >= 0)
    assertTrue("deferral must be handled before the failure path", failure < 0 || deferred < failure)
  }

  @Test
  fun removalReallyRemovesTheView() {
    val raw = source("SplashOverlay.kt")
    assertTrue("dismiss must remove the view, not hide it", raw.contains("container.removeView("))
    assertFalse("hiding would leave an invisible touch layer", raw.contains("visibility = View.GONE"))
  }

  @Test
  fun playerIsMutedAndLooping() {
    val raw = source("SplashOverlay.kt")
    assertTrue(raw.contains("media.setVolume(0f, 0f)"))
    assertTrue(raw.contains("media.isLooping = true"))
  }

  @Test
  fun importHappensOffTheMainThreadWithABoundedCopy() {
    val importer = source("SplashImportController.kt")
    assertTrue("copy must run on its own thread", importer.contains("dsh-splash-import"))
    val store = source("SplashStore.kt")
    assertTrue("copy must abort at the limit", store.contains("written > SplashPolicy.MAX_BYTES"))
  }

  @Test
  fun settingsEntryLivesUnderTheGuideGearMenu() {
    val raw = source("GuideManagementController.kt")
    assertTrue(raw.contains("showSplash()"))
    assertTrue("back from the splash page returns to management", raw.contains("\"splash\" ->"))
    assertTrue("process recreation must restore the page", raw.contains("page == \"splash\""))
  }
}
