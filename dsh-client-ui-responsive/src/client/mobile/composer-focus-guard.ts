const EDITOR = [
  '[data-composer-card] [contenteditable]:not([contenteditable="false"])',
  '[data-composer-card] textarea',
].join(', ')
const FOCUS_WINDOW_MS = 900

/** Suppress focus restored by a drawer action until the user deliberately returns to the editor. */
export class ComposerFocusGuard {
  private timer: number | null = null

  constructor(private readonly doc: Document = document) {}

  arm(): void {
    this.clear()
    this.doc.addEventListener('focusin', this.onFocusIn, true)
    this.doc.addEventListener('pointerdown', this.onPointerDown, true)
    this.doc.addEventListener('keydown', this.clear, true)
    this.timer = this.doc.defaultView!.setTimeout(this.clear, FOCUS_WINDOW_MS)
  }

  blurActiveEditor(): void {
    const active = this.doc.activeElement
    if (active instanceof HTMLElement && active.matches(EDITOR)) active.blur()
  }

  readonly clear = (): void => {
    if (this.timer === null) return
    this.doc.defaultView!.clearTimeout(this.timer)
    this.timer = null
    this.doc.removeEventListener('focusin', this.onFocusIn, true)
    this.doc.removeEventListener('pointerdown', this.onPointerDown, true)
    this.doc.removeEventListener('keydown', this.clear, true)
  }

  private readonly onFocusIn = (event: FocusEvent): void => {
    const editor = event.target instanceof Element ? event.target.closest(EDITOR) : null
    if (editor instanceof HTMLElement) editor.blur()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Element && event.target.closest(EDITOR)) this.clear()
  }
}
