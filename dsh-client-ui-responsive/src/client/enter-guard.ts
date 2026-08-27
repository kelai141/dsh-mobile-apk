/**
 * EnterGuard: mobile-form Enter-key semantics.
 *
 * On the phone soft keyboard the Enter (newline) key fires a plain keydown
 * Enter — upstream InputBar treats it as submit (keyboard.submit), and there
 * is no Shift to fall back on. This guard, on the mobile form only
 * (viewport < MOBILE_BREAKPOINT), intercepts a plain Enter inside the
 * composer textarea at document capture phase — before React's root listener
 * — and converts it into a newline insertion, leaving the send button as the
 * only send channel.
 *
 * Guards that must stay untouched:
 * - IME composition (isComposing / keyCode 229): the candidate-confirm Enter.
 * - Open command menu ([role=listbox]): Enter picks the highlighted item.
 * - Shift+Enter (external keyboards): upstream native newline.
 * - Desktop/wide viewport: upstream behavior unchanged.
 */
import { MOBILE_BREAKPOINT } from './columns.ts'

export class EnterGuard {
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    // The composer textarea only: QueueDock and other Enter handlers are out of scope.
    if (target.closest('[data-composer-card] textarea') === null) return
    // Command menu open: Enter selects the highlighted candidate.
    if (document.querySelector('[role="listbox"]') !== null) return
    if (window.innerWidth >= MOBILE_BREAKPOINT) return
    event.stopPropagation()
    event.preventDefault()
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement && active === target) {
      // Insert the newline through the native edit path so the machine's
      // onChange adopts it; failure degrades to "no newline" but never sends.
      try {
        document.execCommand('insertText', false, '\n')
      } catch {
        /* execCommand unavailable: the Enter is swallowed, nothing is sent */
      }
    }
  }

  attach(): void {
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
  }

  detach(): void {
    document.removeEventListener('keydown', this.onKeyDown, { capture: true })
  }
}
