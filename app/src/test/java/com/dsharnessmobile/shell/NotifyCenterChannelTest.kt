package com.dsharnessmobile.shell

import android.app.NotificationManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 渠道定案与迁移判定的纯逻辑回归（§6.1.1 / §6.1.2，NT-01/NT-02）。
 * 渠道 importance 创建后不可逆——这里的定死值就是那一条不可逆约束的锁。
 */
class NotifyCenterChannelTest {

  @Test
  fun 五类信道的候选ID与importance一次定死() {
    // 静默两类必须 LOW；弹窗三类必须 HIGH（建错只能换 ID，热修无效）
    assertEquals(listOf("dsh-silent"), NotifyCenter.Face.SILENT.candidates)
    assertEquals(NotificationManager.IMPORTANCE_LOW, NotifyCenter.Face.SILENT.importance)
    assertEquals(listOf("dsh-todo-progress"), NotifyCenter.Face.TODO.candidates)
    assertEquals(NotificationManager.IMPORTANCE_LOW, NotifyCenter.Face.TODO.importance)

    assertEquals("dsh-report", NotifyCenter.Face.REPORT.candidates.first())
    assertEquals(listOf("dsh-report", "dsh-report-h2"), NotifyCenter.Face.REPORT.candidates)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, NotifyCenter.Face.REPORT.importance)

    assertEquals(listOf("dsh-question", "dsh-question-h2"), NotifyCenter.Face.QUESTION.candidates)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, NotifyCenter.Face.QUESTION.importance)

    // dsh-auth 复用（历史 HIGH、无调用方），后续是迁移代次
    assertEquals(listOf("dsh-auth", "dsh-auth-h2", "dsh-auth-h3"), NotifyCenter.Face.APPROVAL.candidates)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, NotifyCenter.Face.APPROVAL.importance)
    assertEquals(NotificationManager.IMPORTANCE_LOW.coerceAtMost(2), 2)
  }

  @Test
  fun 弹窗类只有report_question_approval() {
    val popup = NotifyCenter.Face.values().filter { it.popup }.map { it.category }
    assertEquals(listOf("report", "question", "approval"), popup)
  }

  @Test
  fun S2_渠道不存在时首次创建且用目标importance() {
    val sel = NotifyCenter.selectChannel(
      listOf("dsh-question", "dsh-question-h2"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf("dsh-question" to null, "dsh-question-h2" to null),
    )
    assertEquals("dsh-question", sel.channelId)
    assertTrue(sel.create)
    assertEquals("create", sel.reason)
  }

  @Test
  fun S2_渠道已达目标importance时直接使用不重建() {
    val sel = NotifyCenter.selectChannel(
      listOf("dsh-auth"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf("dsh-auth" to NotifyCenter.ChannelFact("dsh-auth", NotificationManager.IMPORTANCE_HIGH, true)),
    )
    assertEquals("dsh-auth", sel.channelId)
    assertEquals(false, sel.create)
    assertEquals("selected", sel.reason)
  }

  @Test
  fun S3_历史低importance且用户没改过_自动切下一个候选() {
    val sel = NotifyCenter.selectChannel(
      listOf("dsh-auth", "dsh-auth-h2", "dsh-auth-h3"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf(
        "dsh-auth" to NotifyCenter.ChannelFact("dsh-auth", NotificationManager.IMPORTANCE_LOW, false),
        "dsh-auth-h2" to null,
      ),
    )
    assertEquals("dsh-auth-h2", sel.channelId)
    assertTrue(sel.create)
    assertEquals("migrated", sel.reason)
  }

  @Test
  fun S3_候选逐个被历史建低时继续顺延() {
    val sel = NotifyCenter.selectChannel(
      listOf("dsh-auth", "dsh-auth-h2", "dsh-auth-h3"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf(
        "dsh-auth" to NotifyCenter.ChannelFact("dsh-auth", NotificationManager.IMPORTANCE_LOW, false),
        "dsh-auth-h2" to NotifyCenter.ChannelFact("dsh-auth-h2", NotificationManager.IMPORTANCE_MIN, false),
      ),
    )
    assertEquals("dsh-auth-h3", sel.channelId)
  }

  @Test
  fun S4_用户亲手降级时不换ID_降级为静默() {
    val sel = NotifyCenter.selectChannel(
      listOf("dsh-auth", "dsh-auth-h2", "dsh-auth-h3"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf("dsh-auth" to NotifyCenter.ChannelFact("dsh-auth", NotificationManager.IMPORTANCE_LOW, true)),
    )
    assertNull(sel.channelId)
    assertTrue(sel.degraded)
    assertEquals("user-demoted", sel.reason)
  }

  @Test
  fun S5_候选全部耗尽也未静默失败_降级为静默并留原因() {
    val sel = NotifyCenter.selectChannel(
      listOf("dsh-report", "dsh-report-h2"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf(
        "dsh-report" to NotifyCenter.ChannelFact("dsh-report", NotificationManager.IMPORTANCE_LOW, true),
      ),
    )
    assertNull(sel.channelId)
    assertEquals("user-demoted", sel.reason)

    val exhausted = NotifyCenter.selectChannel(
      listOf("dsh-report", "dsh-report-h2"),
      NotificationManager.IMPORTANCE_HIGH,
      mapOf(
        "dsh-report" to NotifyCenter.ChannelFact("dsh-report", NotificationManager.IMPORTANCE_LOW, false),
        "dsh-report-h2" to NotifyCenter.ChannelFact("dsh-report-h2", NotificationManager.IMPORTANCE_LOW, false),
      ),
    )
    assertNull(exhausted.channelId)
    assertEquals("exhausted", exhausted.reason)
  }

  @Test
  fun 通知ID_静默两类固定_汇报按会话_提问审批按事件() {
    val silent = NotifyEntry(kind = "silent")
    assertEquals(NotifyCenter.ID_WATCHDOG, NotifyCenter.notificationId(silent, NotifyCenter.Face.SILENT))
    val todo = NotifyEntry(kind = "todo")
    assertEquals(NotifyCenter.ID_TODO, NotifyCenter.notificationId(todo, NotifyCenter.Face.TODO))

    val reportA = NotifyEntry(kind = "report", sessionId = "sess-a")
    val reportA2 = NotifyEntry(kind = "report", sessionId = "sess-a", summary = "第二轮")
    val reportB = NotifyEntry(kind = "report", sessionId = "sess-b")
    assertEquals(NotifyCenter.notificationId(reportA, NotifyCenter.Face.REPORT), NotifyCenter.notificationId(reportA2, NotifyCenter.Face.REPORT))
    assertTrue(NotifyCenter.notificationId(reportA, NotifyCenter.Face.REPORT) != NotifyCenter.notificationId(reportB, NotifyCenter.Face.REPORT))

    val q1 = NotifyEntry(kind = "question", eventId = "e1")
    val q2 = NotifyEntry(kind = "question", eventId = "e2")
    assertTrue(NotifyCenter.notificationId(q1, NotifyCenter.Face.QUESTION) != NotifyCenter.notificationId(q2, NotifyCenter.Face.QUESTION))
    // 同一个 eventId 的重复投递必须落到同一 ID（覆盖式更新 + cancel 可撤）
    assertEquals(NotifyCenter.notificationId(q1, NotifyCenter.Face.QUESTION), NotifyCenter.notificationId(NotifyEntry(kind = "question", eventId = "e1"), NotifyCenter.Face.QUESTION))
  }

  @Test
  fun 汇报文案与用时标签() {
    val completed = NotifyEntry(kind = "report", outcome = "completed")
    assertEquals("已完成", completed.outcomeLabel())
    assertEquals("失败", NotifyEntry(kind = "report", outcome = "error").outcomeLabel())
    assertEquals("被阻塞", NotifyEntry(kind = "report", outcome = "blocked").outcomeLabel())
    assertEquals("已中止", NotifyEntry(kind = "report", outcome = "aborted").outcomeLabel())
    assertEquals("输出超限", NotifyEntry(kind = "report", outcome = "max-tokens").outcomeLabel())
    assertEquals("被中断", NotifyEntry(kind = "report", outcome = "interrupted").outcomeLabel())
    assertEquals("结果未知", NotifyEntry(kind = "report", outcome = "future-kind").outcomeLabel())
    assertEquals("", NotifyEntry(kind = "report").outcomeLabel())

    assertEquals("-" , NotifyEntry(kind = "report").durationLabel())
    assertEquals("8.4s", NotifyEntry(kind = "report", durationMs = 8_400).durationLabel())
    assertEquals("1m24s", NotifyEntry(kind = "report", durationMs = 84_000).durationLabel())
    assertEquals("自定义", NotifyEntry(kind = "report", durationMs = 1, durationLabel = "自定义").durationLabel())
  }

  @Test
  fun 类别到face的映射与旧调用点兼容() {
    for (face in NotifyCenter.Face.values()) {
      assertEquals(face, NotifyCenter.Face.of(face.category))
    }
    assertNull(NotifyCenter.Face.of("task"))
    assertNull(NotifyCenter.Face.of("unknown"))
    // 旧渠道 ID 不得被新语义复用（dsh-task/dsh-todo 保持不动）
    val used = NotifyCenter.Face.values().flatMap { it.candidates }
    assertTrue(!used.contains("dsh-task"))
    assertTrue(!used.contains("dsh-todo"))
    assertTrue(!used.contains("engine"))
  }
}
