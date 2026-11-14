// @vitest-environment jsdom
// 页面宿主 API（window.__dshOverlayHost）回归：
//   - 每个方法都必须返回**合法 JSON 字符串**（原生 evaluateJavascript 直接解码）；
//   - 页面未就绪/异常时返回 {ok:false,error}，绝不抛异常（抛出去原生拿到空值）；
//   - 数据只取页面真源，不猜（sessionId 读不到就空串，工作区不归属就空串）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { carrierFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { OverlayHost, installOverlayHost, OVERLAY_HOST_GLOBAL, readPageSessionId, type OverlayHostFaces } from '../src/client/mobile/overlay-host.ts'
import { createIncomingDraftRuntime } from '../src/client/mobile/incoming-runtime.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OverlayMenuSnapshot, OverlayMenuCandidate, OverlayMenuHit } from '../src/client/mobile/overlay-host.ts'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'

/** 一个可写的输入机桩：真的记录 setDraft/submit/removeAttachment 调用。 */
function fakeInput(options: { draft?: string; attachmentIds?: string[]; removeResult?: boolean } = {}) {
  const calls: string[] = []
  let state = { draft: options.draft ?? '', attachmentIds: options.attachmentIds ?? [] as string[] }
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const input = {
    state: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    setDraft(text: string) { calls.push('setDraft:' + text); state = { ...state, draft: text } },
    submit() { calls.push('submit') },
    removeAttachment(id: string) { calls.push('remove:' + id); if (options.removeResult === false) return false; state = { ...state, attachmentIds: state.attachmentIds.filter(a => a !== id) }; publish(); return true },
    addAttachments(ids: readonly string[]) { calls.push('add:' + ids.join(',')); state = { ...state, attachmentIds: [...state.attachmentIds, ...ids] }; publish(); return true },
  }
  return { input, calls, setState: (next: typeof state) => { state = next } }
}

const TITLE = '会话标题'
const WORKSPACE_ID = 'ws-1'

/** 标准服务面桩：一个会话 + 一个归属它的工作区 + 一份草稿与两个附件。 */
function standardFaces(input: ReturnType<typeof fakeInput>['input'], overrides: Partial<OverlayHostFaces> = {}): OverlayHostFaces {
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: ['s1', 's2'],
        byId: { s1: { title: TITLE, running: true }, s2: { title: '' } },
        phase: 'ready' as const,
      }),
    },
    scope: (id: string) => (id === 's1' ? { id } : undefined),
    sessionOf: () => ({ sessionId: 'agent-real' }),
  }
  const workspaces = {
    list: { getSnapshot: () => ({
      phase: 'ready' as const, state: 'idle' as const,
      items: [
        { workspaceId: WORKSPACE_ID, title: '工作区一', sessionIds: ['s1'] },
        { workspaceId: 'ws-2', title: '工作区二', sessionIds: [] },
      ],
    }) },
  }
  const conversation = {
    input: { for: () => input },
    sendSession: async () => ({ kind: 'success' as const }),
    resolveDraftAttachments: (ids: readonly string[]) => ids.map((id) => ({
      id,
      kind: id.startsWith('img') ? 'image' as const : 'file' as const,
      file: { name: id + '.bin' },
    })),
  }
  return {
    sessions: () => sessions,
    workspaces: () => workspaces,
    uiWorkspace: () => ({ openSession: () => {} }),
    conversation: () => conversation,
    ...overrides,
  }
}

function parse(raw: string): Record<string, unknown> {
  // 每个方法都必须能被 JSON.parse —— 这是「合法 JSON 字符串」契约的唯一判据。
  const parsed: unknown = JSON.parse(raw)
  expect(parsed !== null && typeof parsed === 'object').toBe(true)
  return parsed as Record<string, unknown>
}

beforeEach(() => {
  document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE)
})

describe('readPageSessionId / state', () => {
  it('sessionId 读页面既有会话标记（不与工作区/agentId 串用）', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    expect(readPageSessionId()).toBe('s1')
    document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE)
    expect(readPageSessionId()).toBe('')
  })

  it('state 返回会话/工作区/忙态/草稿/附件，全部来自页面真源', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const { input } = fakeInput({ draft: '半截草稿', attachmentIds: ['img-a', 'file-b'] })
    const host = new OverlayHost(standardFaces(input))
    const state = parse(host.state())
    expect(state.ok).toBe(true)
    expect(state.sessionId).toBe('s1')
    expect(state.sessionTitle).toBe(TITLE)
    expect(state.workspaceId).toBe(WORKSPACE_ID)
    expect(state.workspaceName).toBe('工作区一')
    expect(state.workspaces).toEqual([
      { id: 'ws-1', title: '工作区一' },
      { id: 'ws-2', title: '工作区二' },
    ])
    expect(state.busy).toBe(true)
    expect(state.draft).toBe('半截草稿')
    expect(state.attachments).toEqual([
      { id: 'img-a', name: 'img-a.bin', kind: 'image', thumbnail: '' },
      { id: 'file-b', name: 'file-b.bin', kind: 'file' },
    ])
  })

  it('没有会话标记时返回空串且不猜工作区（workspaces 仍给列表）', () => {
    const { input } = fakeInput()
    const host = new OverlayHost(standardFaces(input))
    const state = parse(host.state())
    expect(state.ok).toBe(true)
    expect(state.sessionId).toBe('')
    expect(state.sessionTitle).toBe('')
    expect(state.workspaceId).toBe('')
    expect(state.workspaceName).toBe('')
    expect(Array.isArray(state.workspaces)).toBe(true)
    expect(state.busy).toBe(false)
  })

  it('服务面抛异常时返回 ok:false + error，而不是抛出去', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const host = new OverlayHost(standardFaces(fakeInput().input, {
      sessions: () => ({ list: { getSnapshot: () => { throw new Error('boom') } } }),
    }))
    const state = parse(host.state())
    expect(state.ok).toBe(false)
    expect(String(state.error)).toContain('boom')
  })
})

describe('sessions', () => {
  it('返回列表快照里的 id/title（title 缺省为空串）', () => {
    const host = new OverlayHost(standardFaces(fakeInput().input))
    const payload = parse(host.sessions())
    expect(payload.ok).toBe(true)
    expect(payload.items).toEqual([
      { id: 's1', title: TITLE, agentId: 'agent-real' },
      { id: 's2', title: '', agentId: '' },
    ])
  })

  it('真的没有会话时 ok:true + 空数组', () => {
    const host = new OverlayHost({
      sessions: () => ({ list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' as const }) } }),
    })
    const payload = parse(host.sessions())
    expect(payload.ok).toBe(true)
    expect(payload.items).toEqual([])
  })

  it('列表还没拉到基线（phase=pending）时 ok:false，让原生退回 RPC', () => {
    const host = new OverlayHost({
      sessions: () => ({ list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'pending' as const }) } }),
    })
    const payload = parse(host.sessions())
    expect(payload.ok).toBe(false)
    expect(typeof payload.error).toBe('string')
  })

  it('会话服务不可读时 ok:false（不得编造空列表）', () => {
    const host = new OverlayHost({})
    const payload = parse(host.sessions())
    expect(payload.ok).toBe(false)
  })
})

describe('commands', () => {
  const twoCommands = [
    { name: 'cmd-a', label: '命令甲', description: '甲说明', section: '常用' },
    { name: 'cmd-b', label: '命令乙', description: '', section: '' },
  ]

  it('未读到时 ok:false（异步预取），读到后 ok:true 且逐条返回', async () => {
    const host = new OverlayHost({}, () => '', async () => twoCommands, () => true)
    const cold = parse(host.commandsJson())
    expect(cold.ok).toBe(false)
    expect(String(cold.error)).toBe('commands-not-ready')
    expect(await host.warmCommands()).toBe(true)
    const warm = parse(host.commandsJson())
    expect(warm.ok).toBe(true)
    expect(warm.items).toEqual(twoCommands)
  })

  it('页面没有合成器时报 composer-unavailable（不假装没有命令）', () => {
    const host = new OverlayHost({}, () => '', async () => [], () => false)
    const payload = parse(host.commandsJson())
    expect(payload.ok).toBe(false)
    expect(String(payload.error)).toBe('composer-unavailable')
  })

  it('读取失败保持未就绪（不拿空表冒充真源）', async () => {
    const host = new OverlayHost({}, () => '', async () => { throw new Error('nope') }, () => true)
    expect(await host.warmCommands()).toBe(false)
    expect(parse(host.commandsJson()).ok).toBe(false)
  })
})

async function settled(host: OverlayHost, raw: string) {
  const start = parse(raw)
  expect(start.pending).toBe(true)
  await vi.waitFor(() => { expect(parse(host.operation(start.operationId)).pending).not.toBe(true) })
  return parse(host.operation(start.operationId))
}

function officialFixture(initial: readonly OverlayMenuCandidate[], reference?: { ready: Promise<unknown>; release(): void }) {
  let items = initial
  const scope = {}, fake = fakeInput({ draft: 'keep @reference' })
  const input = { ...fake.input, state: { ...fake.input.state, getSnapshot: () => ({ ...fake.input.state.getSnapshot(), phase: 'plain', draftRev: 7 }) } }
  const menu = createSnapshotStore<OverlayMenuSnapshot>({ open: false, generation: 0, hit: null, groups: [] })
  const effects: string[] = []
  const dismiss = vi.fn(() => menu.set({ open: false, generation: menu.getSnapshot().generation, hit: null, groups: [] }))
  const controller = {
    menu, resolveClaim: async () => undefined, dismiss,
    toggleSource: vi.fn((_source: string, hit: OverlayMenuHit) => {
      const generation = menu.getSnapshot().generation + 1
      menu.set({ open: true, generation, hit, groups: [{ source: 'command', status: 'pending', items: [] }] })
      queueMicrotask(() => menu.set({ open: true, generation, hit, groups: [{ source: 'command', status: 'ready', items }] }))
    }),
    pick: vi.fn((_source: string, index: number) => {
      const item = menu.getSnapshot().groups[0]?.items[index]
      effects.push(item?.value ?? item?.name ?? 'missing')
      dismiss()
    }),
  }
  const host = new OverlayHost(standardFaces(input, {
    sessions: () => ({ scope: id => id === 's1' ? scope : undefined, sessionOf: () => ({ sessionId: 's1' }), ...(reference === undefined ? {} : { retain: () => reference }) }),
    commandController: () => controller,
  }))
  return { host, controller, menu, fake, effects, update: (next: readonly OverlayMenuCandidate[]) => { items = next } }
}

describe('official command menu API', () => {
  it('filters only exact shared attachment titles from official rows, preserving file-like real commands', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fixture = officialFixture([
      { name: 'file', label: '文件' },
      { name: '/FILES', label: 'Attachment picker' },
      { name: 'native-picker', label: '  Local File  ' },
      { name: 'file-preview', label: '文件预览' },
      { name: 'file-management', label: 'File management' },
      { name: 'goal', label: '目标' },
    ])
    expect(await fixture.host.warmCommands()).toBe(true)
    expect((parse(fixture.host.commandsJson()).items as Array<{ name: string }>).map(item => item.name)).toEqual(['/file-preview', '/file-management', '/goal'])
    expect(fixture.fake.calls).toEqual([])
  })
  it('bounded Session.ready reports session-not-ready and releases; later ready permits a fresh real directory', async () => {
    vi.useFakeTimers()
    try {
      document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
      let finishReady!: () => void
      const reference = { ready: new Promise<void>(resolve => { finishReady = resolve }), release: vi.fn() }
      const fixture = officialFixture([{ name: 'goal' }], reference)
      const cold = fixture.host.warmCommands()
      await vi.advanceTimersByTimeAsync(4001)
      expect(await cold).toBe(false)
      expect(reference.release).toHaveBeenCalledOnce()
      expect(fixture.controller.toggleSource).not.toHaveBeenCalled()
      const retrying = parse(fixture.host.commandsJson())
      expect(retrying).toMatchObject({ ok: false, error: 'session-not-ready' })
      expect(retrying.items).toBeUndefined()
      finishReady()
      await vi.advanceTimersByTimeAsync(0)
      expect(await fixture.host.warmCommands()).toBe(true)
      expect(parse(fixture.host.commandsJson()).items).toEqual([{ name: '/goal', label: 'goal', description: '', section: '' }])
      expect(reference.release.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally { vi.useRealTimers() }
  })
  it('pending source timeout aborts borrow without caching an empty directory', async () => {
    vi.useFakeTimers()
    try {
      document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
      const fixture = officialFixture([{ name: 'goal' }])
      fixture.controller.toggleSource.mockImplementation((_source, hit) => fixture.menu.set({ open: true, generation: 1, hit, groups: [{ source: 'command', status: 'pending', items: [] }] }))
      const warming = fixture.host.warmCommands()
      await vi.advanceTimersByTimeAsync(4100)
      expect(await warming).toBe(false)
      expect(fixture.controller.dismiss).toHaveBeenCalledOnce()
      expect(parse(fixture.host.commandsJson()).ok).toBe(false)
      await vi.advanceTimersByTimeAsync(4100)
    } finally { vi.useRealTimers() }
  })

  it('source failure and user takeover never become success or dismiss the replacement menu', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fixture = officialFixture([{ name: 'goal' }])
    fixture.controller.toggleSource.mockImplementation((_source, hit) => {
      fixture.menu.set({ open: true, generation: 1, hit, groups: [{ source: 'command', status: 'pending', items: [] }] })
      queueMicrotask(() => fixture.menu.set({ open: true, generation: 2, hit: { ...hit }, groups: [{ source: 'other', status: 'ready', items: [] }] }))
    })
    expect(await fixture.host.warmCommands()).toBe(false)
    expect(fixture.controller.dismiss).not.toHaveBeenCalled()
    expect(fixture.menu.getSnapshot().generation).toBe(2)
    expect(parse(fixture.host.commandsJson()).ok).toBe(false)
  })

  it('hidden command selection waits for main page visibility before official pick', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fixture = officialFixture([{ name: 'model', value: 'popup' }])
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const pending = parse(fixture.host.execute('/model', 's1'))
    await Promise.resolve(); await Promise.resolve()
    expect(fixture.controller.pick).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(parse(fixture.host.operation(pending.operationId)).ok).toBe(true))
    expect(fixture.effects).toEqual(['popup'])
  })
  it('reads dynamic official candidates in hidden page without any composer DOM or focus', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    document.body.innerHTML = ''
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const fixture = officialFixture([{ name: 'goal', label: '目标', description: 'desc', value: 'host-input' }])
    try {
      expect(await fixture.host.warmCommands()).toBe(true)
      expect(parse(fixture.host.commandsJson()).items).toEqual([{ name: '/goal', label: '目标', description: 'desc', section: '' }])
      expect(fixture.controller.toggleSource.mock.calls[0]?.[1].span).toEqual({ start: 0, end: 0, draftRev: 7 })
      expect(fixture.fake.calls).toEqual([])
      expect(fixture.controller.dismiss).toHaveBeenCalledOnce()
      fixture.update([{ name: 'new-plugin', label: '新命令' }])
      await fixture.host.refreshCommands()
      expect(parse(fixture.host.commandsJson()).items).toEqual([{ name: '/new-plugin', label: '新命令', description: '', section: '' }])
    } finally { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) }
  })

  it('never steals or dismisses an already open user menu', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fixture = officialFixture([{ name: 'goal' }])
    fixture.menu.set({ open: true, generation: 3, hit: null, groups: [] })
    expect(await fixture.host.warmCommands()).toBe(false)
    expect(parse(fixture.host.commandsJson()).error).toBe('commands-menu-busy')
    expect(fixture.controller.toggleSource).not.toHaveBeenCalled()
    expect(fixture.controller.dismiss).not.toHaveBeenCalled()
  })

  it('hands input popup action and bare-host candidates through official pick with canonical identity', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fixture = officialFixture([
      { name: 'goal', label: '目标', value: 'input-prepare' },
      { name: 'model', label: '模型', value: 'popup-open' },
      { name: 'clear', label: '清屏', value: 'client-action' },
      { name: 'compact', label: '压缩', value: 'host-detached' },
    ])
    for (const name of ['goal', 'model', 'clear', 'compact']) {
      const result = await settled(fixture.host, fixture.host.execute('/' + name, 's1'))
      expect(result).toMatchObject({ ok: true, handedOff: true })
    }
    expect(fixture.effects).toEqual(['input-prepare', 'popup-open', 'client-action', 'host-detached'])
    expect(fixture.fake.calls).toEqual([])
    expect(fixture.fake.input.state.getSnapshot().draft).toBe('keep @reference')
  })
})

describe('operation safety regressions', () => {
  it('attachment A survives send rejection after switching to B by transferring exact send reference back to rail keeper', async () => {
    let active = 's1', refs = 0, retired = false
    const scope = {}, session = { sessionId: 's1' }
    const rail = createSnapshotStore({ draft: 'keep @refs', phase: 'plain', attachmentIds: [] as string[] })
    const input = {
      state: rail, notify() {}, setDraft() {}, submit() {},
      addAttachments(ids: readonly string[]) { rail.set({ ...rail.getSnapshot(), attachmentIds: [...rail.getSnapshot().attachmentIds, ...ids] }); return true },
      removeAttachment(id: string) { rail.set({ ...rail.getSnapshot(), attachmentIds: rail.getSnapshot().attachmentIds.filter(x => x !== id) }); return true },
    }
    const sessions = {
      refresh: async () => {}, scope: () => retired ? undefined : scope, sessionOf: () => session,
      retain: () => { refs++; let done = false; return { binding: { ctx: scope, session }, ready: Promise.resolve({}), release: () => { if (!done) { done = true; refs--; if (refs === 0 && active !== 's1') { retired = true; rail.set({ ...rail.getSnapshot(), attachmentIds: [] }) } } } } },
    }
    let respond!: (value: { kind: 'error' }) => void
    const conversation = { input: { for: () => input }, createDrafts: () => [{ id: 'picked-A' }], sendSession: () => new Promise<{ kind: 'error' }>(resolve => { respond = resolve }) }
    const runtime = createIncomingDraftRuntime({ sessions: () => sessions, workspaces: () => ({ create: async () => ({ workspaceId: 'w' }) }), uiWorkspace: () => ({ connectWorkspace: async () => 's1', openSession() {} }), conversation: () => conversation })
    const handoff = await runtime.retainSession!('s1')
    expect(runtime.attachGenericFile('s1', new File(['x'], 'a.txt'))).toBe(true)
    handoff()
    const host = new OverlayHost({ sessions: () => sessions, conversation: () => conversation }, () => active)
    const pending = parse(host.send('message', 's1'))
    active = 's2'
    await vi.waitFor(() => expect(respond).toBeDefined())
    respond({ kind: 'error' })
    await vi.waitFor(() => expect(parse(host.operation(pending.operationId)).ok).toBe(false))
    expect(retired).toBe(false)
    expect(refs).toBe(1)
    active = 's1'
    expect(rail.getSnapshot().attachmentIds).toEqual(['picked-A'])
    expect(rail.getSnapshot().draft).toBe('keep @refs')
    input.removeAttachment('picked-A')
    expect(refs).toBe(0)
    host.dispose(); runtime.dispose?.()
  })
  it('unready file upload is a known refusal before detachment, not an unknown transport attempt', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ attachmentIds: ['file-a'] }), sendSession = vi.fn()
    const host = new OverlayHost(standardFaces(fake.input, { conversation: () => ({
      input: { for: () => fake.input }, sendSession,
      resolveDraftAttachments: () => [{ id: 'file-a', kind: 'file' }],
      fileUploads: { getSnapshot: () => ({ 'file-a': { status: 'uploading' as const } }) },
    }) }))
    expect(parse(host.send('x')).error).toBe('attachment-not-ready')
    expect(fake.calls).toEqual([])
    expect(fake.input.state.getSnapshot().attachmentIds).toEqual(['file-a'])
    expect(sendSession).not.toHaveBeenCalled()
  })

  it('retained generation must match the scope and captured Session before any send', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ attachmentIds: ['file-a'] }), release = vi.fn(), sendSession = vi.fn()
    const host = new OverlayHost(standardFaces(fake.input, {
      sessions: () => ({ scope: () => ({}), sessionOf: () => ({ sessionId: 's1' }), retain: () => ({ binding: { ctx: {}, session: {} }, ready: Promise.resolve({}), release }) }),
      conversation: () => ({ input: { for: () => fake.input }, sendSession }),
    }))
    const result = await settled(host, host.send('x'))
    expect(result.error).toBe('session-generation-changed')
    expect(fake.input.state.getSnapshot().attachmentIds).toEqual(['file-a'])
    expect(sendSession).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce()
  })
  it('uses actual workspaces.list lifecycle; pending/error are unavailable and later baseline refreshes', () => {
    let snapshot = { items: [{ workspaceId: 'real-w', sessionIds: ['s1'] }], phase: 'pending' as 'pending' | 'ready', state: 'loading' as 'loading' | 'idle' | 'error' }
    const host = new OverlayHost(standardFaces(fakeInput().input, { workspaces: () => ({ list: { getSnapshot: () => snapshot } }) }))
    expect(parse(host.state()).workspacesReady).toBe(false)
    expect(parse(host.openWorkspace('real-w')).error).toBe('workspaces-not-ready')
    snapshot = { ...snapshot, phase: 'ready', state: 'error' }
    expect(parse(host.state()).workspacesError).toBe('workspaces-error')
    snapshot = { ...snapshot, state: 'idle' }
    expect(parse(host.state()).workspacesReady).toBe(true)
    expect(parse(host.state()).workspaces).toEqual([{ id: 'real-w', title: '' }])
  })

  it('instance nonce prevents a reloaded host from settling an old operation ticket', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const first = new OverlayHost(standardFaces(fakeInput().input))
    const second = new OverlayHost(standardFaces(fakeInput().input))
    const a = parse(first.send('first')), b = parse(second.send('second'))
    expect(a.operationId).not.toBe(b.operationId)
    expect(parse(second.operation(a.operationId))).toMatchObject({ pending: true, unknown: true, error: 'operation-not-found' })
    await settled(first, JSON.stringify(a)); await settled(second, JSON.stringify(b))
  })

  it('command timeout remains unknown and deduplicated, then settles its original ticket on late success', async () => {
    vi.useFakeTimers()
    try {
      document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
      let finish!: (value: { kind: 'success' }) => void
      const submit = vi.fn(() => new Promise<{ kind: 'success' }>(resolve => { finish = resolve }))
      const host = new OverlayHost(standardFaces(fakeInput().input, { commandController: () => ({ resolveClaim: async () => ({ submit }) }) }))
      const first = parse(host.execute('/cmd', 's1'))
      await vi.advanceTimersByTimeAsync(26000)
      expect(parse(host.operation(first.operationId))).toMatchObject({ pending: true, unknown: true })
      expect(parse(host.execute('/cmd', 's1')).operationId).toBe(first.operationId)
      expect(submit).toHaveBeenCalledOnce()
      finish({ kind: 'success' }); await vi.advanceTimersByTimeAsync(0)
      expect(parse(host.operation(first.operationId)).ok).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('detached attachments cannot be sent by page in parallel; explicit refusal restores without replacing new rail', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ draft: 'keep @refs', attachmentIds: ['old'] })
    let finish!: (value: { kind: 'error' }) => void
    const sendSession = vi.fn(() => new Promise<{ kind: 'error' }>(resolve => { finish = resolve }))
    const host = new OverlayHost(standardFaces(fake.input, { conversation: () => ({ input: { for: () => fake.input }, sendSession }) }))
    const pending = parse(host.send('overlay'))
    expect(fake.input.state.getSnapshot().attachmentIds).toEqual([])
    fake.input.addAttachments(['new'])
    expect(parse(host.send('overlay')).operationId).toBe(pending.operationId)
    expect(parse(host.send('different')).error).toBe('composer-busy')
    await vi.waitFor(() => expect(sendSession).toHaveBeenCalledOnce())
    finish({ kind: 'error' })
    await vi.waitFor(() => expect(parse(host.operation(pending.operationId)).ok).toBe(false))
    expect(fake.input.state.getSnapshot()).toEqual({ draft: 'keep @refs', attachmentIds: ['new', 'old'] })
  })

  it('an invocation throwing a transport error stays unknown and cannot be retried with same ticket key', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const submit = vi.fn(async () => { throw new Error('connection lost after commit') })
    const host = new OverlayHost(standardFaces(fakeInput().input, { commandController: () => ({ resolveClaim: async () => ({ submit }) }) }))
    const pending = parse(host.execute('/cmd'))
    await vi.waitFor(() => expect(parse(host.operation(pending.operationId)).unknown).toBe(true))
    expect(parse(host.execute('/cmd')).operationId).toBe(pending.operationId)
    expect(submit).toHaveBeenCalledOnce()
  })
})

describe('real admission semantics', () => {
  it('send waits for Host outcome and preserves page draft and references; no void submit', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ draft: 'existing @reference', attachmentIds: ['img-a'] })
    let finish!: (outcome: { kind: 'success' | 'error' }) => void
    const sendSession = vi.fn(() => new Promise<{ kind: 'success' | 'error' }>(resolve => { finish = resolve }))
    const host = new OverlayHost(standardFaces(fake.input, { conversation: () => ({ input: { for: () => fake.input }, sendSession }) }))
    const pending = parse(host.send('overlay message', 's1'))
    await vi.waitFor(() => expect(sendSession).toHaveBeenCalledTimes(1))
    expect(parse(host.operation(pending.operationId)).pending).toBe(true)
    expect(fake.calls).toEqual(['remove:img-a'])
    expect(fake.input.state.getSnapshot().attachmentIds).toEqual([])
    expect(fake.input.state.getSnapshot().draft).toBe('existing @reference')
    finish({ kind: 'error' })
    await vi.waitFor(() => expect(parse(host.operation(pending.operationId)).ok).toBe(false))
    expect(fake.calls).toEqual(['remove:img-a', 'add:img-a'])
    expect(fake.input.state.getSnapshot().attachmentIds).toEqual(['img-a'])
    expect(sendSession.mock.calls[0]?.slice(0, 4)).toEqual([{ sessionId: 'agent-real' }, 'overlay message', ['img-a'], 'queue'])
  })

  it('send success removes only captured attachment IDs; wrong target and empty send fail', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ draft: 'not mine', attachmentIds: ['img-a'] })
    const host = new OverlayHost(standardFaces(fake.input))
    expect(parse(host.send('x', 's2')).error).toBe('session-mismatch')
    expect((await settled(host, host.send('x', 's1'))).ok).toBe(true)
    expect(fake.calls).toEqual(['remove:img-a'])
    expect(parse(new OverlayHost(standardFaces(fakeInput().input)).send('')).ok).toBe(false)
  })

  it('command awaits real scoped claim failure and never touches draft or attachments', async () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ draft: 'keep me', attachmentIds: ['img-a'] })
    const submit = vi.fn(async () => ({ kind: 'error' as const, text: 'invalid arguments' }))
    const resolveClaim = vi.fn(async () => ({ submit }))
    const host = new OverlayHost(standardFaces(fake.input, { commandController: () => ({ resolveClaim }) }))
    expect(parse(host.execute('/cmd', 's2')).ok).toBe(false)
    const result = await settled(host, host.execute('/cmd args', 's1'))
    expect(result).toMatchObject({ ok: false, error: 'invalid arguments' })
    expect(submit).toHaveBeenCalledWith('args', { id: 's1' }, [])
    expect(fake.calls).toEqual([])
    expect(parse(host.execute('plain message')).ok).toBe(false)
  })

  it('removes by stable id after order changes, not stale index', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ attachmentIds: ['img-a', 'file-b'] })
    const host = new OverlayHost(standardFaces(fake.input))
    fake.setState({ draft: '', attachmentIds: ['file-b', 'img-a'] })
    expect(parse(host.removeAttachment('file-b')).ok).toBe(true)
    expect(fake.calls).toEqual(['remove:file-b'])
    expect(parse(host.removeAttachment(1)).ok).toBe(false)
    expect(parse(host.removeAttachment('missing')).ok).toBe(false)
  })

  it('returns attachment refusal and validates navigation catalog', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const host = new OverlayHost(standardFaces(fakeInput({ attachmentIds: ['a'], removeResult: false }).input))
    expect(parse(host.removeAttachment('a')).ok).toBe(false)
    expect(parse(host.openSession('s2')).ok).toBe(true)
    expect(parse(host.openSession('missing')).ok).toBe(false)
  })

  it('workspace uses awaited real navigation instead of arbitrary member session', async () => {
    const openWorkspace = vi.fn(async () => {})
    const host = new OverlayHost(standardFaces(fakeInput().input, { uiWorkspace: () => ({ openSession() {}, openWorkspace }) }))
    expect((await settled(host, host.openWorkspace('ws-2'))).ok).toBe(true)
    expect(openWorkspace).toHaveBeenCalledWith('ws-2')
    expect(parse(host.openWorkspace('absent')).ok).toBe(false)
  })

  it('cold warmup is retryable and later catalog changes refresh', async () => {
    let ready = false; let name = 'first'
    const read = vi.fn(async () => [{ name, label: name, description: '', section: '' }])
    const host = new OverlayHost({}, () => '', read, () => ready)
    expect(await host.warmCommands()).toBe(false)
    expect(read).not.toHaveBeenCalled()
    ready = true
    expect(await host.warmCommands()).toBe(true)
    name = 'changed'
    await host.refreshCommands()
    expect(parse(host.commandsJson()).items).toEqual([{ name, label: name, description: '', section: '' }])
  })
})

describe('background attachment admission without a visual frame', () => {
  function fixture(reply: () => Promise<{ ok: boolean; value?: { accepted?: boolean }; error?: { code?: string; message?: string } }>) {
    const fake = fakeInput({ draft: 'keep @refs', attachmentIds: ['file-a'] })
    const scope = {}, prompt = vi.fn(reply), session = { sessionId: 's1', prompt }, release = vi.fn()
    const sendSession = vi.fn(async () => ({ kind: 'error' as const })), releaseDraftAttachment = vi.fn()
    const serializeDraftAttachments = vi.fn(async () => ({ attachments: [{ type: 'file', receiptId: 'receipt-a' }] }))
    const host = new OverlayHost({
      sessions: () => ({ scope: () => scope, sessionOf: () => session, retain: () => ({ binding: { ctx: scope, session }, ready: Promise.resolve({}), release }) }),
      conversation: () => ({ input: { for: () => fake.input }, sendSession, serializeDraftAttachments, releaseDraftAttachment }),
    }, () => 's1')
    return { host, fake, prompt, sendSession, serializeDraftAttachments, releaseDraftAttachment }
  }
  it('hidden page with no RAF still submits captionless file through exact Session and fixed requestId', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    try {
      const f = fixture(async () => ({ ok: true, value: { accepted: true } }))
      expect((await settled(f.host, f.host.send('', 's1'))).ok).toBe(true)
      expect(f.sendSession).not.toHaveBeenCalled()
      expect(f.prompt).toHaveBeenCalledOnce()
      const args = f.prompt.mock.calls[0] as unknown as unknown[]
      expect(args.slice(0, 2)).toEqual([[{ type: 'file', receiptId: 'receipt-a' }], 'queue'])
      expect(typeof args[3]).toBe('string')
      expect(f.releaseDraftAttachment).toHaveBeenCalledWith('file-a')
      expect(f.fake.input.state.getSnapshot().draft).toBe('keep @refs')
    } finally { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) }
  })
  it('explicit image capability rejection preserves original code/message and restores the exact rail', async () => {
    const f = fixture(async () => ({ ok: false, error: { code: 'session/attachment-invalid', message: 'Model does not support images' } }))
    const result = await settled(f.host, f.host.send('', 's1'))
    expect(result.ok).toBe(false); expect(result.error).toContain('session/attachment-invalid')
    expect(result.error).toContain('does not support images')
    expect(f.fake.input.state.getSnapshot().attachmentIds).toEqual(['file-a'])
    expect(f.releaseDraftAttachment).not.toHaveBeenCalled(); f.host.dispose()
  })
  it('HTTP-like ok without literal accepted cannot settle and cannot submit twice', async () => {
    const f = fixture(async () => ({ ok: true, value: { accepted: false } }))
    const ticket = parse(f.host.send('', 's1'))
    await vi.waitFor(() => expect(parse(f.host.operation(ticket.operationId)).unknown).toBe(true))
    expect(parse(f.host.send('', 's1')).operationId).toBe(ticket.operationId)
    expect(f.prompt).toHaveBeenCalledOnce(); expect(f.releaseDraftAttachment).not.toHaveBeenCalled()
  })
  it('transport after invocation remains unknown rather than restoring and resending the batch', async () => {
    const f = fixture(async () => { throw new Error('lost receipt after commit') })
    const ticket = parse(f.host.send('message', 's1'))
    await vi.waitFor(() => expect(parse(f.host.operation(ticket.operationId)).unknown).toBe(true))
    expect(f.fake.input.state.getSnapshot().attachmentIds).toEqual([])
    expect(parse(f.host.send('message', 's1')).operationId).toBe(ticket.operationId)
    expect(f.prompt).toHaveBeenCalledOnce()
  })
})

describe('unknown attachment admission safety', () => {
  const hosts: OverlayHost[] = []
  afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
  type Reply = { ok: boolean; value?: { accepted?: boolean }; error?: { code?: string; message?: string } }
  function fixture(reply: () => Promise<Reply>, options: { ready?: Promise<unknown>; serialize?: () => Promise<{ attachments: readonly unknown[] }> } = {}) {
    const fake = fakeInput({ draft: 'original @refs', attachmentIds: ['captured-a'] })
    const scope = {}, prompt = vi.fn(reply), session = { sessionId: 's1', prompt }, release = vi.fn()
    const sendSession = vi.fn(async () => ({ kind: 'error' as const })), releaseDraftAttachment = vi.fn()
    const serializeDraftAttachments = vi.fn(options.serialize ?? (async () => ({ attachments: [{ type: 'file', receiptId: 'receipt-a' }] })))
    const host = new OverlayHost({
      sessions: () => ({ scope: () => scope, sessionOf: () => session, retain: () => ({ binding: { ctx: scope, session }, ready: options.ready ?? Promise.resolve({}), release }) }),
      conversation: () => ({ input: { for: () => fake.input }, sendSession, serializeDraftAttachments, releaseDraftAttachment }),
    }, () => 's1')
    hosts.push(host)
    return { host, fake, prompt, sendSession, serializeDraftAttachments, releaseDraftAttachment, release }
  }
  const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
  function stubProof(reply: (method: string, requestId: string, rpcId: string) => unknown | Promise<unknown>) {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string; rpcId: string; payload: { args: { request: { sessionId?: string; address?: { sessionId: string } } } } }
      expect(url).toBe('/api/' + request.method)
      expect(init.credentials).toBe('same-origin')
      expect(init.headers).toEqual({ 'content-type': 'application/json' })
      expect(request.payload.args.request.sessionId ?? request.payload.args.request.address?.sessionId).toBe('s1')
      expect(['session/state', 'session/events']).toContain(request.method)
      return { ok: true, json: async () => reply(request.method, 'unused', request.rpcId) }
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }
  it('actual rc.1 carrierFailure is unknown, retains detached batch and never mints a second prompt', async () => {
    const f = fixture(async () => carrierFailure('session/prompt', new Error('lost receipt after Host commit')))
    const ticket = parse(f.host.send('', 's1'))
    await flush()
    expect(parse(f.host.operation(ticket.operationId))).toMatchObject({ pending: true, unknown: true, operationId: ticket.operationId })
    expect(parse(f.host.send('', 's1')).operationId).toBe(ticket.operationId)
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.fake.input.state.getSnapshot().attachmentIds).toEqual([])
    expect(f.releaseDraftAttachment).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled()
  })
  it.each(['gateway/cancelled', 'gateway/unmounted', 'gateway/new-code', undefined, ''])('ambiguous error %s cannot restore or unlock', async code => {
    const f = fixture(async () => ({ ok: false, error: { code, message: 'no reliable Host refusal' } }))
    const ticket = parse(f.host.send('body', 's1')); await flush()
    expect(parse(f.host.operation(ticket.operationId)).unknown).toBe(true)
    expect(parse(f.host.send('body', 's1')).operationId).toBe(ticket.operationId)
    expect(f.fake.calls).toEqual(['remove:captured-a']); expect(f.prompt).toHaveBeenCalledOnce()
  })
  it('ready timeout before RPC restores exact rail and keeper; late ready never invokes', async () => {
    vi.useFakeTimers()
    let ready!: () => void
    const f = fixture(async () => ({ ok: true, value: { accepted: true } }), { ready: new Promise<void>(resolve => { ready = resolve }) })
    const ticket = parse(f.host.send('body', 's1')); await flush()
    await vi.advanceTimersByTimeAsync(4000); await flush()
    expect(parse(f.host.operation(ticket.operationId))).toMatchObject({ ok: false })
    expect(String(parse(f.host.operation(ticket.operationId)).error)).toContain('session-not-ready')
    expect(f.fake.input.state.getSnapshot()).toEqual({ draft: 'original @refs', attachmentIds: ['captured-a'] })
    expect(f.prompt).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled()
    ready(); await flush(); expect(f.prompt).not.toHaveBeenCalled()
    f.fake.input.removeAttachment('captured-a'); expect(f.release).toHaveBeenCalledOnce()
    f.host.dispose(); expect(f.release).toHaveBeenCalledOnce()
  })
  it('serialization timeout is a pre-admission failure and cannot later submit the batch', async () => {
    vi.useFakeTimers()
    let serialized!: (value: { attachments: readonly unknown[] }) => void
    const f = fixture(async () => ({ ok: true, value: { accepted: true } }), { serialize: () => new Promise(resolve => { serialized = resolve }) })
    const ticket = parse(f.host.send('', 's1')); await flush()
    await vi.advanceTimersByTimeAsync(8000); await flush()
    expect(parse(f.host.operation(ticket.operationId)).ok).toBe(false)
    expect(String(parse(f.host.operation(ticket.operationId)).error)).toContain('attachment-serialization-timeout')
    expect(f.fake.input.state.getSnapshot().attachmentIds).toEqual(['captured-a'])
    serialized({ attachments: [{ type: 'file', receiptId: 'late' }] }); await flush()
    expect(f.prompt).not.toHaveBeenCalled(); expect(f.releaseDraftAttachment).not.toHaveBeenCalled()
  })
  it('read-only state proof settles the original ticket and only captured IDs, preserving newer draft', async () => {
    const f = fixture(async () => carrierFailure('session/prompt', new Error('lost')))
    const ticket = parse(f.host.send('', 's1')); await flush()
    const requestId = (f.prompt.mock.calls[0] as unknown as unknown[])[3]
    f.fake.input.setDraft('new @draft'); f.fake.input.addAttachments(['new-b'])
    const fetcher = stubProof((_method, _request, rpcId) => ({ type: 'server-response', rpcId, result: { ok: true, value: { queue: [{ rpcId: requestId }] } } }))
    f.host.operation(ticket.operationId); await flush()
    expect(parse(f.host.operation(ticket.operationId))).toMatchObject({ ok: true, requestId })
    expect(fetcher).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.releaseDraftAttachment.mock.calls).toEqual([['captured-a']])
    expect(f.fake.input.state.getSnapshot()).toEqual({ draft: 'new @draft', attachmentIds: ['new-b'] })
    f.fake.input.removeAttachment('new-b'); expect(f.release).toHaveBeenCalledOnce()
    expect(parse(f.host.send('another', 's1')).error).not.toBe('composer-busy')
  })
  it('durable exact user/message evidence recovers even if state queue no longer contains it', async () => {
    const f = fixture(async () => carrierFailure('session/prompt', new Error('lost')))
    const ticket = parse(f.host.send('', 's1')); await flush()
    const requestId = (f.prompt.mock.calls[0] as unknown as unknown[])[3]
    const fetcher = stubProof((method, _request, rpcId) => ({ type: 'server-response', rpcId, result: { ok: true, value: method === 'session/state' ? { queue: [] } : { records: [{ type: 'event', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } }] } } }))
    f.host.operation(ticket.operationId); await flush()
    expect(parse(f.host.operation(ticket.operationId)).ok).toBe(true)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/session/state', '/api/session/events'])
    expect(f.release).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce()
  })
  it.each(['wrong-request', 'wrong-rpc-envelope', 'wrong-wire-type', 'string-ok', 'wrong-event-kind'])('rejects %s evidence without restoring or resending', async invalid => {
    const f = fixture(async () => carrierFailure('session/prompt', new Error('lost')))
    const ticket = parse(f.host.send('', 's1')); await flush()
    const requestId = (f.prompt.mock.calls[0] as unknown as unknown[])[3]
    const fetcher = stubProof((method, _request, rpcId) => ({ type: invalid === 'wrong-wire-type' ? 'client-response' : 'server-response', rpcId: invalid === 'wrong-rpc-envelope' ? 'someone-else' : rpcId,
      result: { ok: invalid === 'string-ok' ? 'true' : true, value: method === 'session/state' ? { queue: [] } : { records: [{ type: 'event', event: { type: 'user/message', data: { source: { kind: invalid === 'wrong-event-kind' ? 'tool' : 'user', rpcId: invalid === 'wrong-request' ? 'another-request' : requestId } } } }] } } }))
    f.host.operation(ticket.operationId); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    // send() reads the same cached pending ticket without initiating another query or POST.
    expect(parse(f.host.send('', 's1'))).toMatchObject({ pending: true, unknown: true, operationId: ticket.operationId })
    expect(f.prompt).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled(); expect(f.fake.input.state.getSnapshot().attachmentIds).toEqual([])
  })
  it('each query has a 2.5s bound and concurrent rechecks do not overlap or poll', async () => {
    vi.useFakeTimers()
    const f = fixture(async () => carrierFailure('session/prompt', new Error('lost')))
    const ticket = parse(f.host.send('', 's1')); await flush()
    const signals: AbortSignal[] = []
    const fetcher = vi.fn((_url: string, init: RequestInit) => { signals.push(init.signal as AbortSignal); return new Promise<never>(() => {}) })
    vi.stubGlobal('fetch', fetcher)
    f.host.operation(ticket.operationId); f.host.operation(ticket.operationId); await flush()
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(signals[0].aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(signals[1].aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10000); expect(fetcher).toHaveBeenCalledTimes(2)
    expect(parse(f.host.send('', 's1')).operationId).toBe(ticket.operationId)
  })
  it('dispose aborts inflight read observers and releases unknown exact reference exactly once', async () => {
    const f = fixture(async () => carrierFailure('session/prompt', new Error('lost')))
    const ticket = parse(f.host.send('', 's1')); await flush()
    let signal!: AbortSignal
    const fetcher = vi.fn((_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise<never>(() => {}) })
    vi.stubGlobal('fetch', fetcher)
    f.host.operation(ticket.operationId); await flush()
    f.host.dispose(); await flush(); f.host.dispose()
    expect(signal.aborted).toBe(true); expect(f.release).toHaveBeenCalledOnce()
    expect(f.releaseDraftAttachment).not.toHaveBeenCalled()
    f.host.operation(ticket.operationId); await flush(); expect(fetcher).toHaveBeenCalledOnce()
    expect(parse(f.host.send('new', 's1')).error).toBe('host-disposed')
  })
  it('proof can settle an open carrier and the late old result cannot unlock a newer send', async () => {
    vi.useFakeTimers()
    let oldReply!: (reply: Reply) => void
    const f = fixture(() => new Promise(resolve => { oldReply = resolve }))
    const ticket = parse(f.host.send('', 's1')); await flush()
    const requestId = (f.prompt.mock.calls[0] as unknown as unknown[])[3]
    stubProof((_method, _request, rpcId) => ({ type: 'server-response', rpcId, result: { ok: true, value: { queue: [{ rpcId: requestId }] } } }))
    f.host.operation(ticket.operationId); await flush()
    expect(parse(f.host.operation(ticket.operationId)).ok).toBe(true)
    f.fake.input.addAttachments(['new-b'])
    const replyToOld = oldReply
    const newer = parse(f.host.send('', 's1')); await flush()
    expect(newer.operationId).not.toBe(ticket.operationId)
    replyToOld(carrierFailure('session/prompt', new Error('late old fault'))); await flush()
    expect(parse(f.host.send('', 's1')).operationId).toBe(newer.operationId)
    await vi.advanceTimersByTimeAsync(25000); await flush()
    expect(parse(f.host.operation(ticket.operationId)).ok).toBe(true)
  })
})

describe('installOverlayHost', () => {
  it('装到 window.__dshOverlayHost、版本 2、卸载后恢复原值', () => {
    const host = new OverlayHost({})
    const uninstall = installOverlayHost(host)
    const installed = (window as unknown as Record<string, unknown>)[OVERLAY_HOST_GLOBAL] as Record<string, unknown>
    expect(installed).toBeDefined()
    expect(installed.version).toBe(2)
    for (const name of ['state', 'sessions', 'commands', 'execute', 'send', 'removeAttachment', 'openSession']) {
      expect(typeof installed[name]).toBe('function')
    }
    uninstall()
    expect((window as unknown as Record<string, unknown>)[OVERLAY_HOST_GLOBAL]).toBeUndefined()
  })

  it('不吞掉别人先占的对象（卸载时还原）', () => {
    const target = window as unknown as Record<string, unknown>
    const previous = { preserved: true }
    target[OVERLAY_HOST_GLOBAL] = previous
    const uninstall = installOverlayHost(new OverlayHost({}))
    expect(target[OVERLAY_HOST_GLOBAL]).not.toBe(previous)
    uninstall()
    expect(target[OVERLAY_HOST_GLOBAL]).toBe(previous)
    delete target[OVERLAY_HOST_GLOBAL]
  })
})
