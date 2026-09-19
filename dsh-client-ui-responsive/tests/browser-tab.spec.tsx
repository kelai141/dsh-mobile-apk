// @vitest-environment jsdom
// 0.14.0 极简浏览器面板：顶部地址 + 单按钮，底部分辨率 + PC/手机；无其它文字与控件。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BROWSER_TAB_ID, BROWSER_TAB_KIND, BrowserTab, browserTabDefinition } from '../src/client/mobile/browser-tab.tsx'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

function state(overrides = {}) {
  return JSON.stringify({
    ok: true,
    available: true,
    created: false,
    visible: false,
    url: 'about:blank',
    title: '',
    pageGeneration: 0,
    viewportId: 'device',
    viewportWidth: 0,
    viewportHeight: 0,
    identityId: 'android-real',
    atTop: true,
    scrollDirection: 0,
    reason: '',
    ...overrides,
  })
}

async function render(bridge?: Record<string, unknown>): Promise<HTMLElement> {
  delete window.androidBridge
  if (bridge !== undefined) window.androidBridge = bridge as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const useTabInfo = () => ({ tab: { signal: new AbortController().signal } })
  await act(async () => { root!.render(<BrowserTab {...({ sessionId: 'session-test', useTabInfo } as never)} />) })
  return host
}

function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('HTMLInputElement.value setter missing')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  delete window.androidBridge
  vi.restoreAllMocks()
})

describe('AI 浏览器 Files 侧栏工作台（0.14.0 极简面板）', () => {
  it('tab 类型：extension 带、guide 卡片与工作区文件同级', () => {
    const def = browserTabDefinition()
    expect(def.id).toBe(BROWSER_TAB_ID)
    expect(def.kind).toBe(BROWSER_TAB_KIND)
    expect(def.priority).toBe('extension')
    expect(def.patterns).toBeUndefined()
    expect(def.title('')).toBe('AI 浏览器')
    expect(def.guide).toHaveLength(1)
    expect(def.guide?.[0].order).toBeGreaterThan(10)
    expect(def.guide?.[0].description?.()).toContain('右侧栏')
  })

  it('host 缺席：无任何说明文字，控件禁用，工位仍在场', async () => {
    const el = await render()
    expect(el.textContent).not.toContain('BrowserHost')
    expect(el.querySelector('select')).toBeNull()
    expect(el.querySelector('[data-testid="browser-stage"]')).not.toBeNull()
    expect((el.querySelector('input[aria-label="浏览器地址"]') as HTMLInputElement).disabled).toBe(true)
    expect((el.querySelector('input[aria-label="分辨率"]') as HTMLInputElement).disabled).toBe(true)
  })

  it('打开调用原生 BrowserHost 并发布 bounds；页面已开时同一按钮变刷新', async () => {
    const browserHostBounds = vi.fn(() => state())
    const browserHostShow = vi.fn(() => state({ created: true, visible: true, url: 'https://example.com', pageGeneration: 1 }))
    const browserHostReload = vi.fn(() => state({ created: true, visible: true, url: 'https://example.com', pageGeneration: 2 }))
    const el = await render({
      browserHostStatus: () => state({ created: true, visible: true, url: 'https://example.com', pageGeneration: 1 }),
      browserHostBounds,
      browserHostShow,
      browserHostReload,
    })
    const input = el.querySelector('input[aria-label="浏览器地址"]') as HTMLInputElement
    await act(async () => { setReactInputValue(input, 'example.com') })
    await act(async () => { (el.querySelector('button[type="submit"]') as HTMLButtonElement).click() })
    expect(browserHostShow).toHaveBeenCalledTimes(1)
    const showPayload = JSON.parse(browserHostShow.mock.calls[0][0] as string) as { url: string; session: string }
    expect(showPayload.url).toBe('example.com')
    expect(browserHostBounds).toHaveBeenCalled()
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).textContent).toBe('刷新')
    await act(async () => { (el.querySelector('button[type="submit"]') as HTMLButtonElement).click() })
    expect(browserHostReload).toHaveBeenCalledTimes(1)
  })

  it('底部分辨率输入提交后按 CSS 视口下发（宽×高）', async () => {
    const browserHostViewport = vi.fn(() => state({ created: true, visible: true, url: 'https://example.com' }))
    const el = await render({
      browserHostStatus: () => state({ created: true, visible: true, url: 'https://example.com' }),
      browserHostBounds: vi.fn(() => state()),
      browserHostViewport,
    })
    const input = el.querySelector('input[aria-label="分辨率"]') as HTMLInputElement
    await act(async () => { setReactInputValue(input, '1080x1920') })
    const form = input.closest('form') as HTMLFormElement
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(browserHostViewport).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(browserHostViewport.mock.calls[0][0] as string) as { width: number; height: number }
    expect(payload.width).toBe(1080)
    expect(payload.height).toBe(1920)
  })

  it('PC/手机切换把身份档与该模式记住的分辨率合并为一次下发', async () => {
    const browserHostIdentity = vi.fn(() => state({ created: true, visible: true }))
    const browserHostViewport = vi.fn(() => state({ created: true, visible: true }))
    const el = await render({
      browserHostStatus: () => state({ created: true, visible: true, url: 'https://example.com' }),
      browserHostBounds: vi.fn(() => state()),
      browserHostIdentity,
      browserHostViewport,
    })
    const mode = [...el.querySelectorAll('button')].find((button) => button.textContent === '手机网页') as HTMLButtonElement
    await act(async () => { mode.click() })
    expect(browserHostIdentity).toHaveBeenCalledTimes(1)
    const identity = JSON.parse(browserHostIdentity.mock.calls[0][0] as string) as {
      profile: string; width: number; height: number
    }
    expect(identity.profile).toBe('linux-desktop')
    expect(identity.width).toBe(1280)
    expect(identity.height).toBe(720)
    expect(browserHostViewport).not.toHaveBeenCalled()
  })
})

/**
 * 找到 apply() 注册的自动落位 effect（用桩 ctx 真跑 apply）。
 *
 * 0.14.1 块 D 后的契约：落位走**带会话的入口** `openTabIn(ownerSessionId, kind)`，且只在
 * 壳侧 `ownerSessionId` 与 `<html data-dsh-session-id>` 一致时才动作——旧契约（无会话身份、
 * 调 mounted `openTab`）正是已知 issue #1 的缺陷 A，已被本轮的回归用例锁定为不许回归。
 */
async function loadRevealEffect(opts: { status: () => string; openTabIn: (sessionId: string, kind: string, o?: unknown) => void }) {
  const { apply } = await import('../src/client/index.ts')
  const effects: Array<{ name: string; run: () => (() => void) | void }> = []
  const stub = {
    effect: (cb: () => (() => void) | void, name?: string) => { effects.push({ name: name ?? '', run: cb }); return () => {} },
    slots: { inject: () => () => {}, register: () => () => {} },
    get: (key: string) => {
      if (key === 'sidebarRight') return { openTabIn: opts.openTabIn }
      if (key === 'sidebarRightTabs') return { register: () => () => {} }
      return undefined
    },
    sessions: { subscribe: () => () => {} },
    logger: () => ({ warn: () => {} }),
    on: () => () => {},
  }
  ;(globalThis as Record<string, unknown>).window = globalThis.window
  ;(window as unknown as Record<string, unknown>).androidBridge = { browserHostStatus: opts.status }
  apply(stub as never)
  const found = effects.find((e) => e.name.includes('auto-place'))
  return found
}

describe('AI 浏览器自动落位到右侧栏（0.14.1 块 D：会话绑定 + 收起时延迟落位）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 默认「侧栏展开」= 展开控件不在场；收起用例单独覆盖。
    document.body.innerHTML = ''
    // 上屏会话 = s1（SessionMarker 发布的位置）；壳侧 ownerSessionId 必须与它一致才落位。
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1')
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE)
  })

  /** 让 status 可随调用变化，模拟壳侧状态演进。 */
  function loadWithQueue(frames: string[], openTabIn: (sessionId: string, kind: string, o?: unknown) => void) {
    let i = 0
    return loadRevealEffect({
      status: () => frames[Math.min(i++, frames.length - 1)] ?? '{}',
      openTabIn,
    })
  }

  const page = (gen: number, url = 'https://example.com/', owner = 's1') =>
    JSON.stringify({ created: true, ownerSessionId: owner, pageGeneration: gen, tabs: [{ tabId: 'tab-1', url }] })

  it('首次观测只建立基线：不动作（避免启动时抢侧栏）', async () => {
    const calls: unknown[] = []
    const eff = await loadWithQueue([page(1)], (s, k) => { calls.push({ s, k }) })
    await act(async () => { eff!.run() })
    await act(async () => { vi.advanceTimersByTime(3_000) })
    expect(calls.length).toBe(0)
  })

  it('出现「新页面」（边沿）时按发起会话落位一次，且不重复触发', async () => {
    const calls: Array<{ s: string; k: string }> = []
    const eff = await loadWithQueue([page(1), page(1), page(2), page(2), page(2)], (s, k) => { calls.push({ s, k }) })
    await act(async () => { eff!.run() })
    await act(async () => { vi.advanceTimersByTime(5_000) })
    expect(calls.length).toBe(1)
    expect(calls[0].k).toBe(BROWSER_TAB_KIND)
    expect(calls[0].s, '落位必须带发起会话身份（缺陷 A 的判据）').toBe('s1')
  })

  it('收起态出现新页面：**不落位**（不强制展开），用户展开后补一次', async () => {
    // 收起态的设备实况 = 上游展开控件在场（权威信号）。
    document.body.innerHTML = '<button data-sidebar-right-expand="true"></button>'
    const calls: Array<{ s: string; k: string }> = []
    const eff = await loadWithQueue([page(1), page(2), page(2), page(2)], (s, k) => { calls.push({ s, k }) })
    await act(async () => { eff!.run() })
    await act(async () => { vi.advanceTimersByTime(2_500) })
    // 收起期间绝不落位——这是用户报「收起后自动展开」的根因。
    expect(calls.length).toBe(0)
    // 用户手动展开 -> 补一次落位。
    document.body.innerHTML = ''
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ s: 's1', k: BROWSER_TAB_KIND })
  })

  it('页面未创建时不落位（避免开一个空面板）', async () => {
    const calls: unknown[] = []
    const eff = await loadWithQueue([JSON.stringify({ created: false })], (s, k) => { calls.push({ s, k }) })
    await act(async () => { eff!.run() })
    await act(async () => { vi.advanceTimersByTime(3_000) })
    expect(calls.length).toBe(0)
  })
})

describe('可见性判据：收起 vs 全屏（0.14.0 设备实证三次修正）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

  /** 渲一个带舞台的面板，并按给定标记布置祖先链，取回 publishBounds 会发出的 visible。 */
  async function visibleWith(ancestors: string): Promise<boolean | undefined> {
    const sent: Array<Record<string, unknown>> = []
    delete window.androidBridge
    ;(window as unknown as Record<string, unknown>).androidBridge = {
      browserHostStatus: () => JSON.stringify({ ok: true, available: true, created: true, visible: true, url: 'https://e.test/', title: '', pageGeneration: 1, viewportId: 'device', viewportWidth: 0, viewportHeight: 0, identityId: 'android-real', ownerSessionId: '', atTop: true, scrollDirection: 0, reason: '' }),
      browserHostBounds: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>) },
      browserHostHide: () => '',
      browserHostShow: () => '',
    }
    const host = document.createElement('div')
    host.innerHTML = ancestors
    document.body.appendChild(host)
    const root = createRoot(host)
    const useTabInfo = () => ({ tab: { signal: new AbortController().signal } })
    await act(async () => { root!.render(<BrowserTab {...({ sessionId: 's1', useTabInfo } as never)} />) })
    await act(async () => { vi.advanceTimersByTime(400) })
    await act(async () => { root!.unmount() })
    host.remove()
    return sent.length > 0 ? sent[sent.length - 1].visible as boolean : undefined
  }

  /**
   * 语义锁定（0.14.0 四次踩坑后固化）：收起判据**只能**用「上游展开控件是否在场」。
   * 被否掉的三个候选（各自都会造成用户可见缺陷）：
   *   - `data-sidebar-right-open`：收起态仍为 "true" → 恒判可见（覆盖层压在聊天上）
   *   - `[data-rightbar-col]` 的 collapsed 属性：该元素上根本没有此属性
   *   - frame 上的 `data-rightbar-collapsed`：**恒为 "true"** 的常量 → 恒判收起（页面永久隐藏，
   *     并让虚拟屏永不落位——正是 verify-vdisplay-viewer 回归的原因）
   */
  it('收起判据用「展开控件在场」，且不再使用任何常量式属性', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/client/mobile/browser-tab.tsx', 'utf8'))
    // 必须用权威信号
    expect(src).toContain("document.querySelector('[data-sidebar-right-expand]')")
    // 不得把常量属性当状态读（注释里可以解释，但代码中不得出现读它的表达式）
    expect(src).not.toMatch(/querySelector(All)?\(\s*'\[data-rightbar-collapsed[^)]*\)\s*!==\s*null/)
    expect(src).not.toMatch(/closest\(\s*'\[data-rightbar-collapsed/)
  })

  it('自动落位循环同样用「展开控件在场」作为收起判据（0.14.1 块 D 后策略在 mobile/browser-auto-place.ts）', async () => {
    // 策略自 index.ts 抽到独立模块（缺陷 A/B 的修法需要可单测的会话绑定），判据位置随之迁移：
    // 落位面见 browser-auto-place.ts，接线面见 index.ts（两者都必须只用权威收起信号）。
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/client/mobile/browser-auto-place.ts', 'utf8'))
    expect(src).toContain("document.querySelector('[data-sidebar-right-expand]')")
    expect(src).not.toMatch(/querySelector\(\s*'\[data-rightbar-collapsed[^)]*\)\s*!==\s*null/)
    expect(src).not.toMatch(/closest\(\s*'\[data-rightbar-collapsed/)

    const wiring = await import('node:fs').then((fs) => fs.readFileSync('src/client/index.ts', 'utf8'))
    expect(wiring).toContain('domCollapsedNow')
    expect(wiring).not.toMatch(/querySelector\(\s*'\[data-rightbar-collapsed[^)]*\)\s*!==\s*null/)
    // 反向：旧的 mounted 入口不得再出现在落位接线里（那是缺陷 A 的调用形态）。
    expect(wiring).not.toContain('sidebar.openTab?.(')
  })
})