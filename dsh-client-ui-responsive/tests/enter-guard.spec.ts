// @vitest-environment jsdom
// EnterGuard unit tests: four guards (IME / command menu / Shift+Enter / desktop viewport)
// + mobile-viewport interception on both composer editables (Lexical contenteditable and the
// pre-0.1.5 textarea) + the shift+Enter line-break redispatch + execCommand degradation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EnterGuard } from '../src/client/enter-guard.ts'
import { MOBILE_FORM_MAX_WIDTH } from '../src/client/mobile/form-marker.ts'

/** Run a case at the given viewport width (jsdom innerWidth is writable). */
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

/** Build and dispatch an Enter keydown on a composer target (the capture listener sits on document). */
function fireEnter(target: HTMLElement, opts: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts })
  target.dispatchEvent(event)
  return event
}

/** The shift+Enter gestures the guard re-dispatched on one element. */
function shiftGestures(target: HTMLElement): KeyboardEvent[] {
  const seen: KeyboardEvent[] = []
  target.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).shiftKey) seen.push(event as KeyboardEvent)
  })
  return seen
}

let host: HTMLElement
let guard: EnterGuard

beforeEach(() => {
  setViewport(MOBILE_FORM_MAX_WIDTH) // default mobile viewport
  host = document.createElement('div')
  host.innerHTML = '<div data-composer-card><textarea></textarea>'
    + '<div contenteditable="true"><p>draft</p></div><button type="button">send</button></div>'
  document.body.appendChild(host)
  // jsdom has no execCommand implementation: stub it as an observable spy.
  document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand
  guard = new EnterGuard()
  guard.attach()
})

afterEach(() => {
  guard.detach()
  host.remove()
  vi.restoreAllMocks()
  setViewport(1024)
})

describe('EnterGuard 拦截路径（移动视口）', () => {
  it('composer textarea 内普通 Enter：拦截并插入换行', () => {
    const textarea = host.querySelector('textarea')!
    textarea.focus()
    const event = fireEnter(textarea)
    expect(event.defaultPrevented).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '\n')
  })

  it('composer contenteditable（0.1.5 起）内普通 Enter：拦截并改发 Shift+Enter', () => {
    const editable = host.querySelector('[contenteditable="true"]') as HTMLElement
    const gestures = shiftGestures(editable)
    editable.focus()
    const event = fireEnter(editable.querySelector('p')!)
    expect(event.defaultPrevented).toBe(true)
    expect(gestures).toHaveLength(1)
    // The re-dispatched gesture carries what upstream's keymap reads for a line break.
    expect(gestures[0]!.key).toBe('Enter')
    expect(gestures[0]!.shiftKey).toBe(true)
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('execCommand 抛异常时降级：仍拦截（不发送），不向外抛', () => {
    document.execCommand = vi.fn(() => { throw new Error('unsupported') }) as unknown as typeof document.execCommand
    const textarea = host.querySelector('textarea')!
    textarea.focus()
    expect(() => fireEnter(textarea)).not.toThrow()
  })

  it('contenteditable 改发失败时降级：仍拦截（不发送），不向外抛', () => {
    const editable = host.querySelector('[contenteditable="true"]') as HTMLElement
    // The Enter is dispatched on a child so the failing redispatch is the guard's own call.
    editable.dispatchEvent = (() => { throw new Error('dispatch blocked') }) as unknown as typeof editable.dispatchEvent
    const event = fireEnter(editable.querySelector('p')!)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('EnterGuard 四道守卫（不拦截）', () => {
  it('桌面/宽视口：行为完全不变', () => {
    setViewport(MOBILE_FORM_MAX_WIDTH + 1)
    const event = fireEnter(host.querySelector('textarea')!)
    expect(event.defaultPrevented).toBe(false)
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('Shift+Enter：上游原生换行，不拦截', () => {
    const event = fireEnter(host.querySelector('textarea')!, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
  })

  it('IME 组合（isComposing / keyCode 229）：不拦截', () => {
    const textarea = host.querySelector('textarea')!
    const composed = fireEnter(textarea, { isComposing: true })
    expect(composed.defaultPrevented).toBe(false)
    const legacy = fireEnter(textarea, { keyCode: 229 })
    expect(legacy.defaultPrevented).toBe(false)
  })

  it('引用/命令菜单打开（[role=listbox] 存在）：Enter 选择候选，不拦截', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'listbox')
    document.body.appendChild(menu)
    const event = fireEnter(host.querySelector('[contenteditable="true"]')!)
    expect(event.defaultPrevented).toBe(false)
    menu.remove()
  })

  it('composer 卡片内的非编辑控件（按钮）：不拦截', () => {
    const event = fireEnter(host.querySelector('button')!)
    expect(event.defaultPrevented).toBe(false)
  })

  it('composer 之外的 Enter 处理（QueueDock 等）不受影响', () => {
    const outside = document.createElement('textarea')
    document.body.appendChild(outside)
    const event = fireEnter(outside)
    expect(event.defaultPrevented).toBe(false)
    outside.remove()
  })

  it('composer 之外的 contenteditable：不拦截', () => {
    const outside = document.createElement('div')
    outside.setAttribute('contenteditable', 'true')
    document.body.appendChild(outside)
    const event = fireEnter(outside)
    expect(event.defaultPrevented).toBe(false)
    outside.remove()
  })
})

describe('EnterGuard 生命周期', () => {
  it('detach 后不再拦截', () => {
    guard.detach()
    const event = fireEnter(host.querySelector('textarea')!)
    expect(event.defaultPrevented).toBe(false)
  })
})
