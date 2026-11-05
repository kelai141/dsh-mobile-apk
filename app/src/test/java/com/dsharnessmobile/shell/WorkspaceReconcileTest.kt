package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1364 的**便宜路**：复用已有的 `session/list` RPC 做对账回收（无新路由、无跨仓）。
 *
 * 最危险的失效形态不是「没回收」，而是**误删**：列表读取失败时拿到空列表，照它清理
 * 会把用户正在看的页面全删掉。所以第一条判据就是「空列表什么都不动」。
 */
class WorkspaceReconcileTest {
  private val anon = "__anonymous__"

  @Test fun emptyListNeverReclaims() {
    assertEquals(emptyList<String>(), WorkspaceReclaim.reconcilePlan(listOf("s1", "s2", anon), emptySet(), anon))
  }

  @Test fun vanishedSessionIsReclaimed() {
    assertEquals(listOf("s1"), WorkspaceReclaim.reconcilePlan(listOf("s1", "s2", anon), setOf("s2"), anon))
  }

  @Test fun liveSessionsAreKept() {
    assertEquals(
      emptyList<String>(),
      WorkspaceReclaim.reconcilePlan(listOf("s1", "s2", anon), setOf("s1", "s2"), anon),
    )
  }

  @Test fun anonymousIsNeverReclaimedEvenWhenAbsentFromList() {
    val plan = WorkspaceReclaim.reconcilePlan(listOf(anon), setOf("s1"), anon)
    assertTrue("匿名键不得进入回收计划：" + plan, anon !in plan)
    assertEquals(emptyList<String>(), plan)
  }

  @Test fun pickerRefreshActuallyReconcilesAndOnlyOnSuccess() {
    // 接线：对账必须真的挂在 session/list 的回调里，且**只在 HTTP 200 时**动手。
    // 少了这条，「规则对但没接上」或「失败时也照空列表清理」都不会被上面的纯函数判据发现。
    var root: java.io.File? = java.io.File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !java.io.File(root, "app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt").isFile) {
      root = root.parentFile
    }
    requireNotNull(root) { "找不到仓库根" }
    val panel = java.io.File(root!!, "app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt").readText()
    val start = panel.indexOf("internal fun refreshSessionPicker()")
    assertTrue("找不到 refreshSessionPicker", start >= 0)
    val block = panel.substring(start, panel.indexOf("// Re-validate the target", start))
    assertTrue("refreshSessionPicker 必须调对账", block.contains("reconcileSessionWorkspaces("))
    assertTrue("必须只在 200 且列表非空时对账", block.contains("if (code == 200 && pickerSessions.isNotEmpty())"))
    assertTrue("对账必须在 session/list 回调之内（在 Re-validate 之前）", block.contains("postRpc(\"session/list\""))
  }

  @Test fun onlyVanishedOnesAreReclaimedAmongMany() {
    val keys = listOf("s1", "s2", "s3", "s4", anon)
    assertEquals(listOf("s1", "s3"), WorkspaceReclaim.reconcilePlan(keys, setOf("s2", "s4"), anon))
  }
}
