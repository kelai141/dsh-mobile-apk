// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installPluginMenuPosition } from '../src/client/plugin-menu-position.ts'
import { PLUGIN_SETTINGS_CSS } from '../src/client/plugin-settings.css.ts'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
}

describe('Android plugin select positioning', () => {
  let trigger: HTMLButtonElement
  let menu: HTMLElement
  let dispose: () => void

  function open(): Promise<void> {
    trigger.click()
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
  }

  beforeEach(() => {
    vi.stubGlobal('CSS', { supports: () => false })
    vi.stubGlobal('innerHeight', 640)
    document.body.innerHTML = `
      <section data-plugin-item-detail="web-search">
        <button id="plugin-config-web-search-billing" aria-haspopup="menu" aria-expanded="false">Plan</button>
      </section>
      <div role="menu" data-anchor-side="bottom" data-match-anchor-width></div>
    `
    trigger = document.querySelector('button')!
    menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-anchor-side', 'bottom')
    menu.setAttribute('data-match-anchor-width', '')
    Object.defineProperty(menu, 'scrollHeight', { value: 150 })
    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-expanded', 'true')
      document.body.append(menu)
    })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(44, 100, 260, 34))
  })

  afterEach(() => {
    dispose()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('places only the menu opened by the form trigger under the field', async () => {
    dispose = installPluginMenuPosition()
    await open()
    expect(menu.hasAttribute('data-dsh-plugin-select-menu')).toBe(true)
    expect(menu.style.getPropertyValue('--dsh-select-left')).toBe('44px')
    expect(menu.style.getPropertyValue('--dsh-select-width')).toBe('260px')
    expect(menu.style.getPropertyValue('--dsh-select-top')).toBe('138px')
    expect(document.querySelectorAll('[data-dsh-plugin-select-menu]')).toHaveLength(1)
  })

  it('fits above a bottom field and releases its styles when closed', async () => {
    vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(44, 550, 260, 34))
    dispose = installPluginMenuPosition()
    await open()
    expect(menu.style.getPropertyValue('--dsh-select-top')).toBe('auto')
    expect(menu.style.getPropertyValue('--dsh-select-bottom')).toBe('94px')
    trigger.setAttribute('aria-expanded', 'false')
    await Promise.resolve()
    await new Promise(resolve => requestAnimationFrame(() => resolve()))
    expect(menu.hasAttribute('data-dsh-plugin-select-menu')).toBe(false)
    expect(menu.style.length).toBe(0)
  })

  it('aligns the add menu to the end of its split control', async () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-plugin-panel', '')
    panel.innerHTML = '<div data-plugin-toolbar><span role="group"></span></div>'
    document.body.append(panel)
    const group = panel.querySelector('[role="group"]')!
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(rect(248, 48, 120, 32))
    group.append(trigger)
    menu.className = 'sample_addMenu'
    menu.removeAttribute('data-match-anchor-width')
    dispose = installPluginMenuPosition()
    await open()
    expect(menu.style.getPropertyValue('--dsh-select-left')).toBe('48px')
    expect(menu.style.getPropertyValue('--dsh-select-width')).toBe('320px')
    expect(menu.style.getPropertyValue('--dsh-select-top')).toBe('84px')
  })

  it('marks the select material without writing fallback geometry when CSS anchors are supported', async () => {
    vi.stubGlobal('CSS', { supports: () => true })
    dispose = installPluginMenuPosition()
    await open()
    expect(menu.hasAttribute('data-dsh-plugin-select-menu')).toBe(true)
    expect(menu.style.length).toBe(0)

    dispose()
    expect(menu.hasAttribute('data-dsh-plugin-select-menu')).toBe(false)
  })
})

describe('Android plugin select material', () => {
  it('uses solid charcoal only on the background of a dark plugin select menu', () => {
    const rule = /^(body\[data-ds-dark-theme\][^{]+)\{([^}]+)\}/m.exec(PLUGIN_SETTINGS_CSS)
    expect(rule).not.toBeNull()
    const [, selector, declarations] = rule!
    expect(declarations).toContain('background-color: #303136')
    expect(declarations).toContain('backdrop-filter: none')

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.setAttribute('data-match-anchor-width', '')
    menu.innerHTML = '<div aria-hidden="true"></div><button role="menuitem">Automatic</button>'
    const [background, option] = menu.children
    document.body.append(menu)
    try {
      document.body.setAttribute('data-ds-dark-theme', '')
      expect(background.matches(selector)).toBe(false)

      menu.setAttribute('data-dsh-plugin-select-menu', '')
      expect(background.matches(selector)).toBe(true)
      expect(option.matches(selector)).toBe(false)

      document.body.removeAttribute('data-ds-dark-theme')
      expect(background.matches(selector)).toBe(false)

      document.body.setAttribute('data-ds-dark-theme', '')
      menu.removeAttribute('data-match-anchor-width')
      expect(background.matches(selector)).toBe(false)
    } finally {
      document.body.removeAttribute('data-ds-dark-theme')
      menu.remove()
    }
  })
})
