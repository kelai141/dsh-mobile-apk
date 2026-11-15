package com.dsharnessmobile.shell

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.os.Build
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * 壳进程（uid 2000）唯一的一条 UiAutomation 连接。
 *
 * 树读取与焦点编辑器共用它：两条独立连接会互相抢 AccessibilityManagerService 的客户端位，
 * 一处失败就会让能力位被误判为不可用。这里只串行化，不改任何调用方的语义：
 * - 连接带 FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES，不压制用户已开启的无障碍服务；
 * - 连接失败即断开并丢弃，下一次调用重连；
 * - 持锁期间只做调用方给的那一件事，锁等待受 deadline 约束，不无限阻塞。
 */
internal object ShellUiAutomation {
  private val lock = ReentrantLock()
  @Volatile
  private var automation: UiAutomation? = null
  private var thread: HandlerThread? = null

  /** 是否可能使用该连接（身份与 API 前置条件）。不代表一定连得上。 */
  fun supported(): Boolean =
    Process.myUid() == 2000 && Build.VERSION.SDK_INT >= 30 && Looper.getMainLooper() != null

  /**
   * 在共享连接上执行一次操作。
   *
   * @return 操作结果；连不上、等待超时或已过期时返回 null（调用方按不可用处理）。
   */
  fun <T> withConnection(deadlineMs: Long, block: (UiAutomation) -> T): T? {
    if (!supported()) return null
    val wait = deadlineMs - SystemClock.elapsedRealtime()
    if (wait <= 0L) return null
    if (!lock.tryLock(wait, TimeUnit.MILLISECONDS)) return null
    try {
      if (SystemClock.elapsedRealtime() >= deadlineMs) return null
      val ui = automation ?: connect(deadlineMs) ?: return null
      return try {
        block(ui)
      } catch (t: Throwable) {
        // 连接状态不可信：断开，下一次调用重连。
        discard()
        if (t is Exception) null else throw t
      }
    } finally {
      lock.unlock()
    }
  }

  /**
   * 已连接即视为可观测（不抢锁：读取/写文本正在进行时也必须照实回答 yes，
   * 否则周期性能力探测会在操作途中把能力位收回）；未连接时才真实建立一次。
   */
  fun available(deadlineMs: Long): Boolean =
    automation != null || withConnection(deadlineMs) { it.serviceInfo != null } == true

  /** 断开并释放（只在本进程内；不影响系统里的无障碍服务）。持锁执行，避免与在飞调用交错。 */
  fun discard() {
    lock.lock()
    try {
      val ui = automation
      automation = null
      if (ui != null) runCatching { UiAutomation::class.java.getMethod("disconnect").invoke(ui) }
      thread?.quitSafely()
      thread = null
    } finally {
      lock.unlock()
    }
  }

  private fun connect(deadlineMs: Long): UiAutomation? {
    if (!supported() || SystemClock.elapsedRealtime() >= deadlineMs) return null
    val handler = HandlerThread("dsh-shell-uiautomation").apply { start() }
    var ui: UiAutomation? = null
    try {
      val connectionInterface = Class.forName("android.app.IUiAutomationConnection")
      val connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance()
      ui = UiAutomation::class.java.getConstructor(Looper::class.java, connectionInterface)
        .newInstance(handler.looper, connection)
      val remaining = (deadlineMs - SystemClock.elapsedRealtime()).coerceAtMost(2_000L)
      if (remaining <= 0L) return null
      UiAutomation::class.java
        .getMethod("connectWithTimeout", Int::class.javaPrimitiveType, Long::class.javaPrimitiveType)
        .invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES, remaining)
      val info = ui.serviceInfo ?: return null
      info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      ui.serviceInfo = info
      // 查询一次：连上但已被框架断开的客户端在这里暴露。
      ui.windowsOnAllDisplays
      automation = ui
      thread = handler
      return ui
    } finally {
      if (automation !== ui || ui == null) {
        if (ui != null) runCatching { UiAutomation::class.java.getMethod("disconnect").invoke(ui) }
        handler.quitSafely()
      }
    }
  }
}
