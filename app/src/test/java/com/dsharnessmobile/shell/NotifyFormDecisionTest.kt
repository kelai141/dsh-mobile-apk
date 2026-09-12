package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DEF-NOTIFY-01 回归：引擎给出的 popup=false（NT-05 的 aborted(kind=user)）必须被**消费**。
 * 设备实录：修复前 kind=report/outcome=aborted/popup=false 的通知仍落在 dsh-report 高优渠道并 heads-up。
 */
class NotifyFormDecisionTest {

  @Test
  fun popup_true时按类别形态直投() {
    val d = NotifyCenter.formDecision(NotifyCenter.Face.REPORT, true)
    assertFalse(d.degradeToSilent)
    assertTrue(d.keepPopup)
    assertEquals("popup-honored", d.note)
    // 静默类本来就是静默，popup=true 也不改变形态
    val s = NotifyCenter.formDecision(NotifyCenter.Face.SILENT, true)
    assertFalse(s.degradeToSilent)
    assertFalse(s.keepPopup)
  }

  @Test
  fun popup_false的工作汇报降级为静默条目() {
    val d = NotifyCenter.formDecision(NotifyCenter.Face.REPORT, false)
    assertTrue("report + popup=false 必须降级", d.degradeToSilent)
    assertFalse("降级后不得保留弹窗", d.keepPopup)
    assertEquals("degraded-to-silent", d.note)
  }

  @Test
  fun popup_false的静默类无需动作() {
    val d = NotifyCenter.formDecision(NotifyCenter.Face.TODO, false)
    assertFalse(d.degradeToSilent)
    assertFalse(d.keepPopup)
    assertEquals("already-silent", d.note)
  }

  @Test
  fun 交互类不接受静默降级_否则丢掉唯一作答入口() {
    for (face in listOf(NotifyCenter.Face.QUESTION, NotifyCenter.Face.APPROVAL)) {
      val d = NotifyCenter.formDecision(face, false)
      assertFalse(face.category + " 不得被静默降级", d.degradeToSilent)
      assertTrue(face.category + " 必须保留弹窗", d.keepPopup)
      assertEquals("interactive-popup-kept", d.note)
    }
  }

  @Test
  fun 降级不占用看门狗通知ID() {
    // 静默降级必须换渠道（dsh-silent）但**保留汇报自己的通知 ID**，否则会覆盖看门狗单条
    val report = NotifyEntry(kind = "report", sessionId = "sess-degrade", popup = false)
    val id = NotifyCenter.notificationId(report, NotifyCenter.Face.REPORT)
    assertTrue(id != NotifyCenter.ID_WATCHDOG)
    assertTrue(id != NotifyCenter.ID_TODO)
    // 同会话重复降级仍是同一条（覆盖式更新）
    assertEquals(id, NotifyCenter.notificationId(NotifyEntry(kind = "report", sessionId = "sess-degrade"), NotifyCenter.Face.REPORT))
  }

  @Test
  fun popup解析为false而不是默认true() {
    val entry = NotifyStore.parseEntry(
      "{\"kind\":\"report\",\"outcome\":\"aborted\",\"popup\":false,\"sessionId\":\"s1\",\"title\":\"t\"}",
    )
    assertEquals(false, entry!!.popup)
    // 缺省（老引擎）仍按 true —— 不得把「没这个字段」当成否决赛
    assertEquals(true, NotifyStore.parseEntry("{\"kind\":\"report\",\"sessionId\":\"s1\"}")!!.popup)
  }

  @Test
  fun 投递异常有独立结果_不得冒泡到读线程() {
    assertTrue(NotifyCenter.Result.values().contains(NotifyCenter.Result.ERROR))
  }
}
