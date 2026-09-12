package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 全局动作可用性判定（0.13.8 E6）——把「工具说能做、点了没反应」这类最难查的失败钉在离线断言里。
 *
 * 判定输入是 `getSystemActions()` 报出的 id 集合与 API 级别；核心四条必须恒在
 * （ROM 不报也不能砍），高版本动作按 API 下限与系统报告双门放行。
 */
class GlobalActionCatalogTest {

  /** 从目录里取回动作 id（测试不硬编码平台常量值，避免与 SDK 常量脱钩）。 */
  private fun idOf(name: String): Int {
    val e = GlobalActionCatalog.find(name)
    assertNotNull("目录缺少 $name", e)
    return e!!.id
  }

  @Test
  fun coreActionsAreAlwaysAvailable() {
    // 系统什么都不报（部分 ROM 如此）+ 现代 API：核心四条必须在
    val avail = GlobalActionCatalog.available(emptySet(), 35)
    for (name in listOf("back", "home", "recents", "notifications")) {
      assertTrue("核心动作 $name 不应被系统列表砍掉", avail.contains(name))
    }
    // 系统报告一个与核心无关的集合：核心四条仍必须保留（防「getSystemActions 口径不合」回归）
    val avail2 = GlobalActionCatalog.available(setOf(idOf("quickSettings")), 35)
    assertTrue(avail2.contains("back"))
    assertTrue(avail2.contains("home"))
  }

  @Test
  fun unsupportedBySystemIsExcluded() {
    // 系统只报 quickSettings → 高版本动作（menu/lockScreen 等）不得对外宣传
    val avail = GlobalActionCatalog.available(setOf(idOf("quickSettings")), 35)
    assertTrue(avail.contains("quickSettings"))
    assertFalse("系统未报告的动作不得宣传", avail.contains("menu"))
    assertFalse(avail.contains("lockScreen"))
    // 空列表 = ROM 不报，按 API 下限放行（此时 menu 可用）
    val romSilent = GlobalActionCatalog.available(emptySet(), 35)
    assertTrue(romSilent.contains("menu"))
  }

  @Test
  fun minApiGateHolds() {
    // API 26（Android 8）：lockScreen/takeScreenshot 需要 28 → 不可用；quickSettings 可用
    val api26 = GlobalActionCatalog.available(emptySet(), 26)
    assertFalse(api26.contains("lockScreen"))
    assertFalse(api26.contains("takeScreenshot"))
    assertTrue(api26.contains("quickSettings"))
    // API 28：放行锁屏与截图；menu（31）仍不可用
    val api28 = GlobalActionCatalog.available(emptySet(), 28)
    assertTrue(api28.contains("lockScreen"))
    assertTrue(api28.contains("takeScreenshot"))
    assertFalse(api28.contains("menu"))
    // API 31：全表放行
    val api31 = GlobalActionCatalog.available(GlobalActionCatalog.TABLE.map { it.id }.toSet(), 31)
    assertEquals(GlobalActionCatalog.TABLE.size, api31.size)
  }

  @Test
  fun unknownActionIsRejected() {
    assertNull(GlobalActionCatalog.find("reboot"))
    assertNull(GlobalActionCatalog.find(""))
    assertNotNull(GlobalActionCatalog.find("takeScreenshot"))
  }
}
