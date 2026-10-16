package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleThemeSourceTest {
  private fun find(relative: String): File = listOf(File(relative), File("app/$relative"))
    .firstOrNull { it.isFile } ?: throw AssertionError("找不到源码 $relative")

  @Test
  fun consoleUsesTheShellDayNightPaletteAndCompactControls() {
    val html = find("src/main/assets/console.html").readText()
    assertTrue(html.contains("@media (prefers-color-scheme: dark)"))
    assertTrue(html.contains("--ds-bg: #F5F5F7"))
    assertTrue(html.contains("--ds-bg: #000000"))
    assertTrue(html.contains("--ds-radius: 8px"))
    assertFalse(html.contains("#3DDBCA"))
    assertFalse(html.contains("#5EEAD4"))
    assertFalse(html.contains("radial-gradient"))
  }

  @Test
  fun consoleKeepsItsWorkingControlsAndKeyboardInsetContract() {
    val html = find("src/main/assets/console.html").readText()
    for (id in listOf("close", "enginePill", "copyBtn", "clearBtn", "restartBtn", "output", "chips", "cmd", "send")) {
      assertTrue("console control #$id must remain", html.contains("id=\"$id\""))
    }
    assertTrue(html.contains("window.__consoleInsets = function (top, bottom, ime)"))
    assertTrue(html.contains("window.consoleBridge.submit(text)"))
  }

  @Test
  fun nativeConsoleBarsFollowTheSameDayNightBackground() {
    val activity = find("src/main/java/com/dsharnessmobile/shell/ConsoleActivity.kt").readText()
    assertTrue(activity.contains("window.statusBarColor = getColor(R.color.ds_bg)"))
    assertTrue(activity.contains("window.navigationBarColor = getColor(R.color.ds_bg)"))
    assertTrue(activity.contains("setBackgroundColor(getColor(R.color.ds_bg))"))
    assertTrue(activity.contains("isAppearanceLightStatusBars = !isNight"))
    assertTrue(activity.contains("isAppearanceLightNavigationBars = !isNight"))
  }
}
