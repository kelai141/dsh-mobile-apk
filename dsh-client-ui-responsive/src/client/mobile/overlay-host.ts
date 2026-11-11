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

import { readComposerMenuCommands, hasComposerMenuButton, type ComposerMenuCommand } from './composer-commands.ts'
import { SESSION_ID_ATTRIBUTE } from './session-marker.ts'

/** 全局对象名（壳侧 evaluateJavascript 求值的目标，改了就两端一起改）。 */
export const OVERLAY_HOST_GLOBAL = '__dshOverlayHost'

/** 宿主 API 版本：新增/改变方法语义时递增，原生据此判断能力。 */
export const OVERLAY_HOST_VERSION = 1

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
export interface OverlaySessionsFace {
  readonly list?: { getSnapshot?(): OverlaySessionListSnapshotLike | undefined }
  scope?(id: string): unknown
}

/** 工作区行（WorkspaceView 的窄面）。 */
export interface OverlayWorkspaceRowLike {
  readonly workspaceId: string
  readonly title?: string
  readonly sessionIds?: readonly string[]
}

/** `ctx.workspaces` 的窄面。 */
export interface OverlayWorkspacesFace {
  getSnapshot?(): { readonly items?: readonly OverlayWorkspaceRowLike[] } | undefined
}

/** `ctx.uiWorkspace` 的窄面（导航）。 */
export interface OverlayUiWorkspaceFace {
  openSession(id: unknown): void
}

/** 输入机公开状态（InputState 的窄面）。 */
export interface OverlayInputStateLike {
  readonly draft?: string
  readonly attachmentIds?: readonly string[]
}

/** 草稿附件（ComposerAttachment 的窄面；名字取浏览器 File 的 name）。 */
export interface OverlayAttachmentLike {
  readonly kind: 'image' | 'file'
  readonly id: string
  readonly file?: { readonly name?: string }
}

/** 会话输入机（SessionInput 的窄面）。 */
export interface OverlayInputLike {
  readonly state?: { getSnapshot?(): OverlayInputStateLike | undefined }
  setDraft(text: string): void
  submit(): void
  removeAttachment(id: string): boolean
}

/** `ctx.conversation` 的窄面。 */
export interface OverlayConversationFace {
  readonly input?: { for(scope: unknown): OverlayInputLike }
  resolveDraftAttachments?(ids: readonly string[]): readonly OverlayAttachmentLike[]
}

/**
 * 服务定位面。
 *
 * 为什么用「返回函数」而不是直接传服务实例：本插件可能在服务尚未安装时装配
 * （cordis 的 apply 顺序不受 inject 声明约束），装配期捕获实例会拿到 undefined。
 * 与 index.ts 其它 inject 块同一纪律：**在真正用到的时刻**再取。
 */
export interface OverlayHostFaces {
  sessions?: () => OverlaySessionsFace | undefined
  workspaces?: () => OverlayWorkspacesFace | undefined
  uiWorkspace?: () => OverlayUiWorkspaceFace | undefined
  conversation?: () => OverlayConversationFace | undefined
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

/**
 * 页面宿主 API 的实现（无 DOM 依赖的测试面：会话/工作区/输入机都是注入的窄面）。
 */
export class OverlayHost {
  /** 最近一次成功读到的命令表；null = 还没成功读过。 */
  private commands: OverlayCommand[] | null = null
  /** 读命令的并发合并：原生可能连点几次「命令抽屉」，不能并发开多轮上游菜单。 */
  private commandsInFlight: Promise<void> | null = null

  constructor(
    private readonly faces: OverlayHostFaces,
    private readonly sessionId: () => string = readPageSessionId,
    private readonly readCommands: () => Promise<OverlayCommand[]> = readComposerMenuCommands,
    private readonly composerReady: () => boolean = hasComposerMenuButton,
  ) {}

  /** 原生桥对象（全局只装一份；版本字段供能力强弱判断）。 */
  api(): Record<string, unknown> {
    return {
      version: OVERLAY_HOST_VERSION,
      state: () => this.state(),
      sessions: () => this.sessions(),
      commands: () => this.commandsJson(),
      execute: (line: unknown) => this.execute(line),
      send: (text: unknown) => this.send(text),
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
      const row = sessionId === '' ? undefined : snapshot?.byId?.[sessionId]
      const workspaces = this.workspacesSnapshot()
      const current = sessionId === '' ? undefined : workspaces.find((item) => (item.sessionIds ?? []).includes(sessionId))
      const inputState = this.inputState(sessionId)
      return ok({
        sessionId,
        sessionTitle: row?.title ?? '',
        workspaceId: current?.workspaceId ?? '',
        workspaceName: current?.title ?? '',
        workspaces: workspaces.map((item) => ({ id: item.workspaceId, title: item.title ?? '' })),
        busy: row?.running === true,
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
      if (snapshot.phase === 'pending') return fail('sessions-pending')
      const byId = snapshot.byId ?? {}
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(byId)
      return ok({
        items: ids.map((id) => ({ id, title: byId[id]?.title ?? '' })),
      })
    } catch (error) {
      return failWith('sessions', error)
    }
  }

  /**
   * 动态命令清单（来自上游「+」菜单的真实 DOM，不硬编码任何命令）。
   *
   * **为什么可能返回 ok:false**：读上游菜单必须跨一次 React 提交（异步），而本 API 是同步
   * 求值接口。所以采用「缓存 + 预取」：缓存命中直接返回；未命中时启动一次异步读取并返回
   * `commands-not-ready`，原生稍后重读即可（自然幂等）。页面没有合成器（无「+」）时返回
   * `composer-unavailable`，不假装「没有命令」。
   */
  commandsJson(): string {
    try {
      if (this.commands !== null) return ok({ items: this.commands })
      if (!this.composerReady()) return fail('composer-unavailable')
      void this.refreshCommands()
      return fail('commands-not-ready')
    } catch (error) {
      return failWith('commands', error)
    }
  }

  /** 预取命令表（安装时调用一次；失败不抛）。返回是否已完成一次成功读取。 */
  async warmCommands(): Promise<boolean> {
    await this.refreshCommands()
    return this.commands !== null
  }

  /** 读一次命令表并落缓存（并发合并；失败保持未就绪，等下次重试）。 */
  async refreshCommands(): Promise<void> {
    if (this.commandsInFlight !== null) return this.commandsInFlight
    const run = (async () => {
      try {
        const items = await this.readCommands()
        this.commands = items
      } catch {
        // 读失败保持「未就绪」：宁可让原生重试，也不拿一张空命令表冒充真源。
      } finally {
        this.commandsInFlight = null
      }
    })()
    this.commandsInFlight = run
    return run
  }

  // ── 动作面 ────────────────────────────────────────────────────────────────

  /**
   * 执行一条命令行（如 `/compact`）。
   *
   * 走页面自己的提交路径（写入草稿 → 触发 composer 提交 → 上游命令仲裁），因此
   * 与用户手打命令**完全同一条链路**：命令是否成立、参数是否合法都由页面裁决，
   * 失败会以页面自己的 notice 呈现。这是设计 §6.4「优先复用页面既有命令执行路径」的落点；
   * 不走 `POST /api/commands/execute` 是因为那条路由要 `agentId`，而页面只拥有
   * `sessionId`（设计 §6.3 明令两者不得互串），强行拼一个 agentId 属于猜身份。
   */
  execute(line: unknown): string {
    try {
      if (typeof line !== 'string' || line.trim() === '') return fail('invalid-line')
      const input = this.requireInput()
      if (input === undefined) return fail('composer-unavailable')
      input.setDraft(line)
      input.submit()
      return ok({})
    } catch (error) {
      return failWith('execute', error)
    }
  }

  /**
   * 通过页面自身 composer 提交文本。
   *
   * 为什么必须走 composer 而不是直发 RPC：用户草稿里可能已有附件（图片/文件），
   * 那些附件只属于页面的 composer；绕过去发文本会让「带附件发送」静默丢附件。
   * 写入草稿 + submit 的语义与用户点发送键一致。
   */
  send(text: unknown): string {
    try {
      if (typeof text !== 'string') return fail('invalid-text')
      const input = this.requireInput()
      if (input === undefined) return fail('composer-unavailable')
      input.setDraft(text)
      input.submit()
      return ok({})
    } catch (error) {
      return failWith('send', error)
    }
  }

  /**
   * 按索引移除一个草稿附件（原生附件预览条的删除按钮）。
   *
   * 索引对应 `state().attachments` 的顺序（同一份输入机状态）。越界或页面拒绝（提交中
   * 等忙态）都返回 ok:false，由原生如实提示，不静默当作已删。
   */
  removeAttachment(index: unknown): string {
    try {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return fail('invalid-index')
      const input = this.requireInput()
      if (input === undefined) return fail('composer-unavailable')
      const ids = this.inputState(this.sessionId())?.attachmentIds ?? []
      const id = ids[index]
      if (id === undefined) return fail('attachment-not-found')
      const removed = input.removeAttachment(id)
      return removed ? ok({}) : fail('attachment-remove-refused')
    } catch (error) {
      return failWith('removeAttachment', error)
    }
  }

  /** 切到指定会话（会话药丸）。不存在/不可切换时由页面导航语义决定，异常一律 ok:false。 */
  openSession(sessionId: unknown): string {
    try {
      if (typeof sessionId !== 'string' || sessionId === '') return fail('invalid-session-id')
      const ui = this.faces.uiWorkspace?.()
      if (ui === undefined) return fail('ui-workspace-unavailable')
      ui.openSession(sessionId)
      return ok({})
    } catch (error) {
      return failWith('openSession', error)
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private sessionSnapshot(): OverlaySessionListSnapshotLike | undefined {
    return this.faces.sessions?.()?.list?.getSnapshot?.()
  }

  private workspacesSnapshot(): readonly OverlayWorkspaceRowLike[] {
    const items = this.faces.workspaces?.()?.getSnapshot?.()?.items
    return Array.isArray(items) ? items : []
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

  private requireInput(): OverlayInputLike | undefined {
    return this.inputFacade(this.sessionId())
  }

  private inputState(sessionId: string): OverlayInputStateLike | undefined {
    return this.inputFacade(sessionId)?.state?.getSnapshot?.()
  }

  /** 草稿附件 → 线上形态（名字取 File.name；拿不到就空串，不编）。 */
  private attachmentsOf(inputState: OverlayInputStateLike | undefined): Array<{ name: string; kind: 'image' | 'file' }> {
    const ids = inputState?.attachmentIds
    if (!Array.isArray(ids) || ids.length === 0) return []
    const conversation = this.faces.conversation?.()
    if (conversation?.resolveDraftAttachments === undefined) return []
    try {
      return conversation.resolveDraftAttachments(ids).map((attachment) => ({
        name: attachment.file?.name ?? '',
        kind: attachment.kind === 'image' ? 'image' : 'file',
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
  void host.warmCommands()
  return () => {
    if (target[OVERLAY_HOST_GLOBAL] !== api) return
    if (previous === undefined) delete target[OVERLAY_HOST_GLOBAL]
    else target[OVERLAY_HOST_GLOBAL] = previous
  }
}
