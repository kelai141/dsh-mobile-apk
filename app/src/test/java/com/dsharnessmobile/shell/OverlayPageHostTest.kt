package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 页面宿主回包的解析（design.md §6.2 N3/N4）。
 *
 * 为什么这些解析必须单独测：evaluateJavascript 的回包形态由页面「返回字符串还是对象」决定，
 * 解析错一次的表现是**静默降级**（会话/工作区/命令全部消失），在设备上极难归因；
 * 而它又是纯字符串处理，JVM 里可以一次钉死全部形态。
 */
class OverlayPageHostTest {

  @Test
  fun parsesQuotedJsonStringInExactlyOneLayer() {
    // 页面方法返回 JSON.stringify(...) 时，系统回包是「JSON 字符串字面量」。
    val raw = "\"{\\\"ok\\\":true,\\\"sessionId\\\":\\\"s-1\\\"}\""
    val obj = OverlayPageHost.parseHostReply(raw)
    assertEquals("s-1", obj?.optString("sessionId"))
  }

  @Test
  fun parsesBareObjectReply() {
    val obj = OverlayPageHost.parseHostReply("{\"ok\":true,\"sessionId\":\"s-2\"}")
    assertEquals("s-2", obj?.optString("sessionId"))
  }

  @Test
  fun nullReplyIsNull() {
    assertNull(OverlayPageHost.parseHostReply(null))
  }

  @Test
  fun literalNullIsNull() {
    assertNull(OverlayPageHost.parseHostReply("null"))
  }

  @Test
  fun emptyQuotedStringIsNull() {
    assertNull(OverlayPageHost.parseHostReply("\"\""))
  }

  @Test
  fun quotedLiteralNullStringIsNull() {
    assertNull(OverlayPageHost.parseHostReply("\"null\""))
  }

  @Test
  fun garbageIsNullNotThrow() {
    assertNull(OverlayPageHost.parseHostReply("not-json"))
  }

  @Test
  fun numberReplyIsNull() {
    assertNull(OverlayPageHost.parseHostReply("42"))
  }

  @Test
  fun stateRequiresOkTrue() {
    assertNull(OverlayPageHost.parseState(OverlayPageHost.parseHostReply("{\"ok\":false}")))
  }

  @Test
  fun stateParsesCoreFields() {
    val state = OverlayPageHost.parseState(
      OverlayPageHost.parseHostReply(
        "{\"ok\":true,\"sessionId\":\"s1\",\"sessionTitle\":\"T\",\"workspaceId\":\"w1\"," +
          "\"workspaceName\":\"W\",\"busy\":true,\"draft\":\"hi\"}",
      ),
    )
    assertEquals("s1", state?.sessionId)
    assertEquals("T", state?.sessionTitle)
    assertEquals("w1", state?.workspaceId)
    assertEquals("W", state?.workspaceName)
    assertTrue(state?.busy == true)
    assertEquals("hi", state?.draft)
  }

  @Test
  fun stateMissingFieldsStayEmptyAndAreNotGuessed() {
    val state = OverlayPageHost.parseState(OverlayPageHost.parseHostReply("{\"ok\":true}"))
    assertEquals("", state?.sessionId)
    assertEquals("", state?.workspaceId)
    assertEquals(emptyList<OverlayPageHost.PageWorkspace>(), state?.workspaces)
    assertEquals(emptyList<OverlayPageHost.PageAttachment>(), state?.attachments)
  }

  @Test
  fun stateParsesWorkspacesAndAttachments() {
    val state = OverlayPageHost.parseState(
      OverlayPageHost.parseHostReply(
        "{\"ok\":true,\"workspaces\":[{\"id\":\"w1\",\"title\":\"A\"},{\"id\":\"w2\"}]," +
          "\"attachments\":[{\"name\":\"p.jpg\",\"kind\":\"image\"},{\"kind\":\"file\"}]}",
      ),
    )
    assertEquals(2, state?.workspaces?.size)
    assertEquals("A", state?.workspaces?.get(0)?.title)
    // title 缺失用 id 兜底（页面给了 id 却不给标题时不该出现空行）
    assertEquals("w2", state?.workspaces?.get(1)?.title)
    // 没有名字的附件条目必须丢弃（渲染成空 chip 等于骗用户）
    assertEquals(1, state?.attachments?.size)
    assertEquals("image", state?.attachments?.get(0)?.kind)
  }

  @Test
  fun commandsParseOrderAndLabelFallback() {
    val list = OverlayPageHost.parseCommands(
      OverlayPageHost.parseHostReply(
        "{\"ok\":true,\"items\":[{\"name\":\"/model\",\"label\":\"Model\",\"description\":\"d\"}," +
          "{\"name\":\"/help\"},{\"label\":\"no-name\"}]}",
      ),
    )
    assertEquals(2, list.size)
    assertEquals("/model", list[0].name)
    assertEquals("Model", list[0].label)
    // label 缺失用 name 兜底
    assertEquals("/help", list[1].label)
  }

  @Test
  fun commandsEmptyWhenNotOk() {
    assertEquals(
      emptyList<OverlayPageHost.PageCommand>(),
      OverlayPageHost.parseCommands(OverlayPageHost.parseHostReply("{\"ok\":false,\"items\":[{\"name\":\"x\"}]}")),
    )
  }

  @Test
  fun sessionsSkipEntriesWithoutId() {
    val list = OverlayPageHost.parseSessions(
      OverlayPageHost.parseHostReply(
        "{\"ok\":true,\"items\":[{\"id\":\"s1\",\"title\":\"A\"},{\"title\":\"no-id\"}]}",
      ),
    )
    assertEquals(1, list.size)
    assertEquals("s1", list[0].id)
  }

  @Test
  fun stateCarriesStableAttachmentIdentityAndExplicitAgentAssociation() {
    val state = OverlayPageHost.parseState(OverlayPageHost.parseHostReply("""{"ok":true,"sessionId":"s","agentId":"a","attachments":[{"id":"file-9","name":"x","kind":"file"}]}"""))
    assertEquals("a", state?.agentId)
    assertEquals("file-9", state?.attachments?.single()?.id)
    assertEquals("", OverlayPageHost.parseState(OverlayPageHost.parseHostReply("""{"ok":true,"sessionId":"s"}"""))?.agentId)
  }

  @Test
  fun workspaceReadinessIsExplicitAndLegacyMissingFlagIsNotReady() {
    assertFalse(OverlayPageHost.parseState(OverlayPageHost.parseHostReply("""{"ok":true}"""))!!.workspacesReady)
    val ready = OverlayPageHost.parseState(OverlayPageHost.parseHostReply("""{"ok":true,"workspacesReady":true,"workspacesError":""}"""))!!
    assertTrue(ready.workspacesReady)
    val failed = OverlayPageHost.parseState(OverlayPageHost.parseHostReply("""{"ok":true,"workspacesReady":false,"workspacesError":"workspaces-error"}"""))!!
    assertEquals("workspaces-error", failed.workspacesError)
  }

  @Test
  fun pendingOperationIsNotSuccessfulAdmission() {
    assertFalse(OverlayPageHost.parseOk(OverlayPageHost.parseHostReply("""{"pending":true,"operationId":"x"}""")))
  }

  private fun transcript(vararg rows: org.json.JSONObject): List<OverlayTranscriptRow> {
    val array = org.json.JSONArray()
    rows.forEach { array.put(it) }
    return OverlayPageHost.parseState(org.json.JSONObject().put("ok", true).put("transcript", array))!!.transcript
  }

  private fun row(id: String, role: String, text: String = ""): org.json.JSONObject =
    org.json.JSONObject().put("id", id).put("role", role).put("text", text)

  @Test
  fun transcriptParsesNamedToolsWithLiteralArgumentsResultsAndExplicitState() {
    val rows = transcript(
      row("u", "user", "literal **question**"),
      row("a", "assistant", "# Answer\nMore text"),
      row("call-1", "tool", "must not become prose").put("toolName", "functions.read")
        .put("arguments", "{bad JSON stays literal}").put("result", "<script>literal result</script>").put("state", "failed"),
    )
    assertEquals(listOf("user", "assistant", "tool"), rows.map { it.role })
    assertEquals("# Answer\nMore text", rows[1].text)
    assertEquals("", rows[2].text)
    assertEquals("functions.read", rows[2].toolName)
    assertEquals("{bad JSON stays literal}", rows[2].arguments)
    assertEquals("<script>literal result</script>", rows[2].result)
    assertEquals(OverlayToolRowState.FAILED, rows[2].state)
    assertFalse(rows[2].truncated)
    assertEquals(OverlayToolRowState.RUNNING, transcript(row("c", "tool").put("toolName", "read").put("state", "running"))[0].state)
    assertEquals(OverlayToolRowState.DONE, transcript(row("c", "tool").put("toolName", "read").put("state", "done"))[0].state)
    assertNull(transcript(row("c", "tool").put("toolName", "read").put("state", "unknown"))[0].state)
  }

  @Test
  fun transcriptNeverCoercesObjectsUnknownRolesOrToolFieldsOntoAssistantText() {
    val rows = transcript(
      row("system", "system", "private"), row("thought", "reasoning", "private"),
      row("unnamed", "tool").put("toolName", 123),
      row("numeric-role", "assistant").put("role", 123),
      row("numeric-id", "assistant").put("id", 123),
      row("tool", "tool").put("toolName", "read").put("arguments", org.json.JSONObject().put("secret", "object"))
        .put("result", org.json.JSONArray().put("array")).put("state", true),
      row("assistant", "assistant").put("text", org.json.JSONObject().put("private", "not text"))
        .put("toolName", "not a tool").put("arguments", "not assistant").put("state", "done"),
    )
    assertEquals(listOf("tool", "assistant"), rows.map { it.id })
    assertEquals("", rows[0].arguments)
    assertEquals("", rows[0].result)
    assertNull(rows[0].state)
    assertEquals("", rows[1].text)
    assertEquals("", rows[1].toolName)
    assertEquals("", rows[1].arguments)
    assertNull(rows[1].state)
  }

  @Test
  fun transcriptBoundsUnicodeToolPayloadsAndWholeSerializedUtf8IncludingIdentityAndEscaping() {
    val huge = "界😀\u0000".repeat(5000)
    val rows = transcript(
      *Array(20) { index -> row("tool-$index", "tool").put("toolName", "read").put("arguments", huge).put("result", huge).put("state", "done") },
      row("latest", "assistant", "latest true output"),
    )
    assertTrue(rows.isNotEmpty())
    assertTrue(OverlayPageHost.transcriptJson(rows).toByteArray(Charsets.UTF_8).size <= 24576)
    assertEquals("latest", rows.last().id)
    assertTrue(rows.first().truncated)
    rows.filter { it.role == "tool" }.forEach {
      assertTrue(it.arguments.codePointCount(0, it.arguments.length) <= 1600)
      assertTrue(it.result.codePointCount(0, it.result.length) <= 1600)
      assertFalse(it.arguments.lastOrNull()?.isHighSurrogate() == true)
      assertTrue(it.truncated)
    }
    val escaped = transcript(row("s".repeat(800), "assistant", "\u0000".repeat(4000)))
    assertEquals(1, escaped.size)
    assertTrue(escaped[0].truncated)
    assertTrue(OverlayPageHost.transcriptJson(escaped).toByteArray(Charsets.UTF_8).size <= 24576)
  }

  @Test
  fun transcriptKeepsLatestFortyAndLatestDuplicateIdentityWithExplicitTruncation() {
    val rows = transcript(*Array(60) { row("a-$it", "assistant", "answer-$it") })
    assertEquals(40, rows.size)
    assertEquals("a-20", rows.first().id)
    assertEquals("a-59", rows.last().id)
    assertTrue(rows.first().truncated)
    val duplicates = transcript(row("a", "assistant", "old"), row("a", "assistant", "new"))
    assertEquals(listOf(OverlayTranscriptRow("a", "assistant", "new")), duplicates)
    val tool = OverlayTranscriptRow("tool", "tool", "", "read", "{}", "actual", OverlayToolRowState.DONE)
    val plan = overlayTranscriptMergePlan(emptyList(), listOf(tool, tool.copy(id = "bad", toolName = ""), tool.copy(id = "system", role = "system")))
    assertEquals(listOf(tool), plan.rows)
  }

  @Test
  fun okFlagOnlyTrueWhenExplicitlyTrue() {
    assertTrue(OverlayPageHost.parseOk(OverlayPageHost.parseHostReply("{\"ok\":true}")))
    assertFalse(OverlayPageHost.parseOk(OverlayPageHost.parseHostReply("{\"ok\":false}")))
    assertFalse(OverlayPageHost.parseOk(null))
  }
}
