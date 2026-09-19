// @vitest-environment jsdom
// 0.14.1 块 D（已知 issue #1）回归：侧边栏自动落位必须绑定**发起会话**且不得强制展开。
//
// 判据（docs/0.14.1-preview-PLAN.md §0.2.1 / LEGACY-AND-PERF §5.1 G-10）：
//  ① 多会话并行下 A 会话的动作不得改变 B 会话的侧栏状态（逐会话状态比对，不是「有没有开过 tab」）；
//  ② 收起态不得被强制展开（收起态一次 openTabIn/openTab 调用都不许发生）；
//  ③ 未识别会话身份（状态缺 ownerSessionId）时不得落位——按「上屏会话」兜底正是缺陷 A 本身。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BrowserAutoPlace, domCollapsedNow, type BrowserHostStatusLike } from '../src/client/mobile/browser-auto-place.ts'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'

/** 手动时钟：轮询由测试推进，不依赖真实定时器。 */
function makeScheduler() {
  const handlers = new Map<number, () => void>()
  let next = 1
  return {
    scheduler: {
      setInterval: (handler: () => void) => { handlers.set(next, handler); return next++ },
      clearInterval: (handle: number) => { handlers.delete(handle) },
    },
    fire: () => { for (const handler of [...handlers.values()]) handler() },
    count: () => handlers.size,
  }
}

/** 每次调用现读的状态源（测试中途改真源即可推进边沿）。 */
function statusSource(initial: BrowserHostStatusLike) {
  const state = { status: initial }
  return { state, read: () => JSON.stringify(state.status) }
}

/** 记录调用顺序与参数的侧栏假面（既记录 addressed 入口，也记录 mounted 入口）。 */
function sidebarSpy() {
  const calls: Array<{ entry: string; sessionId?: string; kind: string }> = []
  return {
    calls,
    face: {
      openTabIn: (sessionId: string, kind: string) => { calls.push({ entry: 'openTabIn', sessionId, kind }) },
      // 旧实现的入口：本版**不允许**被调用（它落在上屏会话上）。
      openTab: (kind: string) => { calls.push({ entry: 'openTab', kind }) },
    },
  }
}

const KIND = 'android-browser'

function makePlacement(overrides: {
  status: () => string | undefined
  current?: string | undefined
  collapsed?: boolean
  sidebar?: unknown
}) {
  return new BrowserAutoPlace({
    kind: KIND,
    status: overrides.status,
    currentSessionId: () => overrides.current,
    collapsed: () => overrides.collapsed ?? false,
    sidebar: () => overrides.sidebar as never,
  })
}

function page(owner: string, generation: number, tabId = 'tab-1', url = 'https://example.com') {
  return { created: true, ownerSessionId: owner, pageGeneration: generation, tabs: [{ tabId, url }] }
}

beforeEach(() => { document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE) })
afterEach(() => {
  document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE)
  document.querySelectorAll('[data-sidebar-right-expand]').forEach((node) => { node.remove() })
})

describe('块 D：AI 浏览器自动落位的会话绑定（G-10）', () => {
  it('① A 会话的动作不得改变 B 会话的侧栏状态（B 上屏时零调用）', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    // 上屏会话 = B；壳侧当前工作台 = A（A 刚开了页）
    const placement = makePlacement({ status: source.read, current: 'session-b', sidebar: sidebar.face })

    placement.tick() // 首次观测：只建基线
    expect(sidebar.calls).toEqual([])

    source.state.status = page('session-a', 2) // A 的新页面出现 = 边沿
    placement.tick()
    expect(sidebar.calls, 'A 的动作在 B 上屏时不得写任何会话的侧栏').toEqual([])
    expect(placement.pendingSessions()).toEqual(['session-a'])
  })

  it('① 反向对照：同一实现下「上屏会话 = 发起会话」时确实会落位（证明断言能红能绿）', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', sidebar: sidebar.face })

    placement.tick()
    source.state.status = page('session-a', 2)
    placement.tick()
    expect(sidebar.calls).toEqual([{ entry: 'openTabIn', sessionId: 'session-a', kind: KIND }])
  })

  it('① 落位必须走带会话的入口（openTabIn 带 ownerSessionId；旧的 mounted 入口一次都不许调）', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', sidebar: sidebar.face })
    placement.tick()
    source.state.status = page('session-a', 5)
    placement.tick()

    expect(sidebar.calls).toHaveLength(1)
    expect(sidebar.calls[0].entry).toBe('openTabIn')
    expect(sidebar.calls[0].sessionId).toBe('session-a')
    expect(sidebar.calls.some((call) => call.entry === 'openTab')).toBe(false)
  })

  it('③ 状态缺 ownerSessionId 时不得落位（不按「当前/上屏会话」兜底）', () => {
    const source = statusSource({ created: true, pageGeneration: 1, tabs: [] })
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-b', sidebar: sidebar.face })

    placement.tick()
    source.state.status = { created: true, pageGeneration: 2, tabs: [{ tabId: 'tab-1', url: 'https://x' }] }
    placement.tick()
    expect(sidebar.calls, '无会话身份 = 不落位（缺陷 A 的兜底路径）').toEqual([])
  })

  it('② 收起态不得被强制展开：收起期间零调用，只记 pending', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', collapsed: true, sidebar: sidebar.face })

    placement.tick()
    source.state.status = page('session-a', 2)
    placement.tick()
    expect(sidebar.calls, '收起态任何落位调用都会经 planSetExpanded(true) 强制展开').toEqual([])
    expect(placement.pendingSessions()).toEqual(['session-a'])
  })

  it('② 用户手动展开后补落位一次（且只一次，不因页面还在而反复动作）', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const state = { collapsed: true }
    const placement = new BrowserAutoPlace({
      kind: KIND,
      status: source.read,
      currentSessionId: () => 'session-a',
      collapsed: () => state.collapsed,
      sidebar: () => sidebar.face as never,
    })

    placement.tick()
    source.state.status = page('session-a', 2)
    placement.tick()
    expect(sidebar.calls).toEqual([])

    state.collapsed = false
    placement.tick()
    expect(sidebar.calls).toEqual([{ entry: 'openTabIn', sessionId: 'session-a', kind: KIND }])

    placement.tick()
    placement.tick()
    expect(sidebar.calls, 'pending 已清空且签名未变 → 不得重复落位').toHaveLength(1)
  })

  it('② 收起控件在 DOM 里时的判据与 domCollapsedNow 同源', () => {
    expect(domCollapsedNow()).toBe(false)
    const button = document.createElement('button')
    button.setAttribute('data-sidebar-right-expand', '')
    document.body.appendChild(button)
    expect(domCollapsedNow()).toBe(true)

    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', collapsed: domCollapsedNow(), sidebar: sidebar.face })
    placement.tick()
    source.state.status = page('session-a', 2)
    placement.tick()
    expect(sidebar.calls).toEqual([])
  })

  it('首次观测只建基线（不动作）：页面可能是上次会话遗留的', () => {
    const source = statusSource(page('session-a', 7))
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', sidebar: sidebar.face })
    placement.tick()
    expect(sidebar.calls).toEqual([])
    expect(placement.pendingSessions()).toEqual([])
  })

  it('先观测到「该会话无页面」再出现页面 → 必须落位（该页不可能早于本次页面加载）', () => {
    // 壳侧真源形状：`status()` 恒带 `ownerSessionId = currentWorkspace?.sessionKey`，工作台存在
    // 但还没有页面时 created=false 且 owner 仍为该会话键（BrowserHost.kt 的 status()）。
    const source = statusSource({ created: false, ownerSessionId: 'session-a', pageGeneration: 0, tabs: [] })
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', sidebar: sidebar.face })

    placement.tick() // 本页加载起始：该会话工作台还没有页面
    source.state.status = page('session-a', 1)
    placement.tick()
    expect(sidebar.calls).toEqual([{ entry: 'openTabIn', sessionId: 'session-a', kind: KIND }])
  })

  it('重置基线后不再重复落位（边沿判据不因「先空后页」退化成电平触发）', () => {
    const source = statusSource({ created: false, ownerSessionId: 'session-a' })
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-a', sidebar: sidebar.face })
    placement.tick()
    source.state.status = page('session-a', 1)
    placement.tick()
    placement.tick()
    placement.tick()
    expect(sidebar.calls).toHaveLength(1)
  })

  it('「先空后页」的放行只归属被观测到空的那个会话（B 不得沾 A 的空观测）', () => {
    const source = statusSource({ created: false, ownerSessionId: 'session-a' })
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: 'session-b', sidebar: sidebar.face })
    placement.tick() // A 的会话被观测为空
    // 上屏会话切到 B，B 首次被观测时**已经有页面**（可能是本次页面加载之前遗留的）→ 只建基线。
    source.state.status = page('session-b', 3)
    placement.tick()
    expect(sidebar.calls, 'B 的首次页面不得因 A 曾为空而被落位（否则就是新的跨会话误落位路径）').toEqual([])
  })

  it('壳桥缺席/状态不可解析/created=false 时零动作且不抛', () => {
    const sidebar = sidebarSpy()
    const missing = makePlacement({ status: () => undefined, current: 'session-a', sidebar: sidebar.face })
    const broken = makePlacement({ status: () => '{not json', current: 'session-a', sidebar: sidebar.face })
    const notCreated = makePlacement({ status: () => JSON.stringify({ created: false }), current: 'session-a', sidebar: sidebar.face })
    for (const placement of [missing, broken, notCreated]) {
      placement.tick()
      placement.tick()
    }
    expect(sidebar.calls).toEqual([])
  })

  it('侧栏面缺席（无右侧栏组合）时零动作且不抛', () => {
    const source = statusSource(page('session-a', 1))
    const placement = makePlacement({ status: source.read, current: 'session-a', sidebar: undefined })
    placement.tick()
    source.state.status = page('session-a', 2)
    expect(() => { placement.tick() }).not.toThrow()
  })

  it('attach/detach：轮询只在 attach 之后存在，detach 清干净（不留定时器）', () => {
    const clock = makeScheduler()
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const placement = new BrowserAutoPlace({
      kind: KIND,
      status: source.read,
      currentSessionId: () => 'session-a',
      collapsed: () => false,
      sidebar: () => sidebar.face as never,
      scheduler: clock.scheduler,
    })
    const dispose = placement.attach()
    expect(clock.count()).toBe(1)
    clock.fire()
    source.state.status = page('session-a', 2)
    clock.fire()
    expect(sidebar.calls).toHaveLength(1)

    dispose()
    expect(clock.count()).toBe(0)
    source.state.status = page('session-a', 3)
    clock.fire()
    expect(sidebar.calls, 'detach 后不得再落位').toHaveLength(1)
  })

  it('无 openTabIn 的交接口不落位（跨栈版本不冒充支持）', () => {
    const source = statusSource(page('session-a', 1))
    const calls: string[] = []
    const placement = makePlacement({
      status: source.read,
      current: 'session-a',
      sidebar: { openTab: () => { calls.push('openTab') } },
    })
    placement.tick()
    source.state.status = page('session-a', 2)
    placement.tick()
    expect(calls).toEqual([])
  })

  it('会话标记（data-dsh-session-id）缺席时不得落位', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    const placement = makePlacement({ status: source.read, current: undefined, sidebar: sidebar.face })
    placement.tick()
    source.state.status = page('session-a', 2)
    placement.tick()
    expect(sidebar.calls).toEqual([])
  })

  // ── 反证（改前必红）：把旧实现在同一组 fixture 上跑一遍，它必须**违反**本 spec 的判据 ──
  it('反证：旧的「读全局状态 + 调 mounted openTab」实现在同一 fixture 上必然违规', () => {
    const source = statusSource(page('session-a', 1))
    const sidebar = sidebarSpy()
    // 旧实现：无会话比对、无 ownerSessionId、收起判据不分会话、直接调 mounted 入口。
    let seen = ''
    const oldTick = (): void => {
      const status = JSON.parse(String(source.read())) as BrowserHostStatusLike
      if (status.created !== true) return
      const tabs = Array.isArray(status.tabs) ? (status.tabs as Array<Record<string, unknown>>) : []
      const signature = tabs.map((t) => String(t.tabId) + ':' + String(t.url)).join('|') + '#' + String(status.pageGeneration)
      if (seen !== '' && signature === seen) return
      const first = seen === ''
      seen = signature
      if (first) return
      sidebar.face.openTab(KIND)
    }

    oldTick()
    source.state.status = page('session-a', 2) // A 的页面出现，而上屏会话是 B
    oldTick()

    // 旧实现在「B 上屏」时写了侧栏 → 正是本 spec 判红的那一条。
    expect(sidebar.calls, '改前该断言必红（旧实现写的是上屏会话）').not.toEqual([])
    expect(sidebar.calls[0].entry).toBe('openTab')
    expect(sidebar.calls[0].sessionId, '旧入口不携带任何会话身份').toBeUndefined()
  })
})
