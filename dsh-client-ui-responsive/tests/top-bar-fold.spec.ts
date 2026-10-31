// @vitest-environment jsdom
// D 项：竖屏顶栏插件 UI 折叠（0.14.7 / Spec 2.6），含 E 项灰色圆角矩形的收口。
//
// 真机实测（MuMu PGBM10，600px 视口，header 高 76，tabs 行 y=50.17..75.33）结构：
//   header[data-window-drag]
//     > div[data-conversation-header-leading]        ← [data-dsh-sidebar-toggle]
//     > div[data-slot=conversation.session.header]
//         > div.titleRow                              ← container-type: inline-size
//             > div.headerActions
//                 > div[data-slot=...header.actions]  ← 折叠对象（座位容器）
// 座位下真机当前有两个节点：preset 模式标签 + vendor 快照徽章（div[data-undo-header]）。
//
// 箭头落位（用户 2026-10 推翻旧设计决定）：要「整行最右、与『对话 / 轨迹』同一行」。
// 旧决定是「贴着最后一个视图标签、留在标签条内部」，实机就是掉到标签行下面且偏左。
//
// 标签行形状（真机实测 emulator-5558 竖屏 600x1067，dsh 0.2.1-rc.2，真实非空会话）：
//   div.wSkVaW_tabs                    ← 行容器 display:flex; flex-wrap:wrap;
//     |                                 align-items:flex-start; gap:16px 20px;
//     |                                 padding-left:8px; rect x=20 right=572
//     ├ div.wSkVaW_viewTabs[data-conversation-tabs]
//     |                                 display:flex; flex-wrap:wrap; width=140.02; flex:0 1 auto
//     └ span.wSkVaW_viewsMoreAnchor + button[aria-haspopup=menu]「更多会话视图」
//
// 箭头必须挂在**父行**（tabs.parentElement）末位：标签条自己是 flex:0 1 auto、宽度=内容宽，
// 内部没有剩余空间，auto 外边距在那里推不动（实测 x 恒为 144.02）。
// 验收线：箭头右边缘距视口 ≤16px；与标签文字中心差 ≤2px。
// 判据写死在 DOM 结构上（结构位置 + 样式声明），不用 getBoundingClientRect —— jsdom 没有布局引擎。
// 换行阈值（实测）：2 个标签不换行；到 6 个时行高 25.17 -> 65、箭头掉到第二行；7 个换行。
// 刻意不加 nowrap（加了行高反而变 82，更挤）。
//
// 硬判据：面板里可见的节点集合 === 座位当前实际挂载的节点集合（动态，不枚举插件名）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TopBarFold } from '../src/client/mobile/top-bar-fold.ts'
import { TOP_BAR_FOLD_CSS } from '../src/client/mobile/top-bar-fold.css.ts'

const ACTIONS_SELECTOR = 'div[data-slot="conversation.session.header.actions"]'
const ARROW_ATTR = 'data-dsh-topbar-fold-arrow'
const FOLD_ATTR = 'data-dsh-topbar-fold'

let fold: TopBarFold

/**
   * 搭出与上游同形的标题栏。extra 是该座位下的「已注册插件 UI」节点。
   *
   * 标签行按**真机实测**形状搭（emulator-5558 / dsh 0.2.1-rc.2）：
   *   div.tabs                                 ← 行容器（flex, flex-wrap:wrap, align-items:flex-start）
   *     > div.viewTabs[role=tablist][data-conversation-tabs]  ← React 拥有的标签列表（flex:0 1 auto）
   *     > span.viewsMoreAnchor + button[aria-haspopup=menu]   ← 上游「…」菜单，行的兄弟节点
   * 箭头必须落在这个行容器里、并且是它的末位。
   * @param plugins - 座位下要挂载的节点数量。
   * @param withTabs - 是否渲染视图标签行。
   * @param withMoreMenu - 是否带上游「…」菜单（行的兄弟节点）。
   */
function buildHeader(plugins: number, withTabs = true, withMoreMenu = true): void {
  const header = document.createElement('header')
  header.setAttribute('data-window-drag', '')
  const leading = document.createElement('div')
  leading.setAttribute('data-conversation-header-leading', '')
  const toggle = document.createElement('button')
  toggle.setAttribute('data-dsh-sidebar-toggle', '')
  leading.appendChild(toggle)
  header.appendChild(leading)

  const sessionSeat = document.createElement('div')
  sessionSeat.setAttribute('data-slot', 'conversation.session.header')
  const titleRow = document.createElement('div')
  titleRow.className = 'titleRow'
  const crumbs = document.createElement('nav')
  crumbs.textContent = '月度现金流核算与报告'
  titleRow.appendChild(crumbs)
  const actions = document.createElement('div')
  actions.className = 'headerActions'
  const seat = document.createElement('div')
  seat.setAttribute('data-slot', 'conversation.session.header.actions')
  for (let i = 0; i < plugins; i++) {
    const node = document.createElement('span')
    node.setAttribute('data-plugin-node', String(i))
    node.textContent = 'plugin-' + String(i)
    seat.appendChild(node)
  }
  actions.appendChild(seat)
  titleRow.appendChild(actions)
  sessionSeat.appendChild(titleRow)
  header.appendChild(sessionSeat)
  if (withTabs) {
    const row = document.createElement('div')
    row.className = 'tabs'
    // 实测：行是 flex + flex-wrap:wrap + align-items:flex-start（箭头靠 align-self:center 对齐）。
    row.style.display = 'flex'
    row.style.flexWrap = 'wrap'
    row.style.alignItems = 'flex-start'
    const tabs = document.createElement('div')
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('data-conversation-tabs', '')
    tabs.className = 'viewTabs'
    // 实测：标签条 flex:0 1 auto、宽度=内容宽 —— 内部没有剩余空间，auto 外边距在这里推不动。
    tabs.style.display = 'flex'
    tabs.style.flex = '0 1 auto'
    for (const label of ['对话', '轨迹']) {
      const tab = document.createElement('button')
      tab.setAttribute('role', 'tab')
      tab.textContent = label
      // 实测 .wSkVaW_tab：line-height:16px + padding:0 0 9px -> 按钮盒 25px，文字中心比盒中心高 4.5px。
      // 箭头的 -4px 上移量就是按这个盒子算出来的，所以 fixture 必须带上它。
      tab.style.lineHeight = '16px'
      tab.style.padding = '0 0 9px'
      tab.style.minHeight = '25px'
      tabs.appendChild(tab)
    }
    row.appendChild(tabs)
    if (withMoreMenu) {
      const anchor = document.createElement('span')
      anchor.className = 'viewsMoreAnchor'
      row.appendChild(anchor)
      const menu = document.createElement('button')
      menu.type = 'button'
      menu.setAttribute('aria-haspopup', 'menu')
      menu.textContent = '更多会话视图'
      row.appendChild(menu)
    }
    header.appendChild(row)
  }
  document.body.appendChild(header)
}

/** 折叠相关的可观测状态。 */
function state(): { seat: HTMLElement; arrow: HTMLElement | null; fold: string | null; titleUncontained: boolean } {
  const seat = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)!
  const titleRow = document.querySelector<HTMLElement>('.titleRow')!
  return {
    seat,
    arrow: document.querySelector<HTMLElement>('[' + ARROW_ATTR + ']'),
    fold: seat.getAttribute(FOLD_ATTR),
    titleUncontained: titleRow.hasAttribute('data-dsh-topbar-fold-uncontained'),
  }
}

/** 面板里可见的节点集合（判据用：必须等于座位实际挂载集合）。 */
function panelNodes(): string[] {
  const seat = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)!
  if (seat.getAttribute(FOLD_ATTR) !== 'open') return []
  return [...seat.children].map(child => child.getAttribute('data-plugin-node') ?? child.tagName)
}

/** 座位当前实际挂载的节点集合。 */
function mountedNodes(): string[] {
  const seat = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)!
  return [...seat.children].map(child => child.getAttribute('data-plugin-node') ?? child.tagName)
}

/** 取样式表里折叠箭头那条基础规则的声明块（第一条匹配，svg / aria-expanded 规则在后面）。 */
function arrowRule(css: string): string {
  const match = /\[data-dsh-topbar-fold-arrow\]\s*\{([^}]*)\}/.exec(css)
  if (match === null) throw new Error('样式表里找不到折叠箭头的规则')
  return match[1]
}

/**
 * 「靠右 + 与标签同一行」的唯一判据（jsdom 没有布局引擎，所以判据落在结构位置 + 样式声明上）。
 *
 * 每条不满足都 throw：负控用例拿被篡改的 CSS/DOM 跑同一个函数，必须变红 —— 判据本身要能被证伪。
 */
function assertArrowRightAligned(css: string, arrow: HTMLElement): void {
  // ① 结构：箭头是标签行（tabs.parentElement）的末位孩子。这是「整行最右」在 DOM 上唯一可断言的形式。
  const tabs = document.querySelector<HTMLElement>('[data-conversation-tabs]')
  if (tabs === null) throw new Error('页面上没有视图标签条')
  const row = tabs.parentElement
  if (row === null) throw new Error('视图标签条没有父行')
  const parent = arrow.parentElement
  if (parent === null) throw new Error('箭头没有父节点')
  if (parent === tabs) {
    throw new Error('箭头落在标签条内部：标签条宽度=内容宽，auto 外边距推不动（实测 x 恒为 144.02）')
  }
  if (parent !== row) throw new Error('箭头不在标签行里')
  if (row.lastElementChild !== arrow) throw new Error('箭头不是标签行的末位孩子：右侧还有兄弟节点')
  // ② 同一行：箭头与标签文字在同一个行盒子里（父行）。
  // ③ 水平：auto 起始外边距吃掉行内剩余空间推到最右；再吃 16px 让右边缘距视口 12px（验收线 ≤16px）。
  const rule = arrowRule(css)
  if (!/(?:margin-inline-start|margin-left)\s*:\s*auto/.test(rule)) throw new Error('箭头规则缺少 auto 起始外边距，推不到最右')
  if (!/(?:margin-inline-end|margin-right)\s*:\s*-16px/.test(rule)) throw new Error('箭头规则缺少 -16px 末尾外边距，右边缘距视口仍差 28px（超 16px 验收线）')
  // ④ 垂直：对齐标签文字中心（.tab 的 padding-bottom 让盒子中心比文字中心低 4.5px）。
  if (!/align-self\s*:\s*(?:flex-start|start|center)/.test(rule)) throw new Error('箭头规则缺少 align-self，垂直位置会跟父行 align-items 漂移')
  if (!/margin-top\s*:\s*-4px/.test(rule)) throw new Error('箭头规则缺少 -4px 上移量，与标签文字中心差 4px')
  // ⑤ flex 与尺寸颜色沿用原样。
  if (!/flex\s*:\s*0\s+0\s+auto/.test(rule)) throw new Error('箭头规则缺少 flex: 0 0 auto，在 flex 父行里会被压缩或拉伸')
  if (!/width\s*:\s*24px/.test(rule) || !/height\s*:\s*24px/.test(rule)) throw new Error('箭头尺寸不再是 24x24')
  if (!/color\s*:\s*var\(--dsw-alias-label-secondary/.test(rule)) throw new Error('箭头的颜色变量被改掉')
}

/** 等折叠层的 rAF 同步跑完。 */
function flush(): Promise<void> {
  return new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
}

beforeEach(() => {
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  buildHeader(2)
  fold = new TopBarFold()
})

afterEach(() => {
  fold.detach()
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  document.body.innerHTML = ''
})

describe('视图菜单与折叠箭头的位置', () => {
  it('隐藏上游视图菜单「…」：按 aria-haspopup=menu 精确命中标签条的兄弟', () => {
    // 不用 [data-conversation-tabs] + *：那是「谁排我后面就藏谁」的开放规则，
    // 折叠箭头同样挂在这一行，将来插到这里的兄弟节点都会被误伤。
    expect(TOP_BAR_FOLD_CSS).toMatch(/\[data-conversation-tabs\]\s*\+\s*\[aria-haspopup='menu'\]/)
    expect(TOP_BAR_FOLD_CSS).not.toMatch(/\[data-conversation-tabs\]\s*\+\s*\*(?!\S)/)
  })

  it('折叠箭头推到整行最右并与标签同一行（推翻旧的不得 auto 约束）', async () => {
    fold.attach()
    await flush()
    // 用户推翻了旧设计决定：要整行最右、与「对话 / 轨迹」同一行，而不是紧贴最后一个标签。
    // jsdom 没有布局引擎，所以判据 = 结构位置（行末位）+ 样式声明（auto 外边距 / 居中 / 不压缩）。
    assertArrowRightAligned(TOP_BAR_FOLD_CSS, state().arrow!)
    // 行是 .tabs（父节点，display:flex），箭头挂在它末位。
    const tabs = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    expect(state().arrow!.parentElement).toBe(tabs.parentElement)
    expect(state().arrow!.parentElement!.classList.contains('tabs')).toBe(true)
  })

  it('负控：箭头被兄弟节点挤出末位时，同一条判据必须变红', async () => {
    fold.attach()
    await flush()
    const row = document.querySelector<HTMLElement>('.tabs')!
    const arrow = state().arrow!
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).not.toThrow()
    // 篡改 DOM：行尾再补一个兄弟（上游「…」菜单晚挂 / 重挂的形状），箭头不再是末位。
    const intruder = document.createElement('button')
    row.appendChild(intruder)
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).toThrow(/末位/)
    // 复原并让本帧同步跑完。
    intruder.remove()
    await flush()
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).not.toThrow()
  })

  it('负控：把箭头塞回标签条内部时，同一条判据必须变红', async () => {
    fold.attach()
    await flush()
    const tabs = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const row = tabs.parentElement!
    const arrow = state().arrow!
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).not.toThrow()
    tabs.appendChild(arrow)
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).toThrow(/标签条内部/)
    row.appendChild(arrow)
    await flush()
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).not.toThrow()
  })

  it('负控：去掉 margin-inline-start:auto 时，同一条判据必须变红', async () => {
    fold.attach()
    await flush()
    const arrow = state().arrow!
    // 前提：正常态是绿的。
    expect(() => { assertArrowRightAligned(TOP_BAR_FOLD_CSS, arrow) }).not.toThrow()
    // 去掉 auto：箭头停在行内标签群右侧（实测 x=174.02），推不到整行最右。
    const noAuto = TOP_BAR_FOLD_CSS.replace(/margin-inline-start:\s*auto;/, '')
    expect(noAuto).not.toBe(TOP_BAR_FOLD_CSS)
    expect(() => { assertArrowRightAligned(noAuto, arrow) }).toThrow(/auto 起始外边距/)
  })

  it('负控：样式表退回旧形状（无 -16px / 无 -4px / flex:none）时，同一条判据必须变红', async () => {
    fold.attach()
    await flush()
    const arrow = state().arrow!
    // 退回基线那版箭头规则：flex: none、无 auto、无 -16px、无 -4px、无 align-self。
    const legacy = TOP_BAR_FOLD_CSS
      .replace(/flex:\s*0\s+0\s+auto;/, 'flex: none;')
      .replace(/align-self:\s*flex-start;/, '')
      .replace(/margin-top:\s*-4px;/, '')
      .replace(/margin-inline-start:\s*auto;/, '')
      .replace(/margin-inline-end:\s*-16px;/, '')
    expect(legacy).not.toBe(TOP_BAR_FOLD_CSS)
    expect(() => { assertArrowRightAligned(legacy, arrow) }).toThrow(/auto 起始外边距/)
    // 只去掉 -16px：右边缘仍距视口 28px（超 16px 验收线），必须红。
    const noEnd = TOP_BAR_FOLD_CSS.replace(/margin-inline-end:\s*-16px;/, '')
    expect(() => { assertArrowRightAligned(noEnd, arrow) }).toThrow(/-16px 末尾外边距/)
    // 只去掉 -4px：与标签文字中心差 4px，必须红。
    const noLift = TOP_BAR_FOLD_CSS.replace(/margin-top:\s*-4px;/, '')
    expect(() => { assertArrowRightAligned(noLift, arrow) }).toThrow(/-4px 上移量/)
    // 只去掉 align-self：垂直位置会跟父行 align-items 漂移，必须红。
    const noAlign = TOP_BAR_FOLD_CSS.replace(/align-self:\s*flex-start;/, '')
    expect(() => { assertArrowRightAligned(noAlign, arrow) }).toThrow(/align-self/)
  })

  it('箭头不会被「隐藏 … 菜单」的规则命中（自证不误伤）', async () => {
    fold.attach()
    await flush()
    // 用 jsdom 的 matches 真跑一遍选择器，而不是只比对字符串形态。
    // 本用例只守「箭头不被误伤」这一件事（箭头现在是行的末位孩子，永远不可能是那个相邻兄弟）。
    const arrow = document.querySelector<HTMLElement>('[' + ARROW_ATTR + ']')!
    expect(arrow.matches("[data-conversation-tabs] + [aria-haspopup='menu']")).toBe(false)
  })
})

describe('D 项：竖屏顶栏插件 UI 折叠', () => {
  it('手机竖屏：箭头是标签行的末位孩子（不在标签条内部），且顶栏原生控件仍保留', async () => {
    fold.attach()
    await flush()
    const tabs = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const row = tabs.parentElement!
    const arrow = state().arrow!
    expect(arrow).not.toBeNull()
    // 硬判据：箭头挂在**标签行（父行）**末位 —— 整行最右，与「对话 / 轨迹」同一行。
    expect(arrow.parentElement).toBe(row)
    expect(row.lastElementChild).toBe(arrow)
    // 反证：不得留在标签条内部（标签条宽度=内容宽，auto 外边距在那里推不动）。
    expect(tabs.contains(arrow)).toBe(false)
    // 标题、两个侧边栏按钮（左 toggle / 右展开）都不是我们动的
    expect(document.querySelector('[data-dsh-sidebar-toggle]')).not.toBeNull()
    expect(document.querySelector('.titleRow nav')?.textContent).toContain('月度现金流核算与报告')
  })

  it('标签条自身不被我们塞东西，仍然只有视图标签', async () => {
    fold.attach()
    await flush()
    const tablist = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    // 父行才是行：标签条是 React 拥有的列表，我们一个孩子都不往里放
    // （否则下次 append 会插到箭头后面）。
    const order = [...tablist.children]
    expect(order.map(child => child.getAttribute('role'))).toEqual(['tab', 'tab'])
    expect(tablist.querySelector('[' + ARROW_ATTR + ']')).toBeNull()
  })

  it('React 往标签条追加新标签后，箭头仍在标签行末位（不重建、不掉位）', async () => {
    fold.attach()
    await flush()
    const tablist = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const row = tablist.parentElement!
    const arrow = state().arrow!
    // React 认为自己是 tablist 的唯一 owner：它直接 appendChild 自己的标签。
    const late = document.createElement('button')
    late.setAttribute('role', 'tab')
    late.textContent = '差异'
    tablist.appendChild(late)
    await flush()
    // 箭头不重建（保焦点与监听），仍是行的末位。
    expect(state().arrow).toBe(arrow)
    expect(arrow.parentElement).toBe(row)
    expect(row.lastElementChild).toBe(arrow)
  })

  it('「…」菜单晚一步出现时，箭头被重排回行末位（不留在菜单左边）', async () => {
    document.body.innerHTML = ''
    buildHeader(1, true, false)
    fold.attach()
    await flush()
    const tablist = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const row = tablist.parentElement!
    const arrow = state().arrow!
    expect(row.lastElementChild).toBe(arrow)
    // 上游「…」菜单异步挂到行尾：它插在箭头后面，箭头就不再是最右了。
    const menu = document.createElement('button')
    menu.setAttribute('aria-haspopup', 'menu')
    menu.textContent = '…'
    row.appendChild(menu)
    await flush()
    await flush()
    // 复用同一个箭头（原地重挂，不重建），并把它排回行末位。
    expect(state().arrow).toBe(arrow)
    expect(row.lastElementChild).toBe(arrow)
    expect(menu.nextElementSibling).toBe(arrow)
    expect(arrow.parentElement).toBe(row)
  })

  it('重进手机竖屏默认收起：座位整块离场，面板节点集合为空', async () => {
    fold.attach()
    await flush()
    expect(state().fold).toBe('closed')
    expect(panelNodes()).toEqual([])
    expect(state().arrow?.getAttribute('aria-expanded')).toBe('false')
  })

  it('点箭头展开：面板节点集合 === 座位实际挂载集合（硬判据）', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    expect(state().fold).toBe('open')
    expect(state().arrow?.getAttribute('aria-expanded')).toBe('true')
    expect(panelNodes()).toEqual(mountedNodes())
    expect(mountedNodes()).toEqual(['0', '1'])
  })

  it('展开时解除标题行 containment（否则 fixed 面板被困在 30px 的行里）', async () => {
    fold.attach()
    await flush()
    expect(state().titleUncontained).toBe(false)
    state().arrow!.click()
    expect(state().titleUncontained).toBe(true)
    state().arrow!.click()
    expect(state().titleUncontained).toBe(false)
  })

  it('点外部关闭；点面板内部不关闭', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    expect(state().fold).toBe('open')
    // 面板内部：保持打开
    state().seat.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(state().fold).toBe('open')
    // 外部：关闭
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(state().fold).toBe('closed')
  })

  it('Escape 关闭', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(state().fold).toBe('closed')
  })

  it('新插件动态挂载后自动进入面板（不硬编码名单）', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    expect(panelNodes()).toEqual(['0', '1'])
    // 第三个插件经同一座位挂载
    const seat = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)!
    const extra = document.createElement('span')
    extra.setAttribute('data-plugin-node', '2')
    seat.appendChild(extra)
    await flush()
    expect(panelNodes()).toEqual(mountedNodes())
    expect(panelNodes()).toEqual(['0', '1', '2'])
  })

  it('插件卸载后同步离场（仍是同一判据，不残留已卸载节点）', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    const seat = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)!
    seat.removeChild(seat.lastElementChild!)
    await flush()
    expect(panelNodes()).toEqual(mountedNodes())
    expect(panelNodes()).toEqual(['0'])
  })

  it('展开态下内容变多不重复注入箭头、不重复接管', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    await flush()
    await flush()
    expect(document.querySelectorAll('[' + ARROW_ATTR + ']')).toHaveLength(1)
    expect(document.querySelectorAll('[data-dsh-topbar-fold-uncontained]')).toHaveLength(1)
  })

  it('横屏（不命中手机形态）完全不接管：无箭头、无标记、标题行不动', async () => {
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    fold.attach()
    await flush()
    const s = state()
    expect(s.arrow).toBeNull()
    expect(s.fold).toBeNull()
    expect(s.titleUncontained).toBe(false)
  })

  it('竖屏切横屏后自动恢复：标记、内联样式与箭头全部撤掉', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    const seat = state().seat
    expect(seat.style.getPropertyValue('top')).not.toBe('')
    // 转横屏
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    await flush()
    await flush()
    const s = state()
    expect(s.fold).toBeNull()
    expect(s.arrow).toBeNull()
    expect(s.titleUncontained).toBe(false)
    expect(seat.style.getPropertyValue('top')).toBe('')
    expect(seat.style.getPropertyValue('--dsh-topbar-fold-max-height')).toBe('')
  })

  it('收起时写回接管前的内联原值，不是一律删空（不吞上游/插件自己的样式）', async () => {
    const seat = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)!
    seat.style.setProperty('z-index', '77')
    fold.attach()
    await flush()
    state().arrow!.click()
    expect(seat.style.getPropertyValue('z-index')).toBe('')
    state().arrow!.click()
    expect(seat.style.getPropertyValue('z-index')).toBe('77')
  })

  it('detach 彻底清理：不留箭头、不留标记、不留监听', async () => {
    fold.attach()
    await flush()
    state().arrow!.click()
    fold.detach()
    const s = state()
    expect(s.arrow).toBeNull()
    expect(s.fold).toBeNull()
    expect(s.titleUncontained).toBe(false)
    // 再点外部不应抛（监听已摘）
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  })

  it('标题栏尚未挂载时不报错，也不留下半截状态', async () => {
    document.body.innerHTML = ''
    fold.attach()
    await flush()
    expect(document.querySelector('[' + ARROW_ATTR + ']')).toBeNull()
    // 标题栏随后挂载 → 下一轮同步接管
    buildHeader(1)
    await flush()
    expect(state().arrow).not.toBeNull()
    expect(state().fold).toBe('closed')
  })
})

describe('D 项：样式表守则', () => {
  it('关闭态隐藏、打开态不推动内容（fixed 覆盖层）', () => {
    expect(TOP_BAR_FOLD_CSS).toMatch(/\[data-dsh-topbar-fold='closed'\][^}]*display:\s*none/)
    const open = TOP_BAR_FOLD_CSS.slice(TOP_BAR_FOLD_CSS.indexOf("[data-dsh-topbar-fold='open']"))
    expect(open).toContain('position: fixed')
  })

  it('内容过多限高内部滚动', () => {
    expect(TOP_BAR_FOLD_CSS).toContain('--dsh-topbar-fold-max-height')
    expect(TOP_BAR_FOLD_CSS).toMatch(/overflow-y:\s*auto/)
  })

  it('全部规则都带手机形态门（横屏不受影响）', () => {
    const rules = TOP_BAR_FOLD_CSS.split('}').map(part => part.trim()).filter(Boolean)
    for (const rule of rules) {
      expect(rule).toContain('html[data-dsh-mobile-form]')
    }
  })

  it('E 项：面板内去掉 vendor 徽章的灰色胶囊底与描边，并还原其语义绿点', () => {
    expect(TOP_BAR_FOLD_CSS).toMatch(/\[data-undo-header\]\s*\.u_badge[^}]*background:\s*transparent/)
    expect(TOP_BAR_FOLD_CSS).toMatch(/\[data-undo-header\]\s*\.u_dot[^}]*display:\s*block/)
    // 不碰 vendor 源码：只做样式覆盖（反证：样式表里不得出现 vendor 的 hashed 类名形态）
    expect(TOP_BAR_FOLD_CSS).not.toMatch(/\.[A-Za-z0-9_-]{6,}_.*\{/)
  })
})
