// @vitest-environment jsdom
// EnterGuard unit tests: the four guards (IME / command menu / Shift+Enter / fine pointer)
// + interception on both composer editables (Lexical contenteditable and the pre-0.1.5 textarea)
// + the shift+Enter line-break redispatch + execCommand degradation
// + the pointer criterion of #1040 (a coarse pointer is intercepted at any viewport width; a fine
//   pointer is not; the width rule only comes back when matchMedia cannot be asked at all)
// + the card-scoped menu criterion of #1041 (a listbox outside the card does not disable the guard).
//
// World setup: jsdom ships no matchMedia (measured: `typeof window.matchMedia === 'undefined'`), and
// the guard samples the pointer once at attach. Each case therefore sets its world — viewport width
// and/or a matchMedia stub — *before* mount(), so the attach under test sees it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EnterGuard } from '../src/client/enter-guard.ts'
import { MOBILE_FORM_MAX_WIDTH } from '../src/client/mobile/form-marker.ts'

/** The query the guard asks; asserted verbatim so a rewritten query cannot pass silently. */
const COARSE_QUERY = '(pointer: coarse)'

interface MqlStub {
  /** Writable on purpose: a test flips it and then fires the change the guard subscribed to. */
  matches: boolean
  media: string
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

/**
 * Install a stub `window.matchMedia`.
 *
 * `matches: true` = touch screen (coarse primary pointer), `matches: false` = desktop fine pointer.
 * No stub at all = the matchMedia-unavailable world, where the guard falls back to the width rule.
 * Removed again by afterEach (vi.unstubAllGlobals) so no case leaks its pointer into the next.
 */
function stubMatchMedia(matches: boolean): MqlStub {
  const mql: MqlStub = {
    matches,
    media: COARSE_QUERY,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    if (query !== COARSE_QUERY) throw new Error('unexpected media query: ' + query)
    return mql
  }))
  return mql
}

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
let guard: EnterGuard | null = null

/** Create and attach a guard in the world the case has set up; attach samples the pointer once. */
function mount(): EnterGuard {
  const created = new EnterGuard()
  created.attach()
  guard = created
  return created
}

/** The card fixture's textarea (the pre-0.1.5 composer editable). */
function cardTextarea(): HTMLTextAreaElement {
  return host.querySelector('textarea')!
}

/** The card fixture's Lexical contenteditable (the 0.1.5+ composer editable). */
function cardEditable(): HTMLElement {
  return host.querySelector('[contenteditable="true"]') as HTMLElement
}

/** Append a [role=listbox] to the given parent and return it (caller removes it). */
function addListbox(parent: HTMLElement): HTMLElement {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'listbox')
  parent.appendChild(menu)
  return menu
}

beforeEach(() => {
  // Default world: no matchMedia (jsdom) + the phone width, i.e. the fallback path's mobile side.
  setViewport(MOBILE_FORM_MAX_WIDTH)
  host = document.createElement('div')
  host.innerHTML = '<div data-composer-card><textarea></textarea>'
    + '<div contenteditable="true"><p>draft</p></div><button type="button">send</button></div>'
  document.body.appendChild(host)
  // jsdom has no execCommand implementation: stub it as an observable spy.
  document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand
})

afterEach(() => {
  guard?.detach()
  guard = null
  host.remove()
  vi.unstubAllGlobals() // drop the matchMedia stub, if the case installed one
  vi.restoreAllMocks()
  setViewport(1024)
})

describe('EnterGuard 拦截路径（手机形态）', () => {
  beforeEach(() => { mount() })

  it('composer textarea 内普通 Enter：拦截并插入换行', () => {
    const textarea = cardTextarea()
    textarea.focus()
    const event = fireEnter(textarea)
    expect(event.defaultPrevented).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '\n')
  })

  it('composer contenteditable（0.1.5 起）内普通 Enter：拦截并改发 Shift+Enter', () => {
    const editable = cardEditable()
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
    const textarea = cardTextarea()
    textarea.focus()
    expect(() => fireEnter(textarea)).not.toThrow()
  })

  it('contenteditable 改发失败时降级：仍拦截（不发送），不向外抛', () => {
    const editable = cardEditable()
    // The Enter is dispatched on a child so the failing redispatch is the guard's own call.
    editable.dispatchEvent = (() => { throw new Error('dispatch blocked') }) as unknown as typeof editable.dispatchEvent
    const event = fireEnter(editable.querySelector('p')!)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('EnterGuard 判据：触屏优先，宽度只在问不到指针时兜底（#1040）', () => {
  it('触屏（pointer: coarse）+ 宽视口 1024：仍然拦截 — 软键盘没有 Shift 与视口宽度无关', () => {
    setViewport(1024)
    stubMatchMedia(true)
    mount()
    const textarea = cardTextarea()
    textarea.focus()
    const event = fireEnter(textarea)
    expect(event.defaultPrevented).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '\n')
  })

  it('触屏 + 宽视口 1280：textarea 与 contenteditable 两条路径都拦截', () => {
    setViewport(1280)
    stubMatchMedia(true)
    mount()
    const textarea = cardTextarea()
    const textareaEvent = fireEnter(textarea)
    expect(textareaEvent.defaultPrevented).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '\n')

    const editable = cardEditable()
    const gestures = shiftGestures(editable)
    const editableEvent = fireEnter(editable.querySelector('p')!)
    expect(editableEvent.defaultPrevented).toBe(true)
    expect(gestures).toHaveLength(1)
  })

  /**
   * 有意取舍：`pointer: fine` + 窄视口 → **不拦截**（Enter 发送）。
   *
   * 为什么这不是漏洞：`(pointer: coarse)` 描述的是**主指针**。细指针意味着主输入是
   * 鼠标 / 触控板，窄窗口只是「桌面窗口被缩窄」，不是手机形态 —— 用户手边有键盘，
   * Enter 发送是上游原生语义。Android 上即使接了鼠标，`pointer` 仍由主输入决定，
   * 所以真实手机的软键盘 Enter 不会被这格放给上游（那是 `pointer: coarse` 的路径）。
   *
   * 换掉这个取舍必须同时改测试名，避免它被静默反转。
   */
  it('desktop with fine pointer keeps Enter-to-send even in a narrow frame', () => {
    stubMatchMedia(false)
    mount()
    // 窄视口：pre-#1040 的纯宽度判据会在这里拦截，指针判据说不。
    expect(window.innerWidth).toBeLessThanOrEqual(MOBILE_FORM_MAX_WIDTH)
    const narrowEvent = fireEnter(cardTextarea())
    expect(narrowEvent.defaultPrevented).toBe(false)
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('桌面细指针（pointer: coarse 为 false）：不拦截，交还上游（宽窄视口都一样）', () => {
    stubMatchMedia(false)
    mount()
    // Narrow: under the pre-#1040 width rule this frame was intercepted; the pointer says otherwise.
    const narrowEvent = fireEnter(cardTextarea())
    expect(narrowEvent.defaultPrevented).toBe(false)
    // Wide: upstream behavior, unchanged.
    setViewport(MOBILE_FORM_MAX_WIDTH + 1)
    const wideEvent = fireEnter(cardTextarea())
    expect(wideEvent.defaultPrevented).toBe(false)
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('matchMedia 不可用（jsdom / 老 WebView）+ 窄视口：回落到宽度闸，仍然拦截', () => {
    expect(window.matchMedia).toBeUndefined() // the premise: the pointer cannot be asked about here
    mount()
    const event = fireEnter(cardTextarea())
    expect(event.defaultPrevented).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '\n')
  })

  it('matchMedia 不可用 + 宽视口：宽度兜底判定为窄屏之外，不拦截', () => {
    setViewport(MOBILE_FORM_MAX_WIDTH + 1)
    mount()
    expect(fireEnter(cardTextarea()).defaultPrevented).toBe(false)
  })
})

describe('EnterGuard pointer 订阅（#1040）', () => {
  let mql: MqlStub

  // Coarse world + wide frame: the guard subscribes to this MQL at attach.
  beforeEach(() => {
    setViewport(1024)
    mql = stubMatchMedia(true)
    mount()
  })

  it('pointer 变化后重新采样：coarse 掉成 fine（接上鼠标）后不再拦截', () => {
    const onChange = mql.addEventListener.mock.calls[0]![1] as () => void
    expect(fireEnter(cardTextarea()).defaultPrevented).toBe(true)
    mql.matches = false
    onChange()
    expect(fireEnter(cardTextarea()).defaultPrevented).toBe(false)
  })

  it('detach 解绑同一个 change 处理器，且再次 attach 时重新判定而不沿用旧的 coarse 结论', () => {
    const onChange = mql.addEventListener.mock.calls[0]![1]
    guard!.detach()
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', onChange)
    // Back to a kernel without matchMedia, same wide frame: the fallback, i.e. not intercepted.
    vi.unstubAllGlobals()
    setViewport(1024)
    mount()
    expect(fireEnter(cardTextarea()).defaultPrevented).toBe(false)
  })
})

describe('EnterGuard 守卫生效期内的不拦截', () => {
  beforeEach(() => { mount() })

  it('Shift+Enter：上游原生换行，不拦截', () => {
    const event = fireEnter(cardTextarea(), { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
  })

  it('IME 组合（isComposing / keyCode 229）：不拦截', () => {
    const textarea = cardTextarea()
    const composed = fireEnter(textarea, { isComposing: true })
    expect(composed.defaultPrevented).toBe(false)
    const legacy = fireEnter(textarea, { keyCode: 229 })
    expect(legacy.defaultPrevented).toBe(false)
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

describe('EnterGuard 菜单判据限定在当前 composer 卡片（#1041）', () => {
  beforeEach(() => { mount() })

  it('卡片内的引用/命令菜单打开（[role=listbox] 在卡片内）：Enter 选择候选，不拦截', () => {
    const card = host.querySelector('[data-composer-card]') as HTMLElement
    const menu = addListbox(card)
    try {
      const event = fireEnter(cardEditable())
      expect(event.defaultPrevented).toBe(false)
    } finally {
      menu.remove()
    }
  })

  it('卡片之外存在 [role=listbox]（关不掉的上游「+」菜单 / 设置页下拉）：仍然拦截', () => {
    const stray = addListbox(document.body)
    try {
      const event = fireEnter(cardTextarea())
      expect(event.defaultPrevented).toBe(true)
      expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '\n')
    } finally {
      stray.remove()
    }
  })
})

describe('EnterGuard 生命周期', () => {
  it('detach 后不再拦截', () => {
    mount()
    guard!.detach()
    const event = fireEnter(cardTextarea())
    expect(event.defaultPrevented).toBe(false)
  })
})
