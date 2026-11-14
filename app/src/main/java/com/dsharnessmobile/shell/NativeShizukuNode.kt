package com.dsharnessmobile.shell

import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import com.dsharnessmobile.shell.nativecontrol.NativeShizukuTreeBody
import org.json.JSONObject

/**
 * Raw node verification and one typed action, on the same window/path as the Rust snapshot.
 *
 * 目标屏是显式参数：窗口必须同时满足「属于该 displayId」与「id 等于快照里的 windowId」。
 * 只按 windowId 匹配会让另一块屏上恰好同 id 的窗口顶替目标。
 */
internal object NativeShizukuNode {
  private val probeBusy = java.util.concurrent.atomic.AtomicBoolean(false)

  /**
   * Probe whether this display has an application window whose root can be read.
   * Only the requested display is enumerated; another display's window never vouches for it.
   */
  fun available(displayId: Int): Boolean {
    if (displayId < 0 || !ShellUiAutomation.supported()) return false
    val deadline = SystemClock.elapsedRealtime() + 2_000L
    // 与文本/树的探测互斥：UiAutomation 是单条共享连接，挂起一棵大树的 enumerate 不该让
    // 周期性能力探测误报不可用。
    if (!probeBusy.compareAndSet(false, true)) return false
    return try { probe(displayId, deadline) } finally { probeBusy.set(false) }
  }

  private fun probe(displayId: Int, deadline: Long): Boolean =
    ShellUiAutomation.withConnection(deadline) { ui ->
      val windows = try { ui.windowsOnAllDisplays[displayId]?.toList().orEmpty() }
      catch (_: Throwable) { emptyList() }
      windows.any { window ->
        if (window.type != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION)
          return@any false
        val root = try { window.root } catch (_: Throwable) { null } ?: return@any false
        try {
          root.childCount >= 0
        } finally {
          try { @Suppress("DEPRECATION") root.recycle() } catch (_: Throwable) { }
        }
      }
    } == true

  /** Real display 0 entry point, kept for the existing transaction. */
  fun execute(windowId: Int, path: IntArray, operation: String, argsJson: String,
    expected: String, deadlineMs: Long): Bundle =
    execute(0, windowId, path, operation, argsJson, expected, deadlineMs)

  fun execute(displayId: Int, windowId: Int, path: IntArray, operation: String, argsJson: String,
    expected: String, deadlineMs: Long): Bundle {
    fun result(code: String, executed: String, body: String? = null) = Bundle().apply {
      putBoolean("ok", executed == "yes")
      putString("code", code); putString("executed", executed)
      if (body != null) putString("body", body)
    }
    if (displayId < 0 || path.size > 40 || path.any { it < 0 || it > 4000 } || windowId < 0 ||
      argsJson.toByteArray().size > 16 * 1024 || expected.toByteArray().size > 64 * 1024 ||
      operation !in setOf("read", "click", "longClick", "setText", "scroll", "nodeText"))
      return result("invalid-node-request", "no")
    val now = SystemClock.elapsedRealtime()
    if (deadlineMs - now !in 1L..5000L) return result("node-deadline", "no")
    var dispatched = false
    return try {
      ShellUiAutomation.withConnection(deadlineMs) { ui ->
        ui.clearCache()
        // 窗口列表本身已按 displayId 取：同一 id 的窗口若属于别的屏，根本不会出现在这里。
        val windows = try { ui.windowsOnAllDisplays[displayId]?.toList().orEmpty() }
        catch (_: Throwable) { emptyList() }
        if (windows.isEmpty()) return@withConnection result("node-display-unavailable", "no")
        val window = windows.firstOrNull { it.id == windowId }
          ?: return@withConnection result("node-window-missing", "no")
        var node = window.root ?: return@withConnection result("node-missing", "no")
        try {
          for (index in path) {
            val child = node.getChild(index) ?: return@withConnection result("node-missing", "no")
            @Suppress("DEPRECATION") node.recycle()
            node = child
          }
          if (node.windowId != windowId || !node.isVisibleToUser || !node.isEnabled || node.isPassword)
            return@withConnection result("node-unavailable", "no")
          val raw = NativeShizukuTreeBody.node(NativeShizukuTree.captureNode(node, path.toList())).toString()
          if (operation == "read") return@withConnection result("node-measured", "yes", raw)
          if (expected.isEmpty() || raw != expected) return@withConnection result("node-changed", "no")
          if (SystemClock.elapsedRealtime() >= deadlineMs) return@withConnection result("node-deadline", "no")
          val args = JSONObject(argsJson)
          if (operation == "nodeText") return@withConnection result("node-text-read", "yes", raw)
          var desired: String? = null
          val actionArgs = Bundle()
          val action = when (operation) {
            "click" -> AccessibilityNodeInfo.ACTION_CLICK
            "longClick" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
            "scroll" -> when (args.getString("direction")) {
              "down", "right" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
              "up", "left" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
              else -> return@withConnection result("invalid-direction", "no")
            }
            else -> {
              if (!node.isEditable) return@withConnection result("node-not-editable", "no")
              val existing = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
              desired = if (args.getBoolean("clear")) args.getString("text") else existing + args.getString("text")
              if (desired.toByteArray().size > 8192) return@withConnection result("invalid-text", "no")
              actionArgs.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, desired)
              AccessibilityNodeInfo.ACTION_SET_TEXT
            }
          }
          if (SystemClock.elapsedRealtime() >= deadlineMs) return@withConnection result("node-deadline", "no")
          dispatched = true
          if (!node.performAction(action, actionArgs)) return@withConnection result("node-action-unconfirmed", "unknown")
          if (desired != null) {
            while (SystemClock.elapsedRealtime() < deadlineMs) {
              ui.clearCache()
              if (!node.refresh()) return@withConnection result("node-text-unconfirmed", "unknown")
              val actual = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
              if (actual == desired) return@withConnection result("shizuku-text-confirmed", "yes")
              Thread.sleep(40)
            }
            result("node-text-unconfirmed", "unknown")
          } else result("node-action-accepted", "yes")
        } finally { @Suppress("DEPRECATION") node.recycle() }
      } ?: result("node-connection-unavailable", if (dispatched) "unknown" else "no")
    } catch (_: Exception) { result("node-result-unconfirmed", if (dispatched) "unknown" else "no") }
  }
}
