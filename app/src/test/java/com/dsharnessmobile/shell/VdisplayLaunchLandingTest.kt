package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 跨屏拉起的**落点回读**判据（C1；0.14.1 设备实测缺陷）。
 *
 * 缺陷形态：`am start --display <id>` 的**退出码 0 不等于落在目标屏**——设备实测「目标包已在真实屏
 * 有 task」时它仍回 0，同时打印 `Warning: Activity not started, intent has been delivered to
 * currently running top-most instance.`，而修复前的壳侧在这条路径上无条件报「已拉起到 virtual-N；
 * 真实屏前台不变」。用户的「在虚拟屏里启动软件却跳到真实屏」正是它。
 *
 * 回读因此必须落在**设备事实**上：按 displayId 分组解析该包的 ActivityRecord。
 * 样本取自 MuMu x86_64 / API 35 的真实 `dumpsys activity activities` 输出。
 */
class VdisplayLaunchLandingTest {

  /** 真实样本：包只在 Display #2（虚拟屏）上，Display #0 只有别的应用。 */
  private val onlyOnVirtual = listOf(
    "Display #0 (activities from top to bottom):",
    "    mLastPausedActivity: ActivityRecord{201876071 u0 com.dsharnessmobile.shell/.MainActivity t489}",
    "    topResumedActivity=ActivityRecord{201876071 u0 com.dsharnessmobile.shell/.MainActivity t489}",
    "    * Hist  #0: ActivityRecord{201876071 u0 com.dsharnessmobile.shell/.MainActivity t489}",
    "Display #2 (activities from top to bottom):",
    "  * Task{52b1f90 #493 type=standard A=10051:com.endday.game U=0 visible=true mode=fullscreen sz=1}",
    "    topResumedActivity=ActivityRecord{193219155 u0 com.endday.game/com.godot.game.GodotApp t493}",
    "    * Hist  #0: ActivityRecord{193219155 u0 com.endday.game/com.godot.game.GodotApp t493}",
  ).joinToString("\n")

  @Test
  fun packageOnVirtualDisplayIsReported() {
    assertEquals(setOf(2), VdisplayController.displaysRunning("com.endday.game", onlyOnVirtual))
  }

  @Test
  fun packageAbsentYieldsEmptySet() {
    assertTrue(
      "读不到该包必须是空集（调用方据此报「回读不可用」，绝不据此判成功）",
      VdisplayController.displaysRunning("com.absent.app", onlyOnVirtual).isEmpty(),
    )
  }

  /**
   * Task 行的 `A=10051:com.endday.game` 是 **affinity**，不是落点：只有 Task 行提到该包时
   * 不得报告任何屏——拿 affinity 判会得出错误结论，这正是回读要避开的陷阱。
   */
  @Test
  fun affinityMentionAloneIsNotEvidence() {
    val affinityOnly = listOf(
      "Display #2 (activities from top to bottom):",
      "  * Task{52b1f90 #493 type=standard A=10051:com.endday.game U=0 sz=1}",
      "    Affinity: com.endday.game",
    ).joinToString("\n")
    assertTrue(
      "只有 affinity/Task 行时不得报落点",
      VdisplayController.displaysRunning("com.endday.game", affinityOnly).isEmpty(),
    )
  }

  /** 前缀安全：`com.x` 不得被 `com.xy/.MainActivity` 命中（判据是 `包名/` 精确前缀）。 */
  @Test
  fun packagePrefixDoesNotMatch() {
    val other = listOf(
      "Display #0 (activities from top to bottom):",
      "    topResumedActivity=ActivityRecord{1 u0 com.xy/.MainActivity t1}",
      "    topResumedActivity=ActivityRecord{2 u0 com.x2/com.x2.Main t2}",
    ).joinToString("\n")
    assertTrue(VdisplayController.displaysRunning("com.x", other).isEmpty())
  }

  /** 同一包出现在两块屏（例如已在真实屏有 task 又被请求拉到虚拟屏）→ 两块都要报出来。 */
  @Test
  fun packageOnBothDisplaysIsReported() {
    val both = listOf(
      "Display #0 (activities from top to bottom):",
      "    topResumedActivity=ActivityRecord{1 u0 com.endday.game/com.godot.game.GodotApp t1}",
      "Display #2 (activities from top to bottom):",
      "    topResumedActivity=ActivityRecord{2 u0 com.endday.game/com.godot.game.GodotApp t2}",
    ).joinToString("\n")
    assertEquals(setOf(0, 2), VdisplayController.displaysRunning("com.endday.game", both))
  }

  /** 空输入 / 无 Display 分组 / 空包名都不得抛，也不得凭空报落点。 */
  @Test
  fun malformedInputsFailClosed() {
    assertTrue(VdisplayController.displaysRunning("com.endday.game", "").isEmpty())
    assertTrue(
      "没有 Display # 分组锚点时不得猜屏号",
      VdisplayController.displaysRunning(
        "com.endday.game",
        "    topResumedActivity=ActivityRecord{193219155 u0 com.endday.game/com.godot.game.GodotApp t493}",
      ).isEmpty(),
    )
    assertTrue(VdisplayController.displaysRunning("", onlyOnVirtual).isEmpty())
  }

  @Test
  fun transportSelectionKeepsShizukuIsolatedAndRoutesRootPlans() {
    assertEquals("shizuku", VdisplayController.resolveTransport("shizuku", directSuReady = true, shizukuOk = true))
    assertEquals("shizuku", VdisplayController.resolveTransport("shizuku", directSuReady = true, shizukuOk = false))
    assertEquals("su", VdisplayController.resolveTransport("root", directSuReady = true, shizukuOk = true))
    assertEquals("shizuku-root", VdisplayController.resolveTransport("root", directSuReady = false, shizukuOk = true))
    assertEquals("shizuku", VdisplayController.resolveTransport(null, directSuReady = true, shizukuOk = true))
    assertEquals("su", VdisplayController.resolveTransport(null, directSuReady = true, shizukuOk = false))
    assertEquals("'com.example.app/.Main'", VdisplayController.shellQuote("com.example.app/.Main"))
    assertEquals("'a'\\''b'", VdisplayController.shellQuote("a'b"))
  }

  @Test fun overlayDisplaySettingDetectionDistinguishesActiveFromClearedValues() {
    assertFalse(VdisplayController.isOverlayDisplaySettingActive(null))
    assertFalse(VdisplayController.isOverlayDisplaySettingActive(""))
    assertFalse(VdisplayController.isOverlayDisplaySettingActive("   "))
    assertFalse(VdisplayController.isOverlayDisplaySettingActive("null"))
    assertFalse(VdisplayController.isOverlayDisplaySettingActive("None"))
    assertTrue(VdisplayController.isOverlayDisplaySettingActive("720x1600/240"))
    assertTrue(VdisplayController.isOverlayDisplaySettingActive("1280x720/213;1920x1080/320"))
  }
}
