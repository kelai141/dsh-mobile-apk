// @vitest-environment jsdom
// BackStackSignal: the page half of the shell's system-back policy (§5.1 方案 1).
// Covers the three-input contract the shell relies on (cross-document history is
// the shell's own branch), per-layer close paths, open-order stacking, and the
// failure direction "an unclosable layer keeps consuming instead of exiting".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BackStackSignal } from '../src/client/mobile/back-stack.ts'

let signal: BackStackSignal
let toggleSidebar: ReturnType<typeof vi.fn>
let uplink: ReturnType<typeof vi.fn>

/** Deliver the pending MutationObserver batch (jsdom delivers it as a microtask). */
function flush(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** The phone form marker attribute the drawer detector gates on. */
function setPhoneForm(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

/** Build the frame root with the sidebar expanded (drawer open) by default. */
function buildFrame(collapsed = false): HTMLElement {
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-frame', '')
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frame)
  return frame
}

/** Build the `Modal` / settings-panel layout: overlay > mask + panel[role=dialog]. */
function buildDialog(options: { mask?: boolean, closeButton?: boolean, label?: string } = {}): HTMLElement {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'presentation')
  if (options.mask !== false) {
    const mask = document.createElement('div')
    mask.setAttribute('aria-hidden', 'true')
    overlay.appendChild(mask)
  }
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  if (options.label !== undefined) dialog.setAttribute('aria-label', options.label)
  if (options.closeButton === true) {
    const close = document.createElement('button')
    close.className = 'x_close'
    dialog.appendChild(close)
  }
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  return dialog
}

/** Every event type the given element received, in order. */
function record(target: EventTarget): string[] {
  const seen: string[] = []
  for (const type of ['click', 'mousedown', 'pointerdown']) {
    target.addEventListener(type, () => { seen.push(type) })
  }
  return seen
}

beforeEach(() => {
  document.body.innerHTML = ''
  setPhoneForm(false)
  toggleSidebar = vi.fn()
  uplink = vi.fn()
  window.dshBackBridge = { setAvailable: uplink }
  signal = new BackStackSignal({ toggleSidebar })
})

afterEach(() => {
  signal.detach()
  delete window.dshBackBridge
})

describe('back entry and uplink', () => {
  it('publishes the entry, the depth globals, and one initial "no layer" signal', async () => {
    signal.attach()
    expect(typeof window.__dshBack).toBe('function')
    expect(window.__dshBackDepth).toBe(0)
    expect(window.__dshBackKinds).toEqual([])
    expect(uplink).toHaveBeenCalledTimes(1)
    expect(uplink).toHaveBeenCalledWith(false)
    signal.detach()
    expect(window.__dshBack).toBeUndefined()
    expect(window.__dshBackDepth).toBeUndefined()
    expect(window.__dshBackKinds).toBeUndefined()
    expect(uplink).toHaveBeenLastCalledWith(false)
  })

  it('sends the uplink only when availability changes', async () => {
    signal.attach()
    buildFrame()
    setPhoneForm(true)
    await flush()
    expect(uplink).toHaveBeenCalledTimes(2)
    expect(uplink).toHaveBeenLastCalledWith(true)
    // A DOM change that does not move availability must not cross the bridge again.
    document.body.appendChild(document.createElement('span'))
    await flush()
    expect(uplink).toHaveBeenCalledTimes(2)
  })
})

describe('drawer layer', () => {
  it('is a layer only on the phone form, and closes through the layout toggle', async () => {
    buildFrame()
    setPhoneForm(false)
    signal.attach()
    await flush()
    expect(window.__dshBackDepth).toBe(0)

    setPhoneForm(true)
    await flush()
    expect(window.__dshBackKinds).toEqual(['drawer'])
    expect(window.__dshBack?.()).toBe(true)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('collapses to nothing when the frame already carries data-sidebar-collapsed', async () => {
    buildFrame(true)
    setPhoneForm(true)
    signal.attach()
    await flush()
    expect(window.__dshBackDepth).toBe(0)
  })
})

describe('dialog layer', () => {
  it('closes the topmost layer first, then the drawer below it', async () => {
    buildFrame()
    setPhoneForm(true)
    signal.attach()
    await flush()
    const dialog = buildDialog({ closeButton: true })
    await flush()
    expect(window.__dshBackKinds).toEqual(['drawer', 'dialog'])

    const overlay = dialog.parentElement as HTMLElement
    overlay.querySelector('[aria-hidden="true"]')?.addEventListener('click', () => { overlay.remove() })
    expect(window.__dshBack?.()).toBe(true)
    await flush()
    // The dialog left the DOM: the drawer is the remaining layer.
    expect(window.__dshBackKinds).toEqual(['drawer'])
    expect(toggleSidebar).not.toHaveBeenCalled()

    expect(window.__dshBack?.()).toBe(true)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('closes through the mask with mousedown + click (Modal onClose / lightbox onMouseDown)', async () => {
    signal.attach()
    const dialog = buildDialog({ label: 'preview' })
    const mask = dialog.parentElement?.querySelector('[aria-hidden="true"]') as HTMLElement
    const seen = record(mask)
    await flush()
    expect(window.__dshBack?.()).toBe(true)
    expect(seen).toEqual(['mousedown', 'click'])
  })

  it('falls back to the dialog close button when the layout carries no mask', async () => {
    signal.attach()
    const dialog = buildDialog({ mask: false, closeButton: true })
    const close = dialog.querySelector('button') as HTMLElement
    const seen = record(close)
    await flush()
    expect(window.__dshBack?.()).toBe(true)
    expect(seen).toEqual(['click'])
  })

  it('treats a lightbox-shaped backdrop (mask is a child of the dialog) as one layer', async () => {
    signal.attach()
    const backdrop = document.createElement('div')
    backdrop.setAttribute('role', 'dialog')
    backdrop.setAttribute('aria-modal', 'true')
    backdrop.setAttribute('aria-label', 'preview')
    const mask = document.createElement('div')
    mask.setAttribute('aria-hidden', 'true')
    backdrop.appendChild(mask)
    document.body.appendChild(backdrop)
    const seen = record(mask)
    await flush()
    expect(window.__dshBackKinds).toEqual(['dialog'])
    expect(window.__dshBack?.()).toBe(true)
    expect(seen).toEqual(['mousedown', 'click'])
  })
})

describe('other layers', () => {
  it('closes the trajectory "Event details" panel through its close control', async () => {
    signal.attach()
    const aside = document.createElement('aside')
    aside.setAttribute('aria-label', 'Event details')
    const close = document.createElement('button')
    close.className = 'x_close'
    aside.appendChild(close)
    document.body.appendChild(aside)
    const seen = record(close)
    await flush()
    expect(window.__dshBackKinds).toEqual(['trajectory-details'])
    expect(window.__dshBack?.()).toBe(true)
    expect(seen).toEqual(['click'])
  })

  it('leaves right-column fullscreen through the mode toggle, else the collapse toggle', async () => {
    signal.attach()
    const panel = document.createElement('div')
    // Presented column: the fullscreen attribute alone is the remembered mode, not a layer.
    panel.setAttribute('data-sidebar-right-panel', 'fullscreen')
    panel.setAttribute('data-sidebar-right-open', '')
    const mode = document.createElement('button')
    mode.setAttribute('data-sidebar-right-mode', 'push')
    panel.appendChild(mode)
    const toggle = document.createElement('button')
    toggle.setAttribute('data-sidebar-right-toggle', '')
    panel.appendChild(toggle)
    document.body.appendChild(panel)
    const seenMode = record(mode)
    const seenToggle = record(toggle)
    await flush()
    expect(window.__dshBackKinds).toEqual(['right-fullscreen'])
    expect(window.__dshBack?.()).toBe(true)
    expect(seenMode).toEqual(['click'])
    expect(seenToggle).toEqual([])

    // Without the mode toggle the collapse control is the fallback.
    mode.remove()
    expect(window.__dshBack?.()).toBe(true)
    expect(seenToggle).toEqual(['click'])
  })

  it('does not count a collapsed right column as a layer even while its mode is fullscreen', async () => {
    signal.attach()
    const panel = document.createElement('div')
    panel.setAttribute('data-sidebar-right-panel', 'fullscreen')
    panel.setAttribute('aria-hidden', 'true')
    document.body.appendChild(panel)
    await flush()
    // The MuMu x86_64 measured pair above is a collapsed column, not a layer.
    expect(window.__dshBackKinds).toEqual([])
    expect(window.__dshBackDepth).toBe(0)

    // Presenting the column makes it a layer again, and the mode toggle closes it.
    panel.removeAttribute('aria-hidden')
    panel.setAttribute('data-sidebar-right-open', '')
    const mode = document.createElement('button')
    mode.setAttribute('data-sidebar-right-mode', 'push')
    panel.appendChild(mode)
    const seenMode = record(mode)
    await flush()
    expect(window.__dshBackKinds).toEqual(['right-fullscreen'])
    expect(window.__dshBack?.()).toBe(true)
    expect(seenMode).toEqual(['click'])
  })

  it('dismisses a menu with the menu own outside-pointerdown path', async () => {
    signal.attach()
    const menu = document.createElement('div')
    menu.setAttribute('data-trigger-menu', '')
    document.body.appendChild(menu)
    const seen: string[] = []
    document.addEventListener('pointerdown', event => { seen.push((event.target as Element)?.tagName ?? '') }, true)
    await flush()
    expect(window.__dshBackKinds).toEqual(['menu'])
    expect(window.__dshBack?.()).toBe(true)
    expect(seen).toEqual(['BODY'])
  })

  it('pops one drill level before dismissing the whole menu', async () => {
    signal.attach()
    const menu = document.createElement('div')
    menu.setAttribute('data-trigger-menu', '')
    const nav = document.createElement('nav')
    // Upstream trail: root, one ancestor step, then the current (disabled) step.
    const labels = ['workspace', 'src', 'client']
    for (const [index, label] of labels.entries()) {
      const crumb = document.createElement('button')
      crumb.textContent = label
      if (index === labels.length - 1) {
        crumb.setAttribute('aria-current', 'location')
        crumb.disabled = true
      }
      nav.appendChild(crumb)
    }
    menu.appendChild(nav)
    document.body.appendChild(menu)
    const steps = [...nav.querySelectorAll('button')]
    const parent = steps[1] as HTMLButtonElement
    const seenParent: string[] = []
    parent.addEventListener('mousedown', () => { seenParent.push('mousedown') })
    await flush()
    expect(window.__dshBackKinds).toEqual(['menu', 'menu-drill'])

    expect(window.__dshBack?.()).toBe(true)
    await flush()
    expect(seenParent).toEqual(['mousedown'])
    // The menu stays open: only the drill step was popped.
    expect(window.__dshBackKinds).toEqual(['menu', 'menu-drill'])
  })
})

describe('failure direction', () => {
  it('keeps counting a layer whose control is missing (never lets the shell exit)', async () => {
    signal.attach()
    const orphan = document.createElement('div')
    orphan.setAttribute('data-sidebar-right-panel', 'fullscreen')
    orphan.setAttribute('data-sidebar-right-open', '')
    document.body.appendChild(orphan)
    await flush()
    expect(window.__dshBackKinds).toEqual(['right-fullscreen'])
    expect(window.__dshBack?.()).toBe(false)
    await flush()
    expect(window.__dshBackKinds).toEqual(['right-fullscreen'])
    expect(uplink).toHaveBeenLastCalledWith(true)
  })
})
