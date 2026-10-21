// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { SidebarBubbles } from '../src/client/mobile/sidebar-bubbles.ts'
import { BackStackSignal } from '../src/client/mobile/back-stack.ts'
import { zh } from '../src/client/mobile/sidebar-bubbles.locales.ts'

const owner = 'owner' as SessionId
let current: SessionId | undefined
let narrow: boolean
let panel: HTMLElement
let bubbles: SidebarBubbles
let records: TabRecord[]
let reorder: ReturnType<typeof vi.fn>
let selected: string
let back: BackStackSignal | undefined
const t: TranslateNS<'androidSidebarBubbles'> = (key, params) => zh[key].replace('{title}', String(params?.title ?? ''))
const id = (value: string) => value as TabId
const rect = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, width, height, top: y, bottom: y + height, left: x, right: x + width, toJSON: () => ({}) })
const native = (value: string) => panel.querySelector<HTMLElement>('[data-dockkit-tab="' + value + '"]')!
const row = (value: string) => panel.querySelector<HTMLElement>('[data-dsh-bubble-tab="' + value + '"]')!
const select = (value: string) => row(value).querySelector<HTMLButtonElement>('.dsh-bubble-select')!
const toggle = () => panel.querySelector<HTMLButtonElement>('[data-dsh-sidebar-bubbles-toggle]')!
const popover = () => panel.querySelector<HTMLElement>('.dsh-bubble-popover')!
function pointer(type: string, target: EventTarget, x = 150, y = 100, pointerId = 1): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } })
  target.dispatchEvent(event)
  return event
}
async function flush(): Promise<void> { await Promise.resolve(); vi.advanceTimersByTime(20); await Promise.resolve() }
function addTab(value: string, kind = 'conversation', pane = 'p'): void {
  records.push({ id: id(value), kind, contentId: 'dsh-resource://test/' + value, title: value })
  const source = document.createElement('div')
  source.setAttribute('role', 'tab')
  source.setAttribute('data-dockkit-tab', value)
  source.setAttribute('aria-selected', String(value === selected))
  source.innerHTML = '<span data-dockkit-tab-title><span data-sidebar-right-tab="' + value + '"><svg aria-hidden="true"><path d="M0 0h2v2z" /></svg><span>' + value + '</span></span></span><button data-dockkit-tab-close="' + value + '" aria-label="关闭"></button>'
  source.addEventListener('click', () => {
    selected = value
    panel.querySelectorAll('[data-dockkit-tab]').forEach(node => node.setAttribute('aria-selected', String(node === source)))
  })
  source.querySelector('button')!.addEventListener('click', event => {
    event.stopPropagation()
    const wasSelected = selected === value
    source.remove()
    records = records.filter(record => record.id !== value)
    if (wasSelected) panel.querySelector<HTMLElement>('[data-dockkit-tab]')?.click()
  })
  panel.querySelector('[data-dockkit-strip="' + pane + '"] [data-dockkit-strip-tabs]')!.append(source)
}
function geometry(): void {
  vi.spyOn(popover(), 'getBoundingClientRect').mockImplementation(() => rect(40, 60, 304, 360))
  records.forEach((record, index) => { vi.spyOn(row(record.id), 'getBoundingClientRect').mockImplementation(() => rect(45, 70 + index * 55, 294, 48)) })
}

beforeEach(() => {
  vi.useFakeTimers()
  current = owner; narrow = true; selected = 'chat'; records = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
  vi.stubGlobal('matchMedia', () => ({ get matches() { return narrow }, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const viewport = Object.assign(new EventTarget(), { width: 360, height: 720, offsetLeft: 0, offsetTop: 0 })
  vi.stubGlobal('visualViewport', viewport)
  document.body.innerHTML = '<div data-dsh-frame data-sidebar-collapsed><div data-rightbar-col><div data-sidebar-right-panel="fullscreen" data-sidebar-right-open data-sidebar-right-session="owner"><div data-dockkit-host="dock"><section data-dockkit-pane="p" data-dockkit-pane-active><header><div data-dockkit-strip="p"><div data-dockkit-strip-tabs="p"></div><button data-sidebar-right-mode="push" aria-label="退出全屏"><svg /></button><button data-sidebar-right-toggle aria-label="收起工作面板"><svg /></button><button data-dockkit-add aria-label="新建标签"><svg /></button></div></header><div data-tab-body><input value="draft" /><div data-terminal>running</div></div></section></div></div></div></div>'
  panel = document.querySelector('[data-sidebar-right-panel]')!
  vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 360, 720))
  vi.spyOn(panel.querySelector<HTMLElement>('[data-dockkit-strip]')!, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 360, 48))
  addTab('chat'); addTab('child'); addTab('browser', 'browser'); addTab('terminal', 'terminal'); addTab('screen', 'vdisplay')
  panel.querySelector<HTMLButtonElement>('[data-sidebar-right-toggle]')!.addEventListener('click', () => { panel.removeAttribute('data-sidebar-right-open') })
  reorder = vi.fn((session: SessionId, source: TabId, before: TabId | undefined) => {
    if (session !== current) return false
    const sourceNode = native(source), targetNode = before ? native(before) : null
    sourceNode.parentElement!.insertBefore(sourceNode, targetNode)
    return true
  })
  bubbles = new SidebarBubbles({ session: () => current, tabs: () => records, reorder, t })
  bubbles.attach()
})
afterEach(() => {
  back?.detach(); back = undefined
  bubbles.detach()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('narrow navigation over native tabs', () => {
  it('starts collapsed, shows the current identity and maps every opened tab in native order', () => {
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(popover().getAttribute('aria-hidden')).toBe('true')
    expect(panel.querySelector('.dsh-bubble-heading')?.textContent).toBe('chat')
    expect([...panel.querySelectorAll('[data-dsh-bubble-tab]')].map(node => node.getAttribute('data-dsh-bubble-tab'))).toEqual(['chat', 'child', 'browser', 'terminal', 'screen'])
    expect(select('terminal').getAttribute('aria-label')).toBe('终端: terminal')
    expect(select('screen').getAttribute('aria-label')).toBe('虚拟屏: screen')
    expect(select('chat').getAttribute('aria-pressed')).toBe('true')
    expect(select('chat').querySelectorAll('svg')).toHaveLength(1)
  })
  it('0.14.9：收起后面板里的气泡头保持挂载（滑出过渡由 CSS 播放），不会被瞬间移除', () => {
    expect(panel.querySelector('.dsh-bubble-header')).not.toBeNull()
    panel.querySelector<HTMLButtonElement>('[data-sidebar-right-toggle]')!.click()
    vi.advanceTimersByTime(20)
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(false)
    // 收起态不卸载：若移除节点，CSS 的 translateX 收起过渡无从播放，顶栏就是瞬移消失。
    expect(panel.querySelector('.dsh-bubble-header')).not.toBeNull()
    expect(panel.querySelectorAll('[data-dsh-sidebar-bubbles-toggle]')).toHaveLength(1)
  })
  it('0.14.9：全屏代理优先直调装配方通道；未提供时才回退 original.click()', () => {
    const fallback = vi.fn()
    panel.querySelector('[data-sidebar-right-mode]')!.addEventListener('click', fallback)
    const proxy = () => panel.querySelector<HTMLButtonElement>('.dsh-bubble-control[data-dsh-mode-proxy]')!
    // 缺省（无直调通道）：保留旧回退，行为不回归。
    proxy().click()
    expect(fallback).toHaveBeenCalledTimes(1)
    const direct = vi.fn()
    bubbles.detach()
    bubbles = new SidebarBubbles({ session: () => current, tabs: () => records, reorder, t, toggleFullscreen: direct })
    bubbles.attach()
    proxy().click()
    expect(direct).toHaveBeenCalledTimes(1)
    // 有直调通道时不再经过会空转的 original.click()。
    expect(fallback).toHaveBeenCalledTimes(1)
  })
  it('switches through the original tab and collapses without replacing bodies or inputs', async () => {
    const body = panel.querySelector('[data-tab-body]'), terminal = panel.querySelector('[data-terminal]')
    const input = panel.querySelector('input')!; input.value = 'unsent draft'
    toggle().click(); select('child').click(); await flush()
    expect(selected).toBe('child')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(panel.querySelector('.dsh-bubble-heading')?.textContent).toBe('child')
    expect(panel.querySelector('[data-tab-body]')).toBe(body)
    expect(panel.querySelector('[data-terminal]')).toBe(terminal)
    expect(panel.querySelector('input')).toBe(input)
    expect(input.value).toBe('unsent draft')
    expect(document.activeElement).toBe(toggle())
  })
  it('closes via the native close handler, retains the open list and updates the next selection', () => {
    toggle().click()
    row('chat').querySelector<HTMLButtonElement>('.dsh-bubble-close')!.click()
    expect(native('chat')).toBeNull()
    expect(selected).toBe('child')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(select('child').getAttribute('aria-pressed')).toBe('true')
    native('child').querySelector('[data-dockkit-tab-close]')!.remove()
    bubbles.refresh(); vi.advanceTimersByTime(20)
    expect(row('child').querySelector<HTMLButtonElement>('.dsh-bubble-close')!.hidden).toBe(true)
  })
  it('updates streamed title and status markup without rendering a second tab body', async () => {
    native('browser').querySelector('[data-dockkit-tab-title]')!.innerHTML = '<span>Docs</span><span role="status" aria-label="正在加载">…</span>'
    await flush()
    expect(select('browser').textContent).toContain('Docs')
    expect(select('browser').querySelector('[role=status]')?.getAttribute('aria-label')).toBe('正在加载')
    expect(panel.querySelectorAll('[data-tab-body]')).toHaveLength(1)
    expect(popover().querySelector('[data-sidebar-right-tab]')).toBeNull()
  })
  it('keeps many tabs vertically scrollable inside the visual viewport including the keyboard', async () => {
    for (let index = 0; index < 35; index++) addTab('extra-' + index)
    await flush()
    expect(panel.querySelectorAll('[data-dsh-bubble-tab]')).toHaveLength(40)
    expect(parseFloat(popover().style.maxHeight)).toBeLessThan(720)
    Object.assign(window.visualViewport!, { height: 280 })
    window.visualViewport!.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(20)
    expect(parseFloat(popover().style.maxHeight)).toBeLessThanOrEqual(214)
    expect(parseFloat(popover().style.width)).toBeLessThanOrEqual(336)
  })
  it('consumes outside clicks instead of activating the underlying work panel', () => {
    const danger = vi.fn(); panel.querySelector('[data-tab-body]')!.addEventListener('click', danger)
    toggle().click()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    panel.querySelector('.dsh-bubble-mask')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(danger).not.toHaveBeenCalled()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
  })
  it('honors native IME insets when Android keeps visualViewport at full height', () => {
    document.documentElement.style.setProperty('--dsh-android-ime-bottom', '300px')
    try {
      bubbles.refresh(); vi.advanceTimersByTime(20); toggle().click()
      expect(parseFloat(popover().style.top) + parseFloat(popover().style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 300 - 12)
    } finally { document.documentElement.style.removeProperty('--dsh-android-ime-bottom') }
  })
  it('survives rapid toggles and restores native navigation at the width breakpoint', async () => {
    for (let index = 0; index < 25; index++) toggle().click()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(panel.querySelectorAll('[data-dsh-sidebar-bubbles-toggle]')).toHaveLength(1)
    narrow = false; window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(20)
    expect(panel.querySelector('[data-dsh-bubble-nav]')).toBeNull()
    expect(panel.querySelector('[data-dsh-bubble-native]')).toBeNull()
    expect(native('chat').closest('[data-dockkit-strip]')!.hasAttribute('aria-hidden')).toBe(false)
    narrow = true; window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(20)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(selected).toBe('chat')
    bubbles.detach(); bubbles.attach(); await flush()
    expect(panel.querySelectorAll('[data-dsh-sidebar-bubbles-toggle]')).toHaveLength(1)
  })
  it('rejects delayed clicks and drag commits after the main session changes', () => {
    toggle().click(); current = 'other' as SessionId
    select('child').click()
    expect(selected).toBe('chat')
    expect(reorder).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(panel.querySelector('[data-dsh-bubble-nav]')).toBeNull()
  })
  it('rebinds controls after the selected tab remounts an identical native strip', async () => {
    const old = panel.querySelector<HTMLElement>('[data-dockkit-strip]')!
    const replacement = old.cloneNode(true) as HTMLElement
    replacement.removeAttribute('data-dsh-bubble-native'); replacement.removeAttribute('aria-hidden')
    const add = vi.fn(), collapse = vi.fn()
    replacement.querySelector('[data-dockkit-add]')!.addEventListener('click', add)
    replacement.querySelector('[data-sidebar-right-toggle]')!.addEventListener('click', collapse)
    old.replaceWith(replacement); await flush(); toggle().click()
    popover().querySelector<HTMLButtonElement>('[aria-label="新建标签"]')!.click()
    panel.querySelector<HTMLButtonElement>('.dsh-bubble-control[aria-label="收起工作面板"]')!.click()
    expect(add).toHaveBeenCalledTimes(1); expect(collapse).toHaveBeenCalledTimes(1)
    expect(old.hasAttribute('data-dsh-bubble-native')).toBe(false)
    expect(old.hasAttribute('aria-hidden')).toBe(false)
    expect(replacement.getAttribute('aria-hidden')).toBe('true')
  })
  it('proxies the existing chrome and add action including disabled controls', () => {
    const add = vi.fn(); panel.querySelector('[data-dockkit-add]')!.addEventListener('click', add)
    toggle().click()
    popover().querySelector<HTMLButtonElement>('[aria-label="新建标签"]')!.click()
    expect(add).toHaveBeenCalledTimes(1)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('native order commits and gesture separation', () => {
  it('leaves quick swipes and taps to normal scrolling and selection', () => {
    toggle().click(); geometry()
    pointer('pointerdown', select('chat')); pointer('pointermove', document, 150, 125)
    vi.advanceTimersByTime(450); pointer('pointerup', document, 150, 125)
    expect(reorder).not.toHaveBeenCalled()
    expect(row('chat').hasAttribute('data-dragging')).toBe(false)
    select('child').click(); expect(selected).toBe('child')
  })
  it('commits a long drag once, keeps the list open and suppresses the release click', () => {
    toggle().click(); geometry()
    pointer('pointerdown', select('chat'), 150, 94)
    vi.advanceTimersByTime(401)
    expect(row('chat').hasAttribute('data-dragging')).toBe(true)
    pointer('pointermove', document, 150, 212)
    expect(reorder).not.toHaveBeenCalled()
    pointer('pointerup', document, 150, 212)
    expect(reorder).toHaveBeenCalledTimes(1)
    expect(reorder).toHaveBeenCalledWith(owner, id('chat'), id('terminal'))
    expect([...panel.querySelectorAll('[data-dsh-bubble-tab]')].map(node => node.getAttribute('data-dsh-bubble-tab'))).toEqual(['child', 'browser', 'chat', 'terminal', 'screen'])
    select('chat').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(selected).toBe('chat')
  })
  it('cancels pointer cancellation, extra fingers, scrolling and releases outside the list', () => {
    toggle().click(); geometry()
    pointer('pointerdown', select('chat')); vi.advanceTimersByTime(410)
    pointer('pointercancel', document)
    pointer('pointerdown', select('chat')); select('chat').dispatchEvent(new Event('wheel', { bubbles: true })); vi.advanceTimersByTime(410)
    expect(row('chat').hasAttribute('data-dragging')).toBe(false)
    pointer('pointerdown', select('chat')); vi.advanceTimersByTime(410)
    const touch = new Event('touchstart', { bubbles: true }); Object.defineProperty(touch, 'touches', { value: [{}, {}] }); document.dispatchEvent(touch)
    pointer('pointerup', document)
    pointer('pointerdown', select('chat')); vi.advanceTimersByTime(410)
    pointer('pointermove', document, 150, 212); pointer('pointerup', document, 2, 600)
    expect(reorder).not.toHaveBeenCalled()
    expect(row('chat').hasAttribute('data-dragging')).toBe(false)
  })
  it('keeps a stationary hold through background scroll and suppresses context menus on the captured list', () => {
    toggle().click(); geometry()
    pointer('pointerdown', select('chat'))
    document.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(410)
    expect(row('chat').hasAttribute('data-dragging')).toBe(true)
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true })
    panel.querySelector('.dsh-bubble-list')!.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    pointer('pointercancel', document)
  })
  it('scrolls at the drag edge and releases all pending work on detach', () => {
    toggle().click(); geometry()
    pointer('pointerdown', select('chat')); vi.advanceTimersByTime(410)
    pointer('pointermove', document, 150, 410); vi.advanceTimersByTime(80)
    expect(popover().scrollTop).toBeGreaterThan(0)
    bubbles.detach(); vi.advanceTimersByTime(1000)
    expect(panel.querySelector('[data-dsh-bubble-nav]')).toBeNull()
    expect(reorder).not.toHaveBeenCalled()
  })
})

describe('keyboard and Android back', () => {
  it('keeps native views hidden through collapse and cancels obsolete collapse completions on reopen', () => {
    toggle().click(); toggle().click()
    expect(popover().getAttribute('data-dsh-sidebar-bubbles')).toBe('closing')
    vi.advanceTimersByTime(100); toggle().click(); vi.advanceTimersByTime(500)
    expect(popover().getAttribute('data-dsh-sidebar-bubbles')).toBe('open')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    toggle().click(); vi.advanceTimersByTime(240)
    expect(popover().getAttribute('data-dsh-sidebar-bubbles')).toBe('closed')
  })
  it('navigates, reorders and closes with the keyboard without activating on arrow focus', () => {
    toggle().click()
    select('chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(select('child'))
    expect(selected).toBe('chat')
    select('child').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    expect(reorder).toHaveBeenLastCalledWith(owner, id('child'), id('chat'))
    expect(document.activeElement).toBe(select('child'))
    select('child').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle())
  })
  it('handles the first system back after a canceled hold and restores toggle focus', () => {
    back = new BackStackSignal({ toggleSidebar: vi.fn(), activePanelId: () => null, leaveMainPanel: vi.fn() })
    back.attach(); geometry()
    for (const canceledBy of ['pointercancel', 'blur']) {
      toggle().click(); pointer('pointerdown', select('chat')); vi.advanceTimersByTime(410)
      if (canceledBy === 'pointercancel') pointer('pointercancel', document)
      else window.dispatchEvent(new Event('blur'))
      expect(window.__dshBack?.()).toBe(true)
      expect(toggle().getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(toggle())
      expect(reorder).not.toHaveBeenCalled()
    }
  })
  it('closes bubbles first, then enters the existing panel back path even on rapid back presses', () => {
    const collapse = vi.fn(); panel.querySelector('[data-sidebar-right-mode]')!.addEventListener('click', collapse)
    back = new BackStackSignal({ toggleSidebar: vi.fn(), activePanelId: () => null, leaveMainPanel: vi.fn() })
    back.attach(); toggle().click()
    expect(window.__dshBack?.()).toBe(true)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(collapse).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(toggle())
    expect(window.__dshBack?.()).toBe(true)
    expect(collapse).toHaveBeenCalledTimes(1)
  })
})

describe('workspace drag safety', () => {
  function workspaceNavigation() {
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    bubbles.detach()
    const navigation = { activeId: id('chat'), hiddenTabs: new Set<TabId>(), single: vi.fn(() => true), split: vi.fn(() => true), float: vi.fn(() => true), preview: vi.fn(() => true), drop: vi.fn(() => true), clearPreview: vi.fn() }
    bubbles = new SidebarBubbles({ session: () => current, tabs: () => records, reorder, t, workspaces: navigation })
    bubbles.attach(); toggle().click(); geometry()
    return navigation
  }
  it('keeps the 24px safety buffer out of split mode and restores cancellation without committing order', () => {
    const navigation = workspaceNavigation()
    pointer('pointerdown', select('child'), 150, 130); vi.advanceTimersByTime(400)
    pointer('pointermove', document, 17, 180); vi.advanceTimersByTime(300)
    expect(navigation.preview).not.toHaveBeenCalled()
    pointer('pointercancel', document, 17, 180)
    expect(navigation.drop).not.toHaveBeenCalled(); expect(reorder).not.toHaveBeenCalled()
    expect(document.querySelector('.dsh-bubble-drag-ghost')).toBeNull()
    expect(popover().hasAttribute('data-drag-out')).toBe(false)
  })
  it('requires a stable out-of-buffer dwell, then commits only the previewed workspace drop', () => {
    const navigation = workspaceNavigation()
    pointer('pointerdown', select('child'), 150, 130); vi.advanceTimersByTime(400)
    pointer('pointermove', document, 10, 220); vi.advanceTimersByTime(149)
    expect(navigation.preview).not.toHaveBeenCalled()
    vi.advanceTimersByTime(32)
    expect(navigation.preview).toHaveBeenCalledWith(id('child'), 10, 220)
    expect(popover().hasAttribute('data-drag-out')).toBe(true)
    pointer('pointerup', document, 10, 220)
    expect(navigation.drop).toHaveBeenCalledTimes(1)
    expect(navigation.drop).toHaveBeenCalledWith(id('child'), 10, 220)
    expect(reorder).not.toHaveBeenCalled()
    expect(popover().hasAttribute('data-drag-out')).toBe(false)
    expect(document.querySelector('.dsh-bubble-drag-ghost')).toBeNull()
  })
  it('clears an out-of-buffer preview on reentry without switching to a floating panel', () => {
    const navigation = workspaceNavigation()
    pointer('pointerdown', select('child'), 150, 130); vi.advanceTimersByTime(400)
    pointer('pointermove', document, 10, 220); vi.advanceTimersByTime(192)
    expect(navigation.preview).toHaveBeenCalled()
    pointer('pointermove', document, 17, 220)
    expect(popover().hasAttribute('data-drag-out')).toBe(false)
    pointer('pointerup', document, 17, 220)
    expect(navigation.drop).not.toHaveBeenCalled(); expect(navigation.float).not.toHaveBeenCalled()
    expect(reorder).not.toHaveBeenCalled()
  })
})
