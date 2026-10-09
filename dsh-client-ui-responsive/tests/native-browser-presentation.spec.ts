// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_STAGE_LEASE_MS, NativeBrowserPresentation } from '../src/client/mobile/native-browser-presentation.ts'

let changes: MutationCallback
let hidden = false
let visible = true
let owner: NativeBrowserPresentation
let bounds: ReturnType<typeof vi.fn>
function rect(left = 20, top = 50, width = 300, height = 400): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }
}
function stage(): HTMLElement {
  const element = document.createElement('div')
  element.id = 'stage'
  element.getBoundingClientRect = () => rect()
  document.body.append(element)
  return element
}
function latest(): Record<string, unknown> { return JSON.parse(bounds.mock.calls.at(-1)![0]) }
function mutate(): void { changes([], {} as MutationObserver); vi.advanceTimersByTime(20) }

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  hidden = false; visible = true
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('MutationObserver', class { constructor(callback: MutationCallback) { changes = callback } observe() {} disconnect() {} })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 16))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id))
  bounds = vi.fn(() => '{}')
  window.androidBridge = { browserHostBounds: bounds }
  owner = new NativeBrowserPresentation({ session: 'session-a', uiTabId: 'ui-a', nativeTabId: () => 'native-a',
    visible: () => visible, ready: () => true })
})
afterEach(() => { owner.detach(); delete window.androidBridge; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('native browser stage ownership lease (#341)', () => {
  it('renews unchanged visible bounds beyond the native 4000ms TTL without reopening a page', () => {
    stage(); owner.mount('stage'); vi.advanceTimersByTime(6000)
    expect(BROWSER_STAGE_LEASE_MS).toBeLessThan(4000)
    expect(bounds).toHaveBeenCalledTimes(7)
    expect(latest()).toMatchObject({ session: 'session-a', tabId: 'native-a', uiTabId: 'ui-a', visible: true })
    expect(new Set(bounds.mock.calls.map(call => call[0])).size).toBe(1)
  })
  it('dedupes ordinary refreshes and stops renewal on detach', () => {
    stage(); const release = owner.mount('stage'); owner.refresh(); owner.refresh()
    expect(bounds).toHaveBeenCalledTimes(1)
    release(); expect(latest().visible).toBe(false)
    const count = bounds.mock.calls.length
    vi.advanceTimersByTime(6000); expect(bounds).toHaveBeenCalledTimes(count)
  })
  it('does not starve the lease under repeated unchanged DOM mutations', () => {
    stage(); owner.mount('stage')
    for (let count = 0; count < 100; count++) { mutate(); vi.advanceTimersByTime(40) }
    expect(bounds.mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(latest().visible).toBe(true)
  })
  it('hides synchronously on backgrounding and force-replays on returning', () => {
    stage(); owner.mount('stage'); hidden = true; document.dispatchEvent(new Event('visibilitychange'))
    expect(latest().visible).toBe(false)
    const count = bounds.mock.calls.length
    vi.advanceTimersByTime(6000); expect(bounds).toHaveBeenCalledTimes(count)
    hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    expect(latest().visible).toBe(true)
    window.dispatchEvent(new Event('focus')); expect(bounds).toHaveBeenCalledTimes(count + 2)
  })
  it('attaches when the official stage appears after mount', () => {
    owner.mount('stage'); expect(bounds).not.toHaveBeenCalled()
    stage(); mutate(); expect(latest().visible).toBe(true)
  })
  it('stops renewing when the stage is disconnected or the occurrence becomes invisible', () => {
    const element = stage(); owner.mount('stage'); element.remove(); mutate()
    const count = bounds.mock.calls.length
    vi.advanceTimersByTime(6000); expect(bounds).toHaveBeenCalledTimes(count)
    stage(); mutate(); visible = false; owner.refresh(); expect(latest().visible).toBe(false)
    const hiddenCount = bounds.mock.calls.length
    vi.advanceTimersByTime(6000); expect(bounds).toHaveBeenCalledTimes(hiddenCount)
  })
  it('retries a temporarily unavailable bridge only for a mounted visible stage', () => {
    stage(); delete window.androidBridge; owner.mount('stage')
    window.androidBridge = { browserHostBounds: bounds }
    vi.advanceTimersByTime(BROWSER_STAGE_LEASE_MS); expect(bounds).not.toHaveBeenCalled()
    owner.refresh(); expect(latest().visible).toBe(true)
  })
  it('stops lease retries after a bridge exception until an external event', () => {
    stage(); window.androidBridge = { browserHostBounds: () => { throw new Error('bridge unavailable') } }
    owner.mount('stage'); vi.advanceTimersByTime(6000)
    expect(bounds).not.toHaveBeenCalled()
    window.androidBridge = { browserHostBounds: bounds }; owner.refresh()
    expect(latest().visible).toBe(true)
  })
  it('ignores offscreen portals and dialogs hidden by an ancestor', () => {
    stage()
    const parent = document.createElement('div'); parent.hidden = true
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.getBoundingClientRect = () => rect()
    parent.append(dialog); document.body.append(parent)
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.getBoundingClientRect = () => rect(-500, 50)
    document.body.append(menu); owner.mount('stage'); expect(latest().visible).toBe(true)
  })
  it('suspends renewal under an actual dialog and restores after it closes', () => {
    stage(); owner.mount('stage')
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.getBoundingClientRect = () => rect()
    document.body.append(dialog); mutate(); expect(latest().visible).toBe(false)
    const count = bounds.mock.calls.length
    vi.advanceTimersByTime(5000); expect(bounds).toHaveBeenCalledTimes(count)
    dialog.remove(); mutate(); expect(latest().visible).toBe(true)
  })
})
