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
    // 0.14.0-preview §6.2/§6.3：通知信道消费点 + 通知应答流（两者都是进程级幂等单例）。
    // 落在这里而不是 OverlayService：通知必须**独立于悬浮球开关**生存（§6.0 风险 2）。
    NotifyStore.start(this)
    NotifyBridge.start(this)
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
    // ST-11：偏好仍为开时不停采集器（否则开关会乐观置位「开」而实际已停）；
    // 偏好已关才停。回前台由 MainActivity.onResume 的 DevLogControl.ensureStarted 补启。
    if (!DevLogControl.isPrefEnabled(this)) LogCollector.stop()
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
    // FX-210.1：恢复入口是「服务路径与 Activity 路径」的共同前置——引擎已被前台服务拉起
    // 时重开 app 也要消费 .snapshot-transaction 判据（此前只在 Activity 启动流内、且在
    // 「引擎已在跑」早退之后）。幂等：无事务时只是一次 stat。
    engineManager.recoverInterruptedRefresh()
    if (watchdog == null) {
      WatchdogV2.acquireWakeLock(this)
      watchdog = Executors.newSingleThreadScheduledExecutor().also { exec ->
        exec.scheduleWithFixedDelay({
          try {
            val now = System.currentTimeMillis()
            val state = WatchdogV2.assessProbe(this)
            // FX-210.2/.3/.4：决策与状态无关副作用全部落在 planTick 的前置段（先于一切早退，
            // 含熔断打开的那一拍），调用方只执行返回的破坏性动作。退避/熔断同用
            // effectiveFailureCount（半死阶梯与 DEAD 共用计数，见 #175/#210.2）。
            val plan = WatchdogV2.planTick(
              state = state,
              now = now,
              nextRestartAllowedAt = nextRestartAllowedAt,
              engineReady = engineManager.engineReady,
              engineProcessAlive = engineManager.engineProcessAlive(),
              bootAgeMs = now - EngineManager.lastStartAttemptAt,
              restartDeadConfirmations = restartDeadConfirmations,
              feedProbe = { healthy -> engineManager.onEngineProbe(healthy) },
              consumeMarkers = { WatchdogV2.consumeTaskDoneMarkers(this) },
              refreshWake = { WatchdogV2.refreshWakeLock(this) },
              undoReady = { UndoGate.onProbeFailure(this, WatchdogV2.effectiveFailureCount()) },
            )
            for (line in plan.logs) LogCollector.log("dsh-watchdog", line)
            when (plan.action) {
              WatchdogV2.TickAction.IDLE -> {
                nextRestartAllowedAt = 0L
                UndoGate.disarm(this)
              }
              WatchdogV2.TickAction.HOLD -> Unit
              WatchdogV2.TickAction.UNDO -> {
                nextRestartAllowedAt = now + WatchdogV2.nextDelayMs()
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
              }
              WatchdogV2.TickAction.RESTART -> {
                if (plan.force) {
                  engineManager.mirrorDiagnosticsToShared("engine-boot-hung")
                  LogCollector.log("dsh-watchdog", "tracked child exceeded boot deadline; forcing one controlled restart")
                }
                val requested = engineManager.startEngine(force = plan.force)
                val delayMs = WatchdogV2.nextDelayMs()
                nextRestartAllowedAt = now + delayMs
                LogCollector.log(
                  "dsh-watchdog",
                  "restart requested after confirmed failure #" + WatchdogV2.effectiveFailureCount() +
                    " (accepted=" + requested + ", next eligible in " + delayMs + "ms)",
                )
              }
            }
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
