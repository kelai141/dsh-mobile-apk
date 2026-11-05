// @vitest-environment jsdom
// Source-only native ownership fixtures; never executed in this delegated change.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { NativeBrowserSession } from '../src/client/mobile/native-browser-adapter.ts'
import { parseNativeBrowserSnapshot } from '../src/client/mobile/native-browser-bridge.ts'

const SESSION = 'session-a'
const UI = 'ui-a' as TabId
const native = { tabId: 'native-a', uiTabId: UI, url: 'https://example.com/', title: 'Example',
  pageGeneration: 3, loadState: 'complete', canGoBack: true, canGoForward: false,
  profileAvailable: true, isolationAvailable: true, profileReason: '', identityId: 'android-real',
  viewportWidth: 390, viewportHeight: 844 }
function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, available: true, session: SESSION, profileAvailable: true, profileReason: '',
    tabId: native.tabId, tabs: [native], ...overrides })
}

afterEach(() => { delete window.androidBridge; vi.restoreAllMocks() })

describe('narrow native wire parser', () => {
  it('rejects invalid JSON, foreign session and duplicate native/UI identities', () => {
    expect(parseNativeBrowserSnapshot('{', SESSION).available).toBe(false)
    expect(parseNativeBrowserSnapshot(reply({ session: 'session-b' }), SESSION).reason).toBe('browser-reply-session-mismatch')
    expect(parseNativeBrowserSnapshot(reply({ tabs: [native, native] }), SESSION).available).toBe(false)
    expect(parseNativeBrowserSnapshot(reply({ tabs: [native, { ...native, tabId: 'native-b' }] }), SESSION).available).toBe(false)
  })
  it('does not infer profile readiness from browser availability', () => {
    const result = parseNativeBrowserSnapshot(JSON.stringify({ ok: true, available: true, session: SESSION,
      tabs: [{ tabId: 'native-a', url: 'https://example.com/', title: 'Example' }] }), SESSION)
    expect(result.available).toBe(true)
    expect(result.profileAvailable).toBe(false)
    expect(result.isolationAvailable).toBe(false)
    expect(result.tabs[0]?.profileReason).toBe('browser-profile-state-missing')
  })
  it('keeps browser availability separate from isolation availability', () => {
    const result = parseNativeBrowserSnapshot(JSON.stringify({ ok: true, available: true, browserAvailable: true,
      isolationAvailable: false, session: SESSION, profileAvailable: false, profileReason: 'browser-profile-not-ready',
      tabId: 'native-a', tabs: [{ ...native, profileAvailable: false, isolationAvailable: false,
        profileReason: 'browser-profile-not-ready' }] }), SESSION)
    expect(result.ok).toBe(true)
    expect(result.available).toBe(true)
    expect(result.isolationAvailable).toBe(false)
    expect(result.profileAvailable).toBe(false)
    expect(result.profileReason).toBe('browser-profile-not-ready')
    expect(result.reason).toBe('')
    expect(result.tabs[0]?.isolationAvailable).toBe(false)
  })
})

describe('native frame ownership and cleanup', () => {
  it('routes UI navigation to its own native tab and retains the native checkpoint', async () => {
    const command = vi.fn((_payload: string) => reply())
    window.androidBridge = { browserHostCommand: command }
    const owner = new NativeBrowserSession(SESSION)
    const persist = vi.fn()
    const page = owner.createPage({ tabId: UI, initial: undefined, persist, openRequested: vi.fn() })
    expect(page.frame.getSnapshot().target?.title).toBe('Example')
    page.frame.goBack()
    const payload = JSON.parse(command.mock.calls.at(-1)![0])
    expect(payload).toMatchObject({ action: 'back', session: SESSION, tabId: 'native-a', uiTabId: UI })
    expect(persist.mock.calls.at(-1)?.[0].nativeTabId).toBe('native-a')
    await page.frame.dispose()
    expect(command.mock.calls.map(([raw]) => JSON.parse(raw).action)).not.toContain('close')
    owner.dispose()
  })
  it('closes exactly the matching native tab only on explicit UI close', () => {
    const command = vi.fn((payload: string) => JSON.parse(payload).action === 'close' ? reply({ tabs: [], tabId: undefined }) : reply())
    window.androidBridge = { browserHostCommand: command }
    const owner = new NativeBrowserSession(SESSION)
    owner.refresh()
    owner.closeUi(UI)
    const closes = command.mock.calls.map(([raw]) => JSON.parse(raw)).filter(call => call.action === 'close')
    expect(closes).toEqual([{ action: 'close', session: SESSION, tabId: 'native-a', uiTabId: UI }])
    owner.dispose()
  })
  it('does not claim a native tab already owned by another live UI occurrence', () => {
    window.androidBridge = { browserHostCommand: vi.fn(() => reply()) }
    const owner = new NativeBrowserSession(SESSION)
    owner.refresh()
    expect(owner.claim('other-ui', 'native-a')).toBe(false)
    owner.dispose()
  })
  it('a foreign-session reply never grants a frame, binding or ready profile', () => {
    window.androidBridge = { browserHostCommand: () => reply({ session: 'session-b' }) }
    const owner = new NativeBrowserSession(SESSION)
    const page = owner.createPage({ tabId: UI, initial: undefined, persist: vi.fn(), openRequested: vi.fn() })
    expect(owner.nativeTabId(UI)).toBeUndefined()
    expect(page.frame.getSnapshot().target).toBeUndefined()
    expect(owner.controlSource(UI).getSnapshot().available).toBe(false)
    owner.dispose()
  })
})
