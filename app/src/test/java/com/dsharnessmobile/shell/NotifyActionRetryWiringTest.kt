package com.dsharnessmobile.shell

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1621 的**接线判据**：通知栏「重试」动作必须真的把决策重新入队。
 *
 * 为什么单开一个文件：队列侧的 rearm/retryFailed 绿了，只证明「有这条路」；而本 issue 的原始形状
 * 恰恰是「路不在」—— ACTION_RETRY 分支只写一行日志再 flush。所以这里直接跑**真的接收器类**：
 * 构造 NotifyActionReceiver 实例，喂一个带 retry 动作的 Intent，再从队列文件里读回那条决策。
 *
 * 判据是行为判据（不看源码切片）：看「点完重试之后队列里那条到底变成什么样」。
 */
class NotifyActionRetryWiringTest {

  /** 只提供临时 filesDir / 自身 applicationContext 的最小 Context。 */
  private fun filesContext(dir: File): Context = object : ContextWrapper(null) {
    override fun getFilesDir(): File = dir
    override fun getApplicationContext(): Context = this
  }

  /**
   * 带 extra 的 Intent：android.jar 的桩让真实 Intent 读不出自己写进去的 extra，
   * 这里只覆盖接收器实际用到的那一个读取口（动作语义与真实 Intent 相同）。
   */
  private class ExtraIntent(private val values: Map<String, String>) : Intent() {
    override fun getStringExtra(name: String?): String? = values[name]
  }

  private fun tempDir(): File = kotlin.io.path.createTempDirectory("notify-retry-wiring").toFile()

  private fun retryIntent(eventId: String): Intent = ExtraIntent(
    mapOf(
      NotifyActionReceiver.EXTRA_ACTION to NotifyActionReceiver.ACTION_RETRY,
      NotifyActionReceiver.EXTRA_EVENT_ID to eventId,
      NotifyActionReceiver.EXTRA_KIND to "question",
    ),
  )

  @Test
  fun 通知栏点重试之后队列里那条必须回到待投递() {
    val dir = tempDir()
    val context = filesContext(dir)
    val queuedAt = System.currentTimeMillis() - NotifyDecisionQueue.NOT_READY_BUDGET_MS - 60_000L
    NotifyDecisionQueue.file(context).appendText(
      NotifyDecisionQueue.serialize(
        NotifyDecisionQueue.Decision("rid-wire", "evt-wire", "question", "{}", queuedAt, "failed", 6, 9),
      ) + System.lineSeparator(),
    )

    NotifyActionReceiver().onReceive(context, retryIntent("evt-wire"))

    val after = NotifyDecisionQueue.load(context).single { it.requestId == "rid-wire" }
    assertTrue(
      "点重试之后墙钟起点必须重置（否则下一次 flush 立刻再判失败 = 用户又收到一条「提交失败」），"
        + "实得 ts=" + after.ts + "，入队时刻=" + queuedAt,
      after.ts > queuedAt,
    )
    assertEquals("点重试之后必须回到 pending（不是留在 failed 等下一次重判）", "pending", after.state)
    assertEquals("HTTP 失败计数必须归零", 0, after.attempts)
  }

  @Test
  fun 没有对应决策时重试不得凭空造一条() {
    val context = filesContext(tempDir())
    NotifyActionReceiver().onReceive(context, retryIntent("evt-unknown"))
    assertEquals("队列里没有这条事件时不得写入任何决策", 0, NotifyDecisionQueue.load(context).size)
  }
}
