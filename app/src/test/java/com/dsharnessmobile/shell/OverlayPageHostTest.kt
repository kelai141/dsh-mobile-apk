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
  fun okFlagOnlyTrueWhenExplicitlyTrue() {
    assertTrue(OverlayPageHost.parseOk(OverlayPageHost.parseHostReply("{\"ok\":true}")))
    assertFalse(OverlayPageHost.parseOk(OverlayPageHost.parseHostReply("{\"ok\":false}")))
    assertFalse(OverlayPageHost.parseOk(null))
  }
}
