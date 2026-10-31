/**
 * EnterGuard: mobile-form Enter-key semantics.
 *
 * On a touch keyboard there is no Shift: its Enter key fires a plain keydown
 * Enter — upstream InputBar treats it as submit (keyboard.submit) — and no
 * gesture on that keyboard can produce the Shift+Enter that upstream's keymap
 * maps to a line break. This guard intercepts a plain Enter inside the
 * composer's editable at document capture phase — before React's root
 * listener — and turns it into a line break, leaving the send button as the
 * only send channel.
 *
 * The judgment is the input device, not the viewport width (#1040). A tablet,
 * a phone in landscape, or an unfolded foldable is wider than every phone
 * breakpoint and still has no Shift on its soft keyboard; keying on width left
 * exactly those frames with Enter = send and no newline channel. What actually
 * causes the missing modifier is the primary pointer being a touch screen, so
 * the guard asks `(pointer: coarse)`: matches === true means a coarse pointer,
 * the guard applies however wide the frame is. A fine primary pointer
 * (desktop, or a hybrid driven by mouse/trackpad) keeps upstream behavior
 * untouched, at any width.
 *
 * The pointer answer is sampled once at attach and re-sampled on every `change`
 * of that MQL, so a device that switches to a fine pointer mid-session (a
 * Bluetooth mouse pairing, a DeX-style desktop mode) stops being intercepted
 * without a reload. Unlike width, a coarse pointer also does not flip on
 * resize or rotation, so the decision stays put while the frame is resized.
 *
 * Fallback: `window.matchMedia` is absent in jsdom and in old WebViews
 * (measured: `typeof window.matchMedia === 'undefined'` under jsdom 24). The
 * pointer question cannot be asked there at all, so the guard falls back to the
 * one layout fact it does have — the mobile form breakpoint
 * (`window.innerWidth <= MOBILE_FORM_MAX_WIDTH`), which is the pre-#1040
 * behavior. The fallback is only the unable-to-ask path; it is not a second
 * criterion layered on top of the pointer one.
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
 * - Open command/reference menu ([role=listbox] inside the composer card):
 *   Enter picks the highlighted item. The lookup is scoped to that card: a
 *   listbox anywhere else in the document (an upstream "+" menu that never
 *   closed, a dropdown on a settings page) has nothing to do with this Enter,
 *   and asking the whole document used to disable the guard for every card
 *   while such a leftover existed (#1041).
 * - Shift+Enter (external keyboards): upstream native newline.
 * - Fine primary pointer (desktop): upstream behavior unchanged.
 */
import { MOBILE_FORM_MAX_WIDTH } from './mobile/form-marker.ts'

/** The composer's own editable: upstream's Lexical host, or the pre-0.1.5 textarea. */
const COMPOSER_EDITABLE = '[contenteditable="true"], textarea'

/** 判据是输入设备而不是视口：粗指针 = 触摸屏，软键盘没有 Shift 可退（#1040）。 */
const COARSE_POINTER_QUERY = '(pointer: coarse)'

/**
 * 中文 IME 的候选确认键常落在 compositionend **之后**几毫秒（apk #182-3）。
 * 那段时间里 `isComposing=false` 且 keyCode 不是 229，只看这两条会把「确认候选」误判成
 * 「用户按了换行」→ 被改发 Shift+Enter，多插一个换行。上游 keymap 用 `recentlyComposing`
 * 补这一档，这里对齐同样的宽限窗。
 */
const COMPOSITION_GRACE_MS = 10

export class EnterGuard {
  private lastCompositionEndAt = 0

  /** 触屏 MQL；matchMedia 不可用（jsdom / 老 WebView）时为 null，判据回落到视口宽度。 */
  private pointer: MediaQueryList | null = null

  /** 最近一次采样的粗指针结论：attach 时采一次，之后每次 change 重采。 */
  private coarsePointer = false

  private readonly onPointerChange = (): void => {
    this.samplePointer()
  }

  private samplePointer(): void {
    this.coarsePointer = this.pointer?.matches === true
  }

  /**
   * 判据：触屏优先（#1040）；只有问不到指针的兜底路径才用移动表单的宽度闸。
   */
  private guardApplies(): boolean {
    if (this.pointer === null) return window.innerWidth <= MOBILE_FORM_MAX_WIDTH
    return this.coarsePointer
  }

  private readonly onCompositionEnd = (): void => {
    this.lastCompositionEndAt = Date.now()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    // 组合态第三判据：刚结束组合的宽限窗内，Enter 交还上游处理（候选确认）。
    if (Date.now() - this.lastCompositionEndAt <= COMPOSITION_GRACE_MS) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    // The composer card only: QueueDock and other Enter handlers are out of scope.
    const card = target.closest('[data-composer-card]')
    if (card === null) return
    const editable = target.closest(COMPOSER_EDITABLE)
    if (editable === null || !card.contains(editable)) return
    // Command/reference menu open in this card: Enter selects the highlighted candidate.
    // Scoped to the card on purpose: a listbox elsewhere in the document is not a menu over
    // this Enter, and a document-wide lookup let one leftover disable the guard everywhere (#1041).
    if (card.querySelector('[role="listbox"]') !== null) return
    if (!this.guardApplies()) return
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
    // The pointer question; null when the kernel has no matchMedia at all (jsdom, old WebViews).
    this.pointer = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE_POINTER_QUERY) : null
    // Old WebViews expose addListener/removeListener only: the optional call keeps attach safe there.
    this.pointer?.addEventListener?.('change', this.onPointerChange)
    this.samplePointer()
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
    document.addEventListener('compositionend', this.onCompositionEnd, { capture: true })
  }

  detach(): void {
    this.pointer?.removeEventListener?.('change', this.onPointerChange)
    this.pointer = null
    document.removeEventListener('keydown', this.onKeyDown, { capture: true })
    document.removeEventListener('compositionend', this.onCompositionEnd, { capture: true })
  }
}
