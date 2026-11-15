package com.dsharnessmobile.shell.nativecontrol

import com.dsharnessmobile.shell.DeviceControlService
import org.json.JSONObject
import java.util.concurrent.CompletableFuture

/** 原生无障碍接线；SDK 只在 adapter 内执行，图像交给 Rust 编码与裁剪。 */
internal class NativeA11yExecution : NativeControlDispatcher.Platform {
  fun supportedOperations(displayId: Int): List<String> {
    val service = DeviceControlService.nativePlatformService() ?: return emptyList()
    val platform = NativeAccessibilityPlatform(service)
    return buildList {
      if (platform.pointGesturesSupported(displayId)) addAll(listOf("click", "longClick", "scroll", "swipe"))
      if (platform.screenshotsSupported(displayId)) addAll(listOf("screenshot", "readRegion"))
      if (platform.globalActionsSupported(displayId)) add("global")
      if (platform.windowContentSupported(displayId)) addAll(listOf("snapshot", "click", "longClick", "scroll", "setText", "nodeText"))
    }
  }

  override fun implements(plan: JSONObject): Boolean =
    plan.optString("backend") == "a11y" && plan.optString("operation") in setOf(
      "click", "longClick", "scroll", "swipe", "setText", "nodeText", "screenshot", "readRegion", "snapshot", "global",
    ) &&
      DeviceControlService.nativePlatformService() != null

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val service = DeviceControlService.nativePlatformService()
      ?: return rejected("a11y-offline")
    if (!implements(plan)) return rejected("platform-adapter-unavailable")
    val target = NativeAccessibilityPlatform.RawTarget(
      displayId = plan.getInt("displayId"),
      screenId = plan.getString("screenId"),
      logicalWidth = plan.getInt("width"),
      logicalHeight = plan.getInt("height"),
      epoch = plan.getString("epoch"),
      generation = plan.getString("generation"),
    )
    val platform = NativeAccessibilityPlatform(service)
    if (plan.getString("operation") == "snapshot") {
      return platform.snapshot(target, authorize).thenApply { outcome ->
        when (outcome) {
          is NativeAccessibilityPlatform.TreeOutcome.Rejected -> JSONObject().put("ok", false)
            .put("code", outcome.code).put("executed", "no").put("screenId", target.screenId)
          is NativeAccessibilityPlatform.TreeOutcome.Ok -> {
            if (!refreshFacts()) return@thenApply JSONObject().put("ok", false)
              .put("code", "tree-facts-unavailable").put("executed", "yes").put("screenId", target.screenId)
            receipt(JSONObject(NativeControlCore.publishTree(callId, NativeRawTreeJson.encode(outcome.tree))))
          }
        }
      }
    }
    if (plan.getString("operation") in setOf("screenshot", "readRegion")) {
      return platform.captureRawFrame(target, authorize).thenApply { outcome ->
        when (outcome) {
          is NativeAccessibilityPlatform.CaptureOutcome.Failed -> JSONObject().put("ok", false)
            .put("code", outcome.code).put("executed", outcome.executed).put("screenId", target.screenId)
          is NativeAccessibilityPlatform.CaptureOutcome.Frame -> {
            val frame = outcome.frame
            if (!refreshFacts()) return@thenApply JSONObject().put("ok", false)
              .put("code", "image-facts-unavailable").put("executed", "yes").put("screenId", target.screenId)
            val metadata = JSONObject().put("callId", callId).put("epoch", frame.target.epoch)
              .put("screenId", frame.target.screenId).put("displayId", frame.target.displayId)
              .put("generation", frame.target.generation).put("logicalWidth", frame.target.logicalWidth)
              .put("logicalHeight", frame.target.logicalHeight).put("width", frame.width).put("height", frame.height)
              .put("rowStride", frame.rowStride).put("premultipliedAlpha", frame.premultipliedAlpha)
              .put("transform", frame.transform)
            val encoded = JSONObject(NativeControlCore.encodeFrame(metadata.toString(), frame.bytes))
            receipt(encoded)
          }
        }
      }
    }
    val operation = plan.getString("operation")
    val node = plan.optJSONObject("nodeTarget")?.let { native ->
      val path = native.getJSONArray("path")
      NativeAccessibilityPlatform.RawNodeTarget(native.getInt("windowId"), List(path.length()) { path.getInt(it) })
    }
    if (args.has("ref") && node == null) return rejected("node-target-required")
    val verify: (NativeAccessibilityPlatform.RawNode) -> Boolean = { raw ->
      val verification = JSONObject().put("protocolVersion", NativeControlFrames.PROTOCOL_VERSION)
        .put("kind", "verifyNode").put("callId", callId).put("node", NativeRawTreeJson.node(raw))
      JSONObject(NativeControlCore.exchangeNonblocking(verification.toString())).optBoolean("ok")
    }
    if (operation == "nodeText") {
      if (node == null) return rejected("node-target-required")
      return platform.nodeText(target, node, verify, authorize).thenApply { result ->
        when (result) {
          is NativeAccessibilityPlatform.NodeTextOutcome.Rejected -> JSONObject().put("ok", false)
            .put("code", result.code).put("executed", result.executed)
          is NativeAccessibilityPlatform.NodeTextOutcome.Ok -> {
            val data = JSONObject().put("text", result.node.text)
              .put("description", result.node.contentDescription).put("editable", result.node.editable)
            if (data.toString().toByteArray(Charsets.UTF_8).size > 12 * 1024)
              JSONObject().put("ok", false).put("code", "node-text-too-large").put("executed", "yes")
            else JSONObject().put("ok", true).put("code", "node-text-read").put("executed", "yes").put("data", data)
          }
        }
      }
    }
    val future = when (operation) {
      "click", "longClick" -> if (node != null) platform.clickNode(target, node, verify, authorize, operation == "longClick")
        else if (operation == "click") platform.clickAt(target, args.getInt("x"), args.getInt("y"), authorize)
        else platform.longClickAt(target, args.getInt("x"), args.getInt("y"), 600L, authorize)
      "setText" -> if (node != null) platform.setTextNode(target, node, args.getString("text"), args.getBoolean("clear"), verify, authorize)
        else platform.setFocusedText(target, args.getString("text"), args.getBoolean("clear"), authorize)
      "scroll" -> if (node != null) platform.scrollNode(target, node, args.getString("direction"), verify, authorize)
        else platform.scrollAt(target, args.getInt("x"), args.getInt("y"), args.getString("direction"), args.getDouble("fraction"), authorize)
      "swipe" -> platform.swipe(target, args.getInt("x1"), args.getInt("y1"), args.getInt("x2"), args.getInt("y2"),
        args.optLong("durationMs", 300), authorize)
      "global" -> platform.globalAction(target, args.getString("action"), authorize)
      else -> return rejected("platform-adapter-unavailable")
    }
    return future.thenApply { result ->
      JSONObject().put("ok", result.executed == "yes").put("code", result.code)
        .put("executed", result.executed).put("screenId", target.screenId)
    }
  }

  private fun receipt(native: JSONObject) = JSONObject().also { result ->
    for (key in listOf("ok", "code", "executed", "screenId", "data", "diagnostic")) {
      if (native.has(key)) result.put(key, native.get(key))
    }
  }

  private fun rejected(code: String): CompletableFuture<JSONObject> = CompletableFuture.completedFuture(
    JSONObject().put("ok", false).put("code", code).put("executed", "no"),
  )
}
