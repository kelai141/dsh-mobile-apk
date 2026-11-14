package com.dsharnessmobile.shell

/** Pure, bounded Markdown-to-text projection. No HTML, URI execution, image fetch or Android dependency. */
internal object OverlayMarkdown {
  enum class Style { BOLD, ITALIC, STRIKE, CODE, CODE_BLOCK, HEADING, QUOTE, LINK, RULE }
  data class Span(val start: Int, val end: Int, val style: Style, val level: Int = 0)
  data class Document(val text: String, val spans: List<Span>, val truncated: Boolean)

  private const val MAX_SOURCE_CHARS = 16_000
  private const val MAX_SPANS = 512
  private const val MAX_INLINE_DEPTH = 8
  private val delimiters = listOf("**" to Style.BOLD, "__" to Style.BOLD, "~~" to Style.STRIKE, "*" to Style.ITALIC, "_" to Style.ITALIC)
  private val heading = Regex("^(#{1,6}) +(.+)$")
  private val bullet = Regex("^(\\s*)([-+*]) +(.+)$")
  private val ordered = Regex("^(\\s*)([0-9]{1,9})[.)] +(.+)$")
  private val quote = Regex("^ {0,3}> ?(.*)$")
  private fun isRule(line: String): Boolean {
    val trimmed = line.trim()
    val marker = trimmed.firstOrNull() ?: return false
    var indent = 0
    while (indent < line.length && line[indent] == ' ') indent++
    return marker in "-*_" && indent <= 3 &&
      trimmed.count { it == marker } >= 3 && trimmed.all { it == marker || it == ' '}
  }
  private val fence = Regex("^ {0,3}(`{3,}|~{3,})(.*)$")

  /**
   * Rendered-cell width, not character count.
   *
   * Why: a model answers tables with CJK text and emoji (such as "表格已渲染"). Those glyphs occupy
   * two columns, so padding by String.length leaves the columns visibly ragged on the phone - which
   * is exactly the misalignment a user sees. Wide ranges count as 2, everything else as 1.
   */
  internal fun overlayDisplayWidth(text: String): Int {
    var width = 0
    var i = 0
    while (i < text.length) {
      val cp = text.codePointAt(i)
      width += if (isWide(cp)) 2 else 1
      i += Character.charCount(cp)
    }
    return width
  }

  private fun isWide(codePoint: Int): Boolean =
    codePoint in 0x1100..0x115F || codePoint in 0x2E80..0xA4CF || codePoint in 0xAC00..0xD7A3 ||
      codePoint in 0xF900..0xFAFF || codePoint in 0xFE30..0xFE6F || codePoint in 0xFF00..0xFF60 ||
      codePoint in 0xFFE0..0xFFE6 || codePoint in 0x1F300..0x1FAFF || codePoint in 0x2600..0x27BF

  /**
   * Table projection.
   *
   * Why it exists: a model asked for a report legitimately answers with a pipe table. Rendering those
   * rows as literal pipes is not Markdown, it is unreadable noise on a 900px phone. Tables are flattened
   * to aligned plain text (never a WebView, never HTML) so the surface stays safe and bounded:
   * at most [MAX_TABLE_COLUMNS] columns and [MAX_CELL_CHARS] per cell, first row is the header.
   */
  private const val MAX_TABLE_COLUMNS = 8
  private const val MAX_CELL_CHARS = 120
  private val delimiterCell = Regex("^:?-{1,}:?$")

  private fun cells(line: String): List<String> {
    val trimmed = line.trim()
    val body = if (trimmed.startsWith("|")) trimmed.substring(1) else trimmed
    val cut = if (body.endsWith("|")) body.substring(0, body.length - 1) else body
    val parts = ArrayList<String>()
    var current = StringBuilder()
    var i = 0
    // A backslash-escaped pipe is content, not a column boundary.
    while (i < cut.length && parts.size < MAX_TABLE_COLUMNS) {
      val ch = cut[i]
      if (ch == '\\' && i + 1 < cut.length && cut[i + 1] == '|') { current.append('|'); i += 2; continue }
      if (ch == '|') { parts.add(current.toString().trim().take(MAX_CELL_CHARS)); current = StringBuilder(); i++; continue }
      current.append(ch); i++
    }
    if (parts.size < MAX_TABLE_COLUMNS) parts.add(current.toString().trim().take(MAX_CELL_CHARS))
    return parts
  }

  private fun isDelimiterRow(line: String): Boolean {
    val parts = cells(line)
    return parts.isNotEmpty() && parts.all { delimiterCell.matches(it.replace(" ", "")) }
  }

  /**
   * Plain text of one table cell: inline Markdown projected, styling dropped.
   *
   * Table rows are laid out as aligned text, so a cell cannot carry spans without breaking the
   * column alignment. Dropping only the styling keeps the words correct, which is what a reader
   * needs, and it stops raw link/emphasis syntax leaking into a table.
   */
  private fun plainText(cell: String): String {
    val projected = inlineOnly(cell)
    return projected.text
  }

  /** Bounded inline-only projection reused by table cells; never recurses into block parsing. */
  private fun inlineOnly(source: String): Document {
    val out = StringBuilder(source.length)
    val spans = ArrayList<Span>()
    val text = source.substring(0, minOf(source.length, MAX_CELL_CHARS))

    fun addSpan(start: Int, stop: Int, style: Style) {
      if (stop > start && spans.size < MAX_SPANS) spans.add(Span(start, stop, style, 0))
    }

    fun walk(segment: String, depth: Int) {
      var i = 0
      while (i < segment.length) {
        val ch = segment[i]
        if (ch == '\\' && i + 1 < segment.length) { out.append(segment[i + 1]); i += 2; continue }
        if (ch == '[') {
          val labelEnd = segment.indexOf(']', i + 1)
          if (labelEnd > i && labelEnd + 1 < segment.length && segment[labelEnd + 1] == '(') {
            val targetEnd = segment.indexOf(')', labelEnd + 2)
            if (targetEnd > labelEnd + 2) {
              val target = segment.substring(labelEnd + 2, targetEnd)
              val start = out.length
              val label = segment.substring(i + 1, labelEnd)
              if (depth < 3) walk(label, depth + 1) else out.append(label)
              // Web targets keep the destination (it is the useful part when text is not tappable);
              // relative targets show the label once instead of repeating it.
              if (target.startsWith("https://", true) || target.startsWith("http://", true)) {
                out.append(" (").append(target).append(')')
              }
              addSpan(start, out.length, Style.LINK)
              i = targetEnd + 1
              continue
            }
          }
        }
        var matched = false
        for ((marker, style) in delimiters) {
          if (!segment.startsWith(marker, i)) continue
          val close = segment.indexOf(marker, i + marker.length)
          if (close <= i + marker.length) continue
          val start = out.length
          val inner = segment.substring(i + marker.length, close)
          if (depth < 3) walk(inner, depth + 1) else out.append(inner)
          addSpan(start, out.length, style)
          i = close + marker.length; matched = true; break
        }
        if (!matched) { out.append(ch); i++ }
      }
    }

    walk(text, 0)
    return Document(out.toString(), spans, truncated = source.length > text.length)
  }

  /** Table detection stays local to a header+delimiter pair; a lone row of pipes keeps its literal text. */
  fun parse(source: String): Document {
    var end = minOf(source.length, MAX_SOURCE_CHARS)
    if (end < source.length && end > 0 && source[end - 1].isHighSurrogate()) end--
    val input = source.substring(0, end).replace("\r\n", "\n").replace('\r', '\n')
    val out = StringBuilder(input.length)
    val spans = ArrayList<Span>()
    fun addSpan(start: Int, stop: Int, style: Style, level: Int = 0) {
      if (stop > start && spans.size < MAX_SPANS) spans.add(Span(start, stop, style, level))
    }
    fun inline(text: String, depth: Int = 0) {
      if (depth >= MAX_INLINE_DEPTH) { out.append(text); return }
      var i = 0
      while (i < text.length) {
        val ch = text[i]
        if (ch == '\\' && i + 1 < text.length && text[i + 1] in "\\`*_{}[]()#+-.!>~") {
          out.append(text[i + 1]); i += 2; continue
        }
        if (ch == '`') {
          var count = 1
          while (i + count < text.length && text[i + count] == '`') count++
          val marker = "`".repeat(count)
          val close = text.indexOf(marker, i + count)
          if (close >= i + count) {
            val start = out.length
            out.append(text.substring(i + count, close))
            addSpan(start, out.length, Style.CODE)
            i = close + count; continue
          }
          out.append(marker); i += count; continue
        }
        // Links are display-only: retain the destination as readable text, never create executable spans.
        // Images remain literal Markdown; an alt label must not pretend an image was loaded.
        val image = ch == '!' && i + 1 < text.length && text[i + 1] == '['
        if (ch == '[' || image) {
          val open = i + if (image) 1 else 0
          val labelEnd = text.indexOf(']', open + 1)
          if (labelEnd > open && labelEnd + 1 < text.length && text[labelEnd + 1] == '(') {
            val targetEnd = text.indexOf(')', labelEnd + 2)
            if (targetEnd > labelEnd + 2) {
              val target = text.substring(labelEnd + 2, targetEnd)
              val web = target.startsWith("https://", true) || target.startsWith("http://", true) || target.startsWith("mailto:", true)
              if (!image && web) {
                val start = out.length
                inline(text.substring(open + 1, labelEnd), depth + 1)
                out.append(" (").append(target).append(')')
                addSpan(start, out.length, Style.LINK)
              } else if (!image && target.none { it == ':' }) {
                // Relative targets (e.g. demo-report.md) used to fall back to the raw
                // "[label](target)" source, so the phone showed the same name twice. Show the label
                // only. Targets containing a scheme (javascript:, data:, ...) stay fully literal so an
                // unsafe URI is never reduced to something that looks tappable.
                val start = out.length
                inline(text.substring(open + 1, labelEnd), depth + 1)
                addSpan(start, out.length, Style.LINK)
              } else out.append(text.substring(i, targetEnd + 1))
              i = targetEnd + 1; continue
            }
          }
        }
        var matched = false
        for ((marker, style) in delimiters) {
          if (!text.startsWith(marker, i)) continue
          // Snake_case and identifiers are not emphasis.
          if (marker == "_" && i > 0 && text[i - 1].isLetterOrDigit()) continue
          val close = text.indexOf(marker, i + marker.length)
          if (close <= i + marker.length || text[i + marker.length].isWhitespace() || text[close - 1].isWhitespace()) continue
          val start = out.length
          inline(text.substring(i + marker.length, close), depth + 1)
          addSpan(start, out.length, style)
          i = close + marker.length; matched = true; break
        }
        if (!matched) { out.append(ch); i++ }
      }
    }
    var fenceChar: Char? = null
    var fenceLength = 0
    var codeStart = 0
    var emitted = false
    val lines = input.split('\n')
    var index = 0
    while (index < lines.size) {
      val line = lines[index]
      // Table block: a header row immediately followed by a delimiter row.
      if (fenceChar == null && line.contains('|') && index + 1 < lines.size && isDelimiterRow(lines[index + 1])) {
        val width = ArrayList<Int>()
        val rows = ArrayList<List<String>>()
        rows.add(cells(line))
        var scan = index + 2
        while (scan < lines.size && lines[scan].contains('|') && !fence.matches(lines[scan]) && !isDelimiterRow(lines[scan])) {
          rows.add(cells(lines[scan])); scan++
        }
        // Cells may carry inline Markdown (links, bold, code). Project each cell through the same
        // bounded inline pass the body uses, otherwise a phone shows the raw "[label](target)" text
        // inside a table while the identical construct renders correctly one line below it.
        val projected = rows.map { row -> row.map { cell -> plainText(cell) } }
        for (row in projected) for (c in row.indices) {
          if (c >= width.size) width.add(0)
          width[c] = maxOf(width[c], overlayDisplayWidth(row[c]))
        }
        for (r in rows.indices) {
          if (emitted) out.append('\n')
          emitted = true
          val start = out.length
          projected[r].forEachIndexed { c, cell ->
            if (c > 0) out.append("  ")
            out.append(cell)
            val pad = (width.getOrElse(c) { 0 } - overlayDisplayWidth(cell)).coerceAtLeast(0)
            repeat(pad) { out.append(' ') }
          }
          if (r == 0) {
            addSpan(start, out.length, Style.BOLD)
            out.append('\n')
            var underline = 0
            for (c in width.indices) {
              if (c > 0) underline += 2
              underline += width[c]
            }
            val ruleStart = out.length
            repeat(underline.coerceAtMost(MAX_SOURCE_CHARS)) { out.append('─') }
            addSpan(ruleStart, out.length, Style.RULE)
          }
        }
        index = scan
        continue
      }
      index++
      val fenceMatch = fence.matchEntire(line)
      if (fenceChar != null) {
        if (fenceMatch != null && fenceMatch.groupValues[1].first() == fenceChar && fenceMatch.groupValues[1].length >= fenceLength && fenceMatch.groupValues[2].isBlank()) {
          addSpan(codeStart, out.length, Style.CODE_BLOCK)
          fenceChar = null
        } else {
          if (emitted) out.append('\n')
          out.append(line); emitted = true
        }
        continue
      }
      if (fenceMatch != null) {
        fenceChar = fenceMatch.groupValues[1].first()
        fenceLength = fenceMatch.groupValues[1].length
        codeStart = out.length
        continue
      }
      if (emitted) out.append('\n')
      emitted = true
      val start = out.length
      val h = heading.matchEntire(line)
      val q = quote.matchEntire(line)
      val b = bullet.matchEntire(line)
      val n = ordered.matchEntire(line)
      when {
        h != null -> { inline(h.groupValues[2]); addSpan(start, out.length, Style.HEADING, h.groupValues[1].length) }
        q != null -> { inline(q.groupValues[1]); addSpan(start, out.length, Style.QUOTE) }
        isRule(line) -> { out.append("────────"); addSpan(start, out.length, Style.RULE) }
        b != null -> { out.append(b.groupValues[1]).append("• "); inline(b.groupValues[3]) }
        n != null -> { out.append(n.groupValues[1]).append(n.groupValues[2]).append(". "); inline(n.groupValues[3]) }
        else -> inline(line)
      }
    }
    if (fenceChar != null) addSpan(codeStart, out.length, Style.CODE_BLOCK)
    return Document(out.toString(), spans, end < source.length)
  }
}
