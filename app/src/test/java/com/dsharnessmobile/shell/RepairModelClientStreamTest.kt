package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Protocol replay and SSE regression coverage for [RepairModelClient].
 *
 * These are JVM tests: a real loopback ServerSocket speaks HTTP so the same
 * code path that talks to a gateway is exercised, including the one-request
 * JSON fallback for gateways that ignore stream:true.
 */
class RepairModelClientStreamTest {

  private fun connection(
    api: String,
    port: Int,
    requiresReasoning: Boolean = false,
  ) = RepairModelConnection(
    provider = "probe",
    providerLabel = "Probe",
    modelLabel = "probe-model",
    model = "probe-model",
    baseUrl = "http://127.0.0.1:" + port,
    api = api,
    key = "sk-test",
    requiresReasoningContentOnAssistantMessages = requiresReasoning,
  )

  // ── Anthropic multi-turn replay ───────────────────────────────────────────

  @Test
  fun anthropicParallelToolResultsBecomeOneUserMessage() {
    val client = RepairModelClient()
    val messages = JSONArray()
      .put(JSONObject().put("role", "user").put("content", "修复"))
      .put(
        JSONObject().put("role", "assistant").put("content", "")
          .put(
            "tool_calls",
            JSONArray()
              .put(toolCall("call_1", "read", "{}"))
              .put(toolCall("call_2", "write", "{}")),
          ),
      )
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call_1").put("content", "one"))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call_2").put("content", "two"))

    val body = JSONObject(
      client.anthropicBody(connection("anthropic-messages", 1), messages, JSONArray(), null),
    )
    val outbound = body.getJSONArray("messages")
    assertEquals(3, outbound.length())
    assertEquals("user", outbound.getJSONObject(0).getString("role"))
    assertEquals("assistant", outbound.getJSONObject(1).getString("role"))
    assertEquals("user", outbound.getJSONObject(2).getString("role"))
    val results = outbound.getJSONObject(2).getJSONArray("content")
    assertEquals("并行 tool_result 必须合并到同一条 user 消息", 2, results.length())
    assertEquals("tool_result", results.getJSONObject(0).getString("type"))
    assertEquals("call_1", results.getJSONObject(0).getString("tool_use_id"))
    assertEquals("call_2", results.getJSONObject(1).getString("tool_use_id"))
  }

  @Test
  fun anthropicThinkingSignatureAndBlockOrderArePreservedAndReplayed() {
    val client = RepairModelClient()
    val response = JSONObject(
      """
      {"content":[
        {"type":"thinking","thinking":"先分析","signature":"sig-abc"},
        {"type":"redacted_thinking","data":"enc-xyz"},
        {"type":"text","text":"先读文件"},
        {"type":"tool_use","id":"call_1","name":"read","input":{"path":"a.txt"}}
      ]}
      """.trimIndent(),
    )
    val assistant = client.anthropicResult(response)
    val blocks = assistant.getJSONArray("_anthropic_blocks")
    assertEquals(4, blocks.length())
    assertEquals("thinking", blocks.getJSONObject(0).getString("type"))
    assertEquals("sig-abc", blocks.getJSONObject(0).getString("signature"))
    assertEquals("redacted_thinking", blocks.getJSONObject(1).getString("type"))
    assertEquals("enc-xyz", blocks.getJSONObject(1).getString("data"))
    assertEquals("text", blocks.getJSONObject(2).getString("type"))
    assertEquals("tool_use", blocks.getJSONObject(3).getString("type"))

    val messages = JSONArray()
      .put(JSONObject().put("role", "user").put("content", "继续"))
      .put(JSONObject(assistant.toString()))
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call_1").put("content", "ok"))
    val outbound = JSONObject(
      client.anthropicBody(connection("anthropic-messages", 1), messages, JSONArray(), null),
    ).getJSONArray("messages")
    val replayed = outbound.getJSONObject(1).getJSONArray("content")
    assertEquals(4, replayed.length())
    assertEquals("sig-abc", replayed.getJSONObject(0).getString("signature"))
    assertEquals("enc-xyz", replayed.getJSONObject(1).getString("data"))
    assertEquals("text", replayed.getJSONObject(2).getString("type"))
    assertEquals("tool_use", replayed.getJSONObject(3).getString("type"))

    // 旧会话没有原块时仍按既有逻辑从 reasoning_content 回退。
    val old = JSONObject().put("role", "assistant")
      .put("content", "旧回答").put("reasoning_content", "旧思考")
    val fallback = JSONObject(
      client.anthropicBody(
        connection("anthropic-messages", 1),
        JSONArray().put(JSONObject().put("role", "user").put("content", "x")).put(old),
        JSONArray(), null,
      ),
    ).getJSONArray("messages").getJSONObject(1).getJSONArray("content")
    assertEquals("thinking", fallback.getJSONObject(0).getString("type"))
    assertEquals("旧思考", fallback.getJSONObject(0).getString("thinking"))
    assertEquals("text", fallback.getJSONObject(1).getString("type"))
  }

  // ── Chat Completions null trap and reasoning contract ────────────────────

  @Test
  fun completionsResultDoesNotTurnJsonNullIntoLiteralNullText() {
    val client = RepairModelClient()
    val nullContent = JSONObject(
      """{"choices":[{"message":{"role":"assistant","content":null,"reasoning_content":null,"reasoning":"real-think"}}]}""",
    )
    val parsed = client.completionsResult(nullContent)
    assertEquals("空正文不得变成字符串 null", "", parsed.optString("content"))
    assertEquals("real-think", parsed.optString("reasoning_content"))

    val literalNull = JSONObject(
      """{"choices":[{"message":{"role":"assistant","content":"null","reasoning_content":"null","reasoning_text":"alias-think"}}]}""",
    )
    val parsedLiteral = client.completionsResult(literalNull)
    assertEquals("", parsedLiteral.optString("content"))
    assertEquals("alias-think", parsedLiteral.optString("reasoning_content"))
  }

  @Test
  fun completionsBodyHonoursRequiresReasoningContentOnAssistantMessages() {
    val client = RepairModelClient()
    val messages = JSONArray()
      .put(JSONObject().put("role", "user").put("content", "hi"))
      .put(
        JSONObject().put("role", "assistant").put("content", "")
          .put("tool_calls", JSONArray().put(toolCall("call_1", "read", "{}"))),
      )
    val required = JSONObject(
      client.completionsBody(connection("openai-completions", 1, requiresReasoning = true), messages, JSONArray(), null),
    ).getJSONArray("messages").getJSONObject(1)
    assertEquals("缺少推理字段时必须按协议补空串", "", required.optString("reasoning_content"))
    assertTrue(required.has("reasoning_content"))

    val notRequired = JSONObject(
      client.completionsBody(connection("openai-completions", 1, requiresReasoning = false), messages, JSONArray(), null),
    ).getJSONArray("messages").getJSONObject(1)
    assertFalse("未开启 compat 时不得擅自补字段", notRequired.has("reasoning_content"))
  }

  // ── Responses native items and terminal validation ───────────────────────

  @Test
  fun responsesResultKeepsNativeItemsAndRejectsFailedOrEmptyResponses() {
    val client = RepairModelClient()
    val response = JSONObject(
      """
      {"status":"completed","output":[
        {"type":"reasoning","summary":[{"type":"summary_text","text":"想"}],"encrypted_content":"enc-1"},
        {"type":"message","role":"assistant","content":[{"type":"output_text","text":"答"}]}
      ]}
      """.trimIndent(),
    )
    val parsed = client.responsesResult(response)
    val items = parsed.getJSONArray("_responses_items")
    assertEquals(2, items.length())
    assertEquals("reasoning", items.getJSONObject(0).getString("type"))
    assertEquals("enc-1", items.getJSONObject(0).getString("encrypted_content"))
    assertEquals("答", parsed.getString("content"))

    assertThrows(RepairModelFailure::class.java) {
      client.responsesResult(JSONObject("""{"status":"failed","error":{"message":"boom"},"output":[]}"""))
    }
    assertThrows(RepairModelFailure::class.java) {
      client.responsesResult(JSONObject("""{"status":"incomplete","output":[]}"""))
    }
    assertThrows(RepairModelFailure::class.java) {
      client.responsesResult(JSONObject("""{"status":"completed"}"""))
    }
    assertThrows(RepairModelFailure::class.java) {
      client.responsesResult(JSONObject("""{"status":"completed","output":[]}"""))
    }
  }

  @Test
  fun responsesBodyReplaysNativeItemsInOriginalOrder() {
    val client = RepairModelClient()
    val assistant = JSONObject().put("role", "assistant").put("content", "答")
      .put(
        "_responses_items",
        JSONArray()
          .put(JSONObject().put("type", "reasoning").put("encrypted_content", "enc-1"))
          .put(
            JSONObject().put("type", "function_call").put("call_id", "call_1")
              .put("name", "read").put("arguments", "{\"path\":\"a\"}"),
          )
          .put(
            JSONObject().put("type", "message").put("role", "assistant")
              .put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", "答"))),
          ),
      )
    val messages = JSONArray()
      .put(JSONObject().put("role", "user").put("content", "go"))
      .put(assistant)
      .put(JSONObject().put("role", "tool").put("tool_call_id", "call_1").put("content", "ok"))

    val input = JSONObject(
      client.responsesBody(connection("openai-responses", 1), messages, JSONArray(), null),
    ).getJSONArray("input")
    assertEquals(5, input.length())
    assertEquals("user", input.getJSONObject(0).getString("role"))
    assertEquals("reasoning", input.getJSONObject(1).getString("type"))
    assertEquals("enc-1", input.getJSONObject(1).getString("encrypted_content"))
    assertEquals("function_call", input.getJSONObject(2).getString("type"))
    assertEquals("message", input.getJSONObject(3).getString("type"))
    assertEquals("function_call_output", input.getJSONObject(4).getString("type"))
    var functionCalls = 0
    for (i in 0 until input.length()) if (input.getJSONObject(i).optString("type") == "function_call") functionCalls++
    assertEquals("原生 function_call 不得被二次拼装", 1, functionCalls)
  }

  // ── SSE: Chat Completions ─────────────────────────────────────────────────

  @Test
  fun chatSseAccumulatesInterleavedToolCallsAndUtf8AcrossChunks() {
    val events = listOf(
      sse(JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("reasoning_content", "先想"))))),
      sse(JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", "你好"))))),
      sse(
        JSONObject().put(
          "choices",
          JSONArray().put(
            JSONObject().put(
              "delta",
              JSONObject().put(
                "tool_calls",
                JSONArray().put(
                  JSONObject().put("index", 0).put("id", "call_a").put("type", "function")
                    .put("function", JSONObject().put("name", "read").put("arguments", "{\"path\":")),
                ),
              ),
            ),
          ),
        ),
      ),
      sse(
        JSONObject().put(
          "choices",
          JSONArray().put(
            JSONObject().put(
              "delta",
              JSONObject().put(
                "tool_calls",
                JSONArray().put(
                  JSONObject().put("index", 1).put("id", "call_b").put("type", "function")
                    .put("function", JSONObject().put("name", "write").put("arguments", "{}")),
                ),
              ),
            ),
          ),
        ),
      ),
      sse(
        JSONObject().put(
          "choices",
          JSONArray().put(
            JSONObject().put(
              "delta",
              JSONObject().put(
                "tool_calls",
                JSONArray().put(
                  JSONObject().put("index", 0)
                    .put("function", JSONObject().put("arguments", "\"a.txt\"}")),
                ),
              ),
            ),
          ),
        ),
      ),
      sse(
        JSONObject().put(
          "choices",
          JSONArray().put(
            JSONObject().put("delta", JSONObject().put("content", "世界")).put("finish_reason", "stop"),
          ),
        ),
      ),
      "data: [DONE]\n\n",
    )
    val full = events.joinToString("")
    val bytes = full.toByteArray(StandardCharsets.UTF_8)
    val split = indexInsideUtf8(bytes, "你好")
    val server = HttpProbeServer { socket, _, _ ->
      val out = streamHead(socket, bytes.size)
      out.write(bytes, 0, split)
      out.flush()
      Thread.sleep(25)
      out.write(bytes, split, bytes.size - split)
      out.flush()
    }
    try {
      val listener = RecordingListener()
      val result = RepairModelClient().complete(
        connection("openai-completions", server.port),
        JSONArray().put(JSONObject().put("role", "user").put("content", "go")),
        JSONArray(),
        null,
        listener,
      )
      server.assertNoError()
      assertEquals("你好世界", listener.textJoined())
      assertEquals("先想", listener.reasoningJoined())
      val calls = result.getJSONArray("tool_calls")
      assertEquals(2, calls.length())
      assertEquals("call_a", calls.getJSONObject(0).getString("id"))
      assertEquals("read", calls.getJSONObject(0).getJSONObject("function").getString("name"))
      assertEquals("{\"path\":\"a.txt\"}", calls.getJSONObject(0).getJSONObject("function").getString("arguments"))
      assertEquals("call_b", calls.getJSONObject(1).getString("id"))
    } finally {
      server.close()
    }
  }

  // ── SSE: Responses ────────────────────────────────────────────────────────

  @Test
  fun responsesSseConsumesOutputItemsDeltasAndCompleted() {
    val finalItems = JSONArray()
      .put(JSONObject().put("type", "reasoning").put("encrypted_content", "enc-1")
        .put("summary", JSONArray().put(JSONObject().put("type", "summary_text").put("text", "思考"))))
      .put(JSONObject().put("type", "function_call").put("call_id", "call_1").put("name", "read")
        .put("arguments", "{\"path\":\"x\"}"))
      .put(JSONObject().put("type", "message").put("role", "assistant")
        .put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", "完成"))))
    val events = listOf(
      sseNamed("response.output_item.added", JSONObject().put("output_index", 0)
        .put("item", JSONObject().put("type", "reasoning").put("summary", JSONArray()))),
      sseNamed("response.reasoning_summary_text.delta", JSONObject().put("output_index", 0)
        .put("summary_index", 0).put("delta", "思考")),
      sseNamed("response.output_item.done", JSONObject().put("output_index", 0)
        .put("item", finalItems.getJSONObject(0))),
      sseNamed("response.output_item.added", JSONObject().put("output_index", 1)
        .put("item", JSONObject().put("type", "function_call").put("call_id", "call_1")
          .put("name", "read").put("arguments", ""))),
      sseNamed("response.function_call_arguments.delta", JSONObject().put("output_index", 1)
        .put("delta", "{\"path\":\"x\"}")),
      sseNamed("response.output_item.added", JSONObject().put("output_index", 2)
        .put("item", JSONObject().put("type", "message").put("role", "assistant").put("content", JSONArray()))),
      sseNamed("response.output_text.delta", JSONObject().put("output_index", 2)
        .put("content_index", 0).put("delta", "完成")),
      sseNamed("response.output_item.done", JSONObject().put("output_index", 2)
        .put("item", finalItems.getJSONObject(2))),
      sseNamed("response.completed", JSONObject().put("response",
        JSONObject().put("status", "completed").put("output", finalItems))),
    )
    val body = events.joinToString("").toByteArray(StandardCharsets.UTF_8)
    val server = HttpProbeServer { socket, _, _ ->
      val out = streamHead(socket, body.size)
      out.write(body)
      out.flush()
    }
    try {
      val listener = RecordingListener()
      val result = RepairModelClient().complete(
        connection("openai-responses", server.port),
        JSONArray().put(JSONObject().put("role", "user").put("content", "go")),
        JSONArray(), null, listener,
      )
      server.assertNoError()
      assertEquals("完成", listener.textJoined())
      assertEquals("思考", listener.reasoningJoined())
      val items = result.getJSONArray("_responses_items")
      assertEquals(3, items.length())
      assertEquals("enc-1", items.getJSONObject(0).getString("encrypted_content"))
      assertEquals("function_call", items.getJSONObject(1).getString("type"))
      assertEquals("{\"path\":\"x\"}", items.getJSONObject(1).getString("arguments"))
      assertEquals(1, result.getJSONArray("tool_calls").length())
    } finally {
      server.close()
    }
  }

  // ── SSE: Anthropic ────────────────────────────────────────────────────────

  @Test
  fun anthropicSseConsumesThinkingSignatureAndToolInput() {
    val events = listOf(
      sseNamed("message_start", JSONObject().put("message", JSONObject().put("content", JSONArray()))),
      sseNamed("content_block_start", JSONObject().put("index", 0)
        .put("content_block", JSONObject().put("type", "thinking").put("thinking", ""))),
      sseNamed("content_block_delta", JSONObject().put("index", 0)
        .put("delta", JSONObject().put("type", "thinking_delta").put("thinking", "推理"))),
      sseNamed("content_block_delta", JSONObject().put("index", 0)
        .put("delta", JSONObject().put("type", "signature_delta").put("signature", "sig-1"))),
      sseNamed("content_block_stop", JSONObject().put("index", 0)),
      sseNamed("content_block_start", JSONObject().put("index", 1)
        .put("content_block", JSONObject().put("type", "text").put("text", ""))),
      sseNamed("content_block_delta", JSONObject().put("index", 1)
        .put("delta", JSONObject().put("type", "text_delta").put("text", "答案"))),
      sseNamed("content_block_stop", JSONObject().put("index", 1)),
      sseNamed("content_block_start", JSONObject().put("index", 2)
        .put("content_block", JSONObject().put("type", "tool_use").put("id", "call_1")
          .put("name", "read").put("input", JSONObject()))),
      sseNamed("content_block_delta", JSONObject().put("index", 2)
        .put("delta", JSONObject().put("type", "input_json_delta").put("partial_json", "{\"path\":\"a\"}"))),
      sseNamed("content_block_stop", JSONObject().put("index", 2)),
      sseNamed("message_delta", JSONObject().put("delta", JSONObject().put("stop_reason", "tool_use"))),
      sseNamed("message_stop", JSONObject()),
    )
    val body = events.joinToString("").toByteArray(StandardCharsets.UTF_8)
    val server = HttpProbeServer { socket, _, _ ->
      val out = streamHead(socket, body.size)
      out.write(body)
      out.flush()
    }
    try {
      val listener = RecordingListener()
      val result = RepairModelClient().complete(
        connection("anthropic-messages", server.port),
        JSONArray().put(JSONObject().put("role", "user").put("content", "go")),
        JSONArray(), null, listener,
      )
      server.assertNoError()
      assertEquals("答案", listener.textJoined())
      assertEquals("推理", listener.reasoningJoined())
      val blocks = result.getJSONArray("_anthropic_blocks")
      assertEquals(3, blocks.length())
      assertEquals("thinking", blocks.getJSONObject(0).getString("type"))
      assertEquals("sig-1", blocks.getJSONObject(0).getString("signature"))
      assertEquals("答案", blocks.getJSONObject(1).getString("text"))
      assertEquals("tool_use", blocks.getJSONObject(2).getString("type"))
      assertEquals("a", blocks.getJSONObject(2).getJSONObject("input").getString("path"))
      assertEquals(1, result.getJSONArray("tool_calls").length())
    } finally {
      server.close()
    }
  }

  // ── Gateway ignores stream:true: same request JSON fallback ───────────────

  @Test
  fun gatewayIgnoringStreamFlagFallsBackToJsonWithoutSecondPost() {
    val cases = listOf(
      Triple(
        "openai-completions",
        """{"choices":[{"message":{"role":"assistant","content":"done","reasoning_content":"think"}}]}""",
        "done",
      ),
      Triple(
        "openai-responses",
        """{"status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}""",
        "done",
      ),
      Triple(
        "anthropic-messages",
        """{"content":[{"type":"thinking","thinking":"think"},{"type":"text","text":"done"}]}""",
        "done",
      ),
    )
    for ((api, json, expectedText) in cases) {
      var captured = ""
      var accept = ""
      val server = HttpProbeServer { socket, _, request ->
        captured = request
        accept = header(request, "Accept")
        respondJson(socket, "application/json", json)
      }
      try {
        val listener = RecordingListener()
        val result = RepairModelClient().complete(
          connection(api, server.port),
          JSONArray().put(JSONObject().put("role", "user").put("content", "go")),
          JSONArray(), null, listener,
        )
        server.assertNoError()
        assertEquals(api + " 必须只发一次 POST", 1, server.requests)
        assertEquals(api + " 请求体必须带 stream:true", true, captured.contains("\"stream\":true"))
        assertTrue(api + " Accept 必须是流式优先", accept.contains("text/event-stream"))
        assertEquals(api + " 同请求 JSON 回退必须回调最终文本", expectedText, listener.textJoined())
        assertEquals(api + " 同请求 JSON 回退必须回调最终推理", "think", listener.reasoningJoined())
        assertNotNull(result)
      } finally {
        server.close()
      }
    }
  }

  // ── Cancellation and no-retry-after-delta ─────────────────────────────────

  @Test
  fun cancelDuringStreamSuppressesEveryLateCallback() {
    val first = sse(JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", "第一段")))))
    val second = sse(JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", "第二段")).put("finish_reason", "stop"))))
    val body = (first + second).toByteArray(StandardCharsets.UTF_8)
    val client = RepairModelClient()
    val listener = RecordingListener()
    val firstSeen = CountDownLatch(1)
    listener.onFirstText = {
      firstSeen.countDown()
      listener.cancelAt = System.nanoTime()
      client.cancel()
    }
    val server = HttpProbeServer { socket, _, _ ->
      runCatching {
        val out = streamHead(socket, body.size)
        out.write(first.toByteArray(StandardCharsets.UTF_8))
        out.flush()
        Thread.sleep(400)
        out.write(second.toByteArray(StandardCharsets.UTF_8))
        out.flush()
      }
    }
    val failure = AtomicReference<Throwable?>()
    try {
      val runner = Thread {
        try {
          client.complete(
            connection("openai-completions", server.port),
            JSONArray().put(JSONObject().put("role", "user").put("content", "go")),
            JSONArray(), null, listener,
          )
        } catch (t: Throwable) {
          failure.set(t)
        }
      }
      runner.start()
      assertTrue("首帧应到达", firstSeen.await(5, TimeUnit.SECONDS))
      runner.join(5_000)
      assertFalse("取消后 complete 必须及时返回", runner.isAlive)
      assertEquals("第一段", listener.textJoined())
      assertEquals("取消后不得再有晚到回调", 0, listener.lateCallbacks)
      assertNotNull("取消应以异常结束本次请求", failure.get())
    } finally {
      server.close()
    }
  }

  @Test
  fun disconnectAfterDeltaIsNeverRetried() {
    val first = sse(JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", "已发射")))))
    val firstBytes = first.toByteArray(StandardCharsets.UTF_8)
    val validJson = """{"choices":[{"message":{"role":"assistant","content":"retry-should-not-happen"}}]}"""
    val server = HttpProbeServer { socket, n, _ ->
      if (n == 1) {
        runCatching {
          val out = streamHead(socket, firstBytes.size)
          out.write(firstBytes)
          out.flush()
          Thread.sleep(50)
        }
      } else {
        runCatching { respondJson(socket, "application/json", validJson) }
      }
    }
    try {
      val listener = RecordingListener()
      val failure = assertThrows(RepairModelFailure::class.java) {
        RepairModelClient().complete(
          connection("openai-completions", server.port),
          JSONArray().put(JSONObject().put("role", "user").put("content", "go")),
          JSONArray(), null, listener,
        )
      }
      assertTrue("断流应明确失败", failure.message.orEmpty().contains("中断"))
      assertEquals("已发射", listener.textJoined())
      Thread.sleep(350)
      assertEquals("已发射 delta 后断流严禁重试", 1, server.requests)
    } finally {
      server.close()
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private fun sse(json: JSONObject): String = "data: " + json + "\n\n"

  private fun sseNamed(event: String, json: JSONObject): String = "event: " + event + "\ndata: " + json + "\n\n"

  private fun toolCall(id: String, name: String, arguments: String): JSONObject = JSONObject()
    .put("id", id).put("type", "function")
    .put("function", JSONObject().put("name", name).put("arguments", arguments))

  private fun indexInsideUtf8(bytes: ByteArray, text: String): Int {
    val target = text.toByteArray(StandardCharsets.UTF_8)
    for (i in 0..bytes.size - target.size) {
      var same = true
      for (j in target.indices) if (bytes[i + j] != target[j]) { same = false; break }
      if (same) return i + 1
    }
    return bytes.size / 2
  }

  private fun header(request: String, name: String): String {
    for (line in request.substringBefore("\r\n\r\n").split("\r\n")) {
      val colon = line.indexOf(':')
      if (colon > 0 && line.substring(0, colon).equals(name, ignoreCase = true)) {
        return line.substring(colon + 1).trim()
      }
    }
    return ""
  }

  private class RecordingListener : RepairStreamListener {
    private val lock = Object()
    private val text = ArrayList<String>()
    private val reasoning = ArrayList<String>()
    private var cancelAtNanos = 0L
    private var late = 0

    @Volatile var onFirstText: (() -> Unit)? = null

    var cancelAt: Long
      get() = cancelAtNanos
      set(value) { cancelAtNanos = value }

    val lateCallbacks: Int get() = synchronized(lock) { late }

    override fun onTextDelta(delta: String) {
      val notify: Boolean
      synchronized(lock) {
        if (cancelAtNanos != 0L && System.nanoTime() > cancelAtNanos) late++
        text.add(delta)
        notify = text.size == 1
        lock.notifyAll()
      }
      if (notify) onFirstText?.invoke()
    }

    override fun onReasoningDelta(delta: String) {
      synchronized(lock) {
        if (cancelAtNanos != 0L && System.nanoTime() > cancelAtNanos) late++
        reasoning.add(delta)
        lock.notifyAll()
      }
    }

    fun textJoined(): String = synchronized(lock) { text.joinToString("") }

    fun reasoningJoined(): String = synchronized(lock) { reasoning.joinToString("") }
  }

  private inner class HttpProbeServer(
    private val handler: (Socket, Int, String) -> Unit,
  ) : Closeable {
    private val server = ServerSocket()
    private val count = AtomicInteger()
    private val failure = AtomicReference<Throwable?>()
    private val thread: Thread

    val port: Int

    init {
      server.reuseAddress = true
      server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
      port = server.localPort
      thread = Thread {
        while (!server.isClosed) {
          try {
            val socket = server.accept()
            val number = count.incrementAndGet()
            val request = readRequest(socket.getInputStream())
            handler(socket, number, request)
          } catch (t: Throwable) {
            if (!server.isClosed) failure.compareAndSet(null, t)
          }
        }
      }
      thread.isDaemon = true
      thread.start()
    }

    val requests: Int get() = count.get()

    fun assertNoError() {
      failure.get()?.let { throw AssertionError("loopback server failed", it) }
    }

    override fun close() {
      server.close()
      thread.join(1_000)
    }
  }

  private fun readRequest(input: InputStream): String {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    var headerEnd = -1
    var contentLength = 0
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      out.write(buffer, 0, n)
      if (headerEnd < 0) {
        val text = out.toByteArray().toString(StandardCharsets.ISO_8859_1)
        headerEnd = text.indexOf("\r\n\r\n")
        if (headerEnd >= 0) {
          contentLength = Regex("(?i)content-length:\\s*(\\d+)")
            .find(text.substring(0, headerEnd))?.groupValues?.get(1)?.toIntOrNull() ?: 0
        }
      }
      if (headerEnd >= 0 && out.size() >= headerEnd + 4 + contentLength) break
      if (out.size() > 4_000_000) break
    }
    return out.toByteArray().toString(StandardCharsets.UTF_8)
  }

  private fun streamHead(socket: Socket, length: Int) =
    socket.getOutputStream().also {
      it.write(
        ("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n" +
          "Content-Length: " + length + "\r\nConnection: close\r\n\r\n").toByteArray(StandardCharsets.UTF_8),
      )
      it.flush()
    }

  private fun respondJson(socket: Socket, contentType: String, body: String) {
    val bytes = body.toByteArray(StandardCharsets.UTF_8)
    val out = socket.getOutputStream()
    out.write(
      ("HTTP/1.1 200 OK\r\nContent-Type: " + contentType + "\r\n" +
        "Content-Length: " + bytes.size + "\r\nConnection: close\r\n\r\n").toByteArray(StandardCharsets.UTF_8),
    )
    out.write(bytes)
    out.flush()
  }
}
