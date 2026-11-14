/**
 * 页面侧宿主 API `window.__dshOverlayHost`（版本 1）。
 *
 * 为什么需要它：原生悬浮层（卡片/药丸/输入区/命令抽屉）不能自己查页面状态——
 * 会话身份、工作区、草稿、附件、命令清单的真源都在 Web 页面里。设计 §6.2 N3 的裁定是
 * **新增一个只读/受控的页面 API**（而不是扩多个 JS→Kotlin 桥方法）：桥面对面扩展要走
 * `check-bridge-symmetry` 与桥协议文档，而页面 API 只是 `evaluateJavascript` 的求值目标。
 *
 * 契约（原生侧按此写死，改动需同步壳侧）：
 *   - 所有方法**同步返回 JSON 字符串**（`JSON.stringify` 的结果），方便
 *     `evaluateJavascript` 直接解码；
 *   - 页面未就绪/内部异常时也必须返回合法 JSON（`{"ok":false,"error":"..."}`），
 *     **绝不抛异常**——抛出去会让 evaluateJavascript 拿到空值，原生分不清「失败」与「没接线」。
 *
 * 数据来源全部是页面既有真源，不猜：
 *   - `sessionId`：`<html data-dsh-session-id>`（session-marker.ts 维护的既有标记）；
 *   - `sessionTitle` / `busy` / `sessions()`：会话列表快照（ui-api-session-controller）；
 *   - `workspace*`：工作区控制器快照（`ctx.workspaces`），当前工作区按「该工作区的
 *     sessionIds 含当前会话」判定；不含则返回空串，**不猜**；
 *   - `draft` / `attachments` / `send` / `execute` / `removeAttachment`：会话输入机
 *     （`ctx.conversation.input`，页面自己的 composer 提交路径，因此草稿里的附件能一起发）；
 *   - `commands()`：composer-commands.ts 的公共读取函数（与「+」菜单同一份口径）。
 */

import { ATTACHMENT_ROW_TITLES, type ComposerMenuCommand } from './composer-commands.ts'
import { keepDraftReference } from './incoming-runtime.ts'
import { SESSION_ID_ATTRIBUTE } from './session-marker.ts'

/** 全局对象名（壳侧 evaluateJavascript 求值的目标，改了就两端一起改）。 */
export const OVERLAY_HOST_GLOBAL = '__dshOverlayHost'

/** 宿主 API 版本：新增/改变方法语义时递增，原生据此判断能力。 */
export const OVERLAY_HOST_VERSION = 2

/** 会话列表行（只读我们确实要用的字段；缺字段一律按「没有」处理）。 */
export interface OverlaySessionRowLike {
  readonly title?: string
  readonly running?: boolean
}

/** 会话列表快照的窄面（与 ui-api-session-controller 的 SessionListState 同源）。 */
export interface OverlaySessionListSnapshotLike {
  readonly ids?: readonly string[]
  readonly byId?: Readonly<Record<string, OverlaySessionRowLike | undefined>>
  readonly phase?: 'pending' | 'ready'
}

/** `ctx.sessions` 的窄面。 */
export interface OverlaySessionFace {
  readonly sessionId: string
  getSnapshot?(): { readonly sessionId?: string; readonly openState?: string; readonly openError?: unknown; readonly removed?: boolean }
  subscribe?(listener: () => void): () => void
  prompt?(content: readonly unknown[], mode: 'queue' | 'steer', signal?: AbortSignal, requestId?: string): Promise<{ readonly ok: boolean; readonly value?: { readonly accepted?: boolean }; readonly error?: { readonly code?: string; readonly message?: string } }>
}
export interface OverlayEventWindow {
  readonly entries: readonly { readonly type: 'event' | 'transient'; readonly event: { readonly type: string; readonly seq: number; readonly data: unknown } }[]
  readonly revision?: number
  readonly hasMore?: boolean
}
export interface OverlaySessionBinding {
  readonly sessionId: string
  readonly ctx: unknown
  readonly session: OverlaySessionFace
  readonly eventSource: { getSnapshot(): OverlayEventWindow; subscribe(listener: () => void): () => void }
}
export interface OverlayTranscriptRow {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool'
  /** Visible dialog only; tool payloads never masquerade as assistant text. */
  readonly text: string
  readonly toolName?: string
  readonly arguments?: string
  readonly result?: string
  readonly state?: 'running' | 'done' | 'failed'
  /** This row's fields, or older history preceding it, were omitted by the projection budget. */
  readonly truncated?: boolean
}

export interface OverlaySessionsFace {
  readonly list?: { getSnapshot?(): OverlaySessionListSnapshotLike | undefined; subscribe?(listener: () => void): () => void }
  binding?(id: string): OverlaySessionBinding | undefined
  scope?(id: string): unknown
  sessionOf?(scope: unknown): OverlaySessionFace | undefined
  retain?(id: string, options: { source: string }): { readonly binding?: { readonly ctx: unknown; readonly session: unknown }; ready: Promise<unknown>; release(): void }
}

/** 工作区行（WorkspaceView 的窄面）。 */
export interface OverlayWorkspaceRowLike {
  readonly workspaceId: string
  readonly title?: string
  readonly sessionIds?: readonly string[]
}

/** `ctx.workspaces` 的窄面。 */
export interface OverlayWorkspacesFace {
  readonly list?: { getSnapshot(): { readonly items: readonly OverlayWorkspaceRowLike[]; readonly phase: 'pending' | 'ready'; readonly state: 'idle' | 'loading' | 'error'; readonly error?: unknown }; subscribe?(listener: () => void): () => void }
}

/** `ctx.uiWorkspace` 的窄面（导航）。 */
export interface OverlayUiWorkspaceFace {
  openSession(id: unknown): void
  openWorkspace?(id: unknown): Promise<void>
}

/** 输入机公开状态（InputState 的窄面）。 */
export interface OverlayInputStateLike {
  readonly draft?: string
  readonly phase?: string
  readonly draftRev?: number
  readonly attachmentIds?: readonly string[]
}

/** 草稿附件（ComposerAttachment 的窄面；名字取浏览器 File 的 name）。 */
export interface OverlayAttachmentLike {
  readonly kind: 'image' | 'file'
  readonly id: string
  readonly previewUrl?: string
  readonly width?: number
  readonly height?: number
  readonly file?: { readonly name?: string }
}

/** 会话输入机（SessionInput 的窄面）。 */
export interface OverlayInputLike {
  readonly state?: { getSnapshot?(): OverlayInputStateLike | undefined; subscribe?(listener: () => void): () => void }
  setDraft(text: string): void
  submit(): void
  removeAttachment(id: string): boolean
  addAttachments?(ids: readonly string[]): boolean
}

/** `ctx.conversation` 的窄面。 */
export interface OverlayConversationFace {
  readonly input?: { for(scope: unknown): OverlayInputLike }
  sendSession?(session: unknown, text: string, ids: readonly string[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<{ kind: 'success' | 'error'; text?: string }>
  readonly fileUploads?: { getSnapshot(): Readonly<Record<string, { readonly status: 'uploading' | 'ready' | 'error' } | undefined>> }
  resolveDraftAttachments?(ids: readonly string[]): readonly OverlayAttachmentLike[]
  serializeDraftAttachments?(ids: readonly string[]): Promise<{ readonly attachments: readonly unknown[] }>
  releaseDraftAttachment?(id: string): void
}

/**
 * 服务定位面。
 *
 * 为什么用「返回函数」而不是直接传服务实例：本插件可能在服务尚未安装时装配
 * （cordis 的 apply 顺序不受 inject 声明约束），装配期捕获实例会拿到 undefined。
 * 与 index.ts 其它 inject 块同一纪律：**在真正用到的时刻**再取。
 */
export interface OverlayMenuHit {
  readonly trigger: '/'; readonly query: string; readonly quoted: boolean; readonly position: 'leading'
  readonly span: { readonly start: number; readonly end: number; readonly draftRev: number }
}
export interface OverlayMenuCandidate {
  readonly name: string; readonly label?: string; readonly description?: string; readonly section?: string; readonly value?: string
}
export interface OverlayMenuSnapshot {
  readonly open: boolean; readonly hit: OverlayMenuHit | null; readonly generation: number
  readonly groups: readonly { readonly source: string; readonly status: 'pending' | 'ready'; readonly items: readonly OverlayMenuCandidate[] }[]
}
export interface OverlayCommandController {
  resolveClaim(token: string, signal: AbortSignal): Promise<{ submit(args: string, scope: unknown, attachments: readonly unknown[]): Promise<{ kind: 'success' | 'error'; text?: string }> } | undefined>
  readonly menu?: { getSnapshot(): OverlayMenuSnapshot; subscribe(listener: () => void): () => void }
  toggleSource?(source: string, hit: OverlayMenuHit): void
  pick?(source: string, index: number): void
  dismiss?(): void
}

export interface OverlayHostFaces {
  sessions?: () => OverlaySessionsFace | undefined
  workspaces?: () => OverlayWorkspacesFace | undefined
  uiWorkspace?: () => OverlayUiWorkspaceFace | undefined
  conversation?: () => OverlayConversationFace | undefined
  commandController?: (scope: unknown) => OverlayCommandController | undefined
}

/** 一条命令（宿主 API 线上字段，与 composer-commands 同形）。 */
export type OverlayCommand = ComposerMenuCommand

/** 统一成功包（所有方法都走它，保证字段形态一致）。 */
function ok<T extends Record<string, unknown>>(payload: T): string {
  return JSON.stringify({ ok: true, ...payload })
}

/** 统一失败包：error 一定是字符串（原生可以直接展示）。 */
function fail(error: string): string {
  return JSON.stringify({ ok: false, error })
}

/** 异常 → 失败包。绝不把异常抛给 evaluateJavascript。 */
function failWith(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return fail(action + ': ' + detail)
}

/** 读取当前会话 id：与页面既有会话标记同一个真源，读不到就是空串（不猜）。 */
export function readPageSessionId(): string {
  try {
    return document.documentElement.getAttribute(SESSION_ID_ATTRIBUTE) ?? ''
  } catch {
    return ''
  }
}

const TRANSCRIPT_ROWS = 40
const TRANSCRIPT_BYTES = 24 * 1024
const TRANSCRIPT_CHARS = 4000
const TRANSCRIPT_CAPTURE_CHARS = TRANSCRIPT_CHARS + 1
/** Read only a bounded prefix; opaque payloads are never stringified. */
const transcriptText = (text: string, limit = TRANSCRIPT_CAPTURE_CHARS): string => {
  let end = 0, count = 0
  for (const char of text) { if (count++ === limit) break; end += char.length }
  return text.slice(0, end)
}
const transcriptRecord = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const bodyText = (value: unknown): string => {
  if (!Array.isArray(value)) return ''
  let text = '', hasBlock = false
  for (const block of value) {
    const entry = transcriptRecord(block)
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue
    text = transcriptText(text + (hasBlock ? '\n' : '') + transcriptText(entry.text))
    hasBlock = true
    if (Array.from(text).length === TRANSCRIPT_CAPTURE_CHARS) break
  }
  return text
}

/** Escaping, ids, tool payloads and metadata all share one UTF-8 JSON budget. */
function boundOverlayTranscript(rows: readonly OverlayTranscriptRow[], hasMore: boolean): OverlayTranscriptRow[] {
  const latest: OverlayTranscriptRow[] = rows.slice(-TRANSCRIPT_ROWS).flatMap(row => {
    // Never shorten an identity and risk aliasing unrelated source rows.
    if (row.id.length > 1024) return []
    let truncated = row.truncated === true
    const clip = (text: string, limit: number): string => {
      const value = transcriptText(text, limit)
      if (value.length !== text.length) truncated = true
      return value
    }
    const text = clip(row.text, TRANSCRIPT_CHARS)
    const fields = row.role === 'tool' ? {
      toolName: clip(row.toolName ?? '', 256), arguments: clip(row.arguments ?? '', 1600),
      result: clip(row.result ?? '', 1600), state: row.state,
    } : {}
    return [{ id: row.id, role: row.role, text, ...fields, ...(truncated ? { truncated: true } : {}) }]
  })
  const encoder = new TextEncoder(), size = () => encoder.encode(JSON.stringify(latest)).byteLength
  const markOmitted = (): void => { if (latest.length > 0) latest[0] = { ...latest[0], truncated: true } }
  if (hasMore || rows.length > latest.length) markOmitted()
  while (latest.length > 1 && size() > TRANSCRIPT_BYTES) { latest.shift(); markOmitted() }
  // Control-character escaping can exceed 24KiB even for a single bounded row.
  while (latest.length === 1 && size() > TRANSCRIPT_BYTES) {
    const row = latest[0]
    const field = (['text', 'arguments', 'result', 'toolName'] as const).reduce((largest, key) => (row[key]?.length ?? 0) > (row[largest]?.length ?? 0) ? key : largest, 'text')
    const value = row[field] ?? ''
    if (value.length === 0) { latest.pop(); break }
    latest[0] = { ...row, [field]: transcriptText(value, Math.floor(Array.from(value).length / 2)), truncated: true }
  }
  return latest
}

/** Public SessionBinding eventSource only: real dialog/tools, never reasoning or tool-private meta. */
export function projectOverlayTranscript(sessionId: string, window: OverlayEventWindow): OverlayTranscriptRow[] {
  const rows = new Map<string, OverlayTranscriptRow>()
  const live = new Map<string, { attempt: string; blocks: Map<number, { text: string; closed: boolean }> }>()
  const settled = new Set<string>()
  const assistantKey = (data: Record<string, unknown>, seq: number): string => typeof data.turn === 'number' && typeof data.step === 'number'
    ? sessionId + ':assistant:' + data.turn + ':' + data.step : sessionId + ':assistant-seq:' + seq
  const toolKey = (data: Record<string, unknown>, callId: unknown): string | undefined =>
    typeof callId === 'string' && callId.trim() !== '' && typeof data.turn === 'number' && typeof data.step === 'number'
      ? sessionId + ':tool:' + data.turn + ':' + data.step + ':' + callId : undefined
  const addTool = (data: Record<string, unknown>, callId: unknown, name: unknown, args: unknown): void => {
    const id = toolKey(data, callId)
    if (id === undefined || typeof name !== 'string' || name.trim() === '' || typeof args !== 'string') return
    const previous = rows.get(id)
    rows.set(id, { id, role: 'tool', text: '', toolName: transcriptText(name, 257), arguments: transcriptText(args, 1601), result: previous?.result ?? '', state: previous?.state ?? 'running' })
  }
  for (const entry of window.entries) {
    const data = transcriptRecord(entry.event.data)
    if (entry.type === 'event' && data !== undefined && entry.event.type === 'assistant/message') settled.add(assistantKey(data, entry.event.seq))
  }
  for (const entry of window.entries) {
    const event = entry.event, data = transcriptRecord(event.data)
    if (data === undefined) continue
    if (entry.type === 'event' && event.type === 'user/message') {
      if (transcriptRecord(data.source)?.kind !== 'user') continue
      const text = bodyText(data.content)
      if (text.trim() === '') continue
      const id = sessionId + ':user:' + (typeof data.id === 'string' ? data.id : String(event.seq))
      rows.set(id, { id, role: 'user', text })
    } else if (entry.type === 'event' && event.type === 'assistant/message') {
      const message = transcriptRecord(data.message), text = bodyText(message?.content)
      const id = assistantKey(data, event.seq)
      if (text.trim() !== '') rows.set(id, { id, role: 'assistant', text })
      if (Array.isArray(message?.content)) for (const raw of message.content) {
        const block = transcriptRecord(raw)
        if (block?.type === 'tool-call') addTool(data, block.id, block.name, block.arguments)
      }
    } else if (entry.type === 'event' && event.type === 'tool/call') {
      addTool(data, data.callId, data.name, data.arguments)
    } else if (entry.type === 'event' && event.type === 'tool/result') {
      const message = transcriptRecord(data.message), id = toolKey(data, message?.toolCallId)
      const previous = id === undefined ? undefined : rows.get(id)
      if (previous === undefined || message === undefined || message.role !== 'tool') continue
      const result = bodyText(message.content), reason = transcriptRecord(data.error)?.reason
      rows.set(previous.id, { ...previous, result: result || (message.isError === true && typeof reason === 'string' ? transcriptText(reason) : ''), state: message.isError === true ? 'failed' : 'done' })
    } else if (entry.type === 'transient' && event.type === 'assistant/live-chunk') {
      const id = assistantKey(data, event.seq), chunk = transcriptRecord(data.chunk)
      if (settled.has(id) || chunk === undefined || typeof data.attemptId !== 'string' || typeof chunk.index !== 'number') continue
      let state = live.get(id)
      if (state === undefined || state.attempt !== data.attemptId) { state = { attempt: data.attemptId, blocks: new Map() }; live.set(id, state); rows.delete(id) }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        const block = state.blocks.get(chunk.index)
        if (block?.closed !== true) state.blocks.set(chunk.index, { text: transcriptText((block?.text ?? '') + transcriptText(chunk.text)), closed: false })
      } else if (chunk.type === 'block-end') {
        const block = transcriptRecord(chunk.block)
        if (block?.type === 'text' && typeof block.text === 'string') state.blocks.set(chunk.index, { text: transcriptText(block.text), closed: true })
      }
      const text = transcriptText([...state.blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.text).join('\n'))
      if (text.trim() !== '') rows.set(id, { id, role: 'assistant', text })
    }
  }
  return boundOverlayTranscript([...rows.values()], window.hasMore === true)
}

/**
 * 页面宿主 API 的实现（无 DOM 依赖的测试面：会话/工作区/输入机都是注入的窄面）。
 */
export class OverlayHost {
  /** 最近一次成功读到的命令表；null = 还没成功读过。 */
  private commands: OverlayCommand[] | null = null
  private commandsReadAt = 0
  private commandsSessionId = ''
  private commandsError = ''
  private operationSequence = 0
  private readonly instanceId = globalThis.crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))
  private readonly activeOperationKeys = new Map<string, string>()
  private readonly operations = new Map<string, string>()
  private readonly sending = new Set<string>()
  private readonly draftOwners = new Set<() => void>()

  private disposed = false
  private readonly thumbnails = new Map<string, string>()
  private readonly thumbnailPending = new Set<string>()
  private stateWatching = false
  private stateSubscriptions: (() => void)[] = []
  private inputSubscription: (() => void) | undefined
  private watchedInputState: OverlayInputLike['state'] | undefined
  private transcriptSubscriptions: (() => void)[] = []
  private watchedTranscriptBinding: OverlaySessionBinding | undefined
  private markerObserver: MutationObserver | undefined
  private stateNotification: ReturnType<typeof setTimeout> | undefined

  /** Subscribe only while a native card or composer is visible. Signal invalidation, never duplicate state. */
  watchState(enabled: unknown): string {
    const watching = enabled === true && !this.disposed
    if (watching && this.stateWatching) { this.bindVisibleSessionObservation(); return ok({}) }
    this.stateWatching = watching
    for (const unsubscribe of this.stateSubscriptions) unsubscribe()
    this.stateSubscriptions = []
    this.inputSubscription?.(); this.inputSubscription = undefined; this.watchedInputState = undefined
    for (const unsubscribe of this.transcriptSubscriptions) unsubscribe()
    this.transcriptSubscriptions = []; this.watchedTranscriptBinding = undefined
    this.markerObserver?.disconnect(); this.markerObserver = undefined
    if (this.stateNotification !== undefined) { clearTimeout(this.stateNotification); this.stateNotification = undefined }
    if (!this.stateWatching) return ok({})
    const changed = () => { this.bindVisibleSessionObservation(); this.signalStateChanged() }
    const sessions = this.faces.sessions?.()?.list, workspaces = this.faces.workspaces?.()?.list
    const sessionDrop = sessions?.subscribe?.(changed), workspaceDrop = workspaces?.subscribe?.(changed)
    if (sessionDrop !== undefined) this.stateSubscriptions.push(sessionDrop)
    if (workspaceDrop !== undefined) this.stateSubscriptions.push(workspaceDrop)
    const bindInput = () => changed()
    bindInput()
    this.markerObserver = new MutationObserver(bindInput)
    this.markerObserver.observe(document.documentElement, { attributes: true, attributeFilter: [SESSION_ID_ATTRIBUTE] })
    return ok({})
  }

  private bindVisibleSessionObservation(): void {
    if (!this.stateWatching || this.disposed) return
    const inputState = this.inputFacade(this.sessionId())?.state
    if (inputState !== this.watchedInputState) {
      this.inputSubscription?.()
      this.watchedInputState = inputState
      this.inputSubscription = inputState?.subscribe?.(() => this.signalStateChanged())
    }
    this.bindTranscriptObservation()
  }

  private bindTranscriptObservation(): void {
    if (!this.stateWatching || this.disposed) return
    let binding: OverlaySessionBinding | undefined
    try { binding = this.faces.sessions?.()?.binding?.(this.sessionId()) } catch { /* unavailable is published by state() */ }
    if (binding?.sessionId !== this.sessionId()) binding = undefined
    if (binding === this.watchedTranscriptBinding) return
    for (const unsubscribe of this.transcriptSubscriptions) unsubscribe()
    this.transcriptSubscriptions = []; this.watchedTranscriptBinding = binding
    if (binding === undefined) return
    const changed = () => this.signalStateChanged()
    this.transcriptSubscriptions.push(binding.eventSource.subscribe(changed))
    const lifecycleDrop = binding.session.subscribe?.(changed)
    if (lifecycleDrop !== undefined) this.transcriptSubscriptions.push(lifecycleDrop)
  }

  private transcriptOf(sessionId: string): { rows: OverlayTranscriptRow[]; ready: boolean; error: string } {
    if (sessionId === '') return { rows: [], ready: false, error: 'transcript-session-unavailable' }
    try {
      const binding = this.faces.sessions?.()?.binding?.(sessionId)
      if (binding === undefined || binding.sessionId !== sessionId || binding.session.sessionId !== sessionId) return { rows: [], ready: false, error: 'transcript-session-unavailable' }
      const lifecycle = binding.session.getSnapshot?.()
      if (lifecycle?.removed === true || lifecycle?.openState === 'error') return { rows: [], ready: false, error: 'transcript-history-error' }
      const window = binding.eventSource.getSnapshot()
      return { rows: projectOverlayTranscript(sessionId, window), ready: lifecycle?.openState === 'open', error: lifecycle?.openState === 'open' ? '' : 'transcript-history-pending' }
    } catch { return { rows: [], ready: false, error: 'transcript-unavailable' } }
  }

  private signalStateChanged(): void {
    if (!this.stateWatching || this.disposed || this.stateNotification !== undefined) return
    this.stateNotification = setTimeout(() => { this.stateNotification = undefined; if (this.stateWatching && !this.disposed) console.info('[dsh-overlay-state-changed]') }, 100)
  }
  private readonly unknownSendChecks = new Map<string, { check(): void; dispose(): void }>()
  dispose(): void { this.watchState(false); this.disposed = true; this.thumbnails.clear(); for (const pending of this.unknownSendChecks.values()) pending.dispose(); this.unknownSendChecks.clear(); for (const drop of [...this.draftOwners]) drop() }
  private readonly incomingStates = new Map<string, string>()
  private readonly incomingReads = new Set<string>()
  /** 读命令的并发合并：原生可能连点几次「命令抽屉」，不能并发开多轮上游菜单。 */
  private commandsInFlight: Promise<void> | null = null

  constructor(
    private readonly faces: OverlayHostFaces,
    private readonly sessionId: () => string = readPageSessionId,
    private readonly readCommands?: () => Promise<OverlayCommand[]>,
    private readonly composerReady: () => boolean = () => false,
  ) {}

  /** 原生桥对象（全局只装一份；版本字段供能力强弱判断）。 */
  api(): Record<string, unknown> {
    return {
      version: OVERLAY_HOST_VERSION,
      watchState: (enabled: unknown) => this.watchState(enabled),
      operation: (id: unknown) => this.operation(id),
      incoming: (id: unknown) => this.incoming(id),
      openWorkspace: (id: unknown) => this.openWorkspace(id),
      state: () => this.state(),
      sessions: () => this.sessions(),
      commands: () => this.commandsJson(),
      execute: (line: unknown, sessionId: unknown) => this.execute(line, sessionId),
      send: (text: unknown, sessionId: unknown) => this.send(text, sessionId),
      removeAttachment: (index: unknown) => this.removeAttachment(index),
      openSession: (sessionId: unknown) => this.openSession(sessionId),
    }
  }

  // ── 读取面 ────────────────────────────────────────────────────────────────

  /**
   * 页面当前状态（输入区/卡片的数据源）。
   *
   * sessionId 读不到时返回空串而不是编一个：设计 §6.3 的硬规则是「取不到时显示会话未知」，
   * 原生据此禁用发送/命令，而不是发到某个猜出来的会话。
   */
  state(): string {
    try {
      const sessionId = this.sessionId()
      const snapshot = this.sessionSnapshot()
      if (snapshot === undefined || snapshot.phase !== 'ready') return fail('sessions-not-ready')
      const row = sessionId === '' ? undefined : snapshot?.byId?.[sessionId]
      const workspaceSnapshot = this.workspaceSnapshot()
      const workspacesReady = workspaceSnapshot?.phase === 'ready' && workspaceSnapshot.state !== 'error'
      const workspaces = workspacesReady ? workspaceSnapshot.items : []
      const current = sessionId === '' ? undefined : workspaces.find((item) => (item.sessionIds ?? []).includes(sessionId))
      const inputState = this.inputState(sessionId)
      const transcript = this.transcriptOf(sessionId)
      return ok({
        sessionId,
        agentId: this.resolvedSession(sessionId)?.sessionId ?? '',
        sessionTitle: row?.title ?? '',
        workspaceId: current?.workspaceId ?? '',
        workspaceName: current?.title ?? '',
        workspacesReady,
        workspacesError: workspaceSnapshot === undefined ? 'workspaces-unavailable' : workspaceSnapshot.state === 'error' ? 'workspaces-error' : workspaceSnapshot.phase !== 'ready' ? 'workspaces-pending' : '',
        workspaces: workspaces.map((item) => ({ id: item.workspaceId, title: item.title ?? '' })),
        busy: row?.running === true,
        transcript: transcript.rows,
        transcriptReady: transcript.ready,
        transcriptError: transcript.error,
        attachments: this.attachmentsOf(inputState),
        draft: typeof inputState?.draft === 'string' ? inputState.draft : '',
      })
    } catch (error) {
      return failWith('state', error)
    }
  }

  /**
   * 可用会话列表（悬浮输入区「会话」药丸的切换来源）。
   *
   * 页面列表快照是唯一真源：`pending`（尚未从 Host 拉到基线）与「服务不可读」都返回
   * ok:false，让原生退回 RPC `session/list`。**不得**把「还没加载」当成「没有会话」。
   */
  sessions(): string {
    try {
      const snapshot = this.sessionSnapshot()
      if (snapshot === undefined) return fail('sessions-unavailable')
      if (snapshot.phase !== 'ready') return fail('sessions-pending')
      const byId = snapshot.byId ?? {}
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(byId)
      return ok({
        items: ids.map((id) => ({ id, title: byId[id]?.title ?? '', agentId: this.resolvedSession(id)?.sessionId ?? '' })),
      })
    } catch (error) {
      return failWith('sessions', error)
    }
  }

  /** Official per-session menu store, not DOM rendering/focus, owns the overlay directory. */
  commandsJson(): string {
    try {
      const id = this.sessionId()
      if (this.commandsSessionId !== id) { this.commands = null; this.commandsError = ''; this.commandsSessionId = id }
      if (this.commands !== null && Date.now() - this.commandsReadAt < 1000) return ok({ items: this.commands })
      if (this.readCommands !== undefined && !this.composerReady()) return fail('composer-unavailable')
      const previousError = this.commandsError
      void this.refreshCommands()
      return fail(previousError || 'commands-not-ready')
    } catch (error) { return failWith('commands', error) }
  }

  async warmCommands(): Promise<boolean> {
    await this.refreshCommands()
    return this.commands !== null
  }

  async refreshCommands(): Promise<void> {
    if (this.commandsInFlight !== null) return this.commandsInFlight
    if (this.readCommands !== undefined && !this.composerReady()) return
    const id = this.sessionId()
    this.commandsSessionId = id
    const run = (async () => {
      try {
        const items = this.readCommands !== undefined ? await this.readCommands() : await this.withOfficialMenu(id, (items) => items.filter(item => {
          // Same exact-match attachment-title closure as the shared sheet; never prefix-match commands.
          const name = item.name.trim().replace(/^\//u, '').toLowerCase()
          const label = (item.label ?? '').trim().toLowerCase()
          return !ATTACHMENT_ROW_TITLES.has(name) && !ATTACHMENT_ROW_TITLES.has(label)
        }).map(item => ({
          // The provider routes by canonical candidate.name; localized label is display copy only.
          name: item.name.startsWith('/') ? item.name : '/' + item.name,
          label: item.label ?? item.name, description: item.description ?? '', section: item.section ?? '',
        })))
        if (this.sessionId() !== id) return
        this.commands = items; this.commandsSessionId = id; this.commandsError = ''; this.commandsReadAt = Date.now()
      } catch (error) {
        this.commands = null
        this.commandsError = error instanceof Error ? error.message : String(error)
      } finally { this.commandsInFlight = null }
    })()
    this.commandsInFlight = run
    return run
  }

  private async withOfficialMenu<T>(id: string, run: (items: readonly OverlayMenuCandidate[], controller: OverlayCommandController, input: OverlayInputLike) => T): Promise<T> {
    const sessions = this.faces.sessions?.(), scope = sessions?.scope?.(id), input = this.inputFacade(id)
    if (scope === undefined || input === undefined) throw new Error('composer-unavailable')
    const controller = this.faces.commandController?.(scope), menu = controller?.menu
    if (controller === undefined || menu === undefined || controller.toggleSource === undefined || controller.dismiss === undefined) throw new Error('commands-unavailable')
    if (menu.getSnapshot().open) throw new Error('commands-menu-busy')
    const state = input.state?.getSnapshot?.()
    if (state?.draftRev === undefined || state.phase === 'submitting' || state.phase === 'adjudicating') throw new Error('composer-busy')
    const reference = sessions?.retain?.(id, { source: 'workspaceOperation' })
    let opened = false
    const hit: OverlayMenuHit = { trigger: '/', query: '', quoted: false, position: 'leading', span: { start: 0, end: 0, draftRev: state.draftRev } }
    let generation = -1
    let readinessTimer: number | undefined
    try {
      // SessionReference.ready is an initial history-open waiter, not an immediately hot scope.
      // A stuck open must release this borrow and leave the directory retryable, never cache [].
      await Promise.race([
        reference?.ready ?? Promise.resolve(),
        new Promise<never>((_resolve, reject) => { readinessTimer = window.setTimeout(() => reject(new Error('session-not-ready')), 4000) }),
      ])
      window.clearTimeout(readinessTimer)
      if (this.sessionId() !== id || sessions?.scope?.(id) !== scope) throw new Error('session-generation-changed')
      const binding = reference?.binding
      if (binding !== undefined && binding.ctx !== scope) throw new Error('session-generation-changed')
      if (menu.getSnapshot().open) throw new Error('commands-menu-busy')
      return await new Promise<T>((resolve, reject) => {
        let finished = false, unsubscribe: (() => void) | undefined
        const timer = window.setTimeout(() => finish(new Error('commands-not-ready')), 4000)
        const finish = (error?: Error, value?: T) => {
          if (finished) return
          finished = true; window.clearTimeout(timer); unsubscribe?.()
          if (error !== undefined) reject(error); else resolve(value as T)
        }
        const inspect = () => {
          if (!opened || finished) return
          const current = menu.getSnapshot()
          if (this.sessionId() !== id || sessions?.scope?.(id) !== scope || input.state?.getSnapshot?.()?.draftRev !== state.draftRev) { finish(new Error('commands-aborted')); return }
          if (current.generation !== generation || current.hit !== hit) { finish(new Error('commands-menu-aborted')); return }
          const group = current.groups.find(group => group.source === 'command')
          if (!current.open || group === undefined) { finish(new Error('commands-source-unavailable')); return }
          if (group.status === 'ready') {
            finished = true; window.clearTimeout(timer); unsubscribe?.()
            try { resolve(run(group.items, controller, input)) } catch (error) { reject(error) }
          }
        }
        unsubscribe = menu.subscribe(inspect)
        try {
          controller.toggleSource!('command', hit)
          generation = menu.getSnapshot().generation; opened = true; inspect()
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      })
    } finally {
      window.clearTimeout(readinessTimer)
      const current = menu.getSnapshot()
      // Do not close a user menu which superseded the one this borrow opened.
      if (opened && current.hit === hit && current.generation === generation) controller.dismiss()
      reference?.release()
    }
  }

  private waitForForeground(): Promise<void> {
    if (document.visibilityState === 'visible') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const done = () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', changed) }
      const changed = () => { if (document.visibilityState === 'visible') { done(); resolve() } }
      const timer = window.setTimeout(() => { done(); reject(new Error('commands-foreground-required')) }, 10000)
      document.addEventListener('visibilitychange', changed)
    })
  }

  // ── 动作面 ────────────────────────────────────────────────────────────────

  /** Wake the targeted-only background consumer and poll the authenticated receipt, never infer success. */
  incoming(id: unknown): string {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return fail('invalid-request-id')
    window.dispatchEvent(new Event('dsh:overlay-incoming'))
    if (!this.incomingReads.has(id)) {
      this.incomingReads.add(id)
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('incoming receipt timed out'))
          controller.abort()
        }, 4000)
      })
      // Keep body decoding inside the deadline, but state mutation outside it: a late body is stale.
      const receipt = Promise.resolve().then(async () => {
        const response = await fetch('/api/android/file-incoming?requestId=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
        const result = await response.json() as { ok?: boolean; state?: string }
        return { response, result }
      })
      void Promise.race([receipt, timeout]).then(({ response, result }) => {
        if (response.ok && result.ok === true && typeof result.state === 'string') this.incomingStates.set(id, result.state)
      }).catch(() => {}).finally(() => { clearTimeout(timer); this.incomingReads.delete(id) })
    }
    return ok({ state: this.incomingStates.get(id) ?? 'pending' })
  }

  /** Pollable settlement: evaluateJavascript cannot await a Promise returned by the page. */
  operation(id: unknown): string {
    if (typeof id !== 'string') return fail('invalid-operation')
    this.unknownSendChecks.get(id)?.check()
    return this.operations.get(id) ?? JSON.stringify({ pending: true, unknown: true, operationId: id, error: 'operation-not-found' })
  }

  private begin(key: string, run: (signal: AbortSignal) => Promise<string>): string {
    const existing = this.activeOperationKeys.get(key)
    if (existing !== undefined) return this.operations.get(existing)!
    const operationId = this.instanceId + '-overlay-' + String(++this.operationSequence)
    const pending = JSON.stringify({ pending: true, operationId })
    this.operations.set(operationId, pending)
    this.activeOperationKeys.set(key, operationId)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      // A read-only proof may have settled this ticket while its original carrier is still open.
      if (this.activeOperationKeys.get(key) !== operationId) return
      // An invoked handler may already have committed. Timeout is not proof of refusal.
      this.operations.set(operationId, JSON.stringify({ pending: true, unknown: true, operationId }))
    }, 25000)
    let settled = false
    void Promise.resolve().then(() => run(controller.signal)).then(result => {
      const reply = JSON.parse(result) as { pending?: boolean }
      settled = reply.pending !== true
      this.operations.set(operationId, reply.pending === true ? JSON.stringify({ ...reply, operationId }) : result)
    }, error => {
      this.operations.set(operationId, JSON.stringify({ pending: true, unknown: true, operationId, error: String(error) }))
    }).finally(() => {
      window.clearTimeout(timer)
      if (settled && this.activeOperationKeys.get(key) === operationId) this.activeOperationKeys.delete(key)
      if (this.operations.size > 100) {
        for (const [id, result] of this.operations) {
          if (!JSON.parse(result).pending && id !== operationId) this.operations.delete(id)
          if (this.operations.size <= 100) break
        }
      }
    })
    return pending
  }

  /** Resolve the real scoped claim; no composer mutation and no draft attachments on commands. */
  execute(line: unknown, expectedSessionId: unknown = this.sessionId()): string {
    try {
      if (typeof line !== 'string' || !line.trim().startsWith('/')) return fail('invalid-line')
      const id = this.sessionId()
      if (id === '' || id !== expectedSessionId) return fail('session-mismatch')
      const key = JSON.stringify(['execute', id, line])
      const existing = this.activeOperationKeys.get(key)
      if (existing !== undefined) return this.operations.get(existing)!
      const sessions = this.faces.sessions?.(), scope = sessions?.scope?.(id)
      if (scope === undefined) return fail('composer-unavailable')
      if (this.faces.commandController?.(scope)?.menu !== undefined) {
        return this.begin(key, async () => {
          let invoked = false
          try {
          await this.waitForForeground()
          return await this.withOfficialMenu(id, (items, controller, input) => {
            if (controller.pick === undefined) return fail('commands-unavailable')
            if (input.state?.getSnapshot?.()?.phase !== 'plain') return fail('composer-busy')
            const token = line.trim().replace(/^\//u, '')
            const index = items.findIndex(item => item.name === token)
            if (index < 0) return fail('command-not-found')
            invoked = true
            controller.pick('command', index)
            return ok({ handedOff: true })
          })
          } catch (error) {
            return invoked ? JSON.stringify({ pending: true, unknown: true, error: String(error) }) : failWith('execute', error)
          }
        })
      }
      const reference = sessions?.retain?.(id, { source: 'workspaceOperation' })
      return this.begin(key, async signal => {
        let invoked = false, uncertain = false
        try {
          await reference?.ready
          const binding = reference?.binding
          if (binding !== undefined && (binding.ctx !== scope || binding.session !== sessions?.sessionOf?.(scope))) return fail('session-generation-changed')
          const controller = this.faces.commandController?.(binding?.ctx ?? scope)
          if (controller === undefined) return fail('commands-unavailable')
          const token = line.trim().split(/\s/u)[0] as string
          const claim = await controller.resolveClaim(token, signal)
          if (claim === undefined) return fail('command-not-found')
          invoked = true
          const result = await claim.submit(line.trim().slice(token.length).trimStart(), binding?.ctx ?? scope, [])
          return result.kind === 'success' ? ok({}) : fail(result.text ?? 'command-failed')
        } catch (error) {
          if (!invoked) return failWith('execute', error)
          uncertain = true
          return JSON.stringify({ pending: true, unknown: true, error: String(error) })
        } finally { if (!uncertain) reference?.release() }
      })
    } catch (error) { return failWith('execute', error) }
  }

  /** The input rail gives up this batch synchronously; the browser registry retains its bytes. */
  send(text: unknown, expectedSessionId: unknown = this.sessionId()): string {
    try {
      if (this.disposed) return fail('host-disposed')
      if (typeof text !== 'string') return fail('invalid-text')
      const id = this.sessionId()
      if (id === '' || id !== expectedSessionId) return fail('session-mismatch')
      const key = JSON.stringify(['send', id, text])
      const existing = this.activeOperationKeys.get(key)
      if (existing !== undefined) return this.operations.get(existing)!
      const input = this.inputFacade(id), session = this.resolvedSession(id), conversation = this.faces.conversation?.()
      if (input === undefined || session === undefined || conversation?.sendSession === undefined) return fail('composer-unavailable')
      const state = input.state?.getSnapshot?.()
      if (state === undefined || state.phase === 'submitting' || state.phase === 'adjudicating' || this.sending.has(id)) return fail('composer-busy')
      const ids = [...state.attachmentIds ?? []]
      if (text.trim() === '' && ids.length === 0) return fail('empty-message')
      if (ids.length > 0 && input.addAttachments === undefined) return fail('attachment-admission-unavailable')
      if (conversation.resolveDraftAttachments !== undefined && conversation.fileUploads !== undefined) {
        const drafts = conversation.resolveDraftAttachments(ids), uploads = conversation.fileUploads.getSnapshot()
        if (drafts.length !== ids.length) return fail('attachment-not-found')
        if (drafts.some(draft => (draft.kind === 'file' || uploads[draft.id] !== undefined) && uploads[draft.id]?.status !== 'ready')) return fail('attachment-not-ready')
      }
      const reference = this.faces.sessions?.()?.retain?.(id, { source: 'workspaceOperation' })
      const requestId = crypto.randomUUID()
      const detached: string[] = []
      let detachFailed = false
      this.sending.add(id)
      // JS cannot interleave a user input event inside this batch. Guard refusals must not submit.
      for (const attachmentId of ids) {
        if (!input.removeAttachment(attachmentId)) { detachFailed = true; break }
        detached.push(attachmentId)
      }
      const lifecycle = new AbortController()
      let operationId = '', invoked = false, uncertain = false, accepted = false, finished = false, checking = false
      const finish = (dispose = false) => {
        if (finished) return
        finished = true
        lifecycle.abort()
        this.unknownSendChecks.delete(operationId)
        this.sending.delete(id)
        if (reference !== undefined) {
          const retained = reference.binding
          const exactGeneration = retained === undefined || (retained.session === session && retained.ctx === this.faces.sessions?.()?.scope?.(id))
          if (dispose || !exactGeneration || !keepDraftReference(reference, input.state, this.draftOwners)) reference.release()
        }
      }
      const accept = () => {
        if (accepted) return ok({ requestId })
        accepted = true
        // The captured batch has already left the input rail. Never clear newer draft IDs or text.
        for (const attachmentId of ids) { try { conversation.releaseDraftAttachment?.(attachmentId) } catch { /* admission is already proven */ } }
        this.operations.set(operationId, ok({ requestId }))
        if (this.activeOperationKeys.get(key) === operationId) this.activeOperationKeys.delete(key)
        finish()
        return ok({ requestId })
      }
      const pending = () => JSON.stringify({ pending: true, unknown: true, requestId })
      const raw = this.begin(key, async () => {
        try {
          await this.withSendDeadline(reference?.ready ?? Promise.resolve(), 4000, 'session-not-ready', lifecycle.signal)
          const scope = this.faces.sessions?.()?.scope?.(id)
          const binding = reference?.binding
          if (binding !== undefined && (binding.ctx !== scope || binding.session !== session)) { await this.restoreAttachments(input, detached, lifecycle.signal); return fail('session-generation-changed') }
          if (detachFailed) { await this.restoreAttachments(input, detached, lifecycle.signal); return fail('attachment-detach-refused') }
          const target = (binding?.session ?? session) as OverlaySessionFace
          if (ids.length > 0 && conversation.serializeDraftAttachments !== undefined && target.prompt !== undefined) {
            // Public serialization and Session admission have no visual-frame dependency.
            const serialized = await this.withSendDeadline(conversation.serializeDraftAttachments(ids), 8000, 'attachment-serialization-timeout', lifecycle.signal)
            if (this.faces.sessions?.()?.sessionOf?.(scope) !== session) { await this.restoreAttachments(input, detached, lifecycle.signal); return fail('session-generation-changed') }
            const content = [...serialized.attachments, ...(text === '' ? [] : [{ type: 'text', text }])]
            invoked = true
            const receipt = await target.prompt(content, 'queue', lifecycle.signal, requestId)
            if (accepted) return ok({ requestId })
            if (finished) { uncertain = true; return pending() }
            // Remote folds lost receipts into ok:false gateway/*, not a rejected Promise.
            const code = receipt?.error?.code
            if (receipt?.ok === false && typeof code === 'string' && code !== '' && !code.startsWith('gateway/')) {
              await this.restoreAttachments(input, detached, lifecycle.signal)
              return fail([code, receipt.error?.message].filter(Boolean).join(': '))
            }
            if (receipt?.ok !== true || receipt.value?.accepted !== true) { uncertain = true; return pending() }
            return accept()
          }
          invoked = true
          const outcome = await conversation.sendSession!(target, text, ids, 'queue', lifecycle.signal)
          if (outcome.kind !== 'success') { await this.restoreAttachments(input, detached, lifecycle.signal); return fail(outcome.text ?? 'send-failed') }
          return ok({})
        } catch (error) {
          if (accepted) return ok({ requestId })
          if (invoked) { uncertain = true; return pending() }
          if (!finished) await this.restoreAttachments(input, detached, lifecycle.signal)
          return failWith('send', error)
        } finally { if (!uncertain || accepted) finish(this.disposed) }
      })
      operationId = (JSON.parse(raw) as { operationId: string }).operationId
      this.unknownSendChecks.set(operationId, {
        dispose: () => finish(true),
        check: () => {
          if (!invoked || finished || checking || this.disposed) return
          checking = true
          void this.readPromptAdmission(id, requestId, lifecycle.signal).then(observed => {
            if (observed && !finished && !this.disposed) accept()
          }).finally(() => { checking = false })
        },
      })
      if (this.disposed) finish(true)
      return raw
    } catch (error) { return failWith('send', error) }
  }

  private withSendDeadline<T>(promise: Promise<T>, ms: number, reason: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => done(new Error(reason)), ms)
      const aborted = () => done(new Error('send-observer-disposed'))
      let finished = false
      const done = (error?: Error, value?: T) => {
        if (finished) return
        finished = true; window.clearTimeout(timer); signal?.removeEventListener('abort', aborted)
        if (error !== undefined) reject(error); else resolve(value as T)
      }
      void promise.then(value => done(undefined, value), error => done(error instanceof Error ? error : new Error(String(error))))
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  }

  /** Read-only exact request evidence. A missing/failed query is never proof of rejection. */
  private async readPromptAdmission(sessionId: string, requestId: string, signal: AbortSignal): Promise<boolean> {
    const read = async (method: 'session/state' | 'session/events'): Promise<boolean> => {
      const controller = new AbortController(), abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) return false
        const rpcId = crypto.randomUUID()
        const request = method === 'session/state' ? { sessionId } : { address: { kind: 'session', sessionId }, maxMessages: 100 }
        const query = async () => {
          const response = await fetch('/api/' + method, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
          })
          if (!response.ok) return false
          const wire = await response.json() as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: { queue?: { rpcId?: string }[]; records?: { type?: string; event?: { type?: string; data?: { source?: { kind?: string; rpcId?: string } } } }[] } } }
          if (wire.type !== 'server-response' || wire.rpcId !== rpcId || wire.result?.ok !== true) return false
          const value = wire.result.value
          if (method === 'session/state') return Array.isArray(value?.queue) && value.queue.some(row => row?.rpcId === requestId)
          return Array.isArray(value?.records) && value.records.some(record => record?.type === 'event' && record.event?.type === 'user/message' && record.event.data?.source?.kind === 'user' && record.event.data.source.rpcId === requestId)
        }
        return await this.withSendDeadline(query(), 2500, 'receipt-query-timeout', signal)
      } catch { return false } finally { controller.abort(); signal.removeEventListener('abort', abort) }
    }
    if (await read('session/state')) return true
    return signal.aborted ? false : read('session/events')
  }

  private restoreAttachments(input: OverlayInputLike, ids: readonly string[], signal?: AbortSignal): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    const restore = (): boolean => {
      const state = input.state?.getSnapshot?.()
      if (state === undefined || state.phase === 'submitting' || state.phase === 'adjudicating') return false
      const missing = ids.filter(id => !(state.attachmentIds ?? []).includes(id))
      return missing.length === 0 || input.addAttachments?.(missing) === true
    }
    if (restore()) return Promise.resolve()
    return new Promise<void>(resolve => {
      let restoring = false, finished = false
      let unsubscribe: (() => void) | undefined
      const done = () => {
        if (finished) return
        finished = true; unsubscribe?.(); signal?.removeEventListener('abort', done); resolve()
      }
      const inspect = () => {
        if (restoring || finished) return
        restoring = true
        if (restore()) done()
        restoring = false
      }
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) { done(); return }
      unsubscribe = input.state?.subscribe?.(inspect)
      inspect()
      if (finished) unsubscribe?.()
      // Keep the exact generation until editable ownership returns, or page teardown releases it.
    })
  }

  removeAttachment(id: unknown): string {
    try {
      if (typeof id !== 'string' || id === '') return fail('invalid-attachment-id')
      const input = this.requireInput()
      if (input === undefined) return fail('composer-unavailable')
      if (!(input.state?.getSnapshot?.()?.attachmentIds ?? []).includes(id)) return fail('attachment-not-found')
      return input.removeAttachment(id) ? ok({}) : fail('attachment-remove-refused')
    } catch (error) { return failWith('removeAttachment', error) }
  }

  openSession(sessionId: unknown): string {
    try {
      if (typeof sessionId !== 'string' || sessionId === '') return fail('invalid-session-id')
      const snapshot = this.sessionSnapshot()
      if (snapshot?.phase !== 'ready' || !snapshot.ids?.includes(sessionId)) return fail('session-not-found')
      const ui = this.faces.uiWorkspace?.()
      if (ui === undefined) return fail('ui-workspace-unavailable')
      ui.openSession(sessionId)
      return ok({})
    } catch (error) { return failWith('openSession', error) }
  }

  openWorkspace(id: unknown): string {
    const snapshot = this.workspaceSnapshot()
    if (snapshot?.phase !== 'ready' || snapshot.state === 'error') return fail('workspaces-not-ready')
    if (typeof id !== 'string' || !snapshot.items.some(w => w.workspaceId === id)) return fail('workspace-not-found')
    const ui = this.faces.uiWorkspace?.()
    if (ui?.openWorkspace === undefined) return fail('ui-workspace-unavailable')
    return this.begin(JSON.stringify(['workspace', id]), async () => { await ui.openWorkspace!(id); return ok({}) })
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private sessionSnapshot(): OverlaySessionListSnapshotLike | undefined {
    return this.faces.sessions?.()?.list?.getSnapshot?.()
  }

  private workspaceSnapshot() {
    return this.faces.workspaces?.()?.list?.getSnapshot()
  }

  /** 当前会话的输入机；任何一环缺失都返回 undefined（调用方据此 ok:false）。 */
  private inputFacade(sessionId: string): OverlayInputLike | undefined {
    if (sessionId === '') return undefined
    const sessions = this.faces.sessions?.()
    const conversation = this.faces.conversation?.()
    if (sessions?.scope === undefined || conversation?.input === undefined) return undefined
    try {
      const scope = sessions.scope(sessionId)
      if (scope === undefined) return undefined
      return conversation.input.for(scope)
    } catch {
      return undefined
    }
  }

  private resolvedSession(id: string): OverlaySessionFace | undefined {
    const sessions = this.faces.sessions?.()
    const scope = sessions?.scope?.(id)
    return scope === undefined ? undefined : sessions?.sessionOf?.(scope)
  }

  private requireInput(): OverlayInputLike | undefined {
    return this.inputFacade(this.sessionId())
  }

  private inputState(sessionId: string): OverlayInputStateLike | undefined {
    return this.inputFacade(sessionId)?.state?.getSnapshot?.()
  }

  private thumbnailOf(attachment: OverlayAttachmentLike): string {
    const cached = this.thumbnails.get(attachment.id)
    if (cached !== undefined) return cached
    const url = attachment.previewUrl
    if (this.disposed || this.thumbnailPending.has(attachment.id) || this.thumbnailPending.size >= 2 || typeof url !== 'string' || !url.startsWith('blob:') || typeof createImageBitmap !== 'function') return ''
    this.thumbnailPending.add(attachment.id)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 4000)
    void fetch(url, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('thumbnail-source-unavailable')
      return response.blob()
    }).then(blob => {
      const width = attachment.width, height = attachment.height
      const scale = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 ? Math.min(1, 256 / Math.max(width, height)) : undefined
      return createImageBitmap(blob, scale === undefined ? { resizeWidth: 256, resizeQuality: 'low' } : { resizeWidth: Math.max(1, Math.round(width! * scale)), resizeHeight: Math.max(1, Math.round(height! * scale)), resizeQuality: 'low' })
    }).then(bitmap => {
      try {
        if (this.disposed) return
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height))
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('thumbnail-canvas-unavailable')
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        const data = canvas.toDataURL('image/jpeg', 0.7)
        this.thumbnails.set(attachment.id, data.length <= 49152 ? data : '')
        this.signalStateChanged()
      } finally { bitmap.close() }
    }).catch(() => { if (!this.disposed) this.thumbnails.set(attachment.id, '') }).finally(() => {
      window.clearTimeout(timer); this.thumbnailPending.delete(attachment.id)
      while (this.thumbnails.size > 8) this.thumbnails.delete(this.thumbnails.keys().next().value!)
    })
    return ''
  }

  /** 草稿附件 → 线上形态（名字取 File.name；拿不到就空串，不编）。 */
  private attachmentsOf(inputState: OverlayInputStateLike | undefined): Array<{ id: string; name: string; kind: 'image' | 'file'; thumbnail?: string }> {
    const ids = inputState?.attachmentIds
    if (!Array.isArray(ids) || ids.length === 0) return []
    const conversation = this.faces.conversation?.()
    if (conversation?.resolveDraftAttachments === undefined) return []
    try {
      return conversation.resolveDraftAttachments(ids).map((attachment) => ({
        id: attachment.id,
        name: attachment.file?.name ?? '',
        kind: attachment.kind === 'image' ? 'image' : 'file',
        ...(attachment.kind === 'image' ? { thumbnail: this.thumbnailOf(attachment) } : {}),
      }))
    } catch {
      return []
    }
  }
}

/**
 * 把宿主 API 装到全局（幂等；返回卸载函数，HMR/插件卸载时恢复原值）。
 *
 * 历史对象按原样保留/恢复：若别的代码先占了这个名字，卸载时不能把它删掉。
 */
export function installOverlayHost(host: OverlayHost): () => void {
  const target = window as unknown as Record<string, unknown>
  const previous = target[OVERLAY_HOST_GLOBAL]
  const api = host.api()
  target[OVERLAY_HOST_GLOBAL] = api
  // 预取命令表：原生第一次调 commands() 时大概率已命中缓存（读菜单需要跨一次提交）。
  // No eager menu borrowing at install: cold startup may have no composer at all.
  return () => {
    host.dispose()
    if (target[OVERLAY_HOST_GLOBAL] !== api) return
    if (previous === undefined) delete target[OVERLAY_HOST_GLOBAL]
    else target[OVERLAY_HOST_GLOBAL] = previous
  }
}
