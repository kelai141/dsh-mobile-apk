// @vitest-environment jsdom
// 来件**来源**判据（缺陷 1：拍照后附件被投进新会话）。
//
// 缺陷链：壳侧拍照 → 队列里一条**没有目标会话**的记录 → 本消费端见 sessionId 缺失就
// createSession(cwd) + openSession(id) ⇒ 拍照结果进了新会话，用户被从会话 A 甩走。
//
// 修复：记录带 origin。
//   camera   = 用户在会话 A 里主动点「+ → 拍照」⇒ 并入**当前会话**，不建会话、不导航；
//   external = 用户从别的应用分享进来（PRD F5.2）⇒ 必须仍然强制新会话（负控，不得削弱）。
//
// 判据落点全部是**真实调用**：createSession / openSession / attachGenericFile 的调用记录。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  IncomingDraftConsumer,
  normalizeDraftOrigin,
  DRAFT_ORIGINS,
  DEFAULT_DRAFT_ORIGIN,
  type IncomingDraftFetch,
} from '../src/client/mobile/incoming-draft.ts'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(['payload'], { type: 'image/jpeg' }),
  }
}

/** 队列 + claim + content + complete 四拍的 fetch 替身。 */
function queueFetch(items: readonly unknown[]): IncomingDraftFetch {
  return vi.fn<IncomingDraftFetch>()
    .mockResolvedValueOnce(json({ items }))
    .mockResolvedValueOnce(json({ ok: true, ticket: 'ticket-1', name: 'photo-1.jpg' }))
    .mockResolvedValueOnce(json({}))
    .mockResolvedValueOnce(json({ ok: true, state: 'draft-ready' })) as unknown as IncomingDraftFetch
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  const calls = { create: [] as string[], open: [] as string[], attach: [] as Array<[string, File]>, refresh: 0 }
  const runtime = {
    refreshSessions: async () => { calls.refresh += 1 },
    createSession: async (cwd: string) => { calls.create.push(cwd); return 'session-created-0001' },
    openSession: (id: string) => { calls.open.push(id) },
    sessionScope: () => ({}),
    attachGenericFile: (id: string, file: File) => { calls.attach.push([id, file]); return true },
    notify: () => {},
    ...overrides,
  }
  return { runtime, calls }
}

beforeEach(() => {
  document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE)
  ;(window as unknown as { androidBridge?: unknown }).androidBridge = { incomingWorkspacePath: () => '/incoming' }
})

afterEach(() => {
  document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE)
  delete (window as unknown as { androidBridge?: unknown }).androidBridge
})

describe('来源归一（闭集，缺省 external）', () => {
  it('只有显式 camera 才离开缺省；缺字段/未知/伪造一律 external', () => {
    expect(DEFAULT_DRAFT_ORIGIN).toBe('external')
    expect([...DRAFT_ORIGINS].sort()).toEqual(['camera', 'external'])
    expect(normalizeDraftOrigin(undefined)).toBe('external')
    expect(normalizeDraftOrigin('')).toBe('external')
    expect(normalizeDraftOrigin('camer')).toBe('external')
    expect(normalizeDraftOrigin('CAMERA')).toBe('external')
    expect(normalizeDraftOrigin('attach-to-current')).toBe('external')
    expect(normalizeDraftOrigin('camera')).toBe('camera')
  })
})

describe('camera 来件：并入当前会话（缺陷 1 的修复判据）', () => {
  it('当前有会话时不 createSession、不 openSession，直接附加到当前会话', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-aaaa1111-current')
    const { runtime, calls } = makeRuntime()
    const fetchImpl = queueFetch([
      { entryId: 'photo-entry', origin: 'camera', state: 'received', name: 'photo-1.jpg', bytes: 7 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create, '不得新建会话（这正是缺陷形态）').toEqual([])
    expect(calls.open, '不得做可见导航（拍照返回后用户必须还在原会话）').toEqual([])
    expect(calls.attach).toHaveLength(1)
    expect(calls.attach[0]?.[0]).toBe('session-aaaa1111-current')
    expect(calls.attach[0]?.[1]).toBeInstanceOf(File)
    // claim 必须用当前会话 id 结算（服务端据此核对）
    const claimBody = String(fetchImpl.mock.calls[1]?.[1]?.body)
    expect(claimBody).toContain('photo-entry')
    expect(claimBody).toContain('session-aaaa1111-current')
    // 注：data-dsh-incoming-draft-poll 是**逐步覆盖**的调试标记，后续步骤会写 'attached:true'，
    // 所以不在此断言它——真正的判据是上面三条调用记录。
  })

  it('当前没有会话时落回原行为（新建会话），不静默丢件', async () => {
    const { runtime, calls } = makeRuntime()
    const fetchImpl = queueFetch([
      { entryId: 'photo-entry', origin: 'camera', state: 'received', name: 'photo-1.jpg', bytes: 7 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create).toEqual(['/incoming'])
    expect(calls.open).toEqual(['session-created-0001'])
    expect(calls.attach).toHaveLength(1)
    expect(calls.attach[0]?.[0]).toBe('session-created-0001')
  })
})

describe('external 来件：仍然强制新会话（PRD F5.2 负控）', () => {
  it('当前有会话时也绝不并入——必须新建并导航过去', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-aaaa1111-current')
    const { runtime, calls } = makeRuntime()
    const fetchImpl = queueFetch([
      { entryId: 'share-entry', origin: 'external', state: 'received', name: 'shared.pdf', bytes: 9 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create, '外部分享必须仍然新建会话（F5.2 硬规则）').toEqual(['/incoming'])
    expect(calls.open).toEqual(['session-created-0001'])
    expect(calls.attach[0]?.[0]).toBe('session-created-0001')
    expect(calls.attach[0]?.[0]).not.toBe('session-aaaa1111-current')
  })

  it('缺 origin 字段的老记录按 external 处理（向后兼容 + F5.2 守门）', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-aaaa1111-current')
    const { runtime, calls } = makeRuntime()
    const fetchImpl = queueFetch([
      { entryId: 'legacy-entry', state: 'received', name: 'legacy.pdf', bytes: 4 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create, '没有来源字段 = 外部分享 = 强制新会话').toEqual(['/incoming'])
    expect(calls.open).toEqual(['session-created-0001'])
  })

  it('伪造 origin 值同样按 external 处理', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-aaaa1111-current')
    const { runtime, calls } = makeRuntime()
    const fetchImpl = queueFetch([
      { entryId: 'fake-entry', origin: 'attach-to-current', state: 'received', name: 'x.bin', bytes: 1 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create).toEqual(['/incoming'])
    expect(calls.attach[0]?.[0]).toBe('session-created-0001')
  })
})

describe('camera 的当前会话已失效：回落新建且有界（不得死循环）', () => {
  it('当前会话 scope 不可用 → 回落新建会话并把文件加进去（不是丢弃，也不是永远 deferred）', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-deleted-0000')
    const calls = { create: [] as string[], open: [] as string[], attach: [] as Array<[string, File]> }
    // 已删除的会话：scope 恒为 undefined；新建出来的会话 scope 可用。
    const runtime = {
      refreshSessions: async () => {},
      createSession: async (cwd: string) => { calls.create.push(cwd); return 'session-fallback-0001' },
      openSession: (id: string) => { calls.open.push(id) },
      sessionScope: (id: string) => (id === 'session-deleted-0000' ? undefined : {}),
      attachGenericFile: (id: string, file: File) => { calls.attach.push([id, file]); return true },
      notify: () => {},
    }
    const fetchImpl = queueFetch([
      { entryId: 'photo-entry', origin: 'camera', state: 'received', name: 'photo-1.jpg', bytes: 7 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create, '当前会话真的没了时必须回落新建，而不是让条目永远 deferred').toEqual(['/incoming'])
    expect(calls.attach).toHaveLength(1)
    expect(calls.attach[0]?.[0]).toBe('session-fallback-0001')
  })

  it('回落是**有界**的：scope 永远不可用时不会无限新建会话', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-deleted-0000')
    const createSession = vi.fn(async () => 'session-fallback-0001')
    const runtime = {
      refreshSessions: async () => {},
      createSession,
      openSession: () => {},
      // 任何会话的 scope 都拿不到（最坏情况：作用域投影整体不可用）
      sessionScope: () => undefined,
      attachGenericFile: () => true,
      notify: () => {},
    }
    const fetchImpl = vi.fn<IncomingDraftFetch>(async (input: string) => {
      if (String(input) === '/api/android/file-incoming') {
        return json({ items: [{ entryId: 'photo-entry', origin: 'camera', state: 'received', name: 'photo-1.jpg', bytes: 7 }] })
      }
      return json({ ok: false, error: 'incoming entry not found' }, 404)
    })
    const consumer = new IncomingDraftConsumer(fetchImpl, runtime)
    for (let i = 0; i < 8; i += 1) await consumer.poll()

    // 回落上限 2 次 + 既有 MAX_HYDRATE_ATTEMPTS 封顶 ⇒ 绝不可能每轮都建一个空会话。
    expect(createSession.mock.calls.length).toBeLessThanOrEqual(2)
    expect(createSession.mock.calls.length).toBeGreaterThan(0)
  })
})

describe('带 sessionId 的条目不受来源改动影响（回归）', () => {
  it('服务端已铸会话的条目仍按该会话导航并附加', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'session-aaaa1111-current')
    const { runtime, calls } = makeRuntime()
    const fetchImpl = queueFetch([
      { entryId: 'e1', sessionId: 'session-bbbb2222-server', state: 'session-created', name: 'a.pdf', bytes: 2 },
    ])
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()

    expect(calls.create).toEqual([])
    expect(calls.open).toEqual(['session-bbbb2222-server'])
    expect(calls.attach[0]?.[0]).toBe('session-bbbb2222-server')
  })
})
