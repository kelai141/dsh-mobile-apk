// @vitest-environment jsdom
// 竖屏底部 sheet 拖拽的**强制同步布局次数**契约（流畅度审计 Top 1）。
//
// 为什么单独立一份用例：现有 composer-sheet-two-stage.spec.ts 钉的是**几何数值**
// （peek/max/阈值一个字不许变），这份钉的是**代价**——同一个拖拽到底读了几次几何。
// 两件事必须分开断言，否则改性能时几何回归会被淹没在性能用例里。
//
// ## 计数器替身
//   jsdom 没有布局引擎，本来就要桩几何。这里把 getComputedStyle / getBoundingClientRect
//   包成**计数替身**：返回值与现有夹具一致（不改变任何几何语义），只是额外记次数。
//   计数在 touchstart 之后清零，于是「一次拖拽里除首帧外还读了几次」变成可直接断言的数。
//
// ## 判据（改前 / 改后）
//   一次拖拽（1 次 touchstart + N 次 touchmove），N=6：
//     改前：每个 touchmove 调 peekHeight() + maxHeight()，
//           peekHeight = 4×getComputedStyle + 3×getBoundingClientRect，
//           maxHeight 内部又调一次 peekHeight ⇒ 每个 touchmove 8 次读 ⇒ 6×8 = 48 次几何读。
//     改后：首个 touchmove 付一次（8 次），其余 5 次全部命中 per-drag 缓存 ⇒ 仍是 8 次。
//   断言写成 8（首帧一次）+ 0（其余），而不是日志。
//
// ## 负控
//   NC1 去掉 per-drag 缓存（让 dragPeekMax 每次都现算）⇒「其余帧 0 次」红。
//   NC2 把缓存做成跨拖共享（不在 touchstart 失效）⇒「第二次拖拽仍从 0 开始」红。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { COMPOSER_SHEET_CSS } from '../src/client/mobile/composer-sheet.css.ts'

const PANEL = '[data-dsh-composer-sheet-panel]'
const ROWS = '[data-dsh-composer-sheet-rows]'
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'

/** 计数替身：所有几何读取都过这里，语义与既有夹具一致。 */
let gcsCalls = 0
let gbcrCalls = 0
let counting = false

function resetCounters(): void { gcsCalls = 0; gbcrCalls = 0 }
function totalReads(): number { return gcsCalls + gbcrCalls }

const realGcs = window.getComputedStyle.bind(window)
const realGbcr = Element.prototype.getBoundingClientRect

/** 与 two-stage 夹具同一套高度：瓦片 96 / 行 48 / 行容器 400。 */
function stubRect(el: Element): DOMRect {
  const h = el.matches('[data-dsh-composer-sheet-tiles]') ? 96
    : el.matches('[data-dsh-composer-sheet-row]') ? 48
    : el.matches(ROWS) ? 400
    : el.matches(PANEL) ? (Number.parseFloat((el as HTMLElement).style.height) || 0)
    : 0
  return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) } as DOMRect
}

function buildCard(): HTMLButtonElement {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const tools = document.createElement('div')
  const add = document.createElement('button')
  add.type = 'button'
  add.setAttribute('aria-haspopup', 'listbox')
  add.setAttribute('aria-expanded', 'false')
  add.setAttribute('aria-label', '添加文件或调用指令')
  tools.append(add)
  card.append(tools)
  document.body.append(card)
  return add
}

function touch(target: Element, type: string, y: number): void {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent
  const t = { clientX: 10, clientY: y, identifier: 0, target } as unknown as Touch
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [t] });
  Object.defineProperty(ev, 'changedTouches', { value: [t] });
  target.dispatchEvent(ev)
}

let sheet: ComposerSheet

beforeEach(() => {
  resetCounters(); counting = false
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pe?: string | null) => {
    if (counting) gcsCalls++
    return realGcs(el, pe as string)
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (counting) gbcrCalls++
    return stubRect(this)
  });
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  const style = document.createElement('style')
  style.textContent = COMPOSER_SHEET_CSS
  document.head.append(style)
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {},
  })
  sheet = new ComposerSheet()
  sheet.attach()
});

afterEach(() => {
  sheet.detach()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.documentElement.removeAttribute('data-dsh-mobile-form')
});

function openSheet(): HTMLElement {
  const add = buildCard()
  add.click()
  const panel = document.querySelector<HTMLElement>(PANEL)
  if (panel === null) throw new Error('sheet 未打开：找不到 panel')
  return panel
}

/** 跑一次拖拽：1 次 touchstart + n 次 touchmove，返回每帧的几何读次数。 */
function dragOnce(panel: HTMLElement, moves: number): number[] {
  touch(panel, 'touchstart', 600)
  counting = true; resetCounters()
  const perFrame: number[] = []
  let y = 600
  for (let i = 0; i < moves; i++) {
    y -= 40
    const before = totalReads()
    touch(panel, 'touchmove', y)
    perFrame.push(totalReads() - before)
  }
  touch(panel, 'touchend', y)
  counting = false
  return perFrame
}

describe('sheet 拖拽的强制同步布局次数', () => {
  it('首帧付一次，其余帧不再读几何（改前每帧 8 次）', () => {
    const panel = openSheet()
    const perFrame = dragOnce(panel, 6)

    // 改前：每帧都是 8（peekHeight 4+3，maxHeight 再调一次 peekHeight）。
    // 改后：只有第一帧付账，其余 5 帧全部命中 per-drag 缓存。
    expect(perFrame[0], '首帧必须付一次几何读（建立缓存）').toBeGreaterThan(0)
    expect(perFrame.slice(1), '首帧之后不得再读几何').toEqual([0, 0, 0, 0, 0])
    expect(
      perFrame.reduce((a, b) => a + b, 0),
      '整次拖拽的几何读总数应约等于单帧成本（改前是 6 倍）',
    ).toBeLessThanOrEqual(perFrame[0] * 2)
  })

  it('第二次拖拽重新付账（缓存不跨拖）', () => {
    const panel = openSheet()
    dragOnce(panel, 3)
    const second = dragOnce(panel, 3)
    expect(second[0], '新拖拽首帧必须重新读（不能吃到上一拖的旧值）').toBeGreaterThan(0)
    expect(second.slice(1)).toEqual([0, 0])
  })

  it('视口变化会让缓存失效（键盘弹收 / visualViewport resize）', () => {
    const panel = openSheet()
    touch(panel, 'touchstart', 600)
    counting = true; resetCounters()
    touch(panel, 'touchmove', 560)
    const first = totalReads()
    expect(first).toBeGreaterThan(0)

    // 拖拽中途键盘弹起：resize 本身就该触发重测（relayoutSheet），
    // 之后那一帧也必须重新读，不能拿旧 max。
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true })
    resetCounters()
    window.dispatchEvent(new Event('resize'))
    expect(totalReads(), 'resize 必须触发重测').toBeGreaterThan(0)

    // 判据分两层，缺一不可：
    //  1) resize 当场必须重测（上面那条已断言）；
    //  2) resize 之后面板上公布的 max 必须等于**按新视口算出的** max ——
    //     若实现把旧缓存跨视口复用，这里会停在旧值。
    // 注意 max = max(peek, 0.88 * viewportHeight)：本夹具里 peek 更大，
    // 所以视口变矮**不一定**让 max 变小；正确的判据是「等于公式值」而不是「变小」。
    const panelEl = document.querySelector<HTMLElement>(PANEL)!
    const peekAttr = Number.parseFloat(panelEl.getAttribute('data-dsh-composer-sheet-peek') ?? '0')
    const expectedMax = Math.max(peekAttr, Math.round(window.innerHeight * 0.88))
    resetCounters()
    touch(panel, 'touchmove', 520)
    const after = Number.parseFloat(panelEl.getAttribute('data-dsh-composer-sheet-max') ?? '0')
    expect(after, 'max 必须按新视口重算（缓存不得跨视口复用）').toBe(expectedMax)
    counting = false
    touch(panel, 'touchend', 520)
  })
})