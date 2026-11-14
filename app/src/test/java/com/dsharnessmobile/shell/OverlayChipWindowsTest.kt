package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure size limits plus source wiring; actual separate-window/IME/pass-through needs device proof. */
class OverlayChipWindowsTest {
  @Test fun equalShareWidthLeavesTheConfiguredGap() {
    assertEquals(176, overlayChipWidthLimitPx(360, 8))
    assertEquals(176, overlayChipWidthLimitPx(361, 8))
    assertEquals(0, overlayChipWidthLimitPx(8, 8))
    assertEquals(0, overlayChipWidthLimitPx(7, 8))
    assertEquals(180, overlayChipWidthLimitPx(360, 0))
  }

  @Test fun invalidAndExtremeWidthInputsCannotOverflowOrProduceNegativeWindows() {
    assertEquals(0, overlayChipWidthLimitPx(-1, 8))
    assertEquals(0, overlayChipWidthLimitPx(Int.MIN_VALUE, Int.MAX_VALUE))
    assertEquals(180, overlayChipWidthLimitPx(360, -8))
    assertEquals(Int.MAX_VALUE / 2, overlayChipWidthLimitPx(Int.MAX_VALUE, 0))
    assertEquals(0, overlayChipWidthLimitPx(Int.MAX_VALUE, Int.MAX_VALUE))
  }

  @Test fun bothMaxWidthsAlwaysFitWithoutTakingTheGap() {
    for (width in 0..1200) {
      for (gap in intArrayOf(0, 1, 8, 16, 48)) {
        val limit = overlayChipWidthLimitPx(width, gap)
        assertTrue(limit >= 0)
        if (width >= gap) assertTrue(limit.toLong() * 2L + gap <= width.toLong())
        else assertEquals(0, limit)
      }
    }
  }

  @Test fun chipsAreStableIndependentRootsNeverChildrenOfTheComposer() {
    val source = composer()
    assertTrue(source.contains("val workspaceView: View get() = workspaceChip"))
    assertTrue(source.contains("val sessionView: View get() = sessionChip"))
    assertFalse(source.contains("private val pillRow"))
    assertFalse(source.contains("addView(workspaceChip"))
    assertFalse(source.contains("addView(sessionChip"))
    val root = section(source, "val view: View =", "  init {")
    assertTrue(root.contains("background = null"))
    assertTrue(root.contains("addView(pendingHint"))
    assertTrue(root.contains("addView(answerActions"))
    assertTrue(root.contains("addView(attachScroll"))
    assertTrue(root.contains("addView(inputRow"))
    assertFalse(root.contains("drawerView"))
    assertFalse(root.contains("pillRow"))
  }

  @Test fun chipsHaveNaturalBoundedMeasurementAndOneLineEllipsizedLabels() {
    val source = composer()
    val measurement = section(source, "fun chipSizesPx(", "  // ── 附件条")
    assertTrue(measurement.contains("overlayChipWidthLimitPx(composerWidthPx, chipGapPx)"))
    assertTrue(measurement.contains("measureChip(workspaceChip, widthLimit, height) to measureChip(sessionChip, widthLimit, height)"))
    assertTrue(measurement.contains("View.MeasureSpec.AT_MOST"))
    assertTrue(measurement.contains("View.MeasureSpec.EXACTLY"))
    assertTrue(measurement.contains("chip.maxWidth != widthLimit"))
    assertTrue(measurement.contains("chip.measuredWidth.coerceIn(0, widthLimit)"))
    val chip = section(source, "private fun chip(label:", "private fun chipLabel(")
    assertTrue(chip.contains("maxLines = 1"))
    assertTrue(chip.contains("ellipsize = android.text.TextUtils.TruncateAt.END"))
    assertTrue(source.contains("workspaceChip.contentDescription = workspaceChip.text"))
    assertTrue(source.contains("sessionChip.contentDescription = sessionChip.text"))
  }

  @Test fun answerModeHidesBothChipRootsWithoutChangingDraftOrClickOwnership() {
    val source = composer()
    assertTrue(source.contains("fun chipsVisible(): Boolean = workspaceChip.visibility == View.VISIBLE"))
    assertTrue(source.contains("workspaceChip.visibility = if (data.answeringQuestion) View.GONE else View.VISIBLE"))
    assertTrue(source.contains("sessionChip.visibility = workspaceChip.visibility"))
    assertTrue(source.contains("listener.onComposerWorkspaceChip()"))
    assertTrue(source.contains("listener.onComposerSessionChip()"))
    val render = section(source, "fun render(data:", "fun inputText()")
    assertFalse(render.contains("setInputText("))
    assertFalse(render.contains("input.setText("))
  }

  @Test fun touchUnionUsesVisibleSurfaceChildrenNotTheirTransparentCommonRows() {
    val region = section(composer(), "private fun applyTouchableSurfaces(", "  /** 当前是否 busy")
    assertTrue(region.contains("surfaces.add(pendingHint)"))
    assertTrue(region.contains("surfaces.add(inputRow)"))
    assertTrue(region.contains("surfaces.add(answerActions.getChildAt(index))"))
    assertTrue(region.contains("attachments.add(attachColumn.getChildAt(index))"))
    assertTrue(region.contains("OverlayTouchRegion.unionRegions(root, surfaces)"))
    assertTrue(region.contains("root.offsetDescendantRectToMyCoords(attachScroll, viewport)"))
    assertTrue(region.contains("attachmentRegion.op(viewport, Region.Op.INTERSECT)"))
    assertTrue(region.contains("OverlayTouchRegion.apply(root, region)"))
    assertFalse(region.contains("surfaces.add(answerActions)"))
    assertFalse(region.contains("surfaces.add(attachScroll)"))
    assertFalse(region.contains("surfaces.add(workspaceChip)"))
    assertFalse(region.contains("surfaces.add(sessionChip)"))
    assertFalse(region.contains("measure("))
    assertFalse(region.contains("layoutParams"))
  }

  @Test fun regionUpdatesAreAttachedLayoutEventsCoalescedAndFullyUnsubscribedOnDetach() {
    val binding = section(composer(), "private fun installTouchableSurfaces(", "  /** Exact visible surface union")
    assertTrue(binding.contains("if (queued || !root.isAttachedToWindow) return"))
    assertTrue(binding.contains("ViewTreeObserver.OnGlobalLayoutListener { schedule() }"))
    assertTrue(binding.contains("ViewTreeObserver.OnScrollChangedListener { schedule() }"))
    assertTrue(binding.contains("root.post(update)"))
    assertTrue(binding.contains("root.removeCallbacks(update)"))
    assertTrue(binding.contains("removeOnGlobalLayoutListener(layoutListener)"))
    assertTrue(binding.contains("removeOnScrollChangedListener(scrollListener)"))
    assertTrue(binding.contains("OverlayTouchRegion.forget(root)"))
    assertFalse(binding.contains("postDelayed"))
    assertFalse(binding.contains("postOnAnimation"))
    assertFalse(binding.contains("ValueAnimator"))
    assertFalse(binding.contains("measure("))
  }

  @Test fun chipSizeCachePrecedesMeasurementAndIncludesWidthLabelsAndConfiguration() {
    val sizing = section(composer(), "fun chipSizesPx(", "private fun measureChip(")
    assertTrue(sizing.contains("ChipMeasureKey(composerWidthPx, workspaceChip.text.toString(), sessionChip.text.toString(), config.densityDpi, config.fontScale)"))
    val cached = sizing.indexOf("if (chipMeasureKey == key && cached != null) return cached")
    val measure = sizing.indexOf("measureChip(workspaceChip")
    assertTrue("pre-draw must reuse the measured pair", cached >= 0 && cached < measure)
    assertTrue(sizing.contains("measuredChipSizes = sizes"))
  }

  @Test fun pickerLeaseGuardPrecedesEveryChipMembershipChangeAndTopComparisonIsNormalized() {
    val sync = section(v2(), "private fun syncChipWindows()", "private fun syncDrawerWindow()")
    val guard = sync.indexOf("if (attachmentInteraction != null) return")
    assertTrue(guard >= 0 && guard < sync.indexOf("hideChipWindows()"))
    assertTrue(sync.contains("!c.view.isAttachedToWindow"))
    assertTrue(sync.contains("val top = (location[1] - sizes.first.second - c.chipGapPx).coerceAtLeast(0)"))
    assertTrue(sync.contains("old.y == top"))
    assertTrue(sync.contains("lp.y = top;"))
    assertFalse(sync.contains("lp.y = top.coerceAtLeast"))
  }

  @Test fun chipFastPathRequiresActualWmsPixelsAsWellAsRequestedLayoutParams() {
    val sync = section(v2(), "private fun syncChipWindows()", "private fun syncDrawerWindow()")
    assertTrue("unchanged requests are insufficient after WMS clamping/rotation", actualChipFrameFastPath(sync))
    val oldRequestedOnly = sync.replace(
      " &&\n        actual[0] == x && actual[1] == top && view.width == size.first && view.height == size.second", "",
    )
    assertFalse("negative control: requested-only early return must fail", actualChipFrameFastPath(oldRequestedOnly))
    assertFalse("negative control: origin without rendered size must fail", actualChipFrameFastPath(
      sync.replace(" && view.width == size.first && view.height == size.second", ""),
    ))
    assertFalse("negative control: size without screen origin must fail", actualChipFrameFastPath(
      sync.replace("actual[0] == x && actual[1] == top && ", ""),
    ))
    assertFalse("negative control: actual array without reading the view must fail", actualChipFrameFastPath(
      sync.replace("view.getLocationOnScreen(actual)", "actual.fill(0)"),
    ))
  }

  @Test fun configurationQueuesChipResyncOnlyOutsideThePickerLeaseAfterDrawerReflow() {
    val config = section(v2(), "internal fun onConfigurationChanged()", "private fun scheduleRender()")
    val deferred = config.substringAfter("    if (attachmentInteraction == null) {")
    assertTrue("configuration must keep leased chip membership", deferred != config)
    val cap = deferred.indexOf("setMaxDrawerHeightPx((OverlayWindowFrames.availableHeightPx(s) * .4f).toInt())")
    val drawer = deferred.indexOf("syncDrawerWindow()")
    val chipPost = deferred.indexOf("composer?.view?.post")
    assertTrue("drawer cap and dimensions settle before scheduling actual-location chip read", cap >= 0 && drawer > cap && chipPost > drawer)
    assertTrue(deferred.contains("if (!destroyed && !uiSuspended && !hostForeground) syncChipWindows()"))
    assertFalse("one-shot resync is not a permanent frame poll", deferred.contains("postOnAnimation"))
  }

  private fun actualChipFrameFastPath(sync: String): Boolean {
    val placement = sync.substringAfter("fun place(").substringBefore("val lp = old ?:")
    val compact = placement.replace(Regex("\\s+"), " ")
    return placement.contains("view.getLocationOnScreen(actual)") && compact.contains(
      "if (old != null && old.x == x && old.y == top && old.width == size.first && old.height == size.second && " +
        "actual[0] == x && actual[1] == top && view.width == size.first && view.height == size.second) return",
    )
  }

  @Test fun chipObserversFollowEveryAttachmentAndLayoutListenerIsNotAddedPerShow() {
    val source = v2()
    val ensure = section(source, "private fun ensureComposerView()", "internal fun showComposer(")
    assertTrue(ensure.contains("root.addOnLayoutChangeListener"))
    assertTrue(ensure.contains("root.addOnAttachStateChangeListener"))
    assertTrue(ensure.contains("chipObserver = root.viewTreeObserver.also"))
    assertTrue(ensure.contains("addOnGlobalLayoutListener(chipLayout)"))
    assertTrue(ensure.contains("addOnPreDrawListener(chipPreDraw)"))
    assertTrue(ensure.contains("removeOnGlobalLayoutListener(chipLayout)"))
    assertTrue(ensure.contains("removeOnPreDrawListener(chipPreDraw)"))
    assertTrue(ensure.contains("root.removeCallbacks(syncAttachedChips)"))
    assertFalse(ensure.contains("postOnAnimation"))
    val show = section(source, "internal fun showComposer(", "private fun hideComposerImmediate()")
    assertFalse(show.contains("addOnLayoutChangeListener"))
    assertFalse(show.contains("addOnPreDrawListener"))
  }

  @Test fun queuedEditorFocusChecksBothPresentationGenerationAndPickerOwnership() {
    val show = section(v2(), "internal fun showComposer(", "private fun hideComposerImmediate()")
    assertTrue(show.contains("composerWindowGeneration == focusGeneration"))
    assertTrue(show.contains("!destroyed && !uiSuspended && !hostForeground && !composerClosing && attachmentInteraction == null"))
    assertTrue(show.contains("if (canFocus()) c.focusInput(canFocus)"))
    val focus = section(composer(), "fun focusInput(", "  // ── 内部渲染")
    assertTrue(focus.contains("if (!view.isAttachedToWindow || !canFocus()) return"))
    val deferred = focus.substringAfter("input.post {")
    assertTrue(deferred.indexOf("!canFocus()") < deferred.indexOf("showSoftInput"))
    assertTrue(deferred.contains("!input.hasFocus()"))
  }

  @Test fun inputAndSheetUseOpaqueThemeSurfacesInsteadOfBlendingLowerAppText() {
    val source = composer()
    val input = section(source, "private val inputRow", "private val drawer =")
    val sheet = section(source, "val drawerView: View =", "val view: View =")
    assertTrue(input.contains("setColor(colorSurface)"))
    assertTrue(sheet.contains("setColor(colorSurface)"))
    assertFalse(input.contains("withAlpha"))
    assertFalse(sheet.contains("withAlpha"))
    assertFalse(source.contains("setColor(withAlpha"))
    val root = section(source, "val view: View =", "  init {")
    assertTrue("no shared opaque chip/composer slab", root.contains("background = null"))
    assertFalse(root.contains("setColor("))
    assertFalse(root.contains("addView(workspaceChip"))
    assertFalse(root.contains("addView(sessionChip"))
  }

  @Test fun independentDrawerScrollHasSolidBackingForEveryMenuRowAndAttachmentTile() {
    val drawer = listOf(
      File("src/main/java/com/dsharnessmobile/shell/OverlayCommandDrawer.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/OverlayCommandDrawer.kt"),
    ).first { it.isFile }.readText()
    assertTrue(drawer.contains("R.color.ds_surface"))
    assertTrue(drawer.contains("setBackgroundColor(colorSurface)"))
    assertTrue(drawer.contains("setColor(colorChip)"))
    assertFalse(drawer.contains("withAlpha"))
    // The invariant is that no MENU ROW or ATTACHMENT TILE is painted translucent: the sheet has to
    // cover the app text underneath. A window-level fade would be exactly that bug, so it stays
    // banned outright. Row-level appear motion is allowed, but then it must be bounded, driven by the
    // shared reveal player, and settle synchronously - never a permanent半透明 state.
    // Scope is the two row factories only; the sheet's own grab handle legitimately carries a static
    // alpha, so a whole-file scan would flag decoration instead of the real translucency defect.
    val rowSection = drawer.substringAfter("private fun attachTile(").substringBefore("private fun emptyRow(")
    assertFalse("附件瓦片不得自带半透明", rowSection.contains("alpha ="))
    assertFalse("附件瓦片不得自带位移残留", rowSection.contains("translationY ="))
    val windowFade = Regex("""view\.alpha\s*=|\.alpha\(0f\)""").containsMatchIn(drawer)
    assertFalse("抽屉窗本体不得整体淡入，否则下层应用文字会透出", windowFade)
    for (fade in Regex("""alpha\s*=\s*([0-9.]+)f""").findAll(drawer)) {
      assertTrue("唯一的静态alpha只能是把手高光: " + fade.value, fade.groupValues[1].toFloat() >= 0.5f)
    }
    // Every appear transition goes through the shared player, which always has a settle path.
    assertTrue(drawer.contains("OverlayRevealPlayer("))
    assertTrue(drawer.contains("reveal.settleAll()"))
  }

  private fun v2(): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell/OverlayV2.kt"),
    File("app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt"),
  ).first { it.isFile }.readText()

  private fun composer(): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt"),
    File("app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt"),
  ).first { it.isFile }.readText()

  private fun section(source: String, start: String, end: String): String {
    assertTrue("missing " + start, source.contains(start))
    val tail = source.substringAfter(start)
    assertTrue("missing " + end, tail.contains(end))
    return tail.substringBefore(end)
  }
}
