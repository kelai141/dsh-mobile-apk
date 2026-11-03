// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { IncomingDraftConsumer, isTerminalRefreshFailure, isTerminalStatus, runBounded, type IncomingDraftFetch } from '../src/client/mobile/incoming-draft.ts'

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(['payload'], { type: 'image/png' }),
  }
}

describe('IncomingDraftConsumer', () => {
  it('hydrates one server-created blank session with a generic file draft and no text prompt', async () => {
    const scope = {}
    const events: string[] = []
    const fetchImpl = vi.fn<IncomingDraftFetch>()
      .mockResolvedValueOnce(json({ items: [{
        entryId: 'opaque-entry', sessionId: 'session-abcdef12-1', state: 'session-created', name: 'picture.png', bytes: 7,
      }] }))
      .mockResolvedValueOnce(json({ ok: true, ticket: 'ticket-1', name: 'picture.png' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ ok: true, state: 'draft-ready' }))
    const attachGenericFile = vi.fn(() => true)
    const notify = vi.fn()
    const consumer = new IncomingDraftConsumer(fetchImpl, {
      refreshSessions: async () => { events.push('refresh') },
      createSession: async () => 'session-created-unused',
      openSession: (sessionId) => { events.push('open:' + sessionId) },
      sessionScope: () => scope,
      attachGenericFile,
      notify,
    })

    await consumer.poll()

    expect(events).toEqual(['refresh', 'open:session-abcdef12-1'])
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/android/file-incoming/claim')
    expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).toContain('opaque-entry')
    expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).not.toContain('path')
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/android/file-incoming/content?ticket=ticket-1')
    expect(attachGenericFile).toHaveBeenCalledTimes(1)
    const file = attachGenericFile.mock.calls[0]?.[1]
    expect(file?.name).toBe('picture.png')
    expect(file?.type).toBe('application/octet-stream')
    expect(String(fetchImpl.mock.calls[3]?.[1]?.body)).toContain('draft-ready')
    expect(notify).not.toHaveBeenCalled()
  })

  it('作用域未绑定时不原地自旋：条目延到下一轮 poll，且不建新会话（issue #1413）', async () => {
    const scope = {}
    let scopeReads = 0
    const oneItem = { items: [{
      entryId: 'opaque-entry', sessionId: 'session-abcdef12-2', state: 'session-created', name: 'notes.txt', bytes: 3,
    }] }
    const fetchImpl = vi.fn<IncomingDraftFetch>()
      .mockResolvedValueOnce(json(oneItem))          // 第一轮：只有列表
      .mockResolvedValueOnce(json(oneItem))          // 第二轮：列表
      .mockResolvedValueOnce(json({ ok: true, ticket: 'ticket-2', name: 'notes.txt' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ ok: true, state: 'draft-ready' }))
    const openSession = vi.fn()
    const attachGenericFile = vi.fn(() => true)
    const createSession = vi.fn(async () => 'session-created-unused')
    const consumer = new IncomingDraftConsumer(fetchImpl, {
      refreshSessions: async () => {},
      createSession,
      openSession,
      sessionScope: () => (++scopeReads > 1 ? scope : undefined),
      attachGenericFile,
      notify: vi.fn(),
    })

    await consumer.poll()
    // 第一轮：读到作用域缺失就返回 —— 不再自旋 100 次（旧实现最多 10s，期间整队列停摆）
    expect(scopeReads).toBe(1)
    expect(attachGenericFile).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('claim'))).toBe(false)
    // 也不得因为「作用域没绑」就去新建会话（那是 #1412 的空会话来源）
    expect(createSession).not.toHaveBeenCalled()

    // 第二轮：作用域就绪，条目照常完成
    await consumer.poll()
    expect(attachGenericFile).toHaveBeenCalledWith('session-abcdef12-2', expect.any(File))
  })

  it('uses the trusted incoming-workspace bridge to create a locally addressable blank Session', async () => {
    const previous = window.androidBridge
    window.androidBridge = { incomingWorkspacePath: () => '/data/user/0/example/incoming' }
    try {
      const scope = {}
      const fetchImpl = vi.fn<IncomingDraftFetch>()
        .mockResolvedValueOnce(json({ items: [{ entryId: 'received', state: 'received', name: 'report.pdf', bytes: 2 }] }))
        .mockResolvedValueOnce(json({ ok: true, ticket: 'ticket-received', name: 'report.pdf' }))
        .mockResolvedValueOnce(json({}))
        .mockResolvedValueOnce(json({ ok: true, state: 'draft-ready' }))
      const createSession = vi.fn(async () => 'session-created-0004')
      const refreshSessions = vi.fn(async () => {})
      const consumer = new IncomingDraftConsumer(fetchImpl, {
        refreshSessions,
        createSession,
        openSession: () => { throw new Error('navigation projection not ready') },
        sessionScope: () => scope,
        attachGenericFile: () => true,
        notify: vi.fn(),
      })

      await consumer.poll()

      expect(createSession).toHaveBeenCalledWith('/data/user/0/example/incoming')
      expect(refreshSessions).not.toHaveBeenCalled()
      expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).toContain('session-created-0004')
    } finally {
      window.androidBridge = previous
    }
  })

  it('releases the ticket as removed when the composer refuses the draft', async () => {
    const scope = {}
    const fetchImpl = vi.fn<IncomingDraftFetch>()
      .mockResolvedValueOnce(json({ items: [{
        entryId: 'opaque-entry', sessionId: 'session-abcdef12-3', state: 'session-created', name: 'notes.txt', bytes: 3,
      }] }))
      .mockResolvedValueOnce(json({ ok: true, ticket: 'ticket-3', name: 'notes.txt' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ ok: true, state: 'removed' }))
    const notify = vi.fn()
    const consumer = new IncomingDraftConsumer(fetchImpl, {
      refreshSessions: async () => {},
      createSession: async () => 'session-created-unused',
      openSession: vi.fn(),
      sessionScope: () => scope,
      attachGenericFile: () => false,
      notify,
    })

    await consumer.poll()

    expect(String(fetchImpl.mock.calls[3]?.[1]?.body)).toContain('removed')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  // review C10：无 sessionId 的补建必须有限次——旧实现每次轮询都重试，claim 持续失败时会
  // 反复新建 workspace/session。封顶后停止自动补建，并通过已建会话的 scope 提示一次。
  it('caps repeated hydration attempts and notifies once instead of looping forever', async () => {
    const previous = window.androidBridge
    window.androidBridge = { incomingWorkspacePath: () => '/data/user/0/example/incoming' }
    try {
      const scope = {}
      const fetchImpl = vi.fn<IncomingDraftFetch>(async (input: string) => {
        if (input === '/api/android/file-incoming') {
          return json({ items: [{ entryId: 'stuck', state: 'received', name: 'stuck.bin', bytes: 1 }] })
        }
        // claim/content/complete 永远失败：会话已建但草稿拿不到。
        return json({ ok: false, error: 'incoming entry not found' }, 404)
      })
      const createSession = vi.fn(async () => 'session-created-9999')
      const notify = vi.fn()
      const consumer = new IncomingDraftConsumer(fetchImpl, {
        refreshSessions: async () => {},
        createSession,
        openSession: vi.fn(),
        sessionScope: () => scope,
        attachGenericFile: () => true,
        notify,
      })

      for (let i = 0; i < 8; i += 1) await consumer.poll()

      expect(createSession).toHaveBeenCalledTimes(1)
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify.mock.calls[0]?.[1]).toContain('停止自动重试')
      expect(document.documentElement.getAttribute('data-dsh-incoming-draft-poll')).toBe('exhausted')
    } finally {
      window.androidBridge = previous
    }
  })
})

// ── 0.14.1 批 9（§3.3 S3-21）：拿不到临时工作区时不得静默丢弃 ──────────────────
describe('来件草稿的工作区不可用回执（S3-21）', () => {
  it('拿不到工作区路径时给出用户可见回执，且只给一次', async () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => { events.push(e as CustomEvent) }
    window.addEventListener('dsh:export-result', listener)
    window.androidBridge = { incomingWorkspacePath: () => '' } as never
    const fetchImpl = vi.fn<IncomingDraftFetch>().mockResolvedValue(json({ items: [{
      entryId: 'opaque-entry', state: 'received', name: 'photo.jpg', bytes: 11,
    }] }))
    const consumer = new IncomingDraftConsumer(fetchImpl, {
      refreshSessions: async () => {},
      createSession: async () => 'unused',
      openSession: () => {},
      sessionScope: () => ({}),
      attachGenericFile: () => true,
      notify: () => {},
    })

    await consumer.poll()
    // 旧实现：`if (cwd === '') return` —— 用户的分享就此消失，屏上什么都没有。
    expect(events.length, '必须给出一次可见回执').toBe(1)
    expect(String(events[0].detail.title)).toContain('分享进来的文件')
    expect(String(events[0].detail.detail)).toContain('重新分享')
    // 再轮询一次不得刷屏（同一 entryId 只提示一次）。
    await consumer.poll()
    expect(events.length, '同一文件只提示一次').toBe(1)
    window.removeEventListener('dsh:export-result', listener)
  })
})

describe('issue #1413 有界并发与队列积压', () => {
  it('runBounded 的并发不超过上限，且单条失败不影响同批其它条目', async () => {
    let inFlight = 0
    let peak = 0
    const done: number[] = []
    await runBounded([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      if (n === 2) throw new Error('single item failed')
      done.push(n)
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
    // 失败的那一条不吞掉其它条目
    expect(done).toEqual([1, 3, 4, 5, 6, 7, 8])
  })

  it('队列积压时新条目仍能投递：慢条目不阻塞同批的其它条目', async () => {
    const scope = {}
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>((r) => { releaseSlow = r })
    const attached: string[] = []
    const fetchImpl = vi.fn<IncomingDraftFetch>(async (url, init) => {
      const target = String(url)
      if (target === '/api/android/file-incoming') {
        return json({ items: [
          { entryId: 'slow', sessionId: 'session-slow-0001', state: 'session-created', name: 'slow.bin', bytes: 1 },
          { entryId: 'fast', sessionId: 'session-fast-0002', state: 'session-created', name: 'fast.bin', bytes: 1 },
        ] })
      }
      if (target === '/api/android/file-incoming/claim') {
        const body = String(init?.body ?? '')
        if (body.includes('slow')) { await slowGate; return json({ ok: true, ticket: 't-slow', name: 'slow.bin' }) }
        return json({ ok: true, ticket: 't-fast', name: 'fast.bin' })
      }
      if (target.startsWith('/api/android/file-incoming/content')) return json({})
      return json({ ok: true, state: 'draft-ready' })
    })
    const consumer = new IncomingDraftConsumer(fetchImpl, {
      refreshSessions: async () => {},
      createSession: async () => 'session-created-unused',
      openSession: () => {},
      sessionScope: () => scope,
      attachGenericFile: (_sessionId, file) => { attached.push(file.name); return true },
      notify: vi.fn(),
    })

    const polled = consumer.poll()
    // 慢条目还卡在 claim 上时，快条目必须已经投递完成
    await vi.waitFor(() => { expect(attached).toContain('fast.bin') }, { timeout: 2000 })
    expect(attached).not.toContain('slow.bin')
    releaseSlow()
    await polled
    expect(attached).toContain('slow.bin')
  })
})

describe('issue #1412 刷新失败不得丢掉 sessionId', () => {
  it('isTerminalStatus：只有 4xx（除 408/429）算终态，5xx/缺省算可重试', () => {
    expect(isTerminalStatus(403)).toBe(true)
    expect(isTerminalStatus(404)).toBe(true)
    expect(isTerminalStatus(400)).toBe(true)
    expect(isTerminalStatus(401)).toBe(true)
    expect(isTerminalStatus(408)).toBe(false)
    expect(isTerminalStatus(429)).toBe(false)
    expect(isTerminalStatus(500)).toBe(false)
    expect(isTerminalStatus(503)).toBe(false)
    expect(isTerminalStatus(undefined)).toBe(false)
  })

  it('isTerminalRefreshFailure：网络失败与超时都可重试，只有带 4xx 的错误才判死', () => {
    expect(isTerminalRefreshFailure(new Error('Failed to fetch'))).toBe(false)
    expect(isTerminalRefreshFailure(new TypeError('network'))).toBe(false)
    expect(isTerminalRefreshFailure({ status: 503 })).toBe(false)
    expect(isTerminalRefreshFailure({ statusCode: 403 })).toBe(true)
  })

  it('网络失败时保留条目自带的 sessionId，且**不**新建会话（一次分享不得产生空会话）', async () => {
    const scope = {}
    const oneItem = { items: [{
      entryId: 'e1', sessionId: 'session-original-01', state: 'session-created', name: 'a.txt', bytes: 1,
    }] }
    const fetchImpl = vi.fn<IncomingDraftFetch>()
      .mockResolvedValueOnce(json(oneItem))
      .mockResolvedValueOnce(json(oneItem))
      .mockResolvedValueOnce(json({ ok: true, ticket: 't1', name: 'a.txt' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ ok: true, state: 'draft-ready' }))
    let refreshCalls = 0
    const createSession = vi.fn(async () => 'session-created-unused')
    const attached: string[] = []
    const consumer = new IncomingDraftConsumer(fetchImpl, {
      refreshSessions: async () => { refreshCalls += 1; if (refreshCalls === 1) throw new Error('Failed to fetch') },
      createSession,
      openSession: () => {},
      sessionScope: () => scope,
      attachGenericFile: (sessionId) => { attached.push(String(sessionId)); return true },
      notify: vi.fn(),
    })

    await consumer.poll()
    // 第一轮：刷新网络失败 → 保留原 id、直接延后，不建新会话
    expect(createSession).not.toHaveBeenCalled()
    expect(attached).toEqual([])

    await consumer.poll()
    // 第二轮：刷新成功 → 用**原 id** 投递，仍不建新会话
    expect(createSession).not.toHaveBeenCalled()
    expect(attached).toEqual(['session-original-01'])
  })

  it('服务端明确拒绝（403）时才算 id 已死，走新建会话分支', async () => {
    const previous = window.androidBridge
    window.androidBridge = { incomingWorkspacePath: () => '/data/user/0/example/incoming' }
    try {
      const scope = {}
      const fetchImpl = vi.fn<IncomingDraftFetch>()
        .mockResolvedValueOnce(json({ items: [{
          entryId: 'e2', sessionId: 'session-dead-0002', state: 'session-created', name: 'b.txt', bytes: 1,
        }] }))
        .mockResolvedValueOnce(json({ ok: true, ticket: 't2', name: 'b.txt' }))
        .mockResolvedValueOnce(json({}))
        .mockResolvedValueOnce(json({ ok: true, state: 'draft-ready' }))
      const createSession = vi.fn(async () => 'session-created-0003')
      const consumer = new IncomingDraftConsumer(fetchImpl, {
        refreshSessions: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) },
        createSession,
        openSession: () => {},
        sessionScope: () => scope,
        attachGenericFile: () => true,
        notify: vi.fn(),
      })

      await consumer.poll()
      expect(createSession).toHaveBeenCalledTimes(1)
    } finally {
      window.androidBridge = previous
    }
  })
})
