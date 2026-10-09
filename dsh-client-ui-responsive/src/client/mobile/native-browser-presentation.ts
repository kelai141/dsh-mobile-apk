/** Position one native tab over only the official BrowserBody viewport. */
import type { BrowserPresentation } from './upstream-browser/view/BrowserPresentation.ts'
import type {} from '../android-bridge.ts'

/** Identity and visibility remain owned by the Session/occurrence adapter. */
export interface NativeBrowserPresentationOptions {
  readonly session: string
  readonly uiTabId: string
  readonly nativeTabId: () => string | undefined
  readonly visible: () => boolean
  readonly ready: () => boolean
}

// Must remain below BrowserOverlayPolicy.STAGE_BOUNDS_TTL_MS (4000ms).
export const BROWSER_STAGE_LEASE_MS = 1000

/** Native presentation never opens or closes a page; detach is targeted hide only. */
export class NativeBrowserPresentation implements BrowserPresentation {
  private release: (() => void) | undefined
  private publish: (() => void) | undefined

  constructor(private readonly options: NativeBrowserPresentationOptions) {}

  /** Republish after a framework-visible tab or native navigation change. */
  refresh(): void { this.publish?.() }

  mount(viewportId: string): () => void {
    this.release?.()
    let stage = document.getElementById(viewportId)
    let queued = 0
    let active = true
    let last = ''
    let lease: ReturnType<typeof window.setTimeout> | undefined
    const send = (visible: boolean, renew = false): boolean => {
      const tabId = this.options.nativeTabId()
      if (tabId === undefined || stage === null) return false
      const rect = stage.getBoundingClientRect()
      let left = Math.max(0, rect.left)
      let top = Math.max(0, rect.top)
      let right = Math.min(window.innerWidth, rect.right)
      let bottom = Math.min(window.innerHeight, rect.bottom)
      let displayed = stage.isConnected && !document.hidden
      for (let element: HTMLElement | null = stage; element !== null; element = element.parentElement) {
        const style = window.getComputedStyle(element)
        if (element.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') displayed = false
        const clip = element.getBoundingClientRect()
        if (/hidden|clip|scroll|auto/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
        if (/hidden|clip|scroll|auto/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      }
      // Android native views are above DOM portals; hide while app menus/dialogs own input.
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"], [aria-modal="true"], [role="listbox"]'))
        .some(element => {
          const bounds = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          if (bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false
          for (let ancestor: HTMLElement | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
            const ancestorStyle = window.getComputedStyle(ancestor)
            if (ancestor.hidden || ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || ancestorStyle.opacity === '0') return false
          }
          return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        })
      const stageVisible = visible && displayed && !overlay && document.querySelector('[data-dockkit-pointer]') === null
        && right - left > 1 && bottom - top > 1
      const payload = JSON.stringify({ session: this.options.session, tabId, uiTabId: this.options.uiTabId,
        left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top),
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        visible: stageVisible })
      if (payload === last && !(renew && stageVisible)) return stageVisible
      try {
        if (window.androidBridge?.browserHostBounds === undefined) return false
        window.androidBridge.browserHostBounds(payload)
        last = payload
      } catch (_bridgeUnavailable) { /* A later geometry or lifecycle event may retry. */ return false }
      return stageVisible
    }
    const publish = (renew = false): void => {
      if (!active) return
      // Renewal proves UI ownership; it never reloads or reconstructs the isolated page.
      // Deduped mutation/resize events must not postpone the next renewal indefinitely.
      if (send(this.options.visible() && this.options.ready(), renew)) {
        if (lease === undefined) lease = window.setTimeout(() => { lease = undefined; publish(true) }, BROWSER_STAGE_LEASE_MS)
      } else if (lease !== undefined) {
        window.clearTimeout(lease); lease = undefined
      }
    }
    const schedule = (): void => {
      if (queued !== 0 || !active) return
      queued = window.requestAnimationFrame(() => { queued = 0; publish() })
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => {
      const next = document.getElementById(viewportId)
      if (stage !== next) { send(false); resize?.disconnect(); stage = next; if (stage !== null) resize?.observe(stage); last = '' }
      schedule()
    })
    if (stage !== null) resize?.observe(stage)
    mutation?.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden', 'data-sidebar-right-open', 'data-dockkit-pointer'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    const restore = (): void => publish(true)
    document.addEventListener('visibilitychange', restore)
    window.addEventListener('pageshow', restore)
    window.addEventListener('focus', restore)
    this.publish = publish
    publish()
    const release = (): void => {
      if (!active) return
      active = false
      if (queued !== 0) window.cancelAnimationFrame(queued)
      if (lease !== undefined) window.clearTimeout(lease)
      resize?.disconnect()
      mutation?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      document.removeEventListener('visibilitychange', restore)
      window.removeEventListener('pageshow', restore)
      window.removeEventListener('focus', restore)
      send(false)
      if (this.release === release) { this.release = undefined; this.publish = undefined }
    }
    this.release = release
    return release
  }

  /** Release observers and hide only this Session's native tab. */
  detach(): void { this.release?.() }
}
