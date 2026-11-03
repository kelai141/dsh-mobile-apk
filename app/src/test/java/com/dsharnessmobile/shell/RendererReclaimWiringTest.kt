package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1362 / #1364 的**接线**判据：策略再对，只要没接上就等于没修。
 * 纯函数判据证明「规则对」，这里证明「规则真的被用到」——两者缺一都可能是假绿。
 */
class RendererReclaimWiringTest {
  private val source: String by lazy {
    var root: File? = File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !File(root, "app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt").isFile) {
      root = root.parentFile
    }
    requireNotNull(root) { "找不到仓库根（BrowserHost.kt 不在任何祖先目录下）" }
    File(root, "app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt").readText()
  }

  private fun body(signature: String): String {
    val start = source.indexOf(signature)
    assertTrue("找不到函数：" + signature, start >= 0)
    var depth = 0
    val open = source.indexOf('{', start)
    for (i in open until source.length) {
      if (source[i] == '{') depth++ else if (source[i] == '}') { depth--; if (depth == 0) return source.substring(open, i + 1) }
    }
    error("花括号不配对：" + signature)
  }

  // ── #1362 ──────────────────────────────────────────────────────────────────
  @Test fun destroyDrainsPendingJs() {
    assertTrue("destroy() 必须 drain 在途回执", body("fun destroy()").contains("drainPendingJs("))
  }

  @Test fun enqueueGoesThroughCapAwareEntryPoint() {
    val eval = body("private fun evaluateOnTab(")
    assertTrue("evaluateOnTab 必须走 enqueuePendingJs", eval.contains("enqueuePendingJs(seq, tab, callback)"))
    assertFalse("不得绕过上限直接入队", eval.contains("pendingJs[seq] = PendingJsEntry("))
    assertTrue("入队实现在 enqueuePendingJs 里",
      body("private fun enqueuePendingJs(").contains("pendingJs[seq] = PendingJsEntry("))
  }

  @Test fun drainIsObservable() {
    val d = body("private fun drainPendingJs(")
    assertTrue("回收必须写日志", d.contains("Log.w"))
    assertTrue("日志必须带条数", d.contains("count="))
    assertTrue("日志必须带原因", d.contains("reason="))
    assertTrue("必须逐条回调 null", d.contains("entry.callback(null)"))
  }

  @Test fun capIsCheckedBeforeEnqueue() {
    val e = body("private fun enqueuePendingJs(")
    assertTrue("入队前必须查上限", e.contains("PendingJsDrain.shouldReclaim("))
    assertTrue("超限必须先 drain", e.indexOf("shouldReclaim") < e.indexOf("pendingJs[seq] ="))
  }

  // ── #1364 ──────────────────────────────────────────────────────────────────
  @Test fun switchToOnlyEvictsOverCap() {
    val s = body("private fun switchTo(")
    assertTrue("switchTo 必须调 evictOverCap", s.contains("evictOverCap(workspace)"))
    // 反向：切换时**不得**做「回收全部非当前」那种清空式动作（那是用户可感知的退化）。
    assertFalse("switchTo 不得调用整表回收", s.contains("reclaimInactiveWorkspaces"))
  }

  @Test fun evictionUsesCapPlanAndLogsAge() {
    val e = body("private fun evictOverCap(")
    assertTrue("淘汰计划必须走纯函数", e.contains("WorkspaceReclaim.evictPlan("))
    assertTrue("必须传最近使用时刻表", e.contains("workspaceLastUsedAt"))
    assertTrue("必须记下当前工作台的最近使用时刻", e.contains("workspaceLastUsedAt[it.sessionKey] = now"))
    assertTrue("淘汰必须写日志", e.contains("workspace evicted: reason=cap"))
    assertTrue("日志必须带 key", e.contains("key="))
    assertTrue("日志必须带 age", e.contains("age="))
  }

  @Test fun reclaimRemovesReferenceBeforeTeardown() {
    for (fn in listOf("private fun evictOverCap(", "internal fun dropWorkspaceForSession(")) {
      val b = body(fn)
      val removeAt = b.indexOf("workspaces.remove(")
      val dropAt = b.indexOf("dropWorkspace(")
      assertTrue(fn + "：必须先删引用", removeAt >= 0)
      assertTrue(fn + "：再销毁（先删引用再删目录）", dropAt >= 0)
      assertTrue(fn + "：顺序必须是「先删引用，再销毁」", removeAt < dropAt)
    }
  }

  @Test fun sessionDeleteEntryPointExistsAndIsExposedToTheService() {
    val d = body("internal fun dropWorkspaceForSession(")
    assertTrue("删除路径必须立即回收（不查额度）", !d.contains("evictPlan"))
    assertTrue("删除也必须写日志并带 age", d.contains("reason=session-delete") && d.contains("age="))
    // 服务侧入口（holder）必须存在，否则这条回收没有可信调用面。
    assertTrue("BrowserHostHolder 必须暴露 dropSessionWorkspace",
      source.contains("fun dropSessionWorkspace(session: String?)"))
  }
}
