/**
 * Image-lightbox zoom: the picture zooms, the screen does not.
 *
 * Why this module exists. The upstream preview (ui-primitives `ImageLightbox`) draws a
 * backdrop > stage > mask + `<img>` + close button and carries **no** gesture code at all.
 * The only thing a pinch used to do on a phone was Chromium's page-level zoom: the visual
 * viewport scaled (`visualViewport.scale` 1 → 5, width 450 → 90) and the whole UI —
 * header, conversation, composer — grew with it, which is exactly what the user reported
 * ("放大图片会放大整个屏幕"). The shell now locks page zoom off in
 * `WebViewShim.applyBaseline` (supportZoom / builtInZoomControls / displayZoomControls),
 * so the gesture has to be served here instead, and it has to be served by moving the
 * **image alone**.
 *
 * The contract this module keeps:
 * - only the lightbox `<img>` gets a transform; the backdrop, the stage, the mask and the
 *   close control keep their geometry (that is the user-visible promise: surroundings do
 *   not move);
 * - `visualViewport.scale` stays 1 and `<html>`/`<body>` are never touched, so no
 *   page-level or ancestor-level scaling can sneak back in;
 * - the gesture belongs to the image: pinch and double-tap only work when the pointer is
 *   on the picture. The mask stays the documented close path, so a drag that starts there
 *   must not become a zoom;
 * - every session ends: closing the preview, a second image, or the element going away
 *   resets the transform, so no zoom is carried into the next message.
 *
 * Input is `pointer` events, not `touch`: pointer events carry a stable `pointerId`
 * per contact, they fire for mouse and pen too, and `setPointerCapture` keeps a pinch
 * tracking even when one finger slides off the picture. Touch events would need the same
 * bookkeeping by hand and would break the two-finger case on the first lifted finger.
 *
 * The picture is resolved structurally, never by class name (upstream CSS-module names are
 * hashed): it is the `<img>` inside the `[role="dialog"][aria-modal="true"]` preview. Both
 * shipped shapes are covered — a flat backdrop (mask + img + close as siblings, measured on
 * the 0.2.1 engine) and a staged one (backdrop > stage > mask + img + close, measured on the
 * 0.14.10 build) — so a layout change upstream cannot silently switch the gesture off.
 */

/** Every modal surface; the image preview is the one that actually draws a picture. */
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'
/** Zoom bounds. 1 = fitted to the stage; the ceiling leaves room to read detail on a phone. */
const MIN_ZOOM = 1
const MAX_ZOOM = 5
/** One double-tap toggles between fitted and this reading scale. */
const DOUBLE_TAP_ZOOM = 2.5
/** A second tap must land inside this window to count as a double tap. */
const DOUBLE_TAP_MS = 300
/** Two taps further apart than this (CSS px) are not the same double tap. */
const DOUBLE_TAP_SLOP = 30
/** A drag longer than this (CSS px) cancels the pending double-tap: it was a pinch or a pan. */
const MOVE_SLOP = 10
/** Attribute the stylesheet hooks (touch-action: none on the picture). */
export const ZOOM_TARGET_ATTR = 'data-dsh-lightbox-zoom'
/** Attribute marking the preview surface itself, so a pinch on the mask cannot reach the page. */
export const ZOOM_SURFACE_ATTR = 'data-dsh-lightbox-surface'

/**
 * The picture a preview dialog owns, or null when the dialog is not an image preview.
 *
 * A direct-child image wins (flat shape); otherwise the first descendant image is taken
 * (staged shape). Mask and close control are plain elements/icons, so neither can shadow it.
 * @param dialog - a `[role=dialog][aria-modal]` element.
 * @returns the previewable image, or null.
 */
export function lightboxImage(dialog: Element): HTMLElement | null {
  const direct = dialog.querySelector(':scope > img')
  if (direct instanceof HTMLElement) return direct
  const nested = dialog.querySelector('img')
  return nested instanceof HTMLElement ? nested : null
}

/** One live pointer on the picture. */
interface Contact {
  /** Where this finger started, in CSS px (client coordinates). */
  startX: number
  startY: number
  /** Where it was on the previous move. */
  lastX: number
  lastY: number
}

/**
 * Owns the zoom transform of the preview image.
 *
 * One instance lives for the whole plugin lifetime and follows the current preview: the
 * image is re-resolved on every pointer-down, so a dialog that unmounts and a second image
 * that opens are both handled without remounting this module.
 */
export class LightboxZoom {
  /** Scale currently applied to the live image. */
  private zoom = 1
  /** Centre of the zoom, as a fraction of the image box (0.5/0.5 = the picture's middle). */
  private originX = 0.5
  private originY = 0.5
  /** The image carrying the transform, so a replaced dialog cannot keep a stale one. */
  private target: HTMLElement | null = null
  /** Live contacts, keyed by pointerId. */
  private readonly contacts = new Map<number, Contact>()
  /** Pinch baseline, captured when the second finger lands. */
  private pinchStartDistance = 0
  private pinchStartZoom = 1
  /** Last tap, for the double-tap toggle. */
  private lastTapAt = 0
  private lastTapX = 0
  private lastTapY = 0
  /** A pending double-tap is cancelled by any real movement. */
  private moved = false
  private attached = false

  /** Start listening. Idempotent, so a re-attach cannot double-count pointers. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    document.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: false })
    document.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: false })
    document.addEventListener('pointerup', this.onPointerUp, { capture: true })
    document.addEventListener('pointercancel', this.onPointerUp, { capture: true })
    // Capture phase: the preview's own Escape/close handling stays untouched, this only
    // observes that the surface went away and drops the transform with it.
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
  }

  /** Stop listening and drop every trace of the gesture. */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('pointerup', this.onPointerUp, true)
    document.removeEventListener('pointercancel', this.onPointerUp, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.reset()
  }

  /**
   * Drop the transform and the gesture state.
   *
   * Called on every close path (the preview's own controls, Escape, the image leaving the
   * document) so a zoom can never be inherited by the next message's picture.
   */
  reset(): void {
    this.contacts.clear()
    this.pinchStartDistance = 0
    this.pinchStartZoom = 1
    this.moved = false
    this.lastTapAt = 0
    this.zoom = 1
    this.originX = 0.5
    this.originY = 0.5
    this.paint()
    this.target = null
  }

  /** The scale the live image currently carries (device-side observability). */
  currentZoom(): number {
    return this.zoom
  }

  /** Write the current scale onto the image, or clear it when nothing is zoomed. */
  private paint(): void {
    const image = this.target
    if (image === null) return
    if (this.zoom === 1) {
      image.style.removeProperty('transform')
      image.style.removeProperty('transform-origin')
      return
    }
    // transform-origin stays on the picture, so scaling never moves the stage.
    image.style.transformOrigin = (this.originX * 100).toFixed(2) + '% ' + (this.originY * 100).toFixed(2) + '%'
    image.style.transform = 'scale(' + this.zoom.toFixed(4) + ')'
  }

  /** Resolve the picture under a pointer and adopt it as the zoom target. */
  private targetFor(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null
    const dialog = node.closest(DIALOG_SELECTOR)
    if (dialog === null) return null
    const image = lightboxImage(dialog)
    if (image === null) return null
    if (!image.contains(node)) return null
    if (this.target !== null && this.target !== image) this.reset()
    this.target = image
    return image
  }

  /** Euclidean distance between the two live contacts. */
  private spread(): number {
    const [a, b] = [...this.contacts.values()]
    if (a === undefined || b === undefined) return 0
    return Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY)
  }

  /** Re-centre the zoom on the point midway between the two fingers. */
  private pinchOrigin(): void {
    const image = this.target
    if (image === null) return
    const [a, b] = [...this.contacts.values()]
    if (a === undefined || b === undefined) return
    const box = image.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    const x = (a.lastX + b.lastX) / 2
    const y = (a.lastY + b.lastY) / 2
    this.originX = Math.min(1, Math.max(0, (x - box.left) / box.width))
    this.originY = Math.min(1, Math.max(0, (y - box.top) / box.height))
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const image = this.targetFor(event.target)
    if (image === null) return
    // The picture owns the gesture from here: no page pan, no native drag, no text select.
    event.preventDefault()
    this.contacts.set(event.pointerId, {
      startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
    })
    if (this.contacts.size === 2) {
      this.pinchStartDistance = this.spread()
      this.pinchStartZoom = this.zoom
      this.pinchOrigin()
      this.moved = true
      this.lastTapAt = 0
    } else if (this.contacts.size === 1) {
      this.moved = false
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const contact = this.contacts.get(event.pointerId)
    if (contact === undefined) return
    contact.lastX = event.clientX
    contact.lastY = event.clientY
    if (Math.hypot(event.clientX - contact.startX, event.clientY - contact.startY) > MOVE_SLOP) this.moved = true

    if (this.contacts.size >= 2) {
      event.preventDefault()
      const start = this.pinchStartDistance
      if (start <= 0) return
      const ratio = this.spread() / start
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.pinchStartZoom * ratio))
      this.zoom = next
      this.pinchOrigin()
      this.paint()
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const contact = this.contacts.get(event.pointerId)
    if (contact === undefined) return
    this.contacts.delete(event.pointerId)
    if (this.contacts.size > 0) {
      // Lifting one finger ends the pinch; the survivor must not keep dragging the scale.
      this.pinchStartDistance = 0
      return
    }
    // Last finger up: a tap with no movement is a double-tap candidate.
    if (!this.moved && Math.abs(event.clientX - contact.startX) <= MOVE_SLOP) {
      const now = event.timeStamp
      const isDouble = now - this.lastTapAt <= DOUBLE_TAP_MS
        && Math.abs(event.clientX - this.lastTapX) <= DOUBLE_TAP_SLOP
        && Math.abs(event.clientY - this.lastTapY) <= DOUBLE_TAP_SLOP
      if (isDouble) {
        this.lastTapAt = 0
        this.toggle()
      } else {
        this.lastTapAt = now
        this.lastTapX = event.clientX
        this.lastTapY = event.clientY
      }
    }
  }

  /** Double tap: fitted <-> reading scale, centred on the last tap. */
  private toggle(): void {
    const image = this.target
    if (image === null) return
    if (this.zoom > 1) {
      this.zoom = 1
      this.originX = 0.5
      this.originY = 0.5
    } else {
      const box = image.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) {
        this.originX = Math.min(1, Math.max(0, (this.lastTapX - box.left) / box.width))
        this.originY = Math.min(1, Math.max(0, (this.lastTapY - box.top) / box.height))
      }
      this.zoom = DOUBLE_TAP_ZOOM
    }
    this.paint()
  }

  /** Escape closes the preview; the transform must not outlive it. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.target !== null) this.reset()
  }
}
