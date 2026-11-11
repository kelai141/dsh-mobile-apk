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

  internal fun available(): Boolean = evaluator != null

  /** 页面侧返回的工作区条目（与 [WorkspaceListParse] 的平行类型：这里只服务页面通道，互不依赖）。 */
  internal data class PageWorkspace(val id: String, val title: String)

  /** 页面侧返回的附件条目（kind: image|file）。 */
  internal data class PageAttachment(val name: String, val kind: String)

  /** 页面侧返回的命令条目（真源 = 上游命令菜单，禁止硬编码）。 */
  internal data class PageCommand(val name: String, val label: String, val description: String)

  /** 页面侧返回的会话条目（供输入区的会话药丸切换）。 */
  internal data class PageSession(val id: String, val title: String)

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
  )

  /** 一次求值。表达式必须自己 try/catch 并返回字符串；这里只做超时与空回包归一。 */
  private fun eval(expr: String, onResult: (String?) -> Unit) {
    val ev = evaluator
    if (ev == null) {
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

  internal fun commands(onResult: (List<PageCommand>) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.commands():'';}catch(e){return '';}})()") { raw ->
      onResult(parseCommands(parseHostReply(raw)))
    }
  }

  internal fun execute(line: String, onResult: (Boolean) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.execute(" + jsArg(line) + "):'';}catch(e){return '';}})()") { raw ->
      onResult(parseOk(parseHostReply(raw)))
    }
  }

  internal fun send(text: String, onResult: (Boolean) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.send(" + jsArg(text) + "):'';}catch(e){return '';}})()") { raw ->
      onResult(parseOk(parseHostReply(raw)))
    }
  }

  internal fun removeAttachment(index: Int, onResult: (Boolean) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.removeAttachment(" + index + "):'';}catch(e){return '';}})()") { raw ->
      onResult(parseOk(parseHostReply(raw)))
    }
  }

  internal fun openSession(sessionId: String, onResult: (Boolean) -> Unit) {
    eval("(function(){try{return window.__dshOverlayHost?window.__dshOverlayHost.openSession(" + jsArg(sessionId) + "):'';}catch(e){return '';}})()") { raw ->
      onResult(parseOk(parseHostReply(raw)))
    }
  }

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
        attachments.add(PageAttachment(name, a.optString("kind", "file")))
      }
    }
    return PageState(
      sessionId = obj.optString("sessionId", ""),
      sessionTitle = obj.optString("sessionTitle", ""),
      workspaceId = obj.optString("workspaceId", ""),
      workspaceName = obj.optString("workspaceName", ""),
      workspaces = workspaces,
      busy = obj.optBoolean("busy", false),
      attachments = attachments,
      draft = obj.optString("draft", ""),
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
      out.add(PageSession(id, it.optString("title", "")))
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
