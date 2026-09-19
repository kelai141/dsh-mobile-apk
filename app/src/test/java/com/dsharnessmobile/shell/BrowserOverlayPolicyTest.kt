package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生浏览器覆盖层可见性判据的行为回归。
 *
 * 缺陷形态（用户 2026-09-19 实报「收起侧边栏浏览器不卸载」，0.14.1 复现）：
 * `requestedVisible && stageVisible` 是**每工作台粘滞的记忆态**，一旦某次 `visible=true` 下推
 * 之后发布者（侧栏面板组件）卸载，就再没有任何东西能把它清掉——下一次 `switchTo` 回到该
 * 工作台（模型 `browser_open`、任意控制 op、`dropWorkspace` 的兜底选中）会让 WebView 直接
 * 画在聊天上，而**没有任何组件在场下推 `visible=false`**，用户收起侧栏也撤不掉。
 *
 * 这些用例把「必须有人在场说话才算可见」钉死；撤掉保鲜项即变红（见 freshnessTermIsLoadBearing）。
 */
class BrowserOverlayPolicyTest {

  private val ttl = BrowserOverlayPolicy.STAGE_BOUNDS_TTL_MS

  /** 反向对照实现：0.14.0..0.14.1 出厂的判据（只认记忆态）。 */
  private fun legacyVisible(isCurrent: Boolean, requestedVisible: Boolean, stageVisible: Boolean): Boolean =
    isCurrent && requestedVisible && stageVisible

  @Test
  fun freshStageFromLivePublisherIsDrawn() {
    assertTrue(
      "在场的发布者刚刚下推 visible=true 时必须绘制",
      BrowserOverlayPolicy.visible(true, true, true, boundsAgeMs = 0L, ttlMs = ttl),
    )
  }

  @Test
  fun stillDrawnAtTheFreshnessBoundary() {
    assertTrue(
      "保鲜期边界（恰好 TTL）仍算在场",
      BrowserOverlayPolicy.visible(true, true, true, boundsAgeMs = ttl, ttlMs = ttl),
    )
  }

  @Test
  fun ghostOverlayOfAMissingPublisherIsNotDrawn() {
    // 本用例就是用户实报的形态：三件记忆态全部为 true（历史上确实下推过可见），
    // 但发布者已经不在场（超过保鲜期）——必须停画。
    assertTrue("前提：记忆态确实是「可见」", legacyVisible(true, true, true))
    assertFalse(
      "发布者不在场（TTL+1）时禁止绘制：这正是「收起侧栏也撤不掉」的幽灵覆盖层",
      BrowserOverlayPolicy.visible(true, true, true, boundsAgeMs = ttl + 1, ttlMs = ttl),
    )
  }

  @Test
  fun neverPublishedStageIsNotDrawn() {
    assertFalse(
      "从未下推过 bounds 的工作台（新建 / 非会话调用）一律不绘制",
      BrowserOverlayPolicy.visible(
        true, true, true,
        boundsAgeMs = BrowserOverlayPolicy.boundsAge(0L, 10_000L),
        ttlMs = ttl,
      ),
    )
    assertEquals(
      "未下推的年龄必须是哨兵值，不能是 0（0 会被当成「刚刚下推」而误判可见）",
      BrowserOverlayPolicy.NEVER_PUBLISHED_AGE_MS,
      BrowserOverlayPolicy.boundsAge(0L, 10_000L),
    )
  }

  @Test
  fun eachMemoryFlagAloneIsNotEnough() {
    assertFalse("非当前工作台不得绘制", BrowserOverlayPolicy.visible(false, true, true, 0L, ttl))
    assertFalse("调用方未请求可见不得绘制", BrowserOverlayPolicy.visible(true, false, true, 0L, ttl))
    assertFalse("舞台判定不可见不得绘制", BrowserOverlayPolicy.visible(true, true, false, 0L, ttl))
  }

  @Test
  fun degenerateTtlFailsClosed() {
    assertFalse(
      "保鲜期 <= 0 表示「不接受任何记忆态」：宁可少画，不得多画",
      BrowserOverlayPolicy.visible(true, true, true, 0L, ttlMs = 0L),
    )
    assertFalse(
      "负年龄（时间异常）不得被当成新鲜",
      BrowserOverlayPolicy.visible(true, true, true, boundsAgeMs = -1L, ttlMs = ttl),
    )
  }

  @Test
  fun boundsAgeSaturatesInsteadOfGoingNegative() {
    assertEquals("时钟异常导致 now < published 时按 0 处理（刚下推），绝不误判过期",
      0L, BrowserOverlayPolicy.boundsAge(5_000L, 4_000L))
    assertEquals("正常路径按差值计龄", 400L, BrowserOverlayPolicy.boundsAge(1_000L, 1_400L))
  }

  @Test
  fun watchdogOnlyDropsStagesThatClaimToBeVisible() {
    assertTrue("声称可见但已过期：看门狗必须动手停画",
      BrowserOverlayPolicy.shouldDropStaleStage(stageVisible = true, boundsAgeMs = ttl + 1, ttlMs = ttl))
    assertTrue("声称可见却从未下推过：同样必须动手",
      BrowserOverlayPolicy.shouldDropStaleStage(
        stageVisible = true, boundsAgeMs = BrowserOverlayPolicy.NEVER_PUBLISHED_AGE_MS, ttlMs = ttl,
      ))
    assertFalse("本来就不可见：不动手（避免每拍都写一次 View.visibility）",
      BrowserOverlayPolicy.shouldDropStaleStage(stageVisible = false, boundsAgeMs = ttl + 1, ttlMs = ttl))
    assertFalse("保鲜期内：不动手",
      BrowserOverlayPolicy.shouldDropStaleStage(stageVisible = true, boundsAgeMs = ttl, ttlMs = ttl))
  }

  @Test
  fun freshnessTermIsLoadBearing() {
    // 反证：把保鲜项从判据里拿掉（回到 legacyVisible），上面那条幽灵覆盖层用例必须变红。
    // 这条断言保护的是「测试真的在测保鲜」——否则删掉保鲜项，测试仍可能全绿。
    val withoutFreshness = legacyVisible(true, true, true)
    val withFreshness = BrowserOverlayPolicy.visible(true, true, true, boundsAgeMs = ttl * 4, ttlMs = ttl)
    assertTrue("无保鲜项时会误判可见（= 旧实现的缺陷）", withoutFreshness)
    assertFalse("带保鲜项时正确判不可见", withFreshness)
    assertTrue("两者必须在过期的记忆态上分歧，否则本测试不具判别力", withoutFreshness != withFreshness)
  }
}
