/**
 * Narrow-screen content gestures for the frame's independent sidebars.
 *
 * Only a deliberate, horizontal drag that starts away from the system gesture
 * edges is claimed. A right drag opens the left navigation drawer; a left drag
 * closes it or returns a selected main panel to Conversation. A left drag opens
 * the right panel and a right drag closes it.
 *
 * 0.14.7「实时跟手」：旧实现只在 touchmove 里 preventDefault，真正的开合留到 touchend
 * 按 SWIPE_PX 一次性触发 —— 手指移动时抽屉纹丝不动、松手才跳过去，这就是用户报告的
 * 跟手迟滞 / 动画突兀。现在确认横向手势后，每次 touchmove 都回调 previewLeft /
 * previewRight 上报 progress（0..1，1 = 该面板完全展开；分母是该面板**自己的位移参照
 * 系**，右栏是 --dsh-sidebar-width 而非固定 288px），由消费方（index.ts +
 * mobile-form.css.ts）实时落到位移上；防误触只靠方向（HORIZONTAL_RATIO）与距离
 * （START_SLOP_PX）判定，不引入任何固定时延阻尼。
 *
 * 0.14.7 灵敏度修复（2026-10-12 真机 V2425A / 360 CSS px 反馈「开合都略低、不跟手，
 * 时不时拖了没反应」）：四条成因一起改 ——
 *   1. 死区 START_SLOP_PX 12 -> 8（前 12px 完全没有响应）；
 *   2. HORIZONTAL_RATIO 1.5 -> 1.0，**「时不时没反应」的主因**：真手指走不直，横 100 / 纵 70
 *      时 100 <= 70*1.5 被整条丢弃。降到 1.0 只要求横向分量更大，纵向仍天然被排除；
 *   3. 新增甩动通道：松手结算原先只有「位移过半」一把尺子（左抽屉 288px 要 144px、右栏
 *      100vw=360px 要 180px），短促快甩一律弹回 —— 这是「要拖很久才动」的来源；
 *   4. 甩动同时放行 SWIPE_PX 距离闸门。
 * 距离口径（progress >= 0.5）原样保留，慢速长拖不回归。SYSTEM_EDGE_EXCLUSION_PX 未动。
 *
 * 0.14.7 竞态修正：touch-action 必须在触点按下前生效。mobile-form.css.ts 预置
 * pan-y pinch-zoom，横向滚动容器由本模块预先标记并保留原生平移；touchstart 不改样式。
 * 浏览器一旦接管纵向滚动，本序列即退出，不能随后改判横向、让页面与抽屉同时移动。
 * 纯横向不可取消事件仍允许跟手，避免把 cancelable 当成“手势未发生”的判据。
 *
 * 0.14.7 修复（2026-10-12 真机 CDP 实测，task-7）「半拖只显示内容的一部分」：
 * 上游**只按 frame 的 data-sidebar-collapsed 渲染抽屉内容** —— 收起态是 58 元素 /
 * 11232B 的收起导轨，展开态才是 202 元素 / 40035B 的完整抽屉。此前拖动期间不提交开合
 * 状态，预览层平移的永远是那根**导轨**（整条盒子被 translateX 拖进来，却没有内容），
 * 松手才提交、内容才出现 —— 用户看到的就是「内容不完整」。
 * 因此：意图一确认（open-left / open-right）就**立刻提交开合状态**，让上游挂载完整内容，
 * 之后才由预览层把**完整**抽屉按在手指位置；松手按 progress 决定保留还是回退
 * （回退走真正的收起动作 closeLeft / closeRight，**不能**拿 returnToConversation 顶替 ——
 * 它会顺带 selectPanel(null) 把用户选中的中栏面板一起清掉）。
 * 关闭方向（return / close-right）初始就是展开态、内容本来就已挂载，不需要提前提交，
 * 但同样受本文件的复位纪律约束。
 *
 * 拖动期间在 <html> 上打 DRAWER_DRAGGING_ATTR：消费方样式表据此关掉 200ms 过渡，
 * 否则每一次 touchmove 的位移都被过渡拖成慢半拍。所以**每一个**出口（松手 / 取消 /
 * 多指打断 / 判定失效 / detach）都必须撤掉它，漏一条就会让抽屉停在半开处或永久失去
 * 过渡动画；复位统一走 endDrag()。
 *
 * 顺序纪律：**先提交 / 先回退开合状态，再撤预览**。反了就会先弹回起点再重放一次动画
 * （listener 侧 endPreview 把内联位移清空的瞬间，CSS 只能向"当前已提交的状态"收敛）。
 */

export type SidebarGestureSide = 'left' | 'right'

export const LEFT_SWIPE_KEY = 'dsh.android.sidebarSwipe.left'
export const RIGHT_SWIPE_KEY = 'dsh.android.sidebarSwipe.right'
/** 拖动中打在 <html> 上的标记：消费方样式表据此关掉抽屉过渡，让位移真正跟手。 */
export const DRAWER_DRAGGING_ATTR = 'data-dsh-drawer-dragging'
const SWIPE_PX = 64
/**
 * 横向判定：|dx| 必须**大于**纵向位移。纵向手势天然满足 |dy| > |dx|，所以不会被劫持。
 *
 * 曾是 1.5，那是「时不时拖了但完全没反应」的主因：真机（V2425A / 360 CSS px）手指走不直，
 * 横拖 100px 同时纵向漂移 70px 时 100 <= 70*1.5=105，整条手势被直接丢弃。降到 1.0 后只要求
 * 横向分量更大，斜向拖动不再丢。
 */
const HORIZONTAL_RATIO = 1.0
/** 确认「这次是横向手势」的最小位移，也是跟手预览的起振阈值（12 -> 8：真机嫌前 12px 是死区）。 */
const START_SLOP_PX = 8
/** 甩动通道的最小位移：短而快的甩动也要能开合（旧口径只认 SWIPE_PX=64 的距离）。 */
const FLING_MIN_PX = 24
/**
 * 甩动速度阈值（px/ms）。0.5 = 500 px/s：真机快速滑动的量级远高于它，慢速长拖则远低于它。
 */
const FLING_VELOCITY_PX_PER_MS = 0.5
/**
 * 抬手距最后一次采样的时间上限（ms）。超过它说明手指在松手前已经停住 —— 停住后不再产生
 * touchmove，最后两条采样记录的是"停下来之前"的运动，必须按速度 0 处理，否则「慢慢拖一段、
 * 停住、再松手」会被误判成甩动。
 */
const FLING_MAX_GAP_MS = 100
/**
 * 有效行程上限（相对面板自身宽度）：横向开合最多只需要拖出一个面板的宽度，超过这么多
 * 就不可能是「想把抽屉拖开/收起」的意图。留四分之一容差吸收 overshoot 与用户拖过头。
 *
 * 真因：只排除起点（SYSTEM_EDGE_EXCLUSION_PX）挡不住「起点在内容区、松手落在侧栏上」的
 * 轻点 —— |dx| 会远超 SWIPE_PX，一次点击被当成滑动，侧栏先反向跟手一段再收回（看起来像
 * 点一下就乱抖）。这个上限按面板几何判定，与屏幕宽无关（屏宽不能表达手势意图）。
 */
const MAX_TRAVEL_RATIO = 1.25
/** Keep the narrow outer strip available to Android's immersive back gestures. */
const SYSTEM_EDGE_EXCLUSION_PX = 32
/** 左抽屉（mobile-form.css.ts 的 off-canvas 抽屉）与右栏（fullscreen 覆盖层）的选择器。 */
const DRAWER_SELECTOR = '[data-dsh-frame] > [class*="sidebarCol"]'
const RIGHT_PANEL_SELECTOR = '[data-sidebar-right-panel="fullscreen"]'
/**
 * 右栏的滑动参照系：上游把位移写成 `transform: translateX(var(--dsh-sidebar-width))`
 * （ui-sidebar-right 的 dockkit 子元素），fullscreen 时该变量是 100vw。跟手进度必须按这个
 * 长度换算，不能拿右栏本体的盒子宽度当分母 —— 本体是 position:absolute 的收缩盒，其宽度
 * 与 100vw 无关，会让人以为右栏"该跟 300px 却只跟了 40px"。
 */
const SIDEBAR_WIDTH_VAR = '--dsh-sidebar-width'
/** 抽屉 CSS 宽度是 min(288px, 82vw)：量不到元素时按视口比例回落，不硬编码 288。 */
const DRAWER_VIEWPORT_RATIO = 0.82
/** 软键盘高度所在的根变量（composer-insets / keyboard-boundary 同一来源）。 */
const IME_INSET_VAR = '--dsh-android-ime-bottom'
/**
 * 长按拖动重排的进行中标记（sidebar-reorder.ts 打/撤）。
 *
 * 两处都要判：touchstart 判是为了不认领**在重排拖动开始之后**落下的触点；touchmove 判是
 * 因为长按要等 400ms 才激活，而本模块可能在激活前就已认领同一次触摸 —— 那时只有中途放弃
 * 才能保证「重排拖动期间抽屉绝不开合」。
 */
const REORDER_ATTR = 'data-dsh-sidebar-reorder'
/** 预先标记真正横向溢出的滚动容器，供常驻 CSS 保留其原生横向平移。 */
const HORIZONTAL_SCROLL_ATTR = 'data-dsh-horizontal-scroll'
// A floating pane owns its own move/resize gestures. Letting the drawer arbiter claim a
// horizontal press on its header closed the whole right column while the float moved.
const INTERACTIVE = 'input, textarea, select, button, label, a, summary, [contenteditable="true"], [role="button"], [role="tab"], [role="menu"], [role="menuitem"], [role="textbox"], [role="searchbox"], [role="combobox"], [aria-haspopup], [data-trigger-menu], [data-dockkit-float]'

export interface SidebarGestureActions {
  mobileForm(): boolean
  leftOpen(): boolean
  rightOpen(): boolean
  mainPanelSelected(): boolean
  openLeft(): void
  /**
   * 真正的「收起左抽屉」动作，只用于回退早期提交（open-left 提前打开了、松手又不该开）。
   *
   * **不要拿 returnToConversation 顶替**：它还会 selectPanel(null)，会把用户当前选中的
   * 中栏面板一起清掉，语义不同。装配方不提供这个回调时本模块**不提前提交** open-left，
   * 退化成旧的「松手才开」行为（宁可不跟手，也不能开着一个收不回去的抽屉）。
   */
  closeLeft?(): void
  returnToConversation(): void
  openRight(): void
  closeRight(): void
  /**
   * 拖动中实时上报左抽屉的展开度（0..1，1 = 完全展开），每次 touchmove 一次。
   * 开（open-left）时 progress 随手指增长，关（return）时随手指回落；
   * 消费方把它换算成位移并临时关掉过渡即可。
   */
  previewLeft?(progress: number): void
  /** 右栏的实时展开度，口径同 previewLeft。 */
  previewRight?(progress: number): void
  /**
   * 拖动结束（松手 / 取消 / 多指打断 / 判定失效 / detach）时调用，**无论最终是否开合**，
   * 且必须在同一帧内恢复过渡并清掉临时位移 —— 松手后由 CSS transition 从当前跟手位置
   * 平滑收敛到最终态，否则会出现「先弹回 0 再展开」的跳动。
   */
  endPreview?(): void
}

type GestureAction = 'open-left' | 'return' | 'open-right' | 'close-right'
interface StartPoint {
  id: number
  x: number
  y: number
  /** 本次手势当前跟随的动作；**一旦定下就锁定**（见 onTouchMove 的说明）。 */
  action: GestureAction | null
  /** 该动作的基准长度（见 panelWidth），除零保护在 progressFor。 */
  width: number
  /**
   * 最近两次位移采样（第一条是 touchstart 的位置），最多保留两条。
   *
   * 甩动速度取**最后两条采样之间**的瞬时速度，不能拿「最后一次采样 → 抬手位置」来算：
   * touchend 的 clientX 在真实内核里通常与最后一次 touchmove 完全相同（手指在两次事件之间
   * 并没有移动），那样算出来的位移恒为 0，甩动通道永远不会命中。同理也不能用整段手势的
   * 平均速度 —— 慢拖一大段再停住松手会被平均成一个不小的值，反而误判成甩动。
   */
  samples: { x: number; t: number }[]
}

function findTouch(touches: TouchList, id: number): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index]
    if (touch?.identifier === id) return touch
  }
  return undefined
}

/** Whether a given side's swipe setting is enabled (missing storage defaults on). */
export function sidebarSwipeEnabled(side: SidebarGestureSide): boolean {
  try {
    return localStorage.getItem(side === 'left' ? LEFT_SWIPE_KEY : RIGHT_SWIPE_KEY) !== '0'
  } catch {
    return true
  }
}

/** Persist one side independently; false means browser storage rejected the write. */
export function setSidebarSwipeEnabled(side: SidebarGestureSide, enabled: boolean): boolean {
  try {
    localStorage.setItem(side === 'left' ? LEFT_SWIPE_KEY : RIGHT_SWIPE_KEY, enabled ? '1' : '0')
    return true
  } catch {
    return false
  }
}

function editableOrInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  if (target.closest(INTERACTIVE) !== null) return true
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed
}

function horizontalScroller(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) continue
    const overflowX = getComputedStyle(node).overflowX
    if ((overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay')
      && node.scrollWidth > node.clientWidth + 2) return true
  }
  return false
}

/** 壳侧推送的软键盘高度；>0 即键盘展开（变量缺失/主机不支持时为 0，绝不误判成展开）。 */
function imeInsetPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(IME_INSET_VAR)
  return Number.parseFloat(raw) || 0
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** 把 CSS 长度（px / vw）换算成 px；认不出的写法返回 0，交给调用方回落。 */
function resolveLength(value: string, viewport: number): number {
  if (value === '') return 0
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount)) return 0
  if (value.endsWith('px')) return amount
  if (value.endsWith('vw')) return (viewport * amount) / 100
  return 0
}

/**
 * 手指位移换算成该面板当前应有的展开度。
 *
 * 口径统一为「1 = 完全展开」。使用**带符号**位移而不是 |dx|：手指越过起点反向移动时
 * 进度随之回落，预览不会"反着跟手"（旧实现用 Math.abs，回退段仍在增大）。
 * - open-left 沿 +x 展开、open-right 沿 -x 展开：位移除以面板宽就是新增展开量；
 * - return（收左抽屉）沿 -x 收起、close-right（收右栏）沿 +x 收起：位移是**已收起**的量，
 *   1 - 该量才是展开度。
 * 方向由 resolveAction 在定动作时保证，因此正常手势下与旧口径数值完全一致。
 */
function progressFor(action: GestureAction, dx: number, width: number): number {
  if (!(width > 0)) return 0
  const travelled = clamp01((action === 'open-left' || action === 'close-right' ? dx : -dx) / width)
  return action === 'open-left' || action === 'open-right' ? travelled : 1 - travelled
}

/** Attach one shared touch arbiter; callbacks always read current upstream state. */
export class MobileSidebarGestures {
  private readonly actions: SidebarGestureActions
  private start: StartPoint | null = null
  /** 已进入跟手拖动：DRAWER_DRAGGING_ATTR 与预览回调的生命周期标志。 */
  private dragging = false
  /**
   * 本次手势**提前提交**的展开状态（open-left / open-right）。非 null 表示上游已经按展开态
   * 渲染了完整内容，松手若不成立就必须原路回退（见 rollback）。
   */
  private opened: GestureAction | null = null
  private suppressClickTimer: number | null = null
  private readonly horizontalScrollers = new Set<HTMLElement>()
  private readonly pendingSurfaceNodes = new Set<HTMLElement>()
  private surfaceObserver: MutationObserver | null = null
  private surfaceRefreshQueued = false
  private surfaceRefreshFull = false
  private attached = false

  constructor(actions: SidebarGestureActions) { this.actions = actions }

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.refreshSurfaces()
    this.surfaceObserver = new MutationObserver(records => {
      // Collect candidates only. Dimension and computed-style reads happen later,
      // after the gesture, and only for the changed subtree/element.
      let changed = false
      for (const record of records) {
        if (record.type === 'childList') {
          if (!(record.target instanceof Element) || record.target.closest('[data-dsh-frame]') === null) continue
          for (const node of record.removedNodes) this.forgetSurfaceSubtree(node)
          for (const node of record.addedNodes) changed = this.queueSurfaceSubtree(node) || changed
          continue
        }
        if (!(record.target instanceof HTMLElement) || record.target.closest('[data-dsh-frame]') === null) continue
        if (record.attributeName === 'class') {
          if (!this.pendingSurfaceNodes.has(record.target)) {
            changed = this.queueSurfaceSubtree(record.target) || changed
          }
        } else if (record.attributeName === 'style'
          && this.layoutStyle(record.oldValue ?? '') !== this.layoutStyle(record.target.getAttribute('style') ?? '')) {
          changed = this.queueSurfaceSubtree(record.target) || changed
        }
      }
      if (changed && this.start === null) this.queueSurfaceRefresh(false)
    })
    this.surfaceObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', this.queueFullSurfaceRefresh)
    document.addEventListener('load', this.queueFullSurfaceRefresh, true)
    document.addEventListener('touchstart', this.onTouchStart, true)
    // Chrome marks document-level touchmove passive by default. Explicitly
    // opt out so a recognized horizontal gesture can stop native panning;
    // vertical moves are never prevented.
    document.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false })
    document.addEventListener('touchend', this.onTouchEnd, true)
    document.addEventListener('touchcancel', this.onTouchCancel, true)
    document.addEventListener('click', this.onClick, true)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.surfaceObserver?.disconnect()
    this.surfaceObserver = null
    this.pendingSurfaceNodes.clear()
    window.removeEventListener('resize', this.queueFullSurfaceRefresh)
    document.removeEventListener('load', this.queueFullSurfaceRefresh, true)
    for (const node of this.horizontalScrollers) node.removeAttribute(HORIZONTAL_SCROLL_ATTR)
    this.horizontalScrollers.clear()
    document.removeEventListener('touchstart', this.onTouchStart, true)
    document.removeEventListener('touchmove', this.onTouchMove, true)
    document.removeEventListener('touchend', this.onTouchEnd, true)
    document.removeEventListener('touchcancel', this.onTouchCancel, true)
    document.removeEventListener('click', this.onClick, true)
    this.abandon()
    if (this.suppressClickTimer !== null) window.clearTimeout(this.suppressClickTimer)
    this.suppressClickTimer = null
    this.suppressClick = false
    this.start = null
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    // 任何新触点先终结上一条拖动：多指加入不能留下半个开着的抽屉，也不能让
    // DRAWER_DRAGGING_ATTR 跨手势残留（残留的代价是抽屉永久失去过渡动画）。
    this.abandon()
    this.start = null
    if (!this.actions.mobileForm() || event.touches.length !== 1
      || editableOrInteractive(event.target) || horizontalScroller(event.target)
      || (event.target instanceof Element && event.target.closest('[data-dsh-bubble-nav]') !== null)
      // 互斥：sidebar-reorder 正在做长按拖动重排时不认领本次手势，重排拖动期间抽屉绝不能开合。
      || document.documentElement.hasAttribute(REORDER_ATTR)
      || document.querySelector('[role="dialog"][aria-modal="true"]:not([data-dsh-settings-dialog])') !== null) return

    const width = document.documentElement.clientWidth || window.innerWidth
    const touch = event.touches[0]
    if (touch === null || width <= 0 || touch.clientX <= SYSTEM_EDGE_EXCLUSION_PX
      || touch.clientX >= width - SYSTEM_EDGE_EXCLUSION_PX) return

    // 键盘区域绝不算应用 UI：Android 输入法是独立窗口，正常情况下它的触摸根本进不了
    // WebView，但部分 ROM 会把键盘区触摸透传进来。键盘展开时以可视视口底边为界，
    // 界下的触点一律不认领（键盘没开时不做这个判断，避免被过期视口数据误伤）。
    if (imeInsetPx() > 0) {
      const viewport = window.visualViewport ?? null
      if (viewport !== null && touch.clientY > viewport.height + viewport.offsetTop) return
    }

    // Start anywhere in the phone content. The action is resolved only after a
    // deliberate horizontal movement, using the current open-panel state.
    this.start = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      action: null,
      width: 0,
      samples: [{ x: touch.clientX, t: event.timeStamp }],
    }
  }

  private readonly onTouchMove = (event: TouchEvent): void => {
    const start = this.start
    if (start === null) return
    // 互斥（中途）：touchstart 时可能还没有人拖动，但长按在 400ms 后才激活 —— 本次手势
    // 若已被本模块认领（例如已在跟手拖动），重排一旦激活就必须立刻放弃，否则会一边重排
    // 一边开合抽屉。同时回退已提前提交的展开并撤掉跟手预览，避免抽屉停在半开处。
    if (document.documentElement.hasAttribute(REORDER_ATTR)) {
      this.abandon()
      this.start = null
      return
    }
    if (event.touches.length !== 1) {
      this.abandon()
      this.start = null
      return
    }
    const touch = findTouch(event.touches, start.id)
    if (touch === undefined) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    // 速度采样：每条 touchmove 都记，且在任何门禁之前 —— 甩动常常在刚过死区那一刻就抬手，
    // 若只记"已确认横向"之后的样本，短甩会因为采样太少而算不出速度。
    start.samples.push({ x: touch.clientX, t: event.timeStamp })
    if (start.samples.length > 2) start.samples.shift()
    if (window.getSelection() !== null && !window.getSelection()!.isCollapsed) {
      this.abandon()
      this.start = null
      return
    }
    if (Math.abs(dx) < START_SLOP_PX || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_RATIO) {
      // 已经跟手拖动过、但这次位移不再像横向手势（中途转成纵向滚动）：立刻回退复位。
      // 不复位的话抽屉会停在半开处，而原生滚动已经在动了。
      if (Math.abs(dy) >= START_SLOP_PX && Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_RATIO) {
        this.abandon()
        this.start = null
      } else if (this.dragging) {
        this.abandon()
        start.action = null
      }
      return
    }
    const action = start.action ?? this.resolveAction(dx)
    if (action === null) {
      // 当前方向没有对应动作（例如该侧开关已关）：不拦原生滚动，也不留半开预览。
      this.abandon()
      start.action = null
      return
    }
    if (start.action !== action) {
      // 动作只在这里定一次，之后**锁定**：resolveAction 依赖上游实时开合状态，而本模块在
      // touchmove 里就会提前提交展开状态 —— 若不锁定，提交后的下一次移动就会把同一次手势
      // 重判成 'return'（"已在展开中 → 只认收起方向"），于是自己把刚提交的展开又收回去。
      // 基准长度也只算一次 —— panelWidth 会读 getComputedStyle，逐帧调用等于每次 touchmove
      // 强制一次样式重算，拖动帧率会被它拖垮。
      start.action = action
      start.width = this.panelWidth(action)
      // 超出行程上限：这不是横向开合的意图（典型是"起点在内容区、松手落在已展开的侧栏上"
      // 的轻点），整条手势作废 —— 既不 preview 也不提交动作，避免点一下抽屉乱抖。
      // 只在动作确定并算好基准长度后比较，因此不会误伤还没判断出方向的早期位移。
      if (this.overTravel(start.width, dx)) {
        this.abandon()
        start.action = null
        return
      }
    }
    // 只有确认横向手势后才 preventDefault：拦掉原生平移/滚动，顺带避免这次触摸序列
    // 被当作点击（输入框焦点与软键盘都由此保持不动）。
    //
    // CSS 已预先限制横向原生平移；cancelable 不是意图判据。只有纯横向路径继续跟手，
    // 纵向已在上方退出，因此不会通过放行不可取消事件重新接管原生纵向滚动。
    if (event.cancelable) event.preventDefault()
    // 先关过渡，再提交开合状态、最后写位移：上游只按 frame 的 data-sidebar-collapsed
    // 渲染抽屉内容，不先提交的话预览层平移的是一根没有内容的收起导轨（真机 58 元素 /
    // 11232B，收起态只有 6 个按钮），用户看到的就是"拖到一半内容不完整"；提交后上游挂载
    // 完整抽屉（202 元素 / 40035B，19 个按钮），再把它按在手指位置滑进来。
    // 右栏同理：状态隐藏时 dockkit 的 renderTab 根本不执行（真机收起态右栏只有 31 元素 /
    // 3307B），必须先提交展开才能拖动到完整内容。
    this.beginDrag()
    this.ensureOpen(action)
    const progress = progressFor(action, dx, start.width)
    if (action === 'open-left' || action === 'return') this.actions.previewLeft?.(progress)
    else this.actions.previewRight?.(progress)
  }

  private readonly onTouchEnd = (event: TouchEvent): void => {
    const start = this.start
    this.start = null
    if (this.pendingSurfaceNodes.size > 0) this.queueSurfaceRefresh(false)
    // 以下每条提前返回都走 abandon()：它先回退提前提交的展开、再撤跟手预览（endDrag 是
    // 预览的唯一复位出口）。漏掉回退就会留下一个自己打开的抽屉，漏掉预览就会停在半开处。
    // Do not interpret one finger lifting as a completed swipe while another
    // finger is still down (for example, after a pinch/zoom sequence).
    if (start === null || event.touches.length !== 0) {
      this.abandon()
      return
    }
    const touch = findTouch(event.changedTouches, start.id)
    if (touch === undefined) {
      this.abandon()
      return
    }
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    const action = start.action
    if (action === null) {
      // 没确认过动作 = 没提前提交过任何状态；仍要撤掉可能存在的预览。
      this.abandon()
      return
    }
    // 甩动通道：短促快速的一甩也要成立，不能只认 SWIPE_PX 的距离。
    //
    // 真因（真机「打开和关闭灵敏度都略低」）：松手结算原先只有「位移过半」一把尺子，
    // 而 progress 的分母是面板自身宽度 —— 左抽屉 288px 要拖满 144px、右栏 100vw=360px
    // 要拖满 180px 才提交。用户快速甩一下只有几十像素，视觉上抽屉已经明显跟出来了、
    // 松手却弹回去，体感就是"不跟手"。
    //
    // 判定用**抬手前那一瞬**的速度（start.last，在 touchmove 里采样）：慢拖一大段再停住
    // 时速度接近 0，不会误判成甩动；只有真正快速松手才命中。
    const fling = this.flingVelocity(start, event.timeStamp)
    const flung = fling >= FLING_VELOCITY_PX_PER_MS && Math.abs(dx) >= FLING_MIN_PX
    // 距离闸门对甩动放行，其余仍要求 SWIPE_PX：斜向手势只看横向分量（1.0 倍）。
    if (Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_RATIO || (!flung && Math.abs(dx) < SWIPE_PX)) {
      this.abandon()
      return
    }
    // 方向与动作不符（手指最后反向越过了起点）：回退，不提交。
    if (action === 'open-left' || action === 'close-right' ? dx < 0 : dx > 0) {
      this.abandon()
      return
    }
    // 与 touchmove 同一条上限：整条手势超出行程上限时，连松手提交也不做。少了这条，
    // 「起点在内容区、松手落在侧栏上」的轻点仍会在松手瞬间切换开合。基准长度优先用
    // 跟手阶段缓存的那一份（同一次手势同一个动作），没有缓存才现算。
    if (this.overTravel(start.width > 0 ? start.width : this.panelWidth(action), dx)) {
      this.abandon()
      return
    }
    // 纯横向序列不以 cancelable 决定是否结算；已进入原生纵向滚动的序列早已退出。
    // preventDefault 只在可取消时调用。
    if (event.cancelable) {
      event.preventDefault()
      // 只有真正拦截过这次触摸序列才吞掉随后的兼容 click：不可取消的序列没有 preventDefault，
      // 它的 click 是浏览器正常发出的，吞掉会让「点哪都没反应」。
      this.suppressClick = true
      if (this.suppressClickTimer !== null) window.clearTimeout(this.suppressClickTimer)
      this.suppressClickTimer = window.setTimeout(() => {
        this.suppressClick = false
        this.suppressClickTimer = null
      }, 450)
    }
    // 键盘还开着时展开侧边栏：先收键盘。抽屉与右栏都占着键盘上方的半屏，键盘不退
    // 会被输入法压住，且输入法会继续抢焦点（0.14.7 §2.1）。收起方向不需要处理。
    if (action === 'open-left' || action === 'open-right') this.dismissSoftKeyboard()
    // 两条结算通道，满足其一即成立：
    // - 位移通道（原有、保持不变）：拖过面板一半 —— 与「跟手进度」同一把尺子，用户看到多少
    //   就得到多少。慢速长拖的口径不受本轮改动影响，不回归。
    // - 甩动通道（新增）：速度够快且走了 FLING_MIN_PX，未达一半也提交 —— 这正是真机嫌
    //   「要拖很久才动」的那一段。
    // 都不成立（未达 SWIPE_PX、回退、拖过头）一律回退到起始态。
    const progress = progressFor(action, dx, start.width)
    const distanceSettled = action === 'open-left' || action === 'open-right' ? progress >= 0.5 : progress <= 0.5
    if (flung || distanceSettled) this.commit(action)
    else this.abandon()
    // 先提交开合状态、再撤跟手预览：消费方清掉内联位移与拖动标记时，CSS 是**从手指位置**
    // 平滑收敛到最终态。顺序反了（先撤预览再改状态）会先弹回起点、再重放一次展开动画，
    // 正是用户报告的「松手才动、动画突兀」。
    this.endDrag()
  }

  private readonly onTouchCancel = (): void => {
    // 手势被系统取消：回退提前提交的展开并撤预览，抽屉绝不能停在半开处或自己开着。
    this.abandon()
    this.start = null
    if (this.pendingSurfaceNodes.size > 0) this.queueSurfaceRefresh(false)
  }

  private readonly queueSurfaceRefresh = (full = true): void => {
    this.surfaceRefreshFull ||= full
    if (this.surfaceRefreshQueued) return
    this.surfaceRefreshQueued = true
    // Let the release paint first. While a gesture remains active, retain the
    // dirty targets and retry after its end instead of scanning on touchmove.
    window.setTimeout(() => {
      this.surfaceRefreshQueued = false
      if (!this.attached) return
      if (this.start !== null) {
        this.queueSurfaceRefresh(false)
        return
      }
      const full = this.surfaceRefreshFull
      this.surfaceRefreshFull = false
      if (full) this.refreshSurfaces()
      else this.refreshSurfaceNodes()
    }, 50)
  }

  private readonly queueFullSurfaceRefresh = (): void => { this.queueSurfaceRefresh() }

  private layoutStyle(style: string): string {
    const layoutProperties = /^(?:--|overflow(?:-x)?$|width$|height$|min-width$|max-width$|min-height$|max-height$|display$|box-sizing$|padding(?:-.+)?$|border(?:-.+)?$|font(?:-.+)?$|line-height$|white-space$|flex(?:-.+)?$|grid(?:-.+)?$)/i
    return style.split(';').map(part => part.trim()).filter(part => layoutProperties.test(part.slice(0, part.indexOf(':')).trim()))
      .map(part => part.replace(/\s+/g, '').toLowerCase()).sort().join(';')
  }

  private queueSurfaceSubtree(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false
    let changed = false
    if (node.matches('[data-dsh-frame], [data-dsh-frame] *')) {
      this.pendingSurfaceNodes.add(node)
      changed = true
    }
    for (const child of node.querySelectorAll<HTMLElement>('[data-dsh-frame], [data-dsh-frame] *')) {
      this.pendingSurfaceNodes.add(child)
      changed = true
    }
    return changed
  }

  private forgetSurfaceSubtree(node: Node): void {
    if (!(node instanceof HTMLElement)) return
    for (const element of [node, ...node.querySelectorAll<HTMLElement>('*')]) {
      this.pendingSurfaceNodes.delete(element)
      if (this.horizontalScrollers.delete(element)) element.removeAttribute(HORIZONTAL_SCROLL_ATTR)
    }
  }

  private refreshSurfaceNodes(): void {
    const nodes = [...this.pendingSurfaceNodes]
    this.pendingSurfaceNodes.clear()
    for (const node of nodes) {
      if (!node.isConnected || node.closest('[data-dsh-frame]') === null) continue
      // Read overflow first: most descendants cannot scroll horizontally. Their
      // scrollWidth/clientWidth would force layout during the release animation.
      const scrollable = ['auto', 'scroll', 'overlay'].includes(getComputedStyle(node).overflowX)
        && node.scrollWidth > node.clientWidth + 2
      if (scrollable) {
        this.horizontalScrollers.add(node)
        node.setAttribute(HORIZONTAL_SCROLL_ATTR, '')
      } else {
        this.horizontalScrollers.delete(node)
        node.removeAttribute(HORIZONTAL_SCROLL_ATTR)
      }
    }
  }

  /** 在触点按下前扫描，不能在 touchstart 写 touch-action 后声称已影响当前序列。 */
  private refreshSurfaces(): void {
    const next = new Set<HTMLElement>()
    for (const node of document.querySelectorAll<HTMLElement>('[data-dsh-frame], [data-dsh-frame] *')) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX !== 'auto' && overflowX !== 'scroll' && overflowX !== 'overlay') continue
      if (node.scrollWidth > node.clientWidth + 2) next.add(node)
    }
    for (const node of this.horizontalScrollers) {
      if (!next.has(node)) node.removeAttribute(HORIZONTAL_SCROLL_ATTR)
    }
    for (const node of next) {
      if (!this.horizontalScrollers.has(node)) node.setAttribute(HORIZONTAL_SCROLL_ATTR, '')
    }
    this.horizontalScrollers.clear()
    for (const node of next) this.horizontalScrollers.add(node)
  }

  /** Resolve direction after the swipe threshold; open sidebars consume only their closing direction. */
  private resolveAction(dx: number): GestureAction | null {
    const leftEnabled = sidebarSwipeEnabled('left')
    const rightEnabled = sidebarSwipeEnabled('right')
    if (this.actions.rightOpen()) return dx > 0 && rightEnabled ? 'close-right' : null
    if (this.actions.leftOpen()) return dx < 0 && leftEnabled ? 'return' : null
    if (dx < 0 && this.actions.mainPanelSelected() && leftEnabled) return 'return'
    if (dx > 0 && leftEnabled) return 'open-left'
    if (dx < 0 && rightEnabled) return 'open-right'
    return null
  }

  /**
   * 提前提交展开状态，让上游立刻挂载**完整**抽屉 / 右栏内容 —— 真机实测证明这是内容的唯一
   * 来源（见文件头 0.14.7 修复说明）。只在动作第一次确认时调用一次，幂等。
   *
   * 左抽屉缺 closeLeft 回调时**不提前提交**：上游只提供"切换"语义，没有可逆的收起动作就
   * 无法安全回退，宁可不跟手也不能留下一个关不掉的抽屉（装配方见 index.ts）。
   * 别人已经打开的面板（rightOpen / leftOpen 为真）一律不碰，本模块只提交自己发起的那一个。
   */
  private ensureOpen(action: GestureAction): void {
    if (this.opened !== null) return
    if (action === 'open-left') {
      if (typeof this.actions.closeLeft !== 'function') return
      if (this.actions.leftOpen() || this.actions.rightOpen()) return
      this.actions.openLeft()
      this.opened = action
      return
    }
    if (action === 'open-right') {
      if (this.actions.rightOpen() || this.actions.leftOpen()) return
      this.actions.openRight()
      this.opened = action
    }
  }

  /** 松手成立时的最终提交。已经提前提交过的展开动作无需重复调用（幂等，免一次多余重渲染）。 */
  private commit(action: GestureAction): void {
    const opened = this.opened
    this.opened = null
    if (action === 'open-left') {
      if (opened !== 'open-left' && !this.actions.leftOpen() && !this.actions.rightOpen()) {
        this.actions.openLeft()
      }
    } else if (action === 'return') {
      if (this.actions.leftOpen() || this.actions.mainPanelSelected()) this.actions.returnToConversation()
    } else if (action === 'open-right') {
      if (opened !== 'open-right' && !this.actions.rightOpen() && !this.actions.leftOpen()) {
        this.actions.openRight()
      }
    } else if (this.actions.rightOpen()) {
      this.actions.closeRight()
    }
  }

  /**
   * 把本次手势提前提交的展开状态原路收回。**不碰别人打开的面板**：只回退 this.opened。
   *
   * 顺序必须是「先回退状态、后撤预览」（由 abandon 保证）：反过来的话内联位移一清，CSS
   * 立刻向"当前仍处于展开"的状态收敛，用户会看到抽屉先滑出去、再收回来。
   */
  private rollback(): void {
    const opened = this.opened
    this.opened = null
    if (opened === null) return
    if (opened === 'open-left') {
      if (this.actions.leftOpen()) this.actions.closeLeft?.()
      return
    }
    if (this.actions.rightOpen()) this.actions.closeRight()
  }

  /**
   * 放弃本次手势的唯一出口：先回退提前提交的展开，再撤跟手预览。
   * 顺序反了会先弹回起点再收敛；漏了回退会留下一个自己打开的抽屉。
   */
  private abandon(): void {
    this.rollback()
    this.endDrag()
  }

  /**
   * 抬手前的瞬时速度（px/ms）：由**最后两条采样**算得，即"松手时还在不在动"。
   *
   * 三道守卫，缺一条就会误判：
   * - 采样不足两条（本次手势没有 touchmove）：返回 0，宁可不开也不能凭空造速度；
   * - 抬手距最后一次采样超过 FLING_MAX_GAP_MS：手指其实已经停住（停住后不再产生 touchmove），
   *   此时最后两条采样仍是"停之前"的运动，必须按 0 处理，否则「慢拖后停住再松手」会被当成甩动；
   * - 两次采样时间差非正：时钟不可信，同样不认。
   */
  private flingVelocity(start: StartPoint, endTimestamp: number): number {
    if (start.samples.length < 2) return 0
    const last = start.samples[start.samples.length - 1]!
    const previous = start.samples[start.samples.length - 2]!
    if (!(endTimestamp - last.t <= FLING_MAX_GAP_MS)) return 0
    const elapsed = last.t - previous.t
    if (!(elapsed > 0)) return 0
    return Math.abs(last.x - previous.x) / elapsed
  }

  /** 位移是否已超出一个面板宽度所能表达的意图（见 MAX_TRAVEL_RATIO）。width 由调用方缓存。 */
  private overTravel(width: number, dx: number): boolean {
    return width > 0 && Math.abs(dx) > width * MAX_TRAVEL_RATIO
  }

  /**
   * 面板基准长度：必须与 CSS 实际使用的位移参照系一致，否则跟手比例系统性偏大/偏小。
   * - 左抽屉：mobile-form.css.ts 用 `translateX(-100%)`，百分比参照**自身** border-box
   *   宽度 → 取实测宽度（量不到才按 82vw 回落，不硬编码 288）。
   * - 右栏：上游用 `translateX(var(--dsh-sidebar-width))`，fullscreen 时是 100vw →
   *   参照系是视口宽度。直接解析该变量（与浏览器解析同源），本体实测宽度只作兜底。
   */
  private panelWidth(action: GestureAction): number {
    const viewport = document.documentElement.clientWidth || window.innerWidth || 0
    if (action === 'open-left' || action === 'return') {
      const drawer = document.querySelector<HTMLElement>(DRAWER_SELECTOR)
      const measured = drawer?.getBoundingClientRect().width ?? 0
      return measured > 0 ? measured : viewport * DRAWER_VIEWPORT_RATIO
    }
    const panel = document.querySelector<HTMLElement>(RIGHT_PANEL_SELECTOR)
    const declared = panel === null
      ? ''
      : getComputedStyle(panel).getPropertyValue(SIDEBAR_WIDTH_VAR).trim()
    const declaredPx = resolveLength(declared, viewport)
    if (declaredPx > 0) return declaredPx
    const measured = panel?.getBoundingClientRect().width ?? 0
    return measured > 0 ? measured : viewport
  }

  /** 进入跟手拖动：打开预览并临时关掉抽屉过渡（否则每次位移都被 200ms 过渡拖住）。 */
  private beginDrag(): void {
    if (this.dragging) return
    this.dragging = true
    document.documentElement.setAttribute(DRAWER_DRAGGING_ATTR, '')
  }

  /**
   * 结束跟手拖动：撤标记并让消费方复位临时位移。
   * 这是唯一的预览复位出口，所有中断路径都必须经过它（经 abandon）。
   */
  private endDrag(): void {
    if (!this.dragging) return
    this.dragging = false
    // Clear inline preview while transitions are still disabled, then hand the
    // final committed state back to CSS in the same task. This avoids exposing
    // an intermediate style where the drag marker is gone but the preview is not.
    this.actions.endPreview?.()
    document.documentElement.removeAttribute(DRAWER_DRAGGING_ATTR)
  }

  /**
   * 收起软键盘（只在真正展开侧边栏时调用）。
   *
   * 判据是 activeElement 可编辑：软键盘必然由它拉起，不依赖壳侧 IME 变量是否已推送；
   * IME inset > 0 时再兜底 blur 一次，覆盖「焦点已离开输入框、键盘还没收」的残余态。
   * 壳侧 InputMethodManager 通路要新增桥方法，这里先用 WebView 标准手段，不碰 Kotlin。
   */
  private dismissSoftKeyboard(): void {
    const active = document.activeElement
    const editable = active instanceof HTMLElement
      && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    if (!editable && imeInsetPx() === 0) return
    if (active instanceof HTMLElement) active.blur()
  }

  private suppressClick = false
  private readonly onClick = (event: MouseEvent): void => {
    // Suppress only the compatibility click generated by the just-completed
    // touch sequence. detail=0 remains available to keyboard/screen-reader users.
    if (!this.suppressClick || event.detail === 0) return
    this.suppressClick = false
    if (this.suppressClickTimer !== null) window.clearTimeout(this.suppressClickTimer)
    this.suppressClickTimer = null
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}
