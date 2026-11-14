package com.dsharnessmobile.shell

import android.view.View
import android.view.WindowManager
import java.io.File
import java.lang.reflect.Proxy
import java.util.IdentityHashMap
import org.junit.Assert.*
import org.junit.Test

/**
 * Executes the real OverlayWindows holder against a recording WindowManager. Android's existing
 * return-default JVM stubs provide inert View tokens only: no claim about real focus/IME/WMS behavior.
 * No Robolectric/Mockito dependency or duplicate production lease implementation is introduced.
 */
class OverlayPickerInteractionTest {
  private data class Frame(
    val flags: Int, val alpha: Float, val x: Int, val y: Int, val width: Int, val height: Int,
    val gravity: Int, val softInputMode: Int,
  )

  private fun frame(p: WindowManager.LayoutParams) = Frame(
    p.flags, p.alpha, p.x, p.y, p.width, p.height, p.gravity, p.softInputMode,
  )

  private inner class RecordingWindowManager {
    val applied = IdentityHashMap<View, Frame>()
    val updates = ArrayList<View>()
    var adds = 0
    var removes = 0
    var failUpdateFor: View? = null
    var failUpdateCount = 1
    val wm = Proxy.newProxyInstance(WindowManager::class.java.classLoader,
      arrayOf(WindowManager::class.java)) { proxy, method, args ->
      when (method.name) {
        "addView" -> {
          val view = args!![0] as View
          check(!applied.containsKey(view)) { "duplicate add" }
          applied[view] = frame(args[1] as WindowManager.LayoutParams)
          adds++
          null
        }
        "updateViewLayout" -> {
          val view = args!![0] as View
          updates.add(view)
          if (failUpdateFor === view) {
            failUpdateCount--
            if (failUpdateCount <= 0) failUpdateFor = null
            throw IllegalStateException("controlled WMS update failure")
          }
          check(applied.containsKey(view)) { "update detached view" }
          applied[view] = frame(args[1] as WindowManager.LayoutParams)
          null
        }
        "removeView", "removeViewImmediate" -> {
          check(applied.remove(args!![0] as View) != null) { "remove detached view" }
          removes++
          null
        }
        "hashCode" -> System.identityHashCode(proxy)
        "equals" -> proxy === args!![0]
        "toString" -> "RecordingWindowManager"
        else -> error("unexpected WindowManager call: " + method.name)
      }
    } as WindowManager
  }

  private fun params(index: Int = 0) = WindowManager.LayoutParams().apply {
    // Set every inspected field explicitly; JVM Android stubs do not execute Android defaults.
    flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
      (if (index % 2 == 0) WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
      else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM)
    alpha = if (index == 0) .12f else 1f - index * .05f
    x = 12 + index; y = 31 + index; width = 300 + index; height = 80 + index
    gravity = 51; softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
  }

  @Test fun allWindowsKeepIdentityOrderGeometryAndExactOriginalFlagsAndOpacity() {
    val fake = RecordingWindowManager()
    val holder = OverlayWindows(fake.wm) { fail(it) }
    val originals = LinkedHashMap<OverlayWindows.Slot, Pair<View, Frame>>()
    for ((index, slot) in OverlayWindows.Slot.values().withIndex()) {
      val view = View(null)
      val p = params(index)
      assertTrue(holder.add(slot, view, p))
      originals[slot] = view to frame(p)
    }
    val order = holder.slots()
    val lease = requireNotNull(holder.yieldInteraction())
    var transparency = 1.0
    for ((slot, pair) in originals) {
      val (view, original) = pair
      val yielded = requireNotNull(fake.applied[view])
      assertSame(view, holder.view(slot))
      assertEquals(original.copy(flags = original.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE, alpha = yielded.alpha), yielded)
      assertTrue("yield opacity must never exceed original opacity or a conservative per-window cap",
        yielded.alpha <= minOf(original.alpha, .2f))
      assertTrue("picker must not hide an originally visible window", yielded.alpha > 0f)
      transparency *= 1.0 - yielded.alpha
    }
    assertTrue("all registered overlapping untrusted slots must pass Android 12 opacity policy", 1.0 - transparency < .8)
    assertEquals(order, holder.slots())
    assertEquals(originals.size, holder.count())
    assertEquals(originals.size, fake.adds)
    assertEquals(0, fake.removes)

    assertTrue(holder.restoreInteraction(lease))
    for ((slot, pair) in originals) {
      assertSame(pair.first, holder.view(slot))
      assertEquals("restore every slot's own flags/opacity, not one common default", pair.second, fake.applied[pair.first])
    }
    assertEquals(order, holder.slots())
    assertEquals(originals.size, fake.adds)
    assertEquals(0, fake.removes)
    assertEquals(originals.size * 2, fake.updates.size)
  }

  @Test fun lateRestoreSkipsRemovedAndReplacedViewsAndDoesNotReattachThem() {
    val fake = RecordingWindowManager()
    val holder = OverlayWindows(fake.wm) { }
    val oldCard = View(null)
    val oldComposer = View(null)
    assertTrue(holder.add(OverlayWindows.Slot.CARD, oldCard, params(1)))
    assertTrue(holder.add(OverlayWindows.Slot.COMPOSER, oldComposer, params(2)))
    val lease = requireNotNull(holder.yieldInteraction())
    assertTrue(holder.remove(OverlayWindows.Slot.CARD))
    val replacement = View(null)
    val replacementParams = params(3)
    assertTrue(holder.add(OverlayWindows.Slot.COMPOSER, replacement, replacementParams))
    val replacementBefore = frame(replacementParams)
    val updatesBefore = fake.updates.size
    assertTrue(holder.restoreInteraction(lease))
    assertFalse(holder.contains(OverlayWindows.Slot.CARD))
    assertSame(replacement, holder.view(OverlayWindows.Slot.COMPOSER))
    assertEquals(replacementBefore, fake.applied[replacement])
    assertEquals(updatesBefore, fake.updates.size)
    assertFalse(fake.applied.containsKey(oldCard))
    assertFalse(fake.applied.containsKey(oldComposer))
    assertEquals(3, fake.adds)
    assertEquals(2, fake.removes)
  }

  @Test fun restorationDoesNotUndoLegitimateGeometryChangesOnTheSameView() {
    val fake = RecordingWindowManager()
    val holder = OverlayWindows(fake.wm) { fail(it) }
    val view = View(null)
    val p = params()
    assertTrue(holder.add(OverlayWindows.Slot.COMPOSER, view, p))
    val original = frame(p)
    val lease = requireNotNull(holder.yieldInteraction())
    p.x = 41; p.y = 67; p.width = 510; p.height = 120
    assertTrue(holder.update(OverlayWindows.Slot.COMPOSER, p))
    assertTrue(holder.restoreInteraction(lease))
    assertEquals(original.copy(x = 41, y = 67, width = 510, height = 120), fake.applied[view])
    assertSame(view, holder.view(OverlayWindows.Slot.COMPOSER))
    assertEquals(1, fake.adds)
    assertEquals(0, fake.removes)
  }

  @Test fun emptyLeaseDoesNotInventWindowsOrCalls() {
    val fake = RecordingWindowManager()
    val holder = OverlayWindows(fake.wm) { fail(it) }
    assertTrue(holder.restoreInteraction(requireNotNull(holder.yieldInteraction())))
    assertEquals(0, holder.count())
    assertEquals(0, fake.adds)
    assertEquals(0, fake.removes)
    assertTrue(fake.updates.isEmpty())
  }

  @Test fun failedYieldRollsBackEveryWindowAndReturnsNoPermissionToLaunchPicker() {
    val fake = RecordingWindowManager()
    val logs = ArrayList<String>()
    val holder = OverlayWindows(fake.wm) { logs.add(it) }
    val card = View(null)
    val composer = View(null)
    val cardParams = params(1)
    val composerParams = params(2)
    assertTrue(holder.add(OverlayWindows.Slot.CARD, card, cardParams))
    assertTrue(holder.add(OverlayWindows.Slot.COMPOSER, composer, composerParams))
    val originalCard = frame(cardParams)
    val originalComposer = frame(composerParams)
    fake.failUpdateFor = composer
    assertNull("partial yielding must abort launch, not return a successful lease", holder.yieldInteraction())
    assertEquals(originalCard, fake.applied[card])
    assertEquals(originalComposer, fake.applied[composer])
    assertEquals(originalCard, frame(requireNotNull(holder.params(OverlayWindows.Slot.CARD))))
    assertEquals(originalComposer, frame(requireNotNull(holder.params(OverlayWindows.Slot.COMPOSER))))
    assertSame(card, holder.view(OverlayWindows.Slot.CARD))
    assertSame(composer, holder.view(OverlayWindows.Slot.COMPOSER))
    assertEquals(2, fake.adds)
    assertEquals(0, fake.removes)
    assertTrue("the controlled failure cannot be swallowed silently", logs.any { it.contains("updateWindow failed") })
  }

  @Test fun failedRestoreIsReportedAndTheOriginalLeaseCanRetryWithoutRecreatingAnyView() {
    val fake = RecordingWindowManager()
    val logs = ArrayList<String>()
    val holder = OverlayWindows(fake.wm) { logs.add(it) }
    val view = View(null)
    val p = params(1)
    assertTrue(holder.add(OverlayWindows.Slot.COMPOSER, view, p))
    val original = frame(p)
    val lease = requireNotNull(holder.yieldInteraction())
    val yielded = fake.applied[view]
    fake.failUpdateFor = view
    assertFalse("failed WMS restoration must not be acknowledged as complete", holder.restoreInteraction(lease))
    assertEquals("a failed WMS call did not change the actual window", yielded, fake.applied[view])
    assertTrue("retry must use the original flags/opacity, not the yielded state", holder.restoreInteraction(lease))
    assertEquals(original, fake.applied[view])
    assertSame(view, holder.view(OverlayWindows.Slot.COMPOSER))
    assertEquals(1, fake.adds)
    assertEquals(0, fake.removes)
    assertTrue(logs.any { it.contains("updateWindow failed") })
  }

  @Test fun failedYieldAndFailedRollbackRetainTheOriginalLeaseForRecovery() {
    val fake = RecordingWindowManager()
    val holder = OverlayWindows(fake.wm) { }
    val card = View(null)
    val composer = View(null)
    val cardParams = params(1)
    val composerParams = params(2)
    assertTrue(holder.add(OverlayWindows.Slot.CARD, card, cardParams))
    assertTrue(holder.add(OverlayWindows.Slot.COMPOSER, composer, composerParams))
    val beforeCard = frame(cardParams)
    val beforeComposer = frame(composerParams)
    fake.failUpdateFor = composer
    fake.failUpdateCount = 2 // Fail the initial yield and its first rollback, then permit recovery.
    assertNull(holder.yieldInteraction())
    val pending = requireNotNull(holder.pendingInteractionRestore)
    assertTrue(holder.restoreInteraction(pending))
    assertNull(holder.pendingInteractionRestore)
    assertEquals(beforeCard, fake.applied[card])
    assertEquals(beforeComposer, fake.applied[composer])
    assertEquals(2, fake.adds)
    assertEquals(0, fake.removes)
  }

  /**
   * 气泡的底边必须由 **chip 行窗口的真实 y** 决定，不能由「composer 位置 - chip 高 - gap」反推，
   * 也不能用 gravity=TOP 把顶边摆到「由测量高度推出来的 y」。
   *
   * 设备实测（横屏 1600x900 / 密度 1.5）两次都翻车：
   *  - gravity=TOP + 测量高度 114 ⇒ 窗口实际被内容撑到 138，底边 735 压住 chip 顶 726 达 9 px；
   *  - 换成反推 chipRowTop=750（真实 726）⇒ 同样压 9 px。竖屏同症状：底边 1435 vs chip 顶 1426。
   *
   * 现方案 gravity=BOTTOM 锚底边 + 直接读 WORKSPACE 窗口的 y，实测底边 711 / chip 顶 726，
   * 间隙 15px（10dp x 1.5），两种朝向都成立。这条用例锁住「锚真实窗口、不反推」这两个要点。
   */
  @Test
  fun pickerBubbleAnchorsItsBottomToTheRealChipWindowInsteadOfGuessedHeight() {
    val text = source("OverlayV2.kt")
    val sync = body(text, "syncDrawerWindow")
    // 必须用 BOTTOM 锚底边：TOP + 测量高度会被内容撑破。
    assertTrue("bubble must anchor its bottom edge", sync.contains("lp.gravity = Gravity.BOTTOM or Gravity.START"))
    // 必须读 chip 窗口的真实 y；反推值实测偏 24px。
    assertTrue("chip row top must come from the real window",
      sync.contains("windows.params(OverlayWindows.Slot.WORKSPACE)?.y"))
    // y 必须是「屏幕高 - chipRowTop + gap」这一形态，符号写反就会把气泡推到屏幕外或压住 chip。
    assertTrue("bottom anchor formula", sync.contains("screen.heightPx - chipRowTop + gapPx"))
    // 不允许回到「用测量高度算顶边」的老写法。
    assertFalse("must not position by measured height",
      sync.contains("lp.y = (chipRowTop - h - gapPx)"))
  }

  private fun source(name: String) = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  private fun body(text: String, name: String): String {
    val start = Regex("(?m)^  (?:private|internal) fun " + Regex.escape(name) + "[(]").find(text)
      ?: error("missing function " + name)
    val tail = text.substring(start.range.first)
    val next = Regex("(?m)^  (?:private|internal) fun ").find(tail, start.value.length)
    return tail.substring(0, next?.range?.first ?: tail.length)
      .replace(Regex("""(?s)/[*].*?[*]/"""), "").replace(Regex("""//[^\r\n]*"""), "")
  }

  private fun assertSameWindowPickerContract(text: String) {
    val prepare = body(text, "prepareAttachmentUi")
    assertTrue(prepare.contains("windows.yieldInteraction()"))
    val restore = body(text, "restoreAttachmentInteraction")
    assertTrue(restore.contains("windows.restoreInteraction(lease)"))
    for ((label, method) in listOf("prepare" to prepare, "restore" to restore)) {
      for (forbidden in listOf("hideCard(", "hidePill(", "hideComposer(", "hideDrawer(", "windows.remove(",
        "windows.add(", "showComposer(", "ensureComposerView(", "recreateViewsPreservingState(",
        "restoreDraftSnapshot(", "setInputText(", "setSelection(", "focusRoot(", "focusInput(")) {
        assertFalse(label + " must preserve the attached editor: " + forbidden, method.contains(forbidden))
      }
    }
    val start = body(text, "startAttachment")
    assertTrue(start.contains("if (sid.isEmpty())"))
    assertTrue(start.indexOf("if (sid.isEmpty())") < start.indexOf("OverlayAttachProxyActivity.start("))
    assertTrue(start.indexOf("prepareAttachmentUi(") < start.indexOf("OverlayAttachProxyActivity.start("))
    for (forbidden in listOf("session/create", "createSession(", "svc.activeSessionId =", "setInputText("))
      assertFalse("picker cannot silently retarget a draft: " + forbidden, start.contains(forbidden))
  }

  private fun assertExactRequestRestoration(text: String) {
    val restore = body(text, "restoreAttachmentInteraction")
    assertTrue(restore.contains("attachmentInteractionSession != sessionId"))
    val exact = Regex("""(?:requestId != attachmentInteractionRequestId|attachmentInteractionRequestId != requestId)""")
    assertTrue("membership in all known sid requests is not the current picker identity", exact.containsMatchIn(restore))
    assertTrue(restore.indexOf("windows.restoreInteraction(lease)") < restore.indexOf("attachmentInteraction = null"))
    assertTrue("false restoration must preserve the original lease for bounded recovery", restore.contains("if (!windows.restoreInteraction(lease))"))
  }

  @Test fun onlyTheExactPickerRequestMayRestoreItsLeaseAndRestoreFailureKeepsRecoveryState() {
    val text = source("OverlayV2.kt")
    assertExactRequestRestoration(text)
    val start = body(text, "startAttachment")
    assertTrue("exact id must be registered before Activity launch, including synchronous failures", start.contains("requestId"))
    val launch = start.indexOf("OverlayAttachProxyActivity.start(")
    assertTrue(launch > start.indexOf("prepareAttachmentUi("))
    assertTrue(start.substring(launch).substringBefore("\n").contains("requestId"))
    assertTrue("registration must precede synchronous launch-error delivery",
      start.indexOf(".add(requestId)") in 0 until launch)
    assertTrue("failed yield may not launch the Activity", start.contains("if (!prepareAttachmentUi(sid, mapped, requestId)) return"))
    val restore = body(text, "restoreAttachmentInteraction")
    assertTrue("recovery is finite, not an indefinite refresh timer", restore.contains("attachmentRestoreAttempts++ <"))
    assertTrue("destroyed owners cannot run delayed retries", restore.contains("if (!destroyed) restoreAttachmentInteraction("))
    assertTrue(text.contains("OverlayAttachmentBus.pickerReturnedHandler = { sid, requestId -> restoreAttachmentInteraction(sid, requestId) }"))
  }

  @Test fun controlledNegativeRejectsMembershipOnlyRestoreAndPrematureLeaseDiscard() {
    val text = source("OverlayV2.kt")
    assertExactRequestRestoration(text)
    for ((old, replacement) in listOf(
      "attachmentInteractionRequestId != requestId" to "requestId !in attachmentRequestIds[sessionId].orEmpty()",
      "    if (!windows.restoreInteraction(lease))" to "    attachmentInteraction = null\n    if (!windows.restoreInteraction(lease))",
    )) {
      val mutated = text.replace(old, replacement)
      assertNotEquals("negative must alter the real restoration contract", text, mutated)
      var rejected = false
      try { assertExactRequestRestoration(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("old receipt must not release a newer picker or discard retry state", rejected)
    }
  }

  private fun assertPickerWaitsForStablePresentation(text: String) {
    val prepare = body(text, "prepareAttachmentUi")
    val yieldAt = prepare.indexOf("windows.yieldInteraction()")
    assertTrue("must inspect the real picker lease admission", yieldAt >= 0)
    val admission = prepare.substring(0, yieldAt)
    val condition = admission.lineSequence().firstOrNull { it.contains("if (") && it.contains("cardHandleDragging") }
      ?: error("missing unstable-presentation picker guard")
    for (required in listOf("cardHandleDragging", "morphAnimator?.isRunning == true", "drawerClosing", "composerClosing"))
      assertTrue("any active transition must block picker before flags are leased: " + required, condition.contains(required))
    assertEquals("each transition independently blocks, not an AND of all four", 3,
      Regex(Regex.escape("||")).findAll(condition).count())
    assertFalse(condition.contains("&&"))
    val guard = admission.substringAfter(condition).substringBefore("}")
    assertTrue("busy presentation needs a visible retry explanation", guard.contains("toast(t("))
    assertTrue("unstable presentation cannot fall through into yield", guard.contains("return false"))
    for (forbidden in listOf("cancelCardInteraction(", "finishAnimations(", "morphAnimator?.end(",
      "morphAnimator?.cancel(", "hideCard(", "hidePill(", "hideComposer(", "hideDrawer(", "windows.remove(",
      "setInputText(", "restoreDraftSnapshot(", "cardHandleDragging =", "drawerClosing =", "composerClosing ="))
      assertFalse("picker must defer, not terminate the user's in-flight presentation: " + forbidden, admission.contains(forbidden))
    val start = body(text, "startAttachment")
    assertTrue("rejected admission must not launch a system picker",
      start.contains("if (!prepareAttachmentUi(sid, mapped, requestId)) return"))
  }

  @Test fun pickerAdmissionWaitsForEveryInFlightTransitionWithoutEndingOrHidingThePresentation() {
    assertPickerWaitsForStablePresentation(source("OverlayV2.kt"))
  }

  @Test fun controlledNegativesRejectMissingTransitionGuardAndForcedFinishingBeforePicker() {
    val text = source("OverlayV2.kt")
    assertPickerWaitsForStablePresentation(text)
    val prepare = body(text, "prepareAttachmentUi")
    val condition = prepare.lineSequence().first { it.contains("if (") && it.contains("cardHandleDragging") }
    val mutants = ArrayList<String>()
    for ((old, replacement) in listOf(
      "cardHandleDragging || " to "",
      "morphAnimator?.isRunning == true || " to "",
      "drawerClosing || " to "",
      " || composerClosing" to "",
    )) mutants.add(text.replace(condition, condition.replace(old, replacement)))
    val guard = prepare.substringAfter(condition).substringBefore("}")
    mutants.add(text.replace(guard, guard.replace("return false", "Unit")))
    mutants.add(text.replace(condition, condition + "\n      cancelCardInteraction()"))
    mutants.add(text.replace(condition, condition + "\n      hideComposer()"))
    for (mutated in mutants) {
      assertNotEquals("controlled mutation must change the real picker admission", text, mutated)
      var rejected = false
      try { assertPickerWaitsForStablePresentation(mutated) }
      catch (_: AssertionError) { rejected = true }
      catch (_: IllegalStateException) { rejected = true }
      assertTrue("picker cannot lease moving/detaching windows or forcibly end them", rejected)
    }
  }

  @Test fun settingReapplicationCannotReplaceEntryDuringPickerOrAfterTheSameStyleGesture() {
    val style = body(source("OverlayV2.kt"), "onEntryStyleChanged")
    assertTrue(style.contains("attachmentInteraction != null"))
    assertTrue(style.contains("if (style == next) return"))
    assertTrue(style.indexOf("if (style == next) return") < style.indexOf("removeEntryWindow()"))
    assertTrue(style.indexOf("attachmentInteraction != null") < style.indexOf("removeEntryWindow()"))
  }

  @Test fun systemPickerAndCameraYieldAndRestoreTheSameWindowsWithoutDraftWrites() {
    assertSameWindowPickerContract(source("OverlayV2.kt"))
  }

  @Test fun controlledNegativesRejectTheOldHideRebuildAndSelectionResetStrategies() {
    val text = source("OverlayV2.kt")
    val marker = body(text, "prepareAttachmentUi").lineSequence().first { it.contains("windows.yieldInteraction()") }
    assertTrue(text.contains(marker))
    for (bad in listOf("hideCard()", "hideComposer()", "hideDrawer(false)", "recreateViewsPreservingState()",
      "composer?.setInputText(\"\")", "restoreDraftSnapshot(exportDraftSnapshot())")) {
      val mutated = text.replace(marker, bad + "\n    " + marker)
      assertNotEquals(text, mutated)
      var rejected = false
      try { assertSameWindowPickerContract(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("negative control must reject " + bad, rejected)
    }
  }
}
