package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RepairToolCallParserTest {
  @Test
  fun convertsDsmlContentIntoBoundedToolCallsAndHidesMarkup() {
    val dsml = """
      我会先查看诊断。
      < | DSML | invoke name="read" >
      < | DSML | parameter name="path" string="true">files/diagnostics/error.log</ | DSML | parameter>
      < | DSML | parameter name="offset" string="false">12</ | DSML | parameter>
      </ | DSML | invoke>
    """.trimIndent()
    val calls = RepairToolCallParser.parseDsml(dsml)

    assertEquals(1, calls.length())
    val call = calls.getJSONObject(0)
    assertEquals("read", call.getJSONObject("function").getString("name"))
    val args = JSONObject(call.getJSONObject("function").getString("arguments"))
    assertEquals("files/diagnostics/error.log", args.getString("path"))
    assertEquals(12L, args.getLong("offset"))
    assertFalse(RepairToolCallParser.visibleText(dsml).contains("DSML"))
    assertTrue(RepairToolCallParser.visibleText(dsml).contains("我会先查看诊断"))
  }

  @Test
  fun standardToolCallsWinOverTextualFallback() {
    val message = JSONObject()
      .put("content", "< | DSML | invoke name=\"bash\"></ | DSML | invoke>")
      .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
        .put("function", JSONObject().put("name", "read").put("arguments", "{}"))))
    val normalized = RepairToolCallParser.normalize(message)

    assertEquals("call-1", normalized.getJSONArray("tool_calls").getJSONObject(0).getString("id"))
  }

  @Test
  fun openAiEnvelopeWrapsTheSharedToolSchema() {
    val wrapped = RepairToolCallParser.openAiTools(RepairToolSchemas.definitions())

    assertEquals("function", wrapped.getJSONObject(0).getString("type"))
    assertEquals("read", wrapped.getJSONObject(0).getJSONObject("function").getString("name"))
  }

  @Test
  fun textualDsmlCallsDoNotLeakSyntheticToolIdsIntoOutboundHistory() {
    val message = RepairToolCallParser.normalize(JSONObject().put(
      "role", "assistant",
    ).put("content", "< | DSML | invoke name=\"read\"></ | DSML | invoke>"))
    assertTrue(RepairToolCallParser.textualToolCalls(message))
    assertEquals(1, message.getJSONArray("tool_calls").length())

    val outboundHistory = RepairToolCallParser.outboundHistory(JSONArray().put(message))
    assertEquals(1, outboundHistory.length())
    assertEquals("", outboundHistory.getJSONObject(0).optString("content"))
    val projected = RepairToolCallParser.toolResultsAsUserObservations(JSONArray().put(message))
    assertEquals(0, projected.length())
  }

  @Test
  fun toolObservationsStayOutOfAssistantTextAndAreStable() {
    val history = JSONArray()
    history.put(JSONObject().put("role", "system").put("content", "system"))
    history.put(JSONObject().put("role", "user").put("content", "fix it"))
    history.put(JSONObject().put("role", "assistant").put("content", "reading")
      .put("reasoning_content", "look at logs")
      .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
        .put("function", JSONObject().put("name", "read").put("arguments", "{}")))
        .put(JSONObject().put("id", "call-2")
          .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))
    history.put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "content"))
    history.put(JSONObject().put("role", "tool").put("tool_call_id", "call-2").put("content", "entries"))
    history.put(JSONObject().put("role", "user").put("content", "continue"))

    val first = RepairToolCallParser.toolResultsAsUserObservations(history)
    val second = RepairToolCallParser.toolResultsAsUserObservations(history)
    assertEquals(first.toString(), second.toString())
    assertEquals(5, first.length())
    assertEquals("system", first.getJSONObject(0).getString("content"))
    assertEquals("fix it", first.getJSONObject(1).getString("content"))
    val assistant = first.getJSONObject(2)
    assertEquals("reading", assistant.getString("content"))
    assertEquals("look at logs", assistant.getString("reasoning_content"))
    assertFalse(assistant.has("tool_calls"))
    assertEquals("user", first.getJSONObject(3).getString("role"))
    assertTrue(first.getJSONObject(3).getString("content").contains("content"))
    assertTrue(first.getJSONObject(3).getString("content").contains("entries"))
    assertEquals("continue", first.getJSONObject(4).getString("content"))
    for (i in 0 until first.length()) {
      assertFalse(first.getJSONObject(i).optString("role") == "tool")
      assertFalse(first.getJSONObject(i).has("tool_call_id"))
      assertFalse(first.getJSONObject(i).has("tool_calls"))
    }
    assertEquals("reading", history.getJSONObject(2).getString("content"))
    assertTrue(history.getJSONObject(2).has("tool_calls"))
  }

  @Test
  fun d1ProjectionKeepsProviderCallsOutOfTheNextRequest() {
    val history = JSONArray()
      .put(JSONObject().put("role", "system").put("content", "system"))
      .put(JSONObject().put("role", "user").put("content", "fix it"))
      .put(JSONObject().put("role", "assistant").put("content", "reading")
        .put("reasoning_content", "stable reasoning")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
          .put("type", "function")
          .put("function", JSONObject().put("name", "read").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1")
        .put("content", "diagnostic output"))

    val projected = RepairToolCallParser.toolResultsAsUserObservations(history)

    assertFalse(projected.getJSONObject(2).has("tool_calls"))
    assertEquals("reading", projected.getJSONObject(2).getString("content"))
    assertEquals("stable reasoning", projected.getJSONObject(2).getString("reasoning_content"))
    assertEquals("user", projected.getJSONObject(3).getString("role"))
    assertEquals("tool", history.getJSONObject(3).getString("role"))
  }

  @Test
  fun missingProviderRoleIsRestoredWithoutRewritingTextOrReasoning() {
    val response = JSONObject()
      .put("content", "我先读取诊断文件。")
      .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
        .put("type", "function")
        .put("function", JSONObject().put("name", "read").put("arguments", "{}"))))

    val normalized = RepairToolCallParser.normalize(response)

    assertEquals("assistant", normalized.getString("role"))
    assertEquals("我先读取诊断文件。", normalized.getString("content"))
    assertEquals("call-1", normalized.getJSONArray("tool_calls")
      .getJSONObject(0).getString("id"))
  }

  @Test
  fun normalAssistantAnswerAndReasoningSurviveOutboundHistoryByteForByte() {
    val answer = JSONObject()
      .put("role", "assistant")
      .put("content", "检查完成。")
      .put("reasoning_content", "先核对当前事实。")

    val outbound = RepairToolCallParser.outboundHistory(JSONArray().put(answer))

    assertEquals(1, outbound.length())
    assertEquals("检查完成。", outbound.getJSONObject(0).getString("content"))
    assertEquals("先核对当前事实。", outbound.getJSONObject(0).getString("reasoning_content"))
    assertFalse(outbound.getJSONObject(0).has("tool_calls"))
  }

  @Test
  fun textualDsmlKeepsVisibleAssistantTextAfterSyntheticCallsAreRemoved() {
    val message = RepairToolCallParser.normalize(
      JSONObject()
        .put("role", "assistant")
        .put("content", "我先读取诊断。\n< | DSML | invoke name=\"read\" >< / | DSML | invoke >")
        .put("reasoning_content", "固定思考"),
    )

    val outbound = RepairToolCallParser.outboundHistory(JSONArray().put(message))

    assertEquals(1, outbound.length())
    assertEquals("我先读取诊断。", outbound.getJSONObject(0).getString("content"))
    assertEquals("固定思考", outbound.getJSONObject(0).getString("reasoning_content"))
    assertFalse(outbound.getJSONObject(0).has("tool_calls"))
    assertFalse(outbound.getJSONObject(0).has("repair_textual_tool_calls"))
  }

  @Test
  fun incompleteNativeToolBatchIsClosedWithoutRewritingAssistantText() {
    val history = JSONArray()
      .put(JSONObject().put("role", "system").put("content", "system"))
      .put(JSONObject().put("role", "user").put("content", "fix it"))
      .put(JSONObject().put("role", "assistant").put("content", "reading")
        .put("tool_calls", JSONArray()
          .put(JSONObject().put("id", "call-1").put("type", "function")
            .put("function", JSONObject().put("name", "read").put("arguments", "{}")))
          .put(JSONObject().put("id", "call-2").put("type", "function")
            .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "content"))

    val outbound = RepairToolCallParser.outboundHistory(history)

    assertEquals(4, outbound.length())
    assertEquals("reading", outbound.getJSONObject(2).getString("content"))
    assertEquals(2, outbound.getJSONObject(2).getJSONArray("tool_calls").length())
    assertEquals("call-2", outbound.getJSONObject(3).getString("tool_call_id"))
    assertEquals(RepairToolCallParser.INTERRUPTED_TOOL_RESULT,
      outbound.getJSONObject(3).getString("content"))
    assertEquals("reading", history.getJSONObject(2).getString("content"))
  }

  @Test
  fun parallelNativeToolsKeepEveryPairAndProviderText() {
    val history = JSONArray()
      .put(JSONObject().put("role", "assistant").put("content", "read both")
        .put("reasoning_content", "stable reasoning")
        .put("tool_calls", JSONArray()
          .put(JSONObject().put("id", "call-1").put("type", "function")
            .put("function", JSONObject().put("name", "read").put("arguments", "{}")))
          .put(JSONObject().put("id", "call-2").put("type", "function")
            .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "a"))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-2").put("content", "b"))

    val outbound = RepairToolCallParser.outboundHistory(history)
    val projected = RepairToolCallParser.toolResultsAsUserObservations(outbound)

    assertEquals(3, outbound.length())
    assertEquals(2, outbound.getJSONObject(0).getJSONArray("tool_calls").length())
    assertEquals(2, projected.length())
    assertEquals("read both", projected.getJSONObject(0).getString("content"))
    assertEquals("stable reasoning", projected.getJSONObject(0).getString("reasoning_content"))
    assertEquals("user", projected.getJSONObject(1).getString("role"))
    assertTrue(projected.getJSONObject(1).getString("content").contains("a"))
    assertTrue(projected.getJSONObject(1).getString("content").contains("b"))
    assertFalse(projected.toString().contains("tool_call_id"))
  }

  @Test
  fun emptyToolOnlyBatchProjectsToExactlyOneObservation() {
    val history = JSONArray()
      .put(JSONObject().put("role", "assistant").put("content", "")
        .put("tool_calls", JSONArray()
          .put(JSONObject().put("id", "call-1").put("type", "function")
            .put("function", JSONObject().put("name", "read").put("arguments", "{}")))
          .put(JSONObject().put("id", "call-2").put("type", "function")
            .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "a"))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-2").put("content", "b"))

    val projected = RepairToolCallParser.toolResultsAsUserObservations(history)

    assertEquals(1, projected.length())
    assertEquals("user", projected.getJSONObject(0).getString("role"))
    assertTrue(projected.getJSONObject(0).getString("content").contains("a"))
    assertTrue(projected.getJSONObject(0).getString("content").contains("b"))
  }

  @Test
  fun multipleNativeBatchesKeepAssistantToolResultResultOrder() {
    val history = JSONArray()
      .put(JSONObject().put("role", "system").put("content", "system"))
      .put(JSONObject().put("role", "user").put("content", "fix it"))
      .put(JSONObject().put("role", "assistant").put("content", "")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
          .put("type", "function")
          .put("function", JSONObject().put("name", "read").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "a"))
      .put(JSONObject().put("role", "assistant").put("content", "")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-2")
          .put("type", "function")
          .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-2").put("content", "b"))

    val outbound = RepairToolCallParser.outboundHistory(history)

    assertEquals(listOf("system", "user", "assistant", "tool", "assistant", "tool"),
      (0 until outbound.length()).map { outbound.getJSONObject(it).getString("role") })
    assertEquals("call-1", outbound.getJSONObject(3).getString("tool_call_id"))
    assertEquals("call-2", outbound.getJSONObject(5).getString("tool_call_id"))
    assertEquals("call-1", outbound.getJSONObject(2).getJSONArray("tool_calls")
      .getJSONObject(0).getString("id"))
    assertEquals("call-2", outbound.getJSONObject(4).getJSONArray("tool_calls")
      .getJSONObject(0).getString("id"))
  }

  @Test
  fun interruptedTailAppendsOnlyMissingResultsAndLeavesEarlierContextUntouched() {
    val history = JSONArray()
      .put(JSONObject().put("role", "system").put("content", "system"))
      .put(JSONObject().put("role", "user").put("content", "fix it"))
      .put(JSONObject().put("role", "assistant").put("content", "checking")
        .put("reasoning_content", "stable reasoning")
        .put("tool_calls", JSONArray()
          .put(JSONObject().put("id", "call-1").put("type", "function")
            .put("function", JSONObject().put("name", "read").put("arguments", "{}")))
          .put(JSONObject().put("id", "call-2").put("type", "function")
            .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "a"))

    val before = history.toString()
    assertTrue(RepairToolCallParser.completeInterruptedTail(history))
    assertEquals(5, history.length())
    assertEquals("checking", history.getJSONObject(2).getString("content"))
    assertEquals("stable reasoning", history.getJSONObject(2).getString("reasoning_content"))
    assertEquals("a", history.getJSONObject(3).getString("content"))
    assertEquals("call-2", history.getJSONObject(4).getString("tool_call_id"))
    assertEquals(RepairToolCallParser.INTERRUPTED_TOOL_RESULT,
      history.getJSONObject(4).getString("content"))
    assertTrue(history.toString().startsWith(before.removeSuffix("]")))
    assertFalse(RepairToolCallParser.completeInterruptedTail(history))
  }

  @Test
  fun aCompletedOldBatchDoesNotMaskAnUnfinishedTail() {
    val history = JSONArray()
      .put(JSONObject().put("role", "assistant").put("content", "")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "old-1")
          .put("type", "function")
          .put("function", JSONObject().put("name", "read").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "old-1").put("content", "done"))
      .put(JSONObject().put("role", "assistant").put("content", "checking")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "new-1")
          .put("type", "function")
          .put("function", JSONObject().put("name", "list").put("arguments", "{}")))))

    assertTrue(RepairToolCallParser.completeInterruptedTail(history))
    assertEquals(4, history.length())
    assertEquals("done", history.getJSONObject(1).getString("content"))
    assertEquals("new-1", history.getJSONObject(3).getString("tool_call_id"))
    assertEquals(RepairToolCallParser.INTERRUPTED_TOOL_RESULT,
      history.getJSONObject(3).getString("content"))
  }

  @Test
  fun punctuationOnlyToolTurnDoesNotBecomeAnEmptyBubble() {
    assertEquals("", RepairToolCallParser.displayableText("."))
    assertEquals("", RepairToolCallParser.displayableText("."))
    assertEquals("读取完成。", RepairToolCallParser.displayableText("读取完成。"))
  }

  // issue #1014（负控）：**设备上**网关返回 "reasoning_content": null 时，Android 的 org.json
  // 在 optString 里把 JSONObject.NULL 渲染成**字符串 "null"**（AOSP JSON.toString 走 String.valueOf，
  // 而 NULL 的 toString 就是 "null"），isNotBlank() 对它为真 —— 空 assistant 壳因此被保留。
  //
  // 注意：本仓单测用的是 Maven 的 org.json:json:20240303（app/build.gradle.kts:129），它的
  // optString(key, fallback) 对 NULL 返回 **fallback**，所以用 JSONObject.NULL 构造在 JVM 上
  // 复现不出这条缺陷（实测：那样写修前就是绿的）。设备上真正进入生产代码的值就是字符串 "null"，
  // 因此这里直接喂该值 —— 这才是与设备同形的输入，不是把缺陷"造"出来。
  @Test
  fun androidNullRenderingDoesNotKeepAnEmptyAssistantShell() {
    val history = JSONArray()
      .put(JSONObject().put("role", "system").put("content", "system"))
      .put(JSONObject().put("role", "user").put("content", "fix it"))
      .put(JSONObject().put("role", "assistant")
        .put("content", "null")
        .put("reasoning_content", "null")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
          .put("type", "function")
          .put("function", JSONObject().put("name", "read").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "diag"))

    val projected = RepairToolCallParser.toolResultsAsUserObservations(history)

    // 期望：assistant 空壳被丢弃，只剩 system / user / 该批次的 user 观察。
    val roles = (0 until projected.length()).map { projected.getJSONObject(it).getString("role") }
    assertEquals(listOf("system", "user", "user"), roles)
    for (i in 0 until projected.length()) {
      assertFalse("不得保留内容为字面量 null 的 assistant 壳",
        projected.getJSONObject(i).optString("content") == "null")
      assertFalse(projected.getJSONObject(i).optString("reasoning_content") == "null")
    }
  }

  // 守卫用例（修法落地后加）：界面的取值口径必须与历史投影侧共用同一个判定，否则第三处复发。
  @Test
  fun androidNullReasoningIsNotRenderedAsAThinkingCard() {
    val answer = JSONObject().put("role", "assistant")
      .put("content", "null")
      .put("reasoning_content", "null")
    assertEquals("", RepairToolCallParser.reasoningText(answer))
    assertFalse(RepairToolCallParser.hasProviderContent(answer))
  }

  @Test
  fun reasoningTextKeepsRealTextAndDropsOnlyTheNullRendering() {
    assertEquals("先核对当前事实。",
      RepairToolCallParser.reasoningText(JSONObject().put("reasoning_content", "先核对当前事实。")))
    assertEquals("", RepairToolCallParser.reasoningText(JSONObject()))
    assertEquals("", RepairToolCallParser.reasoningText(JSONObject().put("reasoning_content", "   ")))
    assertTrue(RepairToolCallParser.hasProviderContent(JSONObject().put("content", "真文本")))
    assertTrue(RepairToolCallParser.hasProviderContent(JSONObject().put("reasoning_content", "真推理")))
  }

  @Test
  fun realReasoningContentIsStillPreserved() {
    val history = JSONArray()
      .put(JSONObject().put("role", "user").put("content", "fix it"))
      .put(JSONObject().put("role", "assistant")
        .put("content", JSONObject.NULL)
        .put("reasoning_content", "真实推理文本")
        .put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1")
          .put("type", "function")
          .put("function", JSONObject().put("name", "read").put("arguments", "{}")))))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call-1").put("content", "diag"))

    val projected = RepairToolCallParser.toolResultsAsUserObservations(history)

    assertEquals("assistant", projected.getJSONObject(1).getString("role"))
    assertEquals("真实推理文本", projected.getJSONObject(1).getString("reasoning_content"))
  }
}

