package com.dsharnessmobile.shell

/**
 * 卡片主状态：空闲 / 工作中 / 等待用户 / 引擎出错。
 *
 * 为什么状态只有四档：渲染层只据此决定状态点颜色与默认文案，
 * 更多细分（被阻塞、输出超限）由 [OverlayCardModel.completionLabel] 承载，
 * 两者混在一起会让每个新 kind 都要改一遍状态机。
 */
internal enum class OverlayAgentState { IDLE, RUNNING, WAITING, ERROR }

/**
 * 药丸色调：与状态一一对应，但不复用 [OverlayAgentState]。
 *
 * 为什么分开：药丸还可以用于引擎探活等非轮次信号（ERROR = 引擎离线），
 * 状态枚举里没有「引擎」这一维，硬塞会污染轮次语义。
 */
internal enum class OverlayTone { IDLE, WORKING, WAITING, ERROR }

/**
 * 卡片里的一行工具调用。
 *
 * @property callId 工具调用 id；用于 tool_result 配对。旧插件可能没有该字段，
 *   此时为空串——空串不参与按 id 配对，只按 name 去重。
 * @property name 工具名（如 android_screenshot）。
 * @property summary 单行摘要（参数/结果摘要，由事件源截好）。
 * @property running 是否仍在执行（tool_result 到达后置 false）。
 * @property failed 是否失败；当前 live 协议没有失败位，保留字段供后续事件源填充。
 */
internal data class OverlayToolRow(
  val callId: String,
  val name: String,
  val summary: String,
  val running: Boolean,
  val failed: Boolean,
)

/**
 * 一条待答项（审批或提问）。
 *
 * @property eventId 事件 id，回答时回传，必须原样保留。
 * @property kind 闭集：approval 或 question。
 * @property title 单行展示文本。
 */
internal data class OverlayPendingItem(
  val eventId: String,
  val kind: String,
  val title: String,
)

/**
 * 顶部卡片的不可变聚合模型（纯数据，渲染层只读它）。
 *
 * 为什么不可变 + 纯函数聚合：事件风暴下每一帧都可能来一条事件，
 * 只有「输入旧模型 + 事件 -> 新模型」才能把合并、去重、上限全部单测，
 * 也才能用 == 判断是否真的需要动 View（静止时零刷新）。
 *
 * @property agent 轮次主状态。
 * @property headline 最新可见正文行（onText 写入）；为空时由 [OverlayUiModel.headlineOf] 推导。
 * @property thinkingLine 最近一次思考摘要（<= [OverlayUiModel.MAX_THINKING_CHARS] 字符）。
 * @property toolRows 工具行，最旧在头、最新在尾，环形上限 50。
 * @property pending 待答项，最多 8 条。
 * @property turnStartedAt 本轮开始时间（0 = 还没有轮次）。
 * @property lastEventAt 最近一条事件时间，用于合并窗口判定。
 * @property completionLabel 本轮结局文案（中英按调用方语言落地在 onTurnEnd）。
 * @property toolCount 本轮工具调用计数（含已被环形淘汰的），药丸/汇报可用。
 */
internal data class OverlayCardModel(
  val agent: OverlayAgentState = OverlayAgentState.IDLE,
  val headline: String = "",
  val thinkingLine: String = "",
  val toolRows: List<OverlayToolRow> = emptyList(),
  val pending: List<OverlayPendingItem> = emptyList(),
  val turnStartedAt: Long = 0L,
  val lastEventAt: Long = 0L,
  val completionLabel: String = "",
  val toolCount: Int = 0,
)

/**
 * 药丸单行模型：文案 + 色调。
 *
 * 文案在聚合层就按语言定稿（[OverlayUiModel.pillOf]），渲染层不再做判断，
 * 避免同一个「正在等用户」在两处各写一遍中英文。
 */
internal data class OverlayPillModel(val text: String, val tone: OverlayTone)

/**
 * 事件聚合层：把 live 流事件折叠成 [OverlayCardModel]（纯 Kotlin，JVM 可测）。
 *
 * 为什么所有事件都返回新模型而不是可变状态：上层的合并节流（100ms 一次）会丢弃中间态，
 * 只有纯函数才能在丢弃后仍得到同一个终态；也才能在 JVM 单测里把上限、去重、
 * 合并窗口全部钉死，不需要设备。
 */
internal object OverlayUiModel {
  /** 工具行环形上限：超出丢最旧（design.md §5.4）。 */
  const val MAX_TOOL_ROWS = 50
  /** 思考/正文行最大字符数；超长截断并补省略号。 */
  const val MAX_THINKING_CHARS = 120
  /** 待答项上限：超出保留最新（design.md §5.4）。 */
  const val MAX_PENDING = 8
  /** 文本合并窗口：400ms 内的连续更新视为同一行（design.md §4.2 / MotionCoalescer 口径）。 */
  const val MERGE_WINDOW_MS = 400L

  /** 中文结局标签表；与 OverlayReport.turnEndLabel 的 kind 闭集逐条同构。 */
  private fun endLabelZh(kind: String): String = when (kind) {
    "completed" -> "已完成"
    "error" -> "失败"
    "blocked" -> "被阻塞"
    "aborted" -> "已中止"
    "max-tokens" -> "输出超限"
    "interrupted" -> "被中断"
    else -> "结果未知"
  }

  /** 英文结局标签表：与中文逐条成对，未知 kind 也不得退化成「已完成」。 */
  private fun endLabelEn(kind: String): String = when (kind) {
    "completed" -> "Completed"
    "error" -> "Failed"
    "blocked" -> "Blocked"
    "aborted" -> "Aborted"
    "max-tokens" -> "Output limit reached"
    "interrupted" -> "Interrupted"
    else -> "Unknown result"
  }

  /**
   * 截断单行文本到 [MAX_THINKING_CHARS] 字符以内（含省略号）。
   *
   * 为什么省略号也算在预算里：设计约束是「单行 <= 120 字符」，
   * 若 120 字正文再加一个省略号就变成 121，等于悄悄破了上限。
   */
  private fun truncateLine(text: String): String {
    val flat = text.replace('\n', ' ').replace('\r', ' ').trim()
    if (flat.length <= MAX_THINKING_CHARS) return flat
    return flat.take(MAX_THINKING_CHARS - 1) + "…"
  }

  /**
   * 工具行文本：名字 + 摘要（摘要为空时只给名字）。
   *
   * 为什么失败行加了前缀而不是只换颜色：卡片是扫一眼的信息层，
   * 纯颜色差异在色弱/强光下读不出来。
   */
  private fun toolLine(row: OverlayToolRow): String {
    val name = row.name.ifBlank { "工具" }
    val prefix = if (row.failed) "失败 " else ""
    val body = if (row.summary.isBlank()) name else name + " · " + row.summary
    return prefix + body
  }

  /**
   * 收到一条 tool_call：按 callId 优先、其次按 name 去重后追加/更新。
   *
   * 为什么同名也去重：同一工具在一轮里被连续调用时，UI 上连续出现两行同名
   * 只会挤掉别的行信息量；更新已有行（新摘要覆盖旧摘要）更接近「当前在做什么」。
   * 保留原位置而不是移到末尾，是为了避免列表在事件风暴里上下跳。
   *
   * @param callId 工具调用 id；旧插件可能传空串。
   * @param name 工具名。
   * @param summary 单行摘要。
   * @param at 事件时间 ms。
   */
  fun onToolCall(
    m: OverlayCardModel,
    callId: String,
    name: String,
    summary: String,
    at: Long,
  ): OverlayCardModel {
    val row = OverlayToolRow(
      callId = callId,
      name = name,
      summary = summary,
      running = true,
      failed = false,
    )
    val index = m.toolRows.indexOfFirst { callId.isNotEmpty() && it.callId == callId }
      .let { if (it >= 0) it else m.toolRows.indexOfFirst { it.name == name } }
    val rows = if (index >= 0) {
      m.toolRows.toMutableList().also { it[index] = row }
    } else {
      (m.toolRows + row).takeLast(MAX_TOOL_ROWS)
    }
    val countedBefore = m.toolRows.any { callId.isNotEmpty() && it.callId == callId }
    return m.copy(
      toolRows = rows,
      toolCount = if (countedBefore) m.toolCount else m.toolCount + 1,
      lastEventAt = at,
    )
  }

  /**
   * 收到一条 tool_result：把配对行置为已结束。
   *
   * 为什么找不到配对就整体忽略、不新增占位行：结果事件本身没有工具名与摘要，
   * 凭空插一行「未知工具」只会污染列表；丢弃比乱编更安全。
   */
  fun onToolResult(m: OverlayCardModel, callId: String, at: Long): OverlayCardModel {
    val index = m.toolRows.indexOfFirst { callId.isNotEmpty() && it.callId == callId }
    if (index < 0) return m
    val rows = m.toolRows.toMutableList()
    rows[index] = rows[index].copy(running = false)
    return m.copy(toolRows = rows, lastEventAt = at)
  }

  /**
   * 收到思考摘要（插件 k=think）：合并到单行思考行。
   *
   * 为什么 400ms 内的连续更新只保留最新一版：reasoning 块可能连续到达，
   * 「同一行不断替换」比逐条追加更像流式思考，也不会把行撑爆。
   */
  fun onThink(m: OverlayCardModel, text: String, at: Long): OverlayCardModel {
    val merged = if (shouldMerge(m.lastEventAt, at)) {
      mergeThinking(m.thinkingLine, text)
    } else {
      mergeThinking("", text)
    }
    return m.copy(thinkingLine = merged, lastEventAt = at)
  }

  /**
   * 收到助手可见正文（插件 k=text）：写入 headline（最新进展行）。
   *
   * 为什么正文与思考分两个字段：正文是「已经说出来的结论」，思考是过程；
   * 卡片 headline 优先展示动作/正文，思考行只在没有更强信号时兜底，
   * 这样用户不会把半成品的思考误当成最终答复。
   */
  fun onText(m: OverlayCardModel, text: String, at: Long): OverlayCardModel {
    val merged = if (shouldMerge(m.lastEventAt, at)) {
      mergeThinking(m.headline, text)
    } else {
      mergeThinking("", text)
    }
    return m.copy(headline = merged, lastEventAt = at)
  }

  /**
   * 新一轮开始：清空上一轮的累积（工具行、思考、正文、结局、待答）。
   *
   * 为什么连 pending 一起清：待答项属于上一轮的事件，上一轮已结束还挂着
   * 会让用户去回答一个已经作废的问题。
   */
  fun onTurnStart(m: OverlayCardModel, at: Long): OverlayCardModel = m.copy(
    agent = OverlayAgentState.RUNNING,
    headline = "",
    thinkingLine = "",
    toolRows = emptyList(),
    pending = emptyList(),
    turnStartedAt = at,
    lastEventAt = at,
    completionLabel = "",
    toolCount = 0,
  )

  /**
   * 一轮结束：按 kind 落结局文案，并把残留的「运行中」行收口。
   *
   * 为什么 kind 要按语言落成文案而不是存 kind：药丸/卡片的朝向在事件到达时就是定局，
   * 存 kind 再在渲染时翻译会让同一份状态在语言切换后出现两种说法。
   *
   * @param kind live 的 turn_end.kind（completed/error/blocked/aborted/max-tokens/interrupted）。
   * @param english true = 英文文案。
   */
  fun onTurnEnd(
    m: OverlayCardModel,
    kind: String,
    at: Long,
    english: Boolean,
  ): OverlayCardModel {
    val label = if (english) endLabelEn(kind) else endLabelZh(kind)
    val agent = when (kind) {
      "error" -> OverlayAgentState.ERROR
      else -> OverlayAgentState.IDLE
    }
    return m.copy(
      agent = agent,
      toolRows = m.toolRows.map { it.copy(running = false) },
      pending = emptyList(),
      completionLabel = label,
      lastEventAt = at,
    )
  }

  /**
   * 收到 agent 运行态：只切主状态，不动内容。
   *
   * 为什么 running=false 时不清工具行：结束信号与 turn_end 可能乱序，
   * 清空会让用户在卡刚出现时看到空白。内容只由 turn_start / turn_end 负责收口。
   */
  fun onAgentStatus(m: OverlayCardModel, running: Boolean, at: Long): OverlayCardModel {
    val agent = when {
      running -> OverlayAgentState.RUNNING
      m.agent == OverlayAgentState.ERROR -> OverlayAgentState.ERROR
      m.agent == OverlayAgentState.WAITING -> OverlayAgentState.WAITING
      else -> OverlayAgentState.IDLE
    }
    return m.copy(agent = agent, lastEventAt = at)
  }

  /**
   * 整体替换待答项，最多保留最新 [MAX_PENDING] 条。
   *
   * 为什么留最新而不是最旧：待答项是「现在必须回答」的东西，
   * 超出上限时旧项在页面里仍可处理，把新项丢掉则会让用户答不上刚发生的问题。
   */
  fun setPending(
    m: OverlayCardModel,
    items: List<OverlayPendingItem>,
  ): OverlayCardModel = m.copy(pending = items.takeLast(MAX_PENDING))

  /** 单独更新结局文案（例如页面回执比 turn_end 先到时的兜底）。 */
  fun setCompletionLabel(m: OverlayCardModel, label: String): OverlayCardModel =
    m.copy(completionLabel = label)

  /**
   * 合并两条单行文本：新文本优先，空白新文本不覆盖旧内容。
   *
   * 为什么新文本优先而不是拼接：卡片只有一行，拼接会很快溢出并丢掉真正最新的那句话；
   * 「空白」在事件里通常表示「本块没有可展示文本」，不应把已有内容擦掉。
   */
  fun mergeThinking(prev: String, next: String): String =
    truncateLine(if (next.isBlank()) prev else next)

  /**
   * 两次事件是否落在同一个合并窗口内。
   *
   * 用 <= 而不是 <：400ms 是「窗口长度」而不是「严格小于」，边界那次更新
   * 若判成新窗口会多触发一次重绘。时钟回退（at < prevAt）判为不合并，
   * 避免异常时间戳把窗口永久撑开。
   */
  fun shouldMerge(prevAt: Long, at: Long): Boolean =
    at >= prevAt && at - prevAt <= MERGE_WINDOW_MS

  /**
   * 推导卡片单行标题。
   *
   * 优先级：正在执行的工具 > 最新工具 > 可见正文 > 思考摘要 > 结局 > 状态文案。
   * 为什么「运行中的工具」永远第一：这一行回答的是「它现在在干什么」，
   * 已完成工具和思考都是过去式，只有正在跑的工具是进行时。
   * 注意兜底状态文案只有中文：本函数契约没有语言参数，双语药丸走 [pillOf]；
   * 卡片正文通常已由 onText 写入，这里的兜底只在空模型上出现。
   */
  fun headlineOf(m: OverlayCardModel): String {
    m.toolRows.lastOrNull { it.running }?.let { return toolLine(it) }
    m.toolRows.lastOrNull()?.let { return toolLine(it) }
    if (m.headline.isNotBlank()) return m.headline
    if (m.thinkingLine.isNotBlank()) return m.thinkingLine
    if (m.completionLabel.isNotBlank()) return m.completionLabel
    return when (m.agent) {
      OverlayAgentState.RUNNING -> "工作中"
      OverlayAgentState.WAITING -> "等待你的回答"
      OverlayAgentState.ERROR -> "引擎离线"
      OverlayAgentState.IDLE -> "空闲"
    }
  }

  /**
   * 药丸单行状态。
   *
   * 优先级 WAITING > RUNNING > ERROR > IDLE：等待用户是唯一需要用户动作的状态，
   * 被工具/正文文案盖住会让用户以为它还在自己跑；引擎离线则必须在没有轮次时也能说清。
   *
   * @param english true = 英文文案（中英成对，调用方按当前语言传入）。
   */
  fun pillOf(m: OverlayCardModel, english: Boolean): OverlayPillModel {
    if (m.pending.isNotEmpty() || m.agent == OverlayAgentState.WAITING) {
      return OverlayPillModel(
        UiText.t(english, "等待你的回答", "Waiting for your answer"),
        OverlayTone.WAITING,
      )
    }
    val runningTool = m.toolRows.lastOrNull { it.running }?.name?.takeIf { it.isNotBlank() }
    if (m.agent == OverlayAgentState.RUNNING || runningTool != null) {
      val text = if (runningTool != null) {
        UiText.t(english, "工作中：" + runningTool, "Working: " + runningTool)
      } else {
        UiText.t(english, "工作中", "Working")
      }
      return OverlayPillModel(text, OverlayTone.WORKING)
    }
    if (m.agent == OverlayAgentState.ERROR) {
      return OverlayPillModel(
        UiText.t(english, "引擎离线", "Engine offline"),
        OverlayTone.ERROR,
      )
    }
    return OverlayPillModel(UiText.t(english, "空闲", "Idle"), OverlayTone.IDLE)
  }
}
