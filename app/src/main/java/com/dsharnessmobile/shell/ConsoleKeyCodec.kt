package com.dsharnessmobile.shell

/**
 * 按键串的编码解码（纯函数）。
 *
 * ── 为什么需要这一层 ─────────────────────────────────────────────────────────
 * Android WebView 的 @JavascriptInterface 在字符串参数含 \n / \r 时**整个调用不会到达 Java 侧**：
 * 不抛异常、不留日志，桥接调用静默消失。设备实测：
 *   writeRaw("PLAIN")      -> 到达（有日志）
 *   writeRaw("WITHNL\n")   -> 完全没到（连日志都没有）
 *   writeRaw("WITHCR\r")   -> 同样没到
 * 而控制台要送的方向键、Ctrl-C、Tab 全是这类字符。所以页面侧必须先编码成不含控制字符的串。
 *
 * 编码规则：
 *   \\n  -> 换行        \\r  -> 回车        \\t  -> 制表
 *   \\e  -> ESC(0x1B)   \\\\  -> 反斜杠
 *   \\xHH -> 原始字节（HH 为两位十六进制）
 * 其余字符原样保留；**无法识别的转义丢弃引导反斜杠、保留字符本身**（`\q` → `q`，`\xZZ` → `xZZ`）。
 * 这一条有专门用例钉住（`unknownEscapeDropsTheBackslashAndKeepsTheCharacter` 与
 * `badHexFallsBackToTheEscapedCharacter`）—— 与"不吞字符"的直觉相反，但页面侧已把每个 `\`
 * 编码成 `\\`，真实输入（含 Windows 路径）不会走到这一支；改实现会让那两条用例变红，
 * 属有意契约，2026-10-28 复核后维持现状、只把注释与本意对齐。
 */
internal object ConsoleKeyCodec {

  /**
   * 把页面送来的编码串还原成可以写进 PTY 的真实字节。
   *
   * M-c3（2026-10-25 审计）：`\xHH` 直接产出**原始字节**而不是 Char——旧实现 `code.toChar()`
   * 在 HH ≥ 0x80 时造出 Latin-1 区字符，writeRaw 再 `toByteArray(UTF_8)` 会把它二次编码成
   * 两个字节：`\xE4\xBD\xA0`（"你"的 UTF-8 三字节）送进 PTY 变 6 字节垃圾。现在按字节累计、
   * 字面量按 UTF-8 展开，最后整体按 UTF-8 解码——连续的合法多字节序列还原正确；
   * 孤立的非法高字节退替换符（尽力而为，不吞输入）。
   *
   * @param encoded 编码串（不含裸控制字符）。
   * @return 还原后的串。
   */
  fun decode(encoded: String): String {
    val out = java.io.ByteArrayOutputStream(encoded.length + 16)
    val plain = StringBuilder()
    fun flushPlain() {
      if (plain.isNotEmpty()) {
        val bytes = plain.toString().toByteArray(Charsets.UTF_8)
        out.write(bytes, 0, bytes.size)
        plain.setLength(0)
      }
    }
    var i = 0
    while (i < encoded.length) {
      val ch = encoded[i]
      if (ch != '\\') {
        plain.append(ch)
        i += 1
        continue
      }
      if (i + 1 >= encoded.length) {
        // 结尾单个反斜杠：按字面量保留，不吞。
        plain.append('\\')
        break
      }
      when (val esc = encoded[i + 1]) {
        'n' -> { plain.append('\n'); i += 2 }
        'r' -> { plain.append('\r'); i += 2 }
        't' -> { plain.append('\t'); i += 2 }
        'e' -> { plain.append('\u001b'); i += 2 }
        '\\' -> { plain.append('\\'); i += 2 }
        'x' -> {
          val hex = if (i + 4 <= encoded.length) encoded.substring(i + 2, i + 4) else ""
          val code = hex.toIntOrNull(16)
          if (code == null) {
            // 不合法的十六进制：保留字面量，不静默删除用户输入。
            plain.append(esc)
            i += 2
          } else {
            flushPlain()
            out.write(code)
            i += 4
          }
        }
        else -> { plain.append(esc); i += 2 }
      }
    }
    flushPlain()
    return out.toByteArray().toString(Charsets.UTF_8)
  }
}
