package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 入口手势裁决契约（纯 JVM）。
 *
 * 钉的是 [OverlayGestureRouter] 的时间与位移边界：touchSlop 内外、双击窗口边界、
 * 长按到期、拖动不产生点击、一次手势一个动作、reset 清空。
 * 真机手感的稳定性靠设备验收，这里只保证判定逻辑没有歧义。
 */
class OverlayGestureRouterTest {

  private fun router(): OverlayGestureRouter =
    OverlayGestureRouter(touchSlopPx = 10f, doubleTapTimeoutMs = 300L, longPressTimeoutMs = 500L)

  // ── 拖动阈值 ─────────────────────────────────────────────────────────

  @Test
  fun `位移未超 touchSlop 不判拖动`() {
    val r = router()
    r.onDown(0L)
    assertEquals("阈值内是 NONE", EntryGesture.NONE, r.onMove(5f, 5f))
    assertFalse("阈值内不得进入拖动", r.isDragging())
  }

  @Test
  fun `位移恰好等于 touchSlop 仍不算拖动`() {
    val r = router()
    r.onDown(0L)
    assertEquals("等于阈值属于「未超过」", EntryGesture.NONE, r.onMove(10f, 0f))
    assertFalse("等于阈值不拖动", r.isDragging())
  }

  @Test
  fun `超过 touchSlop 首次给 DRAG_START 之后给 DRAG_MOVE`() {
    val r = router()
    r.onDown(0L)
    assertEquals("首次越界派发起拖", EntryGesture.DRAG_START, r.onMove(20f, 0f))
    assertTrue("已进入拖动", r.isDragging())
    assertEquals("后续移动", EntryGesture.DRAG_MOVE, r.onMove(40f, 10f))
  }

  @Test
  fun `拖动后的抬起只给 DRAG_END 不产生点击`() {
    val r = router()
    r.onDown(0L)
    r.onMove(30f, 0f)
    assertEquals("松手结束拖动", EntryGesture.DRAG_END, r.onUp(30f, 0f, 100L))
    assertFalse("松手后退出拖动", r.isDragging())
    assertEquals("拖动不得补发单击", EntryGesture.NONE, r.resolvePendingTap(1000L))
  }

  // ── 单击与双击 ───────────────────────────────────────────────────────

  @Test
  fun `未拖动的第一次抬起进入待定单击`() {
    val r = router()
    r.onDown(0L)
    assertEquals("不立刻发 TAP", EntryGesture.NONE, r.onUp(2f, 2f, 100L))
    assertEquals("窗口未到不得结算", EntryGesture.NONE, r.resolvePendingTap(399L))
    assertEquals("窗口到点结算出单击", EntryGesture.TAP, r.resolvePendingTap(400L))
    assertEquals("单击只能结算一次", EntryGesture.NONE, r.resolvePendingTap(500L))
  }

  @Test
  fun `两次未拖动抬起在窗口内判双击`() {
    val r = router()
    r.onDown(0L)
    assertEquals("第一下待定", EntryGesture.NONE, r.onUp(0f, 0f, 100L))
    r.onDown(300L)
    assertEquals("300ms 后仍算同一次双击", EntryGesture.DOUBLE_TAP, r.onUp(0f, 0f, 400L))
    assertEquals("双击成立后不再补单击", EntryGesture.NONE, r.resolvePendingTap(1000L))
  }

  @Test
  fun `超过双击窗口的第二下只是新的单击候选`() {
    val r = router()
    r.onDown(0L)
    r.onUp(0f, 0f, 100L)
    r.onDown(500L)
    assertEquals("窗口外的第二下不是双击", EntryGesture.NONE, r.onUp(0f, 0f, 650L))
    assertEquals("新候选按新时间结算", EntryGesture.TAP, r.resolvePendingTap(950L))
  }

  @Test
  fun `拖动会清掉双击候选`() {
    val r = router()
    r.onDown(0L)
    r.onUp(0f, 0f, 100L)
    r.onDown(150L)
    r.onMove(40f, 0f)
    assertEquals("拖完松手", EntryGesture.DRAG_END, r.onUp(40f, 0f, 200L))
    r.onDown(250L)
    assertEquals("拖动之后不得再判双击", EntryGesture.NONE, r.onUp(0f, 0f, 300L))
  }

  @Test
  fun `窗口边界之后按下只算新的单击候选`() {
    val r = router()
    r.onDown(0L)
    r.onUp(0f, 0f, 100L)
    r.onDown(390L)
    // 401 - 100 = 301ms > doubleTapTimeoutMs(300)，必须当成新的单击候选。
    assertEquals("跨窗口不判双击", EntryGesture.NONE, r.onUp(0f, 0f, 401L))
    assertEquals("新候选仍可按新时间结算", EntryGesture.TAP, r.resolvePendingTap(701L))
  }

  // ── 长按 ─────────────────────────────────────────────────────────────

  @Test
  fun `长按到期派发一次 LONG_PRESS`() {
    val r = router()
    r.onDown(0L)
    assertEquals("提前回调不派发", EntryGesture.NONE, r.onLongPress(499L))
    assertEquals("到期派发长按", EntryGesture.LONG_PRESS, r.onLongPress(500L))
    assertEquals("长按是一次性的", EntryGesture.NONE, r.onLongPress(600L))
  }

  @Test
  fun `拖动取消长按`() {
    val r = router()
    r.onDown(0L)
    r.onMove(30f, 0f)
    assertEquals("拖动中不判长按", EntryGesture.NONE, r.onLongPress(600L))
  }

  @Test
  fun `长按后的抬起不再产生单击`() {
    val r = router()
    r.onDown(0L)
    assertEquals("派发长按", EntryGesture.LONG_PRESS, r.onLongPress(600L))
    assertEquals("长按已消费本次手势", EntryGesture.NONE, r.onUp(0f, 0f, 700L))
    assertEquals("不得再补单击", EntryGesture.NONE, r.resolvePendingTap(2000L))
  }

  @Test
  fun `拖动中移动持续返回 DRAG_MOVE`() {
    val r = router()
    r.onDown(0L)
    r.onMove(20f, 0f)
    assertEquals("继续移动", EntryGesture.DRAG_MOVE, r.onMove(30f, 5f))
    assertEquals("反向移动也仍是 MOVE", EntryGesture.DRAG_MOVE, r.onMove(-40f, 0f))
  }

  // ── reset ────────────────────────────────────────────────────────────

  @Test
  fun `reset 清掉待定单击`() {
    val r = router()
    r.onDown(0L)
    r.onUp(0f, 0f, 100L)
    r.reset()
    assertEquals("reset 后不得补发 TAP", EntryGesture.NONE, r.resolvePendingTap(1000L))
  }

  @Test
  fun `reset 清掉拖动状态`() {
    val r = router()
    r.onDown(0L)
    r.onMove(30f, 0f)
    assertTrue("拖动中", r.isDragging())
    r.reset()
    assertFalse("reset 后不再拖动", r.isDragging())
  }

  @Test
  fun `reset 后长按计时从头开始`() {
    val r = router()
    r.onDown(0L)
    r.reset()
    assertEquals("reset 不能残留旧按下时刻", EntryGesture.NONE, r.onLongPress(600L))
  }
}
