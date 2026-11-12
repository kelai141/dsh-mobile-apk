package com.dsharnessmobile.shell.nativecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import com.dsharnessmobile.shell.GlobalActionCatalog
import com.dsharnessmobile.shell.ScreenTargets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 无障碍平台适配层：只读 Android 事实、采集原始树/帧、执行上层获准的 Android 调用。
 *
 * 边界（与 Rust phone-control-core 的约定）：
 * - backend 选择、目标屏幕、范围与授权都由 Rust 决定；本类不保存第二套权限或业务路由。
 * - 不调用 DeviceControlService.handle、ControlCarrier 或旧 Node/ref 解析，也不分配模型 ref。
 * - 树与帧保持原始形态：真实 child 下标、原始像素、原始行跨距。裁剪、缩放、OCR 留给 Rust。
 * - 每个实际 Android 调用前执行上层 finalAuthorize（Rust validateDispatch 的只读快检查）；
 *   返回 false 时结果为 executed=no，且不触碰 SDK。
 * - 派发前的拒绝（executed=no）与派发后的取消/异常/超时（executed=unknown）分开报告；
 *   不自动重试、不切换控件、不回退到真实屏。
 *
 * 生产路径仍由系统绑定服务；本类默认不挂载，由后续 IPC 集成按需构造。
 */
internal class NativeAccessibilityPlatform(
  private val service: AccessibilityService,
  private val main: Handler = Handler(Looper.getMainLooper()),
) {

  /** 一次平台动作的结果。executed 只取 yes/no/unknown。 */
  internal data class ActionOutcome(
    val executed: String,
    val code: String,
    val dispatched: Boolean,
    val detail: String? = null,
  ) {
    companion object {
      fun yes(code: String): ActionOutcome = ActionOutcome("yes", code, true)
      fun no(code: String, detail: String? = null): ActionOutcome = ActionOutcome("no", code, false, detail)
      fun unknown(code: String, detail: String? = null): ActionOutcome = ActionOutcome("unknown", code, true, detail)
    }
  }

  /** 原始树读取结果。 */
  internal sealed class TreeOutcome {
    data class Ok(val tree: RawTree) : TreeOutcome()
    data class Rejected(val code: String, val detail: String? = null) : TreeOutcome()
  }

  /** 原始帧结果。只回一整帧；区域阅读由 Rust 在同一帧上裁剪。 */
  internal sealed class CaptureOutcome {
    data class Frame(val frame: RawFrame) : CaptureOutcome()
    data class Failed(val executed: String, val code: String, val detail: String? = null) : CaptureOutcome()
  }

  /** 节点文本读取结果。 */
  internal sealed class NodeTextOutcome {
    data class Ok(val node: NodeText) : NodeTextOutcome()
    data class Rejected(val executed: String, val code: String, val detail: String? = null) : NodeTextOutcome()
  }

  /** 取消令牌。遍历在节点边界检查，取消后返回已采集部分并标记 stopReason=cancelled。 */
  internal fun interface NativeCancellation {
    fun isCancelled(): Boolean

    companion object {
      val NEVER: NativeCancellation = NativeCancellation { false }
    }
  }

  /** 节点定位目标：显式窗口 + 该窗口内的真实 child 下标路径。窗口选择由 Rust 保存。 */
  internal data class RawNodeTarget(
    val windowId: Int,
    val path: List<Int>,
  )

  /** 精确的显示目标。所有坐标都按该目标的逻辑空间解释。 */
  internal data class RawTarget(
    val displayId: Int,
    val screenId: String,
    val logicalWidth: Int,
    val logicalHeight: Int,
    val epoch: String,
    val generation: String,
  ) {
    /** 目标自检；返回稳定原因码，null 表示形状可用。只校验形状，不推断屏幕身份。 */
    fun rejection(): String? = when {
      displayId < 0 -> "invalid-display"
      screenId.isEmpty() || screenId.length > MAX_SCREEN_ID_CHARS -> "invalid-screen-id"
      screenId.any { it.isISOControl() } -> "invalid-screen-id"
      logicalWidth !in 1..MAX_DIMENSION || logicalHeight !in 1..MAX_DIMENSION -> "invalid-dimension"
      !validToken(epoch) -> "invalid-epoch"
      !validToken(generation) -> "invalid-generation"
      else -> null
    }

    private fun validToken(value: String): Boolean =
      value.length in 1..64 && value.none { it.isWhitespace() || it.isISOControl() }
  }

  /** 逻辑坐标中的左闭右开矩形边界，直接来自 AccessibilityNodeInfo.getBoundsInScreen。 */
  internal data class RawBounds(val left: Int, val top: Int, val right: Int, val bottom: Int)

  /** 原始节点。path 是真实 child 下标序列，root 为空列表；不重排、不剪枝、不分配 ref。 */
  internal data class RawNode(
    val path: List<Int>,
    val className: String,
    val packageName: String,
    val viewId: String,
    val text: String,
    val contentDescription: String,
    val bounds: RawBounds,
    val clickable: Boolean,
    val scrollable: Boolean,
    val editable: Boolean,
    val checkable: Boolean,
    val checked: Boolean,
    val enabled: Boolean,
    val focused: Boolean,
    val visible: Boolean,
    val selected: Boolean,
    val windowId: Int,
  ) {
    fun charCount(): Int = className.length + packageName.length + viewId.length + text.length +
      contentDescription.length
  }

  /** 一次原始树采集。complete=false 时 stopReason 说明预算还是取消。 */
  internal data class RawTree(
    val target: RawTarget,
    val windowId: Int,
    val nodes: List<RawNode>,
    val complete: Boolean,
    val stopReason: String?,
    val elapsedMs: Long,
  )

  /** 能力表。ops 按实际注册的 handler 与当前 SDK/服务能力派生。 */
  internal data class RawCapabilities(
    val displayId: Int,
    val sdkInt: Int,
    val windowContent: Boolean,
    val gestures: Boolean,
    val screenshot: Boolean,
    val ops: List<String>,
    val unsupported: Map<String, String>,
  )

  /**
   * 一张原始帧。bytes 是 1:1 的直通 RGBA，rowStride 为真实行跨距；
   * transform 是显式 raw-to-logical 旋转。只有尺寸完全相等时才给出 identity。
   */
  internal data class RawFrame(
    val target: RawTarget,
    val width: Int,
    val height: Int,
    val rowStride: Int,
    val bytes: ByteArray,
    val transform: String,
    val colorSpace: String,
    val premultipliedAlpha: Boolean,
    val capturedAtMs: Long,
  )

  /** 节点文本读数。 */
  internal data class NodeText(
    val windowId: Int,
    val path: List<Int>,
    val className: String,
    val viewId: String,
    val text: String,
    val contentDescription: String,
    val editable: Boolean,
  )

  private sealed class RootResult {
    class Ok(val root: AccessibilityNodeInfo, val windowId: Int) : RootResult()
    class Rejected(val code: String, val detail: String? = null) : RootResult()
  }

  private sealed class NodeResult {
    class Ok(val node: AccessibilityNodeInfo) : NodeResult()
    class Rejected(val code: String, val detail: String? = null) : NodeResult()
  }

  private class Candidate(
    val windowId: Int,
    val active: Boolean,
    val focused: Boolean,
    val root: AccessibilityNodeInfo,
  )

  private val handlerGuards: List<Pair<String, (Int) -> String?>> = listOf(
    "snapshot.tree" to ::guardContent,
    "nodeText.node" to ::guardContent,
    "click.node" to ::guardContent,
    "setText.node" to ::guardContent,
    "scroll.node" to ::guardContent,
    "click.point" to ::guardGesture,
    "longClick.point" to ::guardGesture,
    "scroll.point" to ::guardGesture,
    "global.real" to ::guardGlobal,
    "screenshot.frame" to ::guardCapture,
    "readRegion.frame" to ::guardCapture,
  )

  /**
   * 当前服务在指定显示上实际支持的 handler。
   * 逐个执行与实际派发相同的 guard；不在别处维护第二份白名单。
   */
  fun pointGesturesSupported(displayId: Int): Boolean = guardGesture(displayId) == null

  fun capabilities(displayId: Int): RawCapabilities {
    val supported = ArrayList<String>(handlerGuards.size)
    val unsupported = LinkedHashMap<String, String>()
    for ((op, guard) in handlerGuards) {
      val reason = try {
        guard(displayId)
      } catch (t: Throwable) {
        "capability-probe-failed:" + describe(t)
      }
      if (reason == null) supported.add(op) else unsupported[op] = reason
    }
    return RawCapabilities(
      displayId = displayId,
      sdkInt = Build.VERSION.SDK_INT,
      windowContent = guardContent(displayId) == null,
      gestures = guardGesture(displayId) == null,
      screenshot = guardCapture(displayId) == null,
      ops = supported,
      unsupported = unsupported,
    )
  }

  /**
   * 采集原始树。
   *
   * 在后台线程读取；最终授权回调在读取前执行。最多 4000 节点、3 秒、固定字符预算；
   * 超限或取消时返回已采集部分并显式标注。根存在但无子节点的空树原样返回。
   */
  fun snapshot(
    target: RawTarget,
    finalAuthorize: () -> Boolean,
    cancel: NativeCancellation = NativeCancellation.NEVER,
  ): CompletableFuture<TreeOutcome> {
    target.rejection()?.let {
      return CompletableFuture.completedFuture(TreeOutcome.Rejected(it, "target rejected"))
    }
    guardContent(target.displayId)?.let {
      return CompletableFuture.completedFuture(TreeOutcome.Rejected(it))
    }
    val future = CompletableFuture<TreeOutcome>()
    try {
      worker.execute {
        val outcome = try {
          readTree(target, finalAuthorize, cancel)
        } catch (t: Throwable) {
          TreeOutcome.Rejected("tree-read-failed", describe(t))
        }
        future.complete(outcome)
      }
    } catch (t: Throwable) {
      future.complete(TreeOutcome.Rejected("worker-unavailable", describe(t)))
    }
    return future
  }

  /** 坐标点击。x/y 以 target 逻辑空间计。 */
  fun clickAt(
    target: RawTarget,
    x: Int,
    y: Int,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> {
    coordinateRejection(target, x, y)?.let { return completedAction(it) }
    return dispatchStroke(target, finalAuthorize, TAP_DURATION_MS) {
      Path().apply { moveTo(x.toFloat(), y.toFloat()) }
    }
  }

  /** 坐标长按。 */
  fun longClickAt(
    target: RawTarget,
    x: Int,
    y: Int,
    durationMs: Long,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> {
    coordinateRejection(target, x, y)?.let { return completedAction(it) }
    val duration = durationMs.coerceIn(MIN_LONG_CLICK_MS, MAX_LONG_CLICK_MS)
    return dispatchStroke(target, finalAuthorize, duration) {
      Path().apply { moveTo(x.toFloat(), y.toFloat()) }
    }
  }

  /** 坐标滚动：以 (x,y) 为中心的滑动，distanceFraction 是轴长的比例。 */
  fun scrollAt(
    target: RawTarget,
    x: Int,
    y: Int,
    direction: String,
    distanceFraction: Double,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> {
    coordinateRejection(target, x, y)?.let { return completedAction(it) }
    if (direction !in DIRECTIONS) return completedAction(ActionOutcome.no("invalid-direction"))
    val segment = NativeRawGeometry.swipeSegment(
      x.toFloat(),
      y.toFloat(),
      target.logicalWidth,
      target.logicalHeight,
      direction,
      distanceFraction,
    ) ?: return completedAction(ActionOutcome.no("gesture-degenerate"))
    return dispatchStroke(target, finalAuthorize, SCROLL_DURATION_MS) {
      Path().apply { moveTo(segment.x1, segment.y1); lineTo(segment.x2, segment.y2) }
    }
  }

  /** 节点点击。不沿父链找可点祖先；verifyNode 失败即停，不换控件。 */
  fun clickNode(
    target: RawTarget,
    nodeTarget: RawNodeTarget,
    verifyNode: (RawNode) -> Boolean,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> = nodeAction(target, nodeTarget) { node ->
    if (!node.isClickable) return@nodeAction ActionOutcome.no("node-not-clickable")
    val raw = captureNode(node, nodeTarget.path)
    if (!safeVerify(verifyNode, raw)) return@nodeAction ActionOutcome.no("verify-failed")
    if (!safeAuthorize(finalAuthorize)) return@nodeAction ActionOutcome.no("authorize-denied")
    try {
      if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
        ActionOutcome.yes("node-click-accepted")
      } else {
        ActionOutcome.no("node-click-rejected")
      }
    } catch (t: Throwable) {
      ActionOutcome.unknown("node-action-exception", describe(t))
    }
  }

  /** 节点 setText。只写目标节点，不做文本匹配，也不自动寻找其它输入框。 */
  fun setTextNode(
    target: RawTarget,
    nodeTarget: RawNodeTarget,
    text: String,
    clear: Boolean,
    verifyNode: (RawNode) -> Boolean,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> {
    if (text.length > MAX_TEXT_CHARS) return completedAction(ActionOutcome.no("text-too-large"))
    if (nodeTarget.windowId < 0) return completedAction(ActionOutcome.no("invalid-window-id"))
    return nodeAction(target, nodeTarget) { node ->
      if (!node.isEditable) return@nodeAction ActionOutcome.no("node-not-editable")
      val raw = captureNode(node, nodeTarget.path)
      if (!safeVerify(verifyNode, raw)) return@nodeAction ActionOutcome.no("verify-failed")
      if (!safeAuthorize(finalAuthorize)) return@nodeAction ActionOutcome.no("authorize-denied")
      val value = if (clear) text else (node.text?.toString() ?: "") + text
      if (value.length > MAX_TEXT_CHARS) return@nodeAction ActionOutcome.no("text-too-large")
      val bundle = Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
      }
      try {
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
          ActionOutcome.yes("node-set-text-accepted")
        } else {
          ActionOutcome.no("node-set-text-rejected")
        }
      } catch (t: Throwable) {
        ActionOutcome.unknown("node-action-exception", describe(t))
      }
    }
  }

  /** 节点滚动。只接受可滚动节点，不回退到整屏手势。 */
  fun scrollNode(
    target: RawTarget,
    nodeTarget: RawNodeTarget,
    direction: String,
    verifyNode: (RawNode) -> Boolean,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> {
    if (direction !in DIRECTIONS) return completedAction(ActionOutcome.no("invalid-direction"))
    return nodeAction(target, nodeTarget) { node ->
      if (!node.isScrollable) return@nodeAction ActionOutcome.no("node-not-scrollable")
      val raw = captureNode(node, nodeTarget.path)
      if (!safeVerify(verifyNode, raw)) return@nodeAction ActionOutcome.no("verify-failed")
      if (!safeAuthorize(finalAuthorize)) return@nodeAction ActionOutcome.no("authorize-denied")
      val legacy = when (direction) {
        "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        else -> null
      }
      try {
        if (legacy != null && node.performAction(legacy)) {
          return@nodeAction ActionOutcome.yes("node-scroll-accepted")
        }
        val directional = when (direction) {
          "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
          "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
          "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
          "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
          else -> null
        }
        if (directional != null && node.performAction(directional)) {
          ActionOutcome.yes("node-scroll-accepted")
        } else {
          ActionOutcome.no("node-scroll-rejected")
        }
      } catch (t: Throwable) {
        ActionOutcome.unknown("node-action-exception", describe(t))
      }
    }
  }

  /** 节点文本读数（不写、不点）。 */
  fun nodeText(
    target: RawTarget,
    nodeTarget: RawNodeTarget,
    verifyNode: (RawNode) -> Boolean,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<NodeTextOutcome> {
    target.rejection()?.let {
      return completedNodeText(NodeTextOutcome.Rejected("no", it, "target rejected"))
    }
    guardContent(target.displayId)?.let {
      return completedNodeText(NodeTextOutcome.Rejected("no", it))
    }
    val future = CompletableFuture<NodeTextOutcome>()
    val posted = main.post {
      val outcome = try {
        when (val resolved = resolveNode(target, nodeTarget)) {
          is NodeResult.Rejected -> NodeTextOutcome.Rejected("no", resolved.code, resolved.detail)
          is NodeResult.Ok -> {
            val node = resolved.node
            try {
              val raw = captureNode(node, nodeTarget.path)
              when {
                !safeVerify(verifyNode, raw) -> NodeTextOutcome.Rejected("no", "verify-failed")
                !safeAuthorize(finalAuthorize) -> NodeTextOutcome.Rejected("no", "authorize-denied")
                else -> NodeTextOutcome.Ok(
                  NodeText(
                    windowId = nodeTarget.windowId,
                    path = nodeTarget.path.toList(),
                    className = raw.className,
                    viewId = raw.viewId,
                    text = raw.text,
                    contentDescription = raw.contentDescription,
                    editable = raw.editable,
                  ),
                )
              }
            } catch (t: Throwable) {
              // 读取节点属性时异常：SDK 已被调用过，不能声称 executed=no。
              NodeTextOutcome.Rejected("unknown", "node-read-exception", describe(t))
            } finally {
              recycle(node)
            }
          }
        }
      } catch (t: Throwable) {
        NodeTextOutcome.Rejected("no", "platform-preflight-exception", describe(t))
      }
      future.complete(outcome)
    }
    if (!posted) future.complete(NodeTextOutcome.Rejected("no", "main-thread-unavailable"))
    return future
  }

  /** 全局动作。仅真实屏；动作可用性由 getSystemActions + GlobalActionCatalog 判定。 */
  fun globalAction(
    target: RawTarget,
    name: String,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<ActionOutcome> {
    target.rejection()?.let { return completedAction(ActionOutcome.no(it, "target rejected")) }
    guardGlobal(target.displayId)?.let { return completedAction(ActionOutcome.no(it)) }
    if (target.screenId != ScreenTargets.REAL) {
      return completedAction(ActionOutcome.no("target-unsupported"))
    }
    val entry = GlobalActionCatalog.find(name)
      ?: return completedAction(ActionOutcome.no("unknown-global-action"))
    val available = GlobalActionCatalog.available(systemGlobalActionIds(), Build.VERSION.SDK_INT)
    if (entry.name !in available) {
      return completedAction(ActionOutcome.no("global-unsupported"))
    }
    val future = CompletableFuture<ActionOutcome>()
    val posted = main.post {
      if (!safeAuthorize(finalAuthorize)) {
        future.complete(ActionOutcome.no("authorize-denied"))
        return@post
      }
      try {
        if (service.performGlobalAction(entry.id)) {
          future.complete(ActionOutcome.yes("global-accepted"))
        } else {
          future.complete(ActionOutcome.no("global-rejected"))
        }
      } catch (t: Throwable) {
        future.complete(ActionOutcome.unknown("global-exception", describe(t)))
      }
    }
    if (!posted) future.complete(ActionOutcome.no("main-thread-unavailable"))
    return future
  }

  /**
   * 采集一张 1:1 原始帧。区域阅读复用同一入口，由 Rust 在逻辑坐标上裁剪。
   * 不做缩放、压缩、裁剪、标尺或 OCR；FLAG_SECURE 由系统拒绝并如实带回。
   */
  fun captureRawFrame(
    target: RawTarget,
    finalAuthorize: () -> Boolean,
  ): CompletableFuture<CaptureOutcome> {
    target.rejection()?.let {
      return completedCapture(CaptureOutcome.Failed("no", it, "target rejected"))
    }
    guardCapture(target.displayId)?.let {
      return completedCapture(CaptureOutcome.Failed("no", it))
    }
    val future = CompletableFuture<CaptureOutcome>()
    val settled = AtomicBoolean(false)
    fun finish(outcome: CaptureOutcome) {
      if (settled.compareAndSet(false, true)) future.complete(outcome)
    }
    val posted = main.post {
      if (!safeAuthorize(finalAuthorize)) {
        finish(CaptureOutcome.Failed("no", "authorize-denied"))
        return@post
      }
      main.postDelayed(
        { finish(CaptureOutcome.Failed("unknown", "capture-timeout")) },
        CAPTURE_TIMEOUT_MS,
      )
      try {
        service.takeScreenshot(
          target.displayId,
          captureWorker,
          object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
              finish(NativeScreenshotDecoder.decode(screenshot, target))
            }

            override fun onFailure(errorCode: Int) {
              finish(CaptureOutcome.Failed("no", captureFailureCode(errorCode), "error=" + errorCode))
            }
          },
        )
      } catch (t: Throwable) {
        finish(CaptureOutcome.Failed("unknown", "capture-dispatch-exception", describe(t)))
      }
    }
    if (!posted) finish(CaptureOutcome.Failed("no", "main-thread-unavailable"))
    return future
  }

  // ── 树与窗口 ───────────────────────────────────────────────────────────

  private fun readTree(
    target: RawTarget,
    finalAuthorize: () -> Boolean,
    cancel: NativeCancellation,
  ): TreeOutcome {
    if (!safeAuthorize(finalAuthorize)) return TreeOutcome.Rejected("authorize-denied")
    val started = SystemClock.uptimeMillis()
    val deadline = started + TREE_BUDGET_MS
    val nodes = ArrayList<RawNode>(256)
    var stopReason: String? = null
    var totalChars = 0
    val root = when (val selected = selectRoot(target, expectedWindowId = null)) {
      is RootResult.Rejected -> return TreeOutcome.Rejected(selected.code, selected.detail)
      is RootResult.Ok -> selected
    }
    val windowId = root.windowId

    fun visit(node: AccessibilityNodeInfo, path: List<Int>, depth: Int) {
      try {
        if (stopReason != null) return
        if (safeCancelled(cancel)) {
          stopReason = "cancelled"
          return
        }
        if (nodes.size >= MAX_NODES) {
          stopReason = "node-limit"
          return
        }
        if (SystemClock.uptimeMillis() > deadline) {
          stopReason = "time-budget"
          return
        }
        if (depth > MAX_DEPTH) {
          stopReason = "depth-limit"
          return
        }
        val raw = captureNode(node, path)
        val chars = raw.charCount()
        if (chars > MAX_FIELD_CHARS || totalChars + chars > MAX_TREE_CHARS) {
          stopReason = "char-budget"
          return
        }
        totalChars += chars
        nodes.add(raw)
        if (depth == MAX_DEPTH) {
          if (node.childCount > 0) stopReason = "depth-limit"
          return
        }
        for (index in 0 until node.childCount) {
          if (stopReason != null) break
          val child = try {
            node.getChild(index)
          } catch (_: Throwable) {
            null
          }
          if (child != null) visit(child, path + index, depth + 1)
        }
      } finally {
        recycle(node)
      }
    }

    try {
      visit(root.root, emptyList(), 0)
    } catch (t: Throwable) {
      // 读取中途失败不丢弃已采集部分：如实标注原因，由 Rust 决定是否重读。
      if (stopReason == null) stopReason = "tree-read-failed"
    }
    return TreeOutcome.Ok(
      RawTree(
        target = target,
        windowId = windowId,
        nodes = nodes,
        complete = stopReason == null,
        stopReason = stopReason,
        elapsedMs = SystemClock.uptimeMillis() - started,
      ),
    )
  }

  /**
   * 选择目标显示的窗口。
   *
   * 读树（expectedWindowId = null）：只看确切 displayId 且 active/focused 的有效窗口，
   * active 优先，其次 focused。
   * 节点动作（expectedWindowId >= 0）：只接受该 id 的窗口，不因它不再 active/focused 而
   * 换树，也不退回当前活动窗口；找不到即拒绝。窗口选择状态由 Rust 保存，本类不持有。
   * API < 30：只允许真实屏 display 0，走 rootInActiveWindow；虚拟屏直接 target-unsupported，
   * 绝不用真实屏窗口冒充。
   */
  private fun selectRoot(target: RawTarget, expectedWindowId: Int?): RootResult {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      if (target.displayId != ScreenTargets.REAL_DISPLAY_ID) {
        return RootResult.Rejected("target-unsupported", "window enumeration requires API 30")
      }
      val root = try {
        service.rootInActiveWindow
      } catch (t: Throwable) {
        return RootResult.Rejected("root-read-failed", describe(t))
      }
      if (root == null) {
        return RootResult.Rejected("no-active-window", "rootInActiveWindow is null")
      }
      val windowId = root.windowId
      if (expectedWindowId != null && windowId != expectedWindowId) {
        recycle(root)
        return RootResult.Rejected(
          "window-mismatch",
          "expected=" + expectedWindowId + " active=" + windowId,
        )
      }
      return RootResult.Ok(root, windowId)
    }

    val byDisplay = try {
      service.windowsOnAllDisplays
    } catch (t: Throwable) {
      return RootResult.Rejected("windows-api-failed", describe(t))
    }
    val windows = byDisplay.get(target.displayId)
      ?: return RootResult.Rejected("no-window-on-display", "displayId=" + target.displayId)
    if (expectedWindowId != null) {
      for (window in windows) {
        val chosen = try {
          if (window.displayId == target.displayId && window.id == expectedWindowId) window.root else null
        } catch (_: Throwable) {
          null
        }
        if (chosen != null) return RootResult.Ok(chosen, expectedWindowId)
      }
      return RootResult.Rejected(
        "window-mismatch",
        "expected=" + expectedWindowId + ", displayId=" + target.displayId + ", windows=" + windows.size,
      )
    }
    val candidates = ArrayList<Candidate>(windows.size)
    for (window in windows) {
      try {
        if (window.displayId != target.displayId) continue
        val active = window.isActive
        val focused = window.isFocused
        if (!active && !focused) continue
        val root = window.root ?: continue
        candidates.add(Candidate(window.id, active, focused, root))
      } catch (_: Throwable) {
        // 单个窗口读失败不影响其它窗口；全部失败时由下方给出结构化原因。
      }
    }
    if (candidates.isEmpty()) {
      return RootResult.Rejected(
        "no-active-window",
        "displayId=" + target.displayId + ", windows=" + windows.size + ", activeOrFocused=0",
      )
    }
    // 与共享 WindowPick 相同的顺序：active > focused > 第一个可用窗口。
    // 该对象是 DeviceControlService 的 internal 嵌套成员，跨文件不可见，故此处按同一规则实现。
    val selected = candidates.firstOrNull { it.active }
      ?: candidates.firstOrNull { it.focused }
      ?: candidates.first()
    for (candidate in candidates) {
      if (candidate !== selected) recycle(candidate.root)
    }
    return RootResult.Ok(selected.root, selected.windowId)
  }

  /**
   * 按真实 child 下标重定位到显式窗口。路径无效返回 path-not-found，窗口不符返回
   * window-mismatch；不按文本/描述猜目标，也不退回当前活动窗口。
   */
  private fun resolveNode(target: RawTarget, nodeTarget: RawNodeTarget): NodeResult {
    val path = nodeTarget.path
    if (nodeTarget.windowId < 0) return NodeResult.Rejected("invalid-window-id")
    if (path.size > MAX_DEPTH) return NodeResult.Rejected("path-too-deep")
    if (path.any { it < 0 }) return NodeResult.Rejected("path-invalid")
    val root = when (val selected = selectRoot(target, nodeTarget.windowId)) {
      is RootResult.Rejected -> return NodeResult.Rejected(selected.code, selected.detail)
      is RootResult.Ok -> selected.root
    }
    var current = root
    for ((level, index) in path.withIndex()) {
      val next = try {
        if (index < current.childCount) current.getChild(index) else null
      } catch (_: Throwable) {
        null
      }
      recycle(current)
      if (next == null) return NodeResult.Rejected("path-not-found", "level=" + level + " index=" + index)
      current = next
    }
    return NodeResult.Ok(current)
  }

  @Suppress("DEPRECATION")
  private fun captureNode(node: AccessibilityNodeInfo, path: List<Int>): RawNode {
    val rect = Rect()
    node.getBoundsInScreen(rect)
    return RawNode(
      path = path.toList(),
      className = node.className?.toString() ?: "",
      packageName = node.packageName?.toString() ?: "",
      viewId = node.viewIdResourceName ?: "",
      text = node.text?.toString() ?: "",
      contentDescription = node.contentDescription?.toString() ?: "",
      bounds = RawBounds(rect.left, rect.top, rect.right, rect.bottom),
      clickable = node.isClickable,
      scrollable = node.isScrollable,
      editable = node.isEditable,
      checkable = node.isCheckable,
      checked = node.isChecked,
      enabled = node.isEnabled,
      focused = node.isFocused,
      visible = node.isVisibleToUser,
      selected = node.isSelected,
      windowId = node.windowId,
    )
  }

  // ── 节点动作 ───────────────────────────────────────────────────────────

  private fun nodeAction(
    target: RawTarget,
    nodeTarget: RawNodeTarget,
    block: (AccessibilityNodeInfo) -> ActionOutcome,
  ): CompletableFuture<ActionOutcome> {
    target.rejection()?.let { return completedAction(ActionOutcome.no(it, "target rejected")) }
    if (nodeTarget.windowId < 0) return completedAction(ActionOutcome.no("invalid-window-id"))
    guardContent(target.displayId)?.let { return completedAction(ActionOutcome.no(it)) }
    val future = CompletableFuture<ActionOutcome>()
    val posted = main.post {
      val outcome = try {
        when (val resolved = resolveNode(target, nodeTarget)) {
          is NodeResult.Rejected -> ActionOutcome.no(resolved.code, resolved.detail)
          is NodeResult.Ok -> {
            try {
              block(resolved.node)
            } catch (t: Throwable) {
              ActionOutcome.unknown("node-action-exception", describe(t))
            } finally {
              recycle(resolved.node)
            }
          }
        }
      } catch (t: Throwable) {
        ActionOutcome.no("platform-preflight-exception", describe(t))
      }
      future.complete(outcome)
    }
    if (!posted) future.complete(ActionOutcome.no("main-thread-unavailable"))
    return future
  }

  // ── 手势 ───────────────────────────────────────────────────────────────

  private fun dispatchStroke(
    target: RawTarget,
    finalAuthorize: () -> Boolean,
    durationMs: Long,
    buildPath: () -> Path,
  ): CompletableFuture<ActionOutcome> {
    target.rejection()?.let { return completedAction(ActionOutcome.no(it, "target rejected")) }
    guardGesture(target.displayId)?.let { return completedAction(ActionOutcome.no(it)) }
    val future = CompletableFuture<ActionOutcome>()
    val settled = AtomicBoolean(false)
    fun finish(outcome: ActionOutcome) {
      if (settled.compareAndSet(false, true)) future.complete(outcome)
    }
    val posted = main.post {
      val gesture = try {
        val builder = GestureDescription.Builder()
        builder.addStroke(
          GestureDescription.StrokeDescription(buildPath(), 0, durationMs.coerceIn(1L, MAX_GESTURE_MS)),
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) builder.setDisplayId(target.displayId)
        builder.build()
      } catch (t: Throwable) {
        finish(ActionOutcome.no("gesture-build-failed", describe(t)))
        return@post
      }
      val callback = object : AccessibilityService.GestureResultCallback() {
        override fun onCompleted(description: GestureDescription?) {
          finish(ActionOutcome.yes("gesture-completed"))
        }

        override fun onCancelled(description: GestureDescription?) {
          finish(ActionOutcome.unknown("gesture-cancelled"))
        }
      }
      // 授权检查紧贴派发：gesture 与 callback 全部构建完成后才读最后一次授权，
      // 避免构建期间撤权后仍把旧许可用于真实调用。
      if (!safeAuthorize(finalAuthorize)) {
        finish(ActionOutcome.no("authorize-denied"))
        return@post
      }
      val accepted = try {
        service.dispatchGesture(gesture, callback, main)
      } catch (t: Throwable) {
        finish(ActionOutcome.unknown("dispatch-exception", describe(t)))
        return@post
      }
      if (!accepted) {
        finish(ActionOutcome.no("gesture-not-dispatched"))
        return@post
      }
      main.postDelayed({ finish(ActionOutcome.unknown("gesture-timeout")) }, durationMs + GESTURE_GRACE_MS)
    }
    if (!posted) finish(ActionOutcome.no("main-thread-unavailable"))
    return future
  }

  // ── 原始帧解码 ─────────────────────────────────────────────────────────

  /**
   * 原始帧解码。单独一层是为了把 API 30 的 takeScreenshot 类型挡在低版本类校验之外：
   * 本类只在 SDK 30+ 的捕获分支里被加载，minSdk 26 的服务进程不会在加载平台层时解析它。
   */
  private object NativeScreenshotDecoder {
    fun decode(
      screenshot: AccessibilityService.ScreenshotResult,
      target: RawTarget,
    ): CaptureOutcome {
      var hardware: android.graphics.Bitmap? = null
      var software: android.graphics.Bitmap? = null
      var straight: android.graphics.Bitmap? = null
      val buffer = try {
        screenshot.hardwareBuffer
      } catch (t: Throwable) {
        return CaptureOutcome.Failed("unknown", "frame-buffer-unavailable", describe(t))
      }
      try {
        val rawWidth = buffer.width
        val rawHeight = buffer.height
        val transform = NativeRawGeometry.transformFor(
          rawWidth,
          rawHeight,
          target.logicalWidth,
          target.logicalHeight,
        ) ?: return CaptureOutcome.Failed(
          "unknown",
          "frame-geometry-mismatch",
          "raw=" + rawWidth + "x" + rawHeight + " logical=" + target.logicalWidth + "x" + target.logicalHeight,
        )
        val frameBytes = rawWidth.toLong() * rawHeight.toLong() * 4L
        if (rawWidth !in 1..MAX_DIMENSION || rawHeight !in 1..MAX_DIMENSION || frameBytes > MAX_FRAME_BYTES) {
          return CaptureOutcome.Failed("unknown", "frame-too-large", "bytes=" + frameBytes)
        }

        hardware = try {
          android.graphics.Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
        } catch (t: Throwable) {
          return CaptureOutcome.Failed("unknown", "frame-wrap-failed", describe(t))
        } ?: return CaptureOutcome.Failed("unknown", "frame-wrap-failed")

        software = try {
          hardware.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        } catch (t: Throwable) {
          return CaptureOutcome.Failed("unknown", "frame-copy-failed", describe(t))
        } ?: return CaptureOutcome.Failed("unknown", "frame-copy-failed")

        // 先复制到 sRGB 的 ARGB_8888 位图，让 GPU 做一次色彩转换；再按行读像素，
        // 只占一行 IntArray，避免为整屏再分配第三张位图与整屏像素数组。
        val srgb = android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB)
        straight = try {
          software.copy(android.graphics.Bitmap.Config.ARGB_8888, false)?.also { it.setColorSpace(srgb) }
        } catch (t: Throwable) {
          return CaptureOutcome.Failed("unknown", "frame-color-convert-failed", describe(t))
        } ?: return CaptureOutcome.Failed("unknown", "frame-color-convert-failed")

        val row = IntArray(rawWidth)
        val bytes = ByteArray(rawWidth * rawHeight * 4)
        var offset = 0
        for (rowIndex in 0 until rawHeight) {
          straight.getPixels(row, 0, rawWidth, 0, rowIndex, rawWidth, 1)
          for (color in row) {
            bytes[offset] = (color ushr 16).toByte()
            bytes[offset + 1] = (color ushr 8).toByte()
            bytes[offset + 2] = color.toByte()
            bytes[offset + 3] = (color ushr 24).toByte()
            offset += 4
          }
        }
        // 原样保留平台时基（takeScreenshot 的 timestamp），不换算成 wall clock。
        val timestamp = screenshot.timestamp
        return CaptureOutcome.Frame(
          RawFrame(
            target = target,
            width = rawWidth,
            height = rawHeight,
            rowStride = rawWidth * 4,
            bytes = bytes,
            transform = transform,
            colorSpace = "srgb",
            // 显式合成到不透明 sRGB：截屏没有可保留的透明语义，避免预乘/直通 alpha 歧义。
            premultipliedAlpha = false,
            capturedAtMs = timestamp,
          ),
        )
      } catch (t: Throwable) {
        return CaptureOutcome.Failed("unknown", "frame-decode-failed", t.javaClass.simpleName)
      } finally {
        straight?.recycle()
        software?.recycle()
        hardware?.recycle()
        try {
          buffer.close()
        } catch (_: Throwable) {
          // 已关闭或平台实现不支持 close 时忽略。
        }
      }
    }
  }

  private fun captureFailureCode(errorCode: Int): String = when (errorCode) {
    AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "secure-window"
    AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "capture-unavailable"
    AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "capture-throttled"
    AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY -> "invalid-display"
    AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR -> "capture-failed"
    else -> "capture-failed"
  }

  // ── 能力 guard（能力表与实际派发共用） ─────────────────────────────────

  private fun guardContent(displayId: Int): String? {
    if (serviceCapabilities() and AccessibilityServiceInfo.CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT == 0) {
      return "content-unavailable"
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R && displayId != ScreenTargets.REAL_DISPLAY_ID) {
      return "target-unsupported:api-below-30"
    }
    return null
  }

  private fun guardGesture(displayId: Int): String? {
    if (serviceCapabilities() and AccessibilityServiceInfo.CAPABILITY_CAN_PERFORM_GESTURES == 0) {
      return "gestures-unavailable"
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R && displayId != ScreenTargets.REAL_DISPLAY_ID) {
      return "target-unsupported:api-below-30"
    }
    return null
  }

  private fun guardCapture(displayId: Int): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "target-unsupported:api-below-30"
    if (serviceCapabilities() and AccessibilityServiceInfo.CAPABILITY_CAN_TAKE_SCREENSHOT == 0) {
      return "screenshot-unavailable"
    }
    return null
  }

  private fun guardGlobal(displayId: Int): String? =
    if (displayId != ScreenTargets.REAL_DISPLAY_ID) "target-unsupported:global-real-only" else null

  private fun serviceCapabilities(): Int = try {
    service.serviceInfo?.capabilities ?: 0
  } catch (_: Throwable) {
    0
  }

  private fun systemGlobalActionIds(): Set<Int> = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      service.systemActions?.map { it.id }?.toSet() ?: emptySet()
    } else {
      emptySet()
    }
  } catch (_: Throwable) {
    emptySet()
  }

  // ── 小工具 ─────────────────────────────────────────────────────────────

  private fun coordinateRejection(target: RawTarget, x: Int, y: Int): ActionOutcome? {
    target.rejection()?.let { return ActionOutcome.no(it, "target rejected") }
    guardGesture(target.displayId)?.let { return ActionOutcome.no(it) }
    if (x < 0 || y < 0 || x >= target.logicalWidth || y >= target.logicalHeight) {
      return ActionOutcome.no("invalid-coordinate")
    }
    return null
  }

  private fun safeAuthorize(finalAuthorize: () -> Boolean): Boolean = try {
    finalAuthorize()
  } catch (_: Throwable) {
    false
  }

  /** verifyNode 是上层只读校验；它抛错按校验失败处理，不触碰控件。 */
  private fun safeVerify(verifyNode: (RawNode) -> Boolean, raw: RawNode): Boolean = try {
    verifyNode(raw)
  } catch (_: Throwable) {
    false
  }

  private fun safeCancelled(cancel: NativeCancellation): Boolean = try {
    cancel.isCancelled()
  } catch (_: Throwable) {
    true
  }

  private fun completedAction(outcome: ActionOutcome): CompletableFuture<ActionOutcome> =
    CompletableFuture.completedFuture(outcome)

  private fun completedCapture(outcome: CaptureOutcome): CompletableFuture<CaptureOutcome> =
    CompletableFuture.completedFuture(outcome)

  private fun completedNodeText(outcome: NodeTextOutcome): CompletableFuture<NodeTextOutcome> =
    CompletableFuture.completedFuture(outcome)

  private fun recycle(node: AccessibilityNodeInfo?) {
    if (node == null) return
    try {
      @Suppress("DEPRECATION")
      node.recycle()
    } catch (_: Throwable) {
      // API 33+ recycle 已是 no-op；旧实现抛错也不影响结果。
    }
  }

  companion object {
    const val MAX_NODES = 4_000
    const val TREE_BUDGET_MS = 3_000L
    const val MAX_DEPTH = 40
    const val MAX_FIELD_CHARS = 65_536
    const val MAX_TREE_CHARS = 1_000_000
    /**
     * 单帧原始字节上限。解码期同时存在硬件位图、软件位图、sRGB 副本与输出字节，
     * 取 32 MiB 把峰值控制在约 130 MiB 内；正常屏幕（含 1440x3200）远低于此值。
     */
    const val MAX_FRAME_BYTES = 32L * 1024L * 1024L
    const val MAX_DIMENSION = 16_384
    const val MAX_SCREEN_ID_CHARS = 128
    const val MAX_TEXT_CHARS = 65_536
    const val TAP_DURATION_MS = 60L
    const val MIN_LONG_CLICK_MS = 300L
    const val MAX_LONG_CLICK_MS = 3_000L
    const val SCROLL_DURATION_MS = 220L
    const val MAX_GESTURE_MS = 60_000L
    const val GESTURE_GRACE_MS = 2_000L
    const val CAPTURE_TIMEOUT_MS = 10_000L

    private val DIRECTIONS = setOf("up", "down", "left", "right")

    /** 树遍历专用后台线程；不阻塞主线程等回调。 */
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "dsh-native-a11y").apply { isDaemon = true }
    }

    /** 截图回调与像素转换专用单线程；与树遍历分开，避免互相阻塞。 */
    private val captureWorker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "dsh-native-frame").apply { isDaemon = true }
    }
  }
}

/** 诊断文本；只用于 detail 字段，调用方按 code 分支。 */
private fun describe(t: Throwable): String {
  val message = t.message?.take(200) ?: ""
  return t.javaClass.simpleName + if (message.isEmpty()) "" else ": " + message
}

/** 无 Android 依赖的纯几何/旋转判定，便于 JVM 单测与后续 androidTest 复用。 */
internal object NativeRawGeometry {
  const val TRANSFORM_IDENTITY = "identity"

  data class Segment(val x1: Float, val y1: Float, val x2: Float, val y2: Float)

  /**
   * 原始帧到逻辑空间的旋转。Android 截屏不提供权威 raw rotation 元数据，因此只有
   * 原始尺寸与逻辑尺寸完全一致时才可证明 identity；宽高互换也不能区分 cw90/cw270，
   * 一律返回 null 由调用方拒绝（frame-geometry-mismatch）。四旋转数学属于 Rust codec，
   * 平台层不猜旋转。
   */
  fun transformFor(
    rawWidth: Int,
    rawHeight: Int,
    logicalWidth: Int,
    logicalHeight: Int,
  ): String? = if (rawWidth == logicalWidth && rawHeight == logicalHeight) TRANSFORM_IDENTITY else null

  /** 以 (x,y) 为中心的滑动线段；端点钳在逻辑目标内。 */
  fun swipeSegment(
    x: Float,
    y: Float,
    logicalWidth: Int,
    logicalHeight: Int,
    direction: String,
    distanceFraction: Double,
  ): Segment? {
    if (logicalWidth <= 1 || logicalHeight <= 1) return null
    if (direction !in setOf("up", "down", "left", "right")) return null
    val fraction = distanceFraction.coerceIn(0.1, 1.0).toFloat()
    val maxX = logicalWidth - 1f
    val maxY = logicalHeight - 1f
    val vertical = direction == "up" || direction == "down"
    val axis = if (vertical) maxY else maxX
    val half = (axis * fraction) / 2f
    if (half < 0.5f) return null
    val (x1, y1, x2, y2) = when (direction) {
      "down" -> listOf(x, y + half, x, y - half)
      "up" -> listOf(x, y - half, x, y + half)
      "right" -> listOf(x - half, y, x + half, y)
      else -> listOf(x + half, y, x - half, y)
    }
    val segment = Segment(
      x1.coerceIn(0f, maxX),
      y1.coerceIn(0f, maxY),
      x2.coerceIn(0f, maxX),
      y2.coerceIn(0f, maxY),
    )
    return if (segment.x1 == segment.x2 && segment.y1 == segment.y2) null else segment
  }
}
