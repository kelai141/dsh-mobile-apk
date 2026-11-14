package com.dsharnessmobile.shell

import android.content.ContextWrapper
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2 视图契约：BackKeyPanelLayout 真对象的按键行为 + 生产视图的接线反证。
 *
 * 普通 JVM 的 Android MotionEvent 是桩，不能把源码契约冒充真实触屏验证；这里钉住 DOWN 起点、
 * UP 当帧原始位移、纵向速度、取消不点击等接线，设备层仍须证明「到顶停住，下一次上推才消散」。
 */
class OverlayV2ViewContractTest {
  @Test
  fun pillTouchBindingUsesTheConstructingViewInsteadOfReadingItsUnassignedProperty() {
    val source = source("OverlayPillView.kt")
    val root = source.substringAfter("val view: View =").substringBefore("fun render(")
    assertTrue("根属性尚未赋值时只能把 apply receiver 传给触摸装配", root.contains("attachTouch(this)"))
    val attach = source.substringAfter("private fun attachTouch(hit: View)")
    assertTrue(attach.contains("hit.setOnTouchListener"))
    assertFalse("在根属性初始化中回读 view 会得到 null", attach.contains("view.setOnTouchListener"))
  }

  @Test
  fun pillDownAlwaysReportsWindowOriginBeforeAnyTapOrDrag() {
    val down = branch(source("OverlayPillView.kt"), "DOWN", "MOVE")
    assertTrue(down.contains("downRawX = ev.rawX"))
    assertTrue(down.contains("downRawY = ev.rawY"))
    val callback = "listener.onPillDrag(OverlayDragPhase.DOWN, 0f, 0f, 0f)"
    assertTrue("DOWN 回调不可依赖 dragging，否则服务仍拿不到起点", down.contains(callback))
    assertFalse(down.contains("if (dragging) listener.onPillDrag(OverlayDragPhase.DOWN"))
    assertTrue(down.indexOf(callback) < down.indexOf("gestureDetector.onTouchEvent(ev)"))
  }

  @Test
  fun pillUpUsesItsOwnRawDisplacementAndOnlyVerticalVelocity() {
    assertPillUpContract(source("OverlayPillView.kt"))
  }

  @Test
  fun pillUpCrossingSlopWithoutAMoveCannotOpenTheCardAsATap() {
    val up = branch(source("OverlayPillView.kt"), "UP", "CANCEL")
    val slop = up.indexOf("if (!dragging && hypot(dx.toDouble(), dy.toDouble()) > touchSlop.toDouble()) dragging = true")
    val detector = up.indexOf("gestureDetector.onTouchEvent(ev)")
    assertTrue("UP 必须先按最终位移排除点击", slop >= 0 && slop < detector)
    assertTrue("detector 内同步点击回调必须仍看到 dragging=true", detector < up.indexOf("dragging = false"))
    assertTrue(source("OverlayPillView.kt").contains("if (!dragging) listener.onPillTap()"))
  }

  @Test
  fun pillCancelEndsTheGestureWithoutTappingOrUpDismissal() {
    val cancel = branch(source("OverlayPillView.kt"), "CANCEL", null)
    assertTrue(cancel.contains("listener.onPillDrag(OverlayDragPhase.CANCEL, lastDx, lastDy, 0f)"))
    assertFalse(cancel.contains("onPillTap()"))
    assertFalse(cancel.contains("OverlayDragPhase.UP"))
    assertTrue(cancel.contains("tracker = null"))
    assertTrue(cancel.contains("dragging = false"))
  }

  @Test
  fun cardRootReusesBackDispatchRatherThanAFocusDependentKeyListener() {
    assertTrue(source("OverlayCardView.kt").contains(
      "val view: View = BackKeyPanelLayout(context) { listener.onCardCollapse() }.apply {",
    ))
    assertFalse(source("OverlayCardView.kt").contains("setOnKeyListener"))
  }

  @Test
  fun composerRootDelegatesBackToAnExplicitRequiredListener() {
    assertTrue(source("OverlayComposer.kt").contains(
      "val view: View = BackKeyPanelLayout(context) { listener.onComposerBack() }.apply {",
    ))
    val contract = source("OverlayViewTypes.kt").substringAfter("interface OverlayComposerListener")
      .substringBefore("// ──")
    assertTrue("不能给默认空实现把漏接线变成静默失败", contract.contains("fun onComposerBack()\n"))
    assertFalse(contract.contains("fun onComposerBack() {"))
    assertFalse(source("OverlayComposer.kt").contains("setOnKeyListener"))
  }

  @Test
  fun backDispatchConsumesBothPhasesButCollapsesOnlyOnceOnUp() {
    var count = 0
    val layout = BackKeyPanelLayout(ContextWrapper(null)) { count += 1 }
    assertTrue(layout.dispatchPanelKey(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_DOWN))
    assertEquals(0, count)
    assertTrue(layout.dispatchPanelKey(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_UP))
    assertEquals(1, count)
    assertFalse(layout.dispatchPanelKey(KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_UP))
    assertEquals(1, count)
  }

  @Test
  fun cardWhiteHandleRetainsDownAndUpRawDeltaAndVerticalVelocity() {
    val source = source("OverlayCardView.kt")
    val down = branch(source, "DOWN", "MOVE")
    assertTrue(down.contains("listener.onCardHandleDrag(OverlayDragPhase.DOWN, 0f, 0f)"))
    val up = branch(source, "UP", "CANCEL")
    assertTrue(up.contains("val dy = ev.rawY - downRawY"))
    assertTrue(up.contains("t.computeCurrentVelocity(1000)"))
    assertTrue(up.contains("listener.onCardHandleDrag(OverlayDragPhase.UP, dy, releaseVelocity.resolve(t.yVelocity, ev.eventTime))"))
    assertFalse(up.contains("xVelocity"))
  }

  @Test
  fun negativeControlRejectsStaleMoveDeltaAndHorizontalFlingVelocity() {
    val source = source("OverlayPillView.kt")
    for (mutated in listOf(
      source.replace("OverlayDragPhase.UP, dx, dy, velocity", "OverlayDragPhase.UP, lastDx, lastDy, velocity"),
      source.replace("releaseVelocity.resolve(t?.yVelocity ?: 0f, ev.eventTime)", "releaseVelocity.resolve(t?.xVelocity ?: 0f, ev.eventTime)"),
    )) {
      var rejected = false
      try {
        assertPillUpContract(mutated)
      } catch (_: AssertionError) {
        rejected = true
      }
      assertTrue("受控回退必须被同一判据拒绝，不能产生假绿", rejected)
    }
  }

  @Test
  fun plusAndRowActionsDelegateDrawerStateToTheOrchestrator() {
    val composer = source("OverlayComposer.kt")
    val plus = composer.substringAfter("private val plusButton").substringBefore("private val input =")
    assertTrue(plus.contains("setOnClickListener { listener.onComposerToggleDrawer() }"))
    assertFalse(plus.contains("setDrawerOpen("))
    val render = composer.substringAfter("fun render(data:").substringBefore("fun inputText()")
    assertFalse("选中/附件回调不能把 V2 drawerMode 留在旧模式", render.contains("setDrawerOpen(false)"))
    assertTrue(source("OverlayViewTypes.kt").contains("fun onComposerToggleDrawer()\n"))
  }

  @Test
  fun drawerHeightIsBoundedAndTheViewportNotJustTheWindowCanScroll() {
    assertIndependentDrawerContract(source("OverlayComposer.kt"), source("OverlayCommandDrawer.kt"))
    val v2 = source("OverlayV2.kt")
    val sync = v2.substringAfter("private fun syncDrawerWindow()").substringBefore("private fun hideDrawer(")
    assertTrue("选择卡片必须交给独立窗口而非撑高输入根", sync.contains("windows.add(OverlayWindows.Slot.DRAWER, c.drawerView, lp)"))
    assertTrue(sync.contains("c.measureDrawerHeightPx(OverlayWindowFrames.composerWidthPx(screen))"))
    assertTrue(sync.contains("OverlayWindowFrames.availableHeightPx(screen) * .4f"))
  }

  @Test
  fun pendingAndThinkingScrollInsideCardSoHandleCannotBePushedOutByContent() {
    val card = source("OverlayCardView.kt")
    val body = card.substringAfter("private val scrollBody").substringBefore("private val scrollView")
    for (child in listOf("thinkingLine", "rowsColumn", "footerLine", "pendingColumn")) {
      assertTrue(child + " 必须在同一滚动体", body.contains("addView(" + child + ","))
    }
    val root = card.substringAfter("val view: View =").substringBefore("  init {")
    assertFalse(root.contains("addView(pendingColumn,"))
    assertFalse(root.contains("addView(thinkingLine,"))
    assertTrue(root.contains("addView(scrollView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))"))
    assertTrue(root.indexOf("addView(scrollView,") < root.indexOf("addView(handleHit,"))
  }

  @Test
  fun nonInputPresentationFocusesTheRootAndFadeInAlwaysResetsScale() {
    val composer = source("OverlayComposer.kt")
    val root = composer.substringAfter("val view: View =").substringBefore("private var busy")
    assertTrue(root.contains("isFocusableInTouchMode = true"))
    assertTrue(root.contains("descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS"))
    assertTrue(composer.contains("fun focusInput(canFocus: () -> Boolean = { true })"))
    val focusRoot = composer.substringAfter("fun focusRoot()").substringBefore("fun focusInput(")
    assertTrue(focusRoot.contains("input.clearFocus()"))
    assertTrue(focusRoot.contains("view.requestFocus()"))
    assertFalse(focusRoot.contains("showSoftInput"))
    val focusInput = composer.substringAfter("fun focusInput(canFocus: () -> Boolean = { true })").substringBefore("private fun applyActionButton()")
    val requestAt = focusInput.indexOf("input.requestFocus()")
    assertTrue("initial focus is attached and still owned", focusInput.indexOf("if (!view.isAttachedToWindow || !canFocus()) return") in 0 until requestAt)
    val deferred = focusInput.substringAfter("input.post {")
    assertTrue("deferred IME work rechecks attachment/focus/ownership before showing keyboard",
      deferred.indexOf("if (!view.isAttachedToWindow || !input.hasFocus() || !canFocus()) return@post") in
        0 until deferred.indexOf("imm?.showSoftInput("))
    val fade = source("OverlayPillView.kt").substringAfter("fun fadeIn()").substringBefore("fun fadeOutAndShrink(")
    val animationGate = fade.indexOf("if (!attached || !motionEnabled)")
    assertTrue(fade.indexOf("view.scaleX = 1f") in 0 until animationGate)
    assertTrue(fade.indexOf("view.scaleY = 1f") in 0 until animationGate)
  }

  @Test
  fun cancellingIndependentDrawerAnimationInvalidatesItsGenerationAndStaleEndAction() {
    assertDrawerCancellationContract(source("OverlayComposer.kt"))
    val v2 = source("OverlayV2.kt")
    val hide = v2.substringAfter("private fun hideDrawer(animated: Boolean)").substringBefore("private fun refreshComposerWindowHeight()")
    val generation = hide.indexOf("val generation = ++drawerWindowGeneration")
    val guard = hide.indexOf("if (generation == drawerWindowGeneration)")
    val remove = hide.indexOf("windows.remove(OverlayWindows.Slot.DRAWER)")
    assertTrue("关闭回调只能移除当前代次，不能误收重开的独立窗", generation >= 0 && guard > generation && remove > guard)
    assertTrue(hide.contains("c.animateDrawerOut(remove)"))
  }

  @Test
  fun gestureVelocityTracksScreenCoordinatesEvenWhenTheOverlayMoves() {
    for (name in listOf("OverlayPillView.kt", "OverlayCardView.kt")) {
      val source = source(name)
      val raw = source.substringAfter("private fun addRawMovement(").substringBefore("private fun withAlpha")
      assertTrue(name, raw.contains("val raw = MotionEvent.obtain(event)"))
      assertTrue(name, raw.contains("raw.offsetLocation(event.rawX - event.x, event.rawY - event.y)"))
      assertTrue(name, raw.contains("tracker.addMovement(raw)"))
      assertTrue(name, raw.contains("raw.recycle()"))
      assertFalse("不允许局部坐标与屏幕坐标混入同一 tracker", source.contains("addMovement(ev)"))
      assertTrue(branch(source, "DOWN", "MOVE").contains("addRawMovement(this, ev)"))
      assertTrue(branch(source, "UP", "CANCEL").contains("addRawMovement("))
    }
  }

  @Test
  fun allAnimatedViewsSubscribeOnlyWhileAttachedAndUnsubscribeOnDetach() {
    for (name in listOf("OverlayCardView.kt", "OverlayPillView.kt", "OverlayComposer.kt")) {
      val source = source(name)
      val attach = source.substringAfter("override fun onViewAttachedToWindow(v: View)")
        .substringBefore("override fun onViewDetachedFromWindow(v: View)")
      assertTrue(name, attach.contains("attached = true"))
      assertTrue(name, attach.contains("motionEnabled = DsUi.animationsEnabled(context)"))
      assertTrue(name, attach.contains("DsUi.registerMotionListener(context)"))
      val detach = source.substringAfter("override fun onViewDetachedFromWindow(v: View)")
        .substringBefore("    })")
      assertTrue(name, detach.contains("attached = false"))
      assertTrue(name, detach.contains("unregisterMotionListener?.invoke()"))
      assertTrue(name, detach.contains("unregisterMotionListener = null"))
    }
  }

  @Test
  fun cardRepeatedRenderKeepsTheSameRunningAnimationAndHiddenCardsCannotAnimate() {
    assertCardMotionContract(source("OverlayCardView.kt"))
    val source = source("OverlayCardView.kt")
    val apply = source.substringAfter("private fun applyRunningAnimation(data:")
      .substringBefore("private fun syncRunningAnimations()")
    assertFalse("每轮 render 不能无条件取消动画", apply.contains("stopRunningAnimations()"))
    assertFalse("每100ms render 不再重复查询系统设置", apply.contains("animationsEnabled(context)"))
    val stop = source.substringAfter("private fun stopRunningAnimations()")
      .substringBefore("private fun addRawMovement(")
    assertTrue(stop.contains("runningAnimationSignature = emptyList()"))
    assertTrue(stop.contains("animator.cancel()"))
    assertTrue(stop.contains("holder.dot.alpha = 1f"))
  }

  @Test
  fun pillFinishConsumesTheCurrentCallbackOnceAndDetachInvalidatesItWithoutCallingIt() {
    val pill = source("OverlayPillView.kt")
    val finish = pill.substringAfter("fun finishAnimations()").substringBefore("private fun cancelFiniteAnimation()")
    assertTrue(finish.contains("val alpha = finiteTargetAlpha ?: return"))
    assertTrue(finish.contains("val onEnd = finiteEnd"))
    assertTrue(finish.indexOf("cancelFiniteAnimation()") < finish.indexOf("onEnd?.invoke()"))
    assertTrue(finish.contains("view.alpha = alpha"))
    assertTrue(finish.contains("view.scaleX = scale"))
    val cancel = pill.substringAfter("private fun cancelFiniteAnimation()").substringBefore("fun setContentAlpha(")
    assertTrue(cancel.contains("animationGeneration += 1"))
    assertTrue(cancel.contains("finiteEnd = null"))
    assertTrue(cancel.contains("finiteTargetAlpha = null"))
    assertTrue(cancel.contains("view.animate().withEndAction(null).cancel()"))
    val detach = pill.substringAfter("override fun onViewDetachedFromWindow(v: View)").substringBefore("    })")
    assertTrue(detach.contains("cancelFiniteAnimation()"))
    assertFalse("detach 不能执行旧消散完成回调", detach.contains("finishAnimations()"))
    assertTrue(pill.contains("if (!motionEnabled) finishAnimations()"))
    val fade = pill.substringAfter("fun fadeOutAndShrink(").substringBefore("fun finishAnimations()")
    assertTrue(fade.contains("if (generation == animationGeneration) finishAnimations()"))
  }

  @Test
  fun composerDisablingMotionFinishesButDetachOnlyCancelsTheOldAnimator() {
    val composer = source("OverlayComposer.kt")
    assertComposerMotionContract(composer)
    assertDrawerCancellationContract(composer)
    assertTrue(composer.contains("if (!motionEnabled) finishAnimations()"))
    val finish = composer.substringAfter("fun finishAnimations()").substringBefore("fun setMaxDrawerHeightPx(")
    assertTrue(finish.contains("val alpha = drawerAnimationTargetAlpha ?: if (drawerOpen) 1f else 0f"))
    assertTrue(finish.contains("val onEnd = drawerAnimationEnd"))
    assertTrue(finish.indexOf("cancelDrawerAnimation()") in 0 until finish.indexOf("onEnd?.invoke()"))
    assertTrue(finish.contains("drawerView.alpha = alpha"))
    assertTrue(finish.contains("drawerView.translationY = translationY"))
    assertFalse("终态不逐帧撑高输入或重排窗口", finish.contains("onComposerLayoutChanged()"))
    assertFalse(finish.contains("layoutParams.height"))
    val detach = composer.substringAfter("override fun onViewDetachedFromWindow(v: View)").substringBefore("    })")
    assertTrue(detach.contains("cancelDrawerAnimation()"))
    assertFalse("detach是废弃旧回调，不执行旧关闭完成动作", detach.contains("finishAnimations()"))
  }

  @Test
  fun animationNegativeControlsRejectPerRenderRestartsAndPrematureDrawerCancellation() {
    val card = source("OverlayCardView.kt")
    val composer = source("OverlayComposer.kt")
    val checks: List<() -> Unit> = listOf(
      { assertCardMotionContract(card.replace("if (signature == runningAnimationSignature) return", "")) },
      { assertComposerMotionContract(composer.replace("if (open == drawerOpen) return", "")) },
      { assertDrawerCancellationContract(composer.replace("if (generation == drawerAnimationGeneration && attached) finishAnimations()", "finishAnimations()")) },
      { assertDrawerCancellationContract(composer.replace("drawerAnimationGeneration++", "// invalidation removed")) },
      { assertIndependentDrawerContract(composer.replace("addView(inputRow,", "addView(drawerView, LinearLayout.LayoutParams(1, 1))\n    addView(inputRow,"), source("OverlayCommandDrawer.kt")) },
      { assertIndependentDrawerContract(composer.replace("View.MeasureSpec.makeMeasureSpec(maxDrawerHeightPx, View.MeasureSpec.AT_MOST)", "View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)"), source("OverlayCommandDrawer.kt")) },
      { assertComposerMotionContract(composer + "\nValueAnimator.ofInt(0, 100) { layoutParams.height = it }") },
    )
    for (check in checks) {
      var rejected = false
      try {
        check()
      } catch (_: AssertionError) {
        rejected = true
      }
      assertTrue("重复render破坏动画幂等的受控负控必须被拒绝", rejected)
    }
  }

  @Test
  fun outsideInputDismissalKeepsTheIndependentTopRecordVisible() {
    assertInputOutsideContract(source("OverlayV2.kt"))
  }

  @Test
  fun idleStopsTheClockButKeepsTheTopRecordAndTranscript() {
    assertIdleRecordContract(source("OverlayV2.kt"), source("OverlayCardView.kt"))
  }

  @Test
  fun negativeControlsRejectOutsideClosingTheCardAndIdleErasingItsRecord() {
    val v2 = source("OverlayV2.kt")
    val card = source("OverlayCardView.kt")
    val checks: List<() -> Unit> = listOf(
      {
        val outside = inputOutsideBody(v2)
        val mutatedOutside = outside.replace("hideComposer()", "hideComposer(); hideCard()")
        assertTrue("负控必须改到实际outside收口", mutatedOutside != outside)
        assertInputOutsideContract(v2.replace(outside, mutatedOutside))
      },
      {
        val outside = inputOutsideBody(v2)
        val mutatedOutside = outside.replace("OverlayWindows.Slot.DRAWER", "OverlayWindows.Slot.COMPOSER")
        assertTrue("负控必须删掉实际sheet命中保护", mutatedOutside != outside)
        assertInputOutsideContract(v2.replace(outside, mutatedOutside))
      },
      { assertIdleRecordContract(v2.replace("if (running) startClockIfNeeded() else stopClock()", "if (running) startClockIfNeeded() else { stopClock(); hideCard() }"), card) },
      { assertIdleRecordContract(v2, card.replace("renderTranscript(data.transcript)", "renderTranscript(emptyList())")) },
    )
    for (check in checks) {
      var rejected = false
      try { check() } catch (_: AssertionError) { rejected = true }
      assertTrue("外部收输入/空闲保记录的受控回退必须变红", rejected)
    }
  }

  @Test
  fun sheetSurfaceCarriesItsOwnGrabHandleSoItReadsAsTheSameFamilyAsTheCard() {
    val drawer = source("OverlayCommandDrawer.kt")
    val content = drawer.substringAfter("private val contentColumn = LinearLayout(context).apply {")
      .substringBefore("private var maxHeightPx")
    assertTrue("sheet根必须有白条把手", content.contains("addView(grabHandleRow"))
    assertTrue("白条必须在附件瓦片之前", content.indexOf("grabHandleRow") < content.indexOf("addView(attachRow"))
    val handle = drawer.substringAfter("private val grabHandle = View(context).apply {").substringBefore("private val grabHandleRow")
    assertTrue("白条必须有tag便于原生dump取证", handle.contains("tag = \"overlay-drawer-handle\""))
    assertTrue("白条尺寸与卡片一致40x4dp", drawer.contains("FrameLayout.LayoutParams(dp(40), dp(4), Gravity.CENTER)"))
    assertFalse("白条不可点击，不吞瓦片触摸", handle.contains("setOnClickListener"))
  }

  private fun inputOutsideBody(source: String): String {
    val start = "  private fun onInputOutside(event: MotionEvent) {"
    assertTrue("outside入口必须存在", source.contains(start))
    val tail = source.substringAfter(start)
    val next = Regex("(?m)^  (?:private|internal) fun ").find(tail)
    assertTrue("outside函数边界必须存在", next != null)
    return tail.substring(0, requireNotNull(next).range.first)
  }

  private fun assertInputOutsideContract(source: String) {
    val outside = inputOutsideBody(source)
    assertTrue(outside.contains("if (event.actionMasked != MotionEvent.ACTION_OUTSIDE) return"))
    for (slot in listOf("CARD", "ENTRY", "PILL", "COMPOSER", "WORKSPACE", "SESSION", "DRAWER")) {
      assertTrue("点其他悬浮窗不算空白outside", outside.contains("OverlayWindows.Slot." + slot))
    }
    assertTrue(outside.contains(".any { containsTouch(it, x, y) }) return"))
    // One tap outside reaches every overlay window; acting twice would close the sheet AND then the
    // composer, so the handled tap must be remembered by downTime before any dismissal decision.
    val dedupe = outside.indexOf("if (event.downTime == outsideHandledDownTime) return")
    assertTrue("空白点击必须按downTime去重，否则一次点击连收两层", dedupe >= 0 && dedupe < outside.indexOf("hideComposer()"))
    assertTrue(outside.contains("outsideHandledDownTime = event.downTime"))
    // With the plus sheet open a blank tap closes only the sheet; the composer and its draft survive.
    val sheetDismiss = outside.indexOf("if (drawerMode != DrawerMode.NONE)")
    val composerHide = outside.indexOf("hideComposer()")
    assertTrue(
      "有加号卡片时空白先收卡片、不收起输入",
      sheetDismiss >= 0 && composerHide > sheetDismiss &&
        outside.substring(sheetDismiss, composerHide).contains("drawerMode = DrawerMode.NONE")
    )
    assertTrue(outside.contains("hideComposer()"))
    assertFalse("空白只收输入，不能顺手收顶部记录", outside.contains("hideCard()"))
    assertFalse(outside.contains("collapseToPill()"))
    val hide = source.substringAfter("internal fun hideComposer()").substringBefore("private fun syncDrawerWindow()")
    assertTrue(hide.contains("hideDrawer(false)"))
    assertTrue(hide.contains("hideSoftInputFromWindow"))
    assertTrue(hide.contains("windows.remove(OverlayWindows.Slot.COMPOSER)"))
    assertFalse(hide.contains("hideCard()"))
    assertFalse(hide.contains("OverlayWindows.Slot.CARD"))
  }

  private fun assertIdleRecordContract(v2: String, card: String) {
    val status = v2.substringAfter("internal fun onAgentStatus(").substringBefore("internal fun onEngineRunning(")
    assertTrue(status.contains("OverlayUiModel.onRuntimeStatus(model, running"))
    assertTrue(status.contains("if (running) startClockIfNeeded() else stopClock()"))
    assertTrue(status.contains("scheduleRender()"))
    assertFalse("结束运行不等于用户关闭记录", status.contains("hideCard()"))
    assertFalse(status.contains("collapseToPill()"))
    assertFalse(status.contains("windows.remove("))
    val clock = v2.substringAfter("private fun startClockIfNeeded()").substringBefore("private fun DSUiAnimationsEnabled()")
    assertTrue(clock.contains("model.agent != OverlayAgentState.RUNNING"))
    assertFalse("空闲只停时钟，不移除卡片", clock.contains("hideCard()"))
    val render = card.substringAfter("fun render(data: OverlayCardData)").substringBefore("fun measureContentHeightPx(")
    assertTrue("真实记录继续渲染，不能用空列表替掉", render.contains("renderTranscript(data.transcript)"))
    assertFalse(render.contains("renderTranscript(emptyList())"))
  }

  private fun assertCardMotionContract(source: String) {
    val sync = source.substringAfter("private fun syncRunningAnimations()").substringBefore("private fun stopRunningAnimations()")
    assertTrue(sync.contains("val signature = if (attached && motionEnabled) runningRows else emptyList()"))
    val guard = sync.indexOf("if (signature == runningAnimationSignature) return")
    assertTrue("相同签名必须在stop之前返回", guard >= 0 && guard < sync.indexOf("stopRunningAnimations()"))
    assertTrue(sync.contains("runningAnimationSignature = signature"))
  }

  private fun assertComposerMotionContract(source: String) {
    val update = source.substringAfter("fun setDrawerOpen(open: Boolean)").substringBefore("fun fadeDrawerIn()")
    val guard = update.indexOf("if (open == drawerOpen) return")
    assertTrue("重复同状态render不能取消正在完成的动画", guard >= 0 && guard < update.indexOf("cancelDrawerAnimation()"))
    val animate = source.substringAfter("private fun animateDrawerTo(").substringBefore("fun finishAnimations()")
    assertTrue(animate.contains("drawerView.animate().alpha(alpha).translationY(translationY).setDuration(durationMs)"))
    // 0ms（动效关闭）也走同一条同步终态路径，不允许「零时长动画」再补一帧。
    assertTrue(animate.contains("if (!attached || !motionEnabled || durationMs <= 0L) { finishAnimations(); return }"))
    assertFalse("选择卡片不再逐帧改高度", source.contains("ValueAnimator"))
    assertFalse(animate.contains("onComposerLayoutChanged()"))
    assertFalse(animate.contains("layoutParams.height"))
  }

  private fun assertDrawerCancellationContract(source: String) {
    val cancel = source.substringAfter("private fun cancelDrawerAnimation()").substringBefore("private fun withAlpha")
    assertTrue(cancel.contains("drawerAnimationGeneration++"))
    assertTrue(cancel.contains("drawerAnimationTargetAlpha = null"))
    assertTrue(cancel.contains("drawerAnimationEnd = null"))
    assertTrue(cancel.contains("drawerView.animate().withEndAction(null).cancel()"))
    val animate = source.substringAfter("private fun animateDrawerTo(").substringBefore("fun finishAnimations()")
    assertTrue(animate.contains("val generation = drawerAnimationGeneration"))
    assertTrue(animate.contains("if (generation == drawerAnimationGeneration && attached) finishAnimations()"))
    val reopen = source.substringAfter("fun fadeDrawerIn()").substringBefore("fun animateDrawerOut(")
    // 展开也必须先取消上一代动画再起新的（时长参数化后不再有 animateDrawerTo(1f, 0f, null) 这个字面）。
    val reopenStart = reopen.indexOf("animateDrawerTo(1f, 0f,")
    assertTrue(reopenStart >= 0)
    assertTrue(reopen.indexOf("cancelDrawerAnimation()") in 0 until reopenStart)
  }

  private fun assertIndependentDrawerContract(composer: String, drawer: String) {
    val root = composer.substringAfter("val view: View =").substringBefore("  init {")
    assertFalse("选择卡片不能成为输入根子节点", root.contains("addView(drawer"))
    assertFalse(composer.contains("private val drawerHost"))
    val independent = composer.substringAfter("val drawerView: View =").substringBefore("  val view: View =")
    assertTrue(independent.contains("addView(drawer.view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))"))
    val measure = composer.substringAfter("fun measureDrawerHeightPx(widthPx: Int)").substringBefore("fun isDrawerOpen()")
    assertTrue(measure.contains("View.MeasureSpec.makeMeasureSpec(widthPx.coerceAtLeast(0), View.MeasureSpec.EXACTLY)"))
    assertTrue(measure.contains("View.MeasureSpec.makeMeasureSpec(maxDrawerHeightPx, View.MeasureSpec.AT_MOST)"))
    assertTrue(measure.contains("drawerView.measuredHeight.coerceIn(0, maxDrawerHeightPx)"))
    assertFalse(measure.contains("View.MeasureSpec.UNSPECIFIED"))
    val setMax = composer.substringAfter("fun setMaxDrawerHeightPx(").substringBefore("fun measureDrawerHeightPx(")
    assertTrue(setMax.contains("maxHeightPx.coerceAtLeast(0)"))
    assertTrue(setMax.contains("drawer.setMaxHeightPx(next)"))
    val body = drawer.substringAfter("private val contentColumn").substringBefore("val view: View =")
    assertTrue(body.contains("addView(attachRow,"))
    assertTrue(body.contains("addView(listColumn,"))
    val viewport = drawer.substringAfter("val view: View =").substringBefore("private var lastSignature")
    assertTrue(viewport.startsWith(" object : ScrollView(context) {"))
    assertTrue(viewport.contains("override fun onMeasure("))
    assertTrue(viewport.contains("minOf(maxHeightPx, parentSize)"))
    assertTrue(viewport.contains("View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST)"))
    assertTrue(viewport.contains("addView(contentColumn,"))
  }

  private fun assertPillUpContract(source: String) {
    val up = branch(source, "UP", "CANCEL")
    assertTrue("UP 不能复用最后一个 MOVE 的 delta", up.contains("val dx = ev.rawX - downRawX"))
    assertTrue(up.contains("val dy = ev.rawY - downRawY"))
    assertTrue(up.contains("t?.let { addRawMovement(it, ev) }"))
    assertTrue(up.contains("t?.computeCurrentVelocity(1000)"))
    assertTrue("消散速度固定为 y，负 vx 不是上推", up.contains("val velocity = releaseVelocity.resolve(t?.yVelocity ?: 0f, ev.eventTime)"))
    assertFalse(up.contains("xVelocity"))
    assertTrue(up.contains("listener.onPillDrag(OverlayDragPhase.UP, dx, dy, velocity)"))
    assertFalse(up.contains("OverlayDragPhase.UP, lastDx, lastDy"))
  }

  private fun branch(source: String, action: String, next: String?): String {
    val start = source.indexOf("MotionEvent.ACTION_" + action + " -> {")
    require(start >= 0) { "找不到触摸分支 " + action }
    val tail = source.substring(start)
    return if (next == null) tail.substringBefore("else -> false") else
      tail.substringBefore("MotionEvent.ACTION_" + next + " -> {")
  }

  @Test fun pillStatusTextCrossfadesOnlyForChangesAndInvalidatesLateCallbacks() {
    val pill = source("OverlayPillView.kt")
    val render = pill.substringAfter("fun render(text:").substringBefore("fun measureContentWidthPx")
    assertTrue(render.contains("if (measuredText != next)"))
    // 时长从 OverlayMotionSpec 取（不再写死 60L），仍保持「先退旧文案、再进新文案」的两段结构。
    assertTrue(render.contains("label.animate().alpha(0f).setDuration(OverlayMotionSpec.labelOutMs(reduced = false))"))
    assertTrue(render.contains("generation != textGeneration || !attached"))
    assertTrue(render.contains("label.animate().alpha(1f).setDuration(OverlayMotionSpec.labelInMs(reduced = false))"))
    assertTrue(pill.substringAfter("fun finishAnimations()").substringBefore("private fun cancelFiniteAnimation()").contains("finishTextTransition()"))
    assertTrue(pill.substringAfter("override fun onViewDetachedFromWindow").substringBefore("    })").contains("finishTextTransition()"))
  }


  /**
   * 首次挂载不得把持久化下来的 0 当成「用户选定的顶部」。
   *
   * 真因（2026-11-13 设备实测）：stripPlacement/clampPillY 的下界是 0（design.md §9.1 R9
   * 「顶部不自动隐藏」），而 entryX/entryY 的 0 同时又是「从没摆过位置」的哨兵。两者撞在
   * 一起时，一条全新细条会正好停在 y=0 —— 状态栏那条系统窗口占据的触摸死区里，于是入口
   * 完全点不动，只能 force-stop 才恢复。判据：两个分支都必须先算出 initialEntry 哨兵，
   * 且细条分支必须把非哨兵情况才使用持久化 y。
   */
  @Test fun firstMountNeverParksTheEntryInsideTheStatusBarTouchDeadZone() {
    val v2 = source("OverlayV2.kt")
    val body = v2.substringAfter("private fun showEntry(").substringBefore("attachEntryTouch(")
    assertTrue(body.contains("val initialEntry = entryX == 0 && entryY == 0"))
    // 哨兵必须在两个分支之前算出来，否则球/条会各写一份判据并再次漂移。
    assertTrue(body.indexOf("val initialEntry") < body.indexOf("if (styleEnum == OverlayEntryStyle.STRIP)"))
    assertTrue(body.contains("if (initialEntry) s.heightPx / 3 else entryY"))
    assertTrue(body.contains("if (initialEntry) {"))
  }

  private fun source(name: String): String {
    val rel = "app/src/main/java/com/dsharnessmobile/shell/" + name
    var root = java.io.File(System.getProperty("user.dir")).absoluteFile
    while (!java.io.File(root, rel).isFile) {
      root = root.parentFile ?: error("找不到仓库根：" + rel)
    }
    return java.io.File(root, rel).readText()
  }
}
