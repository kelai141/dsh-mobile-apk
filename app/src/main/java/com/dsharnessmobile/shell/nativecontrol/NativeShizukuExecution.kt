package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.os.SystemClock
import com.dsharnessmobile.shell.ShizukuTransport
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException

/**
 * Executes Rust-authorized real-screen input: the point tap (bit 0) and focused-editor text (bit 1).
 * Also executes Rust-authorized root `launchApp` (display 0) and `keyEvent` plans without requiring Shizuku.
 * It never chooses the channel and never substitutes another input path.
 */
internal class NativeShizukuExecution(
  private val a11y: NativeControlDispatcher.Platform,
  /**
   * 别名到 Android displayId 的唯一来源：本应用自己的虚拟屏注册表。
   * 计划里的显式目标必须与它一致；找不到就是没登记，绝不退回「当前选中屏」。
   */
  private val displayIdForAlias: (String) -> Int? =
    { alias -> com.dsharnessmobile.shell.VdisplayController.displayIdForAlias(alias) },
  private val context: () -> Context? = { null },
  private val executeRootKeyEvent: (
    context: Context?,
    displayId: Int,
    screenId: String,
    key: String,
    authorize: () -> Boolean,
  ) -> JSONObject = { app, displayId, screenId, key, authorize ->
    if (app == null) JSONObject().put("ok", false).put("code", "root-host-unavailable")
      .put("executed", "no").put("screenId", screenId)
    else com.dsharnessmobile.shell.VdisplayController.keyEventViaRoot(app, displayId, screenId, key, authorize)
  },
  private val executeRootLaunchApp: (
    context: Context?,
    pkg: String,
    authorize: () -> Boolean,
  ) -> JSONObject = { app, pkg, authorize ->
    if (app == null) JSONObject().put("ok", false).put("code", "root-host-unavailable")
      .put("executed", "no").put("screenId", "real")
    else com.dsharnessmobile.shell.VdisplayController.launchRealAppViaRoot(app, pkg, authorize)
  },
) : NativeControlDispatcher.Platform {
  override fun implements(plan: JSONObject): Boolean =
    if (plan.optString("backend") == "shizuku")
      isRealTap(plan) || isRealText(plan) || isRealSnapshot(plan) || isRealFeature(plan) || isRealNode(plan) ||
        isVirtualText(plan) || isVirtualGesture(plan) || isVirtualSnapshot(plan) ||
        isVirtualFeature(plan) || isVirtualNode(plan)
    else if (plan.optString("backend") == "root")
      isRootLaunchApp(plan) || isRootKeyEvent(plan)
    else a11y.implements(plan)

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    if (plan.optString("backend") == "root") {
      if (isRootLaunchApp(plan)) return rootLaunchApp(args, authorize)
      if (isRootKeyEvent(plan)) return rootKeyEvent(plan, args, authorize)
      return rejected("platform-adapter-unavailable")
    }
    if (plan.optString("backend") != "shizuku") return a11y.execute(callId, plan, args, refreshFacts, authorize)
    if (isVirtualText(plan)) return virtualText(plan, args, authorize)
    if (isVirtualGesture(plan)) return virtualGesture(plan, args, authorize)
    if (isVirtualSnapshot(plan)) return snapshot(callId, plan, refreshFacts, authorize)
    if (isVirtualNode(plan)) return virtualNode(callId, plan, args, authorize)
    if (isVirtualFeature(plan)) return virtualFeature(callId, plan, args, refreshFacts, authorize)
    if (isRealNode(plan)) {
      val node = plan.getJSONObject("nodeTarget")
      val rawPath = node.getJSONArray("path")
      val path = IntArray(rawPath.length()) { rawPath.getInt(it) }
      val deadline = SystemClock.elapsedRealtime() + 4_000L
      return try {
        worker.supplyAsync({
          val measured = ShizukuTransport.nativeNodeReal(node.getInt("windowId"), path, "read", JSONObject(), "", deadline) { true }
          if (!measured.optBoolean("ok")) return@supplyAsync measured
          val body = measured.getString("body")
          val verify = JSONObject().put("protocolVersion", 1).put("kind", "verifyNode").put("callId", callId).put("node", JSONObject(body))
          if (!JSONObject(NativeControlCore.exchangeNonblocking(verify.toString())).optBoolean("ok"))
            return@supplyAsync JSONObject().put("ok", false).put("code", "node-changed").put("executed", "no")
          val result = ShizukuTransport.nativeNodeReal(node.getInt("windowId"), path, plan.getString("operation"), args, body, deadline, authorize)
          if (result.optBoolean("ok") && plan.getString("operation") == "nodeText") {
            val raw = JSONObject(result.getString("body"))
            result.put("data", JSONObject().put("text", raw.getString("text"))
              .put("description", raw.getString("contentDescription")).put("editable", raw.getBoolean("editable")))
          }
          result.remove("body")
          result
        })
      } catch (_: RejectedExecutionException) { rejected("shizuku-native-input-busy") }
    }
    if (isRealTap(plan)) {
      val x = args.getInt("x")
      val y = args.getInt("y")
      return try {
        worker.supplyAsync({ ShizukuTransport.nativeTapReal(x, y, authorize) })
      } catch (_: RejectedExecutionException) {
        rejected("shizuku-native-input-busy")
      }
    }
    if (isRealText(plan)) {
      val text = args.optString("text")
      if (!args.has("text")) return rejected("invalid-text")
      if (text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_BYTES) return rejected("invalid-text")
      val clear = args.optBoolean("clear", true)
      // An expired request must never queue: the deadline is fixed before the worker is handed off.
      val deadline = SystemClock.elapsedRealtime() + TEXT_BUDGET_MS
      return try {
        worker.supplyAsync({ ShizukuTransport.nativeSetTextReal(text, clear, deadline, authorize) })
      } catch (_: RejectedExecutionException) {
        rejected("shizuku-native-input-busy")
      }
    }
    if (isRealSnapshot(plan)) return snapshot(callId, plan, refreshFacts, authorize)
    if (isRealFeature(plan)) {
      val operation = plan.getString("operation")
      val deadline = SystemClock.elapsedRealtime() + 4_000L
      return try {
        worker.supplyAsync({
          if (operation in setOf("screenshot", "readRegion")) {
            val target = NativeAccessibilityPlatform.RawTarget(0, "real", plan.getInt("width"),
              plan.getInt("height"), plan.getString("epoch"), plan.getString("generation"))
            val descriptor = ShizukuTransport.nativeCaptureReal(deadline, authorize)
              ?: return@supplyAsync JSONObject().put("ok", false).put("code", "shizuku-frame-unavailable").put("executed", "no")
            val frame = runCatching { NativeShizukuFrame.read(descriptor, target, deadline) }.getOrNull()
              ?: return@supplyAsync JSONObject().put("ok", false).put("code", "shizuku-frame-invalid").put("executed", "yes")
            if (!refreshFacts()) return@supplyAsync JSONObject().put("ok", false).put("code", "image-facts-unavailable").put("executed", "yes")
            val metadata = JSONObject().put("callId", callId).put("epoch", target.epoch)
              .put("screenId", "real").put("displayId", 0).put("generation", target.generation)
              .put("logicalWidth", target.logicalWidth).put("logicalHeight", target.logicalHeight)
              .put("width", frame.width).put("height", frame.height).put("rowStride", frame.rowStride)
              .put("premultipliedAlpha", frame.premultipliedAlpha).put("transform", frame.transform)
            receipt(JSONObject(NativeControlCore.encodeFrame(metadata.toString(), frame.bytes)))
          } else {
            val motion = JSONObject(args.toString())
            if (operation == "scroll") motion.put("width", plan.getInt("width")).put("height", plan.getInt("height"))
            ShizukuTransport.nativeMotionReal(operation, motion, deadline, authorize)
          }
        })
      } catch (_: RejectedExecutionException) { rejected("shizuku-native-input-busy") }
    }
    return rejected("platform-adapter-unavailable")
  }

  private fun isRealTap(plan: JSONObject): Boolean =
    plan.optString("operation") == "click" && plan.optString("screenId") == "real" &&
      plan.optInt("displayId", -1) == 0 && !plan.has("nodeTarget")

  /** Focused-editor text only: a node-targeted setText stays with the accessibility adapter. */
  private fun isRealText(plan: JSONObject): Boolean =
    plan.optString("operation") == "setText" && plan.optString("screenId") == "real" &&
      plan.optInt("displayId", -1) == 0 && !plan.has("nodeTarget")

  /** Real display 0 only. A virtual alias or any other display stays with the accessibility adapter. */
  private fun isRealSnapshot(plan: JSONObject): Boolean =
    plan.optString("operation") == "snapshot" && plan.optString("screenId") == "real" &&
      plan.optInt("displayId", -1) == 0

  private fun isRealFeature(plan: JSONObject): Boolean =
    plan.optString("screenId") == "real" && plan.optInt("displayId", -1) == 0 && !plan.has("nodeTarget") &&
      plan.optString("operation") in setOf("screenshot", "readRegion", "longClick", "scroll",
        "swipe", "keyEvent", "global", "launchApp")

  private fun isRealNode(plan: JSONObject): Boolean = plan.optString("screenId") == "real" &&
    plan.optInt("displayId", -1) == 0 && plan.optJSONObject("nodeTarget")?.let {
      it.optInt("windowId", -1) >= 0 && it.optJSONArray("path")?.let { path ->
        path.length() <= 40 && (0 until path.length()).all { index -> path.optInt(index, -1) in 0..4000 }
      } == true
    } == true &&
    plan.optString("operation") in setOf("click", "longClick", "setText", "scroll", "nodeText")

  // ── 独立授权 Root 执行面（launchApp / keyEvent，不依赖 Shizuku） ───────────

  private fun isRootLaunchApp(plan: JSONObject): Boolean =
    plan.optString("backend") == "root" && plan.optString("operation") == "launchApp" &&
      plan.optString("screenId") == "real" && plan.optInt("displayId", -1) == 0 && !plan.has("nodeTarget")

  private fun isRootKeyEvent(plan: JSONObject): Boolean =
    plan.optString("backend") == "root" && plan.optString("operation") == "keyEvent" && !plan.has("nodeTarget") &&
      ((plan.optString("screenId") == "real" && plan.optInt("displayId", -1) == 0) || virtualDisplayTarget(plan) != null)

  private fun rootLaunchApp(args: JSONObject, authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val pkg = args.optString("pkg")
    if (!NativeShizukuMotion.validPackage(pkg)) return rejected("invalid-package")
    return try {
      worker.supplyAsync({
        val guard = { try { authorize() } catch (_: Exception) { false } }
        executeRootLaunchApp(context(), pkg, guard)
      })
    } catch (_: RejectedExecutionException) {
      rejected("shizuku-native-input-busy")
    }
  }

  private fun rootKeyEvent(plan: JSONObject, args: JSONObject,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val key = args.optString("key")
    if (NativeShizukuMotion.keycodeFor(key) == null) return rejected("invalid-key")
    val target = if (plan.optString("screenId") == "real" && plan.optInt("displayId", -1) == 0) {
      "real" to 0
    } else {
      virtualDisplayTarget(plan) ?: return rejected("shizuku-motion-target-unregistered")
    }
    return try {
      worker.supplyAsync({
        val guard = { try { authorize() } catch (_: Exception) { false } }
        executeRootKeyEvent(context(), target.second, target.first, key, guard)
      })
    } catch (_: RejectedExecutionException) {
      rejected("shizuku-native-input-busy")
    }
  }

  // ── 虚拟屏：只认已登记且在事实面测过的 displayId ───────────────────────────

  private fun virtualDisplayTarget(plan: JSONObject): Pair<String, Int>? {
    val alias = plan.optString("screenId")
    if (!NativeVdisplayExecution.isVirtualAlias(alias)) return null
    val displayId = plan.optInt("displayId", -1)
    if (displayId <= 0) return null
    val registered = runCatching { displayIdForAlias(alias) }.getOrNull()
    if (registered != displayId) return null
    return alias to displayId
  }

  /**
   * 虚拟屏目标的统一形状检查：backend 是 shizuku、alias 是产品别名、displayId 与别名当前一致。
   * 显式目标必须自己成立——绝不拿「当前选中屏」补上缺的 displayId。
   */
  private fun virtualTarget(plan: JSONObject): Pair<String, Int>? {
    if (plan.optString("backend") != "shizuku") return null
    return virtualDisplayTarget(plan)
  }

  private fun isVirtualText(plan: JSONObject): Boolean =
    plan.optString("operation") == "setText" && !plan.has("nodeTarget") && virtualTarget(plan) != null

  /** 虚拟屏坐标点击/长按/滑动：不依赖无障碍，只需目标屏已登记且测到坐标手势。 */
  private fun isVirtualGesture(plan: JSONObject): Boolean =
    !plan.has("nodeTarget") && virtualTarget(plan) != null &&
      plan.optString("operation") in setOf("click", "longClick", "scroll", "swipe", "keyEvent", "global")

  private fun virtualGesture(plan: JSONObject, args: JSONObject,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val target = virtualTarget(plan) ?: return rejected("shizuku-motion-target-unregistered")
    val operation = plan.getString("operation")
    val motion = JSONObject(args.toString())
    if (operation == "scroll") motion.put("width", plan.getInt("width")).put("height", plan.getInt("height"))
    val deadline = SystemClock.elapsedRealtime() + 4_000L
    return try {
      worker.supplyAsync({
        ShizukuTransport.nativeMotionDisplay(target.second, target.first, operation, motion, deadline, authorize)
          .put("screenId", target.first)
      })
    } catch (_: RejectedExecutionException) {
      rejected("shizuku-native-input-busy")
    }
  }

  private fun isVirtualSnapshot(plan: JSONObject): Boolean =
    plan.optString("operation") == "snapshot" && virtualTarget(plan) != null

  private fun isVirtualFeature(plan: JSONObject): Boolean =
    virtualTarget(plan) != null && !plan.has("nodeTarget") &&
      plan.optString("operation") in setOf("screenshot", "readRegion")

  private fun isVirtualNode(plan: JSONObject): Boolean = virtualTarget(plan) != null &&
    plan.optJSONObject("nodeTarget")?.let {
      it.optInt("windowId", -1) >= 0 && it.optJSONArray("path")?.let { path ->
        path.length() <= 40 && (0 until path.length()).all { index -> path.optInt(index, -1) in 0..4000 }
      } == true
    } == true &&
    plan.optString("operation") in setOf("click", "longClick", "setText", "scroll", "nodeText")

  /**
   * 虚拟屏焦点文本：displayId 由计划固定，写入前不会再被选中屏改掉。
   * 写入后任何不确定都保持 unknown，绝不能报 no 让上层以为没发生副作用。
   */
  private fun virtualText(plan: JSONObject, args: JSONObject,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val target = virtualTarget(plan) ?: return rejected("shizuku-editor-target-unregistered")
    val text = args.optString("text")
    if (!args.has("text")) return rejected("invalid-text")
    if (text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_BYTES) return rejected("invalid-text")
    val clear = args.optBoolean("clear", true)
    val deadline = SystemClock.elapsedRealtime() + TEXT_BUDGET_MS
    return try {
      worker.supplyAsync({
        ShizukuTransport.nativeSetTextDisplay(target.second, target.first, text, clear, deadline, authorize)
      })
    } catch (_: RejectedExecutionException) {
      rejected("shizuku-native-input-busy")
    }
  }

  /**
   * 虚拟屏节点动作：先读一次并由 Rust verifyNode 确认，再用同一 window/path 执行一次动作。
   * 读与写都带同一个 displayId，服务侧还会再核对窗口归属该屏。
   */
  private fun virtualNode(callId: String, plan: JSONObject, args: JSONObject,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val target = virtualTarget(plan) ?: return rejected("shizuku-node-target-unregistered")
    val node = plan.getJSONObject("nodeTarget")
    val rawPath = node.getJSONArray("path")
    val path = IntArray(rawPath.length()) { rawPath.getInt(it) }
    val windowId = node.getInt("windowId")
    val operation = plan.getString("operation")
    val deadline = SystemClock.elapsedRealtime() + 4_000L
    return try {
      worker.supplyAsync({
        val measured = ShizukuTransport.nativeNodeDisplay(target.second, target.first, windowId, path,
          "read", JSONObject(), "", deadline) { true }
        if (!measured.optBoolean("ok")) return@supplyAsync measured
        val body = measured.getString("body")
        val verify = JSONObject().put("protocolVersion", 1).put("kind", "verifyNode")
          .put("callId", callId).put("node", JSONObject(body))
        if (!JSONObject(NativeControlCore.exchangeNonblocking(verify.toString())).optBoolean("ok"))
          return@supplyAsync JSONObject().put("ok", false).put("code", "node-changed").put("executed", "no")
        val result = ShizukuTransport.nativeNodeDisplay(target.second, target.first, windowId, path,
          operation, args, body, deadline, authorize)
        if (result.optBoolean("ok") && operation == "nodeText") {
          val raw = JSONObject(result.getString("body"))
          result.put("data", JSONObject().put("text", raw.getString("text"))
            .put("description", raw.getString("contentDescription")).put("editable", raw.getBoolean("editable")))
        }
        result.remove("body")
        result
      })
    } catch (_: RejectedExecutionException) { rejected("shizuku-native-input-busy") }
  }

  /**
   * 虚拟屏原始帧。目标几何来自 Rust 计划；帧尺寸必须与计划一致，否则整帧丢弃。
   * 读取路径不带任何选中屏回落，服务侧按 alias 现查 SurfaceFlinger token。
   */
  private fun virtualFeature(callId: String, plan: JSONObject, args: JSONObject,
    refreshFacts: () -> Boolean, authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val target = virtualTarget(plan) ?: return rejected("shizuku-frame-target-unregistered")
    val operation = plan.getString("operation")
    val deadline = SystemClock.elapsedRealtime() + 4_000L
    return try {
      worker.supplyAsync({
        val raw = NativeAccessibilityPlatform.RawTarget(target.second, target.first, plan.getInt("width"),
          plan.getInt("height"), plan.getString("epoch"), plan.getString("generation"))
        val descriptor = ShizukuTransport.nativeCaptureDisplay(raw.displayId, raw.screenId, deadline, authorize)
          ?: return@supplyAsync JSONObject().put("ok", false).put("code", "shizuku-frame-unavailable")
            .put("executed", "no").put("screenId", raw.screenId)
        val frame = runCatching { NativeShizukuFrame.read(descriptor, raw, deadline) }.getOrNull()
          ?: return@supplyAsync JSONObject().put("ok", false).put("code", "shizuku-frame-invalid")
            .put("executed", "yes").put("screenId", raw.screenId)
        if (!refreshFacts()) return@supplyAsync JSONObject().put("ok", false)
          .put("code", "image-facts-unavailable").put("executed", "yes").put("screenId", raw.screenId)
        val metadata = JSONObject().put("callId", callId).put("epoch", raw.epoch)
          .put("screenId", raw.screenId).put("displayId", raw.displayId).put("generation", raw.generation)
          .put("logicalWidth", raw.logicalWidth).put("logicalHeight", raw.logicalHeight)
          .put("width", frame.width).put("height", frame.height).put("rowStride", frame.rowStride)
          .put("premultipliedAlpha", frame.premultipliedAlpha).put("transform", frame.transform)
        receipt(JSONObject(NativeControlCore.encodeFrame(metadata.toString(), frame.bytes)))
      })
    } catch (_: RejectedExecutionException) { rejected("shizuku-native-input-busy") }
  }

  /**
   * Raw tree published by the service. The Rust plan already owns screenId/epoch/generation/size,
   * so this adapter only copies those fields into the target; it never derives them from the tree.
   */
  private fun snapshot(callId: String, plan: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val screenId = plan.getString("screenId")
    val displayId = plan.getInt("displayId")
    val virtual = displayId != 0
    if (virtual && virtualTarget(plan) == null) return rejected("shizuku-tree-target-unregistered")
    val target = JSONObject().put("displayId", displayId)
      .put("screenId", screenId)
      .put("logicalWidth", plan.getInt("width"))
      .put("logicalHeight", plan.getInt("height"))
      .put("epoch", plan.getString("epoch"))
      .put("generation", plan.getString("generation"))
    val deadline = SystemClock.elapsedRealtime() + TREE_BUDGET_MS
    return try {
      worker.supplyAsync({
        val reply = if (virtual) ShizukuTransport.nativeSnapshotDisplay(displayId, screenId, deadline, authorize)
        else ShizukuTransport.nativeSnapshotReal(deadline, authorize)
        if (!reply.optBoolean("ok")) return@supplyAsync JSONObject().put("ok", false)
          .put("code", reply.optString("code", "shizuku-tree-unavailable"))
          .put("executed", if (reply.optString("executed") == "yes") "unknown" else "no")
          .put("screenId", screenId)
        val body = reply.optString("body")
        if (body.isBlank() || body.toByteArray(Charsets.UTF_8).size > MAX_TREE_BYTES)
          return@supplyAsync JSONObject().put("ok", false).put("code", "shizuku-tree-too-large").put("executed", "no").put("screenId", screenId)
        if (!refreshFacts()) return@supplyAsync JSONObject().put("ok", false)
          .put("code", "tree-facts-unavailable").put("executed", "yes").put("screenId", screenId)
        receipt(JSONObject(NativeControlCore.publishTree(callId,
          NativeShizukuTreeBody.withTarget(body, target))))
      })
    } catch (_: RejectedExecutionException) {
      rejected("shizuku-native-input-busy")
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

  companion object {
    private const val MAX_TEXT_BYTES = 8192
    // The editor rejects anything above 5s; this leaves room for the capability probe and verify.
    private const val TEXT_BUDGET_MS = 4_000L
    // Binder reply budget for one tree body; the service bounds itself well below this.
    private const val MAX_TREE_BYTES = 512 * 1024
    private const val TREE_BUDGET_MS = 5_000L

    // A hung Binder blocks at most one worker. No queue can dispatch an expired request later.
    private val worker = NativeOperationWorker("dsh-native-shizuku")
  }
}
