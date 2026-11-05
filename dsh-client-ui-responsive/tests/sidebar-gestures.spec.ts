// @vitest-environment jsdom
// 0.14.7 §2.1 侧边栏实时跟手：确认横向手势后，位移必须随 touchmove 实时上报（不再松手才动），
// 拖动期间关掉过渡由 DRAWER_DRAGGING_ATTR 表达，且所有中断路径都必须复位；键盘区域不认领、
// 展开侧边栏时收起键盘。原有方向/开关/边缘排除语义在这里保持不动。
//
// 0.14.7 修复（task-7，真机 CDP 实测）「半拖只显示内容的一部分」：
// 上游**只按 frame 的 data-sidebar-collapsed 渲染抽屉内容** —— 收起态是 58 元素 / 6 按钮的
// 收起导轨（真机 innerHTML 11232B），展开态才是 202 元素 / 19 按钮的完整抽屉（40035B）。
// 本文件原先只断言 transform / progress 字符串，恰好漏掉了这一点：拖动期间开合状态不提交，
// 预览层平移的就是那根**没有内容的导轨**，单测全绿而屏幕上是残缺内容。
// 因此下面所有跟手用例都按**内容形态**断言：真机事实固化为 RAIL_SHAPE / FULL_SHAPE，
// harness 的抽屉内容按 frame 的 collapsed 属性重建（与上游同一判据），拖动中必须已是 FULL_SHAPE。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'
import { MOBILE_TABLE_CSS } from '../src/client/mobile/mobile-table.css.ts'
import {
  DRAWER_DRAGGING_ATTR, LEFT_SWIPE_KEY, RIGHT_SWIPE_KEY, MobileSidebarGestures, sidebarSwipeEnabled,
} from '../src/client/mobile/sidebar-gestures.ts'

/**
 * 假时钟：每个触摸事件默认相隔 SLOW_STEP_MS，用来表达「慢速手势」。
 *
 * 甩动通道的判据是**瞬时速度**，所以测试必须能控制时间；jsdom 里连续派发的事件 timeStamp
 * 几乎相同（亚毫秒级），若不管时间，任何位移都会被算成极高速度而误判成甩动。默认慢速让既有
 * 用例维持「只有距离说话」的原语义，甩动用例再用 at 显式给时间点。
 */
const SLOW_STEP_MS = 1000
let clock = 0

function touch(
  type: string, x: number, y: number, target: EventTarget, id = 1, activeIds?: number[], cancelable = true,
  at?: number,
): Event {
  const event = new Event(type, { bubbles: true, cancelable })
  const timestamp = at ?? (clock += SLOW_STEP_MS)
  Object.defineProperty(event, 'timeStamp', { value: timestamp })
  const point = { identifier: id, clientX: x, clientY: y }
  const active = (activeIds ?? (type === 'touchend' ? [] : [id])).map(identifier => ({ ...point, identifier }))
  Object.defineProperty(event, 'touches', { value: active })
  Object.defineProperty(event, 'changedTouches', { value: [point] })
  target.dispatchEvent(event)
  return event
}

function setRect(element: HTMLElement, left: number, width: number): void {
  element.getBoundingClientRect = () => ({
    x: left, y: 0, left, right: left + width, top: 0, bottom: 700, width, height: 700,
    toJSON: () => ({}),
  })
}

/** 壳侧推送的软键盘高度（与 composer-insets / keyboard-boundary 同一来源变量）。 */
function setImeInset(px: number): void {
  document.documentElement.style.setProperty('--dsh-android-ime-bottom', px > 0 ? `${px}px` : '0px')
}

/** jsdom 没有 visualViewport：按需装一个只读的假视口，用于键盘区判定。 */
function installViewport(height: number, offsetTop = 0): void {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height, offsetTop } })
}

/**
 * 上游只按 frame 的 data-sidebar-collapsed 渲染抽屉：收起态是一根导轨，展开态才是完整抽屉。
 * 真机实测（emulator-5562 / Android 15 / 600 CSS px，CDP 合成触摸）：
 *   收起 attrCollapsed=true  → button=6  elems=58   innerHTML=11232B
 *   展开 attrCollapsed=false → button=19 elems=202  innerHTML=40035B
 * 这四组数字就是 harness 的建模依据，也是本文件的核心断言。
 */
const RAIL_SHAPE = { buttons: 6, elems: 58 }
const FULL_SHAPE = { buttons: 19, elems: 202 }
/**
 * 右栏同一判据：上游 dockkit 的 TabHost 是 visible = active && selected && expanded，
 * 状态隐藏时**根本不执行 renderTab**。真机收起态右栏 innerHTML 3307B / 31 元素 / 3 按钮，
 * 展开态才是完整页（这里取 151 元素的下界形态，只用来区分"内容是否已挂载"）。
 */
const RIGHT_RAIL_SHAPE = { buttons: 3, elems: 31 }
const RIGHT_FULL_SHAPE = { buttons: 3, elems: 151 }

/** 生成 button/span 计数精确可控的假内容，让"元素形态"可断言。 */
function markup(buttons: number, spans: number): string {
  return Array.from({ length: buttons }, () => '<button type="button"></button>').join('')
    + Array.from({ length: spans }, () => '<span></span>').join('')
}

const DRAWER_RAIL = markup(RAIL_SHAPE.buttons, RAIL_SHAPE.elems - RAIL_SHAPE.buttons)
const DRAWER_FULL = markup(FULL_SHAPE.buttons, FULL_SHAPE.elems - FULL_SHAPE.buttons)
const RIGHT_RAIL = markup(RIGHT_RAIL_SHAPE.buttons, RIGHT_RAIL_SHAPE.elems - RIGHT_RAIL_SHAPE.buttons)
const RIGHT_FULL = RIGHT_RAIL + markup(0, RIGHT_FULL_SHAPE.elems - RIGHT_RAIL_SHAPE.elems)

/** 内容形态：与真机统计口径一致（子孙元素数 + 按钮数）。 */
function shape(element: HTMLElement): { buttons: number; elems: number } {
  return { buttons: element.querySelectorAll('button').length, elems: element.querySelectorAll('*').length }
}

/** 每个用例结束时统一 detach：文档级监听器跨用例残留会污染后面用例的 defaultPrevented / 焦点断言。 */
const attached: MobileSidebarGestures[] = []

function setup({
  panel = false, drawerOpen = false, rightOpen = false,
  rightRefWidth = null, rightBoxWidth = 400, closeLeft = true,
}: {
  panel?: boolean; drawerOpen?: boolean; rightOpen?: boolean
  rightRefWidth?: number | null; rightBoxWidth?: number; closeLeft?: boolean
} = {}) {
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-frame', '')
  if (!drawerOpen) frame.setAttribute('data-sidebar-collapsed', '')
  const drawer = document.createElement('aside')
  drawer.className = 'sidebarCol_test'
  frame.appendChild(drawer)
  document.body.appendChild(frame)
  setRect(drawer, 0, 200)
  // 上游右栏始终挂载（收起态只是 translateX + visibility:hidden），不是"打开时才存在"。
  const rightPanel = document.createElement('aside')
  rightPanel.setAttribute('data-sidebar-right-panel', 'fullscreen')
  if (rightOpen) rightPanel.setAttribute('data-sidebar-right-open', '')
  // 上游把位移参照系写成 --dsh-sidebar-width；显式给值时用它，可验证分母不是本体盒宽。
  if (rightRefWidth !== null) rightPanel.style.setProperty('--dsh-sidebar-width', `${rightRefWidth}px`)
  setRect(rightPanel, 0, rightBoxWidth)
  document.body.appendChild(rightPanel)
  const state = { panel, rightOpen }
  /** 上游的渲染判据：抽屉内容随 frame 的 collapsed 属性重建（收起＝导轨，展开＝完整）。 */
  const syncDrawer = (): void => {
    drawer.innerHTML = frame.hasAttribute('data-sidebar-collapsed') ? DRAWER_RAIL : DRAWER_FULL
  }
  const syncRight = (): void => { rightPanel.innerHTML = state.rightOpen ? RIGHT_FULL : RIGHT_RAIL }
  syncDrawer()
  syncRight()
  // 跟手预览的记录：left/right 是每次 touchmove 上报的进度，end 是复位次数。
  // drawerShape/rightShape 记录**落点那一刻**的内容形态（本文件的核心事实）。
  // order 记录回调顺序：松手时必须「先提交状态、后撤预览」，否则 CSS 会先弹回起点再重放动画。
  const preview: {
    left: number[]; right: number[]; end: number; order: string[]
    endWhileDragging: boolean[]
    drawerShape: { buttons: number; elems: number }[]
    rightShape: { buttons: number; elems: number }[]
  } = { left: [], right: [], end: 0, order: [], endWhileDragging: [], drawerShape: [], rightShape: [] }
  const calls = {
    openLeft: vi.fn(() => { preview.order.push('state'); frame.removeAttribute('data-sidebar-collapsed'); syncDrawer() }),
    // 真正的「收起左抽屉」动作：只收抽屉，绝不 selectPanel(null)（这是它与 returnToConversation 的区别）。
    closeLeft: vi.fn(() => { preview.order.push('state'); frame.setAttribute('data-sidebar-collapsed', ''); syncDrawer() }),
    returnToConversation: vi.fn(() => {
      preview.order.push('state')
      state.panel = false
      frame.setAttribute('data-sidebar-collapsed', '')
      syncDrawer()
    }),
    openRight: vi.fn(() => { preview.order.push('state'); state.rightOpen = true; syncRight() }),
    closeRight: vi.fn(() => { preview.order.push('state'); state.rightOpen = false; syncRight() }),
    previewLeft: vi.fn((progress: number) => {
      preview.left.push(progress)
      preview.drawerShape.push(shape(drawer))
      preview.order.push('preview')
    }),
    previewRight: vi.fn((progress: number) => {
      preview.right.push(progress)
      preview.rightShape.push(shape(rightPanel))
      preview.order.push('preview')
    }),
    endPreview: vi.fn(() => {
      preview.end += 1
      preview.endWhileDragging.push(dragging())
      preview.order.push('end')
    }),
  }
  const gestures = new MobileSidebarGestures({
    mobileForm: () => document.documentElement.hasAttribute('data-dsh-mobile-form'),
    leftOpen: () => !frame.hasAttribute('data-sidebar-collapsed'),
    rightOpen: () => state.rightOpen,
    mainPanelSelected: () => state.panel,
    openLeft: calls.openLeft,
    // closeLeft 只在装配方提供时才传：缺它时手势源必须放弃"提前提交"（见下方降级用例）。
    ...(closeLeft ? { closeLeft: calls.closeLeft } : {}),
    returnToConversation: calls.returnToConversation,
    openRight: calls.openRight,
    closeRight: calls.closeRight,
    previewLeft: calls.previewLeft,
    previewRight: calls.previewRight,
    endPreview: calls.endPreview,
  })
  gestures.attach()
  attached.push(gestures)
  const collapsed = (): boolean => frame.hasAttribute('data-sidebar-collapsed')
  return {
    frame, drawer, rightPanel, gestures, calls, preview, state, collapsed,
    shape: () => shape(drawer), rightShape: () => shape(rightPanel),
  }
}

function swipe(target: EventTarget, x1: number, y1: number, x2: number, y2: number): void {
  touch('touchstart', x1, y1, target)
  touch('touchmove', x2, y2, target)
  touch('touchend', x2, y2, target)
}

function dragging(): boolean {
  return document.documentElement.hasAttribute(DRAWER_DRAGGING_ATTR)
}

/**
 * 等某个断言自己成立，而不是「睡固定毫秒再断言」。
 *
 * 源码的横向容器扫描是 50ms 防抖（sidebar-gestures.ts 的 queueSurfaceRefresh）。原先测试
 * 睡 70ms——只留 20ms 余量。全量并行跑时事件循环被别的用例占住，50ms 的回调会晚于 70ms
 * 的断言落地，于是真实行为正确、测试却红（实测在全量跑里偶发、单跑三次全绿）。
 *
 * 改法：轮询等条件成立（含一次宏任务让出，保证 50ms 定时器有机会跑），超时才失败。
 * 判据不变，只把「等多久」从猜数字改成等事实。
 */
async function until(predicate: () => boolean, why: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('等待超时：' + why)
    await new Promise<void>(resolve => window.setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  document.documentElement.removeAttribute(DRAWER_DRAGGING_ATTR)
  setImeInset(0)
})

afterEach(() => {
  for (const gestures of attached.splice(0)) gestures.detach()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  document.documentElement.removeAttribute(DRAWER_DRAGGING_ATTR)
  setImeInset(0)
  delete (window as { visualViewport?: unknown }).visualViewport
})

describe('mobile sidebar content gestures', () => {
  it('opens the left drawer from a rightward middle-content swipe', () => {
    const h = setup()
    swipe(document.body, 200, 300, 300, 302)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.calls.returnToConversation).not.toHaveBeenCalled()
    expect(h.collapsed()).toBe(false)
  })

  it('a leftward middle-content swipe returns a selected main panel to Conversation', () => {
    const h = setup({ panel: true })
    swipe(document.body, 200, 300, 100, 302)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()
    expect(h.calls.openLeft).not.toHaveBeenCalled()
  })

  it('closes an open drawer and returns to Conversation from content area', () => {
    const h = setup({ drawerOpen: true, panel: true })
    swipe(h.drawer, 180, 300, 80, 302)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()
    expect(h.calls.openRight).not.toHaveBeenCalled()
    expect(h.collapsed()).toBe(true)
  })

  it('keeps the settings overlay gesture eligible so its owner can close it before returning', () => {
    const h = setup({ drawerOpen: true })
    const settings = document.createElement('div')
    settings.setAttribute('role', 'dialog')
    settings.setAttribute('aria-modal', 'true')
    settings.setAttribute('data-dsh-settings-dialog', '')
    document.body.appendChild(settings)
    swipe(h.drawer, 180, 300, 80, 302)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()
  })

  it('opens the right panel from the middle and closes only that panel with the opposite swipe', () => {
    const h = setup()
    // 结论按跟手进度判定（拖过一半才算，见「松手结算」用例）：右栏宽 400，左拖 220。
    swipe(document.body, 300, 300, 80, 302)
    expect(h.calls.openRight).toHaveBeenCalledOnce()
    expect(h.state.rightOpen).toBe(true)
    h.gestures.detach()
    document.body.innerHTML = ''
    const close = setup({ rightOpen: true })
    swipe(document.body, 100, 300, 340, 302)
    expect(close.calls.closeRight).toHaveBeenCalledOnce()
    expect(close.calls.openLeft).not.toHaveBeenCalled()
    expect(close.state.rightOpen).toBe(false)
    close.gestures.detach()
  })

  it('keeps left and right preferences independent', () => {
    localStorage.setItem(LEFT_SWIPE_KEY, '0')
    expect(sidebarSwipeEnabled('left')).toBe(false)
    expect(sidebarSwipeEnabled('right')).toBe(true)
    const h = setup()
    swipe(document.body, 200, 300, 100, 302)
    expect(h.calls.openRight).toHaveBeenCalledOnce()
    h.state.rightOpen = false
    swipe(document.body, 200, 300, 340, 302)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
  })

  it('suppresses the compatibility click after a recognized swipe but preserves keyboard clicks', () => {
    const h = setup()
    const clicked = vi.fn()
    document.body.addEventListener('click', clicked)
    swipe(document.body, 200, 300, 300, 302)
    const touchClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    document.body.dispatchEvent(touchClick)
    expect(touchClick.defaultPrevented).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
    const keyboardClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })
    document.body.dispatchEvent(keyboardClick)
    expect(keyboardClick.defaultPrevented).toBe(false)
    expect(clicked).toHaveBeenCalledOnce()
    h.gestures.detach()
  })

  it('does not claim desktop gestures, vertical drags, form controls, modal surfaces, or horizontal scrollers', () => {
    const h = setup()
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    swipe(document.body, 8, 300, 100, 302)
    document.documentElement.setAttribute('data-dsh-mobile-form', '')
    // 真纵向滚动：|dy| 远大于 |dx|（ratio 已降到 1.0，斜向不再是"纵向"）。
    swipe(document.body, 200, 300, 230, 560)
    const input = document.createElement('input')
    document.body.appendChild(input)
    swipe(input, 200, 300, 300, 302)
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    swipe(modal, 200, 300, 300, 302)
    modal.remove()
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    Object.defineProperties(scroller, { clientWidth: { value: 100 }, scrollWidth: { value: 200 } })
    document.body.appendChild(scroller)
    swipe(scroller, 200, 300, 300, 302)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    expect(h.collapsed()).toBe(true)
  })

  it('respects disabled right-side gesture without disabling left-side gesture', () => {
    localStorage.setItem(RIGHT_SWIPE_KEY, '0')
    const h = setup()
    swipe(document.body, 200, 300, 100, 302)
    swipe(document.body, 200, 300, 340, 302)
    expect(h.calls.openRight).not.toHaveBeenCalled()
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
  })

  it('leaves the narrow Android system gesture strips at both screen edges untouched', () => {
    const h = setup()
    swipe(document.body, 16, 300, 120, 302)
    swipe(document.body, 384, 300, 280, 302)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    expect(h.calls.openRight).not.toHaveBeenCalled()
  })

  it('does not switch panels when an initially horizontal movement becomes vertical', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    const horizontal = touch('touchmove', 230, 305, document.body)
    expect(horizontal.defaultPrevented).toBe(true)
    // 横向确认的当下就已经提前提交（内容已完整），见「早期提交」用例。
    expect(h.shape()).toEqual(FULL_SHAPE)
    const vertical = touch('touchmove', 235, 400, document.body)
    expect(vertical.defaultPrevented).toBe(false)
    touch('touchend', 235, 400, document.body)
    // 中途转纵向：提前提交被回退，抽屉最终收起、内容回到导轨形态。
    expect(h.collapsed()).toBe(true)
    expect(h.shape()).toEqual(RAIL_SHAPE)
    expect(h.calls.openRight).not.toHaveBeenCalled()
  })

  it('does not claim a pre-existing or newly created text selection', () => {
    const h = setup()
    const text = document.createElement('p')
    text.textContent = 'Selectable conversation text'
    document.body.appendChild(text)
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    swipe(text, 200, 300, 300, 302)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    selection.removeAllRanges()
    touch('touchstart', 200, 300, text)
    selection.addRange(range)
    const move = touch('touchmove', 300, 302, text)
    expect(move.defaultPrevented).toBe(false)
    touch('touchend', 300, 302, text)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
  })

  it('cancels a pending gesture when a second touch joins, even if one finger remains', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, [1])
    touch('touchmove', 230, 302, document.body, 1, [1])
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    touch('touchstart', 220, 300, document.body, 2, [1, 2])
    // 第二指加入：提前提交必须回退，抽屉不能自己开着；跟随目标也不能变成右栏。
    expect(h.collapsed()).toBe(true)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
    touch('touchmove', 300, 304, document.body, 1, [1])
    touch('touchend', 300, 304, document.body, 1, [])
    expect(h.collapsed()).toBe(true)
    expect(h.calls.openRight).not.toHaveBeenCalled()
    h.gestures.detach()
  })

  it('does not complete a swipe when touchend reports another finger still down', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, [1])
    touch('touchmove', 300, 302, document.body, 1, [1])
    expect(h.shape()).toEqual(FULL_SHAPE)
    // Even if the second touchstart/move was missed, the end of the first
    // finger is not a completed single-finger gesture while a touch remains.
    touch('touchend', 300, 302, document.body, 1, [2])
    expect(h.collapsed()).toBe(true)
    expect(h.shape()).toEqual(RAIL_SHAPE)
    touch('touchend', 300, 302, document.body, 2, [])
    expect(h.collapsed()).toBe(true)
    h.gestures.detach()
  })
})
describe('开合灵敏度（0.14.7 真机 V2425A / 360 CSS px 反馈）', () => {
  it('斜向拖动（|dx| 略大于 |dy|）仍被认领并实时跟手：ratio 1.0 不再丢手势', () => {
    const h = setup()
    // 真机典型：横 100 / 纵 70 —— 旧 ratio 1.5 下 100 <= 105 被整条丢弃（"时不时没反应"主因）。
    touch('touchstart', 100, 300, document.body)
    touch('touchmove', 200, 370, document.body)
    expect(h.preview.left).toEqual([0.5])
    expect(dragging()).toBe(true)
    // 松手：横向分量(100) > 纵向(70)，且已过 0.5，提交 —— 最终必须停在展开态。
    touch('touchend', 200, 370, document.body)
    expect(h.collapsed()).toBe(false)
    expect(h.calls.closeLeft).not.toHaveBeenCalled()
  })

  it('快速短甩：位移未达半宽也提交（旧口径只认"拖满一半"）', () => {
    const h = setup()
    // 抽屉宽 200，半宽 = 100；只甩了 60px（old 下必然弹回）。
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 240, 302, document.body, 1, undefined, true, 40)
    touch('touchmove', 260, 302, document.body, 1, undefined, true, 80)
    // 最后两条采样：40ms 内走了 20px => 0.5 px/ms，恰好达阈值；|dx|=60 >= 24。
    touch('touchend', 260, 302, document.body, 1, undefined, true, 80)
    expect(h.collapsed()).toBe(false)
  })

  it('慢速小位移（未达半宽、速度低）不提交并正确回退', () => {
    const h = setup()
    // 每步 60ms 只走 4px => 远低于 0.5 px/ms；总位移 40px < 半宽 100。
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 220, 302, document.body, 1, undefined, true, 600)
    touch('touchmove', 240, 302, document.body, 1, undefined, true, 1600)
    touch('touchend', 240, 302, document.body, 1, undefined, true, 1600)
    // 未达半宽、速度低 -> 回退（拖动中提前提交的展开必须被 closeLeft 收回）。
    expect(h.collapsed()).toBe(true)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
    expect(h.calls.returnToConversation).not.toHaveBeenCalled()
  })

  it('松手前已停住（滑动后停顿再抬手）不算甩动', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    // 两帧之间走得很快（20px/40ms = 0.5 px/ms），但松手晚了 300ms（> FLING_MAX_GAP_MS）。
    touch('touchmove', 240, 302, document.body, 1, undefined, true, 40)
    touch('touchmove', 260, 302, document.body, 1, undefined, true, 80)
    touch('touchend', 260, 302, document.body, 1, undefined, true, 380)
    // 未达半宽且速度按 0 处理 => 回退。
    expect(h.collapsed()).toBe(true)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
  })

  it('纵向滚动仍不被认领（|dy| > |dx| 天然排除）', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 230, 380, document.body, 1, undefined, true, 20)
    touch('touchmove', 250, 480, document.body, 1, undefined, true, 40)
    expect(h.preview.left).toEqual([])
    expect(dragging()).toBe(false)
    touch('touchend', 250, 480, document.body, 1, undefined, true, 40)
    // 全程未被认领：既没提前提交过，也就没有回退动作。
    expect(h.collapsed()).toBe(true)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    expect(h.calls.closeLeft).not.toHaveBeenCalled()
  })

  it('速度阈值边界：略低于阈值不提交，达到阈值才提交', () => {
    // 略低：40ms 走 16px = 0.4 px/ms（阈值 0.5）。|dx|=56 >= 24，所以只可能被速度挡住。
    const slow = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 240, 302, document.body, 1, undefined, true, 40)
    touch('touchmove', 256, 302, document.body, 1, undefined, true, 80)
    touch('touchend', 256, 302, document.body, 1, undefined, true, 80)
    expect(slow.collapsed()).toBe(true)
    expect(slow.calls.closeLeft).toHaveBeenCalledOnce()
    slow.gestures.detach()

    // 达到：40ms 走 20px = 0.5 px/ms。
    const fast = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 240, 302, document.body, 1, undefined, true, 40)
    touch('touchmove', 260, 302, document.body, 1, undefined, true, 80)
    touch('touchend', 260, 302, document.body, 1, undefined, true, 80)
    expect(fast.collapsed()).toBe(false)
  })

  it('甩动也要走够最小位移：极快但只挪了几像素不提交', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    // 极快（2 px/ms）但总共只走了 16px < FLING_MIN_PX(24)，且远未到半宽。
    touch('touchmove', 208, 301, document.body, 1, undefined, true, 10)
    touch('touchmove', 216, 302, document.body, 1, undefined, true, 14)
    touch('touchend', 216, 302, document.body, 1, undefined, true, 14)
    expect(h.collapsed()).toBe(true)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
  })

  it('死区从 12 降到 8：第 9 像素就已开始跟手', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 209, 301, document.body)
    expect(h.preview.left).toEqual([0.045])
    touch('touchend', 209, 301, document.body)
    // 跟手成立了，但 9px 太短：既未达半宽也没速度（慢速）-> 回退。
    expect(h.collapsed()).toBe(true)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
  })

  it('甩动通道同样适用于关闭方向（速度够快即收）', () => {
    const h = setup({ drawerOpen: true })
    touch('touchstart', 180, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 140, 302, document.body, 1, undefined, true, 40)
    touch('touchmove', 120, 302, document.body, 1, undefined, true, 80)
    // |dx|=60 < 半宽 100，但 40ms 走了 20px = 0.5 px/ms。
    touch('touchend', 120, 302, document.body, 1, undefined, true, 80)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(true)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
  })
})

describe('竞态：原生滚动抢走 cancelable 后手势仍须成立（0.14.7 task-11）', () => {
  it('首帧可取消但位移不足，第 2 帧起 cancelable=false —— 手势仍被认领并跟手', () => {
    // Lead 真机 V2425A CDP 实测形态：横向拖 140px / 14 帧，
    // cancelableSeq = "1000000000"（仅首帧可取消），旧实现下 dragging 恒 false、抽屉纹丝不动。
    const h = setup()
    // 首帧：位移只有 3px，还没过死区 —— 此刻不 preventDefault（也无法阻止内核接管）。
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 203, 301, document.body, 1, undefined, true, 25, true)
    expect(dragging()).toBe(false)
    // 第 2 帧起内核已接管：cancelable=false，且位移远超死区。
    touch('touchmove', 240, 302, document.body, 1, undefined, false, 50, true)
    expect(dragging()).toBe(true)
    expect(h.preview.left).toEqual([0.2])
    touch('touchmove', 300, 303, document.body, 1, undefined, false, 75, true)
    expect(h.preview.left).toEqual([0.2, 0.5])
    touch('touchmove', 340, 304, document.body, 1, undefined, false, 100, true)
    expect(h.preview.left).toEqual([0.2, 0.5, 0.7])
    // 松手同样在 cancelable=false 下发生：结算照常提交。
    touch('touchend', 340, 304, document.body, 1, undefined, false, 125, true)
    expect(h.collapsed()).toBe(false)
    expect(h.calls.closeLeft).not.toHaveBeenCalled()
  })

  it('全程 cancelable=false（首帧已被抢走）也要跟手，不再整条丢弃', () => {
    const h = setup()
    // 慢速：600ms 才走 60px，远低于甩动阈值，确保本用例只验证「跟手被认领」。
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 260, 302, document.body, 1, undefined, false, 600, true)
    expect(dragging()).toBe(true)
    expect(h.preview.left).toEqual([0.3])
    touch('touchend', 260, 302, document.body, 1, undefined, false, 1200, true)
    // 60px 未达半宽(100)、速度也低 —— 已被认领过，回退必须走真正的收起动作。
    expect(h.collapsed()).toBe(true)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
  })

  it('不可取消时不调用 preventDefault（避免内核刷 "Ignored attempt to cancel" 警告）', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    const blocked = touch('touchmove', 260, 302, document.body, 1, undefined, false, 25, true)
    expect(blocked.defaultPrevented).toBe(false)
    // 可取消的那一帧仍然要拦。
    const allowed = touch('touchmove', 280, 302, document.body, 1, undefined, true, 50, true)
    expect(allowed.defaultPrevented).toBe(true)
  })
})

describe('real-time following (0.14.7 §2.1)', () => {
  it('上报的进度与手指位移成正比：每次 touchmove 都跟手，无需任何定时器推进', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    // 死区内（|dx| < START_SLOP_PX=8）不位移，也不打拖动标记。
    touch('touchmove', 205, 301, document.body)
    expect(h.preview.left).toEqual([])
    expect(dragging()).toBe(false)
    touch('touchmove', 220, 302, document.body)
    touch('touchmove', 260, 303, document.body)
    touch('touchmove', 320, 304, document.body)
    // 抽屉实测宽度 200：20/200 / 60/200 / 120/200，逐点线性、无阻尼、无延迟。
    expect(h.preview.left).toEqual([0.1, 0.3, 0.6])
    expect(dragging()).toBe(true)
    touch('touchend', 320, 304, document.body)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
  })

  it('拖动标记与预览在松手时同步撤除，让 CSS transition 从当前跟手位置结算', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 320, 302, document.body)
    expect(dragging()).toBe(true)
    touch('touchend', 320, 302, document.body)
    expect(dragging()).toBe(false)
    expect(h.preview.end).toBe(1)
    // Inline offsets must be cleared while transition:none is still in force;
    // only then is CSS allowed to animate toward the committed open state.
    expect(h.preview.endWhileDragging).toEqual([true])
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
  })

  it('进度按面板实测宽度换算并夹在 0..1 之间', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    // 拖动 210px：超过抽屉宽 200，但仍在有效行程上限（200*1.25=250）内 → 夹到 1。
    touch('touchmove', 410, 302, document.body)
    expect(h.preview.left).toEqual([1])
  })

  it('右栏同样实时跟手（progress 分母是右栏实测宽度）', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 100, 302, document.body)
    expect(h.preview.right).toEqual([0.25])
    expect(h.preview.left).toEqual([])
    expect(dragging()).toBe(true)
    // 未过半松手 = 回退：右栏被重新收起（这正是"关闭方向"与"开启方向"共用一把进度尺的结果）。
    touch('touchend', 100, 302, document.body)
    expect(h.calls.openRight).toHaveBeenCalledOnce()
    expect(h.calls.closeRight).toHaveBeenCalledOnce()
    expect(h.state.rightOpen).toBe(false)
    expect(dragging()).toBe(false)
  })

  it('右栏进度分母取 --dsh-sidebar-width（上游位移参照系），而不是右栏本体的盒宽', () => {
    // 本体盒宽只有 100，但上游实际位移参照系是 400px：手指走 100 只能展开 1/4。
    const h = setup({ rightRefWidth: 400, rightBoxWidth: 100 })
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 100, 302, document.body)
    expect(h.preview.right).toEqual([0.25])

    h.gestures.detach()
    document.body.innerHTML = ''
    // 变量缺失（异常内核/未注入）时才退回本体实测宽度。
    const fallback = setup({ rightBoxWidth: 100 })
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 100, 302, document.body)
    expect(fallback.preview.right).toEqual([1])
  })

  it('关闭方向上报的是剩余可见度（1 = 仍完全展开），与开启方向同一套几何', () => {
    const h = setup({ drawerOpen: true, panel: true })
    touch('touchstart', 180, 300, h.drawer)
    touch('touchmove', 80, 302, h.drawer)
    // 左抽屉宽 200，手指左移 100：已收起一半 → 展开度 0.5。
    expect(h.preview.left).toEqual([0.5])
    touch('touchend', 80, 302, h.drawer)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()

    h.gestures.detach()
    document.body.innerHTML = ''
    const close = setup({ rightOpen: true })
    // 右栏展开时，收起的动作是右滑（与左抽屉对称：开/关方向相反）。
    touch('touchstart', 100, 300, document.body)
    touch('touchmove', 300, 302, document.body)
    // 右栏宽 400，手指右移 200：已收起一半 → 剩余可见度 0.5。
    expect(close.preview.right).toEqual([0.5])
    close.gestures.detach()
  })

  it('松手时先提交开合状态、再撤跟手预览：CSS 从手指位置收敛，而不是先弹回起点', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 320, 302, document.body)
    touch('touchend', 320, 302, document.body)
    // 展开方向在 touchmove 就已提交（内容必须先挂载）；不变量是「最后一次状态提交早于预览复位」。
    expect(h.calls.openLeft).toHaveBeenCalled()
    expect(h.preview.order.lastIndexOf('state')).toBeLessThan(h.preview.order.indexOf('end'))

    h.gestures.detach()
    document.body.innerHTML = ''
    const closing = setup({ drawerOpen: true, panel: true })
    touch('touchstart', 180, 300, closing.drawer)
    touch('touchmove', 80, 302, closing.drawer)
    touch('touchend', 80, 302, closing.drawer)
    // 收起方向不提前提交（内容本来就在），所以顺序必须是 预览 → 提交 → 复位。
    expect(closing.preview.order).toEqual(['preview', 'state', 'end'])
  })

  it('轻点不乱抖：起点在内容区、松手落在已展开的侧栏上、位移远超面板宽时不触发任何开合', () => {
    // 现场：屏宽 400 的抽屉上，起点 x=40、松手被夹在 x=384（侧栏上），|dx|=344。
    // 旧实现只排除起点边缘，把它当滑动 → 侧栏先反向跟手一段再收回，看起来点一下就乱抖。
    const h = setup({ drawerOpen: true })
    touch('touchstart', 40, 300, document.body)
    const move = touch('touchmove', 384, 302, document.body)
    expect(h.preview.left).toEqual([])
    expect(h.preview.right).toEqual([])
    expect(dragging()).toBe(false)
    expect(move.defaultPrevented).toBe(false)
    touch('touchend', 384, 302, document.body)
    expect(h.calls.returnToConversation).not.toHaveBeenCalled()
    expect(h.calls.openRight).not.toHaveBeenCalled()
  })

  it('超出面板宽的行程上限：右栏同样不认领（上限跟面板几何走，与屏宽无关）', () => {
    const h = setup({ rightRefWidth: 400, rightBoxWidth: 400 })
    touch('touchstart', 300, 300, document.body)
    // 左拖 600px，远超右栏宽 400*1.25=500 → 整条手势作废。
    const move = touch('touchmove', -300, 302, document.body)
    expect(h.preview.right).toEqual([])
    expect(dragging()).toBe(false)
    expect(move.defaultPrevented).toBe(false)
    touch('touchend', -300, 302, document.body)
    expect(h.calls.openRight).not.toHaveBeenCalled()
  })

  it('行程上限不影响正常开合：一个面板宽以内的拖动照常跟手并提交', () => {
    const h = setup()
    // 抽屉宽 200，上限 250：拖 249 仍有效（正常用户能拖出的范围）。
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 449, 302, document.body)
    expect(h.preview.left).toEqual([1])
    touch('touchend', 449, 302, document.body)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(false)
  })

  it('跟手不足阈值时松手复位，不改变开合状态', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 240, 302, document.body)
    expect(h.preview.left).toEqual([0.2])
    touch('touchend', 240, 302, document.body)
    // 提前提交过展开（内容已挂载），松手不够 → 用真正的收起动作回退，抽屉回到收起态。
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(true)
    expect(h.preview.end).toBe(1)
    expect(dragging()).toBe(false)
  })

  it('拖动中转为纵向滚动时立刻复位，抽屉不停在半开处', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 240, 302, document.body)
    expect(h.preview.left).toEqual([0.2])
    const vertical = touch('touchmove', 245, 420, document.body)
    expect(vertical.defaultPrevented).toBe(false)
    expect(dragging()).toBe(false)
    expect(h.preview.end).toBe(1)
    // 已提前提交的展开必须回退：纵向滚动不该留下一个打开的抽屉。
    expect(h.collapsed()).toBe(true)
    touch('touchend', 245, 420, document.body)
    expect(h.collapsed()).toBe(true)
  })

  it('该侧开关关闭时不跟手、也不拦截原生滚动', () => {
    localStorage.setItem(LEFT_SWIPE_KEY, '0')
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    const move = touch('touchmove', 320, 302, document.body)
    expect(move.defaultPrevented).toBe(false)
    expect(h.preview.left).toEqual([])
    expect(dragging()).toBe(false)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
  })

  it('第二指加入时复位预览并撤掉拖动标记', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, [1])
    touch('touchmove', 260, 302, document.body, 1, [1])
    expect(dragging()).toBe(true)
    touch('touchstart', 220, 300, document.body, 2, [1, 2])
    expect(dragging()).toBe(false)
    expect(h.preview.end).toBe(1)
    expect(h.collapsed()).toBe(true)
    touch('touchend', 260, 302, document.body, 1, [2])
    expect(h.collapsed()).toBe(true)
  })

  it('touchcancel 与 detach 都撤掉拖动标记（漏撤会让抽屉永久失去过渡）', () => {
    const cancelled = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 260, 302, document.body)
    touch('touchcancel', 260, 302, document.body)
    expect(dragging()).toBe(false)
    expect(cancelled.preview.end).toBe(1)
    expect(cancelled.collapsed()).toBe(true)
    cancelled.gestures.detach()

    const detached = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 260, 302, document.body)
    expect(dragging()).toBe(true)
    detached.gestures.detach()
    expect(dragging()).toBe(false)
    expect(detached.preview.end).toBe(1)
    expect(detached.collapsed()).toBe(true)
  })

  it('消费方没有提供预览回调时降级为零开销，原有开合语义不变', () => {
    document.documentElement.setAttribute('data-dsh-mobile-form', '')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    frame.setAttribute('data-sidebar-collapsed', '')
    const drawer = document.createElement('aside')
    drawer.className = 'sidebarCol_test'
    frame.appendChild(drawer)
    document.body.appendChild(frame)
    setRect(drawer, 0, 200)
    const openLeft = vi.fn(() => frame.removeAttribute('data-sidebar-collapsed'))
    const gestures = new MobileSidebarGestures({
      mobileForm: () => true,
      leftOpen: () => !frame.hasAttribute('data-sidebar-collapsed'),
      rightOpen: () => false,
      mainPanelSelected: () => false,
      openLeft,
      closeLeft: vi.fn(),
      returnToConversation: vi.fn(),
      openRight: vi.fn(),
      closeRight: vi.fn(),
    })
    gestures.attach()
    attached.push(gestures)
    swipe(document.body, 200, 300, 300, 302)
    expect(openLeft).toHaveBeenCalledOnce()
    expect(dragging()).toBe(false)
  })
})

describe('拖动中抽屉内容必须已挂载（0.14.7 task-7 真机真因）', () => {
  it('open-left 意图一确认就提交展开：预览落点时抽屉已是完整内容，不是收起导轨', () => {
    const h = setup()
    // 提交前：收起态只有导轨（真机 6 按钮 / 58 元素）。
    expect(h.shape()).toEqual(RAIL_SHAPE)
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 240, 302, document.body)
    // 真机事实：拖动中 attrCollapsed=false 后抽屉是 19 按钮 / 202 元素（innerHTML 40035B），
    // 而"拖动中仍是收起态"只有 6 / 58（11232B）—— 后者就是用户看到的"内容不完整"。
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(false)
    expect(h.preview.drawerShape).toEqual([FULL_SHAPE])
    expect(h.shape()).toEqual(FULL_SHAPE)
    // 位移仍停在半途（progress 0.2 < 1）：内容完整是状态提交带来的，不是动画播完带来的。
    expect(h.preview.left).toEqual([0.2])
    touch('touchend', 240, 302, document.body)
  })

  it('提交顺序是「先提交开合状态、后写位移预览」：反了会先闪一下导轨', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 260, 302, document.body)
    // 第一次跟手落点时，状态提交已经排在预览回调之前。
    expect(h.preview.order).toEqual(['state', 'preview'])
  })

  it('整个拖动过程内容形态恒为完整抽屉（每一帧都挂着内容）', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 230, 302, document.body)
    touch('touchmove', 260, 302, document.body)
    touch('touchmove', 300, 302, document.body)
    expect(h.preview.drawerShape).toEqual([FULL_SHAPE, FULL_SHAPE, FULL_SHAPE])
    touch('touchend', 300, 302, document.body)
    expect(h.collapsed()).toBe(false)
    expect(h.shape()).toEqual(FULL_SHAPE)
  })

  it('收起方向（return）不提前提交状态：拖动期间抽屉不会被清空', () => {
    const h = setup({ drawerOpen: true, panel: true })
    expect(h.shape()).toEqual(FULL_SHAPE)
    touch('touchstart', 180, 300, h.drawer)
    touch('touchmove', 80, 302, h.drawer)
    // 收起方向本来就是展开态、内容已挂载，拖动中不得提前收起（否则内容会提前消失）。
    expect(h.collapsed()).toBe(false)
    expect(h.preview.drawerShape).toEqual([FULL_SHAPE])
    expect(h.calls.returnToConversation).not.toHaveBeenCalled()
    touch('touchend', 80, 302, h.drawer)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()
  })

  it('右栏拖动中内容同样必须已挂载（上游 expanded 时才渲染 dockkit 内容）', () => {
    const h = setup()
    expect(h.rightShape()).toEqual(RIGHT_RAIL_SHAPE)
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 100, 302, document.body)
    // 真机：收起态右栏只有 31 元素 / 3307B（内容根本没渲染），展开态才是完整页。
    expect(h.calls.openRight).toHaveBeenCalledOnce()
    expect(h.state.rightOpen).toBe(true)
    expect(h.preview.rightShape).toEqual([RIGHT_FULL_SHAPE])
    expect(h.rightShape()).toEqual(RIGHT_FULL_SHAPE)
    touch('touchend', 100, 302, document.body)
  })

  it('回退走真正的收起动作：绝不用 returnToConversation 顶替（它会顺带清掉中栏选择）', () => {
    const h = setup({ panel: true })
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 240, 302, document.body)
    touch('touchend', 240, 302, document.body)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
    expect(h.calls.returnToConversation).not.toHaveBeenCalled()
    // 中栏面板选择必须毫发无损。
    expect(h.state.panel).toBe(true)
    expect(h.collapsed()).toBe(true)
    expect(h.shape()).toEqual(RAIL_SHAPE)
  })

  it('松手过半时只提交一次，不重复 toggle（toggle 语义下二次调用会把抽屉关回去）', () => {
    const h = setup()
    swipe(document.body, 200, 300, 320, 302)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.calls.closeLeft).not.toHaveBeenCalled()
    expect(h.collapsed()).toBe(false)
    expect(h.shape()).toEqual(FULL_SHAPE)
  })

  it('缺 closeLeft 回调时宁可不跟手：不提前提交，避免留下关不掉的抽屉', () => {
    const h = setup({ closeLeft: false })
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 260, 302, document.body)
    // 没有可逆的收起动作 → 不提前提交：此时只有预览上报，抽屉内容仍是导轨（明确记录的降级形态）。
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    expect(h.collapsed()).toBe(true)
    expect(h.shape()).toEqual(RAIL_SHAPE)
    // 拖过一半再松手：照常提交（走原有的松手语义），内容随即完整。
    touch('touchmove', 340, 302, document.body)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    touch('touchend', 340, 302, document.body)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.shape()).toEqual(FULL_SHAPE)
  })
})

describe('触点按下前的原生平移策略', () => {
  // 行为变更（图片预览「放大图片会放大整个屏幕」）：本用例原先锁的是
  // `touch-action: pan-y pinch-zoom`，断言「双指缩放留给浏览器」。实测那条授权正是
  // 整屏被放大的来源（pinch-zoom = 允许浏览器捏合缩放整页），所以它被**有意撤销**，
  // 断言随契约一起改：frame 只保留 pan-y，捏合闸门移到根上（body 层 portal 不在 frame
  // 子树里），横向滚动容器仍保留 auto。最后一条是反向守卫：谁再把 pinch-zoom 加回这张
  // 样式表，就等于把这条 bug 加回来。
  it('常驻 CSS 限制横向平移、保留纵向滚动，且不再放行整页双指缩放', () => {
    expect(MOBILE_FORM_CSS).toMatch(/\[data-dsh-frame\], \[data-dsh-frame\] \*\s*\{\s*touch-action: pan-y;/)
    expect(MOBILE_FORM_CSS).toMatch(/html\[data-dsh-mobile-form\]\s*\{\s*touch-action: pan-x pan-y;/)
    expect(MOBILE_FORM_CSS).toMatch(/\[data-dsh-frame\] \[data-dsh-horizontal-scroll\] \*\s*\{\s*touch-action: auto/)
    // 守卫要贴着契约写：禁的是「把 pinch-zoom 写进某条 touch-action 声明」。
    // 判据前先剥掉注释——这张样式表的注释正在解释 pinch-zoom 为什么被撤销，含该词属正常；
    // 不剥会让断言被说明文字绊倒（首版就是踩了这个坑，红的是判据自己）。
    const cssNoComments = MOBILE_FORM_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(cssNoComments).not.toMatch(/touch-action:[^;{}]*pinch-zoom/)
  })

  it('touchstart 不临时改写元素样式，也不覆盖已有原生策略', () => {
    setup()
    const surface = document.createElement('div')
    surface.style.touchAction = 'manipulation'
    document.body.appendChild(surface)
    touch('touchstart', 200, 300, surface)
    expect(surface.style.touchAction).toBe('manipulation')
    touch('touchend', 200, 300, surface)
    expect(surface.style.touchAction).toBe('manipulation')
  })

  it('首次 attach 就标记已有横向滚动容器，无需等第一次触摸', () => {
    const h = setup()
    h.gestures.detach()
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 800 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
    h.drawer.appendChild(scroller)
    h.gestures.attach()
    expect(scroller.hasAttribute('data-dsh-horizontal-scroll')).toBe(true)
    touch('touchstart', 200, 300, scroller)
    const move = touch('touchmove', 300, 302, scroller)
    expect(move.defaultPrevented).toBe(false)
    expect(dragging()).toBe(false)
    h.gestures.detach()
    expect(scroller.hasAttribute('data-dsh-horizontal-scroll')).toBe(false)
  })

  it('新增横向滚动容器与溢出消失都会在下一触摸前更新标记', async () => {
    const h = setup()
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 800 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
    h.drawer.appendChild(scroller)
    await until(() => scroller.hasAttribute('data-dsh-horizontal-scroll'), '新增的横向容器应被标记')
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 200 })
    window.dispatchEvent(new Event('resize'))
    await until(() => !scroller.hasAttribute('data-dsh-horizontal-scroll'), '溢出消失后标记应被摘掉')
  })

  it('父级尺寸或字体样式变化只重测其子树里的横向容器', async () => {
    const h = setup()
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    let width = 800
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, get: () => width })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
    h.drawer.appendChild(scroller)
    await until(() => scroller.hasAttribute('data-dsh-horizontal-scroll'), '新增的横向容器应被标记')

    width = 200
    h.drawer.style.fontSize = '20px'
    await until(() => !scroller.hasAttribute('data-dsh-horizontal-scroll'), '父级字体变化后标记应被摘掉')
  })

  it('完整侧栏在手势中挂载时不扫描全 frame；松手后的帧先结算再做一次扫描', async () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 280, 302, document.body)
    const styleRead = vi.spyOn(window, 'getComputedStyle')
    // Simulate React mounting a large subtree as ensureOpen expands the drawer.
    for (let i = 0; i < 200; i++) {
      const node = document.createElement('div')
      h.drawer.appendChild(node)
    }
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    let dimensionReads = 0
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, get: () => { dimensionReads++; return 800 } })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
    h.drawer.appendChild(scroller)
    await Promise.resolve()
    expect(styleRead).not.toHaveBeenCalled()

    styleRead.mockClear()
    touch('touchend', 320, 302, document.body)
    expect(h.preview.endWhileDragging).toEqual([true])
    expect(dimensionReads).toBe(0)
    await new Promise<void>(resolve => window.setTimeout(resolve, 70))
    expect(styleRead).toHaveBeenCalled()
    expect(dimensionReads).toBeGreaterThan(0)
    expect(scroller.hasAttribute('data-dsh-horizontal-scroll')).toBe(true)
    styleRead.mockRestore()
  })

  it('纵向滚动一旦开始，后来转横且不可取消也不能开启抽屉', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    const vertical = touch('touchmove', 202, 312, document.body)
    expect(vertical.defaultPrevented).toBe(false)
    const horizontal = touch('touchmove', 320, 322, document.body, 1, undefined, false)
    expect(horizontal.defaultPrevented).toBe(false)
    expect(dragging()).toBe(false)
    expect(h.preview.left).toEqual([])
    touch('touchend', 320, 322, document.body)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
  })

  it('快速抬手时纵向分量占优也必须回退，甩动不能绕过纵向防误触', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body, 1, undefined, true, 0)
    touch('touchmove', 240, 302, document.body, 1, undefined, true, 40)
    touch('touchend', 250, 380, document.body, 1, undefined, true, 50)
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(true)
  })
})

describe('preventDefault 的 cancelable 守卫（真机 17 次 Ignored attempt to cancel）', () => {
  it('不可取消的 touchmove：不调 preventDefault，但手势继续跟手（task-11 放宽）', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    const move = touch('touchmove', 300, 302, document.body, 1, undefined, false)
    // 不拦（拦不住也不该刷警告），但绝不能因此丢掉整条手势。
    expect(move.defaultPrevented).toBe(false)
    expect(h.preview.left).toEqual([0.5])
    expect(dragging()).toBe(true)
  })

  it('跟手途中遇到不可取消的 touchmove：继续跟手，不再整条回退', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 260, 302, document.body)
    expect(dragging()).toBe(true)
    expect(h.preview.left).toEqual([0.3])
    const move = touch('touchmove', 320, 302, document.body, 1, undefined, false)
    expect(move.defaultPrevented).toBe(false)
    // 旧语义在 !cancelable 时 abandon() —— 那正是「已经拖了却完全没反应」的机制。
    expect(dragging()).toBe(true)
    expect(h.preview.left).toEqual([0.3, 0.6])
    expect(h.calls.closeLeft).not.toHaveBeenCalled()
  })

  it('不可取消的 touchend：仍然照常结算，且不吞掉兼容 click', () => {
    const h = setup()
    const clicked = vi.fn()
    document.body.addEventListener('click', clicked)
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 300, 302, document.body)
    const end = touch('touchend', 300, 302, document.body, 1, [], false)
    expect(end.defaultPrevented).toBe(false)
    // 位移已达半宽：放宽后应当提交，而不是弹回。
    expect(h.collapsed()).toBe(false)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    // 没有 preventDefault 就不该吞掉兼容 click（吞了会让这次触摸的目标点不动）。
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    document.body.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(clicked).toHaveBeenCalledOnce()
  })

  it('可取消的事件照旧 preventDefault（守卫没有削弱正常路径）', () => {
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    const move = touch('touchmove', 300, 302, document.body)
    expect(move.defaultPrevented).toBe(true)
    const end = touch('touchend', 300, 302, document.body)
    expect(end.defaultPrevented).toBe(true)
  })
})

describe('soft keyboard boundary (0.14.7 §2.1)', () => {
  it('键盘区域内的触摸绝不触发侧边栏手势', () => {
    installViewport(500)
    setImeInset(300)
    const h = setup()
    // 可视视口高 500：其下即输入法窗口区域。
    touch('touchstart', 200, 600, document.body)
    const move = touch('touchmove', 320, 602, document.body)
    expect(move.defaultPrevented).toBe(false)
    expect(h.preview.left).toEqual([])
    expect(dragging()).toBe(false)
    touch('touchend', 320, 602, document.body)
    expect(h.calls.openLeft).not.toHaveBeenCalled()
    expect(h.collapsed()).toBe(true)
  })

  it('键盘展开时应用 UI 区仍能跟手并展开侧边栏', () => {
    installViewport(500)
    setImeInset(300)
    const h = setup()
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 320, 302, document.body)
    expect(h.preview.left).toEqual([0.6])
    expect(h.shape()).toEqual(FULL_SHAPE)
    touch('touchend', 320, 302, document.body)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(false)
  })

  it('键盘展开时从应用 UI 有效展开侧边栏会收起键盘', () => {
    installViewport(500)
    setImeInset(300)
    const h = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)
    swipe(document.body, 200, 300, 300, 302)
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(input)
  })

  it('右栏展开同样收起键盘', () => {
    installViewport(500)
    setImeInset(300)
    const h = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    swipe(document.body, 200, 300, 80, 302)
    expect(h.calls.openRight).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(input)
  })

  it('跟手拖动过程不改变输入框焦点，也不拉起键盘', () => {
    const h = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const focused = vi.fn()
    const blurred = vi.fn()
    input.addEventListener('focus', focused)
    input.addEventListener('blur', blurred)
    touch('touchstart', 200, 300, document.body)
    touch('touchmove', 250, 302, document.body)
    expect(document.activeElement).toBe(input)
    expect(focused).not.toHaveBeenCalled()
    expect(blurred).not.toHaveBeenCalled()
    touch('touchcancel', 250, 302, document.body)
    expect(document.activeElement).toBe(input)
    // 跟手期间确实提交过展开，但被取消后又回退：既没动焦点，也没留下打开的抽屉。
    expect(h.calls.openLeft).toHaveBeenCalledOnce()
    expect(h.calls.closeLeft).toHaveBeenCalledOnce()
    expect(h.collapsed()).toBe(true)
  })

  it('关闭方向的手势不触碰键盘', () => {
    installViewport(500)
    setImeInset(300)
    const h = setup({ drawerOpen: true, panel: true })
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    swipe(h.drawer, 180, 300, 80, 302)
    expect(h.calls.returnToConversation).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input)
  })
})


describe('宽表格首触点与侧栏仲裁', () => {
  it.each([false, true])('移动端样式启用=%s：首触点的滚动归属，含旧行为负控', (fixed) => {
    const style = document.createElement('style')
    document.head.appendChild(style)
    try {
      // jsdom 不评估媒体条件；只展开本用例已选定的触屏规则。
      // 真实 CSS 级联参与 overflow 判断，不伪造 getComputedStyle。
      style.textContent = MOBILE_TABLE_CSS
      const media = style.sheet!.cssRules[0] as CSSMediaRule
      const mobile = Array.from(media.cssRules, rule => rule.cssText).join('\n')
      style.textContent = '.md-table-wide { overflow-x: hidden; }' + (fixed ? mobile : '')
      const h = setup()
      const wrapper = document.createElement('div')
      wrapper.className = 'md-table-wide'
      wrapper.innerHTML = '<table><tbody><tr><td>说明列</td></tr></tbody></table>'
      // jsdom 没有布局引擎，尺寸按设备中的溢出表格建模；不据此声称布局验收。
      Object.defineProperties(wrapper, { clientWidth: { value: 200 }, scrollWidth: { value: 800 } })
      h.frame.appendChild(wrapper)
      const cell = wrapper.querySelector('td')!
      // 不等 MutationObserver 或 hover，模拟流式输出后立刻横滑。
      touch('touchstart', 300, 300, cell)
      const move = touch('touchmove', 100, 302, cell)
      touch('touchend', 100, 302, cell)
      expect(move.defaultPrevented).toBe(!fixed)
      expect(h.calls.openRight).toHaveBeenCalledTimes(fixed ? 0 : 1)
      if (fixed) {
        // touch-action 与几何由 WebView/CDP + ADB 验证；jsdom 不实现该属性。
        // 表格之外仍能展开侧栏，不能用全局禁用手势来掩盖冲突。
        swipe(h.frame, 300, 300, 100, 302)
        expect(h.calls.openRight).toHaveBeenCalledOnce()
      }
    } finally {
      style.remove()
    }
  })
})
