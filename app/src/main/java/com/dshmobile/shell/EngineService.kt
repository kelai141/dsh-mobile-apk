package com.dsharnessmobile.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
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

  override fun onCreate() {
    super.onCreate()
    // C1：复用进程级 pick token（看门狗重启引擎后鉴权不失效、不空放行）。
    engineManager = EngineManager(this, EngineManager.ensurePickToken())
    instance = this
    startForeground(NOTIFICATION_ID, buildNotification())
    // 开发者日志开关已开：常驻收集（logcat + engine.log → dshdata/log/ 按天）。
    if (MainActivity.DevLogPrefs.isEnabled(this)) LogCollector.start(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!userShutdown) ensureEngine() else { watchdog?.shutdownNow(); watchdog = null }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    watchdog?.shutdownNow()
    watchdog = null
    if (instance === this) instance = null
    // 服务退出即停止日志收集（进程内幂等单例；开关关时也已停）。
    LogCollector.stop()
    super.onDestroy()
  }

  /** 用户请求关闭：停看门狗 + 停引擎（不自动重启）。 */
  fun requestShutdown() {
    userShutdown = true
    watchdog?.shutdownNow()
    watchdog = null
    try { engineManager.stopEngine() } catch (_: Exception) {
    }
  }

  /** Start the engine if not running, then arm the watchdog. */
  private fun ensureEngine() {
    if (EngineProbe.check().optBoolean("running", false)) return
    if (engineManager.engineReady && engineManager.startEngine()) {
      // Watchdog: poll every 5s; if the engine process dies, restart it.
      if (watchdog == null) {
        watchdog = Executors.newSingleThreadScheduledExecutor().also { exec ->
          exec.scheduleWithFixedDelay({
            if (!EngineProbe.check().optBoolean("running", false) && engineManager.engineReady) {
              engineManager.startEngine()
            }
          }, 5, 5, TimeUnit.SECONDS)
        }
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
    /** 用户请求关闭标记：关闭后看门狗/onStartCommand 不再自动拉起引擎，需用户手动启动。 */
    @Volatile
    var userShutdown = false
    /** 当前运行的服务实例（MainActivity「关闭」经 requestShutdown 停看门狗）。 */
    @Volatile
    var instance: EngineService? = null
  }
}
