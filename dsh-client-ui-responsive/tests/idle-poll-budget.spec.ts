// @vitest-environment jsdom
// 静止常驻轮询的**必要性**判据（缺陷 3「整体卡顿」的第三条热点）。
//
// 真因形状：NativeBrowserPlacement 在 attach 时起一条自续 setTimeout(1000ms)，每一拍对
// 「上屏会话」无条件调一次 workspace.refresh() → window.androidBridge.browserHostCommand(...)。
// 那是**同步跨语言调用**（页面线程等壳侧主线程），在没有任何浏览器会话可对账时纯属白烧。
//
// 判据（可测量，不依赖设备）：
//  ① 没有任何会话上屏（mounted 为 undefined）、也没有 pending 绑定时，1 秒窗口内
//     browserHostCommand 调用 = 0。判据口径就是「没有可对账的对象」：没有上屏会话就没有
//     GUI 挂载点，也没有 AI 新建原生 Tab 的落点，这一拍无论原生侧答什么都不可能产生写操作；
//  ② 正向用例（不能把功能改没了）：一旦出现一个属于本插件的浏览器 Tab，就必须继续轮询并
//     走 claim —— 这是「AI 新建原生 Tab 落 GUI 挂载点」的唯一通路；
//  ③ 正向用例：有未完成 claim 的 pending 会话时必须继续轮询（否则绑定永远收不了尾）。
import { afterEach, describe, expect, it } from 'vitest'

interface Bridge { browserHostCommand?: (payload: string) => string }

/** 记一次调用并回一份「可用、无 Tab」的原生快照。 */
function installBridge(tabs: Array<Record<string, unknown>> = []): { calls: string[] } {
  const calls: string[] = []
  ;(window as unknown as { androidBridge: Bridge }).androidBridge = {
    browserHostCommand: (payload: string): string => {
      calls.push(payload)
      const session = String((JSON.parse(payload) as { session?: string }).session ?? '')
      return JSON.stringify({
        ok: true, available: true, session, reason: '',
        profileAvailable: false, isolationAvailable: false, profileReason: '',
        tabs, authoritativeTabs: true, tabId: '',
      })
    },
  }
  return { calls }
}

/** 等毫秒（真定时器，不用假时钟：要量的就是真实排程）。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

afterEach(() => { delete (window as unknown as { androidBridge?: Bridge }).androidBridge })

describe('静止常驻轮询的必要性', () => {
  it('① 没有会话上屏、也没有 pending 时，1 秒内不跨桥', async () => {
    const { NativeBrowserPlacement } = await import('../src/client/mobile/native-browser-auto-place.ts')
    const bridge = installBridge()
    const placement = new NativeBrowserPlacement({
      sessions: () => ['s1'],
      tabs: () => [],
      mounted: () => undefined,
      expanded: () => false,
      open: () => {},
      close: () => {},
      kind: 'browser',
      legacyKind: 'browser-legacy',
    })
    const dispose = placement.attach()
    try {
      // attach 那一拍允许读一次（建立基线），之后 1 秒的窗口必须为 0。
      await wait(50)
      const baseline = bridge.calls.length
      await wait(1_000)
      console.log('① attach_calls=' + String(baseline) + ' idle_window_calls=' + String(bridge.calls.length - baseline))
      expect(bridge.calls.length - baseline, '空闲 1 秒内的跨桥调用次数（修复前 1）').toBe(0)
    } finally {
      dispose()
    }
  }, 20_000)

  it('④ 正向用例：会话重新上屏后轮询必须自己恢复（不能停在 idle）', async () => {
    const { NativeBrowserPlacement } = await import('../src/client/mobile/native-browser-auto-place.ts')
    const bridge = installBridge()
    let mounted: string | undefined
    const placement = new NativeBrowserPlacement({
      sessions: () => ['s1'],
      tabs: () => [],
      mounted: () => mounted,
      expanded: () => true,
      open: () => {},
      close: () => {},
      kind: 'browser',
      legacyKind: 'browser-legacy',
    })
    const dispose = placement.attach()
    try {
      await wait(300)
      expect(bridge.calls.length, '空闲期不打桥').toBe(0)
      // 上屏：真壳里由 layout 服务的 mounted 快照翻转触发（index.ts 订阅后调 wake()）。
      mounted = 's1'
      placement.wake()
      await wait(1_200)
      console.log('④ calls_after_wake=' + String(bridge.calls.length))
      expect(bridge.calls.length, '上屏后必须恢复轮询').toBeGreaterThan(0)
    } finally {
      dispose()
    }
  }, 20_000)

  it('② 正向用例：出现一个浏览器 Tab 后必须继续轮询并 claim', async () => {
    const { NativeBrowserPlacement } = await import('../src/client/mobile/native-browser-auto-place.ts')
    // 未绑定的原生 Tab 在真壳上**不带** uiTabId 字段；传空串会被解析器判成非法 Tab，
    // 整份快照退化为 unavailable（那样这条正向用例就永远走不到 claim，自己变成假绿）。
    const bridge = installBridge([{ tabId: 'native-1', url: 'https://example.com', title: 'x', pageGeneration: 1, loadState: 'loaded' }])
    const claimed: string[] = []
    // open() 必须真的往布局里写一个挂载点：claim 的判据是「新建的 GUI Tab 出现了」，
    // 用空实现的话这条正向用例永远走不到 select，会自己变成假绿。
    const layout: Array<{ sessionId: string, tabId: string, kind: string }> = []
    const placement = new NativeBrowserPlacement({
      sessions: () => ['s1'],
      tabs: () => layout as never,
      mounted: () => 's1',
      expanded: () => true,
      open: () => { layout.push({ sessionId: 's1', tabId: 'ui-1', kind: 'browser' }) },
      close: () => {},
      kind: 'browser',
      legacyKind: 'browser-legacy',
    })
    const dispose = placement.attach()
    try {
      await wait(1_200)
      const selectCalls = bridge.calls.filter(payload => payload.includes('"action":"select"'))
      claimed.push(...selectCalls)
      console.log('② total_calls=' + String(bridge.calls.length) + ' select_calls=' + String(selectCalls.length))
      expect(bridge.calls.length, '有 Tab 时必须继续跨桥').toBeGreaterThan(1)
      expect(selectCalls.length, '必须尝试把原生 Tab 绑到 GUI 挂载点').toBeGreaterThan(0)
    } finally {
      dispose()
    }
  }, 20_000)

  it('③ 正向用例：有未完成 claim 的 pending 会话时必须继续轮询', async () => {
    const { NativeBrowserPlacement } = await import('../src/client/mobile/native-browser-auto-place.ts')
    // 原生有 Tab、GUI 也有挂载点，但 claim 需要 select 回执才成功：这里让 select 回不可用，
    // 于是绑定永远 pending —— 轮询必须继续（这正是 pending 集合存在的意义）。
    const calls: string[] = []
    ;(window as unknown as { androidBridge: Bridge }).androidBridge = {
      browserHostCommand: (payload: string): string => {
        calls.push(payload)
        const action = String((JSON.parse(payload) as { action?: string }).action ?? '')
        return JSON.stringify({
          ok: action !== 'select', available: action !== 'select', session: 's1', reason: '',
          profileAvailable: false, isolationAvailable: false, profileReason: '',
          tabs: [{ tabId: 'native-1', url: 'https://example.com', title: 'x', pageGeneration: 1, loadState: 'loaded' }],
          authoritativeTabs: true, tabId: '',
        })
      },
    }
    const layout: Array<{ sessionId: string, tabId: string, kind: string }> = []
    const placement = new NativeBrowserPlacement({
      sessions: () => ['s1'],
      tabs: () => layout as never,
      mounted: () => 's1',
      expanded: () => true,
      open: () => { layout.push({ sessionId: 's1', tabId: 'ui-1', kind: 'browser' }) },
      close: () => {},
      kind: 'browser',
      legacyKind: 'browser-legacy',
    })
    const dispose = placement.attach()
    try {
      await wait(2_500)
      const tabsCalls = calls.filter(payload => payload.includes('"action":"tabs"'))
      console.log('③ tabs_calls=' + String(tabsCalls.length))
      expect(tabsCalls.length, 'pending 未收尾时轮询必须继续（2.5 秒至少 2 拍）').toBeGreaterThanOrEqual(2)
    } finally {
      dispose()
    }
  }, 20_000)
})
