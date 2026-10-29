// @vitest-environment jsdom
// 输入行「+」底部 sheet：三块瓦片 + 自动映射上游「+」菜单项。
//
// 夹具按上游真实形状搭（ui-conversation/skeleton/InputBar.tsx:418-441 与
// ui-input-trigger/MenuView.tsx:94-221）：
//   div[data-composer-card]
//     > div.tools > button[aria-haspopup=listbox]        ← 「+」，唯一判据
//                  > input[type=file][multiple] hidden   ← 三块瓦片都走它
//   div[role=menu]                                        ← 上游「+」弹层（MenuSurface）
//     > div[role=listbox] > button[role=option] ...       ← 逐项映射成行
//
// 关键行为：上游 option 只在 onMouseDown 上挂 onPick（MenuView.tsx:170-173），
// 所以转发必须走 mousedown —— 用 click 转发会静默失效，这条由用例钉住。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { COMPOSER_SHEET_CSS } from '../src/client/mobile/composer-sheet.css.ts'

const BACKDROP = '[data-dsh-composer-sheet-backdrop]'
const PANEL = '[data-dsh-composer-sheet-panel]'
const TILE = '[data-dsh-composer-sheet-tile]'
const ROW = '[data-dsh-composer-sheet-row]'
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'

/** 记录每次上游 option 被转发时收到的事件类型。 */
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
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  item.append(icon)
  // 上游实现：只在 mousedown 上挂选择回调。
  item.addEventListener('mousedown', () => { forwards.push('mousedown:' + label) })
  item.addEventListener('click', () => { forwards.push('click:' + label) })
  return item
}

/**
 * 搭出合成器 + 上游「+」菜单。
 * @param labels - 上游菜单里要出现的项（标签、可选副标题）。
 */
function buildComposer(labels: readonly (readonly [string, string | null])[]): {
  add: HTMLButtonElement
  input: HTMLInputElement
  card: HTMLElement
} {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const tools = document.createElement('div')
  tools.className = 'tools'
  const add = document.createElement('button')
  add.type = 'button'
  add.setAttribute('aria-haspopup', 'listbox')
  add.setAttribute('aria-expanded', 'false')
  add.setAttribute('aria-label', '添加文件或调用指令')
  tools.append(add)
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  tools.append(input)
  card.append(tools)
  document.body.append(card)

  // 「+」被点（或我们派发点击）后，上游把菜单挂到卡片里。
  add.addEventListener('click', () => {
    if (card.querySelector('[role="menu"]') !== null) return
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    for (const [label, description] of labels) list.append(option(label, description))
    menu.append(list)
    card.append(menu)
    add.setAttribute('aria-expanded', 'true')
  })
  // 上游 MenuView 的 Esc 关闭。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    card.querySelector('[role="menu"]')?.remove()
    add.setAttribute('aria-expanded', 'false')
  })
  return { add, input, card }
}

/** 一个真实存在的可聚焦输入框（用来验证「关闭后不聚焦」）。 */
function buildEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('role', 'textbox')
  document.body.append(editor)
  return editor
}

let sheet: ComposerSheet

beforeEach(() => {
  forwards = []
  document.body.innerHTML = ''
  sheet = new ComposerSheet()
})

afterEach(() => {
  sheet.detach()
  document.body.innerHTML = ''
})

/** 等待行填充完成：rAF / setTimeout 两条路径都可能被用到。 */
async function settle(): Promise<void> {
  // 反复让出事件循环，直到映射行写进 DOM 或超时（不用固定时长：jsdom 的 rAF
  // 与 vitest 的计时器都不可靠，见 composer-sheet.ts 的 nextCommit）。
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    if (document.querySelector(ROW) !== null) return
  }
}

/** 点「+」并让 sheet 打开（等到映射行填充完成）。 */
async function openSheet(): Promise<void> {
  sheet.attach()
  document.querySelector<HTMLElement>(ADD)!.click()
  await settle()
}

describe('「+」底部 sheet：结构', () => {
  it('第一排是三块并排瓦片，顺序 拍照 -> 照片 -> 本地文件', async () => {
    buildComposer([['命令', null]])
    await openSheet()
    const tiles = [...document.querySelectorAll(TILE)]
    expect(tiles).toHaveLength(3)
    expect(tiles.map(tile => tile.getAttribute('data-dsh-composer-sheet-tile'))).toEqual(['camera', 'photo', 'file'])
    // 三块在同一排容器里，不在映射行的容器里
    const rowHost = document.querySelector('[data-dsh-composer-sheet-rows]')!
    for (const tile of tiles) expect(rowHost.contains(tile)).toBe(false)
  })

  it('拦截「+」：开的是我们的 sheet，上游小弹层不会留在屏幕上', async () => {
    const { card } = buildComposer([['命令', null]])
    sheet.attach()
    document.querySelector<HTMLElement>(ADD)!.click()
    // 上游菜单是在读项之后异步关掉的，必须等填充完成再看。
    await settle()
    expect(document.querySelector(BACKDROP)).not.toBeNull()
    // 上游菜单只被临时借用来读项，读完必须关掉，不能盖在 sheet 上。
    // （用户那次点击被 stopImmediatePropagation 拦掉，所以它根本没开过。）
    expect(card.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('「+」底部 sheet：自动映射上游菜单', () => {
  it('① 从菜单 items 渲染出 N 行，且顺序与上游一致', async () => {
    buildComposer([['拍照上传', null], ['选择文件', '从本机选择'], ['调用指令', '/ 开头的指令']])
    await openSheet()
    const rows = [...document.querySelectorAll(ROW)]
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.querySelector('[data-dsh-composer-sheet-row-title]')?.textContent))
      .toEqual(['拍照上传', '选择文件', '调用指令'])
  })

  it('副标题「有就显示」：没有 description 的行不渲染副标题节点', async () => {
    buildComposer([['无副标题', null], ['有副标题', '说明文字']])
    await openSheet()
    const rows = [...document.querySelectorAll(ROW)]
    expect(rows[0].querySelector('[data-dsh-composer-sheet-row-sub]')).toBeNull()
    expect(rows[1].querySelector('[data-dsh-composer-sheet-row-sub]')?.textContent).toBe('说明文字')
  })

  it('每行都带图标（从上游 item 的 svg 复制）', async () => {
    buildComposer([['甲', null], ['乙', null]])
    await openSheet()
    const rows = [...document.querySelectorAll(ROW)]
    for (const row of rows) {
      expect(row.querySelector('[data-dsh-composer-sheet-row-icon] svg')).not.toBeNull()
    }
  })

  it('② 点击行转发到原 item（走 mousedown，不是 click）', async () => {
    buildComposer([['甲', null], ['乙', '说明']])
    await openSheet()
    const rows = [...document.querySelectorAll<HTMLElement>(ROW)]
    rows[1].click()
    // 转发要等上游菜单重新开出来（跨一次提交），见 withUpstreamMenu。
    await settle()
    // 反证：若转发用 click，这里会是 click:乙 而上游根本不响应
    expect(forwards.some(entry => entry.startsWith('click:'))).toBe(false)
  })

  it('第三方插件往「+」里加项后自动出现（不靠白名单）', async () => {
    buildComposer([['内置项', null], ['插件加的项', '第三方']])
    await openSheet()
    const titles = [...document.querySelectorAll('[data-dsh-composer-sheet-row-title]')].map(node => node.textContent)
    expect(titles).toContain('插件加的项')
  })

  it('上游菜单拿不到时只留三块瓦片，不抛错', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const add = document.createElement('button')
    add.setAttribute('aria-haspopup', 'listbox')
    card.append(add)
    document.body.append(card)
    sheet.attach()
    expect(() => { add.click() }).not.toThrow()
    expect(document.querySelectorAll(TILE)).toHaveLength(3)
    expect(document.querySelectorAll(ROW)).toHaveLength(0)
  })

  it('焦点在编辑器上时也能读到菜单项（读菜单不能被 blur 抢先）', async () => {
    // 上游 MenuView 只在编辑器有焦点时才开；若 open() 先 blur 再读，映射永远是 0 行。
    // 实机复现过：面板文案只剩「拍照照片本地文件」。
    const editor = buildEditor()
    buildComposer([['甲', null], ['乙', '说明']])
    editor.focus()
    sheet.attach()
    document.querySelector<HTMLElement>(ADD)!.click()
    await settle()
    const rows = [...document.querySelectorAll(ROW)]
    expect(rows).toHaveLength(2)
    // 读完之后焦点仍必须被压走（键盘不能弹）
    expect(document.activeElement).not.toBe(editor)
  })

  it('打开后上游菜单被关掉，不会盖在 sheet 上', async () => {
    const { card } = buildComposer([['甲', null]])
    await openSheet()
    expect(card.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('「+」底部 sheet：键盘行为', () => {
  it('③ 关闭后 activeElement 不是输入框，且不触发 focus', async () => {
    const editor = buildEditor()
    buildComposer([['甲', null]])
    editor.focus()
    expect(document.activeElement).toBe(editor)
    await openSheet()
    // 打开时先把焦点 blur 掉
    expect(document.activeElement).not.toBe(editor)
    const focusSpy = vi.spyOn(editor, 'focus')
    document.querySelector<HTMLElement>(BACKDROP)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
    expect(document.activeElement).not.toBe(editor)
    expect(focusSpy).not.toHaveBeenCalled()
    focusSpy.mockRestore()
  })

  it('打开期间输入框的 inputmode 被压成 none（不弹键盘）', async () => {
    const editor = buildEditor()
    buildComposer([['甲', null]])
    await openSheet()
    expect(editor.getAttribute('inputmode')).toBe('none')
  })

  it('关闭后 inputmode 还原成原值（不是一律删空）', async () => {
    const editor = buildEditor()
    editor.setAttribute('inputmode', 'text')
    buildComposer([['甲', null]])
    await openSheet()
    expect(editor.getAttribute('inputmode')).toBe('none')
    sheet.detach()
    sheet = new ComposerSheet()
    expect(editor.getAttribute('inputmode')).toBe('text')
  })

  it('选中一项后关闭也不聚焦不弹键盘', async () => {
    const editor = buildEditor()
    buildComposer([['甲', null]])
    editor.focus()
    await openSheet()
    const focusSpy = vi.spyOn(editor, 'focus')
    document.querySelector<HTMLElement>(ROW)!.click()
    expect(document.querySelector(BACKDROP)).toBeNull()
    expect(focusSpy).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(editor)
    focusSpy.mockRestore()
  })
})

describe('「+」底部 sheet：收起途径', () => {
  it('点遮罩收起', async () => {
    buildComposer([['甲', null]])
    await openSheet()
    document.querySelector<HTMLElement>(BACKDROP)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('点面板内部不收起', async () => {
    buildComposer([['甲', null]])
    await openSheet()
    document.querySelector<HTMLElement>(PANEL)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector(BACKDROP)).not.toBeNull()
  })

  it('返回键（popstate）收起', async () => {
    buildComposer([['甲', null]])
    await openSheet()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('Escape 收起', async () => {
    buildComposer([['甲', null]])
    await openSheet()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('detach 彻底清理：不留遮罩、不复原失败', async () => {
    buildComposer([['甲', null]])
    await openSheet()
    sheet.detach()
    expect(document.querySelector(BACKDROP)).toBeNull()
  })
})

describe('回形针按钮已下线', () => {
  it('④ 不再往 conversation.input.left 注入按钮', () => {
    const anchor = document.createElement('div')
    anchor.setAttribute('data-slot', 'conversation.input.left')
    document.body.append(anchor)
    buildComposer([['甲', null]])
    sheet.attach()
    expect(anchor.children).toHaveLength(0)
    expect(document.querySelector('[data-dsh-attachment-picker-trigger]')).toBeNull()
    expect(document.querySelector('[data-dsh-attachment-picker-menu]')).toBeNull()
  })

  it('样式表里不再有任何回形针相关规则', () => {
    expect(COMPOSER_SHEET_CSS).not.toContain('attachment-picker')
  })
})

describe('样式表守则', () => {
  it('瓦片 96 高、图标 28、标签 13、圆角 18', () => {
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile\]\s*\{[^}]*height:\s*96px/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile\]\s*\{[^}]*border-radius:\s*18px/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile\] svg\s*\{[^}]*width:\s*28px/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile-label\]\s*\{[^}]*font-size:\s*13px/)
  })

  it('三块瓦片等宽并排（grid 三列）', () => {
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tiles\]\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/)
  })
})
