// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'

/** Select width-gated rules from the browser's CSS parser, not source comments. */
function activeRules(width: number): CSSStyleRule[] {
  const sheet = document.querySelector('style')!.sheet!
  const result: CSSStyleRule[] = []
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const min = /min-width:\s*(\d+)px/.exec(rule.conditionText)
        const max = /max-width:\s*(\d+)px/.exec(rule.conditionText)
        if (min !== null && width >= Number(min[1])) visit(rule.cssRules)
        else if (max !== null && width <= Number(max[1])) visit(rule.cssRules)
      } else if (rule instanceof CSSStyleRule) {
        result.push(rule)
      }
    }
  }
  visit(sheet.cssRules)
  return result
}

/** The matched declarations prove which layer owns the top padding. */
function declarations(width: number, selector: string, property: string): string[] {
  const element = document.querySelector(selector)!
  return activeRules(width)
    .filter(rule => element.matches(rule.selectorText))
    .map(rule => rule.style.getPropertyValue(property))
    .filter(Boolean)
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = `<div data-dsh-frame>
    <aside class="upstream_sidebarCol"><button>Navigation</button></aside>
    <main class="upstream_centerCol"><header>Session</header></main>
    <aside class="upstream_rightbarCol" data-rightbar-col>
      <div data-sidebar-right-panel="fullscreen">Browser</div>
    </aside>
  </div>`
  const style = document.createElement('style')
  style.textContent = MOBILE_FORM_CSS
  document.head.appendChild(style)
})

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('APK #340 / #135 system top inset ownership', () => {
  it.each([768, 1024, 1600])('wide %ipx clears all columns once at the frame', width => {
    expect(declarations(width, '[data-dsh-frame]', 'padding-top'))
      .toEqual(['var(--dsh-mobile-top-inset, 0px)'])
    for (const selector of ["[class*='sidebarCol']", "[class*='centerCol']", "[class*='rightbarCol']", '[data-sidebar-right-panel]']) {
      // The absolute fullscreen panel is anchored in the already inset column.
      expect(declarations(width, selector, 'padding-top')).toEqual([])
    }
  })

  it.each([768, 1600])('wide %ipx keeps the grid inside the original viewport height', width => {
    expect(declarations(width, '[data-dsh-frame]', 'box-sizing')).toEqual(['border-box'])
    expect(declarations(width, '[data-dsh-frame]', 'grid-template-rows')).toEqual(['minmax(0, 1fr)'])
    // Reserving top space must not replace the IME-boundary height owner.
    expect(declarations(width, '[data-dsh-frame]', 'height')).toEqual([])
  })

  it.each([390, 767])('narrow %ipx retains #135 without a second frame inset', width => {
    expect(declarations(width, '[data-dsh-frame]', 'padding-top')).toEqual([])
    for (const selector of ["[class*='sidebarCol']", "[class*='centerCol']", '[data-sidebar-right-panel]']) {
      expect(declarations(width, selector, 'padding-top'))
        .toEqual(['var(--dsh-mobile-top-inset, 0px)'])
    }
  })

  it('shares the live native/safe-area maximum so immersive and cutout updates need no fixed gap', () => {
    expect(declarations(1024, ':root', '--dsh-mobile-top-inset'))
      .toEqual(['max(env(safe-area-inset-top, 0px), var(--dsh-android-system-top, 0px))'])
  })
})
