/**
 * KeyboardBoundary (issue #57): Android 16 edge-to-edge WebViews do not
 * shrink the layout viewport when the soft keyboard opens (adjustResize
 * does not resize the WebView content; visualViewport shrinks but
 * innerHeight stays 758). The mobile frame (height: 100%) therefore extends
 * under the keyboard, and its scrollable content leaves a blank band below
 * the composer — swiping up past the input reveals empty black.
 *
 * Fix: while the IME inset is non-zero, pin the mobile frame's height to the
 * visualViewport height (the keyboard's top edge). The frame's overflow:
 * hidden then clips the blank band instead of letting it scroll into view.
 * Restored to 100% when the keyboard closes.
 *
 * The composer seat (position: sticky; bottom: 0) normally relies on
 * composer-insets.css.ts padding-bottom = --dsh-android-ime-bottom to lift
 * the input above the keyboard while the frame keeps its full height. Once
 * this class pins the frame to the keyboard top edge, that same padding
 * becomes redundant and inflates the seat past its sticky container (seat
 * height > scrollBody height makes the sticky bottom anchor inert and the
 * composer drifts to the top of the viewport). While pinned, the seat's
 * padding-bottom is therefore zeroed; it is restored on keyboard close.
 */
export class KeyboardBoundary {
  private frame: HTMLElement | null = null
  private seat: HTMLElement | null = null
  private media: MediaQueryList | null = null
  private lastIme = 0
  private lastVv = 0

  /** Watch visualViewport resize + the shell's IME inset variable. */
  attach(): void {
    window.visualViewport?.addEventListener('resize', this.onViewportChange)
    // jsdom's matchMedia stub returns a bare object: tolerate it (the
    // visualViewport resize still drives the pin).
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 640px)') : null
    this.media?.addEventListener?.('change', this.onViewportChange)
    this.onViewportChange()
  }

  /** Remove listeners and restore the frame and seat styles. */
  detach(): void {
    window.visualViewport?.removeEventListener('resize', this.onViewportChange)
    this.media?.removeEventListener?.('change', this.onViewportChange)
    this.restore()
  }

  private readonly onViewportChange = (): void => {
    const frame = document.querySelector<HTMLElement>('[data-mobile]')
    if (frame === null) return
    this.frame = frame
    const rootStyle = getComputedStyle(document.documentElement)
    const ime = Number.parseFloat(rootStyle.getPropertyValue('--dsh-android-ime-bottom')) || 0
    const vv = window.visualViewport
    const vvHeight = vv === null ? 0 : Math.round(vv.height)
    // Only react to real keyboard transitions (IME inset > 0); a resize with
    // no inset is a window resize and must keep the natural 100% height.
    if (ime > 0 && vvHeight > 0 && (ime !== this.lastIme || vvHeight !== this.lastVv)) {
      this.lastIme = ime
      this.lastVv = vvHeight
      frame.style.height = `${vvHeight}px`
      // Null out the seat's IME padding while the frame is pinned (see the
      // class comment); keep safe-area/system paddings intact.
      const seat = document.querySelector<HTMLElement>('[data-composer-seat]')
      if (seat !== null) {
        this.seat = seat
        seat.style.paddingBottom = '0px'
      }
    } else if (ime === 0 && (this.lastIme !== 0 || frame.style.height !== '')) {
      this.restore()
    }
  }

  /** Restore the natural frame height and seat padding. */
  private restore(): void {
    if (this.frame !== null) this.frame.style.height = ''
    this.frame = null
    if (this.seat !== null) this.seat.style.paddingBottom = ''
    this.seat = null
    this.lastIme = 0
    this.lastVv = 0
  }
}
