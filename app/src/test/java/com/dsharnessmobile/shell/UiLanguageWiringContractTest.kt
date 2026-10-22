package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Call-site contracts for the engine -> shell language direction.
 *
 * The failure mode is wiring, not logic: the engine settings row stores the
 * preference through the bridge, but the native startup page is built once per
 * activity. Without a rebuild on its next appearance the shell keeps the old
 * language until a cold start.
 */
class UiLanguageWiringContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name)
    return file.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun guideAppearanceRebuildsAStaleLanguage() {
    val code = codeOnly(source("MainActivity.kt"))
    val start = code.indexOf("internal fun showGuide")
    assertTrue("showGuide must exist", start >= 0)
    val body = code.substring(start, minOf(start + 600, code.length))
    assertTrue("启动页出现前必须检查语言是否已变", body.contains("refreshUiLanguageIfChanged()"))
    val helper = code.indexOf("private fun refreshUiLanguageIfChanged")
    assertTrue("refresh helper must exist", helper >= 0)
    val helperBody = code.substring(helper, minOf(helper + 600, code.length))
    assertTrue("必须读取当前偏好", helperBody.contains("AppLanguage.mode(this)"))
    assertTrue("必须重建 Activity", helperBody.contains("recreate()"))
  }

  @Test
  fun onCreateRecordsTheAppliedLanguage() {
    val code = codeOnly(source("MainActivity.kt"))
    val create = code.indexOf("override fun onCreate")
    assertTrue(create >= 0)
    val body = code.substring(create, minOf(create + 800, code.length))
    assertTrue("必须在创建时记录视图树语言", body.contains("appliedUiLanguage = AppLanguage.mode(this)"))
  }

  @Test
  fun bridgeSetterStoresAndSyncsTheProfile() {
    val code = codeOnly(source("MainActivity.kt"))
    val start = code.indexOf("onSetUiLanguage = {")
    assertTrue("bridge setter must exist", start >= 0)
    val body = code.substring(start, minOf(start + 300, code.length))
    assertTrue("必须保存壳偏好", body.contains("setMode"))
    assertTrue("必须同步 dsh profile", body.contains("syncDshLocale"))
  }
}
