package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1363 的**接线**判据：纯决策再正确，只要回执路径没用它，缺陷就还在。
 *
 * 这条锁三件事：
 *  ① 回执路径不再直接按 seq 取回调并写回（旧形态必须消失）；
 *  ② 派发经过 [PendingJsDispatch] 且比对 tab 世代；
 *  ③ 入队时真的记下了 `(tabId, generation)`。
 */
class PendingJsWiringTest {
  private val source: String by lazy {
    var root: File? = File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !File(root, "app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt").isFile) {
      root = root.parentFile
    }
    requireNotNull(root) { "找不到仓库根（BrowserHost.kt 不在任何祖先目录下）" }
    File(root, "app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt").readText()
  }

  @Test fun replyPathNoLongerInvokesCallbackBySeqAlone() {
    // 旧形态：main.post { pendingJs.remove(seq)?.invoke(...) } —— 不看 tab、不看世代。
    assertFalse(
      "回执路径仍在直接按 seq 取回调并写回：" + source.lines().firstOrNull { it.contains("pendingJs.remove(seq)?.invoke") },
      source.contains("pendingJs.remove(seq)?.invoke"),
    )
    assertTrue("回执必须走 deliverJsResult", source.contains("deliverJsResult(tabId, seq, result)"))
  }

  @Test fun dispatchComparesGeneration() {
    assertTrue(source.contains("PendingJsDispatch.decide(entry, tabId, live)"))
    assertTrue("必须从 tabs 里取当前世代", source.contains("tabs[entry.tabId]?.generation?.get()"))
    // 光调用决策函数不够：回调必须**只在 DELIVER 分支**被调。否则「算了但不看结果」也能过。
    assertTrue(
      "回调必须挂在 DELIVER 分支上（算了却不看结果 = 世代校验形同虚设）",
      source.contains("Decision.DELIVER -> entry.callback("),
    )
  }

  @Test fun enqueueRecordsTabAndGeneration() {
    assertTrue(
      "入队必须记 (tabId, generation)",
      source.contains("pendingJs[seq] = PendingJsEntry(tab.id, tab.generation.get(), callback)"),
    )
  }
}
