/**
 * 0.14.7 侧边栏"实时跟手"的位移消费方（sidebar-gestures.ts 是手势源，本模块是落点）。
 *
 * 为什么需要它：两根侧栏此前都只在松手后由 CSS 状态类切换，位移本身由 transition 演出。
 * 手势源现在会在每次 touchmove 上报 progress(0..1)，但"上报"本身不改变屏幕 —— 必须有人
 * 把它换算成内联位移，并保证松手后交还给 CSS 过渡，否则要么不跟手、要么先弹回 0 再展开。
 *
 * 三条不变量：
 * - 拖动中（gestures 打的 data-dsh-drawer-dragging 在场）只写内联 transform；标记由手势源
 *   打撤，本模块不重复清理，避免两个所有者抢同一状态。
 * - endPreview() 只清自己写过的内联位移，不改任何开合状态：状态提交由手势源在松手时先做，
 *   内联值清空后 CSS transition 从"手指停留位置"平滑收敛到那个状态（见 index.ts 的装配顺序）。
 * - 设置面板打开时左抽屉被 CSS 钉成 transform:none，内联位移会盖掉它；因此该态下左抽屉不做
 *   预览落点，只保留状态提交，避免把设置面板拖出屏幕。
 */

/** 左抽屉（off-canvas）的根元素，与 sidebar-gestures 同源。 */
const DRAWER_SELECTOR = '[data-dsh-frame] > [class*="sidebarCol"]'
/** 右栏本体：只用来定位子树，位移不写在它身上（见下方 RIGHT_SLIDE_SELECTOR 的说明）。 */
const RIGHT_PANEL_SELECTOR = '[data-sidebar-right-panel="fullscreen"]'
/**
 * 右栏真正的滑动元素。
 *
 * 上游把收起位移写在这些 dockkit 子元素上（ui-sidebar-right 的 SidebarRight.module.css:
 * `transform: translateX(var(--dsh-sidebar-width))`，展开态 none），而不是右栏本体。跟着它的
 * 同一批元素写内联位移有两个理由：内联优先级最高，天然盖过上游的两条规则，不需要 !important
 * 与规则顺序打架；并且不给出本体加 transform —— 本体一旦成为 transformed ancestor 就会变成
 * 内部固定定位子元素（浮动面板、指针）的 containing block，把它们一起带走。
 * 只取 host='dock'：float 模式是浮动窗，上游也从不给它位移。
 *
 * 0.14.9：移动端气泡头（sidebar-bubbles.ts 的 .dsh-bubble-header，含弹层与遮罩）直接挂在
 * 面板根节点上，不在 dockkit 子树里 —— 只平移 host 时内容跟手、顶栏不动，松手提交后顶栏
 * 才随收起态瞬移消失。它必须和 host 同一批落点、同一帧位移。
 */
const RIGHT_SLIDE_SELECTOR = [
  `${RIGHT_PANEL_SELECTOR} [data-dockkit-host='dock']`,
  `${RIGHT_PANEL_SELECTOR} [data-dockkit-empty]`,
  `${RIGHT_PANEL_SELECTOR} [data-dockkit-divider]`,
  `${RIGHT_PANEL_SELECTOR} > [data-dsh-bubble-nav]`,
].join(', ')

/** 取一个面板的滑动元素：左抽屉只有一个，右栏是上面那批。 */
function slideTargets(side: 'left' | 'right'): HTMLElement[] {
  if (side === 'left') {
    const drawer = document.querySelector<HTMLElement>(DRAWER_SELECTOR)
    return drawer === null ? [] : [drawer]
  }
  return Array.from(document.querySelectorAll<HTMLElement>(RIGHT_SLIDE_SELECTOR))
}

/** 右栏收起的行程：与上游 `translateX(var(--dsh-sidebar-width))` 同一参照（fullscreen 为
 * 面板宽度 = 100vw，push 为列宽）。不能再用百分比：split 下每个 host 只有面板一半宽、
 * 气泡头更是与 host 同宽不同，百分比会让同一帧里各元素位移各不相同。 */
function rightSlideDistance(): number {
  const panel = document.querySelector<HTMLElement>(RIGHT_PANEL_SELECTOR)
  const measured = panel?.getBoundingClientRect().width ?? 0
  return measured > 0 ? measured : document.documentElement.clientWidth || window.innerWidth || 0
}

/**
 * 把一个面板的展开度写成内联位移。
 * @param progress - 0..1，1 = 完全展开。
 * @param side - 哪一根侧栏。
 */
function paint(progress: number, side: 'left' | 'right'): void {
  const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress
  // 左抽屉收起在 -100%（百分比参照自身宽度，即抽屉宽）。右栏按像素行程统一换算。
  const transform = side === 'left'
    ? `translateX(-${(1 - clamped) * 100}%)`
    : `translateX(${(1 - clamped) * rightSlideDistance()}px)`
  for (const element of slideTargets(side)) {
    element.style.transform = transform
    // 右栏收起态是 visibility:hidden（上游规则），不翻回来的话向右侧拖动时它根本不可见，
    // 跟手就成了"看不见的位移"。拖动期间一律可见，松手后由 endPreview 交还 CSS：展开态
    // 立即可见，收起态靠那条 200ms 延迟的 visibility 过渡正好滑出后再隐藏。
    if (side === 'right') element.style.visibility = 'visible'
  }
}

/** Whether the settings panel currently pins the left drawer (its own CSS rule). */
function settingsPinned(): boolean {
  return document.documentElement.hasAttribute('data-dsh-settings-open')
}

/**
 * 手势源需要的三个回调，绑定到当前 DOM 的侧栏元素上。
 *
 * 元素每次查询而不缓存：上游重挂载会换掉 panel 节点（React 重建），缓存会写到已脱离的节点上，
 * 表现为"偶尔某次拖动不跟手"。
 */
export class SidebarDragPreview {
  /** 左抽屉是否写过内联位移（决定 endPreview 要不要清它）。 */
  private leftPainted = false
  /** 右栏是否写过内联位移。 */
  private rightPainted = false

  /**
   * 左抽屉实时展开度。
   * @param progress - 0..1。
   */
  readonly previewLeft = (progress: number): void => {
    // 设置面板态由 CSS 钉住抽屉（transform:none），内联位移会把它拖走 —— 不落点。
    if (settingsPinned()) return
    this.leftPainted = true
    paint(progress, 'left')
  }

  /**
   * 右栏实时展开度。
   * @param progress - 0..1。
   */
  readonly previewRight = (progress: number): void => {
    this.rightPainted = true
    paint(progress, 'right')
  }

  /**
   * 松手 / 取消 / 多指打断 / detach 的唯一复位出口：清掉内联位移，把位移权交回 CSS 过渡。
   * 不触碰任何开合状态 —— 状态提交已由手势源在同一帧先完成。
   */
  readonly endPreview = (): void => {
    if (this.leftPainted) {
      this.leftPainted = false
      for (const element of slideTargets('left')) element.style.transform = ''
    }
    if (this.rightPainted) {
      this.rightPainted = false
      for (const element of slideTargets('right')) {
        element.style.transform = ''
        element.style.visibility = ''
      }
    }
  }
}
