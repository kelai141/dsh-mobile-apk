// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerPopupGuard, composerPopupMaxHeight, popupMaxWidth, popupShiftLeft, popupShiftTop,
  visibleViewport,
} from '../src/client/composer-popup-guard.ts'

// jsdom ships no ResizeObserver; the guard only needs the observation API.
vi.stubGlobal('ResizeObserver', class {
  /** No-op: the guard re-measures through rAF anyway. */
  observe(): void {}
  /** No-op. */
  unobserve(): void {}
  /** No-op. */
  disconnect(): void {}
})

describe('popupMaxWidth', () => {
  it('keeps the design cap when the viewport is wide', () => {
    expect(popupMaxWidth(450)).toBe(340)
  })

  it('follows the viewport fraction on narrow phones', () => {
    expect(popupMaxWidth(360)).toBe(331)
  })
})

describe('popupShiftLeft', () => {
  it('shifts a popup that left the viewport back to the gap', () => {
    expect(popupShiftLeft(-84, 256, 360)).toBe(92)
  })

  it('shifts a popup that ran past the right edge', () => {
    expect(popupShiftLeft(200, 420, 360)).toBe(-68)
  })

  it('leaves an inside popup untouched', () => {
    expect(popupShiftLeft(20, 340, 360)).toBe(0)
  })

  it('keeps the left edge readable when the popup is wider than the viewport', () => {
    expect(popupShiftLeft(-30, 400, 360)).toBe(38)
  })
})

describe('popupShiftTop', () => {
  it('lifts a popup whose bottom fell under the keyboard', () => {
    expect(popupShiftTop(300, 700, 0, 500)).toBe(-208)
  })

  it('pushes down a popup that rose above the visible top', () => {
    expect(popupShiftTop(2, 120, 40, 500)).toBe(46)
  })

  it('leaves a popup fully inside the visible region alone', () => {
    expect(popupShiftTop(200, 400, 0, 800)).toBe(0)
  })

  it('keeps the first rows readable when the popup is taller than the visible region', () => {
    expect(popupShiftTop(100, 800, 0, 500)).toBe(-92)
  })

  it('accounts for a panned visual viewport (offsetTop)', () => {
    // 可视区 300..700；弹层 600..900 的下缘必须落到 700-8=692 → 上移 208
    expect(popupShiftTop(600, 900, 300, 400)).toBe(-208)
  })
})

describe('visibleViewport', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'visualViewport')

  afterEach(() => {
    if (original === undefined) delete (window as { visualViewport?: unknown }).visualViewport
    else Object.defineProperty(window, 'visualViewport', original)
  })

  /** Install a visualViewport stub of the given size and pan. */
  function stubVisualViewport(height: number, offsetTop = 0): void {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height, offsetTop, width: 360, offsetLeft: 0, scale: 1 },
    })
  }

  it('prefers the visual viewport height and includes the pan offset', () => {
    stubVisualViewport(495, 12)
    expect(visibleViewport()).toEqual({ top: 12, height: 495 })
  })

  it('falls back to innerHeight when the host has no visualViewport', () => {
    delete (window as { visualViewport?: unknown }).visualViewport
    expect(visibleViewport()).toEqual({ top: 0, height: window.innerHeight })
  })

  it('protects the keyboard area during both directions of the page transition', () => {
    stubVisualViewport(window.innerHeight)
    const style = document.documentElement.style
    const overlap = '--dsh-android-page-ime-overlap'
    const target = '--dsh-android-page-ime-target'
    try {
      style.setProperty(overlap, '50px')
      style.setProperty(target, '250px')
      expect(visibleViewport()?.height).toBe(window.innerHeight - 250)
      style.setProperty(overlap, '180px')
      style.setProperty(target, '0px')
      expect(visibleViewport()?.height).toBe(window.innerHeight - 180)
    } finally {
      style.removeProperty(overlap)
      style.removeProperty(target)
    }
  })

  it('returns null when the host reports no measurable viewport (jsdom)', () => {
    const inner = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 0 })
    delete (window as { visualViewport?: unknown }).visualViewport
    try {
      expect(visibleViewport()).toBeNull()
    } finally {
      if (inner !== undefined) Object.defineProperty(window, 'innerHeight', inner)
    }
  })
})

describe('composerPopupMaxHeight', () => {
  it('keeps an upward-opening menu below the mobile top bar', () => {
    expect(composerPopupMaxHeight(316, 61, 10)).toBe(233)
  })

  it('keeps the design cap when sufficient room exists', () => {
    expect(composerPopupMaxHeight(700, 61)).toBe(320)
  })

  it('honours the model-menu design cap', () => {
    expect(composerPopupMaxHeight(700, 61, 0, 360)).toBe(360)
  })

  it('does not produce a negative menu height', () => {
    expect(composerPopupMaxHeight(60, 61)).toBe(0)
  })

  it('tightens the cap when the keyboard shrinks the visible viewport (#348)', () => {
    expect(composerPopupMaxHeight(668, 61, 0, 9999, 500)).toBe(427)
  })

  it('ignores the visible bound when it is unmeasurable', () => {
    expect(composerPopupMaxHeight(700, 61, 0, 360)).toBe(360)
  })
})

/** Build the composer DOM the guard looks for and pin the measured geometry. */
function mountComposer(rect: { left: number; right: number; bottom: number }): { card: HTMLElement; listbox: HTMLElement } {
  document.body.innerHTML = `
    <div data-dsh-mobile-topbar=""><button>menu</button></div>
    <div data-composer-card="">
      <div class="surface"><div role="listbox"><div>items</div></div></div>
    </div>`
  const card = document.querySelector<HTMLElement>('.surface')!
  card.getBoundingClientRect = () => ({ ...rect, top: 0, width: rect.right - rect.left, height: 0, x: rect.left, y: 0, toJSON: () => ({}) })
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 360 })
  return { card, listbox: card.querySelector<HTMLElement>('[role="listbox"]')! }
}

/**
 * Cross a macrotask boundary: pending microtasks (the guard's MutationObserver
 * callback) all run before a 0ms timer fires.
 */
function macrotask(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** Wait one animation frame, i.e. until frames queued before this point ran. */
function frame(): Promise<void> {
  return new Promise(resolve => { requestAnimationFrame(() => { resolve() }) })
}

/**
 * Let the guard finish a pass, in ORDER rather than after a guessed delay.
 *
 * The cleanup chain is asynchronous: mutation -> MutationObserver callback
 * (microtask) -> guard.queue() -> requestAnimationFrame -> apply(). The old
 * helper slept a fixed 30ms, which is a guess about scheduling: under a loaded
 * parallel run the frame can land after it, so the assertion read the DOM before
 * the guard cleared it (intermittent red).
 *
 * Awaiting a bare rAF is NOT enough: at `menu.remove()` the observer callback
 * has only been *queued* as a microtask, so the guard has not registered its
 * frame yet and FIFO would run ours FIRST. Draining to a macrotask first lets
 * the observer callback run and register the guard's frame, and only then does
 * our frame join a queue the guard is already in front of. That is a
 * deterministic ordering guarantee, not a longer sleep.
 *
 * @param passes - passes to settle, when a caller mutates again in between.
 */
async function flush(passes = 1): Promise<void> {
  for (let pass = 0; pass < passes; pass++) {
    await macrotask()
    await frame()
  }
}

describe('ComposerPopupGuard', () => {
  let guard: ComposerPopupGuard | null = null
  let previousAndroidBridge: PropertyDescriptor | undefined
  let previousVisualViewport: PropertyDescriptor | undefined

  beforeEach(() => {
    previousVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    previousAndroidBridge = Object.getOwnPropertyDescriptor(window, 'androidBridge')
    delete window.androidBridge
  })

  afterEach(() => {
    guard?.detach()
    guard = null
    document.body.innerHTML = ''
    document.documentElement.style.removeProperty('--dsh-android-ime-bottom')
    if (previousVisualViewport === undefined) delete (window as { visualViewport?: unknown }).visualViewport
    else Object.defineProperty(window, 'visualViewport', previousVisualViewport)
    if (previousAndroidBridge === undefined) delete window.androidBridge
    else Object.defineProperty(window, 'androidBridge', previousAndroidBridge)
  })

  it('caps the surface and its scroll container, and shifts the surface inside', async () => {
    const { card, listbox } = mountComposer({ left: -84, right: 256, bottom: 668 })
    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()

    expect(card.style.getPropertyValue('--dsh-mobile-popup-max-width')).toBe('331px')
    expect(card.style.getPropertyValue('--dsh-mobile-popup-shift')).toBe('92px')
    expect(card.hasAttribute('data-dsh-popup')).toBe(true)
    expect(listbox.style.getPropertyValue('--dsh-mobile-popup-max-width')).toBe('331px')
    expect(listbox.style.getPropertyValue('--dsh-mobile-menu-max-height')).not.toBe('')
  })

  it('matches the phone suggestion menu to its composer and preserves the other menu cap', async () => {
    const rect = { left: 16, right: 396, bottom: 668 }
    const { card: surface, listbox } = mountComposer(rect)
    const composer = surface.parentElement!
    const html = document.documentElement
    surface.setAttribute('data-menu-material', 'translucent')
    surface.setAttribute('data-trigger-menu', '')
    composer.getBoundingClientRect = surface.getBoundingClientRect
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    composer.append(menu)
    Object.defineProperty(html, 'clientWidth', { configurable: true, value: 412 })
    html.setAttribute('data-dsh-mobile-form', '')
    try {
      guard = new ComposerPopupGuard()
      guard.attach()
      await flush()

      const width = '--dsh-mobile-popup-max-width'
      expect(surface.style.getPropertyValue(width)).toBe('380px')
      expect(listbox.style.getPropertyValue(width)).toBe('380px')
      expect(menu.style.getPropertyValue(width)).toBe('340px')

      rect.right = 376
      window.dispatchEvent(new Event('resize'))
      await flush()
      expect(surface.style.getPropertyValue(width)).toBe('360px')

      rect.right = 426
      window.dispatchEvent(new Event('resize'))
      await flush()
      expect(surface.style.getPropertyValue(width)).toBe('396px')

      html.removeAttribute('data-dsh-mobile-form')
      window.dispatchEvent(new Event('resize'))
      await flush()
      expect(surface.style.getPropertyValue(width)).toBe('340px')
    } finally {
      html.removeAttribute('data-dsh-mobile-form')
    }
  })

  it('recovers the tablet suggestion surface height when the keyboard closes', async () => {
    const { card: surface, listbox } = mountComposer({ left: 130, right: 785, bottom: 450 })
    const height = '--dsh-mobile-menu-max-height'
    const tabletMarker = 'data-dsh-tablet-trigger-menu'
    surface.setAttribute('data-trigger-menu', '')
    surface.style.maxHeight = '88px'
    const viewport = { height: 250, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 915 })
    const measure = surface.getBoundingClientRect
    surface.getBoundingClientRect = () => {
      const shift = parseFloat(surface.style.getPropertyValue('--dsh-mobile-popup-shift-y')) || 0
      const rect = measure()
      const measuredHeight = parseFloat(surface.style.getPropertyValue(height)) || 88
      return { ...rect, height: measuredHeight, top: rect.bottom + shift - measuredHeight, bottom: rect.bottom + shift }
    }
    window.androidBridge = {} as never

    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()
    expect(surface.hasAttribute(tabletMarker)).toBe(true)
    expect(surface.style.getPropertyValue(height)).toBe('230px')

    viewport.height = 686
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(surface.style.getPropertyValue(height)).toBe('400px')
    expect(listbox.style.getPropertyValue(height)).toBe('')

    delete window.androidBridge
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(surface.hasAttribute(tabletMarker)).toBe(false)
    expect(surface.style.maxHeight).toBe('88px')

    guard.detach()
    guard = null
    expect(surface.style.getPropertyValue(height)).toBe('')
  })

  it('re-measures an already shifted surface without drifting', async () => {
    const { card } = mountComposer({ left: 20, right: 340, bottom: 668 })
    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()

    expect(card.style.getPropertyValue('--dsh-mobile-popup-shift')).toBe('')
  })

  it('removes every correction on detach', async () => {
    const { card, listbox } = mountComposer({ left: -84, right: 256, bottom: 668 })
    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()

    guard.detach()
    guard = null
    expect(card.style.getPropertyValue('--dsh-mobile-popup-max-width')).toBe('')
    expect(card.style.getPropertyValue('--dsh-mobile-popup-shift')).toBe('')
    expect(card.hasAttribute('data-dsh-popup')).toBe(false)
    expect(listbox.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('')
  })

  it('resolves the aria-controls model menu portal and cleans it up when it closes', async () => {
    document.body.innerHTML = '<div data-composer-card><button aria-haspopup="menu" aria-expanded="true" aria-controls="model-menu"></button></div>'
    const menu = document.createElement('div')
    menu.id = 'model-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.getBoundingClientRect = () => ({
      left: 20, right: 280, top: 250, bottom: 600, width: 260, height: 350,
      x: 20, y: 250, toJSON: () => ({}),
    })
    document.body.append(menu)

    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()

    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)
    expect(menu.hasAttribute('data-dsh-android-model-menu')).toBe(false)
    expect(menu.hasAttribute('data-dsh-popup')).toBe(true)
    expect(menu.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('360px')
    expect(menu.style.getPropertyValue('--dsh-mobile-popup-max-width'))
      .toBe(`${popupMaxWidth(document.documentElement.clientWidth)}px`)

    // ModelSelect keeps role=menu on the portal while changing the pane content.
    // Removing that portal must still schedule guard cleanup.
    menu.remove()
    await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(false)
    expect(menu.hasAttribute('data-dsh-android-model-menu')).toBe(false)
    expect(menu.hasAttribute('data-dsh-popup')).toBe(false)
    expect(menu.style.getPropertyValue('--dsh-mobile-popup-max-width')).toBe('')
    expect(menu.style.getPropertyValue('--dsh-mobile-popup-shift')).toBe('')
    expect(menu.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('')
  })

  it('cleanup is frame-ordered, not delay-ordered (reverse evidence for the old fixed sleep)', async () => {
    document.body.innerHTML = '<div data-composer-card><button aria-haspopup="menu" aria-expanded="true" aria-controls="model-menu"></button></div>'
    const menu = document.createElement('div')
    menu.id = 'model-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.getBoundingClientRect = () => ({
      left: 20, right: 280, top: 250, bottom: 600, width: 260, height: 350,
      x: 20, y: 250, toJSON: () => ({}),
    })
    document.body.append(menu)

    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)

    menu.remove()
    // Drain microtasks only: this runs the MutationObserver callback (so the
    // guard queues its frame) but no frame callback. This is the exact moment
    // the old sleep-based helper could race — the attribute must still be there,
    // proving the assertion below depends on a frame, not on elapsed time.
    await macrotask()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)

    await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(false)
  })

  it('a fixed sleep is NOT sufficient when frames are delayed (fails under the old helper)', async () => {
    document.body.innerHTML = '<div data-composer-card><button aria-haspopup="menu" aria-expanded="true" aria-controls="model-menu"></button></div>'
    const menu = document.createElement('div')
    menu.id = 'model-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.getBoundingClientRect = () => ({
      left: 20, right: 280, top: 250, bottom: 600, width: 260, height: 350,
      x: 20, y: 250, toJSON: () => ({}),
    })
    document.body.append(menu)

    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)

    // Reproduce the loaded-run condition directly: the frame queue is serviced
    // far later than any fixed sleep the test might use.
    const realRaf = globalThis.requestAnimationFrame
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      return realRaf(() => { setTimeout(() => { callback(Date.now()) }, 60) })
    })
    try {
      menu.remove()
      // The old helper's fixed 30ms sleep expires BEFORE the delayed frame, so it
      // would assert here and go red. This is the flake, made deterministic.
      await flush(1)
      expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(false)
      expect(menu.hasAttribute('data-dsh-popup')).toBe(false)
    } finally {
      vi.stubGlobal('requestAnimationFrame', realRaf)
    }
  })

  it('waits for the guard frame even when the frame queue is congested', async () => {
    // Simulate the loaded-run condition the flake came from: many frames queued
    // ahead of the guard's. Ordering must still hold, with no extra delay.
    document.body.innerHTML = '<div data-composer-card><button aria-haspopup="menu" aria-expanded="true" aria-controls="model-menu"></button></div>'
    const menu = document.createElement('div')
    menu.id = 'model-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.getBoundingClientRect = () => ({
      left: 20, right: 280, top: 250, bottom: 600, width: 260, height: 350,
      x: 20, y: 250, toJSON: () => ({}),
    })
    document.body.append(menu)

    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)

    menu.remove()
    // Congestion: a burst of unrelated frames registered right now.
    const noise: Promise<void>[] = []
    for (let i = 0; i < 200; i++) noise.push(new Promise(r => { requestAnimationFrame(() => { r() }) }))
    await Promise.all(noise)
    await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(false)
    expect(menu.hasAttribute('data-dsh-popup')).toBe(false)
    expect(menu.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('')
  })

  it('tags the model menu for opaque Android painting independent of viewport form', async () => {
    window.androidBridge = {} as never
    document.body.innerHTML = '<div data-composer-card><button aria-haspopup="menu" aria-expanded="true" aria-controls="model-menu"></button></div>'
    const menu = document.createElement('div')
    menu.id = 'model-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.getBoundingClientRect = () => ({
      left: 20, right: 280, top: 250, bottom: 600, width: 260, height: 350,
      x: 20, y: 250, toJSON: () => ({}),
    })
    document.body.append(menu)

    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()

    expect(document.documentElement.hasAttribute('data-dsh-mobile-form')).toBe(false)
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)
    expect(menu.hasAttribute('data-dsh-android-model-menu')).toBe(true)

    menu.remove()
    await flush()
    expect(menu.hasAttribute('data-dsh-android-model-menu')).toBe(false)
  })

  /** Cap and transform both feed back into measured geometry, as on WebView. */
  function mountFeedbackMenu(naturalHeight = 368) {
    document.body.innerHTML = '<header><span data-conversation-header-leading></span></header><div data-composer-card><button aria-haspopup="menu" aria-expanded="true" aria-controls="feedback-menu"></button></div><div id="feedback-menu" role="group" data-menu-material="translucent"></div>'
    const menu = document.getElementById('feedback-menu')!
    menu.style.padding = '4px'; menu.style.top = '272px'
    const viewport = Object.assign(new EventTarget(), { height: 484, offsetTop: 0 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    let triggerTop = 417
    const box = (top: number, height: number) => ({ left: 31, right: 279, top, bottom: top + height, width: 248, height, x: 31, y: top, toJSON: () => ({}) })
    document.querySelector('header')!.getBoundingClientRect = () => box(42, 76)
    document.querySelector('button')!.getBoundingClientRect = () => box(triggerTop, 28)
    menu.getBoundingClientRect = () => {
      const cap = parseFloat(menu.style.getPropertyValue('--dsh-mobile-menu-max-height'))
      const height = Math.min(naturalHeight, Number.isFinite(cap) ? cap + 8 : naturalHeight)
      const shift = parseFloat(menu.style.getPropertyValue('--dsh-mobile-popup-shift-y')) || 0
      return box(parseFloat(menu.style.top) + shift, height)
    }
    return { menu, viewport, setTriggerTop: (top: number) => { triggerTop = top },
      upstreamPlace: () => { menu.style.top = `${triggerTop - 8 - menu.getBoundingClientRect().height}px`; window.dispatchEvent(new Event('scroll')) } }
  }

  it('breaks the captured 258/284px cycle across upstream scroll placement', async () => {
    const { menu, upstreamPlace } = mountFeedbackMenu()
    menu.style.setProperty('--dsh-mobile-menu-max-height', '284px')
    menu.style.setProperty('--dsh-mobile-popup-shift-y', '-62px')
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    expect(menu.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('271px')
    for (let pass = 0; pass < 12; pass++) {
      upstreamPlace(); await flush()
      expect(menu.getBoundingClientRect()).toMatchObject({ top: 130, bottom: 409, height: 279 })
      expect(menu.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('271px')
    }
  })

  it('recovers a collapsed white strip without recycling its zero cap', async () => {
    const { menu } = mountFeedbackMenu()
    menu.style.top = '41px'; menu.style.setProperty('--dsh-mobile-menu-max-height', '0px')
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    for (let pass = 0; pass < 6; pass++) {
      window.dispatchEvent(new Event('resize')); await flush()
      expect(menu.getBoundingClientRect()).toMatchObject({ top: 130, height: 279, bottom: 409 })
    }
  })

  it('settles after viewport and trigger change during IME animation', async () => {
    const { menu, viewport, setTriggerTop, upstreamPlace } = mountFeedbackMenu()
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    for (const height of [800, 700, 600, 500, 484]) {
      viewport.height = height; setTriggerTop(height - 67)
      viewport.dispatchEvent(new Event('resize')); upstreamPlace(); await flush()
      expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(height - 8)
      expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(130)
    }
    for (let pass = 0; pass < 8; pass++) {
      viewport.dispatchEvent(new Event('resize')); await flush()
      expect(menu.getBoundingClientRect()).toMatchObject({ top: 130, height: 279, bottom: 409 })
    }
  })

  it('discovers a newly opened group portal without relying on a preceding root menu', async () => {
    const { menu } = mountFeedbackMenu()
    menu.remove()
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(false)
    // With no current selection upstream opens the model pane directly, role=group.
    document.body.append(menu); await flush()
    expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)
    expect(menu.getBoundingClientRect()).toMatchObject({ top: 130, height: 279, bottom: 409 })
  })

  it('repositions an open menu when only the shell IME inset changes', async () => {
    const { menu, setTriggerTop } = mountFeedbackMenu()
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    // No window/visualViewport resize and no content-size change: only the
    // shell CSS moves the trigger. The captured AVD has this exact behaviour.
    setTriggerTop(317)
    document.documentElement.style.setProperty('--dsh-android-ime-bottom', '200px')
    await flush()
    expect(menu.getBoundingClientRect()).toMatchObject({ top: 130, height: 179, bottom: 309 })
    expect(menu.style.getPropertyValue('--dsh-mobile-menu-max-height')).toBe('171px')
  })

  it('rebases the captured AVD correction when upstream commits top after scrolling', async () => {
    const { menu, viewport, setTriggerTop } = mountFeedbackMenu(900)
    viewport.height = 800; setTriggerTop(434)
    document.querySelector('header')!.getBoundingClientRect = () => ({
      top: 0, bottom: 76, height: 76, left: 0, right: 360, width: 360, x: 0, y: 0, toJSON: () => ({}),
    })
    menu.style.top = '325px'
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    expect(menu.getBoundingClientRect()).toMatchObject({ top: 88, height: 338, bottom: 426 })
    expect(menu.style.getPropertyValue('--dsh-mobile-popup-shift-y')).toBe('-237px')
    // The real menu's internal scroll commits this top AFTER our scroll pass,
    // without changing its dimensions or emitting another viewport event.
    menu.style.top = '88px'
    await Promise.resolve(); await Promise.resolve()
    expect(menu.getBoundingClientRect()).toMatchObject({ top: 88, height: 338, bottom: 426 })
    expect(menu.style.getPropertyValue('--dsh-mobile-popup-shift-y')).toBe('0px')
  })

  it('does not remeasure its own custom style writes or an upstream popup after detach', async () => {
    const { menu } = mountFeedbackMenu()
    const measure = vi.spyOn(menu, 'getBoundingClientRect')
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    const count = measure.mock.calls.length
    menu.style.setProperty('--dsh-mobile-popup-max-width', '300px')
    await Promise.resolve(); await Promise.resolve()
    expect(measure.mock.calls.length).toBe(count)
    guard.detach()
    const detachedCount = measure.mock.calls.length
    menu.style.top = '88px'
    await flush()
    expect(measure.mock.calls.length).toBe(detachedCount)
  })

  it('bounds oversized content after child mutations and repeated measurements', async () => {
    const { menu } = mountFeedbackMenu(900)
    guard = new ComposerPopupGuard(); guard.attach(); await flush()
    for (let pass = 0; pass < 6; pass++) {
      menu.append(document.createElement('button')); await flush()
      expect(menu.getBoundingClientRect()).toMatchObject({ top: 130, height: 279, bottom: 409 })
      expect(menu.hasAttribute('data-dsh-mobile-model-menu')).toBe(true)
    }
  })

  it('does nothing without a composer card', async () => {
    document.body.innerHTML = '<div data-dsh-mobile-topbar=""></div>'
    guard = new ComposerPopupGuard()
    guard.attach()
    await flush()
    expect(document.body.querySelector('[data-dsh-popup]')).toBeNull()
  })
})
