package com.dsharnessmobile.shell.nativecontrol

/** JSONObject 接受单引号与未加引号的键。IPC 先检查标准 JSON 文法与深度再交给它。 */
internal object NativeJsonSyntax {
  fun validate(text: String) = Parser(text).document()

  private class Parser(private val text: String) {
    private var position = 0
    fun document() {
      value(0)
      space()
      if (position != text.length) invalid()
    }

    private fun value(depth: Int) {
      space()
      when (peek()) {
        '{', '[' -> {
          if (depth >= 64) throw NativeControlFrames.WireException("json-too-deep")
          val objectValue = peek() == '{'
          position++
          space()
          val end = if (objectValue) '}' else ']'
          if (take(end)) return
          while (true) {
            if (objectValue) {
              string()
              space()
              if (!take(':')) invalid()
            }
            value(depth + 1)
            space()
            if (take(end)) return
            if (!take(',')) invalid()
            space()
          }
        }
        '"' -> string()
        't' -> literal("true")
        'f' -> literal("false")
        'n' -> literal("null")
        '-', in '0'..'9' -> number()
        else -> invalid()
      }
    }

    private fun string() {
      if (!take('"')) invalid()
      while (position < text.length) {
        val char = text[position++]
        if (char == '"') return
        if (char.code < 32) invalid()
        if (char == '\\') {
          if (position >= text.length) invalid()
          when (text[position++]) {
            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
            'u' -> repeat(4) {
              val hex = peek()
              if (hex !in '0'..'9' && hex !in 'a'..'f' && hex !in 'A'..'F') invalid()
              position++
            }
            else -> invalid()
          }
        }
      }
      invalid()
    }

    private fun number() {
      take('-')
      if (!take('0')) digits()
      if (take('.')) digits()
      if (peek() == 'e' || peek() == 'E') {
        position++
        if (!take('+')) take('-')
        digits()
      }
    }

    private fun digits() {
      if (peek() !in '0'..'9') invalid()
      while (peek() in '0'..'9') position++
    }

    private fun literal(value: String) {
      if (!text.startsWith(value, position)) invalid()
      position += value.length
    }

    private fun space() { while (peek() in charArrayOf(' ', '\t', '\r', '\n')) position++ }
    private fun peek(): Char = text.getOrNull(position) ?: '\u0000'
    private fun take(char: Char): Boolean = (peek() == char).also { if (it) position++ }
    private fun invalid(): Nothing = throw NativeControlFrames.WireException("invalid-json-object")
  }
}
