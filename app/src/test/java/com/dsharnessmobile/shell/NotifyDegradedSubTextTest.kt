package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1407 回归：降级告示不得覆盖更具体的 subText。
 *
 * 缺陷形态：`build()` 的 APPROVAL 分支先写「仅本次生效」，紧接着的降级告示分支无条件
 * `setSubText(degradedNotice)` 把它顶掉——用户会把一次性授权当成长期授权。注释本来就写着
 * 「不覆盖更具体的 subText」，实现与注释相反。
 *
 * 两层判据：① 纯函数矩阵（哪些 face 自带 subText，新增分支不同步即红）；
 * ② 源码契约（降级告示的写入必须经过那张表，撤掉 guard 即红）。
 */
class NotifyDegradedSubTextTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun 审批与进度类自带具体subText() {
    assertTrue("审批通知写着「仅本次生效」，降级告示不得覆盖", NotifyCenter.hasSpecificSubText(NotifyCenter.Face.APPROVAL, 1))
    assertTrue("进度通知自带步骤", NotifyCenter.hasSpecificSubText(NotifyCenter.Face.TODO, 1))
    assertTrue("汇报通知自带元信息", NotifyCenter.hasSpecificSubText(NotifyCenter.Face.REPORT, 1))
  }

  @Test
  fun 静默类只在多条时占用subText() {
    assertFalse("单条静默没有 subText，降级告示可以写", NotifyCenter.hasSpecificSubText(NotifyCenter.Face.SILENT, 1))
    assertTrue("多条静默写着条数，不得覆盖", NotifyCenter.hasSpecificSubText(NotifyCenter.Face.SILENT, 2))
  }

  @Test
  fun 提问类不占subText() {
    assertFalse(NotifyCenter.hasSpecificSubText(NotifyCenter.Face.QUESTION, 1))
  }

  @Test
  fun 降级告示的写入必须经过占用判据() {
    val code = codeOnly(source("NotifyCenter.kt"))
    assertTrue(
      "降级告示必须受 hasSpecificSubText 保护",
      code.contains("degradedNotice != null && !hasSpecificSubText(face, entry.count)"),
    )
    assertFalse(
      "不得回到无条件覆盖的写法",
      code.contains("if (degradedNotice != null) b.setSubText(degradedNotice)"),
    )
  }
}
