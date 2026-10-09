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
  @Volatile private var monitorGeneration = 0L
  @Volatile private var updateUiGeneration = 0L
  private val engineMonitorHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val engineMonitorRunnable = object : Runnable {
    override fun run() {
      if (!canRunEngineWork()) return
      if (!activity.pageUiActive || activity.userClosedEngine) return
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
    bootStallStartAt = System.currentTimeMillis()
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
      if (!activity.pageUiActive || !canRunEngineWork()) return
      val generation = monitorGeneration
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
  @Volatile private var clientPluginFailureReasonText = "未点名具体条目"

  /** latch 的只读访问器（MainActivity 的闸门与单测用；CONTRACT §4 冻结此属性名）。 */
  internal val clientPluginTreeFailedLatch: Boolean get() = clientPluginTreeFailed

  /** 失败原因短句（MainActivity 呈现错误页时取用）。 */
  internal val clientPluginFailureReason: String get() = clientPluginFailureReasonText

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
    val folded = (rawLine ?: "").replace('\n', ' ').replace('\r', ' ').trim()
    clientPluginFailureRawLine = folded
    val ids = LogCollector.clientFailedIdsOf(folded)
    clientPluginFailureReasonText = if (ids.isEmpty()) "未点名具体条目" else "条目 " + ids.joinToString(",")
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
    // ④ 后台花掉一次性回滚预算。**不**在 WebView 线程上做 IO/回滚。
    val generation = monitorGeneration
    Thread {
      try {
        maybeRecoverFromClientPluginTreeFailure(generation)
      } catch (t: Throwable) {
        Log.e("dsh-shell", "client plugin tree recovery failed", t)
      }
    }.apply { isDaemon = true; name = "dsh-client-plugin-recovery" }.start()
  }

  /**
   * 自动回滚编排（CONTRACT §4）：一次性入口 → 判定路线 → 唯一动作走 [UndoGate.execute]。
   *
   * **EngineStartFlow 不重复决策**：外科拔除还是整份回滚由 [UndoGate.execute] 内部按同一判据
   * 分支（§5）；这里只负责「算出该传进去的 clientFailure，以及在明确不该动作时不动手」。
   */
  private fun maybeRecoverFromClientPluginTreeFailure(generation: Long) {
    // 只花一次：本进程已花过预算就直接停手（与 UndoGate 的 30 分钟窗叠加）。
    if (clientPluginTreeRecoverySpent) return
    // 一次性入口：被抑制（重试窗内）或未放行 ⇒ 现在不执行回滚。
    if (!UndoGate.onClientPluginTreeFailure(activity, clientPluginFailureReason, activity.engineManager)) return
    if (clientPluginTreeRecoverySpent) return
    clientPluginTreeRecoverySpent = true
    LogCollector.log("dsh-shell", "client plugin tree recovery starting (generation=" + generation + ")")
    try {
      val engine = activity.engineManager
      val patch = PluginMounts.patchFile(engine)
      val ids = LogCollector.clientFailedIdsOf(clientPluginFailureRawLine)
      // 纯判据（见 [clientPluginFailureRoute]）：唯一命中才外科拔除；点名不出但清单未变才允许
      // 整份回滚；两者都不成立就**不动作**（宁可不动，也不做一次会吞掉用户插件的写回）。
      val hardManifest = PluginMounts.ensureHard(activity, PluginMounts.currentFingerprint(activity))
      if (hardManifest == null) {
        LogCollector.writeBootFail(activity, "client-plugin-tree-failed-ownership-unverified",
          "本版本插件归属清单缺失或不匹配；未自动隔离/回滚，用户配置保持原样")
        activity.runOnUiThread { activity.presentClientPluginFailure() }
        return
      }
      val candidate = PluginMounts.clientPullCandidate(activity, patch, ids, hardManifest)
      val route = clientPluginFailureRoute(candidate, PluginMounts.mountUnchangedSinceHealthy(activity, patch))
      if (route == ClientPluginFailureRoute.NO_ACTION) {
        LogCollector.writeBootFail(
          activity, "client-plugin-tree-failed-no-action",
          // 措辞必须**如实指向真因**（Lead 设备取证 DEVICE-FINDING-1）：这一支的触发条件是
          // 「clientPullCandidate 返回 null 且有效 composition 自健康起已变」。
          // Profile cordis 与已解析 bundle insert layers 都参与点名；身份不唯一、factory来源不明或命中Hard时拒绝修改。
          "点名不出唯一可拔 Soft 条目（profile/bundle composition 中无对应 insert、命中多条、factory 身份不明或命中 Hard），" +
            "不自动回滚（避免连坐用户其它插件），停在可读错误页",
        )
        activity.runOnUiThread { activity.presentClientPluginFailure() }
        return
      }
      activity.runOnUiThread {
        if (!activity.isDestroyed && !activity.isFinishing) {
          activity.applyGuidePhase(
            GuidePhase.Undoing, "正在回退插件装配…",
            activity.getString(R.string.ds_client_plugin_fail_hint, clientPluginFailureReason),
          )
        }
      }
      // 唯一动作：外科传 candidate、整份传 null；分支判定在 execute 内部（§5）。
      val result = UndoGate.execute(activity, engine, candidate)
      if (result.executed) {
        WatchdogV2.reset()
        engine.resetCooldown()
        // 设备实测 #3（DEVICE-FINDING-3）：**不 force 就等于没修**。
        //
        // startEngine() 的首个判据是 `if (!force && engineUsable && !degradedHttp) return true` ——
        // 客户端插件装配失败时引擎 **HTTP 是健康的**（坏的只是它装配出来的插件树），于是不带 force
        // 的调用会判定「已有可用引擎」**直接早退、什么都不做**。引擎继续用**启动时读入的旧 profile**
        // 组合并服务 window.__DSH_BOOT__，那份清单里仍含刚被拔掉的坏插件；即使下面的
        // reloadEnginePage() 真的重新导航，取回的**还是同一份坏 manifest**，页面再次报同样的失败。
        // 真机事实：拔除成功、patch 磁盘上已干净，而引擎进程 ETIME 早于拔除时刻——从未重启，屏幕
        // 240s 恒定停在「插件装配失败」。数据面修好、服务面没修好，用户面就是没修好。
        //
        // force = true 的安全边界**不在本调用点**，而在 startEngine 既有护栏：PORT_FOREIGN 仍拒绝；
        // OUR_HTTP 但本壳没有可安全停止的子进程句柄仍拒绝；killExistingEngine 只停**本壳持有的**
        // 句柄，绝不按名字杀未归属的监听器。本场景 engineProcessAlive() == true（有句柄）⇒ 可正常
        // kill+spawn；此刻界面停在引导页 Error 相位（Web UI 从未加载成功），无用户可见的在跑会话。
        engine.startEngine(force = true)
        // 设备实测 #4（DEVICE-FINDING-4）：**reload 必须等引擎真的能应答**。
        //
        // startEngine(force = true) 只保证**进程已 spawn**，不保证 HTTP 已 listen（冷启动实测
        // 5-45s 宽分布）。若紧接着 reload，导航会撞上尚未监听的窗口 ⇒ ERR_CONNECTION_REFUSED
        // ⇒ onReceivedError 置 enginePageFailed ⇒ 用户看到「页面加载失败」，仍然进不去。
        // 所以这里在**后台线程**（本函数本就在回滚线程上）做有界就绪等待，不做任何固定 sleep。
        //
        // 为什么把等待放在 clearClientPluginTreeFailureLatch() **之前**：latch 的语义是「页面已定性
        // 失败，等用户决策」。等待期间引擎还没起来，latch 必须继续按住所有「把 WebUI 推回前台」的
        // 自动路径（含 engineMonitorRunnable），否则 3s 一拍的监控会在引擎未监听时切相位。等待有了
        // 结论之后再决定是「解 latch + 重新导航」还是「保持 Error 并如实留档」。
        val ready = awaitEngineHttpReady(
          budgetMs = ENGINE_BOOT_BUDGET_MS,
          processAlive = { activity.engineManager.engineProcessAlive() },
          current = { !activity.isDestroyed && !activity.isFinishing && canRunEngineWork() },
        )
        if (!ready) {
          // 预算内没等到引擎应答：**不** reload（那只会再造一次「页面加载失败」），也不解 latch，
          // 如实停在可读错误页并把判据落盘——用户仍有「安全模式启动」这条出口。
          LogCollector.writeBootFail(
            activity, "client-plugin-tree-failed-engine-not-ready",
            "已强制重启引擎，但在 " + ENGINE_BOOT_BUDGET_MS / 1000 + "s 预算内未等到 HTTP 应答：" +
              "不在此时重新导航（避免又一次 ERR_CONNECTION_REFUSED），停在可读错误页",
          )
          activity.runOnUiThread { activity.presentClientPluginFailure() }
          return
        }
        // 放行：先解 latch，再**重新导航 + 露出 WebView**（用户可见的「恢复」动作）。
        clearClientPluginTreeFailureLatch()
        activity.runOnUiThread {
          if (!activity.isDestroyed && !activity.isFinishing) {
            // 设备实测 #2（DEVICE-FINDING-2）：**只 showWeb() 不够**——数据修好不等于屏幕修好。
            //
            // showWeb() 只在 enginePageFailed == true 时才 reload，而本场景失败的是**插件装配**
            // 而非导航传输（WebView 早就加载成功了，enginePageFailed == false），于是 showWeb()
            // 只执行 guideRenderer.showWeb()：把**已经持有旧失败文档**的 WebView 重新露出来，
            // 从不重新导航。而客户端插件清单是**文档加载时**拉的，旧文档不会自己重拉一次
            // ⇒ 真机实测：拔除已成功（patch 与基线逐字节相同），屏幕却 3 分钟仍停在
            // "Failed to load plugins"，只能靠手动冷启动恢复。
            //
            // 因此必须**同时**做两件事，顺序也不可换：
            //   ① reloadEnginePage() 真正 webView.reload()：重新取 manifest 与插件树（修复数据面）；
            //   ② showWeb() 把引导页换回 WebView（reload 不负责切界面）。
            // 前置条件已由上面的就绪等待保证（引擎此刻确实在应答，reload 不会撞空端口）。
            // 有界性不变：仍是一次性预算（clientPluginTreeRecoverySpent）内的动作；latch 已清，
            // 走的是 pageRecovery 的 Recovery.RELOAD 一次性重载，不是重载环。
            activity.reloadEnginePage()
            activity.showWeb()
          }
        }
        LogCollector.log("dsh-shell", "client plugin tree recovery executed: " + result.summary.take(200))
      } else {
        LogCollector.writeBootFail(
          activity, "client-plugin-tree-failed-recovery-failed",
          "自动回滚未生效：" + result.summary.take(400),
        )
        // 失败 ⇒ 停在 Error，不再自动重试回滚（latch 保持置位，坏页面不会被弹回）。
        activity.runOnUiThread { activity.presentClientPluginFailure() }
      }
    } catch (t: Throwable) {
      Log.e("dsh-shell", "client plugin tree recovery failed", t)
      LogCollector.writeBootFail(activity, "client-plugin-tree-failed-recovery-exception", "自动回滚编排抛出异常", t)
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
    activity.applyGuidePhase(GuidePhase.Updating, "检查更新…")
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
    if (!isCurrentEngineFlow(generation)) return
    val token = flowOwnership.tokenFor(generation) ?: return
    val caller = Thread {
      try {
        requireCurrentEngineFlow(generation)
        // 引擎全死时先决门槛：急救 CLI 存在 + 快照非空 + 幂等窗口。
        // 0.14.1：阈值必须用 effectiveFailureCount（半死与 DEAD 共用计数），与看门狗侧
        // EngineService.kt 的 undoReady 同口径。旧实现只读 consecutiveFailures —— 而该计数在
        // DEGRADED_HTTP（端口可连、HTTP 持续失败）下恒被清零，于是「半死引擎」在这条路径上
        // 永远达不到阈值，自动回撤静默不可达（与 planTick 的熔断锁存同族盲区）。
        // DEAD 路径不受影响：DEAD 下 consecutiveDegradedHttp 恒 0，两个计数相等。
        if (!UndoGate.onProbeFailure(activity, WatchdogV2.effectiveFailureCount(), engine = activity.engineManager)) return@Thread
        requireCurrentEngineFlow(generation)
        activity.runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          activity.applyGuidePhase(GuidePhase.Undoing, "正在执行回撤…", "正在恢复到崩溃前的最后良好快照。")
        }
        requireCurrentEngineFlow(generation)
        val result = UndoGate.execute(activity, activity.engineManager)
        requireCurrentEngineFlow(generation)
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
          requireCurrentEngineFlow(generation)
          activity.engineManager.resetCooldown()
          if (isCurrentEngineFlow(generation)) activity.engineManager.startEngine()
        } else {
          activity.runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            activity.applyGuidePhase(GuidePhase.Error, "自动回撤不可用", undoUnavailableHint(result.summary))
          }
        }
      } catch (t: Throwable) {
        if (isCurrentEngineFlow(generation)) Log.e("dsh-shell", "auto-undo failed", t)
      } finally {
        token.detach(Thread.currentThread())
      }
    }
    token.attach(caller)
    caller.start()
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
      activity.applyGuidePhase(GuidePhase.Starting, "引擎启动失败，${delayMs / 1000}s 后自动重试（第 $attempt/2 次）",
        startupFailureHint(activity, activity.engineManager.lastStartRefusalCode))
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
    if (!canRunEngineWork()) return
    // CONTRACT §4：新启动世代/用户显式重试 ⇒ 解除插件失败 latch（放行一次坏页面的呈现）。
    // 这里只清 latch，**不**退一次性回滚预算——预算是「本进程最多自动回滚一次」，与世代无关。
    clearClientPluginTreeFailureLatch()
    // The owner and generation change in one CAS; an obsolete finally cannot
    // clear a replacement, and duplicate lifecycle callbacks change neither.
    val token = flowOwnership.begin() ?: return
    val generation = token.generation
    activity.engineManager.lastStartRefusalCode = null
    activity.engineManager.lastStartRefusal = null
    if (!isCurrentEngineFlow(generation)) { flowOwnership.finish(token); return }
    // 新启动世代 = boot-stall 的新 epoch：在此复位（**不在** onPageFinished。
    // onPageFinished 只代表文档加载完，在那里复位会造成同 epoch 重复报，见 L-1）。
    resetBootStall()
    startMonitor()
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
          activity.applyGuidePhase(GuidePhase.Recovering, "正在等待属主维护完成…", "维护结果尚未结算，暂不读取或更新运行时；先有限次快速重试，之后每 5 分钟静默复查一次。")
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
              activity.applyGuidePhase(GuidePhase.Error, "运行时恢复未完成", "事务现场已保留；请打开控制台查看恢复失败原因。修复前不会探活或启动运行时。")
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
          activity.applyGuidePhase(GuidePhase.Error, "安装包运行时指纹不可用", problem.detail)
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
          requireCurrentEngineFlow(generation)
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
          requireCurrentEngineFlow(generation)
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
                "运行时更新失败",
                // 缺陷 D（fx-2）：这两个显式 hint 会**覆盖** defaultHint，所以安全模式引导
                // 必须在这里也带上——否则「运行时更新失败」屏的按钮已改成安全模式入口，
                // 文案却还在让人「重试」，两者对不上。
                startupFailureHint(activity, activity.engineManager.lastStartRefusalCode) + "\n" +
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
      requireCurrentEngineFlow(generation)
      if (!activity.engineManager.startEngine()) {
        requireCurrentEngineFlow(generation)
        // 任务 19：失败终态落盘（此前这条路径**零落盘**——用户反馈第一条的真因）。
        //
        // issue #271 ④：区分「被前置条件拒绝」与「spawn 真失败」。半搬态（live 树缺 node）
        // 属于前者：不再空等 90s 预算，直接以可归因的原因收口，用户看到的不再是
        // 「进程在 90s 预算内死亡」这种无指向的结论。
        val refusal = activity.engineManager.lastStartRefusal
        val refusalCode = activity.engineManager.lastStartRefusalCode
        LogCollector.writeBootFail(
          activity, if (refusal != null) "engine-start-refused" else "engine-start-false",
          "EngineManager.startEngine() 返回 false（未能拉起引擎进程）"
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
          activity.applyGuidePhase(GuidePhase.Error, "引擎启动失败", startupFailureHint(activity, refusalCode))
          activity.showGuide()
        }
        // A foreign listener cannot be repaired by changing this app's profile or ownership.
        if (refusalCode == EngineManager.REFUSAL_PORT_FOREIGN) return@Thread
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
        onEngineStartTimeout(generation)
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
      }
    }
    token.attach(caller)
    caller.start()
  }

  private fun canRunEngineWork(): Boolean =
    !flowOwnership.destroyed && !activity.isDestroyed && !activity.isFinishing && !activity.userClosedEngine &&
      !EngineService.userShutdown && !Thread.currentThread().isInterrupted

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

  /** Start the foreground service (engine keep-alive + watchdog). */
  fun startEngineService() {
    if (!canRunEngineWork() || flowOwnership.destroyed) return
    try {
      activity.startForegroundService(Intent(activity, EngineService::class.java))
    } catch (_: Exception) {
      // Foreground-service start limits: service will start on next launch.
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
   * Restart only after the manager proves it can stop its tracked child. Foreign listeners are
   * left untouched and the subsequent spawn is not attempted.
   */
  fun restart(): Boolean {
    if (activity.isDestroyed || activity.isFinishing || flowOwnership.destroyed) return false
    if (!engineRestarting.compareAndSet(false, true)) return false
    flowOwnership.invalidate()
    val token = flowOwnership.begin()
    if (token == null) { engineRestarting.set(false); return false }
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
        UndoGate.clearRetryEpochForUserRestart(activity)
        if (!isCurrentEngineFlow(generation)) return@Thread
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
internal fun engineBootProgressText(clock: EngineBootClock): String =
  "引擎启动中（已等待 ${clock.waitedSeconds}s / 剩余 ${clock.remainingSeconds}s，冷启动较慢属正常）"

/** 上报节流：每 [ENGINE_BOOT_REPORT_STEP_S] 秒一帧。 */
internal fun engineBootShouldReport(waitedSeconds: Int, stepSeconds: Int = ENGINE_BOOT_REPORT_STEP_S): Boolean =
  waitedSeconds % stepSeconds == 0
