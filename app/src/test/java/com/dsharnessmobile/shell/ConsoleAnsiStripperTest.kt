package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 控制台输出剥离器的判据。
 *
 * 为什么这些用例必须存在：一旦给子进程注入 TERM/TERMINFO，dialog 与 top 就会开始吐控制序列，
 * 而页面是纯文本容器——剥不干净就是满屏转义乱码。反过来剥过头会把正文一起吃掉，
 * 那等于「程序说了话但用户看不见」，同样不可接受。
 */
class ConsoleAnsiStripperTest {

  @Test
  fun sgrSequenceIsStrippedAndTextSurvives() {
    val s = ConsoleAnsiStripper()
    assertEquals("AB", s.feed("\u001b[31mA\u001b[0mB"))
  }

  @Test
  fun oscTerminatedByBellIsDroppedWhole() {
    val s = ConsoleAnsiStripper()
    assertEquals("hello", s.feed("\u001b]0;title\u0007hello"))
  }

  @Test
  fun oscTerminatedByStIsDroppedWholeOtherwiseItEatsTheRest() {
    val s = ConsoleAnsiStripper()
    assertEquals("hello", s.feed("\u001b]0;title\u001b\\hello"))
  }

  @Test
  fun sequenceSplitAcrossChunksIsStillStripped() {
    val s = ConsoleAnsiStripper()
    assertEquals("", s.feed("\u001b[3"))
    assertEquals("", s.feed("8m"))
    assertEquals("X", s.feed("X"))
  }

  @Test
  fun charsetSelectionAfterEscDoesNotSwallowText() {
    val s = ConsoleAnsiStripper()
    assertEquals("ok", s.feed("\u001b(Bok"))
  }

  @Test
  fun carriageReturnBecomesNewlineToKeepLineByLineOutput() {
    val s = ConsoleAnsiStripper()
    assertEquals("a\nb", s.feed("a\rb"))
  }

  @Test
  fun bellAndOtherC0AreDroppedButNewlineAndTabSurvive() {
    val s = ConsoleAnsiStripper()
    assertEquals("a\tb\nc", s.feed("\u0007a\tb\u0000\nc"))
  }

  @Test
  fun resetDropsAHalfSequenceSoItCannotLeakIntoTheNextSession() {
    val s = ConsoleAnsiStripper()
    s.feed("\u001b[3")
    s.reset()
    assertEquals("8m", s.feed("8m"))
  }

  @Test
  fun realDialogFragmentLeavesOnlyReadableText() {
    val s = ConsoleAnsiStripper()
    val raw = "\u001b[?1049h\u001b[22;0;0t\u001b[1;24r\u001b(B\u001b[m\u001b[4l\u001b[?7h" +
      "\u001b[H\u001b[2Jtermux-change-repo"
    assertEquals("termux-change-repo", s.feed(raw))
  }
}