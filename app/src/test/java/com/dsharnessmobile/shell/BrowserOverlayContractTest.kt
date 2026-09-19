package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 覆盖层可见性判据的**调用点契约**（纯 JVM 行为测试覆盖不到 Activity/View）。
 *
 * 用户实报「收起侧边栏浏览器不卸载」的存活条件是三处同源缺陷：
 *   1. `applyVisibility()` 只认粘滞记忆态（已修：改走 [BrowserOverlayPolicy] 并带保鲜期）；
 *   2. `setStageBounds()` 不记录「发布者刚刚说过话」的时刻（保鲜期的唯一数据来源）；
 *   3. `hide()` 只清 `requestedVisible`，把 `stageVisible` 留成 true（下次 switchTo 直接复活）。
 * 任何一处被改回旧写法，幽灵覆盖层就复活，而设备上的表现是「用户收起侧栏，浏览器还在」。
 * 这里对源码断言调用点，撤掉修复即变红。
 */
class BrowserOverlayContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（形态名出现在注释里不算命中——与门禁只看代码的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  @Test
  fun applyVisibilityGoesThroughTheFreshnessPolicy() {
    val body = memberBody(codeOnly(source("BrowserHost.kt")), "private fun applyVisibility()")
    assertTrue(
      "可见性判据必须走 BrowserOverlayPolicy.visible（带保鲜期），不得回退成粘滞布尔量的裸合取",
      body.contains("BrowserOverlayPolicy.visible("),
    )
    assertTrue(
      "必须把发布者年龄传进判据（否则保鲜期恒 0 = 永远新鲜）",
      body.contains("BrowserOverlayPolicy.boundsAge("),
    )
    assertFalse(
      "不得再出现 0.14.0 的裸合取（requestedVisible && stageVisible 是粘滞记忆态）",
      body.contains("workspace.requestedVisible && workspace.stageVisible"),
    )
  }

  @Test
  fun stageBoundsPublishStampsTheFreshnessClock() {
    val body = memberBody(codeOnly(source("BrowserHost.kt")), "fun setStageBounds(raw: String)")
    assertTrue("每次可信 bounds 下推都必须刷新 boundsAt（保鲜期的唯一数据来源）",
      body.contains("boundsAt = SystemClock.uptimeMillis()"))
  }

  @Test
  fun hideClearsBothHalvesOfTheVisibilityMemory() {
    val body = memberBody(codeOnly(source("BrowserHost.kt")), "fun hide(): String")
    assertTrue("hide 必须清 requestedVisible", body.contains("requestedVisible = false"))
    assertTrue(
      "hide 必须同时清 stageVisible：只清一半会让下一次 switchTo 在没有任何在场 UI 时复活覆盖层",
      body.contains("stageVisible = false"),
    )
  }

  @Test
  fun freshnessWatchdogExistsAndIsScheduled() {
    val src = codeOnly(source("BrowserHost.kt"))
    assertTrue("必须有保鲜看门狗（发布者消失本身不产生任何事件）",
      src.contains("val boundsWatchdog = object : Runnable"))
    assertTrue("看门狗必须自续期，否则只查一次",
      src.contains("root.postDelayed(this, BrowserOverlayPolicy.STAGE_BOUNDS_WATCHDOG_MS)"))
    assertTrue("覆盖层在场时才挂表",
      src.contains("root.postDelayed(boundsWatchdog, BrowserOverlayPolicy.STAGE_BOUNDS_WATCHDOG_MS)"))
    assertTrue("Activity 退场必须摘表，避免 root/View 泄漏",
      src.contains("root.removeCallbacks(boundsWatchdog)"))  }
}
