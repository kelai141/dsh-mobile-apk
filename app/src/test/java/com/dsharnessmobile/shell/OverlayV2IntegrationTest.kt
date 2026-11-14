package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** 编排接线反证：并非Android运行验收，JVM只验证生产连接不再断路。 */
class OverlayV2IntegrationTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test fun liveSinkIsBoundBeforeWatcherAndReleasedAtTeardown() {
    val service = source("OverlayService.kt")
    assertTrue(service.contains("liveSink = overlay::onLiveEvent"))
    assertTrue(service.indexOf("switchOverlayUi()\n    live.startWatcher()") >= 0)
    val teardown = service.substringAfter("override fun onDestroy() {").substringBefore("private fun buildRoot")
    assertTrue(teardown.contains("live.stopWatcher()"))
    assertTrue(teardown.contains("displayPrefs.unregisterOnSharedPreferenceChangeListener(displayListener)"))
    assertTrue(teardown.contains("languagePrefs.unregisterOnSharedPreferenceChangeListener(languageListener)"))
    assertTrue(teardown.contains("liveSink = null"))
    assertTrue(teardown.contains("cachedV2?.destroy()"))
    assertTrue(source("OverlayLiveFeed.kt").contains("svc.liveSink?.invoke(liveEventOf(j))"))
  }
  @Test fun statusFilterRunsBeforeAdoptingEventAgent() {
    val service = source("OverlayService.kt").substringAfter("internal fun applyAgentStatus(")
    assertTrue(service.indexOf("val targeted = matchesTargetAgent(agentId)") < service.indexOf("currentAgentId = agentId"))
    assertTrue(service.indexOf("if (!targeted) return") < service.indexOf("cachedV2?.onAgentStatus(agentId, running)"))
  }
  @Test fun realUiPreferencesDoNotStopDataChannels() {
    val body = source("OverlayService.kt").substringAfter("private fun switchOverlayUi() {").substringBefore("// ── 协作类")
    assertFalse(body.contains("v2?.destroy()"))
    assertFalse(body.contains("cancelPendingActions"))
    assertTrue(body.contains("v2?.suspendUi()"))
    assertTrue(body.contains("overlay.resumeUi()"))
    assertTrue(body.contains("liveSink = overlay::onLiveEvent"))
    assertTrue(body.contains("buildRoot()"))
    assertFalse(body.contains("stopSelf"))
    assertFalse(body.contains("stopWatcher"))
    assertFalse(body.contains("panel.destroy"))
    assertTrue(source("OverlayService.kt").contains("v2?.onEntryStyleChanged()"))
  }
  @Test fun capsuleCanReachToleranceAndFadeInOneContinuousSlowDrag() {
    // Deliberate fixture values, not claims that provisional device thresholds are confirmed.
    val policy = OverlayMotion(OverlayMotionConfig(120f, 20f, 60f, 16f, 24f, 4f))
    val top = 48f
    val start = 360f
    val justArrived = policy.topDrag(start, top - start, top)
    assertEquals(top, justArrived.topPx, 0f)
    assertEquals(1f, justArrived.alpha, 0f)
    assertFalse(policy.topRelease(justArrived).hide)
    val tolerant = policy.topDrag(start, top - start - 20f, top)
    assertEquals(1f, tolerant.alpha, 0f)
    assertFalse(policy.topRelease(tolerant).hide)
    val fading = policy.topDrag(start, top - start - 50f, top)
    assertEquals(.5f, fading.alpha, .0001f)
    assertFalse(policy.topRelease(fading).hide)
    assertEquals(1f, policy.topRelease(fading).frame.alpha, 0f)
    val enough = policy.topDrag(start, top - start - 80f, top)
    assertTrue(policy.topRelease(enough).hide)
    assertFalse(policy.topRelease(enough, cancelled = true).hide)
    assertEquals(1f, policy.topRelease(enough, cancelled = true).frame.alpha, 0f)
  }

  @Test fun capsuleWiringUsesDistancePolicyAndExplicitDismissClosesBottomWithoutStoppingAgent() {
    val v2 = source("OverlayV2.kt")
    val drag = v2.substringAfter("private fun handlePillDrag(").substringBefore("private var pillDownX")
    assertTrue(drag.contains("policy.topDrag("))
    assertTrue(drag.contains("policy.topRelease("))
    assertTrue(drag.contains("p.view.alpha = frame.alpha"))
    assertTrue(drag.contains("if (release.hide) dismissPill()"))
    assertFalse("no old velocity/new-DOWN gate", drag.contains("pillDismissReached("))
    val dismiss = v2.substringAfter("private fun dismissPill()").substringBefore("private fun renderPill()")
    assertTrue(dismiss.contains("hideComposer()"))
    for (forbidden in listOf("requestStop(", "stopSelf(", "session/cancel", "setInputText(", "destroy()"))
      assertFalse(forbidden, dismiss.contains(forbidden))
    val bottom = v2.substringAfter("internal fun hideComposer()").substringBefore("private fun syncDrawerWindow()")
    assertTrue(bottom.contains("hideDrawer(false)"))
    assertTrue(bottom.contains("hideSoftInputFromWindow"))
  }

  @Test fun entryTapDoesNotReopenCardClosedByTheSameOutsideTouch() {
    assertFalse(overlayEntryTapShouldOpen(true, false))
    assertFalse(overlayEntryTapShouldOpen(false, true))
    assertTrue(overlayEntryTapShouldOpen(false, false))
    val v2 = source("OverlayV2.kt")
    assertTrue(v2.contains("outsideClosedCardDownTime == ev.downTime"))
    val card = v2.substringAfter("internal fun showCard()").substringBefore("internal fun hideCard()")
    assertFalse("outside不再属于顶部输出", card.contains("MotionEvent.ACTION_OUTSIDE"))
    assertTrue(v2.contains("onEntryTap(openCardOnTap)"))
  }

  @Test fun everyScreenHonorsStrictRatios() {
    for (h in listOf(300, 600, 900, 1600, 2800)) for (d in listOf(1f, 1.5f, 2.75f, 3.5f)) {
      val screen = OverlayScreen(900, h, 24, 48, d)
      val available = OverlayWindowFrames.availableHeightPx(screen)
      assertTrue(OverlayWindowFrames.cardHeightPx(100000, screen, false) <= (available * .32f).toInt())
      assertTrue(OverlayWindowFrames.cardHeightPx(100000, screen, true) <= (available * .4f).toInt())
    }
  }
  @Test fun approvalCannotBypassReasonAndTwoStepGuard() {
    val body = source("OverlayV2.kt").substringAfter("private fun onPendingAction(").substringBefore("private fun startClockIfNeeded")
    assertTrue(body.contains("selectPending(eventId)"))
    assertTrue(body.contains("showPendingPanelFromOverlay()"))
    assertFalse(body.contains("respondApprovalFromUi"))
    assertFalse(body.contains("respondApproval("))
  }
  @Test fun liveBeforeStatusAndReconnectPreserveCurrentTurn() {
    var m = OverlayUiModel.onRuntimeStatus(OverlayCardModel(), true, 10)
    m = OverlayUiModel.onToolCall(m, "a", "read", "one", 20)
    m = OverlayUiModel.onRuntimeStatus(m, true, 30)
    assertEquals(1, m.toolRows.size)
    m = OverlayUiModel.onEngineStatus(m, false, 40)
    assertEquals("Engine offline", OverlayUiModel.pillOf(m, true).text)
    m = OverlayUiModel.onEngineStatus(m, true, 50)
    assertEquals(1, m.toolRows.size)
    assertTrue(m.turnActive)
  }
  @Test fun lateSendCannotBlindlyClearNewInput() {
    val body = source("OverlayV2.kt").substringAfter("private fun sendText(").substringBefore("private fun startAttachment")
    assertTrue(body.contains("sessionGeneration == admittedGeneration"))
    assertTrue(body.contains("svc.activeSessionId == admittedSession"))
    assertTrue(body.contains("composer?.inputText() == sentDraft"))
    assertTrue(body.contains("svc.sendTextFromOverlay(trimmed, settled, { message ->"))
    val service = source("OverlayService.kt").substringAfter("internal fun sendTextFromOverlay(").substringBefore("private fun restoreAfterFailure")
    assertTrue(service.contains("var targetSessionId = initialTarget"))
    assertTrue(service.contains("targetSessionId = sid"))
    assertTrue(service.contains("if (activeSessionId == initialTarget)"))
  }
  @Test fun bottomQuestionAnswerUsesExactEventAndPreservesTheMessageDraft() {
    val v2 = source("OverlayV2.kt")
    val send = v2.substringAfter("private fun sendText(").substringBefore("private var attachmentInteraction:")
    assertTrue(send.indexOf("if (questionTarget != null)") < send.indexOf("svc.sendTextFromOverlay"))
    val answer = v2.substringAfter("private fun sendQuestionAnswer(").substringBefore("private fun sendText(")
    assertTrue(answer.contains("svc.panel.questionTextAnswer(target.eventId, target.questionId"))
    assertTrue(answer.contains("svc.activeSessionId != sid || questionTarget != target"))
    assertTrue(answer.contains("composer?.inputText() == sentDraft"))
    val pending = v2.substringAfter("private fun onPendingAction(").substringBefore("private fun startClockIfNeeded")
    assertTrue(pending.indexOf("if (kind == \"question\")") < pending.indexOf("svc.showPendingPanelFromOverlay()"))
    assertTrue(pending.contains("messageDraftBeforeAnswer = exportDraftSnapshot()"))
    assertTrue(pending.contains("showComposer(true)"))
    assertTrue(v2.contains("leaveQuestionAnswer(false)"))
  }

  @Test fun nativePreviewAcceptsOnlySmallJpegProjectionAndActualViewCanExpand() {
    assertEquals("", overlayThumbnailData("https://example.com/image.png"))
    assertEquals("", overlayThumbnailData("data:image/svg+xml;base64,AAAA"))
    assertEquals("", overlayThumbnailData("data:image/jpeg;base64," + "A".repeat(50000)))
    assertEquals("data:image/jpeg;base64,AAAA", overlayThumbnailData("data:image/jpeg;base64,AAAA"))
    val composer = source("OverlayComposer.kt")
    assertTrue(composer.contains("bounds.outWidth !in 1..256 || bounds.outHeight !in 1..256"))
    assertTrue(composer.contains("setImageBitmap(bitmap)"))
    assertTrue(composer.contains("dp(if (expanded) 160 else 40)"))
  }

  @Test fun currentWorkspaceLabelUsesTheCurrentSessionNotTheCreationOverride() {
    val render = source("OverlayV2.kt").substringAfter("val workspaceLabel = when").substringBefore("val sessionLabel")
    assertTrue(render.contains("state.sessionId == svc.activeSessionId"))
    assertFalse(render.contains("targetWorkspaceIdOverride"))
  }

  @Test fun visibleStateInvalidationIsEventDrivenAndStopsOnHide() {
    val v2 = source("OverlayV2.kt")
    assertTrue(v2.substringAfter("internal fun hideComposer()").substringBefore("private fun syncDrawerWindow").contains("updatePageWatching()"))
    val watching = v2.substringAfter("private fun observingPage() =").substringBefore("\n")
    for (surface in listOf("cardVisible()", "composerVisible()", "pillVisible()"))
      assertTrue("a visible output/input surface needs real event-driven state: " + surface, watching.contains(surface))
    assertTrue(v2.contains("if (destroyed || uiSuspended || !observingPage() || pageStateRefreshQueued) return"))
    val main = source("MainActivity.kt")
    assertTrue(main.contains("isEngineSource(trustedTopFrameUrl) && isEngineSource(message.sourceId())"))
    assertTrue(main.contains("onPageStateInvalidated()"))
  }

  private fun pageRefreshBody(v2: String): String {
    val start = "  private fun refreshPageState() {"
    val end = "  private fun readWorkspaceJson()"
    assertTrue("missing real refresh function", v2.contains(start))
    val tail = v2.substringAfter(start)
    assertTrue("missing refresh boundary", tail.contains(end))
    return tail.substringBefore(end).lineSequence().filterNot { it.trimStart().startsWith("//") }.joinToString("\n")
  }

  private fun assertPillRerenderAfterPageRefresh(v2: String) {
    val refresh = pageRefreshBody(v2)
    val asyncMarker = "    OverlayPageHost.state { s ->"
    assertTrue("must inspect the async callback, not an unrelated render path", refresh.contains(asyncMarker))
    val fallback = refresh.substringBefore(asyncMarker)
    val callback = refresh.substringAfter(asyncMarker)
    val pillRender = "if (pillVisible()) renderPill()"
    assertTrue("page unavailable must rerender the visible capsule rather than retain stale transcript output",
      fallback.contains(pillRender))
    assertTrue(fallback.indexOf("pageState = OverlayPageHost.PageState(") in 0 until fallback.indexOf(pillRender))
    assertTrue("subscription alone cannot render newly arrived transcript when only capsule is visible",
      callback.contains(pillRender))
    val renderAt = callback.indexOf(pillRender)
    for (settled in listOf("if (destroyed || generation != pageReadGeneration) return@state", "pageState = s", "pageState = null"))
      assertTrue("capsule must render only after the current callback settles " + settled,
        callback.indexOf(settled) in 0 until renderAt)
    assertFalse("capsule refresh cannot depend on composer/card visibility",
      callback.substringBefore(pillRender).contains("if (cardVisible()) {"))
  }

  @Test fun pageStateRefreshRendersVisibleCapsuleAfterBothFallbackAndAsyncTranscriptSettlement() {
    assertPillRerenderAfterPageRefresh(source("OverlayV2.kt"))
  }

  @Test fun controlledNegativeRejectsMissingCapsuleRenderInEitherPageRefreshPath() {
    val text = source("OverlayV2.kt")
    assertPillRerenderAfterPageRefresh(text)
    val refresh = pageRefreshBody(text)
    val marker = "if (pillVisible()) renderPill()"
    val positions = Regex(Regex.escape(marker)).findAll(refresh).map { it.range.first }.toList()
    assertEquals("separately guard fallback and async callback", 2, positions.size)
    for (position in positions) {
      val mutatedRefresh = refresh.removeRange(position, position + marker.length)
      val start = "  private fun refreshPageState() {"
      val end = "  private fun readWorkspaceJson()"
      val before = text.substringBefore(start) + start
      val after = end + text.substringAfter(end)
      val mutated = before + mutatedRefresh + after
      assertNotEquals(text, mutated)
      var rejected = false
      try { assertPillRerenderAfterPageRefresh(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("removing only one refresh callback must fail", rejected)
    }
  }

  private fun assertMorphLifecycleOwnership(v2: String) {
    fun section(start: String, end: String): String {
      assertTrue("missing morph contract section " + start, v2.contains(start))
      val tail = v2.substringAfter(start)
      assertTrue("missing morph section boundary " + end, tail.contains(end))
      return tail.substringBefore(end).lineSequence().filterNot { it.trimStart().startsWith("//") }.joinToString("\n")
    }
    val suspend = section("  internal fun suspendUi()", "  internal fun resumeUi()")
    val recreate = section("  internal fun recreateViewsPreservingState()", "  private fun screen()")
    for ((label, method) in listOf("suspend" to suspend, "recreate" to recreate)) {
      val cancel = method.indexOf("cancelCardInteraction()")
      val detach = method.indexOf("windows.remove(")
      assertTrue(label + " must invalidate the old morph before the first window detaches", cancel in 0 until detach)
    }
    val cancel = section("  private fun cancelCardInteraction()", "  private fun resetCardHandleVisual(")
    assertTrue("Animator.cancel may synchronously dispatch onAnimationEnd; invalidate generation FIRST",
      cancel.indexOf("morphGeneration++") in 0 until cancel.indexOf("morphAnimator?.cancel()"))
    for (required in listOf("morphAnimator = null", "main.removeCallbacks(it)", "handleHoldFeedback = null",
      "cardHandleIntent.cancel()", "cardHandleDragging = false", "morphProgress = 0f", "card?.resetMorph()"))
      assertTrue("cancel must clean all old pointer/animation state: " + required, cancel.contains(required))
    val settle = section("  private fun settleCardMorph(", "  private val cardHandleIntent")
    assertTrue("capture the owning card before callbacks can observe replacement Views", settle.contains("val owner = card ?: return"))
    val finish = settle.substringAfter("val finish = {").substringBefore("if (!DSUiAnimationsEnabled()")
    val guard = finish.substringBefore("applyCardMorph(target)")
    for (required in listOf("generation == morphGeneration", "card === owner", "!destroyed", "!uiSuspended", "!recreatingViews", "cardVisible()"))
      assertTrue("old settle cannot collapse a replacement card: " + required, guard.contains(required))
    assertTrue(finish.contains("if (collapse) collapseToPill()"))
    val update = settle.substringAfter("animation.addUpdateListener").substringBefore("animation.addListener")
    for (required in listOf("generation == morphGeneration", "card === owner", "!uiSuspended", "!recreatingViews"))
      assertTrue("old animation frames cannot mutate a replacement card: " + required, update.contains(required))
  }

  @Test fun suspendAndRecreateInvalidateMorphBeforeDetachAndSettleIsBoundToTheOriginalCard() {
    assertMorphLifecycleOwnership(source("OverlayV2.kt"))
  }

  @Test fun controlledNegativesRejectMissingLifecycleInvalidationAndStaleMorphOwnership() {
    val text = source("OverlayV2.kt")
    assertMorphLifecycleOwnership(text)
    val cancelMarker = "    cancelCardInteraction()"
    val suspendAt = text.indexOf(cancelMarker, text.indexOf("  internal fun suspendUi()"))
    val recreateAt = text.indexOf(cancelMarker, text.indexOf("  internal fun recreateViewsPreservingState()"))
    assertTrue(suspendAt >= 0 && recreateAt > suspendAt)
    val mutants = listOf(
      text.removeRange(suspendAt, suspendAt + cancelMarker.length),
      text.removeRange(recreateAt, recreateAt + cancelMarker.length),
      text.replace("    morphGeneration++\n    morphAnimator?.cancel(); morphAnimator = null",
        "    morphAnimator?.cancel(); morphAnimator = null\n    morphGeneration++"),
      text.replace(" && card === owner", ""),
      text.replace("    cardHandleIntent.cancel()", ""),
    )
    for (mutated in mutants) {
      assertNotEquals("negative control must change real lifecycle/settle code", text, mutated)
      var rejected = false
      try { assertMorphLifecycleOwnership(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("lifecycle cancel ordering and original-card ownership are mandatory", rejected)
    }
  }

  private fun assertModernMorphRegionAndSheetCoverage(v2: String) {
    fun method(name: String): String {
      val start = Regex("(?m)^  (?:private|internal) fun " + Regex.escape(name) + "[(]").find(v2)
      assertNotNull("missing actual method " + name, start)
      val tail = v2.substring(requireNotNull(start).range.first)
      val next = Regex("(?m)^  (?:private|internal) fun ").find(tail, start.value.length)
      return tail.substring(0, next?.range?.first ?: tail.length)
        .replace(Regex("""(?s)/[*].*?[*]/"""), "").replace(Regex("""//[^\r\n]*"""), "")
    }
    val morph = method("applyCardMorph")
    val fallback = "if (morphProgress > 0f && !c.updateMorphTouchableRegion()) yieldMorphTouch()"
    assertTrue("working modern input region must retain normal touch flags and opaque window", morph.contains(fallback))
    assertTrue("update input region only after visual shape is applied",
      morph.indexOf("c.applyMorph(") in 0 until morph.indexOf("c.updateMorphTouchableRegion()"))
    assertFalse(morph.contains("FLAG_NOT_TOUCHABLE"))
    assertFalse(morph.contains("lp.alpha ="))
    assertFalse("no per-frame window geometry workaround", morph.contains("windows.update("))
    val code = v2.replace(Regex("""(?s)/[*].*?[*]/"""), "").replace(Regex("""//[^\r\n]*"""), "")
    assertEquals("legacy yield may only be called from failed-region fallback, never flat on every build", 2,
      Regex("""yieldMorphTouch[(][)]""").findAll(code).count()) // declaration + guarded call
    val normal = method("showCard")
    assertFalse("modern card keeps normal input flags", normal.contains("FLAG_NOT_TOUCHABLE"))
    val restore = method("restoreMorphTouch")
    assertTrue(restore.contains("lp.flags = flags; lp.alpha = morphInteractionAlpha"))
    val sheet = method("syncDrawerWindow")
    assertTrue(sheet.contains("val coverBottomControls = c.view.height + c.chipSizesPx("))
    assertTrue(sheet.contains(".first.second + c.chipGapPx + (24f * screen.density).toInt()"))
    assertTrue("sheet must cover input+chips without moving them",
      sheet.contains("maxOf(c.measureDrawerHeightPx(OverlayWindowFrames.composerWidthPx(screen)), coverBottomControls)"))
    assertTrue("coverage cannot violate the 40% available-height hard cap",
      sheet.contains(".coerceIn(1, (OverlayWindowFrames.availableHeightPx(screen) * .4f).toInt().coerceAtLeast(1))"))
    assertFalse(sheet.contains("composerParams?.y ="))
  }

  @Test fun morphUsesModernExactRegionBeforeLegacyFallbackAndSheetCoversBottomControlsWithinCap() {
    assertModernMorphRegionAndSheetCoverage(source("OverlayV2.kt"))
  }

  @Test fun controlledNegativesRejectUnconditionalMorphYieldEarlyRegionAndUndersizedOrUnboundedSheet() {
    val text = source("OverlayV2.kt")
    assertModernMorphRegionAndSheetCoverage(text)
    val fallback = "if (morphProgress > 0f && !c.updateMorphTouchableRegion()) yieldMorphTouch()"
    val mutants = listOf(
      text.replace(fallback, "if (morphProgress > 0f) yieldMorphTouch()"),
      text.replace(fallback, "if (morphProgress > 0f && c.updateMorphTouchableRegion()) yieldMorphTouch()"),
      text.replace("    morphProgress = progress.coerceIn(0f, 1f)", "    yieldMorphTouch()\n    morphProgress = progress.coerceIn(0f, 1f)"),
      text.replace("      c.applyMorph(", "      c.updateMorphTouchableRegion()\n      c.applyMorph("),
      text.replace(" + c.chipGapPx + (24f * screen.density).toInt()", " + c.chipGapPx"),
      text.replace("maxOf(c.measureDrawerHeightPx(OverlayWindowFrames.composerWidthPx(screen)), coverBottomControls)",
        "c.measureDrawerHeightPx(OverlayWindowFrames.composerWidthPx(screen))"),
      text.replace(".coerceIn(1, (OverlayWindowFrames.availableHeightPx(screen) * .4f).toInt().coerceAtLeast(1))", ""),
    )
    for (mutated in mutants) {
      assertNotEquals("negative must alter actual region/coverage wiring", text, mutated)
      var rejected = false
      try { assertModernMorphRegionAndSheetCoverage(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("must reject flat NOT_TOUCHABLE fallback, stale shape or bad sheet coverage", rejected)
    }
  }

  @Test fun rpcTransportRequiresTheExactResponseIdentity() {
    assertTrue(overlayRpcReplyMatches("""{"type":"server-response","rpcId":"request-a","result":{"ok":true}}""", "request-a"))
    assertFalse(overlayRpcReplyMatches("""{"type":"server-response","rpcId":"request-b","result":{"ok":true}}""", "request-a"))
    assertFalse(overlayRpcReplyMatches("""{"type":"client-request","rpcId":"request-a","result":{"ok":true}}""", "request-a"))
  }

  @Test fun foregroundInitialStateComesFromApplicationTracker() {
    assertTrue(source("OverlayV2.kt").contains("private var hostForeground = OverlayHostVisibility.foreground"))
    assertTrue(source("OverlayHostVisibility.kt").contains("app.registerActivityLifecycleCallbacks(this)"))
    assertTrue(source("MainActivity.kt").contains("OverlayHostVisibility.install(application)"))
  }
}
