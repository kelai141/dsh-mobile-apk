package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 窗口持有者的纯判据与槽位表契约。
 *
 * 为什么可测的是这两块：真实 WindowManager 在 JVM 单测里拿不到（isReturnDefaultValues 只给默认值），
 * 但「添加顺序是否违反 z 序」与「槽位表本身的顺序」都是纯数据判据——而它们正是「光环被球盖住」
 * 这类真机回归的第一道防线（F8 事故：先加球后加光环，辉光整窗盖住球面）。
 */
class OverlayWindowsTest {

  private val canonical = listOf(
    OverlayWindows.Slot.HALO,
    OverlayWindows.Slot.ENTRY,
    OverlayWindows.Slot.CARD,
    OverlayWindows.Slot.PILL,
    OverlayWindows.Slot.COMPOSER,
  )

  @Test
  fun canonicalOrderIsNotAViolation() {
    assertFalse(OverlayWindows.orderViolationOf(canonical))
  }

  @Test
  fun emptyOrderIsNotAViolation() {
    assertFalse(OverlayWindows.orderViolationOf(emptyList()))
  }

  @Test
  fun singleSlotIsNotAViolation() {
    assertFalse(OverlayWindows.orderViolationOf(listOf(OverlayWindows.Slot.CARD)))
  }

  @Test
  fun cardAddedBeforeEntryIsAViolation() {
    assertTrue(
      OverlayWindows.orderViolationOf(
        listOf(OverlayWindows.Slot.CARD, OverlayWindows.Slot.ENTRY),
      ),
    )
  }

  @Test
  fun haloAddedLastIsAViolation() {
    assertTrue(
      OverlayWindows.orderViolationOf(
        listOf(OverlayWindows.Slot.ENTRY, OverlayWindows.Slot.HALO),
      ),
    )
  }

  @Test
  fun composerBeforePillIsAViolation() {
    assertTrue(
      OverlayWindows.orderViolationOf(
        listOf(OverlayWindows.Slot.COMPOSER, OverlayWindows.Slot.PILL),
      ),
    )
  }

  @Test
  fun recallBetweenEntryAndCardIsAllowed() {
    assertFalse(
      OverlayWindows.orderViolationOf(
        listOf(
          OverlayWindows.Slot.ENTRY,
          OverlayWindows.Slot.RECALL,
          OverlayWindows.Slot.CARD,
        ),
      ),
    )
  }

  @Test
  fun slotLabelsAreStable() {
    // 标签进日志与设备排查文档；改名等于让历史日志失去可读性。
    assertEquals("halo", OverlayWindows.Slot.HALO.label)
    assertEquals("entry", OverlayWindows.Slot.ENTRY.label)
    assertEquals("recall", OverlayWindows.Slot.RECALL.label)
    assertEquals("card", OverlayWindows.Slot.CARD.label)
    assertEquals("pill", OverlayWindows.Slot.PILL.label)
    assertEquals("composer", OverlayWindows.Slot.COMPOSER.label)
  }

  @Test
  fun canonicalZIndexIsStrictlyIncreasing() {
    val indexes = listOf(
      OverlayWindows.Slot.HALO,
      OverlayWindows.Slot.ENTRY,
      OverlayWindows.Slot.RECALL,
      OverlayWindows.Slot.CARD,
      OverlayWindows.Slot.PILL,
      OverlayWindows.Slot.COMPOSER,
    ).map { it.zIndex }
    assertEquals(indexes.sorted(), indexes)
    assertEquals(indexes.distinct(), indexes)
  }
}
