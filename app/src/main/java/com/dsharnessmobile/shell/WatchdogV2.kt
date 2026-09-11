package com.dsharnessmobile.shell

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.util.Log
import java.io.File

/**
 * 看门狗升级（0.13.0 PRD F2/M3.4）：
 * - 深度探活：HTTP 状态码 + 页面心跳 + 插件状态（EngineProbe 扩展：/api/android/privilege/status
 *   可达表示插件树健康）+ 引擎日志尾部异常扫描（engine.log 末尾 fatal/Error 关键字）。
 * - 熔断与指数退避：连续失败 → 指数退避（5s→10s→20s→40s→80s 封顶），超过熔断阈值（12 次连续失败）
 *   暂停看门狗并记录（界面提示由 GuideChrome 状态区显示），用户交互或探活成功自动复位。
 * - 开机自启：BOOT_COMPLETED 接收器恢复用户上次同意的运行状态（EngineService.userShutdown 持久化）。
 * - 前台唤醒锁：引擎前台运行期间持有（PARTIAL_WAKE_LOCK，标准档位；获取失败降级尽力模式并记录）。
 * - 授权状态探活：ADB 配对断线时记录（F2.9，桥引导重新配对由桥层返回）。
 */
object WatchdogV2 {

  private const val TAG = "dsh-watchdog"
  const val MAX_CONSEC_FAILURES = 12

  /**
   * A slow HTTP response is distinct from a process that no longer accepts TCP.
   * 0.13.8 #175：DEGRADED 拆分病因——DEGRADED_HTTP = HTTP 失败但端口可连（半死，
   * 连续 N 拍升级为受控重启）；DEGRADED_LOG = HTTP 成功但日志异常签名（绝不触发重启，
   * 保留既有「重启会打断活动 turn」语义）。
   */
  enum class ProbeState { HEALTHY, DEGRADED_HTTP, DEGRADED_LOG, DEAD }

  /** DEGRADED_HTTP 阶梯阈值：6 拍 × 5s = 30s（与 restartDeadConfirmations 同量级，远小于 90s 冷启动上限）。 */
  const val DEGRADED_RESTART_CONFIRMATIONS = 6

  @Volatile
  var consecutiveFailures = 0
    private set

  @Volatile
  var consecutiveDegradedHttp = 0
    private set

  /** Exponential delay for destructive recovery attempts after confirmed death. */
  fun nextDelayMs(): Long {
    val n = (consecutiveFailures - 1).coerceAtLeast(0).coerceAtMost(4)
    return (5_000L shl n).coerceAtMost(80_000L)
  }

  /** Only a confirmed dead process contributes to the restart/undo circuit breaker. */
  fun recordProbe(state: ProbeState) {
    consecutiveFailures = if (state == ProbeState.DEAD) consecutiveFailures + 1 else 0
    consecutiveDegradedHttp = nextDegradedCount(state, consecutiveDegradedHttp)
  }

  /** 纯函数（JVM 单测）：DEGRADED_HTTP 自增，其余状态清零。 */
  fun nextDegradedCount(state: ProbeState, count: Int): Int =
    if (state == ProbeState.DEGRADED_HTTP) count + 1 else 0

  /** 熔断与退避共用同一计数（#175：半死阶梯与 DEAD 共用退避，防重启风暴）。 */
  fun effectiveFailureCount(): Int = maxOf(consecutiveFailures, consecutiveDegradedHttp)

  fun tripped(): Boolean = effectiveFailureCount() >= MAX_CONSEC_FAILURES

  fun degradedHttpTripped(): Boolean = consecutiveDegradedHttp >= DEGRADED_RESTART_CONFIRMATIONS

  fun reset() {
    consecutiveFailures = 0
    consecutiveDegradedHttp = 0
  }

  /**
   * Classifies liveness without treating a temporary HTTP stall or a historical
   * log line as proof of process death. A live port is degraded because the UI
   * may be slow, but restarting it would interrupt the active turn.
   */
  fun assessProbe(context: Context): ProbeState {
    val base = EngineProbe.check(2_500).optBoolean("running", false)
    if (!base) return if (EngineProbe.portReachable(1_000)) ProbeState.DEGRADED_HTTP else ProbeState.DEAD
    if (engineLogShowsFailure(context)) {
      LogCollector.log(TAG, "engine log reports a recoverable warning while HTTP remains alive")
      return ProbeState.DEGRADED_LOG
    }
    consumeTaskDoneMarkers(context)
    return ProbeState.HEALTHY
  }

  /** Compatibility projection for callers that only need a strict HTTP health bit. */
  fun deepProbe(context: Context): Boolean = assessProbe(context) == ProbeState.HEALTHY

  /** 引擎事件桥标记文件（dsh-android-bridge 写入 home/.dsh/.task-done.ndjson；经 context 推导）。 */
  private fun taskMarkerFile(context: Context): java.io.File =
    java.io.File(File(context.filesDir, "home/.dsh"), ".task-done.ndjson")

  /** 消费任务完成标记：逐行解析 → NotifyCenter 通知 → 清空标记（幂等；通知权限未授静默降级）。 */
  private fun consumeTaskDoneMarkers(context: Context) {
    val debugLog = java.io.File(context.filesDir, "notify-debug.log")
    fun dbg(msg: String) { try { debugLog.appendText(System.currentTimeMillis().toString() + " " + msg + "\n") } catch (_: Exception) {} }
    try {
      val f = taskMarkerFile(context)
      if (!f.exists() || f.length() == 0L) return
      dbg("marker found, len=" + f.length())
      val lines = f.readLines()
      var notified = 0
      for (line in lines) {
        if (line.isBlank()) continue
        dbg("line: " + line)
        try {
          val j = org.json.JSONObject(line)
          val title = j.optString("title").ifBlank { "任务完成" }
          val snippet = j.optString("text").ifBlank { "引擎已完成一轮任务处理" }
          dbg("parsed title=" + title)
          NotifyCenter.notify(context, "task", title, snippet)
          notified++
          dbg("notify returned ok")
        } catch (e: Exception) {
          dbg("notify threw: " + (e.message ?: e.javaClass.simpleName))
        }
      }
      dbg("done notified=" + notified)
      f.writeText("")
    } catch (e: Exception) {
      dbg("consume outer threw: " + (e.message ?: e.javaClass.simpleName))
    }
  }

  /** 引擎日志尾部异常扫描（最近 4KB 内 fatal/Error 关键字；命中率控制：只取尾部）。 */
  private fun engineLogShowsFailure(context: Context): Boolean {
    return try {
      val f = java.io.File(context.filesDir, "engine.log")
      if (!f.exists()) return false
      java.io.RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        val off = (len - 4096).coerceAtLeast(0)
        raf.seek(off)
        val buf = ByteArray((len - off).toInt().coerceAtMost(4096))
        val n = raf.read(buf)
        val tail = String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8)
        tail.contains("UncaughtException") || tail.contains("plugin tree failed to load")
      }
    } catch (_: Exception) {
      false
    }
  }

  /** 前台唤醒锁（标准档位；获取失败降级尽力模式并记录审计日志）。 */
  private var wakeLock: PowerManager.WakeLock? = null

  fun acquireWakeLock(context: Context) {
    if (wakeLock?.isHeld == true) return
    try {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:engine").also {
        it.setReferenceCounted(false)
        it.acquire(30 * 60 * 1000L)
      }
      LogCollector.log(TAG, "wake lock acquired (30min standard)")
    } catch (t: Throwable) {
      Log.e(TAG, "wake lock acquire failed (degraded best-effort)", t)
      LogCollector.log(TAG, "wake lock FAILED: ${t.message}")
    }
  }

  /**
   * 唤醒锁续期（2026-08-23 修复：acquire(30min) 是一次性定时释放——引擎常驻超过 30 分钟
   * 后段无锁；releaseWakeLock 从未被调用，服务销毁时也漏释放）。watchdog tick 调用：
   * 持有即重设 30 分钟窗口（setReferenceCounted=false 下 acquire 幂等续窗）。
   */
  fun refreshWakeLock(context: Context) {
    try {
      val held = wakeLock?.isHeld == true
      if (held) {
        wakeLock?.acquire(30 * 60 * 1000L)
      } else {
        acquireWakeLock(context)
      }
    } catch (_: Throwable) {
    }
  }

  fun releaseWakeLock() {
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
    } catch (_: Throwable) {
    }
  }
}
