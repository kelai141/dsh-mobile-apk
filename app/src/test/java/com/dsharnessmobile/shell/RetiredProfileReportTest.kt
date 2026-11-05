package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #903：退役条目的**可读报告**（进可导出诊断，不只进开发日志）。
 *
 * 缺陷不是「删了用户的行」—— `dsh-undo-savepoint` 是 0.14.8 已退役的工厂条目
 *（`RETIRED_FACTORY_ENTRIES`），移除是设计行为。缺陷是**用户完全看不到**，于是每次更新后
 * 都以为是 bug、手工加回去、下次再被移除。
 *
 * 因此本组断言守的是**文案与可追溯性**，不是删除逻辑本身：
 *  ① 必须说「已退役」（解释为什么），不能说成「删除你的配置」；
 *  ② 必须给出备份文件名，用户能据此回看差异；
 *  ③ 没有被移除的条目时**不产生噪音**（返回 null）。
 */
class RetiredProfileReportTest {
  @Test
  fun `报告点名被移除的退役条目并说明原因`() {
    val report = FactoryProfilePatch.retiredRemovalReport(
      before = setOf("dsh-undo-savepoint", "ui-layout", "persona"),
      after = setOf("persona"),
      backupName = "cordis.patch.yml.pre-0.14.10-abc.bak",
    )
    assertTrue("必须在场", report != null)
    val r = report!!
    assertTrue("必须说「已退役」: " + r, r.contains("已退役"))
    assertTrue("不得说成删除用户配置: " + r, !r.contains("删除"))
    assertTrue("必须点名被移除的 id: " + r, r.contains("dsh-undo-savepoint"))
    assertTrue("也必须点名 ui-layout: " + r, r.contains("ui-layout"))
    assertFalse("未移除的 id 不得出现: " + r, r.contains("persona"))
  }

  @Test
  fun `报告附备份文件名，便于用户回看差异`() {
    val backup = "cordis.patch.yml.pre-0.14.10-9f2c.bak"
    val r = FactoryProfilePatch.retiredRemovalReport(setOf("a"), emptySet(), backup)!!
    assertTrue("必须给出备份文件名: " + r, r.contains(backup))
    assertTrue(r.contains("备份"))
  }

  @Test
  fun `没有被移除的条目时不产生噪音`() {
    assertNull(FactoryProfilePatch.retiredRemovalReport(setOf("persona"), setOf("persona"), "x.bak"))
    assertNull(FactoryProfilePatch.retiredRemovalReport(emptySet(), emptySet(), "x.bak"))
  }

  @Test
  fun `ids 排序稳定，便于比对诊断`() {
    val a = FactoryProfilePatch.retiredRemovalReport(setOf("b", "a", "c"), emptySet(), "x.bak")
    val b = FactoryProfilePatch.retiredRemovalReport(setOf("c", "a", "b"), emptySet(), "x.bak")
    assertEquals("集合输入顺序不得影响输出", a, b)
    assertTrue(a!!.indexOf("a") < a.indexOf("b"))
  }
}