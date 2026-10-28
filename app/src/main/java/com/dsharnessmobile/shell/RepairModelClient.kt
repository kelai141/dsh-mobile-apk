package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/** One bounded model request. It never opens a browser, Node process, or engine dependency. */
internal class RepairModelClient {
  private val active = AtomicReference<HttpURLConnection?>(null)
  @Volatile internal var lastOutboundDigest: String = ""
    private set
  @Volatile internal var lastOutboundMessages: Int = 0
    private set
  fun cancel() { active.getAndSet(null)?.disconnect() }

  fun complete(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    reasoningEffort: String? = connection.defaultReasoningEffort,
  ): JSONObject {
    require(connection.apiKey.isNotBlank()) { "模型凭据不在内存中；请重新打开修复助手" }
    val endpoint = endpointFor(connection)
    val effort = reasoningEffort?.takeIf { id -> connection.reasoningEfforts.any { it.id == id } }
    val projected = RepairToolCallParser.outboundHistory(messages)
    if (connection.toolHistoryMode == "user-observation") {
      // This is an explicit compatibility override for a gateway that cannot
      // accept provider-native tool roles. It groups one completed batch into a
      // single stable observation; ordinary compatible routes keep the native
      // sequence and the provider-cache prefix unchanged.
      val observation = RepairToolCallParser.toolResultsAsUserObservations(projected)
      for (i in projected.length() - 1 downTo 0) projected.remove(i)
      for (i in 0 until observation.length()) projected.put(observation.getJSONObject(i))
    }
    val outbound = projected
    val outboundBytes = outbound.toString().toByteArray(StandardCharsets.UTF_8)
    lastOutboundDigest = MessageDigest.getInstance("SHA-256").digest(outboundBytes)
      .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    lastOutboundMessages = outbound.length()
    val body = when (connection.api) {
      "anthropic-messages" -> anthropicBody(connection, outbound, tools, effort)
      "openai-responses" -> responsesBody(connection, outbound, tools, effort)
      else -> completionsBody(connection, outbound, tools, effort)
    }
    val response = postWithOneTransientRetry(connection, endpoint, body)
    gatewayErrorOf(response, connection.apiKey)?.let { throw RepairModelFailure(it) }
    val parsed = JSONObject(response)
    val result = when (connection.api) {
      "anthropic-messages" -> anthropicResult(parsed)
      "openai-responses" -> responsesResult(parsed)
      else -> completionsResult(parsed)
    }
    return RepairToolCallParser.normalize(result)
  }

  private fun endpointFor(connection: RepairModelConnection): String {
    val base = connection.baseUrl.trimEnd('/')
    require(base.startsWith("https://") || base.startsWith("http://127.0.0.1") || base.startsWith("http://localhost")) {
      "模型端点必须使用 HTTPS（本机回环除外）"
    }
    return when (connection.api) {
      "anthropic-messages" -> if (base.endsWith("/v1")) "$base/messages" else "$base/v1/messages"
      "openai-responses" -> "$base/responses"
      else -> "$base/chat/completions"
    }
  }


  private fun completionsBody(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    effort: String?,
  ): String {
    // OpenAI-compatible chat endpoints require every tool to be wrapped in a
    // `{type:function, function:{...}}` envelope. Sending the bare Anthropic-like
    // schema let some gateways accept the request but silently ignore the tools,
    // which made the model print DSML markup into assistant content instead.
    // An explicitly configured route may project observations before this point.
    val body = JSONObject().put("model", connection.model).put("messages", messages)
      .put("tools", RepairToolCallParser.openAiTools(tools))
      .put("tool_choice", "auto").put("stream", false)
    applyReasoning(connection, body, effort)
    body.put(connection.maxTokensField ?: "max_tokens", 8192)
    return body.toString()
  }

  private fun responsesBody(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    effort: String?,
  ): String {
    val input = JSONArray()
    val mappedTools = JSONArray()
    var system = ""
    for (i in 0 until messages.length()) {
      val m = messages.getJSONObject(i)
      when (m.optString("role")) {
        "system" -> system += m.optString("content") + "\n"
        "tool" -> input.put(JSONObject().put("type", "function_call_output").put("call_id", m.optString("tool_call_id")).put("output", m.optString("content")))
        else -> {
          val content = m.optString("content")
          if (content.isNotBlank()) input.put(JSONObject().put("role", m.optString("role")).put("content", content))
          val calls = m.optJSONArray("tool_calls") ?: continue
          for (j in 0 until calls.length()) {
            val call = calls.getJSONObject(j); val fn = call.getJSONObject("function")
            input.put(JSONObject().put("type", "function_call").put("call_id", call.getString("id"))
              .put("name", fn.getString("name")).put("arguments", fn.optString("arguments", "{}")))
          }
        }
      }
    }
    for (i in 0 until tools.length()) {
      val tool = tools.getJSONObject(i)
      mappedTools.put(JSONObject().put("type", "function").put("name", tool.getString("name"))
        .put("description", tool.optString("description")).put("parameters", tool.optJSONObject("parameters")))
    }
    val body = JSONObject().put("model", connection.model).put("input", input).put("tools", mappedTools)
      .put("instructions", system).put("store", false)
    if (effort != null && effort != "off") {
      body.put("reasoning", JSONObject().put("effort", effort))
    }
    return body.toString()
  }

  private fun anthropicBody(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    effort: String?,
  ): String {
    val system = StringBuilder(); val converted = JSONArray()
    for (i in 0 until messages.length()) {
      val m = messages.getJSONObject(i)
      when (m.optString("role")) {
        "system" -> system.append(m.optString("content")).append("\n")
        "tool" -> converted.put(JSONObject().put("role", "user").put("content", JSONArray().put(
          JSONObject().put("type", "tool_result").put("tool_use_id", m.optString("tool_call_id"))
            .put("content", m.optString("content")))))
        "assistant" -> {
          val contents = JSONArray()
          m.optString("reasoning_content").takeIf { it.isNotBlank() }?.let {
            contents.put(JSONObject().put("type", "thinking").put("thinking", it))
          }
          m.optString("content").takeIf { it.isNotBlank() && it != "null" }?.let {
            contents.put(JSONObject().put("type", "text").put("text", it))
          }
          val calls = m.optJSONArray("tool_calls") ?: JSONArray()
          for (j in 0 until calls.length()) {
            val call = calls.getJSONObject(j); val fn = call.getJSONObject("function")
            val input = runCatching { JSONObject(fn.optString("arguments", "{}")) }.getOrDefault(JSONObject())
            contents.put(JSONObject().put("type", "tool_use").put("id", call.getString("id"))
              .put("name", fn.getString("name")).put("input", input))
          }
          converted.put(JSONObject().put("role", "assistant").put("content", contents))
        }
        else -> converted.put(JSONObject().put("role", "user").put("content", m.optString("content")))
      }
    }
    val anthTools = JSONArray()
    for (i in 0 until tools.length()) {
      val t = tools.getJSONObject(i)
      anthTools.put(JSONObject().put("name", t.getString("name")).put("description", t.optString("description"))
        .put("input_schema", t.optJSONObject("parameters")))
    }
    val body = JSONObject().put("model", connection.model).put("max_tokens", 8192)
      .put("messages", converted).put("tools", anthTools)
    if (system.isNotBlank()) body.put("system", system.toString())
    if (effort != null && effort != "off") {
      body.put("thinking", JSONObject().put("type", "enabled").put("budget_tokens", effortBudget(effort)))
    }
    return body.toString()
  }

  private fun applyReasoning(connection: RepairModelConnection, body: JSONObject, effort: String?) {
    if (effort == null) return
    val mapped = connection.reasoningEfforts.firstOrNull { it.id == effort }?.wireValue
    when (connection.thinkingFormat) {
      "deepseek" -> {
        body.put("thinking", JSONObject().put("type", if (effort == "off") "disabled" else "enabled"))
        if (effort != "off" && connection.supportsReasoningEffort == true) {
          body.put("reasoning_effort", mapped ?: effort)
        }
      }
      "qwen" -> {
        body.put("enable_thinking", effort != "off")
        if (effort != "off" && connection.supportsReasoningEffort == true) {
          body.put("reasoning_effort", mapped ?: effort)
        }
      }
      "openrouter" -> if (effort != "off") {
        body.put("reasoning", JSONObject().put("effort", mapped ?: effort))
      }
      "string-thinking" -> body.put("thinking", if (effort == "off") "none" else mapped ?: effort)
      "mimo" -> body.put("thinking", JSONObject().put("type", if (effort == "off") "disabled" else "enabled"))
      else -> if (effort != "off" && connection.supportsReasoningEffort != false) {
        body.put("reasoning_effort", mapped ?: effort)
      }
    }
  }

  private fun effortBudget(effort: String): Int = when (effort.lowercase()) {
    "low" -> 2048
    "medium" -> 4096
    "high" -> 8192
    "xhigh", "max" -> 16384
    else -> 4096
  }

  /**
   * 网关错误的结构化判定（2026-10-25 审计 M-R3/M-R4）。null = 不是接口错误。
   *
   * - **结构化**而非文本启发：顶层 `error` 键必须是 JSON 对象才算——自建网关常见的
   *   `{"choices":[...], "error": null}` 或模型正文含 "error" 字样不再被误判（旧实现用
   *   `contains("\"error\"")`，正常纯文本回答会被当成接口错误）。
   * - `error.message` 为 null / JSONObject.NULL 时不算错误：`optString` 会把 null 产出成
   *   `"null"` 字符串，旧实现即误抛「模型接口错误：null」并丢弃正常回答。
   * - 回显消息与 [post] 的 HTTP 错误路径同口径替换 apiKey，防网关错误回显凭据。
   *   例外（2026-10-28 扫描 M4）：apiKey 为空串时字面 `replace("")` 会在每个字符间插 `***`，
   *   把消息毁成乱码——没有可脱敏的凭据就原样放行（空凭据本就发不出有效请求）。
   */
  internal fun gatewayErrorOf(response: String, apiKey: String): String? {
    val errorObject = runCatching { JSONObject(response).optJSONObject("error") }.getOrNull() ?: return null
    if (response.contains("\"tool_calls\"")) return null
    val message = (errorObject.opt("message") as? String)?.takeIf { it.isNotBlank() } ?: return null
    val redacted = if (apiKey.isEmpty()) message else message.replace(apiKey, "***")
    return "模型接口错误：" + redacted.take(300)
  }

  private fun post(connection: RepairModelConnection, endpoint: String, body: String): String {
    val conn = URL(endpoint).openConnection() as HttpURLConnection
    active.set(conn)
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 20_000
      conn.readTimeout = 180_000
      conn.instanceFollowRedirects = false
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Accept", "application/json")
      for ((key, value) in connection.headers) {
        if (key.equals("Host", true) || key.equals("Content-Length", true)) continue
        conn.setRequestProperty(key, value)
      }
      if (connection.api == "anthropic-messages") {
        conn.setRequestProperty("x-api-key", connection.apiKey)
        conn.setRequestProperty("anthropic-version", connection.headers["anthropic-version"] ?: "2023-06-01")
      } else {
        conn.setRequestProperty("Authorization", "Bearer " + connection.apiKey)
      }
      conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
      val code = conn.responseCode
      val stream = if (code in 200..299) conn.inputStream else conn.errorStream
      val bytes = stream?.use { input ->
        val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
        var total = 0
        while (true) {
          val n = input.read(buffer); if (n < 0) break
          total += n
          if (total > 2_000_000) throw RepairModelFailure("模型响应过大")
          out.write(buffer, 0, n)
        }
        out.toByteArray()
      } ?: ByteArray(0)
      val text = bytes.toString(StandardCharsets.UTF_8)
      if (code in 300..399) {
        throw RepairModelFailure("模型端点返回重定向（HTTP $code）；为避免凭据发送到其它域，已拒绝跟随")
      }
      if (code !in 200..299) throw RepairModelFailure("模型请求失败（HTTP $code）：" + text.replace(connection.apiKey, "***").take(300))
      if (text.isBlank()) throw RepairModelFailure("模型返回空响应")
      return text
    } catch (e: RepairModelFailure) { throw e }
    catch (e: Exception) { throw RepairModelFailure("模型连接失败：" + (e.message ?: e.javaClass.simpleName)) }
    finally {
      active.compareAndSet(conn, null)
      conn.disconnect()
    }
  }

  /**
   * A dropped keep-alive socket can fail before the server accepts the body.
   * Retry one idempotent, byte-identical model request; protocol errors and
   * HTTP responses are never retried because they already carry a diagnosis.
   */
  internal fun postWithOneTransientRetry(
    connection: RepairModelConnection,
    endpoint: String,
    body: String,
  ): String {
    try {
      return post(connection, endpoint, body)
    } catch (failure: RepairModelFailure) {
      if (!isTransientTransportFailure(failure.message.orEmpty())) throw failure
    }
    return post(connection, endpoint, body)
  }

  internal fun isTransientTransportFailure(message: String): Boolean {
    if (!message.startsWith("模型连接失败：")) return false
    val detail = message.lowercase()
    return listOf(
      "socket closed", "connection reset", "broken pipe", "unexpected end of stream",
      "connection refused", "connection aborted", "eof", "timed out", "timeout",
    ).any { detail.contains(it) }
  }

  private fun completionsResult(root: JSONObject): JSONObject {
    val choice = root.optJSONArray("choices")?.optJSONObject(0)
      ?: throw RepairModelFailure("模型响应缺少 choices")
    val message = choice.optJSONObject("message") ?: throw RepairModelFailure("模型响应缺少 message")
    val reasoning = listOf("reasoning_content", "reasoning", "reasoning_text")
      .firstNotNullOfOrNull { field -> message.optString(field).takeIf { it.isNotBlank() } }
    if (reasoning != null && message.optString("reasoning_content").isBlank()) {
      message.put("reasoning_content", reasoning)
    }
    return message
  }

  private fun responsesResult(root: JSONObject): JSONObject {
    val output = root.optJSONArray("output") ?: JSONArray(); val calls = JSONArray()
    val text = StringBuilder(); val reasoning = StringBuilder()
    for (i in 0 until output.length()) {
      val item = output.getJSONObject(i)
      when (item.optString("type")) {
        "message" -> {
          val content = item.optJSONArray("content") ?: JSONArray()
          for (j in 0 until content.length()) text.append(content.getJSONObject(j).optString("text"))
        }
        "function_call" -> calls.put(JSONObject().put("id", item.optString("call_id"))
          .put("type", "function").put("function", JSONObject().put("name", item.optString("name"))
            .put("arguments", item.optString("arguments", "{}"))))
        "reasoning" -> {
          val summary = item.optJSONArray("summary")
          if (summary != null) for (j in 0 until summary.length()) {
            reasoning.append(summary.getJSONObject(j).optString("text"))
          }
          val content = item.optJSONArray("content")
          if (content != null) for (j in 0 until content.length()) {
            reasoning.append(content.getJSONObject(j).optString("text"))
          }
        }
      }
    }
    return JSONObject().put("role", "assistant").put("content", text.toString())
      .put("tool_calls", calls).put("reasoning_content", reasoning.toString())
  }

  private fun anthropicResult(root: JSONObject): JSONObject {
    val content = root.optJSONArray("content") ?: JSONArray(); val calls = JSONArray()
    val text = StringBuilder(); val reasoning = StringBuilder()
    for (i in 0 until content.length()) {
      val item = content.getJSONObject(i)
      when (item.optString("type")) {
        "text" -> text.append(item.optString("text"))
        "thinking" -> reasoning.append(item.optString("thinking"))
        "tool_use" -> calls.put(JSONObject().put("id", item.optString("id")).put("type", "function")
          .put("function", JSONObject().put("name", item.optString("name"))
            .put("arguments", item.optJSONObject("input")?.toString() ?: "{}")))
      }
    }
    return JSONObject().put("role", "assistant").put("content", text.toString())
      .put("tool_calls", calls).put("reasoning_content", reasoning.toString())
  }
}

internal class RepairModelFailure(message: String) : Exception(message)
