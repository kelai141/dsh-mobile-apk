package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [MotionCoalescer] / [TabMotionQueues] 的 JVM 单测（纯逻辑，不依赖 Android 运行时）。
 *
 * 守的不变量（issue #540）：
 *  - 连续 MOVE 合帧只剩最后一条；
 *  - DOWN / MOVE / UP 保序；
 *  - 上限溢出只丢最老的 MOVE，绝不丢 DOWN/UP 结构；
 *  - CANCEL 保留（不能被合帧吞掉，否则远端手势悬空）；
 *  - 每个 tab 一条独立事件流，互不串台，tab 消失即清。
 */
class MotionCoalescerTest {

  private val down = 0
  private val up = 1
  private val move = 2
  private val cancel = 3

  private fun sample(action: Int, x: Float = 0f, eventTime: Long = 0L) =
    MotionCoalescer.Sample(action, 0L, eventTime, x, 0f, 1f, 0f, 0)

  @Test
  fun consecutiveMovesCollapseToTheSingleLastOne() {
    val queue = MotionCoalescer(capacity = 64, moveAction = move)
    queue.offer(sample(move, 10f))
    queue.offer(sample(move, 20f))
    queue.offer(sample(move, 30f))

    val drained = queue.drain()

    assertEquals(1, drained.size)
    assertEquals(move, drained[0].action)
    assertEquals(30f, drained[0].x, 0f)
    assertEquals(0, queue.size())
  }

  @Test
  fun downMoveMoveUpKeepsOrderAndCoalescesTheMoves() {
    val queue = MotionCoalescer(capacity = 64, moveAction = move)
    queue.offer(sample(down))
    queue.offer(sample(move, 10f))
    queue.offer(sample(move, 20f))
    queue.offer(sample(up, 20f))

    val drained = queue.drain()

    assertEquals(listOf(down, move, up), drained.map { it.action })
    // 合帧留下的是最后一条 MOVE（20），不是第一条。
    assertEquals(20f, drained[1].x, 0f)
    assertTrue(queue.isEmpty())
    assertEquals(0, queue.drain().size)
  }

  @Test
  fun movesAfterDrainAreNotLost() {
    val queue = MotionCoalescer(capacity = 64, moveAction = move)
    queue.offer(sample(down))
    queue.offer(sample(move, 10f))
    assertEquals(2, queue.drain().size)

    queue.offer(sample(move, 40f))
    val second = queue.drain()
    assertEquals(1, second.size)
    assertEquals(40f, second[0].x, 0f)
  }

  @Test
  fun overflowDropsTheOldestMoveButKeepsDownUpAndCancel() {
    val queue = MotionCoalescer(capacity = 4, moveAction = move)
    queue.offer(sample(down))
    queue.offer(sample(move, 10f))
    queue.offer(sample(up))
    queue.offer(sample(cancel))
    assertEquals(4, queue.size())

    // 队列已满且尾部不是 MOVE：新 MOVE 入队时丢最老的 MOVE，而不是丢结构事件。
    assertTrue(queue.offer(sample(move, 90f)))

    val drained = queue.drain()
    assertEquals(4, drained.size)
    assertEquals(listOf(down, up, cancel, move), drained.map { it.action })
    assertEquals(90f, drained[3].x, 0f)
    assertFalse(drained.any { it.action == move && it.x == 10f })
  }

  @Test
  fun overflowWithoutAnyMoveRefusesTheNewEventInsteadOfDroppingStructure() {
    val queue = MotionCoalescer(capacity = 2, moveAction = move)
    queue.offer(sample(down))
    queue.offer(sample(up))

    assertFalse(queue.offer(sample(move, 5f)))

    assertEquals(listOf(down, up), queue.drain().map { it.action })
  }

  @Test
  fun cancelIsPreservedAndNeverMerged() {
    val queue = MotionCoalescer(capacity = 64, moveAction = move)
    queue.offer(sample(down))
    queue.offer(sample(move, 10f))
    queue.offer(sample(cancel))
    queue.offer(sample(cancel))

    val drained = queue.drain()

    assertEquals(listOf(down, move, cancel, cancel), drained.map { it.action })
  }

  @Test
  fun tabsAreIsolatedFromEachOther() {
    val tabs = TabMotionQueues(capacity = 64, moveAction = move)
    tabs.offer("tab-a", sample(down))
    tabs.offer("tab-a", sample(move, 10f))
    tabs.offer("tab-b", sample(down))
    tabs.offer("tab-a", sample(move, 20f))
    tabs.offer("tab-b", sample(move, 50f))

    val drained = tabs.drainAll()

    assertEquals(listOf("tab-a", "tab-b"), drained.map { it.first })
    val a = drained[0].second
    val b = drained[1].second
    assertEquals(listOf(down, move), a.map { it.action })
    assertEquals(20f, a[1].x, 0f)
    assertEquals(listOf(down, move), b.map { it.action })
    assertEquals(50f, b[1].x, 0f)
    assertEquals(0, tabs.pendingCount("tab-a"))
    assertEquals(0, tabs.pendingCount("tab-b"))
  }

  @Test
  fun forgettingOneTabDoesNotDisturbTheOthers() {
    val tabs = TabMotionQueues(capacity = 64, moveAction = move)
    tabs.offer("tab-a", sample(down))
    tabs.offer("tab-b", sample(down))
    tabs.offer("tab-b", sample(move, 60f))

    tabs.forget("tab-a")

    assertEquals(0, tabs.pendingCount("tab-a"))
    val drained = tabs.drainAll()
    assertEquals(listOf("tab-b"), drained.map { it.first })
    assertEquals(listOf(down, move), drained[0].second.map { it.action })
    assertEquals(60f, drained[0].second[1].x, 0f)
  }
}
