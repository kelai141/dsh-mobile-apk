package com.dsharnessmobile.shell

import org.junit.Assert.*
import org.junit.Test

/** The production pure parser is exercised directly; this does not claim native pixel/device acceptance. */
class OverlayMarkdownTest {
  private fun styled(document: OverlayMarkdown.Document, style: OverlayMarkdown.Style) =
    document.spans.filter { it.style == style }.map { document.text.substring(it.start, it.end) }

  @Test fun headingsListsQuotesAndInlineTypographyKeepReadableMultilineText() {
    val document = OverlayMarkdown.parse("# Title\n\n- **bold** and *italic*\n2. \u0060literal_*\u0060\n> quoted ~~old~~")
    assertEquals("Title\n\n• bold and italic\n2. literal_*\nquoted old", document.text)
    assertEquals(listOf("Title"), styled(document, OverlayMarkdown.Style.HEADING))
    assertEquals(listOf("bold"), styled(document, OverlayMarkdown.Style.BOLD))
    assertEquals(listOf("italic"), styled(document, OverlayMarkdown.Style.ITALIC))
    assertEquals(listOf("literal_*"), styled(document, OverlayMarkdown.Style.CODE))
    assertEquals(listOf("quoted old"), styled(document, OverlayMarkdown.Style.QUOTE))
    assertEquals(listOf("old"), styled(document, OverlayMarkdown.Style.STRIKE))
  }

  @Test fun fencesPreserveCodeAndStreamingUnclosedFenceAsLiteralText() {
    val code = "  const x = \"<script>**literal**</script>\";\n    next()"
    for (tail in listOf("", "\n\u0060\u0060\u0060")) {
      val document = OverlayMarkdown.parse("\u0060\u0060\u0060js\n" + code + tail)
      assertEquals(code, document.text)
      assertEquals(listOf(code), styled(document, OverlayMarkdown.Style.CODE_BLOCK))
      assertTrue(styled(document, OverlayMarkdown.Style.BOLD).isEmpty())
    }
  }

  @Test fun untrustedHtmlImagesAndUnsafeUrisRemainInertLiteralData() {
    val html = "<script>alert(1)</script> <img src=x onerror=evil()>"
    assertEquals(html, OverlayMarkdown.parse(html).text)
    for (uri in listOf("javascript:evil", "intent://evil", "file:///private", "data:text/html,evil")) {
      val input = "[tap](" + uri + ")"
      val document = OverlayMarkdown.parse(input)
      assertEquals(input, document.text)
      assertTrue(styled(document, OverlayMarkdown.Style.LINK).isEmpty())
    }
    val image = "![not loaded](https://example.test/image.png)"
    assertEquals(image, OverlayMarkdown.parse(image).text)
  }

  @Test fun readableLinksRetainTheirDestinationWithoutExecutableSpanData() {
    val document = OverlayMarkdown.parse("[reference](https://example.test/path)")
    assertEquals("reference (https://example.test/path)", document.text)
    assertEquals(listOf(document.text), styled(document, OverlayMarkdown.Style.LINK))
    // Span carries style/range only, not a URL, callback, intent or platform object.
    assertEquals(setOf("start", "end", "style", "level"), OverlayMarkdown.Span::class.java.declaredFields.filterNot { it.isSynthetic }.map { it.name }.toSet())
  }

  @Test fun rawWhitespaceEscapesIdentifiersAndUnfinishedFormattingSurvive() {
    val input = "  first\r\n\tsecond\n\n\\*escaped\\* snake_case\n**unfinished"
    assertEquals("  first\n\tsecond\n\n*escaped* snake_case\n**unfinished", OverlayMarkdown.parse(input).text)
    assertEquals("x" + "\u0060".repeat(5000), OverlayMarkdown.parse("x" + "\u0060".repeat(5000)).text)
  }

  @Test fun sourceAndSpanBudgetsStayBoundedAndNeverCutASurrogatePair() {
    val document = OverlayMarkdown.parse("a".repeat(15999) + "😀" + "z")
    assertTrue(document.truncated)
    assertEquals(15999, document.text.length)
    assertFalse(document.text.last().isHighSurrogate())
    val many = OverlayMarkdown.parse("**x** ".repeat(3000))
    assertTrue(many.truncated)
    assertTrue(many.spans.size <= 512)
    assertTrue(many.spans.all { it.start >= 0 && it.end > it.start && it.end <= many.text.length })
    assertEquals("────────", OverlayMarkdown.parse("* ".repeat(8000)).text)
    assertEquals(many, OverlayMarkdown.parse("**x** ".repeat(3000)))
  }

  @Test fun tildeFencesAndRulesHaveReadableNativeProjection() {
    val document = OverlayMarkdown.parse("---\n~~~txt\nplain *code*\n~~~")
    assertEquals("────────\nplain *code*", document.text)
    assertEquals(listOf("────────"), styled(document, OverlayMarkdown.Style.RULE))
    assertTrue(styled(document, OverlayMarkdown.Style.BOLD).isEmpty())
  }

  @Test fun pipeTableBecomesAlignedTextWithBoldHeaderAndRuleInsteadOfLiteralPipes() {
    val document = OverlayMarkdown.parse("| Step | Status |\n| --- | --- |\n| Write file | done |\n| Read back | done |")
    // Columns pad to the widest cell: "Write file"(10) then "Status"(6), two spaces between columns.
    assertEquals(
      "Step        Status\n──────────────────\nWrite file  done  \nRead back   done  ",
      document.text,
    )
    assertTrue("Table rows must not keep literal pipe separators", !document.text.contains('|'))
    assertEquals(listOf("Step        Status"), styled(document, OverlayMarkdown.Style.BOLD))
    assertEquals(listOf("──────────────────"), styled(document, OverlayMarkdown.Style.RULE))
    assertTrue("Header title must stay content, not vanish into styling", document.text.startsWith("Step"))
  }

  @Test fun tableColumnsAlignByRenderedWidthForCjkAndEmojiWhileThematicRulesDoNot() {
    // Real model output: CJK text plus a check emoji in a two-column table.
    assertEquals(2, OverlayMarkdown.overlayDisplayWidth("表"))
    assertEquals(2, OverlayMarkdown.overlayDisplayWidth("\u2705"))
    assertEquals(3, OverlayMarkdown.overlayDisplayWidth("a表"))
    val doc = OverlayMarkdown.parse("| 项 | 状态 |\n| - | - |\n| 表格 | 已渲染 |")
    val bodyLines = doc.text.lines()
    assertEquals("Header row and rule and one body row", 3, bodyLines.size)
    // Both header and body must start column 2 at the same rendered offset.
    val headerCol2 = OverlayMarkdown.overlayDisplayWidth(bodyLines[0].substringBefore("状态"))
    val bodyCol2 = OverlayMarkdown.overlayDisplayWidth(bodyLines[2].substringBefore("已渲染"))
    assertEquals(headerCol2, bodyCol2)
  }

  @Test fun tableCellsAreBoundedAndEscapedPipesStayContentNotColumns() {
    val wide = (1..30).joinToString("|") { "c" + it }
    val document = OverlayMarkdown.parse("|" + wide + "|\n| - |\n| a \\| b |")
    val headerCells = document.text.lineSequence().first().split("  ").filter { it.isNotBlank() }
    assertTrue("Column fan-out must be capped, not unbounded", headerCells.size <= 8)
    // A lone row of pipes without a delimiter row is not a table and keeps its literal text.
    val plain = OverlayMarkdown.parse("a | b")
    assertEquals("a | b", plain.text)
  }

  @Test fun relativeLinkTargetIsNotRenderedTwiceButUnsafeSchemeStaysLiteral() {
    val relative = OverlayMarkdown.parse("File read [demo-report.md](demo-report.md) unchanged")
    assertEquals("File read demo-report.md unchanged", relative.text)
    assertEquals(listOf("demo-report.md"), styled(relative, OverlayMarkdown.Style.LINK))
    // A scheme-bearing target must never be shortened into something that reads as a live link.
    val unsafe = OverlayMarkdown.parse("[tap](javascript:evil)")
    assertEquals("[tap](javascript:evil)", unsafe.text)
    val web = OverlayMarkdown.parse("[docs](https://example.com/a)")
    assertEquals("docs (https://example.com/a)", web.text)
  }

  @Test fun tableInsideCodeFenceStaysLiteralCode() {
    val document = OverlayMarkdown.parse("~~~\n| a | b |\n| - | - |\n~~~")
    assertEquals("| a | b |\n| - | - |", document.text)
    assertEquals(listOf("| a | b |\n| - | - |"), styled(document, OverlayMarkdown.Style.CODE_BLOCK))
    assertTrue(styled(document, OverlayMarkdown.Style.BOLD).isEmpty())
  }
}
