/**
 * Keep header action menus usable inside the mobile top bar fold.
 *
 * Most header actions render a portal. The background-jobs action intentionally
 * renders an anchored `<ul>` next to its trigger instead; when its owner is
 * inside the folded top-bar surface, that menu is clipped by the surface's
 * scrolling overflow. Promote only that semantic list to a viewport-fixed
 * overlay while it is open, keeping React's DOM ownership and dismissal logic.
 */
const FOLD_SELECTOR = '[data-dsh-topbar-fold="open"]'
const JOBS_LIST_SELECTOR = 'ul[aria-label="后台任务"], ul[aria-label="Background jobs"]'
const MARKER = 'data-dsh-header-popup'
const OWNED_STYLES = ['position', 'top', 'left', 'right', 'width', 'max-width', 'max-height', 'overflow-y', 'z-index'] as const
const VIEWPORT_MARGIN = 12

interface StyleSnapshot {
  readonly value: string
  readonly priority: string
}

/** Adapt an expanded background-jobs menu to the visible mobile viewport. */
export class HeaderPopups {
  private observer: MutationObserver | null = null
  private active: HTMLUListElement | null = null
  private original = new Map<string, StyleSnapshot>()
  private attached = false
  private scheduled = false
  private frame: number | null = null
  private generation = 0

  private readonly onViewportChange = (): void => { this.schedule() }
  /**
   * Scroll handler.
   *
   * The promotion only exists while the background-jobs list is open: with no active list,
   * sync() finds nothing and restores nothing. Before this gate every scroll event scheduled a
   * frame that ran a full-document query for the fold marker — one of the document queries per
   * scroll frame measured in tests/scroll-frame-budget.spec.ts. Resize stays ungated (rare, and
   * the fold marker can appear while the viewport changes).
   */
  private readonly onScroll = (): void => { if (this.active !== null) this.schedule() }

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
    window.removeEventListener('scroll', this.onScroll, true)
    window.visualViewport?.removeEventListener('resize', this.onViewportChange)
    window.visualViewport?.removeEventListener('scroll', this.onViewportChange)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scheduled = false
    this.restore()
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
    const viewportTop = Math.round(visual?.offsetTop ?? 0)
    const viewportBottom = Math.round((visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight))
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
}
