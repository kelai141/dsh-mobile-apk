package com.dsharnessmobile.shell.nativecontrol

import com.dsharnessmobile.shell.BrowserHostHolder
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** Shared BrowserHost keeps its DOM semantics; only transport and admission move out of the old queue. */
internal class NativeSharedHostExecution(
  private val phone: NativeControlDispatcher.Platform,
  private val virtual: NativeControlDispatcher.Platform? = null,
) : NativeControlDispatcher.Platform {
  override fun implements(plan: JSONObject): Boolean =
    if (plan.optString("backend") == "browserHost") plan.optString("operation") in browserOps
    else if (NativeAppWebViewExecution.implements(plan)) true
    else virtual?.implements(plan) == true || phone.implements(plan)

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    if (NativeAppWebViewExecution.implements(plan))
      return NativeAppWebViewExecution.execute(callId, plan, args, refreshFacts, authorize)
    if (plan.optString("backend") != "browserHost") {
      val executor = virtual?.takeIf { it.implements(plan) } ?: phone
      return executor.execute(callId, plan, args, refreshFacts, authorize)
    }
    if (plan.optString("operation") !in browserOps) return rejected("operation-unsupported")
    val host = BrowserHostHolder.host ?: return rejected("browser-host-unavailable")
    return try {
      worker.supplyAsync({
        val admitted = AtomicBoolean(false)
        val raw = host.controlOp(plan.getString("operation"), args,
          if (plan.has("hostDeadlineNanos")) plan.getLong("hostDeadlineNanos") else null) {
          val allowed = authorize()
          if (allowed) admitted.set(true)
          allowed
        }
        if (!admitted.get()) {
          JSONObject().put("ok", false).put("code", raw.optString("reason", "browser-request-rejected"))
            .put("executed", "no")
        } else {
          val ok = if (plan.getString("operation") == "browserCaps") !raw.has("__error")
            else raw.optBoolean("ok", !raw.has("__error"))
          JSONObject().put("ok", ok).put("code", if (ok) "browser-result" else raw.optString("reason", "browser-result-unknown"))
            .put("executed", if (ok) "yes" else "unknown").put("data", raw)
        }
      })
    } catch (_: RejectedExecutionException) { rejected("browser-native-busy") }
  }

  private fun rejected(code: String) = CompletableFuture.completedFuture(
    JSONObject().put("ok", false).put("code", code).put("executed", "no"))

  companion object {
    private val browserOps = setOf(
      "browserCaps", "browserShow", "browserHide", "browserClose", "browserOpen", "browserJs",
      "browserInput", "browserShot", "browserState", "browserSetUa", "browserViewport",
      "browserTabs", "browserFollowTab", "browserCloseTab",
    )
    private val worker = NativeOperationWorker("native-browser-host", queued = 16)
  }
}
