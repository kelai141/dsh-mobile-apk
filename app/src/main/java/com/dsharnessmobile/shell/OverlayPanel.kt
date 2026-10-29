package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** 展开面板协作类：视图构建（buildUnit 会话选择器/状态行/输入行）与渲染（updateBallOnly/updateClock/
 *  状态模板 template_thinking/template_tool）+ 待答卡（MuxClient 提问/审批官方风格卡片渲染 + POST /api/respond 应答）。 */
class OverlayPanel(private val svc: OverlayService) {

  // 主题（色板/明暗判定在 OverlayTheme，构造注入服务即 Context）
  private val theme = OverlayTheme(svc)
  // 双语入口（面板此前整页只有中文：切英文后按钮/状态仍是中文，2026-10-29 真机确认）。
  private fun t(zh: String, en: String): String = UiText.t(svc, zh, en)
  private fun isDarkTheme() = theme.isDarkTheme()
  private fun themeColors() = theme.themeColors()

  // ── 展开态控件句柄 ────────────────────────────────────────────────
  internal var unitView: View? = null            // 展开合体圆角矩形（默认 GONE）
  internal var statusText: TextView? = null
  private var reportEntryView: TextView? = null   // P5-1：状态行右侧的可见「查看汇报」入口
  private var hideEntryView: TextView? = null     // 块J：顶行的「隐藏」入口（球离屏 + 屏缘召回条）
  private var toolChip: TextView? = null
  private var clockText: TextView? = null
  private var closeView: View? = null                // 收起按钮（✕，44dp 命中区；S2-18）
  private var closeIcon: ImageView? = null           // 收起按钮的内层图标（20dp，换肤时改色用）
  private var dividerView: View? = null
  private var sendBtn: View? = null
  private var stopBtn: View? = null
  internal var inputBox: EditText? = null
  private var sessionPicker: TextView? = null      // 展开态目标会话行（点击开选择器窗口）
  private var pendingBox: LinearLayout? = null   // 待处理卡容器（divider 与输入行之间）

  // ── 会话选择器（0.13.8 G2 重构：独立顶层 overlay 窗口，弃 Spinner 子窗口） ──────
  // A-R4：Spinner 下拉 = 面板 overlay 的 SUB_PANEL 子窗口，几何受父 frame/屏幕裁剪支配
  // （「大片空白 + 滚不动」的形态来源）。新形态 = 自有 TYPE_APPLICATION_OVERLAY 窗口 +
  // ScrollView 真滚动 + 官方可视性过滤 + 触摸反馈。
  private var pickerWindow: View? = null
  private var pickerRowView: LinearLayout? = null
  private var pickerShowAll = false
  private val pickerSessions = ArrayList<PickerSession>()
  /** 最近一次 session/list 的失败说明（"" = 成功）。S2-9：失败不得画成「共 0 个会话」。 */
  private var pickerLoadError = ""

  /** 治理后的会话条目（官方可见性口径过滤后）。 */
  internal class PickerSession(val id: String, val label: String, val running: Boolean, val relative: String)

  // 协议（0.1.2-rc.1 dsh-api-gateway/lib/{index,client}.js 核实，0.13.3 W3）：
  // WS /api/remote.mux 上 open `$events` 流；服务端 item value 帧形：
  //   ready = {type:"ready",clientId,host:{home}}（clientId 应答必须回带）；
  //   waterfall = {type:"waterfall",event,eventId,agentId,request}（approval/request 与
  //     user-questions/request）；
  //   emit = {type:"emit",event,args}（api-session/status → args:[agentId,running] 忙态锚点）。
  // 应答统一 POST /api/$events/result，client-request 信封 payload={args:{clientId,eventId,outcome}}：
  //   审批 outcome={kind:"result",value:"allowed-once"|"rejected"}（值=审批词汇原字符串）；
  //   提问 outcome={kind:"result",value:{answers:[{id,selected:[label,…],custom?}]}}（selected 数组）；
  //   提问跳过 outcome={kind:"rejected",error:{name,message}}；审批无取消通道。
  private var mux: MuxClient? = null
  @Volatile private var eventsClientId: String = ""   // ready 帧分配；应答与流实例绑定
  internal val pendingApprovals = LinkedHashMap<String, PendingApproval>()
  internal val pendingQuestions = LinkedHashMap<String, PendingQuestion>()
  private val multiSel = HashMap<String, ArrayList<String>>()   // 多选暂存：questionId → labels
  private val qSingle = HashMap<String, String>()               // 单选暂存：questionId → label
  private val qCustom = HashMap<String, String>()               // 自定义答案：questionId → text
  private var qPage = 0                                          // 多问分页（官方卡 1/N 风格）
  /**
   * 选项超过 6 项时「展开全部」的记忆（questionId 集合）。P0-8：此前 `coerceAtMost(6)` 直接丢弃
   * 第 7 项起的候选，无任何提示——用户看不到剩余项，只能手打。现在默认仍只列 6 项（卡面高度有限），
   * 但给出「还有 N 项（点此展开）」的可点入口，展开后全量列出。
   */
  private val qOptsExpanded = HashSet<String>()
  /**
   * 审批「批准一次」的二次确认态（P0-9）。
   *
   * 证书：批准的是一次**真实工具执行**（`reason` 里往往就是待执行命令），而此前两枚 12sp 小药丸
   * 水平紧邻、单击即放行、无撤销。现在首次点击只进入「待确认」，第二次点击（10 秒内）才放行；
   * 超时或点了「取消」即撤臂，避免陈旧待确认态把后来的一次单击变成放行。
   */
  private var approvalArmedId: String? = null
  private var approvalArmedAtMs = 0L
  private var pendingKey = ""                                    // 当前卡指纹（kind:eventId），变化即清作答态
  private var renderedCardKey = ""                               // 卡片已渲染指纹（防 live 流重绘打断输入）

  /** 服务 onDestroy 联动：关闭 mux 长连接（原 mux?.close(); mux = null）。 */
  internal fun destroy() {
    mux?.close(); mux = null
  }

  internal fun startMux() {
    // 0.14.0-preview：MuxClient 末位新增可选参数 streamId（默认 = 本流 dsh-overlay-events）。
    // Kotlin 的尾随 lambda 绑定**最后一个**形参，所以这里必须把 onFrame 显式写在括号内
    // （写成 MuxClient(...) { } 会把 lambda 当成 streamId，编译期直接报错）。
    mux = MuxClient(EngineEndpoint.HOST, EngineEndpoint.port, "/api/remote.mux", { text -> handleMuxFrame(text) })
  }

  private fun handleMuxFrame(text: String) {
    val j = try { JSONObject(text) } catch (_: Exception) { return }
    when (j.optString("type")) {
      "item" -> {
        val value = j.optJSONObject("value") ?: return
        handleEventValue(value)
      }
      // 流被服务端终止（end）或出错（error）：重连由 MuxClient 重连循环处理
      // （检测不到对端断开时 iframe 也会因 end 后无数据而 idle，这里主动重建连接）。
      "end", "error" -> {
        mux?.close()
        mux = null
        startMux()
      }
    }
  }

  // 0.13.8 G1（缺陷 B）：mux generation 对账——每次重连（ready 帧）换代；pending 条目
  // 若在宽限期后仍未被新 generation 重发（引擎只重发仍 pending 的事件），判为过期丢弃。
  private var generationId = 0
  private val pendingGen = HashMap<String, Int>()

  private fun handleEventValue(value: JSONObject) {
    when (value.optString("type")) {
      "ready" -> {
        eventsClientId = value.optString("clientId", "")
        generationId++
        // 宽限期 3s：重发即续命；未被重发的旧条目判为过期（断线窗口内被结清的事件
        // 永远收不到 cancel，这里是对账兜底）。
        val stale = pendingApprovals.keys + pendingQuestions.keys
        svc.main.postDelayed({
          var dropped = false
          for (id in stale) {
            if ((pendingApprovals.containsKey(id) || pendingQuestions.containsKey(id)) && (pendingGen[id] ?: 0) < generationId) {
              pendingApprovals.remove(id); pendingQuestions.remove(id); pendingGen.remove(id)
              dropped = true
            }
          }
          if (dropped) onPendingChanged()
        }, 3_000)
      }
      "waterfall" -> {
        val event = value.optString("event")
        val eventId = value.optString("eventId")
        val agentId = value.optString("agentId")
        val request = value.optJSONObject("request") ?: return
        when (event) {
          "approval/request" -> svc.main.post {
            pendingApprovals[eventId] = PendingApproval(eventId, agentId, request.optString("toolName", ""), request.optString("reason", ""))
            pendingGen[eventId] = generationId
            onPendingChanged()
          }
          "user-questions/request" -> svc.main.post {
            pendingQuestions[eventId] = PendingQuestion(eventId, agentId, request.optJSONArray("questions") ?: org.json.JSONArray())
            pendingGen[eventId] = generationId
            onPendingChanged()
          }
        }
      }
      "cancel" -> {
        // 0.13.8 G1-1（缺陷 B-1）：{type:"cancel",eventId} = 引擎侧权威「该待答已结清
        // （谁答的都算）」——本端无条件丢弃对应条目并重绘（官方浏览器客户端同款处理）。
        val id = value.optString("eventId")
        if (id.isNotEmpty()) svc.main.post {
          val removed = pendingApprovals.remove(id) != null || pendingQuestions.remove(id) != null
          pendingGen.remove(id)
          if (removed) onPendingChanged()
        }
      }
      "emit" -> {
        when (value.optString("event")) {
          // 0.13.3 D6：api-session/status（args=[agentId, running]）= 官方忙态锚点，
          // 替代旧 turn_start 专门行（bridge 0.1.4 起退役该行）。
          "api-session/status" -> {
            val args = value.optJSONArray("args") ?: return
            if (args.length() >= 2) {
              val agentId = args.optString(0)
              val running = args.optBoolean(1)
              svc.main.post { svc.applyAgentStatus(agentId, running) }
            }
          }
        }
      }
    }
  }

  /** 当前会话（未选目标 = 全部）的第一条待处理；审批优先。 */
  private fun currentPending(): Pair<String, Any>? {
    val sid = svc.activeSessionId
    val ok = { s: String -> sid.isEmpty() || s == sid }
    pendingApprovals.values.firstOrNull { ok(it.agentId) }?.let { return "approval" to it }
    pendingQuestions.values.firstOrNull { ok(it.agentId) }?.let { return "question" to it }
    return null
  }

  internal fun onPendingChanged() {
    val key = currentPending()?.let { "${it.first}:${(it.second as? PendingApproval)?.eventId ?: (it.second as? PendingQuestion)?.eventId ?: ""}" } ?: ""
    if (key != pendingKey) {
      pendingKey = key
      multiSel.clear(); qSingle.clear(); qCustom.clear(); qOptsExpanded.clear(); qPage = 0; renderedCardKey = ""
      // 卡换了就撤臂：待确认态绝不跨卡片存活（否则后来的一次单击会变成放行）。
      approvalArmedId = null
    }
    updateBallOnly()
  }

  /** 展开合体圆角矩形（上区状态 + 下区输入，radius 30dp）。 */
  internal fun buildUnit(): View {
    val dp = svc.resources.displayMetrics.density
    // 面板宽度不在这里算：它是**窗口**属性，唯一权威在 OverlayService.panelWindowWidth()
    // （这里曾有一个同样公式的局部 val，实测全文无人消费——两份口径只有一份生效，留着就是谎）。
    val c = themeColors()

    // 目标会话选择器（0.13.8 G2 重构）：一行式目标显示，点击弹出**独立顶层 overlay
    // 窗口**（非 Spinner 子窗口——几何不再受父 frame 支配）；列表按官方可视性口径
    // 过滤，条目带触摸反馈；选择动作即时、显式（A-R6 的 Spinner 异步回调竞态随之消失）。
    val pickerRowText = TextView(svc).apply {
      tag = "overlay-sessionpicker"
      contentDescription = t("选择发送对话", "Choose conversation")
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.idleText)
      text = t("＋ 新会话", "＋ New session")
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.END
      minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()
      gravity = Gravity.CENTER_VERTICAL or Gravity.START
      background = DsUi.ripple(
        DsUi.roundRect(Color.TRANSPARENT, 10 * dp, c.unitStroke),
        if (isDarkTheme()) 0x33FFFFFF.toInt() else 0x22000000.toInt(),
      )
      setPadding((10 * dp).toInt(), 0, (10 * dp).toInt(), 0)
      setOnClickListener { togglePickerWindow() }
      DsUi.bindPressScale(this)
    }
    sessionPicker = pickerRowText

    val status = ShimmerTextView(svc).apply {
      text = t("空闲", "Idle")
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.idleText)
      // S2-1：长按/三击手势挂在**这一行文字**上，而文字本身只有约 20dp 高——手势热区此前
      // 等于一行字，实测「按不准」。批 5 补了可见入口（「查看汇报」），这里把**手势本身**
      // 的热区也顶到 44dp：手势语义未变，只是让它在手指尺度上成立。
      minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()
      gravity = Gravity.CENTER_VERTICAL
    }
    statusText = status
    attachStatusGesture(status)

    val chip = TextView(svc).apply {
      tag = "overlay-toolchip"
      text = ""
      textSize = 11f
      setTextColor(Color.WHITE)
      background = GradientDrawable().apply { setColor(0xFF4176E6.toInt()); cornerRadius = 10 * dp }
      setPadding((8 * dp).toInt(), (2 * dp).toInt(), (8 * dp).toInt(), (2 * dp).toInt())
      visibility = View.GONE
    }
    toolChip = chip

    val clock = TextView(svc).apply {
      tag = "overlay-clock"
      text = ""
      textSize = 12f
      setTextColor(c.clockText)
      setTypeface(null, android.graphics.Typeface.NORMAL)
      visibility = View.GONE
    }
    clockText = clock

    // 收起按钮（✕）：放顶行（会话选择行）右端。旧版收起箭头在状态行、与 Spinner 下拉
    // 三角同为三角且下拉展开后被列表盖住（视觉引导错误，用户实测）——✕ 与下拉三角可区分
    // 且位于下拉弹出层之上，永不被盖。
    // S2-18（批 5 设备验收时发现）：**触摸目标必须 ≥44dp**。旧实现是 20×20dp 的 ImageView
    // （uiautomator 实测 `收起面板 40×40px = 20×20dp`），而它是面板上唯一的收起入口。
    // 做法与批 5 同口径：外层 FrameLayout 撑到 44dp 命中区，内层 20dp 图标保持观感；
    // 为不让选择行白长 20dp，行的上下内边距在下面按需收紧。
    val close = FrameLayout(svc).apply {
      contentDescription = t("收起面板", "Collapse panel")
      isClickable = true
      setOnClickListener { svc.hidePanel() }
      addView(ImageView(svc).apply {
        setImageResource(R.drawable.dsh_ic_close)
        setColorFilter(c.chevron)
      }, FrameLayout.LayoutParams((20 * dp).toInt(), (20 * dp).toInt(), Gravity.CENTER))
    }
    closeView = close
    closeIcon = (close.getChildAt(0) as? ImageView)

    // 块J（0.14.9-preview）：面板里的「隐藏」入口——球整只离屏、屏缘留一条召回条。
    //
    // 与右端 ✕ 语义**不同**，所以是两个入口而不是一个：✕ 只收面板（球仍在屏上、点球就回来），
    // 「隐藏」是球离屏（回程只有那条召回条）。用户要求在面板里给一个显式入口，且必须与
    // 「收起」区分得开——把两件事塞进一个按钮（如长按 ✕）等于让「收起面板」这一最常用动作
    // 带上一个不可撤销的歧义（长按误触 = 球没了，还要去屏缘找条）。
    //
    // 用文字入口而非新图标：与状态行「查看汇报」同一先例（本仓不为一个入口新建 drawable，
    // 也不需要新色值——文字取主题 chevron 强调色）。热区同 S2-18 口径（≥44dp）。
    val hideEntry = TextView(svc).apply {
      tag = "overlay-hide-entry"
      text = t("隐藏", "Hide")
      textSize = 12f
      setTextColor(c.chevron)
      gravity = Gravity.CENTER
      minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()
      minWidth = (MIN_TOUCH_TARGET_DP * dp).toInt()
      contentDescription = t("隐藏悬浮球", "Hide floating ball")
      isClickable = true
      setOnClickListener { svc.hideBall() }
      DsUi.bindPressScale(this)
    }
    hideEntryView = hideEntry

    // 会话选择行（独立一行，向下箭头 Spinner）+ 右端「隐藏」「✕ 收起」
    // S2-18：✕ 的命中区 44dp，行内边距按需收紧（旧行高 38dp → 44dp，只多 6dp）。
    // 块J：隐藏入口再占 44dp（间隔 4dp，✕ 的 marginStart 保持 8dp）——面板最窄时
    // （屏宽 - 球 34dp - 64dp）仍有富余，选择器文字用 weight 1 自动让位。
    val pickerRow = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (2 * dp).toInt(), (8 * dp).toInt(), (2 * dp).toInt())
      addView(pickerRowText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(hideEntry, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt()).apply { marginStart = (4 * dp).toInt() })
      addView(close, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
    }

    // 状态行：状态文字 + 汇报入口 + 工具×N + 时钟（收起按钮已移至顶行 ✕）
    //
    // P5-1（本批）：状态行右侧补一枚**可见**的「查看汇报」入口。此前开报告栏只有「长按状态行」
    // 一条隐藏手势，模板文案也只会说「长按查看汇报」——没试过长按的用户根本不知道有这东西
    // （审查档 §3.2 S2-1 的「热区仅一行文字高 + 无任何可见提示」）。长按**仍然有效**（不改手势语义，
    // 见 §4「明确不做」），但发现路径不再只依赖隐藏手势。
    val reportEntry = TextView(svc).apply {
      tag = "overlay-report-entry"
      text = t("查看汇报", "View report")
      textSize = 11f
      setTextColor(c.chevron)
      gravity = Gravity.CENTER
      // 热区与批 5 同口径：可点元素不小于触摸目标下限（见 MIN_TOUCH_TARGET_DP）。
      minHeight = (MIN_TOUCH_TARGET_DP * dp).toInt()
      minWidth = (MIN_TOUCH_TARGET_DP * dp).toInt()
      contentDescription = t("查看工作汇报", "View work report")
      isClickable = true
      setOnClickListener { svc.toggleReportBar() }
      DsUi.bindPressScale(this)
    }
    reportEntryView = reportEntry

    val row1 = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (2 * dp).toInt(), (12 * dp).toInt(), (2 * dp).toInt())
      addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(reportEntry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (6 * dp).toInt() })
      addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (6 * dp).toInt() })
      addView(clock, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * dp).toInt() })
    }

    // 输入行：输入框 + 蓝圆发送（白箭头 IconSendOutline16）+ 红圆停止（白方块 rx=3）
    val input = EditText(svc).apply {
      hint = inputHintFor(false, false)
      textSize = 13f
      isSingleLine = true
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) { svc.requestSend(); true } else false
      }
      setTextColor(c.inputText)
      setHintTextColor(c.inputHint)
      background = GradientDrawable().apply {
        setColor(c.inputBg); cornerRadius = 17 * dp
        setStroke((1 * dp).toInt(), c.inputStroke)
      }
      setPadding((14 * dp).toInt(), 0, (14 * dp).toInt(), 0)
    }
    inputBox = input

    // P5-2（本批）：两枚圆钮的**触摸目标 44dp**，视觉圆仍是 36dp（外层 FrameLayout 承载命中区，
    // 内层保持原观感与圆径）。设备实测：36dp 的圆在悬浮窗里按偏就落空，且两者相邻，
    // 误触到「停止」的代价高（中断整轮）。同时补 contentDescription——两枚钮都只有图形。
    fun roundButton(tagName: String, iconRes: Int, iconDp: Int, circle: Int, label: String, onClick: () -> Unit): FrameLayout =
      FrameLayout(svc).apply {
        tag = tagName
        isClickable = true
        contentDescription = label
        setOnClickListener { onClick() }
        addView(FrameLayout(svc).apply {
          background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(circle) }
          addView(ImageView(svc).apply { setImageResource(iconRes) },
            FrameLayout.LayoutParams((iconDp * dp).toInt(), (iconDp * dp).toInt(), Gravity.CENTER))
        }, FrameLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt(), Gravity.CENTER))
      }

    val send = roundButton("overlay-send", R.drawable.dsh_ic_send, 16, 0xFF4176E6.toInt(), t("发送", "Send")) { svc.requestSend() }
    sendBtn = send

    val stop = roundButton("overlay-stop", R.drawable.dsh_ic_stop, 12, 0xFFE04848.toInt(), t("停止当前任务", "Stop current task")) { svc.requestStop() }
    stopBtn = stop

    val row2 = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((8 * dp).toInt(), (4 * dp).toInt(), (8 * dp).toInt(), (4 * dp).toInt())
      addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(send, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt()).apply { marginStart = (4 * dp).toInt() })
      addView(stop, LinearLayout.LayoutParams((MIN_TOUCH_TARGET_DP * dp).toInt(), (MIN_TOUCH_TARGET_DP * dp).toInt()).apply { marginStart = (4 * dp).toInt() })
    }

    val unit = LinearLayout(svc).apply {
      orientation = LinearLayout.VERTICAL
      background = GradientDrawable().apply {
        setColor(c.unitBg)
        cornerRadius = 30 * dp
        setStroke((1 * dp).toInt(), c.unitStroke)
      }
      addView(pickerRow)
      addView(row1)
      val divider = View(svc).apply { setBackgroundColor(c.divider) }
      dividerView = divider
      addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
      addView(buildPendingBox(dp))
      addView(row2)
    }
    unitView = unit
    return unit
  }

  /** 按当前主题刷新展开态配色（unit 背景/描边、状态文字、输入框、分隔线、箭头）。 */
  internal fun applyThemeColors() {
    val c = themeColors()
    val u = unitView ?: return
    val dp = svc.resources.displayMetrics.density
    (u.background as? GradientDrawable)?.apply {
      setColor(c.unitBg)
      setStroke((1 * dp).toInt(), c.unitStroke)
    }
    statusText?.setTextColor(c.idleText)
    clockText?.setTextColor(c.clockText)
    val st = statusText
    if (st != null && !svc.sessionBusy) {
      ShimmerTextView::class.java.cast(st).setShimmering(false)
      // 块H-A1：完成态正在展示时不得被换肤流程改回常态色（文本由分支链负责，颜色也应一致）。
      if (svc.completionLabel().isEmpty()) {
        st.setTextColor(if (!svc.engineRunning) c.offText else c.idleText)
      }
    }
    closeIcon?.setColorFilter(c.chevron)
    reportEntryView?.setTextColor(c.chevron)   // P5-1：汇报入口用主题强调色（换肤时必须同步）
    hideEntryView?.setTextColor(c.chevron)     // 块J：隐藏入口同口径（换肤时必须同步，漏了就留着旧主题灰）
    inputBox?.apply {
      setTextColor(c.inputText)
      setHintTextColor(c.inputHint)
      (background as? GradientDrawable)?.apply {
        setColor(c.inputBg)
        setStroke((1 * dp).toInt(), c.inputStroke)
      }
    }
    dividerView?.setBackgroundColor(c.divider)
  }

  // ── 状态显示模板（模板化设置：占位符 {tool}/{summary}，SharedPreferences 可覆写，后续接设置面板）──

  private fun displayPrefs() = svc.getSharedPreferences("overlay_display", Context.MODE_PRIVATE)

  // S2-12（本批）：思考态默认文案由英文模板 `Deep diving...` 改为中文。
  // 缺陷现场：状态行是**壳侧唯一的常驻运行提示**，却是全仓唯一一处英文正文（工具轮更糟：
  // 直接显示原始工具名 + 参数）。中文受众看到的是「Deep diving... / android_vdisplay_input · …」。
  // 扫光动效本身保留（ShimmerTextView 的形态不变），只换文字。
  private fun templateThinking(): String =
    displayPrefs().getString("template_thinking", "正在思考…") ?: "正在思考…"

  private fun templateTool(): String =
    displayPrefs().getString("template_tool", "正在使用 {tool} · {summary}") ?: "正在使用 {tool} · {summary}"

  /** 块H-A1：完成态常驻文案（并入 overlay_display prefs，与上述两个模板同族，可覆写）。
   *  默认整句「已完成，可查看汇报」；语义标签非「已完成」时（失败/被阻塞/被中断…）
   *  只替换标签部分、保留同一后缀提示——既保证失败态不显示「已完成」，又让提示语只有一处真源。
   *  P5-1 起后缀不再写「长按」：状态行右侧已有**可见**的「查看汇报」入口（长按仍然有效，
   *  但把「怎么开」写进文案只应该指向看得见的那条路）。 */
  private fun templateCompletion(): String =
    displayPrefs().getString("template_completion", "已完成，可查看汇报") ?: "已完成，可查看汇报"

  /** 后缀提示（默认「可查看汇报」）：由 template_completion 剥掉默认标签前缀得到。 */
  private fun completionHint(): String =
    templateCompletion().removePrefix("已完成，").ifBlank { "可查看汇报" }

  // ── 块H 状态行手势（A2 长按开报告栏 / A3 三击跳转）──────────────────
  // 详档 §3.3：目标行原本**无任何触摸处理**（11 处 setOnClickListener 均不涉及 statusText），
  // 故不存在与既有行内手势抢的冲突。消歧用**单一 OnTouchListener 状态机**统一裁决
  // （不用 setOnLongClickListener + 自行数点击）：
  //   DOWN  → 记起点与时刻；距上次 UP 在三击窗口（= 双击超时 ×2，见 tripleTapWindowMs）内则 tapCount++，否则重置为 1；
  //   MOVE  → 位移超 scaledTouchSlop 即标 moved，本次手势不再判长按/三击（防拖动误触）；
  //   计时到 longPressTimeout 且未 moved → 触发 A2（长按优先，一次手势只触发一个动作）；
  //   UP    → 未 moved 且未触发长按：tapCount==3 → 触发 A3；否则等窗口结束；
  //   CANCEL → 全部重置。
  // 阈值一律**运行时读取** ViewConfiguration（不编造数字；先例 OverlayService 的 scaledTouchSlop）。
  // 注意 ViewConfiguration 的 static/实例面**不一致**（javap android-36 android.jar 实证）：
  //   getScaledTouchSlop() 等 scaled* 是**实例**方法 → vc.scaledTouchSlop
  //   getLongPressTimeout() / getDoubleTapTimeout() / getTapTimeout() 是 **static** 方法
  //   → 必须写成 ViewConfiguration.getLongPressTimeout()，写成实例属性会 Unresolved reference。
  //   既有的 scaledTouchSlop 先例恰好只用到实例方法，故未暴露该差异。

  private var statusLongPress: Runnable? = null
  private var statusTapCount = 0
  private var statusLastUpAt = 0L

  /** 长按/三击状态机（挂在 statusText 上；返回 true 表示本事件序列被消费）。 */
  private fun attachStatusGesture(tv: TextView) {
    val vc = android.view.ViewConfiguration.get(svc)
    val slop = vc.scaledTouchSlop                                          // 实例方法
    val longPressMs = android.view.ViewConfiguration.getLongPressTimeout().toLong()   // static
    // S2-2：三击的容错窗**不能**直接取双击超时（约 300ms）——三连击几乎必然断在第二、三下之间，
    // 设备上的表现就是「点了没反应」。见 tripleTapWindowMs 的取值口径。
    val tapWindowMs = tripleTapWindowMs(android.view.ViewConfiguration.getDoubleTapTimeout().toLong())   // static
    var downX = 0f; var downY = 0f
    var moved = false
    var longFired = false

    fun cancelPending() {
      statusLongPress?.let { svc.main.removeCallbacks(it) }
      statusLongPress = null
    }

    tv.isClickable = true
    tv.setOnTouchListener { _, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX; downY = ev.rawY
          moved = false; longFired = false
          // 面板被用户占用：长按期间取消自动收起（详档 §3.3 冲突面 2 的消歧）。
          svc.panelOccupied = true
          // 三击计数：距上次 UP 在两个双击超时内则累加，否则重置为 1（见 tripleTapWindowMs）。
          statusTapCount = nextTapCount(System.currentTimeMillis(), statusLastUpAt, tapWindowMs, statusTapCount)
          cancelPending()
          val r = Runnable {
            if (!moved && !longFired) {
              longFired = true
              svc.toggleReportBar()
            }
          }
          statusLongPress = r
          svc.main.postDelayed(r, longPressMs)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          if (!moved && (Math.abs(ev.rawX - downX) > slop || Math.abs(ev.rawY - downY) > slop)) {
            // 超 touchSlop = 按住并滑动 → 判为拖动/滚动，取消长按且**不**触发 A2/A3。
            moved = true
            cancelPending()
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          cancelPending()
          svc.panelOccupied = false
          statusLastUpAt = System.currentTimeMillis()
          // 一次手势一个动作：长按已触发则本次不得再触发 A3；拖动同理。
          if (statusUpAction(moved, longFired, statusTapCount) == StatusGestureAction.JUMP_TO_APP) {
            statusTapCount = 0
            svc.jumpToApp()
          }
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          cancelPending()
          svc.panelOccupied = false
          statusTapCount = 0
          moved = true
          true
        }
        else -> false
      }
    }
  }

  // ── 待处理卡（AI 提问 / 权限审批：WS 收帧 + POST /api/respond 应答——用户拍板「几乎所有操作直接在悬浮球上完成」）──

  /** 待处理卡容器（divider 与输入行之间，默认 GONE）。 */
  private fun buildPendingBox(dp: Float): LinearLayout = LinearLayout(svc).apply {
    orientation = LinearLayout.VERTICAL
    setPadding((12 * dp).toInt(), (2 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
    visibility = View.GONE
    pendingBox = this
  }

  private fun pendingChip(label: String, filled: Boolean, red: Boolean, dp: Float, onClick: () -> Unit): TextView = TextView(svc).apply {
    text = label
    textSize = 12f
    maxLines = 2
    setTextColor(if (filled || red) Color.WHITE else themeColors().inputText)
    background = GradientDrawable().apply {
      cornerRadius = 14 * dp
      setColor(if (red) 0xFFE04848.toInt() else if (filled) 0xFF4176E6.toInt() else 0x22808080)
      if (!filled && !red) setStroke((1 * dp).toInt(), themeColors().inputStroke)
    }
    setPadding((12 * dp).toInt(), (6 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
    isClickable = true
    setOnClickListener { onClick() }
  }

  private fun lpChip(dp: Float) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
    marginEnd = (8 * dp).toInt()
  }

  /** 渲染卡片（官方提问卡风格）：header 行（灰标签 + ✕ 关闭）、问题加粗、编号徽章选项行
   *  （label + 灰 description）、✎「输入你的答案」自定义行、页脚 ‹1/N› 翻页 + 跳过本题 + 下一题/提交。
   *  force=false 时防 live 流重绘打断输入焦点。 */
  /**
   * M4/M5/M6/M7（0.13.8 G3 余项）：悬浮球动效的四个落点，统一走 [DsUi.animationsEnabled]
   * 降级——系统关动画/省电模式下全部退化为瞬时切换（不闪、不卡、不消耗帧）。
   * 设计口径：位移与透明度只用短时（≤220ms）一次性动画；呼吸/脉冲用无限循环但**只作用于
   * 单行状态文本与光环**，避免整面板反复重绘（低端机上那才真卡）。
   */
  private fun animationsOn(): Boolean = DsUi.animationsEnabled(svc)

  /** M4：待答卡入场——位移 6dp + 渐显（禁用动画时直接显示）。 */
  private fun animateCardIn(view: View) {
    if (!animationsOn()) { view.alpha = 1f; view.translationY = 0f; return }
    val rise = 6 * svc.resources.displayMetrics.density
    view.animate().cancel()
    view.alpha = 0f
    view.translationY = rise
    view.animate().alpha(1f).translationY(0f)
      .setDuration(200L).setInterpolator(DsUi.ease).start()
  }

  /** M5：状态行配色在「空闲/工作/待答」之间平滑过渡（琥珀↔文本色），用 ArgbEvaluator 而非硬切。 */
  private fun animateTextColor(tv: TextView, target: Int) {
    val from = (tv.tag as? Int) ?: target
    tv.tag = target
    if (!animationsOn() || from == target) { tv.setTextColor(target); return }
    android.animation.ValueAnimator.ofObject(
      android.animation.ArgbEvaluator(), from, target,
    ).apply {
      duration = 220L
      interpolator = DsUi.ease
      addUpdateListener { tv.setTextColor(it.animatedValue as Int) }
      start()
    }
  }

  /** M6：状态行换文案——只在文案真的变了时做一次「淡出→换字→淡入」，避免每帧重排。 */
  private fun setStatusText(tv: TextView, next: String) {
    if (tv.text?.toString() == next) return
    if (!animationsOn()) { tv.text = next; tv.alpha = 1f; return }
    tv.animate().cancel()
    tv.animate().alpha(0f).setDuration(90L).withEndAction {
      tv.text = next
      tv.animate().alpha(1f).setDuration(140L).start()
    }.start()
  }

  /** M7：琥珀呼吸——待答（question/approval）期间状态行缓慢明暗（1.0↔0.55，1.2s 一次往返）。
   *  动画实例挂在面板字段上（工程无 res id，故不用 View tag 键）。 */
  private var statusBreathing: android.animation.ObjectAnimator? = null

  private fun setAmberBreathing(tv: TextView, on: Boolean) {
    if (on && animationsOn()) {
      if (statusBreathing?.isRunning == true) return
      statusBreathing = android.animation.ObjectAnimator.ofFloat(tv, View.ALPHA, 1f, 0.55f).apply {
        duration = 1200L
        repeatMode = android.animation.ValueAnimator.REVERSE
        repeatCount = android.animation.ValueAnimator.INFINITE
        interpolator = DsUi.ease
        start()
      }
    } else if (statusBreathing != null) {
      statusBreathing?.cancel()
      statusBreathing = null
      tv.animate().cancel()
      tv.alpha = 1f
    }
  }

  private fun renderPendingCard(force: Boolean = false) {
    val box = pendingBox ?: return
    val cur = currentPending()
    if (cur == null) { box.visibility = View.GONE; return }
    val key = "$pendingKey@$qPage"
    if (!force && renderedCardKey == key && box.visibility == View.VISIBLE && box.childCount > 0) return
    box.removeAllViews()
    renderedCardKey = key
    val dp = svc.resources.displayMetrics.density
    val dark = isDarkTheme()
    val textColor = if (dark) 0xFFE8EAED.toInt() else 0xFF202124.toInt()
    val subColor = if (dark) 0xFF9AA0A6.toInt() else 0xFF5F6368.toInt()
    if (cur.first == "approval") {
      val a = cur.second as PendingApproval
      val title = TextView(svc).apply {
        textSize = 12f
        setTextColor(0xFFB8860B.toInt())
        setTypeface(null, android.graphics.Typeface.BOLD)
        text = t("权限审批", "Approval request")
      }
      box.addView(title)
      val body = TextView(svc).apply {
        textSize = 13f
        setTextColor(textColor)
        text = listOf(t("工具 ${a.toolName}", "Tool ${a.toolName}"), a.reason).filter { it.isNotBlank() }.joinToString("：")
      }
      box.addView(body)
      val buttonRow = LinearLayout(svc).apply { orientation = LinearLayout.HORIZONTAL }
      // P0-9：放行 = 一次真实工具执行（reason 里往往就是待执行命令），而全界面代价最大的一步
      // 此前交互最轻（单击即放行、无撤销）。现在改成两步：首点进入待确认（药丸变红加粗 + 出现「取消」），
      // 10 秒内再点同一按钮才真正放行。超出窗口即重新进入待确认（不让陈旧状态吞掉一次单击）。
      val armed = approvalArmed(approvalArmedId, approvalArmedAtMs, a.eventId, System.currentTimeMillis())
      buttonRow.addView(
        pendingChip(if (armed) t("确认批准（执行）", "Confirm approval (run)") else t("批准一次", "Allow once"), filled = true, red = false, dp) {
          if (!armed) {
            approvalArmedId = a.eventId
            approvalArmedAtMs = System.currentTimeMillis()
            renderPendingCard(true)
            return@pendingChip
          }
          approvalArmedId = null
          respondApproval(a, "allowed-once")
        },
        lpChip(dp),
      )
      if (armed) {
        buttonRow.addView(pendingChip(t("取消", "Cancel"), filled = false, red = false, dp) {
          approvalArmedId = null
          renderPendingCard(true)
        }, lpChip(dp))
      }
      buttonRow.addView(pendingChip(t("拒绝", "Reject"), filled = false, red = true, dp) {
        approvalArmedId = null
        respondApproval(a, "rejected")
      }, lpChip(dp))
      box.addView(buttonRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        setMargins(0, (6 * dp).toInt(), 0, 0)
      })
      box.visibility = View.VISIBLE
      animateCardIn(box)
      return
    }
    val qe = cur.second as PendingQuestion
    val n = qe.items.length()
    if (n == 0) { box.visibility = View.GONE; return }
    qPage = qPage.coerceIn(0, n - 1)
    val item = qe.items.optJSONObject(qPage) ?: return
    val qid = item.optString("id")
    val multi = item.optBoolean("multiSelect", false)
    // header 行：灰色标签（官方 header 字段）+ 右侧 ✕（取消整问）
    val header = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    header.addView(TextView(svc).apply {
      textSize = 11f
      setTextColor(subColor)
      text = item.optString("header", "").ifBlank { t("问题 ${qPage + 1}", "Question ${qPage + 1}") }
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(TextView(svc).apply {
      text = "✕"
      textSize = 13f
      setTextColor(subColor)
      setPadding((6 * dp).toInt(), 0, (6 * dp).toInt(), 0)
      isClickable = true
      setOnClickListener { dismissQuestion(qe) }
    })
    box.addView(header)
    // 问题（加粗）
    box.addView(TextView(svc).apply {
      textSize = 13f
      setTextColor(textColor)
      setTypeface(null, android.graphics.Typeface.BOLD)
      text = item.optString("question", "")
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(0, (2 * dp).toInt(), 0, (4 * dp).toInt())
    })
    // 选项行：[编号徽章] 标签(粗) + 描述(灰)，选中淡蓝底
    val opts = item.optJSONArray("options")
    if (opts != null) {
      // P0-8：第 7 项起此前被 `coerceAtMost(6)` **静默丢弃**（无提示、无展开），引擎给 7 个以上
      // 选项时用户看不到剩余候选，只能被迫手打。现在默认列 6 项（卡面高度有限）+ 一行明示入口。
      val optsTotal = opts.length()
      val expanded = qOptsExpanded.contains(qid)
      val optsShown = optionsShownCount(optsTotal, expanded)
      val optsHidden = optionsHiddenCount(optsTotal, expanded)
      for (oi in 0 until optsShown) {
        val o = opts.optJSONObject(oi) ?: continue
        val label = o.optString("label").ifBlank { t("选项${oi + 1}", "Option ${oi + 1}") }
        val on = if (multi) multiSel[qid]?.contains(label) == true else qSingle[qid] == label
        val row = LinearLayout(svc).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setPadding((6 * dp).toInt(), (7 * dp).toInt(), (6 * dp).toInt(), (7 * dp).toInt())
          background = GradientDrawable().apply { cornerRadius = 10 * dp; setColor(if (on) 0x334176E6 else if (dark) 0x14FFFFFF else 0x0D000000) }
          isClickable = true
          setOnClickListener {
            if (multi) {
              val sel = multiSel.getOrPut(qid) { ArrayList() }
              if (on) sel.remove(label) else sel.add(label)
            } else {
              qSingle[qid] = label; qCustom.remove(qid)
              if (n == 1) { respondQuestion(qe); return@setOnClickListener }
            }
            renderPendingCard(true)
          }
        }
        row.addView(TextView(svc).apply {
          text = (oi + 1).toString()
          textSize = 11f
          setTextColor(if (on) Color.WHITE else subColor)
          gravity = Gravity.CENTER
          background = GradientDrawable().apply { cornerRadius = 5 * dp; setColor(if (on) 0xFF4176E6.toInt() else 0x33808080) }
        }, LinearLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
        row.addView(TextView(svc).apply {
          text = label
          textSize = 13f
          setTextColor(textColor)
          setTypeface(null, android.graphics.Typeface.BOLD)
        })
        val desc = o.optString("description", "")
        if (desc.isNotBlank()) row.addView(TextView(svc).apply {
          text = desc
          textSize = 11f
          setTextColor(subColor)
          maxLines = 1
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = (8 * dp).toInt() })
        box.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          setMargins(0, 0, 0, (4 * dp).toInt())
        })
      }
      if (optsHidden > 0) {
        // 明示「还有什么」，并给出展开入口（再一次点击回到折叠态，避免卡面失控）。
        box.addView(TextView(svc).apply {
          text = t("还有 $optsHidden 项（点此展开全部 $optsTotal 项）", "$optsHidden more (tap to show all $optsTotal)")
          textSize = 12f
          setTextColor(0xFF4176E6.toInt())
          setPadding((6 * dp).toInt(), (8 * dp).toInt(), (6 * dp).toInt(), (8 * dp).toInt())
          minHeight = (44 * dp).toInt()
          contentDescription = t("展开剩余 $optsHidden 个选项", "Expand remaining $optsHidden options")
          isClickable = true
          setOnClickListener { qOptsExpanded.add(qid); renderPendingCard(true) }
        })
      }
    }
    // ✎ 自定义答案行（单选与选项互斥——协议约束）
    val customRow = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt())
      background = GradientDrawable().apply {
        cornerRadius = 10 * dp
        setColor(if (qCustom[qid]?.isNotBlank() == true) 0x334176E6 else if (dark) 0x14FFFFFF else 0x0D000000)
      }
    }
    customRow.addView(TextView(svc).apply {
      text = "✎"
      textSize = 11f
      setTextColor(subColor)
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { cornerRadius = 5 * dp; setColor(0x33808080) }
    }, LinearLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
    val edit = EditText(svc).apply {
      hint = t("输入你的答案", "Type your answer")
      textSize = 13f
      isSingleLine = true
      setTextColor(textColor)
      setHintTextColor(subColor)
      background = null
      setText(qCustom[qid] ?: "")
      addTextChangedListener(object : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
        override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) {
          val t = s?.toString()?.trim() ?: ""
          if (t.isEmpty()) qCustom.remove(qid) else {
            qCustom[qid] = t
            if (!multi) { qSingle.remove(qid); } else { }
          }
        }
      })
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
          if (n == 1) respondQuestion(qe) else { qPage = (qPage + 1).coerceAtMost(n - 1); renderPendingCard(true) }
          true
        } else false
      }
      imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
    }
    customRow.addView(edit, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    box.addView(customRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(0, (2 * dp).toInt(), 0, (4 * dp).toInt())
    })
    // 页脚：‹ 1/N › +（跳过本题）+ 下一题/提交
    val foot = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    if (n > 1) {
      // P0-7：此前整个「‹ 1/N ›」是**一个** TextView，监听写成 (qPage + 1) % n —— 视觉上的「上一题」
      // 实际跳下一题，末页还回卷到第 1 页（用户按了会做错事）。现在拆成两个独立可点区域：
      // 左=上一题（首页禁用）、右=下一题（末页禁用），都不回卷；中间只作进度标签。
      // 热区 ≥44dp（批 5 的同批口径：可点元素不得小于触摸目标下限）。
      val pagerFont = 15f
      foot.addView(TextView(svc).apply {
        text = "‹"
        textSize = pagerFont
        gravity = Gravity.CENTER
        setTextColor(if (qPage > 0) textColor else subColor)
        alpha = if (qPage > 0) 1f else 0.4f
        minWidth = (44 * dp).toInt()
        minHeight = (44 * dp).toInt()
        contentDescription = t("上一题", "Previous")
        isEnabled = qPage > 0
        isClickable = qPage > 0
        if (qPage > 0) setOnClickListener { qPage = pagerIndex(qPage, n, -1); renderPendingCard(true) }
      })
      foot.addView(TextView(svc).apply {
        text = "${qPage + 1}/$n"
        textSize = 12f
        setTextColor(subColor)
        gravity = Gravity.CENTER
      })
      foot.addView(TextView(svc).apply {
        text = "›"
        textSize = pagerFont
        gravity = Gravity.CENTER
        setTextColor(if (qPage < n - 1) textColor else subColor)
        alpha = if (qPage < n - 1) 1f else 0.4f
        minWidth = (44 * dp).toInt()
        minHeight = (44 * dp).toInt()
        contentDescription = t("下一题", "Next")
        isEnabled = qPage < n - 1
        isClickable = qPage < n - 1
        if (qPage < n - 1) setOnClickListener { qPage = pagerIndex(qPage, n, +1); renderPendingCard(true) }
      })
      foot.addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
      if (qPage > 0) {
        foot.addView(pendingChip(t("跳过本题", "Skip this question"), filled = false, red = false, dp) {
          qSingle.remove(qid); qCustom.remove(qid); multiSel.remove(qid)
          qPage = (qPage + 1).coerceAtMost(n - 1)
          renderPendingCard(true)
        }, lpChip(dp))
      }
      val last = qPage == n - 1
      foot.addView(pendingChip(if (last) t("提交", "Submit") else t("下一题", "Next"), filled = true, red = false, dp) {
        if (!last) { qPage++; renderPendingCard(true); return@pendingChip }
        respondQuestion(qe)
      }, lpChip(dp))
    } else {
      foot.addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
      // 单问多选无自动提交路径 → 给「提交」；单选点选项即答、自定义走键盘 DONE 即答
      if (multi) foot.addView(pendingChip(t("提交", "Submit"), filled = true, red = false, dp) { respondQuestion(qe) }, lpChip(dp))
      foot.addView(pendingChip(t("跳过", "Skip"), filled = false, red = false, dp) { dismissQuestion(qe) }, lpChip(dp))
    }
    box.addView(foot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    box.visibility = View.VISIBLE
    animateCardIn(box)
  }

  // ── 应答（0.13.3 W3：POST /api/$events/result，{clientId,eventId,outcome}）──

  /**
   * 网关 RemoteEventResult：outcome = {kind:"result",value}（审批=词汇原字符串；
   * 提问={answers:[…]}）或 {kind:"rejected",error:{name,message}}（提问跳过）。
   * clientId 来自 ready 帧——应答与流实例绑定，未就绪（流未 ready）时直接报失败。
   */
  private fun postEventResult(eventId: String, outcome: JSONObject, onAccepted: (Boolean) -> Unit) {
    Thread {
      var accepted = false
      try {
        val payload = JSONObject()
          .put("args", JSONObject()
            .put("clientId", eventsClientId)
            .put("eventId", eventId)
            .put("outcome", outcome))
        val envelope = JSONObject()
          .put("type", "client-request")
          .put("rpcId", "overlay-event-" + System.currentTimeMillis())
          .put("method", "\$events/result")
          .put("payload", payload)
        var code = -1
        for (attempt in 0..1) {
          val conn = URL(EngineEndpoint.url + "/api/\$events/result").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
          conn.requestMethod = "POST"
          conn.doOutput = true
          conn.connectTimeout = 3000
          conn.readTimeout = 8000
          conn.setRequestProperty("content-type", "application/json")
          EngineAuth.attach(svc.applicationContext, conn)
          conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
          code = conn.responseCode
          if (code == 401 && attempt == 0) {
            conn.disconnect()
            EngineAuth.handleUnauthorized(svc.applicationContext)
            continue
          }
          conn.disconnect()
          break
        }
        accepted = code == 200 && eventsClientId.isNotEmpty()
      } catch (_: Exception) {}
      svc.main.post { onAccepted(accepted) }
    }.start()
  }

  private fun respondApproval(a: PendingApproval, outcome: String) {
    val outcomeJson = JSONObject().put("kind", "result").put("value", outcome)
    postEventResult(a.eventId, outcomeJson) { accepted ->
      if (accepted) {
        // 0.13.8 G1-4（缺陷 B-5）：受理语义与移除分离——HTTP 200 只代表已提交；
        // 卡片保留（引擎 cancel / turn-end 收敛），15s 兜底防引擎无回执。
        val entry = pendingApprovals[a.eventId]
        if (entry != null) {
          entry.submittedAt = System.currentTimeMillis()
          svc.main.postDelayed({
            val cur = pendingApprovals[a.eventId]
            if (cur != null && cur.submittedAt > 0L) {
              pendingApprovals.remove(a.eventId); pendingGen.remove(a.eventId); onPendingChanged()
            }
          }, 15_000)
        }
        // 批准后轮次继续（工具真正执行），下个 live 事件前先亮工作态（同发送空窗逻辑）
        svc.markBusyOptimistic()
        svc.flashStatus(if (outcome == "allowed-once") t("已批准（等待引擎确认）", "Approved (waiting for the engine)") else t("已拒绝", "Rejected"))
        onPendingChanged()
      } else svc.flashStatus(t("应答失败", "Failed to answer"))
    }
  }

  /** 提问作答：answers 按 questions 原序配对（协议硬约束）；单选 custom 与 selected 互斥。
   *  0.1.2-rc.1：selected 由旧协议的单 label 字符串改为 label 数组。 */
  private fun respondQuestion(qe: PendingQuestion) {
    val arr = org.json.JSONArray()
    for (i in 0 until qe.items.length()) {
      val item = qe.items.optJSONObject(i) ?: continue
      val qid = item.optString("id")
      val custom = qCustom[qid]?.trim().orEmpty()
      val sel = ArrayList<String>()
      if (item.optBoolean("multiSelect", false)) multiSel[qid]?.let { sel.addAll(it) }
      else if (custom.isEmpty()) qSingle[qid]?.let { sel.add(it) }
      val entry = JSONObject().put("id", qid).put("selected", org.json.JSONArray(sel))
      if (custom.isNotEmpty()) entry.put("custom", custom)
      arr.put(entry)
    }
    val value = JSONObject().put("answers", arr)
    val outcomeJson = JSONObject().put("kind", "result").put("value", value)
    postEventResult(qe.eventId, outcomeJson) { accepted ->
      if (accepted) {
        // 0.13.8 G1-4：受理 ≠ 移除，等引擎 cancel/turn-end 收敛（同 respondApproval）
        val entry = pendingQuestions[qe.eventId]
        if (entry != null) {
          entry.submittedAt = System.currentTimeMillis()
          svc.main.postDelayed({
            val cur = pendingQuestions[qe.eventId]
            if (cur != null && cur.submittedAt > 0L) {
              pendingQuestions.remove(qe.eventId); pendingGen.remove(qe.eventId); onPendingChanged()
            }
          }, 15_000)
        }
        // 作答后轮次继续，下个 live 事件前先亮工作态（同发送空窗逻辑）
        svc.markBusyOptimistic()
        svc.flashStatus(t("已回答（等待引擎确认）", "Answered (waiting for the engine)"))
        onPendingChanged()
      } else svc.flashStatus(t("应答失败", "Failed to answer"))
    }
  }

  /** 跳过提问 = 拒绝该 waterfall（outcome rejected；审批无取消通道）。 */
  private fun dismissQuestion(qe: PendingQuestion) {
    val outcomeJson = JSONObject().put("kind", "rejected").put(
      "error",
      JSONObject().put("name", "UserQuestionError").put("message", "dismissed from overlay").put("code", "cancelled"),
    )
    postEventResult(qe.eventId, outcomeJson) { accepted ->
      if (accepted) {
        // 0.13.8 G1-4：rejected 亦由引擎 cancel 收敛（同上）
        val entry = pendingQuestions[qe.eventId]
        if (entry != null) {
          entry.submittedAt = System.currentTimeMillis()
          svc.main.postDelayed({
            val cur = pendingQuestions[qe.eventId]
            if (cur != null && cur.submittedAt > 0L) {
              pendingQuestions.remove(qe.eventId); pendingGen.remove(qe.eventId); onPendingChanged()
            }
          }, 15_000)
        }
        svc.flashStatus(t("已跳过", "Skipped"))
        onPendingChanged()
      } else svc.flashStatus(t("应答失败", "Failed to answer"))
    }
  }

  /**
   * issue #133：丢弃某会话已过期的待答/待审批项（该会话已完成，用户可能已在网页端答过，
   * 或轮次已结束）——否则球会一直停在「等待你的回答…」的琥珀态。
   * @returns 是否真的丢弃了条目。
   */
  internal fun dropPendingFor(agentId: String): Boolean {
    if (agentId.isEmpty()) return false
    val questions = pendingQuestions.filterValues { it.agentId == agentId }.keys.toList()
    val approvals = pendingApprovals.filterValues { it.agentId == agentId }.keys.toList()
    for (key in questions) pendingQuestions.remove(key)
    for (key in approvals) pendingApprovals.remove(key)
    for (key in questions) pendingGen.remove(key)
    for (key in approvals) pendingGen.remove(key)
    val dropped = questions.isNotEmpty() || approvals.isNotEmpty()
    if (dropped) onPendingChanged()
    return dropped
  }

  /** issue #133：面板里是否还有用户未提交的草稿——自动收起前必须保留它。 */
  internal fun hasDraft(): Boolean = inputBox?.text?.toString()?.isNotBlank() == true

  /** 只更新球（光环/工作示意），不改窗口结构。 */
  internal fun updateBallOnly() {    // 会话维状态 → 光环；引擎维由探活驱动。PENDING（提问/审批待处理）优先于 WORKING（黄色占先）。
    svc.pendingKind = currentPending()?.first ?: ""
    svc.setHalo(svc.deriveHalo())
    if (svc.expanded) {
      refreshInputHint()   // S2-11：忙/闲与目标会话变化都要改提示语（空闲发的是新一轮，不是插话）
      statusText?.let {
        if (svc.pendingKind == "question") {
          (it as ShimmerTextView).setShimmering(false)
          animateTextColor(it, 0xFFB8860B.toInt())
          setStatusText(it, t("等待你的回答…", "Waiting for your answer…"))
          setAmberBreathing(it, true)
        } else if (svc.pendingKind == "approval") {
          (it as ShimmerTextView).setShimmering(false)
          animateTextColor(it, 0xFFB8860B.toInt())
          setStatusText(it, t("等待权限审批…", "Waiting for approval…"))
          setAmberBreathing(it, true)
        } else if (svc.sessionBusy) {
          setAmberBreathing(it, false)
          if (svc.currentToolName.isNotBlank()) {
            // 模板化（用户拍板）：调工具 → 工具类型 + 概览；思考 → Deep diving 扫光。
            setStatusText(
              it,
              templateTool()
                .replace("{tool}", svc.currentToolName)
                .replace("{summary}", svc.currentToolSummary),
            )
            (it as ShimmerTextView).setShimmering(false)
            animateTextColor(it, themeColors().idleText)
          } else {
            setStatusText(it, templateThinking())
            (it as ShimmerTextView).setShimmering(true)
          }
        } else if (svc.completionLabel().isNotEmpty()) {
          // 块H-A1：完成态常驻分支（详档 §5.1 指定位置：sessionBusy 分支之后、else 常态之前）。
          // 待答分支在前 → 待答时不得显示「已完成」（§6.3 回归面）；
          // sessionBusy 分支在前 → 新一轮进行中不得显示上一轮的完成（§3.1 硬性 2）。
          (it as ShimmerTextView).setShimmering(false)
          setAmberBreathing(it, false)
          animateTextColor(it, 0xFF8AB4F8.toInt())
          // 文案 = 语义标签 + 操作提示。标签来自权威信号或 turn_end 的语义，因此失败类
          // （“失败/被阻塞/…”）不会伪装成「已完成」——这是 A1 的语义分支要求。
          setStatusText(it, svc.completionLabel() + "，" + completionHint())
        } else {
          (it as ShimmerTextView).setShimmering(false)
          setAmberBreathing(it, false)
          animateTextColor(it, 0xFF8A8F98.toInt())
          setStatusText(it, if (svc.engineRunning) t("空闲", "Idle") else t("引擎离线", "Engine offline"))
        }
      }
      toolChip?.let {
        if (svc.toolCount > 0) { it.text = t("工具 ×${svc.toolCount}", "Tools ×${svc.toolCount}"); it.visibility = View.VISIBLE }
        else it.visibility = View.GONE
      }
      updateClock()
      // P0-6：此前只改 alpha（看起来禁用、实际可点），点了落到 requestStop 的第一支
      // 「if (!sessionBusy) return」——静默返回，什么都不发生。现在视觉与行为一致：
      // 空闲/引擎离线时**真的禁用**（isEnabled=false 且不可点），面板状态行同时显示「空闲」。
      stopBtn?.let {
        val canStop = svc.sessionBusy
        it.alpha = if (canStop) 1f else 0.35f
        it.isEnabled = canStop
        it.isClickable = canStop
        it.contentDescription = if (canStop) t("停止当前任务", "Stop current task") else t("停止当前任务（当前没有运行中的任务）", "Stop current task (nothing is running)")
      }
      renderPendingCard()
    }
  }

  private fun updateClock() {
    val ct = clockText ?: return
    if (!svc.sessionBusy) { ct.visibility = View.GONE; return }
    val elapsed = System.currentTimeMillis() - svc.turnStartedAt
    if (elapsed < 15_000) { ct.visibility = View.GONE; return }
    ct.visibility = View.VISIBLE
    // P3-3：时钟与回报条/通知共用同一时长口径（旧实现是「45s」/「2分05秒」两套写法）。
    ct.text = UserCopy.durationText(elapsed)
  }

  /** session/list -> target picker data (G2: official visibility filter + label fallback chain). */
  internal fun refreshSessionPicker() {
    svc.postRpc("session/list", JSONObject().put("_request", JSONObject())) { code, body ->
      pickerSessions.clear()
      // S2-9：失败要如实（旧实现把非 200 静默当空列表 → 页脚写「共 0 个会话」，失败被画成合法空态）。
      pickerLoadError = if (code == 200) "" else t("会话列表读取失败（HTTP $code）", "Failed to load sessions (HTTP $code)")
      // 0.13.5: default target = the running session, else the most recent non-blank one.
      var runningId = ""
      var recentId = ""
      if (code == 200) {
        try {
          val arr = JSONObject(body).optJSONObject("result")
            ?.optJSONObject("value")?.optJSONArray("items")
          if (arr != null) {
            for (i in 0 until arr.length()) {
              val it = arr.optJSONObject(i) ?: continue
              val sid = it.optString("sessionId", "")
              if (sid.isEmpty()) continue
              // 0.13.8 G2 (A-R1): official visibility rules (same as ui-workspace tree.ts) —
              // subagent sessions are invisible; blank sessions visible only when current.
              if (it.optString("origin", "") == "subagent") continue
              val blank = it.optBoolean("blank", false)
              if (blank && sid != svc.activeSessionId) continue
              val running = it.optBoolean("running", false)
              if (runningId.isEmpty() && running) runningId = sid
              if (recentId.isEmpty() && !blank) recentId = sid
              // 0.13.8 G2 (A-R2) label fallback chain: title -> workspace basename ->
              // blank session + relative time (no more "(Nth session)" placeholders).
              // session/list already arrives sorted by updatedAt desc.
              val titleObj = it.optJSONObject("projections")?.optJSONObject("values")?.opt("title")
              val title = if (titleObj == null || titleObj === JSONObject.NULL) "" else titleObj.toString()
              val cwd = it.optString("cwd", "")
              val updated = it.optLong("updatedAt", 0L)
              val label = when {
                title.isNotBlank() -> title
                cwd.isNotBlank() -> cwd.trimEnd('/').substringAfterLast('/')
                blank -> "\u7a7a\u4f1a\u8bdd \u00b7 " + relativeTime(updated)
                else -> "\u672a\u547d\u540d\u4f1a\u8bdd \u00b7 " + relativeTime(updated)
              }
              pickerSessions.add(PickerSession(sid, label, running, relativeTime(updated)))
            }
          }
        } catch (_: Exception) {}
      }
      // Re-validate the target; auto-follow only when unpinned.
      // (A-R5: agent ids from api-session/status must never be stored as session ids.)
      if (svc.activeSessionId.isNotEmpty() && pickerSessions.none { it.id == svc.activeSessionId }) {
        if (svc.userPinnedSession) svc.activeSessionId = ""
      }
      if (svc.activeSessionId.isEmpty() && !svc.userPinnedSession) {
        val follow = if (runningId.isNotEmpty()) runningId else recentId
        if (follow.isNotEmpty()) svc.activeSessionId = follow
      }
      updatePickerRowText()
      if (pickerWindow != null) pickerRowView?.let { fillPickerRows(it) }
    }
  }

  /** Target row text (new-session placeholder or "<label>(current)"). */
  internal fun updatePickerRowText() {
    val row = sessionPicker ?: return
    val current = pickerSessions.firstOrNull { it.id == svc.activeSessionId }
    row.text = if (svc.activeSessionId.isEmpty()) "\uff0b \u65b0\u4f1a\u8bdd"
    else sessionRowText(current?.label)
    refreshInputHint()
  }

  /** 输入框提示语随忙态/目标会话变化（S2-11：空闲态发的是新一轮/新会话，不是插话）。 */
  private fun refreshInputHint() {
    inputBox?.hint = inputHintFor(svc.sessionBusy, svc.activeSessionId.isNotEmpty())
  }

  /** Light refresh on auto-follow (G2: no refetch, no window rebuild — marks only). */
  internal fun refreshPickerMarks() {
    updatePickerRowText()
    if (pickerWindow != null) pickerRowView?.let { fillPickerRows(it) }
  }

  /** A-R5: only ids present in the visible session list may become activeSessionId. */
  internal fun isKnownSessionId(id: String): Boolean =
    id.isEmpty() || pickerSessions.any { it.id == id }

  private fun relativeTime(ts: Long): String {
    if (ts <= 0L) return "\u672a\u77e5\u65f6\u95f4"
    val diff = System.currentTimeMillis() - ts
    val m = diff / 60_000
    return when {
      m < 1 -> "\u521a\u521a"
      m < 60 -> m.toString() + "\u5206\u949f\u524d"
      m < 60 * 24 -> (m / 60).toString() + "\u5c0f\u65f6\u524d"
      else -> (m / (60 * 24)).toString() + "\u5929\u524d"
    }
  }

  // -- picker window (0.13.8 G2: independent TYPE_APPLICATION_OVERLAY window, not a
  //    Spinner SUB_PANEL child of the panel whose frame geometry clipped the list). --

  internal fun togglePickerWindow() {
    if (pickerWindow != null) closePicker() else openPickerWindow()
  }

  internal fun closePicker() {
    pickerWindow?.let { w -> try { if (w.parent != null) svc.wm.removeView(w) } catch (_: Exception) {} }
    pickerWindow = null
    pickerRowView = null
  }

  private fun openPickerWindow() {
    if (pickerWindow != null) return
    val row = sessionPicker ?: return
    val dp = svc.resources.displayMetrics.density
    val c = themeColors()
    val container = LinearLayout(svc).apply {
      orientation = LinearLayout.VERTICAL
      background = DsUi.roundRect(if (isDarkTheme()) 0xF01E1F24.toInt() else 0xF0FFFFFF.toInt(), 14 * dp, c.unitStroke, (1 * dp).toInt())
      elevation = 6 * dp
    }
    val list = LinearLayout(svc).apply { orientation = LinearLayout.VERTICAL }
    pickerRowView = list
    val scroll = android.widget.ScrollView(svc).apply {
      overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS // M10: stretch glow only when scrollable
      addView(list)
    }
    container.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    // Footer: 展开入口（A-R3 治理：默认最近 8 条）/ 读取失败时的重试入口（S2-9）
    val footer = TextView(svc).apply {
      val failed = pickerLoadError.isNotEmpty()
      text = when {
        failed -> pickerLoadError + t("（点此重试）", " (tap to retry)")
        !pickerShowAll && pickerSessions.size > 8 -> "\u5168\u90e8\u4f1a\u8bdd\uff08" + pickerSessions.size + "\uff09"
        else -> "\u5171 " + pickerSessions.size + " \u4e2a\u4f1a\u8bdd"
      }
      textSize = 12f
      setTextColor(
        if (failed) 0xFFE04848.toInt()
        else if (isDarkTheme()) 0xFF9AA0A6.toInt() else 0xFF5F6368.toInt(),
      )
      setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
      if (failed) {
        // S2-9：失败必须能重试。旧实现把 code != 200 静默当空列表，页脚于是写「共 0 个会话」
        // ——把失败画成了合法空态，用户以为「本来就没有会话」，且没有任何重试路径。
        contentDescription = t("会话列表读取失败，点此重试", "Failed to load sessions, tap to retry")
        minHeight = (44 * dp).toInt()
        background = DsUi.ripple(DsUi.roundRect(Color.TRANSPARENT, 8 * dp), if (isDarkTheme()) 0x22FFFFFF.toInt() else 0x22000000.toInt())
        setOnClickListener {
          svc.flashStatus(t("正在重新读取会话…", "Reloading sessions…"))
          refreshSessionPicker()
        }
      } else if (!pickerShowAll && pickerSessions.size > 8) {
        background = DsUi.ripple(DsUi.roundRect(Color.TRANSPARENT, 8 * dp), if (isDarkTheme()) 0x22FFFFFF.toInt() else 0x22000000.toInt())
        setOnClickListener {
          pickerShowAll = true
          fillPickerRows(list)
          text = "\u5171 " + pickerSessions.size + " \u4e2a\u4f1a\u8bdd"
        }
      }
    }
    container.addView(footer, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    fillPickerRows(list)
    val lp = android.view.WindowManager.LayoutParams(
      row.width.takeIf { it > 0 } ?: (300 * dp).toInt(),
      ViewGroup.LayoutParams.WRAP_CONTENT,
      android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,   // A-R4: own top-level window
      android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        android.view.WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      android.graphics.PixelFormat.TRANSLUCENT,
    )
    val loc = IntArray(2)
    row.getLocationOnScreen(loc)
    lp.gravity = android.view.Gravity.TOP or android.view.Gravity.START
    // Height cap at 45% of screen (tames unbounded lists; WRAP when short)
    container.measure(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    val screenW = svc.resources.displayMetrics.widthPixels
    val screenH = svc.resources.displayMetrics.heightPixels
    val maxH = (screenH * 0.45f).toInt()
    lp.height = container.measuredHeight.coerceAtMost(maxH)
    // S2-8（本批修）：x/y **必须钳制在屏内**。旧实现直接写 `loc[0]` / `loc[1] + row.height + 4dp`：
    // 触发行的屏幕 y 在下半屏时，窗口底部（列表尾部 + 页脚「全部会话」）落到屏幕外，
    // 而 overlay 窗口**不会**被用户滚进来——那些条目就是不可达。触发行的 x 靠右时同理。
    // 钳制口径：先保左/上不越界，再保右/下不出屏（超长时以「底部可见」优先，因为可达性比对齐更重要）。
    val gap = (8 * dp).toInt()
    lp.x = loc[0].coerceIn(0, (screenW - lp.width - gap).coerceAtLeast(0))
    lp.y = (loc[1] + row.height + (4 * dp).toInt())
      .coerceIn(0, (screenH - lp.height - gap).coerceAtLeast(0))
    container.setOnTouchListener { _, e ->
      if (e.action == android.view.MotionEvent.ACTION_OUTSIDE) closePicker()
      false
    }
    try {
      // M2 enter animation via WMS windowAnimations (no windowExitAnimation for overlays)
      lp.windowAnimations = R.style.OverlayPickerAnim
      svc.wm.addView(container, lp)
      pickerWindow = container
    } catch (e: Exception) {
      LogCollector.log("dsh-overlay", "picker window addView failed: " + (e.message ?: e.javaClass.simpleName))
    }
  }

  /** Rows: new-session + governed sessions (cap 8 / all) + touch feedback. */
  private fun fillPickerRows(list: LinearLayout) {
    list.removeAllViews()
    val dp = svc.resources.displayMetrics.density
    val dark = isDarkTheme()
    fun addRow(text: String, id: String, running: Boolean, current: Boolean) {
      val tv = TextView(svc).apply {
        this.text = (if (running) "\u25cf " else "") + text + (if (current) "  \u2713" else "")
        textSize = 13f
        setTypeface(null, if (current) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
        setTextColor(if (dark) 0xFFE8EAED.toInt() else 0xFF202124.toInt())
        background = DsUi.ripple(DsUi.roundRect(Color.TRANSPARENT, 8 * dp), if (dark) 0x22FFFFFF.toInt() else 0x22000000.toInt())
        setPadding((12 * dp).toInt(), (9 * dp).toInt(), (12 * dp).toInt(), (9 * dp).toInt())
        DsUi.bindPressScale(this)
        setOnClickListener {
          svc.activeSessionId = id
          // Explicit pick = pin (0.13.5 semantics); empty pick = new session, unpin.
          svc.userPinnedSession = id.isNotEmpty()
          if (id.isEmpty()) svc.sessionBusy = false
          // S2-10（本批修）：手选目标会话必须与「自动跟随」走**同一条**切换通知。
          // 旧实现只改 activeSessionId，没调 onTargetSessionChanged，于是归属旧会话的完成位
          // （「已完成」常驻文案）不被清除——面板展开着切会话，完成位与显示会脱节。
          svc.onTargetSessionChanged(id)
          performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM) // M9 haptics
          closePicker()
          updatePickerRowText()
          // P3-4：会话名超长时附省略号（旧实现 `take(20)` 硬截，用户看到一个像完整名字的片段）。
          svc.flashStatus(if (id.isEmpty()) "\u5df2\u5207\u6362\u5230 \u65b0\u4f1a\u8bdd" else "\u5df2\u5207\u6362\u5230 " + UserCopy.truncateWithEllipsis(text, 20))
          svc.renderPanelOnly()
        }
      }
      list.addView(tv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    addRow("\uff0b \u65b0\u4f1a\u8bdd", "", false, svc.activeSessionId.isEmpty())
    val cap = if (pickerShowAll) Int.MAX_VALUE else 8
    pickerSessions.take(cap).forEach { s ->
      addRow(s.label, s.id, s.running, s.id == svc.activeSessionId)
    }
  }
}

/** 权限审批待处理项（0.1.2-rc.1 $events waterfall 帧投影；eventId 关联键、agentId=目标会话 id）。 */
internal data class PendingApproval(val eventId: String, val agentId: String, val toolName: String, val reason: String, var submittedAt: Long = 0L)

/** AI 提问待处理项（$events waterfall 帧投影，request.questions 原始 JSONArray）。 */
internal data class PendingQuestion(val eventId: String, val agentId: String, val items: org.json.JSONArray, var submittedAt: Long = 0L)

// ── 待答卡/审批卡的常量（顶层：纯判据函数与 UI 代码共用同一份真源）──────────────────

/** 折叠态一次列出的选项数（卡面高度有限；超出的走「还有 N 项」入口，绝不静默丢弃）。 */
internal const val OPTIONS_COLLAPSED_MAX = 6

/** 会话标签解析不出来时给用户看的名（S2-7）：**不得**把内部 sessionId 截断上屏。 */
internal const val SESSION_UNKNOWN_LABEL = "未命名会话"

/**
 * 输入框提示语（S2-11，纯函数 JVM 可测）。
 *
 * 缺陷现场：提示语恒为「发消息可插话…」，但**空闲时发送根本不是插话**——`requestSend` 会按忙态
 * 选 mode=steer/queue，空闲时开的是新一轮；目标会话为空时还会先 `session/create` 新建会话。
 * 用错词会让用户误判「这句话会被塞进正在跑的轮次」，或反过来以为空闲时不能发。
 */
internal fun inputHintFor(busy: Boolean, hasSession: Boolean): String = when {
  busy -> "发消息可插话…"
  hasSession -> "发消息开新一轮…"
  else -> "发消息新建会话…"
}

/**
 * 目标会话行文本（S2-7，纯函数 JVM 可测）。
 *
 * 缺陷现场：标签解析不出来时旧实现把**内部 sessionId 硬截 16 字符**直接上屏
 * （`activeSessionId.take(16) + "…"`）——机器码不该出现在用户界面（审查档 §4.1），
 * 且截断后既认不出也搜不到。现在一律落到「未命名会话（当前）」：用户至少知道
 * 「这就是当前目标」，而不是面对一串 id。
 */
internal fun sessionRowText(label: String?): String =
  (label?.takeIf { it.isNotBlank() } ?: SESSION_UNKNOWN_LABEL) + "（当前）"

/** 审批二次确认的有效窗口：超窗即撤臂，避免陈旧待确认态把后来的一次单击变成放行。 */
internal const val APPROVAL_ARM_MS = 10_000L

// ── 待答卡/审批卡的纯判据（0.14.1 批 2；纯 JVM 单测，不需要 Robolectric）──────────────
//
// 为什么抽成顶层纯函数：这三条都是「用户点一下会发生什么」的判据，此前散在监听器里，
// 于是一类缺陷（箭头方向错、候选被丢、放行无确认）**没有任何离线判据**，只能靠设备实报。
// 抽出来之后，「改坏即判红」的单测可以钉住语义（见 OverlayPendingCardTest）。

/**
 * 翻页索引（**钳制，不回卷**）。
 *
 * P0-7 的语义纠正：旧实现把「‹ 1/N ›」整块做成一枚按钮，监听写成 `(qPage + 1) % n`
 * ——点视觉上的「上一题」实际跳下一题，末页还会回卷到第 1 页（多问题卡片上这是**做错事**）。
 * @param current - 当前页（0 基）。
 * @param total - 总页数。
 * @param delta - -1 上一题 / +1 下一题。
 * @return 钳制在 [0, total-1] 的页号；越界点击保持原页（按钮本身在端点禁用，这里做二重保险）。
 */
internal fun pagerIndex(current: Int, total: Int, delta: Int): Int {
  if (total <= 0) return 0
  return (current + delta).coerceIn(0, total - 1)
}

/**
 * 折叠态一次展示的选项数（P0-8）。
 *
 * 旧实现是 `coerceAtMost(6)` 直接**丢弃**第 7 项起的候选——用户看不到剩余项，只能手打。
 * 现在折叠 ≠ 丢弃：折叠只决定「先列几项」，剩余项由「还有 N 项（点此展开）」入口补足。
 */
internal fun optionsShownCount(total: Int, expanded: Boolean): Int {
  if (total <= 0) return 0
  return if (expanded) total else total.coerceAtMost(OPTIONS_COLLAPSED_MAX)
}

/** 折叠态被隐藏的候选数（> 0 时必须给出可见入口）。 */
internal fun optionsHiddenCount(total: Int, expanded: Boolean): Int =
  (total - optionsShownCount(total, expanded)).coerceAtLeast(0)

/**
 * 审批「批准一次」是否处于**已确认待放行**态（P0-9）。
 *
 * 放行的是一次真实工具执行（reason 里往往就是待执行命令），而此前单击即放行。
 * 判据要点：① 必须是**同一张卡**（armedId 相等）——换卡即撤臂，杜绝陈旧状态把后来的一次单击变成放行；
 * ② 必须落在确认窗口内（超窗视为未确认）。
 */
internal fun approvalArmed(
  armedId: String?,
  armedAtMs: Long,
  eventId: String,
  nowMs: Long,
  windowMs: Long = APPROVAL_ARM_MS,
): Boolean = armedId != null && armedId == eventId && nowMs - armedAtMs in 0 until windowMs
