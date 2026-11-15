package com.dsharnessmobile.shell

import android.app.UiAutomation
import android.graphics.Rect
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.dsharnessmobile.shell.nativecontrol.NativeShizukuTreeBody
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Shell-UID raw tree reader for one explicitly requested display.
 *
 * 只做读取：不做点击、不做 ref 分配、不裁剪。displayId 由调用方的 Rust 计划给出并通过调用方
 * 自己的注册表校验（真实屏只有 0，虚拟屏必须是本应用刚建的那块）。本类只从该 displayId 的
 * 窗口列表里选窗口，选不到就拒绝——绝不用真实屏的窗口冒充虚拟屏，也不回落到别的屏。
 * 不压制已开启的无障碍服务（连接时带 FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES）。
 */
internal object NativeShizukuTree {
  private val busy = AtomicBoolean(false)

  fun interface Cancellation {
    fun isCancelled(): Boolean

    companion object {
      val NEVER: Cancellation = Cancellation { false }
    }
  }

  /** 只探测连接，不读树；失败一律当作不可观测。displayId 用于要求该屏确实有窗口。 */
  fun available(displayId: Int = 0): Boolean {
    if (!ShellUiAutomation.supported() || displayId < 0) return false
    // 正在读树（busy）也是「本服务确实能观测」的证据：此时不得回 no，否则周期性的
    // 能力探测会在读取途中把 bit 收回，下一次快照就被自己挡掉。
    if (busy.get()) return true
    val deadline = SystemClock.elapsedRealtime() + 2_000L
    if (displayId == 0) return ShellUiAutomation.available(deadline)
    return ShellUiAutomation.withConnection(deadline) { ui ->
      selectWindow(ui, displayId) != null
    } == true
  }

  /**
   * 读一次原始树。
   *
   * @param displayId 由调用方按注册表校验后的目标屏；本类只读该屏的窗口。
   * @param authorized 读取前执行一次；返回 false 即不读。
   * @param stillCurrent 读取后再次执行；代次/授权已变则丢弃结果（不重放）。
   * @return 树体 JSON；被拒绝时返回带 code 的结果对象。
   */
  fun read(
    displayId: Int,
    deadlineMs: Long,
    authorized: () -> Boolean,
    stillCurrent: () -> Boolean,
    cancel: Cancellation = Cancellation.NEVER,
  ): Pair<String?, String?> {
    fun refuse(code: String): Pair<String?, String?> = null to code
    if (displayId < 0) return refuse("shizuku-tree-display-unsupported")
    if (Process.myUid() != 2000 || Build.VERSION.SDK_INT < 30) return refuse("shizuku-tree-unavailable")
    val now = SystemClock.elapsedRealtime()
    if (deadlineMs <= now || deadlineMs - now > 6_000L) return refuse("shizuku-tree-deadline")
    if (!safe(authorized)) return refuse("authorize-denied")
    if (!busy.compareAndSet(false, true)) return refuse("shizuku-tree-busy")
    try {
      var refusal: String? = null
      val body = ShellUiAutomation.withConnection(deadlineMs) { ui ->
        if (!safe(authorized)) {
          refusal = "authorize-denied"
          null
        } else capture(ui, displayId, deadlineMs, cancel) ?: run { refusal = "no-active-window"; null }
      }
      if (body == null) return refuse(refusal
        ?: if (SystemClock.elapsedRealtime() >= deadlineMs) "shizuku-tree-deadline" else "shizuku-tree-unavailable")
      // 读取完成后核对代次/授权：结果只对发起它的那次授权有效。
      if (!safe(stillCurrent)) return refuse("shizuku-tree-stale")
      return NativeShizukuTreeBody.encode(body) to null
    } catch (_: Throwable) {
      ShellUiAutomation.discard()
      return refuse("shizuku-tree-error")
    } finally {
      busy.set(false)
    }
  }

  private fun safe(check: () -> Boolean): Boolean = try {
    check()
  } catch (_: Throwable) {
    false
  }

  private fun capture(
    ui: UiAutomation,
    displayId: Int,
    deadlineMs: Long,
    cancel: Cancellation,
  ): NativeShizukuTreeBody.Body? {
    val started = SystemClock.elapsedRealtime()
    val deadline = minOf(deadlineMs, started + NativeShizukuTreeBody.TREE_BUDGET_MS)
    val window = selectWindow(ui, displayId) ?: return null
    val windowId = window.id
    val root = window.root ?: return null
    val nodes = ArrayList<NativeShizukuTreeBody.Node>(192)
    var stopReason: String? = null

    fun visit(node: AccessibilityNodeInfo, path: List<Int>, depth: Int) {
      try {
        if (stopReason != null || nodes.size >= NativeShizukuTreeBody.MAX_NODES) {
          if (stopReason == null) stopReason = "node-limit"
          return
        }
        if (safe { cancel.isCancelled() }) { stopReason = "cancelled"; return }
        if (SystemClock.elapsedRealtime() > deadline) { stopReason = "time-budget"; return }
        // 外层窗口里挂进来的其它窗口节点不属于本次快照：整棵子树跳过，路径保持一致。
        if (node.windowId != windowId) return
        nodes.add(captureNode(node, path))
        if (depth >= NativeShizukuTreeBody.MAX_DEPTH) {
          if (node.childCount > 0) stopReason = "depth-limit"
          return
        }
        for (index in 0 until node.childCount) {
          if (stopReason != null) break
          val child = try { node.getChild(index) } catch (_: Throwable) { null } ?: continue
          visit(child, path + index, depth + 1)
        }
      } finally {
        recycle(node)
      }
    }

    try {
      visit(root, emptyList(), 0)
    } catch (_: Throwable) {
      if (stopReason == null) stopReason = "tree-read-failed"
    }
    // 没有真实根就没有可发布的树（Rust 要求 path [] 在场）。
    if (nodes.isEmpty()) return null
    return NativeShizukuTreeBody.Body(
      windowId = windowId,
      nodes = nodes,
      complete = stopReason == null,
      stopReason = stopReason,
      elapsedMs = SystemClock.elapsedRealtime() - started,
    )
  }

  /** 只在该 displayId 的窗口里选：active 优先，其次 focused。 */
  private fun selectWindow(ui: UiAutomation, displayId: Int): AccessibilityWindowInfo? = try {
    ui.windowsOnAllDisplays[displayId]?.let { windows ->
      if (displayId == 0) windows.firstOrNull { it.isActive } ?: windows.firstOrNull { it.isFocused }
      else windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }.let { apps ->
        apps.firstOrNull { it.isActive } ?: apps.firstOrNull { it.isFocused } ?: apps.singleOrNull()
      }
    }
  } catch (_: Throwable) {
    null
  }

  internal fun captureNode(node: AccessibilityNodeInfo, path: List<Int>): NativeShizukuTreeBody.Node {
    val rect = Rect()
    node.getBoundsInScreen(rect)
    val clipped = { value: CharSequence? ->
      value?.toString()?.take(NativeShizukuTreeBody.MAX_FIELD_CHARS) ?: ""
    }
    return NativeShizukuTreeBody.Node(
      path = path.toList(),
      className = clipped(node.className),
      packageName = clipped(node.packageName),
      viewId = clipped(node.viewIdResourceName),
      // 密码节点不输出文本；hint 不是正文。
      text = if (node.isPassword) "" else if (node.isShowingHintText) "" else clipped(node.text),
      contentDescription = clipped(node.contentDescription),
      left = rect.left,
      top = rect.top,
      right = rect.right,
      bottom = rect.bottom,
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

  private fun recycle(node: AccessibilityNodeInfo?) {
    if (node == null) return
    try {
      @Suppress("DEPRECATION")
      node.recycle()
    } catch (_: Throwable) {
      // API 33+ 已是 no-op。
    }
  }
}
