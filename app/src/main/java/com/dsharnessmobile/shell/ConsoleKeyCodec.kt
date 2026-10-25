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
 * 其余字符原样保留；无法识别的转义按字面量处理（不吞字符）。
 */
internal object ConsoleKeyCodec {

  /**
   * 把页面送来的编码串还原成可以写进 PTY 的真实字节。
   *
   * @param encoded 编码串（不含裸控制字符）。
   * @return 还原后的串。
   */
  fun decode(encoded: String): String {
    val sb = StringBuilder(encoded.length)
    var i = 0
    while (i < encoded.length) {
      val ch = encoded[i]
      if (ch != '\\') {
        sb.append(ch)
        i += 1
        continue
      }
      if (i + 1 >= encoded.length) {
        // 结尾单个反斜杠：按字面量保留，不吞。
        sb.append('\\')
        break
      }
      when (val esc = encoded[i + 1]) {
        'n' -> { sb.append('\n'); i += 2 }
        'r' -> { sb.append('\r'); i += 2 }
        't' -> { sb.append('\t'); i += 2 }
        'e' -> { sb.append('\u001b'); i += 2 }
        '\\' -> { sb.append('\\'); i += 2 }
        'x' -> {
          val hex = if (i + 4 <= encoded.length) encoded.substring(i + 2, i + 4) else ""
          val code = hex.toIntOrNull(16)
          if (code == null) {
            // 不合法的十六进制：保留字面量，不静默删除用户输入。
            sb.append(esc)
            i += 2
          } else {
            sb.append(code.toChar())
            i += 4
          }
        }
        else -> { sb.append(esc); i += 2 }
      }
    }
    return sb.toString()
  }
}
