/**
 * Resolves one back action against the live layout and presented WebUI surfaces.
 * Browser document history and the Android task stack remain owned by their hosts.
 * The legacy availability bridge is retained for older APKs.
 */

/** Layer kinds, bottom to top as detected within one pass. */
export type BackLayerKind =
  | 'drawer'
  | 'dialog'
  | 'trajectory-details'
  | 'right-fullscreen'
  | 'browser-history'
  | 'sidebar-bubbles'
  | 'header-options'
  | 'menu'
  | 'menu-drill'
  | 'composer-sheet'
  | 'model-menu'
  | 'main-panel'
  | 'main-panel-detail'
  | 'marketplace'
  | 'context-menu'

/** One observed layer plus the closure that pops it. */
interface BackLayerDetection {
  /** Stable identity across observation passes, so ordering survives re-detection. */
  id: string | Element
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
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="sidebar"])'
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
const BROWSER_BACK_SELECTOR = '[data-sidebar-right-open] [data-dsh-browser-history-back]'
const MAIN_SECTION_LAYER_SELECTOR = '[data-dsh-linux-environment-panel] [data-dsh-settings-sublayer]'
const MENU_SELECTOR = '[data-trigger-menu]'
// ComposerPopupGuard marks only the open, aria-controlled Android ModelSelect portal.
const MODEL_MENU_SELECTOR = '[data-dsh-android-model-menu]'
/**
 * This plugin's own composer "+" bottom sheet (composer-sheet.ts).
 *
 * Same D8 rule the attachment-source popup used: the sheet is mounted on document.body and removed
 * on close, so its presence is exactly "open". The shell's back callback treats "no layer" as
 * FINISH_ACTIVITY (BackGate.kt:56-60), so without this entry pressing system back with the sheet
 * open would exit the app instead of closing it.
 */
const COMPOSER_SHEET_SELECTOR = '[data-dsh-composer-sheet-backdrop]:not([data-dsh-composer-sheet-leaving])'
const CONTEXT_MENU_SELECTOR = '[data-context-menu][role="menu"], [data-subagent-panel], [data-dsh-header-popup], [role="menu"][class*="_viewOptionsMenu"]'
export const COMPOSER_BACK_EVENT = 'dsh-composer-back-request'
export const SETTINGS_BACK_EVENT = 'dsh-settings-back-request'
export const SUBLAYER_POP_EVENT = 'dsh-settings-sublayer-pop'

export function popSectionLayer(layer: Element): boolean {
  if (!layer.dispatchEvent(new Event(SUBLAYER_POP_EVENT, { bubbles: true, cancelable: true }))) return true
  const back = layer.querySelector<HTMLElement>('[data-dsh-settings-sublayer-back]')
  if (back === null) return false
  back.click()
  return true
}
export type NavigationBackResult = 'handled' | 'blocked' | 'root'
export type NavigationBackSource = 'android' | 'control'
/**
 * 第三方市场插件（dshmarketplace-plugin）的整页浮层。
 *
 * 它由那个插件自己渲染在 React 树之外，不是 `role=dialog`，本栈原先完全看不见它：
 * 系统返回被当成「没有可弹的层」=> BackGate 走 FINISH_ACTIVITY，直接回手机桌面。
 * 三个类名都取自该插件自己的产物（`.dshm-overlay` 是遮罩兼关闭面、`.dshm-back` 是
 * market-J-fullpage 补丁加进页头的「‹ 返回」按钮）。
 */
const MARKETPLACE_OVERLAY_SELECTOR = '.dshm-overlay'
const MARKETPLACE_BACK_SELECTOR = '.dshm-back'
/** The drilled-listing breadcrumb header (a `nav`; the candidate list is a `div[role=listbox]`). */
/**
 * Every element any layer's presence is derived from, as one union selector.
 *
 * Why one pass: detect() runs on every coalesced DOM batch (streaming output commits dozens per
 * second), and it used to issue ten separate `document.querySelector(All)` calls — ten full-tree
 * walks per commit regardless of whether any layer was open. Measured on a 1,725-element page:
 * 10.0 document queries per batch. One union pass plus in-memory classification gives the same
 * detections in the same order for one walk (see tests/back-stack-scan-budget.spec.ts).
 *
 * The union must list every selector any detect*() predicate reads, or a layer stops being seen.
 * Classification is **category-major** (all dialogs, then trajectory, ...) exactly like the old
 * per-selector calls, because the stack order is the order layers are pushed.
 */
const CANDIDATE_SELECTOR = [
  FRAME_SELECTOR,
  RIGHT_COL_SELECTOR,
  DIALOG_SELECTOR,
  'aside[aria-label]',
  RIGHT_FULLSCREEN_SELECTOR,
  '[data-dsh-sidebar-bubbles="open"]',
  '[data-dsh-topbar-fold="open"]',
  MENU_SELECTOR,
  MODEL_MENU_SELECTOR,
  COMPOSER_SHEET_SELECTOR,
  MARKETPLACE_OVERLAY_SELECTOR,
  CONTEXT_MENU_SELECTOR,
  BROWSER_BACK_SELECTOR,
  MAIN_SECTION_LAYER_SELECTOR,
].join(', ')
/** Hashed CSS-module close controls still carry the class token (`[class*=ledger]` precedent). */
const CLOSE_CLASS_HINT = '[class*="close"]'
/**
 * One detail level of a global main panel: the plugin manager's package, item,
 * and row pages each carry one of these stable attributes
 * (ui-plugin-manager PluginManagerPage.tsx), and each draws its own crumb.
 */
const PANEL_DETAIL_SELECTORS = ['[data-plugin-detail]', '[data-plugin-item-detail]', '[data-plugin-row-detail]'] as const
/** The crumb button inside one of those levels (class token survives CSS-module hashing). */
const CRUMB_BUTTON_HINT = 'button[class*="crumb"]'
/**
 * This plugin's back control marker, mounted by mobile/main-panel-back.ts at the list root.
 *
 * Kept in the observed-attribute list so a mount/unmount still re-reconciles the layer, but
 * no longer a closure path: the stylesheet paints it display:none and ActivationGuard blocks
 * its activation, so the list root closes at the layout service instead (#1763).
 */
/** Attributes any layer's presence is derived from; the filter keeps the observer cheap. */
const OBSERVED_ATTRIBUTES = [
  MOBILE_FORM_ATTR,
  SIDEBAR_COLLAPSED_ATTR,
  'role',
  'aria-modal',
  'data-shortcut-modal',
  'aria-label',
  'aria-hidden',
  'data-sidebar-right-panel',
  'data-sidebar-right-open',
  'data-trigger-menu',
  'data-dsh-composer-sheet-backdrop',
  'data-dsh-android-model-menu',
  'data-plugin-panel',
  'data-dsh-main-panel-back',
  'data-dsh-sidebar-bubbles',
  'data-dsh-topbar-fold',
  'data-dsh-composer-sheet-leaving',
  'data-dsh-composer-sheet-concealed',
  'data-dsh-header-popup',
  'data-dsh-settings-level',
  'data-dsh-settings-depth',
  'disabled',
  'hidden',
  'inert',
]

const MUTATION_CANDIDATE_SELECTOR = CANDIDATE_SELECTOR +
  ', [data-dsh-settings-sublayer], [data-dsh-browser-history-back]'

function containsCandidate(node: Node): boolean {
  return node instanceof Element &&
    (node.matches(MUTATION_CANDIDATE_SELECTOR) || node.querySelector(MUTATION_CANDIDATE_SELECTOR) !== null)
}

function affectsNavigation(record: MutationRecord): boolean {
  if (!(record.target instanceof Element)) return false
  if (record.type === 'childList') {
    // Breadcrumbs belong to a menu. Other insertions matter only if their
    // subtree brings a layer in or removes one.
    return record.target.closest(MENU_SELECTOR) !== null ||
      [...record.addedNodes, ...record.removedNodes].some(containsCandidate)
  }
  if (record.target === document.documentElement || record.target.matches(MUTATION_CANDIDATE_SELECTOR)) return true
  // Closing attributes can make a previously matching element stop matching.
  if (record.attributeName?.startsWith('data-') || record.attributeName === 'role' ||
    record.attributeName === 'aria-modal' || record.attributeName === 'aria-label') return true
  if (record.attributeName === 'aria-hidden' || record.attributeName === 'hidden' || record.attributeName === 'inert') {
    return record.target.querySelector(CANDIDATE_SELECTOR) !== null
  }
  return false
}

declare global {
  interface Window {
    /** Pop the topmost page layer; false when the page holds no layer of its own. */
    __dshBack?: () => boolean
    __dshNavigationBack?: (source: NavigationBackSource) => NavigationBackResult
    __dshNavigationTrace?: boolean
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
  if (dialog.hasAttribute('data-dsh-settings-dialog')) {
    const request = new Event(SETTINGS_BACK_EVENT, { bubbles: true, cancelable: true })
    if (!dialog.dispatchEvent(request)) return true
    const section = dialog.querySelector('[data-dsh-settings-sublayer]')
    if (section !== null) return popSectionLayer(section)
  }
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
  // First dismiss the bubble menu. On a phone the column has no smaller
  // presentation, so Back collapses it; on wide layouts it can exit fullscreen.
  const mobile = document.documentElement.hasAttribute(MOBILE_FORM_ATTR)
  const mode = panel.querySelector('[data-dsh-mode-proxy]') ?? panel.querySelector('[data-sidebar-right-mode]')
  const collapse = panel.querySelector('[data-dsh-collapse-proxy]') ?? panel.querySelector('[data-sidebar-right-toggle]')
  const target = panel.querySelector('[data-dsh-sidebar-bubbles-toggle][aria-expanded="true"]')
    ?? (mobile ? collapse ?? mode : mode ?? collapse)
  if (target === null) return false
  dispatchMouse(target, 'click')
  return true
}

/**
 * Leave one level of an upstream global main panel.
 *
 * The plugin manager owns a depth hierarchy (list -> package -> row) and each
 * detail level draws its own crumb control, so a press pops exactly one level
 * through that control rather than writing the page's store. The list root
 * draws no control of its own, so it closes at the layout service directly
 * (see the #1763 note below).
 * @returns whether a level was left (the press is consumed either way).
 */
function closeMainPanel(leave: () => void): boolean {
  // One detail level at a time, through the crumb the page itself draws.
  const details = PANEL_DETAIL_SELECTORS.flatMap(selector => [...document.querySelectorAll(selector)])
  const detail = details[details.length - 1]
  const crumb = detail?.querySelector(CRUMB_BUTTON_HINT)
    ?? document.querySelector('[data-plugin-panel] > header[data-window-drag] button[class*="moreBack"]')

  if (crumb !== null) {
    dispatchMouse(crumb, 'click')
    return true
  }
  // The list root. Leaving the panel is the layout service own panel selection - the exact
  // action the sidebar rows perform - and it is taken directly, not by clicking this plugin
  // own injected back control (#1763).
  //
  // Why the injected control cannot be that path, measured on the device (0.14.11, phone
  // form, 900x1600): main-panel-back.css.ts paints it display:none !important on purpose
  // (the 2026-11-14 round that kept only the title), so it has no layout box; and this
  // plugin own ActivationGuard swallows activations of controls the page does not present
  // (#1317). Evidence: button.dispatchEvent(new MouseEvent('click')) returned false, no
  // document capture listener ran, and the node carried data-dsh-activation-inert. The
  // layer stayed selected, so every system-back press was consumed and did nothing - the
  // reported "back does nothing" while the shell log said DISPATCH_PAGE_STACK.
  //
  // The button stays mounted: it is a real affordance if a later round paints it again, and
  // main-panel-back.spec.ts group C still covers its click handler.
  leave()
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
  /**
   * The presented global main panel (`ctx.layout.panelInfo.activePanelId`), or
   * null while the Conversation is presented.
   *
   * Read from the layout service rather than the DOM: it is the upstream fact
   * "which main panel is selected", it covers every registrant of the `main`
   * seat, and it keeps the layer out of the Conversation — where the shell must
   * still finish the activity.
   */
  activePanelId: () => string | null
  /**
   * Leave the presented main panel (upstream `ctx.layout.selectPanel(null)`).
   *
   * The list root draws no back control of its own, so this is that level final
   * closure; the detail levels never reach it (their crumb pops first).
   */
  leaveMainPanel: () => void
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
  /** 合帧用的挂起标记：一批 DOM 变更只换一次检测。 */
  private scheduled: number | null = null

  /** @param options - the drawer toggle callback. */
  constructor(options: BackStackOptions) {
    this.options = options
  }

  /** Publish the back entry and keep the stack current. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    window.__dshBack = () => this.requestBack('android') === 'handled'
    window.__dshNavigationBack = source => this.requestBack(source)
    window.addEventListener('popstate', this.onHistoryTraversal)
    this.observer = new MutationObserver(records => {
      if (records.some(affectsNavigation)) this.schedule()
    })
    // React may insert a complete surface with its attributes already applied.
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    })
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('pageshow', this.onVisibilityChange)
    this.sync()
  }

  /**
   * 合帧：一批 DOM 变更只安排一次检测。
   *
   * 为什么必须有：观察面是全文档，流式渲染时每个提交都会送来一批变更，而一次 detect()
   * 要跑六七个全文档查询。审计 §7.3 点名的就是「回调直接 sync()，没有合帧」。
   * 合帧窗口是一个宏任务（不是 rAF）：页面不可见时 rAF 不派发，层栈信号就会停在旧值上，
   * 而壳侧正是靠这个信号决定按返回键要不要问页面。
   */
  private schedule(): void {
    if (this.scheduled !== null || !this.attached) return
    this.scheduled = window.setTimeout(() => {
      this.scheduled = null
      this.sync()
    }, 0)
  }

  /** 回到前台立刻结算一次挂起的检测（后台里合帧窗口可能被节流）。 */
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) return
    this.sync()
  }

  /** Stop observing and remove every trace of the signal. */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    if (this.scheduled !== null) window.clearTimeout(this.scheduled)
    this.scheduled = null
    window.removeEventListener('popstate', this.onHistoryTraversal)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('pageshow', this.onVisibilityChange)
    this.layers = []
    delete window.__dshBack
    delete window.__dshNavigationBack
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
   * Re-reconcile now.
   *
   * The main-panel layer fact lives in the layout service, not in the DOM, so a panel
   * switch is also pushed from its subscription; a DOM change that leaves the same panel
   * selected must not be the only trigger.
   */
  refresh(): void {
    if (this.attached) this.sync()
  }

  // popstate arrives after the browser has traversed. Let the existing router
  // restore that entry, then reconcile its committed DOM without traversing again.
  private readonly onHistoryTraversal = (): void => { this.schedule() }

  requestBack(source: NavigationBackSource): NavigationBackResult {
    this.sync()
    const top = this.layers[this.layers.length - 1]
    let result: NavigationBackResult = 'root'
    if (top !== undefined) {
      try {
        result = top.close() ? 'handled' : 'blocked'
      } catch {
        result = 'blocked'
      }
    }
    if (window.__dshNavigationTrace === true) {
      console.info('[dsh-navigation]', {
        source, panel: this.options.activePanelId(), stack: this.kinds,
        layer: top?.kind ?? null, result,
      })
    }
    return result
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
    const sheetActive = next.some(layer => layer.kind === 'composer-sheet')
    next.sort((a, b) => {
      const rank = (kind: BackLayerKind): number => {
        if (kind === 'browser-history' || (sheetActive && (kind === 'menu' || kind === 'menu-drill'))) return 1
        if (kind === 'drawer' || kind === 'main-panel' || kind === 'main-panel-detail' || kind === 'right-fullscreen') return 0
        return 2
      }
      if (a.id instanceof Element && b.id instanceof Element) {
        if (a.id.contains(b.id)) return -1
        if (b.id.contains(a.id)) return 1
      }
      return rank(a.kind) - rank(b.kind) || a.seq - b.seq
    })
    this.layers = next
    this.publish()
  }

  /** Every layer currently in the DOM, in a fixed detection order. */
  private detect(): BackLayerDetection[] {
    const found: BackLayerDetection[] = []
    // One full-document walk per batch. The predicates below used to walk the tree once each
    // (ten walks per commit); they now read this snapshot. See CANDIDATE_SELECTOR.
    const candidates = [...document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)]
    const first = (selector: string): HTMLElement | null => {
      for (const element of candidates) if (element.matches(selector)) return element
      return null
    }
    const all = (selector: string): HTMLElement[] => candidates.filter(element => element.matches(selector))
    const presented = (element: HTMLElement): boolean =>
      element.closest('[hidden], [inert], [aria-hidden="true"], [data-dsh-composer-sheet-concealed]') === null
    const drawer = this.detectDrawer(first)
    if (drawer !== null) found.push(drawer)
    const mainPanel = this.detectMainPanel()
    if (mainPanel !== null) {
      found.push(mainPanel)
      const section = first(MAIN_SECTION_LAYER_SELECTOR)
      if (section !== null) found.push({
        id: section, kind: 'main-panel-detail', close: () => popSectionLayer(section),
      })
    }
    for (const dialog of this.detectDialogs(all)) found.push(dialog)
    const trajectory = this.detectTrajectoryDetails(all)
    if (trajectory !== null) found.push(trajectory)
    const fullscreen = this.detectRightFullscreen(first)
    if (fullscreen !== null) found.push(fullscreen)
    const browserBack = all(BROWSER_BACK_SELECTOR).find(button => !button.matches(':disabled') && presented(button))
    if (browserBack !== undefined) found.push({
      id: browserBack, kind: 'browser-history', close: () => { browserBack.click(); return true },
    })
    const bubbles = first('[data-dsh-sidebar-bubbles="open"]')
    const bubbleToggle = bubbles?.parentElement?.querySelector<HTMLElement>('[data-dsh-sidebar-bubbles-toggle]')
    if (bubbles && bubbleToggle) found.push({ id: 'sidebar-bubbles', kind: 'sidebar-bubbles', close: () => { bubbleToggle.click(); return true } })
    const headerOptions = first('[data-dsh-topbar-fold="open"]')
      ?.closest('header')?.querySelector('[data-dsh-topbar-fold-arrow][aria-expanded="true"]')
    if (headerOptions instanceof HTMLElement) found.push({
      id: 'header-options',
      kind: 'header-options',
      close: () => {
        // Give native/third-party popup dismissal listeners the same outside
        // gesture as a tap on the disclosure, before hiding their anchor.
        dispatchPointerDown(headerOptions)
        headerOptions.click()
        return true
      },
    })
    for (const menu of all(MENU_SELECTOR).filter(presented)) {
      found.push({ id: menu, kind: 'menu', close: () => closeMenu(menu) })
      const nav = menu.querySelector('nav')
      if (nav !== null) found.push({ id: nav, kind: 'menu-drill', close: () => popMenuDrill(nav) })
    }
    const modelMenu = this.detectModelMenu(first)
    if (modelMenu !== null) found.push(modelMenu)
    const composerSheet = this.detectComposerSheet(first)
    if (composerSheet !== null) found.push(composerSheet)
    const marketplace = this.detectMarketplace(first)
    if (marketplace !== null) found.push(marketplace)
    for (const menu of all(CONTEXT_MENU_SELECTOR).filter(presented)) {
      found.push({ id: menu, kind: 'context-menu', close: () => closeMenu(menu) })
    }
    return found
  }

  /** The drawer: the phone form's expanded left sidebar. */
  private detectDrawer(first: (selector: string) => HTMLElement | null): BackLayerDetection | null {
    // Phone form only: on a wide viewport the sidebar is docked chrome, not a
    // layer the system back gesture should close.
    if (!document.documentElement.hasAttribute(MOBILE_FORM_ATTR)) return null
    const frame = first(FRAME_SELECTOR) ?? first(RIGHT_COL_SELECTOR)?.parentElement ?? null
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

  /**
   * The presented global main panel (plugin manager, task manager).
   *
   * It is not a dialog, so nothing else in this stack sees it: without this
   * layer a back press finished the activity from inside the page. The stack
   * position is above the drawer (the panel covers it) and below dialogs and
   * menus, so a surface opened over the panel still closes first.
   */
  private detectMainPanel(): BackLayerDetection | null {
    if (this.options.activePanelId() === null) return null
    return { id: 'main-panel', kind: 'main-panel', close: () => closeMainPanel(() => { this.options.leaveMainPanel() }) }
  }

  /** Every modal surface, in document order (settings panel, Modal, lightbox). */
  private detectDialogs(all: (selector: string) => HTMLElement[]): BackLayerDetection[] {
    return all(DIALOG_SELECTOR)
      .filter(dialog => dialog.closest('[hidden], [inert], [aria-hidden="true"], [data-dsh-composer-sheet-backdrop]') === null)
      .map(dialog => ({ id: dialog, kind: 'dialog', close: () => closeDialog(dialog) }))
  }

  /** The trajectory inspector side panel. */
  private detectTrajectoryDetails(all: (selector: string) => HTMLElement[]): BackLayerDetection | null {
    for (const aside of all('aside[aria-label]')) {
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
  private detectRightFullscreen(first: (selector: string) => HTMLElement | null): BackLayerDetection | null {
    const panel = first(RIGHT_FULLSCREEN_SELECTOR)
    if (panel === null) return null
    return {
      id: 'right-fullscreen',
      kind: 'right-fullscreen',
      close: () => closeRightFullscreen(panel),
    }
  }

  /** ModelSelect owns Escape: leave its drilled pane first, then close and restore trigger focus. */
  private detectModelMenu(first: (selector: string) => HTMLElement | null): BackLayerDetection | null {
    const menu = first(MODEL_MENU_SELECTOR)
    if (menu === null) return null
    return {
      id: 'model-menu',
      kind: 'model-menu',
      close: () => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        // ModelSelect prevents default when it handles Escape. dispatchEvent's false return
        // therefore means handled, not a reason for the Android shell to finish the Activity.
        return true
      },
    }
  }

  /**
   * This plugin's own composer "+" bottom sheet.
   *
   * Distinct from the upstream trigger menus: it is our node, mounted on document.body, and the
   * sheet already closes on the same outside-pointerdown gesture upstream menus use - so the shared
   * dismissal path below is the right control.
   */
  private detectComposerSheet(first: (selector: string) => HTMLElement | null): BackLayerDetection | null {
    const sheet = first(COMPOSER_SHEET_SELECTOR)
    if (sheet === null) return null
    return { id: sheet, kind: 'composer-sheet', close: () => !sheet.dispatchEvent(new Event(COMPOSER_BACK_EVENT, { cancelable: true })) || closeMenu(sheet) }
  }

  /**
   * 第三方市场插件的整页浮层（见 MARKETPLACE_OVERLAY_SELECTOR 的说明）。
   *
   * 用浮层自带的「‹ 返回」当关闭控件；拿不到按钮时退回点蒙层（overlay 的 onClick 就是 close）。
   * 找不到控件就不入栈——与「入栈后必须能关掉」相反的方向在这里不适用：它本就不是本插件
   * 的节点，强行入栈会让返回键一直消费却毫无效果。
   */
  private detectMarketplace(first: (selector: string) => HTMLElement | null): BackLayerDetection | null {
    const overlay = first(MARKETPLACE_OVERLAY_SELECTOR)
    if (overlay === null) return null
    return {
      id: 'marketplace',
      kind: 'marketplace',
      close: () => {
        const button = overlay.querySelector<HTMLElement>(MARKETPLACE_BACK_SELECTOR)
        if (button !== null) { button.click(); return true }
        overlay.click()
        return true
      },
    }
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
