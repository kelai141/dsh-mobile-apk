package com.dsharnessmobile.shell

import android.app.UiAutomation
import android.os.Bundle
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Shell-UID editor adapter. No IME registration, clipboard, text shell command or root fallback.
 * The app-side Rust permit owns scope and routing; this adapter only writes the focused editor of
 * the display it was told to use.
 *
 * 选点规则（多屏下焦点是全局的，必须按屏核对）：
 * 1. 只认目标 display 上应用窗口里的 FOCUS_INPUT；全局焦点落在别的屏时丢弃该节点，绝不写入。
 * 2. 真实屏严格：没有本屏焦点就不写。
 * 3. 虚拟屏兼容：部分 ROM 不在虚拟屏上报焦点，此时只接受该窗口内**唯一**可写编辑器；
 *    出现两个及以上即拒绝（focused-editor-ambiguous），绝不猜第一个。
 * 4. 遍历受深度与总节点数双约束；查到的节点由 [Lookup.Found.release] 统一归还。
 */
internal object NativeShizukuEditor {
  private val busy = AtomicBoolean(false)

  /** Probe the shell connection without touching editor text. A failed probe advertises nothing. */
  fun available(): Boolean = available(0)

  /**
   * Probe whether [displayId] currently has a writable editor. Reads and writes no text.
   * 该探针每 10s 跑一次，因此它触碰的每个节点都必须在返回前归还。
   */
  fun available(displayId: Int): Boolean {
    if (!ShellUiAutomation.supported() || displayId < 0) return false
    if (!busy.compareAndSet(false, true)) return false
    return try {
      val deadline = SystemClock.elapsedRealtime() + 2_000L
      if (displayId == 0) ShellUiAutomation.available(deadline)
      else ShellUiAutomation.withConnection(deadline) { ui ->
        lookup(ui, displayId, keepNode = false) is Lookup.Found
      } ?: false
    } catch (_: Exception) {
      ShellUiAutomation.discard()
      false
    } finally {
      busy.set(false)
    }
  }

  /** Real display 0 entry point, kept for the existing transaction. */
  fun setText(text: String, clear: Boolean, deadlineMs: Long): Bundle =
    setText(0, text, clear, deadlineMs)

  fun setText(displayId: Int, text: String, clear: Boolean, deadlineMs: Long): Bundle {
    fun result(code: String, executed: String) = Bundle().apply {
      putBoolean("ok", executed == "yes")
      putString("code", code)
      putString("executed", executed)
    }
    if (Process.myUid() != 2000 || Build.VERSION.SDK_INT < 30 || displayId < 0)
      return result("shizuku-editor-unavailable", "no")
    if (text.toByteArray(Charsets.UTF_8).size > 8192) return result("invalid-text", "no")
    val now = SystemClock.elapsedRealtime()
    if (deadlineMs <= now || deadlineMs - now > 5_000L) return result("shizuku-editor-deadline", "no")
    if (!busy.compareAndSet(false, true)) return result("shizuku-editor-busy", "no")
    var dispatched = false
    return try {
      ShellUiAutomation.withConnection(deadlineMs) { ui ->
        // clearCache 会让先前节点失效，所以跨次比较只用稳定的 ref 字符串。
        val first = lookup(ui, displayId, keepNode = true)
        if (first !is Lookup.Found) return@withConnection result(refusalOf(first), "no")
        try {
          val firstNode = first.node ?: return@withConnection result("focused-editor-unavailable", "no")
          val desired = if (clear) text else first.text + text
          if (desired.toByteArray(Charsets.UTF_8).size > 8192)
            return@withConnection result("invalid-text", "no")
          // 紧贴唯一一次可变操作前，再核对仍是同一个控件、正文未变。
          if (SystemClock.elapsedRealtime() >= deadlineMs)
            return@withConnection result("shizuku-editor-deadline", "no")
          val latest = lookup(ui, displayId, keepNode = true)
          if (latest !is Lookup.Found) return@withConnection result(refusalOf(latest), "no")
          try {
            val latestNode = latest.node ?: return@withConnection result("focused-editor-unavailable", "no")
            if (latest.ref != first.ref || latest.text != first.text)
              return@withConnection result("focused-editor-changed", "no")
            val args = Bundle().apply {
              putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, desired)
            }
            if (SystemClock.elapsedRealtime() >= deadlineMs)
              return@withConnection result("shizuku-editor-deadline", "no")
            dispatched = true
            val accepted = latestNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            // Android 返回 false 不足以证明自定义编辑器没有副作用。
            if (!accepted) return@withConnection result("shizuku-text-unconfirmed", "unknown")
            while (SystemClock.elapsedRealtime() < deadlineMs) {
              // Refresh the exact node that accepted the action. Text can resize an editor or move
              // focus, so looking up the focused node again by its old bounds cannot prove the write.
              ui.clearCache()
              if (!latestNode.refresh())
                return@withConnection result("shizuku-text-unconfirmed", "unknown")
              if (editorText(latestNode) == desired)
                return@withConnection result("shizuku-text-confirmed", "yes")
              Thread.sleep(40)
            }
            result("shizuku-text-unconfirmed", "unknown")
          } finally {
            latest.release()
          }
        } finally {
          first.release()
        }
      } ?: run {
        // Binder 侧已有可能的写入后，任何「没拿到结果」都只能是 unknown。
        result("shizuku-editor-unavailable", if (dispatched) "unknown" else "no")
      }
    } catch (_: Exception) {
      ShellUiAutomation.discard()
      result("shizuku-editor-error", if (dispatched) "unknown" else "no")
    } finally {
      busy.set(false)
    }
  }

  /**
   * 一次查找的结果。
   *
   * [Found] 持有节点与其祖先的归还责任：[node] 只在 keepNode=true 时非空，
   * 用完必须调用一次 [release]（把候选与沿途祖先一起归还；祖先被提前回收会让候选失效）。
   */
  private sealed class Lookup {
    class Found(
      val ref: String,
      val text: String,
      val node: AccessibilityNodeInfo?,
      val release: () -> Unit,
    ) : Lookup()
    class Missing(val refusal: String) : Lookup()
  }

  private fun refusalOf(result: Lookup): String =
    (result as? Lookup.Missing)?.refusal ?: "focused-editor-unavailable"

  /**
   * 单窗口遍历状态：唯一候选、歧义标记、节点预算，以及「为了拿到候选而不能提前回收」的节点
   * （候选本身与它在树上的祖先）。所有归还在 [releaseAll] 里一次做完，且按引用去重。
   */
  private class Scan(val windowId: Int) {
    var visited = 0
    var editables = 0
    var selected: AccessibilityNodeInfo? = null
    var ambiguous = false
    var exhausted = false
    val held = ArrayList<AccessibilityNodeInfo>(8)

    fun stopped(): Boolean = ambiguous || exhausted

    fun releaseAll(extra: AccessibilityNodeInfo?) {
      val done = ArrayList<AccessibilityNodeInfo>(held.size + 1)
      for (node in held) {
        if (done.any { it === node }) continue
        done.add(node)
        recycle(node)
      }
      if (extra != null && done.none { it === extra }) recycle(extra)
      held.clear()
      selected = null
    }
  }

  /**
   * 找到 [displayId] 上的可写编辑器。
   *
   * 先看目标屏应用窗口里的 FOCUS_INPUT；真实屏只认它。虚拟屏没有焦点时，
   * 允许退到窗口内**唯一**可写编辑器，多于一个即判歧义并拒绝。
   */
  private fun lookup(ui: UiAutomation, displayId: Int, keepNode: Boolean): Lookup {
    val windows = windowsOf(ui, displayId)
    if (windows.isEmpty()) return Lookup.Missing("focused-editor-unavailable")
    ui.clearCache()
    val appWindows = windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
    if (appWindows.isEmpty()) return Lookup.Missing("focused-editor-unavailable")

    // 1) 全局输入焦点落在本屏应用窗口里：直接用。焦点属于别的屏时丢弃，不跨屏写入。
    val focus = runCatching { ui.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()
    if (focus != null) {
      val window = appWindows.firstOrNull { it.id == focus.windowId }
      val onThisDisplay = usableEditor(focus) && focus.isFocused && window != null &&
        (displayId != 0 || window.isFocused)
      if (onThisDisplay) {
        val found = Lookup.Found(identityOf(focus), editorText(focus),
          if (keepNode) focus else null, { recycle(focus) })
        if (!keepNode) found.release()
        return found
      }
      recycle(focus)
    }
    if (displayId == 0) return Lookup.Missing("focused-editor-unavailable")

    // 2) 虚拟屏兼容：只在该屏的活动窗口内有界遍历，只接受唯一可写编辑器。
    val fallback: AccessibilityWindowInfo? = appWindows.singleOrNull()
    val targetWindow: AccessibilityWindowInfo = appWindows.firstOrNull { it.isFocused }
      ?: appWindows.firstOrNull { it.isActive }
      ?: fallback
      ?: return Lookup.Missing("focused-editor-other-display")
    val root = targetWindow.root ?: return Lookup.Missing("focused-editor-unavailable")
    val scan = Scan(targetWindow.id)
    var handedOff = false
    try {
      scanEditors(root, scan, 0)
      val unique = scan.editables == 1 && !scan.ambiguous && !scan.exhausted
      val node = scan.selected
      if (!unique || node == null) return Lookup.Missing(
        if (scan.ambiguous || scan.exhausted) "focused-editor-ambiguous" else "focused-editor-unavailable",
      )
      val found = Lookup.Found(identityOf(node), editorText(node), if (keepNode) node else null,
        { scan.releaseAll(root) })
      handedOff = true
      if (!keepNode) found.release()
      return found
    } finally {
      if (!handedOff) scan.releaseAll(root)
    }
  }

  /**
   * 窗口内有界遍历：总节点数与深度双上限。
   *
   * @return 本子树里是否持有候选节点（true 时调用方不得回收这个子树根）。
   * 找到第二个可写编辑器即判歧义并停止；不含候选的子树根在递归返回后立即回收。
   */
  private fun scanEditors(node: AccessibilityNodeInfo, scan: Scan, depth: Int): Boolean {
    if (scan.stopped()) return false
    scan.visited += 1
    if (scan.visited > MAX_EDITOR_NODES) {
      scan.exhausted = true
      return false
    }
    if (depth > MAX_EDITOR_DEPTH) return false
    if (node.windowId != scan.windowId) return false
    var holds = false
    if (usableEditor(node)) {
      scan.editables += 1
      if (scan.editables > 1) {
        // 第二个可写编辑器：无法判断模型指哪一个，直接判歧义。
        scan.ambiguous = true
        return false
      }
      scan.selected = node
      scan.held.add(node)
      holds = true
    }
    for (index in 0 until node.childCount) {
      if (scan.stopped()) break
      val child = try { node.getChild(index) } catch (_: Throwable) { null } ?: continue
      if (scanEditors(child, scan, depth + 1)) {
        // 候选在这个子树里：子树根必须留到候选用完再归还。
        scan.held.add(child)
        holds = true
      } else {
        recycle(child)
      }
    }
    return holds
  }

  private fun identityOf(node: AccessibilityNodeInfo): String {
    val rect = android.graphics.Rect()
    runCatching { node.getBoundsInScreen(rect) }
    return node.windowId.toString() + "|" + node.viewIdResourceName + "|" + node.className +
      "|" + rect.left + "," + rect.top + "," + rect.right + "," + rect.bottom
  }

  private fun editorText(node: AccessibilityNodeInfo): String =
    if (node.isShowingHintText) "" else node.text?.toString().orEmpty()

  private fun windowsOf(ui: UiAutomation, displayId: Int): List<AccessibilityWindowInfo> = try {
    ui.windowsOnAllDisplays[displayId]?.toList().orEmpty()
  } catch (_: Throwable) {
    emptyList()
  }

  private fun usableEditor(node: AccessibilityNodeInfo): Boolean =
    node.isEditable && !node.isPassword && node.isVisibleToUser && !node.packageName.isNullOrEmpty()

  private fun recycle(node: AccessibilityNodeInfo?) {
    if (node == null) return
    try {
      @Suppress("DEPRECATION")
      node.recycle()
    } catch (_: Throwable) {
      // API 33+ 已是 no-op；重复回收在旧实现上抛错，也不影响结果。
    }
  }

  private const val MAX_EDITOR_DEPTH = 40
  /** 单次查找的节点预算：探针每 10s 跑一次，遍历量必须有上界。 */
  private const val MAX_EDITOR_NODES = 2_000
}
