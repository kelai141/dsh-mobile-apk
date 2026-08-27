import { describe, expect, it } from 'vitest'
import { mobileMenuMaxHeight } from '../src/client/menu-viewport-guard.ts'

describe('mobileMenuMaxHeight', () => {
  it('keeps an upward-opening menu below the mobile top bar', () => {
    expect(mobileMenuMaxHeight(316, 61, 10)).toBe(233)
  })

  it('keeps the upstream design cap when sufficient room exists', () => {
    expect(mobileMenuMaxHeight(700, 61)).toBe(320)
  })

  it('does not produce a negative menu height', () => {
    expect(mobileMenuMaxHeight(60, 61)).toBe(0)
  })
})
