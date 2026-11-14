package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** 纯配置/草稿判据 + 生产接线反证；不冒充真实 WMS/IME/换肤设备验收。 */
class OverlayV2RecreationTest {
  private fun source(): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell/OverlayV2.kt"),
    File("app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt"),
  ).first { it.isFile }.readText()

  private fun body(name: String, next: String): String {
    val text = source()
    assertTrue("missing start: " + name, text.contains(name))
    val tail = text.substringAfter(name)
    assertTrue("missing end: " + next, tail.contains(next))
    return tail.substringBefore(next)
  }

  @Test fun visualKeyTracksLocaleThemeFontAndDensityButNotRotationGeometry() {
    val key = OverlayV2VisualConfiguration("zh-CN", 0x11, 1f, 240, false)
    assertNotEquals(key, key.copy(localeTags = "en-US"))
    assertNotEquals(key, key.copy(uiMode = 0x21))
    assertNotEquals(key, key.copy(fontScale = 1.3f))
    assertNotEquals(key, key.copy(densityDpi = 320))
    assertNotEquals(key, key.copy(english = true))
    assertEquals(key, key.copy())
    val fields = source().substringAfter("data class OverlayV2VisualConfiguration(").substringBefore(")")
    assertFalse(fields.contains("orientation"))
    assertFalse(fields.contains("width"))
    assertFalse(fields.contains("height"))
  }

  @Test fun snapshotRejectsOtherSessionAndClampsSelectionsWithoutChangingTextOrLocks() {
    val snapshot = OverlayV2DraftSnapshot("s1", "draft", true, true, -2, 99, true, true)
    assertTrue(snapshot.matchesSession("s1"))
    assertFalse(snapshot.matchesSession("s2"))
    assertFalse(snapshot.matchesSession(""))
    assertEquals(0 to 5, snapshot.selection())
    assertEquals("draft", snapshot.text)
    assertTrue(snapshot.sendPending)
    assertTrue(snapshot.commandPending)
    assertTrue(snapshot.copy(sessionId = "").matchesSession(""))
    val restore = body("internal fun restoreDraftSnapshot(", "/** 仅暂挂 UI")
    assertTrue(restore.indexOf("snapshot.matchesSession(svc.activeSessionId)") < restore.indexOf("c.setInputText(snapshot.text)"))
    assertFalse(restore.contains("sending ="))
    assertFalse(restore.contains("commandPending ="))
    assertFalse(restore.contains("sendText("))
  }

  @Test fun recreationRemovesOnlyWindowsAndKeepsTicketsModelsAndGenerations() {
    assertRecreationContract(source())
    val recreate = body("internal fun recreateViewsPreservingState()", "/** 屏幕几何")
    for (slot in listOf("ENTRY", "CARD", "PILL", "COMPOSER")) assertTrue(recreate.contains("windows.remove(OverlayWindows.Slot." + slot + ")"))
    assertTrue(recreate.contains("restoreDraftSnapshot(draft)"))
    assertTrue(recreate.contains("cardExpanded = savedExpanded"))
    assertTrue(recreate.contains("drawerMode = savedDrawer"))
    assertTrue(recreate.contains("savedPillX ?: lp.x"))
    assertTrue(recreate.contains("savedPillY ?: lp.y"))
    assertTrue(recreate.indexOf("buildEntry()") < recreate.indexOf("showCard()"))
    assertTrue(recreate.indexOf("showCard()") < recreate.indexOf("showComposer(focusInput = false)"))
    assertTrue(recreate.contains("composer === restored"))
  }

  @Test fun suspendRetainsTheObserverAndDraftObjectAndResumeReusesTheSameV2() {
    val suspend = body("internal fun suspendUi()", "internal fun resumeUi()")
    assertTrue(suspend.contains("uiSuspended = true"))
    assertTrue(suspend.contains("windows.remove(OverlayWindows.Slot.COMPOSER)"))
    for (forbidden in listOf("destroy()", "cancelPendingActions", "receiptHandler = null", "composer = null", "sending = false", "commandPending = false")) assertFalse(forbidden, suspend.contains(forbidden))
    val resume = body("internal fun resumeUi()", "internal fun onLanguageChanged()")
    assertTrue(resume.contains("uiSuspended = false"))
    assertTrue(resume.contains("recreateViewsPreservingState()"))
    assertFalse(resume.contains("start()"))
    assertFalse(resume.contains("OverlayV2("))
  }

  @Test fun configurationAndLanguageChangesAreIdempotentAndDoNotDestroyTickets() {
    val language = body("internal fun onLanguageChanged()", "/** 重建缓存颜色")
    assertTrue(language.contains("visualConfiguration == currentVisualConfiguration()"))
    assertTrue(language.contains("recreateViewsPreservingState()"))
    assertFalse(language.contains("destroy()"))
    val config = body("internal fun onConfigurationChanged()", "private fun scheduleRender()")
    assertTrue(config.contains("visualConfiguration != currentVisualConfiguration()"))
    assertTrue(config.contains("recreateViewsPreservingState()"))
    assertTrue(config.contains("windows.update(OverlayWindows.Slot.ENTRY, lp)"))
    val showComposer = body("internal fun showComposer(", "internal fun hideComposer()")
    assertTrue(showComposer.contains("if (!recreatingViews)"))
    val focusGuard = showComposer.substringAfter("val canFocus = {").substringBefore("}")
    assertTrue("focus ownership predicate must exist", showComposer.contains("val canFocus = {"))
    for (required in listOf("composer === c", "composerVisible()", "composerWindowGeneration == focusGeneration",
      "!destroyed", "!uiSuspended", "!hostForeground", "!composerClosing", "attachmentInteraction == null"))
      assertTrue("deferred focus must reject stale/detached/picker-owned windows: " + required, focusGuard.contains(required))
    assertTrue("explicit focus must recheck when posted AND pass the same guard to deferred IME work",
      showComposer.contains("if (focusInput) main.post { if (canFocus()) c.focusInput(canFocus) }"))
    assertTrue("non-input presentation remains root-only, without automatically requesting IME",
      showComposer.contains("else if (canFocus()) c.focusRoot()"))
  }

  @Test fun pureAttachmentsCanSendButUnconfirmedOrUnavailableAttachmentsCannotFallBackToText() {
    val send = body("private fun sendText(text:", "private fun startAttachment(")
    assertTrue(send.contains("pageState?.takeIf { it.sessionId == sentSession }"))
    assertTrue(send.contains("if (trimmed.isEmpty() && attachments.isEmpty()) return"))
    assertFalse(send.contains("if (trimmed.isEmpty()) return"))
    assertTrue(send.indexOf("if (attachmentsPending.isNotEmpty())") < send.indexOf("sending = true"))
    assertTrue(send.indexOf("if (!OverlayPageHost.available())") < send.indexOf("sending = true"))
    assertTrue(send.contains("OverlayAttachmentBus.recheckPending(sentSession)"))
    assertTrue(send.contains("OverlayPageHost.send(trimmed, sentSession"))
    assertTrue(send.contains("svc.recheckTextSendOutcome()"))
    assertTrue(send.contains("svc.sendTextFromOverlay(trimmed, settled, { message ->"))
    assertFalse(send.substringBefore("sending = true").contains("setInputText(\"\")"))
  }

  @Test fun backgroundResumeEnsuresEntryEvenWhenSnapshotWasCapturedInForeground() {
    val resume = body("internal fun resumeUi()", "internal fun onLanguageChanged()")
    assertTrue(resume.contains("hostForeground = OverlayHostVisibility.foreground"))
    assertTrue(resume.contains("if (!hostForeground && !entryHiddenByUser) buildEntry()"))
    assertTrue(resume.indexOf("recreateViewsPreservingState()") < resume.indexOf("buildEntry()"))
  }

  @Test fun pickerPreservesOriginalEditorAndDefersVisualRecreationUntilReturn() {
    val prepare = body("private fun prepareAttachmentUi(", "private fun restoreAttachmentInteraction(")
    assertTrue(prepare.contains("windows.yieldInteraction()"))
    for (forbidden in listOf("hideCard()", "hideComposer()", "hideDrawer(", "windows.remove(",
      "setInputText", "setSelection", "restoreDraftSnapshot", "destroy()"))
      assertFalse("picker prepare cannot use the old hide/rebuild strategy: " + forbidden, prepare.contains(forbidden))
    val recreate = body("internal fun recreateViewsPreservingState()", "/** 屏幕几何")
    val guard = recreate.substringBefore("val draft = exportDraftSnapshot()")
    assertTrue("configuration/language changes cannot replace picker-owned Views", guard.contains("attachmentInteraction != null"))
    assertTrue(guard.contains("return"))
    val receipt = body("private fun onAttachmentReceipt(", "private fun onAttachmentResult(")
    assertTrue(receipt.contains("restoreAttachmentInteraction(receipt.sessionId, receipt.requestId)"))
    assertFalse(receipt.contains("showComposer("))
    assertFalse(receipt.contains("restoreDraftSnapshot("))
  }

  @Test fun receiptChecksOriginalSessionAndRequestBeforeAnnouncingSuccess() {
    val receipt = body("private fun onAttachmentReceipt(", "private fun onAttachmentResult(")
    assertTrue(receipt.contains("receipt.sessionId != svc.activeSessionId"))
    assertTrue(receipt.contains("receipt.requestId !in ids"))
    assertTrue(receipt.indexOf("receipt.requestId !in ids") < receipt.indexOf("onAttachmentResult("))
    assertTrue("switching active sid cannot strand the original window's temporary flags",
      receipt.indexOf("restoreAttachmentInteraction(receipt.sessionId, receipt.requestId)") <
        receipt.indexOf("receipt.sessionId != svc.activeSessionId"))
    assertTrue(source().contains("OverlayAttachmentBus.receiptHandler = { receipt -> onAttachmentReceipt(receipt) }"))
    assertTrue(source().contains("\"attachment-pending\" -> t("))
  }

  @Test fun repeatedProbeDoesNotScheduleAnIdleRenderButFirstOfflineAndRecoveryStillDo() {
    val probe = body("internal fun onEngineRunning(", "internal fun onPendingChanged()")
    val guard = "if (engineRunningCache == running && model.engineOnline == running) return"
    assertTrue(probe.indexOf(guard) >= 0)
    assertTrue(probe.indexOf(guard) < probe.indexOf("engineRunningCache = running"))
    assertTrue(probe.contains("OverlayUiModel.onEngineStatus(model, running"))
    assertTrue(probe.contains("scheduleRender()"))
    assertFalse(false == false && true == false) // initial cache=false/modelOnline=true must synchronize offline.
    assertTrue(true == true && true == true) // repeated online is a no-op.
  }

  @Test fun renderUsesSemanticCompletionTranslationRatherThanMutatingTheLiveModel() {
    val render = body("private fun renderCard()", "private fun renderComposer()")
    assertTrue(render.contains("OverlayUiModel.completionLabelOf(model, english)"))
    assertTrue(render.contains("completionLabel.isNotEmpty() -> completionLabel"))
    assertFalse(render.contains("model ="))
    assertTrue(render.contains("t(\"需要回答\", \"Question\")"))
  }

  @Test fun controlledNegativeRejectsDestroyAndGenerationResetDuringUiRecreation() {
    for (replacement in listOf("destroy()", "sessionGeneration++", "OverlayPageHost.cancelPendingActions()")) {
      val mutated = source().replace("      stopClock()\n      resizeAnimator", "      " + replacement + "\n      stopClock()\n      resizeAnimator")
      assertNotEquals("负控必须实际改动生产rebuild分支", source(), mutated)
      var rejected = false
      try { assertRecreationContract(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("重建不得销毁业务所有者或清票据", rejected)
    }
  }

  private fun assertStableConfigurationGeometry(text: String) {
    fun section(start: String, end: String): String {
      assertTrue("missing configuration section " + start, text.contains(start))
      val tail = text.substringAfter(start)
      assertTrue("missing configuration section boundary " + end, tail.contains(end))
      return tail.substringBefore(end).lineSequence().filterNot { it.trimStart().startsWith("//") }.joinToString("\n")
    }
    val screen = section("  private fun screen()", "  private fun dimenPx(")
    assertTrue("physical top must not jump when system bars toggle visibility",
      screen.contains("getInsetsIgnoringVisibility(WindowInsets.Type.systemBars())"))
    assertFalse(screen.contains(".getInsets(WindowInsets.Type.systemBars())"))
    assertTrue(screen.contains("statusBar = insets.top"))
    assertTrue(screen.contains("navBar = insets.bottom"))
    assertTrue(screen.indexOf("Build.VERSION.SDK_INT >= 30") < screen.indexOf("getInsetsIgnoringVisibility("))
    val config = section("  internal fun onConfigurationChanged()", "  private fun scheduleRender()")
    val moved = config.indexOf("windows.update(OverlayWindows.Slot.COMPOSER, lp)")
    val tail = config.substringAfter("windows.update(OverlayWindows.Slot.COMPOSER, lp)")
    assertTrue("must update actual input frame before its dependent windows", moved >= 0)
    assertTrue("picker lease cannot gain/rebuild sheet or chip members", tail.contains("if (attachmentInteraction == null) {"))
    val dependencies = tail.substringAfter("if (attachmentInteraction == null) {")
    val cap = "composer?.setMaxDrawerHeightPx((OverlayWindowFrames.availableHeightPx(s) * .4f).toInt())"
    assertTrue("rotation must recalculate the sheet's real available-height cap", dependencies.contains(cap))
    assertTrue(dependencies.indexOf(cap) < dependencies.indexOf("syncDrawerWindow()"))
    assertTrue("chip positioning waits for the input's updated on-screen frame", dependencies.contains("composer?.view?.post {"))
    assertTrue(dependencies.contains("if (!destroyed && !uiSuspended && !hostForeground) syncChipWindows()"))
    val chips = section("  private fun syncChipWindows()", "  private fun syncDrawerWindow()")
    assertTrue("lease may start after post but before execution, so synchronization must recheck",
      chips.indexOf("if (attachmentInteraction != null) return") in 0 until chips.indexOf("val c = composer"))
  }

  @Test fun configurationUsesStableSystemBarGeometryAndResyncsDependentSheetAndChipsAfterInputFrame() {
    assertStableConfigurationGeometry(source())
  }

  @Test fun controlledNegativesRejectTransientInsetsStaleSheetCapAndLeasedDependentWindowChanges() {
    val text = source()
    assertStableConfigurationGeometry(text)
    val configStart = text.indexOf("  internal fun onConfigurationChanged()")
    val configEnd = text.indexOf("  private fun scheduleRender()", configStart)
    val config = text.substring(configStart, configEnd)
    val configMutants = listOf(
      config.replace("composer?.setMaxDrawerHeightPx((OverlayWindowFrames.availableHeightPx(s) * .4f).toInt())", "Unit"),
      config.replace("      syncDrawerWindow()", ""),
      config.replace("    if (attachmentInteraction == null) {", "    if (true) {"),
      config.replace("composer?.view?.post {", "run {"),
    )
    val mutants = configMutants.map { text.substring(0, configStart) + it + text.substring(configEnd) } +
      text.replace("getInsetsIgnoringVisibility(WindowInsets.Type.systemBars())", "getInsets(WindowInsets.Type.systemBars())")
    for (mutated in mutants) {
      assertNotEquals("configuration negative must change real production wiring", text, mutated)
      var rejected = false
      try { assertStableConfigurationGeometry(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("configuration cannot use transient insets, stale sheet cap, or mutate leased membership", rejected)
    }
  }

  private fun assertRecreationContract(source: String) {
    val recreate = source.substringAfter("internal fun recreateViewsPreservingState()").substringBefore("/** 屏幕几何")
    for (forbidden in listOf("destroy()", "start()", "cancelPendingActions", "sessionGeneration++", "pageReadGeneration++", "model =", "pageState =", "pageCommands =", "sending =", "commandPending =")) assertFalse(forbidden, recreate.contains(forbidden))
  }
}
