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
 * 工具行的单行摘要（参考样式：图标 + 操作名 + 关键参数，全部压在一行内）。
 *
 * 为什么单独抽成纯函数：卡片默认折叠工具行，折叠态只能显示这一行文本，所以「取哪个参数当摘要」
 * 是产品语义，必须在 JVM 单测里可断言，不能散落在 View 代码里。纪律：
 *  - 只取命令行/路径这类最有辨识度的参数，绝不拼接整段 JSON；
 *  - 摘要长度有界，超出按字符截断并加省略号，避免一行吃掉整块卡片；
 *  - 不解释结果内容，也不猜测成功与否（状态另有 state 字段）。
 */
internal object OverlayToolSummary {
  const val MAX_SUMMARY_CHARS = 72

  private val keys = listOf(
    "command", "cmd", "file_path", "path", "filePath", "file", "pattern", "query", "url", "name", "prompt",
  )
  private val pathKeys = setOf("file_path", "path", "filePath", "file")

  /** 从已经字符串化的参数投影中取一个可读要点；找不到就返回空串（调用方只显示工具名）。 */
  fun hint(arguments: String): String {
    if (arguments.isBlank()) return ""
    val flat = arguments.replace('\n', ' ').replace('\r', ' ').trim()
    for (key in keys) {
      val marker = "\"" + key + "\""
      val at = flat.indexOf(marker)
      if (at < 0) continue
      val colon = flat.indexOf(':', at + marker.length)
      if (colon < 0) continue
      val value = flat.substring(colon + 1).trimStart().removePrefix("\"").trimStart()
      if (value.isEmpty()) continue
      val stop = value.indexOfFirst { it == '\"' || it == ',' || it == '}' }
      val text = (if (stop >= 0) value.substring(0, stop) else value).trim()
      if (text.isNotEmpty()) return bound(if (key in pathKeys) shortPath(text) else text)
    }
    // No known key: show the raw projection head so the row still says something true.
    return bound(flat)
  }

  /**
   * Paths are shown by their tail, never by the whole absolute path.
   *
   * Why: an Android app-private path is ~70 characters of constant noise
   * (/data/data/<pkg>/files/home/...) that pushes the meaningful file name off a one-line row.
   * Keeping the last two segments preserves identity ("workspaces/incoming/demo-report.md").
   */
  private fun shortPath(full: String): String {
    val parts = full.split('/').filter { it.isNotEmpty() }
    if (parts.size <= 2) return full
    return parts.takeLast(2).joinToString("/")
  }

  private fun bound(text: String): String {
    val single = text.replace(Regex("\\s+"), " ").trim()
    return if (single.length <= MAX_SUMMARY_CHARS) single else single.take(MAX_SUMMARY_CHARS - 1).trimEnd() + "…"
  }
}

/**
 * 公开会话记录的有界投影。user/assistant 的 text 为真实多行正文；tool 的 text 必须为空，
 * 参数与结果单列且只作为字面量展示，不能伪装成助手正文。state 缺失表示未知，不能猜已完成。
 * truncated 表示本行字段或其前方历史被预算截断；稳定 id 从公开消息/turn/step/callId 派生。
 */
internal data class OverlayTranscriptRow(
  val id: String,
  val role: String,
  val text: String,
  val toolName: String = "",
  val arguments: String = "",
  val result: String = "",
  val state: OverlayToolRowState? = null,
  val truncated: Boolean = false,
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
 * @param transcript 当前会话真实用户/助手正文与工具调用；空闲也保留，不由 running 决定清空。
 */
internal data class OverlayCardData(
  val stateLabel: String,
  val thinkingLine: String,
  val toolCount: Int,
  val rows: List<OverlayToolRowItem>,
  val footerLine: String,
  val pending: List<OverlayPendingAction>,
  val running: Boolean,
  val transcript: List<OverlayTranscriptRow> = emptyList(),
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
 * @param kind 固定 "image" 或 "file"；图片携带页面有界JPEG缩略图，不传原始附件字节。
 */
internal data class OverlayAttachmentChip(val name: String, val kind: String, val id: String = "", val thumbnail: String = "")

/** 仅接收页面投影的48KiB以内JPEG缩略图；拒绝URL/原图/SVG及畸形base64。 */
internal fun overlayThumbnailData(data: String): String =
  if (data.length in 24..49152 && data.startsWith("data:image/jpeg;base64,") &&
    data.substringAfter(",").all { it.isLetterOrDigit() && it.code < 128 || it == '+' || it == '/' || it == '=' }) data else ""

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
  val answeringQuestion: Boolean = false,
)

/**
 * 卡片窗回调（服务侧实现）。
 *
 * 所有回调都必须在主线程被调用；视图层不持有服务引用，只持有这个接口，便于单测替身。
 *
 * 拖动位移语义（全 UI 统一）：dxPx/dyPx 都是**相对 ACTION_DOWN 的累计位移**，不是相邻
 * 两帧增量——服务侧用「窗口起点位置 + 累计位移」即可定位窗口，不必自己累加（累加会在
 * 丢帧/事件合并时漂移）。速度固定取 VelocityTracker 的 y 分量 px/s（向下为正）。
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

  /** 在卡片内切换球/侧边条，偏好回调只重建入口，保留输入草稿和事件模型。 */
  fun onCardEntryStyle() = Unit

  /**
   * 白条把手拖动。dyPx 是**自 DOWN 起的累计位移**（向下为正），UP 时 velocityPxPerS
   * 为 y 方向的瞬时速度（VelocityTracker 口径，像素/秒，向下为正）；其余阶段速度为 0。
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
 * 只是多一个 dxPx（药丸可自由拖动，横向也要上报），速度仍固定为 y 分量。
 * DOWN 必须在所有 MOVE/UP 之前上报（即使最后是点击），让服务记录本次手势的窗口起点；
 * UP 使用抬手当帧的累计位移，CANCEL 只终止手势、不消散。消散阈值由服务用
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

  fun onComposerCancelAnswer() {}

  fun onComposerFullQuestionForm() {}

  /** 返回键：编排层先收抽屉，再收输入窗；不发送、不停止后台任务。 */
  fun onComposerBack()

  /** 「＋」只请求编排层切换抽屉；命令/会话/工作区模式由编排层唯一持有。 */
  fun onComposerToggleDrawer()

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

/** 页面与原生同时约束行数/正文和UTF-8 JSON总预算；多行不降成思考摘要。 */
internal const val OVERLAY_TRANSCRIPT_MAX_ROWS = 40

internal data class OverlayTranscriptMergePlan(
  val rows: List<OverlayTranscriptRow>,
  val removedIds: Set<String>,
  val changedIds: Set<String>,
)

/** 最后出现的同 id 为最新快照；未知角色不冒充助手，保留正文的所有空白与换行。 */
internal fun overlayTranscriptMergePlan(
  previous: List<OverlayTranscriptRow>, next: List<OverlayTranscriptRow>,
): OverlayTranscriptMergePlan {
  val byId = LinkedHashMap<String, OverlayTranscriptRow>()
  for (row in next) {
    if (row.id.isBlank() || row.role !in setOf("user", "assistant", "tool")) continue
    if (row.role == "tool" && row.toolName.isBlank()) continue
    byId.remove(row.id)
    byId[row.id] = row
  }
  val rows = byId.values.toList().takeLast(OVERLAY_TRANSCRIPT_MAX_ROWS)
  val old = previous.associateBy { it.id }
  val ids = rows.map { it.id }.toSet()
  return OverlayTranscriptMergePlan(
    rows, old.keys - ids, rows.filter { old[it.id] != it }.map { it.id }.toSet(),
  )
}

/** 仅原先贴底且没有触摸中的用户才跟随；向上读历史时绝不因流更新强制跳到底。 */
internal fun overlayTranscriptShouldFollow(
  scrollY: Int, viewportHeight: Int, contentHeight: Int, touching: Boolean, tolerancePx: Int,
): Boolean = !touching && (viewportHeight <= 0 || contentHeight - (scrollY + viewportHeight) <= tolerancePx.coerceAtLeast(0))

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
