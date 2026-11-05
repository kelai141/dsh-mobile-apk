package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1621：通知栏「提交失败，点击重试」的重试按钮永远不会真的重试（用户可见死路）。
 *
 * 缺陷：NOT_READY 预算按**入队时刻** ts 算；重试按钮只做一次 flush()，既不改 ts 也不把状态改回
 * PENDING。对已超 5 分钟预算的 FAILED 决策，handleNotReady 立刻再判 FAIL -> mark(FAILED) +
 * 再发一条同样的「提交失败」通知，一次投递尝试都没做。
 *
 * 判据全是**行为**判据（不是源码切片）：
 *  ① 纯函数：重排后的决策在「现在」这个时刻必须判 RETRY（= 真的会去投递），而重排前判 FAIL；
 *  ② 落盘真源：走 retryFailed() 之后从队列文件读回来的那条，状态/计时/计数都必须是重置后的样子
 *     —— 用户可见后果就是「这次重试会真的投递一次」，而不是立刻又收到一条失败通知。
 */
class NotifyDecisionQueueRetryTest {

  /** 只提供临时 filesDir 的最小 Context（与 AtomicWriteEntryTest / ClientRollbackGateTest 同款）。 */
  private fun filesContext(dir: File): android.content.Context = object : android.content.ContextWrapper(null) {
    override fun getFilesDir(): File = dir
    override fun getApplicationContext(): android.content.Context = this
  }

  private fun tempDir(): File = kotlin.io.path.createTempDirectory("notify-retry").toFile()

  private fun seed(context: android.content.Context, d: NotifyDecisionQueue.Decision) {
    NotifyDecisionQueue.file(context).appendText(NotifyDecisionQueue.serialize(d) + System.lineSeparator())
  }

  @Test
  fun 重排后这条决策必须重新计时_否则点重试等于再收一条失败() {
    val queuedAt = 1_800_000_000_000L
    val now = queuedAt + NotifyDecisionQueue.NOT_READY_BUDGET_MS + 60_000L
    val failed = NotifyDecisionQueue.Decision(
      "rid-retry", "e1", "question", "{\"kind\":\"result\"}", queuedAt, "failed", 6, 9,
    )
    // 修前形状：预算按入队时刻算 -> 早就到期 -> 再点一次重试只会再判一次 FAIL
    assertEquals(
      "前置：这条 FAILED 决策的墙钟预算已经用光",
      NotifyDecisionQueue.WaitAction.FAIL,
      NotifyDecisionQueue.notReadyAction(failed.ts, now),
    )

    val rearmed = NotifyDecisionQueue.rearm(failed, now)
    assertEquals("重排后必须回到 pending", "pending", rearmed.state)
    assertEquals("重排后墙钟起点必须是点击时刻", now, rearmed.ts)
    assertEquals("HTTP 失败计数必须归零（否则再点一次就撞 MAX_ATTEMPTS）", 0, rearmed.attempts)
    assertEquals("未就绪计数必须归零", 0, rearmed.waitAttempts)
    assertEquals("其余字段不得被重排改动（同一条决策，不是新决策）", failed.requestId, rearmed.requestId)
    assertEquals(failed.eventId, rearmed.eventId)
    assertEquals(failed.outcomeJson, rearmed.outcomeJson)
    assertEquals(
      "用户可见后果：重排之后这次重试真的会去投递（判 RETRY），不是立刻再判失败",
      NotifyDecisionQueue.WaitAction.RETRY,
      NotifyDecisionQueue.notReadyAction(rearmed.ts, now),
    )
  }

  @Test
  fun 点重试必须把队列里的那条真的改回待投递() {
    val dir = tempDir()
    val context = filesContext(dir)
    val queuedAt = 1_800_000_000_000L
    val now = queuedAt + NotifyDecisionQueue.NOT_READY_BUDGET_MS + 60_000L
    seed(
      context,
      NotifyDecisionQueue.Decision("rid-real", "evt-real", "approval", "{}", queuedAt, "failed", 6, 9),
    )

    assertTrue("重试必须命中这条决策", NotifyDecisionQueue.retryFailed(context, "evt-real", now))

    val after = NotifyDecisionQueue.load(context).single { it.requestId == "rid-real" }
    assertEquals("落盘状态必须是 pending（否则 flush 会再判一次 FAIL）", "pending", after.state)
    assertEquals("落盘墙钟起点必须是点击时刻", now, after.ts)
    assertEquals(0, after.attempts)
    assertEquals(0, after.waitAttempts)
    // 同一份「重启/触发点重评」逻辑也必须把它当等待中，而不是到期
    val plan = NotifyDecisionQueue.resumePlan(NotifyDecisionQueue.load(context), now)
    assertTrue("重试之后不得再被判到期", plan.expired.isEmpty())
    assertTrue("重试之后必须仍在等待集合里", plan.waiting.contains("rid-real"))
  }

  @Test
  fun 重试找不到这条决策时必须说实话_不得假装重试过() {
    val context = filesContext(tempDir())
    assertFalse(
      "队列里没有这条事件时 retryFailed 必须返回 false（否则调用方会记一条假的成功）",
      NotifyDecisionQueue.retryFailed(context, "evt-absent", 1_800_000_000_000L),
    )
  }

  @Test
  fun 已经投递成功或已失效的决策不得被重试复活() {
    val dir = tempDir()
    val context = filesContext(dir)
    val now = 1_800_000_000_000L
    seed(context, NotifyDecisionQueue.Decision("rid-sub", "evt-sub", "question", "{}", now, "submitted", 0, 0))
    seed(context, NotifyDecisionQueue.Decision("rid-exp", "evt-exp", "question", "{}", now, "expired", 0, 0))
    assertFalse("submitted 不得被重试复活（会重复作答）", NotifyDecisionQueue.retryFailed(context, "evt-sub", now))
    assertFalse("expired 不得被重试复活（引擎侧请求已经没了）", NotifyDecisionQueue.retryFailed(context, "evt-exp", now))
    assertEquals("submitted", NotifyDecisionQueue.load(context).single { it.requestId == "rid-sub" }.state)
    assertEquals("expired", NotifyDecisionQueue.load(context).single { it.requestId == "rid-exp" }.state)
  }
}
