package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1364（2026-11-04 按维护者裁定重定时机）：**删除为主、切换只做上限淘汰**。
 *
 * 判据要挡住的退化是「切走再切回就重建」——所以第一条就是「上一个会话的工作区必须还在」。
 * 淘汰只在**超上限**时发生，且只淘汰最久未用的那一个。
 */
class WorkspaceReclaimTest {
  private val anon = "__anonymous__"
  private fun used(vararg pairs: Pair<String, Long>): Map<String, Long> = pairs.toMap()

  @Test fun previousSessionWorkspaceSurvivesSwitch() {
    // 上一个是 s1（用过），现在切到 s2：s1 **不得**被淘汰。
    val keys = listOf("s1", "s2", anon)
    val plan = WorkspaceReclaim.evictPlan(
      keys, currentKey = "s2", anonymousKey = anon,
      lastUsedAt = used("s1" to 100L, "s2" to 200L),
    )
    assertTrue("切走就回收是用户可感知的退化（切回来页面重建），计划必须为空：" + plan, plan.isEmpty())
  }

  @Test fun fiveSessionsEvictOnlyTheOldestAndKeepCurrentPlusThree() {
    // 5 个会话工作区，current = s5；s1 最久未用 → 只淘汰 s1。
    val keys = listOf("s1", "s2", "s3", "s4", "s5", anon)
    val lastUsed = used("s1" to 10L, "s2" to 20L, "s3" to 30L, "s4" to 40L, "s5" to 50L)
    val plan = WorkspaceReclaim.evictPlan(keys, currentKey = "s5", anonymousKey = anon, lastUsedAt = lastUsed)
    assertEquals(listOf("s1"), plan)
    val remaining = keys.filter { it !in plan }
    assertEquals(listOf("s2", "s3", "s4", "s5", anon), remaining)
  }

  @Test fun currentIsNeverEvictedEvenIfItLooksOld() {
    // current 的时间戳故意给最小值 —— 仍不得被淘汰。
    val keys = listOf("s1", "s2", "s3", "s4", "s5")
    val lastUsed = used("s1" to 50L, "s2" to 40L, "s3" to 30L, "s4" to 20L, "s5" to 1L)
    val plan = WorkspaceReclaim.evictPlan(keys, currentKey = "s5", anonymousKey = anon, lastUsedAt = lastUsed)
    assertEquals(listOf("s4"), plan) // 非 current 里最久未用的是 s4
    assertTrue("current 不得出现在淘汰计划里", "s5" !in plan)
  }

  @Test fun anonymousIsNeverEvicted() {
    val keys = listOf(anon, "s1", "s2", "s3", "s4", "s5")
    val lastUsed = used(anon to 1L, "s1" to 10L, "s2" to 20L, "s3" to 30L, "s4" to 40L, "s5" to 50L)
    val plan = WorkspaceReclaim.evictPlan(keys, currentKey = "s5", anonymousKey = anon, lastUsedAt = lastUsed)
    assertEquals(listOf("s1"), plan)
    assertTrue("匿名工作台永不淘汰", anon !in plan)
  }

  @Test fun sessionDeleteReleasesOnlyThatSession() {
    val keys = listOf("s1", "s2", "s3", anon)
    assertEquals(listOf("s1", "s3", anon), WorkspaceReclaim.afterSessionDelete(keys, "s2", anon))
    assertEquals(keys, WorkspaceReclaim.afterSessionDelete(keys, "nope", anon))
    assertEquals(keys, WorkspaceReclaim.afterSessionDelete(keys, anon, anon))
  }

  @Test fun capStaysAtTheDocumentedValue() {
    // 上限是被论证过的数字（4 个渲染进程 ≈ 240–600 MB，已接近低端机上限；用户实际并行 1–2，
    // 3 个非当前额度覆盖「同一话题开两三条支线」）。改它必须同时改 WorkspaceReclaim 类注释。
    assertEquals(3, WorkspaceReclaim.RECENT_KEEP)
    assertEquals(4, WorkspaceReclaim.MAX_LIVE)
  }
}
