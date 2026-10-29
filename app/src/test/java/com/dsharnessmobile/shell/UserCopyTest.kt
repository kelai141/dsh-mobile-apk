package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 壳侧文案唯一真源（0.14.1 批 3 / P3-1…P3-4）的行为与反证用例。
 *
 * 这一组断言的目标不是「函数能跑」，而是把四条规则钉死——把任何一条改坏都会在这里判红：
 *  1. **码不上屏**：表内每个码、以及表外的未知码，正文都不得包含该码；
 *  2. **术语唯一**：`Face.label()` 与 `UserCopy.notifyCategory` 同源（同一个东西不许有两个名字）；
 *  3. **时长唯一**：只有一种「分秒」口径，未知给空串而不是 `-`；
 *  4. **截断自证**：超长文本必带省略号，用户不会把截断片段当成完整内容。
 */
class UserCopyTest {

  private fun source(relative: String): String {
    val candidates = listOf(File(relative), File("app/$relative"))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 $relative（工作目录 = " + File(".").absolutePath + "）")
    return file.readText()
  }

  /** 去掉注释行（形态名出现在注释里不算命中——与门禁「只看代码」的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  // ── P3-2：术语唯一 ─────────────────────────────────────────────────────

  @Test
  fun faceLabelsShareTheSingleTable() {
    // 反证：若 Face 再自带一份 label 字面量，两处必然漂移（本批收的就是这个形态）。
    for (face in NotifyCenter.Face.values()) {
      assertEquals(
        "Face(${face.category}) 的用词必须来自唯一真源",
        UserCopy.notifyCategory(face.category),
        face.label(),
      )
    }
    // 五个类别都不许退化成兜底名（退化了说明码写错）。
    assertEquals(
      "五类通知的用词都要在表里（未登记会退化成兜底名）",
      0,
      NotifyCenter.Face.values().count { it.label() == UserCopy.NOTIFY_CATEGORY_UNKNOWN },
    )
  }

  @Test
  fun notifyCategoryNeverEchoesTheCode() {
    for (face in NotifyCenter.Face.values()) {
      assertFalse("类别码不得上屏", face.label().contains(face.category))
    }
    assertEquals(UserCopy.NOTIFY_CATEGORY_UNKNOWN, UserCopy.notifyCategory("brand-new-category"))
  }

  @Test
  fun appNameIsTheLauncherName() {
    // strings.xml 的 app_name 是桌面图标上的名字，唯一真源必须与它一致。
    val strings = source("src/main/res/values/strings.xml")
    assertTrue(
      "app_name 必须存在（应用自称的唯一真源）",
      strings.contains("<string name=\"app_name\">" + UserCopy.APP_NAME + "</string>"),
    )
    // 无障碍服务名要带应用名——用户在系统设置里照着这个名字找。
    assertTrue("无障碍服务名必须含应用自称", UserCopy.A11Y_SERVICE_NAME.startsWith(UserCopy.APP_NAME))
    assertTrue(strings.contains("<string name=\"a11y_service_label\">" + UserCopy.A11Y_SERVICE_NAME + "</string>"))
  }

  @Test
  fun legacyBrandNamesAreGoneFromUserVisibleResources() {
    // 旧形态：同一个应用四个名字（DeepCode / DSH / dsh / DeepSeek Harness）。
    // 资源文件里的每个字符串都是用户可见的，一律不得再出现旧名。
    // 只看**值**：注释里出现旧名不算命中（渠道 ID 仍是 dsh，注释里点名它是对的——
    // 那是内部标识，不是用户可见文案）。这与门禁「只看代码不看注释」的口径一致。
    val strings = source("src/main/res/values/strings.xml").replace(Regex("""<!--[\s\S]*?-->"""), "")
    for (legacy in listOf("DSH", "dsh", "DeepSeek Harness")) {
      assertFalse("strings.xml 的字符串值里不得再出现旧自称：$legacy", strings.contains(legacy))
    }
  }

  @Test
  fun shellCopySitesUseTheSingleName() {
    // 逐一钉住「曾经出现旧名」的用户可见文案点（资源之外的地方）。
    val engineService = codeOnly(source("src/main/java/com/dsharnessmobile/shell/EngineService.kt"))
    assertTrue("引擎通知渠道名必须取唯一真源", engineService.contains("UserCopy.APP_NAME"))
    assertFalse(
      "引擎通知渠道名不得再写死旧名",
      engineService.contains("\"dsh 引擎\""),
    )
    val guide = codeOnly(source("src/main/java/com/dsharnessmobile/shell/GuidePageRenderer.kt"))
    assertTrue("引导页自称号必须取唯一真源", guide.contains("UserCopy.APP_NAME"))
    val deviceControl = codeOnly(source("src/main/java/com/dsharnessmobile/shell/DeviceControlService.kt"))
    assertTrue("无障碍状态里的服务名必须取唯一真源", deviceControl.contains("UserCopy.A11Y_SERVICE_NAME"))
    val console = source("src/main/assets/console.html")
    assertTrue("控制台标题必须用应用自称", console.contains("<title>" + UserCopy.APP_NAME))
  }

  // ── P3-3：时长唯一口径 ─────────────────────────────────────────────────

  @Test
  fun durationFollowsTheSingleChineseRule() {
    // 旧形态三套写法：8.4s / 1m24s / 2分05秒。
    assertEquals("8.4秒", UserCopy.durationText(8_400))
    assertEquals("8秒", UserCopy.durationText(8_000))
    assertEquals("45秒", UserCopy.durationText(45_000))
    assertEquals("1分00秒", UserCopy.durationText(60_000))
    assertEquals("1分24秒", UserCopy.durationText(84_000))
    assertEquals("59分59秒", UserCopy.durationText(3_599_000))
    assertEquals("1小时00分", UserCopy.durationText(3_600_000))
    assertEquals("2小时05分", UserCopy.durationText(7_500_000))
  }

  @Test
  fun unknownDurationIsEmptyNotADash() {
    // 旧实现回 "-"——用户分不清「未知」与「零」。空串让调用方整段省略。
    assertEquals("", UserCopy.durationText(0))
    assertEquals("", UserCopy.durationText(-1))
    assertEquals("", UserCopy.elapsedPhrase(0))
    assertEquals("用时 8秒", UserCopy.elapsedPhrase(8_000))
  }

  @Test
  fun durationHasNoEnglishUnits() {
    val text = UserCopy.durationText(84_000)
    assertFalse("时长里不得混英文单位", text.contains("s") || text.contains("m"))
    assertTrue(text.contains("分") && text.contains("秒"))
  }

  @Test
  fun reportMetaLineOmitsUnknownDurationAndUsesTimesSymbol() {
    // 旧文案「工具 3」会被读成「3 号工具」（审查档 §4.1）。
    assertEquals("用时 1分24秒 · 工具 ×3", UserCopy.reportMetaLine("1分24秒", 3))
    assertEquals("工具 ×0", UserCopy.reportMetaLine("", 0))
    assertFalse("不得再出现「工具 3」这种写法", UserCopy.reportMetaLine("", 3).contains("工具 3"))
  }

  // ── P3-4：截断自证 ─────────────────────────────────────────────────────

  @Test
  fun truncationAlwaysSaysItTruncated() {
    assertEquals("rm -rf /tmp", UserCopy.truncateWithEllipsis("rm -rf /tmp", 24))
    assertEquals("0123456789", UserCopy.truncateWithEllipsis("0123456789", 10))
    val cut = UserCopy.truncateWithEllipsis("rm -rf /data/local/tmp/very-long", 24)
    assertTrue("超长必须附省略号", cut.endsWith("…"))
    assertEquals("总长不得超过 max（含省略号）", 24, cut.length)
    assertEquals("", UserCopy.truncateWithEllipsis("abc", 0))
  }

  @Test
  fun toolSummaryOfTruncatesWithEllipsis() {
    // 反证：去掉省略号即判红——`rm -rf /data/loca` 看起来是一条完整命令。
    val summary = toolSummaryOf("""{"command":"rm -rf /data/local/tmp/build"}""")
    assertTrue("工具概览超长时必须带省略号，实际：$summary", summary.endsWith("…"))
    assertFalse("截断后不得与完整命令逐字相同", summary.contains("local/tmp/build"))
    assertEquals("", toolSummaryOf(""))
    assertEquals("hi", toolSummaryOf("""{"query":"hi"}"""))
  }

  @Test
  fun pickerFlashTruncationIsEllipsised() {
    // 会话名切换回执的截断点（旧实现 take(20) 硬截）。
    val panel = codeOnly(source("src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt"))
    assertTrue("会话名截断必须走唯一入口", panel.contains("UserCopy.truncateWithEllipsis(text, 20)"))
    assertFalse("不得再用裸 take(20) 截断上屏文案", panel.contains("+ text.take(20)"))
  }

  // ── P3-1：码不上屏 ─────────────────────────────────────────────────────

  @Test
  fun httpFailureNeverPrintsTheStatusCode() {
    for (status in listOf(400, 401, 403, 404, 405, 418, 500, 503)) {
      val text = UserCopy.httpFailure("检查更新", status)
      assertTrue("必须给人话（长度下限）：$status", text.length > 8)
      assertFalse("状态码不得上屏：$status", text.contains(status.toString()))
    }
    // 三类语义必须不同——用户下一步不同，就不能说同一句话。
    val unauthorized = UserCopy.httpFailure("检查更新", 403)
    val server = UserCopy.httpFailure("检查更新", 500)
    val missing = UserCopy.httpFailure("检查更新", 404)
    assertEquals(3, setOf(unauthorized, server, missing).size)
    assertTrue(unauthorized.contains("未获授权"))
  }

  @Test
  fun importanceNeverPrintsTheLevel() {
    for (level in 0..5) {
      val text = UserCopy.importance(level)
      assertTrue("档位必须给人话：$level", text.length > 2)
      assertFalse("不得是裸数字：$level", text == level.toString())
    }
    assertEquals("未知档位给空串（调用方整段省略，不打印 ?）", "", UserCopy.importance(-1))
    // 与通知自检面同源：selfCheck 的 importanceLabel 不再回 `HIGH(4)` 这种诊断口径。
    assertEquals(UserCopy.importance(4), NotifyCenter.importanceLabel(4))
    assertFalse(NotifyCenter.importanceLabel(4).contains("4"))
  }

  @Test
  fun categoryFlashUsesTheHumanNameNotTheCode() {
    val code = codeOnly(source("src/main/java/com/dsharnessmobile/shell/NotifyCenter.kt"))
    assertTrue("渠道降级提示必须经唯一真源翻译", code.contains("UserCopy.notifyCategory(category)"))
    assertFalse("类别码不得拼进提示", code.contains("\"通知渠道已降级为静默：\" + category"))
  }

  @Test
  fun sessionHashNoLongerReachesTheScreen() {
    val code = codeOnly(source("src/main/java/com/dsharnessmobile/shell/WatchdogV2.kt"))
    assertFalse(
      "标题回落不得再用会话短哈希上屏（审查档 §4.1）",
      code.contains("\"会话 \" + markerTag("),
    )
    assertTrue("哈希只允许进调试日志", code.contains("markerTag("))
  }

  // ── P3-2：渠道展示名的**迁移可达性** ───────────────────────────────────

  @Test
  fun channelRenameIsDetectedSoOldInstallsGetTheNewWord() {
    // 缺陷现场（设备实测 2026-09-23）：改代码里的 `Face.label()` 到不了老装机——既有渠道
    // （importance 已达标）不再走 createNotificationChannel 分支，系统设置里仍是旧词。
    // 判据：现状与期望不一致时必须判「需要校正」。
    assertTrue(
      "旧名（需要回答）必须判需要校正",
      channelRenameNeeded("需要回答", "引擎向你提问；可直接在通知栏回复", "提问", "引擎向你提问；可直接在通知栏回复"),
    )
    assertTrue(
      "说明变化同样需要校正",
      channelRenameNeeded("提问", "旧说明", "提问", "新说明"),
    )
    assertFalse(
      "已经一致时不得重建（避免无谓的渠道写操作）",
      channelRenameNeeded("提问", "引擎向你提问；可直接在通知栏回复", "提问", "引擎向你提问；可直接在通知栏回复"),
    )
    assertFalse("系统未给说明（null）而期望为空时也算一致", channelRenameNeeded("工作汇报", null, "工作汇报", ""))
    // 与唯一真源同源：五类的期望名就是 UserCopy 的用词。
    for (face in NotifyCenter.Face.values()) {
      assertFalse(
        "期望名必须取自唯一真源，否则这里会误判需要反复重建（${face.category}）",
        channelRenameNeeded(face.label(), face.description, UserCopy.notifyCategory(face.category), face.description),
      )
    }
  }

  @Test
  fun channelNameSyncIsWiredWhereOldInstallsWillRunIt() {
    // 反证（设备实测撞到的形态）：改名逻辑若只挂在渠道**创建**路径上，老装机永远不会执行它——
    // `channelFor` 在 channelsInitialized 之后只读 prefs 映射、不再走 resolveChannel。
    // 因此必须挂在一个每次启动都会跑到的地方。
    val center = codeOnly(source("src/main/java/com/dsharnessmobile/shell/NotifyCenter.kt"))
    assertTrue("必须有渠道展示名同步入口", center.contains("fun syncChannelNames("))
    assertTrue("同步必须挂在 ensureChannels 上", center.contains("syncChannelNames(context)"))
    assertTrue("自检面也要顺手同步", center.contains("syncChannelNames(app)"))
    val main = codeOnly(source("src/main/java/com/dsharnessmobile/shell/MainActivity.kt"))
    assertTrue("启动路径必须调用同步（否则老装机到不了这里）", main.contains("NotifyCenter.syncChannelNames(this)"))
  }

  @Test
  fun snapshotIdAndSnapshotPathsStayOutOfTheCopy() {
    val guide = codeOnly(source("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt"))
    assertFalse("快照 id 不得拼进引导页副文案", guide.contains("\"已恢复到快照 \" + (result.snapshotId"))
    val console = codeOnly(source("src/main/java/com/dsharnessmobile/shell/ConsoleSession.kt"))
    assertFalse("快照内相对路径不得拼进控制台状态", console.contains("usr/bin/bash 不存在"))
    assertTrue("路径应进日志", console.contains("Log.w(TAG, \"console unavailable: bash missing at \""))
  }
}
