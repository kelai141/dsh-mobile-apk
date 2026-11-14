package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [overlaySingleLine] / [overlayRowMergePlan] 的 JVM 单测（纯逻辑，不依赖 Android 运行时）。
 *
 * 守的不变量：
 *  - 单行化必须把换行折成空格（否则 maxLines=1 的 TextView 会把两行粘成无空格字符串）；
 *  - 行增量计划的 update/add/remove 三段互斥且总数守恒（render 幂等的地基）；
 *  - 上限截断按「保留尾部最新」语义，不回退到超过上限的行数。
 */
class OverlayViewTypesTest {

  @Test
  fun singleLineCollapsesNewlinesAndTabsIntoOneSpace() {
    assertEquals("第一行 第二行", overlaySingleLine("第一行\n第二行"))
    assertEquals("a b c", overlaySingleLine("a\r\n\tb   c"))
  }

  @Test
  fun singleLineTrimsLeadingAndTrailingWhitespace() {
    assertEquals("hello", overlaySingleLine("  hello  "))
    assertEquals("", overlaySingleLine("   \n\t "))
    assertEquals("", overlaySingleLine(""))
  }

  @Test
  fun singleLineKeepsCjkWithoutInsertingSpaces() {
    assertEquals("正在思考", overlaySingleLine("正在思考"))
  }

  @Test
  fun rowMergePlanAddsOnlyTailRowsWhenGrowing() {
    val plan = overlayRowMergePlan(previousCount = 2, nextCount = 5)
    assertEquals(2, plan.updateCount)
    assertEquals(3, plan.addCount)
    assertEquals(0, plan.removeCount)
    assertEquals(5, plan.updateCount + plan.addCount)
  }

  @Test
  fun rowMergePlanRemovesTailRowsWhenShrinking() {
    val plan = overlayRowMergePlan(previousCount = 5, nextCount = 2)
    assertEquals(2, plan.updateCount)
    assertEquals(0, plan.addCount)
    assertEquals(3, plan.removeCount)
    assertEquals(5, plan.updateCount + plan.removeCount)
  }

  @Test
  fun rowMergePlanIsIdempotentForSameCount() {
    val plan = overlayRowMergePlan(previousCount = 7, nextCount = 7)
    assertEquals(7, plan.updateCount)
    assertEquals(0, plan.addCount)
    assertEquals(0, plan.removeCount)
  }

  @Test
  fun rowMergePlanCapsAtMaxRowsAndKeepsLatest() {
    val plan = overlayRowMergePlan(previousCount = OVERLAY_CARD_MAX_ROWS, nextCount = 80)
    assertEquals(OVERLAY_CARD_MAX_ROWS, plan.updateCount)
    assertEquals(0, plan.addCount)
    assertEquals(0, plan.removeCount)
  }

  @Test
  fun rowMergePlanClampsNegativeInputsToZero() {
    val plan = overlayRowMergePlan(previousCount = -3, nextCount = -1)
    assertEquals(0, plan.updateCount)
    assertEquals(0, plan.addCount)
    assertEquals(0, plan.removeCount)
  }

  @Test
  fun rowMergePlanHonoursCustomCap() {
    val plan = overlayRowMergePlan(previousCount = 3, nextCount = 10, cap = 6)
    assertEquals(3, plan.updateCount)
    assertEquals(3, plan.addCount)
    assertEquals(0, plan.removeCount)
  }

  @Test
  fun dataContractsCarryKindStringsForApprovalAndQuestion() {
    // kind 是字符串（与 mux 事件口径逐字对齐）；这里钉住两种合法值，防止有人改成枚举时漏映射。
    val approval = OverlayPendingAction(eventId = "e1", kind = "approval", label = "run")
    val question = OverlayPendingAction(eventId = "e2", kind = "question", label = "pick")
    assertTrue(approval.kind == "approval")
    assertTrue(question.kind == "question")
  }
}
