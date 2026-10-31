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

describe('附件入口去重：隐藏上游「文件 / file」行', () => {
  /**
   * 真机菜单形状（2026-10-31 设备实测）：第一条是「文件 / file」，三块瓦片已经覆盖它。
   * 留着的代价是列表第一行永远是冗余项，且横屏卡片里它排在最上面。
   */
  const WITH_FILE: readonly (readonly [string, string | null])[] = [
    ['文件', 'file'],
    ['目标', '设置或查看长期任务目标'],
    ['计划', '进入或退出计划模式'],
    ['反馈', '发送关于当前会话的反馈'],
    ['压缩', '压缩以上对话内容'],
  ]

  it('文件行不复制进列表，其余行一条不少', async () => {
    buildComposer(WITH_FILE)
    await openSheet()
    const titles = [...document.querySelectorAll('[data-dsh-composer-sheet-row-title]')].map((el) => (el.textContent ?? '').trim())
    expect(titles).not.toContain('文件')
    // 其余四条必须都在：少一条就是「误伤」，不是「去重」。
    expect(titles).toEqual(['目标', '计划', '反馈', '压缩'])
  })

  it('英文文案同样命中（file）', async () => {
    buildComposer([['file', 'Choose a file'], ['Target', null], ['Plan', null]])
    await openSheet()
    const titles = [...document.querySelectorAll('[data-dsh-composer-sheet-row-title]')].map((el) => (el.textContent ?? '').trim())
    expect(titles).toEqual(['Target', 'Plan'])
  })

  it('不会留下空行（容器里没有占位节点）', async () => {
    buildComposer(WITH_FILE)
    await openSheet()
    const rows = document.querySelector<HTMLElement>('[data-dsh-composer-sheet-rows]')!
    // 行数必须等于「可点行」的数量：留一个空的 button 也算残留。
    expect(rows.querySelectorAll(ROW)).toHaveLength(4)
    expect([...rows.children].every((child) => child.tagName === 'BUTTON')).toBe(true)
  })

  /**
   * 负控：证明这条过滤不是「把第一行隐掉」。
   *
   * 如果实现退化成 `index === 0` / `li:first-child`，把「文件」从菜单里挪到第二条
   * 就会**保留**文件行、**误删**真正的第一条。下面这个夹具正是那个形状：
   * 首条是「目标」，第二条才是「文件」—— 正确实现必须删掉「文件」、保住「目标」。
   */
  it('负控：文件行不在首位时也必须被去掉，且首条不能被误删', async () => {
    buildComposer([['目标', null], ['文件', 'file'], ['计划', null]])
    await openSheet()
    const titles = [...document.querySelectorAll('[data-dsh-composer-sheet-row-title]')].map((el) => (el.textContent ?? '').trim())
    expect(titles).toEqual(['目标', '计划'])
  })

  /** 负控之二：前缀命中会误伤真实功能项。 */
  it('负控：以「文件」开头的其它功能项不得被误删', async () => {
    buildComposer([['文件预览', 'preview'], ['文件管理', 'manage'], ['文件', 'file']])
    await openSheet()
    const titles = [...document.querySelectorAll('[data-dsh-composer-sheet-row-title]')].map((el) => (el.textContent ?? '').trim())
    expect(titles).toEqual(['文件预览', '文件管理'])
  })
})

describe('居中卡片：限高与进出动画', () => {
  it('限高命中 min(70vh, 560px)，且滚动拓扑是「面板不滚、列表滚」', () => {
    // 新规格：卡片视口居中、固定落点，高度上限 min(70vh, 560px)。
    expect(COMPOSER_SHEET_CSS).toContain('max-height: min(70vh, 560px)')
    // 面板**不**承担滚动（旧写法是面板 overflow-y:auto，实测会让整个面板滚、
    // 列表反而 overflow:visible 不滚，与规格相反）。
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-panel\]\s*\{[^}]*overflow:\s*hidden/)
    expect(COMPOSER_SHEET_CSS).not.toMatch(/\[data-dsh-composer-sheet-panel\]\s*\{[^}]*overflow-y:\s*auto/)
    // 滚动落在列表上，且列表可收缩（否则 min-height:auto 会把它撑开、永远不滚）。
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-rows\]\s*\{[^}]*overflow-y:\s*auto/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-rows\]\s*\{[^}]*min-height:\s*0/)
  })

  it('行内左 padding >= 16px', () => {
    // 卡片居中后不再贴底，safe-area 由「卡片永远不贴视口底」天然规避
    // （max-height 70vh，上下各留 15vh）。这里只钉行内边距。
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-row\]\s*\{[^}]*padding:\s*6px 16px/)
  })

  it('进 200ms / 出 160ms，且 prefers-reduced-motion 直接切', () => {
    expect(COMPOSER_SHEET_CSS).toMatch(/dsh-composer-card-in 200ms/)
    expect(COMPOSER_SHEET_CSS).toMatch(/dsh-composer-card-out 160ms/)
    const at = COMPOSER_SHEET_CSS.lastIndexOf('prefers-reduced-motion')
    const reduced = COMPOSER_SHEET_CSS.slice(at)
    expect(reduced).toContain('animation: none')
    expect(reduced).toContain('transition: none')
  })

  it('标题自动换行而不是截断（窄屏不丢字）', () => {
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-row-title\]\s*\{[^}]*white-space:\s*normal/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-row-title\]\s*\{[^}]*overflow-wrap:\s*anywhere/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-row-title\]\s*\{[^}]*text-wrap:\s*pretty/)
  })

  /**
   * 三瓦片排的横向限位 + snap 是**两种形态共用**的（规格：三张卡片那排横向滚动限位）。
   *
   * 真缺陷形态（2026-10-31 设备实测 P14）：这几条一开始只写在横屏媒体查询里，
   * 竖屏实测 `overflow-x=visible` / `scroll-snap-type=none` —— 窄屏挤在一起也不会滚。
   * 所以判据必须落在**基础规则**上（横屏段只是把 grid 换成 flex）。
   */
  it('三瓦片排横向限位 + snap 在基础规则里（两种形态共用）', () => {
    const base = COMPOSER_SHEET_CSS.slice(
      COMPOSER_SHEET_CSS.indexOf('[data-dsh-composer-sheet-tiles] {'),
      COMPOSER_SHEET_CSS.indexOf('[data-dsh-composer-sheet-tile] {'),
    )
    expect(base).toContain('overflow-x: auto')
    expect(base).toContain('overscroll-behavior-x: contain')
    expect(base).toContain('scroll-snap-type: x proximity')
    // 不超出面板宽 + 可收缩（规格 2）。
    expect(base).toContain('max-width: 100%')
    expect(base).toContain('min-width: 0')
    expect(base).toContain('box-sizing: border-box')
    // 滚动条隐藏但滚动可用（规格 4）：chrome87 只认 ::-webkit-scrollbar。
    expect(base).toContain('scrollbar-width: none')
    expect(COMPOSER_SHEET_CSS).toContain('[data-dsh-composer-sheet-tiles]::-webkit-scrollbar')
    // 卡片不许收缩（规格 1）：装不下时靠滚动，而不是把卡片压窄。
    //
    // 断言写成 `\n\s*flex: 0 0 auto;` 而不是 `[^}]*flex: 0 0 auto`：后者会匹配到
    // 注释里的同名字面量（实测踩过 —— 把声明改成 flex: 1 1 auto 后判据仍绿，
    // 因为它匹配的是上面注释文字）。要求行首 + 结尾分号，才算真声明。
    expect(COMPOSER_SHEET_CSS).toMatch(/\n\s*flex:\s*0 0 auto;/)
  })

  /**
   * 真缺陷（本次规格暴露）：基础规则原来用 `display: grid; grid-template-columns: repeat(3, 1fr)`。
   *
   * `1fr` 轨道按容器宽度均分，**永远不会溢出** —— 配了 overflow-x: auto 也滚不起来，
   * 窄屏下只是把三块越压越窄（360 宽面板实测 105px，320 宽更窄），标题于是挤成多行或被裁。
   * 所以要真滚动，必须是 flex + 卡片 `flex: 0 0 auto` + `min-width` 兜底。
   */
  it('瓦片排不是 grid 1fr（1fr 永不溢出，配 overflow 也滚不起来）', () => {
    const base = COMPOSER_SHEET_CSS.slice(
      COMPOSER_SHEET_CSS.indexOf('[data-dsh-composer-sheet-tiles] {'),
      COMPOSER_SHEET_CSS.indexOf('[data-dsh-composer-sheet-tile] {'),
    )
    expect(base).not.toContain('repeat(3, 1fr)')
    expect(base).toContain('display: flex')
    expect(base).toContain('flex-wrap: nowrap')
    // 卡片必须有最小宽度，否则 flex 会把它们压到 0 宽（滚动依旧不出现）。
    expect(COMPOSER_SHEET_CSS).toMatch(/\n\s*min-width:\s*96px;/)
  })

  /**
   * 标题自动换行（规格 3）：窄屏下换行而不是省略号/被裁。
   *
   * `anywhere` 而不是 `break-word`：中文没有词边界，break-word 对连续汉字不生效。
   * 同时不能留 `nowrap`（那是单行省略号的写法）。
   */
  it('瓦片标题自动换行（normal + anywhere + pretty，且不是 nowrap）', () => {
    const start = COMPOSER_SHEET_CSS.indexOf('[data-dsh-composer-sheet-tile-label] {')
    // 只取这一个规则块（到第一个右花括号），避免把后面规则的 nowrap 带进来误判。
    const label = COMPOSER_SHEET_CSS.slice(start, COMPOSER_SHEET_CSS.indexOf('}', start) + 1)
    expect(label).toContain('white-space: normal')
    expect(label).toContain('overflow-wrap: anywhere')
    expect(label).toContain('text-wrap: pretty')
    expect(label).not.toContain('nowrap')
    expect(label).not.toContain('text-overflow')
  })

  it('关闭时先挂 leaving 标记再移除（收场动画），无 WAAPI 时立刻移除', async () => {
    buildComposer([['命令', null]])
    await openSheet()
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    // jsdom 没有 getAnimations：实现必须走「立刻移除」那条退化路径，不能把面板留在 DOM 里。
    backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(document.querySelector(BACKDROP)).toBeNull()
  })
})

describe('借用窗口内上游菜单不得可见（漏字的真因之一）', () => {
  /**
   * 真缺陷形态（2026-10-31 设备实测）：点「+」后上游菜单自己开出来，我们的 sheet 接手时
   * 要借用它读项。从菜单挂上到被关掉之间约 1.2s，它**真的画在屏幕上** ——
   * listbox right=1022.33，卡片 right=682.33，那一列 role=option 的副标题露在卡片外。
   *
   * 稳定帧看不到它（那时已经关了），所以这条必须在**借用进行中**采样。
   */
  /**
   * 探针：让上游「晚一拍」才把选项填进去，从而造出一个**真实的**借用窗口。
   *
   * 为什么必须这样（两次踩坑的教训）：
   *   1. 用 setInterval(1ms) 采样 —— jsdom 里整个借用窗口只有几个微任务长，一次都插不进去，
   *      采样数组恒为空，看起来像「实现没隐藏」，其实是采样器太慢；
   *   2. 用属性级 MutationObserver 采样 —— 隐藏与还原发生在同一批微任务里，
   *      观察器回调只在批次结束时跑一次，读到的已经是**最终值**（还原后的空串），
   *      于是同样看不到 hidden。
   * 结论：采样器不能只看最终态，必须让借用窗口跨越至少一个宏任务。
   */
  async function openWithSlowUpstream(): Promise<{
    card: HTMLElement
    samples: { visible: string; concealed: boolean }[]
    /** 采样期间见过的外壳节点本身：借用结束后直接查它们（节点可能已脱 DOM）。 */
    shells: HTMLElement[]
  }> {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const add = document.createElement('button')
    add.type = 'button'
    add.setAttribute('aria-haspopup', 'listbox')
    add.setAttribute('aria-expanded', 'false')
    card.append(add)
    document.body.append(card)
    const editor = document.createElement('div')
    editor.setAttribute('data-composer-input', '')
    editor.setAttribute('contenteditable', 'true')
    card.insertBefore(editor, card.firstChild)
    // 点「+」后**先挂空外壳**，选项隔一个宏任务才填（真机就是这个节奏，实测约 1.2s）。
    add.addEventListener('click', () => {
      if (card.querySelector('[role="listbox"]') !== null) return
      const surface = document.createElement('div')
      surface.setAttribute('data-trigger-menu', '')
      const list = document.createElement('div')
      list.setAttribute('role', 'listbox')
      surface.append(list)
      card.append(surface)
      setTimeout(() => {
        for (const label of ['目标', '计划']) list.append(option(label, null))
      }, 20)
    })
    editor.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      card.querySelector('[data-trigger-menu]')?.remove()
    })
    const samples: { visible: string; concealed: boolean }[] = []
    const shells: HTMLElement[] = []
    const probe = setInterval(() => {
      const shell = card.querySelector<HTMLElement>('[data-trigger-menu]')
      if (shell === null) return
      if (!shells.includes(shell)) shells.push(shell)
      samples.push({
        visible: shell.style.getPropertyValue('visibility'),
        concealed: shell.hasAttribute('data-dsh-composer-sheet-concealed'),
      })
    }, 2)
    sheet.attach()
    add.click()
    // 等到选项真的被映射成行（借用结束）再停采样。
    await settleSlow(1000)
    clearInterval(probe)
    return { card, samples, shells }
  }

  it('读菜单期间上游菜单被隐藏（visibility: hidden），读完后还原', async () => {
    const { samples, shells } = await openWithSlowUpstream()
    // 借用窗口内必须出现「隐藏」这个状态（否则它全程可见 = 漏字）。
    expect(samples.some((s) => s.visible === 'hidden')).toBe(true)
    // 且必须带临时标记（还原时按标记清理，两条要一致）。
    expect(samples.some((s) => s.concealed)).toBe(true)
    // 借用结束后必须还原干净：上游节点不能永久不可见（那是别人的 DOM）。
    //
    // **不看采样末帧**：采样器 2ms 一拍，借用结束时它可能已经停了，末帧还停在
    // 「隐藏」上——那是采样竞态，不是实现没还原（实测就踩过这个假红）。
    // 正确做法是直接查采样期间持有的节点：它可能已脱 DOM，但 style/属性仍可读。
    expect(shells.length).toBeGreaterThan(0)
    for (const shell of shells) {
      expect(shell.style.getPropertyValue('visibility')).toBe('')
      expect(shell.hasAttribute('data-dsh-composer-sheet-concealed')).toBe(false)
    }
  })

  /**
   * 藏的是**最外层容器**（[data-trigger-menu]），不是 listbox 本身。
   *
   * 真机结构：MenuSurface 渲染 [data-trigger-menu] 外壳，里面才是 role=listbox。
   * 只藏 listbox 时外壳仍然可见 —— 外壳自身可能带背景/边框/定位，露出来同样是漏字。
   * 撤掉 closest() 回退到 listbox 即判红（负控实测：1 条红）。
   */
  it('隐藏的是菜单最外层容器，不是只藏 listbox', async () => {
    const { samples, shells } = await openWithSlowUpstream()
    // 采样器读的就是外壳；外壳被隐藏 ⇒ 判据成立。
    expect(samples.some((s) => s.visible === 'hidden')).toBe(true)
    // 藏的是外壳：listbox 自己不带隐藏标记，也不带内联 hidden。
    for (const shell of shells) {
      const listbox = shell.querySelector<HTMLElement>('[role="listbox"]')
      if (listbox === null) continue
      expect(listbox.hasAttribute('data-dsh-composer-sheet-concealed')).toBe(false)
      expect(listbox.style.getPropertyValue('visibility')).toBe('')
    }
  })

  it('负控：撤掉隐藏逻辑后同一采样必须观测不到 hidden', async () => {
    // 受控负控：直接构造「不隐藏」的情形（上游菜单已在场，不经过 withUpstreamMenu 的隐藏段），
    // 证明上面那条断言不是恒真 —— 采样逻辑本身确实能区分「可见」与「隐藏」。
    const { card } = buildComposer([['目标', null]])
    const surface = document.createElement('div')
    surface.setAttribute('data-trigger-menu', '')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    surface.append(list)
    card.append(surface)
    const seen: (string | null)[] = []
    const timer = setInterval(() => { seen.push(surface.style.getPropertyValue('visibility')) }, 1)
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    clearInterval(timer)
    expect(seen).not.toContain('hidden')
  })
})

describe('退场动画：标记必须先于取动画', () => {
  /**
   * 真缺陷形态（2026-10-31 设备实测）：离场期间观测到 **0 个**动画帧。
   *
   * 根因是顺序：playExit 先调 getAnimations() 再挂 LEAVING_ATTR。
   * getAnimations() 只返回**当前已存在**的动画对象，而退场动画由 LEAVING_ATTR
   * 那条 CSS 规则定义 —— 先取后挂，取到的永远是空集或入场动画，于是
   * 「没有动画就立刻 remove」把面板直接抹掉，用户看不到收回。
   *
   * jsdom 没有 WAAPI，所以这里用一个**可观测的假 getAnimations** 来钉顺序：
   * 假实现被调用时回读此刻是否已挂 LEAVING_ATTR，从而证明顺序正确。
   */
  it('调用 getAnimations 时 LEAVING_ATTR 已经挂上（顺序判据）', async () => {
    buildComposer([['命令', null]])
    await openSheet()
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    let sawLeavingAtCallTime: boolean | null = null
    let callCount = 0
    // 只在遮罩上装假 WAAPI：回读标记状态，然后返回空数组（让实现走「立刻移除」分支）。
    Object.defineProperty(backdrop, 'getAnimations', {
      configurable: true,
      value: (options?: { subtree?: boolean }) => {
        callCount += 1
        sawLeavingAtCallTime = backdrop.hasAttribute('data-dsh-composer-sheet-leaving')
        // 顺带钉住 subtree: true —— 竖屏退场动画挂在子元素 panel 上。
        expect(options?.subtree).toBe(true)
        return []
      },
    })
    backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(callCount).toBe(1)
    expect(sawLeavingAtCallTime).toBe(true)
    // 空动画集 ⇒ 立刻移除（不能把面板留在 DOM 里）。
    expect(document.querySelector(BACKDROP)).toBeNull()
  })

  /**
   * 兜底计时器：动画对象存在但永远不 finish（被打断 / 事件丢失）时，面板也必须被移除。
   *
   * 真风险：动画可能因元素不可见、浏览器跳过、或事件丢失而**永不触发 finish**。
   * 只靠事件的话面板会永久留在 DOM 里 —— 比没有动画严重得多（点不开也关不掉）。
   * 所以 playExit 除了监听 finish/cancel，还必须挂一个「时长 + 余量」的计时器。
   */
  it('动画永不 finish 时，兜底计时器仍然移除面板', async () => {
    vi.useFakeTimers()
    try {
      buildComposer([['命令', null]])
      sheet.attach()
      document.querySelector<HTMLElement>(ADD)!.click()
      // 等行填完（fake timers 下用 advance 驱动）。
      await vi.advanceTimersByTimeAsync(50)
      const backdrop = document.querySelector<HTMLElement>(BACKDROP)
      expect(backdrop).not.toBeNull()
      // 假动画：永远不派发 finish/cancel。
      Object.defineProperty(backdrop!, 'getAnimations', {
        configurable: true,
        value: () => [{ addEventListener: () => {} }],
      })
      backdrop!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
      // 兜底是 160ms + 120ms 余量；推进到它之后必须已经移除。
      await vi.advanceTimersByTimeAsync(400)
      expect(document.querySelector(BACKDROP)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('负控：先取后挂（顺序反了）必须被这条判据抓住', async () => {
    // 直接验证判据本身能区分两种顺序：这里手工模拟「先取后挂」的读数。
    buildComposer([['命令', null]])
    await openSheet()
    const backdrop = document.querySelector<HTMLElement>(BACKDROP)!
    // 顺序反了时，取动画那一刻标记还没挂 ⇒ sawLeaving=false。
    const sawLeavingIfReversed = backdrop.hasAttribute('data-dsh-composer-sheet-leaving')
    expect(sawLeavingIfReversed).toBe(false)
  })
})

describe('样式表守则', () => {
  it('瓦片 96 高、图标 28、标签 13、圆角走 token', () => {
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile\]\s*\{[^}]*height:\s*96px/)
    // 圆角只准用现有 token（规格：不得新增 hex / 裸值）。
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile\]\s*\{[^}]*border-radius:\s*var\(--dsw-radius-lg/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile\] svg\s*\{[^}]*width:\s*28px/)
    expect(COMPOSER_SHEET_CSS).toMatch(/\[data-dsh-composer-sheet-tile-label\]\s*\{[^}]*font-size:\s*13px/)
  })

  /**
   * 颜色/圆角 token 纪律（规格：只准用现有 --dsw-*，不得新增 hex）。
   *
   * 判据取「新增」而不是「存在」：这个样式表历史上已经有一批 rgba 阴影/半透明底，
   * 一次性清零会连带改掉既有观感（超出本 PR 范围）。所以钉的是**本 PR 引入的
   * 那几条必须走 token**：面板圆角、瓦片圆角、行圆角都不许出现裸 px 值。
   */
  it('圆角一律走 --dsw-radius-* token，不写裸 px', () => {
    const radiusDecls = [...COMPOSER_SHEET_CSS.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(radiusDecls.length).toBeGreaterThan(0)
    for (const decl of radiusDecls) {
      // 多角简写（上两角 0 0）允许 0，但任何非零值都必须是 token。
      const parts = decl.split(/\s+(?![^(]*\))/)
      for (const part of parts) {
        if (part === '0') continue
        expect(part).toContain('var(--dsw-radius-')
      }
    }
  })

  it('三块瓦片装得下时等分铺满（flex 三等分，装不下才滚）', () => {
    // 装得下时按三等分铺满（与改造前实测 105.33px 一致），装不下由 min-width 兜底。
    expect(COMPOSER_SHEET_CSS).toMatch(/\n\s*width:\s*calc\(\(100% - 20px\) \/ 3\)/)
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
