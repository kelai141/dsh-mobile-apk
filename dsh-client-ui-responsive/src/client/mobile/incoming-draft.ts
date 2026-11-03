/**
 * External-open attachment-draft consumer.
 *
 * The queue returns opaque file metadata only. The trusted shell bridge supplies the temporary
 * workspace cwd (never a source-file path); the normal client Session controller creates a blank
 * locally addressable Session there before the source is claimed and attached through the existing
 * composer/upload flow.
 */

import { reportUserFacingResult } from '../export-result.ts'

export interface IncomingDraftItem {
  entryId: string
  sessionId?: string
  state: 'received' | 'session-created'
  name: string
  bytes: number
}

interface ClaimReply {
  ok: boolean
  ticket?: string
  name?: string
}

interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  blob(): Promise<Blob>
}

export type IncomingDraftFetch = (input: string, init?: RequestInit) => Promise<FetchResponse>

/** Narrow facade over existing session and conversation services. */
export interface IncomingDraftRuntime {
  refreshSessions(): Promise<void>
  createSession(cwd: string): Promise<string>
  openSession(sessionId: string): void
  sessionScope(sessionId: string): unknown | undefined
  attachGenericFile(sessionId: string, file: File): boolean
  notify(scope: unknown, text: string): void
}

function itemOf(value: unknown): IncomingDraftItem | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const item = value as Partial<IncomingDraftItem>
  if (typeof item.entryId !== 'string' || item.entryId === '') return undefined
  if (item.sessionId !== undefined && (typeof item.sessionId !== 'string' || item.sessionId === '')) return undefined
  if (item.state !== 'received' && item.state !== 'session-created') return undefined
  if (typeof item.name !== 'string' || item.name === '') return undefined
  if (typeof item.bytes !== 'number' || !Number.isFinite(item.bytes) || item.bytes < 0) return undefined
  return item as IncomingDraftItem
}

function claimOf(value: unknown): ClaimReply | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const claim = value as ClaimReply
  return claim.ok === true && typeof claim.ticket === 'string' && claim.ticket !== '' && typeof claim.name === 'string' && claim.name !== ''
    ? claim
    : undefined
}

/**
 * 一组任务按**有界并发**跑（issue #1413）。
 *
 * 旧实现是串行 `for (const item of items) await this.hydrate(item)`：一条条目卡住，队列里
 * 其余文件全部等着。改成有界并发后，单条慢/失败都不阻塞其它条目；单条异常在这里被吞掉，
 * 不影响同批其它条目（它们各自有自己的重试与终止标记）。
 *
 * @param items - 待处理条目。
 * @param limit - 并发上限（至少 1）。
 * @param task - 单条处理函数。
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      try { await task(items[index]) } catch { /* 单条失败不阻塞同批其它条目 */ }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
}

/** 从一个 HTTP 错误对象上取状态码（不同层用 status / statusCode 两种写法）。 */
function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown, statusCode?: unknown } | null | undefined
  if (typeof e?.status === "number") return e.status
  if (typeof e?.statusCode === "number") return e.statusCode
  return undefined
}

/**
 * 这个状态码是不是**终态**（服务端明确拒绝，重试也不会变好）。
 *
 * 4xx 里 408（请求超时）与 429（限流）是显式可重试的，不算终态；5xx 一律可重试。
 */
export function isTerminalStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  if (status === 408 || status === 429) return false
  return status >= 400 && status < 500
}

/**
 * 刷新会话目录失败时，这次失败是否**终态**（issue #1412）。
 *
 * 旧实现把「刷新失败」一律当终态：`catch { sessionId = undefined }` 丢掉条目自带的
 * sessionId，落进「新建会话」分支 —— claim 用新 id 与服务端记录不符 → 非 ok → 静默
 * return → 下一轮重试（上限 5 次）⇒ 一次分享最多产生 5 个空会话。
 *
 * 判据：只有服务端明确拒绝（4xx，除 408/429）才算这个 id 已死；网络失败 / 超时 / 5xx
 * 一律保留原 id 重试。
 */
export function isTerminalRefreshFailure(error: unknown): boolean {
  return isTerminalStatus(statusOf(error))
}

/** Drives one process-local external attachment flow. */
export class IncomingDraftConsumer {
  private busy = false
  private readonly hydrating = new Set<string>()
  private readonly createdSessions = new Map<string, string>()
  /** review C10：逐条目的载入尝试计数与终止标记——无 sessionId 的补建必须**有限次**。 */
  private readonly attempts = new Map<string, number>()
  private readonly exhausted = new Set<string>()
  /** 已经提示过「临时工作区不可用」的条目（S3-21：同一 entryId 只提示一次）。 */
  private readonly workspaceWarned = new Set<string>()
  private static readonly MAX_HYDRATE_ATTEMPTS = 5
  /** issue #1413：一批条目的并发上限。一条慢/失败不得阻塞同批其它条目。 */
  private static readonly POLL_CONCURRENCY = 4

  /** @param fetchImpl authenticated same-origin fetch. @param runtime session/conversation bridge. */
  constructor(
    private readonly fetchImpl: IncomingDraftFetch,
    private readonly runtime: IncomingDraftRuntime,
  ) {}

  /** Fetch eligible queue metadata and hydrate each blank-session attachment once. */
  async poll(): Promise<void> {
    if (this.busy) return
    this.busy = true
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'fetching')
    try {
      const response = await this.fetchImpl('/api/android/file-incoming', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return
      const payload = await response.json().catch(() => null) as { items?: unknown[] } | null
      if (!Array.isArray(payload?.items)) return
      document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'items:' + String(payload.items.length))
      // issue #1413：有界并发，别让一条慢条目把整个队列串住。
      const items = payload.items.map(itemOf).filter((i): i is IncomingDraftItem => i !== undefined)
      await runBounded(items, IncomingDraftConsumer.POLL_CONCURRENCY, (item) => this.hydrate(item))
    } catch (error) {
      console.warn('[dsh-mobile] incoming draft queue retry deferred:', String(error))
    } finally {
      this.busy = false
    }
  }

  /**
   * review C10：尝试次数封顶。旧实现每次轮询无条件重试；createSession 失败时每次都会新建
   * workspace/session（用户侧表现：反复多出临时会话）。封顶后停止自动补建并提示一次，
   * 用户重新分享文件即可得到新条目（进程内新记录不受影响）。
   */
  private exhaustedFor(item: IncomingDraftItem): boolean {
    const attempts = (this.attempts.get(item.entryId) ?? 0) + 1
    this.attempts.set(item.entryId, attempts)
    if (attempts <= IncomingDraftConsumer.MAX_HYDRATE_ATTEMPTS) return false
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'exhausted')
    if (!this.exhausted.has(item.entryId)) {
      this.exhausted.add(item.entryId)
      console.warn('[dsh-mobile] incoming draft hydration exhausted; a fresh share is required:', item.name)
      const sessionId = item.sessionId ?? this.createdSessions.get(item.entryId)
      const scope = sessionId === undefined ? undefined : this.runtime.sessionScope(sessionId)
      if (scope !== undefined) {
        this.runtime.notify(scope, '外部附件草稿多次载入失败，已停止自动重试；请重新使用系统打开方式分享文件。')
      }
    }
    return true
  }

  /**
   * 「拿不到临时工作区路径」的可见回执（S3-21；同一 entryId 只提示一次）。
   *
   * 为什么会拿不到：壳侧的临时工作区尚未建立（首启/引擎重启中），或壳侧未装配该 bridge 方法。
   * 旧实现直接 return —— 用户的分享就此消失，既没有提示也没有下一步。
   * @param item - 被卡住的来件条目。
   */
  private notifyWorkspaceUnavailable(item: IncomingDraftItem): void {
    if (this.workspaceWarned.has(item.entryId)) return
    this.workspaceWarned.add(item.entryId)
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-unavailable')
    // 这条路径**没有会话可挂**（拿不到工作区 ⇒ 也就没有 sessionId），所以不能用会话级 notify
    // ——那正是「静默丢弃」的成因。改走全局的用户可见结果通道（与导出结果、原生动作失败同一通道）。
    reportUserFacingResult({
      ok: false,
      title: '分享进来的文件还没放进来',
      detail: '应用正在准备临时工作区（或壳侧连接未就绪），所以这次分享还没有落地。'
        + '请稍后重新分享一次，或改用应用内的附件按钮添加文件。',
    })
  }

  private async hydrate(item: IncomingDraftItem): Promise<void> {
    if (this.hydrating.has(item.entryId)) return
    if (this.exhaustedFor(item)) return
    this.hydrating.add(item.entryId)
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'hydrate:' + item.state)
    try {
      const locallyCreated = this.createdSessions.get(item.entryId)
      let sessionId = item.sessionId ?? locallyCreated
      if (sessionId !== undefined) {
        document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'session-refresh')
        try {
          // Only a server-created legacy id needs catalog refresh. A Session returned by the
          // standard client creator is already local; refreshing it can stall behind an unrelated
          // list request before its attachment handoff.
          if (item.sessionId !== undefined) await this.runtime.refreshSessions()
        } catch (error) {
          // issue #1412：刷新失败**不得**丢掉条目自带的 sessionId。
          //
          // 丢了就落进下面的「新建会话」分支：claim 用新 id 与服务端记录不符 → 非 ok →
          // 静默 return → 下一轮重试（上限 5 次）⇒ 一次分享最多产生 5 个空会话。
          //
          // 只有服务端明确拒绝（4xx，除 408/429）才判这个 id 已死；网络失败 / 超时 / 5xx
          // 保留原 id，交给下一轮 poll 重试——期间**不建新会话**。
          if (isTerminalRefreshFailure(error)) {
            sessionId = undefined
          } else {
            document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'session-refresh-deferred')
            return
          }
        }
        if (sessionId !== undefined) {
          try { this.runtime.openSession(sessionId) } catch { /* navigation may lag an addressable Session */ }
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'session-opened')
        }
      }
      if (sessionId === undefined) {
        const cwd = window.androidBridge?.incomingWorkspacePath?.() ?? ''
        if (cwd === '') {
          // S3-21：拿不到临时工作区路径时旧实现**彻底静默丢弃**（连一次 console.warn 都在另一条
          // 分支上）——用户分享了一个文件、看到应用打开了、然后什么都没有，文件不见了。这里给
          // 一次性可见回执（同一 entryId 只提示一次，不随轮询刷屏），并说清下一步。
          this.notifyWorkspaceUnavailable(item)
          return
        }
        try {
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'session-create-call')
          sessionId = await this.runtime.createSession(cwd)
          this.createdSessions.set(item.entryId, sessionId)
          try { this.runtime.openSession(sessionId) } catch { /* attachment handoff is Session-addressed */ }
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'session-opened')
        } catch (error) {
          console.warn('[dsh-mobile] incoming session creation deferred:', String(error))
          return
        }
      }
      // J1 admits through the same InputHub shell that owns the rendered composer. The Session
      // controller resolves before that UI scope can be bound on cold WebView startup, so retain
      // the queue record and wait through the bounded binding window rather than losing the draft.
      // issue #1413：**不原地自旋**。旧实现最多 100 × 100ms = 10s 卡在这一条上，而 poll 当时
      // 是串行的 ⇒ 队列里其余文件在这 10s 内一个都不处理。会话作用域在冷启动后很快绑定，
      // 条目留在队列里，下一轮 poll 再来即可。
      const scope = this.runtime.sessionScope(sessionId)
      if (scope === undefined) {
        document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'scope-deferred')
        return
      }
      let ticket = ''
      try {
        document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'claim')
        const claimResponse = await this.fetchImpl('/api/android/file-incoming/claim', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entryId: item.entryId, sessionId }),
        })
        const claim = claimResponse.ok ? claimOf(await claimResponse.json().catch(() => null)) : undefined
        document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'claim:' + String(claimResponse.status))
        // issue #1412：claim 失败这里**保持**既有的有界重试 + 提示一次（C10）。
        // 不能改成「立即终态」：finish() 需要 ticket，而 claim 失败时还没有 ticket，没有可终态的
        // 对象；而「反复重试」的**真实危害**是每次新建一个空会话 —— 那一条已由上面的
        // isTerminalRefreshFailure 分支堵掉（重试复用同一个 sessionId）。
        if (claim === undefined) return
        ticket = claim.ticket as string
        const content = await this.fetchImpl('/api/android/file-incoming/content?ticket=' + encodeURIComponent(ticket), {
          credentials: 'same-origin', cache: 'no-store',
        })
        if (!content.ok) throw new Error('incoming content HTTP ' + content.status)
        const file = new File([await content.blob()], claim.name as string, { type: 'application/octet-stream' })
        const attached = this.runtime.attachGenericFile(sessionId, file)
        document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'attached:' + String(attached))
        await this.finish(ticket, attached ? 'draft-ready' : 'removed')
        ticket = ''
        if (!attached) this.runtime.notify(scope, '外部附件草稿当前无法加入编辑框，请重新使用系统打开方式。')
      } catch {
        if (ticket !== '') await this.finish(ticket, 'removed')
        this.runtime.notify(scope, '外部附件草稿载入失败；文件没有自动发送，请重新使用系统打开方式。')
      }
    } finally {
      this.hydrating.delete(item.entryId)
    }
  }

  private async finish(ticket: string, outcome: 'draft-ready' | 'removed'): Promise<void> {
    try {
      await this.fetchImpl('/api/android/file-incoming/complete', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket, outcome }),
      })
    } catch {
      // The draft is browser-owned; an acknowledgement failure cannot recreate or send it.
    }
  }
}
