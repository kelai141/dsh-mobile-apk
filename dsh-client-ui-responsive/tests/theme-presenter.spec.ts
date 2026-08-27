// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { ThemePresenter, DARK_ATTRIBUTE } from '../src/client/theme-presenter.ts'

type Snapshot = {
  active: { colorScheme: 'light' | 'dark'; tokens: Record<string, string> }
}

const darkSnapshot = (): Snapshot => ({
  active: { colorScheme: 'dark', tokens: { '--a': '#111', '--b': '#222' } },
})
const lightSnapshot = (): Snapshot => ({
  active: { colorScheme: 'light', tokens: { '--a': '#fff' } },
})

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  delete document.documentElement.dataset.dshPresenter
  document.documentElement.style.colorScheme = ''
})

describe('ThemePresenter (H5 覆盖)', () => {
  it('apply 写入 color-scheme、暗色属性、token 变量与 theme-color meta', () => {
    const p = new ThemePresenter()
    p.apply(darkSnapshot())
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    expect(document.body.style.getPropertyValue('--a')).toBe('#111')
    const meta = document.head.querySelector('meta[name="theme-color"]')
    expect(meta).not.toBeNull()
  })

  it('dispose 收回自身写入（最后写入者）', () => {
    const p = new ThemePresenter()
    p.apply(darkSnapshot())
    p.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('--a')).toBe('')
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull()
  })

  it('L3：多实例并存时，先 dispose 的实例不收回后写入者的全局状态', () => {
    const a = new ThemePresenter()
    const b = new ThemePresenter()
    a.apply(lightSnapshot())
    b.apply(darkSnapshot())
    // a disposes first: globals (color-scheme/dark attribute) belong to the last writer b and must
    // stay
    a.dispose()
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    // b's tokens are unaffected by a
    expect(document.body.style.getPropertyValue('--a')).toBe('#111')
    // globals clear only after b disposes
    b.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })
})
