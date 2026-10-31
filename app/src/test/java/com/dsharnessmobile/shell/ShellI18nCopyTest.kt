package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 壳侧文案双语回归（issue #986 / #987 / #992 / #1011）。
 *
 * 判据分两半，缺一半就会退化成「删掉就绿」：
 *  - (a) 英文态**不得出现中文**：判据是「含 CJK 即红」，但只查 **UI 文案常量路径**——
 *    用户数据（会话标题、目录名、摘要正文、引擎给的标签）本来就可以是中文，不在判据范围内；
 *  - (b) 中文态**不得为空、不得退回英文**：每条都另有一条正向断言钉住中文那一份的**具体内容**，
 *    所以「把中文删了」或「两份都写成英文」会当场红。
 *
 * 纯 JVM（无 Robolectric）：参与文案计算的部分都抽成了不吃 `Context` 的纯函数
 * （[reportLines] / [reportOutcomeHead] / [pickerRelativeTimeText] / [pickerSessionLabelText] /
 * [pickerTargetRowText] / [NotifyCenter.degradedNoticeText] / [NotifyCenter.replyActionLabel] /
 * [localDocDialogCopy] / [pluginLoadErrorMessage] / [repairAssistantCopy]），
 * 测试断言的是**生产代码用的那张表**，不另写一份。
 */
class ShellI18nCopyTest {

  /** 含 CJK 即红（英文态判据）。 */
  private fun hasCjk(text: String): Boolean = text.any { it.code in 0x4E00..0x9FFF }

  private fun assertEnglishCopy(what: String, text: String) {
    assertTrue(what + " 不得为空（空文案等于把这一行删了）", text.isNotBlank())
    assertFalse(what + " 在英文态不得含中文（实际：" + text + "）", hasCjk(text))
  }

  private fun assertChineseCopy(what: String, text: String, mustContain: String) {
    assertTrue(what + " 中文态不得为空", text.isNotBlank())
    assertTrue(what + " 中文态必须含「" + mustContain + "」（实际：" + text + "）", text.contains(mustContain))
  }

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释里复述旧实现，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")
  // ── #986 汇报栏首行：结论标签必须按当前语言重算 ─────────────────────────

  /**
   * 缺陷现场：`outcomeLabel` 是**通知发出时**按当时语言写进条目的字符串
   * （NotifyCenter.sendTest 里就是 UiText.t(app, "已完成", "Completed")），语言切换不会重算；
   * 旧实现 `entry.outcomeLabel.ifBlank { entry.outcomeLabel(app) }` 让这个落库值**永远优先**，
   * 于是中文跑完一轮再切英文，首行仍是「已完成 · …」。
   */
  @Test
  fun reportHeadUsesTheCurrentLocaleNotTheStoredLabel() {
    val stored = NotifyEntry(kind = "report", outcome = "completed", outcomeLabel = "已完成", summary = "修好了三处回执")

    // 判据只落在**文案常量**（结论标签）上：摘要正文是引擎产出的用户数据，中文完全合法，
    // 不参与「含 CJK 即红」。数据必须原样保留，这一点另有断言。
    val en = reportLines(stored, english = true)
    assertEnglishCopy("汇报栏首行结论（英文态）", reportOutcomeHead(stored, english = true))
    assertTrue("英文态首行必须是结论 + 摘要（实际：" + en[0] + "）", en[0].startsWith("Completed"))
    assertTrue("摘要（用户数据）必须原样保留（实际：" + en[0] + "）", en[0].endsWith("修好了三处回执"))

    val zh = reportLines(stored, english = false)
    assertChineseCopy("汇报栏首行（中文态）", zh[0], "已完成")
    assertTrue("中文态仍要带摘要", zh[0].contains("修好了三处回执"))

    // 反向：outcome 为空时不得把落库标签再拿出来用（那正是旧行为）。
    val unknown = NotifyEntry(kind = "report", outcome = "", outcomeLabel = "已完成", summary = "只有正文")
    val unknownHead = reportOutcomeHead(unknown, english = true)
    assertFalse("outcome 为空时不得回落到落库的中文标签（实际：" + unknownHead + "）", hasCjk(unknownHead))
    assertEquals("必须给可读的兜底结论", "Work report", unknownHead)
  }

  /** 汇报栏的**正文判重**用的是同一个 head，必须同口径（否则英文态会把正文判成「与首行重复」而吞掉）。 */
  @Test
  fun reportBodyRedundancyUsesTheSameHead() {
    val entry = NotifyEntry(kind = "report", outcome = "completed", outcomeLabel = "已完成", summary = "修好了三处回执")
    val full = reportBodyText(entry)
    assertTrue("同一句话判重（中文）", reportBodyRedundant(entry, full, english = false))
    assertTrue("同一句话判重（英文）", reportBodyRedundant(entry, full, english = true))
    assertFalse("正文更长时不得判重", reportBodyRedundant(entry, full + "，并补了测试", english = true))
  }

  // ── #987 浮层目标行 + 相对时间 ───────────────────────────────────────────

  /** 缺陷现场：`relativeTime()` 全分支硬编码中文，且值在取列表时就算死存进 PickerSession。 */
  @Test
  fun pickerRelativeTimeFollowsTheLocale() {
    val now = 1_700_000_000_000L
    val cases = listOf(
      listOf(0L, "未知时间", "unknown time"),
      listOf(now - 30_000L, "刚刚", "just now"),
      listOf(now - 5 * 60_000L, "5分钟前", "5 min ago"),
      listOf(now - 3 * 3_600_000L, "3小时前", "3 h ago"),
      listOf(now - 2 * 86_400_000L, "2天前", "2 d ago"),
    )
    for (case in cases) {
      val ts = case[0] as Long
      val zh = pickerRelativeTimeText(ts, english = false, now = now)
      val en = pickerRelativeTimeText(ts, english = true, now = now)
      assertEquals("中文态必须保持既有口径", case[1] as String, zh)
      assertEquals("英文态必须跟随语言", case[2] as String, en)
      assertEnglishCopy("相对时间（英文态，ts=" + ts + "）", en)
    }
  }

  /** 目标行：空目标 = 「＋ 新会话」；有目标 = 「名字（当前）」。两个方向都要有。 */
  @Test
  fun pickerTargetRowFollowsTheLocale() {
    assertEquals("＋ 新会话", pickerTargetRowText(null, english = false))
    assertEquals("＋ New session", pickerTargetRowText(null, english = true))
    assertEnglishCopy("目标行（英文态）", pickerTargetRowText(null, english = true))

    val row = sessionRowText("修好了三处回执", english = true)
    assertTrue("会话名是用户数据，必须原样保留（实际：" + row + "）", row.contains("修好了三处回执"))
    assertTrue("英文态的后缀必须是英文（实际：" + row + "）", row.endsWith(" (current)"))
    assertTrue("中文态的后缀仍是中文", sessionRowText("修好了三处回执", english = false).endsWith("（当前）"))
  }

  /** 会话列表行：占位名与相对时间是界面文案，会话名是数据。 */
  @Test
  fun pickerSessionRowsKeepDataButLocalizeCopy() {
    val now = 1_700_000_000_000L
    val blank = PickerSession("s1", "", false, now - 5 * 60_000L)
    assertEquals("未命名会话 · 5分钟前", pickerSessionLabelText(blank, english = false, now = now))
    assertEquals("Untitled session · 5 min ago", pickerSessionLabelText(blank, english = true, now = now))
    assertEnglishCopy("会话行（英文态）", pickerSessionLabelText(blank, english = true, now = now))

    val titled = PickerSession("s2", "修好了三处回执", false, now - 30_000L)
    val titledEn = pickerSessionLabelText(titled, english = true, now = now)
    assertTrue("会话名是用户数据，英文态也必须原样显示（实际：" + titledEn + "）", titledEn.startsWith("修好了三处回执"))
  }

  /** 源码形态：`applyLanguage()` 必须重算选择器行（只重算目标行不足以修掉列表里的时间列）。 */
  @Test
  fun applyLanguageRebuildsThePickerRows() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    val apply = panel.substringAfter("internal fun applyLanguage()").substringBefore("internal fun updatePickerRowText")
    assertTrue("切语言必须重算选择器行（相对时间跟着语言变）", apply.contains("refreshPickerMarks()"))
    assertFalse("目标行不得再写死中文「＋ 新会话」", panel.contains("isEmpty()) \"\\uff0b"))
  }
  // ── #992 通知降级提示 ───────────────────────────────────────────────────

  /** 缺陷现场：整句模板硬编码中文，只有里面的类别名 `face.label(app)` 跟语言走。 */
  @Test
  fun degradedNoticeIsBilingual() {
    val zh = NotifyCenter.degradedNoticeText("提问", english = false)
    val en = NotifyCenter.degradedNoticeText("Questions", english = true)
    assertChineseCopy("降级提示（中文态）", zh, "降级为静默")
    assertTrue("中文态要点名是哪一类", zh.contains("提问"))
    assertTrue("中文态要给恢复路径", zh.contains("系统设置"))
    assertEnglishCopy("降级提示（英文态）", en)
    assertTrue("英文态要点名是哪一类", en.contains("Questions"))
    assertTrue("英文态要给恢复路径（实际：" + en + "）", en.contains("settings"))
  }

  // ── #1011 三处 + 通知动作按钮 + 修复助手整页 ─────────────────────────────

  /** ① 通知栏「回复」动作按钮（RemoteInput 的 label 与 Action 标题各一处）。 */
  @Test
  fun notifyReplyActionLabelIsBilingual() {
    assertEquals("回复", NotifyCenter.replyActionLabel(english = false))
    assertEnglishCopy("通知回复按钮（英文态）", NotifyCenter.replyActionLabel(english = true))
    val center = codeOnly(source("NotifyCenter.kt"))
    assertFalse("不得再有写死中文的回复动作标题", center.contains(".setLabel(\"回复\")"))
  }

  /** ② 免责声明对话框（标题 + 关闭按钮）。 */
  @Test
  fun disclaimerDialogCopyIsBilingual() {
    val zh = localDocDialogCopy(english = false)
    val en = localDocDialogCopy(english = true)
    assertEquals("免责声明", zh.title)
    assertEquals("关闭", zh.close)
    assertEnglishCopy("免责声明标题（英文态）", en.title)
    assertEnglishCopy("免责声明关闭键（英文态）", en.close)
    val docs = codeOnly(source("LocalDocs.kt"))
    assertFalse("不得再有写死中文的对话框标题", docs.contains(".setTitle(\"免责声明\")"))
    assertFalse("不得再有写死中文的关闭键", docs.contains(".setPositiveButton(\"关闭\", null)"))
  }

  /** ③ 插件管理页的加载失败行（重试提示原本是「$message　点击重试」硬拼中文）。 */
  @Test
  fun pluginLoadErrorMessageIsBilingual() {
    val zh = pluginLoadErrorMessage("暂时无法读取插件。", retry = true, english = false)
    assertChineseCopy("插件页失败行（中文态）", zh, "点击重试")
    assertTrue("必须带上原始失败原因", zh.contains("暂时无法读取插件。"))
    val en = pluginLoadErrorMessage("Could not read plugins right now.", retry = true, english = true)
    assertEnglishCopy("插件页失败行（英文态）", en)
    assertTrue("英文态要点出可重试（实际：" + en + "）", en.contains("retry"))
    // 不重试的那一档不能凭空长出重试提示（防「都拼成同一句」）。
    assertEquals("boom", pluginLoadErrorMessage("boom", retry = false, english = true))
  }

  /** ④ 修复助手：整页主要控件文案（输入 / 发送 / 思考折叠 / 完成 / 抽屉 / 模型面板）。 */
  @Test
  fun repairAssistantCopyIsBilingual() {
    val zh = repairAssistantCopy(english = false)
    val en = repairAssistantCopy(english = true)
    val zhMap = zh.snapshot()
    for ((name, zhText) in zhMap) {
      assertTrue("修复助手 " + name + " 中文态不得为空", zhText.isNotBlank())
    }
    for ((name, enText) in en.snapshot()) {
      assertEnglishCopy("修复助手 " + name + "（英文态）", enText)
      assertNotEquals(name + " 中英必须是两份文案，不能同一句", zhMap[name], enText)
    }
    assertEquals("发送键中文态仍是「发送」", "发送", zh.send)
    assertEquals("思考折叠中文态仍是「思考」", "思考", zh.thinking)
    assertEquals("模型面板标题中文态仍是「模型与推理」", "模型与推理", zh.modelSheetTitle)
    assertTrue("英文态思考是 Thinking", en.thinking.startsWith("Thinking"))
  }

  /** 修复助手必须真的把这张表接到控件上（表本身双语但没人用 = 假绿）。 */
  @Test
  fun repairAssistantControlsReadTheCopyTable() {
    val repair = codeOnly(source("RepairActivity.kt"))
    for (needle in listOf(
      "contentDescription = copy.send",
      "copy.thinking",
      "copy.completed",
      "copy.conversationsTitle",
      "copy.newConversation",
      "copy.recent",
      "copy.noConversations",
      "copy.current",
      "copy.modelSheetTitle",
      "copy.inputHint",
    )) {
      assertTrue("修复助手控件必须读双语表：" + needle, repair.contains(needle))
    }
    assertFalse("不得再有写死中文的发送键", repair.contains("contentDescription = \"发送\""))
    assertFalse("不得再有写死中文的输入提示", repair.contains("hint = \"补充故障信息\""))
    assertFalse("不得再有写死中文的模型面板标题", repair.contains(".setTitle(\"模型与推理\")"))
  }

  /**
   * 修复助手整页的**反向判据**：中文态不得退回英文、不得为空。
   *
   * 上半段（[repairAssistantCopyIsBilingual]）只证明英文那一份没有中文；这一条证明中文那一份
   * 仍然是中文——否则「两份都写成英文」也能让上半段变绿，而中文用户会看到一整页英文。
   */
  @Test
  fun repairAssistantChineseCopyStaysChinese() {
    val zh = repairAssistantCopy(english = false)
    for ((name, zhText) in zh.snapshot()) {
      assertTrue("修复助手 " + name + " 中文态不得为空", zhText.isNotBlank())
      assertTrue("修复助手 " + name + " 中文态必须含中文（实际：" + zhText + "）", hasCjk(zhText))
    }
  }

  /** 同一反向判据覆盖 986/987/992/1011 的其余文案（防「把中文删了 / 改成英文」）。 */
  @Test
  fun chineseCopyNeverDegradesToEnglish() {
    assertTrue("汇报栏结论标签", hasCjk(reportOutcomeHead(NotifyEntry(kind = "report", outcome = "completed"), english = false)))
    assertTrue("相对时间", hasCjk(pickerRelativeTimeText(0L, english = false)))
    assertTrue("目标行", hasCjk(pickerTargetRowText(null, english = false)))
    assertTrue("降级提示", hasCjk(NotifyCenter.degradedNoticeText("提问", english = false)))
    assertTrue("回复按钮", hasCjk(NotifyCenter.replyActionLabel(english = false)))
    assertTrue("免责声明", hasCjk(localDocDialogCopy(english = false).title))
    assertTrue("插件页失败行", hasCjk(pluginLoadErrorMessage("x", retry = true, english = false)))
  }

  /** 会话行里**数据**与**文案**必须分开：英文态保留中文会话名，但占位名与时间是英文。 */
  @Test
  fun sessionDataIsNotRewrittenByLocalization() {
    val now = 1_700_000_000_000L
    val zhNamed = PickerSession("s", "修好了三处回执", false, now - 30_000L)
    val en = pickerSessionLabelText(zhNamed, english = true, now = now)
    assertTrue("中文会话名是数据，英文态必须原样保留", en.contains("修好了三处回执"))
    assertFalse("但界面文案部分不得含中文（实际：" + en + "）", hasCjk(en.substringAfter(" · ")))
  }
}
