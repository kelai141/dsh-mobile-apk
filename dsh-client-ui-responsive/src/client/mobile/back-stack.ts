/**
 * Back-stack signal: the page half of the shell's system-back policy (iteration
 * 0.14.0-preview, plan §5.1 "方案 1" / source diagnosis §6).
 *
 * The shell decides in ONE synchronous back callback, and `evaluateJavascript` is
 * asynchronous, so the page can never be asked at back time: this module observes
 * the known in-memory layers of the upstream frame, keeps them in an ordered
 * stack, exposes `window.__dshBack()`, and pushes "a layer can be popped" to the
 * shell through the synchronous `dshBackBridge.setAvailable` uplink whenever that
 * boolean changes. The shell caches the boolean and calls `window.__dshBack()`.
 *
 * Why an observed layer stack instead of the alternatives:
 * - `WebView.canGoBack()` does not see same-document history entries on the
 *   measured WebView (Chromium 110), so pushState routing cannot drive the shell;
 * - one synthetic Escape would hit every mounted document-level listener at once
 *   (settings, Modal, menu, lightbox) and still miss drawer, trajectory details,
 *   and the right column.
 *
 * Each layer is closed through its OWN control, by stable hook (data attributes,
 * roles, mask structure), not by localized copy:
 * - drawer: the layout service's own toggle (the top-bar button's action);
 * - dialog (settings panel, `Modal`, image lightbox): its mask, else its close
 *   button, else its clickable backdrop;
 * - trajectory "Event details" `<aside>`: its close button;
 * - right column fullscreen, while the column is presented: its mode toggle, else its
 *   collapse toggle;
 * - `@`/slash menu: the menu's own outside-pointerdown dismissal;
 * - menu drill-down: the last enabled breadcrumb (one level per press).
 *
 * Failure direction: the stack only ever pops through reconciliation (a layer's
 * anchor disappearing from the DOM). A layer whose control cannot be found keeps
 * being counted, so the shell consumes the press instead of finishing the
 * activity ("an unobserved or unclosable layer must never exit the app").
 */

/** Layer kinds, bottom to top as detected within one pass. */
export type BackLayerKind =
  | 'drawer'
  | 'dialog'
  | 'trajectory-details'
  | 'right-fullscreen'
  | 'menu'
  | 'menu-drill'

/** One observed layer plus the closure that pops it. */
interface BackLayerDetection {
  /** Stable identity across observation passes, so ordering survives re-detection. */
  id: string
  kind: BackLayerKind
  /** Pop this layer through its own control; false when no control was found. */
  close: () => boolean
}

/** A stacked layer: detection data plus its open-order sequence. */
interface BackLayer extends BackLayerDetection {
  seq: number
}

/** The phone-form marker (`mobile/form-marker.ts`); the drawer is a layer only on phones. */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
/** The frame root, tagged by the form marker; identified before the tag lands by its right column. */
const FRAME_SELECTOR = '[data-dsh-frame]'
const RIGHT_COL_SELECTOR = '[data-rightbar-col]'
/** Frame attribute: present while the left sidebar is collapsed (drawer closed). */
const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'
/** Every upstream modal surface (settings panel, ui-primitives Modal, image lightbox). */
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'
/** Accessible names of the trajectory "Event details" side panel (zh + en dictionaries). */
const TRAJECTORY_LABELS = ['Event details', '事件详情']
/**
 * Right column in its fullscreen presentation **and actually shown**.
 *
 * The panel element keeps `data-sidebar-right-panel="fullscreen"` while the column is collapsed
 * (upstream derives the attribute from the mode alone, and the mode is remembered); what marks the
 * column as presented is `data-sidebar-right-open`, written only while expanded, with
 * `aria-hidden` following it (`SidebarRight.tsx:298-303`). Measured on the MuMu x86_64 build: a
 * collapsed panel carries `aria-hidden="true"` and no open attribute, yet keeps the fullscreen
 * attribute. Counting it as a layer produced a phantom layer that consumed every back press
 * forever (IX-BG-12 red: four presses, depth stuck at 1, the activity never finished).
 */
const RIGHT_FULLSCREEN_SELECTOR =
  '[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]:not([aria-hidden="true"])'
const MENU_SELECTOR = '[data-trigger-menu]'
/** The drilled-listing breadcrumb header (a `nav`; the candidate list is a `div[role=listbox]`). */
const MENU_DRILL_SELECTOR = '[data-trigger-menu] nav'
/** Hashed CSS-module close controls still carry the class token (`[class*=ledger]` precedent). */
const CLOSE_CLASS_HINT = '[class*="close"]'
/** Attributes any layer's presence is derived from; the filter keeps the observer cheap. */
const OBSERVED_ATTRIBUTES = [
  MOBILE_FORM_ATTR,
  SIDEBAR_COLLAPSED_ATTR,
  'role',
  'aria-modal',
  'aria-label',
  'aria-hidden',
  'data-sidebar-right-panel',
  'data-sidebar-right-open',
  'data-trigger-menu',
]

declare global {
  interface Window {
    /** Pop the topmost page layer; false when the page holds no layer of its own. */
    __dshBack?: () => boolean
    /** Number of layers the page currently holds (device-side observability). */
    __dshBackDepth?: number
    /** Layer kinds bottom to top (device-side observability). */
    __dshBackKinds?: string[]
    /** Synchronous shell uplink registered by the APK (`BackGateBridge`). */
    dshBackBridge?: { setAvailable?: (available: boolean) => void }
  }
}

/** Dispatch one pointerdown, degrading to MouseEvent where PointerEvent is absent. */
function dispatchPointerDown(target: EventTarget): void {
  if (typeof PointerEvent === 'function') {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    return
  }
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
}

/** Dispatch one mouse gesture (bubbling + cancelable: React handlers and `preventDefault` both rely on it). */
function dispatchMouse(target: EventTarget, type: string): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
}

/**
 * Close a modal surface through its own dismissal path.
 * @param dialog - the `[role=dialog][aria-modal]` element.
 * @returns whether a control was found and triggered.
 */
function closeDialog(dialog: Element): boolean {
  // Mask first: both masks are documented close paths (settings panel and
  // `Modal` mask.onClick; the image lightbox mask.onMouseDown). The mask is
  // either a sibling of the panel (`Modal`, `SettingsRoot`) or the backdrop's
  // own first child (lightbox), hence both lookups; the mousedown/click pair
  // covers both handlers without double-closing (each mask owns exactly one).
  const mask = dialog.parentElement?.querySelector(':scope > [aria-hidden="true"]')
    ?? dialog.querySelector(':scope > [aria-hidden="true"]')
  if (mask !== null && mask !== undefined) {
    dispatchMouse(mask, 'mousedown')
    dispatchMouse(mask, 'click')
    return true
  }
  const close = dialog.querySelector(`button${CLOSE_CLASS_HINT}`) ?? dialog.querySelector(CLOSE_CLASS_HINT)
  if (close !== null) {
    dispatchMouse(close, 'click')
    return true
  }
  // Backdrop-owned dismissal: the plugin's export-result dialog closes from its
  // backdrop's onClick, and the panel itself stops propagation.
  const backdrop = dialog.parentElement
  if (backdrop !== null) {
    dispatchMouse(backdrop, 'click')
    return true
  }
  return false
}

/**
 * Close the trajectory "Event details" side panel through its own close button.
 * @param aside - the panel element.
 * @returns whether the close control was found and triggered.
 */
function closeTrajectoryDetails(aside: Element): boolean {
  const close = aside.querySelector(`button${CLOSE_CLASS_HINT}`) ?? aside.querySelector(CLOSE_CLASS_HINT)
  if (close === null) return false
  dispatchMouse(close, 'click')
  return true
}

/**
 * Leave the right column's fullscreen presentation.
 * @param panel - the `[data-sidebar-right-panel=fullscreen]` element.
 * @returns whether a control was found and triggered.
 */
function closeRightFullscreen(panel: Element): boolean {
  // Stable upstream hooks: the mode toggle labels itself "exit fullscreen" while
  // fullscreen and the collapse toggle folds the column outright, so no
  // localized aria-label is needed.
  const target = panel.querySelector('[data-sidebar-right-mode]') ?? panel.querySelector('[data-sidebar-right-toggle]')
  if (target === null) return false
  dispatchMouse(target, 'click')
  return true
}

/**
 * Dismiss a trigger menu (slash / `@`) through the menu's own dismissal path.
 * @param menu - the `[data-trigger-menu]` element.
 * @returns whether the dismissal was dispatched.
 */
function closeMenu(menu: Element): boolean {
  // MenuView closes on a document-capture pointerdown whose target is outside
  // the list and outside the composer card; the body satisfies both.
  if (menu.contains(document.body)) return false
  dispatchPointerDown(document.body)
  return true
}

/**
 * Pop one drill-down level of an `@` menu listing.
 * @param nav - the breadcrumb header inside the menu.
 * @returns whether an ancestor step was found and triggered.
 */
function popMenuDrill(nav: Element): boolean {
  // The current step carries aria-current + disabled; the last enabled step is
  // the directory being listed, i.e. exactly one level up. Upstream wires the
  // crumb on mousedown (it keeps composer focus and prevents the default), so a
  // click would not reach it.
  const ancestors = [...nav.querySelectorAll('button')].filter(button =>
    button.getAttribute('aria-current') === null && !(button as HTMLButtonElement).disabled)
  const parent = ancestors[ancestors.length - 1]
  if (parent === undefined) return false
  dispatchMouse(parent, 'mousedown')
  return true
}

/** Wiring the stack needs from the plugin body. */
export interface BackStackOptions {
  /** Toggle the phone drawer: `ctx.layout.toggleSidebar()`, the top-bar button's own action. */
  toggleSidebar: () => void
}

/**
 * The page-side layer stack behind the shell's system-back callback.
 *
 * `attach` publishes `window.__dshBack` and starts observing; `detach` removes
 * the observer, the globals, and the shell's cached availability (a hot unload
 * must not leave the shell believing a layer is still up).
 */
export class BackStackSignal {
  private readonly options: BackStackOptions
  private observer: MutationObserver | null = null
  private layers: BackLayer[] = []
  private seq = 0
  private depth = -1
  private kinds: BackLayerKind[] = []
  private uplinked = false
  private available = false
  private attached = false

  /** @param options - the drawer toggle callback. */
  constructor(options: BackStackOptions) {
    this.options = options
  }

  /** Publish the back entry and keep the stack current. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    window.__dshBack = () => this.popTop()
    this.observer = new MutationObserver(() => { this.sync() })
    // Document-wide with an attribute filter: the layer anchors are attributes
    // written by upstream stores (sidebar collapse, dialog roles, panel mode)
    // and by this plugin's own marker. MutationObserver already batches one
    // callback per delivered batch, so no extra rAF coalescing is needed.
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    })
    this.sync()
  }

  /** Stop observing and remove every trace of the signal. */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    this.layers = []
    delete window.__dshBack
    delete window.__dshBackDepth
    delete window.__dshBackKinds
    // Explicit false: the shell must not keep consuming back presses for a page
    // that no longer provides the entry.
    this.uplinked = false
    this.publish()
  }

  /** The layer kinds currently stacked, bottom to top (device-side assertions read the global). */
  currentKinds(): readonly BackLayerKind[] {
    return this.kinds
  }

  /**
   * Pop the topmost layer through its own control.
   * @returns whether a layer existed (the shell consumes the press either way);
   *   the stack itself only shrinks when the layer's anchor leaves the DOM.
   */
  private popTop(): boolean {
    // Re-detect before deciding: the observer delivers asynchronously, so the
    // cached stack may lag one batch behind (a rapid second back press).
    this.sync()
    const top = this.layers[this.layers.length - 1]
    if (top === undefined) return false
    try {
      return top.close()
    } catch {
      // A throwing control (detached node, upstream change) must not propagate
      // into the shell's back callback: the layer stays counted, so the press is
      // consumed and the activity is not finished.
      return false
    }
  }

  /** Reconcile the observed layers with the stack, keeping open order. */
  private sync(): void {
    const detected = this.detect()
    const next: BackLayer[] = []
    for (const detection of detected) {
      const existing = this.layers.find(layer => layer.id === detection.id)
      // The close closure is refreshed every pass: the anchor element can be
      // replaced (React remount) while the layer itself is the same layer.
      next.push(existing === undefined
        ? { ...detection, seq: ++this.seq }
        : { ...existing, close: detection.close })
    }
    next.sort((a, b) => a.seq - b.seq)
    this.layers = next
    this.publish()
  }

  /** Every layer currently in the DOM, in a fixed detection order. */
  private detect(): BackLayerDetection[] {
    const found: BackLayerDetection[] = []
    const drawer = this.detectDrawer()
    if (drawer !== null) found.push(drawer)
    for (const dialog of this.detectDialogs()) found.push(dialog)
    const trajectory = this.detectTrajectoryDetails()
    if (trajectory !== null) found.push(trajectory)
    const fullscreen = this.detectRightFullscreen()
    if (fullscreen !== null) found.push(fullscreen)
    const menu = this.detectMenu()
    if (menu !== null) found.push(menu)
    const drill = this.detectMenuDrill()
    if (drill !== null) found.push(drill)
    return found
  }

  /** The drawer: the phone form's expanded left sidebar. */
  private detectDrawer(): BackLayerDetection | null {
    // Phone form only: on a wide viewport the sidebar is docked chrome, not a
    // layer the system back gesture should close.
    if (!document.documentElement.hasAttribute(MOBILE_FORM_ATTR)) return null
    const frame = document.querySelector(FRAME_SELECTOR)
      ?? document.querySelector(RIGHT_COL_SELECTOR)?.parentElement
      ?? null
    if (frame === null || frame.hasAttribute(SIDEBAR_COLLAPSED_ATTR)) return null
    return {
      id: 'drawer',
      kind: 'drawer',
      close: () => {
        this.options.toggleSidebar()
        return true
      },
    }
  }

  /** Every modal surface, in document order (settings panel, Modal, lightbox). */
  private detectDialogs(): BackLayerDetection[] {
    return [...document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)].map((dialog, index) => ({
      // Index-keyed: the modal layer is a singleton in practice (one dialog is
      // on top), and open order is what the stack needs, not long-lived identity.
      id: `dialog:${String(index)}`,
      kind: 'dialog' as const,
      close: () => closeDialog(dialog),
    }))
  }

  /** The trajectory inspector side panel. */
  private detectTrajectoryDetails(): BackLayerDetection | null {
    for (const aside of document.querySelectorAll<HTMLElement>('aside[aria-label]')) {
      if (!TRAJECTORY_LABELS.includes(aside.getAttribute('aria-label') ?? '')) continue
      return {
        id: 'trajectory-details',
        kind: 'trajectory-details',
        close: () => closeTrajectoryDetails(aside),
      }
    }
    return null
  }

  /** The right column's fullscreen presentation. */
  private detectRightFullscreen(): BackLayerDetection | null {
    const panel = document.querySelector<HTMLElement>(RIGHT_FULLSCREEN_SELECTOR)
    if (panel === null) return null
    return {
      id: 'right-fullscreen',
      kind: 'right-fullscreen',
      close: () => closeRightFullscreen(panel),
    }
  }

  /** An open command/reference menu. */
  private detectMenu(): BackLayerDetection | null {
    const menu = document.querySelector<HTMLElement>(MENU_SELECTOR)
    if (menu === null) return null
    return { id: 'menu', kind: 'menu', close: () => closeMenu(menu) }
  }

  /** A menu listing descended into a directory (its breadcrumb header is up). */
  private detectMenuDrill(): BackLayerDetection | null {
    const nav = document.querySelector<HTMLElement>(MENU_DRILL_SELECTOR)
    if (nav === null) return null
    return { id: 'menu-drill', kind: 'menu-drill', close: () => popMenuDrill(nav) }
  }

  /** Publish the observability globals and the shell uplink (only on change). */
  private publish(): void {
    const kinds = this.layers.map(layer => layer.kind)
    if (kinds.length !== this.depth || kinds.some((kind, index) => kind !== this.kinds[index])) {
      this.depth = kinds.length
      this.kinds = kinds
      window.__dshBackDepth = kinds.length
      window.__dshBackKinds = kinds
    }
    const available = kinds.length > 0
    // The bridge call is a synchronous cross-language hop: send it once per
    // change (the first pass always sends, so the shell's cache starts synced),
    // never per DOM mutation batch.
    if (this.uplinked && available === this.available) return
    this.uplinked = true
    this.available = available
    try {
      window.dshBackBridge?.setAvailable?.(available)
    } catch {
      // Bridge absent (desktop host) or the interface was re-registered: the
      // page-side stack keeps working and the shell falls back to canGoBack().
    }
  }
}
