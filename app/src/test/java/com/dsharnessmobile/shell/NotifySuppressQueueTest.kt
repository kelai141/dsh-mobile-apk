package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 前台抑制待投队列的纯逻辑回归（0.14.1 块J FIX-1）。
 *
 * 背景：旧实现「抑制 = 永久丢弃」（命中即 return 终态），用户体感「必须划到后台才推送」。
 * FIX-1 改为「抑制 = 延后」，立刻带来两个可预见的退化，本测试逐个钉住：
 *  ① 无 TTL ⇒ 退后台时把几十分钟前的陈旧汇报一次弹一堆；
 *  ② 无去重/无界 ⇒ 同一会话堆积多条（与 NotificationManager 的覆盖式 ID 语义自相矛盾）且队列无界。
 *
 * 全部是纯函数（不碰 Android/Looper），可在 JVM 上直接跑。
 */
class NotifySuppressQueueTest {

  private fun entry(id: String, session: String = "s1") = NotifyEntry(
    kind = "report", sessionId = session, eventId = id, title = "会话 " + session,
  )

  @Test
  fun 同会话后写覆盖前写且移队尾() {
    val t0 = 1_000_000L
    var q = NotifySuppressQueue.merge(emptyList(), entry("e1"), "report:s1", t0)
    q = NotifySuppressQueue.merge(q, entry("e2"), "report:s1", t0 + 100)
    assertEquals("同 key 必须合并为一条（覆盖式，不得堆两条）", 1, q.size)
    assertEquals("后写必须覆盖前写", "e2", q[0].entry.eventId)
  }

  @Test
  fun 不同会话互不覆盖() {
    val t0 = 1_000_000L
    var q = NotifySuppressQueue.merge(emptyList(), entry("e1", "s1"), "report:s1", t0)
    q = NotifySuppressQueue.merge(q, entry("e2", "s2"), "report:s2", t0)
    assertEquals(2, q.size)
  }

  @Test
  fun 过期条目在合并时被清掉() {
    val t0 = 1_000_000L
    val q = NotifySuppressQueue.merge(emptyList(), entry("old", "s1"), "report:s1", t0)
    // 距入队已超 TTL：合并新条目时旧条目必须被清掉（否则陈旧汇报会一直等着退后台补弹）。
    val later = t0 + NotifySuppressQueue.TTL_MS + 1
    val merged = NotifySuppressQueue.merge(q, entry("new", "s2"), "report:s2", later)
    assertEquals("过期项必须被清除，只剩新项", 1, merged.size)
    assertEquals("new", merged[0].entry.eventId)
  }

  @Test
  fun isExpired边界() {
    val t0 = 1_000L
    assertFalse("未到 TTL 不得判过期", NotifySuppressQueue.isExpired(t0, t0 + NotifySuppressQueue.TTL_MS - 1))
    assertTrue("到 TTL 即过期", NotifySuppressQueue.isExpired(t0, t0 + NotifySuppressQueue.TTL_MS))
  }

  @Test
  fun 队列有界_超容量保留最新() {
    val t0 = 1_000_000L
    var q = emptyList<NotifySuppressQueue.Pending>()
    val n = NotifySuppressQueue.MAX_PENDING + 5
    for (i in 0 until n) {
      q = NotifySuppressQueue.merge(q, entry("e$i", "s$i"), "report:s$i", t0 + i)
    }
    assertEquals("队列不得超过容量上限（防无界内存）", NotifySuppressQueue.MAX_PENDING, q.size)
    assertEquals("保留的必须是最新的那批", "e" + (n - 1), q.last().entry.eventId)
  }

  @Test
  fun 单次补投有上限_且最新优先() {
    val t0 = 1_000_000L
    var q = emptyList<NotifySuppressQueue.Pending>()
    for (i in 0 until NotifySuppressQueue.MAX_PENDING) {
      q = NotifySuppressQueue.merge(q, entry("e$i", "s$i"), "report:s$i", t0 + i)
    }
    val (deliver, expired) = NotifySuppressQueue.takeForFlush(q, t0 + 100)
    assertEquals("单次补投必须封顶（防退后台瞬间弹一串）", NotifySuppressQueue.MAX_DELIVER_PER_FLUSH, deliver.size)
    assertEquals(0, expired)
    assertEquals("补投必须取最新的（用户最关心刚做完的那一轮）",
      "e" + (NotifySuppressQueue.MAX_PENDING - 1), deliver.last().entry.eventId)
  }

  @Test
  fun 过期项不计入补投但被计入丢弃() {
    val t0 = 1_000_000L
    val q = listOf(
      NotifySuppressQueue.Pending("report:old", entry("old"), t0),
      NotifySuppressQueue.Pending("report:fresh", entry("fresh"), t0 + NotifySuppressQueue.TTL_MS),
    )
    val now = t0 + NotifySuppressQueue.TTL_MS + 1
    val (deliver, expired) = NotifySuppressQueue.takeForFlush(q, now)
    assertEquals("过期项不得补投", 1, deliver.size)
    assertEquals("fresh", deliver[0].entry.eventId)
    assertEquals("过期项必须被如实计数（丢弃要可观测，不得静默）", 1, expired)
  }

  @Test
  fun 覆盖式去重键与会话粒度一致() {
    // 必须与 notificationId 的 report 粒度（dsh-report:<sessionId>）同源，否则补投会与覆盖式 ID 冲突。
    assertEquals("report:s1", NotifyCenter.deferredKey(entry("e1", "s1")))
    assertEquals("report:s2", NotifyCenter.deferredKey(entry("e2", "s2")))
    // 会话为空时退化为事件身份（不得让不同事件互相吞掉）。
    assertEquals("report:e9", NotifyCenter.deferredKey(NotifyEntry(kind = "report", eventId = "e9")))
  }
}
