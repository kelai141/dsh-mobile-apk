package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 动效规格的纯数学断言 + 生产接线契约。
 *
 * 不冒充设备观感：曲线是否「自然」只能上机看；这里守的是可证伪的部分——
 * 动效关闭必须 0ms、所有输出有界且单调、以及各 View 确实按这些值接线（不是另写一份常量）。
 */
class OverlayMotionSpecTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test fun reducedMotionCollapsesEveryDurationToZero() {
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.drawerShowMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.drawerHideMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.entrySwapMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.rowAppearMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.fadeInMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.labelOutMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.labelInMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.pillInMs(reduced = true))
    assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.pillOutMs(reduced = true))
    for (index in 0..10) assertEquals(OverlayMotionSpec.INSTANT_MS, OverlayMotionSpec.stagedDelayMs(index, reduced = true))
  }

  @Test fun enabledDurationsStayInTheNaturalShortRangeForEverySurface() {
    // 出现类 100..200ms、换文案 40..120ms：低于 100 读作「瞬移」，高于 200 会拖住下一次点击。
    for (duration in listOf(OverlayMotionSpec.drawerShowMs(false), OverlayMotionSpec.drawerHideMs(false),
      OverlayMotionSpec.entrySwapMs(false), OverlayMotionSpec.rowAppearMs(false))) {
      assertTrue("surface transition outside 100..200ms: " + duration, duration in 100L..200L)
    }
    assertTrue(OverlayMotionSpec.labelOutMs(false) in 40L..120L)
    assertTrue(OverlayMotionSpec.labelInMs(false) in 40L..120L)
    assertTrue(OverlayMotionSpec.pillInMs(false) in 100L..200L)
    assertTrue(OverlayMotionSpec.pillOutMs(false) in 100L..200L)
    // 消失不拖过出现：收起/消散都该在用户下一次操作前完成。
    assertTrue(OverlayMotionSpec.drawerHideMs(false) <= OverlayMotionSpec.drawerShowMs(false))
    assertTrue(OverlayMotionSpec.pillOutMs(false) <= 200L)
    assertEquals(0L, OverlayMotionSpec.INSTANT_MS)
  }

  @Test fun stagedDelayIsBoundedMonotonicAndNeverQueuesPastOneBeat() {
    assertEquals(0L, OverlayMotionSpec.stagedDelayMs(0, reduced = false))
    assertEquals(0L, OverlayMotionSpec.stagedDelayMs(-3, reduced = false))
    var previous = 0L
    for (index in 0..20) {
      val delay = OverlayMotionSpec.stagedDelayMs(index, reduced = false)
      assertTrue("delay must never decrease: " + index, delay >= previous)
      assertTrue("delay must stay capped: " + index, delay <= OverlayMotionSpec.STAGGER_MAX_MS)
      previous = delay
    }
    // 上界有意义：超过若干行后不再增加，长列表不会排队到一秒之后。
    assertEquals(OverlayMotionSpec.STAGGER_MAX_MS, OverlayMotionSpec.stagedDelayMs(50, reduced = false))
    assertTrue(OverlayMotionSpec.STAGGER_MAX_MS in 1L..150L)
  }

  @Test fun everyEasingIsMonotonicBoundedAndNeverOvershoots() {
    for (easing in OverlayEasing.entries) {
      assertEquals("start: " + easing, 0f, easing.transform(0f), 0f)
      assertEquals("end: " + easing, 1f, easing.transform(1f), 0f)
      var previous = easing.transform(0f)
      var step = 0
      while (step <= 1000) {
        val t = step / 1000f
        val value = easing.transform(t)
        assertTrue("must stay inside 0..1: " + easing + " @" + t, value in 0f..1f)
        assertTrue("no intentional rebound means no overshoot: " + easing + " @" + t, value <= 1f)
        assertTrue("monotonic: " + easing + " @" + t, value >= previous)
        previous = value
        step += 1
      }
    }
  }

  @Test fun nonFiniteProgressAndOutOfRangeValuesClampInsteadOfProducingNanAlpha() {
    for (easing in OverlayEasing.entries) {
      assertEquals(0f, easing.transform(Float.NaN), 0f)
      // 非有限一律按起点处理：宁可停在起点，也不要把 NaN/∞ 写进 alpha。
      assertEquals(0f, easing.transform(Float.POSITIVE_INFINITY), 0f)
      assertEquals(0f, easing.transform(Float.NEGATIVE_INFINITY), 0f)
      assertEquals(0f, easing.transform(-5f), 0f)
      assertEquals(1f, easing.transform(5f), 0f)
    }
    for (progress in listOf(Float.NaN, -1f, 0f, .5f, 1f, 9f)) {
      val frame = OverlayMotionSpec.fadeFrame(progress)
      assertTrue(frame.alpha in 0f..1f)
      assertTrue(frame.travelFraction in 0f..1f)
      assertTrue(kotlin.math.abs(frame.alpha + frame.travelFraction - 1f) < 1e-6f)
    }
    assertEquals(0f, OverlayMotionSpec.fadeFrame(Float.NaN).alpha, 0f)
    assertEquals(1f, OverlayMotionSpec.fadeFrame(1f).alpha, 0f)
    assertEquals(0f, OverlayMotionSpec.fadeFrame(1f).travelFraction, 0f)
  }

  @Test fun fadeFramesMoveTogetherSoOpacityNeverArrivesBeforePosition() {
    var previous = OverlayMotionSpec.fadeFrame(0f)
    var step = 1
    while (step <= 500) {
      val frame = OverlayMotionSpec.fadeFrame(step / 500f)
      assertTrue(frame.alpha >= previous.alpha)
      assertTrue(frame.travelFraction <= previous.travelFraction)
      previous = frame
      step += 1
    }
  }

  @Test fun streamingGrowIsDistinguishedFromARealContentChange() {
    assertTrue(OverlayMotionSpec.isStreamingGrow("I'll create", "I'll create the file"))
    assertFalse("first bind is not a grow", OverlayMotionSpec.isStreamingGrow("", "hello"))
    assertFalse("shorter text is a real change", OverlayMotionSpec.isStreamingGrow("hello world", "hello"))
    assertFalse("rewrite is a real change", OverlayMotionSpec.isStreamingGrow("hello world", "goodbye world"))
    assertFalse("same text is no change", OverlayMotionSpec.isStreamingGrow("same", "same"))
  }

  @Test fun revealPlayerSettlesInsteadOfLeavingMidAlphaWhenMotionIsOffOrDetached() {
    val reveal = source("OverlayReveal.kt")
    val body = reveal.substringAfter("fun reveal(view: View, index: Int, enabled: Boolean)")
      .substringBefore("fun settleAll()")
    assertTrue("关闭动效必须同步写终态，不能调度零时长动画", body.indexOf("if (!enabled) {") < body.indexOf("view.animate()"))
    assertTrue(body.contains("if (duration <= 0L)"))
    assertTrue("起手必须是最低透明度与位移", body.contains("view.alpha = 0f"))
    assertTrue(body.contains("view.translationY = -risePx"))
    val settle = reveal.substringAfter("fun settle(view: View)")
      .substringBefore("private fun settleInternal(")
    assertTrue(settle.contains("view.animate().withEndAction(null).cancel()"))
    assertTrue(settle.contains("view.alpha = 1f"))
    assertTrue(settle.contains("view.translationY = 0f"))
    assertTrue(reveal.contains("fun settleAll()"))
    // 只动渲染属性：任何布局/窗口几何都不能出现在这里。
    for (forbidden in listOf("layoutParams", "requestLayout", "updateViewLayout", "ValueAnimator", "postDelayed")) {
      assertFalse("reveal must stay render-only: " + forbidden, reveal.contains(forbidden))
    }
  }

  @Test fun composerDrawerUsesSpecDurationsAndHasAnExplicitZeroDurationPath() {
    val composer = source("OverlayComposer.kt")
    val fadeIn = composer.substringAfter("fun fadeDrawerIn()").substringBefore("fun animateDrawerOut(")
    assertTrue(fadeIn.contains("OverlayMotionSpec.drawerShowMs(reduced = !motionEnabled)"))
    val fadeOut = composer.substringAfter("fun animateDrawerOut(onEnd: () -> Unit)").substringBefore("private fun animateDrawerTo(")
    assertTrue(fadeOut.contains("OverlayMotionSpec.drawerHideMs(reduced = !motionEnabled)"))
    val animate = composer.substringAfter("private fun animateDrawerTo(").substringBefore("fun finishAnimations()")
    assertTrue(animate.contains("if (!attached || !motionEnabled || durationMs <= 0L) { finishAnimations(); return }"))
    assertFalse("时长不再写死在视图里", composer.contains("setDuration(160L)"))
    assertFalse("位移不再写死在视图里", composer.contains("translationY = dp(24).toFloat()"))
    // 假绿负控：去掉 0ms 出口后，同一段源码必须举证不出「同步到终态」。
    val mutated = animate.replace("if (!attached || !motionEnabled || durationMs <= 0L) { finishAnimations(); return }",
      "if (!attached || !motionEnabled) { finishAnimations(); return }")
    assertNotEquals(animate, mutated)
    assertFalse(mutated.contains("durationMs <= 0L"))
  }

  @Test fun entryShapeSwapCrossFadesInsideTheStableRootWithoutTouchingGeometry() {
    val entry = source("OverlayEntryView.kt")
    val swap = entry.substringAfter("fun renderStyle(next: OverlayEntryStyle)")
      .substringBefore("fun finishSwap()")
    assertTrue("旧表面必须交叠淡出，而不是瞬间替换", swap.contains("root.addView(outgoing"))
    assertTrue(swap.contains("incoming.alpha = 0f"))
    assertTrue(swap.contains("OverlayMotionSpec.ENTRY_DIP_SCALE"))
    assertTrue(swap.contains("OverlayMotionSpec.entrySwapMs(reduced = !motionEnabled)"))
    assertTrue("动效关闭时直接换形", swap.contains("if (!attached || durationMs <= 0L)"))
    val finish = entry.substringAfter("fun finishSwap()").substringBefore("private fun clearRetiring()")
    assertTrue(finish.contains("clearRetiring()"))
    assertTrue(finish.contains("resetSurfaceTransforms(surface)"))
    val detach = entry.substringAfter("override fun onViewDetachedFromWindow(v: View)").substringBefore("    })")
    assertTrue("移窗必须收口换形过渡", detach.contains("finishSwap()"))
    val feedback = entry.substringAfter("fun renderEdgeProgress(").substringBefore("private fun buildSurface(")
    assertTrue("拖动反馈接手时换形必须在当帧收口", feedback.contains("if (retiring != null)"))
    assertTrue(feedback.contains("finishSwap()"))
    assertTrue("无拖动量的那一帧要留给过渡", feedback.contains("if (p <= 0f) return"))
    assertFalse("换形不允许改窗口几何", swap.contains("layoutParams"))
    assertTrue("触摸目标仍是稳定根", entry.contains("val view: View = root"))
  }

  @Test fun cardRevealNeverFightsTheDistanceMorphOrReplaysOnEveryRender() {
    val card = source("OverlayCardView.kt")
    val gate = card.substringAfter("private fun revealEnabled(): Boolean")
      .substringBefore("private fun renderTranscript(")
    assertTrue(gate.contains("attached && motionEnabled && morphProgress <= 0f"))
    val appear = card.substringAfter("private fun revealOnAppear(")
      .substringBefore("private fun revealEnabled()")
    assertTrue("只有刚出现才播", appear.contains("if (visible && !wasVisible)"))
    val render = card.substringAfter("fun render(data: OverlayCardData)").substringBefore("private fun TextView.setTextIfChanged")
    assertFalse("重复 render 不重播出现过渡", render.contains("rowReveal.reveal(thinkingLine"))
    assertTrue(render.contains("thinkingShown = revealOnAppear(thinkingLine"))
    // 行出现只在新行上发生。
    val rows = card.substringAfter("private fun renderRows(").substringBefore("private fun createRow()")
    assertTrue(rows.contains("rowReveal.reveal(holder.root, rowHolders.size - 1, revealEnabled())"))
    val transcript = card.substringAfter("private fun renderTranscript(").substringBefore("private fun bindTranscriptRow(")
    assertTrue("只有新增消息才淡入", transcript.contains("if (fresh) rowReveal.reveal(holder.root, index, revealEnabled())"))
    // 真源仍归距离形变：出现过渡不得改写 applyMorph 的 alpha 口径。
    val morph = card.substringAfter("fun applyMorph(").substringBefore("fun resetMorph()")
    assertFalse(morph.contains("rowReveal"))
    assertTrue(card.contains("rowReveal.settleAll()"))
  }

  @Test fun drawerRowRevealIsHostedByTheComposerAndGatedByTheSystemSwitch() {
    val drawer = source("OverlayCommandDrawer.kt")
    assertTrue(drawer.contains("fun setAnimationsEnabled(enabled: Boolean)"))
    assertTrue(drawer.contains("if (!enabled)"))
    assertTrue(drawer.contains("reveal.settleAll()"))
    assertTrue("挂窗后补播一次错峰，首次展开不能整块出现", drawer.contains("reveal.reveal(listColumn.getChildAt(index), index, true)"))
    assertTrue(drawer.contains("reveal.reveal(row, index, animationsEnabled)"))
    val composer = source("OverlayComposer.kt")
    assertTrue(composer.contains("drawer.setAnimationsEnabled(attached && motionEnabled)"))
    val detach = composer.substringAfter("override fun onViewDetachedFromWindow(v: View)").substringBefore("    })")
    assertTrue("移窗即收口抽屉行过渡", detach.contains("drawer.setAnimationsEnabled(false)"))
  }
}
