// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ActivationGuard, INERT_ATTR, SUPPRESS_WINDOW_MS, hiddenReason,
} from '../src/client/mobile/activation-guard.ts'

/** Dispatch a press with a real, cancelable event (jsdom has no PointerEvent constructor). */
function press(target: Element): boolean {
  return target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
}

/** Dispatch a click with a real, cancelable event. */
function click(target: Element): boolean {
  return target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function button(cls = ''): HTMLButtonElement {
  const node = document.createElement('button')
  if (cls !== '') node.className = cls
  node.textContent = 'op'
  return node
}

/** A conversation-column button plus a composer card, i.e. the shapes the report covers. */
function conversation(): { column: HTMLElement; action: HTMLButtonElement; card: HTMLElement; input: HTMLElement } {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-frame', '')
  const column = document.createElement('div')
  column.className = 'centerCol_hash'
  const action = button('action')
  column.append(action)
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const input = document.createElement('div')
  input.setAttribute('contenteditable', 'true')
  input.setAttribute('data-composer-input', '')
  card.append(input)
  frame.append(column, card)
  document.body.append(frame)
  return { column, action, card, input }
}

/** 每个用例创建的 guard 都登记下来：断言提前失败时也要撤干净，避免监听串到下一条用例。 */
const guards: ActivationGuard[] = []

function guardWith(options: ConstructorParameters<typeof ActivationGuard>[0] = {}): ActivationGuard {
  const guard = new ActivationGuard(options)
  guards.push(guard)
  guard.attach()
  return guard
}

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => {
  for (const guard of guards.splice(0)) guard.detach()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('#1317 隐藏的控件不得被激活', () => {
  it('祖先透明时按下与点击都被吞掉，并把控件移出命中面/聚焦树', () => {
    const host = document.createElement('div')
    host.style.opacity = '0'
    const action = button()
    host.append(action)
    document.body.append(host)
    const upstream = vi.fn()
    action.addEventListener('click', upstream)
    const blocked: string[] = []
    const guard = guardWith({ onBlocked: (_node, reason) => blocked.push(reason) })

    expect(press(action), '隐藏控件的按下必须被取消').toBe(false)
    expect(click(action), '隐藏控件的点击必须被取消').toBe(false)
    expect(upstream, '上游的副作用一次都不许执行').not.toHaveBeenCalled()
    expect(blocked).toEqual(['transparent', 'transparent'])
    expect(action.hasAttribute(INERT_ATTR)).toBe(true)
    expect(action.style.getPropertyValue('pointer-events'), '移出命中面').toBe('none')
    expect(action.getAttribute('tabindex'), '移出聚焦树').toBe('-1')
    expect(action.getAttribute('aria-hidden'), '移出无障碍树').toBe('true')
    guard.detach()
  })

  it('可见控件原样放行：不取消、不打标记', () => {
    const action = button()
    document.body.append(action)
    const upstream = vi.fn()
    action.addEventListener('click', upstream)
    const guard = guardWith()

    expect(press(action)).toBe(true)
    expect(click(action)).toBe(true)
    expect(upstream).toHaveBeenCalledOnce()
    expect(action.hasAttribute(INERT_ATTR)).toBe(false)
    expect(action.style.getPropertyValue('pointer-events')).toBe('')
    guard.detach()
  })

  it('四种隐藏形态都判隐藏（含祖先与自身）', () => {
    const cases: Array<[string, (host: HTMLElement, node: HTMLElement) => void]> = [
      ['display:none', host => { host.style.display = 'none' }],
      ['visibility:hidden', host => { host.style.visibility = 'hidden' }],
      ['hidden 属性', (host, node) => { node.setAttribute('hidden', '') }],
      ['aria-hidden', (host, node) => { node.setAttribute('aria-hidden', 'true') }],
      ['自身 opacity:0', (host, node) => { node.style.opacity = '0' }],
      ['祖先 opacity:0', host => { host.style.opacity = '0' }],
    ]
    for (const [label, apply] of cases) {
      const host = document.createElement('div')
      const node = button()
      host.append(node)
      document.body.append(host)
      apply(host, node)
      expect(hiddenReason(node), label + ' 必须判隐藏').not.toBeNull()
      host.remove()
    }
    const visible = button()
    document.body.append(visible)
    expect(hiddenReason(visible), '可见控件不得判隐藏').toBeNull()
  })

  it('重新呈现后三处标记原样还原，点击恢复生效', () => {
    const host = document.createElement('div')
    host.style.opacity = '0'
    const action = button()
    action.setAttribute('tabindex', '0')
    action.setAttribute('aria-hidden', 'false')
    host.append(action)
    document.body.append(host)
    const upstream = vi.fn()
    action.addEventListener('click', upstream)
    const guard = guardWith()
    click(action)
    expect(action.hasAttribute(INERT_ATTR), '先确认已被处置').toBe(true)

    host.style.opacity = '1'
    press(document.body)
    expect(action.hasAttribute(INERT_ATTR), '重新可见后不得残留标记').toBe(false)
    expect(action.style.getPropertyValue('pointer-events')).toBe('')
    expect(action.getAttribute('tabindex'), '原 tabindex 必须还回去').toBe('0')
    expect(action.getAttribute('aria-hidden')).toBe('false')
    expect(click(action), '还原后必须重新可点').toBe(true)
    expect(upstream).toHaveBeenCalledOnce()
    guard.detach()
  })

  it('detach 把所有标记还原，不把状态留在 DOM 上', () => {
    const host = document.createElement('div')
    host.style.opacity = '0'
    const action = button()
    host.append(action)
    document.body.append(host)
    const guard = guardWith()
    click(action)
    guard.detach()
    expect(action.hasAttribute(INERT_ATTR)).toBe(false)
    expect(action.style.getPropertyValue('pointer-events')).toBe('')
    expect(action.hasAttribute('tabindex')).toBe(false)
    expect(action.hasAttribute('aria-hidden')).toBe(false)
  })
})

describe('#1316 非输入控件的激活不得抢键盘', () => {
  it('点正文按钮后把焦点塞回输入框会被拒绝（键盘不弹）', () => {
    const { action, input } = conversation()
    const suppressed: HTMLElement[] = []
    const guard = guardWith({ onKeyboardSuppressed: node => suppressed.push(node) })
    press(action)
    input.focus()
    expect(document.activeElement, '输入框不得拿到焦点').not.toBe(input)
    expect(suppressed).toEqual([input])
    guard.detach()
  })

  it('用户自己点输入框永远优先：先撤销窗口再放行焦点', () => {
    const { action, card, input } = conversation()
    const guard = guardWith()
    press(action)
    press(card)
    input.focus()
    expect(document.activeElement, '用户自己的按下必须生效').toBe(input)
    guard.detach()
  })

  it('抑制窗很短：过期后焦点照常落到输入框', () => {
    vi.useFakeTimers()
    const { action, input } = conversation()
    const guard = guardWith()
    press(action)
    vi.advanceTimersByTime(SUPPRESS_WINDOW_MS + 1)
    input.focus()
    expect(document.activeElement).toBe(input)
    guard.detach()
  })

  it('不属于「打开编辑器以外」的控件不 arm：输入卡片内/侧栏/对话框/菜单/菜单开启者', () => {
    const { action, card, input } = conversation()
    const drawer = document.createElement('div')
    drawer.className = 'sidebarCol_hash'
    const drawerButton = button()
    drawer.append(drawerButton)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const dialogButton = button()
    dialog.append(dialogButton)
    document.body.append(drawer, dialog)
    const cardButton = button()
    card.append(cardButton)
    const menuOpener = button()
    menuOpener.setAttribute('aria-haspopup', 'menu')
    document.body.append(menuOpener)
    const guard = guardWith()
    for (const [label, node] of [
      ['输入卡片内', cardButton], ['侧栏内', drawerButton], ['对话框内', dialogButton], ['菜单开启者', menuOpener],
    ] as Array<[string, HTMLButtonElement]>) {
      press(node)
      input.focus()
      expect(document.activeElement, label + ' 不得被当成抢键盘').toBe(input)
      input.blur()
      press(action)
      press(document.body)
    }
    guard.detach()
  })

  it('隐藏控件被拦下时不顺带 arm 键盘窗（两件事互不牵连）', () => {
    const { input } = conversation()
    const host = document.createElement('div')
    host.style.opacity = '0'
    const hidden = button()
    host.append(hidden)
    document.body.append(host)
    const guard = guardWith()
    press(hidden)
    expect(guard.suppressing(), '被吞掉的激活不得顺手压制输入').toBe(false)
    input.focus()
    expect(document.activeElement).toBe(input)
    guard.detach()
  })
})
