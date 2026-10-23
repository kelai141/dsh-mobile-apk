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
    if (text.trimStart().startsWith("---")) {
      val body = text.substring(text.indexOf("---") + 3)
      return parse(body)
    }
    val lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
      .mapIndexedNotNull { index, raw -> parseLine(index + 1, raw) }
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
    require(!noComment.startsWith("\t")) { "unsupported tab indentation at line $number" }
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
      return if (lines[index].text.startsWith("-") &&
        (lines[index].text == "-" || lines[index].text.startsWith("- "))) {
        sequence(indent)
      } else mapping(indent)
    }

    private fun mapping(indent: Int): RepairYamlValue.Mapping {
      val values = LinkedHashMap<String, RepairYamlValue>()
      while (index < lines.size) {
        val line = lines[index]
        if (line.indent < indent) break
        if (line.indent > indent) throw IllegalArgumentException("unexpected indentation at " + line.text)
        if (line.text.startsWith("-")) break
        val pair = splitKey(line.text) ?: throw IllegalArgumentException("expected mapping key: " + line.text)
        index++
        val key = unquote(pair.first)
        val inline = pair.second.trim()
        values[key] = when {
          inline.isEmpty() -> childOrEmpty(indent)
          inline == "{}" -> RepairYamlValue.Mapping(LinkedHashMap())
          inline == "[]" -> RepairYamlValue.Sequence(mutableListOf())
          isBlockHeader(inline) -> blockScalar(inline, indent)
          inline.startsWith("{") || inline.startsWith("[") -> flow(inline)
          else -> RepairYamlValue.Scalar(unquote(inline))
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
        if (!line.text.startsWith("-")) break
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
              !lines[index].text.startsWith("-")) {
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
      if (index >= lines.size || lines[index].indent <= parentIndent) {
        return RepairYamlValue.Mapping(LinkedHashMap())
      }
      return node(lines[index].indent)
    }

    private fun scalarOrFlow(value: String): RepairYamlValue =
      if (value.startsWith("{") || value.startsWith("[")) flow(value) else RepairYamlValue.Scalar(unquote(value))

    private fun flow(value: String): RepairYamlValue {
      // Empty flow objects/lists cover the factory seed. Other inline flow values
      // are not needed for provider routes and stay fail-closed.
      return when (value.trim()) {
        "{}" -> RepairYamlValue.Mapping(LinkedHashMap())
        "[]" -> RepairYamlValue.Sequence(mutableListOf())
        else -> throw IllegalArgumentException("inline flow collections are not supported")
      }
    }

    /** YAML block scalar header: `|`, `|-`, `|+`, `>`, `>-`, `>+` with an optional indent digit. */
    private fun isBlockHeader(value: String): Boolean {
      if (value.isEmpty() || (value[0] != '|' && value[0] != '>')) return false
      return value.substring(1).matches(Regex("[+-]?[1-9]?"))
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
