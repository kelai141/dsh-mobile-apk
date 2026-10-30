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

/** 上游合成器卡片的壳：card > tools > （+ 与 hidden file input）。 */
function buildCard(): { add: HTMLButtonElement; input: HTMLInputElement; card: HTMLElement } {
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
  return { add, input, card }
}

/**
 * 上游「+」菜单的 Esc 关闭，挂在**编辑器根元素**上。
 *
 * 真机链路：Lexical 把 keydown 挂在 contenteditable 上（上游 ComposerContentEditable
 * 渲染的 [data-composer-input]），MenuView 的 document 监听收的是冒泡到那里的同一个事件。
 * 夹具照抄这个形状：只挂元素级监听 —— 直接 document.dispatchEvent 的 Escape
 * 传播路径只有 [document, window]，到不了这里，也就复现不出 #998 的 bug。
 */
function wireEscapeOnEditor(editor: HTMLElement, card: HTMLElement, add: HTMLButtonElement): void {
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    card.querySelector('[data-trigger-menu]')?.remove()
    add.setAttribute('aria-expanded', 'false')
  })
}

/** 上游编辑器根元素（真机上是 contenteditable div）。 */
function buildComposerEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.setAttribute('data-composer-input', '')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('role', 'textbox')
  return editor
}

/**
 * 点「+」后上游把菜单挂到卡片里。
 * @param card - 卡片。
 * @param add - 「+」。
 * @param labels - 上游菜单里要出现的项（标签、可选副标题）。
 * @param delays - 提交节奏：menuDelayMs 控制容器什么时候挂、fillDelayMs 控制容器挂上后
 *   **再过几毫秒才填选项**（真机上游会先提交容器、下一帧才填 [role=option]）。
 *   缺省 0 = 同一帧挂完填完。
 */
function wireUpstreamMenu(
  card: HTMLElement,
  add: HTMLButtonElement,
  labels: readonly (readonly [string, string | null])[],
  delays: { menuDelayMs?: number; fillDelayMs?: number } = {},
): void {
  const { menuDelayMs = 0, fillDelayMs = 0 } = delays
  add.addEventListener('click', () => {
    if (card.querySelector('[role="listbox"]') !== null) return
    const mount = (): void => {
      // 真实上游结构（MenuView.tsx:132）：MenuSurface 的 [data-trigger-menu] 里直接
      // 是 role="listbox"，**没有** role="menu" 这一层。夹具照抄这个形状，
      // 否则选择器写错也测不出来。
      const surface = document.createElement('div')
      surface.setAttribute('data-trigger-menu', '')
      const list = document.createElement('div')
      list.setAttribute('role', 'listbox')
      surface.append(list)
      card.append(surface)
      const fill = (): void => {
        for (const [label, description] of labels) list.append(option(label, description))
      }
      if (fillDelayMs <= 0) fill()
      else setTimeout(fill, fillDelayMs)
    }
    if (menuDelayMs <= 0) mount()
    else setTimeout(mount, menuDelayMs)
    add.setAttribute('aria-expanded', 'true')
  })
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
  const { add, input, card } = buildCard()
  const editor = buildComposerEditor()
  card.insertBefore(editor, card.firstChild)
  wireUpstreamMenu(card, add, labels)
  wireEscapeOnEditor(editor, card, add)
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

/** 读借用闸的当前值（用户看不见它，但残留时 Escape 会被永久吞掉）。 */
function borrowingOf(target: ComposerSheet): boolean {
  return (target as unknown as { borrowing: boolean }).borrowing
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

/**
 * 同上，但给「上游晚一步才给数据」的路径留足时间（默认最多等 1s）。
 *
 * settle() 只让出几十个空任务，够不到上游那 25ms 一轮的轮询；这类用例自己定截止时间。
 */
async function settleSlow(timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
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
    expect(card.querySelector('[role="listbox"]')).toBeNull()
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
    // 正向钉住「转发到了哪一项」：只断言「没有 click」在转发全断时也成立
    // （forwards 是空数组，.some() 恒 false），等于什么都没守（#1010）。
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['甲', '乙 — 说明'])
    rows[1].click()
    // 转发要等上游菜单重新开出来（跨一次提交），见 withUpstreamMenu。
    await settle()
    expect(forwards).toContain('mousedown:乙')
    // 反证：若转发用 click，这里会是 click:乙 而上游根本不响应
    expect(forwards).not.toContain('click:乙')
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
    expect(card.querySelector('[role="listbox"]')).toBeNull()
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

  it('编辑器根不在场时退化为 card 上的 Escape（菜单照样关掉）', async () => {
    // 上游不再打 data-composer-input / contenteditable 时的退化路径：
    // card 上仍派发 Escape（bubbles），所以挂在 card 自己的关闭监听照样收到。
    const { add, card } = buildCard()
    wireUpstreamMenu(card, add, [['甲', null]])
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      card.querySelector('[data-trigger-menu]')?.remove()
      add.setAttribute('aria-expanded', 'false')
    })
    sheet.attach()
    document.querySelector<HTMLElement>(ADD)!.click()
    await settle()
    expect(card.querySelector('[role="listbox"]')).toBeNull()
  })
})

describe('「+」底部 sheet：#998 关上游菜单的 Escape 落点', () => {
  it('Escape 派发到编辑器根元素，不是 document', async () => {
    // 真机链路：Lexical 把 keydown 挂在编辑器根上，document.dispatchEvent 的传播路径
    // 只有 [document, window]，到不了那里 —— 上游菜单留在屏幕上。
    const { card } = buildComposer([['甲', null]])
    const editor = card.querySelector<HTMLElement>('[data-composer-input]')!
    const seen: string[] = []
    editor.addEventListener('keydown', (event) => { seen.push(event.key) })
    await openSheet()
    expect(seen).toContain('Escape')
    expect(card.querySelector('[role="listbox"]')).toBeNull()
  })
})

describe('「+」底部 sheet：#1001 借用闸必须复位', () => {
  it('上游菜单读不到时借用闸已复位：之后按 Escape 能关掉 sheet', async () => {
    // 借用闸若漏在 true，onKeyDown 会把用户的 Escape 当成「我们自己关上游菜单的那一下」吞掉。
    // 卡片里没有编辑器、也没有能开出菜单的东西：读菜单必然空手而归（早退路径）。
    // 那条路径要先等满 3s 超时，这里用假计时器把这段等待快进掉（判据不变）。
    const { add } = buildCard()
    add.addEventListener('click', () => {})
    sheet.attach()
    vi.useFakeTimers()
    try {
      document.querySelector<HTMLElement>(ADD)!.click()
      await vi.advanceTimersByTimeAsync(3100)
    } finally {
      vi.useRealTimers()
    }
    expect(document.querySelector(BACKDROP)).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  it('关闭 sheet 时借用闸一起复位（不留残留）', async () => {
    // 借用闸只在借用段内合上，复位是异步的；用户中途关掉时 close() 必须立刻把它扳回来，
    // 否则下一次按下 Escape 会被当成「我们自己关上游菜单的那一下」吞掉。用户看不见这把闸，
    // 所以直接看实例状态（这是它唯一会被观察到的地方）。
    // 卡片里没有能开出菜单的东西：借用只能等到 3s 超时，闸会一直合着。
    const { add } = buildCard()
    add.addEventListener('click', () => {})
    sheet.attach()
    vi.useFakeTimers()
    try {
      document.querySelector<HTMLElement>(ADD)!.click()
      await vi.advanceTimersByTimeAsync(50)
      expect(borrowingOf(sheet)).toBe(true)
      window.dispatchEvent(new PopStateEvent('popstate'))
      expect(document.querySelector(BACKDROP)).toBeNull()
      expect(borrowingOf(sheet)).toBe(false)
      // 让那次借用自己走完超时，别把悬挂的计时器留给后面的用例。
      await vi.advanceTimersByTimeAsync(3100)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('「+」底部 sheet：#1002 等的是选项不是容器', () => {
  it('上游先挂容器、稍后才填选项：仍能映射出全部行', async () => {
    // 只等容器会在这两帧之间 resolve，读到 0 项，面板只剩三块瓦片。
    const { add, card } = buildCard()
    card.insertBefore(buildComposerEditor(), card.firstChild)
    wireUpstreamMenu(card, add, [['甲', null], ['乙', '说明']], { fillDelayMs: 150 })
    sheet.attach()
    document.querySelector<HTMLElement>(ADD)!.click()
    await settleSlow()
    const titles = [...document.querySelectorAll('[data-dsh-composer-sheet-row-title]')]
      .map(node => node.textContent)
    expect(titles).toEqual(['甲', '乙'])
  })
})

describe('「+」底部 sheet：#999 收尾不碰已关闭之后的焦点', () => {
  it('读菜单期间用户关掉 sheet：迟到的收尾不得 blur 用户此刻的焦点', async () => {
    // 上游慢一拍才给菜单：收尾一定落在 close() 之后。
    const { add, card } = buildCard()
    card.insertBefore(buildComposerEditor(), card.firstChild)
    wireUpstreamMenu(card, add, [['甲', null]], { menuDelayMs: 150 })
    sheet.attach()
    document.querySelector<HTMLElement>(ADD)!.click()
    // 用户此刻在别处输入（sheet 已经关了，键盘应该留着）。
    document.querySelector<HTMLElement>(BACKDROP)!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
    const typing = buildEditor()
    typing.focus()
    expect(document.activeElement).toBe(typing)
    await new Promise<void>((resolve) => { setTimeout(resolve, 350) })
    expect(document.activeElement).toBe(typing)
  })
})

describe('「+」底部 sheet：#1009 打开时锁背景滚动', () => {
  it('打开时 body overflow 置 hidden，关闭按快照还原（不是一律清空）', async () => {
    document.body.style.overflow = 'scroll'
    buildComposer([['甲', null]])
    await openSheet()
    expect(document.body.style.overflow).toBe('hidden')
    document.querySelector<HTMLElement>(BACKDROP)!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('打开前 body 没有 overflow 时，关闭后回到「没有」而不是留下空串', async () => {
    document.body.removeAttribute('style')
    buildComposer([['甲', null]])
    await openSheet()
    expect(document.body.style.overflow).toBe('hidden')
    document.querySelector<HTMLElement>(BACKDROP)!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(document.body.style.overflow).toBe('')
  })
})

describe('「+」底部 sheet：#1009 样式表滚动约束', () => {
  it('遮罩与面板都加 overscroll-behavior: contain', () => {
    expect(COMPOSER_SHEET_CSS)
      .toMatch(/\[data-dsh-composer-sheet-backdrop\]\s*\{[^}]*overscroll-behavior:\s*contain/)
    expect(COMPOSER_SHEET_CSS)
      .toMatch(/\[data-dsh-composer-sheet-panel\]\s*\{[^}]*overscroll-behavior-y:\s*contain/)
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
describe('「+」底部 sheet：#929 焦点顺序（复现真机 MenuView 的焦点要求）', () => {
  /**
   * 真机行为：上游 MenuView 把自己绑在 draft editor 的 caret 上，**编辑器不持焦点就不开菜单**。
   * 现有 buildComposer 无条件生成菜单，所以旧实现「先 blur 再读」在 jsdom 里永远绿 ——
   * 这正是 #892 能带着「未验」合并、设备上映射行永远 0 的原因。
   */
  function buildFocusGatedComposer(
    labels: readonly (readonly [string, string | null])[],
    editor: HTMLElement,
  ): { add: HTMLButtonElement; card: HTMLElement } {
    const { add, card } = buildCard()
    // 真机判据：编辑器不持焦点 -> 菜单不开 -> 读到 0 项。
    add.addEventListener('click', () => {
      if (card.querySelector('[role="listbox"]') !== null) return
      if (document.activeElement !== editor) return
      const surface = document.createElement('div')
      surface.setAttribute('data-trigger-menu', '')
      const list = document.createElement('div')
      list.setAttribute('role', 'listbox')
      for (const [label, description] of labels) list.append(option(label, description))
      surface.append(list)
      card.append(surface)
      add.setAttribute('aria-expanded', 'true')
    })
    return { add, card }
  }

  it('编辑器持焦点时才读得到上游项（先 blur 即 0 行）', async () => {
    const editor = buildEditor()
    buildFocusGatedComposer([['调用指令', '/ 开头的指令']], editor)
    editor.focus()
    expect(document.activeElement).toBe(editor)
    sheet.attach()
    document.querySelector<HTMLElement>(ADD)!.click()
    await settle()
    const rows = [...document.querySelectorAll(ROW)]
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('[data-dsh-composer-sheet-row-title]')?.textContent).toBe('调用指令')
    // 读完之后焦点必须已被压掉：sheet 停留期间不能有键盘。
    expect(document.activeElement).not.toBe(editor)
  })
})
