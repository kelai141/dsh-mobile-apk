package com.dsharnessmobile.shell

import android.content.Intent
import android.os.SystemClock
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
                  // 0.14.1 D3：恢复动作（reload）失败此前**完全静默**——用户继续停在
                  // ERR_CONNECTION_REFUSED 上，而现场没有任何一行说明「我们试过重载但没成功」。
                  // 吞掉无害清理可以，吞掉用户正在等的那个恢复动作不行。
                  try {
                    activity.webView.reload()
                  } catch (e: Exception) {
                    Log.w("dsh-shell", "engine page reload failed", e)
                  }
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
          // 0.14.1 D3：与上面的引擎页重载同族——冻结自愈的唯一动作失败时必须留下痕迹，
          // 否则日志里只有「检测到冻结」，看不出「自愈没生效」。
          try {
            activity.webView.reload()
          } catch (e: Exception) {
            Log.w("dsh-shell", "freeze recovery reload failed", e)
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
    UpdateManager(activity).checkAndApply { st ->
      activity.runOnUiThread {
        // 相位由**类型**决定（0.14.1 批 2 / P0-2）：旧实现按字符串前缀猜，于是「本版没配发布源」
        // 被当失败渲染成满屏红字，而那串错误里写着 overrideManifestUrl（只存在于代码里的名字）。
        // 现在 NotConfigured 走 Info（中性事实 + 下一步），只有真正的失败才是红。
        //
        // 但**不可打断的相位**（首启解压/启动/回滚）进行中不许抢占状态行：那时用户正盯着一件
        // 不能中断的事，旁路结果只写 hint（设备实测：解压到 686MB 时点「检查更新」会把进度顶掉）。
        val locked = activity.guideRenderer.phaseLocked()
        val phase = when (st.outcome) {
          UpdateManager.UpdateOutcome.NotConfigured -> GuidePhase.Info
          UpdateManager.UpdateOutcome.Failed -> GuidePhase.Error
          UpdateManager.UpdateOutcome.Done -> GuidePhase.Recovering
          UpdateManager.UpdateOutcome.Working -> GuidePhase.Updating
        }
        if (locked) {
          activity.guideRenderer.applyGuideHint(
            if (phase == GuidePhase.Error) st.text else st.text + "（当前动作不受影响）",
          )
        } else {
          activity.applyGuidePhase(
            phase,
            if (phase == GuidePhase.Error) "更新失败" else st.text,
            if (phase == GuidePhase.Error) st.text.removePrefix("更新失败：") else null,
          )
        }
        if (st.outcome != UpdateManager.UpdateOutcome.Working) {
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
            // P3-6：快照 id 不上屏（用户看不懂也做不了什么）——正文说清「回到哪个状态 + 接下来会怎样」，
            // id 进日志供排查。
            LogCollector.log("dsh-guide", "undo applied snapshot=" + (result.snapshotId ?: "?"))
            activity.applyGuidePhase(GuidePhase.Recovering, "回撤完成，正在重启引擎…", "已恢复到上一次可用的运行时状态。")
          }
          activity.engineManager.resetCooldown()
          if (isCurrentEngineFlow(generation)) activity.engineManager.startEngine()
        } else {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Error, "自动回撤不可用", undoUnavailableHint(result.summary))
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
        recover = {
          activity.engineManager.recoverInterruptedRefresh()
          // 0.14.2-fx-2 缺口：恢复期**拒绝回滚**此前只有 logcat/诊断面，没有任何界面提示，
          // 用户数据被保护了却不知情。这里落结构化码 + 一次性标记 + 诊断包；可见面由
          // MainActivity 在引擎页面就绪后注入 DOM（引导页会被 showWeb 盖掉，故不切引导页相位）。
          // 不阻断启动：恢复失败只意味着「这棵树还没收敛」，引擎仍可能正常起。
          reportRecoveryRejectionIfAny(activity, activity.engineManager.pendingRecoveryFailure)
        },
        // Health `running` intentionally includes arbitrary 401s for watchdog semantics; startup
        // early-exit needs ownership proof and must not treat an unrelated local listener as ours.
        probeRunning = {
          val ownership = activity.engineManager.probeAvailability()
          ownership == EngineProbe.EngineAvailability.OUR_PROCESS ||
            ownership == EngineProbe.EngineAvailability.OUR_HTTP
        },
      )
      if (engineAlreadyRunning) {
        // P-AC-04：这条早退路径不经过 spawn 观察线程，补一次 listen 标记（幂等；本进程没记过
        // t_boot_start 时按「未知」记 -1 落盘，而不是让三字段整行缺失）。
        LogCollector.markListen(activity)
        // C1：探活已经拿到 HTTP 应答（engineAlreadyRunning 覆盖 running 或 401=可认证，见 probeRunning）；
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
        // 0.14.1 D2（issue #240 建议 2）：**降级闸门**。同一份快照上刷新已连续失败达阈、
        // 且 live 运行时完整时，不再自动重跑那一次注定失败的刷新——以可用态启动，并显式留档。
        //
        // 为什么判据是 live 完整性而不是失败次数：refresh 失败的常见真因是快照缺失/解压不全，
        // 那种情况下「放行」等于拉起一棵不完整的运行时（以「引擎能起但插件缺」的形态静默劣化），
        // 比拦在引导页更坏。issue 现场的真正特征是 live 完整可用、缺的只是提交文件。
        // 出口：换快照（App 升级 → fingerprint 变 → 账本自然失配）或用户手动点「重试」
        // （GuidePageRenderer 的 onStartEngine 会 clearRefreshLedger，见那里）。
        if (activity.engineManager.shouldDegradeRefresh()) {
          LogCollector.writeBootFail(
            activity, "snapshot-refresh-degraded",
            "自动刷新连续失败达阈且 live 运行时完整：跳过本次自动刷新，以现有运行时启动"
              + "（手动点「重试」可强制再刷一次；升级到新快照后本闸门自然失效）",
          )
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, "运行时更新未完成，正以现有运行时启动…")
            activity.guideRenderer.progressText.visibility = View.GONE
          }
        } else {
          if (!isCurrentEngineFlow(generation)) return@Thread
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Extracting, "正在解压运行时")
            activity.guideRenderer.progressText.visibility = View.VISIBLE
            activity.guideRenderer.progressText.text = "准备写入内嵌环境…"
          }
          // 0.14.2 FX1-A：轮换改由**时间**驱动。旧实现在 onProgress 里 tick++，而回调频率 = 解压进度
          // 回调频率（SnapshotExtractor 每 1MB 一次，2.5GB 约 2500 次、间隔数十毫秒），
          // 于是文案以毫秒级频率换句 -> 用户现场「一直在闪」。
          // 本次刷新开始前复位一次，使第一句立刻可见、时间窗从此刻起算。
          activity.guideRenderer.resetRuntimeStageRotation()
          val ok = activity.engineManager.refreshSnapshot(
            onProgress = { _, _ ->
              activity.runOnUiThread {
                if (!isCurrentEngineFlow(generation)) return@runOnUiThread
                // 0.14.2 P2：**不再印任何数字**。旧实现用编造的 700MB 当分母拼
                // 「已写入 1157 MB / 约 700 MB（99%）」（分子大于分母还报 99%）——真因是分母凭空
                // 造的，而真实解压是增量的（含磁盘上已有数据）。现在只推进阶段车轱辘话，
                // 进度条恒为不确定态。回调里的 done/total 仍然收下（接口未变），但不再渲染。
                if (activity.guideRenderer.lastGuidePhase != GuidePhase.Extracting) {
                  activity.applyGuidePhase(GuidePhase.Extracting, "正在解压运行时")
                }
                // 时间戳取自单调时钟：回调频率再高，闸门也只按 1.3s 的窗放行（同一窗内只刷可见性）。
                activity.guideRenderer.showRuntimeStage(SystemClock.elapsedRealtime())
              }
            },
            onStage = { stage ->
              activity.runOnUiThread {
                if (!isCurrentEngineFlow(generation)) return@runOnUiThread
                activity.applyGuidePhase(GuidePhase.Extracting, "正在更新运行时")
                // stage 是 EngineManager 的阶段句（「正在解压运行时…」「正在恢复用户数据…」等），
                // 本身就是无数字的车轱辘话，直接沿用——不为它另造一套文案，避免两份口径漂移。
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
            // issue #271 ④：再带上**稳定错误码**（由 SnapshotFsException.code 归类，如
            // snapshot-delete-residue / snapshot-move-blocked / snapshot-foreign-owner）。
            // 有了码，boot-fail.log 的一行就说清「是哪一类失败」，不必翻栈。
            val refreshCause = activity.engineManager.lastRefreshFailure
            val refreshCode = activity.engineManager.lastRefreshFailureCode ?: "snapshot-refresh-failed"
            LogCollector.writeBootFail(
              activity, refreshCode,
              "内嵌运行时快照解压/写入失败（refreshSnapshot 返回 false，code=" + refreshCode + "）"
                + (refreshCause?.let { " cause=" + it.javaClass.name + ": " + (it.message ?: "无消息") } ?: ""),
              refreshCause,
            )
            activity.runOnUiThread {
              if (!isCurrentEngineFlow(generation)) return@runOnUiThread
              // 0.13.1 W3：解压失败此前零落盘（engine.log 尚不存在、仅 logcat），镜像现场到共享目录。
              // review C5：文案按**实际落点**回填（共享不可写时回落私有目录，不再写死 Documents 路径）。
              val dir = activity.engineManager.mirrorDiagnosticsToShared("snapshot-refresh-failed")
              // S1-5：**诊断包路径不进标题**。旧实现把 `diagnosticsLocationHint(dir)`
              // （「诊断包已存至 /storage/emulated/0/Documents/dshdata/diagnostics/...」）拼进
              // 18sp 的标题里，在窄屏上把标题撑成三行，而真正该一眼看到的是「失败了」。
              // 现在标题只说事实，路径挪到 13sp 的副文案里（可换行，且不抢视觉重心）。
              activity.applyGuidePhase(
                GuidePhase.Error,
                "运行时更新失败",
                // 缺陷 D（fx-2）：这两个显式 hint 会**覆盖** defaultHint，所以安全模式引导
                // 必须在这里也带上——否则「运行时更新失败」屏的按钮已改成安全模式入口，
                // 文案却还在让人「重试」，两者对不上。
                diagnosticsLocationHint(dir) + "。可复制该路径或打开控制台查看 engine.log。" +
                  activity.getString(R.string.ds_safe_hint_short),
              )
              activity.showGuide()
            }
            return@Thread
          }
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, "正在启动引擎…")
          }
        }
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      // 急救 CLI 随 App 版本部署（内容比对幂等）：下探失败时自动回撤的前置依赖。
      activity.engineManager.deployUndoCli()
      if (!activity.engineManager.startEngine()) {
        // 任务 19：失败终态落盘（此前这条路径**零落盘**——用户反馈第一条的真因）。
        //
        // issue #271 ④：区分「被前置条件拒绝」与「spawn 真失败」。半搬态（live 树缺 node）
        // 属于前者：不再空等 90s 预算，直接以可归因的原因收口，用户看到的不再是
        // 「进程在 90s 预算内死亡」这种无指向的结论。
        val refusal = activity.engineManager.lastStartRefusal
        LogCollector.writeBootFail(
          activity, if (refusal != null) "engine-start-refused" else "engine-start-false",
          "EngineManager.startEngine() 返回 false（未能拉起引擎进程）"
            + (refusal?.let { "；refusal=" + it } ?: ""),
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
        // M.1（#272）缺陷 b：先看 401 —— 它意味着「引擎在，但当前 cookie 不被接受」，
        // 必须触发重新认证，**不能**当成「已就绪」放行（旧实现正是这样把用户留在 401 页面且无出口），
        // 也**不能**当成「引擎死亡」（`running` 仍含 401 ⇒ engineProcessAlive 路径不变，D3/W2 不受影响）。
        val probe = EngineProbe.check()
        if (probe.optString("auth") == "required") {
          // A startup probe is not ownership evidence by itself: an unrelated local
          // listener can also answer 401. Reuse the same exact-origin/main-frame
          // policy before clearing or refreshing any cookie state.
          val availability = activity.engineManager.probeAvailability()
          if (EngineProbe.shouldAutoRecoverAuth(401, true, EngineProbe.ENGINE_URL, availability)) {
            LogCollector.log("dsh-engine-start", "owned engine answered 401 during boot: re-authenticating (cookie rejected)")
            runCatching { EngineAuth.handleUnauthorized(activity) }
          } else {
            LogCollector.log("dsh-engine-start", "401 startup recovery refused: engine ownership not proven")
          }
          // 认证刷新后本拍不算就绪：继续轮询，下一拍 200 才是真的就绪。
          Thread.sleep(pollStepMs)
          continue
        }
        if (probe.optBoolean("running", false)) {
          booted = true
          // P-AC-04：主路径的 listen 标记（watchEngineListen 线程为主，这里兜底；幂等）。
          LogCollector.markListen(activity)
          // C1（0.14.1 块F）：**首个 HTTP 响应**。上面这次 EngineProbe.check() 真正拿到了 HTTP 应答
          // （running=true 只在 200/401/303 时成立，见 EngineProbe.check 的判据），这正是 C1 要的读数。
          // M.1（#272）新增的是正交的 auth 字段，running 口径未动。
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
        // ── task-79（Bug A）：动态链接失败 ⇒ 判定运行时树损坏并触发一次重抽取 ──────────
        // 必须在**当拍**读 engine.log：`rotateEngineLog` 每次 spawn 都把 engine.log 截断重写，
        // 而真机上引擎每 4-10 秒就被拉起一次 ⇒ 等下一拍再读，现场已经被下一次启动冲掉。
        maybeSelfHealDamagedRuntimeTree(activity)
        // 0.13.1 W3：进程死亡现场镜像到共享目录（含退出码），用户可直接取包反馈。
        // review C5：文案按实际落点回填（共享不可写时回落私有目录）。
        val dir = activity.engineManager.mirrorDiagnosticsToShared("engine-died-during-boot")
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          // S1-5：同上——标题只说事实，诊断包路径进副文案。
          activity.applyGuidePhase(
            GuidePhase.Error,
            "引擎启动失败",
            diagnosticsLocationHint(dir) + "。可复制该路径或打开控制台查看 engine.log。",
          )
          activity.showGuide()
        }
        onEngineStartTimeout(generation)
        // #118 建议7：进程死亡路径同样自动重试（可自愈的瞬时失败不必停在错误页）。
        scheduleEngineRetry(generation)
        return@Thread
      }
      if (booted) {
        // task-79：启动成功 ⇒ 清掉「运行时树损坏」标记（若不成功，标记留着供诊断与后续决策）。
        clearRuntimeTreeDamageMarker(activity)
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
    manager.checkAndApply { st ->
      activity.runOnUiThread {
        // 与 startUpdateCheck 同口径（0.14.1 批 2 / P0-2）：相位由**类型**决定，不猜字符串前缀。
        val phase = when (st.outcome) {
          UpdateManager.UpdateOutcome.NotConfigured -> GuidePhase.Info
          UpdateManager.UpdateOutcome.Failed -> GuidePhase.Error
          UpdateManager.UpdateOutcome.Done -> GuidePhase.Recovering
          UpdateManager.UpdateOutcome.Working -> GuidePhase.Updating
        }
        activity.applyGuidePhase(phase, st.text)
        activity.showGuide()
      }
      try {
        // 落盘仍是纯文本（adb 侧判据读它），保留原始状态串。
        statusFile.appendText(st.text + "\n")
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
   * Restart only after the manager proves it can stop its tracked child. Foreign listeners are
   * left untouched and the subsequent spawn is not attempted.
   */
  fun restart(): Boolean {
    if (!engineRestarting.compareAndSet(false, true)) return false
    activity.userClosedEngine = false
    flowGeneration.incrementAndGet()
    EngineService.setUserShutdown(activity, false)
    Thread {
      try {
        if (!activity.engineManager.stopOwnedEngine()) {
          activity.runOnUiThread {
            activity.showTestNotification("未重启引擎", activity.engineManager.lastStartRefusal ?: "端口监听未归属到本壳，未执行停止或启动")
          }
          return@Thread
        }
        EngineManager.lastStartAttemptAt = 0
        flowRunning.set(false)
        LogCollector.log("dsh-shell", "restart engine requested (tracked child only)")
        Thread.sleep(1000)
        activity.runOnUiThread {
          activity.showTestNotification("引擎重启中", "已停止本壳托管进程，正在重新启动…")
          start()
        }
      } finally {
        engineRestarting.set(false)
      }
    }.start()
    return true
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

// ── task-79（Bug A）：运行时树损坏 ⇒ 一次受控重抽取 ─────────────────────────────

/**
 * 本次 app 运行是否已经为「运行时树损坏」自愈过一次（进程内一次性，见 [RuntimeTree.maySelfHeal]）。
 *
 * 为什么是**进程内**标记而不是持久化：预算是「每次 app 运行最多一次」——用户重启 app 就是重新给一次机会，
 * 这与「每次启动都无限重抽取」有本质区别。持久化会让用户永远翻不了身。
 */
@Volatile private var runtimeTreeHealedThisRun = false

/**
 * task-79（Bug A）：引擎**因动态链接失败而死**时，判定运行时树损坏并触发一次受控重抽取。
 *
 * 真机现场：`CANNOT LINK EXECUTABLE ... library "libz.so.1" not found` ⇒ 引擎每次拉起都在链接期死，
 * 而旧判据只看 3 个条目 ⇒ 判「运行时完整」⇒ `shouldDegradeRefresh` 放行降级启动 ⇒ 永远拉起同一棵坏树。
 *
 * 自愈动作（**只在预算内**）：
 *  ① 落壳侧标记 `.runtime-tree-damaged`（含时间戳）——engine.log 每次 spawn 被截断，不能当账本；
 *  ② 删 `.snapshot-fingerprint` ⇒ `snapshotFresh()` 立即为 false ⇒ 下次刷新走**完整重抽取**；
 *  ③ 清刷新失败账本 ⇒ 避免降级闸门在新局面下误判（不清则「连续失败达阈 + live 残缺」的旧账会打架）；
 *  ④ 如实写日志：说清做了什么、以及**不承诺一次成功**。
 *
 * 预算外（本次运行已自愈过一次）：**什么都不做**，直接让既有错误页呈现（可读、带诊断包），
 * 避免「重抽取 → 再失败 → 再重抽取」的死循环把用户永远挡在加载中。
 *
 * @param activity 宿主（用其 filesDir 与 engineManager）。
 */
private fun maybeSelfHealDamagedRuntimeTree(activity: MainActivity) {
  // 当拍读：engine.log 由 redirectOutput 每次 spawn 截断重写，晚一拍就读不到现场了。
  val tail = try { PluginMounts.readEngineLogTail(activity, 4_096) } catch (_: Throwable) { "" }
  if (!RuntimeTree.snapshotLinkFailure(tail)) return
  LogCollector.log("dsh-engine-start", "engine died from a dynamic-link failure; runtime tree is damaged")
  if (!RuntimeTree.maySelfHeal(runtimeTreeHealedThisRun)) {
    // 预算用尽：不再删指纹/重抽取，停在可读错误页（既有 UI 已展示诊断包路径）。
    LogCollector.log("dsh-engine-start", "runtime tree damage: self-heal budget already spent this run; not re-extracting (avoid a re-extract loop)")
    return
  }
  runtimeTreeHealedThisRun = true
  try {
    // ① 壳侧标记（不被引擎截断），供后续启动与诊断读取。
    java.io.File(activity.filesDir, RuntimeTree.DAMAGE_MARKER)
      .writeText(System.currentTimeMillis().toString() + (0x0A).toChar())
    // ② 删指纹 ⇒ 下次刷新走完整重抽取。
    val fp = java.io.File(activity.filesDir, ".snapshot-fingerprint")
    if (fp.exists()) fp.delete()
    // ③ 清账本（避免降级闸门在新局面下与新判据打架）。
    activity.engineManager.clearRefreshLedger()
    LogCollector.log("dsh-engine-start", "runtime tree damage: fingerprint cleared, refresh ledger reset; next start will re-extract the runtime")
  } catch (t: Throwable) {
    Log.w("dsh-engine-start", "runtime tree self-heal failed: " + t.javaClass.simpleName + ": " + (t.message ?: ""))
  }
}

/**
 * 0.14.2-fx-2 缺口：把「恢复期拒绝回滚」落成**可见面**所需的全部壳侧事实。
 *
 * 为什么必须有人调它：`applyRecovery` 的 ROLLBACK_FAILED 只写 logcat 与
 * `pendingRecoveryFailure`，没有任何面向 UI 的通道 ⇒ 数据被保护了但用户完全不知情。
 *
 * 做三件事（与 :552 的 refreshSnapshot 失败**同族**的落盘面，但可见面不同）：
 *   ① `LogCollector.writeBootFail(code)` —— 结构化码，排障者 grep 这个码即可归类；
 *   ② 一次性标记文件 —— 供引擎 WebUI 就绪后**注入 DOM 提示**（可见面，见 MainActivity）；
 *   ③ 诊断包镜像 —— 用户可取包反馈。
 *
 * **为什么不在这里切引导页 Error 相位**（与 :552 的关键差别，改动理由写清以免被当成漏做）：
 *   · 恢复期拒绝**不阻断启动**——实测场景（plugin-loss）里应用「一直能跑」，引擎照常起；
 *   · 启动流紧接着就会 `applyGuidePhase(Starting, "正在启动引擎…")`（引擎未起路径）或
 *     `showWeb()`（引擎已起路径），两者都会**立刻覆盖/隐藏**这里设的 Error 相位；
 *     结果是用户看到一闪而过的错误页然后恢复正常 —— 比不显示更糟（像是「刚才出错了？」）；
 *   · 因此可见面唯一可靠的落点是**页面 DOM 注入**（引擎起来、页面 onPageFinished 之后）。
 *   若引擎最终没起来，既有 boot-fail 错误页已经展示了失败，本条仍完整落在诊断面。
 */
private fun reportRecoveryRejectionIfAny(activity: MainActivity, detail: String?) {
  val notice = SnapshotRecoveryNotice.forRejection(detail) ?: return
  // ① 结构化落盘。
  LogCollector.writeBootFail(
    activity,
    notice.code,
    "快照恢复期拒绝回滚（code=" + notice.code + "）：" + (detail ?: ""),
  )
  // ② 一次性标记（注入成功后由 MainActivity consume）。
  SnapshotRecoveryNotice.markPending(activity.filesDir, detail)
  // ③ 诊断包镜像（不切界面相位，理由见上方注释）。
  activity.engineManager.mirrorDiagnosticsToShared(notice.code)
}

/**
 * 启动**成功**时清掉损坏标记（Lead 裁决第 4 条：启动成功即清标记）。
 *
 * 为什么要清：标记的语义是「上次我们判定树坏了」。若树其实已经修好（重抽取成功），
 * 标记留着会让后续诊断误判、也可能让将来新增的读取方做出错误决策。
 * 只删文件，不改预算变量——预算按「每次 app 运行」计，不因成功而重置（同一次运行内不重复自愈）。
 */
private fun clearRuntimeTreeDamageMarker(activity: MainActivity) {
  try {
    val marker = java.io.File(activity.filesDir, RuntimeTree.DAMAGE_MARKER)
    if (marker.exists()) {
      marker.delete()
      LogCollector.log("dsh-engine-start", "runtime tree damage marker cleared after a successful boot")
    }
  } catch (t: Throwable) {
    Log.w("dsh-engine-start", "could not clear damage marker: " + t.javaClass.simpleName)
  }
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
