/**
 * Control-activation discipline for the Android form (issues #1316 #1317).
 *
 * Two reported defects share one root: a control activation reaches upstream while the
 * control is either not presented at all, or is a pure action that must not own the
 * keyboard. Both are adapter-level invariants, so they are enforced here instead of at each
 * call site:
 *
 * 1. **A control the page presents as hidden must not activate** (#1317).
 *    Upstream hides the session-card actions (more / archive / pin) and the drawer's
 *    "new conversation" entry by making them transparent; a transparent box is still
 *    hit-tested, so a tap on "blank space" archived or pinned a conversation. The fix is not
 *    another opacity tweak: the activation is swallowed **and** the control is taken out of
 *    the hit surface (`pointer-events: none`) and out of the focus tree (`tabindex=-1`,
 *    `aria-hidden=true`), i.e. the three faces agree. It is restored as soon as the control
 *    is presented again, so no state is lost.
 *
 * 2. **A non-editable action must not pull the soft keyboard up** (#1316).
 *    Tapping "pause conversation" put focus into the composer, and the IME followed. The
 *    guard is bounded and click-scoped, never a global blur: it arms only for the activation
 *    of a control that is (a) a button, (b) outside the composer card, the drawer, a dialog
 *    or a popup menu, and (c) not a menu opener; it disarms on the user's very next press,
 *    on a press inside the composer, or when the short window expires. A deliberate tap on
 *    the input therefore always wins.
 *
 * Judgement is by DOM facts only (attributes + computed style), never by hashed CSS-Module
 * class names and never by copy, so an upstream restyle cannot silently switch it off.
 */

/** Where an activation was blocked, in upstream-observable terms. */
export type HiddenReason = 'hidden-attribute' | 'display-none' | 'visibility-hidden' | 'transparent' | 'aria-hidden'

/** Shapes that count as "a control the user can activate". */
const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"]'
/** Shapes that own the soft keyboard. */
const EDITABLE_SELECTOR = 'textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]'
/** The composer card: pressing anything inside it is the user asking to type. */
const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
/** Regions whose buttons legitimately open an editor (rename, filter, settings, menus). */
const EDITOR_REGION_SELECTOR = [
  '[class*="sidebarCol"]',
  '[data-dsh-bubble-panel]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(', ')
/** Own marker for the three inert faces, so restoration is exactly reversible. */
export const INERT_ATTR = 'data-dsh-activation-inert'

/** How long after a control activation a programmatic composer focus is still rejected. */
export const SUPPRESS_WINDOW_MS = 250

/** Two API arguments of the same event type: the guard only needs "was this consumed". */
interface ConsumableEvent { preventDefault(): void; stopImmediatePropagation(): void }

/**
 * Why the element is not presented, or null when it is visible.
 *
 * Walks self → body so a transparent or hidden **ancestor** counts: upstream hides the whole
 * action cluster in several places, and checking only the control would miss every one of
 * them. Opacity is the one that actually keeps hit-testing alive, so it is accumulated
 * instead of compared per node.
 *
 * @param control - the element to judge.
 * @param styleOf - computed-style reader (injectable so the judgement is testable offline).
 * @returns the first reason found, or null when the control is presented.
 */
export function hiddenReason(
  control: Element,
  styleOf: (el: Element) => CSSStyleDeclaration | null = defaultStyleOf,
): HiddenReason | null {
  const doc = control.ownerDocument
  let opacity = 1
  let node: Element | null = control
  for (let depth = 0; node !== null && depth < 64; depth++) {
    if (node.hasAttribute?.('hidden') === true) return 'hidden-attribute'
    if (node.getAttribute?.('aria-hidden') === 'true') return 'aria-hidden'
    const style = styleOf(node)
    if (style !== null) {
      if (style.display === 'none') return 'display-none'
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'visibility-hidden'
      const value = Number.parseFloat(style.opacity)
      if (Number.isFinite(value)) opacity *= Math.min(1, Math.max(0, value))
      // Opacity multiplies down the tree: 0 anywhere above makes the control unseeable.
      if (opacity <= 0.01) return 'transparent'
    }
    if (node === doc?.body || node === doc?.documentElement) break
    node = node.parentElement
  }
  return null
}

/** Default style reader; null when the document has no view (detached tree). */
function defaultStyleOf(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument?.defaultView ?? null
  return view === null ? null : view.getComputedStyle(el)
}

/** Injected behaviour for [ActivationGuard]. */
export interface ActivationGuardOptions {
  /** Master switch (default: always on — this plugin only ever runs inside the shell). */
  enabled?: () => boolean
  /** Observation hook: an activation was swallowed because the control was not presented. */
  onBlocked?: (control: Element, reason: HiddenReason) => void
  /** Observation hook: a programmatic composer focus was rejected (the IME never opened). */
  onKeyboardSuppressed?: (editable: HTMLElement) => void
  /** Suppression window in milliseconds. */
  windowMs?: number
  /** Computed-style reader (tests pass a deterministic one). */
  styleOf?: (el: Element) => CSSStyleDeclaration | null
}

/** The three inert faces we write, saved so restoration is byte-exact. */
interface SavedFaces {
  pointerEvents: string | null
  tabIndex: string | null
  ariaHidden: string | null
}

/**
 * Enforces both invariants above with one attach/detach pair.
 *
 * Listeners are capture-phase and read-only until they actually block something, so an
 * activation that is legitimate is never delayed, cancelled or re-dispatched.
 */
export class ActivationGuard {
  private attached = false
  private readonly healed = new Set<HTMLElement>()
  private readonly saved = new WeakMap<HTMLElement, SavedFaces>()
  private guardedUntil = 0

  /**
   * @param options - switches and observation hooks.
   * @param doc - the document to watch (tests pass their own).
   */
  constructor(
    private readonly options: ActivationGuardOptions = {},
    private readonly doc: Document = document,
  ) {}

  /** Start watching (idempotent). */
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.doc.addEventListener('pointerdown', this.onPointerDown, true)
    this.doc.addEventListener('click', this.onClick, true)
    this.doc.addEventListener('focusin', this.onFocusIn, true)
  }

  /** Stop watching and hand every healed control back its original faces. */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.doc.removeEventListener('pointerdown', this.onPointerDown, true)
    this.doc.removeEventListener('click', this.onClick, true)
    this.doc.removeEventListener('focusin', this.onFocusIn, true)
    this.disarm()
    for (const control of [...this.healed]) this.unheal(control)
  }

  /** Whether the keyboard window is currently armed (device-side observability). */
  suppressing(): boolean {
    return this.guardedUntil !== 0 && Date.now() < this.guardedUntil
  }

  private enabled(): boolean {
    return this.options.enabled?.() !== false
  }

  private hiddenOf(control: Element): HiddenReason | null {
    return hiddenReason(control, this.options.styleOf ?? defaultStyleOf)
  }

  /**
   * Why this control must not activate, judged **without** counting our own markers.
   *
   * A healed control carries `aria-hidden`/`pointer-events`/`tabindex` written by us, and our
   * own `aria-hidden` alone satisfies [hiddenReason] — so a second activation would be
   * reported as `aria-hidden` (our doing) instead of the upstream reason it actually has.
   * The three faces are therefore lifted for the check and re-applied when the control is
   * still not presented.
   */
  private reasonFor(control: HTMLElement): HiddenReason | null {
    if (!this.saved.has(control)) return this.hiddenOf(control)
    this.unheal(control)
    const reason = this.hiddenOf(control)
    if (reason !== null) this.heal(control)
    return reason
  }

  /** Press: block activations of hidden controls, then decide whether to arm the IME window. */
  private readonly onPointerDown = (event: Event): void => {
    if (!this.enabled()) return
    this.restorePresented()
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    // The user's own next press always wins over a pending suppression window.
    this.disarm()
    const control = target.closest<HTMLElement>(CONTROL_SELECTOR)
    if (control !== null) {
      const reason = this.reasonFor(control)
      if (reason !== null) {
        this.block(event, control, reason)
        return
      }
    }
    this.arm(target, control)
  }

  /** Click: same judgement, so a synthetic click (or a press that produced no pointerdown) is covered. */
  private readonly onClick = (event: Event): void => {
    if (!this.enabled()) return
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    const control = target.closest<HTMLElement>(CONTROL_SELECTOR)
    if (control === null) return
    const reason = this.reasonFor(control)
    if (reason === null) return
    this.block(event, control, reason)
  }

  /** Focus: inside the window, an editable that grabs focus is the keyboard bug. */
  private readonly onFocusIn = (event: Event): void => {
    if (!this.enabled() || !this.suppressing()) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!target.matches(EDITABLE_SELECTOR)) return
    this.disarm()
    target.blur()
    this.options.onKeyboardSuppressed?.(target)
  }

  /** Swallow an activation that must not happen and take the control out of the hit surface. */
  private block(event: Event, control: HTMLElement, reason: HiddenReason): void {
    const consumable = event as unknown as ConsumableEvent
    consumable.preventDefault()
    consumable.stopImmediatePropagation()
    this.heal(control)
    this.options.onBlocked?.(control, reason)
  }

  /** Arm the suppression window for a genuine, visible, non-editor control activation. */
  private arm(target: Element, control: HTMLElement | null): void {
    if (control === null) return
    if (!control.matches('button, [role="button"]')) return
    if (control.getAttribute('aria-haspopup') !== null) return
    if (control.closest(COMPOSER_CARD_SELECTOR) !== null) return
    if (control.closest(EDITOR_REGION_SELECTOR) !== null) return
    if (target.closest(EDITABLE_SELECTOR) !== null) return
    // 截止时刻是唯一真源（不再挂定时器）：窗口过期、用户按下、被拦下的激活都会把它清零。
    this.guardedUntil = Date.now() + (this.options.windowMs ?? SUPPRESS_WINDOW_MS)
  }

  /** Drop the window (user chose to type, the window expired, or we already blocked). */
  private disarm(): void {
    this.guardedUntil = 0
  }

  /** Give back the faces as soon as the control is presented again. */
  private restorePresented(): void {
    for (const control of [...this.healed]) {
      if (this.reasonFor(control) !== null) continue
      this.unheal(control)
    }
  }

  /** Write the three inert faces, remembering what they were. */
  private heal(control: HTMLElement): void {
    if (!this.saved.has(control)) {
      this.saved.set(control, {
        pointerEvents: control.style.getPropertyValue('pointer-events') || null,
        tabIndex: control.getAttribute('tabindex'),
        ariaHidden: control.getAttribute('aria-hidden'),
      })
    }
    this.healed.add(control)
    control.setAttribute(INERT_ATTR, '')
    control.style.setProperty('pointer-events', 'none', 'important')
    control.setAttribute('tabindex', '-1')
    control.setAttribute('aria-hidden', 'true')
  }

  /** Restore the faces exactly as they were (no leftover attribute, no leftover style). */
  private unheal(control: HTMLElement): void {
    const saved = this.saved.get(control)
    if (saved === undefined) {
      this.healed.delete(control)
      return
    }
    if (saved.pointerEvents === null) control.style.removeProperty('pointer-events')
    else control.style.setProperty('pointer-events', saved.pointerEvents)
    if (saved.tabIndex === null) control.removeAttribute('tabindex')
    else control.setAttribute('tabindex', saved.tabIndex)
    if (saved.ariaHidden === null) control.removeAttribute('aria-hidden')
    else control.setAttribute('aria-hidden', saved.ariaHidden)
    control.removeAttribute(INERT_ATTR)
    this.saved.delete(control)
    this.healed.delete(control)
  }
}
