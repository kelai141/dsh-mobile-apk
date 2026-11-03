package com.dsharnessmobile.shell

import com.dsharnessmobile.shell.PendingJsDispatch.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1363：JS 回执必须比对 tab 存活与世代，**旧世代的回执要被丢弃**。
 *
 * 判据刻意不做成「新世代能工作」——那只证明 happy path。这里每一条都从**旧世代/已关闭**这一侧
 * 断言，因为缺陷本体就是「关页之后回执照旧写回」。
 */
class PendingJsDispatchTest {
  private fun entry(tabId: String = "t1", generation: Long = 1L): PendingJsEntry =
    PendingJsEntry(tabId, generation) { /* 回调在纯判据里不参与 */ }

  @Test fun staleGenerationReplyIsDiscarded() {
    // tab 还在、但已经换过代（closeTabOp 会把 generation +1 再销毁 view）
    assertEquals(
      Decision.DISCARD_STALE_GENERATION,
      PendingJsDispatch.decide(entry(generation = 1L), "t1", liveGeneration = 2L),
    )
  }

  @Test fun replyForClosedTabIsDiscarded() {
    assertEquals(
      Decision.DISCARD_TAB_GONE,
      PendingJsDispatch.decide(entry(), "t1", liveGeneration = null),
    )
  }

  @Test fun replyFromAnotherTabIsDiscarded() {
    // 渲染侧自报的 tabId 与条目不一致（不该发生，但不得据此写回别人的状态）
    assertEquals(
      Decision.DISCARD_TAB_GONE,
      PendingJsDispatch.decide(entry(tabId = "t1"), "t2", liveGeneration = 1L),
    )
  }

  @Test fun matchingGenerationAndTabDelivers() {
    assertEquals(
      Decision.DELIVER,
      PendingJsDispatch.decide(entry(generation = 3L), "t1", liveGeneration = 3L),
    )
  }

  @Test fun staleAndGoneAreDistinguishableForDiagnosis() {
    // 两态必须可区分：关闭竞态 vs 有人在旧页面上继续操作，排障含义不同。
    val stale = PendingJsDispatch.decide(entry(generation = 1L), "t1", liveGeneration = 2L)
    val gone = PendingJsDispatch.decide(entry(), "t1", liveGeneration = null)
    assertFalse(stale == gone)
  }
}
