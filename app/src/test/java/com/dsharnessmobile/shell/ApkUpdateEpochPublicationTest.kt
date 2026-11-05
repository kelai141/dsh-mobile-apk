package com.dsharnessmobile.shell

import android.app.Activity
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class ApkUpdateEpochPublicationTest {
  private class Fixture {
    val controller = ApkUpdateController(Activity())
    private val type = ApkUpdateController::class.java
    private fun field(name: String) = type.getDeclaredField(name).apply { isAccessible = true }
    val state = field("state").get(controller) as ApkUpdateState
    val stateLock = ApkUpdateState::class.java.getDeclaredField("lock").apply { isAccessible = true }.get(state)!!
    val available = UpdateChecker.CheckResult.Available("v9.9.9", "app.apk", "https://example.invalid/app.apk", "ab", 1L)
    fun advance(): Int = type.getDeclaredMethod("advanceEpoch").apply { isAccessible = true }.invoke(controller) as Int
    fun fail(epoch: Int) {
      type.getDeclaredMethod("failDownload", String::class.java, String::class.java, Int::class.javaPrimitiveType)
        .apply { isAccessible = true }.invoke(controller, "obsolete failure", ApkUpdateState.KIND_DOWNLOAD_FAILED, epoch)
    }
    fun progress(epoch: Int) {
      type.getDeclaredMethod("onDownloadProgress", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
        .apply { isAccessible = true }.invoke(controller, 73, epoch)
    }
    fun publishNew(downloading: Boolean = false) {
      field("currentResult").set(controller, available)
      state.onCheckResult(available, "0.0.1")
      if (downloading) assertTrue(state.beginDownload())
    }
  }

  @Test fun staleFailurePreservesTheNewResult() {
    val f = Fixture()
    val oldEpoch = f.advance()
    f.advance()
    f.publishNew()
    f.fail(oldEpoch)
    assertEquals(ApkUpdateState.STATE_AVAILABLE, f.controller.stateName())
    assertNull(f.controller.invariantViolation())
  }

  @Test fun staleCheckPreservesTheNewResult() {
    val f = Fixture()
    val oldEpoch = f.advance()
    f.advance()
    f.publishNew()
    f.controller.publishCheckResult(UpdateChecker.CheckResult.Failed("obsolete check"), oldEpoch)
    assertEquals(ApkUpdateState.STATE_AVAILABLE, f.controller.stateName())
    assertNull(f.controller.invariantViolation())
  }

  @Test fun failureAlreadyPastTheGuardCannotOverwriteANewerCheck() = assertSerialized("onDownloadFailed") { f, e -> f.fail(e) }

  @Test fun checkAlreadyPastTheGuardCannotOverwriteANewerCheck() = assertSerialized("onCheckResult") { f, e ->
    f.controller.publishCheckResult(UpdateChecker.CheckResult.Failed("obsolete check"), e)
  }

  @Test fun progressAlreadyPastTheGuardCannotChangeANewerDownload() = assertSerialized("onDownloadProgress", true) { f, e -> f.progress(e) }

  private fun assertSerialized(stateMethod: String, downloading: Boolean = false, action: (Fixture, Int) -> Unit) {
    val f = Fixture()
    val epoch = f.advance()
    val failure = AtomicReference<Throwable?>()
    val old = Thread { try { action(f, epoch) } catch (error: Throwable) { failure.set(error) } }
    val advance = Thread { try { f.advance() } catch (error: Throwable) { failure.set(error) } }
    var published = false
    try {
      synchronized(f.stateLock) {
        old.start()
        awaitBoundary(old) { blockedIn(old, "ApkUpdateState", stateMethod) }
        advance.start()
        awaitBoundary(advance) { advance.state == Thread.State.TERMINATED || blockedIn(advance, "ApkUpdateController", "advanceEpoch") }
        if (advance.state == Thread.State.TERMINATED) {
          f.publishNew(downloading)
          published = true
        }
      }
    } finally {
      old.join(3000)
      if (advance.state != Thread.State.NEW) advance.join(3000)
    }
    assertFalse("old worker must finish", old.isAlive)
    assertFalse("invalidation must finish", advance.isAlive)
    failure.get()?.let { throw it }
    if (!published) f.publishNew(downloading)
    assertEquals(if (downloading) ApkUpdateState.STATE_DOWNLOADING else ApkUpdateState.STATE_AVAILABLE, f.controller.stateName())
    if (downloading) assertEquals("old progress must not enter the retry", 0, f.controller.percent())
    assertNull(f.controller.invariantViolation())
  }

  private fun blockedIn(thread: Thread, owner: String, method: String): Boolean =
    thread.state == Thread.State.BLOCKED && thread.stackTrace.any { it.className.endsWith(owner) && it.methodName == method }

  private fun awaitBoundary(thread: Thread, predicate: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
    while (!predicate() && System.nanoTime() < deadline) Thread.yield()
    assertTrue("expected production boundary; thread=${thread.state}, stack=${thread.stackTrace.toList()}", predicate())
  }
}
