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
//         > div[role=tablist][data-conversation-tabs] ← 两个标签 + 折叠箭头挂这里
// 座位下真机当前有两个节点：preset 模式标签 + vendor 快照徽章（div[data-undo-header]）。
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
   * 标签行按**线上发布版** 0.2.1-rc.2 的真实形状搭（skeleton/ConversationSession.tsx:143 与
   * 其编译产物一致）：
   *   div.tabs                                    ← 行容器（flex, flex-wrap:wrap）
   *     > div.viewTabs[role=tablist][data-conversation-tabs]   ← React 拥有的标签列表
   *     > ViewsMoreMenu button[aria-haspopup=menu]             ← 上游「…」菜单，行的兄弟节点
   * 箭头必须落在这个行容器里、并且是它的末位。
   * @param plugins - 座位下要挂载的节点数量。
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
    const tabs = document.createElement('div')
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('data-conversation-tabs', '')
    tabs.className = 'viewTabs'
    for (const label of ['对话', '轨迹']) {
      const tab = document.createElement('button')
      tab.setAttribute('role', 'tab')
      tab.textContent = label
      tabs.appendChild(tab)
    }
    row.appendChild(tabs)
    if (withMoreMenu) {
      const menu = document.createElement('button')
      menu.type = 'button'
      menu.setAttribute('aria-haspopup', 'menu')
      menu.textContent = '…'
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

  it('折叠箭头不得用 margin-left:auto 贴整行最右', () => {
    // 需求是「标签行最右侧、紧贴最后一个标签」，不是「整行最右」。
    // 实机实测：带 auto 时箭头 x=548（视口 600），最后标签右边界只有 112。
    expect(TOP_BAR_FOLD_CSS).not.toMatch(/\[data-dsh-topbar-fold-arrow\]\s*\{[^}]*margin-left:\s*auto/)
  })

  it('箭头不会被「隐藏 … 菜单」的规则命中（自证不误伤）', async () => {
    fold.attach()
    await flush()
    // 用 jsdom 的 matches 真跑一遍选择器，而不是只比对字符串形态。
    const row = document.querySelector<HTMLElement>('.tabs')!
    const arrow = document.querySelector<HTMLElement>('[' + ARROW_ATTR + ']')!
    const menu = row.querySelector<HTMLElement>('[aria-haspopup="menu"]')!
    expect(menu.matches("[data-conversation-tabs] + [aria-haspopup='menu']")).toBe(true)
    expect(arrow.matches("[data-conversation-tabs] + [aria-haspopup='menu']")).toBe(false)
  })
})

describe('D 项：竖屏顶栏插件 UI 折叠', () => {
  it('手机竖屏：箭头是标签条内部的最后一个元素，且顶栏原生控件仍保留', async () => {
    fold.attach()
    await flush()
    const tabs = document.querySelector('[data-conversation-tabs]')!
    const row = tabs.parentElement!
    const arrow = state().arrow!
    expect(arrow).not.toBeNull()
    // 硬判据：箭头在**标签条内部**末位，紧贴最后一个视图标签。
    expect(arrow.parentElement).toBe(tabs)
    expect(tabs.lastElementChild).toBe(arrow)
    // 反证：不得停在父行 —— 父行末位是「整行最右」，与标签群之间会空出一段。
    expect(row.lastElementChild).not.toBe(arrow)
    // 标题、两个侧边栏按钮（左 toggle / 右展开）都不是我们动的
    expect(document.querySelector('[data-dsh-sidebar-toggle]')).not.toBeNull()
    expect(document.querySelector('.titleRow nav')?.textContent).toContain('月度现金流核算与报告')
  })

  it('标签条子元素顺序被钉住：视图标签在前，箭头在末尾', async () => {
    fold.attach()
    await flush()
    const tablist = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const arrow = state().arrow!
    // 顺序断言（不是「包含」断言）：对话、轨迹、箭头，箭头必须是最后一个。
    const order = [...tablist.children]
    expect(order.map(child => child.getAttribute('role') ?? child.getAttribute(ARROW_ATTR))).toEqual([
      'tab',
      'tab',
      '',
    ])
    expect(order[order.length - 1]).toBe(arrow)
    // 反证：箭头不能夹在两个标签之间。
    expect(order[0]).not.toBe(arrow)
    expect(order[1]).not.toBe(arrow)
  })

  it('React 往标签条追加新标签后，箭头被重排回末位（不回退到标签之间）', async () => {
    fold.attach()
    await flush()
    const tablist = document.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const arrow = state().arrow!
    // React 认为自己是 tablist 的唯一 owner：它会直接 appendChild 自己的标签，
    // 这次 append 会把箭头顶到倒数第二位 —— 正是「夹在两个标签之间」的成因。
    const late = document.createElement('button')
    late.setAttribute('role', 'tab')
    late.textContent = '差异'
    tablist.appendChild(late)
    await flush()
    // 复用同一个箭头（不重建，保焦点与监听），并把它排回末位。
    expect(state().arrow).toBe(arrow)
    expect(tablist.lastElementChild).toBe(arrow)
    expect(late.nextElementSibling).toBe(arrow)
  })

  it('「…」菜单晚一步出现时，不影响箭头在标签条内的末位', async () => {
    document.body.innerHTML = ''
    buildHeader(1, true, false)
    fold.attach()
    await flush()
    const row = document.querySelector<HTMLElement>('.tabs')!
    const tablist = row.querySelector<HTMLElement>('[data-conversation-tabs]')!
    const arrow = state().arrow!
    expect(tablist.lastElementChild).toBe(arrow)
    // 上游「…」菜单异步挂到父行尾：它属于父行，不该把箭头挤出标签条。
    const menu = document.createElement('button')
    menu.setAttribute('aria-haspopup', 'menu')
    menu.textContent = '…'
    row.appendChild(menu)
    await flush()
    await flush()
    expect(state().arrow).toBe(arrow)
    expect(tablist.lastElementChild).toBe(arrow)
    expect(arrow.parentElement).toBe(tablist)
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
