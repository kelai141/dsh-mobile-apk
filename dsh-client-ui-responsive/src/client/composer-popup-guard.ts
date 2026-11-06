/**
 * Composer popup geometry guard (issues apk#135).
 *
 * Two popups anchor to the composer card: the slash-command menu
 * (`[role='listbox']` inside a surface card) and the model menu
 * (`[role='menu']`, which is its own surface). Both are sized and positioned
 * against their trigger rather than the viewport, so on phones they can
 *   (a) grow past the left viewport edge — long model ids lose their prefix
 *       ("deepseek-v4-…" renders as "eek-v4-…"),
 *   (b) keep a surface card wider than its content once a width cap applies to
 *       the inner scroll container only, leaving a blank strip and a scrollbar
 *       floating away from the card edge, and
 *   (c) rise above the mobile top bar and hide their first rows, and
 *   (d) sit under the soft keyboard: the Android layout viewport keeps its full
 *       height while the visual viewport shrinks, and ModelSelect places its
 *       portaled card from window.innerHeight.
 * The guard measures each open popup and writes the corrections as a width cap,
 * a horizontal shift, a vertical shift and a height cap. Measuring rather than
 * matching upstream class names keeps the fix alive across upstream CSS-module
 * renames.
 */

/** Design cap on the slash-command menu height (figma SLASH 39:26572 MenuDropdown). */
const LISTBOX_HEIGHT_CAP = 320
/** Design cap on the model menu height (upstream ModelSelect .menu). */
const MENU_HEIGHT_CAP = 360
/** Space kept between a popup and the mobile top bar. */
const TOPBAR_CLEARANCE = 12
/** Design cap on a popup's width. */
const POPUP_WIDTH_CAP = 340
/** Fraction of the viewport width a popup may occupy (mirrors the shell's injected cap). */
const POPUP_VIEWPORT_FRACTION = 0.92

/** Gap kept between a popup and each horizontal viewport edge. */
export const POPUP_EDGE_GAP = 8

/**
 * Width cap for a composer popup: the design cap, never more than the fraction
 * of the viewport the shell's injected stylesheet allows.
 * @param viewportWidth - layout viewport width in CSS pixels.
 * @returns the cap in whole CSS pixels.
 */
export function popupMaxWidth(viewportWidth: number): number {
  return Math.max(0, Math.floor(Math.min(POPUP_WIDTH_CAP, viewportWidth * POPUP_VIEWPORT_FRACTION)))
}

/**
 * Horizontal shift that brings a popup back inside the viewport.
 * The right edge wins when the popup is wider than the viewport, so the
 * reading order (labels at the left) stays visible.
 * @param left - untransformed left edge.
 * @param right - untransformed right edge.
 * @param viewportWidth - layout viewport width in CSS pixels.
 * @param gap - minimum clearance to each edge.
 * @returns the shift in whole CSS pixels (0 when already inside).
 */
export function popupShiftLeft(left: number, right: number, viewportWidth: number, gap: number = POPUP_EDGE_GAP): number {
  if (right - left > viewportWidth - gap * 2) return Math.round(gap - left)
  if (right > viewportWidth - gap) return Math.round(viewportWidth - gap - right)
  if (left < gap) return Math.round(gap - left)
  return 0
}

/** The part of the page a user can actually see right now. */
export interface VisibleViewport {
  /** Top edge of the visible region (a browser pan moves it down). */
  readonly top: number
  /** Height of the visible region. */
  readonly height: number
}

/**
 * The visible viewport, or null when the host cannot report one.
 *
 * On Android the layout viewport does NOT shrink when the soft keyboard opens
 * (edge-to-edge), while visualViewport does. A clamp that reads
 * document.documentElement.clientHeight therefore keeps placing cards under the
 * IME. visualViewport wins where it exists; window.innerHeight is the plain
 * browser fallback. A host that reports neither (jsdom has no layout at all)
 * gets null, and callers must then skip the clamp entirely rather than treat a
 * missing measurement as a zero-height viewport.
 * @returns the visible region in CSS pixels, or null when unmeasurable.
 */
export function visibleViewport(): VisibleViewport | null {
  const viewport = window.visualViewport
  if (viewport !== null && viewport !== undefined) {
    const height = Number(viewport.height)
    if (Number.isFinite(height) && height > 0) {
      const offsetTop = Number(viewport.offsetTop)
      return { top: Number.isFinite(offsetTop) ? Math.max(0, Math.round(offsetTop)) : 0, height: Math.round(height) }
    }
  }
  const layout = Number(window.innerHeight)
  return Number.isFinite(layout) && layout > 0 ? { top: 0, height: Math.round(layout) } : null
}

/**
 * Vertical shift that brings a popup back inside the visible viewport.
 *
 * The composer popup is bottom-anchored above its trigger, so a soft keyboard
 * changes nothing about it until the trigger itself is pushed up — but a
 * portaled card placed from window.innerHeight (ModelSelect's own placement) is
 * not, because the Android layout viewport keeps its full height while the IME
 * is open. A card taller than the space left above the keyboard then paints
 * under it. The bottom edge wins when the popup is taller than the visible
 * viewport, so its first rows stay readable.
 * @param top - untransformed top edge.
 * @param bottom - untransformed bottom edge.
 * @param visibleTop - top of the visible viewport (browser pan included).
 * @param visibleHeight - height of the visible viewport.
 * @param gap - minimum clearance to each edge.
 * @returns the shift in whole CSS pixels (0 when already inside).
 */
export function popupShiftTop(
  top: number,
  bottom: number,
  visibleTop: number,
  visibleHeight: number,
  gap: number = POPUP_EDGE_GAP,
): number {
  if (bottom - top > visibleHeight - gap * 2) return Math.round(visibleTop + gap - top)
  if (bottom > visibleTop + visibleHeight - gap) return Math.round(visibleTop + visibleHeight - gap - bottom)
  if (top < visibleTop + gap) return Math.round(visibleTop + gap - top)
  return 0
}

/**
 * Usable height for an upward-opening popup.
 * The popup bottom is anchored to the composer, while the top chrome
 * (upstream's header) occupies part of the viewport above it. The visible
 * viewport bounds the cap too: a keyboard that leaves less room than the popup
 * itself must shrink the scroll container rather than let it paint under the IME.
 * @param popupBottom - popup bottom edge.
 * @param topbarBottom - bottom edge of the top chrome above the popup.
 * @param chromeHeight - popup padding/border excluded from a content-box cap.
 * @param cap - design height cap for this popup kind.
 * @param visibleBottom - bottom edge of the visible viewport; defaults to unbounded.
 * @returns the height cap in whole CSS pixels.
 */
export function composerPopupMaxHeight(
  popupBottom: number,
  topbarBottom: number,
  chromeHeight = 0,
  cap = LISTBOX_HEIGHT_CAP,
  visibleBottom: number = Number.POSITIVE_INFINITY,
): number {
  const roomAboveComposer = popupBottom - topbarBottom - TOPBAR_CLEARANCE - chromeHeight
  const roomInsideVisible = visibleBottom - topbarBottom - TOPBAR_CLEARANCE - chromeHeight
  return Math.max(0, Math.min(cap, Math.floor(Math.min(roomAboveComposer, roomInsideVisible))))
}

/**
 * Bottom edge of the top chrome above the composer, or null when there is none.
 *
 * 0.14.2 P4 removed the self-drawn 44px band ([data-dsh-mobile-topbar]); the real top
 * chrome is now upstream's own conversation header. The header element carries no
 * unique attribute of its own (data-window-drag is on several rows), so it is resolved
 * through the leading seat this plugin registers the drawer toggle into — that seat is
 * inside exactly one header.
 * @returns the header's bottom edge, or null when the header is absent.
 */
function headerTopChrome(): HTMLElement | null {
  const leading = document.querySelector<HTMLElement>('[data-conversation-header-leading]')
  return leading?.closest('header') ?? null
}

/** The painted surface of a popup: the role element itself, or its card parent. */
function surfaceOf(popup: HTMLElement): HTMLElement {
  return popup.getAttribute('role') === 'menu' ? popup : popup.parentElement ?? popup
}

/** Height excluded from a content-box max-height (padding + border). */
function chromeHeight(element: HTMLElement): number {
  const style = getComputedStyle(element)
  if (style.boxSizing === 'border-box') return 0
  return ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
    .map(property => Number.parseFloat(style[property as keyof CSSStyleDeclaration] as string) || 0)
    .reduce((total, value) => total + value, 0)
}

/** Current inline horizontal shift of a surface. */
function readShift(surface: HTMLElement): number {
  return Number.parseFloat(surface.style.getPropertyValue('--dsh-mobile-popup-shift')) || 0
}

/** Current inline vertical shift of a surface. */
function readShiftTop(surface: HTMLElement): number {
  return Number.parseFloat(surface.style.getPropertyValue('--dsh-mobile-popup-shift-y')) || 0
}

/** Upstream placement only; custom correction properties must not feed back. */
function placementKey(surface: HTMLElement): string {
  return [surface.style.top, surface.style.left, surface.style.width, surface.style.height].join('|')
}

/**
 * Keeps every open composer popup inside the viewport: width cap on the surface
 * and its scroll container, horizontal shift on the surface, height cap on the
 * scrolling element.
 */
export class ComposerPopupGuard {
  /**
   * Viewport change (resize / scroll / visualViewport resize).
   *
   * Gated on "a popup is open": the guard's whole job is keeping an OPEN popup inside the
   * viewport, so with no popup there is nothing to correct. Before the gate this ran
   * `requestAnimationFrame` + two full-document queries on every scroll event — measured at
   * 4 document queries per scroll frame with nothing open (tests/scroll-frame-budget.spec.ts).
   * The flag is maintained by apply() itself, so a popup that appears without a viewport change
   * is still picked up by the mutation observer below.
   */
  private readonly onViewportChange = (): void => { if (this.openPopups > 0) this.queue() }
  private readonly mutationObserver = new MutationObserver((records) => {
    if (records.some(record => this.isRelevantMutation(record))) this.queue()
  })
  private readonly resizeObserver = new ResizeObserver(() => { this.queue() })
  private readonly placements = new Map<HTMLElement, string>()
  private readonly placementObserver = new MutationObserver((records) => {
    let changed = false
    for (const record of records) {
      if (!(record.target instanceof HTMLElement) || !this.placements.has(record.target)) continue
      const key = placementKey(record.target)
      if (this.placements.get(record.target) === key) continue
      this.placements.set(record.target, key)
      changed = true
    }
    // Upstream commits a new top after the scroll handler. Rebase before paint;
    // waiting for another scroll leaves the previous transform applied twice.
    if (changed) this.apply()
  })
  private lastImeInset = ''
  /** Open popup count from the last apply(); 0 short-circuits viewport-driven passes. */
  private openPopups = 0
  private frame: number | null = null
  private observed: Element[] = []
  private styled = new Set<HTMLElement>()

  /** Start observing composer popup geometry. */
  attach(): void {
    this.mutationObserver.observe(document.body, { childList: true, subtree: true })
    // Some WebViews keep visualViewport unchanged while the shell moves the
    // composer through its IME CSS inset. Observe that input, never our styles.
    this.lastImeInset = document.documentElement.style.getPropertyValue('--dsh-android-ime-bottom')
    this.mutationObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', this.onViewportChange)
    window.addEventListener('scroll', this.onViewportChange, true)
    window.visualViewport?.addEventListener('resize', this.onViewportChange)
    this.queue()
  }

  /** Stop observing and remove every geometric correction. */
  detach(): void {
    this.mutationObserver.disconnect()
    this.resizeObserver.disconnect()
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('scroll', this.onViewportChange, true)
    window.visualViewport?.removeEventListener('resize', this.onViewportChange)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.clear()
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
    const card = document.querySelector<HTMLElement>('[data-composer-card]')
    // 0.14.2 P4: [data-dsh-mobile-topbar] is gone, so the clamp measures the real
    // top chrome instead — upstream's own header. Without this the upward caps
    // would loosen by the header's whole height and menus would run up under it.
    // Fallback chain: the header's own element, then the legacy band (still present
    // on a shell that has not picked this change up), then 0.
    const topbar = headerTopChrome()
      ?? document.querySelector<HTMLElement>('[data-dsh-mobile-topbar]')
    if (card === null) {
      this.openPopups = 0
      this.clear()
      return
    }
    const popups = new Set(card.querySelectorAll<HTMLElement>("[role='menu'], [role='listbox']"))
    const modelMenus = new Map<HTMLElement, HTMLElement>()
    // ModelSelect renders its menu through a body portal. Resolve that exact
    // surface from the open trigger's aria-controls rather than relying on a
    // composer-descendant selector or localized accessible name.
    for (const trigger of card.querySelectorAll<HTMLElement>("[aria-haspopup='menu'][aria-expanded='true'][aria-controls]")) {
      const controlledIds = trigger.getAttribute('aria-controls')?.trim().split(/\s+/) ?? []
      for (const id of controlledIds) {
        const controlled = document.getElementById(id)
        const role = controlled?.getAttribute('role')
        if (!(controlled instanceof HTMLElement) || (role !== 'menu' && role !== 'group') ||
          controlled.getAttribute('data-menu-material') !== 'translucent') continue
        popups.add(controlled)
        modelMenus.set(controlled, trigger)
      }
    }
    this.openPopups = popups.size
    if (popups.size === 0) {
      this.clear()
      return
    }

    const viewportWidth = document.documentElement.clientWidth
    const widthCap = `${popupMaxWidth(viewportWidth)}px`
    const topbarBottom = topbar?.getBoundingClientRect().bottom ?? 0
    // The keyboard shrinks the visual viewport, not the layout viewport, and a pan
    // moves it down; both are measured per pass (no cached value can go stale across
    // an IME animation). An unmeasurable host keeps the old geometry-only behaviour
    // instead of collapsing every cap to zero.
    const visible = visibleViewport()
    const visibleTop = visible?.top ?? 0
    const visibleBottom = visible === null ? Number.POSITIVE_INFINITY : visible.top + visible.height
    const styled = new Set<HTMLElement>()
    const measured: Element[] = topbar === null ? [] : [topbar, card]

    for (const popup of popups) {
      // ModelSelect keeps the controlled portal surface as role=menu while
      // replacing its contents as the user drills into the model list.
      const surface = modelMenus.has(popup) ? popup : surfaceOf(popup)
      styled.add(surface)
      styled.add(popup)
      measured.push(surface, popup)
      if (modelMenus.has(popup)) {
        surface.setAttribute('data-dsh-mobile-model-menu', '')
        if (window.androidBridge !== undefined) surface.setAttribute('data-dsh-android-model-menu', '')
        else surface.removeAttribute('data-dsh-android-model-menu')
      }

      for (const element of surface === popup ? [popup] : [popup, surface]) {
        if (element.style.getPropertyValue('--dsh-mobile-popup-max-width') !== widthCap) {
          element.style.setProperty('--dsh-mobile-popup-max-width', widthCap)
        }
      }

      const currentShift = readShift(surface)
      const rect = surface.getBoundingClientRect()
      const shift = popupShiftLeft(rect.left - currentShift, rect.right - currentShift, viewportWidth)
      if (shift !== currentShift) {
        surface.style.setProperty('--dsh-mobile-popup-shift', `${shift}px`)
      }
      // Anchor the model portal to its trigger, never its previously capped
      // bottom. Painted geometry fed back into the cap shrinks it to zero;
      // adding the shift to the viewport bound also produces a two-state cycle.
      const currentShiftTop = readShiftTop(surface)
      const trigger = modelMenus.get(popup)
      const triggerRect = trigger?.getBoundingClientRect()
      const anchored = triggerRect !== undefined && triggerRect.height > 0
      const anchorBottom = anchored ? triggerRect.top - POPUP_EDGE_GAP : rect.bottom - currentShiftTop
      const topBound = Math.max(topbarBottom + TOPBAR_CLEARANCE, visibleTop + POPUP_EDGE_GAP)
      const bottomBound = Math.min(anchorBottom, visibleBottom - POPUP_EDGE_GAP)
      const cap = modelMenus.has(popup) || popup.getAttribute('role') === 'menu' ? MENU_HEIGHT_CAP : LISTBOX_HEIGHT_CAP
      const heightCap = `${visible === null
        ? composerPopupMaxHeight(anchorBottom, topbarBottom, chromeHeight(popup), cap)
        : Math.max(0, Math.min(cap, Math.floor(bottomBound - topBound - chromeHeight(popup))))}px`
      if (popup.style.getPropertyValue('--dsh-mobile-menu-max-height') !== heightCap) {
        popup.style.setProperty('--dsh-mobile-menu-max-height', heightCap)
      }
      // Read after sizing: the first painted frame must use the capped height.
      // Upstream can rewrite top on scroll, but the trigger-derived target stays
      // independent of both its inline position and our previous transform.
      const sizedRect = surface.getBoundingClientRect()
      const naturalTop = sizedRect.top - currentShiftTop
      const topShift = visible === null ? 0 : anchored
        ? Math.round(Math.max(topBound, bottomBound - sizedRect.height) - naturalTop)
        : popupShiftTop(naturalTop, sizedRect.bottom - currentShiftTop, visible.top, visible.height)
      if (topShift !== currentShiftTop) {
        surface.style.setProperty('--dsh-mobile-popup-shift-y', `${topShift}px`)
      }
      surface.setAttribute('data-dsh-popup', '')
    }

    for (const element of this.styled) {
      if (!styled.has(element)) this.clearElement(element)
    }
    this.styled = styled
    this.syncObserved(measured)
    this.syncPlacements([...modelMenus.keys()])
  }

  /** Drop every correction and forget the touched elements. */
  private clear(): void {
    this.openPopups = 0
    for (const element of this.styled) this.clearElement(element)
    this.styled = new Set()
    this.syncObserved([])
    this.syncPlacements([])
  }

  private clearElement(element: HTMLElement): void {
    element.style.removeProperty('--dsh-mobile-popup-max-width')
    element.style.removeProperty('--dsh-mobile-popup-shift')
    element.style.removeProperty('--dsh-mobile-popup-shift-y')
    element.style.removeProperty('--dsh-mobile-menu-max-height')
    element.removeAttribute('data-dsh-popup')
    element.removeAttribute('data-dsh-mobile-model-menu')
    element.removeAttribute('data-dsh-android-model-menu')
  }

  private syncObserved(next: Element[]): void {
    if (next.length === this.observed.length && next.every((element, index) => element === this.observed[index])) return
    this.resizeObserver.disconnect()
    for (const element of next) this.resizeObserver.observe(element)
    this.observed = next
  }

  private syncPlacements(next: HTMLElement[]): void {
    if (next.length === this.placements.size && next.every(element => this.placements.has(element))) return
    this.placementObserver.disconnect()
    this.placements.clear()
    for (const element of next) {
      this.placements.set(element, placementKey(element))
      this.placementObserver.observe(element, { attributes: true, attributeFilter: ['style'] })
    }
  }

  private isRelevantMutation(record: MutationRecord): boolean {
    if (record.type === 'attributes' && record.target === document.documentElement) {
      const inset = document.documentElement.style.getPropertyValue('--dsh-android-ime-bottom')
      if (inset === this.lastImeInset) return false
      this.lastImeInset = inset
      return true
    }
    if (record.target instanceof Element && record.target.closest('[data-composer-card]') !== null) return true
    return [...record.addedNodes, ...record.removedNodes].some(node => {
      if (!(node instanceof Element)) return false
      return node.matches('[data-composer-card], [role="listbox"], [role="menu"], [role="group"][data-menu-material="translucent"], [data-dsh-mobile-model-menu]') ||
        node.querySelector('[data-composer-card], [role="listbox"], [role="menu"], [role="group"][data-menu-material="translucent"], [data-dsh-mobile-model-menu]') !== null
    })
  }
}
