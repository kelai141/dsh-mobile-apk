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
    /** 上一拍读到的 live 流长度（§6.2「turn 在跑」的活动信号；增长即视为有活动）。 */
    var lastLiveFeedLength = -1L
    /** 上一拍开始时刻（§6.3 标准拍折算用；0 = 尚未拍过一次，按一个标准拍处理）。 */
    var lastWatchdogTickAt = 0L
  }
  private val serviceEpoch = java.util.concurrent.atomic.AtomicReference<ServiceEpoch?>(null)
  private val startupExecutor = Executors.newSingleThreadScheduledExecutor()
  @Volatile private var serviceDestroyed = false
  private val restartDeadConfirmations = 2

  override fun onCreate() {
    super.onCreate()
    // Android's foreground-service deadline starts at startForegroundService().
    // Promote before preferences, manager construction or other initialization;
    // slow disk/class loading must not spend that deadline before notification.
    startForeground(NOTIFICATION_ID, buildNotification())
    // review C9：userShutdown 是持久状态的进程内镜像——新进程必须先恢复磁盘上的真值，
    // 否则开机/系统重启后（START_STICKY 重投递或 BootReceiver 拉起）「用户已手动关停」被遗忘。
    userShutdown = isUserShutdownPersisted(this)
    // C1: reuse the process-level pick token (auth survives watchdog engine restarts, never blank-allow).
    engineManager = EngineManager(this, EngineManager.ensurePickToken())
    serviceEpoch.set(ServiceEpoch())
    instance = this
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

  /**
   * §6.2：记一次唤醒锁活动租约（三类事件共用同一入口）。
   *
   * 为什么必须集中在一处：租约是「此刻有没有事在做」的唯一判据，散落多处写时间戳会让
   * 判据变成不可核对的隐式约定。刷新点只有三个来源——turn 在跑（[noteWakeActivityForTick]
   * 观察 live 流）、控制请求在途（ControlPoller 调本入口）、启动或重启窗口（ensureEngine
   * 与 RESTART 分支）。
   */
  internal fun noteWakeActivity() {
    WatchdogV2.WakeActivityLease.note()
    // 「有事件立即重取」：不等到下一拍。owner 已关闭（服务换代/停机）时 install 会自动拒绝，
    // 不需要在这里判 epoch。
    val owner = serviceEpoch.get()?.wakeOwner ?: return
    if (serviceDestroyed || userShutdown) return
    WatchdogV2.refreshWakeLock(this, owner)
  }

  /**
   * §6.2 每拍刷新活动信号：turn 在跑 / 重启后的启动窗口。
   *
   * ① live 流变长 = 引擎正在产事件（bridge 每条 turn 事件 append 一行）⇒ 有活动。
   *   用长度比较而不是解析内容：一拍一次 length()，比原来「每 5 秒一次 HTTP 探活 +
   *   4KB 日志读」便宜两个数量级，且不会误判「空转的引擎」为活动（文件不增长）。
   * ② 托管子进程仍在启动冷却窗内 = 启动或重启窗口 ⇒ 有活动（冷启动期 CPU 不能被放掉）。
   *
   * 首次观察（lastLiveFeedLength < 0）只建立基线不算活动：进程重启后历史文件里全是旧行，
   * 拿「文件非空」当活动会让租约无端新鲜 60 秒。
   *
   * 口径边界（如实记，不假装覆盖）：单次**长时间静默**的工具调用（例如一条跑满 3 分钟的
   * bash，期间没有任何 live 事件）在 60 秒后会被判为空闲并放锁。这是「空闲 60 秒释放」这条
   * 口径本身的一部分；下一条 live 事件（tool_result 等）到来时立刻重取。若日后要收紧这一档，
   * 应加的是引擎侧「turn 正在跑」的显式信号，而不是在这里堆启发式（会把空闲释放悄悄废掉）。
   */
  private fun noteWakeActivityForTick(epoch: ServiceEpoch) {
    val liveLength = WatchdogV2.liveFeedLength(this)
    val previous = epoch.lastLiveFeedLength
    epoch.lastLiveFeedLength = liveLength
    if (previous >= 0L && liveLength > previous) {
      noteWakeActivity()
    }
    val nowMs = System.currentTimeMillis()
    val bootAgeMs = nowMs - EngineManager.lastStartAttemptAt
    if (engineManager.engineProcessAlive() && bootAgeMs in 0 until EngineManager.START_COOLDOWN_MS) {
      noteWakeActivity()
    }
  }

  /**
   * §6.3：重排下一拍看门狗（旧实现是 scheduleWithFixedDelay 的固定 5 秒节奏）。
   *
   * 为什么要改成单次重排：健康态要退到 20 秒（每拍一次 HTTP 探活 + 4KB 日志读 + 端口探测，
   * 审计 §6.3），而 DEGRADED/DEAD/冷启动必须立刻回到 5 秒。固定延迟无法在「本拍刚判定为
   * 不健康」之后改变下一拍间隔——那正是「恢复从 30 秒变 90 秒」的来源。
   *
   * 重排只在「同一个 epoch 且还是同一个执行器」时发生；停机/换代后旧链自然终止，不会
   * 出现两个调度器同时拍（与 retireEpoch 的 shutdownNow 互补）。
   */
  private fun scheduleWatchdogTick(epoch: ServiceEpoch, exec: ScheduledExecutorService, delayMs: Long) {
    if (!isEpochCurrent(epoch) || epoch.watchdog.get() !== exec) return
    try {
      exec.schedule({ watchdogTick(epoch, exec) }, delayMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
    } catch (_: java.util.concurrent.RejectedExecutionException) {
      // 停机竞态：执行器已关闭。旧链按「不再重排」终止，无副作用。
    }
  }

  /**
   * §6.3：引擎是否在冷启动窗口内（托管子进程存在且离上次启动尝试不足 90 秒）。
   *
   * 冷启动期必须用 5 秒拍：此时每一拍都在判「起来没有」，20 秒一拍会让「起不来」的
   * 结论延后 3 倍——而它正是破坏性恢复的入口条件。
   */
  private fun isBootingWindow(): Boolean {
    if (!engineManager.engineProcessAlive()) return false
    val age = System.currentTimeMillis() - EngineManager.lastStartAttemptAt
    return age in 0 until EngineManager.START_COOLDOWN_MS
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
    // §6.2：启动窗口本身算活动（口径三类之一）——先记租约再取锁，否则租约空时取到的锁
    // 下一拍就会被放掉，等于没取。
    noteWakeActivity()
    WatchdogV2.acquireWakeLock(this, epoch.wakeOwner)
    if (!isEpochCurrent(epoch)) { WatchdogV2.releaseWakeLock(epoch.wakeOwner); return }
    val exec = Executors.newSingleThreadScheduledExecutor()
    if (!epoch.watchdog.compareAndSet(null, exec)) { exec.shutdownNow(); return }
    if (!isEpochCurrent(epoch)) { retireEpoch(epoch); return }
    try {
      // §6.3：把第一拍挂上调度链（此后每拍由 watchdogTick 自己按状态重排）。
      scheduleWatchdogTick(epoch, exec, WatchdogV2.HEALTHY_TICK_MS)
    } catch (t: Throwable) {
      retireEpoch(epoch)
      if (!serviceDestroyed && !userShutdown) Log.e("dsh-watchdog", "watchdog installation failed", t)
    }
    if (!isEpochCurrent(epoch)) retireEpoch(epoch)
  }

  /**
   * §6.3：看门狗一拍。由 [scheduleWatchdogTick] 按「本拍结论决定的间隔」逐拍重排，
   * 不再是固定 5 秒的 scheduleWithFixedDelay。
   *
   * 本方法只做「拍一次 + 定下一拍间隔」两件事；判定仍全部委托 WatchdogV2.planTick
   * （#210.3/#210.4 的前置副作用顺序原样保留在 planTick 内）。
   */
  private fun watchdogTick(epoch: ServiceEpoch, exec: ScheduledExecutorService) {
    // 下一拍间隔：try 与 catch 两侧都要写，故声明在外（默认取非健康节奏 5 秒）。
    var nextDelayMs = WatchdogV2.ACTIVE_TICK_MS
    try {
      if (!isEpochCurrent(epoch) || epoch.watchdog.get() !== exec) return
      val now = System.currentTimeMillis()
      // §6.3（0.14.10）：本拍实际经过多久 → 折算成多少个「标准拍（5 秒）」记账。
      // 阶梯阈值（30s/60s/90s）都按 5 秒拍标定：健康态退到 20 秒一拍后，若仍按
      // 「一拍 = 一个阶梯单位」计数，30 秒的阶梯会变成 120 秒——审计点名的陷阱。
      // 折算后无论调度拍长多少，恢复与熔断都落在同一时间点（见 WatchdogV2.tickUnits）。
      // 首拍（lastWatchdogTickAt = 0）按一个标准拍处理：不能把它当成「隔了很久」，
      // 否则服务刚起的第一拍就折算成整条阶梯（6 个标准拍），等于跳过整个观察窗。
      val tickMs = if (epoch.lastWatchdogTickAt <= 0L) 0L else now - epoch.lastWatchdogTickAt
      epoch.lastWatchdogTickAt = now
      val units = WatchdogV2.tickUnits(tickMs)
      // 本拍探活状态（用于定下一拍节奏；异常拍保持非健康节奏）。
      var tickState: WatchdogV2.ProbeState? = null
      // 启动流正在排队重试或修复助手持有闸门时，后台不得同时重启、回撤或改写
      // 正在被修复的运行时。保留通知消费与唤醒锁续期：它们不解耦地改写运行时状态。
      if (RepairState.required(this) || RepairState.active || RepairState.retryPending) {
        NotifyStore.drainTick(this)
        if (!isEpochCurrent(epoch)) return
        noteWakeActivityForTick(epoch)
        WatchdogV2.refreshWakeLock(this, epoch.wakeOwner)
        // 修复态不打探活 ⇒ 保持非健康节奏（5 秒）复看，不拖到 20 秒。
        return
      }
      // P1（0.14.1 通知停摆修复）：通知信道消费的**兜底驱动**（`NotifyStore` 的 drainTick）。
      // 它必须在本拍的任何状态判定之前执行——引擎 HEALTHY 时也要消费，而在 DEAD/DEGRADED 各态下
      // 更是唯一活着的消费者（真机停摆现场：`.notify.ndjson` 一直在长，而事件驱动的消费一条也没
      // 投出去，只有这条 5 s 心跳的日志还在更新）。幂等 + 一次 stat，不改本拍语义，失败也不冒泡。
      NotifyStore.drainTick(this)
      if (!isEpochCurrent(epoch)) return
      // §6.2：本拍开始前先刷新活动信号（turn 在跑 / 启动或重启窗口）。它必须在
      // planTick 之前——refreshWake 是 planTick 的前置副作用，读到的是本拍的租约状态。
      noteWakeActivityForTick(epoch)
      if (!isEpochCurrent(epoch)) return
      val state = WatchdogV2.assessProbe(this) { isEpochCurrent(epoch) }
      tickState = state
      if (!isEpochCurrent(epoch)) return
      // UndoGate 的历史健康记录在 0.14.8 起不再更新：插件已退役，壳侧不再运行自动 undo。
      // 急救 CLI 与已有快照仍保留给用户手动恢复。
      if (!isEpochCurrent(epoch)) return
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
        // 自动 undo 主代理已断开运行调用（0.14.8）：看门狗只做探活与受控重启。
        // UndoGate 类保留为历史实现，手动急救入口不受影响。
        undoReady = { false },
        callerCurrent = { isEpochCurrent(epoch) },
        // §6.3：按本拍真实间隔折算的标准拍数记账（20 秒拍 = 4 个标准拍）。
        units = units,
      )
      if (!isEpochCurrent(epoch)) return
      // §6.3：只有健康且不在冷启动窗口时才用 20 秒拍；DEGRADED_*/DEAD/冷启动一律回到
      // 5 秒（tickState 是本拍真实探活结论，不看上一拍，恢复不会被长间隔拖成三倍）。
      nextDelayMs = WatchdogV2.nextTickDelayMs(tickState ?: WatchdogV2.ProbeState.DEAD, booting = isBootingWindow())
      for (line in plan.logs) {
        if (!isEpochCurrent(epoch)) return
        LogCollector.log("dsh-watchdog", line)
      }
      if (!isEpochCurrent(epoch)) return
      when (plan.action) {
        WatchdogV2.TickAction.IDLE -> {
          epoch.nextRestartAllowedAt = 0L
        }
        WatchdogV2.TickAction.HOLD -> Unit
        WatchdogV2.TickAction.UNDO -> Unit
        WatchdogV2.TickAction.RESTART -> {
          if (!isEpochCurrent(epoch)) return
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
          if (!isEpochCurrent(epoch)) return
          // §6.2：重启窗口算活动——noteWakeActivity 内部即按新租约重取唤醒锁
          // （有事件立即重取，不等下一拍），冷启动期间的 CPU 不会被放掉。
          noteWakeActivity()
          // issue #684：让行（刷新中）不算「已发起」——日志要如实区分，否则排障时
          // 「accepted=true 但进程不在」无法归因。
          val startOutcome = engineManager.startEngine(force = plan.force)
          val requested = startOutcome == EngineStartOutcome.STARTED
          if (!isEpochCurrent(epoch)) return
          val delayMs = WatchdogV2.nextDelayMs()
          epoch.nextRestartAllowedAt = now + delayMs
          LogCollector.log(
            "dsh-watchdog",
            "restart requested after confirmed failure #" + WatchdogV2.effectiveFailureCount() +
              " (accepted=" + requested + ", outcome=" + startOutcome + ", next eligible in " + delayMs + "ms)",
          )
        }
      }
    } catch (t: Throwable) {
      if (!isEpochCurrent(epoch)) return
      Log.e("dsh-watchdog", "watchdog tick failed", t)
      LogCollector.log("dsh-watchdog", "watchdog tick failed: " + (t.message ?: t.javaClass.simpleName))
      if (isEpochCurrent(epoch)) WatchdogV2.refreshWakeLock(this, epoch.wakeOwner)
      // 异常拍按「非健康」收口：下一拍回到 5 秒节奏复看。
      nextDelayMs = WatchdogV2.ACTIVE_TICK_MS
    }
    // §6.3：单次延迟重排——旧 scheduleWithFixedDelay 的固定 5 秒节奏换成按状态自适应。
    // 判定全部收口在 nextDelayMs，本处只负责「什么时候再看一眼」。
    if (isEpochCurrent(epoch) && epoch.watchdog.get() === exec) {
      scheduleWatchdogTick(epoch, exec, nextDelayMs)
    }
  }

  private fun buildNotification(): android.app.Notification {
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("engine", UserCopy.APP_NAME + UiText.t(this, " 引擎", " engine"), NotificationManager.IMPORTANCE_LOW))
    }
    val pending = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, "engine")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(UserCopy.APP_NAME + UiText.t(this, " 引擎运行中", " engine is running"))
      .setContentText(UiText.t(this, UserCopy.APP_NAME + " 正在后台工作", UserCopy.APP_NAME + " is working in the background"))
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
