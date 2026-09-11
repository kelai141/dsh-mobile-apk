package com.dsharnessmobile.shell

import android.content.Intent
import android.util.Log
import android.view.View
import java.io.File

/**
 * 引擎启动流与失败分支（自 MainActivity 拆出）：启动/解压/轮询编排、启动失败自动重试、
 * 自动回撤（UndoGate）、在线更新检查、开发者选项关闭/重启，以及前台引擎监控与
 * WebView 渲染进程冻结看门狗（两者均为「引擎不可用→回退测试界面」的失败分支）。
 * Activity 生命周期入口（onCreate/onResume/onDestroy/onPageFinished）经 MainActivity 委托调用。
 */
internal class EngineStartFlow(private val activity: MainActivity) {

  private val UI_DEAD_CONFIRMATIONS = 2

  /** Minimum spacing between retries of a failed engine page (see the monitor below). */
  private val ENGINE_PAGE_RELOAD_INTERVAL_MS = 30_000L

  private val flowRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  /** Invalidates stale startup work when the user closes or explicitly restarts the engine. */
  private val flowGeneration = java.util.concurrent.atomic.AtomicLong(0)
  private val updateRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  /** 重启引擎 in-flight 守卫（防连点双杀双启）。 */
  private val engineRestarting = java.util.concurrent.atomic.AtomicBoolean(false)
  /** #118 建议7（2026-09）：启动失败自动重试（最多 2 次，5s/10s 间隔），
   *  失败不永远停在 Error 引导页等手动操作。手动重试（onStartEngine）归零计数。 */
  internal var engineRetryCount = 0

  /** Foreground liveness is deliberately conservative: a slow HTTP response is
   * not proof that the local Node process died. Only consecutive probe misses
   * with a closed local port replace the active WebView with recovery UI. */
  private var engineMonitorFailures = 0
  /** Throttles retries of an engine page that failed while the engine was still booting. */
  private var lastEnginePageReloadAt = 0L
  private val engineMonitorHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val engineMonitorRunnable = object : Runnable {
    override fun run() {
      val monitor = this
      Thread {
        val probe = try { EngineProbe.check(1_500) } catch (_: Exception) { null }
        val httpAlive = probe?.optBoolean("running", false) == true
        val portAlive = EngineProbe.portReachable(500)
        activity.runOnUiThread {
          if (activity.webViewReady && activity.guideViewReady && !activity.userClosedEngine) {
            if (httpAlive || portAlive) {
              engineMonitorFailures = 0
              if (httpAlive) {
                if (activity.guideView.visibility == View.VISIBLE) {
                  activity.showWeb()
                } else if (activity.enginePageFailed &&
                  System.currentTimeMillis() - lastEnginePageReloadAt > ENGINE_PAGE_RELOAD_INTERVAL_MS
                ) {
                  // The engine answered only after the WebView had already shown its
                  // error page (long snapshot refresh): retry that navigation instead
                  // of leaving the user on ERR_CONNECTION_REFUSED.
                  lastEnginePageReloadAt = System.currentTimeMillis()
                  try { activity.webView.reload() } catch (_: Exception) { }
                }
              }
            } else if (activity.webView.visibility == View.VISIBLE) {
              engineMonitorFailures++
              if (engineMonitorFailures >= UI_DEAD_CONFIRMATIONS) {
                activity.applyGuidePhase(GuidePhase.Recovering, "引擎未运行，正在自动恢复…")
                activity.showGuide()
              }
            }
          }
          if (!activity.userClosedEngine) engineMonitorHandler.postDelayed(monitor, 3_000)
        }
      }.start()
    }
  }

  // —— WebView 渲染进程冻结看门狗（2026-08-18，issue #36：荣耀 MagicUI 6.1 /
  // Android 12 仍卡「Loading plugins…」且页面无诊断层 = 渲染进程 JS 主线程冻结，
  // 页面内看门狗定时器也跑不动）。evaluateJavascript 的 JS 在渲染进程执行，App
  // 主线程不受影响：主线程周期发 JS 心跳，回调不再返回即判渲染进程失活 →
  // Toast 提示 + 自动 reload 一次 + 记日志。 ——
  private val freezeHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var jsAckAt = System.currentTimeMillis()
  private var pageLoadedAt = System.currentTimeMillis()
  private var pingOutstanding = false
  private var freezeReloaded = false
  private val freezeRunnable = object : Runnable {
    override fun run() {
      if (!activity.webViewReady || activity.userClosedEngine || activity.webView.visibility != View.VISIBLE) return
      val now = System.currentTimeMillis()
      if (now - pageLoadedAt > 45_000 && now - jsAckAt > 20_000) {
        LogCollector.log("dsh-shell", "webview JS 无响应，渲染进程冻结（frozenMs=" + (now - jsAckAt) + "）")
        try {
          android.widget.Toast.makeText(
            activity, "页面无响应，正在自动刷新…", android.widget.Toast.LENGTH_LONG,
          ).show()
        } catch (_: Exception) {
        }
        if (!freezeReloaded) {
          freezeReloaded = true
          try { activity.webView.reload() } catch (_: Exception) {
          }
        }
        jsAckAt = now
        pingOutstanding = false
      } else if (!pingOutstanding) {
        pingOutstanding = true
        try {
          activity.webView.evaluateJavascript("1") { _ ->
            jsAckAt = System.currentTimeMillis()
            pingOutstanding = false
          }
        } catch (_: Exception) {
          pingOutstanding = false
        }
      }
      freezeHandler.postDelayed(this, 10_000)
    }
  }

  /** onResume 前台引擎监控启动（幂等移除后重投）。 */
  fun startMonitor() {
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    engineMonitorHandler.post(engineMonitorRunnable)
  }

  /** onDestroy 兜底：停止前台监控与页面冻结看门狗。 */
  fun stopMonitoring() {
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
  }

  fun startFreezeWatchdog() {
    if (activity.userClosedEngine || !activity.webViewReady || activity.webView.visibility != View.VISIBLE) return
    val now = System.currentTimeMillis()
    pageLoadedAt = now
    jsAckAt = now
    pingOutstanding = false
    if (freezeHandler.hasCallbacks(freezeRunnable)) freezeHandler.removeCallbacks(freezeRunnable)
    freezeHandler.postDelayed(freezeRunnable, 10_000)
  }

  fun startUpdateCheck() {
    if (!updateRunning.compareAndSet(false, true)) return
    activity.guideRenderer.chrome.updateButton.isEnabled = false
    activity.guideRenderer.chrome.updateButton.alpha = 0.55f
    activity.applyGuidePhase(GuidePhase.Updating, "检查更新…")
    UpdateManager(activity).checkAndApply { status ->
      activity.runOnUiThread {
        val done = status.startsWith("更新完成") || status.startsWith("更新失败")
        activity.applyGuidePhase(
          if (status.startsWith("更新失败")) GuidePhase.Error
          else if (status.startsWith("更新完成")) GuidePhase.Recovering
          else GuidePhase.Updating,
          status,
        )
        if (done) {
          updateRunning.set(false)
          activity.guideRenderer.chrome.updateButton.isEnabled = true
          activity.guideRenderer.chrome.updateButton.alpha = 1f
        }
      }
    }
  }

  /** 开发者选项「关闭」：停止引擎并回退到初始化（启动/测试）界面，不自动重启。 */
  fun shutdownToGuide() {
    activity.userClosedEngine = true
    flowGeneration.incrementAndGet()
    EngineService.userShutdown = true
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    activity.runOnUiThread {
      activity.hideSoftInput()
      activity.applyGuidePhase(GuidePhase.Closed, "引擎已关闭")
      activity.showGuide()
    }
    try { EngineService.instance?.requestShutdown() } catch (_: Exception) {
    }
    try { activity.engineManager.stopEngine() } catch (_: Exception) {
    }
    try { activity.stopService(Intent(activity, EngineService::class.java)) } catch (_: Exception) {
    }
    LogCollector.log("dsh-shell", "harness closed via dev options (shutdownToGuide)")
  }

  /** 引擎启动超时/失败后进入自动回撤流程：UndoGate 幂等，安全多次调用。 */
  private fun maybeAutoUndo(generation: Long) {
    if (activity.userClosedEngine) return
    Thread {
      try {
        // 引擎全死时先决门槛：急救 CLI 存在 + 快照非空 + 幂等窗口
        if (!UndoGate.onProbeFailure(activity, WatchdogV2.consecutiveFailures)) return@Thread
        activity.runOnUiThread {
          activity.applyGuidePhase(GuidePhase.Undoing, "正在执行回撤…", "正在恢复到崩溃前的最后良好快照。")
        }
        val result = UndoGate.execute(activity, activity.engineManager)
        if (result.executed) {
          // 恢复配置文件后重启引擎（冷却窗复位由 UndoGate 完成后置零）
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Recovering, "回撤完成，正在重启引擎…", "已恢复到快照 " + (result.snapshotId ?: "?"))
          }
          activity.engineManager.resetCooldown()
          if (isCurrentEngineFlow(generation)) activity.engineManager.startEngine()
          else EngineService.instance?.let { WatchdogV2.reset() }
        } else {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Error, "自动回撤不可用", result.summary.take(120))
          }
        }
      } catch (t: Throwable) {
        Log.e("dsh-shell", "auto-undo failed", t)
      }
    }.start()
  }

  /** 引擎启动超时（startEngineFlow 轮询失败后调用）：触发自动回撤。 */
  private fun onEngineStartTimeout(generation: Long) {
    // 先给看门狗一次机会：WatchdogV2 熔断阈值(12)远高于此处的保守阈值(6)，
    // 因此本路径只在「启动即失败」时触发；正常慢启动不会到达这里。
    maybeAutoUndo(generation)
  }

  private fun scheduleEngineRetry(generation: Long) {
    if (!isCurrentEngineFlow(generation)) return
    if (engineRetryCount >= 2) return
    engineRetryCount++
    val delayMs = 5_000L * engineRetryCount
    val attempt = engineRetryCount
    activity.runOnUiThread {
      if (!isCurrentEngineFlow(generation)) return@runOnUiThread
      activity.applyGuidePhase(GuidePhase.Starting, "引擎启动失败，${delayMs / 1000}s 后自动重试（第 $attempt/2 次）")
      activity.showGuide()
    }
    engineMonitorHandler.postDelayed({
      if (isCurrentEngineFlow(generation)) start()
    }, delayMs)
  }

  /**
   * Engine-first flow: use an already-running engine (Termux or prior
   * embedded), else extract the embedded snapshot and start the embedded
   * engine, then poll until the web service answers.
   */
  fun start() {
    // onCreate and the following onResume can both request startup. Acquire the
    // flow before mutating lifecycle state so a duplicate cannot invalidate the
    // actual starter.
    if (!flowRunning.compareAndSet(false, true)) return
    val generation = flowGeneration.incrementAndGet()
    activity.userClosedEngine = false
    EngineService.userShutdown = false
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    engineMonitorHandler.post(engineMonitorRunnable)
    Thread {
      try {
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (EngineProbe.check().optBoolean("running", false)) {
        activity.runOnUiThread { if (isCurrentEngineFlow(generation)) activity.showWeb() }
        return@Thread
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      // 启动即有反馈：进入测试界面显示"正在启动引擎…"（不再白屏等 probe）。
      activity.runOnUiThread {
        if (!isCurrentEngineFlow(generation)) return@runOnUiThread
        activity.applyGuidePhase(GuidePhase.Starting, "正在启动引擎…")
        activity.showGuide()
      }
      // Resolve a runtime transaction interrupted by a kill, an OEM cleaner or a
      // low-memory restart before deciding whether the snapshot is current.
      activity.engineManager.recoverInterruptedRefresh()
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (!activity.engineManager.snapshotFresh()) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Extracting, "正在解压运行时")
          activity.guideRenderer.progressText.visibility = View.VISIBLE
          activity.guideRenderer.progressText.text = "准备写入内嵌环境…"
        }
        val ok = activity.engineManager.refreshSnapshot(
          onProgress = { done, _ ->
            activity.runOnUiThread {
              if (!isCurrentEngineFlow(generation)) return@runOnUiThread
              // done 是解压后字节数，total 是压缩包字节数，口径不一致；只显示已解压量。
              val mb = done / 1024 / 1024
              activity.guideRenderer.progressText.visibility = View.VISIBLE
              activity.guideRenderer.progressText.text = "已写入 " + mb + " MB"
              if (activity.guideRenderer.lastGuidePhase != GuidePhase.Extracting) {
                activity.applyGuidePhase(GuidePhase.Extracting, "正在解压运行时")
              }
            }
          },
          onStage = { stage ->
            activity.runOnUiThread {
              if (!isCurrentEngineFlow(generation)) return@runOnUiThread
              activity.applyGuidePhase(GuidePhase.Extracting, "正在更新运行时")
              activity.guideRenderer.progressText.visibility = View.VISIBLE
              activity.guideRenderer.progressText.text = stage
            }
          },
        )
        if (!ok) {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            // 0.13.1 W3：解压失败此前零落盘（engine.log 尚不存在、仅 logcat），镜像现场到共享目录。
            activity.engineManager.mirrorDiagnosticsToShared("snapshot-refresh-failed")
            activity.applyGuidePhase(GuidePhase.Error, "运行时更新失败（诊断包已存至 Documents/dshdata/diagnostics）")
            activity.showGuide()
          }
          return@Thread
        }
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Starting, "正在启动引擎…")
        }
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      // 急救 CLI 随 App 版本部署（内容比对幂等）：下探失败时自动回撤的前置依赖。
      activity.engineManager.deployUndoCli()
      if (!activity.engineManager.startEngine()) {
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, "引擎启动失败")
          activity.showGuide()
        }
        maybeAutoUndo(generation)
        // #118 建议7：失败不清零计数时自动重试（Error 页不再需要手动点重试）。
        scheduleEngineRetry(generation)
        return@Thread
      }
      // Poll for the web service with process-alive semantics (0.13.0 D1): cold boot takes
      // 20-45s (EngineManager START_COOLDOWN_MS comment); the old hard 30s budget fired
      // "引擎启动超时" on slow devices (K20 Pro) even though the engine later started.
      // Now: as long as the engine process is alive we keep waiting (up to 90s); only a dead
      // process declares failure (auto-undo path). UI shows a grey "still starting" state, not an error.
      val pollBudgetMs = 90_000L
      val pollStepMs = 1000L
      val budgetEnd = System.currentTimeMillis() + pollBudgetMs
      var waitedSeconds = 0
      var booted = false
      while (System.currentTimeMillis() < budgetEnd) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        if (EngineProbe.check().optBoolean("running", false)) {
          booted = true
          // 0.13.8 #174：引擎就绪钩子——补投冷启动期间待发的来件通知（拷贝完成时
          // 引擎尚未 listen 的竞态路径；fail-soft，失败留在待发清单等下一轮）。
          try { FileIncoming.flushPending(activity) } catch (_: Throwable) {}
          break
        }
        if (!activity.engineManager.engineProcessAlive()) {
          // 引擎进程已死：宣判失败（自动回退路径），不再空等。
          break
        }
        waitedSeconds = ((budgetEnd - System.currentTimeMillis()) / pollStepMs).toInt()
        if (waitedSeconds % 15 == 0) {
          val s = waitedSeconds
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, "引擎启动中（已等待 ${60 - s}s，冷启动较慢属正常）")
          }
        }
        Thread.sleep(pollStepMs)
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (!booted && !activity.engineManager.engineProcessAlive()) {
        // 0.13.1 W3：进程死亡现场镜像到共享目录（含退出码），用户可直接取包反馈。
        activity.engineManager.mirrorDiagnosticsToShared("engine-died-during-boot")
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, "引擎启动失败（诊断包已存至 Documents/dshdata/diagnostics）")
          activity.showGuide()
        }
        onEngineStartTimeout(generation)
        // #118 建议7：进程死亡路径同样自动重试（可自愈的瞬时失败不必停在错误页）。
        scheduleEngineRetry(generation)
        return@Thread
      }
      if (booted) {
        startEngineService()
        applyShizukuKeepAlive()
        activity.runOnUiThread { if (isCurrentEngineFlow(generation)) activity.showWeb() }
      } else {
        // 进程还活着但 90s 内未就绪（异常慢）：灰色提示而非红色错误，不触发回退——
        // 引擎仍在启动，3s engineMonitorRunnable 会兜底切界面。
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Starting, "引擎启动较慢（已超过 90s），仍在后台启动中…")
        }
      }
      return@Thread
      } finally {
        flowRunning.set(false)
      }
    }.start()
  }

  /** True only for the active startup request and while the user has not closed it. */
  private fun isCurrentEngineFlow(generation: Long): Boolean =
    !activity.userClosedEngine && flowGeneration.get() == generation

  /** Run the runtime snapshot update; status mirrored to a file for adb verification. */
  fun runUpdate() {
    val statusFile = File(activity.filesDir, "update-status.txt")
    val manager = UpdateManager(activity)
    manager.checkAndApply { status ->
      activity.runOnUiThread {
        val phase = when {
          status.startsWith("更新失败") -> GuidePhase.Error
          status.startsWith("更新完成") -> GuidePhase.Recovering
          else -> GuidePhase.Updating
        }
        activity.applyGuidePhase(phase, status)
        activity.showGuide()
      }
      try {
        statusFile.appendText(status + "\n")
      } catch (_: Exception) {
      }
    }
  }

  /** Start the foreground service (engine keep-alive + watchdog). */
  fun startEngineService() {
    try {
      activity.startForegroundService(Intent(activity, EngineService::class.java))
    } catch (_: Exception) {
      // Foreground-service start limits: service will start on next launch.
    }
  }

  /** Best-effort Shizuku keep-alive boost; outcome logged only. */
  private fun applyShizukuKeepAlive() {
    try {
      Thread {
        val result = ShizukuSupport.status(activity)
        Log.i("dsh-shizuku", result)
      }.start()
    } catch (_: Throwable) {
    }
  }

  /**
   * 重启引擎服务进程（设置界面「重启引擎」）：pkill 引擎 → 重置冷却与
   * 流程守卫 → 1s 后重新走启动流程（EngineService 看门狗亦会拉起，
   * 进程级 CAS + 冷却保证双路径幂等）。防连点：in-flight 守卫。
   */
  fun restart() {
    if (!engineRestarting.compareAndSet(false, true)) return
    activity.userClosedEngine = false
    flowGeneration.incrementAndGet()
    EngineService.userShutdown = false
    Thread {
      try {
        try {
          Runtime.getRuntime().exec(arrayOf("/system/bin/pkill", "-f", "bin.js")).waitFor()
        } catch (_: Throwable) {
        }
        EngineManager.lastStartAttemptAt = 0
        flowRunning.set(false)
        LogCollector.log("dsh-shell", "restart engine requested (pkill)")
        Thread.sleep(1000)
        activity.runOnUiThread {
          activity.showTestNotification("引擎重启中", "引擎进程已结束，正在重新启动…")
          start()
        }
      } finally {
        engineRestarting.set(false)
      }
    }.start()
  }
}
