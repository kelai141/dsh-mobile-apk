// @vitest-environment jsdom
// 横屏 / 桌面形态：从输入框左下角「+」展开的原生卡片。
//
// 与竖屏底部 sheet 是**同一张 panel 的两种几何**：竖屏贴底全宽（bottomGap=0），
// 横屏锚到「+」上（左边缘对齐、底边 +8px、宽 <=360、不画遮罩）。
//
// 这里钉的是几何与形态契约，不是肉眼观感：
//   1. 横屏：卡片左边缘 == 「+」左边缘（<=1px），宽度 <=360，底边距「+」顶边 8px；
//   2. 竖屏：仍是贴底 sheet，且内联几何必须被撤干净（否则 CSS 贴底失效）；
//   3. 两形态：三瓦片 + 9 行都在；
//   4. 无障碍：横屏 aria-modal=false（非模态 popover），竖屏 true；
//   5. 聚焦：打开进第一项，关闭后 activeElement 不是编辑器；
//   6. 负控：去掉锚定计算（退化成全宽贴底）时，同一批断言必须判红。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { COMPOSER_SHEET_CSS } from '../src/client/mobile/composer-sheet.css.ts'

const BACKDROP = '[data-dsh-composer-sheet-backdrop]'
const PANEL = '[data-dsh-composer-sheet-panel]'
const TILE = '[data-dsh-composer-sheet-tile]'
const ROW = '[data-dsh-composer-sheet-row]'
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'
const ANCHORED = 'data-dsh-composer-sheet-anchored'

/** 横屏手机视口（真机 MuMu 横屏是 1600x900，这里取一个典型矮视口）。 */
const LANDSCAPE = { width: 900, height: 420 }
/** 竖屏手机视口。 */
const PORTRAIT = { width: 420, height: 900 }

/**
 * 「+」在两种视口里的位置：横屏时它贴在输入框左下角，竖屏时同样在左下但更高。
 * 数值本身不重要，重要的是断言用的比对基准来自**同一个 rect**。
 */
let plusRect: { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** 上游「+」菜单的 9 项（与真机菜单同量级）。 */
const NINE: readonly (readonly [string, string | null])[] = [
  ['拍照上传', null], ['选择文件', '从本机选择'], ['调用指令', '/ 开头的指令'],
  ['目标', null], ['计划', null], ['反馈', null],
  ['压缩', null], ['权限', null], ['模型', null],
]

/** 记录「+」菜单项被转发时的事件类型。 */
let forwards: string[] = []

function option(label: string, description: string | null): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.setAttribute('role', 'option')
  item.setAttribute('aria-label', label)
  const name = document.createElement('span')
  name.className = 'MenuView_itemName'
  name.textContent = label
  item.append(name)
  if (description !== null) {
    const desc = document.createElement('span')
    desc.className = 'MenuView_itemDescription'
    desc.textContent = description
    item.append(desc)
  }
  item.addEventListener('mousedown', () => { forwards.push('mousedown:' + label) })
  return item
}

/**
 * 装一个可控的 matchMedia：只让 anchoredMedia 的查询结果由参数决定。
 * @param matches - 该媒体查询是否命中（true = 卡片形态）。
 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('orientation: landscape') ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

/**
 * 搭合成器 + 上游菜单，并给「+」一个固定 rect。
 * @param labels - 上游菜单项（标签、可选副标题）。
 */
function buildComposer(labels: readonly (readonly [string, string | null])[]): {
  add: HTMLButtonElement
  card: HTMLElement
} {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const tools = document.createElement('div')
  const add = document.createElement('button')
  add.type = 'button'
  add.setAttribute('aria-haspopup', 'listbox')
  add.setAttribute('aria-expanded', 'false')
  add.setAttribute('aria-label', '添加文件或调用指令')
  // 几何锚点的唯一来源：这个 rect。测试断言直接拿它比对。
  add.getBoundingClientRect = () => plusRect as DOMRect
  tools.append(add)
  card.append(tools)
  document.body.append(card)

  add.addEventListener('click', () => {
    if (card.querySelector('[role="listbox"]') !== null) return
    const surface = document.createElement('div')
    surface.setAttribute('data-trigger-menu', '')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    for (const [label, description] of labels) list.append(option(label, description))
    surface.append(list)
    card.append(surface)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    card.querySelector('[data-trigger-menu]')?.remove()
  })
  return { add, card }
}

/** 一个可聚焦的编辑器（用来验证关闭后不聚焦它）。 */
function buildEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('role', 'textbox')
  document.body.append(editor)
  return editor
}

let sheet: ComposerSheet
/** jsdom 的视口原值：beforeEach 会改成测试想要的尺寸，afterEach 还原。 */
let originalSize: { w: PropertyDescriptor | undefined; h: PropertyDescriptor | undefined }

/**
 * 把 jsdom 视口设成给定尺寸。
 *
 * 必须显式设：jsdom 默认 1024x768，与真机横屏（矮视口）差很远，
 * 锚定算法里的「上方空间够不够」会因此判成完全不同的分支。
 * @param size - 目标视口尺寸。
 */
function setViewport(size: { width: number; height: number }): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: size.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: size.height })
}

beforeEach(() => {
  forwards = []
  document.body.innerHTML = ''
  originalSize = {
    w: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
    h: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
  }
  setViewport(LANDSCAPE)
  plusRect = { left: 16, top: 300, right: 52, bottom: 336, width: 36, height: 36 }
  sheet = new ComposerSheet()
})

afterEach(() => {
  sheet.detach()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  if (originalSize.w !== undefined) Object.defineProperty(window, 'innerWidth', originalSize.w)
  if (originalSize.h !== undefined) Object.defineProperty(window, 'innerHeight', originalSize.h)
})

/** 等到映射行写进 DOM。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    if (document.querySelector(ROW) !== null) return
  }
}

/** 按给定形态打开面板。 */
async function open(anchored: boolean, viewport?: { width: number; height: number }): Promise<void> {
  stubMatchMedia(anchored)
  setViewport(viewport ?? (anchored ? LANDSCAPE : PORTRAIT))
  sheet.attach()
  document.querySelector<HTMLElement>(ADD)!.click()
  await settle()
}

/** 读出面板的内联几何（脚本写进去的那几个）。 */
function geometry(): { left: number; width: number; bottom: number | null; top: number | null; position: string } {
  const panel = document.querySelector<HTMLElement>(PANEL)!
  const style = panel.style
  return {
    left: parseFloat(style.left === '' ? 'NaN' : style.left),
    width: parseFloat(style.width === '' ? 'NaN' : style.width),
    bottom: style.bottom === '' ? null : parseFloat(style.bottom),
    top: style.top === '' ? null : parseFloat(style.top),
    position: style.position,
  }
}

describe('横屏：锚在「+」上的原生卡片', () => {
  it('卡片左边缘 == 「+」左边缘（误差 <=1px）', async () => {
    stubMatchMedia(true)
    buildComposer(NINE)
    await open(true)
    const g = geometry()
    expect(Math.abs(g.left - plusRect.left)).toBeLessThanOrEqual(1)
  })

  it('宽度 <= 360 且不贴视口边', async () => {
    buildComposer(NINE)
    await open(true)
    const g = geometry()
    expect(g.width).toBeLessThanOrEqual(360)
    expect(g.left).toBeGreaterThanOrEqual(0)
    expect(g.left + g.width).toBeLessThanOrEqual(LANDSCAPE.width + 1)
  })

  it('底边与「+」间距 8px（自下展开）', async () => {
    buildComposer(NINE)
    await open(true)
    const g = geometry()
    // bottom 是「离视口底的距离」：卡片底边贴 plus.top - 8，
    // 换算成 CSS bottom = viewportH - (plus.top - 8) = viewportH - plus.top + 8。
    const expectedBottom = window.innerHeight - plusRect.top + 8
    expect(g.bottom).not.toBeNull()
    expect(Math.abs((g.bottom as number) - expectedBottom)).toBeLessThanOrEqual(1)
    expect(g.top).toBeNull()
  })

  it('「+」靠右时宽度按可用空间收紧，不顶出视口', async () => {
    // 视口 640 宽，「+」贴到右边（left=560）：360 宽会溢出到 920，必须收窄。
    const narrow = { width: 640, height: 420 }
    plusRect = { left: 560, top: 300, right: 596, bottom: 336, width: 36, height: 36 }
    buildComposer(NINE)
    await open(true, narrow)
    const g = geometry()
    expect(g.width).not.toBeNull()
    const w = g.width as number
    const left = g.left as number
    // 关键判据：左边缘 + 宽度 不能越过视口（留 12px 右边距）。
    expect(left + w).toBeLessThanOrEqual(640 - 12 + 1)
    // 且宽度确实被收窄了（不是无脑 360）。
    expect(w).toBeLessThan(360)
  })

  it('上方空间不足时翻到「+」下方并自上展开', async () => {
    // 把「+」压到贴近视口顶部：spaceAbove 小于最小可用高度，必须改成往下开。
    plusRect = { left: 16, top: 40, right: 52, bottom: 76, width: 36, height: 36 }
    buildComposer(NINE)
    await open(true)
    const g = geometry()
    expect(g.top).not.toBeNull()
    expect(Math.abs((g.top as number) - (plusRect.bottom + 8))).toBeLessThanOrEqual(1)
    expect(g.bottom).toBeNull()
    expect(document.querySelector<HTMLElement>(PANEL)!.getAttribute('data-dsh-composer-sheet-dir')).toBe('down')
  })

  it('横屏遮罩全透明，但仍铺满并接收事件（点它能关）', async () => {
    buildComposer(NINE)
    await open(true)
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    expect(backdrop.hasAttribute(ANCHORED)).toBe(true)
    // CSS 层：命中 anchored 时 backdrop 不再是 rgba(0,0,0,.42) 的全屏黑幕。
    // 先把注释剥掉：注释里也会出现花括号与 pointer-events 字样，直接切片会误判。
    const cssNoComments = COMPOSER_SHEET_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const anchorStart = cssNoComments.indexOf('[' + 'data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored]')
    // 只取 backdrop 那一条规则（到第一个 } 结束），不要把后面的 panel 规则一起切进来。
    const anchoredBlock = cssNoComments.slice(anchorStart, cssNoComments.indexOf('}', anchorStart))
    expect(anchoredBlock).toContain('background: transparent')
    // 但必须仍然接收事件：否则点击落到下面的页面 / iframe / ShadowRoot 上，
    // panel.contains(target) 看不到它，卡片关不掉。
    expect(anchoredBlock).toContain('pointer-events: auto')
    expect(anchoredBlock).not.toContain('pointer-events: none')
    // 也必须仍然铺满全屏（position: static 会让它缩成内容宽，点击区域塌掉）。
    expect(anchoredBlock).toContain('position: fixed')
    expect(anchoredBlock).toContain('inset: 0')
  })

  it('横屏点遮罩（面板外）关闭卡片', async () => {
    buildComposer(NINE)
    await open(true)
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    // 点在遮罩自身（不在面板内）：模拟点到卡片外面。
    // jsdom 没有 PointerEvent：用同名的 Event 触发，监听器只读 target，不需要指针字段。
    backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('无障碍：横屏 aria-modal=false（非模态 popover），竖屏 true', async () => {
    buildComposer(NINE)
    await open(true)
    expect(document.querySelector<HTMLElement>(PANEL)!.getAttribute('aria-modal')).toBe('false')
    sheet.detach()
    document.body.innerHTML = ''
    sheet = new ComposerSheet()
    buildComposer(NINE)
    await open(false)
    expect(document.querySelector<HTMLElement>(PANEL)!.getAttribute('aria-modal')).toBe('true')
  })

  it('打开后焦点进入第一项（三瓦片的第一块）', async () => {
    buildComposer(NINE)
    await open(true)
    const first = document.querySelector<HTMLElement>(TILE)!
    // 焦点必须落在面板内、且落在第一块瓦片上（不是编辑器、不是 body）。
    expect(document.activeElement).toBe(first)
    expect(document.querySelector<HTMLElement>(PANEL)!.contains(document.activeElement)).toBe(true)
  })

  it('动画原点在左下、120ms', () => {
    const block = COMPOSER_SHEET_CSS.slice(COMPOSER_SHEET_CSS.indexOf('transform-origin: bottom left'))
    expect(block.length).toBeGreaterThan(0)
    expect(COMPOSER_SHEET_CSS).toContain('transform-origin: bottom left')
    expect(COMPOSER_SHEET_CSS).toContain('scale(0.96)')
    expect(COMPOSER_SHEET_CSS).toContain('dsh-composer-card-in 120ms')
  })
})

describe('竖屏：保持贴底 sheet', () => {
  it('不写内联几何（交给 CSS 贴底，bottomGap == 0）', async () => {
    buildComposer(NINE)
    await open(false)
    const panel = document.querySelector<HTMLElement>(PANEL)!
    expect(panel.style.position).toBe('')
    expect(panel.style.left).toBe('')
    expect(panel.style.width).toBe('')
    expect(panel.style.bottom).toBe('')
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    expect(backdrop.hasAttribute(ANCHORED)).toBe(false)
    // CSS 里竖屏那条是 justify-content: flex-end + panel 无圆角上方以外的定位，
    // 贴底由 backdrop 的 inset:0 + flex-end 达成（bottomGap 恒为 0）。
    // 竖屏贴底靠 backdrop 的 inset:0 + flex-end；这里只钉「上一条规则确实声明了 flex-end」。
    const backdropHead = COMPOSER_SHEET_CSS.slice(0, COMPOSER_SHEET_CSS.indexOf('[data-dsh-composer-sheet-panel]'))
    expect(backdropHead).toContain('justify-content: flex-end')
  })

  it('横竖切换时重算：竖屏后撤掉内联几何', async () => {
    buildComposer(NINE)
    await open(true)
    expect(geometry().position).toBe('fixed')
    // 切成竖屏并触发 resize
    stubMatchMedia(false)
    window.dispatchEvent(new Event('resize'))
    const panel = document.querySelector<HTMLElement>(PANEL)!
    expect(panel.style.position).toBe('')
    expect(panel.style.left).toBe('')
    expect(document.querySelector<HTMLElement>(BACKDROP)!.hasAttribute(ANCHORED)).toBe(false)
  })
})

describe('两形态都要满足的内容契约', () => {
  it.each([['横屏', true], ['竖屏', false]])('%s：三瓦片都在、行数 == 9', async (_name, anchored) => {
    buildComposer(NINE)
    await open(anchored)
    expect(document.querySelectorAll(TILE)).toHaveLength(3)
    expect(document.querySelectorAll(ROW)).toHaveLength(9)
  })
})

describe('关闭行为：点卡片外关闭且焦点不回编辑器', () => {
  it('横屏点面板外 -> 关闭，activeElement 不是编辑器', async () => {
    const editor = buildEditor()
    editor.focus()
    buildComposer(NINE)
    await open(true)
    const focusSpy = vi.spyOn(editor, 'focus')
    // 点 body（面板外）：onBackdropPointerDown 用 panel.contains 判定，不依赖遮罩。
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
    expect(document.activeElement).not.toBe(editor)
    expect(focusSpy).not.toHaveBeenCalled()
    focusSpy.mockRestore()
  })

  it('Escape 关闭（两形态都成立）', async () => {
    buildComposer(NINE)
    await open(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
  })
})

describe('负控：去掉锚定计算后退化成全宽贴底，断言必须判红', () => {
  /**
   * 受控负控：不改被测类，而是把「锚定计算」的产物替换成全宽贴底的内联几何，
   * 重跑同一批几何断言。它们必须失败 —— 否则说明这些断言根本没盯住定位方式。
   */
  function degradeToFullWidth(): void {
    const panel = document.querySelector<HTMLElement>(PANEL)!
    panel.style.setProperty('position', 'fixed', 'important')
    panel.style.setProperty('left', '0px', 'important')
    panel.style.setProperty('width', '100%', 'important')
    panel.style.setProperty('bottom', '0px', 'important')
    panel.style.removeProperty('top')
  }

  it('负控样本：左边缘不再对齐「+」', async () => {
    buildComposer(NINE)
    await open(true)
    degradeToFullWidth()
    const g = geometry()
    expect(Math.abs(g.left - plusRect.left)).toBeGreaterThan(1)
  })

  it('负控样本：宽度不再是受限的 px 值（退化成全宽）', async () => {
    buildComposer(NINE)
    await open(true)
    degradeToFullWidth()
    const raw = document.querySelector<HTMLElement>(PANEL)!.style.width
    // 真实实现写的是 "360px" 这类受限值；退化样本是 "100%"。
    expect(raw).toBe('100%')
    expect(raw.endsWith('px')).toBe(false)
  })

  it('负控样本：底部间距不再是 8px', async () => {
    buildComposer(NINE)
    await open(true)
    degradeToFullWidth()
    const g = geometry()
    const expectedBottom = 420 - plusRect.top + 8
    expect(Math.abs((g.bottom as number) - expectedBottom)).toBeGreaterThan(1)
  })

  it('负控自检：判据函数在真实几何上为真、在退化几何上为假', () => {
    const anchoredOk = (g: { left: number; width: number; bottom: number | null }): boolean =>
      Math.abs(g.left - plusRect.left) <= 1
      && g.width <= 360
      && g.bottom !== null
      && Math.abs(g.bottom - (420 - plusRect.top + 8)) <= 1
    expect(anchoredOk({ left: 16, width: 360, bottom: 128 })).toBe(true)
    expect(anchoredOk({ left: 0, width: 900, bottom: 0 })).toBe(false)
  })
})
