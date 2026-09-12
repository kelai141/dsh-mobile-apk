package com.dsharnessmobile.shell

import android.accessibilityservice.AccessibilityService

/**
 * 全局动作目录（0.13.8 E6）——名称 ↔ 平台常量 ↔ 最低 API，**纯数据 + 纯函数**（可 JVM 单测）。
 *
 * 为什么单独一个文件：可用性判定必须能单测。原实现把 `when(action)` 硬编码在
 * `AccessibilityService` 子类里，任何一条可用性规则都只能上真机试——而「工具说能做、
 * 点了没反应」正是最难查的一类失败，恰恰需要离线断言把它钉住。
 *
 * 可用性由 `getSystemActions()` 驱动：系统报不出来的动作不执行、也不宣传。
 */
object GlobalActionCatalog {

  /** 一条全局动作：`name` 是工具面用的名字，`id` 是平台常量，`minSdk` 是引入版本。 */
  class Entry(val name: String, val id: Int, val minSdk: Int, val core: Boolean = false)

  /**
   * 目录表。`core = true` 的四条（back/home/recents/notifications）在所有 Android 上都存在，
   * 恒放行——不能让一个不可靠的 `getSystemActions()` 结果把它们砍掉（防回归）。
   */
  val TABLE: List<Entry> = listOf(
    Entry("back", AccessibilityService.GLOBAL_ACTION_BACK, 1, core = true),
    Entry("home", AccessibilityService.GLOBAL_ACTION_HOME, 1, core = true),
    Entry("recents", AccessibilityService.GLOBAL_ACTION_RECENTS, 1, core = true),
    Entry("notifications", AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS, 1, core = true),
    Entry("quickSettings", AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS, 1),
    Entry("powerDialog", AccessibilityService.GLOBAL_ACTION_POWER_DIALOG, 1),
    Entry("toggleSplitScreen", AccessibilityService.GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN, 24),
    Entry("lockScreen", AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN, 28),
    Entry("takeScreenshot", AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT, 28),
    Entry("menu", AccessibilityService.GLOBAL_ACTION_MENU, 31),
    Entry("mediaPlayPause", AccessibilityService.GLOBAL_ACTION_MEDIA_PLAY_PAUSE, 31),
    Entry("dismissNotificationShade", AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE, 31),
    Entry("accessibilityShortcut", AccessibilityService.GLOBAL_ACTION_ACCESSIBILITY_SHORTCUT, 31),
  )

  /**
   * 给定系统报出的动作 id 集合与 API 级别，返回可用动作名（顺序同目录表）。
   *
   * 规则（顺序即优先级）：
   * ① 低于该动作的最低 API → 不可用；
   * ② 核心四条 → 恒可用；
   * ③ 其余：系统列表为空（部分 ROM 不报）时按 API 下限放行，非空时以系统列表为准。
   */
  fun available(ids: Set<Int>, sdk: Int): List<String> =
    TABLE.filter { entry -> sdk >= entry.minSdk && (entry.core || ids.isEmpty() || ids.contains(entry.id)) }
      .map { entry -> entry.name }

  /** 按名称查条目（未知名称返回 null，由调用方回可读错误）。 */
  fun find(name: String): Entry? = TABLE.firstOrNull { it.name == name }
}
