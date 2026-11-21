package com.dsharnessmobile.shell

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackGateTest {
  @Test
  fun pageLayersTakePrecedenceOverAvailableHistory() {
    for (result in listOf("\"handled\"", "\"blocked\"", null, "\"unexpected\"")) {
      assertEquals(BackDecision.CONSUME, BackGate.decide(canGoBack = true, pageResult = result))
    }
  }

  @Test
  fun confirmedRootUsesHistoryThenActivityDefault() {
    assertEquals(BackDecision.GO_BACK_HISTORY, BackGate.decide(true, "\"root\"", legacyAvailable = true))
    assertEquals(BackDecision.FINISH_ACTIVITY, BackGate.decide(false, "\"root\""))
  }

  @Test
  fun absentControllerHonorsTheLegacySignal() {
    assertEquals(BackDecision.CONSUME, BackGate.decide(true, "\"unavailable\"", legacyAvailable = true))
    assertEquals(BackDecision.GO_BACK_HISTORY, BackGate.decide(true, "\"unavailable\""))
    assertEquals(BackDecision.FINISH_ACTIVITY, BackGate.decide(false, "\"unavailable\""))
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
