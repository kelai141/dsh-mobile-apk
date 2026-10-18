package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject

/**
 * Normalizes tool calls returned by OpenAI-compatible gateways.
 *
 * Some gateways serialize DeepSeek's textual DSML tool syntax into the assistant
 * content instead of the standard `tool_calls` array. The repair client uses the
 * same bounded tool loop for both forms; the markup is never rendered as chat.
 */
internal object RepairToolCallParser {
  const val INTERRUPTED_TOOL_RESULT = "工具调用已取消：修复任务停止，结果未返回。"
  private val flags = setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE)
  private val invokeBlock = Regex(
    """<\s*\|\s*DSML\s*\|\s*invoke\b([^>]*)>(.*?)<\s*/\s*\|\s*DSML\s*\|\s*invoke\s*>""",
    flags,
  )
  private val parameterBlock = Regex(
    """<\s*\|\s*DSML\s*\|\s*parameter\b([^>]*)>(.*?)<\s*/\s*\|\s*DSML\s*\|\s*parameter\s*>""",
    flags,
  )
  private val nameAttribute = Regex(
    """\bname\s*=\s*(?:"([^"]*)"|'([^']*)')""",
    RegexOption.IGNORE_CASE,
  )
  private val stringAttribute = Regex(
    """\bstring\s*=\s*(?:"(true|false)"|'(true|false)'|(true|false))""",
    RegexOption.IGNORE_CASE,
  )
  private val anyDsmlTag = Regex(
    """<\s*/?\s*\|\s*DSML\s*\|[^>]*>""",
    RegexOption.IGNORE_CASE,
  )

  /** Adds parsed calls to an assistant message and removes protocol markup from its text. */
  fun normalize(message: JSONObject): JSONObject {
    // Some compatible gateways return no role on a successful assistant
    // message. Preserve the provider text and calls, but restore the protocol
    // role so the next request can pair every tool result.
    if (message.optString("role").isBlank()) message.put("role", "assistant")
    val content = message.optString("content", "")
    val existing = message.optJSONArray("tool_calls") ?: JSONArray()
    val calls = if (existing.length() == 0) parseDsml(content) else existing
    // Textual DSML is not a protocol-level tool call. Sending a fabricated
    // tool_call_id back to the gateway makes the next request fail with
    // "tool calls and tool results do not match". Keep the parsed calls so the
    // repair loop can execute them, but mark the message so the loop can return
    // their observations as ordinary user text instead of a tool role.
    if (existing.length() == 0 && calls.length() > 0) {
      message.put("repair_textual_tool_calls", true)
    }
    message.put("content", visibleText(content))
    message.put("tool_calls", calls)
    return message
  }

  fun textualToolCalls(message: JSONObject): Boolean =
    message.optBoolean("repair_textual_tool_calls", false)

  /**
   * Closes a provider-issued tool batch that a stop, process death, or older
   * client left without every result. The assistant response and all existing
   * results stay byte-for-byte unchanged; only truthful cancellation results are
   * appended for calls that never returned. This keeps a durable conversation
   * resumable without rewriting its provider context.
   */
  fun completeInterruptedTail(
    messages: JSONArray,
    cancellation: String = INTERRUPTED_TOOL_RESULT,
  ): Boolean {
    var assistantIndex = -1
    for (index in messages.length() - 1 downTo 0) {
      val role = messages.getJSONObject(index).optString("role")
      if (role == "tool") continue
      if (role == "assistant") assistantIndex = index
      break
    }
    if (assistantIndex < 0) return false
    val assistant = messages.getJSONObject(assistantIndex)
    val calls = assistant.optJSONArray("tool_calls") ?: return false
    if (calls.length() == 0) return false
    val ids = LinkedHashSet<String>()
    for (index in 0 until calls.length()) {
      calls.optJSONObject(index)?.optString("id")?.takeIf { it.isNotBlank() }?.let(ids::add)
    }
    if (ids.isEmpty()) return false
    val seen = LinkedHashSet<String>()
    for (index in assistantIndex + 1 until messages.length()) {
      val message = messages.getJSONObject(index)
      if (message.optString("role") != "tool") break
      message.optString("tool_call_id").takeIf { it in ids }?.let(seen::add)
    }
    val missing = ids.filter { it !in seen }
    if (missing.isEmpty()) return false
    for (id in missing) {
      messages.put(
        JSONObject().put("role", "tool").put("tool_call_id", id).put("content", cancellation),
      )
    }
    return true
  }

  /** Removes client-only markers and repairs tool history before sending it back. */
  fun outboundHistory(messages: JSONArray): JSONArray {
    val result = JSONArray()
    var pending: PendingCalls? = null
    for (i in 0 until messages.length()) {
      val message = JSONObject(messages.getJSONObject(i).toString())
      if (message.optString("role").isBlank()) message.put("role", "assistant")
      val textual = message.optBoolean("repair_textual_tool_calls", false)
      message.remove("repair_textual_tool_calls")
      // DSML was only text in the provider response. Exposing synthesized calls
      // in the assistant history makes the gateway require a tool result with an
      // id it never issued. The observation is already present as the next user
      // message, so the outbound assistant must remain a plain text message.
      if (textual) message.remove("tool_calls")
      val role = message.optString("role")
      when (role) {
        "assistant" -> {
          flushPending(result, pending)
          pending = null
          // Only calls completed by a following tool result may leave this
          // boundary. Keeping a provider call whose result is absent makes the
          // next request fail before the model can recover.
          // A normal assistant answer is part of the provider transcript. An
          // absent or empty tool_calls field must not erase its text or
          // reasoning; both fields are protocol input on the next request and
          // changing them also destroys the provider's prompt-cache prefix.
          val calls = message.optJSONArray("tool_calls")
          if (calls == null || calls.length() == 0) {
            message.remove("tool_calls")
            result.put(message)
            continue
          }
          val ids = LinkedHashSet<String>()
          for (j in 0 until calls.length()) {
            val call = calls.optJSONObject(j) ?: continue
            val id = call.optString("id")
            if (id.isNotBlank() && call.optJSONObject("function") != null) ids += id
          }
          if (ids.size != calls.length()) {
            message.remove("tool_calls")
            result.put(message)
            continue
          }
          pending = PendingCalls(message, ids)
        }
        "tool" -> {
          val batch = pending ?: continue
          val id = message.optString("tool_call_id")
          if (id !in batch.ids || !batch.seen.add(id)) continue
          batch.results.put(message)
          if (batch.seen == batch.ids) {
            flushPending(result, batch)
            pending = null
          }
        }
        else -> {
          flushPending(result, pending)
          pending = null
          result.put(message)
        }
      }
    }
    flushPending(result, pending)
    return result
  }

  private data class PendingCalls(
    val assistant: JSONObject,
    val ids: Set<String>,
    val seen: MutableSet<String> = LinkedHashSet(),
    val results: JSONArray = JSONArray(),
  )

  /** Appends a complete native pair or preserves prose without an orphan result. */
  private fun flushPending(out: JSONArray, pending: PendingCalls?) {
    if (pending == null) return
    if (pending.seen != pending.ids) {
      out.put(pending.assistant)
      // Preserve the provider-issued assistant response. A request cannot carry
      // only part of a tool batch, so project truthful cancellation results for
      // calls that have not returned yet. The canonical history is left alone.
      for (id in pending.ids) {
        if (id in pending.seen) continue
        out.put(
          JSONObject().put("role", "tool").put("tool_call_id", id)
            .put("content", INTERRUPTED_TOOL_RESULT),
        )
      }
      return
    }
    out.put(pending.assistant)
    for (i in 0 until pending.results.length()) out.put(pending.results.getJSONObject(i))
  }

  /**
   * Compatibility projection for gateways that explicitly opt out of the
   * provider-native tool role. One completed batch becomes one stable user
   * observation, never several consecutive users. Assistant text and reasoning
   * stay byte-for-byte unchanged, and the canonical history is never mutated.
   */
  fun toolResultsAsUserObservations(messages: JSONArray): JSONArray {
    val result = JSONArray()
    var index = 0
    while (index < messages.length()) {
      val original = messages.getJSONObject(index)
      val role = original.optString("role")
      val calls = original.optJSONArray("tool_calls")
      if (role == "assistant" && calls != null) {
        val names = HashMap<String, String>()
        for (i in 0 until calls.length()) {
          val call = calls.optJSONObject(i) ?: continue
          val function = call.optJSONObject("function") ?: continue
          names[call.optString("id")] = function.optString("name")
        }
        val assistant = JSONObject(original.toString())
        assistant.remove("repair_textual_tool_calls")
        assistant.remove("tool_calls")
        // An empty assistant placeholder has no provider content and becomes an
        // invalid consecutive-user request. Preserve prose/reasoning, omit the
        // empty shell, and attach all results for this batch to one observation.
        if (assistant.optString("content").isNotBlank() ||
          assistant.optString("reasoning_content").isNotBlank()) {
          result.put(assistant)
        }
        var cursor = index + 1
        val observations = StringBuilder()
        while (cursor < messages.length()) {
          val next = messages.getJSONObject(cursor)
          if (next.optString("role") != "tool") break
          val callId = next.optString("tool_call_id")
          val name = names[callId].orEmpty().ifBlank { "tool" }
          if (observations.isNotEmpty()) observations.append("\n\n")
          observations.append("工具 ").append(name).append(" 的执行结果：\n")
            .append(next.optString("content", ""))
          cursor++
        }
        if (observations.isNotEmpty()) {
          result.put(JSONObject().put("role", "user").put("content", observations.toString()))
        }
        index = cursor
        continue
      }
      result.put(original)
      index++
    }
    return result
  }

  /** Parses the DSML invoke blocks emitted by some OpenAI-compatible gateways. */
  fun parseDsml(content: String): JSONArray {
    val calls = JSONArray()
    if (!content.contains("DSML", ignoreCase = true)) return calls
    invokeBlock.findAll(content).forEachIndexed { index, match ->
      val name = attribute(nameAttribute, match.groupValues[1])
      if (name.isBlank()) return@forEachIndexed
      val arguments = JSONObject()
      parameterBlock.findAll(match.groupValues[2]).forEach { parameter ->
        val attributes = parameter.groupValues[1]
        val key = attribute(nameAttribute, attributes)
        if (key.isBlank()) return@forEach
        val rawValue = parameter.groupValues[2]
        val stringValue = stringAttribute.find(attributes)?.let { result ->
          result.groupValues.drop(1).firstOrNull { it.isNotEmpty() }
        }
        arguments.put(key, typedValue(rawValue, stringValue))
      }
      calls.put(
        JSONObject()
          .put("id", "dsml-call-" + (index + 1))
          .put("type", "function")
          .put(
            "function",
            JSONObject().put("name", name).put("arguments", arguments.toString()),
          ),
      )
    }
    return calls
  }

  /** Removes textual tool protocol from anything that will be shown to the user. */
  fun visibleText(content: String): String {
    if (!content.contains("DSML", ignoreCase = true)) return content
    var text = invokeBlock.replace(content, "")
    text = parameterBlock.replace(text, "")
    text = anyDsmlTag.replace(text, "")
    return text.replace(Regex("""\n[ \t]*\n[ \t]*\n+"""), "\n\n").trim()
  }

  /** Tool-only turns may carry a punctuation placeholder instead of prose. */
  fun displayableText(content: String): String {
    val text = visibleText(content)
    return if (text.any { it.isLetterOrDigit() || it in "，。！？；：、（）【】《》“”‘’…—" }) text else ""
  }

  /** Converts the shared tool schema to the OpenAI Chat Completions envelope. */
  fun openAiTools(tools: JSONArray): JSONArray {
    val mapped = JSONArray()
    for (i in 0 until tools.length()) {
      val tool = tools.getJSONObject(i)
      mapped.put(
        JSONObject().put("type", "function").put(
          "function",
          JSONObject().put("name", tool.getString("name"))
            .put("description", tool.optString("description"))
            .put("parameters", tool.optJSONObject("parameters")),
        ),
      )
    }
    return mapped
  }

  private fun attribute(pattern: Regex, attributes: String): String {
    val match = pattern.find(attributes) ?: return ""
    return match.groupValues.drop(1).firstOrNull { it.isNotEmpty() }.orEmpty()
  }

  private fun typedValue(raw: String, stringFlag: String?): Any {
    if (stringFlag == null || stringFlag.equals("true", ignoreCase = true)) return raw
    val text = raw.trim()
    return when {
      text.equals("null", ignoreCase = true) -> JSONObject.NULL
      text.equals("true", ignoreCase = true) -> true
      text.equals("false", ignoreCase = true) -> false
      text.toLongOrNull() != null -> text.toLong()
      text.toDoubleOrNull() != null -> text.toDouble()
      else -> raw
    }
  }
}
