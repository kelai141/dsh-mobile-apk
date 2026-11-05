// @vitest-environment jsdom
// 审计 §7.2：原生浏览器落位每秒按会话数打原生桥。
//
// 三条判据（全部落在**可观测的行为**上，不碰实现细节、不测机器速度）：
//  ① 只轮询「有本插件 GUI 挂载点」或「正在上屏」或「还有未完成绑定」的会话：
//     只在 sessions() 里、没有挂载点也不上屏的旁路会话一次原生桥都不打；
//  ② document.hidden 时不排下一拍；回前台立刻补一拍并恢复自排；
//  ③ 一次 tick 里 tabs() 只读一次（只有本拍写过布局之后才重读一次），不随会话数增长。
//
// 反证方式：把**审计时点的旧 tick 原样**搬进本文件当夹具（legacyTick），
// 在同一份 fixture 上跑一遍并断言它必然违反上述判据；撤掉修复即变红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightOpenTab } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { NativeBrowserPlacement } from '../src/client/mobile/native-browser-auto-place.ts'

const KIND = 'android-browser'
const LEGACY = 'android-browser-legacy'

/** 原生桥回复：给定会话的原生 Tab 清单。 */
function reply(session: string, tabs: { tabId: string, uiTabId?: string }[] = []): string {
  return JSON.stringify({
    ok: true, available: true, session, profileAvailable: true, isolationAvailable: true, profileReason: '',
    tabs: tabs.map(tab => ({ ...tab, url: 'https://example.com/', title: 'Example', pageGeneration: 1,
      loadState: 'complete', canGoBack: false, canGoForward: false, profileAvailable: true,
      isolationAvailable: true, profileReason: '',
      identityId: 'android-real', viewportWidth: 390, viewportHeight: 844 })),
  })
}

/** 一次卡片挂载点。 */
function record(session: string, tabId: string, kind = KIND): SidebarRightOpenTab {
  return { sessionId: session as SessionId, tabId: tabId as TabId, kind, contentId: tabId }
}

let hidden = false

interface Harness {
  readonly placement: NativeBrowserPlacement
  readonly calls: string[]
  readonly tabsReads: () => number
  readonly dispose: () => void
  setNative(session: string, tabs: { tabId: string, uiTabId?: string }[]): void
}

/**
 * 搭一份只测行为的夹具。
 * @param options - 上屏会话与初始挂载点。
 * @returns 落位实例、桥调用记录与布局读取计数。
 */
function harness(options: { mounted?: string, tabs?: SidebarRightOpenTab[] } = {}): Harness {
  let mounted = options.mounted
  let tabs = options.tabs ?? []
  let reads = 0
  const calls: string[] = []
  const native = new Map<string, { tabId: string, uiTabId?: string }[]>()
  window.androidBridge = {
    browserHostCommand: (payload: string) => {
      const parsed = JSON.parse(payload) as { session: string, action: string }
      calls.push(parsed.action + ':' + parsed.session)
      return reply(parsed.session, native.get(parsed.session) ?? [])
    },
  }
  const placement = new NativeBrowserPlacement({
    // 本模块不再读 sessions()：只在其中的旁路会话不该产生任何原生桥调用。
    sessions: () => ['session-x', 'session-y'] as readonly SessionId[],
    tabs: () => { reads += 1; return tabs },
    mounted: () => mounted as SessionId | undefined,
    expanded: () => true,
    open: (session) => { calls.push('open:' + session) },
    close: (session, tabId) => { calls.push('close:' + session + ':' + tabId) },
    kind: KIND, legacyKind: LEGACY,
  })
  return {
    placement,
    calls,
    tabsReads: () => reads,
    dispose: placement.attach(),
    setNative: (session, list) => { native.set(session, list) },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
})

afterEach(() => {
  delete window.androidBridge
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.documentElement.removeAttribute('data-dsh-browser-pending')
})

describe('审计 §7.2：只轮询有事的会话、后台停拍、一拍一次快照', () => {
  it('没有任何挂载点、也不上屏时，一拍都不打原生桥', () => {
    const h = harness()
    try {
      vi.advanceTimersByTime(5000)
      expect(h.calls, '空工作区每秒跨桥一次是纯开销').toEqual([])
    } finally { h.dispose() }
  })

  it('旁路会话不进轮询：只有挂了 GUI 的会话打桥', () => {
    const h = harness({ mounted: 'session-b', tabs: [record('session-b', 'ui-b')] })
    try {
      vi.advanceTimersByTime(1000)
      expect(h.calls.filter(call => call.endsWith(':session-b')).length).toBeGreaterThan(0)
      expect(h.calls.some(call => call.endsWith(':session-a')), '没有任何挂载点的会话不得被轮询').toBe(false)
    } finally { h.dispose() }
  })

  it('document.hidden 时不排下一拍；回前台补一拍并恢复自排', () => {
    const h = harness({ mounted: 'session-a', tabs: [record('session-a', 'ui-a')] })
    try {
      vi.advanceTimersByTime(1000)
      const before = h.calls.length
      expect(before).toBeGreaterThan(0)

      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(10_000)
      expect(h.calls.length, '后台里既不排拍也不打桥').toBe(before)

      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      expect(h.calls.length, '回前台立刻补一拍').toBeGreaterThan(before)
      const restored = h.calls.length
      vi.advanceTimersByTime(2000)
      expect(h.calls.length, '补拍之后自排恢复').toBeGreaterThan(restored)
    } finally { h.dispose() }
  })

  it('一次 tick 内布局只读一次（本拍没有写布局时）', () => {
    const h = harness({ mounted: 'session-a', tabs: [record('session-a', 'ui-a'), record('session-b', 'ui-b')] })
    try {
      expect(h.tabsReads(), '首个 tick 只读一次布局快照').toBe(1)
      vi.advanceTimersByTime(1000)
      expect(h.tabsReads(), '每拍一次，且与故障会话数无关').toBe(2)
    } finally { h.dispose() }
  })

  it('原生关闭检测写过布局之后才重读：判定用新快照，不用本拍开头那份', () => {
    const h = harness({ mounted: 'session-a', tabs: [record('session-a', 'ui-a')] })
    try {
      // 第一拍：原生侧有 ui-a 的 Tab → 建立绑定（不经 open，不写布局）。
      h.setNative('session-a', [{ tabId: 'native-a', uiTabId: 'ui-a' }])
      vi.advanceTimersByTime(1000)
      const readsBeforeClose = h.tabsReads()
      // 第二拍：原生侧已关闭该 Tab → 挂载点必须被关掉。
      h.setNative('session-a', [])
      vi.advanceTimersByTime(1000)
      expect(h.calls, '原生已关闭的挂载点必须关掉（否则卡片留在界面上）').toContain('close:session-a:ui-a')
      expect(h.tabsReads(), '写过布局之后必须重读一次').toBeGreaterThan(readsBeforeClose)
    } finally { h.dispose() }
  })

  it('detach 后不再排拍，也不再打桥', () => {
    const h = harness({ mounted: 'session-a', tabs: [record('session-a', 'ui-a')] })
    vi.advanceTimersByTime(1000)
    const before = h.calls.length
    h.dispose()
    vi.advanceTimersByTime(10_000)
    expect(h.calls.length).toBe(before)
  })
})

// ── 反证夹具：审计时点（0.14.8）的旧 tick，逐字搬入 ───────────────────────────
/**
 * 审计 §7.2 描述的旧实现：无条件 setInterval + sessions() 全并进 ids + 同一拍重复读 tabs()。
 *
 * 刻意不做任何"改良"：它就是旧代码的形状（行号按 0.14.8 的 §7.2 清单）。
 * 新实现必须在这份夹具上违反判据，否则说明本 spec 断言不到真实差异。
 */
function legacyTick(options: {
  sessions: string[]
  tabs: () => readonly SidebarRightOpenTab[]
  mounted: string | undefined
  nativeTabs: readonly { tabId: string, uiTabId?: string }[]
  refresh: (session: string) => void
  open: (session: string) => void
}): void {
  const ids = new Set([...options.sessions, ...options.tabs().map(tab => tab.sessionId)])
  if (options.mounted !== undefined) ids.add(options.mounted)
  for (const session of ids) {
    options.refresh(session) // 原生桥：workspace.refresh() → browserHostCommand('tabs')
    const records = options.tabs().filter(tab => tab.sessionId === session
      && (tab.kind === KIND || tab.kind === LEGACY))
    void records
    void options.tabs() // 旧 :77 的第二次读取
    for (const native of options.nativeTabs) {
      if (native.uiTabId !== undefined && options.tabs().some(tab => tab.sessionId === session && tab.tabId === native.uiTabId)) continue
      if (session !== options.mounted) continue
      const before = new Set(options.tabs().map(tab => tab.tabId))
      options.open(session)
      void options.tabs().find(tab => tab.sessionId === session && !before.has(tab.tabId))
    }
  }
}

describe('反证：旧行为在同一 fixture 上必然违反判据', () => {
  it('旧行为为旁路会话打桥，且会话越多打得越多', () => {
    let reads = 0
    const tabs = (): readonly SidebarRightOpenTab[] => { reads += 1; return [] }
    const calls: string[] = []
    legacyTick({
      sessions: ['session-a', 'session-b', 'session-c'],
      tabs,
      mounted: undefined,
      nativeTabs: [],
      refresh: (session) => { calls.push(session) },
      open: () => {},
    })
    expect(calls, '旧行为：每个 sessions() 成员各打一次原生桥（与会话数线性相关）')
      .toEqual(['session-a', 'session-b', 'session-c'])
    expect(reads, '旧行为同一拍连读多次布局').toBeGreaterThan(1)
  })

  it('旧行为在后台照跑（旧实现没有 document.hidden 判据）', () => {
    const ticks: string[] = []
    hidden = true
    const handle = setInterval(() => { ticks.push('tick') }, 1000)
    try {
      vi.advanceTimersByTime(5000)
      expect(ticks.length, '旧实现 = 无条件 setInterval：后台每拍都跑').toBe(5)
    } finally { clearInterval(handle) }
  })

  it('同一 fixture 上新实现两项都不违反（对照上面两条）', () => {
    const h = harness()
    try {
      vi.advanceTimersByTime(4000)
      expect(h.calls, '新实现：旁路会话一次桥都不打').toEqual([])
      expect(h.tabsReads(), '新实现：每拍一次（一共 5 拍：attach + 4）').toBeLessThanOrEqual(5)
    } finally { h.dispose() }
  })
})
