package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * §3.3 设置页/开发者选项族（0.14.1 批 9）在**壳侧**的判据。
 *
 * 本批的壳侧改动只有一处，但它决定页面上「重启中…」是真是假：重启入口必须**如实回报是否发起了重启**，
 * 而不是旧签名的 void（页面只能假装忙碌两秒再自己变回）。
 */
class DevActionsBatch9Test {

  private fun source(relative: String): String {
    val candidates = listOf(File(relative), File("app/$relative"))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 $relative（工作目录 = " + File(".").absolutePath + "）")
    return file.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun restartReportsWhetherItActuallyStarted() {
    val flow = codeOnly(source("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt"))
    assertTrue("start 必须回 Boolean（页面据此决定要不要进忙碌态）", flow.contains("fun restart(): Boolean"))
    assertTrue("已在重启中必须如实回 false", flow.contains("compareAndSet(false, true)) return false"))
    assertTrue("真的发起了才回 true", flow.contains("return true"))

    val bridge = codeOnly(source("src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt"))
    assertTrue("桥面签名必须是 Boolean（#686 起入口先过顶层帧门禁，委托链不变）", bridge.contains("fun restartEngine(): Boolean = trusted { onRestartEngine() }"))
    assertTrue("回调类型必须是 Boolean（不得退回 Unit/未接线桩）", bridge.contains("private val onRestartEngine: () -> Boolean"))
    // 默认实现刻意是 fail-closed 的空桩（未接线时回 false ⇒ 页面如实说「没发起」，而不是假忙碌）。
    // 真正的接线判据在下一条：MainActivity 必须把真源传进去（否则上面的桩就会一直是答案）。

    val main = codeOnly(source("src/main/java/com/dsharnessmobile/shell/MainActivity.kt"))
    assertTrue("启动流必须接上真源", main.contains("onRestartEngine = { engineFlow.restart() }"))
  }
}
