// @vitest-environment jsdom
// 侧边栏 AI 浏览器面板入口回归（U-1）：tab 类型定义 + 面板读 host 半档位路由。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BROWSER_STATUS_ROUTE, BROWSER_TAB_ID, BROWSER_TAB_KIND, BrowserTab, browserTabDefinition } from '../src/client/mobile/browser-tab.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

const PAYLOAD = {
  ok: true,
  available: false,
  tier: 'L1-text',
  viewportRoute: 'S1',
  identityRoute: 'ua-string-only',
  factsSource: 'measured-baseline(p0-2026-09-12, MuMu/WebView110)',
  capsNote: 'browserCaps 未实现或超时（壳侧 op 待落地）',
  uaChAvailable: false,
  androidxWebkitAvailable: false,
  densityOverrideSupported: false,
  browserWebViewAvailable: false,
  cdpEnabled: false,
  reasons: ['工位 WebView 未就绪'],
  degradedNotes: ['WebView 110 < 116：本机无 UA-CH'],
  viewportPresets: [{ id: 'phone-portrait', label: '手机竖屏（默认）', width: 390, height: 844, mobile: true }],
  identityProfiles: [{ id: 'android-real', label: '真实手机（默认）', requiresConfirm: false }],
}

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<BrowserTab {...({} as never)} />)
  })
  return host
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
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
  vi.unstubAllGlobals()
})

describe('AI 浏览器面板入口（U-1）', () => {
  it('tab 类型：extension 带、无地址模式（页面类型）、guide 卡片与工作区文件同级', () => {
    const def = browserTabDefinition()
    expect(def.id).toBe(BROWSER_TAB_ID)
    expect(def.kind).toBe(BROWSER_TAB_KIND)
    expect(def.priority).toBe('extension')
    expect(def.patterns).toBeUndefined()
    expect(def.title('')).toBe('AI 浏览器')
    expect(def.guide).toHaveLength(1)
    expect(def.guide?.[0].order).toBeGreaterThan(10)
    expect(def.guide?.[0].title()).toBe('AI 浏览器')
    expect(def.guide?.[0].description?.()).toContain('右侧栏')
  })

  it('面板读 host 半只读路由并渲染档位/来源/降级说明', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => PAYLOAD }))
    vi.stubGlobal('fetch', fetchMock)
    const el = await render()
    await settle()
    expect(fetchMock).toHaveBeenCalledWith(BROWSER_STATUS_ROUTE, expect.objectContaining({ credentials: 'same-origin' }))
    expect(el.querySelector('[data-testid="browser-tier"]')?.textContent).toContain('L1-text')
    expect(el.querySelector('[data-testid="browser-source"]')?.textContent).toContain('measured-baseline')
    expect(el.querySelector('[data-testid="browser-source"]')?.textContent).toContain('browserCaps 未实现')
    expect(el.querySelector('[data-testid="browser-degraded"]')?.textContent).toContain('无 UA-CH')
    expect(el.querySelector('[data-testid="browser-stage"]')?.textContent).toContain('BrowserHost 未接入')
    expect(el.querySelector('[data-testid="browser-viewport"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="browser-identity"]')).not.toBeNull()
  })

  it('未获授权（401）时不静默：面板给出可读提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const el = await render()
    await settle()
    expect(el.querySelector('[data-testid="browser-note"]')?.textContent).toContain('未获授权')
    expect(el.querySelector('[data-testid="browser-tier"]')).toBeNull()
  })

  it('host 半缺席（fetch 抛错）时给出可读提示而不是空白面板', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const el = await render()
    await settle()
    expect(el.querySelector('[data-testid="browser-note"]')?.textContent).toContain('不可用')
  })
})
