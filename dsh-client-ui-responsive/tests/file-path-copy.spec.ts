// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { FilePathCopy, LONG_PRESS_MS, extractPreviewPath } from '../src/client/mobile/file-path-copy.ts'
import { zh, en } from '../src/client/mobile/file-path-copy.locales.ts'

const tZh: TranslateNS<'androidFilePathCopy'> = (key) => zh[key]

function pointer(type: string, target: EventTarget, x = 80, y = 40, pointerId = 1): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } })
  target.dispatchEvent(event)
  return event
}

describe('FilePathCopy (450ms long press)', () => {
  let copier: FilePathCopy
  let copyText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    copyText = vi.fn(() => true)
    ;(window as unknown as { androidBridge?: { copyText: (t: string) => boolean } }).androidBridge = { copyText }
    copier = new FilePathCopy(tZh)
    copier.attach()
  })

  afterEach(() => {
    copier.detach()
    delete (window as unknown as { androidBridge?: unknown }).androidBridge
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('extracts full path from title attribute on [data-textpreview-path]', () => {
    document.body.innerHTML = '<span data-textpreview-path="true" title="/storage/emulated/0/Download/very/long/report.md"><span>report.md</span></span>'
    const inner = document.querySelector('[data-textpreview-path] span')!
    expect(extractPreviewPath(inner)).toBe('/storage/emulated/0/Download/very/long/report.md')
  })

  it('copies full path after 450ms hold, suppresses contextmenu, and shows bilingual toast', async () => {
    const abs = '/data/data/com.dsharnessmobile.shell/files/home/ws/src/report.md'
    document.body.innerHTML = `<div data-dockkit-host="float"><span data-textpreview-path="true" title="${abs}">report.md</span><button id="reload">reload</button></div>`
    const pathEl = document.querySelector('[data-textpreview-path]')!

    pointer('pointerdown', pathEl, 100, 50)
    vi.advanceTimersByTime(LONG_PRESS_MS - 50)
    expect(copyText).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60)
    await Promise.resolve()
    expect(copyText).toHaveBeenCalledWith(abs)
    expect(document.querySelector('[data-dsh-path-copy-toast]')?.textContent).toBe(zh.copied)

    const ctxMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    pathEl.dispatchEvent(ctxMenu)
    expect(ctxMenu.defaultPrevented).toBe(true)

    // Bilingual dictionary parity
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())

    vi.advanceTimersByTime(1900)
    expect(document.querySelector('[data-dsh-path-copy-toast]')).toBeNull()
  })

  it('cancels on early release, >10px drag, or scroll, and falls back to navigator.clipboard', async () => {
    delete (window as unknown as { androidBridge?: unknown }).androidBridge
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const abs = '/storage/emulated/0/Download/a.txt'
    document.body.innerHTML = `<div data-dsh-workspaces="2"><span data-textpreview-path="true" title="${abs}">a.txt</span></div>`
    const pathEl = document.querySelector('[data-textpreview-path]')!

    // Early release cancels
    pointer('pointerdown', pathEl, 50, 50)
    vi.advanceTimersByTime(200)
    pointer('pointerup', document, 50, 50)
    vi.advanceTimersByTime(400)
    expect(writeText).not.toHaveBeenCalled()

    // >10px move cancels
    pointer('pointerdown', pathEl, 50, 50)
    pointer('pointermove', document, 70, 50)
    vi.advanceTimersByTime(LONG_PRESS_MS + 20)
    expect(writeText).not.toHaveBeenCalled()

    // Scroll cancels
    pointer('pointerdown', pathEl, 50, 50)
    document.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(LONG_PRESS_MS + 20)
    expect(writeText).not.toHaveBeenCalled()

    // Valid hold uses navigator.clipboard fallback
    pointer('pointerdown', pathEl, 50, 50)
    vi.advanceTimersByTime(LONG_PRESS_MS + 10)
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith(abs)
  })
})
