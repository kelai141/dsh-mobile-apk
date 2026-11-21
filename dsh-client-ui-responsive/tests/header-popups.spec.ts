// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeaderPopups } from '../src/client/mobile/header-popups.ts'

const MARKER = 'data-dsh-header-popup'

function flush(): Promise<void> {
  return new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => resolve()) }) })
}

function mountMenu(): { fold: HTMLDivElement; trigger: HTMLButtonElement; list: HTMLUListElement } {
  const fold = document.createElement('div')
  fold.setAttribute('data-dsh-topbar-fold', 'open')
  const trigger = document.createElement('button')
  trigger.setAttribute('aria-expanded', 'true')
  const list = document.createElement('ul')
  list.setAttribute('aria-label', '后台任务')
  list.style.setProperty('left', '7px')
  fold.append(trigger, list)
  document.body.append(fold)
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    x: 460, y: 120, top: 120, bottom: 148, left: 460, right: 500,
    width: 40, height: 28, toJSON: () => ({}),
  } as DOMRect)
  return { fold, trigger, list }
}

describe('手机顶栏内的后台任务浮窗', () => {
  let popup: HeaderPopups | undefined

  afterEach(() => {
    popup?.detach()
    popup = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('将绝对定位任务菜单提升为屏幕内 fixed 浮窗并保留触发器语义', async () => {
    const { list } = mountMenu()
    popup = new HeaderPopups()
    popup.attach()
    await flush()

    expect(list.getAttribute(MARKER)).not.toBeNull()
    expect(list.style.getPropertyValue('position')).toBe('fixed')
    expect(list.style.getPropertyPriority('position')).toBe('important')
    expect(list.style.getPropertyValue('left')).toBe('460px') // follows the trigger while staying inside the viewport
    expect(list.style.getPropertyValue('top')).toBe('153px')
    expect(list.style.getPropertyValue('max-height')).toBeTruthy()
  })

  it('恢复菜单节点原有的内联定位样式', async () => {
    const { fold, trigger, list } = mountMenu()
    popup = new HeaderPopups()
    popup.attach()
    await flush()
    fold.remove()
    await flush()

    expect(list.hasAttribute(MARKER)).toBe(false)
    expect(list.style.getPropertyValue('left')).toBe('7px')
    expect(list.style.getPropertyValue('position')).toBe('')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('detach 后忽略已经排队的 animation frame', () => {
    const { list } = mountMenu()
    let pending: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      pending = callback
      return 41
    })
    popup = new HeaderPopups()
    popup.attach()
    popup.detach()
    pending?.(0)

    expect(list.getAttribute(MARKER)).toBeNull()
    expect(list.style.getPropertyValue('position')).toBe('')
  })

  it('bounds the portaled subagent catalog to the visible viewport and tracks IME changes', async () => {
    const anchor = document.createElement('div')
    anchor.setAttribute('data-subagent-action', '')
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-expanded', 'true')
    anchor.append(trigger)
    const panel = document.createElement('div')
    panel.setAttribute('data-subagent-panel', '')
    document.body.append(anchor, panel)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 390, top: 80, bottom: 108,
    } as DOMRect)
    const viewport = Object.assign(new EventTarget(), { width: 420, height: 600, offsetTop: 0, offsetLeft: 0 })
    vi.stubGlobal('visualViewport', viewport)
    popup = new HeaderPopups()
    popup.attach()
    try {
      await flush()
      expect(panel.style.top).toBe('113px')
      expect(panel.style.left).toBe('48px')
      expect(panel.style.maxHeight).toBe('475px')
      expect(panel.style.height).toBe('')

      viewport.height = 300
      viewport.dispatchEvent(new Event('resize'))
      await flush()
      expect(panel.style.maxHeight).toBe('175px')

      vi.mocked(trigger.getBoundingClientRect).mockReturnValue({ left: 390, top: 248, bottom: 276 } as DOMRect)
      viewport.dispatchEvent(new Event('scroll'))
      await flush()
      expect(panel.style.top).toBe('auto')
      expect(panel.style.bottom).toBe(`${window.innerHeight - 243}px`)
      expect(panel.style.maxHeight).toBe('231px')

      popup.detach()
      expect(panel.style.maxHeight).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('触发器贴近视口底部时向上翻转且菜单不越出可视高度', async () => {
    const { trigger, list } = mountMenu()
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 460, y: 550, top: 550, bottom: 578, left: 460, right: 500,
      width: 40, height: 28, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 500, left: 0, right: 500,
      width: 500, height: 500, toJSON: () => ({}),
    } as DOMRect)
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 500 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    popup = new HeaderPopups()
    popup.attach()
    await flush()

    const top = Number.parseFloat(list.style.getPropertyValue('top'))
    const height = Number.parseFloat(list.style.getPropertyValue('max-height'))
    expect(top).toBe(12)
    expect(top).toBeLessThan(550)
    expect(top + height).toBeLessThanOrEqual(588)
  })

  it('忽略不属于后台任务的列表', async () => {
    const { fold, list } = mountMenu()
    list.setAttribute('aria-label', 'Agent Team')
    popup = new HeaderPopups()
    popup.attach()
    await flush()

    expect(fold.hasAttribute('data-dsh-header-popup')).toBe(false)
    expect(list.getAttribute(MARKER)).toBeNull()
  })

  it('旧 WebView 将会话菜单定位在右上角触发器下方', async () => {
    document.body.innerHTML = `
      <button class="hash_headerMenuButton" data-context-menu-trigger
        aria-expanded="true" aria-controls="session-header-menu"></button>
      <div data-context-menu role="menu"></div>
      <div id="session-header-menu" data-context-menu role="menu"></div>`
    const trigger = document.querySelector('button')!
    const menu = document.getElementById('session-header-menu')!
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 524, right: 552, top: 11, bottom: 39,
    } as DOMRect)
    popup = new HeaderPopups()
    popup.attach()
    await flush()
    expect(menu.style.top).toBe('44px')
    expect(menu.style.left).toBe('312px')
    expect(document.querySelector<HTMLElement>('[role="menu"]')?.style.top).toBe('')
    trigger.setAttribute('aria-expanded', 'false')
    await flush()
    expect(menu.style.top).toBe('')
    expect(menu.style.left).toBe('')
  })
})
