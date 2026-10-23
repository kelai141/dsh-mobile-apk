/**
 * 抽屉收起时关掉页面上仍开着的瞬态浮层（issue #489）。
 *
 * 现场：工作区行的「…」菜单（上游 WorkspaceRow 的 primitives Menu，portal 到 body、
 * fixed 定位）开着时，用折叠按钮 / 左滑手势 / 系统返回键收起抽屉，菜单仍停在视口里、
 * 原锚点附近且可点——portal 菜单不在抽屉子树里，抽屉被 CSS 平移出屏动不到它；primitives
 * 的定位循环还会把菜单钳在视口内。而 primitives Menu 只在「document 上收到目标在
 * 菜单/锚点之外的 pointerdown、Escape、选中某项、窗口失焦」时关闭，上述几条收起路径
 * 只翻布局状态，其中任何一条通知都不发。点遮罩那条路之所以正常，是真实点按本身
 * 携带了一次外部 pointerdown。
 *
 * 修法：监听外框根 data-sidebar-collapsed 的「开 → 合」翻转，翻转时对 document.body
 * 派发一次冒泡的 pointerdown（与 back-stack.ts closeMenu 同一手法），让页面上所有以
 * 「外部按下即收」为判据的瞬态浮层（primitives Menu、@/slash MenuView、附件源菜单、
 * 模型菜单等）各自按自己的判据收起。选属性翻转而不是包装各条收起动作，是因为收起入口
 * 不止本插件注入的几条——上游抽屉自己的折叠按钮直通布局服务，插件包装不到；frame 的
 * 这个属性是全部收起路径的唯一汇总点。
 *
 * 边界：手机形态才介入（桌面收起是锚点原地变窄，且折叠按钮的真实点按本就会关菜单）；
 * 只在「开 → 合」翻转时派发一次，展开方向与初始收起态都不派发。派发的是不落在任何
 * 浮层内部的普通 pointerdown，除「外部按下即收」类浮层外没有其他消费者——与点遮罩
 * 路径里真实点按产生的那个外部 pointerdown 等效。
 */

/** 外框根，抽屉的开合状态写在它上面。 */
const FRAME_SELECTOR = '[data-dsh-frame]'
/** 外框属性：存在即抽屉已收起。 */
const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'

export interface DrawerOverlayDismissDeps {
  /** 当前是否手机形态。 */
  mobileForm: () => boolean
}

/**
 * On the open -> collapsed flip of the frame attribute, dispatch one outside
 * pointerdown so every outside-press-dismissed overlay closes through its own rule.
 */
export class DrawerOverlayDismiss {
  private frame: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private waitObserver: MutationObserver | null = null
  /** 上一次读到的收起态；null = 尚未建立基线（首个读数只记状态，不触发）。 */
  private collapsed: boolean | null = null
  private attached = false

  constructor(
    private readonly deps: DrawerOverlayDismissDeps,
    private readonly doc: Document = document,
  ) {}

  /**
   * Bind the current frame and record its collapsed state as the baseline.
   * @returns false while the frame has not mounted yet (plugin order).
   */
  private bind(): boolean {
    const frame = this.doc.querySelector<HTMLElement>(FRAME_SELECTOR)
    if (frame === null) return false
    this.frame = frame
    this.collapsed = frame.hasAttribute(SIDEBAR_COLLAPSED_ATTR)
    this.observer = new MutationObserver(this.onMutate)
    this.observer.observe(frame, { attributes: true, attributeFilter: [SIDEBAR_COLLAPSED_ATTR] })
    return true
  }

  private readonly onMutate = (): void => {
    if (this.frame === null) return
    const now = this.frame.hasAttribute(SIDEBAR_COLLAPSED_ATTR)
    const was = this.collapsed
    this.collapsed = now
    if (was === false && now === true && this.deps.mobileForm()) this.dismissOverlays()
  }

  /** 派发一次落在页面根上的外部 pointerdown（PointerEvent 缺席时退化为 MouseEvent）。 */
  private dismissOverlays(): void {
    const target = this.doc.body
    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      return
    }
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    if (this.bind()) return
    // The frame can mount after this entry (plugin order): wait for it, then
    // take the baseline from its real state (same wait as MobileChrome's mirror).
    this.waitObserver = new MutationObserver(() => { if (this.bind()) this.waitObserver?.disconnect() })
    this.waitObserver.observe(this.doc.documentElement, { childList: true, subtree: true })
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    this.waitObserver?.disconnect()
    this.waitObserver = null
    this.frame = null
    this.collapsed = null
  }
}
