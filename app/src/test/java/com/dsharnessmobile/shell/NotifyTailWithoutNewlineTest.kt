package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1358：通知文件的尾行**没有换行**时不得让整条消费链停摆。
 *
 * 判据全部用**字节级夹具**（最后一行不带换行直接 EOF），并且要求
 * **两条连续帧都不带换行时都能出** —— 只验一条会漏掉「粘成一行、两条一起丢」那种形态。
 */
class NotifyTailWithoutNewlineTest {
  private fun bytes(s: String) = s.toByteArray(Charsets.UTF_8)

  private fun drain(s: String, atEof: Boolean = false): Pair<List<String>, Long> {
    val b = bytes(s)
    val r = NotifyStore.drainBytes(b, b.size, atEof = atEof)
    return r.lines to r.consumed
  }

  @Test fun twoConsecutiveFramesWithoutAnyNewlineBothComeOut() {
    // 上游把分隔符写在**下一条前面**时就是这种形态：两条记录粘在一起、全程无换行。
    val (lines, consumed) = drain("""{"a":1}{"b":2}""")
    assertEquals(listOf("""{"a":1}""", """{"b":2}"""), lines)
    assertEquals("必须消费到块尾", bytes("""{"a":1}{"b":2}""").size.toLong(), consumed)
  }

  @Test fun mixedFramesOneWithNewlineOneWithoutBothComeOut() {
    val text = "{\"a\":1}\n{\"b\":2}"
    val (lines, consumed) = drain(text)
    assertEquals(listOf("""{"a":1}""", """{"b":2}"""), lines)
    assertEquals(bytes(text).size.toLong(), consumed)
  }

  @Test fun halfFrameIsStillWaitedFor() {
    // 真正的半截帧（括号不闭合）**不宽容**：只消费到换行为止，尾部留给下次补齐。
    val text = "{\"a\":1}\n{\"b\":"
    val (lines, consumed) = drain(text)
    assertEquals(listOf("""{"a":1}"""), lines)
    assertEquals("只消费到第一个换行之后", 8L, consumed)
  }

  @Test fun atEofConsumesTheHalfFrameSoTheOffsetCanAdvance() {
    // 流/文件已结束：残行是「最后一条」，必须消费掉，否则偏移永远卡在这里、后续全丢。
    val text = "{\"a\":1}\n{\"b\":"
    val (lines, consumed) = drain(text, atEof = true)
    assertEquals(2, lines.size)
    assertEquals("必须消费到块尾", bytes(text).size.toLong(), consumed)
  }

  @Test fun bracesInsideStringValuesAreNotTreatedAsStructure() {
    // 字符串值里出现花括号/转义引号时，按裸花括号切会切错——这条钉住它不会。
    val text = """{"a":"}{"}"""
    val (lines, consumed) = drain(text)
    assertEquals(listOf(text), lines)
    assertEquals(bytes(text).size.toLong(), consumed)
  }

  @Test fun rotatedRemnantIsTreatedAsClosedStream() {
    // 接线（维护者要求 2）：轮转残段是**已封闭**文件，drainRotated 必须按 atEof 调用——
    // 否则它最后那一行（无换行）还是会被丢掉，只修主循环等于只修一半。
    var root: java.io.File? = java.io.File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !java.io.File(root, "app/src/main/java/com/dsharnessmobile/shell/NotifyStore.kt").isFile) {
      root = root.parentFile
    }
    requireNotNull(root) { "找不到仓库根" }
    val src = java.io.File(root!!, "app/src/main/java/com/dsharnessmobile/shell/NotifyStore.kt").readText()
    val start = src.indexOf("private fun drainRotated(")
    assertTrue("找不到 drainRotated", start >= 0)
    val block = src.substring(start, src.indexOf("private fun", start + 10).let { if (it < 0) src.length else it })
    assertTrue("drainRotated 必须按 atEof 消费残段：" + block.take(200), block.contains("atEof = true"))
  }

  @Test fun trailingNewlineStillProducesNoEmptyRecord() {
    val (lines, consumed) = drain("{\"a\":1}\n")
    assertEquals(listOf("""{"a":1}"""), lines)
    assertEquals(bytes("{\"a\":1}\n").size.toLong(), consumed)
    assertTrue("尾部换行不得产生空记录", lines.none { it.isEmpty() })
  }
}
