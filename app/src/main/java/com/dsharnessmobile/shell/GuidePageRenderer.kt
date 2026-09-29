package com.dsharnessmobile.shell

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.io.File

/** 引导页（启动/测试界面）纯代码 UI：GuidePhase 状态机驱动视图渲染 + WebUI/引导页切换（自 MainActivity 拆出）。 */

internal enum class GuidePhase { Idle, Starting, Extracting, Updating, Recovering, Undoing, Error, Closed, Info }

// ── 状态副文案的仲裁（S1-2；顶层纯逻辑，JVM 可测）──────────────────────────
//
// 缺陷现场：五个来源（相位默认句 / 流程进度 / 旁路回执 / 下载提示 / 日志回执）各自直接写
// `chrome.statusHint.text`，彼此没有优先级——同一时刻显示哪一句取决于调用时序。
// 于是「正在更新运行时 686MB」会被一行旁路回执顶掉（设备实测：首启解压期间点「检查更新」）。

/** 副文案的来源与优先级（数字越大越"硬"，只有更高或同级能顶掉它）。 */
internal enum class HintSource(val priority: Int) {
  /** 相位驱动的文案（启动/解压/回滚…）。 */
  PHASE(30),

  /** 流程内进度/阶段（下载百分比、解压阶段名）。 */
  FLOW(20),

  /** 旁路动作的回执（检查更新结果、复制日志回执、探测中…）。 */
  SIDE(10),
}

/**
 * 是否接受这次写入。
 * @param current 当前文案的来源（null = 还没有人写过）。
 * @param currentSticky 当前文案是否**不可打断**（相位锁定期内写的才置位）。
 * @param incoming 本次写入的来源。
 *
 * 规则：不可打断的文案只能被**同级或更高**优先级顶掉（即另一条相位文案）；否则一律拒绝。
 * 非锁定期一切照常（后写者赢）——这样「点检查更新，然后它回报结果」这条正常路径不受影响。
 */
internal fun hintAccepted(current: HintSource?, currentSticky: Boolean, incoming: HintSource): Boolean =
  !currentSticky || incoming.priority >= (current?.priority ?: 0)

// ── S1-4 → 0.14.2 P2：进度**不再印任何数字**（用户口径，逐条落地）────────────────
//
// 缺陷现场（真机读数）：「已写入 1157 MB / 约 700 MB（99%）」——分子大于分母还报 99%。
// 真因不是「四舍五入错了」，而是**分母本身是编造的**：旧实现拿
// `RUNTIME_UNCOMPRESSED_APPROX_BYTES = 700MB` 当总量，而真实解压是**增量的**（既包含本次解压的
// 新字节，也包含磁盘上已有的旧数据），所以任何固定分母都是在凭空造事实。分子一旦超过这个假
// 分母，百分比就必然自相矛盾。
//
// 用户口径：「不如改成不显示数字，只画一个进度条，然后底下小字就只显示：正在解压，正在处理
// 残留数据，正在准备运行时这种车轱辘话」。即：
//   - 数字（「已写入 N MB」/「约 700 MB」/「x%」）**全部下线**；
//   - 进度条保留，但走**不确定态**（循环动画），不宣称任何比例；
//   - 底下小字只显示**阶段车轱辘话**——句子里没有数字，因此不可能再出现自相矛盾。
//
// 因此 RUNTIME_UNCOMPRESSED_APPROX_BYTES / runtimeProgressPercent / runtimeProgressLabel
// 三条**一并下线**（编造的分母 + 它的两个派生输出）。这里保留的是它们的位置与理由，
// 免得下次有人看到「少了个进度百分比」又把它加回来。

/**
 * 启动页「底下小字」的阶段车轱辘话（0.14.2 P2，纯数据 JVM 可测）。
 *
 * 三条覆盖解压期的三类阶段：解压本体 / 上次更新留下的残留清理 / 运行时收尾。
 * **刻意不含任何数字与百分比**——这正是本轮缺陷的修法：只要句子里没有数字，
 * 就不可能再出现「分子大于分母还报 99%」这种自相矛盾的火星读数。
 */
internal val RUNTIME_STAGE_PHRASES: List<String> = listOf(
  "正在解压运行时…",
  "正在处理残留数据…",
  "正在准备运行时…",
)

/**
 * 每句阶段文案的**停留时长**（0.14.2 FX1-A）。
 *
 * 取值依据（1.3s 而不是更快/更慢）：
 *  - 用户现场是「一直在闪」——旧实现按**回调次数**换句，而解压每 1MB 回调一次
 *    （SnapshotExtractor），2.5GB 完整解压约 2500 次回调、单次间隔 ~30ms 量级，
 *    于是同一句话停留不到一帧地被打断，观感就是闪烁；
 *  - 心理学上的「还在动」判据：约 1s 以上的稳定停留才被读成「一句完整的话」，
 *    低于 ~0.5s 只被读成「画面在抖」；故下限取 1.2s；
 *  - 上限取 1.5s：再久，长时间解压时用户会怀疑界面冻住，失去「轮换」的意义。
 * 1.3s 落在该区间中部，且与既有 2s 状态轮询（useShellState pollMs）不成整数倍，
 * 避免两个周期叠成肉眼可见的拍频。该值未经多机型校准，调整只改这一处。
 */
internal const val STAGE_ROTATE_INTERVAL_MS = 1_300L

/**
 * 按 [tick] 确定地取一条阶段文案（纯函数 JVM 可测）。
 *
 * 为什么需要轮换：解压是长时间单一相位，一句不动的文案会让用户以为界面冻住了；轮换车轱辘话
 * 只表达「还在动」，不表达「动了多少」——后者正是我们**没有**可信数据的东西。
 *
 * @param tick 轮换序号（调用方按进度回调递增；负数也接受，按模归一）。
 * @returns [RUNTIME_STAGE_PHRASES] 中确定的一条。
 */
internal fun runtimeStagePhrase(tick: Int): String {
  val n = RUNTIME_STAGE_PHRASES.size
  return RUNTIME_STAGE_PHRASES[((tick % n) + n) % n]
}

/**
 * 阶段文案的**时间**轮换闸门（0.14.2 FX1-A，纯逻辑 JVM 可测）。
 *
 * ── 为什么必须有这一层（缺陷本体）────────────────────────────────────────────
 * 旧实现把「轮换」挂在了**回调次数**上：`EngineStartFlow` 每次 `onProgress` 就 `tick++`，
 * 而 `SnapshotExtractor` 每解压 1MB 回调一次 ⇒ 2.5GB 完整解压约 2500 次回调，
 * 单次间隔 ~30ms；文案于是以毫秒级频率换句，用户读到的就是「一直在闪」。
 * 这是「用事件次数冒充时间」的形态：事件频率由数据量决定，与人的阅读节奏毫无关系。
 *
 * 本类把判据改成**时间**：同一时间窗内无论来多少次回调，都拒绝换句（返回 false）。
 * 于是文案的更换节奏由 [intervalMs] 决定，与回调频率彻底解耦——数据量再大也不会更闪。
 *
 * ── 并发与边界语义（都已在 `GuideAndConsoleBatch6Test` 里逐条判红）────────────
 *  - 全部字段由 `lock` 保护：`onProgress` 经 `runOnUiThread` 到主线程，但 `onStage` 与
 *    相位切换也可能从别处触发，复合操作（判窗+计时+自增）必须原子；
 *  - **首次调用必定返回 true**（用户要立刻看到一句，而不是先空 1.3s）——用 `started` 标记
 *    而不是拿 0 当「没有上次」，因为 0 是合法时钟值（`SystemClock.elapsedRealtime()` 从 0 起）；
 *  - **时钟回拨**（nowMs < 上次锚点）不得让闸门永久卡死（那会变成新的「界面冻住」），
 *    也不得因抖动而连续换句（那是闪的复发）：处理为「重新锚定到当前时刻、本次不换句」；
 *  - 序号自增**按模回绕**，不依赖 Int 溢出（2^31 次 × 1.3s ≈ 88 年才溢出，但回绕成本为零）。
 *
 * @param intervalMs 每句的停留时长；调用方传 [STAGE_ROTATE_INTERVAL_MS]。<=0 视为「每调必换」
 *   （测试与极端配置的确定性语义，不做特判）。
 */
internal class RuntimeStageRotation(private val intervalMs: Long) {

  private val lock = Any()
  private var stageIndex = 0
  private var anchorMs = 0L
  private var started = false

  /** 当前该显示的那一句（未开始时为第一句）。 */
  fun currentPhrase(): String = synchronized(lock) { runtimeStagePhrase(stageIndex) }

  /** 已推进到的轮换序号（反证用：证明「同一时间窗内它没有动」）。 */
  val index: Int get() = synchronized(lock) { stageIndex }

  /**
   * 到了下一个时间窗就前进一句并返回 true；**同一时间窗内一律返回 false**（文案不得变）。
   *
   * @param nowMs 单调时钟毫秒（生产传 `SystemClock.elapsedRealtime()`；测试直接给值）。
   * @returns true = 调用方应把文案更新为 [currentPhrase]；false = 文案**保持原样**（不闪的判据）。
   */
  fun advanceIfDue(nowMs: Long): Boolean = synchronized(lock) {
    if (!started) {
      started = true
      anchorMs = nowMs
      return true
    }
    if (nowMs < anchorMs) {
      // 时钟回拨：重新锚定，本次不换句。既不卡死（下次仍按新锚点判窗），也不抖动。
      anchorMs = nowMs
      return false
    }
    if (nowMs - anchorMs < intervalMs) return false
    anchorMs = nowMs
    stageIndex = (stageIndex + 1) % RUNTIME_STAGE_PHRASES.size
    true
  }

  /** 相位切换/流程重跑时复位，使下一次调用重新显示第一句并重新起算时间窗。 */
  fun reset() = synchronized(lock) {
    stageIndex = 0
    anchorMs = 0L
    started = false
    Unit
  }
}

/**
 * 文案是否**不含**任何数字与百分比（0.14.2 P2 的用户口径判据，纯函数 JVM 可测）。
 *
 * 抽成函数而不是在测试里写正则：这样生产侧的「文案纪律」与测试侧是同一个判据，
 * 将来新增阶段句时也能被同一条断言守住。
 *
 * @param text 待检文案。
 * @returns true = 句中不含任何 ASCII 数字，也不含百分号。
 */
internal fun stagePhraseHasNoNumbers(text: String): Boolean =
  text.none { it in '0'..'9' } && !text.contains('%')

/**
 * 自动回撤不可用时给用户看的一句话（S1-6，纯函数 JVM 可测）。
 *
 * 缺陷现场：`EngineStartFlow` 直接 `result.summary.take(120)` 当副文案，而 summary 是 UndoGate 的
 * **内部判定句**——「插件清单已变化但点名不出失败插件：不做整份回滚（避免连用户其它插件一起回退）」。
 * 用户既看不懂这是好事还是坏事，也读不出「我现在该做什么」。
 * 按可判定的关键词归类到五条用户口径；原始 summary 仍照旧落盘、可复制（诊断信息不丢）。
 */
internal fun undoUnavailableHint(summary: String): String = when {
  summary.contains("超时") -> "读取快照清单超时（状态未知，不等于没有快照）——稍后会自动重试；仍失败请打开控制台看 engine.log。"
  summary.contains("未部署") -> "急救工具未就绪，暂时无法自动回撤——重装应用可恢复该工具；期间请打开控制台排查。"
  summary.contains("无快照可回滚") -> "没有可用的回滚点（本次安装还没建立健康快照）——重启应用会自动重试启动。"
  summary.contains("点名不出") || summary.contains("不做整份回滚") ->
    "检测到插件清单有变化但定位不到具体是哪个插件，因此**没有**做整份回滚（以免连你自己装的插件一起回退）——请打开控制台检查插件。"
  else -> "自动回撤没能完成——请打开控制台查看 engine.log 后再试。"
}

internal class GuidePageRenderer(private val activity: MainActivity) {

  lateinit var chrome: GuideChrome
  private lateinit var engineStatus: TextView
  /** 引擎启动流写入解压进度（EngineStartFlow）。 */
  lateinit var progressText: TextView
  private lateinit var progressBar: ProgressBar
  private lateinit var crashBanner: TextView
  private lateinit var logSummary: TextView
  /** 测试界面三段式结构块：入场 stagger 动画按块依次淡入。 */
  private lateinit var brandBlock: View
  private lateinit var cardBlock: View
  private lateinit var actionBlock: View
  var lastGuidePhase: GuidePhase = GuidePhase.Idle
    private set
  private var statusPulse: ObjectAnimator? = null

  // —— S1-2：状态副文案的仲裁状态（唯一写入口 pushHint 维护） ——
  private var hintSource: HintSource? = null
  private var hintSticky = false

  // —— APK 自更新（0.13.8 批 H）状态：仅手动触发、同一按钮二次确认 ——
  /** 已发现的新版（非空 = 按钮停在「下载并安装 vX」二次确认态，再点才开始下载）。 */
  private var apkPending: UpdateChecker.CheckResult.Available? = null
  /** 下载完成待安装的包（授权页返回后由 settlePendingInstall 续继）。 */
  private var apkReadyToInstall: File? = null
  private var apkBusy = false

  fun buildGuideView(): LinearLayout {
    chrome = buildGuideChrome(
      activity,
      GuideCallbacks(
        onStartEngine = {
          // 缺陷 D（fx-2）：同一个主按钮在 **Error 相位**下语义不同——它变成「安全模式启动」。
          // 分叉放在这里而不是换控件：`GuideChrome` 只有一个 primaryButton，
          // 复用它的既有样式/锁态/无障碍面比新增按钮更少出事面（也避免用 Phase==Error 之外的判据）。
          if (lastGuidePhase == GuidePhase.Error) enterSafeMode()
          else {
            activity.engineFlow.engineRetryCount = 0 // 手动重试归零自动重试计数
            // 0.14.1 D2：同时清空**跨进程**的快照刷新失败账本。用户显式点「重试」就是要求
            // 「再试一次刷新」；不清账的话降级闸门会让他永远拿不到那次刷新，按钮就成了摆设。
            activity.engineManager.clearRefreshLedger()
            activity.startEngineFlow()
          }
        },
        onOpenConsole = { activity.startActivity(Intent(activity, ConsoleActivity::class.java)) },
        onCheckUpdate = { onUpdateButton() },
        onGrantStorage = { activity.dirPickerController.requestStorageGrant() },
        onCopyLog = { copyGuideLog() },
      ),
    )
    engineStatus = chrome.engineStatus
    progressText = chrome.progressText
    progressBar = chrome.progressBar
    crashBanner = chrome.crashBanner
    logSummary = chrome.logSummary
    brandBlock = chrome.brandBlock
    cardBlock = chrome.cardBlock
    actionBlock = chrome.actionBlock
    chrome.versionLabel.text = "v" + BuildConfig.VERSION_NAME
    refreshGuideMeta()
    return chrome.root
  }

  /** 测试界面入场：品牌区/状态卡/操作区依次淡入上移。仅在界面从隐藏变为可见时播放。 */
  private fun animateGuideReveal() {
    val rise = 16 * activity.resources.displayMetrics.density
    val items = listOf(brandBlock, cardBlock, actionBlock)
    items.forEachIndexed { i, v ->
      v.animate().cancel()
      v.alpha = 0f
      v.translationY = rise
      v.animate()
        .alpha(1f).translationY(0f)
        .setStartDelay(i * 80L).setDuration(480L)
        .setInterpolator(DsUi.ease).start()
    }
  }

  fun applyGuidePhase(phase: GuidePhase, title: String, hint: String? = null) {
    lastGuidePhase = phase
    engineStatus.text = title
    val resolvedHint = hint ?: defaultHint(phase)
    // S1-2：相位文案走仲裁漏斗（不可打断相位期间，旁路回执不得顶掉它）。
    pushHint(resolvedHint, HintSource.PHASE, sticky = phaseLocked(phase))

    val busy = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Recovering ||
      phase == GuidePhase.Undoing
    val lockPrimary = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Undoing ||
      // S1-3：**自动恢复期间也必须锁**。旧实现在 Recovering 时让主按钮可点且写着「重试」，
      // 而此刻看门狗正在自动重试——用户点它只会打断正在进行的恢复，且手册里那句「重试」
      // 与自动流程在同一屏上互相打架（点了之后仍回到「正在自动恢复」）。
      phase == GuidePhase.Recovering
    chrome.primaryButton.isEnabled = !lockPrimary
    chrome.primaryButton.alpha = if (lockPrimary) 0.55f else 1f
    chrome.primaryButton.text = when (phase) {
      GuidePhase.Closed -> activity.getString(R.string.ds_restart)
      // 缺陷 D（fx-2）：启动失败时主按钮是「安全模式启动」而不是「重试」。
      // 用户口径：失败的当下，重试往往只是再撞一次同一堵墙；能自救的那条路是带着上下文进安全模式。
      GuidePhase.Error -> activity.getString(R.string.ds_safe_start)
      GuidePhase.Recovering -> activity.getString(R.string.ds_recovering)
      GuidePhase.Starting, GuidePhase.Extracting -> activity.getString(R.string.ds_starting)
      GuidePhase.Updating -> activity.getString(R.string.ds_updating)
      GuidePhase.Undoing -> activity.getString(R.string.ds_undoing)
      GuidePhase.Idle, GuidePhase.Info -> activity.getString(R.string.ds_start_engine)
    }

    val showProgress = busy
    progressBar.visibility = if (showProgress) View.VISIBLE else View.GONE
    // 0.14.2 P2：进度条**恒为不确定态**。旧实现会在流程给出「同口径的 done/total」时切确定档，
    // 但那个 total 是编造常数（见上方 P2 说明），于是进度条宣称的比例也是编造的。
    // 现在只保留循环动画：它如实表达「还在动」，不表达「动了多少百分比」。
    progressBar.isIndeterminate = true
    if (phase != GuidePhase.Extracting) progressText.visibility = View.GONE

    val dotColor = when (phase) {
      GuidePhase.Error, GuidePhase.Closed -> activity.getColor(R.color.ds_danger)
      GuidePhase.Updating, GuidePhase.Extracting -> activity.getColor(R.color.ds_warn)
      GuidePhase.Starting, GuidePhase.Recovering, GuidePhase.Undoing -> activity.getColor(R.color.ds_accent)
      // Info = 中性事实陈述（本版没有这项能力、无需处理），既不是故障（红）也不是进行中（黄）。
      GuidePhase.Idle, GuidePhase.Info -> activity.getColor(R.color.ds_text_tertiary)
    }
    chrome.statusDot.background = DsUi.oval(dotColor)
    setStatusPulse(busy)
    refreshGuideMeta()
  }


  /**
   * 缺陷 D（fx-2）：点「安全模式启动」——进入安全模式 + 把修复 prompt 塞进剪贴板。
   *
   * 顺序是按用户价值排的，不是随手写的：
   *  ① 先取失败现场（boot-fail.log 尾巴），因为**它可能被后续启动轮转掉**；
   *  ② 进安全模式（摘第三方插件条目、保留我们自己的；事务纪律见 [SafeMode.enter]）；
   *  ③ 组装 prompt（含①的原文 + 「保留自有插件」「先定位真因」两条约束）并写剪贴板；
   *  ④ 如实回执：成功/失败都要说清哪一步没成，**不承诺一定能修复**。
   *
   * ④ 回执给用户看一小会儿，随后**真的以 safe 状态重启引擎**（用户口径：点一下就以 safe 状态运行）。
   *
   * 为什么回执与重启之间留一小段延时：安全模式改的是装配清单，引擎**重启后才生效**，
   * 所以必须重启；但若立刻重启，`Starting` 相位会立刻用相位文案覆盖掉回执，
   * 用户就看不到「prompt 已复制 / 复制失败」这个结果——而那正是本按钮的主要交付物之一。
   * 用 `chrome.root.postDelayed`（View 自带的 Handler）而不是自建 Handler：
   * View 的延时任务随视图 detach 自动失效，**不存在 Activity 泄漏面**；
   * 回调里再判一次 `lastGuidePhase == Error`，避免用户在延时窗口内又点了别的东西后仍被强制重启。
   *
   * 重启前清快照刷新账本与重试计数：与既有「手动重试」同口径——用户显式要求「以 safe 状态运行」，
   * 就该真的发起一次启动尝试，而不是被上一次失败的降级闸门挡住。
   */
  private fun enterSafeMode() = activity.runOnUiThread {
    val engine = activity.engineManager
    val (stage, logTail) = SafeMode.readFailureContext(activity)
    val result = SafeMode.enter(
      patch = SafeMode.patchFile(engine),
      homePatch = SafeMode.homePatchFile(engine),
      autoDir = SafeMode.autoDir(engine),
      id = SafeMode.newId(),
    )
    if (!result.ok) {
      // 备份不成功就绝不进入（[SafeMode.enter] 保证未改任何文件）——回执必须带真因。
      applyGuideHint(activity.getString(R.string.ds_safe_failed, result.message))
      return@runOnUiThread
    }
    val prompt = buildSafeModePrompt(
      stage = stage,
      detail = result.message,
      logTail = logTail,
      safeModeActive = true,
    )
    val copied = SafeMode.copyToClipboard(activity, prompt)
    // 回执按「剪贴板成没成」分两句：prompt 的交付是这条路径的主要价值，不能含糊过去。
    applyGuideHint(
      if (copied) activity.getString(R.string.ds_safe_entered)
      else activity.getString(R.string.ds_safe_prompt_copy_failed),
    )
    // 回执看一小会儿，然后真的以 safe 状态重启（见方法注释：为什么留延时、为什么用 View 的 postDelayed）。
    chrome.root.postDelayed({
      if (lastGuidePhase != GuidePhase.Error) return@postDelayed
      activity.engineFlow.engineRetryCount = 0
      activity.engineManager.clearRefreshLedger()
      activity.startEngineFlow()
    }, SAFE_RESTART_DELAY_MS)
  }

  private companion object {
    /** 回执可见时长：足够读完一句「修复指令已复制到剪贴板」，又不至于让用户以为按钮没反应。 */
    const val SAFE_RESTART_DELAY_MS = 1_500L
  }

  /** 只更新副标题（不动相位/状态点/主按钮）。
   *
   *  用途：**不可打断的相位**（首启解压 / 启动 / 回滚）进行中，旁路动作（如「检查更新」）的结果
   *  不该抢占状态行——否则「正在更新运行时 686MB」会被一行「本版不提供在线更新」顶掉，
   *  用户以为解压被取消了（设备实测：首启解压期间点「检查更新」正是这个现象）。 */
  fun applyGuideHint(text: String) = pushHint(text, HintSource.SIDE)

  /** 流程内进度/阶段文案（优先级高于旁路回执、低于相位文案）。 */
  fun applyFlowHint(text: String) = pushHint(text, HintSource.FLOW)

  /**
   * 状态副文案的**唯一写入口**（S1-2）。
   *
   * 缺陷现场：全仓有 5 个来源直接写 `chrome.statusHint.text`（相位默认句、流程进度、旁路回执、
   * 下载提示、日志回执），彼此没有优先级——最终显示哪一句**取决于调用时序**（哪个线程先跑完）。
   * 表现是「同一时刻显示哪句话说不清」，而且不可打断的相位句会被旁路回执顶掉。
   * 修法：全部经此漏斗，按 [HintSource] 的优先级仲裁（见 [hintAccepted]）。
   */
  private fun pushHint(text: String, source: HintSource, sticky: Boolean = false) {
    if (!hintAccepted(hintSource, hintSticky, source)) return
    hintSource = source
    hintSticky = sticky
    chrome.statusHint.text = text
    chrome.statusHint.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
  }

  /** 当前相位是否为**不可打断**（旁路动作只能写 hint，不得改相位）。 */
  fun phaseLocked(): Boolean = phaseLocked(lastGuidePhase)

  private fun phaseLocked(phase: GuidePhase): Boolean = phase == GuidePhase.Starting ||
    phase == GuidePhase.Extracting ||
    phase == GuidePhase.Undoing

  /**
   * 0.14.2 FX1-A：阶段文案的轮换闸门（时间驱动）。
   *
   * 为什么放在这里而不是 EngineStartFlow：轮换是**视图**的节奏问题，闸门与它控制的那个
   * `progressText` 放同一处，才不会出现「两个调用点各带自己的计时」。
   */
  private val stageRotation = RuntimeStageRotation(STAGE_ROTATE_INTERVAL_MS)

  /**
   * 0.14.2 P2：进度回调的**唯一**写入口——只写阶段车轱辘话，不写数字、不切确定档。
   *
   * 旧实现这里有两个方法（一个切确定档、一个拼「已写入 N MB / 约 700 MB（x%）」文案），
   * 两者共用一个编造的分母。现在收敛成一个只表达「在动」的入口：
   * 进度条恒为不确定态，文案只按 [RUNTIME_STAGE_PHRASES] 轮换。
   *
   * 0.14.2 FX1-A：轮换改由**时间**驱动（[RuntimeStageRotation]）。旧实现在此直接按调用次数
   * 取句，而调用频率 = 解压进度回调频率（每 1MB 一次，2.5GB 约 2500 次、间隔 ~30ms）
   * ⇒ 文案以毫秒级频率换句，用户读到的是「一直在闪」。现在同一时间窗内重复调用**只刷新可见性、
   * 不换句子**（进度条的不确定动画仍在动，所以「还在动」这个信息没丢）。
   *
   * @param nowMs 单调时钟毫秒（调用方传 `SystemClock.elapsedRealtime()`；测试可直接给值）。
   */
  fun showRuntimeStage(nowMs: Long) {
    progressBar.isIndeterminate = true
    progressText.visibility = View.VISIBLE
    if (!stageRotation.advanceIfDue(nowMs)) return
    progressText.text = stageRotation.currentPhrase()
  }

  /** 相位切走/流程重跑时复位轮换，使下一次重新显示第一句并重新起算时间窗。 */
  fun resetRuntimeStageRotation() = stageRotation.reset()

  private fun defaultHint(phase: GuidePhase): String = when (phase) {
    GuidePhase.Starting -> "首次启动会解压内嵌运行时，请保持应用在前台。"
    GuidePhase.Extracting -> extractHintBody()
    GuidePhase.Updating -> "下载并校验快照后会自动切换运行时。"
    GuidePhase.Recovering -> "看门狗正在拉起引擎，通常几秒内恢复。"
    GuidePhase.Undoing -> "正在把配置/插件回滚到最后良好快照（自动回撤）。"
    // 缺陷 D（fx-2）：失败页的默认副文案要说清「这个按钮现在做什么」——
    // 旧文案只提「重试」，而按钮此刻已被改成安全模式入口（文案与事实必须对齐）。
    GuidePhase.Error -> activity.getString(R.string.ds_safe_hint)
    GuidePhase.Closed -> "引擎已停止，不会自动恢复。"
    GuidePhase.Idle -> "引擎就绪后将进入 " + UserCopy.APP_NAME + "。首次使用需授予存储权限——导出文件与日志要写在公共目录。"
    GuidePhase.Info -> "运行时随安装包一起更新：安装新版 APK 即完成升级。"
  }

  /**
   * 解压相位文案（0.14.2 P2）：不再印任何体量数字。
   *
   * 旧实现写的是「正在写入内嵌 Termux 环境，约 700MB，需数分钟，请勿关闭应用。」——那个 700MB
   * 就是被下线的编造常数。真实解压量是增量的（含磁盘上已有数据），界面无从知道总量，
   * 所以这里只给「别关应用」这个用户真正需要知道的事。
   */
  private fun extractHintBody(): String =
    "正在写入内嵌 Termux 环境（首次启动需数分钟，请勿关闭应用）。"

  private fun setStatusPulse(on: Boolean) {
    if (on) {
      val anim = statusPulse ?: ObjectAnimator.ofFloat(chrome.statusDot, View.ALPHA, 1f, 0.28f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        interpolator = DsUi.ease
        statusPulse = this
      }
      if (!anim.isStarted) anim.start()
    } else {
      statusPulse?.cancel()
      chrome.statusDot.alpha = 1f
    }
  }

  /** 取消状态点脉冲动画（onDestroy 兜底，自 MainActivity.onDestroy 迁入）。 */
  fun cancelPulse() {
    statusPulse?.cancel()
    statusPulse = null
  }

  fun refreshGuideMeta() {
    if (!::chrome.isInitialized) return
    val runtimeReady = try { activity.engineManager.engineReady } catch (_: Exception) { false }
    chrome.runtimeChip.text = if (runtimeReady) {
      activity.getString(R.string.ds_runtime_ready)
    } else {
      activity.getString(R.string.ds_runtime_pending)
    }
    // 0.14.1 用户反馈：chip 判据从「SDK 版本 或 isExternalStorageManager」改为
    // **公共目录供给的真实结果**（EngineManager 落盘的状态）。
    // 旧判据写的是 `SDK_INT < 30 || isExternalStorageManager()` → API<30 一律显示「存储已授权」，
    // 而那条路上既没有 All Files Access 这个权限模型、运行时 WRITE 也没在任何启动路径上请求过，
    // 于是**界面说正常、Documents/dshdata 却建不出来**，用户既看不到问题也没有授权入口。
    // 「尚未探测」同样不得显示为已就绪（坑 161 同族：状态与事实必须对齐）。
    val presentation = PublicRepoProvision.presentation(activity.engineManager.publicRepoStatus())
    val chip = chrome.storageChip
    when (presentation) {
      PublicRepoPresentation.READY -> {
        chip.text = activity.getString(R.string.ds_storage_granted)
        chip.contentDescription = activity.getString(R.string.ds_storage_granted_cd)
      }
      PublicRepoPresentation.PENDING -> {
        // S1-9：还没探过 —— 不劝授权、更不说就绪，只给一个「立刻探一次」的动作。
        chip.text = activity.getString(R.string.ds_storage_pending)
        chip.contentDescription = activity.getString(R.string.ds_storage_pending_cd)
      }
      PublicRepoPresentation.NEEDS_GRANT -> {
        chip.text = activity.getString(R.string.ds_storage_needed)
        chip.contentDescription = activity.getString(R.string.ds_storage_needed)
      }
      PublicRepoPresentation.WRITE_FAILED -> {
        // 授权看起来够却写不进去：不能只说「去授权」（用户授权了也没用），要说出是写入失败。
        // 具体原因落在那行供给记录里（EngineManager.publicRepoLastAttempt），并可复制反馈。
        chip.text = activity.getString(R.string.ds_storage_write_failed)
        chip.contentDescription = activity.getString(R.string.ds_storage_write_failed_cd)
      }
    }
    // S1-7/S1-8/S1-9：观感与动作都由状态决定（旧实现是固定观感 + 固定动作）。
    val action = storageChipAction(presentation)
    styleStorageChip(
      activity, chip,
      actionable = action != StorageChipAction.NONE,
      danger = presentation == PublicRepoPresentation.WRITE_FAILED,
    )
    chip.setOnClickListener(
      if (action == StorageChipAction.NONE) null
      else { _ -> runStorageChipAction(action) },
    )
  }

  /** 存储 chip 的状态相关动作（S1-8/S1-9）：不再一律弹授权页。 */
  private fun runStorageChipAction(action: StorageChipAction) {
    when (action) {
      StorageChipAction.NONE -> Unit
      StorageChipAction.PROBE_AGAIN -> {
        pushHint(activity.getString(R.string.ds_storage_probing), HintSource.SIDE)
        activity.provisionPublicRepoAndRefreshChip(PublicRepoProvision.TRIGGER_ON_RESUME)
      }
      StorageChipAction.REQUEST_GRANT -> activity.dirPickerController.requestStorageGrant()
      StorageChipAction.COPY_FAILURE_DETAIL -> {
        // 写入失败时用户唯一有用的一步：把失败原文拿走（去反馈/自行排查）。
        // 旧实现这一下走的是「请求授权」——授权本来就够，点了当然什么都不变。
        val detail = activity.engineManager.publicRepoLastAttempt()
        if (detail.isBlank()) {
          toast(activity.getString(R.string.ds_storage_no_detail))
        } else {
          activity.copyTextNative(detail)
          toast(activity.getString(R.string.ds_storage_detail_copied))
        }
      }
    }
  }

  /** 测试界面「检查更新」按钮：手动检查 APK 自更新（用户拍板：不自动检查）。
   *  同按钮三态 = 检查 → （发现新版）二次确认 → 下载安装；已有下载好的包则直接续继安装。 */
  private fun onUpdateButton() {
    if (apkBusy) return
    apkReadyToInstall?.let { continueInstall(); return }
    apkPending?.let { downloadAndInstall(it); return }
    checkApkUpdate()
  }

  private fun setUpdateButton(label: String, enabled: Boolean) {
    // 固定高按钮 + 长版本号（v0.13.7fx-1）会换行截断（device 实测）——单行 + 省略号
    chrome.updateButton.maxLines = 1
    chrome.updateButton.ellipsize = android.text.TextUtils.TruncateAt.END
    chrome.updateButton.text = label
    chrome.updateButton.isEnabled = enabled
    chrome.updateButton.alpha = if (enabled) 1f else 0.55f
  }

  private fun apkHint(msg: String) = pushHint(msg, HintSource.SIDE)

  private fun sizeText(bytes: Long): String =
    if (bytes <= 0) "" else "%.1f MB".format(bytes / 1048576.0)

  /** 手动检查（不自动检查）：失败如实报原因，且不阻断既有引擎快照更新检查。
   *  发现新版时不自动进入下载——由用户再点同一按钮二次确认（169MB 下载不做误触启动）。 */
  private fun checkApkUpdate() {
    apkBusy = true
    setUpdateButton(activity.getString(R.string.ds_apk_checking), enabled = false)
    Thread {
      val r = UpdateChecker.checkLatest()
      activity.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        apkBusy = false
        when (r) {
          is UpdateChecker.CheckResult.UpToDate -> {
            val v = "v" + UpdateChecker.currentVersion()
            setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
            apkHint(activity.getString(R.string.ds_apk_latest, v))
            toast(activity.getString(R.string.ds_apk_latest, v))
            // 外层的壳已是最新 → 继续既有引擎快照检查（保持本按钮原有语义不失）
            activity.engineFlow.startUpdateCheck()
          }
          is UpdateChecker.CheckResult.Available -> {
            apkPending = r
            setUpdateButton(activity.getString(R.string.ds_apk_confirm, r.tag), enabled = true)
            apkHint(activity.getString(R.string.ds_apk_available, r.tag, "v" + UpdateChecker.currentVersion(), sizeText(r.sizeBytes)))
          }
          is UpdateChecker.CheckResult.Failed -> {
            setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
            apkHint(r.reason)
            toast(r.reason)
            activity.engineFlow.startUpdateCheck()
          }
        }
      }
    }.start()
  }

  /** 二次确认后的下载：镜像链 + .tmp→rename 原子落盘（有 .sha256 资产则校验）；完成后自动拉起安装。 */
  private fun downloadAndInstall(r: UpdateChecker.CheckResult.Available) {
    apkBusy = true
    val dest = File(UpdateChecker.updatesDir(activity), r.name)
    setUpdateButton(activity.getString(R.string.ds_apk_downloading, 0), enabled = false)
    apkHint(activity.getString(R.string.ds_apk_download_hint, r.name, sizeText(r.sizeBytes)))
    Thread {
      var fail: String? = null
      var ok = false
      try {
        val expected = r.sha256Url?.let { UpdateChecker.downloadText(it) }
        // FX-209.E1（E-12 第二处）：缓存复用分支与新下载分支**共用同一份**产物校验。
        // 旧实现两边各写一套：缓存分支比 sizeBytes（有 sha 还校验 sha），下载分支只判
        // 「HTTP 200 且写盘成功」——同一份截断/半包产物在两条路径上判定相反。判定强度现在
        // 只由 verifyApkArtifact（ApkArtifactCheck.kt）决定，两分支用同形参数调用。
        fun artifactVerdict(): ApkArtifactVerdict = verifyApkArtifact(
          fileExists = dest.exists(),
          actualBytes = dest.length(),
          expectedBytes = r.sizeBytes,
          expectedSha256 = expected,
          sha256Matches = { UpdateChecker.verifySha256(dest, it) },
        )
        // 上次下载完成但未安装（授权中断/安装取消）→ 复用已验证的包，不重复拉 169MB
        if (artifactVerdict() is ApkArtifactVerdict.Accept) {
          ok = true
        } else {
          val used = UpdateChecker.download(r.apkUrl, dest) { pct ->
            activity.runOnUiThread {
              if (apkBusy && !activity.isFinishing && !activity.isDestroyed) {
                setUpdateButton(activity.getString(R.string.ds_apk_downloading, pct), enabled = false)
              }
            }
          }
          if (used == null) {
            fail = "下载失败：镜像链全部不可用（直连/GitHub 加速镜像均失败）"
          } else {
            when (val verdict = artifactVerdict()) {
              is ApkArtifactVerdict.Accept -> ok = true
              is ApkArtifactVerdict.Reject -> {
                dest.delete()
                fail = "下载失败：" + verdict.reason + "（文件已删除，请重试）"
              }
            }
          }
        }
      } catch (e: Exception) {
        fail = "下载失败：" + (e.message ?: e.javaClass.simpleName)
      }
      val result = fail
      activity.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        apkBusy = false
        if (ok) {
          apkReadyToInstall = dest
          continueInstall()
        } else {
          // 保持二次确认态：同一按钮变「重试下载并安装」，再点即重试
          setUpdateButton(activity.getString(R.string.ds_apk_retry, r.tag), enabled = true)
          apkHint(result ?: "下载失败")
          toast(result ?: "下载失败")
        }
      }
    }.start()
  }

  /** 已下载完成：权限不足先拉「安装未知应用」授权页（onResume 结算续继），否则直接唤起系统安装器。 */
  private fun continueInstall() {
    val apk = apkReadyToInstall ?: return
    if (!apk.exists()) {
      apkReadyToInstall = null
      setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
      apkHint("安装包已不存在，请重新检查更新")
      return
    }
    if (!UpdateChecker.canInstall(activity)) {
      // P0-3：此前这里只改 hint，而按钮还停在「下载中 100%」且 `enabled=false`——文案让用户
      // 「再点按钮」而按钮收不到点击，唯一出路是杀应用重来（且内存里的 apkReadyToInstall 会丢）。
      // 现在把按钮复原成**可点**的「授权后继续安装」：onUpdateButton 见到 apkReadyToInstall 即走
      // continueInstall，所以「再点按钮」这句文案从此是事实。
      // S1-10：授权页**是否真的拉起**必须如实回报——旧实现两级 catch 都失败也不吭声，
      // 而 hint 已经写着「已打开授权页」（一句不保证为真的承诺）。
      val opened = UpdateChecker.requestInstallPermission(activity)
      if (opened) {
        apkHint(activity.getString(R.string.ds_apk_need_permission))
      } else {
        apkHint(activity.getString(R.string.ds_apk_permission_page_failed))
        toast(activity.getString(R.string.ds_apk_permission_page_failed))
      }
      setUpdateButton(activity.getString(R.string.ds_apk_grant_install), enabled = true)
      return
    }
    if (UpdateChecker.invokeInstaller(activity, apk)) {
      apkHint(activity.getString(R.string.ds_apk_installing))
      apkPending = null
      apkReadyToInstall = null
      setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
    } else {
      setUpdateButton(activity.getString(R.string.ds_apk_retry_install), enabled = true)
      apkHint("安装器拉起失败，请再点按钮重试")
    }
  }

  /** 从「安装未知应用」授权页返回（MainActivity.onResume 调用）：已授权则自动续继安装。 */
  fun settlePendingInstall() {
    if (apkReadyToInstall == null || apkBusy) return
    if (UpdateChecker.canInstall(activity)) continueInstall()
    else {
      // 拒绝并返回：文案说清「还能怎么办」，按钮保持可点（P0-3）——用户可直接再点，或去授权页。
      apkHint(activity.getString(R.string.ds_apk_permission_denied))
      setUpdateButton(activity.getString(R.string.ds_apk_grant_install), enabled = true)
    }
  }

  private fun toast(msg: String) {
    android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_LONG).show()
  }

  private fun copyGuideLog() {
    // 0.14.0（用户 2026-09-15）：一键复制当前代 engine.log 全文（不限大小）；绝不拼接
    // engine.log.1/.2——当前文件即「最近一次启动至今」，不会混入上一次启动。出口脱敏
    // 与展示同源（0.13.8 #184：令牌行不得进入外发文本）。
    val text = readEngineLogFull()
    // S1-1：日志不存在/读不出来时**必须回执**。旧实现在这里静默 return：用户点了「复制」，
    // 界面没有任何变化，粘出来也是空的——既不知道是不是自己没点中，也不知道下一步做什么。
    if (text.isNullOrBlank()) {
      val msg = activity.getString(R.string.ds_copy_log_empty)
      pushHint(msg, HintSource.SIDE)
      toast(msg)
      return
    }
    activity.copyTextNative(text)
    val ok = activity.getString(R.string.ds_log_copied)
    pushHint(ok, HintSource.SIDE)
    toast(ok)
  }

  /** 当前代 engine.log 全文（脱敏后）；缺失/不可读回退尾部摘要（同样脱敏）。 */
  private fun readEngineLogFull(): String? {
    val f = File(activity.filesDir, "engine.log")
    if (!f.exists()) return null
    val raw = try {
      f.readText(Charsets.UTF_8)
    } catch (_: Throwable) {
      tailEngineLog(400)
    }
    return EngineAuth.redact(raw)
  }

  fun showWeb() {
    activity.guideView.visibility = View.GONE
    // 不直接置 VISIBLE：露出时机要与首帧提交对齐（#242 反色闪），
    // 但由 revealWebView() 保证「最迟 WEB_REVEAL_FALLBACK_MS 后一定显形」。
    activity.revealWebView()
    // Preserve the existing WebView session across a liveness transition. Only
    // a documented engine-origin load error requires a fresh navigation.
    if (activity.enginePageFailed) {
      activity.enginePageFailed = false
      activity.webView.reload()
    }
  }

  /** 进入测试界面（引擎失败/未就绪回退）：状态 + 崩溃横幅 + engine.log 摘要。 */
  fun showGuide() {
    val becomingVisible = activity.guideView.visibility != View.VISIBLE
    activity.webView.visibility = View.GONE
    activity.guideView.visibility = View.VISIBLE
    if (becomingVisible) animateGuideReveal()
    val crash = activity.crashInfo
    if (crash != null) {
      crashBanner.visibility = View.VISIBLE
      crashBanner.text = "上次异常退出：$crash"
    } else {
      crashBanner.visibility = View.GONE
    }
    val tail = tailEngineLog(8)
    if (tail.isNotEmpty()) {
      logSummary.text = tail
      chrome.logSection.visibility = View.VISIBLE
    } else {
      chrome.logSection.visibility = View.GONE
    }
    refreshGuideMeta()
  }

  /** engine.log 尾部摘要（测试界面诊断用；缺失/不可读返回空）。
   *  展示出口脱敏（0.13.8 #184）：用户截图上报即外发，令牌行不得进入。 */
  private fun tailEngineLog(lines: Int): String {
    val f = File(activity.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      java.io.RandomAccessFile(f, "r").use { file ->
        val start = (file.length() - 16 * 1024).coerceAtLeast(0)
        file.seek(start)
        val bytes = ByteArray((file.length() - start).toInt())
        file.readFully(bytes)
        val tail = java.util.ArrayDeque<String>(lines)
        String(bytes, Charsets.UTF_8).lineSequence().forEach { line ->
          if (tail.size == lines) tail.removeFirst()
          tail.addLast(line)
        }
        EngineAuth.redact(tail.joinToString("\n"))
      }
    } catch (_: Exception) {
      ""
    }
  }
}
