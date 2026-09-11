package com.dsharnessmobile.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service owning the embedded engine lifecycle: keeps the app
 * process alive while backgrounded (user-visible notification) and restarts
 * the engine process when it dies (watchdog). M2 keep-alive, no root needed.
 */
class EngineService : Service() {

  private lateinit var engineManager: EngineManager
  private var watchdog: ScheduledExecutorService? = null
  private var nextRestartAllowedAt = 0L
  private val restartDeadConfirmations = 2

  override fun onCreate() {
    super.onCreate()
    // C1: reuse the process-level pick token (auth survives watchdog engine restarts, never blank-allow).
    engineManager = EngineManager(this, EngineManager.ensurePickToken())
    instance = this
    startForeground(NOTIFICATION_ID, buildNotification())
    // Dev log toggle on: persistent collection (logcat + engine.log → dshdata/log/, daily).
    if (MainActivity.DevLogPrefs.isEnabled(this)) LogCollector.start(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!userShutdown) ensureEngine() else {
      watchdog?.shutdownNow(); watchdog = null
      // 用户停机/划掉关闭后的 START_STICKY 重投递：不再常驻（撤前台通知、允许进程结束）。
      if (intent == null) { stopSelf(); return START_NOT_STICKY }
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /** 任务移除（生命周期礼仪 F5.3）：不启动任何隐藏复活（不反弹）。
   *  ADB-F9 修复（2026-09-05 用户拍板语义）：划掉后台 = 主动关闭——完整停机，不保活。
   *  保活（前台服务 + 看门狗）只服务「App 仍在后台未划掉」的场景。撤悬浮球 UI +
   *  requestShutdown（userShutdown 标记 + 停看门狗 + 停引擎）+ stopSelf（撤前台通知，
   *  onDestroy 释放 wakelock / 停日志）；START_STICKY 重投递被 userShutdown 门拦截。 */
  override fun onTaskRemoved(rootIntent: Intent?) {
    try {
      FileIncoming.cleanupTmp(this)
    } catch (_: Exception) {
    }
    try {
      stopService(Intent(this, OverlayService::class.java))
    } catch (_: Exception) {
    }
    requestShutdown()
    stopSelf()
    LogCollector.log("dsh-file-open", "onTaskRemoved: full shutdown (swipe-away = user close)")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    watchdog?.shutdownNow()
    watchdog = null
    WatchdogV2.releaseWakeLock()
    if (instance === this) instance = null
    // Log collection stops when the service exits (in-process idempotent singleton; also stopped when the toggle is off).
    LogCollector.stop()
    super.onDestroy()
  }

  /** User-requested shutdown: stop the watchdog + engine (no auto-restart). */
  fun requestShutdown() {
    userShutdown = true
    watchdog?.shutdownNow()
    watchdog = null
    try { engineManager.stopEngine() } catch (_: Exception) {
    }
  }

  /**
   * Start the engine if not running, then arm the watchdog. v2 (PRD F2-4):
   * the watchdog is installed in EVERY state — the previous early return for a
   * running engine left no watcher, so a later process death went unnoticed
   * until the user interacted. The tick also feeds the update-v2 confirmation/
   * rollback state machine (PRD F3.2/F1.10).
   */
  private fun ensureEngine() {
    if (!engineManager.engineReady) return
    if (watchdog == null) {
      WatchdogV2.acquireWakeLock(this)
      watchdog = Executors.newSingleThreadScheduledExecutor().also { exec ->
        exec.scheduleWithFixedDelay({
          try {
            val state = WatchdogV2.assessProbe(this)
            // 0.13.8 #175：DEGRADED_HTTP 达阈值后不再被 alive 早退——半死引擎（端口可连、
            // HTTP 持续失败）走与 DEAD 相同的受控重启阶梯；DEGRADED_LOG 保留不重启语义。
            val degradedLadderTripped = state == WatchdogV2.ProbeState.DEGRADED_HTTP && WatchdogV2.degradedHttpTripped()
            val alive = state != WatchdogV2.ProbeState.DEAD
            if (state == WatchdogV2.ProbeState.HEALTHY || state == WatchdogV2.ProbeState.DEAD) {
              engineManager.onEngineProbe(state == WatchdogV2.ProbeState.HEALTHY)
            }
            WatchdogV2.recordProbe(state)
            WatchdogV2.refreshWakeLock(this)

            if (alive && !degradedLadderTripped) {
              nextRestartAllowedAt = 0L
              UndoGate.disarm(this)
              return@scheduleWithFixedDelay
            }
            if (!engineManager.engineReady) return@scheduleWithFixedDelay
            if (!degradedLadderTripped && WatchdogV2.consecutiveFailures < restartDeadConfirmations) {
              LogCollector.log("dsh-watchdog", "confirmed-dead sample " + WatchdogV2.consecutiveFailures + "/" + restartDeadConfirmations + "; observing before restart")
              return@scheduleWithFixedDelay
            }
            if (degradedLadderTripped) {
              LogCollector.log("dsh-watchdog", "DEGRADED_HTTP 连续 " + WatchdogV2.consecutiveDegradedHttp + " 拍（端口可连但 HTTP 持续失败）→ 升级为受控重启")
            }
            if (WatchdogV2.tripped()) {
              LogCollector.log("dsh-watchdog", "watchdog circuit open after confirmed-dead failures; destructive recovery paused")
              return@scheduleWithFixedDelay
            }

            val now = System.currentTimeMillis()
            val managedChildAlive = engineManager.engineProcessAlive()
            val bootAge = now - EngineManager.lastStartAttemptAt
            if (managedChildAlive && bootAge in 0 until EngineManager.START_COOLDOWN_MS) {
              LogCollector.log("dsh-watchdog", "dead probe deferred while the tracked child remains inside its boot window")
              return@scheduleWithFixedDelay
            }
            if (UndoGate.onProbeFailure(this, WatchdogV2.effectiveFailureCount())) {
              nextRestartAllowedAt = now + WatchdogV2.nextDelayMs()
              LogCollector.log("dsh-watchdog", "auto-undo trigger after confirmed failures=" + WatchdogV2.effectiveFailureCount())
              Thread {
                val result = UndoGate.execute(this, engineManager)
                if (result.executed) {
                  LogCollector.log("dsh-watchdog", "auto-undo ok -> " + (result.snapshotId ?: "?"))
                  engineManager.resetCooldown()
                  engineManager.startEngine()
                } else {
                  LogCollector.log("dsh-watchdog", "auto-undo not executed: " + result.summary.take(160))
                }
              }.start()
              return@scheduleWithFixedDelay
            }
            if (now < nextRestartAllowedAt) {
              LogCollector.log("dsh-watchdog", "restart deferred for " + (nextRestartAllowedAt - now) + "ms")
              return@scheduleWithFixedDelay
            }

            if (managedChildAlive) {
              engineManager.mirrorDiagnosticsToShared("engine-boot-hung")
              LogCollector.log("dsh-watchdog", "tracked child exceeded boot deadline; forcing one controlled restart")
            }
            val requested = engineManager.startEngine(force = managedChildAlive)
            val delayMs = WatchdogV2.nextDelayMs()
            nextRestartAllowedAt = now + delayMs
            LogCollector.log(
              "dsh-watchdog",
              "restart requested after confirmed failure #" + WatchdogV2.effectiveFailureCount() +
                " (accepted=" + requested + ", next eligible in " + delayMs + "ms)",
            )
          } catch (t: Throwable) {
            Log.e("dsh-watchdog", "watchdog tick failed", t)
            LogCollector.log("dsh-watchdog", "watchdog tick failed: " + (t.message ?: t.javaClass.simpleName))
            WatchdogV2.refreshWakeLock(this)
          }
        }, 5, 5, TimeUnit.SECONDS)
      }
    }
  }

  private fun buildNotification(): android.app.Notification {
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("engine", "dsh 引擎", NotificationManager.IMPORTANCE_LOW))
    }
    val pending = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, "engine")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle("DeepCode 引擎运行中")
      .setContentText("DeepCode 正在后台工作")
      .setContentIntent(pending)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 2
    /** User-requested shutdown flag: after shutdown the watchdog/onStartCommand no longer raises the engine; the user must start it manually. */
    @Volatile
    var userShutdown = false
    /** Currently running service instance (MainActivity's "Shut down" stops the watchdog via requestShutdown). */
    @Volatile
    var instance: EngineService? = null
  }
}
