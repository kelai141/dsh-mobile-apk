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
// 2026-11-14 审查实测：dismiss() 原本查 [data-sidebar-mask]，而遮罩的真名是
// [data-dsh-mobile-mask]（MobileChrome.tsx 发布）。查询名写错 ⇒ mask 恒 null ⇒ 第二行就
// return，点侧栏条目抽屉根本不收，而上面 9 条用例全绿（它们只测 sync() 的 id 跳变）。
// 本用例钉住整条交互链：点了抽屉里的导航条目，必须真的把遮罩的 mousedown/click 打出去。
describe('PanelNavDrawer：点抽屉条目后真的收起（遮罩真名）', () => {
  it('点抽屉里的导航条目 ⇒ 对遮罩派发 mousedown + click（收起动作真的发生）', async () => {
    vi.useFakeTimers()
    setPhoneForm(true)
    document.body.innerHTML = ''
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    const column = document.createElement('div')
    column.className = 'x_sidebarCol'
    column.innerHTML = '<button type="button" id="nav-item">插件</button>'
    frame.appendChild(column)
    document.body.appendChild(frame)
    // 遮罩用上游的真名发布；这里只观察它有没有被点到。
    const mask = document.createElement('div')
    mask.setAttribute('data-dsh-mobile-mask', '')
    const onMask = vi.fn()
    mask.addEventListener('mousedown', onMask)
    mask.addEventListener('click', onMask)
    document.body.appendChild(mask)
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({
      width: 289, height: 800, top: 0, left: 0, right: 289, bottom: 800, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const drawer = new PanelNavDrawer({ activePanelId: () => 'plugins', collapseDrawer: vi.fn(), frame: () => frame })
    drawer.attachNavDismiss()
    column.querySelector<HTMLButtonElement>('#nav-item')!.click()
    // 收起判定要等抽屉 200ms 过渡跑完（NAV_DISMISS_DELAY_MS）。
    await vi.advanceTimersByTimeAsync(400)
    expect(onMask).toHaveBeenCalledTimes(2)
    drawer.detachNavDismiss()
    vi.useRealTimers()
  })

  it('反证：遮罩不在场时不得抛错（热卸载 / 非手机形态都会走到）', async () => {
    vi.useFakeTimers()
    setPhoneForm(true)
    document.body.innerHTML = ''
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    const column = document.createElement('div')
    column.className = 'x_sidebarCol'
    column.innerHTML = '<button type="button" id="nav-item">插件</button>'
    frame.appendChild(column)
    document.body.appendChild(frame)
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({
      width: 289, height: 800, top: 0, left: 0, right: 289, bottom: 800, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const drawer = new PanelNavDrawer({ activePanelId: () => 'plugins', collapseDrawer: vi.fn(), frame: () => frame })
    drawer.attachNavDismiss()
    column.querySelector<HTMLButtonElement>('#nav-item')!.click()
    await vi.advanceTimersByTimeAsync(400)
    drawer.detachNavDismiss()
    vi.useRealTimers()
  })
})
