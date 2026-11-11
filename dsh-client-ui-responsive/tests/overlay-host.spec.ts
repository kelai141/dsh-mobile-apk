// @vitest-environment jsdom
// 页面宿主 API（window.__dshOverlayHost）回归：
//   - 每个方法都必须返回**合法 JSON 字符串**（原生 evaluateJavascript 直接解码）；
//   - 页面未就绪/异常时返回 {ok:false,error}，绝不抛异常（抛出去原生拿到空值）；
//   - 数据只取页面真源，不猜（sessionId 读不到就空串，工作区不归属就空串）。
import { describe, it, expect, beforeEach } from 'vitest'
import { OverlayHost, installOverlayHost, OVERLAY_HOST_GLOBAL, readPageSessionId, type OverlayHostFaces } from '../src/client/mobile/overlay-host.ts'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'

/** 一个可写的输入机桩：真的记录 setDraft/submit/removeAttachment 调用。 */
function fakeInput(options: { draft?: string; attachmentIds?: string[]; removeResult?: boolean } = {}) {
  const calls: string[] = []
  let state = { draft: options.draft ?? '', attachmentIds: options.attachmentIds ?? [] as string[] }
  const input = {
    state: { getSnapshot: () => state },
    setDraft(text: string) { calls.push('setDraft:' + text); state = { ...state, draft: text } },
    submit() { calls.push('submit') },
    removeAttachment(id: string) { calls.push('remove:' + id); return options.removeResult !== false },
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
  }
  const workspaces = {
    getSnapshot: () => ({
      items: [
        { workspaceId: WORKSPACE_ID, title: '工作区一', sessionIds: ['s1'] },
        { workspaceId: 'ws-2', title: '工作区二', sessionIds: [] },
      ],
    }),
  }
  const conversation = {
    input: { for: () => input },
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
      { name: 'img-a.bin', kind: 'image' },
      { name: 'file-b.bin', kind: 'file' },
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
      { id: 's1', title: TITLE },
      { id: 's2', title: '' },
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

describe('send / execute / removeAttachment / openSession', () => {
  it('send：写入页面草稿并触发页面提交（附件随草稿一起发）', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ attachmentIds: ['img-a'] })
    const host = new OverlayHost(standardFaces(fake.input))
    const payload = parse(host.send('你好'))
    expect(payload.ok).toBe(true)
    expect(fake.calls).toEqual(['setDraft:你好', 'submit'])
  })

  it('send：非字符串参数 ok:false；没有输入机 ok:false', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const host = new OverlayHost(standardFaces(fakeInput().input))
    expect(parse(host.send(42)).ok).toBe(false)
    const noInput = new OverlayHost({})
    expect(parse(noInput.send('x')).ok).toBe(false)
  })

  it('execute：走同一条 composer 提交路径（命令由页面裁决）', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput()
    const host = new OverlayHost(standardFaces(fake.input))
    expect(parse(host.execute('/compact')).ok).toBe(true)
    expect(fake.calls).toEqual(['setDraft:/compact', 'submit'])
    expect(parse(host.execute('')).ok).toBe(false)
    expect(parse(host.execute(undefined)).ok).toBe(false)
  })

  it('removeAttachment：按 state().attachments 的索引移除；越界/拒绝都 ok:false', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ attachmentIds: ['img-a', 'file-b'] })
    const host = new OverlayHost(standardFaces(fake.input))
    expect(parse(host.removeAttachment(1)).ok).toBe(true)
    expect(fake.calls).toContain('remove:file-b')
    expect(parse(host.removeAttachment(9)).ok).toBe(false)
    expect(parse(host.removeAttachment(-1)).ok).toBe(false)
    expect(parse(host.removeAttachment(1.5)).ok).toBe(false)
  })

  it('removeAttachment：页面拒绝删除时如实 ok:false', () => {
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
    const fake = fakeInput({ attachmentIds: ['img-a'], removeResult: false })
    const host = new OverlayHost(standardFaces(fake.input))
    const payload = parse(host.removeAttachment(0))
    expect(payload.ok).toBe(false)
  })

  it('openSession：调用页面导航；非法 id/服务缺失都 ok:false', () => {
    const opened: unknown[] = []
    const host = new OverlayHost({ uiWorkspace: () => ({ openSession: (id) => { opened.push(id) } }) })
    expect(parse(host.openSession('s2')).ok).toBe(true)
    expect(opened).toEqual(['s2'])
    expect(parse(host.openSession('')).ok).toBe(false)
    expect(parse(host.openSession(3)).ok).toBe(false)
    expect(parse(new OverlayHost({}).openSession('s2')).ok).toBe(false)
  })
})

describe('installOverlayHost', () => {
  it('装到 window.__dshOverlayHost、版本 1、卸载后恢复原值', () => {
    const host = new OverlayHost({})
    const uninstall = installOverlayHost(host)
    const installed = (window as unknown as Record<string, unknown>)[OVERLAY_HOST_GLOBAL] as Record<string, unknown>
    expect(installed).toBeDefined()
    expect(installed.version).toBe(1)
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
