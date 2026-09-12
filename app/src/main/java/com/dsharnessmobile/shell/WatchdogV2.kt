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

  /** FX-212.3：标记文件消费偏移的 prefs 键（跨进程重启不重放历史标记）。 */
  private const val KEY_MARKER_OFFSET = "notify.markerOffset"

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

  /**
   * 退避阶梯（纯函数，JVM 单测）：5s → 10s → 20s → 40s → 80s 封顶。
   * #210.2：入参必须是 [effectiveFailureCount]（半死与 DEAD 共用计数）。只读
   * `consecutiveFailures` 时 DEGRADED_HTTP 恒 5s——与 [tripped] 的熔断口径自相矛盾。
   */
  fun delayForFailureCount(count: Int): Long {
    val n = (count - 1).coerceAtLeast(0).coerceAtMost(4)
    return (5_000L shl n).coerceAtMost(80_000L)
  }

  /** Exponential delay for destructive recovery attempts (death or half-dead ladder). */
  fun nextDelayMs(): Long = delayForFailureCount(effectiveFailureCount())

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
   *
   * 只做分类，不承担副作用（#210.4）：标记消费由 [planTick] 的前置段在**任何状态**下
   * 统一执行——挂在 HEALTHY 分支尾部正是「DEGRADED_LOG 早退吞掉消费」的成因。
   */
  fun assessProbe(context: Context): ProbeState {
    val base = EngineProbe.check(2_500).optBoolean("running", false)
    if (!base) return if (EngineProbe.portReachable(1_000)) ProbeState.DEGRADED_HTTP else ProbeState.DEAD
    if (engineLogShowsFailure(context)) {
      LogCollector.log(TAG, "engine log reports a recoverable warning while HTTP remains alive")
      return ProbeState.DEGRADED_LOG
    }
    return ProbeState.HEALTHY
  }

  /**
   * 一拍看门狗的决策。#210.3 / #210.4（源文档 §3.3 B1 顺序约束第 1 条）：
   * 三个状态无关副作用（onEngineProbe 更新回退确认、标记消费、唤醒锁续期）在
   * **任何分支早退之前**执行——含 [tripped] 熔断打开的那一拍；否则 12 拍之后
   * 所有修复都被熔断早退吞掉。调用方（EngineService）只按返回值执行破坏性动作。
   */
  internal fun planTick(
    state: ProbeState,
    now: Long,
    nextRestartAllowedAt: Long,
    engineReady: Boolean,
    engineProcessAlive: Boolean,
    bootAgeMs: Long,
    restartDeadConfirmations: Int,
    startCooldownMs: Long = EngineManager.START_COOLDOWN_MS,
    feedProbe: (Boolean) -> Unit,
    consumeMarkers: () -> Unit,
    refreshWake: () -> Unit,
    undoReady: () -> Boolean,
  ): TickPlan {
    // ── 前置副作用（#210.3/#210.4）：与状态分类无关，先于一切早退 ──
    feedProbe(state == ProbeState.HEALTHY)
    recordProbe(state)
    consumeMarkers()
    refreshWake()

    val logs = ArrayList<String>(2)
    val degradedLadderTripped = state == ProbeState.DEGRADED_HTTP && degradedHttpTripped()
    val alive = state != ProbeState.DEAD
    if (degradedLadderTripped) {
      logs += "DEGRADED_HTTP 连续 " + consecutiveDegradedHttp + " 拍（端口可连但 HTTP 持续失败）→ 升级为受控重启"
    }
    // DEGRADED_LOG 保留「绝不重启」语义：HTTP 存活时重启会打断活动 turn。
    if (alive && !degradedLadderTripped) return TickPlan(TickAction.IDLE)
    if (!engineReady) return TickPlan(TickAction.HOLD)
    if (!degradedLadderTripped && consecutiveFailures < restartDeadConfirmations) {
      return TickPlan(
        TickAction.HOLD,
        listOf("confirmed-dead sample " + consecutiveFailures + "/" + restartDeadConfirmations + "; observing before restart"),
      )
    }
    if (tripped()) {
      return TickPlan(TickAction.HOLD, logs + "watchdog circuit open after confirmed-dead failures; destructive recovery paused")
    }
    if (engineProcessAlive && bootAgeMs in 0 until startCooldownMs) {
      return TickPlan(TickAction.HOLD, logs + "dead probe deferred while the tracked child remains inside its boot window")
    }
    if (undoReady()) {
      return TickPlan(TickAction.UNDO, logs + ("auto-undo trigger after confirmed failures=" + effectiveFailureCount()))
    }
    if (now < nextRestartAllowedAt) {
      return TickPlan(TickAction.HOLD, logs + ("restart deferred for " + (nextRestartAllowedAt - now) + "ms"))
    }
    return TickPlan(TickAction.RESTART, logs, force = engineProcessAlive)
  }

  /** watchdog 一拍的恢复动作（#210.2/.3/.4）。 */
  enum class TickAction {
    /** 存活且未触发半死阶梯：调用方复位重启窗口并解除 undo 观察。 */
    IDLE,
    /** 本拍不动作（未就绪 / 观察窗 / 熔断打开 / 启动冷却 / 重启节流）。 */
    HOLD,
    /** 触发配置层急救回撤（UndoGate）。 */
    UNDO,
    /** 请求受控重启（force = 托管子进程仍在场，须换进程）。 */
    RESTART,
  }

  /** [planTick] 的决策结果；[logs] 为本次 tick 应写入 dsh-watchdog 的结构化行。 */
  data class TickPlan(
    val action: TickAction,
    val logs: List<String> = emptyList(),
    val force: Boolean = false,
  )

  /** Compatibility projection for callers that only need a strict HTTP health bit. */
  fun deepProbe(context: Context): Boolean = assessProbe(context) == ProbeState.HEALTHY

  /** 会话短哈希（D14：标题缺失时的可区分回落，非字面量）。 */
  private fun markerTag(sessionId: String): String {
    if (sessionId.isEmpty()) return "未知"
    return (sessionId.hashCode() and 0x7fffffff).toString(16).padStart(6, '0').takeLast(6)
  }

  /** 引擎事件桥标记文件（dsh-android-bridge 写入 home/.dsh/.task-done.ndjson；经 context 推导）。 */
  private fun taskMarkerFile(context: Context): java.io.File =
    java.io.File(File(context.filesDir, "home/.dsh"), ".task-done.ndjson")

  /** 标记文件消费偏移（FX-212.3：按字节推进；-1 = 尚未从 prefs 装载）。 */
  @Volatile
  private var markerOffset = -1L

  /** 单次读取上限（与 OverlayLiveFeed / NotifyStore 同口径：行边界在 CAP 内，溢出留到下一轮）。 */
  internal val markerReadCapBytes: Int = 256 * 1024

  /** 消费窗口的纯函数结果：[lines] 整行；[advance] 本次可推进的字节数（到最后一个换行符）。 */
  internal data class MarkerWindow(val lines: List<String>, val advance: Long)

  /**
   * FX-212.3（纯函数，JVM 单测）：从一个读取窗口里取出**整行前缀**。
   * 没有换行（半行）时 advance=0 —— 偏移不推进，等下一拍补齐；多字节被截断的尾字符同理自然消失。
   * 旧实现 readLines() + writeText("") 的三态缺陷（读-清窗口吞行、清零窗口重复投递、无界读）
   * 都靠「只推进整行 + 从不截断」这一条消掉。
   */
  internal fun markerConsumeWindow(payload: ByteArray, length: Int): MarkerWindow {
    val n = length.coerceAtMost(payload.size)
    var last = -1
    var i = n - 1
    while (i >= 0) {
      if (payload[i] == '\n'.code.toByte()) { last = i; break }
      i--
    }
    if (last < 0) return MarkerWindow(emptyList(), 0L)
    val lines = ArrayList<String>()
    for (piece in String(payload, 0, last, Charsets.UTF_8).split("\n")) {
      val t = piece.trim()
      if (t.isNotEmpty()) lines.add(t)
    }
    return MarkerWindow(lines, (last + 1).toLong())
  }

  private fun markerOffsetOf(context: Context): Long {
    if (markerOffset < 0) markerOffset = NotifyCenter.prefs(context).getLong(KEY_MARKER_OFFSET, 0L)
    return markerOffset
  }

  private fun markerOffsetTo(context: Context, value: Long) {
    markerOffset = value
    try {
      NotifyCenter.prefs(context).edit().putLong(KEY_MARKER_OFFSET, value).apply()
    } catch (_: Exception) {
      // prefs 写失败只损「重启后偏移」，不影响本轮消费
    }
  }

  /**
   * 消费任务完成标记（FX-212.3，按偏移推进；**不再截断文件**）。
   *
   * 为什么偏移要落 prefs（对计划口径的唯一增补）：只放内存时，进程每次重启 offset 归零 →
   * 「新壳 + 老引擎」组合（没有 .notify.ndjson，双读不双发门永不置位）会把历史标记**重复通知**一遍；
   * 落 prefs 后：离线期间写入的标记仍会被消费（保留原语义），重启不重放。
   *
   * #210.4：由 [planTick] 的前置段调用——HEALTHY/DEGRADED_HTTP/DEGRADED_LOG/DEAD 四态都要消费。
   */
  internal fun consumeTaskDoneMarkers(context: Context) {
    val debugLog = java.io.File(context.filesDir, "notify-debug.log")
    fun dbg(msg: String) { try { debugLog.appendText(System.currentTimeMillis().toString() + " " + msg + "\n") } catch (_: Exception) {} }
    try {
      val f = taskMarkerFile(context)
      if (!f.exists()) return
      val len = f.length()
      var offset = markerOffsetOf(context)
      if (len < offset) {
        // 文件被轮转/重建（旧 truncate 语义或外部清理）：偏移归零重新读
        dbg("marker shrunk: len=" + len + " offset=" + offset + " -> 0")
        markerOffsetTo(context, 0L)
        offset = 0L
      }
      if (len == offset) return
      var window = MarkerWindow(emptyList(), 0L)
      try {
        java.io.RandomAccessFile(f, "r").use { raf ->
          val want = (len - offset).coerceAtMost(markerReadCapBytes.toLong()).toInt()
          val buf = ByteArray(want)
          raf.seek(offset)
          val read = raf.read(buf)
          if (read > 0) window = markerConsumeWindow(buf, read)
        }
      } catch (e: Exception) {
        dbg("marker read failed: " + (e.message ?: e.javaClass.simpleName))
        return
      }
      dbg("marker window: len=" + len + " offset=" + offset + " consumedBytes=" + window.advance + " lines=" + window.lines.size)
      var notified = 0
      for (line in window.lines) {
        dbg("line: " + line)
        try {
          val j = org.json.JSONObject(line)
          // D14 同源约束：标题缺失时回落可区分标识（会话短哈希），不再回落字面量「任务完成」
          val title = j.optString("title").ifBlank { "会话 " + markerTag(j.optString("sessionId")) }
          val snippet = j.optString("text").ifBlank { "引擎已完成一轮任务处理" }
          // NT-09 双读不双发：.notify.ndjson 已服役时旧信道只做回退（不在两处重复投递）
          val posted = NotifyStore.legacyFallback(context, title, snippet)
          if (posted) notified++
          dbg("notify returned ok=" + posted)
        } catch (e: Exception) {
          dbg("notify threw: " + (e.message ?: e.javaClass.simpleName))
        }
      }
      // 只推进整行字节；**永不 writeText("")**（截断会清零窗口内的行，且崩溃中途会重复投递）
      if (window.advance > 0) markerOffsetTo(context, offset + window.advance)
      dbg("done notified=" + notified + " consumedLines=" + window.lines.size + " newOffset=" + markerOffset)
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
