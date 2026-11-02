// @vitest-environment jsdom
// 竖屏底部 sheet 的**两段式手势**（peek <-> expanded）契约用例。
//
// 这份文件先于实现落地：判据只取契约，不迁就当前「居中卡片」形态。逐条对应契约：
//   1. 竖屏（documentElement 带 data-dsh-mobile-form）：backdrop form="sheet"；
//      panel 带 phase(peek|expanded)、内联 style.height(px)、peek(px)、max(px)；
//      panel 内没有关闭叉，有抓手；横屏（无 marker）：form="card"、有叉、无抓手、
//      不写内联 height、不装手势。
//   2. peek = padTop + handleH + tilesH + gap + 2.5*rowH + padBottom + safeBottom
//      （rowH 取第一条真实行高，拿不到用 46；safeBottom 取 --dsh-sheet-safe-bottom，缺省 0）。
//      **契约修订（spec-author 记）**：原式没有 handleH 项，但把手是面板内容里的真实一块
//      （rect + marginTop + marginBottom：jsdom 无布局 rect=0，只算外边距 4+6=10；设备上量到 14）；
//      不写进 peek 就会被瓦片压住。
//      判据按「面板内容高度之和」取：把手怎么表达（内联高度 / 外边距 / 折进 padding）都认，
//      只要 peek 等于真实内容高度。其余项与阈值一个字没动。
//   3. max = 0.88 * (visualViewport.height || innerHeight)，且 max >= peek。
//   4. 方向锁 8px：前 8px 不改高度、不判定归属；归属 = rows.scrollTop>0 归列表（高度不变），
//      scrollTop===0 上滑归 sheet（height = min(max, startH + (-dy))，1:1），
//      scrollTop===0 下滑且 startH>peek 时 height = max(peek, startH - dy)。
//   5. 到 max 继续上滑：高度保持 max，改由 rows.scrollTop 增加（交回列表）。
//   6. 下滑到 peek 后继续下拉：panel translateY(extra) 跟手；松手 extra > 0.3*peek -> 关闭，
//      否则回到 peek。
//   7. 松手吸附：按最终高度与 (peek+max)/2 比较变 peek|expanded 并写回 style.height；
//      prefers-reduced-motion: reduce 下不加过渡。
//   8. 三条关闭路径（下拉超阈值 / 点遮罩 / popstate）共用同一个 close()：
//      backdrop 先挂 data-dsh-composer-sheet-leaving 再移除。
//   9. 层级与事件：backdrop z-index 2147483100 高于页面内容；backdrop 与 panel 的
//      pointer-events 都不是 none；行列表 overflow-y: auto。
//
// ## 度量夹具（jsdom 没有布局引擎，这里定义唯一的输入通道）
//   - 注入**真实样式表** COMPOSER_SHEET_CSS：padding / gap / overflow / z-index 全部由实现自己的
//     级联给出，用例不手写这些常数（改 CSS 时期望值自动跟着走）。
//   - 高度按**元素角色**桩在 Element / HTMLElement 原型上，getBoundingClientRect / offsetHeight /
//     clientHeight 三个通道给同一个数：瓦片排 96、行 48（设 0 表示「拿不到」）、行容器 400；
//     panel 的高度就是它当前的内联 height（所以 startH 无论从哪条通道读都一致）。
//   - --dsh-sheet-safe-bottom 同时写在 documentElement 内联与一条命中 html/body/backdrop/panel/rows
//     的规则上：jsdom 不继承自定义属性，两个通道都铺，实现读哪个元素都拿得到。
//   - matchMedia 默认装成 matches=false（真机一定有它；不装会让实现读到 undefined 而假失败），
//     reduce 用例再单独装成 true。Element.prototype.scrollTo 也补一个只写 scrollTop 的桩
//     （jsdom 没实现它，这是宿主缺口，不是实现缺陷）。visualViewport 桩带 addEventListener /
//     removeEventListener（实现会往它上面挂 resize/scroll）。
//   - 假时钟：每个手势事件间隔 1000ms（performance.now 与 event.timeStamp 同源）。必须如此 ——
//     jsdom 里连续事件间隔亚毫秒，实现的速度判据会把 20px 慢拖当成甩动直接关（夹具噪声）。
//   - 视觉数值只在一处钉：PORTRAIT_PADDING（4/16/12）由 A 段那一条断言；几何用例一律现读
//     getComputedStyle，调视觉不会假红。
//   - 吸附动效只按**脚本可见**的事实判：`data-dsh-composer-sheet-settling` 标记（挂 backdrop 或 panel 都认）
//     或 panel 内联 transition 里带时长。reduce 下两者都不许出现 —— jsdom 不评估 CSS 媒体查询，
//     所以「CSS 里写了 reduce 规则」在这里不算数，脚本必须自己走瞬时路径（契约 7 的 matchMedia 判据）。
//
// ## 契约修订（两处，均已在对应用例里注明理由）
//   1. peek 公式补 handleH 项（把手是面板内容里真实的一块，实测 10px；见 D 段注释）。
//   2. 手势事件原语由 pointerdown 改为 touchstart/touchmove/touchend —— 为了保住行列表的原生
//      滚动（pointer 路线必须 touch-action:none 才能压住原生滚动，那会把列表滚动一起杀掉）。
//      位移语义判据一个字没改；要换回 pointer 只需改 dragEvent() 这一个函数。
//
// ## 三条负控（各自会让哪条用例变红）
//   NC1 去掉 8px 方向锁 -> 「前 8px 不改高度」（12 号）红：第一段 5px 位移就会 1:1 改高度。
//   NC2 peek 写成固定视口比例（如 42vh = 420）-> 6 / 7 / 8 号三条红：420 与组成项之和
//       （250 / 245 / 284）互不相等。
//   NC3 关闭阈值 0.3 -> 0 -> 「松手 extra 未超阈值不关闭」（20 号）红：20px 下拉就会被误关。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { COMPOSER_SHEET_CSS } from '../src/client/mobile/composer-sheet.css.ts'

const ATTR = {
  backdrop: 'data-dsh-composer-sheet-backdrop',
  panel: 'data-dsh-composer-sheet-panel',
  tiles: 'data-dsh-composer-sheet-tiles',
  rows: 'data-dsh-composer-sheet-rows',
  row: 'data-dsh-composer-sheet-row',
  close: 'data-dsh-composer-sheet-close',
  handle: 'data-dsh-composer-sheet-handle',
  form: 'data-dsh-composer-sheet-form',
  phase: 'data-dsh-composer-sheet-phase',
  peek: 'data-dsh-composer-sheet-peek',
  max: 'data-dsh-composer-sheet-max',
  leaving: 'data-dsh-composer-sheet-leaving',
  settling: 'data-dsh-composer-sheet-settling',
} as const

const sel = (name: keyof typeof ATTR): string => '[' + ATTR[name] + ']'

const BACKDROP = sel('backdrop')
const PANEL = sel('panel')
const TILES = sel('tiles')
const ROWS = sel('rows')
const ROW = sel('row')
const CLOSE = sel('close')
const HANDLE = sel('handle')
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'

/** 竖屏视口：600x1000（0.88*1000 = 880 是整数，便于断言 max）。 */
const PORTRAIT = { width: 600, height: 1000 }
/** 横屏视口（原设备横屏量级，只用来证明「不装手势」）。 */
const LANDSCAPE = { width: 1067, height: 600 }

/** 度量夹具的默认输入：与仓库现行 CSS 一致（瓦片排 96 / 行 48 / 行间距 8）。 */
const DEFAULT_METRICS = { tilesH: 96, rowH: 48, rowsH: 400, safeBottom: 0 }
/**
 * 竖屏面板的内边距（视觉口径的唯一真源，对应 composer-sheet.css.ts 里的 padding: 4px 16px 12px）。
 *
 * 只有 A 段那一条钉它，其余几何用例一律用 getComputedStyle 现读 ——
 * 以后调视觉只改这里一处，6/7/8 不会跟着假红。
 */
const PORTRAIT_PADDING = { top: 4, right: 16, bottom: 12, left: 16 } as const
type Metrics = typeof DEFAULT_METRICS

let metrics: Metrics = { ...DEFAULT_METRICS }
/**
 * 假时钟：每个手势事件间隔 SLOW_STEP_MS。
 *
 * 实现普遍会算速度来决定「甩动直接关 / 直接展开」。jsdom 里连续派发的事件间隔亚毫秒，
 * 任何位移都会被算成极高速度（实测：20px 的慢拖被当成 20px/ms 的甩动），那是**夹具**问题
 * 而不是实现问题。这里给一条慢速时钟，让「只有距离说话」的用例语义成立；甩动用例不存在
 * 于本文件（契约里没有速度判据）。
 */
const SLOW_STEP_MS = 1000
let fakeClock = 0
let sheet: ComposerSheet
let styles: HTMLStyleElement | null = null
let restores: (() => void)[] = []
let originalSize: { w: PropertyDescriptor | undefined; h: PropertyDescriptor | undefined } = { w: undefined, h: undefined }

// ---------------------------------------------------------------------------
// 视口 / 手机形态标记
// ---------------------------------------------------------------------------

function setViewport(size: { width: number; height: number }): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: size.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: size.height })
}

function setMobileForm(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

function setLandscapeWorld(): void {
  setViewport(LANDSCAPE)
  setMobileForm(false)
}

// ---------------------------------------------------------------------------
// 度量桩：三条高度通道 + 自定义属性 + 视口 / matchMedia 宿主缺口
// ---------------------------------------------------------------------------

/** 按角色给高度：实现无论读 rect / offsetHeight / clientHeight，都拿到同一个数。 */
function heightOf(element: Element): number {
  if (!(element instanceof Element)) return 0
  if (element.hasAttribute(ATTR.tiles)) return metrics.tilesH
  if (element.hasAttribute(ATTR.rows)) return metrics.rowsH
  if (element.hasAttribute(ATTR.row)) return metrics.rowH
  if (element.hasAttribute(ATTR.panel)) {
    // 面板高度 = 它自己写下的内联 height：startH 从哪条通道读都一致。
    return Number.parseFloat((element as HTMLElement).style.height) || 0
  }
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
  // jsdom 根本没实现 scrollTo（连属性都没有，vi.spyOn 会直接抛）：自己补一个只写 scrollTop 的桩。
  // 这是宿主缺口，不是实现缺陷 —— 但实现若用 scrollTo 必须在真机上可用，所以两边都要能走通。
  const proto = Element.prototype as unknown as { scrollTo?: unknown }
  const hadScrollTo = Object.prototype.hasOwnProperty.call(proto, 'scrollTo')
  const originalScrollTo = proto.scrollTo
  Object.defineProperty(proto, 'scrollTo', {
    configurable: true,
    writable: true,
    value: function (this: Element, ...args: unknown[]): void {
      const target = args[0]
      if (typeof target === 'object' && target !== null && 'top' in (target as Record<string, unknown>)) {
        const top = Number((target as { top?: unknown }).top)
        if (Number.isFinite(top)) (this as HTMLElement).scrollTop = top
      }
    },
  })
  restores.push(() => {
    rectSpy.mockRestore()
    offsetSpy.mockRestore()
    clientSpy.mockRestore()
    if (hadScrollTo) proto.scrollTo = originalScrollTo
    else delete proto.scrollTo
  })
}

const SAFE_BOTTOM_VAR = '--dsh-sheet-safe-bottom'

/** 注入真实样式表（外加可选的自定义属性规则）。 */
function applyStyles(): void {
  styles?.remove()
  styles = document.createElement('style')
  const extra = metrics.safeBottom > 0
    ? '\nhtml, body, ' + BACKDROP + ', ' + PANEL + ', ' + ROWS + ' { ' + SAFE_BOTTOM_VAR + ': ' + metrics.safeBottom + 'px; }\n'
    : ''
  styles.textContent = COMPOSER_SHEET_CSS + extra
  document.head.append(styles)
}

/** 装 matchMedia（jsdom 没有它；真机一定有）。 */
/** 装假时钟：performance.now 与事件 timeStamp 同源，实现读哪个都拿到慢速时间轴。 */
function installClock(): void {
  fakeClock = 0
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => fakeClock)
  restores.push(() => spy.mockRestore())
}

function installMatchMedia(reducedMotion: boolean): void {
  const stub = (query: string): unknown => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: stub })
}

// ---------------------------------------------------------------------------
// 上游夹具（形状照 ui-conversation/InputBar + ui-input-trigger/MenuView）
// ---------------------------------------------------------------------------

const LABELS = ['目标', '计划', '反馈', '压缩', '权限'] as const

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

/** 搭上游合成器：「+」点开后在卡片里挂 role=listbox，编辑器根上收 Escape。 */
function buildComposer(labels: readonly string[] = LABELS): HTMLButtonElement {
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
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    card.querySelector('[data-trigger-menu]')?.remove()
  })
  document.body.append(card)
  return add
}

/** 让出若干轮宏任务（实现可能在读菜单之后重算几何）。 */
async function flush(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
}

/** 打开 sheet，并等到映射行填进去（真实行高存在）+ 几何重算结束。 */
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
  expect(panel, '面板必须存在（竖屏 form=sheet / 横屏 form=card 都要有）').not.toBeNull()
  return panel!
}

function backdropEl(): HTMLElement {
  const backdrop = document.querySelector<HTMLElement>(BACKDROP)
  expect(backdrop, '遮罩必须存在').not.toBeNull()
  return backdrop!
}

function rowsEl(): HTMLElement {
  const rows = document.querySelector<HTMLElement>(ROWS)
  expect(rows, '行列表容器必须存在').not.toBeNull()
  return rows!
}

/** 读一个「像素数值」属性，并挡住 vh / % 这类非像素写法。 */
function numberAttr(element: Element, attr: string): number {
  const raw = (element.getAttribute(attr) ?? '').trim()
  expect(raw, '[' + attr + '] 必须是像素数值，不能是 ' + JSON.stringify(raw)).not.toMatch(/vh|vw|%|em\b/)
  const value = Number.parseFloat(raw)
  expect(Number.isFinite(value), '[' + attr + '] 读不到数值：' + JSON.stringify(raw)).toBe(true)
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
  const triple = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(raw)
  if (triple !== null) return Number(triple[1])
  const matrix = /matrix\(([^)]+)\)/.exec(raw)
  if (matrix !== null) {
    const parts = matrix[1].split(',').map((part) => Number.parseFloat(part))
    if (parts.length === 6) return parts[5]
  }
  return 0
}

/** 吸附动效标记：挂在 backdrop 或 panel 上都认（实现把标记放在哪一层不影响判据）。 */
function settlingMarker(): boolean {
  const backdrop = document.querySelector<HTMLElement>(BACKDROP)
  if (backdrop !== null && backdrop.hasAttribute(ATTR.settling)) return true
  const panel = document.querySelector<HTMLElement>(PANEL)
  return panel !== null && panel.hasAttribute(ATTR.settling)
}

/** 契约里的 safeBottom：优先面板上的 --dsh-sheet-safe-bottom，再退到 documentElement，缺省 0。 */
function safeBottomOf(): number {
  const candidates: HTMLElement[] = [document.documentElement]
  const panel = document.querySelector<HTMLElement>(PANEL)
  if (panel !== null) candidates.unshift(panel)
  for (const element of candidates) {
    const inline = element.style.getPropertyValue(SAFE_BOTTOM_VAR).trim()
    if (inline !== '') return Number.parseFloat(inline) || 0
    const computed = getComputedStyle(element).getPropertyValue(SAFE_BOTTOM_VAR).trim()
    if (computed !== '') return Number.parseFloat(computed) || 0
  }
  return 0
}

/** 契约里的 rowH：第一条真实行高，拿不到用 46。 */
function measuredRowHeight(): number {
  const first = document.querySelector<HTMLElement>(ROW)
  const height = first === null ? 0 : first.getBoundingClientRect().height
  return height > 0 ? height : 46
}

/** 把手那一块占的高度：rect + 上下外边距（把手怎么摆都按真实占用算）。 */
function handleBlockHeight(): number {
  const handle = document.querySelector<HTMLElement>(HANDLE)
  if (handle === null) return 0
  const style = getComputedStyle(handle)
  return handle.getBoundingClientRect().height
    + (Number.parseFloat(style.marginTop) || 0)
    + (Number.parseFloat(style.marginBottom) || 0)
}

/** 契约里的 peek 公式；输入与实现同源（DOM/CSS），所以不写死常数。 */
function expectedPeek(): number {
  const panel = panelEl()
  const tiles = document.querySelector<HTMLElement>(TILES)!
  const rows = rowsEl()
  const panelStyle = getComputedStyle(panel)
  const padTop = Number.parseFloat(panelStyle.paddingTop) || 0
  const padBottom = Number.parseFloat(panelStyle.paddingBottom) || 0
  // 瓦片排与行列表之间的间距：现行 CSS 里行容器 margin-top = 10px、瓦片排 gap = 10px（同值），
  // 取到哪一个都不改期望值 —— 断言不该绑死在某个属性选择上。
  const gap = Number.parseFloat(getComputedStyle(rows).marginTop) || Number.parseFloat(getComputedStyle(tiles).gap) || 0
  const tilesH = tiles.getBoundingClientRect().height
  return padTop + handleBlockHeight() + tilesH + gap + 2.5 * measuredRowHeight() + padBottom + safeBottomOf()
}

/** 契约里的 max 公式。 */
function expectedMax(): number {
  const viewport = (window as unknown as { visualViewport?: { height?: number } }).visualViewport
  const height = viewport?.height ?? 0
  return 0.88 * (height > 0 ? height : window.innerHeight)
}

// ---------------------------------------------------------------------------
// 手势原语（touch*：jsdom 没有 TouchEvent 构造器，用 Event + touches 定义补齐，与
// sidebar-gestures.spec.ts 同一套写法）
// ---------------------------------------------------------------------------

type DragPhase = 'start' | 'move' | 'end'

/**
 * 派发一次触摸事件。
 *
 * **原语说明（契约修订，spec-author 记）**：契约原文写的是 pointerdown 落在 panel。
 * 落地时改成 touch*，理由是这个手势必须**保留行列表的原生滚动**：pointer 路线要
 * touch-action: none 才能压住原生滚动，而那会连行列表的滚动一起杀掉（列表就得全程由脚本
 * 手搓）；touchmove + 只在「归 sheet」时 preventDefault 才能既跟手又留原生滚动。
 * **语义判据一个字没改**：起手/移动/松手的位移关系、8px 方向锁、归属、交接、吸附都一样。
 * 如果后续决定改回 pointer（要 mouse/pen 也跟手），只需换掉这一个函数。
 */
function dragEvent(phase: DragPhase, target: EventTarget, y: number, x = 120): void {
  fakeClock += SLOW_STEP_MS
  const kind = phase === 'start' ? 'touchstart' : phase === 'move' ? 'touchmove' : 'touchend'
  const event = new Event(kind, { bubbles: true, cancelable: true })
  const point = { identifier: 1, clientX: x, clientY: y }
  Object.defineProperty(event, 'timeStamp', { value: fakeClock })
  // touchend 的 touches 必须为空（真机语义），changedTouches 才带落点。
  Object.defineProperty(event, 'touches', { value: kind === 'touchend' ? [] : [point] })
  Object.defineProperty(event, 'changedTouches', { value: [point] })
  target.dispatchEvent(event)
}

/** 手指落在面板上（起点 y 固定 800，位移由 moveTo 的相对量表达）。 */
const DRAG_ORIGIN = 800
function startDrag(y = DRAG_ORIGIN): void { dragEvent('start', panelEl(), y) }
function moveTo(y: number): void { dragEvent('move', panelEl(), y) }
function endDrag(y: number): void { dragEvent('end', panelEl(), y) }

/** 一次完整的「上滑到 expanded 并松手」：用于把面板放进 expanded 态。 */
async function dragToExpanded(): Promise<void> {
  startDrag()
  moveTo(DRAG_ORIGIN - 400) // peek(250) + 400 = 650 > (250+880)/2 = 565
  endDrag(DRAG_ORIGIN - 400)
  await flush()
}

/**
 * 记录 close() 是否**先挂 leaving 再移除**（jsdom 没有 WAAPI，实现走「立刻移除」那条路，
 * 所以这里装一个假 getAnimations 来读调用瞬间的标记状态）。
 */
function probeLeaving(backdrop: HTMLElement): { calls: number; sawLeaving: boolean | null } {
  const probe: { calls: number; sawLeaving: boolean | null } = { calls: 0, sawLeaving: null }
  Object.defineProperty(backdrop, 'getAnimations', {
    configurable: true,
    value: () => {
      probe.calls += 1
      probe.sawLeaving = backdrop.hasAttribute(ATTR.leaving)
      return []
    },
  })
  return probe
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

beforeEach(() => {
  metrics = { ...DEFAULT_METRICS }
  document.body.innerHTML = ''
  originalSize = {
    w: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
    h: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
  }
  setViewport(PORTRAIT)
  setMobileForm(true)
  installHeights()
  installClock()
  applyStyles()
  installMatchMedia(false)
  sheet = new ComposerSheet()
})

afterEach(() => {
  sheet.detach()
  document.body.innerHTML = ''
  styles?.remove()
  styles = null
  document.documentElement.removeAttribute(SAFE_BOTTOM_VAR)
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  delete (window as unknown as { visualViewport?: unknown }).visualViewport
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
  for (const restore of restores.splice(0)) restore()
  if (originalSize.w === undefined) delete (window as unknown as { innerWidth?: unknown }).innerWidth
  else Object.defineProperty(window, 'innerWidth', originalSize.w)
  if (originalSize.h === undefined) delete (window as unknown as { innerHeight?: unknown }).innerHeight
  else Object.defineProperty(window, 'innerHeight', originalSize.h)
})

// ---------------------------------------------------------------------------
// A. 夹具自检（度量输入可读，常数透明）
// ---------------------------------------------------------------------------

describe('A. 夹具自检：视觉口径钉子与度量通道', () => {
  it('1 面板内边距 = 4/16/12，且 peek = 4 + 10 + 96 + 8 + 120 + 12 + 0 = 250', async () => {
    buildComposer()
    await openSheet()
    const panel = panelEl()
    const style = getComputedStyle(panel)
    // **整个文件里唯一钉视觉数值的地方**（真源 = PORTRAIT_PADDING）。
    // 改 padding 只该改这条与那个常量；6/7/8 走公式，不会跟着假红。
    expect([
      Number.parseFloat(style.paddingTop),
      Number.parseFloat(style.paddingRight),
      Number.parseFloat(style.paddingBottom),
      Number.parseFloat(style.paddingLeft),
    ]).toEqual([PORTRAIT_PADDING.top, PORTRAIT_PADDING.right, PORTRAIT_PADDING.bottom, PORTRAIT_PADDING.left])
    // 度量通道自检：三个高度通道同一套桩。jsdom 没有布局，把手 rect = 0，
    // 所以把手那一块只算外边距 4 + 6 = 10（设备上量到 14，差的正是把手自身的 4px）。
    expect([
      handleBlockHeight(),
      document.querySelector<HTMLElement>(TILES)!.getBoundingClientRect().height,
      Number.parseFloat(getComputedStyle(rowsEl()).marginTop),
      measuredRowHeight(),
      safeBottomOf(),
    ]).toEqual([10, 96, 8, 48, 0])
    // 由这些输入推出的 peek：4 + 10 + 96 + 8 + 2.5*48 + 12 + 0 = 250。
    expect(expectedPeek()).toBe(250)
    expect(peekPx()).toBe(250)
    expect(expectedMax()).toBe(880)
  })
})

// ---------------------------------------------------------------------------
// B. 竖屏 sheet 形态
// ---------------------------------------------------------------------------

describe('B. 竖屏：sheet 形态发布的事实', () => {
  it('2 backdrop form="sheet"；panel 带 phase=peek、内联 height、peek、max', async () => {
    buildComposer()
    await openSheet()
    expect(backdropEl().getAttribute(ATTR.form)).toBe('sheet')
    expect(phaseOf()).toBe('peek')
    expect(panelEl().style.height).toMatch(/^\d+(\.\d+)?px$/)
    expect(heightPx()).toBe(peekPx())
    expect(peekPx()).toBeGreaterThan(0)
    expect(maxPx()).toBeGreaterThanOrEqual(peekPx())
  })

  it('3 竖屏没有关闭叉，有抓手', async () => {
    buildComposer()
    await openSheet()
    // 判据按契约字面只落在 panel 内（sheet 形态的关闭靠下拉 / 遮罩 / 系统返回）。
    expect(panelEl().querySelector(CLOSE)).toBeNull()
    expect(panelEl().querySelector(HANDLE)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// C. 横屏 card 形态（对照：不装手势）
// ---------------------------------------------------------------------------

describe('C. 横屏：仍是居中卡片，不装手势', () => {
  it('4 backdrop form="card"、有关闭叉、无抓手、无内联 height / phase / peek / max', async () => {
    setLandscapeWorld()
    buildComposer()
    await openSheet()
    expect(backdropEl().getAttribute(ATTR.form)).toBe('card')
    expect(panelEl().querySelector(CLOSE)).not.toBeNull()
    expect(backdropEl().querySelector(HANDLE)).toBeNull()
    expect(panelEl().style.height).toBe('')
    expect(panelEl().hasAttribute(ATTR.phase)).toBe(false)
    expect(panelEl().hasAttribute(ATTR.peek)).toBe(false)
    expect(panelEl().hasAttribute(ATTR.max)).toBe(false)
  })

  it('5 横屏不装手势：上下拖动都不改高度、不出位移、不出 phase', async () => {
    setLandscapeWorld()
    buildComposer()
    await openSheet()
    startDrag()
    moveTo(DRAG_ORIGIN - 200)
    moveTo(DRAG_ORIGIN + 200)
    endDrag(DRAG_ORIGIN + 200)
    await flush()
    expect(panelEl().style.height).toBe('')
    expect(translateYOf(panelEl())).toBe(0)
    expect(panelEl().hasAttribute(ATTR.phase)).toBe(false)
    expect(document.querySelector(BACKDROP)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D. peek 几何
// ---------------------------------------------------------------------------

describe('D. peek = padTop + handleH + tilesH + gap + 2.5*rowH + padBottom + safeBottom', () => {
  it('6 用第一条真实行高（48）：peek 等于公式值，且 height 就是 peek', async () => {
    buildComposer()
    await openSheet()
    // 不断言绝对像素：期望值由 getComputedStyle + 夹具桩现算（视觉口径变了也不会假红）。
    expect(measuredRowHeight()).toBe(DEFAULT_METRICS.rowH)
    expect(peekPx()).toBe(expectedPeek())
    expect(heightPx()).toBe(peekPx())
  })

  it('7 拿不到真实行高时回退 46（peek 相应少 2.5*(48-46) = 5）', async () => {
    metrics.rowH = 0 // 行元素量不到高度（折叠 / 未布局）
    buildComposer()
    await openSheet()
    expect(measuredRowHeight()).toBe(46)
    expect(peekPx()).toBe(expectedPeek())
    // 反证：回退确实进了公式 —— 若实现忽略回退（按 0 行高算），peek 会少 2.5*46。
    expect(peekPx()).toBeGreaterThan(expectedPeek() - 2.5 * 46)
    // 而且必须比「真实行高」的世界低 5px（同一夹具，只换行高）。
    expect(expectedPeek() + 2.5 * (DEFAULT_METRICS.rowH - 46)).not.toBe(peekPx())
  })

  it('8 safeBottom 取 --dsh-sheet-safe-bottom（34）：peek 只涨 34', async () => {
    metrics.safeBottom = 34
    applyStyles()
    buildComposer()
    await openSheet()
    const panelStyle = getComputedStyle(panelEl())
    expect(safeBottomOf()).toBe(34)
    expect(peekPx()).toBe(expectedPeek())
    // 安全区只计一次：它由 peek 公式加，**不许**同时折进 padding（旧写法会多算一遍）。
    expect(Number.parseFloat(panelStyle.paddingBottom)).toBe(PORTRAIT_PADDING.bottom)
    expect(Number.parseFloat(panelStyle.paddingTop)).toBe(PORTRAIT_PADDING.top)
  })

  it('8b 缺省（没有 --dsh-sheet-safe-bottom）时安全区为 0，peek 里也不留残余', async () => {
    buildComposer()
    await openSheet()
    expect(safeBottomOf()).toBe(0)
    // 缺省世界与「声明 34」的世界必须刚好差 34 —— 差更多就是重复计了安全区。
    expect(expectedPeek()).toBe(
      PORTRAIT_PADDING.top + handleBlockHeight()
      + document.querySelector<HTMLElement>(TILES)!.getBoundingClientRect().height
      + Number.parseFloat(getComputedStyle(rowsEl()).marginTop)
      + 2.5 * measuredRowHeight()
      + PORTRAIT_PADDING.bottom
      + 0,
    )
    expect(peekPx()).toBe(expectedPeek())
  })

  it('9 NC2 负控：peek 写成固定视口比例（42vh = 420）与组成项之和必然不等', async () => {
    buildComposer()
    await openSheet()
    const vhPeek = Math.round(0.42 * window.innerHeight) // 420
    const realPeek = expectedPeek() // 250
    // 判据能区分：写 vh 的实现给出的 420 与 250 不等，6/7/8 三条必红。
    expect(vhPeek).not.toBe(realPeek)
    expect(vhPeek).toBe(420)
    expect(peekPx()).toBe(realPeek)
  })
})

// ---------------------------------------------------------------------------
// E. max 几何
// ---------------------------------------------------------------------------

describe('E. max = 0.88 * (visualViewport.height || innerHeight)', () => {
  it('10 没有 visualViewport 时用 innerHeight（1000 -> 880），且 max >= peek', async () => {
    buildComposer()
    await openSheet()
    expect(expectedMax()).toBe(880)
    expect(Math.abs(maxPx() - 880)).toBeLessThanOrEqual(1)
    expect(maxPx()).toBeGreaterThanOrEqual(peekPx())
  })

  it('11 有 visualViewport 时用它的高度（800 -> 704），不看 innerHeight', async () => {
    // 真机的 visualViewport 是事件目标：实现会往它上面挂 resize/scroll。jsdom 没有它，
    // 桩必须连 addEventListener/removeEventListener 一起给（否则 detach 会抛，属夹具缺口）。
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 800,
        offsetTop: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })
    buildComposer()
    await openSheet()
    expect(expectedMax()).toBe(704)
    expect(Math.abs(maxPx() - 704)).toBeLessThanOrEqual(1)
    expect(maxPx()).toBeLessThan(Math.round(0.88 * window.innerHeight))
    expect(maxPx()).toBeGreaterThanOrEqual(peekPx())
  })
})

// ---------------------------------------------------------------------------
// F. 方向锁与归属
// ---------------------------------------------------------------------------

describe('F. 8px 方向锁与归属判定', () => {
  it('12 前 8px 不改高度，越过 8px 才 1:1 跟手（同一手势内两段都要成立）', async () => {
    buildComposer()
    await openSheet()
    const before = heightPx()
    startDrag()
    moveTo(DRAG_ORIGIN - 5)
    const afterFive = heightPx()
    moveTo(DRAG_ORIGIN - 7)
    const afterSeven = heightPx()
    // 锁内：一点都不动。
    expect(afterFive).toBe(before)
    expect(afterSeven).toBe(before)
    // 越过锁之后必须真的动起来：只断言「锁内不动」在**完全没有手势**时也成立，
    // 那样这条用例证明不了方向锁存在（只是证明了没有手势）。
    moveTo(DRAG_ORIGIN - 60)
    expect(heightPx()).toBe(before + 60)
    endDrag(DRAG_ORIGIN - 60)
  })

  it('13 NC1 负控：去掉方向锁后，这条判据必然变红', async () => {
    buildComposer()
    await openSheet()
    const before = heightPx()
    startDrag()
    moveTo(DRAG_ORIGIN - 5)
    const locked = heightPx()
    expect(locked).toBe(before)
    // 没有锁的实现会立刻 1:1 跟手：before + 5 与观测值必须不等，否则这条断言证明不了任何事。
    expect(before + 5).not.toBe(locked)
  })

  it('14 归属看 rows.scrollTop：>0 归列表（高度不变），回到 0 后归 sheet（高度涨）', async () => {
    buildComposer()
    await openSheet()
    const before = heightPx()
    // 第一段：列表已经滚过 -> 列表拥有手势，sheet 不许抢。
    rowsEl().scrollTop = 40
    startDrag()
    moveTo(DRAG_ORIGIN - 100)
    const during = heightPx()
    moveTo(DRAG_ORIGIN - 180)
    const later = heightPx()
    expect(during).toBe(before)
    expect(later).toBe(before)
    endDrag(DRAG_ORIGIN - 180)
    // 列表自己的滚动位置由原生滚动负责，这里只钉「sheet 没抢」。
    expect(rowsEl().scrollTop).toBe(40)
    // 第二段：同一个面板，scrollTop 归零后同一手势必须归 sheet ——
    // 没有这一段的话，上面两条在「根本没有手势」时也成立，证明不了归属判定。
    rowsEl().scrollTop = 0
    startDrag()
    moveTo(DRAG_ORIGIN - 100)
    expect(heightPx()).toBe(before + 100)
    endDrag(DRAG_ORIGIN - 100)
  })

  it('15 scrollTop===0 上滑：sheet 拥有，1:1 跟手（位移 -60 -> 高度 +60，-160 -> +160）', async () => {
    buildComposer()
    await openSheet()
    const before = heightPx()
    expect(rowsEl().scrollTop).toBe(0)
    startDrag()
    moveTo(DRAG_ORIGIN - 60)
    expect(heightPx()).toBe(before + 60)
    moveTo(DRAG_ORIGIN - 160)
    expect(heightPx()).toBe(before + 160)
    endDrag(DRAG_ORIGIN - 160)
    await flush()
    // 250+160 = 410 低于中点 565 -> 吸附回 peek（1:1 只是拖动过程，松手由 8 号契约决定）。
    expect(phaseOf()).toBe('peek')
    expect(heightPx()).toBe(peekPx())
  })

  it('16 scrollTop===0 下滑且 startH>peek：height = max(peek, startH - dy)', async () => {
    buildComposer()
    await openSheet()
    await dragToExpanded()
    const startH = heightPx()
    expect(startH).toBe(Math.round(maxPx()))
    startDrag()
    moveTo(DRAG_ORIGIN + 100)
    expect(heightPx()).toBe(startH - 100)
    moveTo(DRAG_ORIGIN + 300)
    expect(heightPx()).toBe(startH - 300)
    endDrag(DRAG_ORIGIN + 300)
    await flush()
    expect(phaseOf()).toBe('expanded') // 580/480 都高于中点
  })
})

// ---------------------------------------------------------------------------
// G. 到 max 继续上滑
// ---------------------------------------------------------------------------

describe('G. 到 max 继续上滑：交回列表', () => {
  it('17 高度停在 max，超出部分转成 rows.scrollTop', async () => {
    buildComposer()
    await openSheet()
    const startH = heightPx()
    const max = maxPx()
    rowsEl().scrollTop = 0
    startDrag()
    // 先把高度顶到 max，再多滑 120px。
    moveTo(DRAG_ORIGIN - (max - startH) - 120)
    expect(heightPx()).toBe(Math.round(max))
    expect(rowsEl().scrollTop).toBeGreaterThan(0)
    moveTo(DRAG_ORIGIN - (max - startH) - 220)
    expect(heightPx()).toBe(Math.round(max))
    endDrag(DRAG_ORIGIN - (max - startH) - 220)
  })
})

// ---------------------------------------------------------------------------
// H. peek 之下继续下拉
// ---------------------------------------------------------------------------

describe('H. 到 peek 后继续下拉：跟手 / 阈值 / 回弹', () => {
  it('18 下拉量在 peek 之下跟手：panel translateY(extra)', async () => {
    buildComposer()
    await openSheet()
    const peek = peekPx()
    startDrag()
    moveTo(DRAG_ORIGIN + 40)
    expect(heightPx()).toBe(peek) // 高度已经到底，不再变
    expect(translateYOf(panelEl())).toBe(40)
    moveTo(DRAG_ORIGIN + 60)
    expect(translateYOf(panelEl())).toBe(60)
    endDrag(DRAG_ORIGIN + 60)
    await flush()
    // 60 < 0.3*250 = 75 -> 不关闭、回弹到 peek、位移归零。
    expect(document.querySelector(BACKDROP)).not.toBeNull()
    expect(translateYOf(panelEl())).toBe(0)
    expect(heightPx()).toBe(peek)
    expect(phaseOf()).toBe('peek')
  })

  it('19 松手 extra > 0.3*peek：关闭', async () => {
    buildComposer()
    await openSheet()
    const peek = peekPx()
    // 先证 peek 与公式一致（关闭之后面板已经不在 DOM 里，就再也读不到了）。
    expect(peek).toBe(expectedPeek())
    startDrag()
    moveTo(DRAG_ORIGIN + 100) // 100 > 0.3*250 = 75
    expect(translateYOf(panelEl())).toBe(100)
    endDrag(DRAG_ORIGIN + 100)
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('20 NC3 负控：阈值 0.3 -> 0 时，「未超阈值不关闭」必然变红', async () => {
    buildComposer()
    await openSheet()
    const peek = peekPx()
    const threshold = 0.3 * peek
    startDrag()
    moveTo(DRAG_ORIGIN + 20) // 20 -> 真跟手已经发生
    expect(translateYOf(panelEl())).toBe(20)
    // 20 必须落在「不关闭」的带子里：若阈值退化成 0，20 > 0 就会关掉，
    // 下面这条「仍开着」的断言随之变红。
    expect(20).toBeLessThan(threshold)
    expect(20).toBeGreaterThan(0)
    endDrag(DRAG_ORIGIN + 20)
    await flush()
    expect(document.querySelector(BACKDROP)).not.toBeNull()
    expect(phaseOf()).toBe('peek')
  })
})

// ---------------------------------------------------------------------------
// I. 松手吸附与减少动态
// ---------------------------------------------------------------------------

describe('I. 松手吸附与 prefers-reduced-motion', () => {
  it('21 最终高度高于 (peek+max)/2：phase=expanded 且写回 max 高度', async () => {
    buildComposer()
    await openSheet()
    const midpoint = (peekPx() + maxPx()) / 2
    startDrag()
    moveTo(DRAG_ORIGIN - 400) // 658 > 569
    expect(heightPx()).toBeGreaterThan(midpoint)
    endDrag(DRAG_ORIGIN - 400)
    await flush()
    expect(phaseOf()).toBe('expanded')
    expect(heightPx()).toBe(Math.round(maxPx()))
    expect(translateYOf(panelEl())).toBe(0)
  })

  it('22 最终高度低于中点：phase=peek 且写回 peek 高度', async () => {
    buildComposer()
    await openSheet()
    const peek = peekPx()
    startDrag()
    moveTo(DRAG_ORIGIN - 120) // 378 < 569
    endDrag(DRAG_ORIGIN - 120)
    await flush()
    expect(phaseOf()).toBe('peek')
    expect(heightPx()).toBe(peek)
  })

  it('23 正常动效：吸附打开过渡（settling 标记或内联 transition 二选一）', async () => {
    buildComposer()
    await openSheet()
    startDrag()
    moveTo(DRAG_ORIGIN - 400)
    endDrag(DRAG_ORIGIN - 400)
    await flush()
    // 两种实现都接受：标记驱动（CSS 负责过渡）或脚本直接写内联 transition。
    // 都不出现 = 吸附是瞬间跳变，用户看不到「弹回/展开」的过程。
    expect(settlingMarker() || /\d+\s*m?s/.test(panelEl().style.transition)).toBe(true)
  })

  it('24 prefers-reduced-motion: reduce：吸附不加过渡，但高度照样写回', async () => {
    installMatchMedia(true)
    buildComposer()
    await openSheet()
    startDrag()
    moveTo(DRAG_ORIGIN - 400)
    endDrag(DRAG_ORIGIN - 400)
    await flush()
    // 吸附语义不变（高度/phase 照写），只是不许有过渡 —— jsdom 不评估 CSS 媒体查询，
    // 所以这条必须由脚本自己走瞬时路径（reduce 下不打开动画）。
    expect(phaseOf()).toBe('expanded')
    expect(heightPx()).toBe(Math.round(maxPx()))
    expect(settlingMarker()).toBe(false)
    expect(panelEl().style.transition).not.toMatch(/\d+\s*m?s/)
  })
})

// ---------------------------------------------------------------------------
// J. 三条关闭路径共用同一个 close()
// ---------------------------------------------------------------------------

describe('J. 三条关闭路径同一 close()：先挂 leaving 再移除', () => {
  it('25 下拉超阈值：leaving 先于移除', async () => {
    buildComposer()
    await openSheet()
    const probe = probeLeaving(backdropEl())
    startDrag()
    moveTo(DRAG_ORIGIN + 120)
    endDrag(DRAG_ORIGIN + 120)
    expect(probe.calls).toBe(1)
    expect(probe.sawLeaving).toBe(true)
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('26 点遮罩：leaving 先于移除', async () => {
    buildComposer()
    await openSheet()
    const probe = probeLeaving(backdropEl())
    backdropEl().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    expect(probe.calls).toBe(1)
    expect(probe.sawLeaving).toBe(true)
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('27 popstate：leaving 先于移除', async () => {
    buildComposer()
    await openSheet()
    const probe = probeLeaving(backdropEl())
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(probe.calls).toBe(1)
    expect(probe.sawLeaving).toBe(true)
    expect(document.querySelector(BACKDROP)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// K. 层级与事件
// ---------------------------------------------------------------------------

describe('K. 层级与事件', () => {
  it('28 backdrop z-index 2147483100 高于页面内容，且 backdrop 与 panel 都接事件', async () => {
    const page = document.createElement('div')
    page.style.zIndex = '10'
    document.body.append(page)
    buildComposer()
    await openSheet()
    const backdrop = backdropEl()
    const zIndex = Number.parseFloat(getComputedStyle(backdrop).zIndex) || 0
    expect(zIndex).toBe(2147483100)
    expect(zIndex).toBeGreaterThan(Number.parseFloat(getComputedStyle(page).zIndex) || 0)
    expect(getComputedStyle(backdrop).pointerEvents).not.toBe('none')
    expect(getComputedStyle(panelEl()).pointerEvents).not.toBe('none')
  })

  it('29 行列表是滚动容器（overflow-y: auto），面板自己不是', async () => {
    buildComposer()
    await openSheet()
    const rows = rowsEl()
    const computed = getComputedStyle(rows).overflowY
    if (computed === '') {
      // jsdom 拿不到 computed 时的兜底：样式表文本必须写着这条。
      expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-rows\]\s*\{[^}]*overflow-y:\s*auto/)
    } else {
      expect(computed).toBe('auto')
    }
    const panelOverflow = getComputedStyle(panelEl()).overflowY
    if (panelOverflow !== '') expect(panelOverflow).not.toBe('auto')
  })
})