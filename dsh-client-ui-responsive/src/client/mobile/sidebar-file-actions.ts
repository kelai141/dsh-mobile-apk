/**
 * Right-sidebar single-click [↗] light menu for external open and system share.
 * Mounted inside the C2 bubble header trailing slot in mobile/tablet forms and
 * reused by DocumentExternalMenuAction in desktop-landscape.
 */
import type { TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { parseFileAddress, resolveAbsolutePath } from './address.ts'
import {
  openExternalFile,
  shareExternalFile,
  type CardBridgeResult,
  type FileCardBridge,
} from './file-card-actions.ts'
import type { SidebarFileActionsKey } from './sidebar-file-actions.locales.ts'

const TRIGGER_ATTR = 'data-dsh-file-action-trigger'
const MENU_ATTR = 'data-dsh-file-action-menu'
const ITEM_ATTR = 'data-dsh-file-action'
const TOAST_ATTR = 'data-dsh-file-action-toast'
const TOAST_MS = 3000

const ICON_EXPORT = 'M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4'
const ICON_OPEN = 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z'
const ICON_SHARE = 'M21 3 11 13M21 3l-6.5 18-3.5-8-8-3.5z'

export function createFileActionSvg(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

export const FILE_ACTION_TRIGGER_ICON = ICON_EXPORT

/**
 * Resolve a right-sidebar tab to an absolute device path when it represents a file.
 * Non-file tabs (conversation, terminal, browser, vdisplay, files tree) return undefined.
 */
export function resolveFileTabPath(
  tab: Pick<TabRecord, 'kind' | 'contentId'> | undefined,
  getSessionCwd: (sessionId: string) => string | undefined,
): string | undefined {
  if (!tab?.contentId) return undefined
  if (tab.kind === 'files' || tab.kind === 'files-tree') return undefined
  const parsed = parseFileAddress(tab.contentId)
  if (parsed === undefined) return undefined
  const root = parsed.scope === 'session' ? getSessionCwd(parsed.sessionId) : undefined
  return resolveAbsolutePath(parsed, root)
}

function errorKey(result: CardBridgeResult): SidebarFileActionsKey {
  if (result.reason === 'unavailable') return 'unavailable'
  if (result.error === 'no-receiver') return 'noReceiver'
  if (result.error === 'io') return 'notReadable'
  if (result.error === 'uri-denied') return 'notAllowed'
  return 'failed'
}

export interface SidebarFileActionMenuOptions {
  readonly bridge: () => FileCardBridge
  readonly t: TranslateNS<'androidSidebarFileActions'>
  readonly onWillOpen?: () => void
}

/** Coordinates the right-sidebar [↗] trigger button and floating two-option menu. */
export class SidebarFileActionMenu {
  private host: HTMLElement | null = null
  private trigger: HTMLButtonElement | null = null
  private currentPath: string | undefined
  private menu: HTMLDivElement | null = null
  private activeAnchor: HTMLElement | null = null
  private activePath: string | undefined
  private toast: HTMLDivElement | null = null
  private toastTimer: number | null = null
  private attached = false
  private t: TranslateNS<'androidSidebarFileActions'>

  constructor(private readonly options: SidebarFileActionMenuOptions) {
    this.t = options.t
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true)
    document.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('resize', this.onResize)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onResize)
    this.close()
    this.clearTrigger()
    this.clearToast()
    this.host = null
    this.currentPath = undefined
  }

  setTranslate(t: TranslateNS<'androidSidebarFileActions'>): void {
    this.t = t
    if (this.trigger) {
      const label = this.t('trigger')
      this.trigger.setAttribute('aria-label', label)
      this.trigger.title = label
    }
    if (this.menu) {
      const openBtn = this.menu.querySelector<HTMLButtonElement>('[' + ITEM_ATTR + '="open"] span')
      const shareBtn = this.menu.querySelector<HTMLButtonElement>('[' + ITEM_ATTR + '="share"] span')
      if (openBtn) openBtn.textContent = this.t('openExternal')
      if (shareBtn) shareBtn.textContent = this.t('shareFile')
    }
  }

  /** Update the mobile/tablet C2 header trailing host for the active tab. */
  update(host: HTMLElement | null, absPath: string | undefined): void {
    if (!this.attached) this.attach()
    if (host === null || absPath === undefined || absPath === '') {
      if (this.menu && this.activeAnchor === this.trigger) this.close()
      this.clearTrigger()
      this.host = host
      this.currentPath = undefined
      return
    }
    if (this.currentPath !== absPath && this.menu && this.activeAnchor === this.trigger) {
      this.close()
    }
    this.host = host
    this.currentPath = absPath
    if (!this.trigger || !host.contains(this.trigger)) {
      this.clearTrigger()
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'dsh-file-action-trigger'
      btn.setAttribute(TRIGGER_ATTR, '')
      btn.setAttribute('aria-haspopup', 'menu')
      btn.setAttribute('aria-expanded', 'false')
      const label = this.t('trigger')
      btn.setAttribute('aria-label', label)
      btn.title = label
      btn.append(createFileActionSvg(ICON_EXPORT))
      btn.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        if (!this.currentPath) return
        this.openFor(btn, this.currentPath)
      })
      host.replaceChildren(btn)
      this.trigger = btn
    }
  }

  /** Toggle or open the two-option light menu anchored to a trigger button. */
  openFor(anchor: HTMLElement, absPath: string): void {
    if (!this.attached) this.attach()
    if (this.menu && this.activeAnchor === anchor && this.activePath === absPath) {
      this.close()
      return
    }
    this.close()
    this.options.onWillOpen?.()
    this.activeAnchor = anchor
    this.activePath = absPath
    anchor.setAttribute('aria-expanded', 'true')

    const menu = document.createElement('div')
    menu.className = 'dsh-file-action-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-context-menu', '')
    menu.setAttribute(MENU_ATTR, '')
    menu.setAttribute('aria-label', this.t('trigger'))

    menu.append(
      this.buildItem('open', ICON_OPEN, this.t('openExternal'), () => {
        const result = openExternalFile(this.options.bridge(), absPath)
        this.close()
        if (!result.ok) this.showError(result)
      }),
      this.buildItem('share', ICON_SHARE, this.t('shareFile'), () => {
        const result = shareExternalFile(this.options.bridge(), absPath)
        this.close()
        if (!result.ok) this.showError(result)
      }),
    )

    document.body.append(menu)
    this.menu = menu
    this.positionMenu(menu, anchor)
  }

  close(): void {
    if (this.menu) {
      this.menu.remove()
      this.menu = null
    }
    if (this.activeAnchor?.isConnected) {
      this.activeAnchor.setAttribute('aria-expanded', 'false')
    }
    this.activeAnchor = null
    this.activePath = undefined
  }

  private clearTrigger(): void {
    this.trigger?.remove()
    this.trigger = null
  }

  private buildItem(
    action: 'open' | 'share',
    iconPath: string,
    text: string,
    onSelect: () => void,
  ): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'dsh-file-action-item'
    item.setAttribute('role', 'menuitem')
    item.setAttribute(ITEM_ATTR, action)
    const label = document.createElement('span')
    label.textContent = text
    item.append(createFileActionSvg(iconPath), label)
    item.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      onSelect()
    })
    return item
  }

  private positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
    const a = anchor.getBoundingClientRect()
    const vw = window.innerWidth || 360
    const vh = window.innerHeight || 640
    const mw = Math.min(menu.offsetWidth || 200, vw - 16)
    const mh = menu.offsetHeight || 96
    const left = Math.max(8, Math.min(vw - mw - 8, (a.right > 0 ? a.right : vw - 12) - mw))
    const fitsBelow = a.bottom + 6 + mh <= vh - 12
    const top = fitsBelow
      ? Math.max(8, a.bottom + 6)
      : Math.max(8, a.top - mh - 6)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
  }

  private showError(result: CardBridgeResult): void {
    this.clearToast()
    const toast = document.createElement('div')
    toast.className = 'dsh-file-action-toast'
    toast.setAttribute(TOAST_ATTR, '')
    toast.setAttribute('role', 'status')
    toast.setAttribute('aria-live', 'polite')
    toast.textContent = this.t(errorKey(result))
    document.body.append(toast)
    this.toast = toast
    this.toastTimer = window.setTimeout(() => { this.clearToast() }, TOAST_MS)
  }

  private clearToast(): void {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    this.toast?.remove()
    this.toast = null
  }

  private readonly onOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.menu) return
    const target = event.target instanceof Element ? event.target : null
    if (target && (this.menu.contains(target) || this.activeAnchor?.contains(target))) return
    this.close()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.menu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      const anchor = this.activeAnchor
      this.close()
      anchor?.focus?.({ preventScroll: true })
    }
  }

  private readonly onResize = (): void => {
    if (this.menu) this.close()
  }
}
