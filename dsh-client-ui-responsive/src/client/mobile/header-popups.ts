/**
 * Keep header action menus usable inside the mobile top bar fold.
 *
 * Most header actions render a portal. The background-jobs action intentionally
 * renders an anchored `<ul>` next to its trigger instead; when its owner is
 * inside the folded top-bar surface, that menu is clipped by the surface's
 * scrolling overflow. Promote only that semantic list to a viewport-fixed
 * overlay while it is open, keeping React's DOM ownership and dismissal logic.
 */
import { visibleViewport } from '../composer-popup-guard.ts'

const FOLD_SELECTOR = '[data-dsh-topbar-fold="open"]'
const JOBS_LIST_SELECTOR = 'ul[aria-label="后台任务"], ul[aria-label="Background jobs"]'
const SUBAGENT_PANEL = '[data-subagent-panel]'
const SUBAGENT_TRIGGER = '[data-subagent-action] button[aria-expanded="true"]'
const VIEW_OPTIONS_MENU = '[role="menu"][class*="_viewOptionsMenu"]'
const VIEW_OPTIONS_TRIGGER = '[data-sidebar-workspace-header] svg[data-icon="dsw-icon-sliders-two-outline-regular"]'
export const SESSION_MENU_TRIGGER = 'button[data-context-menu-trigger][class*="headerMenuButton"]'
const SESSION_MENU = '[data-context-menu][role="menu"]'
const MARKER = 'data-dsh-header-popup'
const OWNED_STYLES = ['position', 'top', 'left', 'right', 'width', 'max-width', 'max-height', 'overflow-y', 'z-index'] as const
const VIEWPORT_MARGIN = 12
const POPUP_GAP = 5
const ANCHORED_STYLES = [
  'top', 'bottom', 'left', 'right', 'width', 'max-width', 'max-height', 'position-try-fallbacks',
] as const

export const SUBAGENT_POPUP_CSS = `
[data-subagent-panel] > [class*="menuBody"] {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
`

interface StyleSnapshot {
  readonly value: string
  readonly priority: string
}

export function sessionHeaderMenu(trigger: Element | null | undefined): HTMLElement | null {
  if (trigger?.getAttribute('aria-expanded') !== 'true') return null
  const id = trigger.getAttribute('aria-controls')
  const menu = id ? document.getElementById(id) : null
  return menu?.matches(SESSION_MENU) ? menu : null
}

/** Adapt an expanded background-jobs menu to the visible mobile viewport. */
export class HeaderPopups {
  private observer: MutationObserver | null = null
  private active: HTMLUListElement | null = null
  private catalog: HTMLElement | null = null
  private viewOptions: HTMLElement | null = null
  private sessionMenu: HTMLElement | null = null
  private original = new Map<string, StyleSnapshot>()
  private attached = false
  private scheduled = false
  private frame: number | null = null
  private generation = 0

  private readonly onViewportChange = (): void => { this.schedule() }
  private readonly onImeChange = (): void => {
    if (this.active !== null || this.catalog !== null || this.viewOptions !== null || this.sessionMenu !== null) {
      this.schedule()
    }
  }
  /**
   * Scroll handler.
   *
   * The promotion only exists while the background-jobs list is open: with no active list,
   * sync() finds nothing and restores nothing. Before this gate every scroll event scheduled a
   * frame that ran a full-document query for the fold marker — one of the document queries per
   * scroll frame measured in tests/scroll-frame-budget.spec.ts. Resize stays ungated (rare, and
   * the fold marker can appear while the viewport changes).
   */
  private readonly onScroll = (event: Event): void => {
    const affects = (panel: HTMLElement | null): boolean =>
      panel !== null && !(event.target instanceof Node && panel.contains(event.target))
    if (this.active !== null || affects(this.catalog) || affects(this.viewOptions) || affects(this.sessionMenu)) {
      this.schedule()
    }
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.generation++
    this.observer = new MutationObserver(() => { this.schedule() })
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })
    window.addEventListener('resize', this.onViewportChange)
    window.addEventListener('dsh-page-ime-change', this.onImeChange)
    window.addEventListener('scroll', this.onScroll, true)
    window.visualViewport?.addEventListener('resize', this.onViewportChange)
    window.visualViewport?.addEventListener('scroll', this.onViewportChange)
    this.schedule()
  }

  detach(): void {
    this.attached = false
    this.generation++
    this.observer?.disconnect()
    this.observer = null
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('dsh-page-ime-change', this.onImeChange)
    window.removeEventListener('scroll', this.onScroll, true)
    window.visualViewport?.removeEventListener('resize', this.onViewportChange)
    window.visualViewport?.removeEventListener('scroll', this.onViewportChange)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scheduled = false
    this.restore()
    this.clearAnchoredStyles(this.catalog)
    this.clearAnchoredStyles(this.viewOptions)
    this.clearAnchoredStyles(this.sessionMenu)
    this.catalog = null
    this.viewOptions = null
    this.sessionMenu = null
  }

  private schedule(): void {
    if (!this.attached || this.scheduled) return
    this.scheduled = true
    const generation = this.generation
    this.frame = requestAnimationFrame(() => {
      if (!this.attached || generation !== this.generation) return
      this.frame = null
      this.scheduled = false
      this.sync()
      this.syncCatalog()
      this.syncViewOptions()
      this.syncSessionMenu()
    })
  }

  private sync(): void {
    const fold = document.querySelector<HTMLElement>(FOLD_SELECTOR)
    const list = fold?.querySelector<HTMLUListElement>(JOBS_LIST_SELECTOR) ?? null
    const trigger = list?.previousElementSibling
    if (list === null || !(trigger instanceof HTMLButtonElement) || trigger.getAttribute('aria-expanded') !== 'true') {
      this.restore()
      return
    }
    if (this.active !== list) {
      this.restore()
      this.active = list
      this.original.clear()
      for (const name of OWNED_STYLES) {
        this.original.set(name, {
          value: list.style.getPropertyValue(name),
          priority: list.style.getPropertyPriority(name),
        })
      }
      list.setAttribute(MARKER, '')
    }
    this.measure(list, trigger)
  }

  private measure(list: HTMLUListElement, trigger: HTMLButtonElement): void {
    const rect = trigger.getBoundingClientRect()
    const visual = window.visualViewport
    const viewportWidth = Math.round((visual?.width || document.documentElement.clientWidth || window.innerWidth))
    const viewportLeft = Math.round(visual?.offsetLeft ?? 0)
    const viewport = visibleViewport()
    const viewportTop = viewport?.top ?? 0
    const viewportBottom = viewport === null ? window.innerHeight : viewport.top + viewport.height
    const width = Math.max(1, Math.min(500, viewportWidth - VIEWPORT_MARGIN * 2))
    const viewportRight = viewportLeft + viewportWidth
    const left = Math.max(viewportLeft + VIEWPORT_MARGIN, Math.min(Math.round(rect.left), viewportRight - VIEWPORT_MARGIN - width))
    const safeTop = viewportTop + VIEWPORT_MARGIN
    const safeBottom = viewportBottom - VIEWPORT_MARGIN
    const availableHeight = Math.max(1, safeBottom - safeTop)
    const below = Math.max(0, safeBottom - Math.round(rect.bottom + 5))
    const above = Math.max(0, Math.round(rect.top - 5) - safeTop)
    const openDown = below >= above
    const maxHeight = Math.max(1, Math.min(availableHeight, Math.max(below, above)))
    const preferredTop = openDown ? Math.round(rect.bottom + 5) : Math.round(rect.top - 5 - maxHeight)
    const top = Math.max(safeTop, Math.min(preferredTop, safeBottom - maxHeight))

    list.style.setProperty('position', 'fixed', 'important')
    list.style.setProperty('top', `${top}px`, 'important')
    list.style.setProperty('left', `${left}px`, 'important')
    list.style.setProperty('right', 'auto', 'important')
    list.style.setProperty('width', `${width}px`, 'important')
    list.style.setProperty('max-width', `${width}px`, 'important')
    list.style.setProperty('max-height', `${maxHeight}px`, 'important')
    list.style.setProperty('overflow-y', 'auto', 'important')
    list.style.setProperty('z-index', '1000', 'important')
  }

  private restore(): void {
    if (this.active !== null) {
      this.active.removeAttribute(MARKER)
      for (const name of OWNED_STYLES) {
        const saved = this.original.get(name)
        if (saved === undefined || saved.value === '') this.active.style.removeProperty(name)
        else this.active.style.setProperty(name, saved.value, saved.priority)
      }
    }
    this.active = null
    this.original.clear()
  }

  private syncCatalog(): void {
    const panel = document.querySelector<HTMLElement>(SUBAGENT_PANEL)
    const trigger = panel ? document.querySelector(SUBAGENT_TRIGGER)?.closest('button') : null
    this.catalog = this.syncAnchoredPopup(this.catalog, panel, trigger, 360, false)
  }

  private syncViewOptions(): void {
    // Modern WebViews already have the anchor-positioned Workspace menu.
    if (globalThis.CSS?.supports?.('top', 'anchor(bottom)')) return
    const panel = document.querySelector<HTMLElement>(VIEW_OPTIONS_MENU)
    const trigger = panel ? document.querySelector(VIEW_OPTIONS_TRIGGER)?.closest('button') : null
    this.viewOptions = this.syncAnchoredPopup(this.viewOptions, panel, trigger, 200, true)
  }

  private syncSessionMenu(): void {
    if (globalThis.CSS?.supports?.('top', 'anchor(bottom)')) return
    const trigger = document.querySelector(`${SESSION_MENU_TRIGGER}[aria-expanded="true"]`)
    const panel = sessionHeaderMenu(trigger)
    this.sessionMenu = this.syncAnchoredPopup(this.sessionMenu, panel, trigger, 240, true)
  }

  private syncAnchoredPopup(
    previous: HTMLElement | null, panel: HTMLElement | null, trigger: Element | null | undefined,
    preferredWidth: number, alignEnd: boolean,
  ): HTMLElement | null {
    if (panel !== previous) this.clearAnchoredStyles(previous)
    if (panel === null) return null
    const viewport = visibleViewport()
    if (!trigger || viewport === null) {
      this.clearAnchoredStyles(panel)
      return null
    }

    const root = document.documentElement
    const safe = getComputedStyle(root)
    const inset = (edge: string): number => parseFloat(safe.getPropertyValue(edge)) || 0
    const navBottom = root.hasAttribute('data-dsh-ime') ? 0 : inset('--dsh-android-navbar-bottom')
    const safeTop = Math.max(viewport.top, inset('--dsh-android-system-top')) + VIEWPORT_MARGIN
    const safeBottom = Math.min(viewport.top + viewport.height, window.innerHeight - navBottom) - VIEWPORT_MARGIN
    const anchor = trigger.getBoundingClientRect()
    const top = Math.min(safeBottom, Math.max(safeTop, anchor.bottom + POPUP_GAP))
    const bottom = Math.max(safeTop, Math.min(safeBottom, anchor.top - POPUP_GAP))
    const below = safeBottom - top
    const above = bottom - safeTop
    const opensDown = below >= above
    const visual = window.visualViewport
    const leftEdge = Math.max(visual?.offsetLeft ?? 0, inset('--dsh-android-system-left')) + VIEWPORT_MARGIN
    const rightEdge = Math.min(
      (visual?.offsetLeft ?? 0) + (visual?.width || window.innerWidth),
      window.innerWidth - inset('--dsh-android-system-right'),
    ) - VIEWPORT_MARGIN
    const width = Math.max(1, Math.min(preferredWidth, rightEdge - leftEdge))
    const anchorLeft = alignEnd ? anchor.right - width : anchor.left
    const left = Math.max(leftEdge, Math.min(anchorLeft, rightEdge - width))

    // Explicit coordinates also work on WebViews without CSS anchor positioning.
    panel.style.setProperty('position-try-fallbacks', 'none', 'important')
    panel.style.setProperty('top', opensDown ? `${top}px` : 'auto', 'important')
    panel.style.setProperty('bottom', opensDown ? 'auto' : `${window.innerHeight - bottom}px`, 'important')
    panel.style.setProperty('left', `${left}px`, 'important')
    panel.style.setProperty('right', 'auto', 'important')
    panel.style.setProperty('width', `${width}px`, 'important')
    panel.style.setProperty('max-width', `${width}px`, 'important')
    panel.style.setProperty('max-height', `${Math.max(1, Math.min(560, Math.max(below, above)))}px`, 'important')
    return panel
  }

  private clearAnchoredStyles(panel: HTMLElement | null): void {
    if (panel === null) return
    for (const prop of ANCHORED_STYLES) panel.style.removeProperty(prop)
  }
}
