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

  /** 取 refreshSessionPicker 的函数体（从签名到 `// Re-validate the target`）。 */
  private fun pickerBlock(): String {
    var root: java.io.File? = java.io.File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !java.io.File(root, "app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt").isFile) {
      root = root.parentFile
    }
    requireNotNull(root) { "找不到仓库根" }
    val panel = java.io.File(root!!, "app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt").readText()
    val start = panel.indexOf("internal fun refreshSessionPicker()")
    assertTrue("找不到 refreshSessionPicker", start >= 0)
    return panel.substring(start, panel.indexOf("// Re-validate the target", start))
  }

  @Test fun pickerRefreshActuallyReconcilesAndOnlyOnSuccess() {
    // 接线：对账必须真的挂在 session/list 的回调里，且**只在 HTTP 200 时**动手。
    // 少了这条，「规则对但没接上」或「失败时也照空列表清理」都不会被上面的纯函数判据发现。
    val block = pickerBlock()
    assertTrue("refreshSessionPicker 必须调对账", block.contains("reconcileSessionWorkspaces("))
    assertTrue("必须只在 200 且列表非空时对账", block.contains("if (code == 200 && liveIds.isNotEmpty())"))
    assertTrue("对账必须在 session/list 回调之内（在 Re-validate 之前）", block.contains("postRpc(\"session/list\""))
  }

  /**
   * issue #1573：对账必须用**全量存活集**，不能用可见性过滤后的 pickerSessions。
   *
   * 这是缺陷的**打红负控**：把下面三条断言对应的源码改回 `pickerSessions.map { it.id }`，
   * 本测试立刻变红。
   *
   * 为什么旧测试挡不住：`pickerRefreshActuallyReconcilesAndOnlyOnSuccess` 曾把
   * `pickerSessions.isNotEmpty()` 当成**正确形态钉住**，于是「用 UI 面数据当存活集」这件事
   * 在门禁全绿的情况下活了下来，直到用户看到工作台被无声销毁。
   */
  @Test fun reconcileUsesUnfilteredLiveIdsNotVisibilityFilteredPickerSessions() {
    val block = pickerBlock()
    // 1) 对账入参必须是 liveIds（全量）
    assertTrue(
      "对账入参必须是 liveIds；实得：" + block.lines().firstOrNull { it.contains("reconcileSessionWorkspaces(") },
      block.contains("reconcileSessionWorkspaces(liveIds)"),
    )
    // 2) 绝不能把 pickerSessions 的 id 集当存活集（#1573 的缺陷形态）
    assertTrue(
      "不得用 pickerSessions.map { it.id } 作存活集（#1573：那是可见性过滤后的 UI 面数据）",
      !block.contains("pickerSessions.map { it.id }"),
    )
    // 3) liveIds 必须在可见性过滤**之前**登记，否则收上来的就不是全量
    val addAt = block.indexOf("liveIds.add(sid)")
    val subagentAt = block.indexOf("== \"subagent\"")
    val blankAt = block.indexOf("blank && sid != svc.activeSessionId")
    assertTrue("找不到 liveIds.add(sid)", addAt >= 0)
    assertTrue("找不到 subagent 过滤", subagentAt >= 0)
    assertTrue("找不到 blank 过滤", blankAt >= 0)
    assertTrue(
      "liveIds.add(sid) 必须在可见性过滤之前；addAt=" + addAt + " subagentAt=" + subagentAt + " blankAt=" + blankAt,
      addAt < subagentAt && addAt < blankAt,
    )
  }

  @Test fun onlyVanishedOnesAreReclaimedAmongMany() {
    val keys = listOf("s1", "s2", "s3", "s4", anon)
    assertEquals(listOf("s1", "s3"), WorkspaceReclaim.reconcilePlan(keys, setOf("s2", "s4"), anon))
  }
}
