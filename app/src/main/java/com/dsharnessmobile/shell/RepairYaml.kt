package com.dsharnessmobile.shell

/**
 * A deliberately small indentation parser for the DSH configuration subset.
 *
 * DSH persists user configuration in a Cordis patch and, on older installations,
 * settings.yaml. Both are YAML documents whose relevant values are mappings, lists,
 * scalars, and empty flow collections. This parser preserves node kinds so the repair
 * assistant can distinguish a model entry from an arbitrary nested key sharing the
 * same name. It never evaluates YAML tags or escapes, and it refuses unsupported
 * constructs rather than silently guessing a route.
 */
internal sealed class RepairYamlValue {
  /** An unrelated YAML block (for example a persona prompt); never a usable route scalar. */
  class Opaque : RepairYamlValue()

  /** A present key with an explicit null value (`null` / `~`); never the literal string. */
  class Null : RepairYamlValue()
  class Scalar(val value: String) : RepairYamlValue()
  class Mapping(val values: LinkedHashMap<String, RepairYamlValue>) : RepairYamlValue()
  class Sequence(val values: MutableList<RepairYamlValue>) : RepairYamlValue()

  fun string(key: String): String? = (this as? Mapping)?.values?.get(key)
    ?.let { it as? Scalar }?.value
  fun mapping(key: String): Mapping? = (this as? Mapping)?.values?.get(key) as? Mapping
  fun sequence(key: String): Sequence? = (this as? Mapping)?.values?.get(key) as? Sequence
}

internal object RepairYaml {
  fun parse(text: String): RepairYamlValue {
    // UTF-8 BOM is legal at the very start of a document but must not become part of
    // the first key. Strip it before any structural inspection.
    val normalized = text.removePrefix("\uFEFF").replace("\r\n", "\n").replace("\r", "\n")
    val kept = ArrayList<String>()
    var documentStarted = false
    for (raw in normalized.split("\n")) {
      val line = raw.trimStart('\uFEFF')
      val content = stripComment(line).trim()
      if (!documentStarted) {
        // Comments / blank lines may precede the document marker; %YAML and %TAG
        // directives are metadata, not document content.
        if (content.isEmpty() || content.startsWith("%")) continue
        if (content == "---") {
          documentStarted = true
          continue
        }
        documentStarted = true
      }
      // The end marker closes the explicit document. Only a column-zero marker is
      // structural: an indented "..." inside a block scalar is payload, not a marker.
      val columnZero = line == line.trimStart()
      if (columnZero && (content == "..." || content == "---")) break
      kept += line
    }
    val lines = kept.mapIndexedNotNull { index, raw -> parseLine(index + 1, raw) }
    if (lines.isEmpty()) return RepairYamlValue.Mapping(LinkedHashMap())
    val parser = Parser(lines)
    return parser.document()
  }

  private data class Line(val indent: Int, val text: String)

  private fun parseLine(number: Int, raw: String): Line? {
    val noComment = stripComment(raw)
    if (noComment.isBlank()) return null
    val indent = noComment.indexOfFirst { it != ' ' }
    if (indent < 0) return null
    require(!noComment.startsWith("\t")) { "unsupported tab indentation at line " + number }
    val content = noComment.substring(indent).trimEnd()
    return Line(indent, content)
  }

  private fun stripComment(raw: String): String {
    var quote: Char? = null
    var i = 0
    while (i < raw.length) {
      val c = raw[i]
      if (quote != null) {
        if (c == quote && (i == 0 || raw[i - 1] != '\\')) quote = null
      } else if (c == '\'' || c == '"') {
        quote = c
      } else if (c == '#' && (i == 0 || raw[i - 1].isWhitespace())) {
        return raw.substring(0, i)
      }
      i++
    }
    return raw
  }

  private class Parser(private val lines: List<Line>) {
    private var index = 0

    fun document(): RepairYamlValue {
      if (lines.isEmpty()) return RepairYamlValue.Mapping(LinkedHashMap())
      val result = node(lines.first().indent)
      require(index == lines.size) { "unexpected content at line " + lines[index].text }
      return result
    }

    private fun node(indent: Int): RepairYamlValue {
      if (index >= lines.size) return RepairYamlValue.Mapping(LinkedHashMap())
      return if (isSequenceLine(lines[index].text)) sequence(indent) else mapping(indent)
    }

    private fun isSequenceLine(text: String): Boolean =
      text == "-" || text.startsWith("- ")

    private fun mapping(indent: Int): RepairYamlValue.Mapping {
      val values = LinkedHashMap<String, RepairYamlValue>()
      while (index < lines.size) {
        val line = lines[index]
        if (line.indent < indent) break
        if (line.indent > indent) throw IllegalArgumentException("unexpected indentation at " + line.text)
        if (isSequenceLine(line.text)) break
        val pair = splitKey(line.text) ?: throw IllegalArgumentException("expected mapping key: " + line.text)
        index++
        val key = unquote(pair.first)
        val inline = pair.second.trim()
        values[key] = when {
          inline.isEmpty() -> childOrEmpty(indent)
          isBlockHeader(inline) -> blockScalar(inline, indent)
          inline.startsWith("{") || inline.startsWith("[") -> flow(inline)
          else -> scalar(inline)
        }
      }
      return RepairYamlValue.Mapping(values)
    }

    private fun sequence(indent: Int): RepairYamlValue.Sequence {
      val values = mutableListOf<RepairYamlValue>()
      while (index < lines.size) {
        val line = lines[index]
        if (line.indent < indent) break
        if (line.indent > indent) throw IllegalArgumentException("unexpected indentation at " + line.text)
        if (!isSequenceLine(line.text)) break
        val rest = line.text.drop(1).trimStart()
        index++
        when {
          rest.isEmpty() -> values += childOrEmpty(indent)
          rest.startsWith("{") || rest.startsWith("[") -> values += flow(rest)
          isBlockHeader(rest) -> values += blockScalar(rest, indent)
          splitKey(rest) != null -> {
            val objectIndent = indent + 2
            val valuesInItem = LinkedHashMap<String, RepairYamlValue>()
            val first = splitKey(rest)!!
            val firstValue = first.second.trim()
            valuesInItem[unquote(first.first)] = when {
              // The first key used the sequence dash itself as its parent. Valid
              // YAML may indent its value at the sibling level (two spaces) or
              // deeper (four spaces); only the former is also the object indent.
              firstValue.isEmpty() -> childOrEmpty(indent)
              isBlockHeader(firstValue) -> blockScalar(firstValue, objectIndent)
              else -> scalarOrFlow(firstValue)
            }
            while (index < lines.size && lines[index].indent == objectIndent &&
              !isSequenceLine(lines[index].text)) {
              val child = lines[index]
              val pair = splitKey(child.text)
                ?: throw IllegalArgumentException("expected mapping key: " + child.text)
              index++
              val tail = pair.second.trim()
              valuesInItem[unquote(pair.first)] = when {
                tail.isEmpty() -> childOrEmpty(objectIndent)
                isBlockHeader(tail) -> blockScalar(tail, objectIndent)
                else -> scalarOrFlow(tail)
              }
            }
            values += RepairYamlValue.Mapping(valuesInItem)
          }
          else -> values += scalarOrFlow(rest)
        }
      }
      return RepairYamlValue.Sequence(values)
    }

    private fun childOrEmpty(parentIndent: Int): RepairYamlValue {
      if (index >= lines.size) return RepairYamlValue.Mapping(LinkedHashMap())
      val next = lines[index]
      if (next.indent < parentIndent) return RepairYamlValue.Mapping(LinkedHashMap())
      // Indentless block sequence: a mapping key may own a sequence whose dashes sit
      // at the same column as the key itself (legal YAML, common in hand-edited files).
      if (next.indent == parentIndent && isSequenceLine(next.text)) {
        return sequence(parentIndent)
      }
      if (next.indent <= parentIndent) return RepairYamlValue.Mapping(LinkedHashMap())
      return node(next.indent)
    }

    private fun scalarOrFlow(value: String): RepairYamlValue =
      if (value.startsWith("{") || value.startsWith("[")) flow(value) else scalar(value)

    private fun scalar(value: String): RepairYamlValue {
      val trimmed = value.trim()
      if (isPlainNull(trimmed)) return RepairYamlValue.Null()
      return RepairYamlValue.Scalar(unquote(trimmed))
    }

    /** YAML null forms are values, not strings: `baseURL: null` must stay missing. */
    private fun isPlainNull(value: String): Boolean {
      if (value.length >= 2 && (value.first() == '\'' || value.first() == '"')) return false
      return value.isEmpty() || value == "~" || value.equals("null", ignoreCase = true)
    }

    private fun flow(value: String): RepairYamlValue {
      val text = value.trim()
      val reader = FlowReader(text)
      val node = reader.readNode()
      require(reader.remaining() == 0) { "trailing content after inline flow collection" }
      return node
    }

    /**
     * Recursive reader for YAML flow collections.
     *
     * Quoted entries may contain commas, colons and brackets; those separators belong
     * to the scalar, not to the collection. Nested `{}` / `[]` recurse, so a patch
     * such as `config: {providers: {demo: {models: [a, b]}}}` resolves structurally.
     */
    private inner class FlowReader(private val text: String) {
      private var index = 0

      fun remaining(): Int = text.length - index

      fun readNode(): RepairYamlValue {
        skipSpace()
        require(index < text.length) { "unexpected end of inline flow collection" }
        return when (text[index]) {
          '{' -> mapping()
          '[' -> sequence()
          else -> throw IllegalArgumentException("inline flow collection must start with { or [")
        }
      }

      private fun mapping(): RepairYamlValue.Mapping {
        index++
        val values = LinkedHashMap<String, RepairYamlValue>()
        skipSpace()
        if (peek('}')) { index++; return RepairYamlValue.Mapping(values) }
        while (true) {
          skipSpace()
          val key = unquote(readScalar(setOf(':')))
          skipSpace()
          require(peek(':')) { "expected ':' in inline flow mapping" }
          index++
          val value = value(setOf(',', '}'))
          values[key] = value
          skipSpace()
          require(index < text.length) { "unterminated inline flow mapping" }
          when (text[index]) {
            ',' -> {
              index++
              skipSpace()
              if (peek('}')) { index++; return RepairYamlValue.Mapping(values) }
            }
            '}' -> { index++; return RepairYamlValue.Mapping(values) }
            else -> throw IllegalArgumentException("expected ',' or '}' in inline flow mapping")
          }
        }
      }

      private fun sequence(): RepairYamlValue.Sequence {
        index++
        val values = mutableListOf<RepairYamlValue>()
        skipSpace()
        if (peek(']')) { index++; return RepairYamlValue.Sequence(values) }
        while (true) {
          values += value(setOf(',', ']'))
          skipSpace()
          require(index < text.length) { "unterminated inline flow sequence" }
          when (text[index]) {
            ',' -> {
              index++
              skipSpace()
              if (peek(']')) { index++; return RepairYamlValue.Sequence(values) }
            }
            ']' -> { index++; return RepairYamlValue.Sequence(values) }
            else -> throw IllegalArgumentException("expected ',' or ']' in inline flow sequence")
          }
        }
      }

      private fun value(stopAt: Set<Char>): RepairYamlValue {
        skipSpace()
        if (index < text.length && (text[index] == '{' || text[index] == '[')) return readNode()
        val raw = readScalar(stopAt)
        return scalar(raw)
      }

      private fun readScalar(stopAt: Set<Char>): String {
        skipSpace()
        val start = index
        var quote: Char? = null
        while (index < text.length) {
          val c = text[index]
          if (quote != null) {
            if (c == quote && (index == 0 || text[index - 1] != '\\')) quote = null
            index++
            continue
          }
          if (c == '\'' || c == '"') { quote = c; index++; continue }
          if (c in stopAt) break
          index++
        }
        return text.substring(start, index).trim()
      }

      private fun skipSpace() {
        while (index < text.length && text[index].isWhitespace()) index++
      }

      private fun peek(c: Char): Boolean = index < text.length && text[index] == c
    }

    /** YAML block scalar header: `|`, `|-2`, `|2-`, `>+`, `>2+` (both suffix orders). */
    private fun isBlockHeader(value: String): Boolean {
      if (value.isEmpty() || (value[0] != '|' && value[0] != '>')) return false
      return value.substring(1).matches(Regex("(?:[+-][1-9]?|[1-9][+-]?)?"))
    }

    /** Skip block payloads without interpreting prompts as config keys or guessing credentials. */
    private fun blockScalar(header: String, parentIndent: Int): RepairYamlValue {
      require(isBlockHeader(header))
      while (index < lines.size && lines[index].indent > parentIndent) index++
      return RepairYamlValue.Opaque()
    }

    private fun splitKey(value: String): Pair<String, String>? {
      var quote: Char? = null
      var depth = 0
      for (i in value.indices) {
        val c = value[i]
        if (quote != null) {
          if (c == quote && (i == 0 || value[i - 1] != '\\')) quote = null
        } else when (c) {
          '\'', '"' -> quote = c
          '[', '{' -> depth++
          ']', '}' -> depth--
          ':' -> if (depth == 0 && (i + 1 == value.length || value[i + 1].isWhitespace())) {
            return value.substring(0, i).trim() to value.substring(i + 1)
          }
        }
      }
      return null
    }

    private fun unquote(value: String): String {
      val trimmed = value.trim()
      if (trimmed.length < 2) return trimmed
      return when {
        trimmed.first() == '\'' && trimmed.last() == '\'' ->
          trimmed.substring(1, trimmed.length - 1).replace("''", "'")
        trimmed.first() == '"' && trimmed.last() == '"' -> unescapeDouble(trimmed.substring(1, trimmed.length - 1))
        else -> trimmed
      }
    }

    private fun unescapeDouble(value: String): String {
      val out = StringBuilder(value.length)
      var i = 0
      while (i < value.length) {
        val c = value[i]
        if (c != '\\' || i + 1 >= value.length) { out.append(c); i++; continue }
        when (val next = value[++i]) {
          'n' -> out.append('\n')
          'r' -> out.append('\r')
          't' -> out.append('\t')
          '\\', '"', '/' -> out.append(next)
          else -> { out.append('\\'); out.append(next) }
        }
        i++
      }
      return out.toString()
    }
  }
}
