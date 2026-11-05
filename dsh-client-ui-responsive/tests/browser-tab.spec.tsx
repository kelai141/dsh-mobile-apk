// @vitest-environment jsdom
// Source fixtures for target 0.2; written only, never executed in this delegated change.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { BrowserTab, browserTabDefinition, legacyBrowserTabDefinition, BROWSER_TAB_ID, BROWSER_TAB_KIND } from '../src/client/mobile/browser-tab.tsx'
import type { AndroidBrowserBodyProps } from '../src/client/mobile/browser-tab.tsx'
import type { NativeBrowserControlState } from '../src/client/mobile/native-browser-adapter.ts'
import type { BrowserControllerState } from '../src/client/mobile/upstream-browser/browser/BrowserController.ts'
import { emptyBrowserFrame } from '../src/client/mobile/upstream-browser/browser/BrowserFrame.ts'
import { createBrowserStore } from '../src/client/mobile/upstream-browser/browser/store.ts'
import { en, zh } from '../src/client/mobile/upstream-browser/locales.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Isolate the barrel: `browser-tab.tsx` takes exactly two symbols from ui-primitives, but the package's
 * compiled `lib/index.js` re-exports the entire component library — pulling shiki (+ its langs/themes),
 * simple-icons, lexical and the CSS modules in with it. That transitive graph is a build-time concern of
 * the packaged client, not of this unit under test, and resolving it here would mean installing a second
 * copy of the whole UI dependency tree just to run one spec.
 *
 * The spec asserts tab-definition/wire behavior and the native control row, never the artwork or the menu
 * button rendering, so a minimal stand-in is faithful to what is being tested. 用 Proxy 而不是逐个具名导出：
 * 官方 BrowserBody 从同一个 barrel 里取 8 个符号（Button/Tooltip/5 个 Icon/2 个常量），具名清单会随
 * vendored 上游版本漂移，Proxy 对新符号自动兜底。
 *
 * 顺序约束：本调用**不能**紧跟在以 `(` 开头的那行前面（原写法 `vi.mock(...)` 后跟
 * `(globalThis as ...)` 会被解析成 `vi.mock(...)(globalThis...)` ⇒ TypeError: vi.mock(...) is not a
 * function）——ASI 不会在 `(` 前补分号，空行也救不了。故把它挪到 globalThis 赋值之后。
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  // 只声明本 spec 可达面真正用到的符号（browser-tab.tsx + vendored BrowserBody/BrowserTitle 的并集）。
  // 逐个具名而不是 Proxy：Proxy 对任意属性都返回函数会让 React 的 thenable/$typeof 探测递归，
  // vitest 直接挂死（实测 10 分钟不返回）。具名清单漂移时测试会以「缺少导出」立刻判红，是可接受的信号。
  const passThrough = (props: { children?: unknown }): unknown => props.children ?? null
  return {
    Button: passThrough, Tooltip: passThrough, MenuItemButton: passThrough, GuideArtworkBrowser: passThrough,
    IconChevronLeftOutlineRegular: passThrough, IconChevronRightOutlineRegular: passThrough,
    IconLinkOutlineRegular: passThrough, IconRefreshOutlineRegular: passThrough,
    IconRightUpOutlineRegular: passThrough, IconGlobeOutlineRegular: passThrough,
    SHIELD_OUTLINE_PATH: 'M0 0', ICON_REGULAR_STROKE: 1.5,
  }
})

const SESSION = 'session-test' as SessionId
const TAB = 'ui-browser' as TabId
const t: TranslateNS<'androidSidebarBrowser'> = (key, params) => {
  const template = zh[key]
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
}
let root: Root | undefined
let host: HTMLDivElement | undefined

function keyedHook<T>(value: () => T): KeyedSnapshotSelectorHook<T> {
  const hook = <Selected,>(_key: string, select?: (snapshot: T | undefined) => Selected): T | Selected =>
    select === undefined ? value() : select(value())
  return hook as KeyedSnapshotSelectorHook<T>
}

async function mount(nativeOverrides: Partial<NativeBrowserControlState> = {}, visible = true) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const store = createBrowserStore().create('android-browser-view-fixture')
  let info: ReturnType<AndroidBrowserBodyProps['useTabInfo']> = {
    sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane' as PaneId },
    tab: { id: TAB, kind: 'browser', title: zh['type.label'], contentId: 'sidebar://browser/fixture', visible,
      navigation: { address: 'sidebar://browser/fixture', params: undefined, revision: 0 }, signal: new AbortController().signal,
      actions: { bindCommands: vi.fn(() => vi.fn()), openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() } },
  }
  const native: NativeBrowserControlState = { nativeTabId: 'native-1', available: true, reason: '',
    profileAvailable: true, isolationAvailable: true, profileReason: '', identityId: 'android-real', viewportWidth: 390, viewportHeight: 844,
    ...nativeOverrides }
  const state: BrowserControllerState = { frame: emptyBrowserFrame(), restoreTarget: undefined, addressFailure: undefined, addressRevision: 0 }
  const callbacks = {
    mount: vi.fn(() => vi.fn()), dispose: vi.fn(async () => {}), rebind: vi.fn(), loadUrl: vi.fn(), restore: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), setSandbox: vi.fn(),
    setBrowserVisible: vi.fn(), setBrowserIdentity: vi.fn(), setBrowserViewport: vi.fn(), refreshBrowserStatus: vi.fn(), closeBrowserTab: vi.fn(),
  }
  const props = {
    ...callbacks, sessionId: SESSION, useTabInfo: () => info, t, actions: store.actions,
    useStore: <Selected,>(select: (snapshot: ReturnType<typeof store.getSnapshot>) => Selected): Selected => select(store.getSnapshot()),
    useBrowserState: keyedHook(() => state), useNativeBrowserState: keyedHook(() => native),
  } as AndroidBrowserBodyProps
  const render = async (): Promise<void> => { await act(async () => { root!.render(<BrowserTab {...props} />) }) }
  await render()
  return { host, callbacks, hide: async () => { info = { ...info, tab: { ...info.tab, visible: false } }; await render() } }
}

afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount() })
  root = undefined
  host?.remove()
  host = undefined
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('official browser chrome over the Android adapter', () => {
  it('takes the builtin browser kind with one guide and a guide-less legacy resolver', () => {
    const current = browserTabDefinition(t)
    const legacy = legacyBrowserTabDefinition(t)
    expect(current).toMatchObject({ id: BROWSER_TAB_ID, kind: BROWSER_TAB_KIND, priority: 'extension', multiple: true, keepMounted: true })
    expect(current.guide).toHaveLength(1)
    expect(current.guide?.[0].icon).toBeDefined()
    expect(legacy.kind).toBe('android-browser')
    expect(legacy.id).not.toBe(current.id)
    expect(legacy.guide).toEqual([])
  })

  it('renders the official address/start/navigation UI and a separate native control row', async () => {
    const view = await mount()
    expect(view.host.querySelector('input[aria-label="' + zh['address.placeholder'] + '"]')).not.toBeNull()
    expect(view.host.textContent).toContain(zh.start)
    for (const label of [zh.back, zh.forward, zh.reload, zh.go, zh.external]) {
      expect(view.host.querySelector('button[aria-label="' + label + '"]')).not.toBeNull()
    }
    expect(view.host.querySelector('input[aria-label="' + zh['native.viewport'] + '"]')).not.toBeNull()
    expect(view.host.querySelectorAll('form')).toHaveLength(2)
    expect(view.host.querySelector('iframe, webview')).toBeNull()
  })

  it('publishes actual tab.visible transitions and hide-only unmount cleanup', async () => {
    const view = await mount()
    expect(view.callbacks.setBrowserVisible).toHaveBeenCalledWith(TAB, true)
    await view.hide()
    expect(view.callbacks.setBrowserVisible).toHaveBeenLastCalledWith(TAB, false)
    await act(async () => { root!.unmount() })
    root = undefined
    expect(view.callbacks.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('treats unavailable identity isolation as a notice while the browser keeps working', async () => {
    const view = await mount({ available: true, isolationAvailable: false, profileAvailable: false,
      profileReason: 'browser-profile-not-ready' })
    expect(view.host.textContent).toContain(zh['native.isolation.unavailable'])
    expect(view.host.textContent).not.toContain(zh['native.unavailable'])
    expect(view.host.textContent).not.toContain('浏览器身份档不可用')
  })

  it('shows no isolation notice while isolation is available, even before a profile is created', async () => {
    const view = await mount({ available: true, isolationAvailable: true, profileAvailable: false,
      profileReason: 'browser-profile-not-ready' })
    expect(view.host.textContent).not.toContain(zh['native.isolation.unavailable'])
  })

  it('keeps error semantics only when the browser itself is unavailable', async () => {
    const view = await mount({ available: false, isolationAvailable: false, reason: 'browser-profile-unsupported' })
    expect(view.host.textContent).toContain(zh['native.unavailable'].replace('{reason}', 'browser-profile-unsupported'))
  })

  it('keeps the isolation notice copy bilingual and code-free', () => {
    expect(zh['native.isolation.unavailable']).toBe('浏览器可用；身份隔离不可用（已降级为单一身份档）')
    expect(en['native.isolation.unavailable']).toBe('Browser works; identity isolation unavailable (single profile fallback)')
    expect(zh['native.isolation.unavailable']).not.toContain('browser-profile')
  })

  it('routes PC profile and viewport actions to the owning UI occurrence', async () => {
    const view = await mount()
    const pc = Array.from(view.host.querySelectorAll('button')).find(button => button.textContent === zh['native.desktop'])!
    await act(async () => { pc.click() })
    expect(view.callbacks.setBrowserIdentity).toHaveBeenCalledWith(TAB, true)
    const input = view.host.querySelector<HTMLInputElement>('input[aria-label="' + zh['native.viewport'] + '"]')!
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(view.callbacks.setBrowserViewport).toHaveBeenCalledWith(TAB, 390, 844)
  })
})
