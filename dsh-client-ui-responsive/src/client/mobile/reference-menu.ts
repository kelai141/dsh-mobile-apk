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
 * - clicking a file row's body keeps upstream behavior (settle the pick);
 * - clicks on the checkbox never reach upstream's mousedown pick.
 *
 * 0.13.8 真机迭代（两轮反馈）：
 * - 第一轮：勾选态不实时同步（`preventDefault()` 吃掉原生 checkbox 翻转后没回写 DOM）、
 *   确认按钮白底白字（主题 token `--dsw-alias-brand-primary` 在深色下近白 + 上游 button 默认样式
 *   盖过注入样式表）。
 * - 第二轮（本版重做）：**用标签字符串当视觉状态的键是错的**——上游一重渲染行标签就可能与插入时
 *   不一致，于是出现「内部集合已勾选、方框仍显示未勾选」（用户实测：底部已显示"已选 1 项"而方框空）。
 *   现在状态**挂在行元素上**（`data-dsh-ref-on`），视觉完全由 CSS 从该属性派生，中间没有 JS 同步
 *   步骤；行元素被上游换掉时 `enhance()` 按标签把状态补回新元素。
 * - 同时按原生行样式重画勾选框：不再是浏览器默认的 input 方块，而是主题化圆角方框
 *   （未选 = 描边；选中 = 品牌蓝底 + 白勾），垂直居中、与行内图标同列。
 */
const ROW_SELECTOR = '[data-trigger-menu] [role="option"]'
const CHECK_ATTR = 'data-dsh-ref-check'
/** 选中标记（**视觉状态的唯一来源**：属性是状态，样式是后果，由 CSS 消费）。 */
const ON_ATTR = 'data-dsh-ref-on'
const BAR_ATTR = 'data-dsh-ref-bar'
const NAME_CLASS_HINT = 'itemName'
/** Gesture kinds one tap can arrive as; only the first of an interaction acts. */
const GESTURES = ['pointerdown', 'mousedown', 'click'] as const
/** Window that folds the gesture kinds of a single tap into one action. */
const ACTION_DEBOUNCE_MS = 400
/** 品牌蓝（勾选框与按钮共用）。**不取 `--dsw-alias-brand-primary`**：该 token 在深色主题下实测
 *  解析为 rgb(249,250,251)（近白），当底色配白字就是「白底白字不可见」。 */
const BRAND = '#4d6bfe'

/**
 * 勾选框与底部条样式。
 *
 * 两点设计决定：
 * 1. 勾选框用 `<span>` + CSS 画——原生 `<input type=checkbox>` 在深色主题里是浏览器默认方块，
 *    与上游行样式不融（用户反馈「和原生 ui 融合得太差」）；
 * 2. 选中态由 `[data-dsh-ref-on]` 属性派生，没有任何 JS 视觉同步步骤，因此不可能出现
 *    「集合已选中而方框未勾」的失配。
 * 底部条的关键样式仍在 JS 里内联 `!important`（上游 button 默认样式会盖过注入表）。
 */
export const REFERENCE_BAR_CSS: string = `
[data-dsh-ref-check] {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0 10px 0 2px;
  align-self: center;
  border-radius: 5px;
  border: 1.5px solid #8b909a;
  background: transparent;
  box-sizing: border-box;
  position: relative;
  transition: background-color .12s ease, border-color .12s ease;
}
[data-dsh-ref-on] [data-dsh-ref-check] {
  background: #4d6bfe;
  border-color: #4d6bfe;
}
[data-dsh-ref-on] [data-dsh-ref-check]::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 1.5px;
  width: 4px;
  height: 8px;
  border: solid #ffffff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
[data-dsh-ref-bar] {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e5e5);
  background: var(--dsw-alias-bg-l1, #ffffff);
}
[data-dsh-ref-bar-count] {
  font-size: 13px;
  color: var(--dsw-alias-text-l2, #5f6368);
}
[data-dsh-ref-add] {
  padding: 6px 14px;
  border-radius: 8px;
  border: none;
  background: #4d6bfe;
  color: #ffffff;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}
[data-dsh-ref-add]:active { filter: brightness(0.92); }
@media (prefers-color-scheme: dark) {
  [data-dsh-ref-check] { border-color: var(--dsw-alias-border-l2, #6b7075); }
  [data-dsh-ref-bar] {
    border-top-color: var(--dsw-alias-border-l1, #2a2b30);
    background: var(--dsw-alias-bg-l1, #17181c);
  }
  [data-dsh-ref-bar-count] { color: var(--dsw-alias-text-l2, #9aa0a6); }
}
`

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
  /** 标签集合（仅用于最终 pick；视觉状态不依赖它，见文件头）。 */
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
    if (this.claimOnce()) this.toggle(row)
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

  /**
   * Ensure every row carries a checkbox, re-apply the checked mark for rows upstream re-rendered
   * (state lives on the element, so a fresh element needs the mark back), then refresh the bar.
   */
  private enhance(): void {
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      let box = row.querySelector<HTMLElement>('[' + CHECK_ATTR + ']')
      if (box === null) {
        box = document.createElement('span')
        box.setAttribute(CHECK_ATTR, '')
        box.setAttribute('role', 'checkbox')
        box.setAttribute('aria-label', rowLabel(row))
        row.insertBefore(box, row.firstChild)
      }
      const on = this.checked.has(rowLabel(row))
      if (on) row.setAttribute(ON_ATTR, '')
      else row.removeAttribute(ON_ATTR)
      box.setAttribute('aria-checked', on ? 'true' : 'false')
    }
    this.renderBar()
  }

  /** Toggle one row：状态直接落在行元素上，随后由 CSS 呈现（无二次同步步骤）。 */
  private toggle(row: HTMLElement): void {
    const label = rowLabel(row)
    const on = !row.hasAttribute(ON_ATTR)
    if (on) {
      row.setAttribute(ON_ATTR, '')
      this.checked.add(label)
    } else {
      row.removeAttribute(ON_ATTR)
      this.checked.delete(label)
    }
    row.querySelector<HTMLElement>('[' + CHECK_ATTR + ']')
      ?.setAttribute('aria-checked', on ? 'true' : 'false')
    this.renderBar()
  }

  /**
   * 底部条的关键样式内联写入：`style.setProperty(..., 'important')` 的优先级高于任何样式表规则
   * （含上游对 `button` 的默认样式——真机实测过一次「白底白字」正是这个原因）。
   * 颜色不取 `--dsw-alias-brand-primary`（深色下近白），用显式品牌蓝。
   */
  private applyBarStyles(bar: HTMLElement, count: HTMLElement, add: HTMLElement): void {
    const set = (el: HTMLElement, prop: string, value: string): void => {
      el.style.setProperty(prop, value, 'important')
    }
    const dark = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches
    set(bar, 'display', 'flex')
    set(bar, 'gap', '8px')
    set(bar, 'align-items', 'center')
    set(bar, 'justify-content', 'space-between')
    set(bar, 'padding', '8px 12px')
    set(bar, 'border-top', '1px solid var(--dsw-alias-border-l1, ' + (dark ? '#2a2b30' : '#e5e5e5') + ')')
    set(bar, 'background', 'var(--dsw-alias-bg-l1, ' + (dark ? '#17181c' : '#ffffff') + ')')
    set(count, 'font-size', '13px')
    set(count, 'color', 'var(--dsw-alias-text-l2, ' + (dark ? '#9aa0a6' : '#5f6368') + ')')
    set(add, 'background-color', BRAND)
    set(add, 'background-image', 'none')
    set(add, 'color', '#ffffff')
    set(add, 'border', 'none')
    set(add, 'border-radius', '8px')
    set(add, 'padding', '6px 14px')
    set(add, 'font-size', '13px')
    set(add, 'font-weight', '500')
    set(add, 'line-height', '1.4')
    set(add, 'appearance', 'none')
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
    bar.innerHTML = ''
    const count = document.createElement('span')
    count.setAttribute('data-dsh-ref-bar-count', '')
    count.textContent = '已选 ' + String(this.checked.size) + ' 项'
    const add = document.createElement('button')
    add.type = 'button'
    add.setAttribute('data-dsh-ref-add', '')
    add.textContent = '添加 ' + String(this.checked.size) + ' 项'
    bar.append(count, add)
    this.applyBarStyles(bar, count, add)
    if (existing === null) menu.appendChild(bar)
  }

  /** Insert every checked candidate through upstream's settle-pick, one reference at a time. */
  private async addSelected(): Promise<void> {
    const labels = [...this.checked]
    this.checked.clear()
    document.querySelectorAll('[' + ON_ATTR + ']').forEach((el) => { el.removeAttribute(ON_ATTR) })
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

  /** The row whose candidate label matches. */
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
