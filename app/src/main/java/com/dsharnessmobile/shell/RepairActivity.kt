package com.dsharnessmobile.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * 修复助手整页文案（#1011 ①）。
 *
 * 缺陷现场：这一页是原生面，绝大多数控件文案是内联中文字面量——切英文后整页仍是中文。
 * 收成一张表，`RepairActivity` 建视图时按当前语言取一份（页面重建即跟随语言）。
 * 只收**界面文案**：引擎/模型名、会话标题、诊断正文都是数据，不在表内。
 *
 * ## 本文件有三类中文**故意不译**（不是遗漏）
 *
 * 判据：译文只送给**人眼/人耳**——界面文案、无障碍 contentDescription、用户可见的错误与状态。
 * 送给模型、或作为协议键的字符串保持原样。
 *
 * 1. **SYSTEM_PROMPT**（文件末尾常量）：它是**给模型的提示词**，不是给用户看的文案。提示词约束
 *    模型行为，改语言会改变模型对工具名/字段名的对齐（`read`/`bash`/`restart_engine` 这些标识符
 *    本身也不翻译），收益为零而风险是行为漂移。
 * 2. **beginAutomaticRepair() 首轮指令** 与 **toolTitle() 里的工具名标识符**：前者是喂给模型的
 *    指令文本，后者是 `read`/`write`/`edit`/`list`/`bash`/`preflight` 这类**协议键**。键是协议的一部分，
 *    译了就对不上。工具显示名（"读取文件"/"Read file"）是用户可见的，那部分已经译。
 * 3. **diagnosticContext() 里的诊断上下文**：路径与 `RepairPreflight.collectAndFormat(...)` 预检简报
 *    是喂给模型的工具/诊断载荷，键名保持英文稳定标识以保跨语言一致。
 *
 * 新增文案时按这条判据归类：给人看的要双语，给模型或当键用的不译。
 */
internal data class RepairAssistantCopy(
  val send: String,
  val stop: String,
  val steerSend: String,
  val queued: String,
  val cancelledUnsent: String,
  val inputHint: String,
  val thinking: String,
  val completed: String,
  val conversationsTitle: String,
  val newConversation: String,
  val recent: String,
  val noConversations: String,
  val current: String,
  val modelSheetTitle: String,
  val close: String,
) {
  /** 逐字段快照（测试用来遍历「每个字段都双语」）。 */
  fun snapshot(): Map<String, String> = linkedMapOf(
    "send" to send,
    "stop" to stop,
    "steerSend" to steerSend,
    "queued" to queued,
    "cancelledUnsent" to cancelledUnsent,
    "inputHint" to inputHint,
    "thinking" to thinking,
    "completed" to completed,
    "conversationsTitle" to conversationsTitle,
    "newConversation" to newConversation,
    "recent" to recent,
    "noConversations" to noConversations,
    "current" to current,
    "modelSheetTitle" to modelSheetTitle,
    "close" to close,
  )
}

/** 取当前语言的一份文案（#1011 ①）。纯函数：`english` 已解析，JVM 单测两个方向都能断言。 */
internal fun repairAssistantCopy(english: Boolean): RepairAssistantCopy = RepairAssistantCopy(
  send = UiText.t(english, "发送", "Send"),
  stop = UiText.t(english, "停止", "Stop"),
  steerSend = UiText.t(english, "插话发送", "Queue message"),
  queued = UiText.t(english, "已排队，下轮发送", "Queued for next turn"),
  cancelledUnsent = UiText.t(english, "已取消（未发送）", "Cancelled (not sent)"),
  inputHint = UiText.t(english, "补充故障信息", "Describe the problem"),
  thinking = UiText.t(english, "思考", "Thinking"),
  completed = UiText.t(english, "完成", "Done"),
  conversationsTitle = UiText.t(english, "修复会话", "Repair sessions"),
  newConversation = UiText.t(english, "新建对话", "New conversation"),
  recent = UiText.t(english, "近期", "Recent"),
  noConversations = UiText.t(english, "还没有修复会话", "No repair sessions yet"),
  current = UiText.t(english, "当前", "Current"),
  modelSheetTitle = UiText.t(english, "模型与推理", "Model and reasoning"),
  close = UiText.t(english, "关闭", "Close"),
)

/**
 * 右侧圆形主按钮形态判定（形态 A）。
 *
 * - 空闲态：始终为 [SEND]；
 * - 运行中且输入框含非空白内容：切为 [STEER_SEND]（允许插话排队，下轮安全点送入）；
 * - 运行中且输入框为空：切为 [STOP]（停止当前修复任务）。
 */
internal enum class RepairActionMode {
  SEND,
  STEER_SEND,
  STOP,
}

internal fun repairActionMode(busy: Boolean, draftText: CharSequence?): RepairActionMode = when {
  !busy -> RepairActionMode.SEND
  !draftText.isNullOrBlank() -> RepairActionMode.STEER_SEND
  else -> RepairActionMode.STOP
}

internal fun isStateChangingRepairTool(name: String): Boolean =
  name in setOf("write", "edit", "restart_engine", "refresh_runtime")

internal fun parseToolArgumentsObject(rawArgs: String): JSONObject? = runCatching {
  val trimmed = rawArgs.trim()
  if (trimmed.isEmpty()) return@runCatching JSONObject()
  val tokener = JSONTokener(trimmed)
  val value = tokener.nextValue()
  if (value !is JSONObject) return@runCatching null
  if (tokener.nextClean() != '\u0000') return@runCatching null
  value
}.getOrNull()

internal fun repairToolInvalidArgumentsJson(detail: String? = null): String {
  val message = if (detail.isNullOrBlank()) {
    "工具参数不是合法的 JSON 对象，请修正参数格式。"
  } else {
    "工具参数不是合法的 JSON 对象：" + detail.take(200)
  }
  return JSONObject()
    .put("ok", false)
    .put("error", "invalid-arguments")
    .put("message", message)
    .toString()
}

internal fun repairToolRefusalJson(reason: String?): String {
  val code = reason?.takeIf { it.isNotBlank() } ?: "tool-call-refused"
  val message = when (code) {
    "duplicate-tool-call" -> "同一状态下重复执行相同的工具调用已被拦截，请根据已有结果调整思路或直接收口。"
    "max-tool-calls" -> "本轮工具调用次数已达上限，请基于已有证据停止调用并收口汇报。"
    "max-total-output-bytes" -> "本轮工具输出字节预算已耗尽，请基于已有证据收口汇报。"
    else -> "工具调用已被安全护栏拒绝（$code）。"
  }
  return JSONObject()
    .put("ok", false)
    .put("error", code)
    .put("message", message)
    .toString()
}

internal fun repairStopReasonMessage(reason: String?, english: Boolean): String = when (reason) {
  "max-steps" -> UiText.t(
    english,
    "本轮已达到 ${RepairLoopGuard.MAX_STEPS} 步模型调用上限。可补充信息后继续；当前状态不代表已修复。",
    "This turn reached the ${RepairLoopGuard.MAX_STEPS}-step model limit. Add details to continue; the current state does not mean it is fixed.",
  )
  "max-tool-calls" -> UiText.t(
    english,
    "本轮已达到 ${RepairLoopGuard.MAX_TOOL_CALLS} 次工具调用上限，已自动停手。可补充信息后继续。",
    "This turn reached the ${RepairLoopGuard.MAX_TOOL_CALLS}-call tool limit and stopped. Add details to continue.",
  )
  "max-total-output-bytes" -> UiText.t(
    english,
    "本轮工具输出累计已达字节上限，已自动停手以防止上下文溢出。可缩小范围后继续。",
    "Cumulative tool output reached the byte budget and stopped to protect context. Narrow the scope to continue.",
  )
  "consecutive-no-progress-batches" -> UiText.t(
    english,
    "连续多轮操作未取得新进展，已自动收口停止。请查看上方诊断记录或补充说明后继续。",
    "Stopped automatically after consecutive rounds with no new progress. Review the transcript above or add guidance to continue.",
  )
  "consecutive-invalid-tool-batches" -> UiText.t(
    english,
    "连续多轮工具调用失败或被拦截，已自动收口停止。请根据上方提示调整或补充说明。",
    "Stopped automatically after consecutive failed or rejected tool batches. Adjust or add details based on the transcript above.",
  )
  else -> UiText.t(
    english,
    "本轮修复已达到安全护栏上限（${reason ?: "unknown"}）并停止；当前状态不代表已修复。",
    "This repair turn stopped at a safety guard (${reason ?: "unknown"}); the current state does not mean it is fixed.",
  )
}

internal data class RepairToolObservation(
  val stateChanged: Boolean,
  val madeProgress: Boolean,
  val errorCode: String?,
)

/**
 * 统计每批工具调用是否取得有效进展（新读取窗口/新列表/成功命令/写入或重启成功）与错误码。
 */
internal class RepairBatchProgressTracker {
  private val seenReadWindows = HashSet<String>()
  private val seenListWindows = HashSet<String>()
  private val seenCommands = HashSet<String>()
  private val seenProbes = HashSet<String>()

  fun observe(name: String, rawArgs: String, resultJson: String, stateVersion: Int): RepairToolObservation {
    val obj = runCatching { JSONObject(resultJson) }.getOrNull()
      ?: return RepairToolObservation(stateChanged = false, madeProgress = false, errorCode = "invalid-tool-result")
    val errorCode = obj.optString("error", "").takeIf { it.isNotBlank() }
    if (errorCode != null) {
      return RepairToolObservation(stateChanged = false, madeProgress = false, errorCode = errorCode)
    }
    val ok = obj.optBoolean("ok", false)
    val stateChanged = isStateChangingRepairTool(name) && ok
    val madeProgress = when (name) {
      "write" -> ok
      "edit" -> ok && obj.optBoolean("changed", true)
      "restart_engine" -> ok || obj.optBoolean("restarted", false)
      "refresh_runtime" -> ok || obj.optBoolean("refreshed", false)
      "read" -> {
        val key = "$stateVersion|${obj.optString("path")}|${obj.optLong("offset", -1L)}|${obj.optInt("readBytes", 0)}|${obj.optLong("size", -1L)}"
        seenReadWindows.add(key)
      }
      "list" -> {
        val count = obj.optJSONArray("entries")?.length() ?: -1
        seenListWindows.add("$stateVersion|${obj.optString("path")}|$count")
      }
      "bash" -> {
        val timedOut = obj.optBoolean("timedOut", false)
        val cancelled = obj.optBoolean("cancelled", false)
        val exitCode = if (obj.isNull("exitCode")) null else obj.optInt("exitCode", -1)
        ok && !timedOut && !cancelled && exitCode == 0 && seenCommands.add("$stateVersion|$rawArgs")
      }
      "engine_status", "preflight" -> seenProbes.add("$stateVersion|$name")
      else -> false
    }
    return RepairToolObservation(stateChanged = stateChanged, madeProgress = madeProgress, errorCode = null)
  }
}
/**
 * Native startup repair chat. The surface deliberately does not depend on Node,
 * WebView, plugins, or the extracted snapshot.
 */
class RepairActivity : Activity() {
  private lateinit var conversation: LinearLayout
  private lateinit var scroll: ScrollView
  private lateinit var input: EditText
  private lateinit var send: ImageButton
  private lateinit var modelButton: ImageButton
  @Volatile private var tools: RepairTools? = null
  private lateinit var root: LinearLayout
  private lateinit var topBar: LinearLayout
  private lateinit var navigationCluster: LinearLayout
  private lateinit var historyButton: ImageButton
  private lateinit var content: LinearLayout
  private lateinit var composer: LinearLayout
  private val busy = AtomicBoolean(false)
  private val sessionLock = Any()
  private val queueLock = Any()
  private val pendingUserMessages = mutableListOf<PendingUserMessage>()
  private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
  private var history = JSONArray()
  private var eventLog = JSONArray()
  private var currentSessionId: String? = null
  /** 会话标题初值。**用户可见**（会写进会话抽屉的会话列表），所以必须跟随语言。 */
  private var currentTitle = s("新的修复", "New repair")
  /** 整页文案表（#1011 ①）：建视图时按当前语言取一份，控件一律读它，不再内联中文字面量。 */
  private val copy: RepairAssistantCopy by lazy { repairAssistantCopy(UiText.isEnglish(this)) }

  /** 行内双语（#1011 ①）：消息体/提示语这类只在一处出现的文案，中英就写在同一行。 */
  private fun s(zh: String, en: String): String = UiText.t(this, zh, en)
  private var drawerScrim: View? = null
  private var drawer: LinearLayout? = null
  private lateinit var drawerList: LinearLayout
  private lateinit var shellHost: FrameLayout
  @Volatile private var diagnosticText: String? = null
  @Volatile private var connections: List<RepairModelConnection> = emptyList()
  private var selectedModel = 0
  private var selectedEffort: String? = null
  // 2026-10-25 审计 M-RA1：三者均为跨线程字段（worker 线程写 client、主线程 cancelWork 读；
  // onDestroy 主线程写 alive、worker 循环读）——无 @Volatile 时取消窗口内的可见性延迟会让
  // client?.cancel() 拿到旧 null，该次 HTTP 请求只能等 180s readTimeout 兜底。
  @Volatile private var worker: Thread? = null
  @Volatile private var client: RepairModelClient? = null
  @Volatile private var alive = true
  @Volatile private var activeStreamUi: StreamingTurnUi? = null
  @Volatile private var report: File? = null
  private var pendingActivity: View? = null
  private var activeConnection: RepairModelConnection? = null
  private var modelNotice: LinearLayout? = null
  private var modelNoticeText: TextView? = null
  private var reloadModels: Button? = null
  // #1017：候选在后台解码，打开会话时先把会话偏好的模型身份/强度寄存在这里。
  private var pendingIdentity: String? = null
  private var pendingEffort: String? = null
  /**
   * 会话落盘器。所有 `saveCurrentSession()` 都只是提交快照，序列化与磁盘写发生在
   * `dsh-repair-session-writer` 线程上；onDestroy 会 flush 到落盘为止。
   */
  private val sessionWriter = RepairSessionWriter { session ->
    RepairConversationStore.save(filesDir, session)
  }
  @Volatile private var diagnosticsReady = false
  @Volatile private var defaultModelAvailable = false
  @Volatile private var modelSources = ""
  /**
   * 配置里存在但凭据引用没 join 上的路由。
   *
   * 只存「provider / model / 引用名」，**绝不存 key 值**（引用名本身已在 RepairModelConfig
   * 侧做过形似密钥的剔除）。用途只有一个：把「配了但缺 key」与「没配」在提示区区分开。
   */
  @Volatile private var unavailableRoutes: List<RepairModelUnavailable> = emptyList()
  /** 配置树的根（`home/.dsh`）整个不存在：运行时还没解出来，不是没配模型（issue #1012）。 */
  @Volatile private var modelRootMissing = false

  private data class PendingUserMessage(
    val text: String,
    val statusView: TextView,
  )

  private fun loadRepairModels(): List<RepairModelConnection> {
    val result = RepairModelConfig.loadDetailed(applicationContext)
    defaultModelAvailable = result.defaultAvailable
    modelRootMissing = result.rootMissing
    unavailableRoutes = result.unavailable
    // 状态必须说清「为什么没候选」，而不是只报一个「未读到可用模型」。
    // 用户拿着这句话无法区分：没配置 / 配置读不到 / 读到了但缺凭据——三种修法完全不同。
    // 文案表本身也放在 RepairModelNotice（statusLabels），单测钉的是**生产代码用的那份表**；
    // 若测试自己另写一份，删掉某个状态它照样绿，等于没守。
    val english = UiText.isEnglish(this)
    val labels = RepairModelNotice.statusLabels(english)
    val fallback = RepairModelNotice.statusFallback(english)
    // 缺凭据的路由逐条进来源表：只说引用名，不带 key 值（前几位也不行）。
    val missingCredentials = unavailableRoutes.joinToString("\n") { route ->
      route.provider + " / " + route.model + ": " +
        RepairModelNotice.statusLabel(route.reason, labels, fallback) +
        (route.credentialRef?.let { " (" + it + ")" } ?: "")
    }
    modelSources = (result.sources.joinToString("\n") { source ->
      source.path + ": " + RepairModelNotice.statusLabel(source.status, labels, fallback)
    } + (if (missingCredentials.isEmpty()) "" else "\n" + missingCredentials)).trim()
    return result.connections
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (!RepairState.required(this)) { finish(); return }
    RepairState.active = true
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = getColor(R.color.ds_bg)
    window.navigationBarColor = getColor(R.color.ds_bg)
    val isNight = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES
    androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = !isNight
      isAppearanceLightNavigationBars = !isNight
    }
    // Android recreates the Activity for a configuration change. Rotating the
    // phone must keep the same chat and any half-typed prompt instead of
    // silently creating a fresh repair conversation.
    val restored = savedInstanceState
    val engine = EngineManager(applicationContext, EngineManager.ensurePickToken())
    tools = RepairTools(applicationContext, engine)
    root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(getColor(R.color.ds_bg))
    }
    shellHost = FrameLayout(this)
    topBar = buildTopBar()
    root.addView(topBar)
    content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    conversation = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, space(10), 0, space(8))
    }
    scroll = ScrollView(this).apply {
      isFillViewport = true
      clipToPadding = false
      isHorizontalScrollBarEnabled = false
      addView(conversation, ViewGroup.LayoutParams(-1, -2))
    }
    content.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
    modelNotice = buildModelNotice()
    content.addView(modelNotice)
    composer = buildComposer()
    content.addView(composer)
    root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
    buildConversationDrawer()
    shellHost.addView(root, FrameLayout.LayoutParams(-1, -1))
    setContentView(shellHost)
    applyInsets()
    applyResponsiveLayout()

    openOrCreateSession(restored?.getString(STATE_SESSION_ID))
    restored?.getString(STATE_INPUT)?.let { input.setText(it) }
    worker = Thread {
      // Diagnostics and model configuration are independent failures. Load models first so
      // repair-model-source.json reflects this run before mirrorDiagnosticsToShared copies it.
      val modelFailure = try {
        val loaded = loadRepairModels()
        connections = loaded
        selectedModel = 0
        selectedEffort = loaded.firstOrNull()?.defaultReasoningEffort
        // 0 候选**不在这里**合成一句话（issue #1012）：failure 是「读取本身失败」，
        // 优先级压过一切。若把「没候选」也塞进 failure，rootMissing 分支永远轮不到，
        // 用户看到的还是那句「未读到可用模型」。说什么由 RepairModelNotice.present 决定。
        null
      } catch (e: Exception) {
        UiText.t(this, "读取模型配置失败：", "Could not read model configuration: ") + e.javaClass.simpleName
      }
      val diagnosticsFailure = try {
        report = engine.mirrorDiagnosticsToShared("native-repair")
        tools = RepairTools(applicationContext, engine, report)
        val preflight = RepairPreflight.collectAndFormat(applicationContext, engine, report)
        diagnosticText = diagnosticContext(engine, preflight)
        diagnosticsReady = report != null
        null
      } catch (e: Exception) {
        UiText.t(this, "诊断读取失败：", "Could not read diagnostics: ") + e.javaClass.simpleName
      }
      runOnUiThread {
        if (!alive) return@runOnUiThread
        restoreSelection()
        applyModelState(modelFailure)
        if (diagnosticsFailure != null) addSystemMessage(diagnosticsFailure, s("诊断", "Diagnostics"))
        val emptyHistory = synchronized(sessionLock) { history.length() == 0 }
        if (emptyHistory) {
          if (diagnosticsReady && connections.isNotEmpty() && defaultModelAvailable) beginAutomaticRepair()
          else addSystemMessage(
            UiText.t(this,
              "修复助手已打开。修好模型或诊断后，可点「重新读取模型配置」再开始。",
              "The repair assistant is open. Reload the model configuration after fixing it, then continue."),
          )
        } else addSystemMessage(s("已打开最近的修复会话，可以继续补充故障信息。", "Reopened the most recent repair session; keep adding details."))
      }
    }.apply { name = "dsh-repair-init"; start() }
  }

  private fun buildTopBar(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(space(8), space(8), space(10), space(8))
    setBackgroundColor(getColor(R.color.ds_bg))
    navigationCluster = LinearLayout(this@RepairActivity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
    }
    navigationCluster.addView(
      iconButton(R.drawable.repair_ic_back, s("返回启动页", "Back to the start page")) { returnToLauncher() },
      LinearLayout.LayoutParams(space(42), space(42)),
    )
    historyButton = iconButton(R.drawable.repair_ic_history, s("打开修复会话", "Open repair sessions")) {
      openConversationDrawer()
    }
    navigationCluster.addView(
      historyButton,
      LinearLayout.LayoutParams(space(42), space(42)).apply { topMargin = space(4) },
    )
    addView(navigationCluster, LinearLayout.LayoutParams(-2, -2))
    // No decorative page title: the center stays empty like a chat app.
    addView(View(this@RepairActivity), LinearLayout.LayoutParams(0, -1, 1f))
    // Keep the header quiet: navigation on the left, one circular model
    // picker on the right. Selection details stay inside the picker.
    modelButton = iconButton(R.drawable.repair_ic_model, s("选择模型与推理强度", "Choose model and reasoning effort")) {
      showModelSheet()
    }
    modelButton.isEnabled = false
    addView(modelButton, LinearLayout.LayoutParams(space(42), space(42)))
  }

  private fun buildComposer(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.BOTTOM
    setPadding(space(12), space(8), space(12), space(12))
    setBackgroundColor(getColor(R.color.ds_bg))
    input = EditText(this@RepairActivity).apply {
      hint = copy.inputHint
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
        InputType.TYPE_TEXT_FLAG_MULTI_LINE
      maxLines = 4
      minLines = 1
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      setTextColor(getColor(R.color.ds_text_primary))
      setHintTextColor(getColor(R.color.ds_text_secondary))
      setPadding(space(16), space(11), space(16), space(11))
      background = DsUi.roundRect(getColor(R.color.ds_surface),
        resources.getDimension(R.dimen.ds_radius_card), getColor(R.color.ds_hairline))
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(s: Editable?) {
          updateSendButton()
        }
      })
    }
    addView(input, LinearLayout.LayoutParams(0, -2, 1f))
    send = ImageButton(this@RepairActivity).apply {
      setImageResource(R.drawable.dsh_ic_send)
      scaleType = ImageView.ScaleType.CENTER
      setPadding(space(13), space(13), space(13), space(13))
      contentDescription = copy.send
      isEnabled = false
      DsUi.bindPressScale(this)
      setOnClickListener { onSendButton() }
    }
    styleSendButton(this@RepairActivity, send, RepairActionMode.SEND)
    addView(send, LinearLayout.LayoutParams(space(46), space(46)).apply { marginStart = space(8) })
  }

  /**
   * Model availability is a banner, not a page-level failure: diagnostics, the transcript and
   * every escape route stay usable while the configuration is missing or malformed.
   */
  private fun buildModelNotice(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    visibility = View.GONE
    setPadding(space(12), space(8), space(12), space(8))
    setBackgroundColor(getColor(R.color.ds_surface_muted))
    modelNoticeText = TextView(this@RepairActivity).apply {
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTextColor(getColor(R.color.ds_text_secondary))
      setLineSpacing(0f, 1.35f)
    }
    addView(modelNoticeText, LinearLayout.LayoutParams(-1, -2))
    val actions = LinearLayout(this@RepairActivity).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(0, space(8), 0, 0)
    }
    reloadModels = actionButton(UiText.t(this@RepairActivity, "重新读取模型配置", "Reload model configuration")) {
      reloadModelConfiguration()
    }
    val console = actionButton(UiText.t(this@RepairActivity, "打开控制台", "Open console")) { openConsole() }
    val retry = actionButton(UiText.t(this@RepairActivity, "返回启动页重试引擎", "Back and retry engine")) {
      returnAndRetry()
    }
    actions.addView(reloadModels, LinearLayout.LayoutParams(0, -2, 1f))
    actions.addView(console, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = space(6) })
    actions.addView(retry, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = space(6) })
    addView(actions, LinearLayout.LayoutParams(-1, -2))
  }

  private fun actionButton(label: String, action: () -> Unit): Button = Button(this).apply {
    text = label
    isAllCaps = false
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    setTextColor(getColor(R.color.ds_text_primary))
    minHeight = space(44)
    stateListAnimator = null
    background = DsUi.ripple(DsUi.roundRect(getColor(R.color.ds_surface),
      resources.getDimension(R.dimen.ds_radius_pill), getColor(R.color.ds_hairline)),
      getColor(R.color.ds_accent_soft))
    DsUi.bindPressScale(this, 0.97f)
    setOnClickListener { action() }
  }

  private fun applyModelState(failure: String?) {
    // 判定在 RepairModelNotice（纯函数、可单测）；这里只把结果落到 View 上。
    // 分开的理由：文案归属原先只能靠拉起 Activity 才验得到，而拉起 Activity 会读真实
    // filesDir/home，在真机上等于污染用户配置。
    val notice = RepairModelNotice.present(
      failure = failure,
      candidateCount = connections.size,
      defaultModelAvailable = defaultModelAvailable,
      diagnosticsReady = diagnosticsReady,
      noModelText = UiText.t(this,
        "未读到可用模型。可在控制台修好配置后重新读取，也可直接重试引擎。",
        "No model is available. Fix configuration in the console and reload, or retry the engine."),
      noDiagnosticsText = UiText.t(this,
        "无法读取本轮诊断。可打开控制台或返回启动页重试引擎。",
        "This run's diagnostics could not be read. Open the console or return and retry the engine."),
      defaultUnavailableText = UiText.t(this,
        "当前默认模型不可用。请点右上角选择模型，再发送修复需求。",
        "The configured default model is unavailable. Choose a model at the top right before sending a repair request."),
      rootMissing = modelRootMissing,
      unavailableCount = unavailableRoutes.size,
      unavailableText = UiText.t(this,
        "配置里读到了模型路由，但凭据引用没有命中：patch 里只有引用名，真正的 key 在 .credentials.yaml 的 refs 里。请补上对应 key 或改对引用名后点「重新读取模型配置」。",
        "Model routes were found, but their credential references did not resolve. The patch only carries a reference name; the real key lives in .credentials.yaml under refs. Add the key or fix the reference name, then reload the model configuration."),
      rootMissingText = UiText.t(this,
        "运行时还没解出来（配置目录尚不存在）。这不是模型没配好——请返回启动页重试引擎，等快照解压完成后再回来看。也可打开控制台查看启动日志。",
        "The runtime has not been extracted yet; the configuration directory does not exist. This is not a missing model: go back and retry the engine, then return once the snapshot finishes extracting. The console shows the startup log."),
    )
    modelButton.isEnabled = notice.modelControlsEnabled
    // 发送键与模型选择分开（issue #1012 A3）：0 候选时选择器确实没得选，但发送不该一起关。
    send.isEnabled = notice.sendEnabled
    modelNotice?.visibility = if (notice.visible) View.VISIBLE else View.GONE
    modelNoticeText?.text = notice.text.orEmpty()
    modelNoticeText?.visibility = if (notice.visible) View.VISIBLE else View.GONE
    if (notice.appendSources && modelSources.isNotEmpty()) {
      modelNoticeText?.append("\n" + modelSources)
    }
    reloadModels?.isEnabled = true
  }

  private fun reloadModelConfiguration() {
    if (busy.get()) return
    reloadModels?.isEnabled = false
    Thread {
      val loaded = runCatching { loadRepairModels() }
      // 同上（issue #1012）：只有「读取抛错」才是 failure；0 候选交给 present() 判该说哪句。
      val failure = loaded.exceptionOrNull()?.let {
        UiText.t(this, "读取模型配置失败：", "Could not read model configuration: ") + it.javaClass.simpleName
      }
      val next = loaded.getOrNull()
      runOnUiThread {
        if (!alive) return@runOnUiThread
        if (next != null) {
          connections = next
        }
        restoreSelection()
        applyModelState(failure)
        reloadModels?.isEnabled = true
        // 只有真的读到了候选才说「已重新读取」：0 候选时上面那句横幅才是用户该看的，
        // 再补一句「已重新读取」会让人以为已经好了（issue #1012）。
        if (failure == null && next != null && next.isNotEmpty()) addSystemMessage(
          UiText.t(this, "已重新读取模型配置。", "Model configuration reloaded."),
        )
      }
    }.apply { name = "dsh-repair-models"; isDaemon = true; start() }
  }

  private fun openConsole() {
    runCatching { startActivity(Intent(this, ConsoleActivity::class.java)) }
      .onFailure { addSystemMessage(UiText.t(this, "无法打开控制台：", "Could not open the console: ") + it.javaClass.simpleName) }
  }

  private fun returnAndRetry() {
    if (busy.get()) {
      addSystemMessage(UiText.t(this, "请先停止当前修复，再返回启动页。", "Stop the current repair before returning."))
      return
    }
    RepairState.active = false
    launchStartupPage(retry = true)
  }

  /** Both exits land on the startup page; only the retry exit arms the one-shot in-process flag (#682). */
  private fun launchStartupPage(retry: Boolean) {
    val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
    if (retry) MainActivity.pendingSelfRetry = true
    startActivity(intent)
    finish()
  }


  /** Android-native drawer chrome; the same controls also work in landscape. */
  private fun buildConversationDrawer() {
    drawerScrim = View(this).apply {
      setBackgroundColor(0x66000000)
      visibility = View.GONE
      setOnClickListener { closeConversationDrawer() }
    }
    shellHost.addView(drawerScrim, FrameLayout.LayoutParams(-1, -1))
    drawer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(getColor(R.color.ds_bg))
      visibility = View.GONE
      elevation = space(12).toFloat()
      setPadding(space(12), space(12), space(12), space(12))
    }
    val panel = drawer!!
    panel.addView(TextView(this).apply {
      text = copy.conversationsTitle
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      setTextColor(getColor(R.color.ds_text_primary))
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setPadding(space(10), space(6), space(10), space(10))
    })
    panel.addView(TextView(this).apply {
      text = copy.newConversation
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setTextColor(getColor(R.color.ds_accent))
      setPadding(space(10), space(10), space(10), space(10))
      background = DsUi.ripple(
        DsUi.roundRect(getColor(R.color.ds_surface),
          resources.getDimension(R.dimen.ds_radius_sm), getColor(R.color.ds_hairline)),
        getColor(R.color.ds_accent_soft),
      )
      setOnClickListener { createNewConversation() }
    }, LinearLayout.LayoutParams(-1, -2))
    panel.addView(TextView(this).apply {
      text = copy.recent
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setTextColor(getColor(R.color.ds_text_secondary))
      setPadding(space(10), space(16), space(10), space(6))
    })
    drawerList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    panel.addView(ScrollView(this).apply {
      isFillViewport = true
      addView(drawerList, ViewGroup.LayoutParams(-1, -2))
    }, LinearLayout.LayoutParams(-1, 0, 1f))
    val width = minOf((resources.displayMetrics.widthPixels * 0.82f).toInt(), space(340))
    shellHost.addView(drawer, FrameLayout.LayoutParams(width, -1).apply { gravity = Gravity.START })
    drawerScrim?.bringToFront()
    drawer?.bringToFront()
  }

  private fun openConversationDrawer() {
    drawerList.removeAllViews()
    val refs = RepairConversationStore.list(filesDir)
    if (refs.isEmpty()) {
      drawerList.addView(TextView(this).apply {
        text = copy.noConversations
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setTextColor(getColor(R.color.ds_text_secondary))
        setPadding(space(10), space(12), space(10), space(12))
      })
    }
    for (ref in refs) {
      val item = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(space(10), space(9), space(8), space(9))
        background = DsUi.ripple(
          DsUi.roundRect(if (ref.id == currentSessionId) getColor(R.color.ds_surface)
            else Color.TRANSPARENT, resources.getDimension(R.dimen.ds_radius_sm)),
          getColor(R.color.ds_accent_soft),
        )
        setOnClickListener {
          closeConversationDrawer()
          if (ref.id != currentSessionId) switchConversation(ref.id)
        }
      }
      item.addView(TextView(this).apply {
        text = ref.title
        maxLines = 2
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setTextColor(if (ref.id == currentSessionId) getColor(R.color.ds_accent)
          else getColor(R.color.ds_text_primary))
      })
      if (ref.id == currentSessionId) item.addView(TextView(this).apply {
        text = copy.current
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        setTextColor(getColor(R.color.ds_text_secondary))
        setPadding(0, space(2), 0, 0)
      })
      drawerList.addView(item, LinearLayout.LayoutParams(-1, -2))
    }
    drawerScrim?.visibility = View.VISIBLE
    drawer?.visibility = View.VISIBLE
  }

  private fun closeConversationDrawer() {
    drawer?.visibility = View.GONE
    drawerScrim?.visibility = View.GONE
  }

  private fun beginAutomaticRepair() {
    synchronized(sessionLock) {
      history.put(JSONObject().put("role", "system").put("content", SYSTEM_PROMPT))
    }
    saveCurrentSession()
    addSystemMessage(s("引擎未能启动。我会自动读取本轮诊断，检查运行时并尝试修复。", "The engine did not start. I will read this run's diagnostics, check the runtime and try to repair it."))
    addSystemMessage(s("已收集本轮诊断", "Collected this run's diagnostics"), s("诊断已就绪", "Diagnostics ready"))
    val displayPrompt = s("自动排查本轮启动失败并尝试修复。", "Automatically inspect this run's startup failure and try to repair it.")
    val modelPrompt = buildString {
      append("自动排查主引擎启动失败，结合以下本轮诊断目录与预检简报（preflight）按需查看文件并实际修复、重启验证，不要只给建议。")
      val context = diagnosticText
      if (!context.isNullOrBlank()) {
        append("\n\n").append(context)
      }
    }
    runAgent(modelPrompt, displayPrompt)
  }

  /**
   * 打开（或新建）会话。**只做会话本身的事**：配置解码不在这里。
   *
   * #1017：这里原先调 `RepairModelConfig.load(applicationContext)`，于是 onCreate（主线程）
   * 先把整份模型配置解析一遍，紧接着 worker 里的 `loadRepairModels()` 又把同一份配置完整
   * 解析第二遍——一次打开解析两遍，且第一遍在主线程（还会顺带原子写一次
   * `repair-model-source.json`）。现在唯一解码点是后台的 `loadRepairModels()`；
   * 这里只记下恢复出的模型偏好，等候选到达后由 `restoreSelection()` 落定。
   */
  private fun openOrCreateSession(restoredId: String? = null) {
    val session = restoredId?.let { RepairConversationStore.load(filesDir, it) }
      ?: RepairConversationStore.create(filesDir)
    val (interruptedClosed, eventsSnapshot) = synchronized(sessionLock) {
      currentSessionId = session.id
      currentTitle = session.title
      history = JSONArray(session.history.toString())
      eventLog = JSONArray(session.events.toString())
      val closed = RepairToolCallParser.completeInterruptedTail(history)
      closed to RepairSessionJson.copy(eventLog)
    }
    if (interruptedClosed) saveCurrentSession()
    // 候选尚未解码：先把会话里记下的身份/强度留下，等 connections 到位后再解析成索引。
    pendingIdentity = session.modelIdentity
    pendingEffort = session.reasoningEffort
    renderEvents(eventsSnapshot)
  }

  private fun createNewConversation() {
    if (busy.get()) return
    saveCurrentSession()
    clearStreamingUi(removePending = true)
    val session = RepairConversationStore.create(filesDir)
    synchronized(sessionLock) {
      currentSessionId = session.id
      currentTitle = session.title
      history = JSONArray()
      eventLog = JSONArray()
    }
    conversation.removeAllViews()
    closeConversationDrawer()
    if (diagnosticsReady && connections.isNotEmpty() && defaultModelAvailable) {
      beginAutomaticRepair()
    } else {
      saveCurrentSession()
      addSystemMessage(
        when {
          connections.isEmpty() -> s(
            "已新建修复会话。当前没有可用模型，请先在控制台修复配置并点击「重新读取模型配置」，再发送修复需求。",
            "Created a new repair session. No model is available; fix configuration in the console and reload models before sending.",
          )
          !defaultModelAvailable -> s(
            "已新建修复会话。当前默认模型不可用，请先点右上角选择可用模型，再发送修复需求。",
            "Created a new repair session. The default model is unavailable; choose a model at the top right before sending.",
          )
          else -> s(
            "已新建修复会话。本轮诊断尚未就绪，未自动开始修复；你可以直接输入故障描述发送，或返回启动页重试引擎。",
            "Created a new repair session. Diagnostics are not ready yet, so automatic repair did not start; describe the problem to send, or return and retry the engine.",
          )
        },
      )
    }
  }

  private fun switchConversation(id: String) {
    if (busy.get()) return
    saveCurrentSession()
    clearStreamingUi(removePending = true)
    val session = RepairConversationStore.load(filesDir, id) ?: return
    val (interruptedClosed, eventsSnapshot) = synchronized(sessionLock) {
      currentSessionId = session.id
      currentTitle = session.title
      history = JSONArray(session.history.toString())
      eventLog = JSONArray(session.events.toString())
      val closed = RepairToolCallParser.completeInterruptedTail(history)
      closed to RepairSessionJson.copy(eventLog)
    }
    if (interruptedClosed) saveCurrentSession()
    restoreSelection(session)
    conversation.removeAllViews()
    renderEvents(eventsSnapshot)
    scrollToBottom()
  }

  /**
   * 把「会话偏好的模型 + 推理强度」解析成当前候选下标。
   *
   * #1017：候选改为后台解码后，打开会话时 connections 还是空的，偏好只能先记在
   * [pendingIdentity]/[pendingEffort] 里，等 worker 拿到候选再落定（显式传 session 的
   * 路径——切会话——仍以传入的会话为准）。否则恢复会话会静默退回第一个候选。
   */
  private fun restoreSelection(session: RepairConversation? = null) {
    val identity = session?.modelIdentity ?: pendingIdentity
    val index = connections.indexOfFirst { it.identity == identity }
    selectedModel = if (index >= 0) index else 0
    val wanted = session?.reasoningEffort ?: pendingEffort
    selectedEffort = wanted?.takeIf { effort ->
      connections.getOrNull(selectedModel)?.reasoningEfforts?.any { it.id == effort } == true
    } ?: connections.getOrNull(selectedModel)?.defaultReasoningEffort
    if (connections.isNotEmpty()) {
      pendingIdentity = null
      pendingEffort = null
    }
  }

  private fun renderEvents(events: JSONArray) {
    for (i in 0 until events.length()) {
      val event = events.optJSONObject(i) ?: continue
      when (event.optString("type")) {
        "user" -> addUserMessage(event.optString("text"))
        "assistant" -> addAssistantMessage(event.optString("text"))
        "reasoning" -> addReasoningCard(event.optString("text"))
        "system" -> addSystemMessage(event.optString("text"), event.optString("label").ifBlank { s("修复助手", "Repair assistant") })
        "tool" -> addRestoredToolCard(event.optString("name"), event.optString("summary"))
        "diagnostic" -> {
          // Protocol evidence stays in the durable event log for the next repair
          // turn and support; it is not chat content shown to the user.
          Unit
        }
      }
    }
  }

  private fun recordEvent(event: JSONObject, save: Boolean = true) {
    // User messages may legitimately repeat. Protocol diagnostics may be
    // recorded by more than one cleanup path, so deduplicate only that private
    // event class and leave visible chat events untouched.
    synchronized(sessionLock) {
      if (event.optString("type") == "diagnostic") {
        val encoded = event.toString()
        for (i in eventLog.length() - 1 downTo 0) {
          if (eventLog.optJSONObject(i)?.toString() == encoded) return
        }
      }
      eventLog.put(event)
    }
    if (save) saveCurrentSession()
  }

  /**
   * 冻结当前会话并**提交**给写线程。
   *
   * #1017：修前这里在调用线程上做两件重活——把 history/events 各过一遍 `toString()` +
   * 重新解析（整份会话 JSON 的序列化/反序列化），然后 `RepairConversationStore.save` 原子
   * 落盘并重写索引、扫描目录。调用点包含主线程路径（自动开修、切会话、关模型面板、
   * onDestroy），等于把整份会话的序列化与文件 IO 压在主线程上。
   *
   * 现在：主线程只做 O(元素数) 的结构深拷贝（不起整份字符串），落盘交给
   * [RepairSessionWriter] 的单线程串行写。顺序语义由写线程保证——同一时刻只有一笔在写，
   * 且提交之间以最新一笔覆盖旧的，所以「切会话时先存旧、再载新」不会出现旧数据覆盖新数据。
   * 退出（onDestroy）显式 [RepairSessionWriter.flush]，最后一笔不丢。
   */
  private fun saveCurrentSession() {
    val snapshot = synchronized(sessionLock) {
      val id = currentSessionId ?: return
      var firstUser = ""
      for (i in 0 until history.length()) {
        val message = history.optJSONObject(i) ?: continue
        if (message.optString("role") == "user") { firstUser = message.optString("content"); break }
      }
      if (firstUser.isNotBlank()) currentTitle = firstUser.lineSequence().firstOrNull()
        ?.trim()?.take(48)?.takeIf { it.isNotBlank() } ?: currentTitle
      RepairConversation(
        id = id,
        title = currentTitle,
        history = RepairSessionJson.copy(history),
        events = RepairSessionJson.copy(eventLog),
        modelIdentity = connections.getOrNull(selectedModel)?.identity ?: pendingIdentity,
        reasoningEffort = selectedEffort,
      )
    }
    sessionWriter.submit(snapshot)
  }

  private fun onSendButton() {
    if (busy.get()) {
      val text = input.text.toString().trim()
      when (repairActionMode(busy = true, draftText = text)) {
        RepairActionMode.STEER_SEND -> enqueueSteeringMessage(text)
        RepairActionMode.STOP -> cancelWork()
        RepairActionMode.SEND -> submit()
      }
    } else {
      submit()
    }
  }

  private fun enqueueSteeringMessage(text: String) {
    val accepted = synchronized(queueLock) {
      if (!busy.get()) {
        false
      } else {
        val statusView = addQueuedUserMessageOnMain(text)
        pendingUserMessages.add(PendingUserMessage(text, statusView))
        true
      }
    }
    if (accepted) {
      input.setText("")
    } else {
      submit()
    }
  }

  private fun submit() {
    if (busy.get()) return
    val text = input.text.toString().trim()
    // 判定在 RepairModelNotice（纯函数、可单测）；这里只落结果。
    // 关键顺序（issue #1012 A3）：先按判定确认真的要发，再清空输入。
    // 旧实现先 input.setText("") 再在 runAgent() 里无候选时静默 return——
    // 用户打的字凭空消失且界面毫无反应。
    val decision = RepairModelNotice.composer(connections.size, text)
    // Do not append a duplicate prompt when the user taps send on an empty composer.
    if (!decision.send && !decision.notifyNoModel) return
    if (decision.notifyNoModel) {
      addSystemMessage(UiText.t(this,
        s("没有可用模型，这条消息没有发出，内容已保留在输入框。请先重新读取模型配置，或返回启动页重试引擎。",
        "No model is available, so this message was not sent. Your text is kept in the input box; reload the model configuration or retry the engine from the start page."),
        "No model is available, so this message was not sent. Your draft is kept in the composer. Reload the model configuration, or go back and retry the engine."))
      return
    }
    input.setText("")
    runAgent(text)
  }

  private fun runAgent(prompt: String, displayPrompt: String = prompt) {
    if (connections.isEmpty() || !busy.compareAndSet(false, true)) return
    val connection = connections[selectedModel.coerceIn(0, connections.lastIndex)]
    activeConnection = connection
    val effort = selectedEffort.takeIf { id ->
      id != null && connection.reasoningEfforts.any { it.id == id }
    }
    setBusy(true)
    // A stop or process death can leave the final provider-issued batch
    // unfinished. Close it with truthful cancellation results before appending
    // the next user turn, without rewriting any prior assistant text or result.
    synchronized(sessionLock) {
      RepairToolCallParser.completeInterruptedTail(history)
      if (history.length() == 0) {
        history.put(JSONObject().put("role", "system").put("content", SYSTEM_PROMPT))
      }
      val hasUser = (0 until history.length()).any {
        history.optJSONObject(it)?.optString("role") == "user"
      }
      val fullPrompt = if (!hasUser && !diagnosticText.isNullOrBlank() && !prompt.contains("preflight=")) {
        prompt + "\n\n" + diagnosticText
      } else {
        prompt
      }
      eventLog.put(JSONObject().put("type", "user").put("text", displayPrompt))
      history.put(JSONObject().put("role", "user").put("content", safe(fullPrompt)))
    }
    saveCurrentSession()
    addUserMessage(displayPrompt)
    addActivity(s("正在分析诊断", "Analysing diagnostics"))
    startRepairWorker(connection, effort)
  }

  private fun startRepairWorker(connection: RepairModelConnection, effort: String?) {
    worker = Thread {
      var completed = false
      var stopReason: String? = null
      try {
        val activeClient = RepairModelClient()
        client = activeClient
        val activeTools = tools ?: throw IllegalStateException("RepairTools not initialized")
        val tracker = RepairLoopGuard.LoopTracker()
        val batchProgress = RepairBatchProgressTracker()
        var stateVersion = 0
        var lastTextual = false

        while (true) {
          if (!alive || Thread.currentThread().isInterrupted) throw InterruptedException()
          val batchDecision = tracker.beginBatch()
          if (batchDecision.shouldStop) {
            stopReason = batchDecision.reason
            break
          }

          val outboundSnapshot = synchronized(sessionLock) { RepairSessionJson.copy(history) }
          val streamUi = StreamingTurnUi()
          activeStreamUi = streamUi
          // The outbound client keeps the provider-native tool sequence. Only an
          // explicit route compatibility flag may select another representation;
          // the canonical history in memory and on disk never changes shape.
          val answer = try {
            activeClient.complete(connection, outboundSnapshot, activeTools.definitions(), effort, streamUi)
          } catch (failure: Exception) {
            streamUi.dispose()
            if (activeStreamUi === streamUi) activeStreamUi = null
            // A protocol rejection leaves the prior call and its results in the
            // canonical history. Persist that exact state before surfacing the
            // error so reopening the conversation cannot lose the failed batch,
            // and never try to infer a repaired shape from the UI transcript.
            if (!Thread.currentThread().isInterrupted && alive) {
              recordEvent(
                JSONObject()
                  .put("type", "diagnostic")
                  .put("code", "model-request-failed")
                  .put("messages", activeClient.lastOutboundMessages)
                  .put("digest", activeClient.lastOutboundDigest)
                  .put("detail", safe(failure.message ?: failure.javaClass.simpleName)),
              )
            }
            throw failure
          }
          if (!alive || Thread.currentThread().isInterrupted) {
            streamUi.dispose()
            if (activeStreamUi === streamUi) activeStreamUi = null
            throw InterruptedException()
          }
          // Preserve the provider's text and reasoning bytes, while isolating the
          // array element from any temporary gateway envelope fields.
          synchronized(sessionLock) {
            history.put(JSONObject(answer.toString()))
          }
          lastTextual = RepairToolCallParser.textualToolCalls(answer)
          // issue #1014：取值走 RepairToolCallParser.reasoningText —— Android 的 org.json 会把
          // JSONObject.NULL 渲染成字符串 "null"，直接 optString + isNotBlank 会把它当成真实推理，
          // 于是多出一张正文只有 null 的「思考」卡并被 recordEvent 写进会话事件（重开会话仍在）。
          val reasoning = RepairToolCallParser.reasoningText(answer)
          val text = RepairToolCallParser.displayableText(answer.optString("content", ""))
          uiSync {
            streamUi.finishOnMain(reasoning, text)
            if (activeStreamUi === streamUi) activeStreamUi = null
          }
          if (reasoning.isNotBlank()) {
            recordEvent(JSONObject().put("type", "reasoning").put("text", reasoning), save = false)
          }
          if (text.isNotBlank()) {
            recordEvent(JSONObject().put("type", "assistant").put("text", text), save = false)
          }
          saveCurrentSession()

          val calls = answer.optJSONArray("tool_calls")
          if (calls == null || calls.length() == 0) {
            val canAttemptNext = tracker.steps < RepairLoopGuard.MAX_STEPS &&
              tracker.toolCalls < RepairLoopGuard.MAX_TOOL_CALLS &&
              tracker.outputBytes <= RepairLoopGuard.MAX_TOTAL_OUTPUT_BYTES - BUDGET_MARKER_BYTES
            val queued = if (canAttemptNext) drainPendingMessages() else emptyList()
            if (queued.isNotEmpty() && alive && !Thread.currentThread().isInterrupted) {
              consumeQueuedMessages(queued)
              addActivity(s("继续处理补充信息", "Processing follow-up message"))
              continue
            }
            if (!canAttemptNext && hasPendingMessages()) {
              stopReason = when {
                tracker.steps >= RepairLoopGuard.MAX_STEPS -> "max-steps"
                tracker.toolCalls >= RepairLoopGuard.MAX_TOOL_CALLS -> "max-tool-calls"
                else -> "max-total-output-bytes"
              }
              break
            }
            completed = true
            break
          }

          var batchMadeProgress = false
          val batchErrorCodes = ArrayList<String?>(calls.length())
          var batchStopReason: String? = null

          for (i in 0 until calls.length()) {
            if (!alive || Thread.currentThread().isInterrupted) throw InterruptedException()
            val call = calls.getJSONObject(i)
            val fn = call.optJSONObject("function") ?: JSONObject()
            val name = fn.optString("name", "")
            val callId = call.optString("id", "")
            val rawArgs = rawFunctionArguments(fn)

            removePendingActivity()
            addToolCard(name, s("正在执行", "Running"))

            val callDecision = tracker.beforeCall(name, rawArgs, "v$stateVersion")
            val rawOutcome: String
            if (!callDecision.allowCall) {
              if (callDecision.shouldStop && batchStopReason == null) {
                batchStopReason = callDecision.reason
              }
              rawOutcome = repairToolRefusalJson(callDecision.reason)
              batchErrorCodes += callDecision.reason
            } else {
              val parsedArgs = parseToolArgumentsObject(rawArgs)
              if (parsedArgs == null) {
                rawOutcome = repairToolInvalidArgumentsJson()
                batchErrorCodes += "invalid-arguments"
              } else {
                val executed = try {
                  activeTools.execute(name, parsedArgs)
                } catch (e: InterruptedException) {
                  throw e
                } catch (e: Exception) {
                  JSONObject()
                    .put("ok", false)
                    .put("error", "tool-execution-failed")
                    .put("message", e.message ?: e.javaClass.simpleName)
                    .toString()
                }
                val sanitized = safe(executed)
                rawOutcome = sanitized
                val obs = batchProgress.observe(name, rawArgs, sanitized, stateVersion)
                if (obs.stateChanged) stateVersion++
                if (obs.madeProgress) batchMadeProgress = true
                batchErrorCodes += obs.errorCode
              }
            }

            val prepared = tracker.prepareResult(rawOutcome)
            if (prepared.decision.shouldStop && batchStopReason == null) {
              batchStopReason = prepared.decision.reason
            }
            val result = prepared.content
              ?: repairToolRefusalJson(prepared.decision.reason ?: callDecision.reason)

            synchronized(sessionLock) {
              if (lastTextual) {
                // Text DSML has no gateway-level tool id. Returning an invented id
                // in a tool role causes the next turn to be rejected. Give the model
                // the observation as data and keep the JSON protocol valid.
                history.put(
                  JSONObject().put("role", "user").put(
                    "content",
                    s("工具 ", "Tool ") + name + s(" 的执行结果：\n", " result:\n") + result,
                  ),
                )
              } else {
                history.put(
                  JSONObject().put("role", "tool").put("tool_call_id", callId).put("content", result),
                )
              }
            }
            recordEvent(JSONObject().put("type", "tool").put("name", name).put("summary", toolSummary(result)))
            finishToolCard(result)
          }

          val finishDecision = tracker.finishBatch(batchMadeProgress, batchErrorCodes)
          if (finishDecision.shouldStop || batchStopReason != null) {
            stopReason = finishDecision.reason ?: batchStopReason
            break
          }

          val queued = drainPendingMessages()
          if (queued.isNotEmpty() && alive && !Thread.currentThread().isInterrupted) {
            consumeQueuedMessages(queued)
          }
          addActivity(s("继续分析修复结果", "Analysing the repair result"))
        }

        if (!completed) {
          removePendingActivity()
          val unconsumed = drainPendingMessages()
          markPendingMessagesCancelled(unconsumed)
          addSystemMessage(repairStopReasonMessage(stopReason, UiText.isEnglish(this)))
        }
      } catch (_: InterruptedException) {
        // FutureTask.get and tool cancellation both surface as an interrupt.
        // Clear that transient flag before the cleanup UI call so a stop cannot
        // turn into a second fatal exception on the worker thread.
        Thread.interrupted()
        clearStreamingUi(removePending = false)
        markPendingMessagesCancelled(drainPendingMessages())
        synchronized(sessionLock) {
          RepairToolCallParser.completeInterruptedTail(history)
        }
        saveCurrentSession()
        if (alive) {
          runCatching { removePendingActivity() }
          runCatching { addSystemMessage(s("已停止修复。已完成的文件修改仍然保留。", "Repair stopped. File changes already made are kept.")) }
        }
      } catch (e: Exception) {
        clearStreamingUi(removePending = false)
        markPendingMessagesCancelled(drainPendingMessages())
        if (!alive) return@Thread
        if (Thread.currentThread().isInterrupted ||
          e.message.orEmpty().contains("Socket closed", ignoreCase = true)) {
          Thread.interrupted()
          synchronized(sessionLock) {
            RepairToolCallParser.completeInterruptedTail(history)
          }
          saveCurrentSession()
          runCatching { removePendingActivity() }
          runCatching { addSystemMessage(s("已停止修复。已完成的文件修改仍然保留。", "Repair stopped. File changes already made are kept.")) }
          return@Thread
        }
        if (alive) {
          runCatching { removePendingActivity() }
          runCatching { addSystemMessage(s("修复中断：", "Repair interrupted: ") + safe(e.message ?: e.javaClass.simpleName)) }
        }
      } finally {
        client = null
        connections.forEach { it.clearCredential() }
        saveCurrentSession()
        if (!alive) {
          synchronized(queueLock) {
            pendingUserMessages.clear()
            busy.set(false)
          }
          return@Thread
        }
        // #1017：本轮结束要重新读配置（凭据在上面已从连接对象上抹掉，下一轮必须重新取），
        // 但整份解码原先发生在 runOnUiThread 里 = 主线程上又解析一遍配置。这里改走与
        // 打开时同一个解码入口 loadRepairModels()，仍在 worker 线程上，主线程只拿到结果赋值。
        val reloaded = runCatching { loadRepairModels() }
        val refreshed = reloaded.getOrNull()
        val refreshFailure = reloaded.exceptionOrNull()?.let {
          UiText.t(this, "读取模型配置失败：", "Could not read model configuration: ") + it.javaClass.simpleName
        }
        runOnUiThread {
          if (!alive) {
            synchronized(queueLock) {
              pendingUserMessages.clear()
              busy.set(false)
            }
            return@runOnUiThread
          }
          if (refreshed != null) {
            connections = refreshed
            restoreSelection()
          } else {
            selectedModel = selectedModel.coerceIn(0, connections.lastIndex.coerceAtLeast(0))
          }
          val candidateReady = connections.isNotEmpty() &&
            connections[selectedModel.coerceIn(0, connections.lastIndex)].apiKey.isNotBlank()
          val followUps = synchronized(queueLock) {
            if (completed && candidateReady && pendingUserMessages.isNotEmpty()) {
              pendingUserMessages.toList().also { pendingUserMessages.clear() }
            } else {
              if (pendingUserMessages.isNotEmpty()) {
                val cancelled = pendingUserMessages.toList()
                pendingUserMessages.clear()
                markPendingMessagesCancelledOnMain(cancelled)
              }
              busy.set(false)
              emptyList()
            }
          }
          if (followUps.isNotEmpty()) {
            applyModelState(refreshFailure)
            for (item in followUps) {
              item.statusView.visibility = View.GONE
            }
            synchronized(sessionLock) {
              for (item in followUps) {
                eventLog.put(JSONObject().put("type", "user").put("text", item.text))
                history.put(JSONObject().put("role", "user").put("content", safe(item.text)))
              }
            }
            saveCurrentSession()
            val nextConnection = connections[selectedModel.coerceIn(0, connections.lastIndex)]
            activeConnection = nextConnection
            val nextEffort = selectedEffort.takeIf { id ->
              id != null && nextConnection.reasoningEfforts.any { it.id == id }
            }
            setBusy(true)
            addActivity(s("继续分析补充信息", "Analysing follow-up details"))
            startRepairWorker(nextConnection, nextEffort)
          } else {
            setBusy(false)
            applyModelState(refreshFailure)
          }
        }
      }
    }.apply { name = "dsh-native-repair"; start() }
  }

  private fun rawFunctionArguments(fn: JSONObject): String = when (val value = fn.opt("arguments")) {
    null, JSONObject.NULL -> "{}"
    is String -> value.trim().let { if (it.isEmpty() || it == "null") "{}" else it }
    is JSONObject -> value.toString()
    else -> value.toString()
  }

  private fun hasPendingMessages(): Boolean = synchronized(queueLock) {
    pendingUserMessages.isNotEmpty()
  }

  private fun drainPendingMessages(): List<PendingUserMessage> = synchronized(queueLock) {
    if (pendingUserMessages.isEmpty()) emptyList()
    else pendingUserMessages.toList().also { pendingUserMessages.clear() }
  }

  private fun consumeQueuedMessages(items: List<PendingUserMessage>) {
    if (items.isEmpty()) return
    synchronized(sessionLock) {
      for (item in items) {
        eventLog.put(JSONObject().put("type", "user").put("text", item.text))
        history.put(JSONObject().put("role", "user").put("content", safe(item.text)))
      }
    }
    saveCurrentSession()
    uiSync {
      for (item in items) {
        item.statusView.visibility = View.GONE
      }
    }
  }

  private fun markPendingMessagesCancelled(items: List<PendingUserMessage>) {
    if (items.isEmpty() || !alive) return
    runOnUiThread {
      if (!alive) return@runOnUiThread
      markPendingMessagesCancelledOnMain(items)
    }
  }

  private fun markPendingMessagesCancelledOnMain(items: List<PendingUserMessage>) {
    for (item in items) {
      item.statusView.text = copy.cancelledUnsent
      item.statusView.setTextColor(getColor(R.color.ds_danger))
    }
  }

  private fun setBusy(value: Boolean) = uiSync {
    input.isEnabled = true
    reloadModels?.isEnabled = !value
    modelButton.isEnabled = connections.isNotEmpty()
    // 发送键在空闲态始终可点（issue #1012 A3）；0 候选时点击由 submit() 给出可见提示
    // 并保留草稿，而不是让用户对着一颗点不动的按钮猜。
    send.isEnabled = true
    styleSendButton(this, send, repairActionMode(value, input.text))
  }

  private fun updateSendButton() {
    styleSendButton(this, send, repairActionMode(busy.get(), input.text))
  }

  /** One circular control swaps send, queued steer-send, and stop without changing color hierarchy. */
  private fun styleSendButton(activity: Activity, button: ImageButton, mode: RepairActionMode) {
    when (mode) {
      RepairActionMode.SEND -> {
        button.setImageResource(R.drawable.dsh_ic_send)
        button.contentDescription = copy.send
      }
      RepairActionMode.STEER_SEND -> {
        button.setImageResource(R.drawable.dsh_ic_send)
        button.contentDescription = copy.steerSend
      }
      RepairActionMode.STOP -> {
        button.setImageResource(R.drawable.dsh_ic_stop)
        button.contentDescription = copy.stop
      }
    }
    button.setColorFilter(activity.getColor(R.color.ds_text_on_accent))
    button.background = DsUi.ripple(
      DsUi.oval(activity.getColor(R.color.ds_accent)),
      activity.getColor(R.color.ds_accent_pressed),
    )
  }

  private fun addUserMessage(text: String) = uiSync {
    createUserMessageOnMain(text, statusText = null)
  }

  private fun addQueuedUserMessageOnMain(text: String): TextView =
    createUserMessageOnMain(text, statusText = copy.queued)!!

  private fun createUserMessageOnMain(text: String, statusText: String?): TextView? {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.END
      setPadding(space(48), space(6), space(12), space(6))
    }
    row.addView(TextView(this).apply {
      this.text = text
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      setTextColor(getColor(R.color.ds_text_on_accent))
      setLineSpacing(0f, 1.3f)
      setTextIsSelectable(true)
      setPadding(space(15), space(10), space(15), space(10))
      background = DsUi.roundRect(getColor(R.color.ds_accent),
        resources.getDimension(R.dimen.ds_radius_card))
    }, LinearLayout.LayoutParams(-2, -2))
    val statusView = if (statusText != null) {
      TextView(this).apply {
        this.text = statusText
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        setTextColor(getColor(R.color.ds_text_secondary))
        setPadding(0, space(3), space(4), 0)
      }.also { row.addView(it, LinearLayout.LayoutParams(-2, -2)) }
    } else null
    addToConversation(row)
    return statusView
  }

  private fun addAssistantMessage(text: String) = uiSync {
    createAssistantBubble(text)
  }

  private fun createAssistantBubble(text: String): Pair<View, TextView> {
    val row = LinearLayout(this).apply {
      gravity = Gravity.START
      setPadding(space(12), space(6), space(40), space(6))
    }
    val bubble = TextView(this).apply {
      this.text = text
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      setTextColor(getColor(R.color.ds_text_primary))
      setLineSpacing(0f, 1.45f)
      setTextIsSelectable(true)
      movementMethod = LinkMovementMethod.getInstance()
      setPadding(space(14), space(10), space(14), space(10))
      background = DsUi.roundRect(getColor(R.color.ds_surface),
        resources.getDimension(R.dimen.ds_radius_card), getColor(R.color.ds_hairline))
    }
    row.addView(bubble, LinearLayout.LayoutParams(-2, -2))
    addToConversation(row)
    return row to bubble
  }

  private fun addReasoningCard(text: String) = uiSync {
    createReasoningCard(text)
  }

  private fun createReasoningCard(text: String): Pair<View, TextView> {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(space(12), space(4), space(20), space(4))
    }
    // Reasoning stays in the transcript as a quiet, explicitly labelled block.
    // Its text is selectable and expands fully, so the user can inspect the
    // provider's own words without confusing them with the final answer.
    val toggle = TextView(this).apply {
      this.text = copy.thinking
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTextColor(getColor(R.color.ds_text_secondary))
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setPadding(space(2), space(3), space(2), space(3))
    }
    val detail = TextView(this).apply {
      this.text = text
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTextColor(getColor(R.color.ds_text_secondary))
      setLineSpacing(0f, 1.35f)
      setTextIsSelectable(true)
      setPadding(space(10), space(8), space(10), space(8))
      background = DsUi.roundRect(getColor(R.color.ds_surface_muted),
        resources.getDimension(R.dimen.ds_radius_sm), getColor(R.color.ds_hairline))
      visibility = View.VISIBLE
    }
    toggle.setOnClickListener {
      val show = detail.visibility != View.VISIBLE
      detail.visibility = if (show) View.VISIBLE else View.GONE
      toggle.text = if (show) copy.thinking + "  ▾" else copy.thinking + "  ▸"
    }
    row.addView(toggle, LinearLayout.LayoutParams(-2, -2))
    row.addView(detail, LinearLayout.LayoutParams(-1, -2))
    addToConversation(row)
    return row to detail
  }

  private inner class StreamingTurnUi : RepairStreamListener {
    private val bufferLock = Any()
    private val reasoningBuf = StringBuilder()
    private val textBuf = StringBuilder()
    private var flushPending = false
    private var lastFlushMs = 0L
    private var lastScrollMs = 0L
    @Volatile private var active = true
    private var reasoningView: TextView? = null
    private var assistantView: TextView? = null
    private var reasoningCardRow: View? = null
    private var assistantCardRow: View? = null

    private val flushTask = Runnable {
      runOnUiThread {
        if (!alive || !active || activeStreamUi !== this) return@runOnUiThread
        flushOnMain()
      }
    }

    override fun onReasoningDelta(delta: String) {
      if (delta.isEmpty()) return
      val delayMs: Long?
      synchronized(bufferLock) {
        if (!active) return
        reasoningBuf.append(delta)
        if (flushPending) {
          delayMs = null
        } else {
          flushPending = true
          val elapsed = SystemClock.uptimeMillis() - lastFlushMs
          delayMs = (STREAM_THROTTLE_MS - elapsed).coerceAtLeast(0L)
        }
      }
      if (delayMs != null) scheduleFlush(delayMs)
    }

    override fun onTextDelta(delta: String) {
      if (delta.isEmpty()) return
      val delayMs: Long?
      synchronized(bufferLock) {
        if (!active) return
        textBuf.append(delta)
        if (flushPending) {
          delayMs = null
        } else {
          flushPending = true
          val elapsed = SystemClock.uptimeMillis() - lastFlushMs
          delayMs = (STREAM_THROTTLE_MS - elapsed).coerceAtLeast(0L)
        }
      }
      if (delayMs != null) scheduleFlush(delayMs)
    }

    private fun scheduleFlush(delayMs: Long) {
      if (delayMs <= 0L) {
        runOnUiThread {
          if (!alive || !active || activeStreamUi !== this) return@runOnUiThread
          flushOnMain()
        }
      } else {
        mainHandler.postDelayed(flushTask, delayMs)
      }
    }

    private fun flushOnMain() {
      val reasoningSnapshot: String
      val textSnapshot: String
      synchronized(bufferLock) {
        flushPending = false
        lastFlushMs = SystemClock.uptimeMillis()
        if (!active) return
        reasoningSnapshot = reasoningBuf.toString()
        textSnapshot = textBuf.toString()
      }
      var updated = false
      if (reasoningSnapshot.isNotBlank()) {
        removePendingActivityOnMain()
        val view = ensureReasoningView()
        if (view.text.toString() != reasoningSnapshot) {
          view.text = reasoningSnapshot
          updated = true
        }
      }
      if (textSnapshot.isNotBlank()) {
        removePendingActivityOnMain()
        val view = ensureAssistantView()
        if (view.text.toString() != textSnapshot) {
          view.text = textSnapshot
          updated = true
        }
      }
      if (updated) {
        val now = SystemClock.uptimeMillis()
        if (now - lastScrollMs >= STREAM_THROTTLE_MS) {
          lastScrollMs = now
          scrollToBottom()
        }
      }
    }

    private fun ensureReasoningView(): TextView {
      reasoningView?.let { return it }
      val (row, detail) = createReasoningCard("")
      reasoningCardRow = row
      reasoningView = detail
      return detail
    }

    private fun ensureAssistantView(): TextView {
      assistantView?.let { return it }
      val (row, bubble) = createAssistantBubble("")
      assistantCardRow = row
      assistantView = bubble
      return bubble
    }

    fun finishOnMain(finalReasoning: String, finalText: String) {
      synchronized(bufferLock) {
        active = false
        flushPending = false
      }
      mainHandler.removeCallbacks(flushTask)
      if (finalReasoning.isNotBlank()) {
        removePendingActivityOnMain()
        val view = reasoningView
        if (view != null) view.text = finalReasoning else createReasoningCard(finalReasoning)
      } else {
        reasoningCardRow?.let { row ->
          if (row.parent === conversation) conversation.removeView(row)
        }
      }
      if (finalText.isNotBlank()) {
        removePendingActivityOnMain()
        val view = assistantView
        if (view != null) view.text = finalText else createAssistantBubble(finalText)
      } else {
        assistantCardRow?.let { row ->
          if (row.parent === conversation) conversation.removeView(row)
        }
      }
      reasoningView = null
      assistantView = null
      reasoningCardRow = null
      assistantCardRow = null
      scrollToBottom()
    }

    fun dispose() {
      synchronized(bufferLock) {
        active = false
        flushPending = false
      }
      mainHandler.removeCallbacks(flushTask)
      reasoningView = null
      assistantView = null
      reasoningCardRow = null
      assistantCardRow = null
    }
  }

  private fun addSystemMessage(text: String, label: String = s("修复助手", "Repair assistant")) = uiSync {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(space(12), space(4), space(28), space(4))
    }
    if (label != s("修复助手", "Repair assistant")) {
      row.addView(TextView(this).apply {
        this.text = label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(getColor(R.color.ds_text_secondary))
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setPadding(space(2), 0, 0, space(2))
      })
    }
    row.addView(TextView(this).apply {
      this.text = text
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTextColor(getColor(R.color.ds_text_secondary))
      setLineSpacing(0f, 1.35f)
      setTextIsSelectable(true)
    })
    addToConversation(row)
  }

  private fun addRestoredToolCard(name: String, summary: String) = uiSync {
    val card = addToolCardOnMain(name, s("完成", "Done"))
    val title = card.getChildAt(0) as? LinearLayout
    title?.findViewWithTag<TextView>("tool-status")?.setTextColor(getColor(R.color.ds_ok))
    card.findViewWithTag<TextView>("tool-detail")?.text = summary
    card
  }

  private fun addActivity(label: String): LinearLayout = uiSync {
    removePendingActivityOnMain()
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(space(16), space(5), space(24), space(5))
    }
    row.addView(TextView(this).apply {
      text = "●"
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 8f)
      setTextColor(getColor(R.color.ds_accent))
      setPadding(0, 0, space(7), 0)
    })
    row.addView(TextView(this).apply {
      text = label
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTextColor(getColor(R.color.ds_text_secondary))
    })
    addToConversation(row)
    pendingActivity = row
    row
  }

  private fun addToolCard(name: String, status: String): LinearLayout = uiSync {
    val card = addToolCardOnMain(name, status)
    pendingActivity = card
    card
  }

  /** Tool cards default to a single summary row. Their payloads can be large. */
  private fun addToolCardOnMain(name: String, status: String): LinearLayout {
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(space(12), space(9), space(12), space(9))
      background = DsUi.roundRect(getColor(R.color.ds_chip),
        resources.getDimension(R.dimen.ds_radius_md), getColor(R.color.ds_hairline))
      tag = name
    }
    val title = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    title.addView(TextView(this).apply {
      text = toolTitle(name) + "  "
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setTextColor(getColor(R.color.ds_text_primary))
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    })
    title.addView(TextView(this).apply {
      text = status + "  ▸"
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setTextColor(getColor(R.color.ds_text_secondary))
      tag = "tool-status"
    }, LinearLayout.LayoutParams(0, -2, 1f))
    card.addView(title)
    val detail = TextView(this).apply {
      text = ""
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setTextColor(getColor(R.color.ds_text_secondary))
      setLineSpacing(0f, 1.3f)
      setTextIsSelectable(true)
      setPadding(0, space(6), 0, 0)
      visibility = View.GONE
      tag = "tool-detail"
    }
    card.addView(detail)
    card.setOnClickListener {
      val showing = detail.visibility != View.VISIBLE
      detail.visibility = if (showing) View.VISIBLE else View.GONE
      (title.findViewWithTag<TextView>("tool-status"))?.let {
        val plain = it.text.toString().removeSuffix(" ▸").removeSuffix(" ▾")
        it.text = plain + if (showing) "  ▾" else "  ▸"
      }
    }
    addToConversation(LinearLayout(this).apply {
      setPadding(space(12), space(3), space(24), space(3))
      addView(card, LinearLayout.LayoutParams(-1, -2))
    })
    return card
  }

  private fun finishToolCard(raw: String) {
    val summary = toolSummary(raw)
    val ok = runCatching {
      val json = JSONObject(raw)
      !json.has("error") && json.optBoolean("ok", !json.optBoolean("deferred", false))
    }.getOrDefault(true)
    uiSync {
      val card = pendingActivity as? LinearLayout
      pendingActivity = null
      card ?: return@uiSync
      val title = card.getChildAt(0) as? LinearLayout ?: return@uiSync
      val status = title.findViewWithTag<TextView>("tool-status")
      status?.text = (if (ok) copy.completed else s("未通过", "Failed")) + "  ▸"
      status?.setTextColor(getColor(if (ok) R.color.ds_ok else R.color.ds_warn))
      card.findViewWithTag<TextView>("tool-detail")?.text = summary
      scrollToBottom()
    }
  }

  private fun removePendingActivity() = uiSync {
    removePendingActivityOnMain()
  }

  private fun removePendingActivityOnMain() {
    val row = pendingActivity
    pendingActivity = null
    if (row != null && row.parent === conversation) conversation.removeView(row)
  }
  private fun addToConversation(view: View) {
    conversation.addView(view, LinearLayout.LayoutParams(-1, -2))
    scrollToBottom()
  }
  private fun scrollToBottom() = scroll.post { if (alive) scroll.fullScroll(ScrollView.FOCUS_DOWN) }

  private fun <T> uiSync(block: () -> T): T {
    if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return block()
    val result = AtomicReference<T>()
    val failure = AtomicReference<Throwable>()
    val latch = CountDownLatch(1)
    runOnUiThread {
      try {
        if (alive) result.set(block()) else failure.set(InterruptedException())
      } catch (error: Throwable) {
        failure.set(error)
      } finally {
        latch.countDown()
      }
    }
    // A stop press interrupts this worker while a view update may still be in
    // flight. Wait until the main thread owns and finishes that update, then
    // restore the flag so the outer catch/finally can run its durable save.
    var interrupted = false
    while (true) {
      try {
        latch.await()
        break
      } catch (_: InterruptedException) {
        interrupted = true
      }
    }
    if (interrupted) Thread.currentThread().interrupt()
    val error = failure.get()
    if (error is InterruptedException) throw InterruptedException()
    if (error != null) throw RuntimeException(error)
    @Suppress("UNCHECKED_CAST")
    return result.get() as T
  }

  private fun showModelSheet() {
    if (connections.isEmpty()) return
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(space(4), space(4), space(4), space(4))
    }
    fun addSection(label: String) {
      content.addView(TextView(this).apply {
        text = label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTextColor(getColor(R.color.ds_text_secondary))
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setPadding(space(12), space(10), space(12), space(4))
      })
    }
    addSection(s("模型", "Model"))
    var modelDialog: AlertDialog? = null
    for ((index, connection) in connections.withIndex()) {
      content.addView(TextView(this).apply {
        text = connection.modelLabel + "\n" + connection.providerLabel
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setTextColor(if (index == selectedModel) getColor(R.color.ds_accent)
          else getColor(R.color.ds_text_primary))
        setPadding(space(12), space(8), space(12), space(8))
        background = DsUi.ripple(DsUi.roundRect(if (index == selectedModel)
          getColor(R.color.ds_chip) else Color.TRANSPARENT, resources.getDimension(R.dimen.ds_radius_sm)),
          getColor(R.color.ds_accent_soft))
        setOnClickListener {
          selectedModel = index
          selectedEffort = connection.defaultReasoningEffort
          modelDialog?.dismiss()
        }
      })
    }
    val effortTitle = content.childCount
    addSection(s("推理强度", "Reasoning effort"))
    val effortStart = content.childCount
    val effortHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    fun fillEfforts() {
      effortHost.removeAllViews()
      val efforts = connections[selectedModel].reasoningEfforts
      if (efforts.isEmpty()) {
        effortHost.addView(TextView(this).apply {
          text = s("该模型未声明可调档位", "This model declares no adjustable effort levels")
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
          setTextColor(getColor(R.color.ds_text_secondary))
          setPadding(space(12), space(6), space(12), space(8))
        })
      } else for (effort in efforts) {
        effortHost.addView(TextView(this).apply {
          text = effort.label + (if (effort.id == selectedEffort) "  ✓" else "")
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
          setTextColor(if (effort.id == selectedEffort) getColor(R.color.ds_accent)
            else getColor(R.color.ds_text_primary))
          setPadding(space(12), space(7), space(12), space(7))
          setOnClickListener {
            selectedEffort = effort.id
            fillEfforts()
          }
        })
      }
    }
    fillEfforts()
    content.addView(effortHost)
    modelDialog = AlertDialog.Builder(this)
      .setTitle(copy.modelSheetTitle)
      .setView(ScrollView(this).apply { addView(content) })
      .setNegativeButton(copy.close, null)
      .show()
    modelDialog!!.setOnDismissListener {
      saveCurrentSession()
    }
  }

  private fun applyResponsiveLayout() {
    val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    if (landscape) {
      root.orientation = LinearLayout.VERTICAL
      scroll.setPadding(0, 0, 0, 0)
      conversation.setPadding(space(10), space(4), space(10), space(4))
      composer.setPadding(space(20), space(2), space(20), space(8))
      topBar.setPadding(space(8), space(2), space(10), space(2))
      navigationCluster.orientation = LinearLayout.VERTICAL
      navigationCluster.layoutParams = LinearLayout.LayoutParams(-2, -2)
      navigationCluster.getChildAt(0).layoutParams =
        LinearLayout.LayoutParams(space(42), space(42))
      navigationCluster.getChildAt(1).layoutParams =
        LinearLayout.LayoutParams(space(42), space(42)).apply { topMargin = space(4) }
    } else {
      root.orientation = LinearLayout.VERTICAL
      scroll.setPadding(0, 0, 0, 0)
      conversation.setPadding(0, space(10), 0, space(8))
      composer.setPadding(space(12), space(8), space(12), space(12))
      topBar.setPadding(space(8), space(8), space(10), space(8))
      navigationCluster.orientation = LinearLayout.VERTICAL
      navigationCluster.layoutParams = LinearLayout.LayoutParams(-2, -2)
      navigationCluster.getChildAt(0).layoutParams =
        LinearLayout.LayoutParams(space(42), space(42))
      navigationCluster.getChildAt(1).layoutParams =
        LinearLayout.LayoutParams(space(42), space(42)).apply { topMargin = space(4) }
    }
  }

  @Deprecated("The manifest keeps the native chat in place across rotation")
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyResponsiveLayout()
  }

  private fun applyInsets() {
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      insets
    }
    ViewCompat.requestApplyInsets(root)
  }

  private fun diagnosticContext(engine: EngineManager, preflightSummary: String): String {
    val dir = report
    val lines = StringBuilder()
    lines.append("runtimeDir=").append(engine.usrDir.absolutePath).append('\n')
    lines.append("homeDir=").append(engine.homeDir.absolutePath).append('\n')
    if (dir == null) {
      lines.append("diagnosticsDir=<unavailable>\n")
    } else {
      lines.append("diagnosticsDir=").append(dir.absolutePath)
      if (!dir.canonicalPath.startsWith(engine.dshDataDir.canonicalPath + File.separator)) {
        lines.append(" (app-private)")
      }
      lines.append('\n')
    }
    lines.append("preflight=").append(preflightSummary)
    return lines.toString()
  }

  private fun toolTitle(name: String): String = when (name) {
    "read" -> s("读取文件", "Read file")
    "write" -> s("写入修复", "Write repair")
    "edit" -> s("局部编辑", "Edit file")
    "list" -> s("查看目录", "List directory")
    "bash" -> s("运行命令", "Run command")
    "engine_status" -> s("检查引擎", "Check engine")
    "restart_engine" -> s("重启引擎", "Restart engine")
    "refresh_runtime" -> s("刷新运行时", "Refresh runtime")
    "preflight" -> s("运行预检", "Run preflight")
    else -> name
  }

  private fun toolSummary(raw: String): String {
    val value = runCatching { JSONObject(raw) }.getOrNull() ?: return raw.take(4000)
    return when {
      value.has("content") -> value.optString("path") + "\n" + value.optString("content").take(4000)
      value.has("entries") -> s("返回 ", "Returned ") + (value.optJSONArray("entries")?.length() ?: 0) + s(" 个条目", " entries")
      value.has("output") -> s("退出码 ", "Exit code ") + value.optString("exitCode", "?") + "\n" + value.optString("output").take(4000)
      value.has("findings") -> s("预检发现 ", "Preflight findings: ") + value.optInt("findingCount", value.optJSONArray("findings")?.length() ?: 0) + "\n" + raw.take(4000)
      value.has("error") -> {
        val code = value.optString("error")
        val msg = value.optString("message")
        if (msg.isNotBlank()) "$code: $msg".take(4000) else code
      }
      value.has("ok") -> if (value.optBoolean("ok")) s("操作成功", "Operation succeeded") else s("操作未成功", "Operation did not succeed")
      else -> raw.take(4000)
    }
  }

  private fun safe(text: String): String {
    var result = LogSanitizer.sanitizeOrNull(text) ?: s("[脱敏失败，已省略内容]", "[Redaction failed; content omitted]")
    connections.forEach { connection ->
      if (connection.apiKey.isNotEmpty()) result = result.replace(connection.apiKey, "***")
      connection.headers.values.filter { it.length >= 8 }.forEach { result = result.replace(it, "***") }
    }
    return result
  }

  private fun returnToLauncher() {
    if (busy.get()) {
      addSystemMessage(s("请先停止当前修复，再返回启动页。", "Stop the current repair before returning to the start page."))
      return
    }
    RepairState.active = false
    launchStartupPage(retry = false)
  }

  private fun cancelWork() {
    clearStreamingUi(removePending = true)
    client?.cancel()
    tools?.cancel()
    worker?.interrupt()
  }

  private fun clearStreamingUi(removePending: Boolean) {
    activeStreamUi?.dispose()
    activeStreamUi = null
    if (!removePending) return
    if (Looper.myLooper() == Looper.getMainLooper()) {
      removePendingActivityOnMain()
    } else if (alive) {
      runOnUiThread {
        if (!alive) return@runOnUiThread
        removePendingActivityOnMain()
      }
    }
  }

  private fun iconButton(icon: Int, label: String, action: () -> Unit): ImageButton =
    ImageButton(this).apply {
      setImageResource(icon)
      setBackgroundTintList(null)
      setColorFilter(getColor(R.color.ds_text_primary))
      scaleType = ImageView.ScaleType.CENTER
      setPadding(space(8), space(8), space(8), space(8))
      background = DsUi.ripple(DsUi.oval(getColor(R.color.ds_button_surface)),
        getColor(R.color.ds_accent_soft))
      contentDescription = label
      DsUi.bindPressScale(this)
      setOnClickListener { action() }
    }

  private fun space(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

  override fun onDestroy() {
    alive = false
    cancelWork()
    saveCurrentSession()
    // #1017：落盘已经在写线程上，退出前必须等到它落完，否则切后台/旋转后的最后一笔会话会丢。
    // flush 超时会在调用线程把最后一笔同步写完，宁慢不丢。
    sessionWriter.flush()
    RepairState.active = false
    super.onDestroy()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    // The durable store owns the transcript and complete protocol history. Only
    // the small Activity selection and composer draft need Android's bundle.
    currentSessionId?.let { outState.putString(STATE_SESSION_ID, it) }
    if (::input.isInitialized) outState.putString(STATE_INPUT, input.text.toString())
    super.onSaveInstanceState(outState)
  }

  companion object {
    private const val STATE_SESSION_ID = "repair.session.id"
    private const val STATE_INPUT = "repair.input"
    private const val STREAM_THROTTLE_MS = 60L
    private const val BUDGET_MARKER_BYTES = 24
    private const val SYSTEM_PROMPT = """你是打包在 Android APK 内的原生运行时修复助手。主引擎启动失败且自动恢复已停止；你独立于 Node、插件和 WebView，使用 DSH 模型连接自主定位并修复，不要只给建议。
核心路径：usr/（运行时文件树与动态库）、home/.dsh/profiles/web/cordis.patch.yml（活动配置）、package.json（profile 与 bundle 清单）。
排查纪律：先看首轮预检简报（preflight），按需用 read(tail=true)、read(offset, limit)、list、edit、preflight 查当前证据，避免从头整读大日志；区分历史日志与本轮事实。优先用 edit/write 最小修改（会自动备份；bash 修改前需先备份，bash 不可用时用原生文件工具）。修改后调 restart_engine 与 engine_status 验证；若运行时文件树或快照损坏，先调 refresh_runtime 再重启并验证。HTTP 可用不代表 WebView 插件就绪；未验证通过不得宣称已修复，最后提示用户点左上返回箭头回启动页验证。
止损收口：同一假设失败 2 次，或遇到凭据缺失、网络不可达、外部未归属进程占端口、APK 自身缺陷等外部阻塞时，立即停手并诚实汇报根因、已做改动与人工步骤。
安全红线：禁读或泄露凭据/密钥，禁下载或修改 APK，禁用 root，禁删用户会话、工作区或其它插件数据。使用简短中文汇报。"""
  }
}
