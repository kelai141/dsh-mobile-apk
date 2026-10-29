package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.14.1 批 5「可发现性与热区」的行为回归（纯 JVM，无 Robolectric）。
 *
 * 覆盖 `docs/0.14.1-TODO-AND-RELEASE-GATE.md` §1.1 的 P5-1…P5-6，外加同域的两条 §3.2
 * （S2-15/S2-16 在客户端侧，见 client 仓的 phone-control.spec.tsx / dev-section.spec.tsx）。
 * 做法沿用本仓既有两条路子（同 OverlayPendingCardTest）：
 *  1. **纯函数判据**——语义直接可测，改坏即红（含**可比数字**：光环对比度是按 sRGB 亮度公式复算的，
 *     不是「看着差不多了」）；
 *  2. **源码级判据**——需要 View/Window 的形态（热区像素、窗口 flag、装配顺序）在 JVM 里跑不起来，
 *     就断言「修复形态在场 + 旧形态不在场」，撤掉修复即红。
 *
 * 设备层证据（截图 + uiautomator 量到的热区尺寸）另走三层验收的 B 轨，不在本文件里。
 */
class OverlayBatch5Test {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释里会复述旧实现作为背景，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  // ── 对比度复算（P5-3 的判据要落在一个数上，不是「看起来可见」）────────────────

  /** 页面底色参照：浅色页 = 白；深色页取壳侧深色主题的 panel 底色（OverlayTheme.unitBg 深色档）。 */
  private val whitePage = 0xFFFFFFFF.toInt()
  private val darkPage = 0xF21E1F24.toInt()

  private fun linear(v: Int): Double {
    val s = v / 255.0
    return if (s <= 0.04045) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
  }

  private fun relLum(argb: Int): Double =
    0.2126 * linear((argb ushr 16) and 0xFF) +
      0.7152 * linear((argb ushr 8) and 0xFF) +
      0.0722 * linear(argb and 0xFF)

  /** source-over 合成（把带 alpha 的前景色压到背景上），返回合成后的不透明色。 */
  private fun over(fg: Int, bg: Int): Int {
    val a = ((fg ushr 24) and 0xFF) / 255.0
    fun ch(shift: Int): Int =
      Math.round(a * ((fg ushr shift) and 0xFF) + (1 - a) * ((bg ushr shift) and 0xFF)).toInt()
    return (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
  }

  private fun contrast(fg: Int, bg: Int): Double {
    val l1 = relLum(over(fg, bg))
    val l2 = relLum(bg)
    return (maxOf(l1, l2) + 0.05) / (minOf(l1, l2) + 0.05)
  }

  // ── P5-3：空闲光环在浅色背景上必须可见，且深色侧零回归 ──────────────────────
  //
  // 两档空闲底色登记在 OverlayTheme 的色板里，本测试**从源码取字面量**再复算对比度——
  // 不在这里重抄颜色（重抄就成了重言式：改源码色值测试还绿），也顺带钉住「深色档 == Halo.IDLE」。

  /** 从 OverlayTheme.kt 源码取某一档色板的 haloIdle / haloIdleFade（hex 字面量 → Int）。 */
  private fun paletteIdle(dark: Boolean): Pair<Int, Int> {
    val src = codeOnly(source("OverlayTheme.kt"))
    val branch = if (dark) src.substringAfter("if (isDarkTheme()) {").substringBefore("} else {")
    else src.substringAfter("} else {")
    fun pick(name: String): Int {
      val m = Regex("""$name\s*=\s*0x([0-9A-Fa-f]{8})\.toInt\(\)""").find(branch)
        ?: throw AssertionError(
          "OverlayTheme 的" + (if (dark) "深色" else "浅色") + "档缺少 $name（改形/改名即判红）",
        )
      return m.groupValues[1].toLong(16).toInt()
    }
    return pick("haloIdle") to pick("haloIdleFade")
  }

  @Test
  fun `深色主题的空闲光环必须与改动前逐字节相同`() {
    val (color, fade) = paletteIdle(dark = true)
    assertEquals("深色空闲底色不得改动（改动前实测 3.48:1，改了就回归）", Halo.IDLE.color, color)
    assertEquals(Halo.IDLE.fade, fade)
    assertEquals("解析结果必须等于深色档", color to fade, haloColorsFor(Halo.IDLE, color, fade))
    assertTrue(
      "深色页对比度实测 " + contrast(color, darkPage) + "，不得低于 3.0:1",
      contrast(color, darkPage) >= 3.0,
    )
  }

  @Test
  fun `浅色主题的空闲光环必须在白底可见`() {
    val (color, fade) = paletteIdle(dark = false)
    assertNotEquals(
      "不得仍取半透明白：白底上与背景同色（1.00:1），观感是「空闲时没有光环」",
      Halo.IDLE.color,
      color,
    )
    val c = contrast(color, whitePage)
    assertTrue("白底对比度实测 " + c + "，必须 ≥ 2.5:1（低于此值肉眼几乎看不出环）", c >= 2.5)
    // 中性灰：r=g=b，不与三态色相抢语义（三态由 channelOrderMatchesTheIntendedHues 钉住色相方向）。
    val r = (color ushr 16) and 0xFF
    val g = (color ushr 8) and 0xFF
    val b = color and 0xFF
    assertEquals("浅色空闲色必须是中性灰（r=g）", r, g)
    assertEquals("浅色空闲色必须是中性灰（g=b）", g, b)
    assertTrue("次强档必须比主档更弱（否则可见环反而更宽更亮，与三态口径不一致）", ((fade ushr 24) and 0xFF) < ((color ushr 24) and 0xFF))
    assertTrue("次强档 alpha 必须非零（否则该层不可见）", ((fade ushr 24) and 0xFF) > 0)
    assertEquals("解析结果必须等于浅色档", color to fade, haloColorsFor(Halo.IDLE, color, fade))
  }

  @Test
  fun `另外三态不随主题变化`() {
    val light = paletteIdle(dark = false)
    val dark = paletteIdle(dark = true)
    for (h in listOf(Halo.WORKING, Halo.PENDING, Halo.ERROR)) {
      assertEquals(h.name + "：浅色主题下必须原样透传", h.color to h.fade, haloColorsFor(h, light.first, light.second))
      assertEquals(h.name + "：深色主题下必须原样透传", h.color to h.fade, haloColorsFor(h, dark.first, dark.second))
    }
  }

  @Test
  fun `换肤时必须重刷光环`() {
    val halo = codeOnly(source("OverlayHalo.kt"))
    assertTrue(
      "haloView 的 drawable 是手工构造的，不随 uiMode 更新——必须提供 refreshTheme 且只走 setHalo 这一条改色入口",
      halo.contains("fun refreshTheme() = setHalo(lastHalo)"),
    )
    val svc = codeOnly(source("OverlayService.kt"))
    assertTrue("onConfigurationChanged 必须调用 halo.refreshTheme()", svc.contains("halo.refreshTheme()"))
  }

  // ── P5-2：热区不得小于 44dp，且四处可点元素取同一常量 ───────────────────────

  @Test
  fun `最小热区常量不得低于 44dp`() {
    assertTrue("MIN_TOUCH_TARGET_DP 实测 " + MIN_TOUCH_TARGET_DP + "，不得小于 44", MIN_TOUCH_TARGET_DP >= 44)
  }

  @Test
  fun `手柄行内边距必须凑够最小热区`() {
    for (d in listOf(1f, 1.5f, 2f, 2.75f, 3f, 4f)) {
      val pillPx = (4 * d).toInt()
      val pad = handleRowPaddingPx(MIN_TOUCH_TARGET_DP, 4, d)
      val targetPx = (MIN_TOUCH_TARGET_DP * d).toInt()
      assertTrue(
        "density=$d：药丸 $pillPx + 上下内边距 " + (2 * pad) + " 必须 ≥ 热区下限 $targetPx",
        pillPx + 2 * pad >= targetPx,
      )
      assertTrue("density=$d：内边距不得为负", pad >= 0)
    }
    assertEquals("药丸比热区还高时退化为 0（不得出现负内边距）", 0, handleRowPaddingPx(10, 20, 2f))
  }

  @Test
  fun `回报栏与面板的可点元素都取同一热区常量`() {
    val report = codeOnly(source("OverlayReport.kt"))
    assertTrue("回报栏关闭键宽度", report.contains("minWidth = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertTrue("回报栏关闭键高度", report.contains("minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertTrue("回报栏手柄行内边距", report.contains("handleRowPaddingPx(MIN_TOUCH_TARGET_DP, 4, dp)"))
    assertFalse("不得再出现写死的 28dp 触摸目标（旧注释自称 28dp、实测 18dp）", report.contains("28dp"))

    val panel = codeOnly(source("OverlayPanel.kt"))
    val picker = panel.substringAfter("val pickerRowText").substringBefore("sessionPicker = pickerRowText")
    val status = panel.substringAfter("val status =").substringBefore("statusText = status")
    val reportEntry = panel.substringAfter("val reportEntry =").substringBefore("reportEntryView = reportEntry")
    val hideEntry = panel.substringAfter("val hideEntry = TextView(svc)").substringBefore("hideEntryView = hideEntry")
    assertTrue("会话选择器必须保留 44dp 触控高度", picker.contains("minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertFalse("字号放大时会话选择行不得固定为 26dp", panel.contains("LayoutParams(0, (26 * dp).toInt(), 1f)"))
    assertTrue("状态文字手势热区必须保留", status.contains("minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertTrue("汇报入口宽度必须保留", reportEntry.contains("minWidth = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertTrue("汇报入口高度必须保留", reportEntry.contains("minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    // 块J（0.14.9-preview）：隐藏入口必须与既有入口同口径（不新造尺寸常量），✕ 命中区不得被挤掉。
    // 按 main 的**逐项断言**口径写，不再用「出现次数」计数：并入 #411 后同一文件里该常量的出现次数
    // 已随会话选择行热区变成 14 处，写死次数会在别的合法改动上假红。
    assertTrue("隐藏入口宽度必须取热区常量", hideEntry.contains("minWidth = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertTrue("隐藏入口高度必须取热区常量", hideEntry.contains("minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()"))
    assertTrue("面板关闭键命中区必须保留", panel.contains("addView(close, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt())"))
    assertTrue("发送按钮命中区必须保留", panel.contains("addView(send, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt())"))
    assertTrue("停止按钮命中区必须保留", panel.contains("addView(stop, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt())"))
  }

  @Test
  fun `两枚圆钮必须补 contentDescription 且视觉尺寸不变`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("发送必须有无障碍名", panel.contains("roundButton(\"overlay-send\", R.drawable.dsh_ic_send, 16, 0xFF4176E6.toInt(), t(\"发送\", \"Send\"))"))
    assertTrue("停止必须有无障碍名", panel.contains("roundButton(\"overlay-stop\", R.drawable.dsh_ic_stop, 12, 0xFFE04848.toInt(), t(\"停止当前任务\", \"Stop current task\"))"))
    assertTrue("外层命中区撑到热区下限、内层保持 36dp 观感", panel.contains("FrameLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt(), Gravity.CENTER)"))
    val report = codeOnly(source("OverlayReport.kt"))
    assertTrue("回报栏关闭键必须有无障碍名", report.contains("contentDescription = \"关闭工作汇报\""))
    assertTrue("手柄行必须有无障碍名", report.contains("contentDescription = \"上下拖动调整汇报栏高度\""))
  }

  // ── P5-1：状态行必须有可见入口，长按仍可用 ─────────────────────────────────

  @Test
  fun `状态行必须有可见的汇报入口`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("入口文案必须在场", panel.contains("\"查看汇报\""))
    assertTrue("入口必须真的开报告栏", panel.contains("setOnClickListener { svc.toggleReportBar() }"))
    assertTrue("入口必须挂在状态行（row1）里", panel.contains("addView(reportEntry"))
    assertTrue("入口必须有无障碍名", panel.contains("t(\"查看工作汇报\", \"View work report\")"))
    assertTrue("换肤时必须同步入口配色", panel.contains("reportEntryView?.setTextColor(c.chevron)"))
  }

  @Test
  fun `完成态提示语指向可见入口而不是长按`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("默认完成模板必须改成指向可见入口", panel.contains("getString(\"template_completion\", \"已完成，可查看汇报\")"))
    assertTrue("兜底提示语必须同口径", panel.contains("ifBlank { \"可查看汇报\" }"))
    assertFalse(
      "不得再只教长按：可见入口已存在，文案指向用户看不见的手势等于没入口",
      panel.contains("长按查看汇报"),
    )
    assertTrue("长按手势本身不得删除（不改手势语义）", panel.contains("svc.toggleReportBar()"))
  }

  // ── P5-4 / S2-4：回报条正文顺序 ───────────────────────────────────────────

  @Test
  fun `元信息三行必须排在正文全文之前`() {
    val report = codeOnly(source("OverlayReport.kt"))
    val metaLoop = report.indexOf("for ((i, line) in lines.withIndex())")
    val bodyBlock = report.indexOf("if (!reportBodyRedundant(entry, full))")
    assertTrue("元信息循环必须在场", metaLoop > 0)
    assertTrue("正文块必须在场", bodyBlock > 0)
    assertTrue(
      "正文全文必须排在元信息之后：旧顺序把「用时 · 工具数 · 产出」顶到 8 KiB 正文之下，首屏看不到",
      bodyBlock > metaLoop,
    )
    assertFalse("不得再回到「插在首行之后」的旧形态", report.contains("if (i == 0 && full.isNotEmpty())"))
  }

  // ── S2-6：正文与摘要重复渲染 ─────────────────────────────────────────────

  @Test
  fun `正文与摘要同句时不得渲染两遍`() {
    val base = NotifyEntry(kind = "report", outcome = "completed", outcomeLabel = "已完成", summary = "修好了三处回执")
    assertTrue(
      "旧条目没有 body 时 reportBodyText 回落 summary，而 summary 已在首行 → 正文块必须判为多余",
      reportBodyRedundant(base, reportBodyText(base)),
    )
    val withBody = base.copy(body = "正文第一行\n正文第二行")
    assertFalse("有真正文时必须渲染", reportBodyRedundant(withBody, reportBodyText(withBody)))
    assertTrue("空正文一律判多余（没有块可渲染）", reportBodyRedundant(base, ""))
    assertTrue("条目为 null 且无正文", reportBodyRedundant(null, ""))
    assertFalse("条目为 null 但有正文时不得吞掉正文", reportBodyRedundant(null, "只有正文"))
    val noSummary = NotifyEntry(kind = "report", outcome = "completed", outcomeLabel = "")
    assertFalse("摘要为空时正文是唯一内容来源，不得判多余", reportBodyRedundant(noSummary, "只有正文"))
    // 近似相似**不**算多余：宁可重复显示，也不能因为「长得像」把内容丢掉。
    assertFalse("正文比摘要长时不算多余", reportBodyRedundant(base, "修好了三处回执，并且补了测试"))
  }

  // ── S2-2：三击窗口 ───────────────────────────────────────────────────────

  @Test
  fun `三击窗口必须宽于双击超时`() {
    assertEquals("按双击超时的两倍推导（运行时读系统值，不编造数字）", 600L, tripleTapWindowMs(300L))
    assertTrue("必须严格宽于双击超时：旧实现直接拿 300ms 当三击窗口，人手按不出", tripleTapWindowMs(300L) > 300L)
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("手势必须真的用上该窗口", panel.contains("tripleTapWindowMs(android.view.ViewConfiguration.getDoubleTapTimeout().toLong())"))
    val svc = codeOnly(source("OverlayService.kt"))
    assertTrue("跳转失败必须有可见回执（旧实现只写日志）", svc.contains("t(\"跳转失败，请手动切到 DSH\", \"Could not switch; open DSH manually\")"))
  }

  // ── S2-11 / S2-7：提示语与机器码 ─────────────────────────────────────────

  @Test
  fun `空闲发送的提示语不得说插话`() {
    assertEquals("忙碌时才是插话", "发消息可插话…", inputHintFor(busy = true, hasSession = true))
    assertEquals("空闲且有目标会话 = 开新一轮", "发消息开新一轮…", inputHintFor(busy = false, hasSession = true))
    assertEquals("空闲且无目标会话 = 新建会话", "发消息新建会话…", inputHintFor(busy = false, hasSession = false))
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("提示语必须随忙态/目标会话刷新", panel.contains("refreshInputHint()"))
    assertFalse("不得再有写死的「发消息可插话…」初值", panel.contains("hint = \"发消息可插话…\""))
  }

  @Test
  fun `目标会话行不得把内部 sessionId 截断上屏`() {
    assertEquals("修好了三处回执（当前）", sessionRowText("修好了三处回执"))
    assertEquals("未命名会话（当前）", sessionRowText(null))
    assertEquals("未命名会话（当前）", sessionRowText("   "))
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertFalse("不得再把内部 sessionId 截断上屏", panel.contains("activeSessionId.take(16)"))
  }

  // ── S2-5 / S2-8 / S2-9 / S2-10 / S2-12 / S2-14：同域的低风险项 ────────────

  @Test
  fun `回报条不得抢输入焦点`() {
    val report = codeOnly(source("OverlayReport.kt"))
    assertTrue("回报条内没有任何文本输入，窗口必须 NOT_FOCUSABLE（否则一打开就把键盘弹掉）", report.contains("FLAG_NOT_FOCUSABLE"))
    assertTrue("点栏外即关的语义必须保留", report.contains("FLAG_WATCH_OUTSIDE_TOUCH"))
  }

  @Test
  fun `会话选择器必须钳制在屏内并可重试`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("y 必须钳制（旧实现直写触发行 y：行在下半屏时列表尾部落屏外且不可达）", panel.contains(".coerceIn(0, (screenH - lp.height - gap).coerceAtLeast(0))"))
    assertTrue("x 同样钳制（触发行靠右时右边界出屏）", panel.contains(".coerceIn(0, (screenW - lp.width - gap).coerceAtLeast(0))"))
    assertTrue("读失败必须如实报错", panel.contains("会话列表读取失败（HTTP \$code）"))
    assertTrue("读失败必须给重试入口", panel.contains("（点此重试）"))
  }

  @Test
  fun `手选目标会话必须走同一条切换通知`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue(
      "选择器点选后必须调 onTargetSessionChanged（否则完成位归属旧会话不被清除，显示与事实脱节）",
      panel.contains("svc.onTargetSessionChanged(id)"),
    )
  }

  @Test
  fun `状态行主文案不得再用英文模板`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("思考态默认文案必须是中文", panel.contains("getString(\"template_thinking\", \"正在思考…\")"))
    assertFalse("不得再出现英文扫光文案", panel.contains("Deep diving..."))
    assertTrue("工具轮默认文案同样给中文外壳", panel.contains("getString(\"template_tool\", \"正在使用 {tool} · {summary}\")"))
  }

  @Test
  fun `探活 tick 不得覆写待答文案`() {
    val svc = codeOnly(source("OverlayService.kt"))
    assertTrue(
      "探活直写「引擎离线」前必须同时排除完成态与待答态（旧判据只看完成文案，会把「等待你的回答…」抹掉）",
      svc.contains("completionLabel().isEmpty() && pendingKind.isEmpty()"),
    )
  }
}
