package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1409 回归：通知动作数溢出时必须给出「打开应用作答」入口。
 *
 * 缺陷形态：`questionNeedsAppEntry` 只看**单个问题**的选项数（`any { options.size > 2 }`）。
 * 多问叠加时「1 个回复 + Σ选项」会超过折叠态能画的动作数，而单看每个问题都没超标 ⇒ 判据
 * 返回 false，第 2 个问题起既点不到也没有引导入口。
 *
 * 判据按**总动作数**（1 个回复 + 每个可选项提问的选项按钮）而不是单问选项数。
 */
class NotifyQuestionActionBudgetTest {

  private fun entry(vararg optionCounts: Int): NotifyEntry = NotifyEntry(
    kind = "question",
    questions = optionCounts.mapIndexed { index, count ->
      NotifyQuestion(id = "q" + index, options = (1..count).map { "o" + it })
    },
  )

  @Test
  fun 单问两选项刚好占满折叠态_不需要入口() {
    assertFalse("1 个回复 + 2 个选项 = 3，折叠态画得下", NotifyCenter.questionNeedsAppEntry(entry(2)))
  }

  @Test
  fun 两个单选项提问也是三个动作_不需要入口() {
    assertFalse("1 个回复 + 1 + 1 = 3", NotifyCenter.questionNeedsAppEntry(entry(1, 1)))
  }

  @Test
  fun 多问叠加超过折叠态_必须给入口() {
    assertTrue("1 个回复 + 2 + 1 = 4 > 3", NotifyCenter.questionNeedsAppEntry(entry(2, 1)))
    assertTrue("1 个回复 + 2 + 2 = 5 > 3", NotifyCenter.questionNeedsAppEntry(entry(2, 2)))
    assertTrue("三个问题各两选项 = 7（issue 的复现用例）", NotifyCenter.questionNeedsAppEntry(entry(2, 2, 2)))
  }

  @Test
  fun 单问选项多于两个仍然必须给入口() {
    assertTrue("通知栏根本加不出这三个按钮", NotifyCenter.questionNeedsAppEntry(entry(3)))
    assertTrue("一问三选项 + 一问两选项", NotifyCenter.questionNeedsAppEntry(entry(3, 2)))
  }

  @Test
  fun 判据必须按总动作数而不是单问选项数() {
    val code = File("src/main/java/com/dsharnessmobile/shell/NotifyCenter.kt").takeIf { it.isFile }
      ?: File("app/src/main/java/com/dsharnessmobile/shell/NotifyCenter.kt")
    val source = code.readText()
    assertTrue(
      "判据必须统计总动作数（1 + Σ可选项提问的选项数）",
      source.contains("val optionActions = entry.questions.filter { it.options.size in 1..2 }.sumOf { it.options.size }"),
    )
    assertTrue(
      "折叠态动作上限必须是有名字的常量，不写裸 3",
      source.contains("internal const val MAX_COLLAPSED_ACTIONS = 3"),
    )
  }
}
