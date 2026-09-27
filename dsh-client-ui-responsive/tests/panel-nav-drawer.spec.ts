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
})
