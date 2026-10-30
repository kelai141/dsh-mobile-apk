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

  /** I5（2026-10-25 审计）：真 PTY 的 ONLCR 让每个换行都以 CRLF 输出——必须折叠成单个换行，否则整屏双倍行距。 */
  @Test
  fun crlfCollapsesToSingleNewline() {
    val stripper = ConsoleAnsiStripper()
    assertEquals("a" + nl + "b" + nl, stripper.feed("a" + crlf + "b" + crlf))
  }

  /** I5：CR 与 LF 跨块送达（读缓冲边界形态）同样只折一次。
   *  块尾悬 CR 不产出（等下一字符定折叠）——流式语义的必然代价，控制台是长连接不受影响。 */
  @Test
  fun crlfAcrossChunksCollapsesToSingleNewline() {
    val stripper = ConsoleAnsiStripper()
    assertEquals("a", stripper.feed("a" + cr))
    assertEquals(nl + "b", stripper.feed(nl + "b"))
  }

  /** I5：CR 后不是 LF——CR 折行，后续字符按正文语义重新分发（ESC 引导不被吞）。 */
  @Test
  fun bareCrStillFoldsAndRedistributesEscape() {
    val stripper = ConsoleAnsiStripper()
    assertEquals("a" + nl + "x", stripper.feed("a" + cr + "" + esc + "[1m" + "x"))
  }

  private val nl = Char(10).toString()
  private val cr = Char(13).toString()
  private val crlf = cr + nl
  private val esc = Char(27).toString()

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

  @Test
  fun delAndC1ControlsNeverReachTheScreen() {
    // DEL（0x7F）与 C1（0x80–0x9F）都不是可见字符；旧实现只判 `ch < ' '` ⇒ 两者原样上屏
    // （实测 `a\u007fb` → `[97, 127, 98]`，控制台里就是方块/空白）。
    assertEquals("DEL 必须丢弃", "ab", ConsoleAnsiStripper().feed("a\u007fb"))
    assertEquals("普通 C1 必须丢弃", "ab", ConsoleAnsiStripper().feed("a\u0085b"))
    // 反向：正文里的多字节字符与 tab/换行必须原样保留（修法不得把 CJK 一起吃掉）。
    assertEquals("CJK 与 tab 保留", "中\t文\n", ConsoleAnsiStripper().feed("中\t文\n"))
  }

  @Test
  fun eightBitCsiIsStrippedLikeItsSevenBitForm() {
    // `\u009b` 是 8 位形式的 CSI，真实终端会照常解析 ⇒ 必须按序列吃掉，不能当正文上屏。
    val eightBit = ConsoleAnsiStripper().feed("a\u009b1;31mb")
    assertEquals("8 位 CSI 必须被剥离", "ab", eightBit)
    val sevenBit = ConsoleAnsiStripper().feed("a\u001b[1;31mb")
    assertEquals("7 位形式的行为不得改变", "ab", sevenBit)
  }

  @Test
  fun repeatedCarriageReturnFoldsOnce() {
    // 真 PTY 偶尔出现 `\r\r\n`（重绘后清行）。旧实现每个 CR 都输出换行 ⇒ 凭空多一空行。
    assertEquals("连续 CR 只折一次", "x\ny", ConsoleAnsiStripper().feed("x\r\r\ny"))
    assertEquals("单个 CRLF 仍是单换行", "x\ny", ConsoleAnsiStripper().feed("x\r\ny"))
  }
}
