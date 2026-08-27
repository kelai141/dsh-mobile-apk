// @vitest-environment node
// Mobile-frame scroll containment guard (issue apk#65): the mobile frame must
// stay a non-scroll container. If it regresses to overflow: hidden, the closed
// details sheet inflates its scrollHeight and scrollIntoView / touch drags
// scroll the whole frame — content drifts up, the top bar scrolls away and the
// closed sheet peeks into the viewport bottom like a phantom details popup.
// Also guards the trajectory full-viewport overlay CSS (issue apk#67).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const moduleCss = fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url))
const overlayCss = fileURLToPath(new URL('../src/client/trajectory-details.css.ts', import.meta.url))

function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `selector ${selector} present`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('mobile frame scroll containment (apk#65)', () => {
  it('.mobileFrame uses overflow: clip so the frame is not a scroll container', () => {
    const block = ruleBlock(readFileSync(moduleCss, 'utf8'), '.mobileFrame')
    expect(block).toMatch(/overflow:\s*clip/)
    expect(block).not.toMatch(/overflow:\s*hidden/)
  })
})

describe('trajectory details overlay (apk#67)', () => {
  it('overlays the panel full-viewport on narrow screens', () => {
    const source = readFileSync(overlayCss, 'utf8')
    const body = source.match(/`([^`]*)`/)?.[1] ?? ''
    expect(body).toContain('@media (max-width: 760px)')
    expect(body).toContain('aside[aria-label="Event details"]')
    expect(body).toContain('position: fixed')
    expect(body).toContain('inset: 0')
  })
  it('scopes the overlay to the aside (the tablist also carries the same aria-label)', () => {
    const source = readFileSync(overlayCss, 'utf8')
    const body = source.match(/`([^`]*)`/)?.[1] ?? ''
    // The fixed-position rule must be aside-scoped, never bare [aria-label="Event details"].
    expect(body).not.toContain('[data-mobile] [aria-label="Event details"] {')
    expect(body).toContain('[data-mobile] aside[aria-label="Event details"] {')
  })
  it('raises the ledger stacking context while the panel is open (banner/tabs/timeline cover fix)', () => {
    const source = readFileSync(overlayCss, 'utf8')
    const body = source.match(/`([^`]*)`/)?.[1] ?? ''
    expect(body).toContain(':has(aside[aria-label="Event details"])')
    expect(body).toContain('z-index: 12')
  })
})
