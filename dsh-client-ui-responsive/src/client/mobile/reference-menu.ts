/**
 * Mobile reference-menu enhancer (apk #163).
 *
 * Upstream's `@` menu gives a directory row two verbs: the row body settles the pick (the folder
 * itself becomes an atomic reference and the menu closes) while only the ~14px trailing chevron
 * (or Tab) drills into it. That is fine with a mouse and keyboard; on a phone the chevron is a
 * poor target, so tapping a folder row referenced the folder and the user never reached the
 * files inside — reported as "the @ feature is unusable" (#150 / #144 / #163).
 *
 * The row-body behavior itself is fixed one layer down, in the engine tree: patch
 * `reference-drill-F6` makes the mobile form's directory rows settle into the folder. This
 * enhancer therefore owns only the multi-select chrome.
 *
 * This enhancer re-shapes the same menu for the mobile form:
 *
 * - every row gets a leading checkbox; checked rows form a multi-select set with a bottom
 *   "add N" action that inserts them all as references (driven through upstream's own pick so the
 *   atomic reference semantics stay upstream's);
 * - (row-body drilling is upstream's once the F6 engine patch is applied);
 * - clicking a file row's body keeps upstream behavior (settle the pick);
 * - clicks on the checkbox never reach upstream's mousedown pick.
 */
const ROW_SELECTOR = '[data-trigger-menu] [role="option"]'
const CHECK_ATTR = 'data-dsh-ref-check'
const BAR_ATTR = 'data-dsh-ref-bar'
const NAME_CLASS_HINT = 'itemName'
/** Gesture kinds one tap can arrive as; only the first of an interaction acts. */
const GESTURES = ['pointerdown', 'mousedown', 'click'] as const
/** Window that folds the gesture kinds of a single tap into one action. */
const ACTION_DEBOUNCE_MS = 400

/** One row this enhancer tracks: its label, whether it is a directory, and the live element. */
interface Row {
  label: string
  directory: boolean
}

/** Read a row's candidate label (upstream renders it in the name span; fall back to text). */
function rowLabel(row: HTMLElement): string {
  const name = row.querySelector('[class*="' + NAME_CLASS_HINT + '"]')
  return ((name?.textContent ?? row.textContent) || '').trim()
}


/** The composer's editable host (upstream Lexical root). */
function composerEditable(): HTMLElement | null {
  return document.querySelector('[data-composer-card] [contenteditable="true"], [data-composer-card] textarea')
}

/** Multi-select state plus the mobile-only row behavior for the reference menu. */
export class ReferenceMenuEnhancer {
  private readonly checked = new Set<string>()
  private observer: MutationObserver | null = null
  private lastClaim = 0
  private scheduled = false

  private readonly onGesture = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest<HTMLElement>(ROW_SELECTOR)
    if (row === null) return
    if (target.closest('[' + CHECK_ATTR + ']') === null) return
    // Own the gesture, and let only the first kind of one tap act: a tap arrives as
    // pointerdown + mousedown + click (measured on device), and acting on each toggled the
    // row three times. The claim itself is what keeps upstream's settle-pick away.
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
    if (this.claimOnce()) this.toggle(rowLabel(row))
  }

  private readonly onMenuClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element) || target.closest('[' + BAR_ATTR + ']') === null) return
    if (target.closest('[data-dsh-ref-add]') === null) return
    event.preventDefault()
    event.stopPropagation()
    void this.addSelected()
  }

  /**
   * True for the first gesture of one interaction. A tap arrives as pointerdown + mousedown +
   * click; acting on each inserted the same row three times (measured on device), so only the
   * first one acts while the rest are still claimed.
   */
  private claimOnce(): boolean {
    const now = Date.now()
    if (now - this.lastClaim < ACTION_DEBOUNCE_MS) return false
    this.lastClaim = now
    return true
  }

  attach(): void {
    // One gesture kind only: claiming pointerdown + preventDefault suppresses the compatibility
    // mouse events, while claiming both would run the row behavior twice (measured on device: a
    // single tap produced three folder references).
    for (const kind of GESTURES) document.addEventListener(kind, this.onGesture, true)
    document.addEventListener('click', this.onMenuClick, true)
    this.observer = new MutationObserver(() => { this.schedule() })
    this.observer.observe(document.body, { childList: true, subtree: true })
    this.schedule()
  }

  detach(): void {
    for (const kind of GESTURES) document.removeEventListener(kind, this.onGesture, true)
    document.removeEventListener('click', this.onMenuClick, true)
    this.observer?.disconnect()
    this.observer = null
    this.checked.clear()
    document.querySelectorAll('[' + BAR_ATTR + ']').forEach((bar) => { bar.remove() })
  }

  /** Coalesce DOM churn into one enhance pass per frame. */
  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.enhance()
    })
  }

  /** Add the leading checkbox to every row that lacks one, then refresh the action bar. */
  private enhance(): void {
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (row.querySelector('[' + CHECK_ATTR + ']') !== null) continue
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.setAttribute(CHECK_ATTR, rowLabel(row))
      box.setAttribute('aria-label', rowLabel(row))
      box.style.cssText = 'flex:none;width:18px;height:18px;margin:0 8px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)'
      row.insertBefore(box, row.firstChild)
    }
    this.renderBar()
  }

  /** Toggle one label in the multi-select set. */
  private toggle(label: string): void {
    if (this.checked.has(label)) this.checked.delete(label)
    else this.checked.add(label)
    this.renderBar()
  }

  /** Reflect the current set: a bottom action inside the open menu. */
  private renderBar(): void {
    const menu = document.querySelector('[data-trigger-menu]')
    const existing = document.querySelector<HTMLElement>('[' + BAR_ATTR + ']')
    if (menu === null || this.checked.size === 0) {
      existing?.remove()
      return
    }
    const bar = existing ?? document.createElement('div')
    bar.setAttribute(BAR_ATTR, '')
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;border-top:1px solid var(--dsw-alias-separator,#e5e5e5)'
    bar.innerHTML = ''
    const count = document.createElement('span')
    count.textContent = '已选 ' + String(this.checked.size) + ' 项'
    count.style.cssText = 'font-size:13px;opacity:.8'
    const add = document.createElement('button')
    add.type = 'button'
    add.setAttribute('data-dsh-ref-add', '')
    add.textContent = '添加'
    add.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font-size:13px'
    bar.append(count, add)
    if (existing === null) menu.appendChild(bar)
  }

  /** Insert every checked candidate through upstream's settle-pick, one reference at a time. */
  private async addSelected(): Promise<void> {
    const labels = [...this.checked]
    this.checked.clear()
    document.querySelector<HTMLElement>('[' + BAR_ATTR + ']')?.remove()
    for (const label of labels) {
      if (!(await this.pickByLabel(label))) return
    }
  }

  /**
   * Drive one upstream pick for `label`: focus the composer, (re)open the menu with `@` when it
   * closed, then settle the matching row. Upstream owns the reference it inserts; a row that never
   * appears ends the sequence rather than inventing text upstream would not have produced.
   */
  private async pickByLabel(label: string): Promise<boolean> {
    const editable = composerEditable()
    if (editable === null) return false
    editable.focus()
    if (document.querySelector('[data-trigger-menu]') === null) {
      document.execCommand('insertText', false, '@')
      if (!(await this.waitFor(() => this.findRow(label) !== null))) return false
    }
    const row = this.findRow(label)
    if (row === null) return false
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await this.waitFor(() => document.querySelector('[data-trigger-menu]') === null || this.findRow(label) === null, 600)
    return true
  }

  /** The row whose candidate label matches, ignoring the checkbox we injected. */
  private findRow(label: string): HTMLElement | null {
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (rowLabel(row) === label) return row
    }
    return null
  }

  /** Poll one predicate for up to `timeout` ms (menu open/close is not observable otherwise). */
  private waitFor(predicate: () => boolean, timeout = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = (): void => {
        if (predicate()) { resolve(true); return }
        if (Date.now() - started > timeout) { resolve(false); return }
        setTimeout(tick, 60)
      }
      tick()
    })
  }
}
