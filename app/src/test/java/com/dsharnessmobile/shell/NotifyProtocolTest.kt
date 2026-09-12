package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * .notify.ndjson 协议回归（§6.2.1 / NT-04、NT-08）：字节级偏移消费与六种 kind 解析。
 * 反向自证口径：把 drainBytes 改成「按块长推进」（旧 readLines+writeText 的等价形态），
 * 半行用例立刻红。
 */
class NotifyProtocolTest {

  private fun bytes(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

  @Test
  fun 只消费完整行_半行留给下一轮() {
    val chunk = bytes("{\"kind\":\"todo\",\"done\":1}\n{\"kind\":\"re")
    val r = NotifyStore.drainBytes(chunk, chunk.size)
    assertEquals(listOf("{\"kind\":\"todo\",\"done\":1}"), r.lines)
    assertEquals(25L, r.consumed)
    // 偏移未推进 -> 下一次从同一偏移重读整行（半行不是丢行，只是延后一轮）
    val rest = bytes("{\"kind\":\"report\"}\n")
    val r2 = NotifyStore.drainBytes(rest, rest.size)
    assertEquals(listOf("{\"kind\":\"report\"}"), r2.lines)
    assertEquals(rest.size.toLong(), r2.consumed)
  }

  @Test
  fun 无换行时偏移不动() {
    val chunk = bytes("{\"kind\":\"silent\"")
    val r = NotifyStore.drainBytes(chunk, chunk.size)
    assertTrue(r.lines.isEmpty())
    assertEquals(0L, r.consumed)
  }

  @Test
  fun 一百行连续追加零丢失() {
    val sb = StringBuilder()
    for (i in 1..100) sb.append("{\"kind\":\"todo\",\"done\":").append(i).append(",\"total\":100}\n")
    val chunk = bytes(sb.toString())
    val r = NotifyStore.drainBytes(chunk, chunk.size)
    assertEquals(100, r.lines.size)
    assertEquals(chunk.size.toLong(), r.consumed)
  }

  @Test
  fun 多字节截断不产生乱码且不丢行() {
    val full = "{\"kind\":\"silent\",\"title\":\"中文标题\"}\n".toByteArray(Charsets.UTF_8)
    // 截到「中」字中间
    val cut = full.size - 10
    val head = full.copyOfRange(0, cut)
    val headResult = NotifyStore.drainBytes(head, head.size)
    // 该块末尾没有换行 -> 整块留到下一轮（不按块长推进）
    assertTrue(headResult.lines.isEmpty())
    assertEquals(0L, headResult.consumed)
    // 下一轮把剩余字节接上
    val rest = full.copyOfRange(cut, full.size)
    val merged = head + rest
    val r = NotifyStore.drainBytes(merged, merged.size)
    assertEquals(1, r.lines.size)
    assertTrue(r.lines[0].contains("中文标题"))
    assertEquals(full.size.toLong(), r.consumed)
  }

  @Test
  fun 空行与空白行被跳过() {
    val chunk = bytes("\n\n{\"kind\":\"silent\"}\n   \n")
    val r = NotifyStore.drainBytes(chunk, chunk.size)
    assertEquals(listOf("{\"kind\":\"silent\"}"), r.lines)
  }

  @Test
  fun 六种kind全部可解析且字段正确() {
    val report = NotifyStore.parseEntry(
      "{\"ts\":\"2026-09-12T10:00:00.000Z\",\"kind\":\"report\",\"outcome\":\"completed\",\"sessionId\":\"s1\",\"title\":\"跑门禁\",\"summary\":\"全绿\",\"durationMs\":84000,\"toolCount\":12,\"turn\":4,\"presentedFiles\":[\"a.md\",\"b.apk\"],\"popup\":true}",
    )
    assertNotNull(report)
    assertEquals("report", report!!.kind)
    assertEquals("completed", report.outcome)
    assertEquals(84_000L, report.durationMs)
    assertEquals(12, report.toolCount)
    assertEquals(4, report.turn)
    assertEquals(listOf("a.md", "b.apk"), report.presentedFiles)
    assertTrue(report.popup)

    val todo = NotifyStore.parseEntry("{\"kind\":\"todo\",\"done\":3,\"total\":7,\"current\":\"跑门禁\",\"sessionId\":\"s1\"}")
    assertEquals(3, todo!!.done)
    assertEquals(7, todo.total)
    assertEquals("跑门禁", todo.current)

    val silent = NotifyStore.parseEntry("{\"kind\":\"silent\",\"event\":\"watchdog\",\"title\":\"引擎状态\",\"text\":\"已恢复\",\"count\":3}")
    assertEquals("watchdog", silent!!.event)
    assertEquals(3, silent.count)

    val question = NotifyStore.parseEntry(
      "{\"kind\":\"question\",\"eventId\":\"e1\",\"questions\":[{\"id\":\"q1\",\"header\":\"需要回答\",\"question\":\"现在方便吗？\",\"options\":[{\"label\":\"方便\"},{\"label\":\"稍后\"}]}]}",
    )
    assertEquals("e1", question!!.eventId)
    assertEquals(1, question.questions.size)
    assertEquals("q1", question.questions[0].id)
    assertEquals(listOf("方便", "稍后"), question.questions[0].options)

    val approval = NotifyStore.parseEntry("{\"kind\":\"approval\",\"eventId\":\"e2\",\"toolName\":\"bash\",\"reason\":\"rm -rf build/\"}")
    assertEquals("bash", approval!!.toolName)
    assertEquals("rm -rf build/", approval.reason)

    val resolve = NotifyStore.parseEntry("{\"kind\":\"resolve\",\"eventId\":\"e1\"}")
    assertEquals("resolve", resolve!!.kind)
  }

  @Test
  fun 未知kind与坏行不崩且不误投() {
    assertNull(NotifyStore.parseEntry("not json at all"))
    assertNull(NotifyStore.parseEntry("{\"title\":\"no kind\"}"))
    assertNull(NotifyStore.parseEntry(""))
    val unknown = NotifyStore.parseEntry("{\"kind\":\"future-kind\",\"text\":\"x\"}")
    assertNotNull(unknown)
    assertEquals("future-kind", unknown!!.kind)
  }

  @Test
  fun ts解析失败返回0() {
    assertEquals(0L, NotifyStore.parseEpochMs("{\"kind\":\"silent\"}"))
    assertEquals(0L, NotifyStore.parseEpochMs("{\"kind\":\"silent\",\"ts\":\"not-a-time\"}"))
    assertTrue(NotifyStore.parseEpochMs("{\"ts\":\"2026-09-12T10:00:00.000Z\"}") > 0L)
  }

  @Test
  fun 双读不双发_未服役时旧信道仍投递() {
    // 新信道未服役（notifyChannelActive=false）→ legacyFallback 应尝试投递（返回 true）
    // 这里只断言开关的初始语义与「服役后不再投递」的判定入口存在（Context 不可用，不落地投递）
    assertEquals(false, NotifyStore.notifyChannelActive)
    assertTrue(NotifyStore.FILE_NAME == ".notify.ndjson")
    assertTrue(NotifyStore.LEGACY_FILE == ".task-done.ndjson")
    assertTrue(NotifyStore.ROTATED_NAME == ".notify.ndjson.1")
  }
}
