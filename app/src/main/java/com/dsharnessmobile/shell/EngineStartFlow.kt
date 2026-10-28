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

  private val flowOwnership = StartupFlowOwnership()
  private val ownershipRetry = StartupOwnershipRetryBudget()
  /** 重启引擎 in-flight 守卫（防连点双杀双启）。 */
  private val engineRestarting = java.util.concurrent.atomic.AtomicBoolean(false)
  /** #118 建议7（2026-09）：启动失败自动重试（最多 2 次，5s/10s 间隔），
   *  失败不永远停在 Error 引导页等手动操作。手动重试（onStartEngine）归零计数。 */
  internal var engineRetryCount: Int
    get() = RepairState.retries(activity)
    set(value) = RepairState.setRetries(activity, value)
  @Volatile private var currentStartGeneration = 0L

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
  @Volatile private var monitorGeneration = 0L
  @Volatile private var updateUiGeneration = 0L
  private val engineMonitorHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val engineMonitorRunnable = object : Runnable {
    override fun run() {
      if (!canRunEngineWork()) return
      if (!activity.pageUiActive || activity.userClosedEngine) return
      if (RepairState.active || RepairState.retryPending) return
      if (!mayObserveColdStart(RepairState.required(activity), RepairState.coldStartAttemptInFlight())) return
      // CONTRACT §4 闸门：插件装配失败 latch 期内整条前台监控都不再动作。
      // 为什么是整条而不是只挡住 showWeb 那一支：latch 的语义是「页面已定性失败，等用户决策」；
      // 放行其余分支就会继续做「引擎未运行 → 自动恢复」的相位切换，把 Error 页顶掉——那是
      // 另一种形态的弹回。用户显式重试/安全模式会清 latch，出口仍在。
      if (clientPluginTreeFailed) return
      // The startup owner performs its own probes. A retry clears the previous refusal;
      // the monitor must not briefly promote that same foreign listener during the new attempt.
      if (flowOwnership.running) {
        engineMonitorHandler.postDelayed(this, 3_000)
        return
      }
      // HTTP liveness does not prove that a foreign listener belongs to this engine.
      if (activity.engineManager.lastStartRefusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return
      val generation = monitorGeneration
      val monitor = this
      Thread {
        val probe = try { EngineProbe.check(1_500) } catch (_: Exception) { null }
        val httpAlive = probe?.optBoolean("running", false) == true
        val portAlive = EngineProbe.portReachable(500)
        activity.runOnUiThread {
          if (generation != monitorGeneration || !activity.pageUiActive || !canRunEngineWork()) return@runOnUiThread
          // A repair decision made during the HTTP request revokes this observation too.
          if (RepairState.retryPending ||
            !mayObserveColdStart(RepairState.required(activity), RepairState.coldStartAttemptInFlight())) return@runOnUiThread
          if (flowOwnership.running) {
            engineMonitorHandler.postDelayed(monitor, 3_000)
            return@runOnUiThread
          }
          if (activity.engineManager.lastStartRefusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return@runOnUiThread
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
                    activity.retryFailedEnginePage()
                  } catch (e: Exception) {
                    Log.w("dsh-shell", "engine page reload failed", e)
                  }
                }
              }
            } else if (activity.webView.visibility == View.VISIBLE) {
              engineMonitorFailures++
              if (engineMonitorFailures >= UI_DEAD_CONFIRMATIONS) {
                activity.applyGuidePhase(GuidePhase.Recovering, UiText.t(activity, "引擎未运行，正在自动恢复…", "The engine is not running; recovering automatically…"))
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
  // 前台静默 reload 一次 + 记日志；后台时间不参与冻结判定。 ——
  private val freezeHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var jsAckAt = System.currentTimeMillis()
  private var pageLoadedAt = System.currentTimeMillis()
  private var pingOutstanding = false
  private var freezeReloaded = false
  private val freezeRunnable = object : Runnable {
    override fun run() {
      if (!canRunEngineWork()) return
      if (!activity.pageUiActive || !activity.webViewReady || activity.userClosedEngine || activity.webView.visibility != View.VISIBLE) return
      // CONTRACT §4 闸门：latch 期内早退。坏页面本来就装不上插件，evaluateJavascript 心跳
      // 得不到应答是**预期结果**，把它当成「渲染进程冻结」去 reload 只是又一次弹回坏页面
      // （与 showWeb 的 reload 环同族）。清 latch 之后本看门狗自然恢复。
      if (clientPluginTreeFailed) return
      val now = System.currentTimeMillis()
      if (now - pageLoadedAt > 45_000 && now - jsAckAt > 20_000) {
        if (!freezeReloaded) {
          freezeReloaded = true
          LogCollector.log("dsh-shell", "webview JS 无响应，渲染进程冻结（frozenMs=" + (now - jsAckAt) + "）")
          // 0.14.1 D3：与上面的引擎页重载同族——冻结自愈的唯一动作失败时必须留下痕迹，
          // 否则日志里只有「检测到冻结」，看不出「自愈没生效」。
          try {
            activity.reloadEnginePage()
          } catch (e: Exception) {
            Log.w("dsh-shell", "freeze recovery reload failed", e)
          }
        }
        jsAckAt = now
        pingOutstanding = false
      } else if (!pingOutstanding) {
        pingOutstanding = true
        try {
          val generation = monitorGeneration
          activity.webView.evaluateJavascript("1") { _ ->
            if (generation != monitorGeneration || !activity.pageUiActive) return@evaluateJavascript
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
    if (!canRunEngineWork()) return
    if (!activity.pageUiActive || activity.userClosedEngine) return
    monitorGeneration++
    engineMonitorFailures = 0
    // Background time is not evidence of a frozen renderer or stalled foreground boot.
    bootStallStartAt = bootStallNow()
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    engineMonitorHandler.post(engineMonitorRunnable)
    startBootStallWatchdog()
    startFreezeWatchdog()
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
  //
  // **0.14.10 缺陷修复（审计 §6.7）：基准曾是墙上时钟，stalledMs 会被校时凭空放大。**
  // 现场：新机首装首启 `shell-stall` 记 `stalledMs=352525`（352s），而同一轮页面在首个 HTTP
  // 之后 148ms 就报了 `page-ready`——352 是 40s 窗口的 8.8 倍，单靠前后时序解释不了。
  // 真因是基准值取 [System.currentTimeMillis]（墙上时钟）：新装机在首次联网前系统时间往往还没
  // 校准，起点记下的是一份偏慢的时间；随后 NTP 校时把钟**向前拨**，下一拍做差就凭空多出几百秒。
  // 故起点与做差统一走 [bootStallNow]（单调时钟），见该函数的选型注释。
  private var bootStallStartAt = bootStallNow()

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
      if (!activity.pageUiActive || !canRunEngineWork()) return
      val generation = monitorGeneration
      try {
        val stalledMs = bootStallElapsedMs(bootStallStartAt, bootStallNow())
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
            if (pageReadyReported || generation != monitorGeneration || !activity.pageUiActive || !canRunEngineWork()) { bootStallReported = false; return@Thread }
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
    if (!canRunEngineWork()) return
    // 页面 ready 是**最硬的健康证据**（结果性判据：真实 DOM 已渲染）：它到达时必须清修复门。
    // 此前（0.14.10 审计 §B-1，小米 14 实锤 2026-10-25）：门在场且冷启自动尝试已花掉时，
    // 本守卫把 ready 报文整条丢弃——实测五轮启动页面**每一轮都活着并上报 ready**（上游
    // ErrorBoundary 兜住了 slot entry 的 React #130），但壳因持久门无视它，用户每轮看到
    // 「引擎仍无法启动」引导页，直到手清 native-repair 才亮。coldStartAttemptInFlight 的
    // 例外只覆盖「自动尝试刚花掉、门还没来得及被本轮失败重置」的窗口，覆盖不了
    // 「门是历史残留、本进程已无自动尝试额度」的常态——那正是环境性死亡后的真实形态。
    // 保留的语义边界：clientPluginTreeFailed 在场仍丢弃（插件树失败是页面自身的终态，
    // ready 行与失败行同源竞争时以失败为准——那是另一条契约，不在本修复动）。
    if (clientPluginTreeFailed) return
    if (RepairState.required(activity)) {
      RepairState.reset(activity)
      LogCollector.log("dsh-shell", "repair gate cleared by page-reported boot-ready")
    }
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
    if (!canRunEngineWork()) return
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

  // ── 客户端插件装配失败：壳侧失败面（CONTRACT §4）────────────────────────────
  //
  // 页面注入层在「终局失败」时经 console.error 发布 `[dsh-boot-failed] …`（CONTRACT §1），
  // MainActivity.onConsoleMessage 路由到本方法。壳侧要做的四件事（顺序即契约）：
  //   ① 落失败终态（boot-fail.log，stage=client-plugin-tree-failed）+ Log.e 双通道；
  //   ② 置 latch —— 之后 showWeb / 前台监控 / 冻结看门狗都不得把坏页面弹回前台；
  //   ③ 前台立即切引导页 Error（非前台只挂起，由 onResume 消费）；
  //   ④ 后台花掉**一次**自动回滚预算（与 UndoGate 的 30 分钟窗叠加）。
  //
  // **不得复用 enginePageFailed + claimLoadErrorRetry()**（CONTRACT §0 的硬约束）：那条路
  // 是「页面加载失败 → 自动重载」，而坏插件树会让页面每次渲染完都回到同一条契约行——
  // 复用即重载环。latch 是独立的、只有用户显式动作才解除的闸门。

  /** latch：本世代是否已认定「客户端插件装配失败」（CONTRACT §4）。
   *  只有三条路径置位（本方法），只有用户显式动作/新启动世代清位（clear...）。 */
  @Volatile private var clientPluginTreeFailed = false

  /** 本进程是否已花掉自动回滚预算（一次性；与 UndoGate.RETRY_WINDOW_MS 叠加）。 */
  @Volatile private var clientPluginTreeRecoverySpent = false

  /** 失败契约行原文（折叠后；供解析 failedIds 与落盘 detail）。 */
  @Volatile private var clientPluginFailureRawLine = ""

  /** 面向用户的失败原因短句（进错误页 hint 的 %1$s；绝不写「未知」以外的臆造内容）。 */
  @Volatile private var clientPluginFailureReasonIds: List<String> = emptyList()

  /** latch 的只读访问器（MainActivity 的闸门与单测用；CONTRACT §4 冻结此属性名）。 */
  internal val clientPluginTreeFailedLatch: Boolean get() = clientPluginTreeFailed

  /** 失败条目（MainActivity 按当前界面语言取短句）。 */
  internal val clientPluginFailureIds: List<String> get() = clientPluginFailureReasonIds

  /** 用户显式动作/新启动世代/回滚放行时调用：解除 latch（**不**退自动回滚预算）。 */
  internal fun clearClientPluginTreeFailureLatch() {
    clientPluginTreeFailed = false
  }

  /**
   * 页面契约行入口（由 MainActivity 控制台路由调用；JavaBridge/WebView 线程）。
   *
   * 幂等开销极小（重复行只是重复写一条诊断），但编排本身是幂等的：latch 置位后重复到达
   * 不会重复起回滚线程——[clientPluginTreeRecoverySpent] 是一次性的。
   */
  fun onClientPluginTreeFailed(rawLine: String) {
    if (!canRunEngineWork()) return
    if (clientPluginTreeFailed || RepairState.required(activity)) return
    val folded = (rawLine ?: "").replace('\n', ' ').replace('\r', ' ').trim()
    clientPluginFailureRawLine = folded
    val ids = LogCollector.clientFailedIdsOf(folded)
    clientPluginFailureReasonIds = ids
    // ① 失败终态落盘（writeBootFail 内部另有一条 Log.e；下面这条把「契约行原文」也带进 logcat）。
    val detail = "客户端插件装配失败（页面侧契约行 " + LogCollector.PAGE_PLUGIN_FAIL_PREFIX + "）：failedIds=" +
      (if (ids.isEmpty()) "-" else ids.joinToString(",")) + " 原文=" + folded.take(400)
    LogCollector.writeBootFail(activity, "client-plugin-tree-failed", detail)
    Log.e("dsh-shell", "client plugin tree failed: failedIds=" + (if (ids.isEmpty()) "-" else ids.joinToString(",")) +
      " line=" + folded.take(400))
    // ② latch：此后所有「把 WebUI 推回前台」的自动路径都必须让路。
    clientPluginTreeFailed = true
    // ③ 呈现：前台立刻切错误相位；非前台挂起，由 MainActivity.onResume 消费。
    activity.runOnUiThread { activity.presentClientPluginFailure() }
    // 页面装配失败也消耗同一份两次重试预算，不再执行配置回滚。
    activity.runOnUiThread { scheduleEngineRetry(currentStartGeneration, clientFailure = true) }

  }

  /** 页面就绪/失败时复位（重新计时 + 允许再次上报）。 */
  fun resetBootStall() {
    bootStallStartAt = bootStallNow()
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

  /** Pause/destroy/renderer-loss: stop Activity page monitoring, never the EngineService task watchdog. */
  fun stopMonitoring() {
    monitorGeneration++ // Reject HTTP/JS callbacks already in flight at pause or renderer loss.
    engineMonitorFailures = 0
    pingOutstanding = false
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    bootStallHandler.removeCallbacks(bootStallRunnable)
  }

  fun startFreezeWatchdog() {
    if (!canRunEngineWork()) return
    if (!activity.pageUiActive || activity.userClosedEngine || !activity.webViewReady || activity.webView.visibility != View.VISIBLE) return
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
    if (!OnlineUpdateGate.begin()) return
    val updateGeneration = ++updateUiGeneration
    activity.guideRenderer.chrome.updateButton.isEnabled = false
    activity.guideRenderer.chrome.updateButton.alpha = 0.55f
    activity.applyGuidePhase(GuidePhase.Updating, UiText.t(activity, "检查更新…", "Checking for updates…"))
    UpdateManager(activity).checkAndApply { st ->
      activity.runOnUiThread {
        if (updateGeneration != updateUiGeneration || !canRunEngineWork()) return@runOnUiThread
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
          UpdateManager.UpdateOutcome.Working, UpdateManager.UpdateOutcome.Verifying -> GuidePhase.Updating
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
        if (st.outcome != UpdateManager.UpdateOutcome.Working && st.outcome != UpdateManager.UpdateOutcome.Verifying) {
          activity.guideRenderer.chrome.updateButton.isEnabled = true
          activity.guideRenderer.chrome.updateButton.alpha = 1f
        }
      }
    }
  }

  /** 开发者选项「关闭」：停止引擎并回退到初始化（启动/测试）界面，不自动重启。 */
  fun shutdownToGuide() {
    activity.userClosedEngine = true
    flowOwnership.invalidate()
    EngineService.setUserShutdown(activity, true)
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    activity.runOnUiThread {
      activity.hideSoftInput()
      activity.applyGuidePhase(GuidePhase.Closed, UiText.t(activity, "引擎已关闭", "Engine closed"))
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

  private fun scheduleEngineRetry(generation: Long, clientFailure: Boolean = false) {
    if (!isCurrentEngineFlow(generation)) return
    if (!shouldScheduleAutomaticRetry(RepairState.required(activity), engineRetryCount, RepairState.retryPending)) {
      // Automatic recovery stays bounded. Only an explicit user retry clears the durable gate.
      if (engineRetryCount >= 2 && !RepairState.required(activity)) requireNativeRepair()
      return
    }
    RepairState.retryPending = true
    engineRetryCount++
    val delayMs = 5_000L * engineRetryCount
    val attempt = engineRetryCount
    activity.runOnUiThread {
      if (!isCurrentEngineFlow(generation)) return@runOnUiThread
      activity.applyGuidePhase(GuidePhase.Starting, UiText.t(activity,
        "启动失败，${delayMs / 1000}s 后重试（$attempt/2）",
        "Startup failed; retrying in ${delayMs / 1000}s ($attempt/2)"),
        startupFailureHint(activity, activity.engineManager.lastStartRefusalCode))
      activity.showGuide()
    }
    engineMonitorHandler.postDelayed({
      RepairState.retryPending = false
      if (isCurrentEngineFlow(generation) && !RepairState.required(activity)) {
        Thread {
          if (!isCurrentEngineFlow(generation)) return@Thread
          // stopOwnedEngine() also returns false when the tracked child is
          // already dead and the port is closed. Only a still-reachable port
          // without an owned child is a genuine reason to stop retrying.
          if (clientFailure && !activity.engineManager.stopOwnedEngine() &&
            EngineProbe.portReachable(500)) {
            requireNativeRepair()
            return@Thread
          }
          activity.engineManager.resetCooldown()
          activity.runOnUiThread {
            if (isCurrentEngineFlow(generation)) {
              if (clientFailure) activity.enginePageFailed = true
              start()
            }
          }
        }.apply { name = "dsh-startup-retry"; start() }
      }
    }, delayMs)
  }

  /** 两次重试耗尽后不再启动、回滚或自动拔插件，交给独立原生助手。 */
  private fun requireNativeRepair() {
    RepairState.requireRepair(activity)
    RepairState.retryPending = false
    Thread { activity.engineManager.mirrorDiagnosticsToShared("startup-retries-exhausted") }
      .apply { isDaemon = true; name = "dsh-repair-diagnostics"; start() }
    activity.runOnUiThread {
      if (activity.isDestroyed || activity.isFinishing) return@runOnUiThread
      activity.showGuide()
      activity.applyGuidePhase(
        GuidePhase.Error,
        UiText.t(activity, "引擎仍无法启动", "The engine still will not start"),
        UiText.t(activity, "已自动重试两次。可启动修复助手，自动读取本轮诊断并修复运行时。", "Automatic retry failed twice. The repair assistant can read this failure and repair the runtime."),
      )
    }
  }

  /**
   * Engine-first flow: use an already-running engine (Termux or prior
   * embedded), else extract the embedded snapshot and start the embedded
   * engine, then poll until the web service answers.
   */
  fun start() {
    if (!canRunEngineWork()) return
    // 冷启自动尝试（0.14.10）：与 MainActivity.startEngineFlow 同一出口语义；RepairState 内部保证每进程一次。
    if (startupEntryDecision(RepairState.required(activity), explicitUserRetry = RepairState.coldStartAutoAttemptAvailable(activity)) ==
      StartupEntryDecision.BLOCKED_FOR_REPAIR) { requireNativeRepair(); return }
    // 放行即花掉本进程的一次冷启自动尝试（查询不消耗，两道闸门共用一次额度）。
    RepairState.spendColdStartAutoAttempt()
    // EngineManager.ensurePrivateDshData() establishes the active profile and
    // migrates legacy DSH_HOME layouts. The handoff used to happen as a side
    // effect of starting the engine; selecting and validating a model happens
    // before that now, so establish it before the first start.
    // CONTRACT §4：新启动世代/用户显式重试 ⇒ 解除插件失败 latch（放行一次坏页面的呈现）。
    // 这里只清 latch，**不**退一次性回滚预算——预算是「本进程最多自动回滚一次」，与世代无关。
    clearClientPluginTreeFailureLatch()
    // 页面装载失败也会消耗两次重试预算；新世代开始时清掉 latch，
    // 让下一次页面申报能再次落到修复闸门。
    clientPluginTreeFailed = false
    // The owner and generation change in one CAS; an obsolete finally cannot
    // clear a replacement, and duplicate lifecycle callbacks change neither.
    val token = flowOwnership.begin()
    if (token == null) {
      // 抢不到所有权有两种原因，**必须分开**（定位报告 §2.3）：destroyed 是生命周期终结，
      // 保持「不启动」；running 是「另一次启动/快照刷新正在跑」，丢弃它才是缺陷。
      deferEngineStartWhileSnapshotTransactionBusy()
      return
    }
    val generation = token.generation
    currentStartGeneration = generation
    RepairState.startupInProgress = true
    activity.engineManager.lastStartRefusalCode = null
    activity.engineManager.lastStartRefusal = null
    if (!isCurrentEngineFlow(generation)) { flowOwnership.finish(token); return }
    // 新启动世代 = boot-stall 的新 epoch：在此复位（**不在** onPageFinished。
    // onPageFinished 只代表文档加载完，在那里复位会造成同 epoch 重复报，见 L-1）。
    resetBootStall()
    startMonitor()
    // 启动即有反馈（2026-10-18）：相位切换必须**先于**任何可能耗时的前置工作落地。
    // 旧实现把 «正在启动引擎…» 排在 worker 线程里、且排在 `prepareStartupOwnership` 与
    // 「引擎已在跑」探活之后——主线程要空等属主探测（Shizuku/root 面可达数秒），用户按了按钮
    // 屏幕纹丝不动，随后才突然跳到「启动中」。这里在主线程、worker 之前一次切到位：
    // 相位与按钮文案同源（applyGuidePhase 一次切到底），主按钮当场变成「启动中」并锁住。
    //
    // 为什么要判 `webView` 是否在场：**只有引导页才是用户按下这个按钮的地方**。自动入口
    // （onCreate/onResume）也会走到这里，而那时引擎可能已经在跑——若无条件 showGuide()，
    // 会把正在显示的引擎页面抢下去闪一下再切回来。用户按按钮时 webView 必然不可见，
    // 因此这条判据既不削弱「按下即有反馈」，又不给自动入口制造闪烁。
    //
    // 复用现有快照（用户口径）：这一步只做相位，不探测、不解压、不重建任何状态；已解压且指纹
    // 匹配的运行时仍走下面的既有早退路径（startupRecoverThenProbe → snapshotFresh）。
    if (!activity.webViewReady || activity.webView.visibility != View.VISIBLE) {
      activity.applyGuidePhase(GuidePhase.Starting, UiText.t(activity, "正在启动引擎…", "Starting the engine…"))
      activity.showGuide()
    }
    val caller = Thread {
      try {
      if (!isCurrentEngineFlow(generation)) return@Thread
      // Repair before any transaction reads: root-owned marker/stage leaves can break recovery too.
      val ownership = ShizukuTransport.prepareStartupOwnership(activity.applicationContext)
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (startupOwnershipPending(ownership.optString("reason"))) {
        // Pending is not startup failure: no undo, toast, fresh/read or worker replay.
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Recovering,
            UiText.t(activity, "正在等待属主维护完成…", "Waiting for ownership maintenance…"),
            UiText.t(activity,
              "维护结果尚未结算，暂不读取运行时；稍后自动重试。",
              "Maintenance is not settled yet; the runtime stays untouched and the app retries later."))
        }
        // 预算内快速重试；预算用尽后**不停止**，转为长周期复查——否则临时性的探测不完备
        // （binder 未就绪等）会把用户卡到重启设备为止（2026-10-02 复审：UNKNOWN 无上限）。
        val delay = ownershipRetry.nextDelayMs() ?: SLOW_OWNERSHIP_RECHECK_MS
        engineMonitorHandler.postDelayed({
          if (isCurrentEngineFlow(generation) && activity.pageUiActive) start()
        }, delay)
        return@Thread
      }
      if (!ownership.optBoolean("ok")) LogCollector.log("dsh-root", "preboot ownership repair incomplete: " + ownership.optString("reason"))
      if (!isCurrentEngineFlow(generation)) return@Thread
      // FX-210.1（源文档 §3.3 B1 顺序约束）：恢复入口是「服务路径与 Activity 路径」的
      // 共同前置——引擎已被前台服务拉起时重开 app 也要消费 .snapshot-transaction 判据，
      // 因此它必须排在「引擎已在跑」早退之前（顺序由 startupRecoverThenProbe 保证）。
      val engineAlreadyRunning = startupRecoverThenProbe(
        recover = {
          requireCurrentEngineFlow(generation)
          activity.engineManager.recoverInterruptedRefresh()
          requireCurrentEngineFlow(generation)
          // 恢复期拒绝必须同时留下诊断证据与用户提示：写结构化码、一次性标记和诊断包；
          // 本轮若仍未收敛，下面直接显示引导页 Error 并阻断探活/启动。恢复后进入引擎页时，
          // MainActivity 也可消费保留的标记，在 DOM 中交付后续提示。
          // 恢复失败时必须阻断探活与启动；事务现场未收敛前不能把当前 live 树当成健康运行时。
          reportRecoveryRejectionIfAny(activity, activity.engineManager.pendingRecoveryFailure) { isCurrentEngineFlow(generation) }
          if (activity.engineManager.snapshotRecoveryBlocksRuntime()) {
            activity.runOnUiThread {
              if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, UiText.t(activity, "运行时恢复未完成", "Runtime recovery did not finish"), UiText.t(activity, "事务现场已保留；请打开控制台查看恢复失败原因。修复前不会探活或启动运行时。", "The transaction state is preserved. Open the console to see why recovery failed; nothing is probed or started until it is repaired."))
              activity.showGuide()
            }
            throw java.util.concurrent.CancellationException("snapshot recovery has not converged")
          }
        },
        // Health `running` intentionally includes arbitrary 401s for watchdog semantics; startup
        // early-exit needs ownership proof and must not treat an unrelated local listener as ours.
        probeRunning = {
          requireCurrentEngineFlow(generation)
          val ownership = activity.engineManager.probeAvailability()
          ownership == EngineProbe.EngineAvailability.OUR_PROCESS ||
            ownership == EngineProbe.EngineAvailability.OUR_HTTP
        },
      )
      requireCurrentEngineFlow(generation)
      activity.engineManager.snapshotFingerprintProblem()?.let { problem ->
        requireCurrentEngineFlow(generation)
        LogCollector.writeBootFail(activity, problem.failureCode.orEmpty(), problem.detail.orEmpty())
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error,
            UiText.t(activity, "安装包运行时指纹不可用", "Runtime fingerprint unavailable"), problem.detail)
          activity.showGuide()
        }
        return@Thread
      }
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
      // 相位已由本函数入口切到 Starting（启动即有反馈），这里不再重复切换——
      // 重复切会把中途「等待属主维护」等相位又顶回「正在启动引擎…」。
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
          requireCurrentEngineFlow(generation)
          LogCollector.writeBootFail(
            activity, "snapshot-refresh-degraded",
            "自动刷新连续失败达阈且 live 运行时完整：跳过本次自动刷新，以现有运行时启动"
              + "（手动点「重试」可强制再刷一次；升级到新快照后本闸门自然失效）",
          )
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, UiText.t(activity, "运行时更新未完成，正以现有运行时启动…", "The runtime update did not finish; starting with the current runtime…"))
            activity.guideRenderer.progressText.visibility = View.GONE
          }
        } else {
          if (!isCurrentEngineFlow(generation)) return@Thread
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Extracting, UiText.t(activity, "正在解压运行时", "Extracting the runtime"))
            activity.guideRenderer.showInitialRuntimeStage()
            activity.guideRenderer.progressText.visibility = View.VISIBLE
            activity.guideRenderer.progressText.text = UiText.t(activity, "正在准备运行时…", "Preparing the runtime…")
          }
          // 0.14.2 FX1-A：轮换改由**时间**驱动。旧实现在 onProgress 里 tick++，而回调频率 = 解压进度
          // 回调频率（SnapshotExtractor 每 1MB 一次，2.5GB 约 2500 次、间隔数十毫秒），
          // 于是文案以毫秒级频率换句 -> 用户现场「一直在闪」。
          // 本次刷新开始前复位一次，使第一句立刻可见、时间窗从此刻起算。
          activity.guideRenderer.resetRuntimeStageRotation()
          requireCurrentEngineFlow(generation)
          val ok = activity.engineManager.refreshSnapshot(
            onProgress = { _, _ ->
              activity.runOnUiThread {
                if (!isCurrentEngineFlow(generation)) return@runOnUiThread
                // 0.14.2 P2：**不再印任何数字**。旧实现用编造的 700MB 当分母拼
                // 「已写入 1157 MB / 约 700 MB（99%）」（分子大于分母还报 99%）——真因是分母凭空
                // 造的，而真实解压是增量的（含磁盘上已有数据）。现在只推进阶段车轱辘话，
                // 进度条恒为不确定态。回调里的 done/total 仍然收下（接口未变），但不再渲染。
                if (activity.guideRenderer.lastGuidePhase != GuidePhase.Extracting) {
                  activity.applyGuidePhase(GuidePhase.Extracting, UiText.t(activity, "正在解压运行时", "Extracting the runtime"))
                }
                // 时间戳取自单调时钟：回调频率再高，闸门也只按 1.3s 的窗放行（同一窗内只刷可见性）。
                activity.guideRenderer.showRuntimeStage(SystemClock.elapsedRealtime())
              }
            },
            onStage = { stage ->
              activity.runOnUiThread {
                if (!isCurrentEngineFlow(generation)) return@runOnUiThread
                activity.applyGuidePhase(GuidePhase.Extracting, UiText.t(activity, "正在更新运行时", "Updating the runtime"))
                // stage 是 EngineManager 的阶段句（「正在解压运行时…」「正在恢复用户数据…」等），
                // 本身就是无数字的车轱辘话，直接沿用——不为它另造一套文案，避免两份口径漂移。
                activity.guideRenderer.progressText.visibility = View.VISIBLE
                activity.guideRenderer.progressText.text = stage
              }
            },
          )
          requireCurrentEngineFlow(generation)
          if (!ok && activity.engineManager.lastRefreshDeferred) {
            // 0.14.9：另一条启动流正在刷新同一个快照——**让行不是失败**。
            // 旧实现把 refreshSnapshot 的 false 一律当失败，第二个入口（新 Activity / 重开应用）
            // 会写 boot-fail 并显示「运行时更新失败」，而刷新其实还在持有者线程里正常进行。
            // 这里只留一行让行记录并退出本线程：刷新完成后由持有者拉起引擎；若持有者已随
            // Activity 销毁，下一次入口的探活会接手。
            LogCollector.writeBootFail(
              activity, "snapshot-refresh-deferred",
              "本次启动请求撞上正在进行的快照刷新，已让行（非失败）：未重复解压、未改动运行时；"
                + "由持有刷新的启动流在完成后拉起引擎。",
            )
            return@Thread
          }
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
            activity.engineManager.lastStartRefusalCode = refreshCause?.let {
              activity.engineManager.startupExceptionCode(it)
            } ?: EngineManager.REFUSAL_RUNTIME_UNAVAILABLE
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
                UiText.t(activity, "运行时更新失败", "Runtime update failed"),
                // 缺陷 D（fx-2）：这两个显式 hint 会**覆盖** defaultHint，所以安全模式引导
                // 必须在这里也带上——否则「运行时更新失败」屏的按钮已改成安全模式入口，
                // 文案却还在让人「重试」，两者对不上。
                startupFailureHint(activity, activity.engineManager.lastStartRefusalCode) + "\n" +
                  diagnosticsLocationHint(dir) +
                  UiText.t(activity, "。可复制该路径，或打开控制台查看 engine.log。",
                    ". Copy that path, or open the console to read engine.log.") +
                  activity.getString(R.string.ds_safe_hint_short),
              )
              activity.showGuide()
            }
            return@Thread
          }
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, UiText.t(activity, "正在启动引擎…", "Starting the engine…"))
          }
        }
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      // issue #684：让行与失败必须分开 ——「刷新中让行」没有进程，不能进存活判据、不能计重试预算。
      // 旧实现把它当 true（已发起），于是存活判据当拍为假，一次正常的 8-12 分钟刷新被误判成
      // 「进程在预算内死亡」，两次重试后落持久修复门。
      val startOutcome = activity.engineManager.startEngine()
      if (startOutcome == EngineStartOutcome.DEFERRED_REFRESHING) {
        LogCollector.writeBootFail(
          activity, "engine-start-deferred-refresh",
          "本次启动请求撞上正在进行的快照刷新，已让行（非失败）：未 spawn、未置 STARTING、未计重试预算；"
            + "由持有刷新的启动流在完成后拉起引擎。",
        )
        return@Thread
      }
      if (startOutcome == EngineStartOutcome.REFUSED) {
        requireCurrentEngineFlow(generation)
      // A Hard ownership mismatch is itself an install/runtime integrity failure.
      // There is no separate UI retry state that can resolve it: the assistant
      // reads the actual archive and profile through native tools.
      if (activity.engineManager.lastStartRefusalCode == EngineManager.REFUSAL_HARD_BUNDLE_SELECTION) {
        // issue #657：这条 early return 此前跳过了下面的失败落盘，于是「Hard 清单缺失」
        // 这种用户无法自行诊断的拒启，成了唯一不在 boot-fail.log 留痕的启动失败。
        //
        // 落盘已**下沉**到 EngineManager.startEngine() 的统一收口 refuse()（7 条出口全走它），
        // 所以这里不再重复写——设备实测过重复版本会一次拒启写两条同 stage 记录，
        // 反而让 boot-fail.log 的条数失真。此处只保留「转交原生修复」这层语义。
        requireNativeRepair()
        return@Thread
      }
        // 任务 19：失败终态落盘（此前这条路径**零落盘**——用户反馈第一条的真因）。
        //
        // issue #271 ④：区分「被前置条件拒绝」与「spawn 真失败」。半搬态（live 树缺 node）
        // 属于前者：不再空等 90s 预算，直接以可归因的原因收口，用户看到的不再是
        // 「进程在 90s 预算内死亡」这种无指向的结论。
        val refusal = activity.engineManager.lastStartRefusal
        val refusalCode = activity.engineManager.lastStartRefusalCode
        LogCollector.writeBootFail(
          activity, if (refusal != null) "engine-start-refused" else "engine-start-false",
          // issue #720：布尔时代的口径（"返回 false"）已随三态契约作废，落盘文案必须说清是哪一态。
          "EngineManager.startEngine() 判为 REFUSED（引擎未 spawn，原因见 refusalCode）"
            + (refusalCode?.let { "；refusalCode=" + it } ?: "")
            // issue #309：把**判别性事实**（确诊项有几个）也写进 boot-fail，而不是只写进
            // LogCollector.log——后者只有采集器在跑时才落盘（独立评审 C6 指出的可诊断性缺口）。
            // 这一格正是「自动路径为什么没动」的唯一线索：空 = 只有低置信度条目命中。
            + (refusalCode?.let { "；confirmed=" + activity.engineManager.lastStartRefusalConfirmed.joinToString(",") } ?: "")
            + (refusal?.let { "；refusal=" + it } ?: ""),
        )
        // issue #309：解开闸门 A / 闸门 B 的互锁。
        //
        // 互锁形态（源码级确证）：闸门 A（liveRuntimeComplete，spawn 之前）拒启 ⇒ 不 spawn
        // ⇒ engine.log 永不产生 ⇒ 闸门 B（maybeSelfHealDamagedRuntimeTree 读 engine.log 尾部
        // 找 CANNOT LINK）判据恒为假 ⇒ 自愈不可达。且 refreshSnapshot 全仓只有冷启动一个调用点，
        // 拒启路径为零；UI 的「重试」只清账本不删指纹（指纹新鲜时是 no-op）——自动与手动路径都为零，
        // 用户实测 36 次 / 47 分钟无任何恢复动作。
        //
        // 修法：拒启原因确为「live 树残缺」**且缺的是确诊项**时，删指纹 + 清账本，让下一次冷启动
        // 的 `if (!snapshotFresh())` 走完整重抽取。三处克制：
        //   ① 只在确诊项缺失时触发——REQUIRED_LIBS 成员可能是**传递依赖**误报（issue #309 明确
        //      告诫「不要贸然补全该表」，否则互锁会从「可人工救」升级为「只能清应用数据」），
        //      因此它们只记录、不触发；
        //   ② 复用 runtimeTreeHealedThisRun（每次 app 运行一次），不新增预算变量，
        //      因此不会引入「重抽取 → 再失败 → 再重抽取」死循环；
        //   ③ 不改闸门 A 的判据本身——带病的树仍然不被 spawn，安全性不变。
        // 预算用尽或缺的都是低置信度条目时如实停在错误页并留档，不假装已修复。
        if (refusalCode == EngineManager.REFUSAL_LIVE_RUNTIME_INCOMPLETE) {
          maybeRecoverFromIncompleteLiveRuntime(
            activity,
            confirmedMissing = activity.engineManager.lastStartRefusalConfirmed,
          ) { isCurrentEngineFlow(generation) }
        }
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, UiText.t(activity, "引擎启动失败", "Engine failed to start"), startupFailureHint(activity, refusalCode))
          activity.showGuide()
        }
        // A foreign listener cannot be repaired by changing this app's profile or ownership.
        if (refusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return@Thread
        // #118 建议7：失败不清零计数时自动重试（Error 页不再需要手动点重试）。
        scheduleEngineRetry(generation)
        return@Thread
      }
      // Poll for the web service with process-alive semantics (0.13.0 D1): cold boot takes
      // 20-45s (EngineManager START_COOLDOWN_MS comment); the old hard 30s budget fired
      // "引擎启动超时" on slow devices (K20 Pro) even though the engine later started.
      // A concurrent manager can accept the spawn CAS before publishing its child. Wait for
      // that preparation too, within the same budget; only neither alive nor preparing is DEAD.
      // UI shows a grey "still starting" state.
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
        requireCurrentEngineFlow(generation)
        if (probe.optString("auth") == "required") {
          // A startup probe is not ownership evidence by itself: an unrelated local
          // listener can also answer 401. Reuse the same exact-origin/main-frame
          // policy before clearing or refreshing any cookie state.
          val availability = activity.engineManager.probeAvailability()
          requireCurrentEngineFlow(generation)
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
          requireCurrentEngineFlow(generation)
          try { FileIncoming.flushPending(activity) } catch (_: Throwable) {}
          break
        }
        if (!activity.engineManager.engineBootMayContinue()) {
          // 没有存活进程且没有其它 manager 的启动准备请求：此时才确认死亡。
          // 引擎进程已死：宣判失败（自动回退路径），不再空等。
          break
        }
        val clock = engineBootClock(pollBudgetMs - (budgetEnd - System.currentTimeMillis()))
        if (engineBootShouldReport(clock.waitedSeconds)) {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Starting, engineBootProgressText(clock, UiText.isEnglish(activity)))
          }
        }
        Thread.sleep(pollStepMs)
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (!booted && !activity.engineManager.engineBootMayContinue()) {
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
        requireCurrentEngineFlow(generation)
        maybeSelfHealDamagedRuntimeTree(activity) { isCurrentEngineFlow(generation) }
        // 0.13.1 W3：进程死亡现场镜像到共享目录（含退出码），用户可直接取包反馈。
        // review C5：文案按实际落点回填（共享不可写时回落私有目录）。
        requireCurrentEngineFlow(generation)
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
        // #118 建议7：进程死亡路径同样自动重试（可自愈的瞬时失败不必停在错误页）。
        scheduleEngineRetry(generation)
        return@Thread
      }
      if (booted) {
        // task-79：启动成功 ⇒ 清掉「运行时树损坏」标记（若不成功，标记留着供诊断与后续决策）。
        clearRuntimeTreeDamageMarker(activity) { isCurrentEngineFlow(generation) }
        requireCurrentEngineFlow(generation)
        startEngineService()
        applyShizukuKeepAlive(generation)
        activity.runOnUiThread { if (isCurrentEngineFlow(generation)) activity.showWeb() }
      } else {
        // 进程还活着或另一路仍在准备，但 90s 内未就绪（异常慢）：灰色提示而非红色错误，不触发回退——
        // 引擎仍在启动，3s engineMonitorRunnable 会兜底切界面。
        // 0.13.8 #175：终点不再「只提示」——安排一次自动重试（DEGRADED_HTTP 阶梯随后
        // 兜底：若 HTTP 持续失败而端口可连，看门狗会受控重启，不再永久停留灰字）。
        // 任务 19：这条路径正是设备实测「44 次 boot-start 未到 listen」的形态之一——
        // 它此前**只写一行 log 且不落盘**（log 只在调试采集器开启时才写），必须进失败终态。
        LogCollector.writeBootFail(
          activity, "boot-budget-exceeded",
          "引擎进程存活或启动请求仍在准备，但 " + ENGINE_BOOT_BUDGET_MS / 1000 + "s 预算内 Web 端口未就绪（t_listen=-1 形态）",
        )
        LogCollector.log("dsh-shell", "engine boot window exceeded 90s; scheduling retry (half-dead ladder will take over if HTTP stays failing)")
        scheduleEngineRetry(generation)
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Starting, UiText.t(activity, "引擎启动较慢（已超过 90s），已安排自动重试…", "Engine startup is slow (over 90s); an automatic retry is scheduled…"))
        }
      }
      return@Thread
      } catch (t: Throwable) {
        if (!isCurrentEngineFlow(generation) || t is java.util.concurrent.CancellationException || t is InterruptedException) return@Thread
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
        activity.engineManager.lastStartRefusalCode = activity.engineManager.startupExceptionCode(t)
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Error, "引擎启动失败",
            startupFailureHint(activity, activity.engineManager.lastStartRefusalCode))
          activity.showGuide()
        }
      } finally {
        token.detach(Thread.currentThread())
        flowOwnership.finish(token)
        RepairState.startupInProgress = false
      }
    }
    token.attach(caller)
    caller.start()
  }

  /**
   * P1：`flowOwnership.begin()` 拿不到所有权时的**如实处置**（定位报告 §2.3）。
   *
   * `begin()` 返回 null 有两种原因，且语义相反，**必须分开**：
   *  - `destroyed`：Activity 已销毁 / 进程整体关停 —— 保持「不启动」（原来那个 return 是对的）；
   *  - `running`：**另一次启动流或快照刷新正在跑**（刷新期间 `running` 恒为 true，
   *    `finish(token)` 只在启动线程的 finally 里执行；见 EngineStartFlow.kt:1117）——
   *    此时静默 return 就是缺陷本体：不 spawn、不改相位、不落盘，用户与排障者都看不到痕迹。
   *
   * 处置：① 一定留一行**进 boot-fail.log** 的落痕。不走 `LogCollector.log` 就完事：它的 sink 受
   * `DevLogPrefs` 门控且默认关闭，`dsh-day.log` 恒 absent，等于没留痕（报告 §4 可观测性缺口）；
   * ② 有快照事务在场时起一个**有界等待者**（[deferredStartRunnable]），等事务收口**且**所有权
   * 空出来再自动续跑一次 [start]。
   *
   * 判据用**跨进程真源** journal 文件而不是 `flowOwnership.running`：后者只是本 Activity 实例的
   * 内存态（MainActivity 未声明 launchMode，新实例会绕过它），journal 才是「刷新真的在跑」的事实。
   */
  private fun deferEngineStartWhileSnapshotTransactionBusy() {
    if (flowOwnership.destroyed) return // 生命周期终结：保持不启动，不等待、不留痕。
    if (!canRunEngineWork()) return
    engineMonitorHandler.removeCallbacks(deferredStartRunnable)
    val marker = SnapshotTransaction.readMarker(activity.filesDir)
    LogCollector.log("dsh-shell", "engine start deferred: another start flow or a snapshot refresh owns the generation")
    if (marker == null) {
      // 所有权被占、但没有任何快照事务在场（典型是同一实例里上一次启动流的收尾还没跑完）。
      //
      // **0.14.10 缺陷修复（审计 §6.1）**：旧实现在这里只写一行 boot-fail 就 return，文案还宣称
      // 「下一次入口会重试」——而实际上没有任何自动续跑。现场证据：新机 boot-fail.log 里
      // `engine-start-deferred-no-transaction` 反复出现，采样期间仍在新增——每一次都意味着
      // 一次**被静默丢弃**的启动请求（用户按了按钮 / 回到前台，引擎却没起来）。
      //
      // 现在改为**有界自动重试**（[NO_TRANSACTION_RETRY_*]）：所有权是上一次启动流的收尾在占，
      // 它通常几十毫秒内就会 `finish()`。按 200ms 步进重试数秒，成功即续跑 start()；预算用尽
      // 则如实记一条 timeout（**不**判失败、不改相位——用户看到的仍是「正在启动引擎…」）。
      //
      // 与上面「有快照事务在场」那条**不是同一个等待者**，两者刻意分开：
      //  - 事务在场：等的是**跨进程的 8-12 分钟解压**，判据是 journal 文件，预算 16 分钟；
      //  - 无事务：等的是**本实例上一次启动流的收尾**，判据是 flowOwnership，预算数秒。
      // 把它们并成一个（例如复用 deferredStartRunnable 的 16 分钟预算）会让「上一次流收尾慢了」
      // 这种秒级情形也挂上 16 分钟等待者，用户点到按钮后毫无反馈。
      LogCollector.writeBootFail(
        activity, "engine-start-deferred-no-transaction",
        "启动请求未获世代所有权（另一次启动流仍在占用），且无快照事务在场：本次请求未被受理，未拉起引擎；"
          + "已安排按 " + NO_TRANSACTION_RETRY_STEP_MS + "ms 步进、上限 " + NO_TRANSACTION_RETRY_BUDGET_MS
          + "ms 的自动重试，取得所有权后自动续跑。",
      )
      noTransactionRetry.attempts = 0
      engineMonitorHandler.postDelayed(noTransactionRetry, NO_TRANSACTION_RETRY_STEP_MS)
      return
    }
    LogCollector.writeBootFail(
      activity, "engine-start-deferred",
      "启动请求撞上正在进行的快照刷新，已转为有界等待（**非**静默丢弃）：事务 phase="
        + (marker.phase.name) + "，帐龄(自述)="
        + snapshotTransactionAccountedAgeMs(marker, System.currentTimeMillis()) / 1_000 + "s，预算 "
        + SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS / 60_000 + " 分钟；事务收口后自动续跑一次启动。",
    )
    engineMonitorHandler.postDelayed(deferredStartRunnable, SNAPSHOT_TRANSACTION_WAIT_POLL_STEP_MS)
  }

  /**
   * P1 的有界等待者：**事务收口 且 世代所有权空出来** ⇒ 自动续跑一次 [start]。
   *
   * 为什么等两个条件而不是只等事务：所有权由上一次启动流的 worker 持有（刷新就发生在它内部），
   * 事务收口后它还要跑完 spawn/轮询那一段才 `finish(token)`。只等事务会在所有权还没空出来时
   * 续跑一次，又撞回 L700 —— 那只是把静默丢弃换成忙等。
   *
   * 有界性：累计等待到 [SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS] 即落一条如实 timeout 痕迹后收手
   * （**不判失败**、不显示成故障：事务仍在跑时用户看到的是同一句「正在以安全模式重启运行时…」）。
   */
  private val deferredStartRunnable = object : Runnable {
    private var waitedMs = 0L
    override fun run() {
      if (!canRunEngineWork()) { waitedMs = 0L; return }
      val transactionBusy = SnapshotTransaction.readMarker(activity.filesDir) != null
      if (!transactionBusy && !flowOwnership.running) {
        waitedMs = 0L
        LogCollector.log("dsh-shell", "deferred engine start resuming: snapshot transaction settled and ownership is free")
        start()
        return
      }
      if (waitedMs >= SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS) {
        waitedMs = 0L
        LogCollector.writeBootFail(
          activity, "engine-start-deferred-timeout",
          "启动请求在 " + SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS / 60_000 + " 分钟等待预算内仍未取得世代所有权"
            + "（快照事务在场=" + transactionBusy + "）：本次启动请求未执行，也未拉起引擎；"
            + "事务仍在解压时可稍后重试或改用重启应用。",
        )
        return
      }
      waitedMs += SNAPSHOT_TRANSACTION_WAIT_POLL_STEP_MS
      engineMonitorHandler.postDelayed(this, SNAPSHOT_TRANSACTION_WAIT_POLL_STEP_MS)
    }
  }

  /**
   * 审计 §6.1 的有界重试者：**无快照事务在场、但世代所有权被占**时，按秒级预算等所有权空出来。
   *
   * 与 [deferredStartRunnable] 的边界（两者**不得**合并，判据 / 预算 / 等的东西全都不同）：
   *  - 本等待者：等**本实例上一次启动流的收尾**（`flowOwnership.running`）。它是内存态，
   *    通常几十毫秒内就结束；预算必须小（[NO_TRANSACTION_RETRY_BUDGET_MS]），否则用户点完按钮
   *    要对着「正在启动引擎…」空等；
   *  - [deferredStartRunnable]：等**跨进程的快照事务**（journal 文件 + 所有权），对应 8-12 分钟
   *    的解压，预算 16 分钟（[SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS]）。
   *
   * 判据仍是所有权本身而不是时间：一旦 `!flowOwnership.running` 就续跑 [start]（它会自己再抢
   * 一次 `begin()`，抢不到会重新落到这条路径，不存在「偷偷绕过所有权」）。
   * destroyed / running 语义完全保持：destroyed 立即收手（不启动）；每次重试都先过
   * [canRunEngineWork]，与 [start] 入口同一道闸门。
   */
  private val noTransactionRetry = object : Runnable {
    /** 已走过的拍数（累计等待 = 拍数 × 步进）。 */
    internal var attempts = 0
    override fun run() {
      // 事务在期间出现时也要能转交给 16 分钟那条等待者，所以先读 journal（跨进程真源）。
      val decision = decideNoTransactionRetry(
        canRun = canRunEngineWork(),
        transactionPresent = SnapshotTransaction.readMarker(activity.filesDir) != null,
        ownershipRunning = flowOwnership.running,
        attempts = attempts,
      )
      when (decision) {
        DeferredStartRetryDecision.STOP -> { attempts = 0; return }
        DeferredStartRetryDecision.HAND_OVER_TO_TRANSACTION_WAIT -> {
          attempts = 0
          LogCollector.log("dsh-shell", "no-transaction retry handing over to the transaction waiter")
          deferEngineStartWhileSnapshotTransactionBusy()
          return
        }
        DeferredStartRetryDecision.RESUME -> {
          attempts = 0
          LogCollector.log("dsh-shell", "deferred engine start resuming: generation ownership is free")
          start()
          return
        }
        DeferredStartRetryDecision.TIMEOUT -> {
          attempts = 0
          LogCollector.writeBootFail(
            activity, "engine-start-deferred-no-transaction-timeout",
            "启动请求在 " + NO_TRANSACTION_RETRY_BUDGET_MS + "ms 重试预算内仍未取得世代所有权"
              + "（另一次启动流仍在占用，且始终无快照事务在场）：本次启动请求未执行，也未拉起引擎；"
              + "下一次入口（点按钮 / 回前台探活）会再次尝试。",
          )
          return
        }
        DeferredStartRetryDecision.RETRY -> {
          attempts++
          engineMonitorHandler.postDelayed(this, NO_TRANSACTION_RETRY_STEP_MS)
        }
      }
    }
  }

  private fun canRunEngineWork(): Boolean =
    !flowOwnership.destroyed && !activity.isDestroyed && !activity.isFinishing && !activity.userClosedEngine &&
      !EngineService.userShutdown && !RepairState.active && !Thread.currentThread().isInterrupted

  /** Also rejects completion callbacks after destruction or global user shutdown. */
  private fun isCurrentEngineFlow(generation: Long): Boolean =
    canRunEngineWork() && flowOwnership.isCurrent(generation)

  private fun requireCurrentEngineFlow(generation: Long) {
    if (!isCurrentEngineFlow(generation)) throw java.util.concurrent.CancellationException("obsolete engine startup caller")
  }

  /** Cancel this Activity's callers, never the process-wide root maintenance worker. */
  fun destroy() {
    updateUiGeneration++
    flowOwnership.invalidate(destroy = true)
    stopMonitoring()
    engineMonitorHandler.removeCallbacksAndMessages(null)
  }

  /** Run the runtime snapshot update; status mirrored to a file for adb verification. */
  fun runUpdate() {
    if (!OnlineUpdateGate.begin()) return
    val updateGeneration = ++updateUiGeneration
    val statusFile = File(activity.filesDir, "update-status.txt")
    val manager = UpdateManager(activity)
    manager.checkAndApply { st ->
      activity.runOnUiThread {
        if (updateGeneration != updateUiGeneration || !canRunEngineWork()) return@runOnUiThread
        // 与 startUpdateCheck 同口径（0.14.1 批 2 / P0-2）：相位由**类型**决定，不猜字符串前缀。
        val phase = when (st.outcome) {
          UpdateManager.UpdateOutcome.NotConfigured -> GuidePhase.Info
          UpdateManager.UpdateOutcome.Failed -> GuidePhase.Error
          UpdateManager.UpdateOutcome.Done -> GuidePhase.Recovering
          UpdateManager.UpdateOutcome.Working, UpdateManager.UpdateOutcome.Verifying -> GuidePhase.Updating
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

  private val foregroundServiceStartQueued = java.util.concurrent.atomic.AtomicBoolean(false)

  /** Request foreground protection after the current Activity lifecycle callback returns. */
  fun startEngineService() {
    if (!canRunEngineWork() || flowOwnership.destroyed || EngineService.instance != null) return
    if (!foregroundServiceStartQueued.compareAndSet(false, true)) return
    // Requesting during onResume starts Android's service deadline while the same
    // main thread is still restoring views, overlays and picker state. Queue the
    // request itself so those synchronous lifecycle tasks finish before it starts.
    activity.window.decorView.post {
      foregroundServiceStartQueued.set(false)
      if (!canRunEngineWork() || flowOwnership.destroyed || activity.isFinishing ||
        activity.isDestroyed || EngineService.instance != null) return@post
      try {
        activity.startForegroundService(Intent(activity, EngineService::class.java))
      } catch (_: Exception) {
        // Foreground-service start limits: service will start on next launch.
      }
    }
  }

  /** Best-effort Shizuku keep-alive boost; outcome logged only. */
  private fun applyShizukuKeepAlive(generation: Long) {
    val token = flowOwnership.tokenFor(generation) ?: return
    if (!isCurrentEngineFlow(generation)) return
    try {
      val caller = Thread {
        try {
          if (!isCurrentEngineFlow(generation)) return@Thread
          val result = ShizukuSupport.status(activity)
          if (isCurrentEngineFlow(generation)) Log.i("dsh-shizuku", result)
        } finally { token.detach(Thread.currentThread()) }
      }
      token.attach(caller)
      caller.start()
    } catch (_: Throwable) {
    }
  }

  /**
   * D3（0.14.6）：**安全模式启动**的重启动作——先停本壳托管的旧引擎，再走正常启动流。
   *
   * ## 为什么必须有它（真机缺陷链）
   * `GuidePageRenderer.enterSafeMode()` 此前只调 `activity.startEngineFlow()`。那条路先探活，
   * 探到旧引擎仍在（OUR_PROCESS / OUR_HTTP）就 early-return 并 `showWeb()`——**从不经过**
   * EngineManager.startEngine，于是「快照新鲜度」与「live 树完整性」两道既有闸门一次都不执行。
   * 后果正是用户现场：点「安全模式启动」后 UI 看似拉起，却仍是**旧进程服务旧 manifest**
   * （清单里还含刚被摘掉的第三方插件条目），页面再次报同样的插件失败，随后一连串报错；
   * 安全模式这一改**根本没生效**。与 0.14.4 已修的 DEVICE-FINDING-3（startEngine 不带 force ⇒
   * 早退 ⇒ 继续服务旧 manifest）是同一形态，只是这次发生在安全模式这条路径上。
   *
   * ## 复用的既有机制（不新造停止语义）
   * - 停止：[EngineManager.stopOwnedEngine]——只停**本壳持有句柄**的子进程，绝不按名字杀未归属监听器；
   * - 判据：[safeModeRestartDecision]（纯函数，JVM 可反证），live 完整性 / 快照就绪 / 归属权
   *   三种输入各走一条明确结论；
   * - 启动：仍旧 `activity.startEngineFlow()`，**不绕过**，两道既有闸门照常各过一遍。
   *
   * ## 中间态如实（D4）
   * 旧进程已停、新进程未起这段窗口**不得**显示成已就绪：先切 `Starting` 相位并给如实文案。
   * 被拒的两条路径必须说清「安全模式的插件改动本次不生效」，并照写 boot-fail——
   * 既不静默失败，也不隐藏真实失败（D5）。
   *
   * 停失败（`stopOwnedEngine()` 返回 false）的处理与 [restart] 一字不差：不继续、如实回执。
   */
  internal fun restartOwnedEngineForSafeMode() {
    if (!canRunEngineWork()) return
    // **必须离开 UI 线程**：本方法由 GuidePageRenderer.enterSafeMode 的 postDelayed 在**主线程**上调用，
    // 而下面每一步都有真实阻塞——liveRuntimeComplete() 遍历运行时树（文件系统 IO）、
    // stopOwnedEngine() 内含最长 1s 的端口/归属探活。原地调用就是一条真实的 ANR 路径
    // （与 enterSafeMode 里 maybeRecoverFromIncompleteLiveRuntime 的同一教训）。
    Thread {
      try {
        performSafeModeRestart()
      } catch (t: Throwable) {
        Log.e("dsh-shell", "safe mode restart failed", t)
        LogCollector.writeBootFail(activity, "safe-mode-restart-failed",
          "安全模式重启线程抛出未捕获异常：" + t.javaClass.simpleName + ": " + (t.message ?: "无消息"), t)
      }
    }.apply { isDaemon = true; name = "dsh-safe-mode-restart" }.start()
  }

  /** [restartOwnedEngineForSafeMode] 的线程体（**非 UI 线程**；判据与动作都在这里）。 */
  private fun performSafeModeRestart() {
    if (!canRunEngineWork()) return
    val engine = activity.engineManager
    // P1（定位报告 §2.3/§7）：**动任何东西之前**先看快照事务是否正在进行（跨进程真源
    // = 事务 journal 文件，比本 Activity 实例的内存态客观——MainActivity 未声明 launchMode，
    // 新实例会绕过 flowOwnership）。事务在场时先停旧引擎会把用户从「能跑但插件错」推到
    // 「8-12 分钟没有引擎」，正是社区现象「点了安全模式、引擎没起来」。故此处**一步都不动**，
    // 只如实回执 + 有界等待事务收口，收口后再走同一条「先停旧、再起新」。
    if (SnapshotTransaction.readMarker(activity.filesDir) != null) {
      awaitSnapshotTransactionThenRestartSafeMode()
      return
    }
    val liveComplete = engine.liveRuntimeComplete()
    val snapshotFresh = engine.snapshotFresh()
    // 归属权在「停」之前只能由 stopOwnedEngine 的真实返回值回答（它内含探活 + 句柄判定），
    // 故这里先按 live/快照面判一次；归属失败在下一次判定中收口（见下方 stopOk）。
    val preDecision = safeModeRestartDecision(liveComplete, snapshotFresh, ownedStopOk = true)
    if (!safeModeRestartCanProceed(preDecision)) {
      // live 树残缺：停掉旧进程只会把用户从「能跑但插件错」推到「跑不了」，故**一步都不动**。
      LogCollector.writeBootFail(
        activity, "safe-mode-restart-refused",
        "安全模式重启被拒（decision=" + preDecision + "）：live 运行时树不完整，未停止也未重启引擎；" +
          "安全模式的插件改动本次不生效。停在可读错误页",
      )
      activity.runOnUiThread { applySafeModeRestartHint(preDecision) }
      return
    }
    // 中间态：旧进程即将停止 / 新进程尚未就绪——**不得**显示成已就绪。
    activity.runOnUiThread {
      if (canRunEngineWork()) applySafeModeRestartHint(preDecision)
    }
    val stopped = try { engine.stopOwnedEngine() } catch (t: Throwable) {
      LogCollector.writeBootFail(activity, "safe-mode-restart-stop-failed",
        "安全模式重启：停止旧引擎时抛出 " + t.javaClass.simpleName + ": " + (t.message ?: "无消息"), t)
      false
    }
    if (!stopped) {
      // 端口未被归属到本壳（或停止失败）：**绝不**继续 spawn，否则等于盲目重启一个不属于我们的监听器。
      val decision = safeModeRestartDecision(liveComplete, snapshotFresh, ownedStopOk = false)
      LogCollector.writeBootFail(
        activity, "safe-mode-restart-not-owned",
        "安全模式重启被拒（decision=" + decision + "）：" + EngineProbe.ENGINE_AUTHORITY + " 未被归属到本壳或旧引擎停止失败，" +
          "未执行启动以免覆盖未知监听器；安全模式的插件改动本次不生效",
      )
      activity.runOnUiThread { applySafeModeRestartHint(decision) }
      return
    }
    // 归零既有账本：用户显式要求「以 safe 状态运行」，就该真的发起一次启动尝试，
    // 而不是被上一次失败的降级闸门挡住（与手动重试同口径）。
    engineRetryCount = 0
    engine.clearRefreshLedger()
    // P2（定位报告 §4/§7）：**成功/进入面**留痕。既有四个失败 stage（refused / not-owned /
    // stop-failed / failed）都在失败分支上，成功面此前只写 LogCollector.log——而采集器默认关
    // （DevLogPrefs 默认 false），dsh-day.log 恒 absent ⇒ 安全模式重启的成功面在诊断包里
    // 完全不可见，这正是社区反馈「查不出真因」的直接原因。本 stage 是**进入面**（不是失败面）：
    // 它与那四个失败 stage 组成两面对照。D3 验收脚本 verify-d3-safemode-restart.mjs 的 C4
    // 判据用的是通配 safe-mode-restart-*，本 stage 命中该通配是**刻意的**——但读的人不得据此
    // 把它当失败记录判红（脚本自身把它归在「失败面补充证据」一列，不参与判红）。
    LogCollector.writeBootFail(
      activity, "safe-mode-restart-started",
      "安全模式重启进入启动流（decision=" + preDecision + "）：本壳托管的旧引擎已停，正以安全模式清单重建运行时",
    )
    LogCollector.log("dsh-shell", "safe mode restart: owned engine stopped, starting with the safe profile (decision=" + preDecision + ")")
    activity.startEngineFlow()
  }

  /**
   * P1：快照事务进行中的安全模式重启——**不丢弃、不谎报成功、不先停旧引擎**。
   *
   * 为什么不能先停：定位报告 §3 的 M2 与 §2.4 说明，刷新一旦开始就必然跑完（解压路径不响应
   * 线程中断），实测 8-12 分钟。先停旧引擎会让用户在这段时间里**完全没有引擎**——界面上就是
   * 社区反馈的那一幕「点了安全模式，引擎没起来」。故这里等事务收口**之后**才走
   * [performSafeModeRestart] 的既有「先停旧、再起新」。
   *
   * 有界性（见 [awaitSnapshotTransactionSettled]）：16 分钟硬预算 + 1s 步进。预算依据 =
   * 报告 §3 的全量重解压实测上限 12 分钟（8-12 分钟区间），留 4 分钟余量覆盖换树 + 收尾
   * （提交点是「先写指纹、后清 marker」，Lead 实测该窗口本身约 25s）。超预算**不当失败**：
   * 事务仍在跑时如实落一条 timeout 痕迹并复用同一相位文案，让用户知道还在等而不是坏了。
   */
  private fun awaitSnapshotTransactionThenRestartSafeMode() {
    val engine = activity.engineManager
    val liveComplete = engine.liveRuntimeComplete()
    val snapshotFresh = engine.snapshotFresh()
    // 只读的预判：live 树残缺时**一步都不动**（与既有的 [safeModeRestartCanProceed] 同源），
    // 停滞在这里等一个注定会被拒的重启毫无意义——如实回执比空等更负责。
    val preDecision = safeModeRestartDecision(liveComplete, snapshotFresh, ownedStopOk = true)
    // 事务自述的相与账龄（纯读，不猜）：用户可见文案与 boot-fail 记录**同一份**，避免两处口径漂移。
    val marker = SnapshotTransaction.readMarker(activity.filesDir)
    val waitText = snapshotTransactionWaitText(
      marker?.phase?.name ?: "unknown",
      snapshotTransactionAccountedAgeMs(marker, System.currentTimeMillis()),
      UiText.isEnglish(activity),
    )
    // 如实相位：此刻**旧引擎仍在跑**（我们还没停），事务也在跑。不得出现「已就绪」。
    activity.runOnUiThread {
      if (canRunEngineWork()) applySafeModeRestartHint(preDecision, waitText)
    }
    LogCollector.log("dsh-shell", "safe mode restart deferred: snapshot transaction in progress (decision=" + preDecision + ")")
    LogCollector.writeBootFail(
      activity, "snapshot-transaction-wait",
      waitText + "（安全模式重启已推迟，非静默丢弃；decision=" + preDecision
        + "）事务收口后自动继续「先停旧引擎、再以安全模式清单重建」",
    )
    val settled = awaitSnapshotTransactionSettled(
      transactionActive = { SnapshotTransaction.readMarker(activity.filesDir) != null },
      current = { canRunEngineWork() },
    )
    if (!settled) {
      LogCollector.writeBootFail(
        activity, "snapshot-transaction-wait-failed",
        "快照事务在 " + SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS / 60_000 + " 分钟预算内仍未收口（或已换代/销毁）："
          + "安全模式重启本次未执行，安全模式的插件改动本次不生效；事务仍在解压时不建议重复操作，"
          + "可稍后重试或改用重启应用。",
      )
      return
    }
    if (!canRunEngineWork()) return
    // 事务已收口：按同一判据重算一次（live/快照在等待期间可能已变），再走既有的先停后启。
    performSafeModeRestart()
  }

  /**
   * 安全模式重启的如实回执（相位 + 文案），保证「停旧起新」窗口不被显示成已就绪。
   *
   * @param extraHint 附加的如实说明（可为 null）。P1 的事务等待路径用它承载
   *   [snapshotTransactionWaitText]——那一段回答的是「为什么在等、还要等多久」，与
   *   [safeModeRestartDecision] 的判定面是两个维度，故**不并进** [safeModeRestartHint] 的取值域。
   */
  private fun applySafeModeRestartHint(decision: SafeModeRestartDecision, extraHint: String? = null) {
    val hint = safeModeRestartHint(decision, UiText.isEnglish(activity)) + (extraHint?.let { "\n" + it } ?: "")
    when {
      safeModeRestartCanProceed(decision) ->
        // 放行面：明确的中间态（旧引擎停止中或已停、新引擎未就绪），相位必须是 Starting 而不是任何就绪态。
        activity.applyGuidePhase(GuidePhase.Starting, UiText.t(activity, "正在以安全模式重启运行时…", "Restarting the runtime in safe mode…"), hint)
      else ->
        // 拒绝面：停在可读错误页（Error 相位保留「安全模式启动」出口，用户可再次尝试）。
        activity.applyGuidePhase(GuidePhase.Error, UiText.t(activity, "安全模式未能生效", "Safe mode did not take effect"), hint)
    }
    activity.showGuide()
  }

  /**
   * Restart only after the manager proves it can stop its tracked child. Foreign listeners are
   * left untouched and the subsequent spawn is not attempted.
   */
  fun restart(): Boolean {
    if (activity.isDestroyed || activity.isFinishing || flowOwnership.destroyed) return false
    if (!engineRestarting.compareAndSet(false, true)) return false
    flowOwnership.invalidate()
    val token = flowOwnership.begin()
    if (token == null) {
      // 同 start()：running（另一次启动/刷新在跑）不得静默丢弃，如实留痕 + 有界等待续跑。
      engineRestarting.set(false)
      deferEngineStartWhileSnapshotTransactionBusy()
      return false
    }
    val generation = token.generation
    activity.userClosedEngine = false // Explicit user restart, not a lifecycle callback.
    EngineService.setUserShutdown(activity, false)
    val caller = Thread {
      try {
        if (!isCurrentEngineFlow(generation)) return@Thread
        if (!activity.engineManager.stopOwnedEngine()) {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.showTestNotification("未重启引擎", activity.engineManager.lastStartRefusal ?: "端口监听未归属到本壳，未执行停止或启动")
          }
          return@Thread
        }
        if (!isCurrentEngineFlow(generation)) return@Thread
        // Only an explicit, ownership-proven user restart clears the legacy undo
        // suppression epoch. Automatic retries never take this path.
        UndoGate.clearRetryEpochForUserRestart(activity)
        EngineManager.lastStartAttemptAt = 0
        LogCollector.log("dsh-shell", "restart engine requested (tracked child only)")
        Thread.sleep(1000)
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.showTestNotification("引擎重启中", "已停止本壳托管进程，正在重新启动…")
          flowOwnership.finish(token)
          start()
        }
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      } finally {
        token.detach(Thread.currentThread())
        flowOwnership.finish(token)
        engineRestarting.set(false)
      }
    }
    token.attach(caller)
    caller.start()
    return true
  }
}

internal object OnlineUpdateGate {
  private val running = java.util.concurrent.atomic.AtomicBoolean(false)
  fun begin(): Boolean = running.compareAndSet(false, true)
  fun end() { running.set(false) }
}

/**
 * 诊断包落点的用户可见文案（review C5）：按**实际**镜像结果回填，绝不写死共享目录路径——
 * 未授权 All Files Access 的设备（issue #228 环境）会回落应用私有目录，用户按 Documents 路径找不到现场。
 */
internal fun diagnosticsLocationHint(dir: java.io.File?): String =
  if (dir == null) "诊断包落盘失败（共享与私有目录均不可写）" else "诊断包已存至 " + dir.absolutePath

/** Ownership preparation cannot authorize snapshot reads until maintenance has settled. */
internal fun startupOwnershipPending(reason: String): Boolean =
  reason == "root-maintenance-busy" || reason == "repair-result-unknown"

/** Pure generation/owner gate; cancellation targets only caller threads, never shared root workers. */
internal class StartupFlowOwnership {
  internal class Token(val generation: Long) {
    private val cancelled = java.util.concurrent.atomic.AtomicBoolean(false)
    private val callers = java.util.concurrent.ConcurrentHashMap.newKeySet<Thread>()
    fun attach(caller: Thread) {
      callers.add(caller)
      if (cancelled.get()) caller.interrupt()
    }
    fun detach(caller: Thread) { callers.remove(caller) }
    fun cancel() {
      cancelled.set(true)
      for (caller in callers) caller.interrupt()
    }
  }
  private data class State(val generation: Long = 0, val token: Token? = null, val running: Boolean = false, val destroyed: Boolean = false)
  private val state = java.util.concurrent.atomic.AtomicReference(State())
  val destroyed: Boolean get() = state.get().destroyed
  val running: Boolean get() = state.get().running

  fun begin(): Token? {
    while (true) {
      val before = state.get()
      if (before.destroyed || before.running) return null
      val token = Token(before.generation + 1)
      if (state.compareAndSet(before, State(token.generation, token, running = true))) {
        before.token?.cancel()
        return token
      }
    }
  }

  fun finish(token: Token) {
    while (true) {
      val before = state.get()
      if (before.token !== token || !before.running) return
      if (state.compareAndSet(before, before.copy(running = false))) return
    }
  }

  fun isCurrent(generation: Long): Boolean = state.get().let { !it.destroyed && it.generation == generation }
  fun tokenFor(generation: Long): Token? = state.get().token?.takeIf { it.generation == generation }

  fun invalidate(destroy: Boolean = false) {
    while (true) {
      val before = state.get()
      val after = State(before.generation + 1, destroyed = before.destroyed || destroy)
      if (state.compareAndSet(before, after)) { before.token?.cancel(); return }
    }
  }
}

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

// ── task-79（Bug A）+ issue #309：运行时树损坏 ⇒ 一次受控重抽取 ────────────────

/**
 * 本次 app 运行是否已经为「运行时树损坏」自愈过一次（进程内一次性，见 [RuntimeTree.maySelfHeal]）。
 *
 * 为什么是**进程内**标记而不是持久化：预算是「每次 app 运行最多一次」——用户重启 app 就是重新给一次机会，
 * 这与「每次启动都无限重抽取」有本质区别。持久化会让用户永远翻不了身。
 */
// 独立评审 C3：「读-判-写」三步并不原子，而它有两个真实并发来源——启动流的 worker 线程与
// EngineService 看门狗的 RESTART 拍（`EngineService.kt:319` 直接调 startEngine），两者可能
// 同时读到 false。后果本来无害（删指纹/清账本都幂等），但注释宣称「每次运行最多一次」，
// 那就让它**真的**只有一次：用 CAS 把「花掉预算」变成单次操作。
private val runtimeTreeHealedThisRun = java.util.concurrent.atomic.AtomicBoolean(false)

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
private fun maybeSelfHealDamagedRuntimeTree(activity: MainActivity, current: () -> Boolean) {
  if (!current()) return
  // 当拍读：engine.log 由 redirectOutput 每次 spawn 截断重写，晚一拍就读不到现场了。
  val tail = try { PluginMounts.readEngineLogTail(activity, 4_096) } catch (_: Throwable) { "" }
  if (!current() || !RuntimeTree.snapshotLinkFailure(tail)) return
  LogCollector.log("dsh-engine-start", "engine died from a dynamic-link failure; runtime tree is damaged")
  // CAS 即判定：抢输的那一拍直接认预算已花，不再重复删指纹/重抽取（避免重抽取死循环）。
  if (!runtimeTreeHealedThisRun.compareAndSet(false, true)) {
    // 预算用尽：不再删指纹/重抽取，停在可读错误页（既有 UI 已展示诊断包路径）。
    LogCollector.log("dsh-engine-start", "runtime tree damage: self-heal budget already spent this run; not re-extracting (avoid a re-extract loop)")
    return
  }
  try {
    if (!current()) return
    // ① 壳侧标记（不被引擎截断），供后续启动与诊断读取。
    java.io.File(activity.filesDir, RuntimeTree.DAMAGE_MARKER)
      .writeText(System.currentTimeMillis().toString() + (0x0A).toChar())
    // ② 删指纹 ⇒ 下次刷新走完整重抽取。
    val fp = java.io.File(activity.filesDir, ".snapshot-fingerprint")
    if (!current()) return
    if (fp.exists() && current()) fp.delete()
    // ③ 清账本（避免降级闸门在新局面下与新判据打架）。
    if (!current()) return
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
 * 做三件事（与 refreshSnapshot 失败**同族**的落盘面，但可见面不同）：
 *   ① `LogCollector.writeBootFail(code)` —— 结构化码，排障者 grep 这个码即可归类；
 *   ② 一次性标记文件 —— 供引擎 WebUI 就绪后**注入 DOM 提示**（可见面，见 MainActivity）；
 *   ③ 诊断包镜像 —— 用户可取包反馈。
 *
 * **恢复拒绝会阻断探活与启动**：启动流在发现未收敛事务后保留现场、显示持久的引导页 Error，
 * 并抛出 CancellationException 结束本轮；不能继续到 `applyGuidePhase(Starting, ...)` 或 `showWeb()`。
 * 这样用户可直接看到恢复入口提示，诊断码、一次性标记和诊断包仍用于后续排查与恢复。
 */
private fun reportRecoveryRejectionIfAny(activity: MainActivity, detail: String?, current: () -> Boolean) {
  if (!current()) return
  val notice = SnapshotRecoveryNotice.forRejection(detail) ?: return
  // ① 结构化落盘。
  LogCollector.writeBootFail(
    activity,
    notice.code,
    "快照恢复期拒绝回滚（code=" + notice.code + "）：" + (detail ?: ""),
  )
  // ② 一次性标记（注入成功后由 MainActivity consume）。
  if (!current()) return
  SnapshotRecoveryNotice.markPending(activity.filesDir, detail)
  // ③ 诊断包镜像（不切界面相位，理由见上方注释）。
  if (!current()) return
  activity.engineManager.mirrorDiagnosticsToShared(notice.code)
}

/**
 * issue #309：live 运行时树残缺时**唯一**的自动恢复动作（与闸门 B 共用同一份预算）。
 *
 * 为什么需要它：闸门 A 在 spawn 之前就拒启，因此 engine.log 根本不会产生，闸门 B 的判据
 * （读 engine.log 尾部的 CANNOT LINK / library not found）**结构性不可达**；而 refreshSnapshot
 * 全仓只有冷启动一个调用点，拒启分支为零、UI 的「重试」在指纹新鲜时是 no-op。结果是「live 树
 * 缺一条 soname 链」这种可自愈状态会把用户永久挡在错误页（issue 实测 36 次 / 47 分钟零恢复）。
 *
 * **两道闸门**（判定全在 RuntimeTree.allowStartRecovery，本函数只执行其结论，不自己发明条件）：
 *   ① 预算——复用 runtimeTreeHealedThisRun（每次 app 运行一次），不新增预算变量，
 *      因此不会引入「重抽取 → 再失败 → 再重抽取」死循环；
 *   ② 证据分级——confirmedMissing 为空时**自动路径**不动作。低置信度条目（REQUIRED_LIBS 成员）
 *      可能是传递依赖造成的假阴性，issue #309 明确告诫「不要贸然补全该表」；自动放宽等于把
 *      「可人工救」升级成「每次启动白付一次 8-12 分钟全量抽取并抹掉现场」。
 *      **唯一例外是用户显式动作**（userForced，错误页的错误态按钮）：自动路径的克制不能变成
 *      「用户连点一下都不行」——issue 现场用户只能靠壳侧终端手工补库，本 issue 的核心诉求
 *      正是「给闸门 A 加出口」。预算仍照旧约束他：一次之后仍失败就停手。
 *
 *      **如实声明其边界**（独立评审 C1/C2：不声明就等于又造一个「承诺不存在的动作」）：
 *      手动点击**不保证**产生动作，两种情况下它是**静默空操作**——
 *        · 本次运行已花过预算（自动路径先花掉了那一次）⇒ 日志写 budget already spent；
 *        · 根本没有 live 树残缺拒启（`lastStartRefusalCode` 不是该码）⇒ 调用方压根不进来。
 *      另外 userForced **不是**「强制启动」：它只放行证据分级去删指纹，spawn 仍由闸门 A 把关，
 *      即带病的树在重抽取完成前依然起不来（这是安全属性，不是缺陷）。
 *
 * 动作（与闸门 B 的自愈同形，避免两套口径）——顺序**不可换**：
 *   ① 写壳侧损坏标记（不被引擎截断，供后续启动与诊断读取）；
 *   ② 删 .snapshot-fingerprint（EngineManager.invalidateSnapshotFreshness）⇒
 *      下一次冷启动的 `if (!snapshotFresh())` 走完整重抽取；
 *   ③ 清刷新失败账本 ⇒ 避免降级闸门在新局面下用旧账打架；
 *   ④ 写一份**快照前**诊断镜像 ⇒ 拒启取证已在 boot-fail.log，这里补一份可整包取走的现场。
 *
 * **不做什么**（写清以免被当成漏做）：不改闸门 A 的判据，带病的树仍然不被 spawn；不在本函数内
 * 直接调 refreshSnapshot（那会把 2.5GB 解压塞进拒启分支的调用栈，且与冷启动路径争同一次刷新）；
 * 不承诺一次修好——预算用尽或证据不足时如实停在错误页，由用户手动「重试」再走一轮。
 * 与 #240 的降级闸门不冲突：下一次冷启动时 live 仍不完整 ⇒ shouldDegradeRefresh() 返回 false ⇒
 * 不会绕过这次刷新（删除指纹正是为了让那条路径真正走到 refreshSnapshot）。
 *
 * @param activity 宿主（用其 filesDir 与 engineManager）。
 * @param confirmedMissing 闸门 A 的**确诊缺失项**（EngineManager.lastStartRefusalConfirmed）。
 * @param userForced 真 = 用户在错误页显式要求重做运行时（放行证据分级，不放行预算）。
 * @param current 世代校验，恢复途中若已换代则立刻停手。
 */
internal fun maybeRecoverFromIncompleteLiveRuntime(
  activity: MainActivity,
  confirmedMissing: List<String>,
  userForced: Boolean = false,
  current: () -> Boolean,
) {
  if (!current()) return
  if (!RuntimeTree.allowStartRecovery(confirmedMissing, runtimeTreeHealedThisRun.get(), userForced)) {
    val reason = if (confirmedMissing.isEmpty() && !userForced) {
      "no confirmed missing entry (only low-confidence probes fired, so the automatic path stays put)"
    } else {
      "self-heal budget already spent this run"
    }
    LogCollector.log("dsh-engine-start", "live runtime incomplete (gate A): " + reason + "; staying at the readable error page")
    return
  }
  // 上面是纯判定（便于单测）；**这里是权威**：CAS 抢输说明另一条线程刚花掉了那一次，
  // 立刻收手，不得重复恢复。
  if (!runtimeTreeHealedThisRun.compareAndSet(false, true)) {
    LogCollector.log("dsh-engine-start", "live runtime incomplete (gate A): lost the one-shot budget race; staying at the readable error page")
    return
  }
  val evidence = confirmedMissing.joinToString(", ")
  LogCollector.log(
    "dsh-engine-start",
    "live runtime incomplete (gate A): clearing fingerprint so the next start re-extracts the runtime; confirmed=" + evidence,
  )
  // 每一步各自容错，且**任何一步失败都要留下可归因的落盘记录**：
  // 旧写法把整段包在一个 try 里，标记写盘一抛（独立评审 D6）就连一条 boot-fail 都没有，
  // 只剩一句 Log.w——这正是本 issue 反复出现的「失败现场不存在」的同形复发。
  val stepFailure = runCatching {
    java.io.File(activity.filesDir, RuntimeTree.DAMAGE_MARKER)
      .writeText(System.currentTimeMillis().toString() + (0x0A).toChar())
  }.exceptionOrNull()
  if (stepFailure != null) {
    Log.w("dsh-engine-start", "could not write runtime-tree damage marker", stepFailure)
  }
  if (!current()) return
  // 删指纹：即使上面的标记没写成，这一步仍是恢复动作的承重墙，必须继续尝试。
  val invalidated = activity.engineManager.invalidateSnapshotFreshness()
  if (!current()) return
  activity.engineManager.clearRefreshLedger()
  if (!current()) return
  // 独立评审 6(b)：删指纹**没成**时把预算**退回去**。
  //
  // 为什么必须退：预算的语义是「一次运行内最多重做一次运行时」，用来防止重抽取死循环；
  // 而 invalidation 失败意味着**根本没安排重做**（没有触发重抽取的载体）。此时若照样烧掉预算，
  // 自动路径与用户手动点击在本次运行内**双双失效**，用户被钉在错误页——比本 issue 修之前更糟
  // （修之前只是拒绝，现在变成「拒绝且连出口都烧了」）。退回是安全的：什么都没做，
  // 也就没有任何循环可防。
  if (!invalidated) runtimeTreeHealedThisRun.set(false)
  // 落盘文案必须**如实**反映真做成了什么：删不掉指纹时不能写「下次启动将走完整重抽取」，
  // 否则复现的是本 issue 第 5 条指出的同形缺陷（文案承诺一个并不存在的动作）。
  LogCollector.writeBootFail(
    activity,
    if (invalidated) "live-runtime-incomplete-recovery" else "live-runtime-incomplete-recovery-blocked",
    "闸门 A 拒启（live 运行时树残缺，确诊项：" + evidence + "）：" +
      if (invalidated) {
        "已删指纹并清刷新账本，下次启动将走完整重抽取；本次不 spawn"
      } else {
        "指纹删不掉（存储异常），无法安排重抽取；本次不 spawn"
      } + (stepFailure?.let { "；损坏标记写入失败=" + it.javaClass.simpleName } ?: ""),
  )
  if (!current()) return
  // 取证镜像放最后：它是最贵的一步（六代 engine.log + 有界 logcat 抽取），
  // 而且必须在**结果已定**之后取，否则镜像里的 start_refusal_* 还是上一次拒启的值
  // （独立评审 C7）。best-effort：失败不影响上面的结论。
  activity.engineManager.mirrorDiagnosticsToShared("live-runtime-incomplete")
}

/**
 * 启动**成功**时清掉损坏标记（Lead 裁决第 4 条：启动成功即清标记）。
 *
 * 为什么要清：标记的语义是「上次我们判定树坏了」。若树其实已经修好（重抽取成功），
 * 标记留着会让后续诊断误判、也可能让将来新增的读取方做出错误决策。
 * 只删文件，不改预算变量——预算按「每次 app 运行」计，不因成功而重置（同一次运行内不重复自愈）。
 */
private fun clearRuntimeTreeDamageMarker(activity: MainActivity, current: () -> Boolean) {
  if (!current()) return
  try {
    val marker = java.io.File(activity.filesDir, RuntimeTree.DAMAGE_MARKER)
    if (marker.exists() && current()) {
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

// ── CONTRACT §4：客户端插件装配失败的自动回滚路线（纯判据，JVM 可反证）──────────

/**
 * 自动回滚的路线（[clientPluginFailureRoute] 的取值域）。
 *
 * 三者互斥且穷尽：
 * - [CLIENT_PULL]    点出了唯一可拔条目 → 外科拔除（只动这一条）；
 * - [KNOWN_GOOD]     点不出名，但挂载清单与健康时的软清单一致 → 故障与插件清单无关，
 *                    才允许走 known-good 整份回滚（此时回滚不会吞掉任何用户插件）；
 * - [NO_ACTION]      其余一切 → 不动作（宁可停在可读错误页，也不做一次会抹掉用户插件的写回）。
 */
internal enum class ClientPluginFailureRoute { CLIENT_PULL, KNOWN_GOOD, NO_ACTION }

/**
 * 纯判据：给定唯一可拔候选与清单是否自健康起未变，决定自动回滚走哪条路（CONTRACT §4）。
 *
 * **本函数只决定是否调用 [UndoGate.execute]；安全护栏的真源在 UndoGate.execute，不得在此重复实施或绕过。**
 * 它不碰任何文件、不判硬清单/跨版本/快照在场——那些是 execute 的职责（Lead 仲裁 2026-10-05：两层判据
 * 不同源，route 层负责「该不该去动清单」并留下 NO_ACTION 留档，execute 负责「动清单的方式安不安全」）。
 *
 * 为什么必须把决策与执行分开：执行面（[UndoGate.execute] / [PluginMounts.pullByClientIds]）都要
 * Context + 文件系统，无法离线单测；而「什么时候不该动用户配置」恰恰是最需要反证的一条
 * （历史坑：把整个 patch 写回，用户新装的插件全部消失）。抽成纯函数后可直接逐条断言。
 *
 * @param candidate 唯一点名的可拔条目（点不出/多命中/命中硬清单时 [PluginMounts.clientPullCandidate] 返回 null）
 * @param mountUnchangedSinceHealthy 挂载清单是否与健康时记录的软清单逐字节一致
 */
internal fun clientPluginFailureRoute(
  candidate: PluginMounts.FailedEntry?,
  mountUnchangedSinceHealthy: Boolean,
): ClientPluginFailureRoute = when {
  candidate != null -> ClientPluginFailureRoute.CLIENT_PULL
  mountUnchangedSinceHealthy -> ClientPluginFailureRoute.KNOWN_GOOD
  else -> ClientPluginFailureRoute.NO_ACTION
}

// ── D3（0.14.6）：安全模式重启的纯判定（JVM 可反证）──────────────────────────

/**
 * 「安全模式启动」这一步重启动作的判定面（[safeModeRestartDecision] 的取值域）。
 *
 * 为什么需要单独的判定：安全模式的**全部价值**是「改了装配清单 ⇒ 引擎必须用新清单重建」。
 * 而 GuidePageRenderer.enterSafeMode 走的是 activity.startEngineFlow()，它内部先探活，
 * 探到旧引擎还在（OUR_PROCESS / OUR_HTTP）就 early-return 并 showWeb()——**根本不经过**
 * EngineManager.startEngine，于是两道既有闸门（[EngineStartFlow] 的快照新鲜度判定与
 * EngineManager 的 live 树完整性闸门）一次都不执行：旧进程继续服务**旧 manifest**，
 * 页面再次报同样的插件失败（0.14.4 的 DEVICE-FINDING-3 同族形态）。故这里把「可不可以动」
 * 抽成纯判定，使「绝不在不完整 / 未归属的前提下盲目重启」可逐条反证。
 *
 * - [PROCEED]                  live 完整 + 快照就绪 ⇒ 正常重启；
 * - [PROCEED_SNAPSHOT_STALE]   live 完整 + 快照未就绪 ⇒ **允许**放行（issue #240 的有意降级窗
 *                              就在这条路上：快照未就绪不等于运行时不可用），中间态文案必须如实；
 * - [REFUSE_LIVE_INCOMPLETE]   live 树残缺 ⇒ 绝不先停后启（停掉旧进程只会把用户从「能跑但插件错」
 *                              推到「跑不了」），停在可读错误页；
 * - [REFUSE_OWNERSHIP]         当前引擎端点未被归属到本壳 ⇒ 绝不按名字杀未归属监听器（既有护栏）。
 */
internal enum class SafeModeRestartDecision { PROCEED, PROCEED_SNAPSHOT_STALE, REFUSE_LIVE_INCOMPLETE, REFUSE_OWNERSHIP }

/**
 * 纯判据：安全模式重启该不该放行。
 *
 * 判据来源全部复用既有权威口径，不另造：live 完整性 = [EngineManager.liveRuntimeComplete]
 * （与降级闸门同源）；快照就绪 = [EngineManager.snapshotFresh]（= AGENTS.md 高频雷点 2 的
 * 「指纹翻转 + 事务文件消失」口径）；归属权 = [EngineManager.stopOwnedEngine] 的返回值。
 *
 * **本函数不执行任何动作**，也不替代两道既有闸门：放行之后 startEngineFlow 仍会各自再过一遍
 * 「快照新鲜度」与「live 树完整性」。它只回答「这一步该不该去停旧进程并重新拉起」。
 *
 * @param liveComplete live 运行时树是否完整（缺 node/bin.js/profile 时为 false）
 * @param snapshotFresh 内嵌快照是否已就绪（指纹新鲜）
 * @param ownedStopOk 旧进程是否可安全停止（本壳持有句柄）；「动之前」传 true 表示只问 live 面
 */
internal fun safeModeRestartDecision(
  liveComplete: Boolean,
  snapshotFresh: Boolean,
  ownedStopOk: Boolean,
): SafeModeRestartDecision = when {
  !liveComplete -> SafeModeRestartDecision.REFUSE_LIVE_INCOMPLETE
  !ownedStopOk -> SafeModeRestartDecision.REFUSE_OWNERSHIP
  snapshotFresh -> SafeModeRestartDecision.PROCEED
  else -> SafeModeRestartDecision.PROCEED_SNAPSHOT_STALE
}

/** 放行面：只有两个 PROCEED* 允许进入「停旧进程 + 重新拉起」。拒绝面一律不得动作。 */
internal fun safeModeRestartCanProceed(decision: SafeModeRestartDecision): Boolean =
  decision == SafeModeRestartDecision.PROCEED || decision == SafeModeRestartDecision.PROCEED_SNAPSHOT_STALE

/**
 * 面向用户的**如实**文案（含被拒时的真因与出口）。
 *
 * 放行两条都**不得**宣称已就绪：此刻旧进程已停、新进程未起，是明确的中间态。
 * 被拒两条必须说清「安全模式的插件改动本次不生效」，不得让用户以为已经生效。
 */
internal fun safeModeRestartHint(decision: SafeModeRestartDecision, english: Boolean = false): String =
  if (english) when (decision) {
    SafeModeRestartDecision.PROCEED ->
      "Restarting the runtime in safe mode: the old engine stops first, then a new one starts. Stay in the app."
    SafeModeRestartDecision.PROCEED_SNAPSHOT_STALE ->
      "Restarting in safe mode: the old engine stops, then a new one starts. The snapshot is not ready yet, so this start may be slower."
    SafeModeRestartDecision.REFUSE_LIVE_INCOMPLETE ->
      "Runtime incomplete; the engine was not stopped or restarted, so safe mode does not apply this time."
    SafeModeRestartDecision.REFUSE_OWNERSHIP ->
      "The current engine port is not owned by this app; the engine was not restarted, so safe mode does not apply."
  } else when (decision) {
    SafeModeRestartDecision.PROCEED ->
      "正在以安全模式重启运行时…（先停旧引擎，再启动新引擎，请保持前台）"
    SafeModeRestartDecision.PROCEED_SNAPSHOT_STALE ->
      "正在以安全模式重启…（先停旧引擎，再启动新引擎；快照未就绪，本次可能较慢）"
    SafeModeRestartDecision.REFUSE_LIVE_INCOMPLETE ->
      "运行时不完整，未重启引擎：安全模式本次不生效。请先按提示重做运行时。"
    SafeModeRestartDecision.REFUSE_OWNERSHIP ->
      "当前引擎端口不属于本应用，未重启引擎：安全模式本次不生效。请先在控制台排查。"
  }

/**
 * 快照事务等待的**如实相位文案**（P1；纯函数，JVM 可反证）。
 *
 * 【为什么它**不在** [safeModeRestartHint] 的取值域内】[safeModeRestartHint] 是
 * [SafeModeRestartDecision] 四值枚举的穷尽 when，语义是「这一步该不该去停旧进程并重新拉起」
 * 的四个结论；而本函数回答的是**另一个维度**的问题——「事务还要多久、现在处于什么相」。
 * 把它塞进那个枚举等于把「修并发缺陷」与「改既有判定契约」混进同一个改动（既有
 * SafeModeRestartDecisionTest / IndependentSafeModeRestartTest 有取值域与文案一一对应断言）。
 * 故刻意独立：**改写这条文案不会影响那四个结论的取值域**。
 *
 * 约束（D3 判据 C3 + 既有 `claimsReady` 断言）：**不得**出现「已就绪 / 启动完成 / 已启动完成 /
 * 可以开始使用」这类宣称可用的词——此刻旧引擎仍在跑、事务仍在跑，是明确的中间相。
 *
 * @param phase 事务 journal 自述的相（如 STAGED / SWAPPING）
 * @param accountedAgeMs 事务自述开始时间至今的时长；null = journal 没有可用的起始时间
 */
internal fun snapshotTransactionWaitText(phase: String, accountedAgeMs: Long?, english: Boolean = false): String {
  val age = accountedAgeMs?.let { (it / 60_000).coerceAtLeast(0L) }
  if (english) {
    return "Unpacking the runtime (phase=" + phase + ", about " +
      (age?.let { "$it min" } ?: "unknown time") +
      "). The engine restarts when this finishes; stay in the app."
  }
  return "运行时正在解压（phase=" + phase + "，约 " +
    (age?.let { "$it 分钟" } ?: "未知时长") +
    "）：事务结束后会重启引擎，请保持前台。"
}

/** 事务自述账龄（毫秒）；journal 没有可用起始时间时返回 0（**不猜**，也不写负值）。 */
internal fun snapshotTransactionAccountedAgeMs(marker: SnapshotTransaction.Marker?, nowMs: Long): Long =
  marker?.startedAt?.takeIf { it > 0L }?.let { (nowMs - it).coerceAtLeast(0L) } ?: 0L

// ── boot-stall 计时基准：**必须用单调时钟做差**（审计 §6.7）────────────────────────────
//
// 缺陷形态（0.14.9 审计 §6.7 与现场证据）：新机首装首启时 `boot-diag.log` 记
// `source=shell-stall ... stalledMs=352525 ... pageReady=false`，而同一轮页面在首个 HTTP 之后
// 148ms 就报了 `page-ready`。也就是壳侧把一个已经就绪的页面记成「卡了 352 秒」。
//
// 真因**不是起点取错**，而是**时钟基准选错**：起点与做差都用了 [System.currentTimeMillis]
// （墙上时钟）。新装机在首次联网校准之前系统时间常常偏慢，起点因此记下一份**偏小**的读数；
// 随后 NTP/用户校时把钟**向前拨**，下一次 tick 做差就凭空多出几百秒——352 秒这个量级、以及
// 「只在首装首启出现」这一分布，都与该机制吻合（单靠 tick 前后时序解释不了 8.8 倍放大）。
//
// 选型（三选一，只有第一个是对的）：
//  - [android.os.SystemClock.elapsedRealtime]：自开机起的毫秒数，**不受校时影响**，且设备休眠
//    （深睡）期间**继续计数**。这里要比的正是「用户感知到的等待」——用户合上屏幕再回来，等待
//    确实经过了，所以含深睡是对的。
//  - [android.os.SystemClock.uptimeMillis]：**不含深睡**。用它会在「息屏放置一段时间后再回前台」
//    的场景里系统性低报等待时长，正好漏掉本项目最需要抓的那类现场。
//  - [System.currentTimeMillis]：**缺陷本体**，见上（会被向前/向后拨）。
//
// 与 snapshotTransactionAccountedAgeMs 的区别（**那一处刻意不动**）：事务账龄比的是 journal 里
// 由**另一个进程**写下的 startedAt，属跨进程比较、只能走墙上时钟；本函数比的是**本进程内**两个
// 时刻，所以能且应当用单调时钟。

/** boot-stall 计时基准：单调时钟（毫秒），跨休眠继续计数、不受校时影响。 */
internal fun bootStallNow(): Long = android.os.SystemClock.elapsedRealtime()

/**
 * 两个**单调**时刻之间经过的毫秒数。
 *
 * 为什么单独抽出来：这是「352 秒假 stall」的判据本体，抽成纯函数后 JVM 单测可以直接构造
 * 「起点之后墙上时钟前跳 300 秒」的场景做反证（见 BootStallClockTest），不需要 sleep 真时间，
 * 也不依赖设备时钟。
 *
 * 返回值恒非负：now 不晚于起点（同一毫秒、注入错误、基准被回退）一律返回 0——
 * 负的「已经卡了 -300 秒」会在诊断里变成另一种假读数，不如如实表示「本拍没有经过时间」。
 */
internal fun bootStallElapsedMs(startedAt: Long, now: Long): Long =
  if (now <= startedAt) 0L else now - startedAt

// ── P1（0.14.8）：快照事务窗口内的**有界等待**（定位报告 §2.3/§7）────────────────────
//
// 缺陷形态：刷新期间 `flowOwnership.running` 恒为 true（finish 只在启动线程 finally 里跑），
// 于是 EngineStartFlow.start() 的 `flowOwnership.begin() ?: return` 把请求**静默丢弃**——
// 不 spawn、不改相位、不落盘。安全模式重启（performSafeModeRestart 末尾的 startEngineFlow）
// 正是撞在这堵墙上，用户看到的就是「点了安全模式，引擎没起来」。

/**
 * 等待快照事务**收口**（journal 消失）；true = 已收口，false = 预算内未收口或已换代/销毁。
 *
 * 写法与 [awaitEngineHttpReady] 同源：注入式 clock + 硬预算，使「有界」可被 JVM 逐条反证
 * （这条等待最危险的形态是变成无限等——它跑在启动线程上，一旦不受预算约束就会永久挂住）。
 *
 * - 判据 [transactionActive] = `SnapshotTransaction.readMarker(filesDir) != null`：**跨进程真源**。
 *   比 `flowOwnership.running` 客观——后者只是本 Activity 实例的内存态，而 MainActivity 未声明
 *   `launchMode`，新实例会绕过它（报告 §2.3 的适用边界）。
 * - [current]：世代/生命周期校验，false 立即收手，不对废弃世代做动作。
 * - 预算用尽 ⇒ 返回 false，**由调用方如实回执**；不得静默（那只是把丢弃挪了个位置）。
 *
 * 预算依据（不给魔数）：报告 §3 的一次全量重解压实测为 **8-12 分钟**，
 * [SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS] 取 16 分钟 = 12 分钟上限 + 4 分钟余量，余量覆盖换树
 * 与收尾——提交点是「先写指纹、后清 marker」，Lead 实测该窗口本身约 25s，而事务随时可能从
 * STAGED 推进到 SWAPPING。超预算不算失败：用户看到的是同一条如实中间态文案（不显示成故障），
 * 另在 boot-fail.log 落一条 timeout 痕迹。
 *
 * @param pollStepMs 轮询步进（生产 1s；单测注入）
 * @param now 时钟读数（单测注入）
 * @param sleep 睡眠（单测注入，避免真实等待）
 * @param transactionActive 事务是否仍在进行（journal 在场）
 * @param current 世代/生命周期校验
 */
internal fun awaitSnapshotTransactionSettled(
  budgetMs: Long = SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS,
  pollStepMs: Long = SNAPSHOT_TRANSACTION_WAIT_POLL_STEP_MS,
  now: () -> Long = { System.currentTimeMillis() },
  sleep: (Long) -> Unit = { ms -> if (ms > 0L) Thread.sleep(ms) },
  transactionActive: () -> Boolean,
  current: () -> Boolean = { true },
): Boolean {
  val deadline = now() + budgetMs
  while (true) {
    if (!current()) return false
    if (!transactionActive()) return true
    if (now() >= deadline) return false
    sleep(pollStepMs)
  }
}

/** 快照事务等待预算：16 分钟（依据见 [awaitSnapshotTransactionSettled] 的注释）。 */
internal const val SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS = 16 * 60_000L

/** 快照事务等待步进（毫秒）。 */
internal const val SNAPSHOT_TRANSACTION_WAIT_POLL_STEP_MS = 1_000L

// ── 审计 §6.1：**无快照事务**时的有界自动重试（与上面那条 16 分钟预算无关）────────────────
//
// 现场形态：deferEngineStartWhileSnapshotTransactionBusy() 的「无事务」分支只写一行 boot-fail
// 就 return，文案还承诺「下一次入口会重试」——但从来没有任何自动续跑。新机 boot-fail.log 里
// 这条反复新增，每一次都是一次被静默丢弃的启动请求。
//
// 预算依据（不给魔数）：这里等的是**本实例上一次启动流的收尾**（flowOwnership.finish，在启动
// 线程的 finally 里执行），它通常是**毫秒级**——启动线程已经跑完 spawn/轮询的最后一句，只剩
// 一个 CAS。所以预算取「数秒」而不是分钟：200ms × 15 拍 = 3 秒，足够覆盖一次 GC 抖动或主线程
// 繁忙，又不至于让用户对着「正在启动引擎…」空等下去。
//
// **不要**把它并到 16 分钟那条：那条等的是跨进程的 8-12 分钟解压，判据是 journal 文件。

/** 无事务重试的步进（毫秒）：200ms 一拍，足够细地把「上一个启动流刚收尾」这种窗口接住。 */
internal const val NO_TRANSACTION_RETRY_STEP_MS = 200L

/** 无事务重试的预算（毫秒）：数秒级（15 拍），超时如实记一条 timeout。 */
internal const val NO_TRANSACTION_RETRY_BUDGET_MS = 3_000L

/** 无事务重试的每一拍要做什么（纯判据，JVM 可逐条反证）。 */
internal enum class DeferredStartRetryDecision {
  /** 生命周期已终结 / 用户已关引擎：不启动，也不再排下一拍。 */
  STOP,
  /** 事务在这期间出现了：交给 16 分钟那条等待者（本等待者收手）。 */
  HAND_OVER_TO_TRANSACTION_WAIT,
  /** 所有权空出来了：续跑 start()（它会自己再抢一次 begin()）。 */
  RESUME,
  /** 预算用尽：如实记一条 timeout 后收手（不判失败、不改相位）。 */
  TIMEOUT,
  /** 仍在预算内且所有权仍被占：排下一拍。 */
  RETRY,
}

/**
 * 无事务重试的**决策本体**（审计 §6.1）。
 *
 * 抽成纯函数的理由与 [awaitSnapshotTransactionSettled] 同源：这条重试最危险的形态是**变成无限重试**
 * 或**偷偷绕过世代所有权**，两者都只能在 JVM 上逐条反证（真跑要等真实启动流收尾）。
 *
 * 判据顺序即语义，**不可重排**：
 *  ① 生命周期闸门最先 —— destroyed / 用户关引擎 / 维修态一律 STOP，绝不因为「快超时了」而漏判；
 *  ② 事务在场优先于所有权空出 —— 事务在跑说明上一次流已推进到解压，该由 16 分钟等待者接手；
 *  ③ 所有权空出即 RESUME（**不等满预算**：等待本身没有意义，抢到就是抢到了）；
 *  ④ 预算用尽 TIMEOUT（如实收手，不静默）；
 *  ⑤ 其余 RETRY。
 *
 * @param canRun 生命周期闸门（生产传 [EngineStartFlow] 的 canRunEngineWork）
 * @param transactionPresent 跨进程真源：快照事务 journal 是否在场
 * @param ownershipRunning 本次启动流是否仍持有世代所有权
 * @param attempts 已经走过的拍数（0 = 第一次决策）
 * @param budgetMs 预算（毫秒）
 * @param stepMs 步进（毫秒）
 */
internal fun decideNoTransactionRetry(
  canRun: Boolean,
  transactionPresent: Boolean,
  ownershipRunning: Boolean,
  attempts: Int,
  budgetMs: Long = NO_TRANSACTION_RETRY_BUDGET_MS,
  stepMs: Long = NO_TRANSACTION_RETRY_STEP_MS,
): DeferredStartRetryDecision {
  if (!canRun) return DeferredStartRetryDecision.STOP
  if (transactionPresent) return DeferredStartRetryDecision.HAND_OVER_TO_TRANSACTION_WAIT
  if (!ownershipRunning) return DeferredStartRetryDecision.RESUME
  val waitedMs = attempts.coerceAtLeast(0).toLong() * stepMs
  if (waitedMs >= budgetMs) return DeferredStartRetryDecision.TIMEOUT
  return DeferredStartRetryDecision.RETRY
  }

// ── DEVICE-FINDING-4：引擎强制重启后的**有界就绪等待**（纯判据，JVM 可反证）─────────

/**
 * 有界等待引擎 HTTP 真的能应答；true = 已就绪，false = 预算内未就绪（或已换代/进程已死）。
 *
 * 为什么必须有它（DEVICE-FINDING-4）：`startEngine(force = true)` 只保证**进程已 spawn**，
 * **不保证 HTTP 已 listen**（冷启动实测 5-45s 的宽分布）。外科拔除后若紧接着 reload，导航会撞上
 * 尚未监听的窗口 → ERR_CONNECTION_REFUSED → onReceivedError 置 enginePageFailed → 用户看到
 * 「页面加载失败」，仍然进不去（真机实测第 4 条）。因此 reload 必须在**引擎已应答之后**发起。
 *
 * **为什么不做固定 sleep**：冷启动耗时是 5-45s 宽分布——定短了照样撞窗口（缺陷原样复现），
 * 定长了则每次故障恢复都白等几十秒。轮询真实探针是以事实收敛，而不是拿猜测换时间。
 *
 * 有界性（本函数最危险的形态是「变成无限等」，它跑在回滚的后台线程上）：
 *  - 硬预算 [budgetMs]：now() 由注入，超预算立即返回 false；
 *  - 进程已死（[processAlive] 为假）⇒ 再等也不会就绪，提前收手；
 *  - 已换代（[current] 为假）⇒ 立刻收手，不对废弃世代做动作。
 *
 * 判据复用 [EngineProbe.check]：只在 running（200/401/303，与看门狗同一口径）为真时算就绪——
 * 401 也算就绪是刻意的：那是「引擎活着但要重新认证」，与「端口没起来」必须区分，认证走既有路径。
 *
 * @param budgetMs 硬预算（生产传 [ENGINE_BOOT_BUDGET_MS]）
 * @param pollStepMs 轮询步进
 * @param now 时钟读数（单测注入）
 * @param sleep 睡眠（单测注入，避免真实等待）
 * @param probe 探活：true = 引擎 HTTP 已能应答
 * @param processAlive 引擎子进程是否仍活着
 * @param current 世代校验：false 表示已换代/已销毁
 */
internal fun awaitEngineHttpReady(
  budgetMs: Long = ENGINE_BOOT_BUDGET_MS,
  pollStepMs: Long = ENGINE_BOOT_POLL_STEP_MS,
  now: () -> Long = { System.currentTimeMillis() },
  sleep: (Long) -> Unit = { ms -> if (ms > 0L) Thread.sleep(ms) },
  probe: () -> Boolean = {
    try {
      EngineProbe.check(pollStepMs.toInt().coerceIn(200, 1_500)).optBoolean("running", false)
    } catch (_: Throwable) {
      false
    }
  },
  processAlive: () -> Boolean = { true },
  current: () -> Boolean = { true },
): Boolean {
  val deadline = now() + budgetMs
  while (true) {
    if (!current()) return false
    if (probe()) return true
    // 进程已死：再等也不会就绪（spawn 失败/瞬间退出），提前把控制权交回调用方。
    if (!processAlive()) return false
    if (now() >= deadline) return false
    sleep(pollStepMs)
  }
}

/** 默认预算 = [ENGINE_BOOT_BUDGET_MS]（调用点不得再传字面量秒数）。 */
internal fun engineBootClock(elapsedMs: Long, budgetMs: Long = ENGINE_BOOT_BUDGET_MS): EngineBootClock =
  EngineBootClock(elapsedMs, budgetMs)

/** 引导页启动中文案（唯一生成点）：显示值与真实已等**同源**。 */
internal fun engineBootProgressText(clock: EngineBootClock, english: Boolean = false): String =
  if (english) {
    "Starting the engine (${clock.waitedSeconds}s, ${clock.remainingSeconds}s left; a slow cold start is normal)"
  } else {
    "引擎启动中（已等待 ${clock.waitedSeconds}s，剩余 ${clock.remainingSeconds}s）"
  }

/** 上报节流：每 [ENGINE_BOOT_REPORT_STEP_S] 秒一帧。 */
internal fun engineBootShouldReport(waitedSeconds: Int, stepSeconds: Int = ENGINE_BOOT_REPORT_STEP_S): Boolean =
  waitedSeconds % stepSeconds == 0
