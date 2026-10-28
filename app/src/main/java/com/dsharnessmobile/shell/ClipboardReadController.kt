package com.dsharnessmobile.shell

import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject

/** Foreground, native-confirmed clipboard reads for one trusted page draft. */
internal class ClipboardReadController(
  private val activity: MainActivity,
  private val page: () -> WebView?,
  private val trusted: (String) -> Boolean,
) {
  private val handler = Handler(Looper.getMainLooper())
  private var dialog: AlertDialog? = null
  private var pending: String? = null
  private var expiresAtNanos = 0L
  private var epoch = 0L
  private var timeout: Runnable? = null

  /** Queue no clipboard access until the user confirms the native prompt. */
  fun request(requestId: String) {
    check(Looper.myLooper() == Looper.getMainLooper())
    // 非法 requestId 必须静默丢弃：回执要把它拼进 evaluateJavascript，未过白名单的串就是注入面。
    if (!requestId.matches(Regex("[A-Za-z0-9_-]{8,64}"))) return
    // WebView 不在时没有回执信道（evaluateJavascript 需要 view），只能靠页面侧超时兜底。
    val view = page() ?: return
    val url = view.url
    // 2026-10-28 扫描 M2：这组「壳侧受理失败」必须给回执——旧实现直接 return，用户点
    // 「从剪贴板填充」后要白等满页面侧 35s 超时才知道没受理（切回应用瞬间点击即触发：
    // hasWindowFocus 还没恢复）。与 busy 同型：deny 要如实，不能让页面猜。
    if (url == null || !trusted(url) || !activity.hasWindowFocus() ||
      activity.isFinishing || activity.isDestroyed
    ) {
      reply(view, requestId, JSONObject().put("ok", false).put("reason", "unavailable"))
      return
    }
    if (pending != null) {
      // A busy reply must not replace or invalidate the first consent request.
      reply(view, requestId, JSONObject().put("ok", false).put("reason", "busy"))
      return
    }
    pending = requestId
    val ticket = ++epoch
    expiresAtNanos = System.nanoTime() + 30_000_000_000L
    fun finish(payload: JSONObject) {
      if (pending != requestId || epoch != ticket) return
      clear()
      if (!activity.isFinishing && !activity.isDestroyed && view === page() && view.url == url && trusted(url)) {
        reply(view, requestId, payload)
      }
    }
    val prompt = AlertDialog.Builder(activity)
      .setTitle(R.string.ds_clipboard_read_title)
      .setMessage(R.string.ds_clipboard_read_detail)
      .setNegativeButton(android.R.string.cancel) { _, _ ->
        finish(JSONObject().put("ok", false).put("reason", "cancelled"))
      }
      .setPositiveButton(R.string.ds_clipboard_read_action) { _, _ ->
        if (pending != requestId || epoch != ticket) return@setPositiveButton
        if (System.nanoTime() >= expiresAtNanos ||
          view !== page() || view.url != url || !trusted(url)) {
          clear()
          return@setPositiveButton
        }
        // Plain text only: never dereference clipboard URIs or coerce intents.
        val text = runCatching {
          val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          val clip = clipboard.primaryClip
          if (clip == null || clip.itemCount != 1) null else clip.getItemAt(0).text
        }.getOrNull()
        val payload = if (text == null || text.isEmpty() || text.length > 16_384) {
          JSONObject().put("ok", false).put("reason", "invalid-text")
        } else {
          JSONObject().put("ok", true).put("text", text.toString())
        }
        finish(payload)
      }
      .setOnCancelListener { finish(JSONObject().put("ok", false).put("reason", "cancelled")) }
      .create()
    dialog = prompt
    timeout = Runnable { finish(JSONObject().put("ok", false).put("reason", "expired")) }
    handler.postDelayed(timeout!!, 30_000)
    prompt.show()
  }

  /** Invalidate pending consent when the Activity pauses, navigates or is destroyed. */
  fun cancel() {
    clear()
  }

  /** A disposed editor can revoke only its own outstanding request. */
  fun cancel(requestId: String) {
    if (pending == requestId) clear()
  }

  private fun clear() {
    epoch++
    pending = null
    timeout?.let(handler::removeCallbacks)
    timeout = null
    dialog?.dismiss()
    dialog = null
  }

  /** Deliver JSON as data; neither clipboard text nor failures enter logs. */
  private fun reply(view: WebView, requestId: String, payload: JSONObject) {
    payload.put("requestId", requestId)
    // 受理失败/取消路径可能在 isFinishing 边缘调进来：view 正在销毁时 evaluateJavascript
    // 会抛 IllegalStateException——回执本就没有恢复路径，吞掉比让调用线程炸掉正确。
    runCatching {
      view.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('dsh:clipboard-text',{detail:" +
          escapeLineSeparators(payload.toString()) + "}));",
        null,
      )
    }
  }
}
