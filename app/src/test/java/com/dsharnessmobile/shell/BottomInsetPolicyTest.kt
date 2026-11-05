package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * issue #783 缺陷 A（壳侧一半）：底部两条通道必须语义分明。
 *
 * 判别位：手势导航设备上报 navigationBars.bottom = 0、mandatorySystemGestures.bottom = 138
 * 物理 px（46 CSS px，荣耀 CRT-AN00 / density 3.0 实测）。
 *   - navBar 通道（交互面消费）必须归零；
 *   - system 通道（sheet/气泡/市场消费）仍为 46，既有表面零位移。
 * 旧实现只有一条通道且取 max ⇒ 交互面被要求让出 46 CSS px 纯背景带。
 *
 * 反证口径：把 navBar 改成也取 max(bars, gestures) 时，「手势模式交互面归零」立刻变红
 * （已实测：3 条用例红）。
 */
class BottomInsetPolicyTest {

  /** 荣耀 CRT-AN00：1080x2388 / density 3.0 / 手势导航。 */
  private val density = 3.0f
  private val gestureBottomPx = 138

  @Test
  fun 手势导航下交互面通道必须归零() {
    val channels = BottomInsetPolicy.channels(0, gestureBottomPx, density)
    assertEquals("手势模式没有可遮挡的栏，交互面不得再留空白带", 0, channels.navBar)
  }

  @Test
  fun 手势导航下保守通道保持原值_既有表面零位移() {
    val channels = BottomInsetPolicy.channels(0, gestureBottomPx, density)
    assertEquals("sheet/气泡/市场的预留必须与修前逐像素一致", 46, channels.system)
  }

  @Test
  fun 三键导航下两条通道相等() {
    // 三键导航：navigationBars.bottom = 144 物理 px，手势热区 0 ⇒ 两条都是 48 CSS px。
    val channels = BottomInsetPolicy.channels(144, 0, density)
    assertEquals(48, channels.system)
    assertEquals(48, channels.navBar)
  }

  @Test
  fun 不足一像素也要让开() {
    // 向上取整：125 / 3.0 = 41.67 ⇒ 42；126 / 3.0 = 42.0 恰好整。
    assertEquals(42, BottomInsetPolicy.channels(125, 0, density).navBar)
    assertEquals(42, BottomInsetPolicy.channels(126, 0, density).navBar)
  }

  @Test
  fun 非法输入一律归零不抛() {
    assertEquals(0, BottomInsetPolicy.channels(0, 0, density).navBar)
    assertEquals(0, BottomInsetPolicy.channels(-12, 0, density).navBar)
    assertEquals(0, BottomInsetPolicy.channels(144, 0, 0f).navBar)
    assertEquals(0, BottomInsetPolicy.channels(-12, -12, density).system)
  }
}
