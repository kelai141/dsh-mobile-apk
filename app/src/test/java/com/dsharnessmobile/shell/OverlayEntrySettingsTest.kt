package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Bridge behavior and settings wiring; actual overlay geometry/lifecycle still needs device tests. */
class OverlayEntrySettingsTest {
  @Test
  fun trustedSettingsReadAndWriteTheSamePreferenceWithoutEnablingTheOverlay() {
    var stored = "ball"
    var enableCalls = 0
    val writes = mutableListOf<String>()
    val bridge = AndroidBridge(
      { _ -> }, { _ -> }, { _, _ -> },
      isTrustedTopFrame = { true },
      onGetOverlayEntryStyle = { stored },
      onSetOverlayEntryStyle = { shape -> writes += shape; stored = shape; stored },
      onSetOverlayEnabled = { enableCalls += 1; true },
    )
    assertEquals("ball", bridge.getOverlayEntryStyle())
    assertEquals("strip", bridge.setOverlayEntryStyle("strip"))
    assertEquals("strip", bridge.getOverlayEntryStyle())
    assertEquals("ball", bridge.setOverlayEntryStyle("ball"))
    assertEquals(listOf("strip", "ball"), writes)
    assertEquals("shape selection must not turn on the service", 0, enableCalls)
  }

  @Test
  fun setterReturnsTheDelegateReadbackRatherThanEchoingTheRequestedShape() {
    val bridge = AndroidBridge(
      { _ -> }, { _ -> }, { _, _ -> },
      isTrustedTopFrame = { true },
      onGetOverlayEntryStyle = { "ball" },
      onSetOverlayEntryStyle = { "ball" },
    )
    assertEquals("ball", bridge.setOverlayEntryStyle("strip"))
    assertEquals("ball", bridge.getOverlayEntryStyle())
  }

  @Test
  fun untrustedFramesCannotReadOrMutateTheShape() {
    var calls = 0
    val bridge = AndroidBridge(
      { _ -> }, { _ -> }, { _, _ -> },
      onGetOverlayEntryStyle = { calls += 1; "ball" },
      onSetOverlayEntryStyle = { calls += 1; "strip" },
    )
    expectDenied { bridge.getOverlayEntryStyle() }
    expectDenied { bridge.setOverlayEntryStyle("strip") }
    assertEquals("origin guard must run before either delegate", 0, calls)
  }

  @Test
  fun settingsWiringKeepsExistingPreferenceAndAppliesOnlyThroughTheV2Owner() {
    val source = source("MainActivity.kt")
    assertTrue(source.contains("onGetOverlayEntryStyle = { OverlayV2.entryStyle(this) }"))
    val write = source.substringAfter("onSetOverlayEntryStyle = { requested ->")
      .substringBefore("onGetScreenScope =")
    assertTrue("unknown inputs must not overwrite an existing preference", write.contains(
      "if (requested == OverlayV2.STYLE_BALL || requested == OverlayV2.STYLE_STRIP)",
    ))
    assertTrue(write.contains("OverlayV2.prefs(this).edit().putString(OverlayV2.KEY_ENTRY_STYLE, requested).apply()"))
    assertTrue("JS bridge threads cannot mutate WindowManager views", write.contains(
      "runOnUiThread { OverlayService.instance?.v2?.onEntryStyleChanged() }",
    ))
    assertTrue("return the preference readback after any accepted/rejected request", write.contains("          OverlayV2.entryStyle(this)\n        },"))
    assertFalse("never change the staged rollout from a shape setting", write.contains("KEY_ENTRY_UI_V2"))
    assertFalse("shape selection is not a service permission/enable action", write.contains("OverlayController"))
    assertFalse(write.contains("startService("))
    assertFalse(write.contains("stopService("))
  }

  @Test
  fun newBridgeMethodsStaySymmetricWithTheTypedSettingsSurface() {
    val kotlin = source("AndroidBridge.kt")
    val types = file("../dsh-client-ui-responsive/src/client/android-bridge.ts").readText()
    assertTrue(kotlin.contains("fun getOverlayEntryStyle(): String = trusted { onGetOverlayEntryStyle() }"))
    assertTrue(kotlin.contains("fun setOverlayEntryStyle(style: String): String = trusted { onSetOverlayEntryStyle(style) }"))
    assertTrue(types.contains("getOverlayEntryStyle?: () => 'ball' | 'strip'"))
    assertTrue(types.contains("setOverlayEntryStyle?: (style: 'ball' | 'strip') => 'ball' | 'strip'"))
  }

  private fun expectDenied(block: () -> Unit) {
    try {
      block()
      fail("untrusted frame must not reach entry preference")
    } catch (_: AndroidBridge.BridgeFrameDenied) {
      // Expected: no preference delegate was called.
    }
  }

  private fun source(name: String): String = file("src/main/java/com/dsharnessmobile/shell/$name").readText()

  private fun file(path: String): File = sequenceOf(File(path), File("app", path))
    .first { it.isFile }
}
