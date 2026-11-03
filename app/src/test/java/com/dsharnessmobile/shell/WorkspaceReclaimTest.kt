package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1364：会话切走时必须回收**非当前、非匿名**的工作台。
 *
 * 这条判据要能**双向**区分两件事（维护者要求）：
 *  - 「跳过 current」——current 与匿名必须留在终态里；
 *  - 「根本没有调用」——所以必须有一个**非 current 的可删工作区**真的出现在回收计划里。
 * 只断言「目录还在」在两种实现下都绿，区分不了这两件事。
 */
class WorkspaceReclaimTest {
  private val anon = "__anonymous__"

  @Test fun nonCurrentWorkspaceIsActuallyReclaimed() {
    val keys = listOf("s1", "s2", anon)
    // s2 是当前会话：s1 必须出现在计划里 —— 这证明「真的会删」，而不是「压根没调用」。
    assertEquals(listOf("s1"), WorkspaceReclaim.plan(keys, currentKey = "s2", anonymousKey = anon))
  }

  @Test fun currentAndAnonymousSurvive() {
    val keys = listOf("s1", "s2", anon)
    assertEquals(
      listOf("s2", anon),
      WorkspaceReclaim.remainingKeys(keys, currentKey = "s2", anonymousKey = anon),
    )
  }

  @Test fun noCurrentMeansEverySessionWorkspaceGoes() {
    val keys = listOf("s1", "s2", anon)
    assertEquals(listOf("s1", "s2"), WorkspaceReclaim.plan(keys, currentKey = null, anonymousKey = anon))
    assertEquals(listOf(anon), WorkspaceReclaim.remainingKeys(keys, currentKey = null, anonymousKey = anon))
  }

  @Test fun currentNotInMapReclaimsEverythingElse() {
    // 当前键已不在表里（例如刚被别处摘掉）：其余仍应全部回收，不得因为「找不到 current」而放弃。
    val keys = listOf("s1", "s2")
    assertEquals(listOf("s1", "s2"), WorkspaceReclaim.plan(keys, currentKey = "gone", anonymousKey = anon))
  }

  @Test fun anonymousIsNeverReclaimedEvenWhenNotCurrent() {
    val keys = listOf(anon, "s1")
    assertTrue(WorkspaceReclaim.plan(keys, currentKey = "s1", anonymousKey = anon).isEmpty())
    assertEquals(listOf(anon, "s1"), WorkspaceReclaim.remainingKeys(keys, currentKey = "s1", anonymousKey = anon))
  }
}
