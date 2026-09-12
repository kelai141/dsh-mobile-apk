/**
 * KeyboardBoundary (issue #57): Android 16 edge-to-edge WebViews do not
 * shrink the layout viewport when the soft keyboard opens (adjustResize
 * does not resize the WebView content; visualViewport shrinks but
 * innerHeight stays 758). The frame (height: 100%, upstream ui-layout's root
 * grid) therefore extends under the keyboard, and its scrollable content leaves
 * a blank band below the composer — swiping up past the input reveals empty
 * black.
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
  /** 收敛代次（#197 机制②）：新事件打断旧的复算链，避免过期复算覆盖新状态。 */
  private settleGeneration = 0
  /** 延迟复算的定时器句柄（detach 时清掉；jsdom 测试结束后残留回调会报错）。 */
  private settleTimer: number | null = null
  /** 已卸载标记：卸载后任何延迟回调都必须直接返回（宿主可能已销毁 window/document）。 */
  private detached = false

  /** Watch visualViewport resize + the shell's IME inset variable. */
  attach(): void {
    this.detached = false
    window.visualViewport?.addEventListener('resize', this.onViewportChange)
    // jsdom's matchMedia stub returns a bare object: tolerate it (the
    // visualViewport resize still drives the pin).
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null
    this.media?.addEventListener?.('change', this.onViewportChange)
    this.onViewportChange()
  }

  /** Remove listeners and restore the frame and seat styles. */
  detach(): void {
    this.detached = true
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    window.visualViewport?.removeEventListener('resize', this.onViewportChange)
    this.media?.removeEventListener?.('change', this.onViewportChange)
    this.restore()
  }

  private readonly onViewportChange = (): void => {
    const frame = document.querySelector<HTMLElement>('[data-dsh-frame]')
    if (frame === null) return
    this.frame = frame
    this.apply(frame)
    // #197 机制②：键盘动画中途的 resize 会把 frame 高度钉在一个**偏小**的中间值
    // （生产日志抓到 frameH=189 while vvH=495），若随后没有新事件就永久停在半高。
    // 这里补两次复算把中间态收敛掉（rAF 抓动画尾帧，260ms 抓内核最终布局）。
    // 两处都带 detached 守卫与 try/catch：宿主（含 jsdom 测试）可能在回调前卸载 window。
    const generation = ++this.settleGeneration
    const settle = (): void => {
      if (this.detached || generation !== this.settleGeneration) return
      try {
        this.apply(frame)
      } catch {
        // 宿主已销毁（测试卸载/页面切换）：收敛复算是尽力而为的补偿，失败不该冒泡。
      }
    }
    requestAnimationFrame(settle)
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null
      settle()
    }, 260)
  }

  /** 按当前 IME inset 与可视视口高度决定钉住还是还原（可重复调用，幂等）。 */
  private apply(frame: HTMLElement): void {
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
