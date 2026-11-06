// @vitest-environment jsdom
/**
 * D7 regression: the narrow-form sheet pins the off-canvas drawer for the
 * settings panel alone. The marker therefore has to publish the settings-only
 * fact on the root, because the CSS rule that consumes it is an ancestor
 * match and the panel carrying data-dsh-settings-dialog is a descendant.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MobileFormMarker } from '../src/client/mobile/form-marker.ts'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'

const markers: MobileFormMarker[] = []

afterEach(() => {
  for (const marker of markers.splice(0)) marker.detach()
  document.body.innerHTML = ''
})

function attach(): MobileFormMarker {
  const marker = new MobileFormMarker()
  marker.attach()
  markers.push(marker)
  return marker
}

/** Mount one body-level aria-modal dialog, optionally carrying the settings nav. */
function mountDialog(withNav: boolean): HTMLElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  if (withNav) dialog.append(document.createElement('nav'))
  document.body.append(dialog)
  return dialog
}

/** Flush the MutationObserver microtask. */
const settle = async (): Promise<void> => { await Promise.resolve() }

describe('MobileFormMarker settings dialog fact', () => {
  it('does not publish the settings fact for a plain modal', async () => {
    attach()
    mountDialog(false)
    await settle()

    expect(document.documentElement.hasAttribute('data-dsh-modal-open')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(false)
    expect(document.querySelector('[data-dsh-settings-dialog]')).toBeNull()
  })

  it('publishes the settings fact on the root and tags the panel', async () => {
    attach()
    const dialog = mountDialog(true)
    await settle()

    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(true)
    expect(dialog.hasAttribute('data-dsh-settings-dialog')).toBe(true)
  })

  it('retracts both facts when the settings panel closes', async () => {
    attach()
    const dialog = mountDialog(true)
    await settle()
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(true)

    dialog.remove()
    await settle()

    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-modal-open')).toBe(false)
  })

  it('moves the settings fact with the panel instead of pinning it to the first dialog', async () => {
    attach()
    const modal = mountDialog(false)
    await settle()
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(false)

    const settings = mountDialog(true)
    await settle()
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(true)

    // The plain modal closing must not retract the settings fact.
    modal.remove()
    await settle()
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(true)
    expect(settings.hasAttribute('data-dsh-settings-dialog')).toBe(true)
  })

  it('keeps the drawer pin a plain ancestor match', () => {
    // Chromium 105 is the :has() floor while the browser syntax floor here is
    // 87, so the rule must not depend on :has() nor on the coarse modal fact.
    // Comments may name both, so only the declarations are inspected.
    const selectors = MOBILE_FORM_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(selectors).toContain('html[data-dsh-settings-open] [data-dsh-frame]')
    expect(selectors).not.toContain(':has(')
    expect(selectors).not.toContain('@supports')
    expect(selectors).not.toContain('html[data-dsh-modal-open]')
  })

  it('detach removes the root facts', async () => {
    const marker = attach()
    mountDialog(true)
    await settle()
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(true)

    marker.detach()
    markers.splice(markers.indexOf(marker), 1)
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-modal-open')).toBe(false)
  })

  it('tags a settings panel that upstream mounts inside the shell overlay layer', async () => {
    // 0.2.2 起 SettingsRoot 的面板渲染在 AppFrame 的 [data-shell-overlay] 里；旧的
    // 「排除覆盖层内对话框」过滤会把它一起排掉，整套移动设置层因此永不激活
    // （真机表现：点开设置后是桌面双栏布局，错位且进不去分区）。
    const overlay = document.createElement('div')
    overlay.setAttribute('data-shell-overlay', '')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('data-shortcut-modal', 'settings')
    dialog.append(document.createElement('nav'))
    overlay.append(dialog)
    document.body.append(overlay)
    attach()
    await settle()
    expect(dialog.hasAttribute('data-dsh-settings-dialog')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-settings-open')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-modal-open')).toBe(true)
  })
})
