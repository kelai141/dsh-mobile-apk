package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FX-212.3 回归：.task-done.ndjson 消费从 readLines() + writeText("") 改为按字节偏移推进。
 *
 * 三态缺陷各由一条断言锁死：
 *  ① 读-清之间追加的行被整段吞掉（永久丢失）→ 「追加行在下一拍消费」；
 *  ② writeText("") 是截断语义、崩溃中途会重复投递 → 源码契约禁止 writeText("");
 *  ③ readLines() 无界 → CAP 只吃整行 + 半行不推进。
 */
class WatchdogMarkerConsumeTest {

  private fun bytes(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }.filter { it >= 0 }.minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  private fun source(): String {
    val f = listOf(
      File("src/main/java/com/dsharnessmobile/shell/WatchdogV2.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/WatchdogV2.kt"),
    ).firstOrNull { it.isFile } ?: throw AssertionError("找不到 WatchdogV2.kt（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 生产消费循环的忠实模型：CAP 有界读 + 只推进整行 + len < offset 归零。 */
  private fun consumeAll(payload: ByteArray, cap: Int): Pair<List<String>, Long> {
    val out = ArrayList<String>()
    var offset = 0L
    while (offset < payload.size) {
      val len = payload.size.toLong()
      if (len < offset) offset = 0L
      val want = (len - offset).coerceAtMost(cap.toLong()).toInt()
      if (want <= 0) break
      val buf = payload.copyOfRange(offset.toInt(), (offset + want).coerceAtMost(len).toInt())
      val w = WatchdogV2.markerConsumeWindow(buf, buf.size)
      if (w.advance == 0L) break
      out.addAll(w.lines)
      offset += w.advance
    }
    return out to offset
  }

  private fun linesPayload(count: Int, prefix: String = "line"): ByteArray {
    val sb = StringBuilder()
    for (i in 1..count) sb.append("{\"sessionId\":\"").append(prefix).append("\",\"n\":").append(i).append("}\n")
    return bytes(sb.toString())
  }

  @Test
  fun 每行恰好消费一次_零丢失零重复() {
    val payload = linesPayload(100)
    val (lines, offset) = consumeAll(payload, 4096)
    assertEquals(100, lines.size)
    assertEquals(payload.size.toLong(), offset)
    assertEquals("行内容不得重复", 100, lines.toSet().size)
    assertTrue(lines.first().contains("\"n\":1"))
    assertTrue(lines.last().contains("\"n\":100"))
  }

  @Test
  fun CAP只吃整行_切在半行处不推进超额() {
    val payload = linesPayload(50)
    val lineBytes = bytes("{\"sessionId\":\"line\",\"n\":1}\n").size
    // 故意让 CAP 切在某一行的中间（4 整行 + 3 字节）
    val cap = lineBytes * 4 + 3
    val w = WatchdogV2.markerConsumeWindow(payload.copyOfRange(0, cap), cap)
    assertTrue("CAP 内有整行", w.lines.isNotEmpty())
    assertTrue("推进量必须落在换行符之后", w.advance <= cap.toLong())
    assertTrue("推进量必须小于 CAP（切在半行）", w.advance < cap.toLong())
    assertEquals("只吃整行：推进量恰为整数行", (lineBytes * 4).toLong(), w.advance)
    // 整体仍零丢失：分多拍消费
    val (all, offset) = consumeAll(payload, cap)
    assertEquals(50, all.size)
    assertEquals(payload.size.toLong(), offset)
    assertEquals(50, all.toSet().size)
  }

  @Test
  fun 半行不推进偏移() {
    val payload = bytes("{\"sessionId\":\"a\",\"n\":1}\n{\"sessionId\":\"b\"")
    val first = WatchdogV2.markerConsumeWindow(payload, payload.size)
    assertEquals(1, first.lines.size)
    assertEquals(bytes("{\"sessionId\":\"a\",\"n\":1}\n").size.toLong(), first.advance)
    // 下一拍从 offset=25 续读剩余半行 + 补齐
    val rest = bytes(",\"n\":2}\n")
    val second = WatchdogV2.markerConsumeWindow(rest, rest.size)
    assertEquals(1, second.lines.size)
    assertTrue(second.lines[0].contains("\"n\":2"))
  }

  @Test
  fun 无换行时完全不推进() {
    val payload = bytes("{\"sessionId\":\"half\"")
    val w = WatchdogV2.markerConsumeWindow(payload, payload.size)
    assertTrue(w.lines.isEmpty())
    assertEquals(0L, w.advance)
  }

  @Test
  fun 多字节截断不产生乱码且不丢行() {
    val full = bytes("{\"title\":\"中文标题\",\"n\":1}\n")
    val cut = full.size - 6
    val head = full.copyOfRange(0, cut)
    val headW = WatchdogV2.markerConsumeWindow(head, head.size)
    assertEquals("末尾无换行 -> 整块留到下一轮", 0L, headW.advance)
    val merged = head + full.copyOfRange(cut, full.size)
    val w = WatchdogV2.markerConsumeWindow(merged, merged.size)
    assertEquals(1, w.lines.size)
    assertTrue(w.lines[0].contains("中文标题"))
    assertEquals(full.size.toLong(), w.advance)
  }

  @Test
  fun 追加行在下一拍消费_零丢失零重复() {
    val first = linesPayload(3)
    val (lines1, offset1) = consumeAll(first, 4096)
    assertEquals(3, lines1.size)
    // 生产者继续追加（模拟长 turn 连续多条 task-done）
    val grown = first + linesPayload(4, prefix = "more")
    val delta = grown.copyOfRange(offset1.toInt(), grown.size)
    val w = WatchdogV2.markerConsumeWindow(delta, delta.size)
    assertEquals(4, w.lines.size)
    assertEquals(delta.size.toLong(), w.advance)
    assertTrue(w.lines.all { it.contains("more") })
    // 再拍无事可做
    assertEquals(0L, WatchdogV2.markerConsumeWindow(bytes(""), 0).advance)
  }

  @Test
  fun 空行被跳过但计入推进() {
    val payload = bytes("\n\n{\"n\":1}\n\n")
    val w = WatchdogV2.markerConsumeWindow(payload, payload.size)
    assertEquals(1, w.lines.size)
    assertEquals(payload.size.toLong(), w.advance)
  }

  // ── 源码契约（FX-212.3 判据）：撤掉修复即变红 ────────────────────────────

  @Test
  fun 消费函数不得再用readLines或截断文件() {
    val body = codeOnly(memberBody(source(), "internal fun consumeTaskDoneMarkers("))
    assertFalse("不得再 readLines()（无界读）", body.contains("readLines()"))
    assertFalse("不得再 writeText(\"\")（截断清零窗口）", body.contains("writeText(\"\")"))
    assertTrue("必须有界读", body.contains("RandomAccessFile("))
    assertTrue("必须走纯函数窗口", body.contains("markerConsumeWindow("))
    assertTrue("必须按偏移推进", body.contains("markerOffsetTo(context, offset + window.advance)"))
    assertTrue("必须有 CAP", body.contains("markerReadCapBytes"))
    assertTrue("len < offset 必须归零", body.contains("if (len < offset)"))
  }

  @Test
  fun 偏移必须跨重启存活且推进入口唯一() {
    val code = codeOnly(source())
    assertTrue("偏移字段必须 @Volatile", code.contains("@Volatile") && code.contains("private var markerOffset"))
    assertTrue("偏移必须落 prefs（重启不重放历史标记）", code.contains("KEY_MARKER_OFFSET"))
    assertTrue("偏移写入必须经唯一入口", code.contains("private fun markerOffsetTo(context: Context, value: Long)"))
    assertTrue("半行不推进：只有 advance>0 才写偏移", code.contains("if (window.advance > 0) markerOffsetTo("))
  }

  @Test
  fun 调试日志必须能对账消费量() {
    val body = codeOnly(memberBody(source(), "internal fun consumeTaskDoneMarkers("))
    assertTrue("必须打 consumedBytes", body.contains("consumedBytes="))
    assertTrue("必须打 newOffset", body.contains("newOffset="))
    assertTrue("必须打 len/offset", body.contains("len=") && body.contains("offset="))
  }
}
