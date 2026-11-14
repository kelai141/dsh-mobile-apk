package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 源码契约只钉独立窗口与动画纪律，不替代设备布局/手势验收。 */
class OverlayFloatingComposerTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()
  private fun section(text: String, start: String, end: String): String {
    assertTrue("missing " + start, text.contains(start))
    val tail = text.substringAfter(start)
    assertTrue("missing " + end, tail.contains(end))
    return tail.substringBefore(end)
  }

  @Test fun composerRootHasNoSharedChipRowOrInvisibleFullWidthChipHitArea() {
    val c = source("OverlayComposer.kt")
    val root = section(c, "val view: View =", "  init {")
    assertTrue(root.contains("background = null"))
    assertFalse(root.contains("setColor("))
    assertFalse(root.contains("addView(drawerView"))
    assertFalse(root.contains("addView(drawerHost"))
    assertFalse("extracted chips cannot keep a shared full-width parent", c.contains("private val pillRow"))
    assertTrue(c.contains("val workspaceView: View get() = workspaceChip"))
    assertTrue(c.contains("val sessionView: View get() = sessionChip"))
    for (chip in listOf("workspaceChip", "sessionChip", "workspaceView", "sessionView", "pillRow"))
      assertFalse("chip owns an independent bounded window, not the input root: " + chip, root.contains("addView(" + chip))
    val v2 = source("OverlayV2.kt")
    assertTrue(v2.contains("OverlayWindows.Slot.WORKSPACE"))
    assertTrue(v2.contains("OverlayWindows.Slot.SESSION"))
  }

  @Test fun inputRowIsACompletePillAndEditorDoesNotAddAnotherPanel() {
    val c = source("OverlayComposer.kt")
    val row = section(c, "private val inputRow", "private val drawer =")
    assertTrue(row.contains("cornerRadius = dp(32).toFloat()"))
    assertTrue("input text needs a solid surface rather than ghosting underlying app content", row.contains("setColor(colorSurface)"))
    assertFalse(row.contains("setColor(withAlpha(colorSurface,"))
    assertTrue(row.contains("setStroke(dp(1), colorBorder)"))
    assertFalse(row.contains("cornerRadii"))
    val editor = section(c, "private val input = EditText", "private var lastInputLineCount")
    assertTrue(editor.contains("background = null"))
    assertTrue(editor.contains("maxLines = 4"))
  }

  @Test fun independentDrawerRootHandlesBackAndContainsOnlyDrawerContent() {
    val c = source("OverlayComposer.kt")
    val root = section(c, "val drawerView: View =", "val view: View =")
    assertTrue(root.contains("BackKeyPanelLayout(context) { listener.onComposerBack() }"))
    assertTrue(root.contains("addView(drawer.view"))
    assertTrue(root.contains("cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)"))
    assertTrue(root.contains("clipToOutline = true"))
    assertTrue("sheet must opaquely cover the unchanged input underneath", root.contains("setColor(colorSurface)"))
    assertFalse("sheet must not ghost input text through its background", root.contains("setColor(withAlpha(colorSurface,"))
    assertFalse(root.contains("addView(inputRow"))
  }

  @Test fun drawerAnimationOnlyChangesTransformsNotPerFrameGeometry() {
    val c = source("OverlayComposer.kt")
    val animation = section(c, "fun fadeDrawerIn()", "fun setMaxDrawerHeightPx(")
    // 时长不再写死毫秒数：改由 OverlayMotionSpec 提供（动效关闭时 0ms），这里钉的是「用的就是它」。
    assertTrue(animation.contains("drawerView.animate().alpha(alpha).translationY(translationY).setDuration(durationMs)"))
    assertFalse(c.contains("ValueAnimator"))
    assertFalse(animation.contains("layoutParams"))
    assertFalse(animation.contains("requestLayout"))
    assertFalse(animation.contains("onComposerLayoutChanged"))
    assertFalse(animation.contains("WindowManager"))
  }

  @Test fun reopeningAndDetachDiscardOldCloseCallback() {
    val c = source("OverlayComposer.kt")
    val state = section(c, "fun setDrawerOpen(", "fun fadeDrawerIn()")
    assertTrue(state.contains("if (open == drawerOpen) return"))
    assertTrue(state.contains("cancelDrawerAnimation()"))
    assertTrue(state.contains("plusButton.isSelected = open"))
    val cancel = section(c, "private fun cancelDrawerAnimation()", "private fun dp(")
    assertTrue(cancel.contains("drawerAnimationGeneration++"))
    assertTrue(cancel.contains("drawerAnimationEnd = null"))
    assertTrue(cancel.contains("drawerView.animate().withEndAction(null).cancel()"))
    val detach = section(c, "override fun onViewDetachedFromWindow(v: View)", "  private var busy")
    assertTrue(detach.contains("cancelDrawerAnimation()"))
    assertFalse(detach.contains("finishAnimations()"))
  }

  @Test fun motionDisableFinishesCurrentCallbackOnceAndDetachUnsubscribes() {
    val c = source("OverlayComposer.kt")
    assertTrue(c.contains("drawerView.addOnAttachStateChangeListener"))
    assertTrue(c.contains("if (!motionEnabled) finishAnimations()"))
    assertTrue(c.contains("generation == drawerAnimationGeneration && attached"))
    val finish = section(c, "fun finishAnimations()", "fun setMaxDrawerHeightPx(")
    assertTrue(finish.contains("val onEnd = drawerAnimationEnd"))
    assertTrue(finish.indexOf("cancelDrawerAnimation()") < finish.indexOf("onEnd?.invoke()"))
    val detach = section(c, "override fun onViewDetachedFromWindow(v: View)", "  private var busy")
    assertTrue(detach.contains("unregisterMotionListener?.invoke()"))
    assertTrue(detach.contains("unregisterMotionListener = null"))
  }

  @Test fun measurementUsesInjectedCapAndInternalScrollRatherThanScreenConstant() {
    val c = source("OverlayComposer.kt")
    val measure = section(c, "fun measureDrawerHeightPx(widthPx: Int)", "fun isDrawerOpen()")
    assertTrue(measure.contains("widthPx.coerceAtLeast(0)"))
    assertTrue(measure.contains("makeMeasureSpec(maxDrawerHeightPx, View.MeasureSpec.AT_MOST)"))
    assertTrue(measure.contains("coerceIn(0, maxDrawerHeightPx)"))
    assertFalse(measure.contains("displayMetrics"))
    val drawer = source("OverlayCommandDrawer.kt")
    assertTrue(drawer.contains("override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int)"))
    assertTrue(drawer.contains("minOf(maxHeightPx, parentSize)"))
    assertTrue(drawer.contains("View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST)"))
    assertTrue(drawer.contains("addView(contentColumn"))
    assertTrue(drawer.contains("if (signature == lastSignature) return"))
  }

  @Test fun repeatedRenderDoesNotRestartAnimationOrOverwriteInputDraft() {
    val c = source("OverlayComposer.kt")
    val render = section(c, "fun render(data:", "fun inputText()")
    assertFalse(render.contains("fadeDrawerIn("))
    assertFalse(render.contains("animateDrawerOut("))
    assertFalse(render.contains("setInputText("))
    assertFalse(render.contains("updateDrawerHeightNow"))
    assertTrue(render.contains("commands = data.commands"))
  }
  private fun assertIndependentSheetContract(v2: String) {
    val sync = section(v2, "private fun syncDrawerWindow()", "private fun hideDrawer(")
    assertTrue(sync.contains("windows.add(OverlayWindows.Slot.DRAWER, c.drawerView, lp)"))
    assertTrue(sync.contains("windows.update(OverlayWindows.Slot.DRAWER, lp)"))
    assertTrue(sync.contains("Gravity.BOTTOM or Gravity.START"))
    assertTrue(sync.contains("SOFT_INPUT_ADJUST_NOTHING"))
    assertTrue(sync.contains("lp.y = screen.navBarPx"))
    assertTrue(sync.contains(".4f"))
    for (forbidden in listOf("composerParams", "Slot.COMPOSER", "refreshComposerWindowHeight(",
      "c.view.translationY", "c.view.layoutParams", "MATCH_PARENT", "prepareAttachmentUi("))
      assertFalse("opening a sheet cannot move/resize/reparent input: " + forbidden, sync.contains(forbidden))
    val resize = section(v2, "private fun refreshComposerWindowHeight()", "private var sending")
    assertFalse("sheet height cannot become composer y avoidance", resize.contains("measureDrawerHeightPx"))
    assertFalse(resize.contains("lp.y ="))
    assertFalse(resize.contains("drawerParams"))
    val composer = section(v2, "internal fun showComposer(", "private fun hideComposerImmediate()")
    assertTrue(composer.contains("y = OverlayWindowFrames.composerBottomPx(s)"))
    assertFalse(composer.contains("measureDrawerHeightPx"))
    assertFalse(composer.contains("drawerParams"))
  }

  @Test fun independentSheetCoversInputWithoutChangingItsFrameOrCreatingAFullScreenTouchLayer() {
    assertIndependentSheetContract(source("OverlayV2.kt"))
  }

  @Test fun staleDrawerCloseCannotRemoveTheNewlyReopenedSheet() {
    val v2 = source("OverlayV2.kt")
    val sync = section(v2, "private fun syncDrawerWindow()", "private fun hideDrawer(")
    assertTrue(sync.contains("drawerWindowGeneration++"))
    assertTrue(sync.contains("if (drawerClosing) { c.fadeDrawerIn(); drawerClosing = false }"))
    val close = section(v2, "private fun hideDrawer(", "private var lastComposerMeasuredHeight")
    assertTrue(close.contains("val generation = ++drawerWindowGeneration"))
    assertTrue(close.indexOf("if (generation == drawerWindowGeneration)") < close.indexOf("windows.remove("))
    assertTrue(close.contains("if (animated && drawerClosing) return"))
  }

  @Test fun outsideTapOnlyClosesBottomAndCannotCloseLeasedPickerWindows() {
    val outside = section(source("OverlayV2.kt"), "private fun onInputOutside(", "private fun ensureComposerView()")
    assertTrue(outside.contains("if (attachmentInteraction != null) return"))
    assertTrue(outside.indexOf("attachmentInteraction != null") < outside.indexOf("hideComposer()"))
    assertTrue(outside.contains("MotionEvent.ACTION_OUTSIDE"))
    assertTrue(outside.contains("hideComposer()"))
    for (forbidden in listOf("hideCard(", "hidePill(", "dismissPill(", "setInputText(", "stopSelf(", "requestStop("))
      assertFalse("outside is bottom-only: " + forbidden, outside.contains(forbidden))
  }

  @Test fun controlledNegativesRejectSheetAvoidanceAndComposerResizing() {
    val text = source("OverlayV2.kt")
    val marker = "    drawerParams = lp"
    assertTrue(text.contains(marker))
    for (bad in listOf("composerParams?.y = height", "composerParams?.height = height",
      "windows.update(OverlayWindows.Slot.COMPOSER, lp)", "c.view.translationY = -height.toFloat()")) {
      val mutated = text.replace(marker, "    " + bad + "\n" + marker)
      assertNotEquals(text, mutated)
      var rejected = false
      try { assertIndependentSheetContract(mutated) } catch (_: AssertionError) { rejected = true }
      assertTrue("negative control must reject input displacement: " + bad, rejected)
    }
  }

}

