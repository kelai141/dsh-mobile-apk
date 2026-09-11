/**
 * EnterGuard: mobile-form Enter-key semantics.
 *
 * On the phone soft keyboard the Enter (newline) key fires a plain keydown
 * Enter — upstream InputBar treats it as submit (keyboard.submit), and there
 * is no Shift to fall back on. This guard, on the mobile form only
 * (viewport <= MOBILE_FORM_MAX_WIDTH), intercepts a plain Enter inside the
 * composer's editable at document capture phase — before React's root
 * listener — and turns it into a line break, leaving the send button as the
 * only send channel.
 *
 * The editable is upstream's Lexical contenteditable since 0.1.5 (the
 * pre-0.1.5 composer was a textarea), and Lexical's own line break is reached
 * through the Shift+Enter gesture: the composer keymap returns false for
 * shiftKey and lets @lexical/plain-text insert the break. The guard therefore
 * re-dispatches the swallowed Enter as Shift+Enter on the same element instead
 * of writing text itself. Dropping the textarea assumption is what kept this
 * guard alive across the 0.1.5 upgrade: a textarea-only check silently turned
 * every soft-keyboard Enter back into a submit (measured 2026-09-10 on MuMu,
 * WebView 110: composer innerText was empty after Enter and the message had
 * been sent).
 *
 * Guards that must stay untouched:
 * - IME composition (isComposing / keyCode 229): the candidate-confirm Enter.
 * - Open command/reference menu ([role=listbox]): Enter picks the highlighted item.
 * - Shift+Enter (external keyboards): upstream native newline.
 * - Desktop/wide viewport: upstream behavior unchanged.
 */
import { MOBILE_FORM_MAX_WIDTH } from './mobile/form-marker.ts'

/** The composer's own editable: upstream's Lexical host, or the pre-0.1.5 textarea. */
const COMPOSER_EDITABLE = '[contenteditable="true"], textarea'

export class EnterGuard {
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    // The composer card only: QueueDock and other Enter handlers are out of scope.
    const card = target.closest('[data-composer-card]')
    if (card === null) return
    const editable = target.closest(COMPOSER_EDITABLE)
    if (editable === null || !card.contains(editable)) return
    // Command/reference menu open: Enter selects the highlighted candidate.
    if (document.querySelector('[role="listbox"]') !== null) return
    if (window.innerWidth > MOBILE_FORM_MAX_WIDTH) return
    event.stopPropagation()
    event.preventDefault()
    if (editable instanceof HTMLTextAreaElement) {
      // Insert the newline through the native edit path so the machine's
      // onChange adopts it; failure degrades to "no newline" but never sends.
      try {
        document.execCommand('insertText', false, '\n')
      } catch {
        /* execCommand unavailable: the Enter is swallowed, nothing is sent */
      }
      return
    }
    try {
      editable.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
      }))
    } catch {
      /* no line break inserted: the Enter stays swallowed, so nothing is sent */
    }
  }

  attach(): void {
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
  }

  detach(): void {
    document.removeEventListener('keydown', this.onKeyDown, { capture: true })
  }
}
