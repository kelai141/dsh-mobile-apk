package com.dsharnessmobile.shell

import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * 页面宿主 API 通道（design.md §6.2 的 N3/N4）：Kotlin → 页面 `window.__dshOverlayHost` 的单次求值桥。
 *
 * 为什么是「原生求值页面只读 API」而不是新增一堆 `@JavascriptInterface`：
 * 会话 id / 工作区 / 命令清单的**权威真源都在页面**（会话标记、uiWorkspace store、上游命令菜单），
 * 原生反查一个页面 API 比让页面主动推多个桥方法简单，也不扩大 JS→原生的能力面
 * （`check-bridge-symmetry.mjs` 守的桥面一处不动）。详见 design.md §6.2 末尾的三条理由。
 *
 * 协议要点：
 *  - 页面每个方法都返回 **JSON 字符串**（页面侧 JSON.stringify 后再返回），因此
 *    `evaluateJavascript` 的回包是被引号包起来的字符串字面量，需要先解码一次再解析
 *    （[parseHostReply] 两种形态都吃：直接用 JSONObject 包一层是旧实现的常见错法）。
 *  - 页面未就绪 / 方法抛异常 / 宿主没注册时一律回调 null，**不抛**——调用方按 null 走降级分支。
 *  - 所有回调都在主线程；超过 [TIMEOUT_MS] 未回包按 null 收口，避免状态机永久卡在「等页面」。
 *
 * 线程纪律：只在主线程调用；evaluator 由 MainActivity 在 onResume 注册、onDestroy 注销。
 */
internal object OverlayPageHost {

  /** 等待页面回包的上限。evaluateJavascript 本身不保证回调（页面销毁/进程回收时会静默丢失）。 */
  internal const val TIMEOUT_MS = 2500L

  private val main = Handler(Looper.getMainLooper())

  /**
   * 页面求值器（MainActivity 注册）：输入完整 JS 表达式，回调该表达式的 JSON 编码结果。
   * 未注册（未启动过主界面 / WebView 已销毁）时为 null，所有方法直接降级。
   */
  @Volatile
  internal var evaluator: ((String, (String?) -> Unit) -> Unit)? = null

  @Volatile internal var readiness: (() -> Boolean)? = null

  internal fun available(): Boolean = evaluator != null && readiness?.invoke() == true

  /** 页面侧返回的工作区条目（与 [WorkspaceListParse] 的平行类型：这里只服务页面通道，互不依赖）。 */
  internal data class PageWorkspace(val id: String, val title: String)

  /** 页面侧返回的附件条目（kind: image|file）。 */
  internal data class PageAttachment(val name: String, val kind: String, val id: String = "", val thumbnail: String = "")

  /** 页面侧返回的命令条目（真源 = 上游命令菜单，禁止硬编码）。 */
  internal data class PageCommand(val name: String, val label: String, val description: String)

  /** 页面侧返回的会话条目（供输入区的会话药丸切换）。 */
  internal data class PageSession(val id: String, val title: String, val agentId: String = "")

  /** 页面宿主 state() 的解析结果。字段缺失一律空值/空列表——**不得猜测**（design.md §6.3 硬规则 2/3）。 */
  internal data class PageState(
    val sessionId: String,
    val sessionTitle: String,
    val workspaceId: String,
    val workspaceName: String,
    val workspaces: List<PageWorkspace>,
    val busy: Boolean,
    val attachments: List<PageAttachment>,
    val draft: String,
    val agentId: String = "",
    val workspacesReady: Boolean = false,
    val workspacesError: String = "",
    val transcript: List<OverlayTranscriptRow> = emptyList(),
    val transcriptReady: Boolean = false,
    val transcriptError: String = "",
  )

  /** 一次求值。表达式必须自己 try/catch 并返回字符串；这里只做超时与空回包归一。 */
  private fun eval(expr: String, onResult: (String?) -> Unit) {
    if (Looper.myLooper() != Looper.getMainLooper()) { main.post { eval(expr, onResult) }; return }
    val ev = evaluator
    if (ev == null || !available()) {
      onResult(null)
      return
    }
    var finished = false
    val finish = { raw: String? ->
      if (!finished) {
        finished = true
        onResult(raw)
      }
    }
    try {
      ev(expr) { raw -> main.post { finish(raw) } }
      main.postDelayed({ finish(null) }, TIMEOUT_MS)
    } catch (t: Throwable) {
      LogCollector.log("dsh-overlay", "page host eval failed: " + (t.message ?: t.javaClass.simpleName))
      finish(null)
    }
  }

  /** 把用户输入安全地放进 JS 字符串字面量（复用既有 U+2028/2029 处理）。 */
  private fun jsArg(value: String): String = jsString(value)

  internal fun watchState(enabled: Boolean) {
    eval(callExpression("watchState", enabled.toString())) { }
  }

  internal fun state(onResult: (PageState?) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.state():'';}catch(e){return '';}})()") { raw ->
      onResult(parseState(parseHostReply(raw)))
    }
  }

  internal fun sessions(onResult: (List<PageSession>) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.sessions():'';}catch(e){return '';}})()") { raw ->
      onResult(parseSessions(parseHostReply(raw)))
    }
  }

  internal fun sessionsOrNull(onResult: (List<PageSession>?) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.sessions():'';}catch(e){return '';}})()") { raw ->
      val obj = parseHostReply(raw)
      onResult(if (obj?.optBoolean("ok", false) == true) parseSessions(obj) else null)
    }
  }

  internal fun commandsOrNull(onResult: (List<PageCommand>?) -> Unit) {
    val deadline = android.os.SystemClock.uptimeMillis() + 5000L
    fun read() {
      eval(callExpression("commands", "")) { raw ->
        val obj = parseHostReply(raw)
        if (obj?.optBoolean("ok", false) == true) onResult(parseCommands(obj))
        else if (obj?.optString("error") == "commands-not-ready" && android.os.SystemClock.uptimeMillis() < deadline) main.postDelayed({ read() }, 100L)
        else onResult(null)
      }
    }
    read()
  }

  internal fun commands(onResult: (List<PageCommand>) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.commands():'';}catch(e){return '';}})()") { raw ->
      onResult(parseCommands(parseHostReply(raw)))
    }
  }

  private fun callExpression(method: String, argument: String): String =
    "(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost." + method + "(" + argument + "):'';}catch(e){return '';}})()"

  private data class PendingAction(
    val id: String,
    val onUnknown: (String) -> Unit,
    val onResult: (Boolean) -> Unit,
    var unknownShown: Boolean = false,
    var polling: Boolean = false,
    var cancelled: Boolean = false,
  )
  private val pendingActions = LinkedHashMap<String, PendingAction>()

  private fun unknown(action: PendingAction) {
    if (!action.unknownShown) { action.unknownShown = true; action.onUnknown(action.id) }
  }

  /** Unknown/timeout is never a refusal: keep the ticket and require an explicit recheck. */
  private fun action(method: String, argument: String, onResult: (Boolean) -> Unit, onUnknown: (String) -> Unit = {}) {
    eval(callExpression(method, argument)) { raw ->
      val obj = parseHostReply(raw)
      if (obj?.has("ok") == true && !obj.optBoolean("pending", false)) { onResult(parseOk(obj)); return@eval }
      val id = obj?.optString("operationId", "").orEmpty().ifEmpty { "unconfirmed-" + java.util.UUID.randomUUID().toString() }
      val pending = PendingAction(id, onUnknown, onResult)
      pendingActions[id] = pending
      if (obj == null) { unknown(pending); return@eval }
      pollOperation(pending, android.os.SystemClock.uptimeMillis() + 30000L, 100L)
    }
  }

  internal fun recheckPendingActions() {
    for (pending in pendingActions.values.toList()) {
      if (!pending.polling && !pending.cancelled) pollOperation(pending, android.os.SystemClock.uptimeMillis() + 30000L, 100L)
    }
  }

  internal fun cancelPendingActions() {
    for (pending in pendingActions.values.toList()) { pending.cancelled = true; unknown(pending) }
    pendingActions.clear()
  }

  private fun pollOperation(action: PendingAction, deadline: Long, delay: Long) {
    if (action.cancelled) return
    if (!available() || android.os.SystemClock.uptimeMillis() >= deadline) { action.polling = false; unknown(action); return }
    action.polling = true
    eval(callExpression("operation", jsArg(action.id))) { raw ->
      if (action.cancelled) return@eval
      val obj = parseHostReply(raw)
      if (obj == null || obj.optString("error") == "operation-not-found") {
        action.polling = false; unknown(action); return@eval
      }
      if (obj.optBoolean("pending", false)) {
        if (obj.optBoolean("unknown", false)) unknown(action)
        val nextDelay = (delay * 2L).coerceAtMost(1000L)
        main.postDelayed({ pollOperation(action, deadline, nextDelay) }, delay)
      } else {
        action.polling = false
        pendingActions.remove(action.id)
        action.onResult(parseOk(obj))
      }
    }
  }

  internal fun pollIncoming(requestId: String, onResult: (String) -> Unit) {
    eval(callExpression("incoming", jsArg(requestId))) { raw ->
      val obj = parseHostReply(raw)
      onResult(obj?.optString("state", "pending") ?: "pending")
    }
  }

  internal fun execute(line: String, onResult: (Boolean) -> Unit) = action("execute", jsArg(line), onResult)
  internal fun execute(line: String, expectedSessionId: String, onUnknown: (String) -> Unit, onResult: (Boolean) -> Unit) = action("execute", jsArg(line) + "," + jsArg(expectedSessionId), onResult, onUnknown)
  internal fun execute(line: String, expectedSessionId: String, onResult: (Boolean) -> Unit) = action("execute", jsArg(line) + "," + jsArg(expectedSessionId), onResult)
  internal fun send(text: String, onResult: (Boolean) -> Unit) = action("send", jsArg(text), onResult)
  internal fun send(text: String, expectedSessionId: String, onUnknown: (String) -> Unit, onResult: (Boolean) -> Unit) = action("send", jsArg(text) + "," + jsArg(expectedSessionId), onResult, onUnknown)
  internal fun send(text: String, expectedSessionId: String, onResult: (Boolean) -> Unit) = action("send", jsArg(text) + "," + jsArg(expectedSessionId), onResult)
  internal fun openWorkspace(id: String, onResult: (Boolean) -> Unit) = action("openWorkspace", jsArg(id), onResult)
  internal fun removeAttachment(id: String, onResult: (Boolean) -> Unit) = action("removeAttachment", jsArg(id), onResult)
  internal fun openSession(sessionId: String, onResult: (Boolean) -> Unit) = action("openSession", jsArg(sessionId), onResult)

  /**
   * 解析 evaluateJavascript 的回包（**纯函数**，JVM 可测）。
   *
   * 三种形态都要吃：
   *  - `"{\"ok\":true,...}"`（页面方法返回字符串 => 回包是 JSON 字符串字面量）——先 JSONTokener 解码一次；
   *  - `{"ok":true}`（页面方法直接返回对象时系统的编码形态）——直接解析；
   *  - `null` / `""` / `"null"`（页面未就绪或宿主未注入）——返回 null，调用方走降级。
   */
  internal fun parseHostReply(raw: String?): JSONObject? {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty() || text == "null" || text == "\"\"") return null
    return try {
      val value: Any? = JSONTokener(text).nextValue()
      when (value) {
        is String -> if (value.isBlank() || value == "null") null else JSONObject(value)
        is JSONObject -> value
        else -> null
      }
    } catch (_: Throwable) {
      null
    }
  }

  /** Defense in depth: budget the canonical UTF-8 JSON, not just text or UTF-16 code units. */
  internal fun transcriptJson(rows: List<OverlayTranscriptRow>): String = JSONArray().also { array ->
    for (row in rows) array.put(JSONObject().also { value ->
      value.put("id", row.id).put("role", row.role).put("text", row.text)
      if (row.role == "tool") {
        value.put("toolName", row.toolName).put("arguments", row.arguments).put("result", row.result)
        row.state?.let { value.put("state", it.name.lowercase(java.util.Locale.ROOT)) }
      }
      if (row.truncated) value.put("truncated", true)
    })
  }.toString()

  private fun transcriptPrefix(value: String, count: Int): String {
    var end = 0
    var remaining = count
    while (end < value.length && remaining-- > 0) end += Character.charCount(value.codePointAt(end))
    return value.substring(0, end)
  }

  private fun parseTranscript(array: JSONArray?): List<OverlayTranscriptRow> {
    if (array == null) return emptyList()
    val latest = ArrayList<OverlayTranscriptRow>()
    val ids = HashSet<String>()
    var omitted = array.length() > OVERLAY_TRANSCRIPT_MAX_ROWS
    for (index in array.length() - 1 downTo (array.length() - OVERLAY_TRANSCRIPT_MAX_ROWS).coerceAtLeast(0)) {
      val raw = array.optJSONObject(index) ?: continue
      val id = raw.opt("id") as? String ?: continue
      val role = raw.opt("role") as? String ?: continue
      if (id.isBlank() || id.length > 1024 || role !in setOf("user", "assistant", "tool") || !ids.add(id)) continue
      var clipped = raw.opt("truncated") == true
      fun field(key: String, cap: Int): String {
        val value = raw.opt(key) as? String ?: return ""
        val prefix = transcriptPrefix(value, cap)
        if (prefix != value) clipped = true
        return prefix
      }
      val text = if (role == "tool") "" else field("text", 4000)
      val name = if (role == "tool") field("toolName", 256) else ""
      val arguments = if (role == "tool") field("arguments", 1600) else ""
      val result = if (role == "tool") field("result", 1600) else ""
      if (role == "tool" && name.isBlank()) continue
      val state = if (role != "tool") null else when (raw.opt("state") as? String) {
        "running" -> OverlayToolRowState.RUNNING
        "done" -> OverlayToolRowState.DONE
        "failed" -> OverlayToolRowState.FAILED
        else -> null
      }
      var row = OverlayTranscriptRow(id, role, text, name, arguments, result, state, clipped)
      // Reserve the omission flag so adding it below cannot exceed the global budget.
      while (latest.isEmpty() && transcriptJson(listOf(row.copy(truncated = true))).toByteArray(Charsets.UTF_8).size > 24576) {
        val longest = listOf(row.text, row.arguments, row.result, row.toolName).maxByOrNull { it.length } ?: ""
        if (longest.isEmpty()) break
        val prefix = transcriptPrefix(longest, longest.codePointCount(0, longest.length) / 2)
        row = when (longest) {
          row.text -> row.copy(text = prefix, truncated = true)
          row.arguments -> row.copy(arguments = prefix, truncated = true)
          row.result -> row.copy(result = prefix, truncated = true)
          else -> row.copy(toolName = prefix, truncated = true)
        }
      }
      val candidate = listOf(row.copy(truncated = true)) + latest
      if (transcriptJson(candidate).toByteArray(Charsets.UTF_8).size > 24576) { omitted = true; break }
      latest.add(0, row)
    }
    if (omitted && latest.isNotEmpty()) latest[0] = latest[0].copy(truncated = true)
    return latest
  }

  /** state() 回包 -> 模型。缺失字段留空，不猜（design.md §6.3）。 */
  internal fun parseState(obj: JSONObject?): PageState? {
    if (obj == null) return null
    if (!obj.optBoolean("ok", false)) return null
    val workspaces = ArrayList<PageWorkspace>()
    val wsArr = obj.optJSONArray("workspaces")
    if (wsArr != null) {
      for (i in 0 until wsArr.length()) {
        val w = wsArr.optJSONObject(i) ?: continue
        val id = w.optString("id", "")
        if (id.isEmpty()) continue
        workspaces.add(PageWorkspace(id, w.optString("title", id)))
      }
    }
    val attachments = ArrayList<PageAttachment>()
    val atArr = obj.optJSONArray("attachments")
    if (atArr != null) {
      for (i in 0 until atArr.length()) {
        val a = atArr.optJSONObject(i) ?: continue
        val name = a.optString("name", "")
        if (name.isEmpty()) continue
        attachments.add(PageAttachment(name, a.optString("kind", "file"), a.optString("id", ""), overlayThumbnailData(a.optString("thumbnail", ""))))
      }
    }
    val transcript = parseTranscript(obj.optJSONArray("transcript"))
    return PageState(
      sessionId = obj.optString("sessionId", ""),
      sessionTitle = obj.optString("sessionTitle", ""),
      workspaceId = obj.optString("workspaceId", ""),
      workspaceName = obj.optString("workspaceName", ""),
      workspaces = workspaces,
      busy = obj.optBoolean("busy", false),
      attachments = attachments,
      draft = obj.optString("draft", ""),
      agentId = obj.optString("agentId", ""),
      workspacesReady = obj.optBoolean("workspacesReady", false),
      workspacesError = obj.optString("workspacesError", ""),
      transcript = transcript,
      transcriptReady = obj.optBoolean("transcriptReady", false),
      transcriptError = obj.optString("transcriptError", ""),
    )
  }

  internal fun parseSessions(obj: JSONObject?): List<PageSession> {
    if (obj == null || !obj.optBoolean("ok", false)) return emptyList()
    val out = ArrayList<PageSession>()
    val arr = obj.optJSONArray("items") ?: return out
    for (i in 0 until arr.length()) {
      val it = arr.optJSONObject(i) ?: continue
      val id = it.optString("id", "")
      if (id.isEmpty()) continue
      out.add(PageSession(id, it.optString("title", ""), it.optString("agentId", "")))
    }
    return out
  }

  internal fun parseCommands(obj: JSONObject?): List<PageCommand> {
    if (obj == null || !obj.optBoolean("ok", false)) return emptyList()
    val out = ArrayList<PageCommand>()
    val arr = obj.optJSONArray("items") ?: return out
    for (i in 0 until arr.length()) {
      val it = arr.optJSONObject(i) ?: continue
      val name = it.optString("name", "")
      if (name.isEmpty()) continue
      out.add(PageCommand(name, it.optString("label", name), it.optString("description", "")))
    }
    return out
  }

  internal fun parseOk(obj: JSONObject?): Boolean = obj != null && obj.optBoolean("ok", false)
}
