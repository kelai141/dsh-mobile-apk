package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.security.MessageDigest
import java.util.Base64

/** JNI 与 Android adapter 的接线层；能力、通道和生命周期始终由 Rust 决定。 */
internal class NativeControlDispatcher(
  private val core: Core,
  private val facts: Facts,
  private val platform: Platform,
) : NativeControlSocketServer.Handler {
  fun interface Core {
    fun exchange(request: JSONObject): JSONObject
    fun fastExchange(request: JSONObject): JSONObject = exchange(request)
    fun readImage(callId: String): NativeImageResult? = null
  }
  /** 必须是短时事实读取；禁止权限弹窗、启动 Binder 或同步健康探测。 */
  fun interface Facts { fun capture(): JSONObject }

  interface Platform {
    /** 仅表示本 adapter 是否实现该 Rust 计划，不能覆盖 Rust 的授权判断。 */
    fun implements(plan: JSONObject): Boolean

    /** 必须在实际 Android API 调用的同一回调中，紧邻调用前执行 authorize。 */
    fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
      authorize: () -> Boolean): CompletableFuture<JSONObject>
  }

  override fun handle(request: JSONObject, cancellation: NativeControlSocketServer.Cancellation): JSONObject {
    NativeControlFrames.validate(request)
    val response = when (request.getString("method")) {
      "capabilities" -> {
        val refreshed = refresh()
        if (!refreshed.optBoolean("ok")) refreshed else exchange("capabilities")
      }
      "status" -> exchange("operationStatus", request.getString("callId"))
      "cancel" -> exchange("cancel", request.getString("callId"))
      "execute" -> execute(request, cancellation)
      else -> error("unsupported-method", "no")
    }
    if (!response.has("protocolVersion")) response.put("protocolVersion", NativeControlFrames.PROTOCOL_VERSION)
    return deliverTree(deliverImage(response))
  }

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
    return try {
      dispatchOwned(callId, request, prepared, cancellation)
    } catch (_: Exception) {
      // 只有这条请求取得了 prepare；异常时撤回未派发或保留已派发的未知记录。
      runCatching { exchange("cancel", callId) }.getOrElse { error("native-request-failed", "unknown") }
    }
  }

  private fun dispatchOwned(callId: String, request: JSONObject, prepared: JSONObject,
    cancellation: NativeControlSocketServer.Cancellation): JSONObject {
    var plan = prepared.optJSONObject("plan") ?: return withdraw(callId, "missing-native-plan")
    if (cancellation.isCancelled()) return exchange("cancel", callId)
    val latest = refresh()
    if (!latest.optBoolean("ok")) return withdraw(callId, "facts-refresh-failed")
    if (cancellation.isCancelled()) return exchange("cancel", callId)
    if (!platform.implements(plan)) {
      plan = fallback(callId, plan, cancellation)?.optJSONObject("plan")
        ?: return withdraw(callId, "platform-adapter-unavailable")
    }
    if (cancellation.isCancelled()) return exchange("cancel", callId)
    var committed = exchange("commit", callId)
    if (committed.optString("code") == "authorization-changed" && fallback(callId, plan, cancellation) != null) {
      if (cancellation.isCancelled()) return exchange("cancel", callId)
      committed = exchange("commit", callId)
    }
    if (committed.optString("dispatch") != "permitted") {
      // 未取得派发许可只撤销 prepared；不要留下可误派的待办。
      exchange("cancel", callId)
      return committed
    }
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(request.optLong("timeoutMs", 15_000L))
    return dispatchCommitted(callId, committed, cancellation, deadline)
  }

  private fun fallback(callId: String, original: JSONObject, cancellation: NativeControlSocketServer.Cancellation): JSONObject? {
    if (original.optString("backend") != "a11y" || original.has("nodeTarget") || cancellation.isCancelled()) return null
    val alternate = exchange("fallbackUnavailableA11y", callId)
    val plan = alternate.optJSONObject("plan") ?: return null
    return alternate.takeIf { it.optBoolean("ok") && platform.implements(plan) }
  }

  private fun dispatchCommitted(callId: String, committed: JSONObject,
    cancellation: NativeControlSocketServer.Cancellation, deadline: Long): JSONObject {
    val committedPlan = committed.optJSONObject("plan") ?: return settle(callId, error("missing-dispatch-plan", "unknown"))
    val nativeArgs = committedPlan.optJSONObject("args")
      ?: return settle(callId, error("missing-native-arguments", "no")
        .put("screenId", committedPlan.opt("screenId") ?: JSONObject.NULL))
    if (committed.optString("callId") != callId) return settle(callId, error("dispatch-call-mismatch", "unknown"))
    var denied: JSONObject? = null
    val gateLock = Any()
    val gateConsumed = AtomicBoolean(false)
    val gateGranted = AtomicBoolean(false)
    val gate = { synchronized(gateLock) {
      val allowed = if (!gateConsumed.compareAndSet(false, true) || cancellation.isCancelled() || System.nanoTime() >= deadline) false else {
        val latestFacts = core.fastExchange(envelope("publishFacts").put("facts", facts.capture()))
        val check = if (latestFacts.optBoolean("ok")) core.fastExchange(envelope("validateDispatch", callId))
          else JSONObject().put("valid", false).put("settleHint", error("facts-current-unavailable", "no"))
        val valid = check.optBoolean("valid") && check.optString("dispatch") == "permitted"
        if (!valid) denied = check.optJSONObject("settleHint")
        valid
      }
      if (allowed) gateGranted.set(true)
      allowed
    } }
    val receipt = try {
      platform.execute(callId, committedPlan, nativeArgs, { refresh().optBoolean("ok") }, gate)
        .get((deadline - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS)
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
    // Permanently close this adapter's gate before attempting a different adapter. Only a
    // returned definite no may switch, and Rust independently checks current A11y facts.
    synchronized(gateLock) { gateConsumed.set(true) }
    if (!gateGranted.get() && receipt.optString("executed") == "no" && !cancellation.isCancelled() &&
      System.nanoTime() < deadline && committedPlan.optString("backend") == "a11y" &&
      refresh().optBoolean("ok")) {
      val alternate = fallback(callId, committedPlan, cancellation)
      if (alternate?.optString("dispatch") == "permitted") return dispatchCommitted(callId, alternate, cancellation, deadline)
    }
    var result = denied ?: if (receipt.optString("executed") == "yes" && !gateGranted.get()) {
      error("platform-authorization-unconfirmed", "unknown")
    } else receipt
    // Adapter 不得改写 Rust 绑定的屏幕；回执的 screenId 总是沿用获准计划。
    result.put("screenId", committedPlan.opt("screenId") ?: JSONObject.NULL)
    if (cancellation.isCancelled()) return exchange("cancel", callId)
    if (result.optString("executed") == "yes") {
      val refreshedAfterAction = runCatching { refresh().optBoolean("ok") }.getOrDefault(false)
      if (!refreshedAfterAction) result = error("post-facts-unavailable", "yes")
        .put("screenId", committedPlan.opt("screenId") ?: JSONObject.NULL)
    }
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

  private fun deliverTree(response: JSONObject): JSONObject {
    val metadata = response.optJSONObject("data")?.optJSONObject("tree")
      ?: response.optJSONObject("receipt")?.optJSONObject("data")?.optJSONObject("tree") ?: return response
    if (!response.optBoolean("ok") || response.optString("executed") != "yes") return response
    val callId = response.optString("callId")
    fun unavailable(code: String) = JSONObject(response.toString()).put("ok", false).put("code", code)
    return try {
      if (!refresh().optBoolean("ok")) return unavailable("tree-facts-unavailable")
      val native = exchange("readTree", callId)
      val tree = native.optJSONObject("tree") ?: return unavailable(native.optString("code", "tree-unavailable"))
      if (!native.optBoolean("ok") || tree.opt("snapshotId") != metadata.opt("snapshotId") ||
        tree.opt("epoch") != metadata.opt("epoch") || tree.opt("generation") != metadata.opt("generation") ||
        tree.optString("screenId") != response.optString("screenId")) return unavailable("tree-integrity-failed")
      response.put("tree", tree)
    } catch (_: Exception) { unavailable("tree-delivery-failed") }
  }

  /** 字节封装与完整性检查，不裁剪、压缩或推断图像尺寸。 */
  private fun deliverImage(response: JSONObject): JSONObject {
    val metadata = response.optJSONObject("data")?.optJSONObject("image")
      ?: response.optJSONObject("receipt")?.optJSONObject("data")?.optJSONObject("image")
      ?: return response
    if (!response.optBoolean("ok") || response.optString("executed") != "yes") return response
    val callId = response.optString("callId")
    fun unavailable(code: String): JSONObject = error(code, response.optString("executed", "unknown"))
      .put("protocolVersion", NativeControlFrames.PROTOCOL_VERSION).put("callId", callId)
      .put("screenId", response.opt("screenId") ?: JSONObject.NULL)
      .also { result -> for (key in listOf("phase", "terminal", "receipt")) {
        if (response.has(key)) result.put(key, response.get(key))
      } }
    return try {
      if (!refresh().optBoolean("ok")) return unavailable("image-facts-unavailable")
      val image = core.readImage(callId) ?: return unavailable("image-unavailable")
      val nativeMetadata = JSONObject(image.metadata)
      val bytes = image.jpeg ?: return unavailable(nativeMetadata.optString("code", "image-unavailable"))
      if (bytes.isEmpty() || bytes.size > 1024 * 1024 || !sameImageMetadata(nativeMetadata, metadata))
        return unavailable("image-integrity-failed")
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
      if (nativeMetadata.optInt("bytes") != bytes.size || nativeMetadata.optString("sha256") != digest)
        return unavailable("image-integrity-failed")
      response.put("image", JSONObject(nativeMetadata.toString()).put("data", Base64.getEncoder().encodeToString(bytes)))
    } catch (_: Exception) { unavailable("image-delivery-failed") }
  }

  private fun sameImageMetadata(left: JSONObject, right: JSONObject): Boolean {
    if (left.length() != right.length()) return false
    val keys = left.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      val a = left.opt(key)
      val b = right.opt(key)
      if (a is JSONObject && b is JSONObject) {
        if (!sameImageMetadata(a, b)) return false
      } else if (a != b) return false
    }
    return true
  }
  private fun exchange(kind: String, callId: String? = null): JSONObject = core.exchange(envelope(kind, callId))
  private fun envelope(kind: String, callId: String? = null): JSONObject = JSONObject()
    .put("protocolVersion", NativeControlFrames.PROTOCOL_VERSION).put("kind", kind)
    .also { if (callId != null) it.put("callId", callId) }

  private fun error(code: String, executed: String): JSONObject = JSONObject()
    .put("ok", false).put("code", code).put("executed", executed).put("screenId", JSONObject.NULL)
}
