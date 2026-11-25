// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import {
  SidebarFileActionMenu,
  resolveFileTabPath,
} from '../src/client/mobile/sidebar-file-actions.ts'
import { SIDEBAR_FILE_ACTIONS_CSS } from '../src/client/mobile/sidebar-file-actions.css.ts'
import { zh, en } from '../src/client/mobile/sidebar-file-actions.locales.ts'
import type { FileCardBridge } from '../src/client/mobile/file-card-actions.ts'

const tZh: TranslateNS<'androidSidebarFileActions'> = (key) => zh[key]

describe('resolveFileTabPath', () => {
  it('resolves session file and absolute file tabs while returning undefined for non-file tabs', () => {
    const getCwd = (sid: string) => (sid === 's1' ? '/data/data/com.dsharnessmobile.shell/files/home/ws' : undefined)

    expect(
      resolveFileTabPath(
        { kind: 'document', contentId: 'dsh-resource://file/session/s1/docs/report.md' },
        getCwd,
      ),
    ).toBe('/data/data/com.dsharnessmobile.shell/files/home/ws/docs/report.md')

    expect(
      resolveFileTabPath(
        { kind: '@dsh-android/client-ui-responsive/open-with', contentId: 'dsh-resource://file/absolute/storage/emulated/0/Download/app.bundle' },
        getCwd,
      ),
    ).toBe('/storage/emulated/0/Download/app.bundle')

    expect(resolveFileTabPath({ kind: 'conversation', contentId: 'dsh-resource://conversation/c1' }, getCwd)).toBeUndefined()
    expect(resolveFileTabPath({ kind: 'terminal', contentId: 'dsh-resource://terminal/t1' }, getCwd)).toBeUndefined()
    expect(resolveFileTabPath({ kind: 'browser', contentId: 'dsh-resource://browser/b1' }, getCwd)).toBeUndefined()
    expect(resolveFileTabPath({ kind: 'vdisplay', contentId: 'dsh-resource://vdisplay/v1' }, getCwd)).toBeUndefined()
    expect(resolveFileTabPath({ kind: 'files', contentId: 'dsh-resource://file/session/s1/.' }, getCwd)).toBeUndefined()
  })
})

describe('SidebarFileActionMenu', () => {
  let host: HTMLDivElement
  let bridge: FileCardBridge
  let menu: SidebarFileActionMenu
  let onWillOpen: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.append(host)
    bridge = {
      openFileExternal: vi.fn(() => JSON.stringify({ ok: true })),
      shareFile: vi.fn(() => JSON.stringify({ ok: true })),
    }
    onWillOpen = vi.fn()
    menu = new SidebarFileActionMenu({ bridge: () => bridge, t: tZh, onWillOpen })
    menu.attach()
  })

  afterEach(() => {
    menu.detach()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('mounts [↗] trigger for file tabs and removes it for non-file tabs', () => {
    menu.update(host, '/storage/emulated/0/Download/report.md')
    const trigger = host.querySelector<HTMLButtonElement>('[data-dsh-file-action-trigger]')
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu')

    menu.update(host, undefined)
    expect(host.querySelector('[data-dsh-file-action-trigger]')).toBeNull()
  })

  it('opens two-option light menu on single click and invokes openFileExternal & shareFile with normalized MIME', () => {
    const absPath = '/storage/emulated/0/Download/report.md'
    menu.update(host, absPath)
    const trigger = host.querySelector<HTMLButtonElement>('[data-dsh-file-action-trigger]')!
    trigger.click()

    expect(onWillOpen).toHaveBeenCalledTimes(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const popup = document.querySelector<HTMLElement>('[data-dsh-file-action-menu]')
    expect(popup).not.toBeNull()
    expect(popup?.getAttribute('role')).toBe('menu')

    const openItem = popup!.querySelector<HTMLButtonElement>('[data-dsh-file-action="open"]')!
    const shareItem = popup!.querySelector<HTMLButtonElement>('[data-dsh-file-action="share"]')!
    expect(openItem.textContent).toBe(zh.openExternal)
    expect(shareItem.textContent).toBe(zh.shareFile)

    openItem.click()
    expect(bridge.openFileExternal).toHaveBeenCalledWith(absPath, 'text/plain')
    expect(document.querySelector('[data-dsh-file-action-menu]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    trigger.click()
    document.querySelector<HTMLButtonElement>('[data-dsh-file-action="share"]')!.click()
    expect(bridge.shareFile).toHaveBeenCalledWith(absPath, 'text/plain')
  })

  it('dismisses on outside pointerdown or Escape and shows bilingual error toast without disabling retry', () => {
    const absPath = '/data/data/com.dsharnessmobile.shell/files/home/.dsh/settings.yaml'
    menu.update(host, absPath)
    const trigger = host.querySelector<HTMLButtonElement>('[data-dsh-file-action-trigger]')!

    trigger.click()
    expect(document.querySelector('[data-dsh-file-action-menu]')).not.toBeNull()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('[data-dsh-file-action-menu]')).toBeNull()

    trigger.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.querySelector('[data-dsh-file-action-menu]')).toBeNull()

    ;(bridge.shareFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify({ ok: false, error: 'uri-denied' }))
    trigger.click()
    document.querySelector<HTMLButtonElement>('[data-dsh-file-action="share"]')!.click()
    const toast = document.querySelector('[data-dsh-file-action-toast]')
    expect(toast?.textContent).toBe(zh.notAllowed)
    expect(trigger.disabled).toBe(false)

    // Bilingual dictionary completeness
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())

    vi.advanceTimersByTime(3100)
    expect(document.querySelector('[data-dsh-file-action-toast]')).toBeNull()
  })

  it('CSS hides desktop toolbar button in splits, floats, and non-desktop device forms', () => {
    expect(SIDEBAR_FILE_ACTIONS_CSS).toContain("html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-doc-action-trigger]")
    expect(SIDEBAR_FILE_ACTIONS_CSS).toContain("[data-dockkit-host='float'] [data-dsh-doc-action-trigger]")
    expect(SIDEBAR_FILE_ACTIONS_CSS).toContain("[data-dsh-workspaces='2'] [data-dsh-doc-action-trigger]")
  })
})
