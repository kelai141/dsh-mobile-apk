package com.dsharnessmobile.shell

/**
 * 悬浮新 UI（Phase 2 / entry_ui_v2）的**唯一数据契约**。
 *
 * 为什么把类型集中在一个文件：视图层（OverlayEntryView / OverlayCardView / OverlayPillView /
 * OverlayComposer / OverlayCommandDrawer）与未来的服务编排层之间只通过这些不可变快照
 * 通信。快照由纯逻辑层（OverlayUiModel 等，无 Android 依赖）产出，视图层只负责把快照
 * 绑到 View 上——这样「聚合逻辑」可以在 JVM 单测里断言，而视图层无需知道事件流从哪来。
 *
 * 纪律：
 *  - 本文件**不引入任何 Android 类型**，保持可被纯 JVM 单测引用；
 *  - 枚举/数据类字段语义即契约，新增字段只能追加（服务端与视图是同一进程的同一版本，
 *    但保持「只加不改」可以在分阶段合入时不打断旧调用点）；
 *  - 监听器回调全部在主线程（View 触摸与动画回调的自然线程）被调用。
 */

/** 入口形态（§9.1）：球 = 34dp 圆；细条 = 贴边 8x64dp 可视、8x88dp 窗口。 */
internal enum class OverlayEntryStyle { BALL, STRIP }

/** 药丸/状态点的语义色档（§4.1 agentState 的视图投影）。 */
internal enum class OverlayUiTone { IDLE, WORKING, WAITING, ERROR }

/**
 * 拖动阶段（视图层不自己做手势裁决，只把阶段与位移/速度交给服务）。
 *
 * 用自定义枚举而不是直接回传 MotionEvent：视图层不该把 Android 事件对象泄漏给服务，
 * 服务只需要「阶段 + 位移 + 速度」这三样就能做阈值判定（阈值本身在纯逻辑层）。
 */
internal enum class OverlayDragPhase { DOWN, MOVE, UP, CANCEL }

/** 工具行状态（§4.3：tool_call 先占位 RUNNING，tool_result 就地改 DONE/FAILED）。 */
internal enum class OverlayToolRowState { DONE, RUNNING, FAILED }

/**
 * 卡片里的一行工具调用。
 *
 * @param id 稳定标识（服务侧用 callId/序号生成）；视图层用它做「同一行原地更新」的键，
 *   不重新创建 View 是 §7.7「文本原地更新」的硬要求。
 * @param title 工具名或标题，单行显示。
 * @param detail 参数摘要/结果摘要，单行显示，可为空串。
 * @param state 决定状态点颜色与是否呼吸。
 */
internal data class OverlayToolRowItem(
  val id: String,
  val title: String,
  val detail: String,
  val state: OverlayToolRowState,
)

/**
 * 卡片待答区的一项。
 *
 * @param eventId 应答时要回填的事件标识（approval/question 都有）。
 * @param kind 固定只有 "approval" 与 "question" 两种：前者渲染允许/拒绝，后者只渲染回答。
 *   用 String 而不是枚举是为了与 mux 事件的现有字符串口径逐字对齐，避免多一层映射。
 * @param label 展示文案（例如工具名或问题摘要）。
 */
internal data class OverlayPendingAction(
  val eventId: String,
  val kind: String,
  val label: String,
)

/**
 * 顶部事件卡片的渲染快照（§3.1 W3）。
 *
 * @param stateLabel 状态行主文案（空闲/正在思考/等待审批…）。
 * @param thinkingLine 单行思考摘要（空串表示没有，视图层隐藏该行）。
 * @param toolCount 状态行右侧的「xN」数字（0 时不显示）。
 * @param rows 工具行；视图层最多渲染 [OVERLAY_CARD_MAX_ROWS] 行，超出按「保留最新」截断。
 * @param footerLine 底部说明行（空串隐藏）。
 * @param pending 待答项；视图层按 kind 渲染按钮。
 * @param running 是否处于运行态，决定状态点/呼吸动画是否允许。
 */
internal data class OverlayCardData(
  val stateLabel: String,
  val thinkingLine: String,
  val toolCount: Int,
  val rows: List<OverlayToolRowItem>,
  val footerLine: String,
  val pending: List<OverlayPendingAction>,
  val running: Boolean,
)

/**
 * 抽屉列表的一条条目（真源是页面宿主 API，Kotlin 侧不得硬编码命令表，§11.2）。
 *
 * 同一结构被服务侧复用于「命令列表 / 会话列表 / 工作区列表」三种数据源（抽屉区域复用）：
 * 视图层不得假设条目一定是命令，也不得写死任何标题文案。
 *
 * @param name 选择时回传的原始标识（命令名或会话 id，服务侧自行分流）。
 * @param label 展示名（可为空，空则用 name）。
 * @param description 描述，11sp 次文字，可为空。
 */
internal data class OverlayCommandItem(
  val name: String,
  val label: String,
  val description: String,
)

/**
 * 输入区的附件 chip。
 *
 * @param kind 固定 "image" 或 "file"：决定是否保留图片扩展名展示，不做富预览（§8.3）。
 */
internal data class OverlayAttachmentChip(val name: String, val kind: String)

/**
 * 底部输入区的渲染快照（§3.1 W5 / §8.1）。
 *
 * @param workspaceLabel 工作区药丸文案（空串时视图层回退到「工作区」）。
 * @param sessionLabel 会话药丸文案（同上）。
 * @param pendingHint 待答提示行（「正在回答：…」），空串隐藏。
 * @param busy 是否正在跑一轮：决定发送按钮显示「停止」。
 * @param sendEnabled 发送按钮是否可点（空草稿/无可用会话时为 false）。
 */
internal data class OverlayComposerData(
  val workspaceLabel: String,
  val sessionLabel: String,
  val attachments: List<OverlayAttachmentChip>,
  val commands: List<OverlayCommandItem>,
  val pendingHint: String,
  val busy: Boolean,
  val sendEnabled: Boolean,
)

/**
 * 卡片窗回调（服务侧实现）。
 *
 * 所有回调都必须在主线程被调用；视图层不持有服务引用，只持有这个接口，便于单测替身。
 *
 * 拖动位移语义（全 UI 统一）：dxPx/dyPx 都是**相对 ACTION_DOWN 的累计位移**，不是相邻
 * 两帧增量——服务侧用「窗口起点位置 + 累计位移」即可定位窗口，不必自己累加（累加会在
 * 丢帧/事件合并时漂移）。速度取 VelocityTracker 当前主方向的 px/s（向下/向右为正）。
 */
internal interface OverlayCardListener {
  /** 点右上角关闭按钮：只收卡片窗，不动 Agent（§4.2）。 */
  fun onCardCollapse()

  /**
   * 点头部「隐藏」文字按钮：把悬浮入口收进屏缘召回条（隐藏态），**不是**关闭卡片。
   *
   * 为什么与 [onCardCollapse] 分开：收起卡片后球还在屏上（点球就回来），隐藏态则只剩
   * 召回条一条回路（OverlayRecall）。两个动作的撤销成本不同，不能共用一个入口。
   */
  fun onCardHideEntry()

  /**
   * 白条把手拖动。dyPx 是**自 DOWN 起的累计位移**（向下为正），UP/CANCEL 时 velocityPxPerS
   * 为把手方向的瞬时速度（VelocityTracker 口径，像素/秒，向下为正）；其余阶段速度为 0。
   */
  fun onCardHandleDrag(phase: OverlayDragPhase, dyPx: Float, velocityPxPerS: Float)

  /**
   * 待答项按钮。approve=true 表示「允许/回答」，false 表示「拒绝」；kind=="question" 时
   * 视图层固定传 true（问题没有拒绝语义，真正的答复文本走输入区）。
   */
  fun onCardPendingAction(eventId: String, kind: String, approve: Boolean)
}

/**
 * 药丸窗回调（服务侧实现）。拖动阶段语义同 [OverlayCardListener.onCardHandleDrag]，
 * 只是多一个 dxPx（药丸可自由拖动，横向也要上报）；消散阈值由服务用
 * OverlayWindowFrames.pillDismissReached 判定，本视图不决定。
 */
internal interface OverlayPillListener {
  fun onPillTap()

  fun onPillDrag(phase: OverlayDragPhase, dxPx: Float, dyPx: Float, velocityPxPerS: Float)
}

/**
 * 输入区回调（服务侧实现）。
 *
 * onComposerLayoutChanged 用于「视图自身高度变了」的场合（抽屉展开/收起、附件条增删、
 * 输入框行数变化），服务据此重算窗口高度；它**不**表示内容数据变化。
 */
internal interface OverlayComposerListener {
  fun onComposerSend(text: String)

  fun onComposerStop()

  /** kind 固定 "camera" / "photo" / "file"。 */
  fun onComposerAttach(kind: String)

  fun onComposerRemoveAttachment(index: Int)

  fun onComposerWorkspaceChip()

  fun onComposerSessionChip()

  /**
   * 用户点了抽屉列表的一条条目；line 就是 [OverlayCommandItem.name]（命令名或会话 id）。
   * 服务侧按当前数据源自行分流，视图层不做任何猜测。
   */
  fun onComposerCommand(line: String)

  fun onComposerLayoutChanged()
}

// ── 视图层共享纯函数（无 Android 依赖，JVM 可测）──────────────────────────────

/** 卡片工具行的渲染上限（§4.3 环形缓冲上限 50）。超出的旧行直接丢弃，不在视图里留空壳。 */
internal const val OVERLAY_CARD_MAX_ROWS = 50

/**
 * 把多行文本压成单行：换行/制表/连续空白折叠成一个空格并去首尾。
 *
 * 为什么需要：思考行与药丸都是 maxLines=1 + ellipsize=END。若不先折叠，文本里的换行会被
 * TextView 在单行模式下静默丢弃并拼成无空格的一长串（「第一行第二行」），看起来像 bug。
 */
internal fun overlaySingleLine(text: String): String {
  if (text.isEmpty()) return ""
  val sb = StringBuilder(text.length)
  var pendingSpace = false
  for (ch in text) {
    if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') {
      pendingSpace = sb.isNotEmpty()
      continue
    }
    if (pendingSpace) {
      sb.append(' ')
      pendingSpace = false
    }
    sb.append(ch)
  }
  return sb.toString()
}

/**
 * 工具行增量更新计划（纯函数）。
 *
 * 目标：render() 幂等，且**行数不变时绝不重建 View**（§7.7 文本原地更新）。计划把
 * 「上一帧 N 行 → 这一帧 M 行」拆成三段：
 *  - update：前 min(N, M, cap) 行原地更新文本/状态色；
 *  - remove：要收掉的尾部行数；
 *  - add：要追加的新行数。
 *
 * 注意语义：视图层**只追增删尾部**，中间行按索引原地改绑（因为数据源是「最新在尾部」的
 * 追加模型）。若未来出现乱序，本函数不再正确，调用方必须先排序。
 *
 * @param previousCount 上一帧视图里已有的行数。
 * @param nextCount 这一帧数据里的行数（可超过 cap，按 cap 截断）。
 * @param cap 上限（默认 [OVERLAY_CARD_MAX_ROWS]）。
 */
internal fun overlayRowMergePlan(
  previousCount: Int,
  nextCount: Int,
  cap: Int = OVERLAY_CARD_MAX_ROWS,
): OverlayRowMergePlan {
  val target = nextCount.coerceIn(0, cap)
  val previous = previousCount.coerceIn(0, cap)
  val update = minOf(previous, target)
  return OverlayRowMergePlan(
    updateCount = update,
    addCount = target - update,
    removeCount = previous - update,
  )
}

/** [overlayRowMergePlan] 的结果；三段互斥，视图层按 update → remove → add 顺序执行。 */
internal data class OverlayRowMergePlan(
  val updateCount: Int,
  val addCount: Int,
  val removeCount: Int,
)
