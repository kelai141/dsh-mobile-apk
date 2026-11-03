package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1362 / #1364 的**接线**判据：策略再对，只要没接上就等于没修。
 *
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
    assertTrue("destroy() 必须 drain 在途回执（否则条目与闭包永久驻留）", body("fun destroy()").contains("drainPendingJs("))
  }

  @Test fun enqueueGoesThroughCapAwareEntryPoint() {
    val eval = body("private fun evaluateOnTab(")
    assertTrue("evaluateOnTab 必须走 enqueuePendingJs（带上限）", eval.contains("enqueuePendingJs(seq, tab, callback)"))
    assertFalse(
      "evaluateOnTab 里仍有绕过上限的直接入队",
      eval.contains("pendingJs[seq] = PendingJsEntry("),
    )
    // 真正的入队发生在新方法里——这条证明「走的是同一条有上限的路」。
    assertTrue(
      "入队实现必须在 enqueuePendingJs 里",
      body("private fun enqueuePendingJs(").contains("pendingJs[seq] = PendingJsEntry("),
    )
  }

  @Test fun drainIsObservable() {
    val d = body("private fun drainPendingJs(")
    // 静默回收会让以后分不清「没堆」与「堆了但被静默回收」。
    assertTrue("回收必须写日志", d.contains("Log.w"))
    assertTrue("日志必须带条数", d.contains("count="))
    assertTrue("日志必须带原因", d.contains("reason="))
    // 逐条以 null 回调，让调用方的 2s 闩立刻结束，而不是各自等超时。
    assertTrue("必须逐条回调 null", d.contains("entry.callback(null)"))
  }

  @Test fun capIsCheckedBeforeEnqueue() {
    val e = body("private fun enqueuePendingJs(")
    assertTrue("入队前必须查上限", e.contains("PendingJsDrain.shouldReclaim("))
    assertTrue("超限必须先 drain", e.indexOf("shouldReclaim") < e.indexOf("pendingJs[seq] ="))
  }

  // ── #1364 ──────────────────────────────────────────────────────────────────
  @Test fun switchToReclaimsInactiveWorkspaces() {
    assertTrue(
      "switchTo 必须调 reclaimInactiveWorkspaces（否则会话切走永不回收）",
      body("private fun switchTo(").contains("reclaimInactiveWorkspaces(workspace)"),
    )
  }

  @Test fun reclaimRemovesReferenceBeforeTeardown() {
    val r = body("private fun reclaimInactiveWorkspaces(")
    val removeAt = r.indexOf("workspaces.remove(")
    val dropAt = r.indexOf("dropWorkspace(")
    assertTrue("必须先删引用", removeAt >= 0)
    assertTrue("然后再销毁（先删引用再删目录）", dropAt >= 0)
    assertTrue("顺序必须是「先删引用，再销毁」", removeAt < dropAt)
    // 计划来自纯函数，且跳过 current 与匿名
    assertTrue("回收计划必须走纯函数", r.contains("WorkspaceReclaim.plan("))
    assertTrue("必须传当前工作台作 keep", r.contains("keep?.sessionKey"))
    assertTrue("必须传匿名键", r.contains("ANONYMOUS_SESSION"))
  }

  @Test fun reclaimDoesNotSwallowProfileDisposeFailureIntoTheCaller() {
    // 维护者要求：删目录失败只 warn，不阻断会话删除。dropWorkspace 内部对 profile dispose
    // 是 runCatching/ catch 后记 profileError —— 这里锁住「它不会把异常抛回回收调用方」。
    val d = body("private fun dropWorkspace(")
    assertTrue("profile 释放失败必须被吞下并记录", d.contains("profileError"))
    assertTrue("profile 释放必须包在 try/catch 或 runCatching 里",
      d.contains("runCatching") || d.contains("catch"))
  }
}
