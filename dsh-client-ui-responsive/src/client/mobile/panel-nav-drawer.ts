/**
 * Move the phone drawer aside when a global main panel is selected (0.14.2 FX1-C).
 *
 * The panel the drawer navigates to is drawn in the centre column, but on the phone
 * form the sidebar is a `position: fixed` off-canvas overlay 289px wide (mobile-form.css.ts).
 * Selecting a panel therefore left the drawer covering the panel it had just opened -
 * including that panel's own back control, which the user then could not see or tap
 * ("点进去就出不来" / "你关闭键呢").
 *
 * Upstream cannot do this itself: `selectPanel` only writes `panelInfo.activePanelId`,
 * and the docked desktop sidebar has no reason to close.
 *
 * 2026-11-14（用户）：「从侧边栏中打开插件页面后，侧边栏不会自动关闭」。两个原因一起修：
 * - 判据原本只认 `lastPanelId === null`（会话 -> 面板这一次跳变）。面板已经是同一个 id 时
 *   （在插件页打开抽屉再点「插件」）一次都不会收；
 * - 「已经收起」原本只读 `data-sidebar-collapsed`。手势把抽屉拉开后这个状态位可能仍写着
 *   收起，于是 sync 读到「已收起」直接返回 —— 抽屉就那么开着压在刚打开的面板上。
 * 现在：面板非空就尝试收；收不收得动由几何判断（左抽屉右缘是否在视口内），
 * 状态位只作为没有列元素时的兜底。
 */
/** Phone-form marker (mobile/form-marker.ts); the drawer is an overlay only on phones. */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
/** Frame root tag written by the form marker. */
const FRAME_SELECTOR = '[data-dsh-frame]'
/** Frame attribute: present while the left drawer is collapsed. */
const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'
/** 抽屉自身的收合过渡 200ms；等它跑完再判，过渡期间补点会把 toggle 再翻一次。 */
const NAV_DISMISS_DELAY_MS = 260
/** 抽屉在屏上的判据：左抽屉右缘越过这个像素数就算还开着。 */
const DRAWER_ON_SCREEN_MIN_RIGHT = 8

/** The frame facts this behaviour reads. */
export interface PanelNavDrawerDeps {
  /** The presented main panel, or null while the Conversation is shown. */
  activePanelId(): string | null
  /** Collapse the drawer: upstream `ctx.layout.toggleSidebar()`. */
  collapseDrawer(): void
  /** The tagged frame root, or null before the form marker lands. */
  frame(): Element | null
}

/**
 * Collapses the drawer once, when a panel selection replaces the Conversation.
 *
 * Not a subscription owner: the caller feeds it the layout service's notifications,
 * so this class holds no listener of its own and cannot leak one.
 */
export class PanelNavDrawer {
  private readonly deps: PanelNavDrawerDeps
  private lastPanelId: string | null
  private dismissing = false

  /** @param deps - frame facts and the drawer action. */
  constructor(deps: PanelNavDrawerDeps) {
    this.deps = deps
    this.lastPanelId = deps.activePanelId()
  }

  /**
   * Reconcile against the current panel selection.
   * @returns whether the drawer was collapsed by this call.
   */
  sync(): boolean {
    const panelId = this.deps.activePanelId()
    const opened = panelId !== null && this.lastPanelId === null
    this.lastPanelId = panelId
    if (!opened) return false
    if (!document.documentElement.hasAttribute(MOBILE_FORM_ATTR)) return false
    const frame = this.deps.frame() ?? document.querySelector(FRAME_SELECTOR)
    if (frame === null) return false
    // Geometry first: the state bit can lag behind a gesture-opened drawer, and reading it
    // as "already collapsed" is exactly how the drawer stayed on top of the panel.
    if (!this.drawerOnScreen(frame)) return false
    this.deps.collapseDrawer()
    return true
  }

  /**
   * 手机形态下点抽屉里的导航条目后，把抽屉收回去（2026-11-14 用户：「从侧边栏中打开
   * 插件页面后，侧边栏不会自动关闭」，自动化任务那一屏同样）。
   *
   * `sync()` 只覆盖「面板 id 从 null 变成某个值」这一种跳变：点同一项面板、或者打开的是
   * 没有 `[data-plugin-panel]` 标记的面板（自动化任务），订阅给不出判据。这里直接看交互：
   * 点在抽屉里的条目就算一次导航。
   *
   * 监听放在 document 捕获阶段，抽屉自己的点击处理照常先跑；延迟到过渡结束后再判，
   * 只对「真的还开着」的抽屉动手。
   */
  attachNavDismiss(): void {
    if (this.dismissing) return
    this.dismissing = true
    document.addEventListener('click', this.onNavClick, true)
  }

  /** 撤掉交互判据的监听（热卸载不留孤儿）。 */
  detachNavDismiss(): void {
    if (!this.dismissing) return
    this.dismissing = false
    document.removeEventListener('click', this.onNavClick, true)
  }

  private readonly onNavClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (!document.documentElement.hasAttribute(MOBILE_FORM_ATTR)) return
    const frame = this.deps.frame() ?? document.querySelector(FRAME_SELECTOR)
    if (frame === null) return
    const column = frame.querySelector<HTMLElement>("[class*='sidebarCol']")
    if (column === null || !column.contains(target)) return
    if (target.closest('button, a, [role="button"], [role="menuitem"]') === null) return
    // 展开器（aria-expanded）只改树形结构，不是导航。
    if (target.closest('[aria-expanded]') !== null) return
    window.setTimeout(() => {
      const live = this.deps.frame() ?? document.querySelector(FRAME_SELECTOR)
      if (live !== null) this.dismiss(live)
    }, NAV_DISMISS_DELAY_MS)
  }

  /** 抽屉真在屏上时，用遮罩自己的 toggleSidebar 把它收回去。 */
  private dismiss(frame: Element): void {
    if (!this.drawerOnScreen(frame)) return
    const mask = document.querySelector('[data-sidebar-mask]')
    if (!(mask instanceof HTMLElement)) return
    mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  /** 抽屉在屏判据：没有列元素时退回状态位，有列元素时只认几何。 */
  private drawerOnScreen(frame: Element): boolean {
    const column = frame.querySelector<HTMLElement>("[class*='sidebarCol']")
    if (column === null) return !frame.hasAttribute(SIDEBAR_COLLAPSED_ATTR)
    return column.getBoundingClientRect().right > DRAWER_ON_SCREEN_MIN_RIGHT
  }
}
