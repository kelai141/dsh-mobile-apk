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

  /**
   * 块L：boot 卡住诊断（页面停在 loading 但引擎健康）——记录已进入诊断态，避免每 tick 重复落盘。
   */
  @Volatile private var bootStallReported = false
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
                // C1：本 tick 拿到了真实 HTTP 应答。这条路径覆盖「引擎由看门狗/服务拉起」的世代——
                // 否则那些世代只有 t_listen（TCP）而没有首个响应读数，C1 在门禁里会被判 SKIP 而非判绿。
                LogCollector.markFirstHttp(activity)
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
    startBootStallWatchdog()
  }

  // ── 块L：boot 卡住诊断（「engineHttp=200 却一直 loading」可诊断）────────────
  //
  // 为什么需要：诊断屏那组 `pendingBundles:[] badBundles:[] engineHttp:200` 与「卡住」**不矛盾**
  // （详档 §2.2 三个盲区）——它的谓词结构上报不出「加载成功但插件挂住」。真因只能来自页面侧运行时
  // 装配状态。壳侧能提供的是：① 在页面迟迟不就绪而**引擎健康**时，把现场落盘（run-as 可取，
  // 不依赖调试采集器开关）；② 显式标注「页面侧运行时状态从壳侧不可得」，**绝不留空数组**
  // （空数组正是本次误导的根源，详档 §6.2 硬约束 1）。
  //
  // **L-1 缺陷修复（0.14.1）**：本判据此前用 `activity.webViewReady` 当「页面未就绪」，而它等价于
  // `::webView.isInitialized`——**字段一初始化即恒真**，与页面是否渲染完成毫无关系。后果是设备上
  // 一次**健康启动**被误报 7 条（`boot-diag.log` 7 行 `source=shell-stall`、`engineHttp=ok` 全成立、
  // `stalledMs≈40s`；同 epoch `boot-segments.log` 有 `note=first-http`），且同一 epoch 报了两行
  // （`resetBootStall()` 挂在 `startFreezeWatchdog`，而后者由 `onPageFinished` 调用——页面加载完复位
  // 计时，再过 40s 又报一次）。
  //
  // 真信号只能是**页面自己报的「已渲染」**：页面侧在结果性判据首次为真时打 `[dsh-boot-ready]`
  // （dsh-host-web-compat/lib/index.js 的 readyWatch），壳侧 onConsoleMessage 收到即置
  // [pageReadyReported] 并**永久停止**本 epoch 的 stall 计时。页面没报 ⇒ 才可能是真卡住。
  private var bootStallStartAt = System.currentTimeMillis()

  /**
   * 本 epoch 页面是否已自报就绪（L-1 判据）。只由页面侧 `[dsh-boot-ready]` 置真——
   * 不得由 `onPageFinished`/`webViewReady` 之类「文档级」信号置真（那正是被误报的旧判据）。
   */
  @Volatile private var pageReadyReported = false

  /** 本 epoch 是否已为「页面就绪」落过诊断行（避免每 tick 重复）。 */
  @Volatile private var pageReadyLogged = false
  private val bootStallHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val bootStallRunnable = object : Runnable {
    override fun run() {
      try {
        val stalledMs = System.currentTimeMillis() - bootStallStartAt
        // 判据三合一：①页面**未**自报就绪（真信号）；②该 epoch 未报过；③页面可见、未被用户关闭、
        // 且不是「页面加载本身已失败」（后者有自己的恢复路径，不该再记成 stall）。
        // 引擎健康与否由后台探活复核（下方），避免「引擎没起来」被误记成「页面卡住」。
        if (stalledMs >= LogCollector.BOOT_STALL_WINDOW_MS && !pageReadyReported &&
          !activity.userClosedEngine && activity.webView.visibility == View.VISIBLE &&
          !activity.enginePageFailed && !bootStallReported
        ) {
          bootStallReported = true
          val stalled = stalledMs
          Thread {
            val probe = try { EngineProbe.check(1_500) } catch (_: Throwable) { null }
            if (probe?.optBoolean("running", false) != true) {
              // 引擎确实没起来：这不是「页面侧卡住」，撤销本轮上报标记，交给既有引擎失败路径。
              bootStallReported = false
              return@Thread
            }
            // 页面仍未就绪且引擎健康 ⇒ 这才是真卡住。pageReadyReported 必须再查一次
            // （后台线程可能已收到 ready；竞态下宁可少报也不少报——误报正是本次要修的缺陷）。
            if (pageReadyReported) { bootStallReported = false; return@Thread }
            val detail = "stalledMs=" + stalled +
              " engineHttp=ok pageReady=false pageClosed=false" +
              " hint=page-side-fiber-state-unavailable-from-shell"
            LogCollector.writeBootDiag(
              activity, "shell-stall", detail,
              pageSideRuntime = LogCollector.PAGE_RUNTIME_UNAVAILABLE,
            )
            LogCollector.log("dsh-shell", "boot stalled with healthy engine (stalledMs=" + stalled + ")")
          }.apply { isDaemon = true; name = "dsh-boot-stall-probe" }.start()
        }
      } catch (_: Throwable) {
        // 诊断本身不得成为故障源。
      }
      bootStallHandler.postDelayed(this, 5_000)
    }
  }

  /**
   * 页面自报**就绪**（L-1 判据真源）：由 MainActivity 的 onConsoleMessage 在收到
   * `[dsh-boot-ready]` 时调用。
   *
   * 幂等：同一 epoch 只落一次 page-ready 诊断行（便于设备侧确认「页面确实报过就绪」），
   * 但**置位本身是永久的**——一旦页面就绪，本 epoch 不再有 stall 判定。
   */
  fun onPageReadyReported(rawLine: String) {
    pageReadyReported = true
    if (pageReadyLogged) return
    pageReadyLogged = true
    // 页面自报的就绪行本身带上 waitedMs，落到 page-console 便于与 shell-stall 对照。
    LogCollector.writeBootDiag(
      activity, "page-console", "phase=page-ready " + rawLine.replace('\n', ' '),
      pageSideRuntime = "reported-by-page",
    )
    LogCollector.log("dsh-shell", "page reported boot-ready")
  }

  /**
   * 页面自报**卡住**（L-2 载荷）：由 onConsoleMessage 在收到 `[dsh-boot-stall]` 时调用。
   * 载荷里带 pendingEntries/failedEntries/graphLoaded/waitingForMs 四字段（页面侧运行时真值），
   * 直接落 pageSideRuntime（不再是 unavailable）。
   */
  fun onPageStallReported(rawLine: String) {
    try {
      val runtime = extractPageSideRuntime(rawLine)
      LogCollector.writeBootDiag(
        activity, "page-console", rawLine.replace('\n', ' '),
        pageSideRuntime = runtime,
      )
    } catch (_: Throwable) {
      // 落盘失败不得成为故障源。
    }
  }

  /** 页面就绪/失败时复位（重新计时 + 允许再次上报）。 */
  fun resetBootStall() {
    bootStallStartAt = System.currentTimeMillis()
    bootStallReported = false
    // 新 epoch：页面的就绪声明随之作废，必须由页面重新报（否则复位后永远不会报卡住 = 丧失去判别力）。
    pageReadyReported = false
    pageReadyLogged = false
  }

  /**
   * 从页面自报行里取出 `pageSideRuntime=<值>`（L-2：该值即 §6.2 四字段的 JSON）。
   *
   * 为什么不做 JSON 解析：壳侧只需要**原样透传**给落盘（解析再序列化只会多一处两侧格式
   * 对不上的机会，且四字段的值可能含 unavailable 字符串）。取值按 `pageSideRuntime=` 到
   * 下一个顶层 ` detail=` 之间截取——页面侧保证这几个字段间无空格（折叠后仍是单行）。
   * 取不到返回 [LogCollector.PAGE_RUNTIME_UNAVAILABLE]（绝不臆造）。
   */
  internal fun extractPageSideRuntime(rawLine: String): String {
    val text = rawLine ?: return LogCollector.PAGE_RUNTIME_UNAVAILABLE
    val key = "pageSideRuntime="
    val at = text.indexOf(key)
    if (at < 0) return LogCollector.PAGE_RUNTIME_UNAVAILABLE
    val rest = text.substring(at + key.length)
    val end = rest.indexOf(" detail=")
    val value = (if (end < 0) rest else rest.substring(0, end)).trim()
    return if (value.isEmpty()) LogCollector.PAGE_RUNTIME_UNAVAILABLE else value
  }

  private fun startBootStallWatchdog() {
    bootStallHandler.removeCallbacks(bootStallRunnable)
    bootStallHandler.postDelayed(bootStallRunnable, 5_000)
  }

  /** onDestroy 兜底：停止前台监控与页面冻结看门狗。 */
  fun stopMonitoring() {
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    bootStallHandler.removeCallbacks(bootStallRunnable)
  }

  fun startFreezeWatchdog() {
    if (activity.userClosedEngine || !activity.webViewReady || activity.webView.visibility != View.VISIBLE) return
    val now = System.currentTimeMillis()
    pageLoadedAt = now
    jsAckAt = now
    pingOutstanding = false
    // **不要**在这里 resetBootStall()：本函数由 onPageFinished 调用，而 onPageFinished 只代表
    // **文档加载完**，不代表页面渲染完/插件装配完。此前在这里复位 → 页面加载完重新计时 →
    // 再过 40s 又报一次，同一 epoch 落两行（L-1 的重复报根因）。
    // 现在 boot-stall 的 epoch 只由真正的世代切换（start()/restart 路径）与页面自报就绪驱动。
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
    EngineService.setUserShutdown(activity, true)
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
        // 引擎全死时先决门槛：急救 CLI 存在 + 快照非空 + 幂等窗口。
        // 0.14.1：阈值必须用 effectiveFailureCount（半死与 DEAD 共用计数），与看门狗侧
        // EngineService.kt 的 undoReady 同口径。旧实现只读 consecutiveFailures —— 而该计数在
        // DEGRADED_HTTP（端口可连、HTTP 持续失败）下恒被清零，于是「半死引擎」在这条路径上
        // 永远达不到阈值，自动回撤静默不可达（与 planTick 的熔断锁存同族盲区）。
        // DEAD 路径不受影响：DEAD 下 consecutiveDegradedHttp 恒 0，两个计数相等。
        if (!UndoGate.onProbeFailure(activity, WatchdogV2.effectiveFailureCount())) return@Thread
        activity.runOnUiThread {
          activity.applyGuidePhase(GuidePhase.Undoing, "正在执行回撤…", "正在恢复到崩溃前的最后良好快照。")
        }
        val result = UndoGate.execute(activity, activity.engineManager)
        if (result.executed) {
          // 恢复配置文件后重启引擎（冷却窗复位由 UndoGate 完成后置零）。
          // 0.14.1：undo 成功即解除熔断锁存（与 EngineService 的 UNDO 分支同口径）——tripped 一旦
          // 为真即永久 HOLD，若此处不复位，回撤后重启的世代会被上一次的失败计数白白锁住。
          WatchdogV2.reset()
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Recovering, "回撤完成，正在重启引擎…", "已恢复到快照 " + (result.snapshotId ?: "?"))
          }
          activity.engineManager.resetCooldown()
          if (isCurrentEngineFlow(generation)) activity.engineManager.startEngine()
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
    // 新启动世代 = boot-stall 的新 epoch：在此复位（**不在** onPageFinished。
    // onPageFinished 只代表文档加载完，在那里复位会造成同 epoch 重复报，见 L-1）。
    resetBootStall()
    activity.userClosedEngine = false
    EngineService.setUserShutdown(activity, false)
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    engineMonitorHandler.post(engineMonitorRunnable)
    Thread {
      try {
      if (!isCurrentEngineFlow(generation)) return@Thread
      // FX-210.1（源文档 §3.3 B1 顺序约束）：恢复入口是「服务路径与 Activity 路径」的
      // 共同前置——引擎已被前台服务拉起时重开 app 也要消费 .snapshot-transaction 判据，
      // 因此它必须排在「引擎已在跑」早退之前（顺序由 startupRecoverThenProbe 保证）。
      val engineAlreadyRunning = startupRecoverThenProbe(
        recover = { activity.engineManager.recoverInterruptedRefresh() },
        probeRunning = { EngineProbe.check().optBoolean("running", false) },
      )
      if (engineAlreadyRunning) {
        // P-AC-04：这条早退路径不经过 spawn 观察线程，补一次 listen 标记（幂等；本进程没记过
        // t_boot_start 时按「未知」记 -1 落盘，而不是让三字段整行缺失）。
        LogCollector.markListen(activity)
        // C1：探活已经拿到 HTTP 应答（engineAlreadyRunning 来自 EngineProbe.check().running），
        // 所以首个响应时刻同样可判——否则「进程内接手已在跑的引擎」这一路径永远没有 C1 读数。
        LogCollector.markFirstHttp(activity)
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
      // 中断事务已由启动前置（startupRecoverThenProbe）恢复——此处只做新鲜度判定。
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
          // 任务 19：失败终态落盘（快照解压失败是「启动起不来」的已知成因之一）。
          // 【0.14.1 升级路径 P0】必须带上**真因**：`refreshSnapshot` 只回布尔值，真因挂在
          // `EngineManager.lastRefreshFailure`。旧实现此处不传 error → boot-fail.log 只有
          // `error=none(boolean-failure-path)`，排障者拿不到 `Directory not empty` 那条真因。
          val refreshCause = activity.engineManager.lastRefreshFailure
          LogCollector.writeBootFail(
            activity, "snapshot-refresh-failed",
            "内嵌运行时快照解压/写入失败（refreshSnapshot 返回 false）"
              + (refreshCause?.let { " cause=" + it.javaClass.name + ": " + (it.message ?: "无消息") } ?: ""),
            refreshCause,
          )
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            // 0.13.1 W3：解压失败此前零落盘（engine.log 尚不存在、仅 logcat），镜像现场到共享目录。
            // review C5：文案按**实际落点**回填（共享不可写时回落私有目录，不再写死 Documents 路径）。
            val dir = activity.engineManager.mirrorDiagnosticsToShared("snapshot-refresh-failed")
            activity.applyGuidePhase(GuidePhase.Error, "运行时更新失败（" + diagnosticsLocationHint(dir) + "）")
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
        // 任务 19：失败终态落盘（此前这条路径**零落盘**——用户反馈第一条的真因）。
        LogCollector.writeBootFail(
          activity, "engine-start-false",
          "EngineManager.startEngine() 返回 false（未能拉起引擎进程）",
        )
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
      // Now: as long as the engine process is alive we keep waiting (up to the budget); only a
      // dead process declares failure (auto-undo path). UI shows a grey "still starting" state.
      // FX-212.2（E-9）：预算与文案只许有一个来源——ENGINE_BOOT_BUDGET_MS。旧实现把预算改到
      // 90s 却把文案硬编码成 60 - s，首帧即显示「已等待 -30s」；本处不再出现任何字面量秒数。
      val pollBudgetMs = ENGINE_BOOT_BUDGET_MS
      val pollStepMs = ENGINE_BOOT_POLL_STEP_MS
      val budgetEnd = System.currentTimeMillis() + pollBudgetMs
      var booted = false
      while (System.currentTimeMillis() < budgetEnd) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        if (EngineProbe.check().optBoolean("running", false)) {
          booted = true
          // P-AC-04：主路径的 listen 标记（watchEngineListen 线程为主，这里兜底；幂等）。
          LogCollector.markListen(activity)
          // C1（0.14.1 块F）：**首个 HTTP 响应**。上面这次 EngineProbe.check() 真正拿到了 HTTP 应答
          // （running=true 只在响应码 200/401/303 时成立，见 EngineProbe.check 的判据），这正是 C1
          // 要的「首个 HTTP 响应」而不是 TCP LISTEN。与 t_listen 分开记，使「LISTEN 快、首个响应慢」
          // 这条已验证的假绿路径可被门禁在同一行上同时断言（详档 §5.1 C1）。幂等。
          LogCollector.markFirstHttp(activity)
          // 0.13.8 #174：引擎就绪钩子——补投冷启动期间待发的来件通知（拷贝完成时
          // 引擎尚未 listen 的竞态路径；fail-soft，失败留在待发清单等下一轮）。
          try { FileIncoming.flushPending(activity) } catch (_: Throwable) {}
          break
        }
        if (!activity.engineManager.engineProcessAlive()) {
          // 引擎进程已死：宣判失败（自动回退路径），不再空等。
          break
        }
        val clock = engineBootClock(pollBudgetMs - (budgetEnd - System.currentTimeMillis()))
        if (engineBootShouldReport(clock.waitedSeconds)) {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, engineBootProgressText(clock))
          }
        }
        Thread.sleep(pollStepMs)
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (!booted && !activity.engineManager.engineProcessAlive()) {
        // 任务 19：失败终态落盘。这条路径是设备实测里最密集的失败形态（44 次 t_listen=-1 中
        // 多数是引擎进程死亡），必须留下「当时配置指纹 + 引擎日志状态 + 退出码」。
        //
        // **为什么失败的启动常常「连 engine.log 都没输出」**（用户反馈要求排查的项）：
        // 引擎子进程的 stdout/stderr **并没有被丢弃**——`EngineManager.startWithArgs` 里
        // `redirectErrorStream(true)` + `redirectOutput(engine.log)`，两者都进同一个文件。
        // 于是「engine.log 为空」只有三种成因，本条诊断把它们全部记下来以便区分：
        //   ① spawn 从未成功（进程没起来）→ 文件可能不存在，或大小为 0；
        //   ② 进程瞬间退出且一句都没来得及写（native 崩溃 / 缺 so / 动态链接失败）；
        //   ③ 旋转把本次输出滚进了 engine.log.1..5（rotateEngineLog 保留 5 代）。
        // 故这里把 engine.log 各世代大小一并落盘——「日志到底在不在」本身就是判据。
        // （退出码由既有 mirrorDiagnosticsToShared 的诊断包承载；EngineManager 不在本任务写面内，
        //   故不在壳侧另取一份。）
        LogCollector.writeBootFail(
          activity, "process-died-during-boot",
          "引擎进程在 " + ENGINE_BOOT_BUDGET_MS / 1000 + "s 预算内死亡且 Web 端口未就绪（t_listen=-1 形态）；" +
            LogCollector.describeEngineLogState(activity.filesDir),
        )
        // 0.13.1 W3：进程死亡现场镜像到共享目录（含退出码），用户可直接取包反馈。
        // review C5：文案按实际落点回填（共享不可写时回落私有目录）。
        val dir = activity.engineManager.mirrorDiagnosticsToShared("engine-died-during-boot")
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, "引擎启动失败（" + diagnosticsLocationHint(dir) + "）")
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
        // 0.13.8 #175：终点不再「只提示」——安排一次自动重试（DEGRADED_HTTP 阶梯随后
        // 兜底：若 HTTP 持续失败而端口可连，看门狗会受控重启，不再永久停留灰字）。
        // 任务 19：这条路径正是设备实测「44 次 boot-start 未到 listen」的形态之一——
        // 它此前**只写一行 log 且不落盘**（log 只在调试采集器开启时才写），必须进失败终态。
        LogCollector.writeBootFail(
          activity, "boot-budget-exceeded",
          "引擎进程存活但 " + ENGINE_BOOT_BUDGET_MS / 1000 + "s 预算内 Web 端口未就绪（t_listen=-1 形态）",
        )
        LogCollector.log("dsh-shell", "engine boot window exceeded 90s; scheduling retry (half-dead ladder will take over if HTTP stays failing)")
        scheduleEngineRetry(generation)
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Starting, "引擎启动较慢（已超过 90s），已安排自动重试…")
        }
      }
      return@Thread
      } catch (t: Throwable) {
        // **任务 19 的根因之一（关键）**：本 try **此前没有 catch**（只有 finally），于是启动线程里
        // 任何异常（NoSuchMethodError / OOM / 空指针等）都被抛到线程默认处理器——**壳侧零落盘**，
        // logcat 里也可能什么都没有。这正是用户反馈「启动失败时几乎不留任何诊断日志」的直接成因：
        // 不是日志被丢弃，而是**根本没有接住异常**。
        // 现在：异常类名 + 完整栈进 boot-fail.log，并同步 Log.e（双通道，logcat 与文件都能查）。
        LogCollector.writeBootFail(
          activity, "start-flow-exception",
          "启动线程抛出未捕获异常（此前该路径零落盘）",
          t,
        )
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, "引擎启动失败")
          activity.showGuide()
        }
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
    EngineService.setUserShutdown(activity, false)
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

/**
 * 诊断包落点的用户可见文案（review C5）：按**实际**镜像结果回填，绝不写死共享目录路径——
 * 未授权 All Files Access 的设备（issue #228 环境）会回落应用私有目录，用户按 Documents 路径找不到现场。
 */
internal fun diagnosticsLocationHint(dir: java.io.File?): String =
  if (dir == null) "诊断包落盘失败（共享与私有目录均不可写）" else "诊断包已存至 " + dir.absolutePath

/**
 * 启动前置（FX-210.1，JVM 单测的顺序契约）：先执行恢复入口，再做探活分流。
 * 缺陷形态：探活命中「引擎已在跑」即 return@Thread，事务恢复（applyRecovery）被跳过——
 * 引擎由前台服务拉起后重开 app 时，.snapshot-transaction 判据永不消费。把这一步抽成
 * 函数是为了让「恢复先于早退」成为可断言的顺序，而不是散落在流程里的两行语句。
 *
 * @return 探活结果（true = 引擎已在跑，调用方走早退分支）。
 */
internal fun startupRecoverThenProbe(recover: () -> Unit, probeRunning: () -> Boolean): Boolean {
  recover()
  return probeRunning()
}

// ── FX-212.2：启动轮询预算与引导页倒计时文案的同一真源 ────────────────────────
//
// 缺陷形态（F-212.2 / E-9）：预算从 30s 提到 90s 时只改了轮询常量，文案仍写死 `60 - s`
// （s = 剩余秒）——首帧显示「已等待 -30s」，此后每一帧恒偏 30s；把 60 改成 90 而仍留两处
// 独立常量的做法同样判未修复。这里把预算、步进、上报节拍、文案全部收进同一组符号：
// [EngineBootClock] 的两个读数互补（waited + remaining = budget），文案只由它派生。

/** 冷启动轮询预算（毫秒）——轮询与文案的**唯一**来源。 */
internal const val ENGINE_BOOT_BUDGET_MS = 90_000L

/** 轮询步进（毫秒）。 */
internal const val ENGINE_BOOT_POLL_STEP_MS = 1_000L

/** 文案上报间隔（秒）：每 15s 一帧（首帧 waited=0 立即上报，恒无负值）。 */
internal const val ENGINE_BOOT_REPORT_STEP_S = 15

/**
 * 同一毫秒输入派生的双读数：已等待 / 剩余**互补**（二者相加恒为预算秒数）。
 * 单侧钳制到 [0, budget]，因此任何输入（含超预算、负值）都不会派生负数文案。
 */
internal class EngineBootClock(elapsedMs: Long, budgetMs: Long) {
  val budgetSeconds: Int = (budgetMs / 1_000L).toInt()
  val waitedSeconds: Int = (elapsedMs.coerceIn(0L, budgetMs) / 1_000L).toInt()
  val remainingSeconds: Int = budgetSeconds - waitedSeconds
}

/** 默认预算 = [ENGINE_BOOT_BUDGET_MS]（调用点不得再传字面量秒数）。 */
internal fun engineBootClock(elapsedMs: Long, budgetMs: Long = ENGINE_BOOT_BUDGET_MS): EngineBootClock =
  EngineBootClock(elapsedMs, budgetMs)

/** 引导页启动中文案（唯一生成点）：显示值与真实已等**同源**。 */
internal fun engineBootProgressText(clock: EngineBootClock): String =
  "引擎启动中（已等待 ${clock.waitedSeconds}s / 剩余 ${clock.remainingSeconds}s，冷启动较慢属正常）"

/** 上报节流：每 [ENGINE_BOOT_REPORT_STEP_S] 秒一帧。 */
internal fun engineBootShouldReport(waitedSeconds: Int, stepSeconds: Int = ENGINE_BOOT_REPORT_STEP_S): Boolean =
  waitedSeconds % stepSeconds == 0
