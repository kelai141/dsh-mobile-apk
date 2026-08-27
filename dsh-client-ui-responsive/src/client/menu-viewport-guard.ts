/** Maximum command-menu height from the upstream visual specification. */
const MENU_CAP = 320
/** Space kept below the mobile top bar before the command menu begins. */
const TOPBAR_CLEARANCE = 12

/**
 * Calculate the usable height for an upward-opening command menu.
 * The menu bottom is anchored to the composer, while the mobile top bar
 * occupies part of the viewport above it.
 */
export function mobileMenuMaxHeight(menuBottom: number, topbarBottom: number, chromeHeight = 0): number {
  return Math.max(0, Math.min(MENU_CAP, Math.floor(menuBottom - topbarBottom - TOPBAR_CLEARANCE - chromeHeight)))
}

/**
 * Keeps the upstream bottom-anchored command menu below the mobile top bar.
 * The upstream hook clamps only to viewport top; the frame owns the extra
 * mobile chrome and applies this additional geometric constraint.
 */
export class MenuViewportGuard {
  private readonly onViewportChange = (): void => { this.queue() }
  private readonly mutationObserver = new MutationObserver((records) => {
    if (records.some(record => this.isRelevantMutation(record))) this.queue()
  })
  private readonly resizeObserver = new ResizeObserver(() => { this.queue() })
  private frame: number | null = null
  private observed: Element[] = []
  private menu: HTMLElement | null = null

  /** Start observing mobile menu geometry. */
  attach(): void {
    this.mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', this.onViewportChange)
    window.addEventListener('scroll', this.onViewportChange, true)
    window.visualViewport?.addEventListener('resize', this.onViewportChange)
    this.queue()
  }

  /** Stop observing and remove the transient inline constraint. */
  detach(): void {
    this.mutationObserver.disconnect()
    this.resizeObserver.disconnect()
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('scroll', this.onViewportChange, true)
    window.visualViewport?.removeEventListener('resize', this.onViewportChange)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.menu?.style.removeProperty('--dsh-mobile-menu-max-height')
    this.menu = null
    this.observed = []
  }

  private queue(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.apply()
    })
  }

  private apply(): void {
    const topbar = document.querySelector<HTMLElement>('[data-mobile-topbar]')
    const menu = document.querySelector<HTMLElement>('[data-composer-card] [role="listbox"]')
    if (topbar === null || menu === null) {
      this.menu?.style.removeProperty('--dsh-mobile-menu-max-height')
      this.menu = null
      this.syncObserved([])
      return
    }

    const seat = menu.closest<HTMLElement>('[data-composer-seat]')
    const card = menu.closest<HTMLElement>('[data-composer-card]')
    this.menu = menu
    this.syncObserved([topbar, seat, card].filter((element): element is HTMLElement => element !== null))

    const value = `${mobileMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      topbar.getBoundingClientRect().bottom,
      menuChromeHeight(menu),
    )}px`
    if (menu.style.getPropertyValue('--dsh-mobile-menu-max-height') !== value) {
      menu.style.setProperty('--dsh-mobile-menu-max-height', value)
    }
  }

  private syncObserved(next: Element[]): void {
    if (next.length === this.observed.length && next.every((element, index) => element === this.observed[index])) return
    this.resizeObserver.disconnect()
    for (const element of next) this.resizeObserver.observe(element)
    this.observed = next
  }

  private isRelevantMutation(record: MutationRecord): boolean {
    if (record.target instanceof Element && record.target.closest('[data-composer-card]') !== null) return true
    return [...record.addedNodes, ...record.removedNodes].some(node => {
      if (!(node instanceof Element)) return false
      return node.matches('[data-composer-card], [role="listbox"]') ||
        node.querySelector('[data-composer-card], [role="listbox"]') !== null
    })
  }
}

/** Height excluded from CSS max-height when the menu uses content-box sizing. */
function menuChromeHeight(menu: HTMLElement): number {
  const style = getComputedStyle(menu)
  if (style.boxSizing === 'border-box') return 0
  return ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
    .map(property => Number.parseFloat(style[property as keyof CSSStyleDeclaration] as string) || 0)
    .reduce((total, value) => total + value, 0)
}
