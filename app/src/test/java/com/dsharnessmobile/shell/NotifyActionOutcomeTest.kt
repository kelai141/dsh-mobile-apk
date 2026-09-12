package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通知动作 outcome 回归（§6.3.2 / NT-14、NT-16、NT-21）：
 * 审批闭集只有 allowed-once / rejected；回复按提问 id 配对；空回复不入队。
 */
class NotifyActionOutcomeTest {

  @Test
  fun 批准与拒绝是审批的唯一两个结局() {
    // 不比较 JSON 字符串（org.json 的键序不保证），逐字段断言
    val approve = NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_APPROVE, null, null, null)!!
    assertEquals("result", approve.getString("kind"))
    assertEquals("allowed-once", approve.getString("value"))
    val reject = NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_REJECT, null, null, null)!!
    assertEquals("result", reject.getString("kind"))
    assertEquals("rejected", reject.getString("value"))
    // 不存在任何常驻授权词汇（协议闭集 allowed-once | rejected | cancelled | unavailable）
    val word = approve.getString("value") + reject.getString("value")
    assertTrue(!word.contains("always"))
    assertTrue(!word.contains("allow-all"))
    assertTrue(!word.contains("permanent"))
  }

  @Test
  fun 选项动作按提问id配对selected() {
    val o = NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_OPTION, "白天", null, "q1")
    assertTrue(o != null)
    val answers = o!!.getJSONObject("value").getJSONArray("answers")
    assertEquals(1, answers.length())
    assertEquals("q1", answers.getJSONObject(0).getString("id"))
    assertEquals("白天", answers.getJSONObject(0).getJSONArray("selected").getString(0))
    assertTrue(!answers.getJSONObject(0).has("custom"))
  }

  @Test
  fun 回复动作走custom且询问id缺失时有兜底() {
    val o = NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_REPLY, null, " 好的 ", "q2")
    val answer = o!!.getJSONObject("value").getJSONArray("answers").getJSONObject(0)
    assertEquals("q2", answer.getString("id"))
    assertEquals("好的", answer.getString("custom"))
    assertEquals(0, answer.getJSONArray("selected").length())

    val fallback = NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_REPLY, null, "hi", null)
    assertEquals("q", fallback!!.getJSONObject("value").getJSONArray("answers").getJSONObject(0).getString("id"))
  }

  @Test
  fun 空回复与未知动作不入队() {
    assertNull(NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_REPLY, null, "", "q1"))
    assertNull(NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_REPLY, null, "   ", "q1"))
    assertNull(NotifyActionReceiver.outcomeFor("future-action", null, "x", "q1"))
    assertNull(NotifyActionReceiver.outcomeFor(NotifyActionReceiver.ACTION_RETRY, null, null, null))
  }

  @Test
  fun 结果键与显式动作字面量稳定() {
    // 三处必须同字面量：通知动作、接收侧读取、用例
    assertEquals("dsh.reply", NotifyActionReceiver.REPLY_KEY)
    assertEquals("com.dsharnessmobile.shell.action.NOTIFY_ACTION", NotifyActionReceiver.ACTION_NOTIFY_ACTION)
    assertEquals("dsh.action", NotifyActionReceiver.EXTRA_ACTION)
    assertEquals("dsh.eventId", NotifyActionReceiver.EXTRA_EVENT_ID)
    assertEquals("dsh.kind", NotifyActionReceiver.EXTRA_KIND)
    assertEquals("dsh.option", NotifyActionReceiver.EXTRA_OPTION)
    assertEquals("dsh.questionId", NotifyActionReceiver.EXTRA_QUESTION_ID)
  }
}
