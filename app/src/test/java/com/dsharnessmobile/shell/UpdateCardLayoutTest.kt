package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 更新卡「克制化」改版的**版面契约**（纯 JVM）。
 *
 * 用户看图后的反馈（2026-10-29）：两枚等宽按钮并列偏重，要主按钮只有一个，另一个降为
 * 卡内右侧的轻量文字链接；状态行 `新版本 v0.14.10（当前 v0.14.9-DEV-FAST，152.0 MB）`
 * 偏长，缩成 `v0.14.10 可用 · 152 MB`。
 *
 * 这里钉的是 [UpdateCardLayout] 那张表（谁是主、次入口要不要出现）与渲染层的**接线事实**。
 * 位图层面的「看起来克制」只能靠截图证——两层各管一半。
 */
class UpdateCardLayoutTest {

  private val newline: String = 10.toChar().toString()

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name)
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString(newline)

  private fun res(name: String): String {
    val f = File("src/main/res", name).takeIf { it.isFile } ?: File("app/src/main/res", name)
    return f.readText()
  }

  // ── 1. 主/次：有新版时主按钮是下载，检查降为文字链接 ─────────────────────

  @Test
  fun `有新版时主按钮是下载检查降为文字链接`() {
    // 用户口径：主按钮只有一个（有新版时是「下载」），另一个降为轻量文字链接。
    val layout = UpdateCardLayout.layoutFor(ApkUpdateState.STATE_AVAILABLE, canDownload = true)
    assertEquals("有新版时主按钮必须是下载",
      UpdateCardLayout.PRIMARY_DOWNLOAD, layout.primary)
    assertTrue("此时次入口必须出现", layout.secondaryVisible)
    assertEquals("次入口文案键必须是「检查」",
      UpdateCardLayout.SECONDARY_CHECK, layout.secondaryLabel)
  }

  @Test
  fun `已是最新与尚未检查时主按钮是检查且没有次入口`() {
    // 这两态没有可下的目标：次入口若是「下载」会是一枚点了没反应的链接。
    for (state in listOf(
      ApkUpdateState.STATE_IDLE,
      ApkUpdateState.STATE_UP_TO_DATE,
      ApkUpdateState.STATE_CHECKING,
      ApkUpdateState.STATE_FAILED,
    )) {
      val layout = UpdateCardLayout.layoutFor(state, canDownload = false)
      assertEquals("状态 " + state + " 的主按钮必须是检查",
        UpdateCardLayout.PRIMARY_CHECK, layout.primary)
      assertFalse("状态 " + state + " 不该有次入口", layout.secondaryVisible)
    }
  }

  @Test
  fun `下载进行中只留主按钮不给次入口`() {
    // 载荷正在用：此刻「检查」没有意义，给了只会误导用户点它。
    val layout = UpdateCardLayout.layoutFor(ApkUpdateState.STATE_DOWNLOADING, canDownload = true)
    assertEquals("下载中主按钮仍是下载那枚（承载进度）",
      UpdateCardLayout.PRIMARY_DOWNLOAD, layout.primary)
    assertFalse("下载中不得给次入口", layout.secondaryVisible)
  }

  @Test
  fun `需要授权时主按钮是下载那枚而不是检查`() {
    // 「去授权」是这时的唯一前进动作，把「检查」摆成主按钮等于让用户原地打转。
    val layout = UpdateCardLayout.layoutFor(ApkUpdateState.STATE_NEED_PERMISSION, canDownload = true)
    assertEquals(UpdateCardLayout.PRIMARY_DOWNLOAD, layout.primary)
  }

  @Test
  fun `每个状态都只给一个主按钮`() {
    // 这张表是「克制」的唯一保证：任何状态都不许出现两枚并列主按钮。
    val states = listOf(
      ApkUpdateState.STATE_IDLE, ApkUpdateState.STATE_CHECKING,
      ApkUpdateState.STATE_UP_TO_DATE, ApkUpdateState.STATE_AVAILABLE,
      ApkUpdateState.STATE_DOWNLOADING, ApkUpdateState.STATE_INSTALLING,
      ApkUpdateState.STATE_NEED_PERMISSION, ApkUpdateState.STATE_FAILED,
    )
    for (state in states) {
      for (can in listOf(true, false)) {
        val layout = UpdateCardLayout.layoutFor(state, can)
        assertTrue(
          "主按钮必须是已知的两选一（state=" + state + " can=" + can + "）",
          layout.primary == UpdateCardLayout.PRIMARY_CHECK ||
            layout.primary == UpdateCardLayout.PRIMARY_DOWNLOAD,
        )
        // 次入口与主按钮不得是同一件事（否则同一动作出现两次）。
        if (layout.secondaryVisible) {
          assertEquals("次入口只能承担与主按钮不同的动作",
            UpdateCardLayout.SECONDARY_CHECK, layout.secondaryLabel)
          assertEquals("次入口只在下载当主时出现",
            UpdateCardLayout.PRIMARY_DOWNLOAD, layout.primary)
        }
      }
    }
  }

  // ── 2. 状态行文案 ────────────────────────────────────────────────────────

  @Test
  fun `状态行是版本号加可用加体积而不是长句`() {
    // 用户口径 `v0.14.10 可用 · 152 MB`。
    val line = UpdateCardLayout.availableLine("v0.14.10", "152 MB")
    assertEquals("状态行必须是「版本 可用 · 体积」", "v0.14.10 可用 · 152 MB", line)
    assertFalse("状态行不得再出现「新版本（当前 …）」那种长句", line.contains("当前"))
    assertFalse("状态行不得带括号", line.contains("（"))
  }

  @Test
  fun `缺字段时不拼出残句`() {
    assertEquals("没有体积就不带那个分隔点", "v0.14.10 可用",
      UpdateCardLayout.availableLine("v0.14.10", ""))
    assertEquals("没有版本号时给一句完整话", "有新版可用 · 152 MB",
      UpdateCardLayout.availableLine("", "152 MB"))
    assertEquals("两者都没有也要成句", "有新版可用",
      UpdateCardLayout.availableLine("", ""))
  }

  @Test
  fun `资源串仍是中英成对的唯一真源`() {
    // 文案走 R.string 而不是在 Kotlin 里硬拼中文：否则切英文时这一行会掉回中文。
    for (file in listOf("values/strings.xml", "values-en/strings.xml")) {
      val text = res(file)
      assertTrue(file + " 必须有 ds_apk_version_available",
        text.contains("<string name=\"ds_apk_version_available\">"))
    }
    val zh = res("values/strings.xml")
    val line = zh.lines().first { it.contains("<string name=\"ds_apk_version_available\">") }
    assertTrue("中文资源不该再含「当前」", !line.contains("当前"))
    assertTrue("中文资源应是「可用 · 体积」形态", line.contains("可用") && line.contains("·"))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("渲染层必须真的用到这枚资源",
      renderer.contains("R.string.ds_apk_version_available"))
  }

  // ── 3. 接线事实：次入口存在且与主按钮互斥 ───────────────────────────────

  @Test
  fun `次入口是一枚文字链接而不是第二枚等宽按钮`() {
    // 用户口径「降为卡内右侧的轻量文字链接」。若它仍是 makeSecondary，就是换了个名字的按钮。
    val chrome = codeOnly(source("GuideChrome.kt"))
    // 取整段声明（含末尾的 apply {} 块）：用属性名到下一个同级 val 之间做切片，
    // 而不是按 "\n  }" 截——那样会漏掉 apply 块后半段（次要色就在那段里）。
    // 切片用**声明行 + apply 块的收尾**做边界：从 "val apkSecondaryLink = TextView" 起，
    // 到该 apply 块结束的 "  }" 行止。前一枚按钮（apkDownload）的 makeSecondary 在切片之前，
    // 后续构造入参在切片之后——两头都不会被误纳入。
    val lines = chrome.lines()
    val start = lines.indexOfFirst { it.contains("val apkSecondaryLink = TextView") }
    assertTrue("必须能定位次入口的声明行", start >= 0)
    var end = start
    while (end < lines.size - 1 && !(end > start && lines[end].trim() == "}")) end++
    val body = lines.subList(start, end + 1).joinToString(newline)
    assertTrue("切片必须真的取到声明体", body.contains("TextView(activity)"))
    assertTrue("切片必须含次要色（否则断言在空集上假绿）",
      body.contains("R.color.ds_text_secondary"))
    assertFalse("次入口不得用 makeSecondary（那就是第二枚按钮）",
      body.contains("makeSecondary"))
    assertTrue("次入口必须是 TextView", body.contains("TextView(activity)"))
    assertTrue("次入口用次要色（不是主色，否则与主按钮抢视线）",
      body.contains("R.color.ds_text_secondary"))
    assertTrue("次入口仍要有足量触控高度",
      body.contains("ds_btn_secondary_height"))
  }

  @Test
  fun `主按钮与文字链接同一行且互斥`() {
    // 同一行保证状态切换时行高不跳；互斥保证不会两枚同时出现。
    val controller = codeOnly(source("GuideManagementController.kt"))
    val actions = controller.substringAfter("val actions = LinearLayout")
      .substringBefore("block.addView(actions)")
    assertTrue("检查那枚在主按钮位", actions.contains("chrome.updateButton"))
    assertTrue("下载那枚也在同一行（权重 1，与检查互斥）",
      actions.contains("chrome.apkDownload"))
    assertTrue("次入口贴在同一行右侧", actions.contains("chrome.apkSecondaryLink"))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    val apply = renderer.substringAfter("private fun applyActionLayout(")
    assertTrue("下载当主时检查必须被隐藏",
      apply.contains("chrome.updateButton.visibility = View.GONE"))
    assertTrue("检查当主时下载必须被隐藏",
      apply.contains("chrome.apkDownload.visibility = View.GONE"))
  }

  @Test
  fun `无障碍：主按钮的读屏描述仍带当前版本`() {
    // 当前版本从状态行拿掉了，但不能从读屏侧消失——否则用户不知道点下去会装哪一版。
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    val available = renderer.substringAfter("ApkUpdateState.STATE_AVAILABLE ->")
      .substringBefore("ApkUpdateState.STATE_DOWNLOADING ->")
    assertTrue("下载按钮的 contentDescription 必须仍含当前版本",
      available.contains("R.string.ds_apk_available") &&
        available.contains("UpdateChecker.currentVersion()"))
  }
}