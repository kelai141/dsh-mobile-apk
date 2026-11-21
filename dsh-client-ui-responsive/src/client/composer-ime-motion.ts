const NATIVE_TARGET = '--dsh-android-page-ime-target'
const NATIVE_DURATION = '--dsh-android-page-ime-duration'
const LAYOUT_OVERLAP = '--dsh-page-ime-layout'
const CLIP_ATTR = 'data-dsh-ime-motion'
const INSET_EVENT = 'dsh-page-ime-change'

/** Animate the visible conversation surface without laying out the frame on every tick. */
export class ComposerImeMotion {
  private target: number | undefined
  private layout = 0
  private flight: { animation: Animation; clip: Element } | null = null

  attach(): () => void {
    window.addEventListener(INSET_EVENT, this.sync)
    window.addEventListener('resize', this.onResize)
    this.sync()
    return () => {
      window.removeEventListener(INSET_EVENT, this.sync)
      window.removeEventListener('resize', this.onResize)
      this.clearMotion()
      document.documentElement.style.removeProperty(LAYOUT_OVERLAP)
    }
  }

  private setLayout(overlap: number): void {
    this.layout = overlap
    document.documentElement.style.setProperty(LAYOUT_OVERLAP, `${overlap}px`)
  }

  private clearMotion(): void {
    const flight = this.flight
    this.flight = null
    if (!flight) return
    flight.animation.cancel()
    flight.clip.removeAttribute(CLIP_ATTR)
  }

  private readonly onResize = (): void => {
    this.clearMotion()
    if (this.target !== undefined) this.setLayout(this.target)
  }

  private readonly sync = (): void => {
    const style = document.documentElement.style
    const target = Number.parseFloat(style.getPropertyValue(NATIVE_TARGET))
    if (!Number.isFinite(target) || target === this.target) return
    const previous = this.target
    this.target = target
    const duration = Number.parseFloat(style.getPropertyValue(NATIVE_DURATION))
    const scroll = document.querySelector<HTMLElement>('[data-conversation-content] [data-conversation-scroll]')
    const clip = scroll?.closest('[data-conversation-content]')
    const seat = scroll?.querySelector<HTMLElement>('[data-composer-seat]')
    if (previous === undefined || !(duration > 0) || !clip || !scroll || !seat?.getClientRects().length ||
        typeof seat.animate !== 'function' || document.hidden ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.clearMotion()
      this.setLayout(target)
      return
    }

    // Use the taller layout for both directions so the translation never exposes an empty strip above the messages.
    const hero = clip.getAttribute('data-content-phase') === 'hero'
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4
    const layer = hero || atBottom ? scroll : seat
    const measureStart = this.flight !== null || target < this.layout
    const before = measureStart ? seat.getBoundingClientRect().top : 0
    this.clearMotion()
    if (target < this.layout) this.setLayout(target)
    const from = measureStart ? before - seat.getBoundingClientRect().top : 0
    const to = (this.layout - target) * (hero ? 0.5 : 1)
    if (Math.abs(to - from) < 1) {
      this.setLayout(target)
      return
    }

    clip.setAttribute(CLIP_ATTR, '')
    const animation = layer.animate([
      { transform: `translate3d(0, ${from}px, 0)` },
      { transform: `translate3d(0, ${to}px, 0)` },
    ], { duration, fill: 'both', easing: target > previous ? 'cubic-bezier(.2,.7,.25,1)' : 'linear' })
    this.flight = { animation, clip }
    animation.addEventListener('finish', () => {
      if (this.flight?.animation !== animation) return
      this.setLayout(target)
      this.clearMotion()
    }, { once: true })
  }
}
