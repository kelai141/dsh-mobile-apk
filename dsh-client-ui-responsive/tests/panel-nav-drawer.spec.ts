// @vitest-environment jsdom
// FX1-C 续：手机形态下抽屉会盖住刚打开的主面板（含其返回控件）。
//
// 现场实测：抽屉是 `position: fixed` 的 289px 离屏覆盖层，选中「插件」后它仍然张着，
// 于是面板本体连同注入的返回控件都在抽屉底下 —— 用户看不到也点不到（"点进去就出不来"）。
// 判据：Conversation -> 面板 的**那一次**切换要把抽屉放下；用户随后自己再拉开抽屉不得被顶掉。
import { describe, it, expect, vi } from 'vitest'
import { PanelNavDrawer } from '../src/client/mobile/panel-nav-drawer.ts'

function setPhoneForm(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

/**
 * A drawer harness: the frame's collapsed attribute is the drawer's own state.
 * @param collapsed - whether the drawer starts collapsed (closed).
 */
function harness(collapsed: boolean) {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-frame', '')
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frame)
  let panelId: string | null = null
  const collapseDrawer = vi.fn(() => { frame.setAttribute('data-sidebar-collapsed', '') })
  const drawer = new PanelNavDrawer({
    activePanelId: () => panelId,
    collapseDrawer,
    frame: () => frame,
  })
  return {
    frame,
    collapseDrawer,
    drawer,
    open: () => { frame.removeAttribute('data-sidebar-collapsed') },
    select: (id: string | null) => { panelId = id; return drawer.sync() },
  }
}

describe('PanelNavDrawer：进面板时收起抽屉', () => {
  it('从会话切到面板：抽屉被收起一次（返回控件因此可见可点）', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.select('plugins')).toBe(true)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
  })

  it('反证：会话里（activePanelId 仍为 null）不得动抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.select(null)).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
  })

  it('反证：用户随后自己再拉开抽屉，不得被顶掉（只在进入面板那一次收起）', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.select('plugins')).toBe(true)
    // 用户重新拉开抽屉。
    h.open()
    // 同一面板的后续通知（轮询/重渲染都会触发）不得再次收起。
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })

  it('反证：面板间切换（plugins -> tasks）不得反复收起抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    h.select('plugins')
    h.open()
    expect(h.select('tasks')).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })

  it('反证：桌面形态（非手机表单）不得被收起 —— 停靠侧栏是常驻外框不是覆盖层', () => {
    setPhoneForm(false)
    const h = harness(false)
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })

  it('抽屉本来就关着时不重复切（toggle 会把它反开）', () => {
    setPhoneForm(true)
    const h = harness(true)
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
  })

  it('反证：离开面板（panels -> null）不得动抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    h.select('plugins')
    h.open()
    expect(h.select(null)).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })

  it('几何判据：状态位还写着「已收起」，但抽屉右缘在视口内 —— 仍必须收起（手势拉开后的滞后）', () => {
    setPhoneForm(true)
    const h = harness(false)
    const column = document.createElement('div')
    column.className = 'x_sidebarCol'
    h.frame.appendChild(column)
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({
      width: 289, height: 800, top: 0, left: 0, right: 289, bottom: 800, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    // 状态位滞后：属性还在，但抽屉实际在屏上。
    h.frame.setAttribute('data-sidebar-collapsed', '')
    expect(h.select('plugins')).toBe(true)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })

  it('几何判据：抽屉右缘已推出视口时不重复切（toggle 会把它反开）', () => {
    setPhoneForm(true)
    const h = harness(false)
    const column = document.createElement('div')
    column.className = 'x_sidebarCol'
    h.frame.appendChild(column)
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({
      width: 289, height: 800, top: 0, left: -289, right: 0, bottom: 800, x: -289, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
  })
})

// ── 点会话行「三个点」不得把抽屉收起来（用户设备实测） ──────────────────────────
//
// 现场：抽屉开着 → 点某条会话右侧的「三个点」→ 抽屉自己收起，菜单刚弹出就被连带清掉。
// 真因：attachNavDismiss 的点击判据只排除 [aria-expanded]（展开器），而上游「三个点」是
// primitives Menu 的锚点按钮，真机属性只有 data-context-menu-trigger（无 aria-haspopup、
// 无 aria-expanded）⇒ 被当成「导航了一次」，260ms 后模拟点遮罩收起抽屉。
describe('PanelNavDrawer：点会话行菜单入口不得收起抽屉', () => {
  /**
   * 装一个「抽屉开着」的真实 DOM：frame > sidebarCol > row(treeitem) > rowActions > 三个点。
   * @param buttonAttrs - 三个点按钮要带的属性（本用例的判据变量）。
   */
  function drawerHarness(buttonAttrs: Record<string, string>) {
    setPhoneForm(true)
    document.body.innerHTML = ''
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    const column = document.createElement('div')
    column.className = 'x_sidebarCol'
    // 抽屉在屏上（几何判据的第一道门）。
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({
      width: 280, height: 800, top: 0, left: 0, right: 280, bottom: 800, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const row = document.createElement('div')
    row.setAttribute('data-row-key', 'session:s1')
    row.setAttribute('role', 'treeitem')
    const actions = document.createElement('span')
    actions.className = 'x_rowActions'
    const menuButton = document.createElement('button')
    menuButton.setAttribute('type', 'button')
    menuButton.setAttribute('aria-label', '会话“示例”的操作')
    for (const [name, value] of Object.entries(buttonAttrs)) menuButton.setAttribute(name, value)
    actions.appendChild(menuButton)
    row.appendChild(actions)
    column.appendChild(row)
    frame.appendChild(column)
    document.body.appendChild(frame)
    // 抽屉遮罩：dismiss() 唯一的收起通路就是对它派发点按。
    const mask = document.createElement('div')
    mask.setAttribute('data-sidebar-mask', '')
    const maskClicks = vi.fn()
    mask.addEventListener('click', maskClicks)
    document.body.appendChild(mask)
    const collapseDrawer = vi.fn()
    const drawer = new PanelNavDrawer({ activePanelId: () => null, collapseDrawer, frame: () => frame })
    drawer.attachNavDismiss()
    return { frame, column, row, menuButton, maskClicks, drawer, collapseDrawer }
  }

  /** 派发一次真实点击并等过 NAV_DISMISS_DELAY_MS（260ms）的判定期。 */
  async function clickAndSettle(target: Element): Promise<void> {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await new Promise<void>(resolve => window.setTimeout(resolve, 420))
  }

  it('上游「三个点」只带 data-context-menu-trigger：不得收起抽屉（缺陷形态）', async () => {
    // 真机实测属性集合：type / class / aria-label / data-context-menu-trigger（无 haspopup、无 expanded）。
    const h = drawerHarness({ 'data-context-menu-trigger': '' })
    await clickAndSettle(h.menuButton)
    expect(h.maskClicks, '点菜单入口不是导航，抽屉必须保持张开').not.toHaveBeenCalled()
    h.drawer.detachNavDismiss()
  })

  it('反证：工作区行的「…」带 aria-haspopup=menu，同样不得收起抽屉', async () => {
    const h = drawerHarness({ 'data-context-menu-trigger': '', 'aria-haspopup': 'menu' })
    await clickAndSettle(h.menuButton)
    expect(h.maskClicks).not.toHaveBeenCalled()
    h.drawer.detachNavDismiss()
  })

  it('正控：真正的导航按钮（无菜单属性）仍必须收起抽屉（修复不得把功能关掉）', async () => {
    const h = drawerHarness({})
    await clickAndSettle(h.menuButton)
    expect(h.maskClicks, '点抽屉里的普通条目仍是一次导航，抽屉应退场').toHaveBeenCalled()
    h.drawer.detachNavDismiss()
  })
})
