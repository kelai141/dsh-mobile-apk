// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ThemeBridge } from '../src/client/theme-bridge.ts'

type Bridge = { setDark: (d: boolean) => void }

/** Install a minimal matchMedia mock; jsdom has none. */
function mockMatchMedia(initialDark = false) {
  let dark = initialDark
  const mql = {
    get matches() { return dark },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }
  window.matchMedia = vi.fn((q: string) => {
    if (q.includes('prefers-color-scheme')) return mql
    return { ...mql, media: q }
  }) as unknown as typeof window.matchMedia
  return mql
}

beforeEach(() => {
  delete (window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge
  delete (window as { androidBridge?: unknown }).androidBridge
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('ThemeBridge (H5 覆盖)', () => {
  it('早装桥存在时 stand down：不替换 matchMedia、不建立新桥', () => {
    mockMatchMedia()
    const existing = { setDark: vi.fn() }
    ;(window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge = existing
    const native = window.matchMedia
    new ThemeBridge().install()
    expect(window.matchMedia).toBe(native) // not replaced
    expect((window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge).toBe(existing)
  })

  it('无桥 + 壳同步桥存在：建立本地桥、hook matchMedia、boot 快照拉取真实深色', () => {
    mockMatchMedia(false) // native stuck on light (vivo scenario)
    ;(window as { androidBridge?: unknown }).androidBridge = { getSystemDark: () => true }
    new ThemeBridge().install()
    // Bridge established and the boot snapshot is dark
    const bridge = (window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge
    expect(bridge).toBeDefined()
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(true)
  })

  it('L4：无任何 setDark 来源（无早装桥、无壳桥）时 stand down，不装悬空桩', () => {
    mockMatchMedia(false)
    const native = window.matchMedia
    new ThemeBridge().install()
    expect(window.matchMedia).toBe(native)
    expect((window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge).toBeUndefined()
  })

  it('setDark 变化驱动已注册监听器；注册时立即 fire 当前值', () => {
    mockMatchMedia(false)
    ;(window as { androidBridge?: unknown }).androidBridge = { getSystemDark: () => false }
    new ThemeBridge().install()
    const bridge = (window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge!
    const listener = vi.fn()
    const mql = window.matchMedia('(prefers-color-scheme: dark)') as unknown as {
      addEventListener: (t: string, cb: () => void) => void
    }
    mql.addEventListener('change', listener)
    expect(listener).toHaveBeenCalledTimes(1) // fires on registration (with the current value)
    bridge.setDark(true)
    expect(listener).toHaveBeenCalledTimes(2)
    bridge.setDark(true) // idempotent: no change, no fire
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('addListener 路径同样被驱动', () => {
    mockMatchMedia(false)
    ;(window as { androidBridge?: unknown }).androidBridge = { getSystemDark: () => false }
    new ThemeBridge().install()
    const bridge = (window as unknown as { __dshThemeBridge?: Bridge }).__dshThemeBridge!
    const listener = vi.fn()
    const mql = window.matchMedia('(prefers-color-scheme: dark)') as unknown as {
      addListener: (cb: () => void) => void
    }
    mql.addListener(listener)
    expect(listener).toHaveBeenCalledTimes(0) // addListener does not fire immediately, unlike addEventListener's fire-on-register semantics
    bridge.setDark(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
