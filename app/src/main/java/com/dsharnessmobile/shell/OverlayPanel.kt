package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
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
  private fun isDarkTheme() = theme.isDarkTheme()
  private fun themeColors() = theme.themeColors()

  // ── 展开态控件句柄 ────────────────────────────────────────────────
  internal var unitView: View? = null            // 展开合体圆角矩形（默认 GONE）
  internal var statusText: TextView? = null
  private var toolChip: TextView? = null
  private var clockText: TextView? = null
  private var closeView: ImageView? = null       // 展开态收起按钮（✕，会话选择行右端）
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
  private var pendingKey = ""                                    // 当前卡指纹（kind:eventId），变化即清作答态
  private var renderedCardKey = ""                               // 卡片已渲染指纹（防 live 流重绘打断输入）

  /** 服务 onDestroy 联动：关闭 mux 长连接（原 mux?.close(); mux = null）。 */
  internal fun destroy() {
    mux?.close(); mux = null
  }

  internal fun startMux() {
    mux = MuxClient("127.0.0.1", 3080, "/api/remote.mux") { text -> handleMuxFrame(text) }
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
      multiSel.clear(); qSingle.clear(); qCustom.clear(); qPage = 0; renderedCardKey = ""
    }
    updateBallOnly()
  }

  /** 展开合体圆角矩形（上区状态 + 下区输入，radius 30dp）。 */
  internal fun buildUnit(): View {
    val dp = svc.resources.displayMetrics.density
    val width = (svc.resources.displayMetrics.widthPixels - (64 * dp).toInt() - (32 * dp).toInt()).coerceAtMost((400 * dp).toInt())
    val c = themeColors()

    // 目标会话选择器（0.13.8 G2 重构）：一行式目标显示，点击弹出**独立顶层 overlay
    // 窗口**（非 Spinner 子窗口——几何不再受父 frame 支配）；列表按官方可视性口径
    // 过滤，条目带触摸反馈；选择动作即时、显式（A-R6 的 Spinner 异步回调竞态随之消失）。
    val pickerRowText = TextView(svc).apply {
      tag = "overlay-sessionpicker"
      contentDescription = "选择发送对话"
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.idleText)
      text = "＋ 新会话"
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.END
      background = DsUi.ripple(
        DsUi.roundRect(Color.TRANSPARENT, 10 * dp, c.unitStroke),
        if (isDarkTheme()) 0x33FFFFFF.toInt() else 0x22000000.toInt(),
      )
      setPadding((10 * dp).toInt(), (5 * dp).toInt(), (10 * dp).toInt(), (5 * dp).toInt())
      setOnClickListener { togglePickerWindow() }
      DsUi.bindPressScale(this)
    }
    sessionPicker = pickerRowText

    val status = ShimmerTextView(svc).apply {
      text = "空闲"
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.idleText)
    }
    statusText = status

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
    val close = ImageView(svc).apply {
      setImageResource(R.drawable.dsh_ic_close)
      setColorFilter(c.chevron)
      contentDescription = "收起面板"
      isClickable = true
      setOnClickListener { svc.hidePanel() }
    }
    closeView = close

    // 会话选择行（独立一行，向下箭头 Spinner）+ 右端 ✕ 收起
    val pickerRow = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (2 * dp).toInt())
      addView(pickerRowText, LinearLayout.LayoutParams(0, (26 * dp).toInt(), 1f))
      addView(close, LinearLayout.LayoutParams((20 * dp).toInt(), (20 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
    }

    // 状态行：状态文字 + 工具×N + 时钟（收起按钮已移至顶行 ✕）
    val row1 = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (4 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
      addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(chip)
      addView(clock, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * dp).toInt() })
    }

    // 输入行：输入框 + 蓝圆发送（白箭头 IconSendOutline16）+ 红圆停止（白方块 rx=3）
    val input = EditText(svc).apply {
      hint = "发消息可插话…"
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

    val send = FrameLayout(svc).apply {
      val inner = ImageView(svc).apply { setImageResource(R.drawable.dsh_ic_send) }
      addView(inner, FrameLayout.LayoutParams((16 * dp).toInt(), (16 * dp).toInt(), Gravity.CENTER))
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF4176E6.toInt()) }
      isClickable = true
      setOnClickListener { svc.requestSend() }
      tag = "overlay-send"
    }
    sendBtn = send

    val stop = FrameLayout(svc).apply {
      val inner = ImageView(svc).apply { setImageResource(R.drawable.dsh_ic_stop) }
      addView(inner, FrameLayout.LayoutParams((12 * dp).toInt(), (12 * dp).toInt(), Gravity.CENTER))
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFE04848.toInt()) }
      isClickable = true
      setOnClickListener { svc.requestStop() }
      tag = "overlay-stop"
    }
    stopBtn = stop

    val row2 = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
      addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(send, LinearLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
      addView(stop, LinearLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
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
      st.setTextColor(if (!svc.engineRunning) c.offText else c.idleText)
    }
    closeView?.setColorFilter(c.chevron)
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

  private fun templateThinking(): String =
    displayPrefs().getString("template_thinking", "Deep diving...") ?: "Deep diving..."

  private fun templateTool(): String =
    displayPrefs().getString("template_tool", "{tool} · {summary}") ?: "{tool} · {summary}"

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
        text = "权限审批"
      }
      box.addView(title)
      val body = TextView(svc).apply {
        textSize = 13f
        setTextColor(textColor)
        text = listOf("工具 ${a.toolName}", a.reason).filter { it.isNotBlank() }.joinToString("：")
      }
      box.addView(body)
      val buttonRow = LinearLayout(svc).apply { orientation = LinearLayout.HORIZONTAL }
      buttonRow.addView(pendingChip("批准一次", filled = true, red = false, dp) { respondApproval(a, "allowed-once") }, lpChip(dp))
      buttonRow.addView(pendingChip("拒绝", filled = false, red = true, dp) { respondApproval(a, "rejected") }, lpChip(dp))
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
      text = item.optString("header", "").ifBlank { "问题 ${qPage + 1}" }
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
      for (oi in 0 until opts.length().coerceAtMost(6)) {
        val o = opts.optJSONObject(oi) ?: continue
        val label = o.optString("label").ifBlank { "选项${oi + 1}" }
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
      hint = "输入你的答案"
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
      foot.addView(TextView(svc).apply {
        text = "‹ ${qPage + 1}/$n ›"
        textSize = 12f
        setTextColor(subColor)
        setPadding((4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt())
        isClickable = true
        setOnClickListener { qPage = (qPage + 1) % n; renderPendingCard(true) }
      })
      foot.addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
      if (qPage > 0) {
        foot.addView(pendingChip("跳过本题", filled = false, red = false, dp) {
          qSingle.remove(qid); qCustom.remove(qid); multiSel.remove(qid)
          qPage = (qPage + 1).coerceAtMost(n - 1)
          renderPendingCard(true)
        }, lpChip(dp))
      }
      val last = qPage == n - 1
      foot.addView(pendingChip(if (last) "提交" else "下一题", filled = true, red = false, dp) {
        if (!last) { qPage++; renderPendingCard(true); return@pendingChip }
        respondQuestion(qe)
      }, lpChip(dp))
    } else {
      foot.addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
      // 单问多选无自动提交路径 → 给「提交」；单选点选项即答、自定义走键盘 DONE 即答
      if (multi) foot.addView(pendingChip("提交", filled = true, red = false, dp) { respondQuestion(qe) }, lpChip(dp))
      foot.addView(pendingChip("跳过", filled = false, red = false, dp) { dismissQuestion(qe) }, lpChip(dp))
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
          val conn = URL("http://127.0.0.1:3080/api/\$events/result").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
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
        svc.flashStatus(if (outcome == "allowed-once") "已批准（等待引擎确认）" else "已拒绝")
        onPendingChanged()
      } else svc.flashStatus("应答失败")
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
        svc.flashStatus("已回答（等待引擎确认）")
        onPendingChanged()
      } else svc.flashStatus("应答失败")
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
        svc.flashStatus("已跳过")
        onPendingChanged()
      } else svc.flashStatus("应答失败")
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
      statusText?.let {
        if (svc.pendingKind == "question") {
          (it as ShimmerTextView).setShimmering(false)
          animateTextColor(it, 0xFFB8860B.toInt())
          setStatusText(it, "等待你的回答…")
          setAmberBreathing(it, true)
        } else if (svc.pendingKind == "approval") {
          (it as ShimmerTextView).setShimmering(false)
          animateTextColor(it, 0xFFB8860B.toInt())
          setStatusText(it, "等待权限审批…")
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
        } else {
          (it as ShimmerTextView).setShimmering(false)
          setAmberBreathing(it, false)
          animateTextColor(it, 0xFF8A8F98.toInt())
          setStatusText(it, if (svc.engineRunning) "空闲" else "引擎离线")
        }
      }
      toolChip?.let {
        if (svc.toolCount > 0) { it.text = "工具 ×${svc.toolCount}"; it.visibility = View.VISIBLE }
        else it.visibility = View.GONE
      }
      updateClock()
      stopBtn?.alpha = if (svc.sessionBusy) 1f else 0.35f
      renderPendingCard()
    }
  }

  private fun updateClock() {
    val ct = clockText ?: return
    if (!svc.sessionBusy) { ct.visibility = View.GONE; return }
    val elapsed = System.currentTimeMillis() - svc.turnStartedAt
    if (elapsed < 15_000) { ct.visibility = View.GONE; return }
    ct.visibility = View.VISIBLE
    val sec = elapsed / 1000
    ct.text = if (sec >= 60) "${sec / 60}分%02d秒".format(sec % 60) else "${sec}s"
  }

  /** session/list -> target picker data (G2: official visibility filter + label fallback chain). */
  internal fun refreshSessionPicker() {
    svc.postRpc("session/list", JSONObject().put("_request", JSONObject())) { code, body ->
      pickerSessions.clear()
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
    else (current?.label ?: svc.activeSessionId.take(16) + "\u2026") + "\uff08\u5f53\u524d\uff09"
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
    // Footer: expand-all entry (A-R3 governance: most recent 8 by default; search pending session/search wiring)
    val footer = TextView(svc).apply {
      text = if (!pickerShowAll && pickerSessions.size > 8) "\u5168\u90e8\u4f1a\u8bdd\uff08" + pickerSessions.size + "\uff09" else "\u5171 " + pickerSessions.size + " \u4e2a\u4f1a\u8bdd"
      textSize = 12f
      setTextColor(if (isDarkTheme()) 0xFF9AA0A6.toInt() else 0xFF5F6368.toInt())
      setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
      if (!pickerShowAll && pickerSessions.size > 8) {
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
    lp.x = loc[0]
    lp.y = loc[1] + row.height + (4 * dp).toInt()
    // Height cap at 45% of screen (tames unbounded lists; WRAP when short)
    container.measure(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    val maxH = (svc.resources.displayMetrics.heightPixels * 0.45f).toInt()
    lp.height = container.measuredHeight.coerceAtMost(maxH)
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
          performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM) // M9 haptics
          closePicker()
          updatePickerRowText()
          svc.flashStatus(if (id.isEmpty()) "\u5df2\u5207\u6362\u5230 \u65b0\u4f1a\u8bdd" else "\u5df2\u5207\u6362\u5230 " + text.take(20))
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
