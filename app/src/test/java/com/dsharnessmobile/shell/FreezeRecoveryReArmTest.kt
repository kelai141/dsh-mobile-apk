package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1355 回归：冻结自愈必须能「重新武装」。
 *
 * 缺陷形态：`freezeReloaded` 置位后没有任何复位点——同一进程内第二次渲染进程冻结只落一行日志、
 * 不 reload，界面永久停在 Loading，除杀进程没有出口。
 *
 * 判据落在「复位点在应答回调里、且不在 startFreezeWatchdog 里」：
 * 后者由 `onPageFinished` 调用，文档加载完就触发，此时 JS 可能仍然死着——在那里复位会变成
 * reload → onPageFinished → 复位 → 再判冻结 → 再 reload 的循环。
 */
class FreezeRecoveryReArmTest {

  private fun source(): String =
    File(File("src/main/java/com/dsharnessmobile/shell"), "EngineStartFlow.kt").readText()

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun `页面应答回来必须复位冻结自愈闸门`() {
    val code = codeOnly(source())
    val ack = code.substringAfter("activity.webView.evaluateJavascript(\"1\")")
      .substringBefore("} catch (_: Exception)")
    assertTrue("应答回调里必须复位 freezeReloaded", ack.contains("freezeReloaded = false"))
  }

  @Test
  fun `不得在 startFreezeWatchdog 里复位`() {
    val code = codeOnly(source())
    val fn = code.substringAfter("fun startFreezeWatchdog()").substringBefore("fun startUpdateCheck()")
    assertTrue("找不到 startFreezeWatchdog()", fn.isNotEmpty())
    assertFalse(
      "onPageFinished 只代表文档加载完，在那里复位会造成 reload 循环",
      fn.contains("freezeReloaded = false"),
    )
  }

  @Test
  fun `置位与复位必须成对存在`() {
    val code = codeOnly(source())
    assertEquals(
      "freezeReloaded = false 只应有两处：字段声明 + 应答回调里的复位",
      2,
      Regex("freezeReloaded = false").findAll(code).count(),
    )
    assertEquals(
      "置位点应恰好一处（检测到冻结时）",
      1,
      Regex("freezeReloaded = true").findAll(code).count(),
    )
  }
}
