package com.dsharnessmobile.shell

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BackGate: the three-input back decision (cross-document history / page layer stack / neither),
 * the page-script contracts, the cached signal, and the bridge's set/get symmetry.
 *
 * The decision is a pure function on purpose: the shell's back callback must decide
 * synchronously, so the only testable unit is "given these two booleans, which branch",
 * not a WebView.
 */
class BackGateTest {

  // ── 三分支：跨文档历史 / 页面层栈 / 都没有（IX-BG-13）────────────────────────

  @Test
  fun crossDocumentHistoryTakesTheHistoryBranch() {
    assertEquals(BackDecision.GO_BACK_HISTORY, BackGate.decide(canGoBack = true, pageStackAvailable = false))
    assertTrue(BackGate.consumed(BackDecision.GO_BACK_HISTORY))
  }

  @Test
  fun pageLayerStackDispatchesToThePageAndConsumes() {
    assertEquals(BackDecision.DISPATCH_PAGE_STACK, BackGate.decide(canGoBack = false, pageStackAvailable = true))
    assertTrue(BackGate.consumed(BackDecision.DISPATCH_PAGE_STACK))
  }

  @Test
  fun neitherInputFinishesTheActivity() {
    assertEquals(BackDecision.FINISH_ACTIVITY, BackGate.decide(canGoBack = false, pageStackAvailable = false))
    assertFalse(BackGate.consumed(BackDecision.FINISH_ACTIVITY))
  }

  /** IX-BG-11：历史优先于层栈，写反即拒合。 */
  @Test
  fun historyOutranksThePageStack() {
    assertEquals(BackDecision.GO_BACK_HISTORY, BackGate.decide(canGoBack = true, pageStackAvailable = true))
  }

  // ── 页面脚本契约 ──────────────────────────────────────────────────────────

  /** 入口名与 && 短路是页面侧的契约（注入层暴露 window.__dshBack）。 */
  @Test
  fun dispatchScriptPinsThePageEntry() {
    assertEquals("window.__dshBack && window.__dshBack()", BackGate.DISPATCH_SCRIPT)
  }

  @Test
  fun depthScriptReadsThePublishedGlobal() {
    assertEquals("window.__dshBackDepth|0", BackGate.READ_DEPTH_SCRIPT)
  }

  @Test
  fun parseDepthAcceptsJsonTextAndDegradesToZero() {
    assertEquals(2, BackGate.parseDepth("\"2\""))
    assertEquals(2, BackGate.parseDepth("2"))
    assertEquals(0, BackGate.parseDepth("0"))
    assertEquals(3, BackGate.parseDepth("  3  "))
    assertEquals(0, BackGate.parseDepth("null"))
    assertEquals(0, BackGate.parseDepth("\"null\""))
    assertEquals(0, BackGate.parseDepth(""))
    assertEquals(0, BackGate.parseDepth("-1"))
    assertEquals(0, BackGate.parseDepth("abc"))
    assertEquals(0, BackGate.parseDepth(null))
  }

  // ── 缓存（onPageStarted 复位 / 桥上报 / onPageFinished 拉平）────────────────

  @Test
  fun stateStartsUnavailable() {
    val state = BackGateState()
    assertFalse(state.pageStackAvailable)
    assertEquals(0, state.pageStackDepth)
  }

  @Test
  fun bridgeSignalMovesTheCache() {
    val state = BackGateState()
    state.onSignal(true)
    assertTrue(state.pageStackAvailable)
    state.onSignal(false)
    assertFalse(state.pageStackAvailable)
    assertEquals(0, state.pageStackDepth)
  }

  @Test
  fun pageStartInvalidatesThePreviousDocument() {
    val state = BackGateState()
    state.onSignal(true)
    state.onPageFinished(4)
    state.onPageStarted()
    assertFalse(state.pageStackAvailable)
    assertEquals(0, state.pageStackDepth)
  }

  @Test
  fun pageFinishPullSetsAvailabilityFromDepth() {
    val state = BackGateState()
    state.onPageFinished(0)
    assertFalse(state.pageStackAvailable)
    state.onPageFinished(3)
    assertTrue(state.pageStackAvailable)
    assertEquals(3, state.pageStackDepth)
    state.onPageFinished(0)
    assertFalse(state.pageStackAvailable)
  }

  // ── 桥面对称性：setAvailable / getBackAvailable 成对且都带 @JavascriptInterface ──

  @Test
  fun bridgeSetterAndGetterArePaired() {
    val state = BackGateState()
    val bridge = BackGateBridge(state)
    assertFalse(bridge.getBackAvailable())
    bridge.setAvailable(true)
    assertTrue(bridge.getBackAvailable())
    bridge.setAvailable(false)
    assertFalse(bridge.getBackAvailable())
  }

  @Test
  fun everyBridgeMethodIsExposedToThePage() {
    val setter = BackGateBridge::class.java.getMethod("setAvailable", java.lang.Boolean.TYPE)
    val getter = BackGateBridge::class.java.getMethod("getBackAvailable")
    assertTrue(setter.isAnnotationPresent(JavascriptInterface::class.java))
    assertTrue(getter.isAnnotationPresent(JavascriptInterface::class.java))
  }
}
