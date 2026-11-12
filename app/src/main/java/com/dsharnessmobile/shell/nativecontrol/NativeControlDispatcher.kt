package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** JNI 与 Android adapter 的接线层；能力、通道和生命周期始终由 Rust 决定。 */
internal class NativeControlDispatcher(
  private val core: Core,
  private val facts: Facts,
  private val platform: Platform,
) : NativeControlSocketServer.Handler {
  fun interface Core {
    fun exchange(request: JSONObject): JSONObject
    fun fastExchange(request: JSONObject): JSONObject = exchange(request)
  }
  /** 必须是短时事实读取；禁止权限弹窗、启动 Binder 或同步健康探测。 */
  fun interface Facts { fun capture(): JSONObject }

  interface Platform {
    /** 仅表示本 adapter 是否实现该 Rust 计划，不能覆盖 Rust 的授权判断。 */
    fun implements(plan: JSONObject): Boolean

    /** 必须在实际 Android API 调用的同一回调中，紧邻调用前执行 authorize。 */
    fun execute(plan: JSONObject, args: JSONObject, authorize: () -> Boolean): CompletableFuture<JSONObject>
  }

  override fun handle(request: JSONObject, cancellation: NativeControlSocketServer.Cancellation): JSONObject {
    NativeControlFrames.validate(request)
    return when (request.getString("method")) {
      "capabilities" -> {
        val refreshed = refresh()
        if (!refreshed.optBoolean("ok")) refreshed else exchange("capabilities")
      }
      "status" -> exchange("operationStatus", request.getString("callId"))
      "cancel" -> exchange("cancel", request.getString("callId"))
      "execute" -> execute(request, cancellation)
      else -> error("unsupported-method", "no")
    }
  }

  override fun cancel(callId: String) { exchange("cancel", callId) }

  private fun execute(request: JSONObject, cancellation: NativeControlSocketServer.Cancellation): JSONObject {
    val callId = request.getString("callId")
    if (cancellation.isCancelled()) return error("cancelled-before-admission", "no")
    val refreshed = refresh()
    if (!refreshed.optBoolean("ok")) return refreshed
    val prepare = envelope("prepare", callId)
    for (field in listOf("epoch", "operation", "screenId", "generation", "args")) {
      if (request.has(field)) prepare.put(field, request.get(field))
    }
    val prepared = core.exchange(prepare)
    // 完成回执只回读；在途、未知和拒绝均没有第二次派发入口。
    if (prepared.optBoolean("replayed") || prepared.optString("code") != "prepared" || !prepared.optBoolean("ok")) return prepared
    val plan = prepared.optJSONObject("plan") ?: return withdraw(callId, "missing-native-plan")
    if (!platform.implements(plan)) return withdraw(callId, "platform-adapter-unavailable")
    if (cancellation.isCancelled()) return exchange("cancel", callId)
    val latest = refresh()
    if (!latest.optBoolean("ok")) return withdraw(callId, "facts-refresh-failed")
    if (cancellation.isCancelled()) return exchange("cancel", callId)
    val committed = exchange("commit", callId)
    if (committed.optString("dispatch") != "permitted") {
      // 未取得派发许可只撤销 prepared；不要留下可误派的待办。
      exchange("cancel", callId)
      return committed
    }
    val committedPlan = committed.optJSONObject("plan") ?: return settle(callId, error("missing-dispatch-plan", "unknown"))
    var denied: JSONObject? = null
    val gateConsumed = AtomicBoolean(false)
    val gateGranted = AtomicBoolean(false)
    val gate = {
      val allowed = if (!gateConsumed.compareAndSet(false, true) || cancellation.isCancelled()) false else {
        val latestFacts = core.fastExchange(envelope("publishFacts").put("facts", facts.capture()))
        val check = if (latestFacts.optBoolean("ok")) core.fastExchange(envelope("validateDispatch", callId))
          else JSONObject().put("valid", false).put("settleHint", error("facts-current-unavailable", "no"))
        val valid = check.optBoolean("valid") && check.optString("dispatch") == "permitted"
        if (!valid) denied = check.optJSONObject("settleHint")
        valid
      }
      if (allowed) gateGranted.set(true)
      allowed
    }
    val receipt = try {
      platform.execute(committedPlan, request.optJSONObject("args") ?: JSONObject(), gate)
        .get(request.optLong("timeoutMs", 15_000L), TimeUnit.MILLISECONDS)
    } catch (_: TimeoutException) {
      exchange("cancel", callId)
      return exchange("operationStatus", callId)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      exchange("cancel", callId)
      return exchange("operationStatus", callId)
    } catch (_: ExecutionException) {
      error("platform-result-unknown", "unknown")
    } catch (_: Exception) {
      error("platform-result-unknown", "unknown")
    }
    val result = denied ?: if (receipt.optString("executed") == "yes" && !gateGranted.get()) {
      error("platform-authorization-unconfirmed", "unknown")
    } else receipt
    // Adapter 不得改写 Rust 绑定的屏幕；回执的 screenId 总是沿用获准计划。
    result.put("screenId", committedPlan.opt("screenId") ?: JSONObject.NULL)
    if (cancellation.isCancelled()) return exchange("operationStatus", callId)
    return settle(callId, result)
  }

  private fun withdraw(callId: String, code: String): JSONObject {
    val cancelled = exchange("cancel", callId)
    if (cancelled.optString("executed") != "no") return cancelled
    return error(code, "no").put("callId", callId)
  }

  private fun settle(callId: String, receipt: JSONObject): JSONObject = core.exchange(
    envelope("settle", callId).put("receipt", receipt),
  )

  private fun refresh(): JSONObject = core.exchange(envelope("publishFacts").put("facts", facts.capture()))
  private fun exchange(kind: String, callId: String? = null): JSONObject = core.exchange(envelope(kind, callId))
  private fun envelope(kind: String, callId: String? = null): JSONObject = JSONObject()
    .put("protocolVersion", NativeControlFrames.PROTOCOL_VERSION).put("kind", kind)
    .also { if (callId != null) it.put("callId", callId) }

  private fun error(code: String, executed: String): JSONObject = JSONObject()
    .put("ok", false).put("code", code).put("executed", executed).put("screenId", JSONObject.NULL)
}
