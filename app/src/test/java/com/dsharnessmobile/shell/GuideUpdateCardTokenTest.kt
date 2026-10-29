package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 更新卡（管理中心里那张「标题 + 状态行 + 检查 / 下载」的卡片）的**结构与 token 契约**（纯 JVM，无 Robolectric）。
 *
 * 用户口径：「检查更新那两枚按钮包成一张卡片，尺寸与页面其它卡片对齐」＋「不要合并成一枚按钮去猜
 * 这次点击是检查还是下载」。对齐基准由协作者补充确定：**WebView 设置页那张卡片**
 * （`dsh-client-ui-responsive/src/client/dev-section/dev-section.css.ts` 的 `.dsh-screen-control-card`，
 * #860 之后「应用更新」分区就用它）。本文件把下列六条钉成断言，撤掉修复即红：
 *  1. 卡片外壳取自 `DsUi.settingsCardBackground` / `DsUi.settingsCardPaddingPx` 这一对函数，
 *     更新卡自己不再写一份 token 组合；
 *  2. 外壳五项取值与本仓 dimens 的对应档一致（12dp 圆角 / 12dp 内边距 / 卡片面 / hairline 描边）；
 *  3. 两枚按钮仍是两个独立控件、各自硬绑一个回调，卡片本身**不承担点击**；
 *  4. 按钮填充色不得与卡片底色同 token（否则住进卡片后按钮与卡片融成一片）；
 *  5. 文字层级按 WebView 那套（标题 14 / 说明 12 与 18 行高）；
 *  6. 卡片不叠加额外左右外边距，宽度与相邻 row 同一水平边距。
 *
 * 为什么这些是**源码断言**而不是渲染断言：JVM 单测里没有 View 树，setPadding/background 的效果
 * 只能靠设备截图证；能在这里守的是「谁在读哪个 token」这类结构关系——它恰好是最容易悄悄漂移的
 * 一层（两处各抄一份，单看任一文件都看不出来）。
 */
class GuideUpdateCardTokenTest {

  private val newline: String = 10.toChar().toString()

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun resXml(relative: String): String {
    val candidates = listOf(File("src/main/res/" + relative), File("app/src/main/res/" + relative))
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到资源 " + relative)
    return f.readText()
  }

  /** 只留代码行（注释里会复述旧实现与对照表，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString(newline)

  /** 取某个函数体（从签名行到它自己那个收尾大括号行），用于「断言只落在这段里」。 */
  private fun bodyAfter(src: String, signature: String): String {
    val start = src.indexOf(signature)
    assertTrue("源码里找不到 " + signature, start >= 0)
    val rest = src.substring(start + signature.length)
    val end = rest.indexOf(newline + "  }")
    return if (end >= 0) rest.substring(0, end) else rest
  }

  /** 取 dimens.xml 里某个 dp 值的字面量（判「这一档到底是多少 dp」）。 */
  private fun dimenValue(relative: String, name: String): String {
    val xml = resXml(relative)
    val open = "<dimen name=" + QUOTE + name + QUOTE + ">"
    val start = xml.indexOf(open)
    assertTrue(relative + " 必须定义 " + name, start >= 0)
    return xml.substring(start + open.length).substringBefore("<")
  }

  // ── 1. 卡片外壳 token 同源 ───────────────────────────────────────────────

  @Test
  fun `卡片外壳规格取自 DsUi 的设置卡这对函数`() {
    // 「对齐」不能靠两处各写一遍恰好一样——那是漂移的温床。更新卡的外壳必须走 DsUi 那一对函数，
    // 规格值本身也只写在 DsUi 里（调用方只读函数、不读 token），改一处两边一起变。
    val dsui = codeOnly(source("DsUi.kt"))
    assertTrue(
      "DsUi 必须提供设置卡背景规格",
      dsui.contains("fun settingsCardBackground(context: android.content.Context): GradientDrawable"),
    )
    assertTrue(
      "DsUi 必须提供设置卡内边距",
      dsui.contains("fun settingsCardPaddingPx(context: android.content.Context): IntArray"),
    )
    val bg = bodyAfter(dsui, "fun settingsCardBackground(context: android.content.Context): GradientDrawable {")
    assertTrue("背景必须用卡片面 ds_surface", bg.contains("R.color.ds_surface"))
    assertTrue("圆角必须用 ds_radius_settings_card", bg.contains("R.dimen.ds_radius_settings_card"))
    assertTrue("描边必须用 ds_hairline", bg.contains("R.color.ds_hairline"))
    assertTrue("描边宽必须是 1 物理像素的 hairline", bg.contains("coerceAtLeast(1)"))
    val pad = bodyAfter(dsui, "fun settingsCardPaddingPx(context: android.content.Context): IntArray {")
    assertTrue("内边距必须用 ds_space_12", pad.contains("R.dimen.ds_space_12"))

    val management = codeOnly(source("GuideManagementController.kt"))
    val card = bodyAfter(management, "private fun updateCard() = LinearLayout(activity).apply {")
    assertTrue("卡片背景必须走这对函数", card.contains("background = DsUi.settingsCardBackground(activity)"))
    assertTrue("卡片内边距必须走这对函数", card.contains("DsUi.settingsCardPaddingPx(activity).let"))
    // 反证：调用方不得自己再写一份 token 组合——那就回到了「两处各写一遍」。
    assertFalse("卡片不得自己写圆角", card.contains("ds_radius_settings_card"))
    assertFalse("卡片不得自己写描边色", card.contains("R.color.ds_hairline"))
    assertFalse("卡片不得自己写内边距档位", card.contains("R.dimen.ds_space_12"))
  }

  // ── 2. 外壳五项取值与 WebView 卡片逐项同档 ────────────────────────────────

  @Test
  fun `卡片圆角与内边距取 12 这一档而不是近似取整`() {
    // 基准（#860 的 WebView 卡片 .dsh-screen-control-card）：
    //   border-radius: 12px  -> 上游 --dsw-radius-md = 12px
    //   padding: 12px        -> 上游间距档 12
    // 原生侧 8dp/16dp 两档分别对应上游 --dsw-radius-sm 与 --dsw-radius-lg，都不是 12；
    // 取任一近似都会让两侧卡片差 4dp，而这俩入口在同一台设备上肉眼可比。
    assertTrue(
      "卡片圆角必须是 12dp 这一档（对应 --dsw-radius-md 12px）",
      dimenValue("values/dimens.xml", "ds_radius_settings_card") == "12dp",
    )
    assertTrue(
      "卡片内边距档必须是 12dp（对应 WebView 的 padding: 12px）",
      dimenValue("values/dimens.xml", "ds_space_12") == "12dp",
    )
    // 反证：不许复用已有的近似档（8dp / 16dp）——它们分别是另外两档圆角。
    val dsui = codeOnly(source("DsUi.kt"))
    val bg = bodyAfter(dsui, "fun settingsCardBackground(context: android.content.Context): GradientDrawable {")
    assertFalse("不得用 ds_radius_sm 近似", bg.contains("R.dimen.ds_radius_sm"))
    assertFalse("不得用 ds_radius_md 近似", bg.contains("R.dimen.ds_radius_md"))
    assertFalse("不得用引导页那张卡的圆角档近似", bg.contains("R.dimen.ds_radius_card"))
  }

  // ── 3. 两枚按钮仍各自独立，卡片不承担点击 ────────────────────────────────

  @Test
  fun `两枚按钮仍各自硬绑一个动作且卡片不抢点击域`() {
    val management = codeOnly(source("GuideManagementController.kt"))
    val body = bodyAfter(management, "private fun updateBlock(): View {")
    // 两枚控件都被摆进同一行，但仍是**两个** addView：合并成一枚就无从区分检查与下载。
    assertTrue("检查按钮必须仍独立摆入", body.contains("buttons.addView(chrome.updateButton"))
    assertTrue("下载按钮必须仍独立摆入", body.contains("buttons.addView(chrome.apkDownload"))
    // 卡片只是容器：不设点击、不设焦点，读屏不会被它合并或截断。
    val card = bodyAfter(management, "private fun updateCard() = LinearLayout(activity).apply {")
    assertTrue("卡片必须显式不可点击", card.contains("isClickable = false"))
    assertTrue("卡片必须显式不可聚焦", card.contains("isFocusable = false"))
    assertFalse("卡片不得安装点击监听", card.contains("setOnClickListener"))
    assertFalse("更新卡整体不得安装点击监听", body.contains("setOnClickListener"))
    // 回调仍在 GuideChrome，各自独立指向一个控制器入口（合并按钮必然要从这里删掉一个）。
    val chrome = codeOnly(source("GuideChrome.kt"))
    assertTrue(
      "检查按钮接 onCheckUpdate",
      chrome.contains("makeSecondary(activity.getString(R.string.ds_check_update), callbacks.onCheckUpdate)"),
    )
    assertTrue("下载按钮接 onDownloadUpdate", chrome.contains("callbacks.onDownloadUpdate()"))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("检查只发 check", renderer.contains("activity.apkUpdate.onCheckPressed()"))
    assertTrue("下载只发 download", renderer.contains("onDownloadUpdate = { activity.apkUpdate.onDownloadPressed() }"))
    assertFalse("不得再出现一枚按钮推断三步的旧入口", renderer.contains("onButtonPressed"))
  }

  @Test
  fun `按状态决定哪一枚可见可用的逻辑保持不变`() {
    // 卡片是纯视觉容器，本次改动**不新增**任何状态分支：可见性仍由渲染层按状态设。
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("下载按钮的显隐仍由 label 是否为空决定", renderer.contains("if (label == null)"))
    assertTrue("隐藏而非留一枚点了没反应的按钮", renderer.contains("button.visibility = View.GONE"))
    assertTrue("可用态检查按钮禁用（保护已确认载荷）", renderer.contains("setCheckButton(check, enabled = false)"))
    // 卡片本身没有任何随状态变化的形态——它不该出现在状态分支里。
    val management = codeOnly(source("GuideManagementController.kt"))
    val body = bodyAfter(management, "private fun updateBlock(): View {")
    assertFalse("卡片不得因状态切换可见性", body.contains("visibility ="))
  }

  // ── 4. 按钮填充色不得与卡片底色同 token ──────────────────────────────────

  @Test
  fun `按钮填充色不得与卡片底色同 token`() {
    // 旧形态下按钮直接坐在面板底色上，写 ds_surface 也有对比；住进卡片后卡片底色就是 ds_surface，
    // 再用它就与卡片融为一体、看不出按钮边界。ds_button_surface 是这套设计里专给按钮面的 token。
    val management = codeOnly(source("GuideManagementController.kt"))
    val body = bodyAfter(management, "private fun updateBlock(): View {")
    assertTrue("按钮填充必须用 ds_button_surface", body.contains("R.color.ds_button_surface"))
    assertFalse("按钮填充不得再用卡片底色 ds_surface", body.contains("R.color.ds_surface"))
    // 两套配色都必须定义该 token，否则某一模式下会回退到默认色。
    for (variant in listOf("values/colors.xml", "values-night/colors.xml")) {
      val xml = resXml(variant)
      val expected = "<color name=" + QUOTE + "ds_button_surface" + QUOTE + ">"
      assertTrue(variant + " 必须定义 ds_button_surface", xml.contains(expected))
    }
  }

  // ── 5. 文字层级与 WebView 卡片同档 ───────────────────────────────────────

  @Test
  fun `标题与状态行的字号行高对齐 WebView 卡片的标题与说明`() {
    // 基准（#860 的 dev-section.css.ts）：
    //   .dsh-gs-title { font-size: 14px; line-height: 20px }
    //   .dsh-gs-desc  { font-size: 12px; line-height: 18px }
    // 两侧并排时字号不一致，用户看到的就是「两个入口不是一套设计」。
    val management = codeOnly(source("GuideManagementController.kt"))
    val title = bodyAfter(management, "private fun cardTitle() = TextView(activity).apply {")
    assertTrue("卡片标题必须是 14sp（对应 .dsh-gs-title 的 14px）", title.contains("14f"))
    assertTrue("卡片标题必须是主色", title.contains("R.color.ds_text_primary"))

    val chrome = codeOnly(source("GuideChrome.kt"))
    val status = bodyAfter(chrome, "val apkStatus = TextView(activity).apply {")
    assertTrue("状态行必须是 12sp（对应 .dsh-gs-desc 的 12px）", status.contains("12f"))
    // 12sp * 1.5 = 18sp 行高，正是 .dsh-gs-desc 的 line-height: 18px。
    assertTrue("状态行行距必须是 1.5 倍（12*1.5 = 18，对应 line-height 18px）", status.contains("setLineSpacing(0f, 1.5f)"))
    assertTrue("状态行必须是次要色（对应 --dsw-alias-label-secondary）", status.contains("R.color.ds_text_secondary"))
  }

  // ── 6. 水平边距与相邻 row 一致 ───────────────────────────────────────────

  @Test
  fun `更新卡与相邻 row 同一水平边距`() {
    // 卡片左右对齐的依据是「两者都是 management 列的子项、列自带水平内边距」，
    // 而不是卡片自己再补一层左右外边距——补了就会比相邻行窄一截。
    val management = codeOnly(source("GuideManagementController.kt"))
    // 只取**卡片容器自己**那段：卡片内部的按钮行确实需要一个 8dp 的缝（两枚按钮之间），
    // 那不是卡片的外边距，整段扫会把它误判成「卡片补了外边距」。
    val card = bodyAfter(management, "private fun updateCard() = LinearLayout(activity).apply {")
    assertFalse("卡片不得再补左外边距", card.contains("marginStart"))
    assertFalse("卡片不得再补右外边距", card.contains("marginEnd"))
    assertTrue("卡片必须撑满列宽", card.contains("LinearLayout.LayoutParams(-1, -2)"))
    // 相邻 row 与更新卡同属一列：列出自身的内边距就是两者的公共水平边距。
    val column = bodyAfter(management, "private fun column() = LinearLayout(activity).apply {")
    assertTrue("列必须自带水平内边距（卡片与 row 的公共边距来源）", column.contains("setPadding(dp(4), dp(12), dp(4), dp(16))"))
  }

  private companion object {
    /** 双引号字符本身。写成字符码是为了让断言里的 XML 片段不依赖编辑器的转义风格。 */
    val QUOTE: String = 34.toChar().toString()
  }
}
