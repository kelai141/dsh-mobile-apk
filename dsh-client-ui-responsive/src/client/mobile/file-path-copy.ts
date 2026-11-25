/**
 * 450ms long-press full-path copy on the document preview Row 2 path bar (`[data-textpreview-path]`).
 * Applies across main pane, split panes, and floating windows without mutating upstream toolbar buttons.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'

export const LONG_PRESS_MS = 450
export const MOVE_SLOP_PX = 10
const TOAST_MS = 1800
const PATH_SELECTOR = '[data-textpreview-path]'
const TOAST_ATTR = 'data-dsh-path-copy-toast'

/** Extract the full file path from a clicked/pressed element inside `[data-textpreview-path]`. */
export function extractPreviewPath(target: Element | null): string | undefined {
  const node = target?.closest(PATH_SELECTOR)
  if (!node) return undefined
  const raw = node.getAttribute('title') || node.textContent
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/** Write text using AndroidBridge.copyText first, falling back to navigator.clipboard.writeText. */
export async function copyPathToClipboard(path: string): Promise<boolean> {
  if (!path) return false
  try {
    const bridge = window.androidBridge as { copyText?: (text: string) => boolean } | undefined
    if (typeof bridge?.copyText === 'function') {
      return Boolean(bridge.copyText.call(bridge, path))
    }
  } catch {
    // Fall through to navigator.clipboard when the shell bridge throws.
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(path)
      return true
    }
  } catch {
    return false
  }
  return false
}

interface PendingPress {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly path: string
  readonly host: Element
}

export class FilePathCopy {
  private attached = false
  private press: PendingPress | null = null
  private timer: number | null = null
  private suppressInteraction = false
  private suppressTimer: number | null = null
  private toast: HTMLDivElement | null = null
  private toastTimer: number | null = null

  constructor(private t: TranslateNS<'androidFilePathCopy'>) {}

  setTranslate(t: TranslateNS<'androidFilePathCopy'>): void {
    this.t = t
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    document.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('pointermove', this.onPointerMove, true)
    document.addEventListener('pointerup', this.onPointerUp, true)
    document.addEventListener('pointercancel', this.onPointerCancel, true)
    document.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true })
    document.addEventListener('scroll', this.onScroll, true)
    document.addEventListener('contextmenu', this.onContextMenu, true)
    document.addEventListener('click', this.onClick, true)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('pointerup', this.onPointerUp, true)
    document.removeEventListener('pointercancel', this.onPointerCancel, true)
    document.removeEventListener('touchstart', this.onTouchStart, true)
    document.removeEventListener('scroll', this.onScroll, true)
    document.removeEventListener('contextmenu', this.onContextMenu, true)
    document.removeEventListener('click', this.onClick, true)
    this.cancelPress()
    this.clearSuppression()
    this.clearToast()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.cancelPress()
    if (event.button !== 0 || event.isPrimary === false) return
    if (!(event.target instanceof Element)) return
    const host = event.target.closest(PATH_SELECTOR)
    if (!host) return
    const path = extractPreviewPath(host)
    if (!path) return
    this.suppressInteraction = false
    this.press = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      path,
      host,
    }
    this.timer = window.setTimeout(() => {
      this.timer = null
      const active = this.press
      if (!active || !active.host.isConnected) {
        this.press = null
        return
      }
      this.press = null
      this.armSuppression()
      void this.performCopy(active.path)
    }, LONG_PRESS_MS)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const active = this.press
    if (!active || event.pointerId !== active.pointerId) return
    const dx = Math.abs(event.clientX - active.startX)
    const dy = Math.abs(event.clientY - active.startY)
    if (Math.max(dx, dy) > MOVE_SLOP_PX) this.cancelPress()
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.press && event.pointerId === this.press.pointerId) this.cancelPress()
  }

  private readonly onPointerCancel = (): void => {
    this.cancelPress()
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length > 1) this.cancelPress()
  }

  private readonly onScroll = (): void => {
    if (this.press) this.cancelPress()
  }

  private readonly onContextMenu = (event: Event): void => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest(PATH_SELECTOR)) {
      event.preventDefault()
      if (this.suppressInteraction || this.press) event.stopImmediatePropagation()
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.suppressInteraction) return
    if (!(event.target instanceof Element) || !event.target.closest(PATH_SELECTOR)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.clearSuppression()
  }

  private async performCopy(path: string): Promise<void> {
    const ok = await copyPathToClipboard(path)
    if (!this.attached) return
    this.showToast(this.t(ok ? 'copied' : 'failed'))
  }

  private showToast(text: string): void {
    this.clearToast()
    const toast = document.createElement('div')
    toast.className = 'dsh-path-copy-toast'
    toast.setAttribute(TOAST_ATTR, '')
    toast.setAttribute('role', 'status')
    toast.setAttribute('aria-live', 'polite')
    toast.textContent = text
    document.body.append(toast)
    this.toast = toast
    this.toastTimer = window.setTimeout(() => { this.clearToast() }, TOAST_MS)
  }

  private cancelPress(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.press = null
  }

  private armSuppression(): void {
    this.clearSuppression()
    this.suppressInteraction = true
    this.suppressTimer = window.setTimeout(() => { this.clearSuppression() }, 600)
  }

  private clearSuppression(): void {
    this.suppressInteraction = false
    if (this.suppressTimer !== null) {
      clearTimeout(this.suppressTimer)
      this.suppressTimer = null
    }
  }

  private clearToast(): void {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    this.toast?.remove()
    this.toast = null
  }
}
