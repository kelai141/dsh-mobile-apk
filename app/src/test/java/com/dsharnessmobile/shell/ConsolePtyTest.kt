package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 控制台 PTY 的判据。
 *
 * 每一组都对应设备实测过的具体失败形态：
 *   - 尺寸为 0 时 TUI 按 0 行 0 列排版，界面上是空白或错位；
 *   - JSON 帧不加转义时，输出里的引号/换行会把整帧截断，页面收到的是半句话；
 *   - 中继协议不认识的消息必须当没看见，而不是把原始 JSON 当终端输出上屏。
 */
class ConsolePtyTest {

  @Test
  fun argvRunsTheRelayThroughTheSnapshotNode() {
    val node = File("node")
    val relay = File("relay.mjs")
    val a = ConsolePty.argv(node, relay)
    assertEquals(2, a.size)
    assertEquals("第一个参数必须是 node", node.absolutePath, a[0])
    assertEquals("第二个参数必须是中继脚本", relay.absolutePath, a[1])
  }

  @Test
  fun zeroSizeFromThePageFallsBackToTheStandardGrid() {
    // 首帧布局未完成时页面会测出 0，直接下发就是 0x0 的 PTY。
    val (cols, rows) = ConsolePty.normalizeSize(0, 0)
    assertEquals(ConsolePty.DEFAULT_COLS, cols)
    assertEquals(ConsolePty.DEFAULT_ROWS, rows)
  }

  @Test
  fun negativeSizeAlsoFallsBack() {
    val (cols, rows) = ConsolePty.normalizeSize(-100, -7)
    assertEquals(ConsolePty.DEFAULT_COLS, cols)
    assertEquals(ConsolePty.DEFAULT_ROWS, rows)
  }

  @Test
  fun usableSizeIsKeptAsIs() {
    // 常见手机竖屏实测约 37 行 76 列，这类值不能被兜底改写。
    val (cols, rows) = ConsolePty.normalizeSize(76, 37)
    assertEquals(76, cols)
    assertEquals(37, rows)
  }

  @Test
  fun tinyButPositiveSizeIsSnappedUpToTheFloor() {
    val (cols, rows) = ConsolePty.normalizeSize(10, 3)
    assertEquals(ConsolePty.DEFAULT_COLS, cols)
    assertEquals(ConsolePty.DEFAULT_ROWS, rows)
  }

  @Test
  fun writeMessageEscapesSoOneFrameStaysOneLine() {
    // 帧边界是换行：内容里一旦有裸换行，壳侧就会把一帧切成两半。
    val msg = ConsolePty.writeMessage("a\nb\rc")
    assertTrue("帧里不能有裸换行", !msg.trimEnd('\n').contains('\n'))
    assertTrue("换行必须被转义", msg.contains("\\n"))
    assertTrue("回车必须被转义", msg.contains("\\r"))
  }

  @Test
  fun writeMessageEscapesQuotesAndBackslashes() {
    val msg = ConsolePty.writeMessage("say \"hi\" \\ ok")
    assertTrue("引号必须转义，否则 JSON 结构被破坏", msg.contains("\\\""))
    assertTrue("反斜杠必须转义", msg.contains("\\\\"))
  }

  @Test
  fun controlCharactersAreEscapedAsUnicode() {
    // ESC 是终端控制序列的引导符，原样塞进 JSON 会让解析方拿到不可见字符。
    val msg = ConsolePty.writeMessage("\u001b[31m")
    assertTrue("ESC 必须转成 \\u001b", msg.contains("\\u001b"))
  }

  @Test
  fun dataOfDecodesAnEscapedPayload() {
    val payload = "line1\nline2\ttab \"q\" \u001b[0m"
    val line = "{\"op\":\"data\",\"data\":" + ConsolePty.quote(payload) + "}"
    assertEquals("解码必须还原原文", payload, ConsolePty.dataOf(line))
  }

  @Test
  fun dataOfIgnoresNonDataMessages() {
    // 中继的 ready/exit/error 是控制帧，不能被当终端输出上屏。
    assertNull(ConsolePty.dataOf("{\"op\":\"ready\",\"pid\":123}"))
    assertNull(ConsolePty.dataOf("{\"op\":\"exit\",\"code\":0}"))
    assertNull(ConsolePty.dataOf("not json at all"))
  }

  @Test
  fun numberFieldOfReadsExitCode() {
    assertEquals(7, ConsolePty.numberFieldOf("{\"op\":\"exit\",\"code\":7}", "code"))
    assertEquals(-1, ConsolePty.numberFieldOf("{\"op\":\"exit\",\"code\":-1}", "code"))
    assertNull(ConsolePty.numberFieldOf("{\"op\":\"ready\"}", "code"))
  }

  @Test
  fun resizeMessageCarriesBothDimensions() {
    val msg = ConsolePty.resizeMessage(100, 30)
    assertTrue(msg.contains("\"op\":\"resize\""))
    assertTrue(msg.contains("\"cols\":100"))
    assertTrue(msg.contains("\"rows\":30"))
  }
}
