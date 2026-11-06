// @vitest-environment jsdom
// 底部 sheet 的手势**取消**路径（issue #1525：把 #1378 的源码文本判据换成行为判据）。
//
// ## 为什么重写
// #1378 的回归用例读的是**源码文本**：断言 `touchcancel` 绑在 `onSheetTouchCancel`、且那段
// 800 字符窗口里没有 `this.close()`。这种判据与实现结构同构、与用户可见行为脱钩 ——
//   - 把 `this.close()` 从取消处理器挪进它调用的 `settleTo()` / helper（issue #1525 的复现路径），
//     窗口里确实不再出现那句话，用例照旧绿，而用户仍然会在来电、通知下拉之后丢掉面板；
//   - 给处理器改个名字、换个绑定写法（别名 / 事件映射表），文本断言全红而行为没变。
// 因此这里改为**派发合成触摸序列**，只断言可观察事实：遮罩还在不在、phase 落在哪一段、
// 高度回到多少、位移是否归零、拖拽标记是否摘掉。
//
// ## 三条判据（缺一条就会退回「只能红」或「只能绿」）
//   1 下拉**超过关闭阈值**后派 `touchcancel`：面板必须不关，且吸附回取消前的 peek 落点；
//   2 同一手势序列把最后一个事件换成 `touchend`：必须关 —— 证明第 1 条不是「怎么都不关」，
//     也证明这条手势序列真的越过了阈值（否则第 1 条是白捡的）；
//   3 取消发生在 expanded 态：吸附回 expanded（不是掉回 peek）—— 落点按取消前的形态算。
//
// ## 负控（各自让哪条变红）
//   NC1 把 `this.close()` 挪进 `settleTo()`（#1525 的复现路径）-> 用例 1 红（遮罩被摘掉）。
//   NC2 把 `touchcancel` 重新绑到 `onSheetTouchEnd`（#1378 的原缺陷）-> 用例 1 红。
//   NC3 让取消恒吸附到 peek（丢掉 expanded 判定）-> 用例 3 红（expanded 被降成 peek）。
//
// ## 夹具
// jsdom 没有布局引擎也没有 TouchEvent 构造器，两个宿主缺口都在这里补齐：高度按元素角色桩在
// Element.prototype.getBoundingClientRect 上（瓦片 96 / 行 48 / 行容器 400 / 面板取内联 height），
// 样式注入实现自己的 COMPOSER_SHEET_CSS（padding / gap 由级联给出，用例不手写常数）；
// 触摸事件用 `new Event('touch*')` + `touches` / `changedTouches` 定义补齐。
// 假时钟：每个事件间隔 1000ms（performance.now 与 timeStamp 同源）。必须如此 —— jsdom 里
// 连续事件间隔亚毫秒，实现的速度判据会把 100px 的慢拖当成甩动，用例 2 就会「因夹具而红」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { COMPOSER_SHEET_CSS } from '../src/client/mobile/composer-sheet.css.ts'

const ATTR = {
  backdrop: 'data-dsh-composer-sheet-backdrop',
  panel: 'data-dsh-composer-sheet-panel',
  tiles: 'data-dsh-composer-sheet-tiles',
  rows: 'data-dsh-composer-sheet-rows',
  row: 'data-dsh-composer-sheet-row',
  phase: 'data-dsh-composer-sheet-phase',
  peek: 'data-dsh-composer-sheet-peek',
  max: 'data-dsh-composer-sheet-max',
  dragging: 'data-dsh-composer-sheet-dragging',
} as const

const BACKDROP = '[' + ATTR.backdrop + ']'
const PANEL = '[' + ATTR.panel + ']'
const ROW = '[' + ATTR.row + ']'
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'

/** 竖屏视口 600x1000：0.88*1000 = 880（max 是整数，断言不必四舍五入）。 */
const VIEWPORT = { width: 600, height: 1000 }
/** 度量桩的输入：瓦片排 96 / 行 48 / 行容器 400（与仓库现行 CSS 同量级）。 */
const METRICS = { tilesH: 96, rowH: 48, rowsH: 400 }
/** 每个手势事件之间的假时间（ms）。 */
const SLOW_STEP_MS = 1000
/** 手指落点（位移一律用相对量表达）。 */
const DRAG_ORIGIN = 800

let fakeClock = 0
let sheet: ComposerSheet
let styles: HTMLStyleElement | null = null
let restores: (() => void)[] = []
const origin: { w?: PropertyDescriptor; h?: PropertyDescriptor } = {}

// ---------------------------------------------------------------------------
// 度量桩与宿主缺口
// ---------------------------------------------------------------------------

/** 按元素角色给高度：实现读 rect / offsetHeight / clientHeight 都拿到同一个数。 */
function heightOf(element: Element): number {
  if (!(element instanceof Element)) return 0
  if (element.hasAttribute(ATTR.tiles)) return METRICS.tilesH
  if (element.hasAttribute(ATTR.rows)) return METRICS.rowsH
  if (element.hasAttribute(ATTR.row)) return METRICS.rowH
  if (element.hasAttribute(ATTR.panel)) return Number.parseFloat((element as HTMLElement).style.height) || 0
  return 0
}

function installHeights(): void {
  const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element): DOMRect {
      const height = heightOf(this)
      return {
        x: 0, y: 0, top: 0, left: 0, right: 360, bottom: height, width: 360, height,
        toJSON: () => ({}),
      } as DOMRect
    } as () => DOMRect,
  )
  const offsetSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement): number { return heightOf(this) },
  )
  const clientSpy = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(
    function (this: Element): number { return heightOf(this) },
  )
  restores.push(() => {
    rectSpy.mockRestore()
    offsetSpy.mockRestore()
    clientSpy.mockRestore()
  })
}

function applyStyles(): void {
  styles?.remove()
  styles = document.createElement('style')
  styles.textContent = COMPOSER_SHEET_CSS
  document.head.append(styles)
}

/** 假时钟：performance.now 与事件 timeStamp 同源。 */
function installClock(): void {
  fakeClock = 0
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => fakeClock)
  restores.push(() => spy.mockRestore())
}

/** 装 matchMedia（jsdom 没有它；真机一定有）。 */
function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): unknown => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// ---------------------------------------------------------------------------
// 上游夹具（形状照 ui-conversation/InputBar + ui-input-trigger/MenuView）
// ---------------------------------------------------------------------------

function option(label: string): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.setAttribute('role', 'option')
  item.setAttribute('aria-label', label)
  const name = document.createElement('span')
  name.className = 'MenuView_itemName'
  name.textContent = label
  item.append(name)
  return item
}

/** 搭上游合成器：「+」点开后在卡片里挂 role=listbox（行由实现自己映射）。 */
function buildComposer(labels: readonly string[] = ['目标', '计划', '反馈']): void {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const editor = document.createElement('div')
  editor.setAttribute('data-composer-input', '')
  editor.setAttribute('contenteditable', 'true')
  card.append(editor)
  const add = document.createElement('button')
  add.type = 'button'
  add.setAttribute('aria-haspopup', 'listbox')
  add.setAttribute('aria-expanded', 'false')
  card.append(add)
  add.addEventListener('click', () => {
    if (card.querySelector('[role="listbox"]') !== null) return
    const surface = document.createElement('div')
    surface.setAttribute('data-trigger-menu', '')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    for (const label of labels) list.append(option(label))
    surface.append(list)
    card.append(surface)
  })
  document.body.append(card)
}

/** 让出若干轮宏任务（实现映射行、重算几何都在微/宏任务里）。 */
async function flush(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
}

/** 打开 sheet 并等到映射行落进面板（真实行高存在）。 */
async function openSheet(): Promise<void> {
  sheet.attach()
  document.querySelector<HTMLElement>(ADD)!.click()
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    if (document.querySelector(ROW) !== null) break
  }
  await flush()
}

// ---------------------------------------------------------------------------
// 面板事实读取
// ---------------------------------------------------------------------------

function panelEl(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(PANEL)
  expect(panel, '面板必须存在').not.toBeNull()
  return panel!
}

function backdropEl(): HTMLElement {
  const backdrop = document.querySelector<HTMLElement>(BACKDROP)
  expect(backdrop, '遮罩必须存在').not.toBeNull()
  return backdrop!
}

function numberAttr(element: Element, attr: string): number {
  const value = Number.parseFloat((element.getAttribute(attr) ?? '').trim())
  expect(Number.isFinite(value), '[' + attr + '] 读不到数值').toBe(true)
  return value
}

function heightPx(): number { return Number.parseFloat(panelEl().style.height) || 0 }
function peekPx(): number { return numberAttr(panelEl(), ATTR.peek) }
function maxPx(): number { return numberAttr(panelEl(), ATTR.max) }
function phaseOf(): string | null { return panelEl().getAttribute(ATTR.phase) }

/** 面板当前的下拉位移（translateY，px）。 */
function translateYOf(element: HTMLElement): number {
  const raw = (element.style.transform || getComputedStyle(element).transform || '').trim()
  if (raw === '' || raw === 'none') return 0
  const single = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(raw)
  if (single !== null) return Number(single[1])
  const matrix = /matrix\(([^)]+)\)/.exec(raw)
  if (matrix !== null) {
    const parts = matrix[1].split(',').map((part) => Number.parseFloat(part))
    if (parts.length === 6) return parts[5]
  }
  return 0
}

// ---------------------------------------------------------------------------
// 触摸原语
// ---------------------------------------------------------------------------

type TouchPhase = 'start' | 'move' | 'end' | 'cancel'

/** 派发一次触摸事件（jsdom 没有 TouchEvent 构造器：Event + touches 定义补齐）。 */
function touchEvent(phase: TouchPhase, target: EventTarget, y: number, x = 120): void {
  fakeClock += SLOW_STEP_MS
  const kind = phase === 'start' ? 'touchstart'
    : phase === 'move' ? 'touchmove'
      : phase === 'end' ? 'touchend' : 'touchcancel'
  const event = new Event(kind, { bubbles: true, cancelable: true })
  const point = { identifier: 1, clientX: x, clientY: y }
  Object.defineProperty(event, 'timeStamp', { value: fakeClock })
  // 抬手/取消的 touches 必须为空（真机语义），changedTouches 才带落点。
  Object.defineProperty(event, 'touches', { value: kind === 'touchmove' || kind === 'touchstart' ? [point] : [] })
  Object.defineProperty(event, 'changedTouches', { value: [point] })
  target.dispatchEvent(event)
}

function startDrag(y = DRAG_ORIGIN): void { touchEvent('start', panelEl(), y) }
function moveTo(y: number): void { touchEvent('move', panelEl(), y) }
function endDrag(y: number): void { touchEvent('end', panelEl(), y) }
function cancelDrag(y: number): void { touchEvent('cancel', panelEl(), y) }

/** 一次完整的「上滑到 expanded 并松手」：把面板放进 expanded 态。 */
async function dragToExpanded(): Promise<void> {
  startDrag()
  moveTo(DRAG_ORIGIN - 400)
  endDrag(DRAG_ORIGIN - 400)
  await flush()
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = ''
  origin.w = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  origin.h = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  installHeights()
  installClock()
  applyStyles()
  installMatchMedia()
  sheet = new ComposerSheet()
})

afterEach(() => {
  sheet.detach()
  document.body.innerHTML = ''
  styles?.remove()
  styles = null
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
  for (const restore of restores.splice(0)) restore()
  if (origin.w === undefined) delete (window as unknown as { innerWidth?: unknown }).innerWidth
  else Object.defineProperty(window, 'innerWidth', origin.w)
  if (origin.h === undefined) delete (window as unknown as { innerHeight?: unknown }).innerHeight
  else Object.defineProperty(window, 'innerHeight', origin.h)
})

/**
 * 把面板往下拖过关闭阈值，然后停在「已超过阈值、尚未松手」的那一刻。
 * 返回拖拽途中的可观察事实，供三个用例共用（同一手势序列，只有收尾事件不同）。
 */
async function pullPastCloseThreshold(): Promise<{ peek: number; backdrop: HTMLElement }> {
  buildComposer()
  await openSheet()
  const peek = peekPx()
  const backdrop = backdropEl()
  expect(phaseOf()).toBe('peek')
  startDrag()
  moveTo(DRAG_ORIGIN + 20)
  moveTo(DRAG_ORIGIN + 100)
  // 前置事实：位移真的越过阈值、面板真的跟手 —— 否则「取消后不关」是白捡的。
  expect(translateYOf(panelEl())).toBe(100)
  expect(100, '下拉量必须大于关闭阈值（0.3 * peek）').toBeGreaterThan(0.3 * peek)
  return { peek, backdrop }
}

describe('sheet 手势取消不得按提交处理（issue #1525：行为判据）', () => {
  it('1 下拉超过关闭阈值后 touchcancel：面板必须不关，且吸附回取消前的 peek 落点', async () => {
    const { peek, backdrop } = await pullPastCloseThreshold()
    cancelDrag(DRAG_ORIGIN + 100)
    await flush()
    // 核心判据：系统取消不是用户松手。节点身份也要是同一块（不能被「先删再建」糊过去）。
    expect(document.querySelector(BACKDROP), '系统取消不是提交：遮罩与面板必须仍然在').toBe(backdrop)
    expect(backdrop.isConnected).toBe(true)
    expect(phaseOf()).toBe('peek')
    expect(heightPx()).toBe(peek)
    expect(translateYOf(panelEl()), '下拉位移必须归零').toBe(0)
    expect(panelEl().hasAttribute(ATTR.dragging), '拖拽标记必须摘掉').toBe(false)
  })

  it('2 同一手势序列把收尾事件换成 touchend：必须关（证明用例 1 不是「怎么都不关」）', async () => {
    await pullPastCloseThreshold()
    endDrag(DRAG_ORIGIN + 100)
    expect(document.querySelector(BACKDROP), '同样的下拉量在用户松手时必须关（阈值判据不能退化）').toBeNull()
  })

  it('3 取消发生在 expanded 态：吸附回 expanded，不掉回 peek', async () => {
    buildComposer()
    await openSheet()
    const max = maxPx()
    await dragToExpanded()
    expect(phaseOf(), '前置事实：先进入 expanded').toBe('expanded')
    expect(heightPx()).toBe(Math.round(max))
    // expanded 态下再拉一小段（仍在 peek 之上，没有 overscroll）：取消要回到 expanded。
    startDrag()
    moveTo(DRAG_ORIGIN + 40)
    expect(heightPx(), '前置事实：这一段下拉仍在 peek 之上（不产生 overscroll）').toBeGreaterThan(peekPx())
    cancelDrag(DRAG_ORIGIN + 40)
    await flush()
    expect(document.querySelector(BACKDROP)).not.toBeNull()
    expect(phaseOf(), '取消的落点按取消前的形态算：expanded 不许被降成 peek').toBe('expanded')
    expect(heightPx()).toBe(Math.round(max))
    expect(translateYOf(panelEl())).toBe(0)
  })
})
