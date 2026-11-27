import { visibleViewport } from './composer-popup-guard.ts'

const SELECT_TRIGGER = '[data-plugin-item-detail="web-search"] button[id^="plugin-config-web-"][aria-haspopup="menu"]'
const SELECT_MENU = '[role="menu"][data-anchor-side][data-match-anchor-width]'
const ADD_TRIGGER = '[data-plugin-panel] [data-plugin-toolbar] [role="group"] button[aria-haspopup="menu"]'
const ADD_MENU = '[role="menu"][data-anchor-side][class*="_addMenu"]'
const ADD_MENU_WIDTH = 320
const MENU_MARKER = 'data-dsh-plugin-select-menu'
const GAP = 4
const MARGIN = 12

// Mark the body portal for scoped styling and supply geometry only when
// the WebView lacks CSS anchors.
export function installPluginMenuPosition(): () => void {
  const needsAnchorFallback = !globalThis.CSS?.supports?.('top', 'anchor(bottom)')

  let releaseActive: (() => void) | undefined
  const mount = (trigger: HTMLElement): void => {
    const isAddMenu = trigger.matches(ADD_TRIGGER)
    if (isAddMenu && !needsAnchorFallback) return
    const group = isAddMenu ? trigger.closest('[role="group"]') : null
    const portalSelector = ':scope > ' + (isAddMenu ? ADD_MENU : SELECT_MENU)
    releaseActive?.()
    const existing = new Set(document.body.querySelectorAll(portalSelector))
    const viewport = window.visualViewport
    let menu: HTMLElement | undefined
    let frame: number | undefined
    let timeout: number | undefined
    let opened = false

    const position = (): void => {
      frame = undefined
      if (!trigger.isConnected || (opened && trigger.getAttribute('aria-expanded') !== 'true')) {
        cleanup()
        return
      }
      if (trigger.getAttribute('aria-expanded') !== 'true') return
      opened = true

      if (menu === undefined) {
        const candidates = [...document.body.querySelectorAll<HTMLElement>(portalSelector)]
          .filter(candidate => !existing.has(candidate))
        if (candidates.length !== 1) return
        menu = candidates[0]
        menu.setAttribute(MENU_MARKER, '')
        window.clearTimeout(timeout)
      } else if (!menu.isConnected) {
        cleanup()
        return
      }

      if (!needsAnchorFallback) return
      const bounds = visibleViewport()
      if (bounds === null) return
      const anchor = (group ?? trigger).getBoundingClientRect()
      const safeTop = Math.max(bounds.top, 0) + MARGIN
      const safeBottom = bounds.top + bounds.height - MARGIN
      const safeLeft = (viewport?.offsetLeft ?? 0) + MARGIN
      const safeRight = safeLeft + (viewport?.width ?? window.innerWidth) - 2 * MARGIN
      const startBelow = Math.max(safeTop, anchor.bottom + GAP)
      const endAbove = Math.min(safeBottom, anchor.top - GAP)
      const below = Math.max(0, safeBottom - startBelow)
      const above = Math.max(0, endAbove - safeTop)
      const content = menu.querySelector<HTMLElement>(':scope > [role="presentation"]')
      const naturalHeight = content === null ? menu.scrollHeight : content.scrollHeight + menu.offsetHeight - content.clientHeight
      const openDown = below >= naturalHeight || below >= above
      const width = Math.max(1, Math.min(isAddMenu ? ADD_MENU_WIDTH : anchor.width, safeRight - safeLeft))
      const preferredLeft = isAddMenu ? anchor.right - width : anchor.left
      const left = Math.max(safeLeft, Math.min(preferredLeft, safeRight - width))
      menu.style.setProperty('--dsh-select-left', left + 'px')
      menu.style.setProperty('--dsh-select-width', width + 'px')
      menu.style.setProperty('--dsh-select-top', openDown ? startBelow + 'px' : 'auto')
      menu.style.setProperty('--dsh-select-bottom', openDown ? 'auto' : window.innerHeight - endAbove + 'px')
      menu.style.setProperty('--dsh-select-height', Math.max(1, openDown ? below : above) + 'px')
    }

    const queue = (event?: Event): void => {
      if (event?.target instanceof Node && menu?.contains(event.target)) return
      if (frame === undefined) frame = requestAnimationFrame(position)
    }

    const observer = new MutationObserver(() => queue())
    const cleanup = (): void => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      window.removeEventListener('scroll', queue, true)
      window.removeEventListener('resize', queue)
      viewport?.removeEventListener('scroll', queue)
      viewport?.removeEventListener('resize', queue)
      if (menu !== undefined) {
        menu.removeAttribute(MENU_MARKER)
        for (const spec of ['left', 'width', 'top', 'bottom', 'height']) {
          menu.style.removeProperty('--dsh-select-' + spec)
        }
      }
      releaseActive = undefined
    }

    releaseActive = cleanup
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] })
    observer.observe(document.body, { childList: true })
    if (needsAnchorFallback) {
      window.addEventListener('scroll', queue, true)
      window.addEventListener('resize', queue)
      viewport?.addEventListener('scroll', queue)
      viewport?.addEventListener('resize', queue)
    }
    timeout = window.setTimeout(cleanup, 1000)
    queue()
  }

  const arm = (event: Event): void => {
    const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>(SELECT_TRIGGER + ', ' + ADD_TRIGGER) : null
    if (trigger && trigger.getAttribute('aria-expanded') !== 'true') mount(trigger)
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') arm(event)
  }

  document.addEventListener('click', arm, true)
  document.addEventListener('keydown', onKey, true)
  return () => {
    releaseActive?.()
    document.removeEventListener('click', arm, true)
    document.removeEventListener('keydown', onKey, true)
  }
}
