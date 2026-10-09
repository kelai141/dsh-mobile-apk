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
  private class ServiceEpoch {
    val stopped = java.util.concurrent.atomic.AtomicBoolean(false)
    val startupQueued = java.util.concurrent.atomic.AtomicBoolean(false)
    val startupCaller = java.util.concurrent.atomic.AtomicReference<Thread?>(null)
    val startupFuture = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.ScheduledFuture<*>?>(null)
    val undoCaller = java.util.concurrent.atomic.AtomicReference<Thread?>(null)
    val watchdog = java.util.concurrent.atomic.AtomicReference<ScheduledExecutorService?>(null)
    val wakeOwner = WatchdogV2.WakeLockOwner()
    val ownershipRetry = StartupOwnershipRetryBudget()
    var nextRestartAllowedAt = 0L
    var lastDeathMirrorAt = 0L
  }
  private val serviceEpoch = java.util.concurrent.atomic.AtomicReference<ServiceEpoch?>(null)
  private val startupExecutor = Executors.newSingleThreadScheduledExecutor()
  @Volatile private var serviceDestroyed = false
  private val restartDeadConfirmations = 2

  override fun onCreate() {
    super.onCreate()
    // review C9：userShutdown 是持久状态的进程内镜像——新进程必须先恢复磁盘上的真值，
    // 否则开机/系统重启后（START_STICKY 重投递或 BootReceiver 拉起）「用户已手动关停」被遗忘。
    userShutdown = isUserShutdownPersisted(this)
    // C1: reuse the process-level pick token (auth survives watchdog engine restarts, never blank-allow).
    engineManager = EngineManager(this, EngineManager.ensurePickToken())
    serviceEpoch.set(ServiceEpoch())
    instance = this
    startForeground(NOTIFICATION_ID, buildNotification())
    // 0.14.0-preview §6.2/§6.3：通知信道消费点 + 通知应答流（两者都是进程级幂等单例）。
    // 落在这里而不是 OverlayService：通知必须**独立于悬浮球开关**生存（§6.0 风险 2）。
    NotifyStore.start(this)
    NotifyBridge.start(this)
    // 0.14.0 承载拆离：控制队列随前台引擎服务起停——a11y 关着也能承载 browser*/vd*。
    ControlCarrier.ensureStarted(this)
    // Dev log toggle on: persistent collection (logcat + engine.log → dshdata/log/, daily).
    if (MainActivity.DevLogPrefs.isEnabled(this)) LogCollector.start(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!userShutdown) {
      // Root maintenance/transaction recovery must never wait on the Service main thread.
      if (!serviceDestroyed) {
        val epoch = serviceEpoch.get() ?: ServiceEpoch().let { candidate ->
          if (serviceEpoch.compareAndSet(null, candidate)) candidate else serviceEpoch.get()
        }
        if (epoch != null && epoch.startupQueued.compareAndSet(false, true)) scheduleStartup(epoch, 0L)
      }
    } else {
      serviceEpoch.get()?.let { retireEpoch(it) }
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
    serviceDestroyed = true
    serviceEpoch.get()?.let { retireEpoch(it) }
    startupExecutor.shutdownNow() // Cancels caller waits, not RootOwnershipJobs' shared worker.
    val currentInstance = instance === this
    if (currentInstance) { ControlCarrier.stop(); instance = null }
    // ST-11：偏好仍为开时不停采集器（否则开关会乐观置位「开」而实际已停）；
    // 偏好已关才停。回前台由 MainActivity.onResume 的 DevLogControl.ensureStarted 补启。
    if (currentInstance && !DevLogControl.isPrefEnabled(this)) LogCollector.stop()
    super.onDestroy()
  }

  /** User-requested shutdown: stop the watchdog + engine (no auto-restart). */
  fun requestShutdown() {
    if (serviceDestroyed || instance !== this) return
    setUserShutdown(this, true)
    serviceEpoch.get()?.let { retireEpoch(it) }
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
  private fun isEpochCurrent(epoch: ServiceEpoch): Boolean =
    !serviceDestroyed && !userShutdown && !Thread.currentThread().isInterrupted &&
      !epoch.stopped.get() && serviceEpoch.get() === epoch && instance === this

  /** One queued/running startup chain per epoch; pending results keep the same bounded chain. */
  private fun scheduleStartup(epoch: ServiceEpoch, delayMs: Long) {
    if (!isEpochCurrent(epoch)) return
    try {
      synchronized(epoch) {
        val future = startupExecutor.schedule({
          // A zero-delay task must not reschedule before its future has been installed.
          synchronized(epoch) { if (!isEpochCurrent(epoch)) return@schedule }
          val caller = Thread.currentThread()
          epoch.startupCaller.set(caller)
          try { if (isEpochCurrent(epoch)) ensureEngine(epoch) }
          catch (t: Throwable) {
            if (isEpochCurrent(epoch)) {
              epoch.startupQueued.set(false)
              Log.e("dsh-engine", "service startup failed", t)
            }
          }
          finally { epoch.startupCaller.compareAndSet(caller, null) }
        }, delayMs, TimeUnit.MILLISECONDS)
        epoch.startupFuture.getAndSet(future)?.cancel(false)
        if (!isEpochCurrent(epoch)) future.cancel(true)
      }
    } catch (_: java.util.concurrent.RejectedExecutionException) {
      // Destruction can reject a queued retry. No effects or replacement teardown follow.
    }
  }

  private fun retireEpoch(epoch: ServiceEpoch) {
    serviceEpoch.compareAndSet(epoch, null)
    epoch.stopped.set(true)
    epoch.startupFuture.getAndSet(null)?.cancel(true)
    epoch.startupCaller.getAndSet(null)?.interrupt()
    epoch.undoCaller.getAndSet(null)?.interrupt()
    epoch.watchdog.getAndSet(null)?.shutdownNow()
    WatchdogV2.releaseWakeLock(epoch.wakeOwner)
  }

  private fun ensureEngine(epoch: ServiceEpoch) {
    if (!isEpochCurrent(epoch)) return
    val ownership = ShizukuTransport.prepareStartupOwnership(applicationContext)
    if (!isEpochCurrent(epoch)) return
    if (startupOwnershipPending(ownership.optString("reason"))) {
      val delay = epoch.ownershipRetry.nextDelayMs() ?: SLOW_OWNERSHIP_RECHECK_MS
      scheduleStartup(epoch, delay)
      if (delay == SLOW_OWNERSHIP_RECHECK_MS) {
        Log.i("dsh-root", "service startup remains deferred; ownership recheck in " + delay + "ms")
      }
      return
    }
    if (!ownership.optBoolean("ok")) LogCollector.log("dsh-root", "service preboot ownership repair incomplete: " + ownership.optString("reason"))
    if (!isEpochCurrent(epoch)) return
    val ready = engineManager.engineReady
    if (!isEpochCurrent(epoch)) return
    if (!ready) { epoch.startupQueued.set(false); return }
    // FX-210.1：恢复入口是「服务路径与 Activity 路径」的共同前置——引擎已被前台服务拉起
    // 时重开 app 也要消费 .snapshot-transaction 判据（此前只在 Activity 启动流内、且在
    // 「引擎已在跑」早退之后）。幂等：无事务时只是一次 stat。
    engineManager.recoverInterruptedRefresh()
    // Recovery can wait in root/Binder/disk; never install after that wait without a new epoch check.
    if (!isEpochCurrent(epoch)) return
    if (engineManager.snapshotRecoveryBlocksRuntime()) {
      Log.e("dsh-engine", "startup held: snapshot recovery journal remains unresolved")
      epoch.startupQueued.set(false)
      return
    }
    WatchdogV2.acquireWakeLock(this, epoch.wakeOwner)
    if (!isEpochCurrent(epoch)) { WatchdogV2.releaseWakeLock(epoch.wakeOwner); return }
    val exec = Executors.newSingleThreadScheduledExecutor()
    if (!epoch.watchdog.compareAndSet(null, exec)) { exec.shutdownNow(); return }
    if (!isEpochCurrent(epoch)) { retireEpoch(epoch); return }
    try {
        exec.scheduleWithFixedDelay({
          try {
            if (!isEpochCurrent(epoch) || epoch.watchdog.get() !== exec) return@scheduleWithFixedDelay
            val now = System.currentTimeMillis()
            // P1（0.14.1 通知停摆修复）：通知信道消费的**兜底驱动**（`NotifyStore` 的 drainTick）。
            // 它必须在本拍的任何状态判定之前执行——引擎 HEALTHY 时也要消费，而在 DEAD/DEGRADED 各态下
            // 更是唯一活着的消费者（真机停摆现场：`.notify.ndjson` 一直在长，而事件驱动的消费一条也没
            // 投出去，只有这条 5 s 心跳的日志还在更新）。幂等 + 一次 stat，不改本拍语义，失败也不冒泡。
            NotifyStore.drainTick(this)
            if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
            val state = WatchdogV2.assessProbe(this) { isEpochCurrent(epoch) }
            if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
            // 自动回滚的目标选择（2026-09-21）：**壳侧探活 HEALTHY 是「好」的唯一硬证据**。
            // 急救 CLI 的 restore-last-good 认的是插件自报的 boot-state（apply 阶段/30s 定时写 ok，
            // 不代表引擎整体起来了）——设备实测过「引擎起不来但 boot-state 仍 ok」的形态，于是回滚
            // 会把**含坏配置的那份快照**原样写回。这里在健康拍记下当时的最新快照 id，UndoGate 回滚时
            // 优先用它回滚。幂等 + 一次目录列举，值不变不落盘。
            if (state == WatchdogV2.ProbeState.HEALTHY) UndoGate.noteHealthy(this, engineManager)
            if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
            // FX-210.2/.3/.4：决策与状态无关副作用全部落在 planTick 的前置段（先于一切早退，
            // 含熔断打开的那一拍），调用方只执行返回的破坏性动作。退避/熔断同用
            // effectiveFailureCount（半死阶梯与 DEAD 共用计数，见 #175/#210.2）。
            val plan = WatchdogV2.planTick(
              state = state,
              now = now,
              nextRestartAllowedAt = epoch.nextRestartAllowedAt,
              engineReady = engineManager.engineReady,
              engineProcessAlive = engineManager.engineProcessAlive(),
              bootAgeMs = now - EngineManager.lastStartAttemptAt,
              restartDeadConfirmations = restartDeadConfirmations,
              // 【issue #274 ①】端口归属的**生产口径**。
              //
              // 口径是「本进程是否托管着一个活着的引擎子进程」，而不是去反查 3080 的监听者：
              //   · 探活处于 DEGRADED_HTTP 时端口**必然可连**（否则会是 DEAD）；
              //   · 此刻若我们确有活着的托管子进程 ⇒ 端口几乎必然是我们的（半死档）；
              //   · 若我们没有任何托管子进程而端口仍可连 ⇒ 占着它的是**别人**，
              //     此时盲目重启只会撞 EADDRINUSE，先 HOLD 并留诊断行。
              //
              // 这是**代理判据**，不是内核级归属证明（本仓无 netstat/uid 反查的设备无关通道）。
              // 它偏保守：只有在「我们没有活子进程」时才判为他人占用。
              // 自愈性：他人进程退出后端口不再可达 ⇒ 状态转为 DEAD ⇒ 该门不再适用（degradedLadderTripped=false），
              // 重启路径照常恢复，不会形成永久死局。
              portOwnedByApp = engineManager.engineProcessAlive(),
              feedProbe = { healthy -> if (isEpochCurrent(epoch)) engineManager.onEngineProbe(healthy) },
              consumeMarkers = { if (isEpochCurrent(epoch)) WatchdogV2.consumeTaskDoneMarkers(this) },
              refreshWake = { if (isEpochCurrent(epoch)) WatchdogV2.refreshWakeLock(this, epoch.wakeOwner) },
              // 【issue #274 ①】回滚的证据门：探活超时 = 「引擎在忙/磁盘慢」而非故障，
              // 端口非本进程持有 = 重启/回滚都不解决问题。两者命中时本拍既不 arm 也不 execute。
              undoReady = {
                isEpochCurrent(epoch) && UndoGate.onProbeFailure(
                  this,
                  WatchdogV2.effectiveFailureCount(),
                  UndoGate.RollbackEvidence(
                    logTail = WatchdogV2.lastLogTail,
                    portOwnedByApp = engineManager.engineProcessAlive(),
                    slowOnly = WatchdogV2.lastProbeTimedOut,
                  ),
                  engine = engineManager,
                )
              },
              callerCurrent = { isEpochCurrent(epoch) },
            )
            if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
            for (line in plan.logs) {
              if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
              LogCollector.log("dsh-watchdog", line)
            }
            if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
            when (plan.action) {
              WatchdogV2.TickAction.IDLE -> {
                epoch.nextRestartAllowedAt = 0L
                UndoGate.disarm(this)
              }
              WatchdogV2.TickAction.HOLD -> Unit
              WatchdogV2.TickAction.UNDO -> {
                epoch.nextRestartAllowedAt = now + WatchdogV2.nextDelayMs()
                val caller = Thread {
                  try {
                    if (!isEpochCurrent(epoch)) return@Thread
                    val result = UndoGate.execute(this, engineManager)
                    if (!isEpochCurrent(epoch)) return@Thread
                    if (result.executed) {
                      // 0.14.1：配置回滚成功后必须解除熔断锁存。tripped 一旦为真即永久 HOLD，
                      // 只有 HEALTHY 探活或 EngineStartFlow 的唯一一处 reset 能解——而 undo 成功
                      // 正是「引擎应当重新可用」的时点，此处不复位会让恢复后的世代白白被锁住。
                      WatchdogV2.reset()
                      LogCollector.log("dsh-watchdog", "auto-undo ok -> " + (result.snapshotId ?: "?"))
                      if (!isEpochCurrent(epoch)) return@Thread
                      engineManager.resetCooldown()
                      if (!isEpochCurrent(epoch)) return@Thread
                      engineManager.startEngine()
                    } else {
                      LogCollector.log("dsh-watchdog", "auto-undo not executed: " + result.summary.take(160))
                      // 回滚不可用时必须**解除失败计数与熔断锁存**，否则本拍之后再没有恢复路径：
                      // planTick 在锁存打开后恒 HOLD（不再 RESTART），而「引擎一直死」又永远不会出现
                      // HEALTHY 拍去解开它 —— 用户看到的是「引擎死了、App 也不再重试」的死局。
                      // 2026-09-21 设备实测：跨版本护栏拒绝回滚（UndoGate 返回 executed=false）后正是这个形状
                      // （引擎进程消失、HTTP 000，直到进程重启才恢复）。复位只清计数/锁存，不清 arm 文件；
                      // 重启仍受退避约束（≤80s），不会打风暴。
                      if (isEpochCurrent(epoch)) WatchdogV2.reset()
                    }
                  } catch (t: Throwable) {
                    if (isEpochCurrent(epoch)) Log.e("dsh-watchdog", "auto-undo failed", t)
                  } finally {
                    epoch.undoCaller.compareAndSet(Thread.currentThread(), null)
                  }
                }
                if (epoch.undoCaller.compareAndSet(null, caller)) {
                  if (!isEpochCurrent(epoch)) {
                    epoch.undoCaller.compareAndSet(caller, null)
                    return@scheduleWithFixedDelay
                  }
                  caller.start()
                }
              }
              WatchdogV2.TickAction.RESTART -> {
                if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
                if (plan.force) {
                  engineManager.mirrorDiagnosticsToShared("engine-boot-hung")
                  LogCollector.log("dsh-watchdog", "tracked child exceeded boot deadline; forcing one controlled restart")
                } else if (now - epoch.lastDeathMirrorAt >= DEATH_MIRROR_INTERVAL_MS) {
                  // review C5：确认死亡的常态重启也镜像现场（10 分钟节流）——后台崩溃循环下
                  // 旧实现只在 force 档镜像，轮转几拍后原始 engine.log 已被滚掉，取证现场丢失。
                  val dir = engineManager.mirrorDiagnosticsToShared("engine-died")
                  if (dir != null) epoch.lastDeathMirrorAt = now
                  LogCollector.log("dsh-watchdog", "engine death diagnostics: " + (dir?.absolutePath ?: "unavailable"))
                }
                if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
                val requested = engineManager.startEngine(force = plan.force)
                if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
                val delayMs = WatchdogV2.nextDelayMs()
                epoch.nextRestartAllowedAt = now + delayMs
                LogCollector.log(
                  "dsh-watchdog",
                  "restart requested after confirmed failure #" + WatchdogV2.effectiveFailureCount() +
                    " (accepted=" + requested + ", next eligible in " + delayMs + "ms)",
                )
              }
            }
          } catch (t: Throwable) {
            if (!isEpochCurrent(epoch)) return@scheduleWithFixedDelay
            Log.e("dsh-watchdog", "watchdog tick failed", t)
            LogCollector.log("dsh-watchdog", "watchdog tick failed: " + (t.message ?: t.javaClass.simpleName))
            if (isEpochCurrent(epoch)) WatchdogV2.refreshWakeLock(this, epoch.wakeOwner)
          }
        }, 5, 5, TimeUnit.SECONDS)
    } catch (t: Throwable) {
      retireEpoch(epoch)
      if (!serviceDestroyed && !userShutdown) Log.e("dsh-watchdog", "watchdog installation failed", t)
    }
    if (!isEpochCurrent(epoch)) retireEpoch(epoch)
  }

  private fun buildNotification(): android.app.Notification {
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("engine", UserCopy.APP_NAME + " 引擎", NotificationManager.IMPORTANCE_LOW))
    }
    val pending = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, "engine")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(UserCopy.APP_NAME + " 引擎运行中")
      .setContentText(UserCopy.APP_NAME + " 正在后台工作")
      .setContentIntent(pending)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 2
    /** 常态死亡镜像的节流窗（review C5）：看门狗每 5s 一拍，崩溃循环下不能每拍都打包。 */
    private const val DEATH_MIRROR_INTERVAL_MS = 10 * 60 * 1000L

    /** 用户手动关停的持久真源（review C9）：BootReceiver 与 START_STICKY 重投递都必须尊重它。 */
    private const val LIFECYCLE_PREFS = "engine_lifecycle"
    private const val KEY_USER_SHUTDOWN = "user_shutdown"

    /** User-requested shutdown flag: after shutdown the watchdog/onStartCommand no longer raises the engine; the user must start it manually. */
    @Volatile
    var userShutdown = false

    /** 写内存镜像 + 落盘（磁盘是唯一跨进程/跨重启的真源）。 */
    fun setUserShutdown(context: android.content.Context, value: Boolean) {
      userShutdown = value
      try {
        context.applicationContext
          .getSharedPreferences(LIFECYCLE_PREFS, android.content.Context.MODE_PRIVATE)
          .edit().putBoolean(KEY_USER_SHUTDOWN, value).apply()
      } catch (_: Throwable) {
      }
    }

    /** 读磁盘上的用户停机状态；系统在进程外重启时（开机/START_STICKY 新进程）用它恢复。 */
    fun isUserShutdownPersisted(context: android.content.Context): Boolean = try {
      context.applicationContext
        .getSharedPreferences(LIFECYCLE_PREFS, android.content.Context.MODE_PRIVATE)
        .getBoolean(KEY_USER_SHUTDOWN, false)
    } catch (_: Throwable) {
      false
    }

    /** Currently running service instance (MainActivity's "Shut down" stops the watchdog via requestShutdown). */
    @Volatile
    var instance: EngineService? = null
  }
}

/**
 * 快速重试预算用尽后的复查节拍（2026-10-02 复审：UNKNOWN 不能没有上限——临时性的探测不完备
 * 若不复查，用户只能重启设备）。调用方在预算耗尽后按此节拍继续静默复查。
 */
internal const val SLOW_OWNERSHIP_RECHECK_MS = 300_000L

/** Six delayed retries per Service epoch; exhaustion falls back to a slow recheck instead of spinning/replaying. */
internal class StartupOwnershipRetryBudget {
  private val delaysMs = longArrayOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L)
  private val used = java.util.concurrent.atomic.AtomicInteger(0)
  fun nextDelayMs(): Long? {
    while (true) {
      val count = used.get()
      if (count >= delaysMs.size) return null
      if (used.compareAndSet(count, count + 1)) return delaysMs[count]
    }
  }
}
