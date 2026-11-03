package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1408 回归：通知的动作按钮标题必须跟语言走。
 *
 * 缺陷形态：提问/审批通知的四个动作标题硬编码中文（「打开应用作答」「批准一次」「拒绝」「重试」），
 * 英文系统下仍是中文；同文件的 RemoteInput 回复标签（#1011 ②）已经走过 `UiText`，这四个漏了。
 *
 * 判据落在「标题必须是 UiText.t(app, 中文, English) 的调用」上，而不是「有没有英文」：
 * 后者在文案改写时容易误判，前者撤掉本地化即红。
 */
class NotifyActionLabelsTest {

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
  fun 四个动作标题必须走双语通道() {
    val code = codeOnly(source("NotifyCenter.kt"))
    val expected = listOf(
      "打开应用作答" to "Open app to answer",
      "批准一次" to "Allow once",
      "拒绝" to "Reject",
      "重试" to "Retry",
    )
    for ((zh, en) in expected) {
      assertTrue(
        "动作标题「" + zh + "」必须走 UiText.t（中英各一份）",
        code.contains("UiText.t(app, \"" + zh + "\", \"" + en + "\")"),
      )
    }
  }

  @Test
  fun 不得留下裸中文标题() {
    val code = codeOnly(source("NotifyCenter.kt"))
    // 旧形态：标题是裸字面量（缩进固定，撤掉本地化即红）。
    val bare = listOf(
      "\n          \"打开应用作答\",",
      "\n      \"批准一次\",",
      "\n      \"拒绝\",",
      ", \"重试\", pending)",
    )
    for (form in bare) {
      assertFalse("动作标题不得以裸中文出现：" + form.trim(), code.contains(form))
    }
  }
}
