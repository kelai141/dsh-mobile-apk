// @vitest-environment jsdom
// LightboxZoom unit tests: the gesture belongs to the picture, never to the page.
//
// The bug this guards: a pinch inside the preview used to be served by Chromium's page-level
// zoom, so the visual viewport scaled and the whole UI (header, conversation, composer) grew
// with the image. The contract these cases pin down is therefore "only the <img> moves":
//  - the transform lands on the lightbox image and on nothing else;
//  - a gesture that starts on the mask (the documented close path) never zooms;
//  - every close path drops the transform, so it cannot leak into the next message;
//  - a second, different image starts from 1x instead of inheriting the previous zoom.
//
// jsdom ships no layout, so getBoundingClientRect is stubbed per image: the module only uses
// it to turn a pointer position into a transform-origin fraction.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LightboxZoom, lightboxImage, ZOOM_TARGET_ATTR } from '../src/client/mobile/lightbox-zoom.ts'

/** Build one preview dialog shaped like the upstream lightbox: backdrop > stage > mask + img. */
function mountPreview(): { dialog: HTMLElement; stage: HTMLElement; img: HTMLImageElement; mask: HTMLElement } {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  const stage = document.createElement('div')
  const mask = document.createElement('div')
  mask.setAttribute('aria-hidden', 'true')
  const img = document.createElement('img')
  img.setAttribute(ZOOM_TARGET_ATTR, '')
  stage.append(mask, img)
  dialog.append(stage)
  document.body.append(dialog)
  return { dialog, stage, img, mask }
}

/** Give an element a layout box; jsdom reports zeros otherwise. */
function box(el: Element, left: number, top: number, width: number, height: number): void {
  ;(el as HTMLElement).getBoundingClientRect = () => ({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
    toJSON: () => ({}),
  }) as DOMRect
}

/** One pointer event; jsdom has no PointerEvent constructor, so a MouseEvent carries the fields. */
function pointer(type: string, target: EventTarget, id: number, x: number, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: id })
  Object.defineProperty(event, 'timeStamp', { value: Date.now() })
  target.dispatchEvent(event)
  return event
}

describe('lightboxImage', () => {
  it('resolves the picture inside a preview dialog', () => {
    const { dialog, img } = mountPreview()
    expect(lightboxImage(dialog)).toBe(img)
  })

  it('resolves a flat preview whose image is a direct child', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const mask = document.createElement('div')
    mask.setAttribute('aria-hidden', 'true')
    const img = document.createElement('img')
    dialog.append(mask, img)
    expect(lightboxImage(dialog)).toBe(img)
  })

  it('returns null for a dialog that draws no picture', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.append(document.createElement('div'))
    expect(lightboxImage(dialog)).toBeNull()
  })
})

describe('LightboxZoom', () => {
  let zoom: LightboxZoom

  beforeEach(() => { zoom = new LightboxZoom(); zoom.attach() })
  afterEach(() => { zoom.detach(); document.body.replaceChildren() })

  it('scales the picture on a two-finger spread and leaves every ancestor untouched', () => {
    const { dialog, stage, img } = mountPreview()
    box(img, 40, 100, 300, 200)
    pointer('pointerdown', img, 1, 100, 200)
    pointer('pointerdown', img, 2, 200, 200)
    pointer('pointermove', img, 2, 300, 200)
    expect(img.style.transform).toMatch(/^scale\(2\./)
    // The promise to the user: the surroundings do not move.
    expect(stage.style.transform).toBe('')
    expect(dialog.style.transform).toBe('')
    expect(zoom.currentZoom()).toBeGreaterThan(1)
  })

  it('never zooms when the gesture starts on the mask', () => {
    const { img, mask } = mountPreview()
    box(img, 0, 0, 300, 200)
    pointer('pointerdown', mask, 1, 100, 100)
    pointer('pointerdown', mask, 2, 200, 100)
    pointer('pointermove', mask, 2, 400, 100)
    expect(img.style.transform).toBe('')
    expect(zoom.currentZoom()).toBe(1)
  })

  it('clamps the pinch to the documented bounds', () => {
    const { img } = mountPreview()
    box(img, 0, 0, 300, 200)
    pointer('pointerdown', img, 1, 100, 100)
    pointer('pointerdown', img, 2, 200, 100)
    pointer('pointermove', img, 2, 9000, 100)
    expect(zoom.currentZoom()).toBe(5)
  })

  it('toggles between fitted and reading scale on a double tap', () => {
    const { img } = mountPreview()
    box(img, 0, 0, 300, 200)
    pointer('pointerdown', img, 1, 150, 100)
    pointer('pointerup', img, 1, 150, 100)
    pointer('pointerdown', img, 2, 150, 100)
    pointer('pointerup', img, 2, 150, 100)
    expect(zoom.currentZoom()).toBe(2.5)
    pointer('pointerdown', img, 3, 150, 100)
    pointer('pointerup', img, 3, 150, 100)
    pointer('pointerdown', img, 4, 150, 100)
    pointer('pointerup', img, 4, 150, 100)
    expect(zoom.currentZoom()).toBe(1)
  })

  it('does not treat a drag as a double tap', () => {
    const { img } = mountPreview()
    box(img, 0, 0, 300, 200)
    pointer('pointerdown', img, 1, 100, 100)
    pointer('pointermove', img, 1, 160, 100)
    pointer('pointerup', img, 1, 160, 100)
    pointer('pointerdown', img, 2, 100, 100)
    pointer('pointermove', img, 2, 160, 100)
    pointer('pointerup', img, 2, 160, 100)
    expect(zoom.currentZoom()).toBe(1)
  })

  it('drops the transform when the preview closes with Escape', () => {
    const { img } = mountPreview()
    box(img, 0, 0, 300, 200)
    pointer('pointerdown', img, 1, 100, 100)
    pointer('pointerdown', img, 2, 200, 100)
    pointer('pointermove', img, 2, 300, 100)
    expect(img.style.transform).not.toBe('')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(img.style.transform).toBe('')
    expect(zoom.currentZoom()).toBe(1)
  })

  it('starts a different picture at 1x instead of inheriting the zoom', () => {
    const first = mountPreview()
    box(first.img, 0, 0, 300, 200)
    pointer('pointerdown', first.img, 1, 100, 100)
    pointer('pointerdown', first.img, 2, 200, 100)
    pointer('pointermove', first.img, 2, 300, 100)
    expect(zoom.currentZoom()).toBeGreaterThan(1)

    document.body.replaceChildren()
    const second = mountPreview()
    box(second.img, 0, 0, 300, 200)
    pointer('pointerdown', second.img, 3, 100, 100)
    expect(second.img.style.transform).toBe('')
    expect(zoom.currentZoom()).toBe(1)
  })

  it('leaves no transform behind after reset', () => {
    const { img } = mountPreview()
    box(img, 0, 0, 300, 200)
    pointer('pointerdown', img, 1, 100, 100)
    pointer('pointerdown', img, 2, 200, 100)
    pointer('pointermove', img, 2, 300, 100)
    zoom.reset()
    expect(img.style.transform).toBe('')
    expect(img.style.transformOrigin).toBe('')
  })
})
