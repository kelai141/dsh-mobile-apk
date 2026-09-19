package com.dsharnessmobile.shell

import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * 块H-A2（0.14.1）报告栏协作类：长按状态行 → 底部可滚动的上拉/下拉栏，预览 agent 最近一次汇报。
 *
 * 形态判定（详档 §4.1，逐条对照）：
 *  - **新增独立顶层窗口**，不复用 unit 面板。理由：unit 是贴球定位（positionPanel）且承载输入框与 IME；
 *    用户要的是「底部抽屉」语义，锚定关系与 unit 根本不同；且抽屉需要可约束高度，与 unit 的
 *    WRAP_CONTENT + 收进屏内假设冲突。同构先例 = OverlayPanel 的 pickerWindow（独立顶层 overlay 窗口，
 *    FLAG_NOT_TOUCH_MODAL + FLAG_WATCH_OUTSIDE_TOUCH，点栏外即关）。
 *  - 关闭三条路：① 点栏外（ACTION_OUTSIDE）；② 显式关闭按钮；③ **面板收起时联动收口**
 *    （hidePanel 与 onDestroy 两处，纪律同 FX-212.1——防「面板视图缺失但子窗口仍在屏上」的残窗）。
 *  - 内容来源：`NotifyStore.latestReportLine()`（T6 为块H 提供的进程内窄接口，签名稳定）。
 *    渲染口径复用 NotifyCenter.reportLine/reportBigText 的既有文案（后者是私有函数，故此处镜像口径，
 *    不新造字段语义）：首行 = outcomeLabel[ + " · " + summary]，次行 = 用时 … · 工具 ×N，末行 = 产出：…。
 *  - 空摘要（NotifyEntry.summary 可空，notify-projection 侧 `?? ''`）必须**仍能打开且不崩**：
 *    reportLines 对 null 条目返回占位行，对空 summary 只输出 head，绝不返回空列表。
 */
class OverlayReport(private val svc: OverlayService) {

  private var window: View? = null
  // 主题协作类（与 OverlayPanel 同款：构造注入服务引用，不在构造期解引用服务状态）。
  private val theme = OverlayTheme(svc)

  private fun themeColors() = theme.themeColors()

  fun isShowing(): Boolean = window != null

  /** 长按入口：已开则收起，未开则打开。返回是否已显示（供调用方判断手势是否被消费）。 */
  fun toggleReport(): Boolean {
    if (isShowing()) { hideReport(); return false }
    return showReport()
  }

  /** 组装栏体（每次打开重建：内容随时可能更新，复用会显示陈旧文本）。 */
  internal fun buildReportBar(): View {
    val dp = svc.resources.displayMetrics.density
    val c = themeColors()
    val entry = latestEntry()
    val lines = reportLines(entry)

    val title = TextView(svc).apply {
      text = "工作汇报"
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.inputText)
    }
    val close = TextView(svc).apply {
      text = "✕"
      textSize = 14f
      setTextColor(c.clockText)
      setPadding((10 * dp).toInt(), (2 * dp).toInt(), (10 * dp).toInt(), (2 * dp).toInt())
      isClickable = true
      setOnClickListener { hideReport() }
    }
    val header = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((14 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (4 * dp).toInt())
      addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(close)
    }

    // 正文：逐行 TextView（首行 head+summary、次行时长/工具数、末行产出清单）。
    val body = LinearLayout(svc).apply { orientation = LinearLayout.VERTICAL }
    for ((i, line) in lines.withIndex()) {
      body.addView(TextView(svc).apply {
        text = line
        textSize = if (i == 0) 13f else 12f
        setTextColor(if (i == 0) c.inputText else c.clockText)
        if (i == 0) setTypeface(null, android.graphics.Typeface.NORMAL)
        setPadding((14 * dp).toInt(), (3 * dp).toInt(), (14 * dp).toInt(), (3 * dp).toInt())
      })
    }

    // 可滚动容器（先例 OverlayPanel.openPickerWindow 的 ScrollView）。
    val scroll = ScrollView(svc).apply {
      overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
      isFillViewport = false
      addView(body, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    // 底部拖拽手柄（视觉提示「可上拉/下拉」；不做手势，避免与「栏内可滚动」抢事件）。
    val handle = View(svc).apply {
      background = GradientDrawable().apply { cornerRadius = (2 * dp).toInt().toFloat(); setColor(c.unitStroke) }
    }
    val handleRow = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      setPadding(0, (6 * dp).toInt(), 0, (8 * dp).toInt())
      addView(handle, LinearLayout.LayoutParams((36 * dp).toInt(), (4 * dp).toInt()))
    }

    return LinearLayout(svc).apply {
      orientation = LinearLayout.VERTICAL
      background = DsUi.roundRect(
        if (theme.isDarkTheme()) 0xF01E1F24.toInt() else 0xF0FFFFFF.toInt(),
        16 * dp, c.unitStroke, (1 * dp).toInt(),
      )
      elevation = 8 * dp
      addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
      addView(handleRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
  }

  /**
   * 打开报告栏。**空汇报也必须打开**（A2 反证：summary 可空，不得因空字段静默不显示）——
   * 内容为空时 reportLines 给占位行，窗口照常出现，用户不会得到「长按没反应」的假象。
   */
  fun showReport(): Boolean {
    if (window != null) return true
    val dp = svc.resources.displayMetrics.density
    val sw = svc.resources.displayMetrics.widthPixels
    val sh = svc.resources.displayMetrics.heightPixels
    // 栏体构建失败不得静默返回（坑 149 判据：无日志的静默失败 = 一道发现不了缺陷的防线）。
    // 用户观感是「长按没反应」，若无日志则现场无从诊断（与 pickerWindow 的 addView 失败同口径）。
    val bar = try {
      buildReportBar()
    } catch (e: Exception) {
      LogCollector.log("dsh-overlay-report", "report bar build failed: " + (e.message ?: e.javaClass.simpleName))
      return false
    }
    val w = (sw - 2 * (16 * dp).toInt()).coerceAtMost((440 * dp).toInt()).coerceAtLeast((200 * dp).toInt())
    // 高度：屏高 40% 为上限（详档 §4.1 的抽屉形态；具体比例属未确证项，实机走查时按需调整）。
    val maxH = (sh * 0.40f).toInt()
    val lp = android.view.WindowManager.LayoutParams(
      w,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      // 与 pickerWindow 同款：栏外触摸照常穿透 + 点栏外即关（ACTION_OUTSIDE）。
      // **不**加 FLAG_NOT_FOCUSABLE 语义到 unit 面板路径——本窗口独立，不涉及面板 IME。
      android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        android.view.WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.START
      x = (sw - w) / 2
      y = 0
    }
    bar.measure(
      View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.AT_MOST),
      View.MeasureSpec.makeMeasureSpec(maxH, View.MeasureSpec.AT_MOST),
    )
    lp.height = bar.measuredHeight.coerceIn(1, maxH.coerceAtLeast(1))
    bar.setOnTouchListener { _, e ->
      if (e.action == MotionEvent.ACTION_OUTSIDE) hideReport()
      false
    }
    return try {
      svc.wm.addView(bar, lp)
      window = bar
      true
    } catch (e: Exception) {
      LogCollector.log("dsh-overlay-report", "report bar addView failed: " + (e.message ?: e.javaClass.simpleName))
      false
    }
  }

  /** 关窗（幂等；hidePanel / onDestroy 联动收口都走这里）。 */
  fun hideReport() {
    val w = window ?: return
    window = null
    try { if (w.parent != null) svc.wm.removeView(w) } catch (_: Exception) {}
  }

  // ── 纯逻辑（JVM 可测，无 Android 依赖） ───────────────────────────────

  /** 最近一条 report（T6 窄接口 → 既有解析器 NotifyStore.parseEntry，不另造第二份解析口径）。 */
  internal fun latestEntry(): NotifyEntry? = try {
    NotifyStore.latestReportLine()?.let { NotifyStore.parseEntry(it) }
  } catch (_: Throwable) {
    null
  }
}

/**
 * 报告栏正文行（**顶层纯函数**，不解引用服务/Context → JVM 单测直接覆盖，不需要 Robolectric）。
 *
 * 复用 NotifyCenter.reportLine/reportBigText 的既有文案口径（后者是私有函数，故此处镜像口径，
 * 不新造字段语义）：
 *  首行 = head[ + " · " + summary]，head = outcomeLabel（空则 outcomeLabel() 映射，再空则「工作汇报」）；
 *  次行 = 用时 <durationLabel> · 工具 ×<toolCount>；
 *  末行 = 产出：<name1>、<name2>…（presentedFiles 非空时）。
 *
 * **条目为 null（本进程还没见过 report）不返回空表**——给占位行，保证长按后窗口仍能打开、
 * 用户不会得到「长按没反应」的假象（详档 §6.2 A2 反证）。
 */
internal fun reportLines(entry: NotifyEntry?): List<String> {
  if (entry == null) return listOf("暂无汇报内容", "完成一轮对话后这里会显示汇报")
  val head = entry.outcomeLabel.ifBlank { entry.outcomeLabel() }.ifBlank { "工作汇报" }
  val summary = entry.summary.ifBlank { entry.text }
  val out = ArrayList<String>(3)
  out.add(if (summary.isBlank()) head else head + " · " + summary)
  out.add("用时 " + entry.durationLabel() + " · 工具 ×" + entry.toolCount)
  if (entry.presentedFiles.isNotEmpty()) {
    out.add("产出：" + entry.presentedFiles.joinToString("、"))
  }
  return out
}

/**
 * 块H 状态行手势的**纯裁决逻辑**（顶层函数，JVM 可直接测——A3 的两条防误触判据在这里判红）。
 */
internal enum class StatusGestureAction { NONE, JUMP_TO_APP }

/** 三击计数：距上次 UP 在窗口内则累加，否则重置为 1（窗口运行时读取，不编造数字）。 */
internal fun nextTapCount(now: Long, lastUpAt: Long, tapWindowMs: Long, current: Int): Int =
  if (now - lastUpAt <= tapWindowMs) current + 1 else 1

/**
 * UP 时刻的裁决：仅当「未拖动（未超 touchSlop）且长按未触发且累计点击达 3」才跳转。
 *  - A3 反证 1：二次点击（tapCount < 3）→ NONE，不得跳转；
 *  - A3 反证 2：长按已触发（longFired）→ NONE，该手势不得再触发 A3（一次手势一个动作）；
 *  - 防误触：按住并滑动超 touchSlop（moved）→ NONE，判为拖动。
 */
internal fun statusUpAction(moved: Boolean, longFired: Boolean, tapCount: Int): StatusGestureAction =
  if (!moved && !longFired && tapCount >= 3) StatusGestureAction.JUMP_TO_APP else StatusGestureAction.NONE

/**
 * 块H-A1 语义映射：`.live.ndjson` 的 `turn_end.kind` → 完成态标签。
 *
 * 与 `plugins/dsh-android-bridge/src/notify-projection.ts` 的 `reportOutcomeLabel(kind)`
 * **逐字同构**（那是「已完成/失败/被阻塞/…」的唯一权威定义处，`'completed' -> '已完成'`）。
 * 未知 kind 一律「结果未知」——**不得**退化成「已完成」（把失败误报为完成是本需求最危险的错误，
 * 详档 §3.1）。
 */
internal fun turnEndLabel(kind: String): String = when (kind) {
  "completed" -> "已完成"
  "error" -> "失败"
  "blocked" -> "被阻塞"
  "aborted" -> "已中止"
  "max-tokens" -> "输出超限"
  "interrupted" -> "被中断"
  else -> "结果未知"
}

/**
 * 块H-A1 完成位（0.14.1）。会话维 + 消费标记：
 *
 *  - `armed`：有一次「尚未被看到的完成」。轮次结束时置位，**面板收起态也能存活**（本类挂在
 *    OverlayService 服务级字段上，不在面板视图的视图状态里——详档 §3.2 判定 2：自动收起
 *    默认开，所以「完成后用户还没看到面板」是默认路径）。
 *  - `consume()`（`showPanel()` 首次打开调用）：把完成位搬进 `shownLabel` 供**本次展开期常驻**
 *    显示，并**清空 `armed`**——这正是「首次」二字的实现：同一完成位只能被消费一次，
 *    下次收起再打开不会又冒出来（详档 §3.2 判定 1）。
 *  - `onPanelHidden()`（`hidePanel()` 调用）：结束本次展示，文案回常态。`armed` 为 null 时
 *    再打开即显示常态文案。
 *  - 清空：新一轮开始（`running=true` 或任一 `tool_call`）。
 *
 * **两条信号的分工（详档 §3.1，这是 A1 最容易做错的地方）**：
 *  - 触发用**权威信号** `api-session/status running=false`（`onAuthoritativeIdle`）——
 *    它自带会话感知与定位，且已承载既有完成处理。
 *  - 语义标签用 `.live.ndjson` 的 `turn_end`（`onTurnEnd` 带 `ok`/`kind`）——权威信号只给
 *    `running:boolean`，**不给结果原因**；失败/被阻塞/被中断都不得显示「已完成」。
 *  - 关键细节：权威信号**不得覆盖**已到的语义标签。二者到达顺序不定（live 文件消费者与 WS
 *    下行是两条独立路径），但语义标签更精确，故一旦带标签就不再被默认文案改写。
 */
internal class CompletionNotice {

  /** 未消费的完成位：null = 无。pair = (会话键, 文案标签)。 */
  private var armed: Pair<String, String>? = null

  /** 消费后仍在展示的文案；"" = 回常态。 */
  private var shownLabel = ""

  /** 正在展示的完成位所属会话键（`activeLabelFor` 的比对依据）。 */
  private var shownSessionId = ""

  /**
   * 轮次结束（`.live.ndjson` turn_end，带语义）。只对**当前目标会话**生效——
   * 否则会出现「A 会话完成，B 会话的悬浮窗显示已完成」的错配（详档 §3.1 硬性 1）。
   * @param label 「已完成」或对应的失败类标签（reportOutcomeLabel 口径）。
   */
  fun onTurnEnd(sessionId: String, label: String) {
    if (label.isBlank()) return
    // 若该文案此刻正在展示（权威信号先到并被展开态消费），只升级文案、不把它撤下——
    // 否则语义标签后到会让用户眼前刚出现的完成提示瞬间消失。
    if (shownLabel.isEmpty()) {
      armed = sessionId to label
    } else {
      shownLabel = label
      shownSessionId = sessionId
    }
  }

  /**
   * 权威空闲信号（api-session/status running=false）。**仅当尚无带标签的完成位时**置默认文案——
   * 不覆盖更精确的语义标签，也不改写它归属的会话（见类注释）。
   */
  fun onAuthoritativeIdle(sessionId: String, defaultLabel: String) {
    val cur = armed
    if (cur != null && cur.second.isNotBlank()) return
    armed = sessionId to defaultLabel
    shownLabel = ""
  }

  /**
   * 新一轮开始：**立即清除**完成位与展示文案（详档 §3.1 硬性 2：完成位必须独立于
   * toolCount/currentToolName，且新一轮必须清除旧完成位，否则 A 轮完成后 B 轮进行中仍显示
   * 「已完成」）。
   */
  fun onTurnStart() {
    armed = null
    shownLabel = ""
    shownSessionId = ""
  }

  /**
   * 目标会话切换（详档 §3.2 复位时机「目标会话切换清除」）：完成位归属别的会话则整体清除，
   * 避免「A 会话完成」的文案被 B 会话的悬浮窗呈现。
   *
   * 语义说明：空键（尚无目标会话 / 未知归属）视为**通配**——不因切换而误清（那会让 A1 在
   * 目标尚未确定时永不显示）。只有「双方都非空且不相等」才算真切换。
   * @return 是否因切换而清除了完成位。
   */
  fun onTargetSessionChanged(newSessionId: String): Boolean {
    if (newSessionId.isEmpty()) return false
    var cleared = false
    val cur = armed
    if (cur != null && cur.first.isNotEmpty() && cur.first != newSessionId) {
      armed = null
      cleared = true
    }
    if (shownSessionId.isNotEmpty() && shownSessionId != newSessionId) {
      shownLabel = ""
      shownSessionId = ""
      cleared = true
    }
    return cleared
  }

  /**
   * 首次打开面板：消费完成位 → 本次展开期常驻；同时清空 `armed` 保证「首次」语义
   * （下次收起再打开不再显示）。无完成位则无操作。
   * @return 是否消费到了一个完成位。
   */
  fun consume(): Boolean {
    val cur = armed ?: return false
    armed = null
    shownLabel = cur.second
    shownSessionId = cur.first
    return true
  }

  /** 面板收起：结束本次展示（下次打开若无新完成位即回常态）。 */
  fun onPanelHidden() {
    shownLabel = ""
    shownSessionId = ""
  }

  /**
   * 当前该显示的完成态文案；"" = 常态（未消费 / 已收起 / 新一轮 / **会话不匹配**）。
   *
   * **会话比对（task-14 补的真实防线）**：完成位记录所属会话键，只有与当前目标会话一致才呈现。
   * 旧实现只把 sessionId 存进 pair 却**从不比对**（`.first` 零命中）→ 那个字段是死数据，
   * 所谓「按会话分桶」只是注释里的声明。此处把它变成真正的渲染门。
   * 空键仍按通配处理（见 [onTargetSessionChanged]）。
   */
  fun activeLabelFor(activeSessionId: String): String {
    if (shownLabel.isEmpty()) return ""
    if (shownSessionId.isNotEmpty() && activeSessionId.isNotEmpty() && shownSessionId != activeSessionId) return ""
    return shownLabel
  }

  /** 兼容入口（无目标会话上下文时按通配处理）。 */
  fun activeLabel(): String = activeLabelFor("")

  /** 是否存在未消费的完成位（供测试与守卫判定）。 */
  fun isArmed(): Boolean = armed != null

  /** 未消费完成位所属会话键（测试用；null = 无完成位）。 */
  fun armedSessionId(): String? = armed?.first
}
