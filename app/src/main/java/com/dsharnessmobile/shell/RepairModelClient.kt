package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.PushbackInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.TreeMap
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * Streaming callbacks for one model request.
 *
 * The listener is optional: when it is null the client keeps the historical
 * single JSON request and response. When it is present every protocol asks the
 * server for SSE, but a gateway that ignores `stream: true` and answers with
 * plain JSON is consumed by the same request via the JSON fallback path.
 */
internal interface RepairStreamListener {
  fun onReasoningDelta(delta: String) {}
  fun onTextDelta(delta: String) {}
}

/** One bounded model request. It never opens a browser, Node process, or engine dependency. */
internal class RepairModelClient {
  /** anthropic 分支的 token 常量（issue #1015；详见 [anthropicTokenPlan]）。 */
  internal companion object {
    /** 不留思考预算时（effort=off/null）的回复上限。与原硬写值一致，保持既有行为不变。 */
    const val ANTHROPIC_MAX_TOKENS_DEFAULT = 8192

    /** 思考预算之外留给正式回答的空间：只留 budget+1 会让回答被截断。 */
    const val ANTHROPIC_OUTPUT_HEADROOM = 8192

    /** 回复上限的天花板：防止高档位把 max_tokens 推到端点拒绝的数值。 */
    const val ANTHROPIC_MAX_TOKENS_CEILING = 32768

  /**
   * 一次模型请求（含一次重试）的总时长预算，issue #1370。
   *
   * 读超时本身是 180s；重试存在的意义只是「连接废了、请求没送达」，那种失败通常几十毫秒就回来。
   * 所以预算取一个读超时的量级：第一次已经耗掉超过它就不再重试，杜绝 2×180s。
   */
  const val RETRY_TOTAL_BUDGET_MS = 180_000L

    /** 单次响应（普通 JSON 或整条 SSE 流）的字节上限。 */
    private const val MAX_RESPONSE_BYTES = 2_000_000

    private val REASONING_FIELDS = listOf("reasoning_content", "reasoning", "reasoning_text")
  }

  private val active = AtomicReference<HttpURLConnection?>(null)

  /**
   * 请求级取消标记。cancel() 之后读循环、重试判定与所有回调都看它；
   * 回调与 cancel() 共用 callbackLock，保证 cancel() 返回后不会再出现晚到回调。
   */
  @Volatile private var cancelled = false

  private val callbackLock = Any()

  @Volatile internal var lastOutboundDigest: String = ""
    private set
  @Volatile internal var lastOutboundMessages: Int = 0
    private set

  fun cancel() {
    synchronized(callbackLock) { cancelled = true }
    active.getAndSet(null)?.disconnect()
  }

  fun complete(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    reasoningEffort: String? = connection.defaultReasoningEffort,
    streamListener: RepairStreamListener? = null,
  ): JSONObject {
    require(connection.apiKey.isNotBlank()) { "模型凭据不在内存中；请重新打开修复助手" }
    if (cancelled) throw InterruptedException()
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
    val streaming = streamListener != null
    val body = when (connection.api) {
      "anthropic-messages" -> anthropicBody(connection, outbound, tools, effort, streaming)
      "openai-responses" -> responsesBody(connection, outbound, tools, effort, streaming)
      else -> completionsBody(connection, outbound, tools, effort, streaming)
    }
    val state = AttemptState()
    val response = postWithRetry(
      connection, endpoint, body, RETRY_TOTAL_BUDGET_MS, { 0L }, streamListener, state,
    )
    gatewayErrorOf(response, connection.apiKey)?.let { throw RepairModelFailure(it) }
    val parsed = JSONObject(response)
    val result = when (connection.api) {
      "anthropic-messages" -> anthropicResult(parsed)
      "openai-responses" -> responsesResult(parsed)
      else -> completionsResult(parsed)
    }
    val normalized = RepairToolCallParser.normalize(result)
    if (streamListener != null) {
      if (!state.emittedReasoning) {
        val reasoning = RepairToolCallParser.reasoningText(normalized)
        if (reasoning.isNotBlank()) emitFinalReasoning(streamListener, state, reasoning)
      }
      if (!state.emittedText) {
        val text = contentText(normalized)
        if (text.isNotBlank()) emitFinalText(streamListener, state, text)
      }
    }
    return normalized
  }

  internal fun endpointFor(connection: RepairModelConnection): String {
    val base = normalizeModelBase(connection.baseUrl)
    require(base != null) { "模型端点必须是 http(s) 地址，且不得内嵌账号密码" }
    val suffix = when (connection.api) {
      "anthropic-messages" -> if (base.substringBefore('?').endsWith("/v1")) "/messages" else "/v1/messages"
      "openai-responses" -> "/responses"
      else -> "/chat/completions"
    }
    return appendEndpointPath(base, suffix)
  }

  /**
   * 把请求路径拼到 base 上，且**把 base 自带的查询串留在最末**。
   *
   * 自部署网关常用 `http://host:8000/v1?token=…` 这种形态；直接 `base + "/chat/completions"`
   * 会拼出 `…?token=…/chat/completions`（查询串把路径吃进去），请求必然打错地方。
   * 这里先切出 path 再拼，最后接回原查询串与片段。
   *
   * @param base 已规范化的基址（可含查询串与片段）。
   * @param suffix 要追加的路径，必须以 `/` 开头。
   * @returns 可直接请求的完整端点。
   */
  internal fun appendEndpointPath(base: String, suffix: String): String {
    val hash = base.indexOf('#')
    val head = if (hash >= 0) base.substring(0, hash) else base
    val tail = if (hash >= 0) base.substring(hash) else ""
    val query = head.indexOf('?')
    return if (query < 0) head + suffix + tail
    else head.substring(0, query) + suffix + head.substring(query) + tail
  }

  /**
   * 抹掉文本里任何 URL 的查询串。
   *
   * 放宽到明文 HTTP 之后，端点可能长成 `http://host:8000/v1?token=…`：底层异常消息会把整条 URL
   * 带出来，而修复助手的失败文案会进聊天记录、`repair-model-source.json` 与共享诊断包。
   * 查询串里恰恰是自部署网关最常见的放 key 位置，所以**一律不保留查询串内容**，只留路径。
   *
   * 凭据（userinfo）在准入层已被拒绝，不会出现在 URL 里；这里只处理查询串与片段。
   *
   * @param text 可能含 URL 的任意文本（通常是异常消息）。
   * @returns 查询串被替换为 `?<redacted>` 的文本。
   */
  internal fun redactUrlQuery(text: String): String {
    val withoutQuery = Regex("(https?://[^\\s?#]+)\\?[^\\s#]*").replace(text) { it.groupValues[1] + "?<redacted>" }
    return Regex("(https?://[^\\s#]+)#[^\\s]*").replace(withoutQuery) { it.groupValues[1] + "#<redacted>" }
  }

  /**
   * 模型端点准入与规范化。
   *
   * 用户 2026-11-01 明确要求：**允许本地地址与明文 HTTP**（自部署模型很常见）。旧实现只放行
   * `https://` 与两个回环字面量，于是自建网关（`http://192.168.x.x:8000/v1`、内网域名、
   * `http://host:8000/v1`）在修复助手里一律被判「端点不合法」——引擎那边能用的配置，助手用不了。
   *
   * 取舍是显式的：明文 HTTP 的代价（同网段可被动嗅探/篡改凭据与内容）由用户自担，平台侧
   * `network_security_config` 的 base-config 早已 `cleartextTrafficPermitted="true"`（见该文件
   * 0.14.1 注释），所以这里是「准入面与平台面重新对齐」，不是新开一个口子。
   *
   * 仍然拒绝三类：非 http(s) scheme（file/javascript/data 等）、空 host、URL 里内嵌
   * `user:pass@`（凭据会随请求发到第三方日志里）。
   *
   * @param raw 配置里的 baseURL 原文。
   * @returns 去掉末尾斜杠、保留显式端口与路径前缀（含 IPv6 方括号）的基址；不合法返回 null。
   */
  internal fun normalizeModelBase(raw: String): String? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    val lower = text.lowercase()
    val scheme = when {
      lower.startsWith("https://") -> "https://"
      lower.startsWith("http://") -> "http://"
      else -> return null
    }
    val rest = text.substring(scheme.length)
    // user:pass@host 形态：凭据会被写进 Authorization 之外的 URL，可能落到对端日志与重定向里。
    val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
    if (authority.contains('@')) return null
    val host = when {
      authority.startsWith("[") -> {
        val close = authority.indexOf(']')
        if (close <= 1) return null
        authority.substring(0, close + 1)
      }
      else -> authority.substringBefore(':')
    }
    if (host.isEmpty() || host == "[]") return null
    // 保留显式端口、路径前缀与 IPv6 方括号，只收敛末尾斜杠。
    return (scheme + rest).trimEnd('/')
  }

  internal fun completionsBody(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    effort: String?,
    stream: Boolean = false,
  ): String {
    // OpenAI-compatible chat endpoints require every tool to be wrapped in a
    // `{type:function, function:{...}}` envelope. Sending the bare Anthropic-like
    // schema let some gateways accept the request but silently ignore the tools,
    // which made the model print DSML markup into assistant content instead.
    // An explicitly configured route may project observations before this point.
    val outgoing = JSONArray(messages.toString())
    for (i in 0 until outgoing.length()) {
      val message = outgoing.optJSONObject(i) ?: continue
      // 私有协议回放字段只属于各自的协议路由；跨协议发送时不能把未知字段带给网关。
      message.remove("_anthropic_blocks")
      message.remove("_responses_items")
      if (message.optString("role") != "assistant") continue
      // Android 的 org.json 会把 JSONObject.NULL 渲染成字面量 "null"。
      // 出站前把空正文收敛为空串，并让 reasoning_content 从任一别名取真值，
      // 否则 "null" 会遮蔽 reasoning/reasoning_text，或把空正文当正文发给网关。
      val rawContent = message.opt("content")
      if (rawContent == null || rawContent == JSONObject.NULL ||
        (rawContent is String && rawContent.trim() == "null")
      ) {
        message.put("content", "")
      }
      val reasoning = reasoningField(message)
      if (reasoning.isNotEmpty()) {
        message.put("reasoning_content", reasoning)
      } else {
        val existing = message.opt("reasoning_content")
        if (existing == null || existing == JSONObject.NULL ||
          (existing is String && existing.trim() == "null")
        ) {
          message.remove("reasoning_content")
          if (connection.requiresReasoningContentOnAssistantMessages) {
            message.put("reasoning_content", "")
          }
        }
      }
    }
    val body = JSONObject().put("model", connection.model).put("messages", outgoing)
      .put("tools", RepairToolCallParser.openAiTools(tools))
      .put("tool_choice", "auto").put("stream", stream)
    applyReasoning(connection, body, effort)
    body.put(connection.maxTokensField ?: "max_tokens", 8192)
    return body.toString()
  }

  internal fun responsesBody(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    effort: String?,
    stream: Boolean = false,
  ): String {
    val input = JSONArray()
    val mappedTools = JSONArray()
    var system = ""
    for (i in 0 until messages.length()) {
      val m = messages.getJSONObject(i)
      when (m.optString("role")) {
        "system" -> system += contentText(m) + "\n"
        "tool" -> input.put(
          JSONObject().put("type", "function_call_output")
            .put("call_id", m.optString("tool_call_id")).put("output", contentText(m)),
        )
        else -> {
          val native = m.optJSONArray("_responses_items")
          if (m.optString("role") == "assistant" && native != null && native.length() > 0) {
            // 同协议回放优先使用 provider 原生 output item：reasoning item 的
            // encrypted_content 与原始顺序都必须逐字保留，否则下一轮网关会因
            // 缺少加密推理或 item 次序变化而 400。
            var hasFunctionCall = false
            var hasMessage = false
            for (j in 0 until native.length()) {
              val item = native.optJSONObject(j) ?: continue
              when (item.optString("type")) {
                "function_call" -> hasFunctionCall = true
                "message" -> hasMessage = true
              }
              input.put(JSONObject(item.toString()))
            }
            if (!hasMessage && contentText(m).isNotBlank()) {
              input.put(JSONObject().put("role", "assistant").put("content", contentText(m)))
            }
            if (!hasFunctionCall) appendResponsesCalls(m, input)
          } else {
            val content = contentText(m)
            if (content.isNotBlank()) input.put(JSONObject().put("role", m.optString("role")).put("content", content))
            appendResponsesCalls(m, input)
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
    if (stream) body.put("stream", true)
    if (effort != null && effort != "off") {
      body.put("reasoning", JSONObject().put("effort", effort))
    }
    return body.toString()
  }

  private fun appendResponsesCalls(message: JSONObject, input: JSONArray) {
    val calls = message.optJSONArray("tool_calls") ?: return
    for (j in 0 until calls.length()) {
      val call = calls.optJSONObject(j) ?: continue
      val fn = call.optJSONObject("function") ?: continue
      input.put(
        JSONObject().put("type", "function_call").put("call_id", call.optString("id"))
          .put("name", fn.optString("name"))
          .put("arguments", fieldText(fn, "arguments").ifBlank { "{}" }),
      )
    }
  }

  internal fun anthropicBody(
    connection: RepairModelConnection,
    messages: JSONArray,
    tools: JSONArray,
    effort: String?,
    stream: Boolean = false,
  ): String {
    val system = StringBuilder()
    val converted = JSONArray()
    var pendingResults: JSONArray? = null

    fun flushToolResults() {
      val results = pendingResults ?: return
      if (results.length() > 0) {
        converted.put(JSONObject().put("role", "user").put("content", results))
      }
      pendingResults = null
    }

    for (i in 0 until messages.length()) {
      val m = messages.getJSONObject(i)
      when (m.optString("role")) {
        "system" -> system.append(contentText(m)).append("\n")
        "tool" -> {
          // 同一轮并行的多个 tool 消息必须是**一条** user 消息的多个 tool_result
          // 块。拆成多条连续 user 消息会被 Anthropic 判为角色不交替而 400。
          val results = pendingResults ?: JSONArray().also { pendingResults = it }
          results.put(
            JSONObject().put("type", "tool_result").put("tool_use_id", m.optString("tool_call_id"))
              .put("content", contentText(m)),
          )
        }
        "assistant" -> {
          flushToolResults()
          converted.put(JSONObject().put("role", "assistant").put("content", anthropicAssistantBlocks(m)))
        }
        else -> {
          flushToolResults()
          converted.put(JSONObject().put("role", "user").put("content", contentText(m)))
        }
      }
    }
    flushToolResults()
    val anthTools = JSONArray()
    for (i in 0 until tools.length()) {
      val t = tools.getJSONObject(i)
      anthTools.put(JSONObject().put("name", t.getString("name")).put("description", t.optString("description"))
        .put("input_schema", t.optJSONObject("parameters")))
    }
    // issue #1015：max_tokens 与 budget_tokens 必须是**同一个约束下的两个值**，不能各写一张表。
    // Anthropic 协议要求 budget_tokens **严格小于** max_tokens；旧实现把 max_tokens 硬写成 8192，
    // 而 effortBudget 的 high=8192 / xhigh,max=16384 ⇒ 这三档必然违规，端点回 400。
    // 现在由 anthropicTokenPlan() 一处决定二者，从结构上消除「两张表互相不知道」的可能。
    val plan = anthropicTokenPlan(effort)
    val body = JSONObject().put("model", connection.model).put("max_tokens", plan.maxTokens)
      .put("messages", converted).put("tools", anthTools)
    if (stream) body.put("stream", true)
    if (system.isNotBlank()) body.put("system", system.toString())
    if (plan.budgetTokens != null) {
      body.put("thinking", JSONObject().put("type", "enabled").put("budget_tokens", plan.budgetTokens))
    }
    return body.toString()
  }

  private fun anthropicAssistantBlocks(message: JSONObject): JSONArray {
    val native = message.optJSONArray("_anthropic_blocks")
    if (native != null && native.length() > 0) return JSONArray(native.toString())
    // 旧会话没有原块时的既有拼装逻辑：思考文本、正文、工具调用按此顺序重建。
    val contents = JSONArray()
    val reasoning = reasoningField(message)
    if (reasoning.isNotBlank()) {
      contents.put(JSONObject().put("type", "thinking").put("thinking", reasoning))
    }
    val text = contentText(message)
    if (text.isNotBlank() && text.trim() != "null") {
      contents.put(JSONObject().put("type", "text").put("text", text))
    }
    val calls = message.optJSONArray("tool_calls") ?: JSONArray()
    for (j in 0 until calls.length()) {
      val call = calls.getJSONObject(j)
      val fn = call.getJSONObject("function")
      val input = runCatching { JSONObject(fieldText(fn, "arguments").ifBlank { "{}" }) }.getOrDefault(JSONObject())
      contents.put(JSONObject().put("type", "tool_use").put("id", call.getString("id"))
        .put("name", fn.getString("name")).put("input", input))
    }
    return contents
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

  /**
   * anthropic 分支要发的两个 token 参数（issue #1015）。
   *
   * [maxTokens] 是回复上限，[budgetTokens] 是思考预算；**不变量：budgetTokens 恒小于 maxTokens**。
   * null 表示本档不启用思考（effort 为 null / "off"）。
   */
  internal data class AnthropicTokenPlan(val maxTokens: Int, val budgetTokens: Int?)

  /**
   * 由推理档位算出「合法的」max_tokens + budget_tokens（issue #1015）。
   *
   * 缺陷现场：旧实现把 max_tokens 硬写成 8192，而思考预算另有一张 fixed 表
   * （high=8192、xhigh/max=16384），两张表互不知道对方 ⇒ high 档 budget==max、
   * xhigh/max 档 budget>max，二者都违反 Anthropic「budget_tokens 必须严格小于 max_tokens」，
   * 端点直接回 400。而真实配置把 reasoningEffort 默认 pin 成 max，所以打开助手即中招。
   *
   * 修法不是「把 8192 调大」——那只是把冲突推给下一个更高的档位。这里改成**单一真源**：
   * 先按档位定思考预算，再由「预算 + 预留输出」推出 max_tokens，二者永远满足约束。
   * `ANTHROPIC_OUTPUT_HEADROOM` 是留给正式回答的空间：思考用完预算后还要输出结果，
   * 只把 max_tokens 设成 budget+1 会让回复被截断。
   *
   * @return maxTokens 恒 > budgetTokens（有预算时）；无预算时 budgetTokens 为 null。
   */
  internal fun anthropicTokenPlan(effort: String?): AnthropicTokenPlan {
    if (effort == null || effort == "off") {
      return AnthropicTokenPlan(maxTokens = ANTHROPIC_MAX_TOKENS_DEFAULT, budgetTokens = null)
    }
    val budget = effortBudget(effort)
    val max = (budget + ANTHROPIC_OUTPUT_HEADROOM).coerceAtMost(ANTHROPIC_MAX_TOKENS_CEILING)
    // 上限夹紧后仍必须满足「严格小于」：极高档位撞到 ceiling 时把预算压回 max-1。
    val safeBudget = if (budget < max) budget else (max - 1).coerceAtLeast(1)
    return AnthropicTokenPlan(maxTokens = max, budgetTokens = safeBudget)
  }

  /** 档位 -> 思考预算。这是**唯一**的档位表；max_tokens 由它派生（见 anthropicTokenPlan）。 */
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

  private fun post(
    connection: RepairModelConnection,
    endpoint: String,
    body: String,
    streamListener: RepairStreamListener?,
    state: AttemptState,
  ): String {
    state.beginAttempt()
    if (cancelled) throw InterruptedException()
    val conn = URL(endpoint).openConnection() as HttpURLConnection
    active.set(conn)
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 20_000
      conn.readTimeout = 180_000
      conn.instanceFollowRedirects = false
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty(
        "Accept",
        if (streamListener != null) "text/event-stream, application/json" else "application/json",
      )
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
      state.responseReceived = true
      if (code in 300..399) {
        throw RepairModelFailure("模型端点返回重定向（HTTP $code）；为避免凭据发送到其它域，已拒绝跟随")
      }
      if (code !in 200..299) {
        val errorText = conn.errorStream?.let { readBounded(it) { cancelled } }.orEmpty()
        throw RepairModelFailure(
          "模型请求失败（HTTP $code）：" + errorText.replace(connection.apiKey, "***").take(300),
        )
      }
      val (sse, input) = openResponseBody(conn)
      if (sse) {
        return parseSse(connection, input, streamListener, state)
      }
      val text = readBounded(input) { cancelled }.removePrefix("\uFEFF")
      if (text.isBlank()) throw RepairModelFailure("模型返回空响应")
      return text
    } catch (e: InterruptedException) {
      throw e
    } catch (e: RepairModelFailure) {
      if (cancelled) throw InterruptedException()
      throw e
    }
    // 异常消息常带完整 URL：查询串必须抹掉再进文案（见 redactUrlQuery）。
    catch (e: Exception) {
      if (cancelled) throw InterruptedException()
      throw RepairModelFailure("模型连接失败：" + redactUrlQuery(e.message ?: e.javaClass.simpleName))
    } finally {
      active.compareAndSet(conn, null)
      conn.disconnect()
    }
  }

  /**
   * 2xx 之后用 Content-Type 或有界预读判断响应形态。
   *
   * 预读只吞掉空白/BOM 与第一个有意义字节，并全部 unread 回去，因此普通 JSON
   * 回退与 SSE 都从完整字节流开始读，绝不会为了判断形态丢掉响应开头。
   */
  private fun openResponseBody(conn: HttpURLConnection): Pair<Boolean, InputStream> {
    val pushback = PushbackInputStream(conn.inputStream, 256)
    val prefix = ByteArrayOutputStream()
    var significant = -1
    while (prefix.size() < 256) {
      val b = pushback.read()
      if (b < 0) break
      prefix.write(b)
      if (b == 0xEF || b == 0xBB || b == 0xBF) continue
      val ch = b.toChar()
      if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') continue
      significant = b
      break
    }
    if (significant < 0) throw RepairModelFailure("模型返回空响应")
    pushback.unread(prefix.toByteArray())
    val contentType = conn.contentType.orEmpty().lowercase()
    val sse = when {
      contentType.contains("text/event-stream") -> true
      significant == '{'.code || significant == '['.code -> false
      else -> true
    }
    return sse to pushback
  }

  private fun readBounded(input: InputStream, stopped: () -> Boolean = { false }): String {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0
    while (true) {
      if (stopped()) throw InterruptedException()
      val n = input.read(buffer)
      if (n < 0) break
      total += n
      if (total > MAX_RESPONSE_BYTES) throw RepairModelFailure("模型响应过大")
      out.write(buffer, 0, n)
    }
    return out.toByteArray().toString(StandardCharsets.UTF_8)
  }

  private fun parseSse(
    connection: RepairModelConnection,
    input: InputStream,
    listener: RepairStreamListener?,
    state: AttemptState,
  ): String {
    val accumulator: SseAccumulator = when (connection.api) {
      "anthropic-messages" -> AnthropicSseAccumulator(connection, listener, state)
      "openai-responses" -> ResponsesSseAccumulator(connection, listener, state)
      else -> ChatSseAccumulator(connection, listener, state)
    }
    val reader = SseLineReader(input, MAX_RESPONSE_BYTES) { cancelled }
    var event = ""
    val data = StringBuilder()
    var terminal = false
    while (!terminal) {
      if (cancelled) throw InterruptedException()
      val line = reader.readLine() ?: break
      if (line.isEmpty()) {
        if (data.isNotEmpty() || event.isNotEmpty()) {
          terminal = accumulator.accept(event, data.toString())
          event = ""
          data.setLength(0)
        }
        continue
      }
      if (line.startsWith(":")) continue
      val colon = line.indexOf(':')
      val field = if (colon < 0) line else line.substring(0, colon)
      var value = if (colon < 0) "" else line.substring(colon + 1)
      if (value.startsWith(" ")) value = value.substring(1)
      when (field) {
        "event" -> event = value
        "data" -> {
          if (data.isNotEmpty()) data.append('\n')
          data.append(value)
        }
      }
    }
    if (!terminal && (data.isNotEmpty() || event.isNotEmpty())) {
      terminal = accumulator.accept(event, data.toString())
    }
    if (!terminal) throw RepairModelFailure("模型流式响应中断：未收到终止事件")
    val payload = accumulator.payload().toString()
    flushFilters(listener, state)
    return payload
  }

  private fun flushFilters(listener: RepairStreamListener?, state: AttemptState) {
    if (listener == null) return
    val textTail = state.textFilter.finish()
    if (textTail.isNotEmpty()) emitFinalText(listener, state, textTail)
    val reasoningTail = state.reasoningFilter.finish()
    if (reasoningTail.isNotEmpty()) emitFinalReasoning(listener, state, reasoningTail)
  }

  private fun postWithRetry(
    connection: RepairModelConnection,
    endpoint: String,
    body: String,
    elapsedBudgetMs: Long,
    elapsed: () -> Long,
    streamListener: RepairStreamListener?,
    state: AttemptState,
  ): String {
    val started = System.nanoTime()
    var attempts = 0
    while (true) {
      try {
        return post(connection, endpoint, body, streamListener, state)
      } catch (failure: RepairModelFailure) {
        if (cancelled) throw failure
        if (!isTransientTransportFailure(failure.message.orEmpty())) throw failure
        // 只有在 HTTP 响应与首帧回调都尚未到达时才允许原样重发一次。
        // 流已经开始后断流既不重试（避免重复生成/重复计费），也不吞掉已有回调。
        if (state.responseReceived || state.streamStarted || state.emittedText || state.emittedReasoning) {
          throw failure
        }
        // 已经耗掉的时间 + 这次剩余预算：超了就不重试（防止 2×180s 的尾巴）
        val spent = elapsed().coerceAtLeast((System.nanoTime() - started) / 1_000_000L)
        if (spent >= elapsedBudgetMs || attempts >= 1) throw failure
        attempts++
      }
    }
  }

  /**
   * A dropped keep-alive socket can fail before the server accepts the body.
   * Retry one idempotent, byte-identical model request; protocol errors and
   * HTTP responses are never retried because they already carry a diagnosis.
   *
   * issue #1370：**读超时不在可重试之列**。`readTimeout` 是 180s，把它算作 transient 会让
   * 单次请求最坏 2×180s，而且网关在超时后可能已经收到并处理了第一次请求 —— 重发等于让模型
   * 重复生成、用户重复计费。重试只留给「连上之前/连接被对端掐断」这类**没送达**的失败。
   * 另外这道闸还有总时长上限：第一次已经花掉的时间计入预算，超预算就不再重试。
   */
  internal fun postWithOneTransientRetry(
    connection: RepairModelConnection,
    endpoint: String,
    body: String,
    elapsedBudgetMs: Long = RETRY_TOTAL_BUDGET_MS,
    elapsed: () -> Long = { 0L },
    streamListener: RepairStreamListener? = null,
  ): String = postWithRetry(connection, endpoint, body, elapsedBudgetMs, elapsed, streamListener, AttemptState())

  /**
   * 哪些传输失败值得原样重发一次。
   *
   * 判据是**请求有没有可能已经送达**：
   *   · 可重试：连接建立前的拒绝 / 对端在响应前掐断（keep-alive 复用最常见的形态）——
   *     服务端要么没收到，要么明确没给结果；
   *   · 不可重试：`timed out` / `timeout` —— 读超时意味着我们**已经发出去了**，只是没等到回音，
   *     重发会让模型重复生成（issue #1370）。
   */
  internal fun isTransientTransportFailure(message: String): Boolean {
    if (!message.startsWith("模型连接失败：")) return false
    val detail = message.lowercase()
    return listOf(
      "socket closed", "connection reset", "broken pipe", "unexpected end of stream",
      "unexpected end of file", "connection refused", "connection aborted", "eof",
    ).any { detail.contains(it) }
  }

  internal fun completionsResult(root: JSONObject): JSONObject {
    val choice = root.optJSONArray("choices")?.optJSONObject(0)
      ?: throw RepairModelFailure("模型响应缺少 choices")
    val message = choice.optJSONObject("message") ?: throw RepairModelFailure("模型响应缺少 message")
    val reasoning = reasoningField(message)
    message.put("content", contentText(message))
    if (reasoning.isNotEmpty()) {
      message.put("reasoning_content", reasoning)
    } else if (message.opt("reasoning_content") == JSONObject.NULL ||
      (message.opt("reasoning_content") is String &&
        (message.optString("reasoning_content").trim() == "null" || message.optString("reasoning_content").isBlank()))
    ) {
      message.put("reasoning_content", "")
    }
    return message
  }

  internal fun responsesResult(root: JSONObject): JSONObject {
    val status = fieldText(root, "status")
    if (status == "failed" || status == "incomplete") {
      val detail = responseFailureDetail(root)
      throw RepairModelFailure(
        if (status == "failed") "模型响应失败：" + detail else "模型响应不完整：" + detail,
      )
    }
    val output = root.optJSONArray("output") ?: throw RepairModelFailure("模型响应缺少 output")
    if (output.length() == 0) throw RepairModelFailure("模型响应 output 为空")
    val calls = JSONArray()
    val text = StringBuilder()
    val reasoning = StringBuilder()
    for (i in 0 until output.length()) {
      val item = output.optJSONObject(i) ?: continue
      when (item.optString("type")) {
        "message" -> {
          val content = item.optJSONArray("content") ?: JSONArray()
          for (j in 0 until content.length()) {
            val part = content.optJSONObject(j) ?: continue
            text.append(fieldText(part, "text"))
          }
        }
        "function_call" -> calls.put(
          JSONObject().put("id", fieldText(item, "call_id")).put("type", "function")
            .put(
              "function",
              JSONObject().put("name", fieldText(item, "name"))
                .put("arguments", fieldText(item, "arguments").ifBlank { "{}" }),
            ),
        )
        "reasoning" -> {
          val summary = item.optJSONArray("summary")
          if (summary != null) for (j in 0 until summary.length()) {
            reasoning.append(fieldText(summary.optJSONObject(j) ?: JSONObject(), "text"))
          }
          val content = item.optJSONArray("content")
          if (content != null) for (j in 0 until content.length()) {
            reasoning.append(fieldText(content.optJSONObject(j) ?: JSONObject(), "text"))
          }
        }
      }
    }
    return JSONObject().put("role", "assistant").put("content", text.toString())
      .put("tool_calls", calls).put("reasoning_content", reasoning.toString())
      .put("_responses_items", JSONArray(output.toString()))
  }

  internal fun anthropicResult(root: JSONObject): JSONObject {
    val content = root.optJSONArray("content") ?: JSONArray()
    val blocks = JSONArray()
    val calls = JSONArray()
    val text = StringBuilder()
    val reasoning = StringBuilder()
    for (i in 0 until content.length()) {
      val item = content.optJSONObject(i) ?: continue
      blocks.put(JSONObject(item.toString()))
      when (item.optString("type")) {
        "text" -> text.append(fieldText(item, "text"))
        "thinking" -> reasoning.append(fieldText(item, "thinking"))
        "tool_use" -> calls.put(
          JSONObject().put("id", fieldText(item, "id")).put("type", "function")
            .put(
              "function",
              JSONObject().put("name", fieldText(item, "name"))
                .put("arguments", item.optJSONObject("input")?.toString() ?: "{}"),
            ),
        )
      }
    }
    return JSONObject().put("role", "assistant").put("content", text.toString())
      .put("tool_calls", calls).put("reasoning_content", reasoning.toString())
      .put("_anthropic_blocks", blocks)
  }

  private fun responseFailureDetail(root: JSONObject): String {
    val error = root.optJSONObject("error")
    val message = (error?.opt("message") as? String)?.takeIf { it.isNotBlank() }
      ?: (root.opt("error") as? String)?.takeIf { it.isNotBlank() }
      ?: fieldText(root.optJSONObject("incomplete_details") ?: JSONObject(), "reason").takeIf { it.isNotBlank() }
      ?: "未提供原因"
    return message.take(300)
  }

  private fun streamFailure(connection: RepairModelConnection, root: JSONObject): RepairModelFailure {
    val error = root.optJSONObject("error")
    val raw = (error?.opt("message") as? String)?.takeIf { it.isNotBlank() }
      ?: (root.opt("error") as? String)?.takeIf { it.isNotBlank() }
      ?: (root.opt("message") as? String)?.takeIf { it.isNotBlank() }
      ?: "模型流式响应错误"
    val redacted = if (connection.apiKey.isEmpty()) raw else raw.replace(connection.apiKey, "***")
    return RepairModelFailure("模型接口错误：" + redacted.take(300))
  }

  private fun emitText(listener: RepairStreamListener?, state: AttemptState, delta: String) {
    if (listener == null || delta.isEmpty()) return
    val filtered = state.textFilter.feed(delta)
    if (filtered.isEmpty()) return
    synchronized(callbackLock) {
      if (cancelled) return
      state.streamStarted = true
      state.emittedText = true
      listener.onTextDelta(filtered)
    }
  }

  private fun emitReasoning(listener: RepairStreamListener?, state: AttemptState, delta: String) {
    if (listener == null || delta.isEmpty()) return
    val filtered = state.reasoningFilter.feed(delta)
    if (filtered.isEmpty()) return
    synchronized(callbackLock) {
      if (cancelled) return
      state.streamStarted = true
      state.emittedReasoning = true
      listener.onReasoningDelta(filtered)
    }
  }

  private fun emitFinalText(listener: RepairStreamListener, state: AttemptState, text: String) {
    synchronized(callbackLock) {
      if (cancelled) return
      state.streamStarted = true
      state.emittedText = true
      listener.onTextDelta(text)
    }
  }

  private fun emitFinalReasoning(listener: RepairStreamListener, state: AttemptState, text: String) {
    synchronized(callbackLock) {
      if (cancelled) return
      state.streamStarted = true
      state.emittedReasoning = true
      listener.onReasoningDelta(text)
    }
  }

  private fun fieldText(obj: JSONObject, key: String): String {
    val value = obj.opt(key)
    return when (value) {
      is String -> if (value.trim() == "null") "" else value
      is Number, is Boolean -> value.toString()
      else -> ""
    }
  }

  private fun reasoningField(obj: JSONObject): String {
    for (key in REASONING_FIELDS) {
      val value = obj.opt(key)
      if (value is String && value.isNotBlank() && value.trim() != "null") return value
    }
    return ""
  }

  private fun contentText(obj: JSONObject): String {
    val value = obj.opt("content") ?: return ""
    return when (value) {
      is String -> if (value.trim() == "null") "" else value
      is JSONArray -> {
        val text = StringBuilder()
        for (i in 0 until value.length()) {
          when (val part = value.opt(i)) {
            is String -> if (part.trim() != "null") text.append(part)
            is JSONObject -> text.append(fieldText(part, "text"))
          }
        }
        text.toString()
      }
      else -> ""
    }
  }

  private fun parseStreamJson(data: String): JSONObject =
    runCatching { JSONObject(data) }.getOrElse { throw RepairModelFailure("模型流式响应格式错误") }

  private interface SseAccumulator {
    fun accept(event: String, data: String): Boolean
    fun payload(): JSONObject
  }

  private class ChatToolCall {
    var id = ""
    var type = "function"
    val name = StringBuilder()
    val arguments = StringBuilder()
  }

  private inner class ChatSseAccumulator(
    private val connection: RepairModelConnection,
    private val listener: RepairStreamListener?,
    private val state: AttemptState,
  ) : SseAccumulator {
    private val text = StringBuilder()
    private val reasoning = StringBuilder()
    private val calls = TreeMap<Int, ChatToolCall>()
    private var terminal = false

    override fun accept(event: String, data: String): Boolean {
      val payload = data.trim()
      if (payload.isEmpty()) return false
      if (payload == "[DONE]") {
        terminal = true
        return true
      }
      val root = parseStreamJson(payload)
      if (root.optJSONObject("error") != null) throw streamFailure(connection, root)
      if (fieldText(root, "type") == "error") throw streamFailure(connection, root)
      val choices = root.optJSONArray("choices") ?: return false
      val choice = choices.optJSONObject(0) ?: return false
      val delta = choice.optJSONObject("delta")
      if (delta != null) {
        val reasoningDelta = reasoningField(delta)
        if (reasoningDelta.isNotEmpty()) {
          reasoning.append(reasoningDelta)
          emitReasoning(listener, state, reasoningDelta)
        }
        val contentDelta = contentText(delta)
        if (contentDelta.isNotEmpty()) {
          text.append(contentDelta)
          emitText(listener, state, contentDelta)
        }
        accumulateCalls(delta)
      } else {
        val message = choice.optJSONObject("message")
        if (message != null && text.isEmpty() && reasoning.isEmpty() && calls.isEmpty()) {
          val reasoningText = reasoningField(message)
          if (reasoningText.isNotEmpty()) {
            reasoning.append(reasoningText)
            emitReasoning(listener, state, reasoningText)
          }
          val content = contentText(message)
          if (content.isNotEmpty()) {
            text.append(content)
            emitText(listener, state, content)
          }
          accumulateCalls(message)
        }
      }
      val finish = choice.opt("finish_reason")
      if (finish is String && finish.isNotBlank()) terminal = true
      return terminal
    }

    private fun accumulateCalls(source: JSONObject) {
      val deltaCalls = source.optJSONArray("tool_calls") ?: return
      for (j in 0 until deltaCalls.length()) {
        val item = deltaCalls.optJSONObject(j) ?: continue
        val index = item.optInt("index", j)
        val call = calls.getOrPut(index) { ChatToolCall() }
        val id = fieldText(item, "id")
        if (id.isNotEmpty()) call.id = id
        val type = fieldText(item, "type")
        if (type.isNotEmpty()) call.type = type
        val fn = item.optJSONObject("function") ?: continue
        val name = fieldText(fn, "name")
        if (name.isNotEmpty()) call.name.append(name)
        when (val arguments = fn.opt("arguments")) {
          is String -> if (arguments.trim() != "null") call.arguments.append(arguments)
          is JSONObject -> call.arguments.append(arguments.toString())
          is JSONArray -> call.arguments.append(arguments.toString())
        }
      }
    }

    override fun payload(): JSONObject {
      if (!terminal) throw RepairModelFailure("模型流式响应中断：未收到终止事件")
      val message = JSONObject().put("role", "assistant").put("content", text.toString())
      if (reasoning.isNotEmpty()) message.put("reasoning_content", reasoning.toString())
      if (calls.isNotEmpty()) {
        val array = JSONArray()
        for ((_, call) in calls) {
          array.put(
            JSONObject().put("id", call.id).put("type", call.type.ifBlank { "function" })
              .put(
                "function",
                JSONObject().put("name", call.name.toString())
                  .put("arguments", call.arguments.toString().ifBlank { "{}" }),
              ),
          )
        }
        message.put("tool_calls", array)
      }
      return JSONObject().put(
        "choices",
        JSONArray().put(JSONObject().put("message", message).put("finish_reason", "stop")),
      )
    }
  }

  private inner class ResponsesSseAccumulator(
    private val connection: RepairModelConnection,
    private val listener: RepairStreamListener?,
    private val state: AttemptState,
  ) : SseAccumulator {
    private val items = TreeMap<Int, JSONObject>()
    private val textByIndex = HashMap<Int, StringBuilder>()
    private val argumentsByIndex = HashMap<Int, StringBuilder>()
    private val reasoningByIndex = HashMap<Int, StringBuilder>()
    private var finalResponse: JSONObject? = null
    private var terminal = false

    override fun accept(event: String, data: String): Boolean {
      if (data.isBlank()) {
        if (event == "response.completed") terminal = true
        if (event == "response.failed") throw RepairModelFailure("模型响应失败：未提供原因")
        if (event == "response.incomplete") throw RepairModelFailure("模型响应不完整：未提供原因")
        return terminal
      }
      val root = parseStreamJson(data)
      if (root.optJSONObject("error") != null) throw streamFailure(connection, root)
      val type = if (event.isBlank() || event == "message") fieldText(root, "type") else event
      when (type) {
        "error" -> throw streamFailure(connection, root)
        "response.output_item.added", "response.output_item.done" -> {
          val index = root.optInt("output_index", items.size)
          val item = root.optJSONObject("item") ?: return false
          if (type.endsWith(".done")) items[index] = JSONObject(item.toString())
          else if (!items.containsKey(index)) items[index] = JSONObject(item.toString())
        }
        "response.output_text.delta" -> {
          val delta = fieldText(root, "delta")
          if (delta.isEmpty()) return false
          val index = root.optInt("output_index", 0)
          val builder = textByIndex.getOrPut(index) { StringBuilder() }
          builder.append(delta)
          val item = ensureMessage(index)
          val content = item.optJSONArray("content") ?: JSONArray().also { item.put("content", it) }
          val contentIndex = root.optInt("content_index", 0)
          while (content.length() <= contentIndex) {
            content.put(JSONObject().put("type", "output_text").put("text", ""))
          }
          val part = content.optJSONObject(contentIndex) ?: JSONObject()
          part.put("type", "output_text").put("text", builder.toString())
          content.put(contentIndex, part)
          emitText(listener, state, delta)
        }
        "response.output_text.done" -> {
          val full = fieldText(root, "text")
          if (full.isEmpty()) return false
          val index = root.optInt("output_index", 0)
          val item = ensureMessage(index)
          item.put(
            "content",
            JSONArray().put(JSONObject().put("type", "output_text").put("text", full)),
          )
          textByIndex[index] = StringBuilder(full)
        }
        "response.function_call_arguments.delta" -> {
          val delta = fieldText(root, "delta")
          if (delta.isEmpty()) return false
          val index = root.optInt("output_index", 0)
          val builder = argumentsByIndex.getOrPut(index) { StringBuilder() }
          builder.append(delta)
          val item = ensureFunctionCall(index, root)
          item.put("arguments", builder.toString())
        }
        "response.function_call_arguments.done" -> {
          val index = root.optInt("output_index", 0)
          val full = fieldText(root, "arguments")
          if (full.isNotEmpty()) {
            argumentsByIndex[index] = StringBuilder(full)
            ensureFunctionCall(index, root).put("arguments", full)
          }
        }
        "response.reasoning_summary_text.delta", "response.reasoning_summary.delta",
        "response.reasoning_text.delta" -> {
          val delta = fieldText(root, "delta")
          if (delta.isEmpty()) return false
          val index = root.optInt("output_index", 0)
          val builder = reasoningByIndex.getOrPut(index) { StringBuilder() }
          builder.append(delta)
          val item = ensureReasoning(index)
          val summary = item.optJSONArray("summary") ?: JSONArray().also { item.put("summary", it) }
          val summaryIndex = root.optInt("summary_index", 0)
          while (summary.length() <= summaryIndex) {
            summary.put(JSONObject().put("type", "summary_text").put("text", ""))
          }
          val part = summary.optJSONObject(summaryIndex) ?: JSONObject()
          part.put("type", "summary_text").put("text", builder.toString())
          summary.put(summaryIndex, part)
          emitReasoning(listener, state, delta)
        }
        "response.completed" -> {
          finalResponse = root.optJSONObject("response") ?: root
          terminal = true
        }
        "response.failed" -> throw streamFailure(
          connection,
          root.optJSONObject("response") ?: root,
        )
        "response.incomplete" -> {
          val response = root.optJSONObject("response") ?: root
          throw RepairModelFailure("模型响应不完整：" + responseFailureDetail(response))
        }
      }
      return terminal
    }

    private fun ensureMessage(index: Int): JSONObject = items.getOrPut(index) {
      JSONObject().put("type", "message").put("role", "assistant").put("content", JSONArray())
    }

    private fun ensureFunctionCall(index: Int, source: JSONObject): JSONObject {
      val existing = items[index]
      if (existing != null && existing.optString("type") == "function_call") return existing
      val itemId = fieldText(source, "item_id")
      val call = JSONObject().put("type", "function_call")
      if (itemId.isNotEmpty()) call.put("id", itemId)
      val callId = fieldText(source, "call_id")
      if (callId.isNotEmpty()) call.put("call_id", callId)
      val name = fieldText(source, "name")
      if (name.isNotEmpty()) call.put("name", name)
      call.put("arguments", argumentsByIndex[index]?.toString() ?: "")
      items[index] = call
      return call
    }

    private fun ensureReasoning(index: Int): JSONObject = items.getOrPut(index) {
      JSONObject().put("type", "reasoning").put("summary", JSONArray())
    }

    override fun payload(): JSONObject {
      if (!terminal) throw RepairModelFailure("模型流式响应中断：未收到终止事件")
      val response = finalResponse
      if (response != null) {
        val output = response.optJSONArray("output")
        if (output != null && output.length() > 0) {
          return JSONObject().put("status", "completed").put("output", JSONArray(output.toString()))
        }
      }
      val output = JSONArray()
      for ((_, item) in items) output.put(JSONObject(item.toString()))
      return JSONObject().put("status", "completed").put("output", output)
    }
  }

  private class AnthropicBlock(val raw: JSONObject) {
    val type: String = fieldText(raw, "type")
    val text = StringBuilder(fieldText(raw, "text"))
    val thinking = StringBuilder(fieldText(raw, "thinking"))
    val signature = StringBuilder(fieldText(raw, "signature"))
    val partialJson = StringBuilder()
    val input: JSONObject? = raw.optJSONObject("input")?.let { JSONObject(it.toString()) }

    fun build(): JSONObject {
      val block = JSONObject(raw.toString())
      when (type) {
        "text" -> block.put("text", text.toString())
        "thinking" -> {
          block.put("thinking", thinking.toString())
          if (signature.isNotEmpty()) block.put("signature", signature.toString())
        }
        "tool_use" -> {
          val parsed = if (partialJson.isNotEmpty()) {
            runCatching { JSONObject(partialJson.toString()) }.getOrNull()
          } else null
          if (parsed != null) block.put("input", parsed)
          else if (input != null) block.put("input", input)
        }
      }
      return block
    }

    private fun fieldText(obj: JSONObject, key: String): String {
      val value = obj.opt(key)
      return if (value is String && value.trim() != "null") value else ""
    }
  }

  private inner class AnthropicSseAccumulator(
    private val connection: RepairModelConnection,
    private val listener: RepairStreamListener?,
    private val state: AttemptState,
  ) : SseAccumulator {
    private val blocks = TreeMap<Int, AnthropicBlock>()
    private var terminal = false

    override fun accept(event: String, data: String): Boolean {
      if (data.isBlank()) {
        if (event == "message_stop") terminal = true
        return terminal
      }
      val root = parseStreamJson(data)
      val type = if (event.isBlank() || event == "message") fieldText(root, "type") else event
      when (type) {
        "error" -> throw streamFailure(connection, root)
        "message_start" -> {
          val message = root.optJSONObject("message") ?: return false
          val content = message.optJSONArray("content") ?: return false
          for (i in 0 until content.length()) {
            val block = content.optJSONObject(i) ?: continue
            blocks[i] = AnthropicBlock(block)
          }
        }
        "content_block_start" -> {
          val index = root.optInt("index", blocks.size)
          val block = root.optJSONObject("content_block") ?: return false
          val stateBlock = AnthropicBlock(block)
          blocks[index] = stateBlock
          when (stateBlock.type) {
            "text" -> {
              val initial = stateBlock.text.toString()
              if (initial.isNotEmpty()) emitText(listener, state, initial)
            }
            "thinking" -> {
              val initial = stateBlock.thinking.toString()
              if (initial.isNotEmpty()) emitReasoning(listener, state, initial)
            }
          }
        }
        "content_block_delta" -> {
          val index = root.optInt("index", 0)
          val block = blocks.getOrPut(index) { AnthropicBlock(JSONObject().put("type", "text")) }
          val delta = root.optJSONObject("delta") ?: return false
          when (fieldText(delta, "type")) {
            "text_delta" -> {
              val value = fieldText(delta, "text")
              if (value.isNotEmpty()) {
                block.text.append(value)
                emitText(listener, state, value)
              }
            }
            "thinking_delta" -> {
              val value = fieldText(delta, "thinking")
              if (value.isNotEmpty()) {
                block.thinking.append(value)
                emitReasoning(listener, state, value)
              }
            }
            "signature_delta" -> {
              val value = fieldText(delta, "signature")
              if (value.isNotEmpty()) block.signature.append(value)
            }
            "input_json_delta" -> {
              val value = fieldText(delta, "partial_json")
              if (value.isNotEmpty()) block.partialJson.append(value)
            }
          }
        }
        "content_block_stop" -> {
          // 块内容在 payload() 里统一 build；这里只需要保证索引已存在。
          val index = root.optInt("index", 0)
          if (!blocks.containsKey(index)) blocks[index] = AnthropicBlock(JSONObject().put("type", "text"))
        }
        "message_delta" -> {
          // stop_reason 与 usage 不参与正文，终止由 message_stop 负责。
        }
        "message_stop" -> terminal = true
      }
      return terminal
    }

    override fun payload(): JSONObject {
      if (!terminal) throw RepairModelFailure("模型流式响应中断：未收到终止事件")
      val content = JSONArray()
      for ((_, block) in blocks) content.put(block.build())
      return JSONObject().put("content", content)
    }
  }

  private class AttemptState {
    @Volatile var responseReceived = false
    @Volatile var streamStarted = false
    @Volatile var emittedText = false
    @Volatile var emittedReasoning = false
    val textFilter = DsmlStreamFilter()
    val reasoningFilter = DsmlStreamFilter()

    fun beginAttempt() {
      responseReceived = false
      streamStarted = false
      emittedText = false
      emittedReasoning = false
      textFilter.reset()
      reasoningFilter.reset()
    }
  }

  /**
   * Holds back a trailing fragment that may be the beginning of a DSML tag.
   *
   * Streaming cannot know whether "<" or "<|DS" is ordinary prose or the first
   * slice of a DSML marker, so those prefixes are buffered until the next delta
   * decides. Complete DSML tags are dropped instead of being shown as text.
   */
  private class DsmlStreamFilter {
    private val pending = StringBuilder()

    fun reset() {
      pending.setLength(0)
    }

    fun feed(delta: String): String {
      pending.append(delta)
      return drain()
    }

    fun finish(): String {
      val out = drain()
      if (pending.isEmpty()) return out
      val rest = pending.toString()
      pending.setLength(0)
      return if (looksLikeDsmlPrefix(rest)) out else out + rest
    }

    private fun drain(): String {
      val out = StringBuilder()
      var consumed = 0
      while (consumed < pending.length) {
        val lt = pending.indexOf("<", consumed)
        if (lt < 0) {
          out.append(pending, consumed, pending.length)
          consumed = pending.length
          break
        }
        if (lt > consumed) out.append(pending, consumed, lt)
        val rest = pending.substring(lt)
        val gt = rest.indexOf('>')
        if (gt < 0) {
          if (looksLikeDsmlPrefix(rest)) {
            consumed = lt
            break
          }
          out.append('<')
          consumed = lt + 1
          continue
        }
        val tag = rest.substring(0, gt + 1)
        if (isDsmlTag(tag)) {
          consumed = lt + gt + 1
        } else {
          out.append('<')
          consumed = lt + 1
        }
      }
      if (consumed > 0) pending.delete(0, consumed)
      return out.toString()
    }

    private fun looksLikeDsmlPrefix(text: String): Boolean {
      if (!text.startsWith("<")) return false
      val after = text.substring(1).filterNot { it == ' ' || it == '\t' }.lowercase()
      return "|dsml|".startsWith(after) || after.startsWith("|dsml|") ||
        "/|dsml|".startsWith(after) || after.startsWith("/|dsml|")
    }

    private fun isDsmlTag(tag: String): Boolean {
      val normalized = tag.filterNot { it == ' ' || it == '\t' }.lowercase()
      return normalized.startsWith("<|dsml|") || normalized.startsWith("</|dsml|")
    }
  }

  private class SseLineReader(
    private val input: InputStream,
    private val maxBytes: Int,
    private val stopped: () -> Boolean,
  ) {
    private val buffer = ByteArray(8192)
    private var offset = 0
    private var length = 0
    private var total = 0

    fun readLine(): String? {
      val line = ByteArrayOutputStream()
      while (true) {
        if (stopped()) throw InterruptedException()
        if (offset >= length) {
          val n = input.read(buffer)
          if (n < 0) {
            if (line.size() == 0) return null
            return decode(line.toByteArray())
          }
          total += n
          if (total > maxBytes) throw RepairModelFailure("模型响应过大")
          offset = 0
          length = n
        }
        val b = buffer[offset].toInt() and 0xff
        offset++
        if (b == '\n'.code) return decode(line.toByteArray())
        line.write(b)
        if (line.size() > MAX_LINE_BYTES) throw RepairModelFailure("模型流式响应单行过大")
      }
    }

    private fun decode(bytes: ByteArray): String {
      var end = bytes.size
      if (end > 0 && bytes[end - 1] == '\r'.code.toByte()) end--
      return String(bytes, 0, end, StandardCharsets.UTF_8)
    }

    private companion object {
      const val MAX_LINE_BYTES = 1_000_000
    }
  }
}

internal class RepairModelFailure(message: String) : Exception(message)
