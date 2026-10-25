package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 按键编码的判据。
 *
 * 为什么要有这层编码：Android WebView 的 @JavascriptInterface 在字符串参数含 \n / \r 时
 * **整个调用不会到达 Java 侧**——不抛异常、不留日志，桥接调用静默消失。
 * 设备实测：writeRaw("PLAIN") 有日志，writeRaw("WITHNL\n") 与 writeRaw("WITHCR\r") 连日志都没有。
 * 而控制台要送的方向键、Ctrl-C、Tab 全是这类字符，所以页面必须先编码成不含控制符的串再过桥。
 */
class ConsoleKeyCodecTest {

  private fun decode(s: String): String = ConsoleKeyCodec.decode(s)

  @Test
  fun plainTextPassesThroughUnchanged() {
    assertEquals("abcXYZ0123", decode("abcXYZ0123"))
  }

  @Test
  fun newlineAndCarriageReturnAreRestored() {
    // 命令提交靠这两个字符，丢一个就不能执行。
    assertEquals("echo hi\n", decode("echo hi\\n"))
    assertEquals("echo hi\r", decode("echo hi\\r"))
  }

  @Test
  fun escapeIntroducesTheEscapeByte() {
    // 方向键是 ESC [ A 这类序列，ESC 必须是真字节 0x1B，不能是字面量 "e"。
    assertEquals("\u001b[A", decode("\\e[A"))
    assertEquals("\u001b", decode("\\e"))
  }

  @Test
  fun hexEscapeCoversAnyControlByte() {
    // Ctrl-C(0x03) / Ctrl-D(0x04) / Tab(0x09) 都可能出现在按键条里。
    assertEquals("\u0003", decode("\\x03"))
    assertEquals("\u0004", decode("\\x04"))
    assertEquals("\u0009", decode("\\x09"))
  }

  @Test
  fun tabAndBackslashEscapes() {
    assertEquals("a\tb", decode("a\\tb"))
    assertEquals("a\\b", decode("a\\\\b"))
  }

  @Test
  fun danglingBackslashIsKeptAsText() {
    // 半截转义不能把字符吞掉，否则用户输入的路径（如 C:\）会少一个字符。
    assertEquals("a\\", decode("a\\"))
  }

  @Test
  fun unknownEscapeDropsTheBackslashAndKeepsTheCharacter() {
    // 语义与 shell 一致：反斜杠是转义引导符，认不出就只保留被转义的字符本身。
    assertEquals("q", decode("\\q"))
    assertEquals("a.q", decode("a.\\q"))
  }

  @Test
  fun badHexFallsBackToTheEscapedCharacter() {
    // \xZZ 不是合法十六进制：退化成"转义 x"，于是剩下 ZZ 原样跟随。
    // 关键是**不静默删除用户输入**（路径里出现反斜杠时不能少字符）。
    assertEquals("xZZ", decode("\\xZZ"))
  }
}
