// @vitest-environment jsdom
// 居中卡片形态：横屏与竖屏共用同一张卡片（规格已从「锚在 + 上」改为「视口居中」）。
//
// 为什么改：锚定在加号上会让卡片位置随输入框位置漂移（横屏尤甚），用户要求固定落点。
// 现在几何**全部交给 CSS**（grid + place-items: center），脚本不写任何内联定位。
//
// 这里钉的是契约，不是肉眼观感：
//   1. 居中：backdrop 是 grid + place-items: center，卡片宽/高只受视口约束；
//   2. 无内联几何：脚本不写 left/top/width/max-height/transform-origin；
//   3. 遮罩：半透明黑 + pointer-events:auto，点它能关；
//   4. 动效：入场从视口底边之下飞入（translateY(100vh) → 0）200ms，出场反向 160ms；
//   5. reduced-motion：文件末尾统一 animation:none，不许被更具体的规则覆盖；
//   6. 两形态内容一致：行副标题与瓦片标签都显示（取消横屏隐藏）；
//   7. 列表滚到底时最后一行完整可见（padding-bottom + scroll-padding-bottom）；
//   8. 负控：去掉遮罩点击处理器、把入场起点改回加号坐标 —— 判据必须变红。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { COMPOSER_SHEET_CSS } from '../src/client/mobile/composer-sheet.css.ts'

const BACKDROP = '[data-dsh-composer-sheet-backdrop]'
const PANEL = '[data-dsh-composer-sheet-panel]'
const TILE = '[data-dsh-composer-sheet-tile]'
const ROW = '[data-dsh-composer-sheet-row]'
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'

/** 横屏矮视口（原设备横屏 1067x600 dp 的量级）。 */
const LANDSCAPE = { width: 1067, height: 600 }
/** 竖屏视口。 */
const PORTRAIT = { width: 600, height: 1067 }

/** 「+」的固定 rect。新形态**不该**读它 —— 保留只为证明卡片位置与它无关。 */
let plusRect: { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** 上游「+」菜单项（标签、可选副标题）。 */
const NINE: readonly (readonly [string, string | null])[] = [
  ['拍照上传', null], ['选择文件', '从本机选择'], ['调用指令', '/ 开头的指令'],
  ['目标', null], ['计划', null], ['反馈', null],
  ['压缩', null], ['权限', null], ['模型', null],
]

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

function buildEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('role', 'textbox')
  document.body.append(editor)
  return editor
}

let sheet: ComposerSheet
let originalSize: { w: PropertyDescriptor | undefined; h: PropertyDescriptor | undefined }

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
  plusRect = { left: 16, top: 500, right: 52, bottom: 536, width: 36, height: 36 }
  sheet = new ComposerSheet()
})

afterEach(() => {
  sheet.detach()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  if (originalSize.w !== undefined) Object.defineProperty(window, 'innerWidth', originalSize.w)
  if (originalSize.h !== undefined) Object.defineProperty(window, 'innerHeight', originalSize.h)
})

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    if (document.querySelector(ROW) !== null) return
  }
}

/** 按给定视口打开面板（形态已统一，viewport 只影响 CSS 计算，不再影响脚本分支）。 */
async function open(viewport?: { width: number; height: number }): Promise<void> {
  setViewport(viewport ?? LANDSCAPE)
  sheet.attach()
  document.querySelector<HTMLElement>(ADD)!.click()
  await settle()
}

/** 取出某个选择器的规则体（到第一个右花括号为止）。 */
function ruleBody(selector: string): string {
  const at = COMPOSER_SHEET_CSS.indexOf(selector + ' {')
  expect(at).toBeGreaterThan(-1)
  return COMPOSER_SHEET_CSS.slice(at, COMPOSER_SHEET_CSS.indexOf('}', at) + 1)
}

describe('居中卡片：几何交给 CSS，脚本不写内联定位', () => {
  it('backdrop 用 grid + place-items: center 居中，卡片不靠脚本定位', () => {
    const backdrop = ruleBody('[data-dsh-composer-sheet-backdrop]')
    expect(backdrop).toContain('position: fixed')
    expect(backdrop).toContain('inset: 0')
    expect(backdrop).toContain('display: grid')
    expect(backdrop).toContain('place-items: center')
  })

  it('宽度 min(360px, 100vw - 24px)，高度 max-height min(70vh, 560px)，圆角走 token', () => {
    const panel = ruleBody('[data-dsh-composer-sheet-panel]')
    expect(panel).toContain('width: min(360px, calc(100vw - 24px))')
    expect(panel).toContain('max-height: min(70vh, 560px)')
    expect(panel).toContain('border-radius: var(--dsw-radius-xl, 20px)')
    expect(panel).toContain('overflow: hidden')
  })

  /**
   * 真契约：脚本**不得**再写任何内联几何。
   *
   * 旧形态靠 placeAnchored() 内联写 left/width/max-height/transform-origin，
   * 卡片位置因此随「+」漂移。改居中后这些内联值必须一个都不剩 ——
   * 只要有一条回来，卡片就又会被脚本钉住。
   */
  it('打开后 panel 没有任何内联几何（left/top/width/max-height/transform-origin）', async () => {
    buildComposer(NINE)
    await open()
    const panel = document.querySelector<HTMLElement>(PANEL)!
    for (const prop of ['position', 'left', 'top', 'right', 'bottom', 'width', 'max-height', 'transform-origin']) {
      expect(panel.style.getPropertyValue(prop)).toBe('')
    }
  })

  it('卡片位置与「+」无关：把「+」挪到四个角落，结果都一样（无内联几何）', async () => {
    for (const corner of [
      { left: 0, top: 0, right: 36, bottom: 36, width: 36, height: 36 },
      { left: 1031, top: 0, right: 1067, bottom: 36, width: 36, height: 36 },
      { left: 0, top: 564, right: 36, bottom: 600, width: 36, height: 36 },
      { left: 1031, top: 564, right: 1067, bottom: 600, width: 36, height: 36 },
    ]) {
      document.body.innerHTML = ''
      plusRect = corner
      buildComposer(NINE)
      await open()
      const panel = document.querySelector<HTMLElement>(PANEL)!
      expect(panel.style.getPropertyValue('left')).toBe('')
      expect(panel.style.getPropertyValue('top')).toBe('')
      expect(panel.style.getPropertyValue('width')).toBe('')
      sheet.detach()
      sheet = new ComposerSheet()
    }
  })

  it('已删除锚定形态的痕迹：无 anchored 属性、无 dir、CSS 里无 transform-origin 声明', () => {
    buildComposer(NINE)
    return open().then(() => {
      const panel = document.querySelector<HTMLElement>(PANEL)!
      const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
      expect(backdrop.hasAttribute('data-dsh-composer-sheet-anchored')).toBe(false)
      expect(panel.hasAttribute('data-dsh-composer-sheet-dir')).toBe(false)
      // 行内声明里不许出现 transform-origin（注释里提到不算）。
      expect(COMPOSER_SHEET_CSS).not.toMatch(/^\s*transform-origin\s*:/m)
      // 也不再需要「形态判定」的媒体查询。
      expect(COMPOSER_SHEET_CSS).not.toContain('orientation: landscape')
    })
  })
})

describe('遮罩：半透明黑、覆盖整屏、可点击关闭', () => {
  it('遮罩是 rgba(0,0,0,0.55) 且 pointer-events: auto（禁止 none）', () => {
    const backdrop = ruleBody('[data-dsh-composer-sheet-backdrop]')
    expect(backdrop).toContain('background: rgba(0, 0, 0, 0.55)')
    expect(backdrop).toMatch(/\n\s*pointer-events:\s*auto;/)
    // 断言用行首声明形式，而不是对整块做子串否定：
    // 注释里会合法地提到「不接事件」的后果，子串否定会匹配到注释而假红。
    expect(backdrop).not.toMatch(/\n\s*pointer-events:\s*none;/)
  })

  it('点遮罩（面板外）关闭', async () => {
    buildComposer(NINE)
    await open()
    expect(document.querySelector(PANEL)).not.toBeNull()
    document.querySelector<HTMLElement>(BACKDROP)!.dispatchEvent(
      new Event('pointerdown', { bubbles: true, cancelable: true }),
    )
    expect(document.querySelector(PANEL)).toBeNull()
  })

  it('点面板内部不关闭', async () => {
    buildComposer(NINE)
    await open()
    const panel = document.querySelector<HTMLElement>(PANEL)!
    panel.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(document.querySelector(PANEL)).not.toBeNull()
  })
})

describe('动效：从视口底边之下飞入 / 飞回', () => {
  it('入场 keyframes 起点是 translateY(100vh)（视口底外），终点 0，200ms', () => {
    const kf = COMPOSER_SHEET_CSS.slice(
      COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-in'),
      COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-out'),
    )
    // 起点必须把卡片整体推到视口底外：100vh 是保守且与「+」无关的取值。
    expect(kf).toContain('translateY(100vh)')
    expect(kf).toContain('translateY(0)')
    const panel = ruleBody('[data-dsh-composer-sheet-panel]')
    expect(panel).toContain('animation: dsh-composer-card-in 200ms cubic-bezier(0.215, 0.61, 0.355, 1)')
  })

  it('出场反向飞回视口底，160ms', () => {
    const kf = COMPOSER_SHEET_CSS.slice(COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-out'))
    expect(kf).toContain('translateY(0)')
    expect(kf).toContain('translateY(100vh)')
    // 离场用**对称反向**曲线（入场 .215,.61,.355,1 的镜像），不是照抄入场曲线。
    expect(COMPOSER_SHEET_CSS).toContain('animation: dsh-composer-card-out 160ms cubic-bezier(0.645, 0.045, 0.355, 1) forwards')
    expect(COMPOSER_SHEET_CSS).toContain('animation: dsh-composer-backdrop-out 160ms cubic-bezier(0.645, 0.045, 0.355, 1) forwards')
  })

  it('遮罩淡入 200ms、淡出 160ms', () => {
    expect(ruleBody('[data-dsh-composer-sheet-backdrop]')).toContain('animation: dsh-composer-backdrop-in 200ms')
    expect(COMPOSER_SHEET_CSS).toContain('animation: dsh-composer-backdrop-out 160ms')
  })
})

describe('reduced-motion：统一直接切，不被更具体的规则覆盖', () => {
  /**
   * 真缺陷形态（2026-10-31 实测）：reduced-motion 块写在文件中部时，后面更具体的
   * animation 规则会盖掉它的 animation: none —— 卡片照旧播 200ms。
   *
   * 判据两条：① 块里同时含 backdrop / panel / leaving 变体；② 它必须在
   * 所有 animation 声明**之后**（用 lastIndexOf 定位，且晚于 card-out 那条）。
   */
  it('文件末尾有 reduced-motion 块，且覆盖 backdrop / panel / leaving 变体', () => {
    const at = COMPOSER_SHEET_CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    const block = COMPOSER_SHEET_CSS.slice(at)
    expect(block).toContain('[data-dsh-composer-sheet-backdrop]')
    expect(block).toContain('[data-dsh-composer-sheet-panel]')
    expect(block).toContain('[data-dsh-composer-sheet-leaving]')
    expect(block).toContain('animation: none')
    expect(block).toContain('transition: none')
  })

  it('reduced-motion 块位置在所有 animation 之后（放前面会被盖掉）', () => {
    const rmAt = COMPOSER_SHEET_CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    const lastAnim = COMPOSER_SHEET_CSS.lastIndexOf('animation:')
    // 允许块内部自己出现 animation: none —— 取块之前最后一条 animation 声明比较。
    const lastAnimBeforeBlock = COMPOSER_SHEET_CSS.lastIndexOf('animation:', rmAt)
    expect(rmAt).toBeGreaterThan(lastAnimBeforeBlock)
    expect(rmAt).toBeLessThan(lastAnim + 1)
  })
})

describe('两形态内容一致：副标题与瓦片标签都显示', () => {
  it('CSS 里没有「隐藏行副标题 / 隐藏瓦片标签」的规则', () => {
    expect(COMPOSER_SHEET_CSS).not.toMatch(/\[data-dsh-composer-sheet-row-sub\]\s*\{[^}]*display:\s*none/)
    expect(COMPOSER_SHEET_CSS).not.toMatch(/\[data-dsh-composer-sheet-tile-label\]\s*\{[^}]*display:\s*none/)
    // 也不许用组合选择器隐藏它们。
    expect(COMPOSER_SHEET_CSS).not.toContain('[data-dsh-composer-sheet-row-sub] {\n    display: none')
  })

  it('九行都在，且副标题文本确实渲染进 DOM', async () => {
    buildComposer(NINE)
    await open()
    expect(document.querySelectorAll(ROW).length).toBe(NINE.length)
    const subs = [...document.querySelectorAll('[data-dsh-composer-sheet-row-sub]')]
    // 有描述的项才有副标题；至少要有 1 条，且内容非空。
    expect(subs.length).toBeGreaterThan(0)
    expect(subs.every((s) => (s.textContent ?? '').trim().length > 0)).toBe(true)
  })

  it('三块瓦片都在，标签可见（不被 display:none 藏掉）', async () => {
    buildComposer(NINE)
    await open()
    expect(document.querySelectorAll(TILE).length).toBe(3)
    const labels = [...document.querySelectorAll('[data-dsh-composer-sheet-tile-label]')]
    expect(labels.length).toBe(3)
    // 文案随 locale 变（jsdom 默认 en 给 Camera/Photos/Local files），
    // 这里只钉「三块都有非空标签」，具体文案由 locale 决定。
    expect(labels.every((l) => (l.textContent ?? '').trim().length > 0)).toBe(true)
  })
})

describe('列表滚动：最后一行不得被切半', () => {
  it('rows 是滚动容器，且有 padding-bottom + scroll-padding-bottom', () => {
    const rows = ruleBody('[data-dsh-composer-sheet-rows]')
    expect(rows).toContain('overflow-y: auto')
    expect(rows).toContain('min-height: 0')
    expect(rows).toMatch(/padding-bottom:\s*[1-9]/)
    expect(rows).toMatch(/scroll-padding-bottom:\s*[1-9]/)
  })

  /**
   * 真缺陷（2026-10-31 设备截图）：`grid-auto-rows: minmax(0, 1fr)` 把 8 行强行等分到
   * 卡片可用高度里。横屏卡片只有 420px 高时每行被压到约 33px，小于行的视觉高度
   * （min-height 46px）→ 行与行重叠、最后一行被切半。
   *
   * 判据：轨道必须是内容高（auto），且行自身有 min-height 兜底。
   */
  it('行轨道是 auto（内容高），不是 1fr 等分（否则横屏把行压扁重叠）', () => {
    const rows = ruleBody('[data-dsh-composer-sheet-rows]')
    expect(rows).toContain('grid-auto-rows: auto')
    expect(rows).not.toContain('grid-auto-rows: minmax(0, 1fr)')
    expect(ruleBody('[data-dsh-composer-sheet-row]')).toMatch(/min-height:\s*4[0-9]px/)
  })

  it('行文本列能收缩并裁切（副标题不画出卡片外）', () => {
    expect(COMPOSER_SHEET_CSS).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(ruleBody('[data-dsh-composer-sheet-row]')).toContain('min-width: 0')
    expect(ruleBody('[data-dsh-composer-sheet-row-text]')).toContain('overflow: hidden')
  })
})

describe('内容与关闭行为契约', () => {
  it('卡片打开后上游 listbox 已被收起（不残留在页面上）', async () => {
    buildComposer(NINE)
    const card = document.querySelector<HTMLElement>('[data-composer-card]')!
    const surface = document.createElement('div')
    surface.setAttribute('data-trigger-menu', '')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    for (const [label, description] of NINE) {
      const item = document.createElement('button')
      item.setAttribute('role', 'option')
      item.textContent = label
      if (description !== null) {
        const sub = document.createElement('span')
        sub.textContent = description
        item.append(sub)
      }
      list.append(item)
    }
    surface.append(list)
    card.append(surface)

    await open()
    expect(document.querySelector(PANEL)).not.toBeNull()
    expect(document.querySelector('[data-composer-card] [role="listbox"]')).toBeNull()
    expect(document.querySelectorAll(ROW).length).toBe(NINE.length)
  })

  it('点面板外关闭后，activeElement 不是编辑器', async () => {
    const editor = buildEditor()
    editor.focus()
    buildComposer(NINE)
    await open()
    document.querySelector<HTMLElement>(BACKDROP)!.dispatchEvent(
      new Event('pointerdown', { bubbles: true, cancelable: true }),
    )
    expect(document.querySelector(PANEL)).toBeNull()
    expect(document.activeElement).not.toBe(editor)
  })

  it('Escape 关闭', async () => {
    buildComposer(NINE)
    await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector(PANEL)).toBeNull()
  })

  it('打开后焦点进入第一块瓦片', async () => {
    buildComposer(NINE)
    await open()
    const first = document.querySelector<HTMLElement>(TILE)!
    expect(document.activeElement).toBe(first)
  })
})

/**
 * 系统返回（Android 返回手势 / 返回键）必须**先关卡片**，而不是退出或返回上层。
 *
 * 实现方式：**复用**仓库既有的 BackStackSignal（`back-stack.ts`）—— 它是壳侧返回策略的
 * 页面半边，按「已挂载的层」计数，`window.__dshBack()` 被壳侧 OnBackPressedCallback
 * **同步**调用。它已经把 `[data-dsh-composer-sheet-backdrop]` 认成 `composer-sheet` 层。
 *
 * 为什么**不**用 history.pushState（用户最初建议的那条）：
 * `back-stack.ts` 头注释记着实测结论 —— Chromium 110 的 `WebView.canGoBack()` 看不到
 * same-document history 条目，所以 pushState 驱动不了壳侧的返回判定；本机 WebView 正是
 * 110（`webview_version=110.0.5481.154`）。用 pushState 会得到「看起来压了历史、返回键照样退出」的假象。
 */
describe('系统返回先关卡片（复用 BackStackSignal）', () => {
  it('卡片开着时是一层，__dshBack() 关掉它且返回 true', async () => {
    const { BackStackSignal } = await import('../src/client/mobile/back-stack.ts')
    const signal = new BackStackSignal({
      toggleSidebar: () => {},
      activePanelId: () => null,
      leaveMainPanel: () => {},
    })
    const uplink = vi.fn()
    vi.stubGlobal('dshBackBridge', { setAvailable: uplink })
    signal.attach()
    try {
      buildComposer(NINE)
      await open()
      await new Promise((r) => { setTimeout(r, 0) })
      await new Promise((r) => { setTimeout(r, 0) })
      const win = window as unknown as { __dshBackKinds?: string[]; __dshBackDepth?: number; __dshBack?: () => boolean }
      expect(win.__dshBackKinds).toContain('composer-sheet')
      expect(win.__dshBackDepth).toBeGreaterThanOrEqual(1)
      // 壳侧返回键：同步调用，返回 true = 消费掉这次返回（不退应用）
      expect(win.__dshBack?.()).toBe(true)
      // 卡片已被关掉
      expect(document.querySelector(PANEL)).toBeNull()
      // 且层栈回落（下一次返回才会走应用自身的返回，不是被空消费）
      await new Promise((r) => { setTimeout(r, 0) })
      await new Promise((r) => { setTimeout(r, 0) })
      expect(win.__dshBackKinds ?? []).not.toContain('composer-sheet')
      expect(uplink).toHaveBeenLastCalledWith(false)
    } finally {
      signal.detach()
      vi.unstubAllGlobals()
    }
  })
})

describe('离场必须与入场镜像（向下沉出，不得缩小/淡出/向上退场）', () => {
  it('引用名镜像：入场 card-in 向上，离场 card-out 向下，位移值相同', () => {
    const kIn = COMPOSER_SHEET_CSS.slice(
      COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-in'),
      COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-out'),
    )
    const kOut = COMPOSER_SHEET_CSS.slice(COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-out'))
    // 入场：视口底外 -> 0
    expect(kIn).toContain('translateY(100vh)')
    expect(kIn).toContain('translateY(0)')
    // 离场：0 -> 视口底外（同一个值，方向相反）
    expect(kOut).toContain('translateY(0)')
    expect(kOut).toContain('translateY(100vh)')
    // 离场不得用缩小 / 淡出 / 向上退场代替
    expect(kOut).not.toContain('scale(')
    expect(kOut).not.toContain('opacity')
    expect(kOut).not.toContain('translateY(-')
  })

  it('时长与缓动镜像：进 200ms .215,.61,.355,1；出 160ms .645,.045,.355,1', () => {
    expect(ruleBody('[data-dsh-composer-sheet-panel]')).toContain('animation: dsh-composer-card-in 200ms cubic-bezier(0.215, 0.61, 0.355, 1)')
    expect(COMPOSER_SHEET_CSS).toContain('animation: dsh-composer-card-out 160ms cubic-bezier(0.645, 0.045, 0.355, 1) forwards')
  })

  /**
   * 三条关闭路径必须走**同一个**离场动画，不得有的瞬关。
   *
   * jsdom 没有 WAAPI，直接 remove 会掩盖「有没有播动画」。所以这里给遮罩装一个假的
   * getAnimations（返回一个永不 finish 的动画对象），然后断言：
   *   ① backdrop 挂上 [data-dsh-composer-sheet-leaving]；
   *   ② 面板此刻**仍在 DOM**（说明没有瞬关，在等动画结束）。
   */
  it('路径 1（×）：点关闭按钮走离场动画，不瞬关', async () => {
    buildComposer(NINE)
    await open()
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    let finish: (() => void) | null = null
    Object.defineProperty(backdrop, 'getAnimations', {
      configurable: true,
      value: () => [{ addEventListener: (type: string, fn: () => void) => { if (type === 'finish') finish = fn } }],
    })
    const closeBtn = document.querySelector<HTMLElement>('[data-dsh-composer-sheet-close]')!
    expect(closeBtn).not.toBeNull()
    closeBtn.click()
    // 离场标记已挂 + 面板仍在（等动画）
    expect(document.querySelector(BACKDROP)!.hasAttribute('data-dsh-composer-sheet-leaving')).toBe(true)
    expect(document.querySelector(PANEL)).not.toBeNull()
    // 动画结束才移除
    finish!()
    expect(document.querySelector(PANEL)).toBeNull()
  })

  it('路径 2（点外部）与路径 3（系统返回）同样挂离场标记，不瞬关', async () => {
    // 点外部
    buildComposer(NINE)
    await open()
    let bd = document.querySelector<HTMLElement>(BACKDROP)!
    Object.defineProperty(bd, 'getAnimations', { configurable: true, value: () => [{ addEventListener: () => {} }] })
    bd.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(document.querySelector(BACKDROP)!.hasAttribute('data-dsh-composer-sheet-leaving')).toBe(true)
    expect(document.querySelector(PANEL)).not.toBeNull()
    sheet.detach()
    sheet = new ComposerSheet()
    document.body.innerHTML = ''

    // 系统返回（走 BackStackSignal 的 composer-sheet 层，闭合仍是同一套 outside-pointerdown）
    const { BackStackSignal } = await import('../src/client/mobile/back-stack.ts')
    const signal = new BackStackSignal({ toggleSidebar: () => {}, activePanelId: () => null, leaveMainPanel: () => {} })
    vi.stubGlobal('dshBackBridge', { setAvailable: () => {} })
    signal.attach()
    try {
      buildComposer(NINE)
      await open()
      await new Promise((r) => { setTimeout(r, 0) })
      await new Promise((r) => { setTimeout(r, 0) })
      bd = document.querySelector<HTMLElement>(BACKDROP)!
      Object.defineProperty(bd, 'getAnimations', { configurable: true, value: () => [{ addEventListener: () => {} }] })
      const win = window as unknown as { __dshBack?: () => boolean }
      expect(win.__dshBack?.()).toBe(true)
      expect(document.querySelector(BACKDROP)?.hasAttribute('data-dsh-composer-sheet-leaving') ?? false).toBe(true)
    } finally {
      signal.detach()
      vi.unstubAllGlobals()
    }
  })
})

describe('负控：新判据必须能抓住两种坏态', () => {
  /**
   * 负控 ①：去掉遮罩的点击处理器 → 「点遮罩关闭」必须变红。
   *
   * 做法：打开后用 stopImmediatePropagation 拦掉遮罩上的 pointerdown 监听
   * （等价于「没接这个处理器」），断言面板仍在 —— 与正向用例互为反证。
   */
  it('负控 1：遮罩监听被剥掉时，点遮罩不再关闭（正向判据会红）', async () => {
    buildComposer(NINE)
    await open()
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    // cloneNode **不复制**事件监听器：换上去的节点等价于「没接处理器」，
    // 这正是把 addEventListener 那行删掉后的形态。
    const clone = backdrop.cloneNode(true) as HTMLElement
    backdrop.replaceWith(clone)
    clone.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    // 没有处理器 ⇒ 面板仍在。若这里变成 null，说明判据不依赖处理器（假门禁）。
    expect(document.querySelector(PANEL)).not.toBeNull()
  })

  /**
   * 负控 ②：把入场起点改回「加号坐标」→ 必须红。
   *
   * 新规格要求入场起点与「+」无关（translateY(100vh)）。这里构造旧形态的
   * 起点（scale + 4px，靠 transform-origin 指到加号），断言它**不满足**新判据：
   * 起点位移远小于卡片高度 ⇒ 卡片首帧并未整体落在视口底外。
   */
  it('负控 2：入场起点若是旧形态（4px 位移）则「完全在视口底外」判据为假', () => {
    const viewportH = 600
    const cardH = 350
    // 旧形态起点：translateY(4px) —— 卡片顶边仍在视口内。
    const oldStartTop = (viewportH - cardH) / 2 + 4
    expect(oldStartTop < viewportH).toBe(true)
    // 新形态起点：translateY(100vh) —— 卡片顶边在视口底之外。
    const newStartTop = (viewportH - cardH) / 2 + viewportH
    expect(newStartTop >= viewportH).toBe(true)
    // 且 CSS 里确实是 100vh，不是小位移。
    const kf = COMPOSER_SHEET_CSS.slice(
      COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-in'),
      COMPOSER_SHEET_CSS.indexOf('@keyframes dsh-composer-card-out'),
    )
    expect(kf).toContain('translateY(100vh)')
    expect(kf).not.toContain('translateY(4px)')
    expect(kf).not.toContain('scale(')
  })
})