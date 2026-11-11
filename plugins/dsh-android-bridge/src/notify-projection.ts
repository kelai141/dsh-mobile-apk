/**
 * 通知信道投影（0.14.0-preview §6.2/§6.5）——引擎侧事件 → `.notify.ndjson` 的**纯逻辑**。
 *
 * 为什么单独成文件：D13/D14 两个既存误读（`turn/end` 的 reason 被当成 outcome、
 * 会话标题读不存在的 `session.header.title`）之所以能活到现在，是因为判定逻辑埋在
 * 事件监听闭包里、只能靠设备观测。抽成纯函数后每种 `reason.kind` 都有 fixture 回归
 * （`test/notify-projection.test.mjs`），撤掉修复即变红。
 *
 * 上游事实（逐字核实）：
 *  - `turn/end` 载荷 = `{turn, reason: TurnEndReason}`，`reason.kind` 是闭集
 *    completed | aborted | blocked | error | max-tokens | interrupted
 *    （dsh/packages/core/session/src/types.ts:200-221、:285）。
 *  - `SessionHeader` **没有 title 字段**（同上 :93-130）；标题唯一正确来源是
 *    `session/title` 事件的 `{title, messageSeqs, source}`（session-title/src/types.ts:41-48）。
 *  - `todo/write` 载荷是整表覆盖 `{todos:[{content,status}]}`，「完成 N/M」**不在事件里**，
 *    消费方自己数（todo/tool-todo/src/types.ts:21-31）。
 *  - `deliverables/presented` = `{turn, callId, files:[{path,description?}]}`。
 */

/** `turn/end` 的 reason.kind 闭集（上游 TurnEndReasonMap 的键）。 */
export type TurnEndKind = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'

/** 六种 kind 的权威清单（门禁用例按它逐条覆盖）。 */
export const TURN_END_KINDS: readonly TurnEndKind[] = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
]

/** 未知/缺字段时的占位（merge-extensible 联合的兜底分支）。 */
export type TurnEndKindOrUnknown = TurnEndKind | 'unknown'

/** 读取 `reason.kind`；非对象/未知字符串一律 `unknown`（不得当成成功）。 */
export function turnEndKind(reason: unknown): TurnEndKindOrUnknown {
  if (reason === null || typeof reason !== 'object') return 'unknown'
  const kind = (reason as { kind?: unknown }).kind
  return typeof kind === 'string' && (TURN_END_KINDS as readonly string[]).includes(kind)
    ? (kind as TurnEndKind)
    : 'unknown'
}

/**
 * D13 修复点：只有 `reason.kind === 'completed'` 才算成功。
 * 现状误读 `reason.outcome === 'success'`（该字段根本不存在）→ `.live.ndjson` 的
 * `turn_end.ok` 恒 false。
 */
export function turnEndOk(reason: unknown): boolean {
  return turnEndKind(reason) === 'completed'
}

/** 工作汇报结果文案（弹窗类的标题后缀与正文首行）。 */
export function reportOutcomeLabel(kind: TurnEndKindOrUnknown): string {
  switch (kind) {
    case 'completed':
      return '已完成'
    case 'error':
      return '失败'
    case 'blocked':
      return '被阻塞'
    case 'aborted':
      return '已中止'
    case 'max-tokens':
      return '输出超限'
    case 'interrupted':
      return '被中断（进程重启）'
    default:
      return '结果未知'
  }
}

/**
 * 是否允许弹窗。
 *
 * 静默（return false）——「不是用户要的结果」且**不需要用户当场处理**的两类：
 *  - `aborted`：NT-05，用户自己按停，弹窗是噪声；
 *  - `interrupted`：0.14.2 D15-B 裁定。reason.kind=interrupted 的文案是「被中断（进程重启）」，
 *    它由**引擎崩溃/自动重启**产生，不是用户动作的结果。自动重启风暴下每轮 turn/end 都产一条
 *    report 通知 ⇒ 每轮 heads-up 一次，用户看到的就是「频繁弹窗」，而弹窗里没有任何可操作内容。
 *    注意：本函数只决定 **popup（heads-up）**，不决定投递——report 条目照常产出、照常进通知栏
 *    （见 :364 的 popup 字段与壳侧 NotifyCenter.formDecision 的降级分支），所以「任务被中断」
 *    这条事实仍然可见，只是不再打断用户。
 *
 * 弹窗（return true）——其余四种 completed / error / blocked / max-tokens：这些要么是用户
 * 主动发起的任务有了结果，要么是需要用户知道并可能处理的终态。
 *
 * default（未知 kind）保持 return true：上游新增 kind 时必须可见（否则用户永远收不到
 * 「任务结束了」），由调用方同时记日志。
 */
export function shouldPopupReport(kind: TurnEndKindOrUnknown): boolean {
  switch (kind) {
    case 'completed':
    case 'error':
    case 'blocked':
    case 'max-tokens':
      return true
    case 'aborted':
    case 'interrupted':
      // 同组理由：都不是「用户要的结果」，且都不需要用户当场处理（详见上方文档注释）。
      return false
    default:
      // 未知 kind 也必须可见（否则上游新增 kind 时用户永远收不到「任务结束了」），
      // 由调用方同时记日志。
      return true
  }
}

/** 会话标识短哈希（D14 的回退标识：不要再用字面量「任务完成」）。 */
export function sessionTag(sessionId: unknown): string {
  const s = String(sessionId ?? '')
  if (s === '') return '未知会话'
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * 从 `assistant/message` 的 content 块数组里取**可见正文**（0.14.1 设备缺陷修复）。
 *
 * 缺陷本体：上游 `TextBlock { type:'text'; text }` 与 `ReasoningBlock { type:'reasoning'; text }`
 * **共用 `text` 字段名**（dsh/packages/llm/llm/src/types.ts:54-64）。投影层此前写的是
 * `content.map(c => c.text ?? '').join('')`——**按字段取值而不按类型过滤**，于是思考块被当成回答。
 * 思考块在一条 assistant message 里通常排在最前，再经 `summarize(text, 120)` 硬截断，
 * 用户在上拉汇报栏看到的正是「某一段思考内容」的开头。同一条 summary 还是通知展开正文与
 * `.live.ndjson` 的 `sum` 来源，故修在这一处即可三处同好。
 *
 * 判据来源：上游 `agent.ts:486` 用 `message.content.filter(block => block.type === 'tool-call')`
 * 判别块类型，证明运行期 content 项**带 `type` 字段**。
 *
 * **兼容分支（刻意保留）**：仅当整条消息**没有任何块带 `type`**（未知 provider 的旧形状）时，
 * 才退化为「取全部 `text`」。没有这条兜底，一次 provider 形状差异就会把缺陷从
 * 「显示思考」直接劣化成「什么都不显示」——那不是修复，是把可见的错误换成不可见的错误。
 */
export function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const blocks = content.filter(
    (b): b is { type?: unknown; text?: unknown } => b !== null && typeof b === 'object',
  )
  const typed = blocks.filter((b) => typeof b.type === 'string')
  const picked = typed.length > 0 ? typed.filter((b) => b.type === 'text') : blocks
  return picked.map((b) => (typeof b.text === 'string' ? b.text : '')).join('').trim()
}

/** 摘要压缩（单行、去空白、硬截断；上限默认 120 字＝§6.1.1 的汇报摘要口径）。 */
export function summarize(text: unknown, max = 120): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s === '') return ''
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * 从 `assistant/message` 的 content 块数组里取**思考文本**（0.14.1 之后新需求：卡片思考行）。
 *
 * 为什么必须按类型过滤而不是按字段取值：上游 `TextBlock { type:'text'; text }` 与
 * `ReasoningBlock { type:'reasoning'; text }` **共用 `text` 字段名**
 * （dsh/packages/llm/llm/src/types.ts:54-64，判据来源同 [visibleText]）。
 * 若按 `text` 取值，回答块会被当成思考；若不过滤 type，思考会被当成回答 —— 两个方向都错。
 *
 * 一块消息里可能有多段 reasoning；取**最后一个非空块**作为「最新一版」（同轮内思考是叠加演进的，
 * 用户想看的是当前这一版）。没有任何带 type 的块时返回空串 —— 未知 provider 形状下
 * **不猜**哪一段是思考（[visibleText] 的兼容分支只用于「宁可显示正文也不要什么都不显示」，
 * 思考行不需要这种兜底：猜错的思考行比没有更糟）。
 */
export function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const blocks = content.filter(
    (b): b is { type?: unknown; text?: unknown } => b !== null && typeof b === 'object',
  )
  const typed = blocks.filter((b) => typeof b.type === 'string')
  for (let i = typed.length - 1; i >= 0; i -= 1) {
    const block = typed[i]
    if (block.type !== 'reasoning') continue
    const text = typeof block.text === 'string' ? block.text.trim() : ''
    if (text !== '') return text
  }
  return ''
}

/**
 * 思考行摘要：**首行** + 单行压缩 + 硬截断（默认 120 字，与设计 §5.3 的 `thinkingLine` 同口径）。
 *
 * 为什么先取首行再压缩：思考正文里通常有多段；卡片只显示单行，取「第一行的开头」才能让
 * 用户看出这一版思路的起点。反过来先压成一行再取前面 120 字，会把第二段的内容混进来，
 * 变成一句读不通的拼接。截断走仓内既有 [summarize]（截断必带省略号），不另造一套。
 */
export function reasoningSummary(content: unknown, max = 120): string {
  const text = reasoningText(content)
  if (text === '') return ''
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  return summarize(firstLine, max)
}

/**
 * 汇报正文（可滚动区）的上限：8 KiB。
 *
 * 为什么需要正文而不只是摘要（0.14.1 D6，设备实报「长按查看详情…无法滚动查看输出」）：
 * 报告栏此前只有 120 字摘要，而摘要经单行化 + 硬截断后**恒不超高**——「栏内可滚动」这条验收
 * 判据在 120 字上限下恒真而无意义（内容从来不会超标），于是「读不到完整输出」从设计上即不可达。
 * 换句话说：不是滚动坏了，是**没有可滚的内容**。
 *
 * 有界是必须的：`.notify.ndjson` 的轮转上限是 512 KiB（壳侧 NOTIFY_MAX），单轮无界落盘会让
 * 几十轮就把信道撑爆、把历史汇报挤掉。8 KiB 对「一轮的最终答复」足够，超出部分显式截断。
 */
export const REPORT_BODY_MAX = 8 * 1024

/** 正文截断标记。有界截断**必须显式**——不得让用户把截断处当成全文结尾。 */
export const REPORT_BODY_TRUNCATED = '\n…（正文过长，此处截断）'

/** 正文（有界、保留换行）。空文本返回空串。 */
export function boundReportBody(text: unknown, max = REPORT_BODY_MAX): string {
  const s = String(text ?? '').trim()
  if (s === '') return ''
  return s.length <= max ? s : s.slice(0, max) + REPORT_BODY_TRUNCATED
}

/** 用时文案（毫秒 → 「1m23s」/「8.4s」）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return ms + 'ms'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return (ms / 1000).toFixed(1) + 's'
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m + 'm' + s + 's'
}

/** 待办进度：自己数 n/N 与当前项（事件载荷不含完成数，见文件头）。 */
export interface TodoProgress {
  done: number
  total: number
  current: string
}

/** `todo/write` 整表 → 进度（in_progress 优先作「当前」，否则取第一条未完成）。 */
export function todoProgress(todos: unknown): TodoProgress {
  const list = Array.isArray(todos) ? todos : []
  let done = 0
  let current = ''
  for (const raw of list) {
    const item = (raw ?? {}) as { content?: unknown; status?: unknown }
    const status = String(item.status ?? '')
    if (status === 'completed') done += 1
    else if (current === '' && status === 'in_progress') current = String(item.content ?? '')
  }
  if (current === '') {
    for (const raw of list) {
      const item = (raw ?? {}) as { content?: unknown; status?: unknown }
      if (String(item.status ?? '') !== 'completed') {
        current = String(item.content ?? '')
        break
      }
    }
  }
  return { done, total: list.length, current: summarize(current, 40) }
}

/** 一条待办通知的载荷（写盘前形态；壳侧只做投影不做判定）。 */
export interface TodoEntry {
  done: number
  total: number
  current: string
  sessionId: string
  title: string
}

/**
 * 待办降频（R6/NT-06）：同一会话 ≥1s 才允许再次投递，且进度签名不变时不投递。
 * 返回 true = 允许投递。调用方持有状态：本函数不产生副作用。
 */
export function shouldEmitTodo(
  previousAt: number,
  previousSignature: string,
  signature: string,
  now: number,
  minIntervalMs = 1000,
): boolean {
  if (signature === previousSignature && previousAt > 0) return false
  return now - previousAt >= minIntervalMs
}

/** 工作汇报载荷（`kind:"report"` 的字段子集；标题来源 = session/title，非 session.header.title）。 */
export interface ReportEntry {
  outcome: TurnEndKindOrUnknown
  outcomeLabel: string
  sessionId: string
  title: string
  /** 单行摘要（通知展开正文 / 悬浮窗工具行 chip 的口径，120 字上限）。 */
  summary: string
  /** 该轮可见正文全文（有界 8 KiB，保留换行）；报告栏可滚动区的内容来源。空 = 该轮没有可见正文。 */
  body: string
  durationMs: number
  toolCount: number
  turn: number
  presentedFiles: string[]
  popup: boolean
}

/** `endTurn` 的入参（全部来自事件载荷，便于 fixture 回放）。 */
export interface EndTurnInput {
  sessionId: unknown
  turn: unknown
  reason: unknown
  now: number
}

/**
 * 会话级投影状态：标题（D14）、轮次起点与工具计数（用时/工具数）、
 * 最近摘要与产出文件（工作汇报正文）。**纯状态机**，不含 IO。
 */
export class SessionNotifyState {
  private readonly titles = new Map<string, string>()
  private readonly turnStart = new Map<string, number>()
  private readonly turnTools = new Map<string, number>()
  private readonly summaries = new Map<string, string>()
  private readonly bodies = new Map<string, string>()
  private readonly presented = new Map<string, string[]>()
  private readonly todoAt = new Map<string, number>()
  private readonly todoSig = new Map<string, string>()

  /** `session/title` → 标题表（D14 的唯一正确来源）。 */
  setTitle(sessionId: unknown, title: unknown): void {
    const id = String(sessionId ?? '')
    const t = String(title ?? '').trim()
    if (id === '' || t === '') return
    this.titles.set(id, t)
  }

  /** 通知标题：标题表 → 会话短哈希（**不再回落字面量「任务完成」**）。 */
  titleFor(sessionId: unknown): string {
    const id = String(sessionId ?? '')
    const t = this.titles.get(id)
    return t && t.trim() !== '' ? t : '会话 ' + sessionTag(id)
  }

  /** `turn/start`：记起点并清零本轮工具计数。 */
  startTurn(sessionId: unknown, turn: unknown, now: number): void {
    const id = String(sessionId ?? '')
    if (id === '') return
    this.turnStart.set(id, now)
    this.turnTools.set(id, 0)
    this.summaries.delete(id)
    this.bodies.delete(id)
    this.presented.delete(id)
    void turn
  }

  /** `tool/call`：本轮工具数 +1。 */
  countToolCall(sessionId: unknown): void {
    const id = String(sessionId ?? '')
    if (id === '') return
    this.turnTools.set(id, (this.turnTools.get(id) ?? 0) + 1)
  }

  /**
   * `assistant/message`：本轮最后一段文本。
   *
   * 同时记两份口径：`summary`（单行 120 字，通知展开正文与工具行 chip 用）与
   * `body`（有界 8 KiB、保留换行，报告栏可滚动区用）。二者同源但用途不同——
   * 报告栏此前只拿得到 summary，于是「可滚动」是空的（见 [REPORT_BODY_MAX]）。
   */
  setSummary(sessionId: unknown, text: unknown): void {
    const id = String(sessionId ?? '')
    const s = summarize(text)
    if (id === '' || s === '') return
    this.summaries.set(id, s)
    this.bodies.set(id, boundReportBody(text))
  }

  /** `deliverables/presented`：产出文件名（只留 basename，避免锁屏泄露绝对路径）。 */
  setPresented(sessionId: unknown, files: unknown): void {
    const id = String(sessionId ?? '')
    if (id === '' || !Array.isArray(files)) return
    const names: string[] = []
    for (const raw of files) {
      const p = String((raw as { path?: unknown })?.path ?? '')
      if (p === '') continue
      const base = p.split(/[\\/]/).pop() ?? p
      if (base !== '') names.push(base)
    }
    if (names.length > 0) this.presented.set(id, names.slice(0, 8))
  }

  /**
   * 待办降频判定并记账（`todo/write` 路径调用）。
   * 返回 true = 本次允许投递；同时刷新节流时间与签名。
   */
  acceptTodo(sessionId: unknown, progress: TodoProgress, now: number, minIntervalMs = 1000): boolean {
    const id = String(sessionId ?? '')
    if (id === '') return false
    const signature = progress.done + '/' + progress.total + '/' + progress.current
    const prevAt = this.todoAt.get(id) ?? 0
    const prevSig = this.todoSig.get(id) ?? ''
    if (!shouldEmitTodo(prevAt, prevSig, signature, now, minIntervalMs)) return false
    this.todoAt.set(id, now)
    this.todoSig.set(id, signature)
    return true
  }

  /** `turn/end` → 汇报载荷（D13 的成败判定在这条路径上生效）。 */
  endTurn(input: EndTurnInput): ReportEntry {
    const id = String(input.sessionId ?? '')
    const kind = turnEndKind(input.reason)
    const start = this.turnStart.get(id) ?? 0
    const durationMs = start > 0 && input.now >= start ? input.now - start : 0
    const entry: ReportEntry = {
      outcome: kind,
      outcomeLabel: reportOutcomeLabel(kind),
      sessionId: id,
      title: this.titleFor(id),
      summary: this.summaries.get(id) ?? '',
      body: this.bodies.get(id) ?? '',
      durationMs,
      toolCount: this.turnTools.get(id) ?? 0,
      turn: Number(input.turn ?? 0) || 0,
      presentedFiles: this.presented.get(id) ?? [],
      popup: shouldPopupReport(kind),
    }
    this.turnStart.delete(id)
    this.turnTools.delete(id)
    return entry
  }

  /** 标题表只读快照（诊断/测试）。 */
  titlesSnapshot(): ReadonlyMap<string, string> {
    return this.titles
  }
}
