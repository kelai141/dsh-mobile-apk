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
 *
 * 0.13.8（真机反馈的两处缺陷）：
 * - **勾选态不实时同步**：`preventDefault()` 吃掉原生 checkbox 的状态翻转后，实现只改了内部集合，
 *   没回写 DOM → 视觉上框永远是空的（用户实测：「勾上了、确认也能选中，但方框状态没同步」）。
 *   修复 = 每次 toggle 与每次 enhance 后统一 `syncCheckboxes()` 把 `.checked` 按集合回写。
 * - **确认按钮没做深色适配**：底部条用内联样式写死了浅色分隔线与白字，暗色主题下按钮与分隔线
 *   与面板脱节。修复 = 走主题 token + `prefers-color-scheme` 兜底（样式集中在 REFERENCE_BAR_CSS，
 *   由 index.ts 注入，不再散落内联）。
 */
const ROW_SELECTOR = '[data-trigger-menu] [role="option"]'
const CHECK_ATTR = 'data-dsh-ref-check'
const BAR_ATTR = 'data-dsh-ref-bar'
const NAME_CLASS_HINT = 'itemName'
/**
 * 多选条的状态样式（hover/active/禁用/勾选框强调色）。
 *
 * 关键样式（背景、文字色、边框）**不在这里**：真机实测发现上游对 `button` 的默认样式会盖过
 * 注入样式表（表现为「白底 + 白字」，按钮看不见字），因此那几项改成内联 `!important` 写入
 * （见 `applyBarStyles`）——内联 + important 是目前唯一能稳定压过任意上游规则的写法。
 * 本表只写「状态类」样式（这类样式上游不会覆盖，写在表里更清晰也更好维护）。
 *
 * 颜色口径（**真机实测踩到的坑**）：`--dsw-alias-brand-primary` 在深色主题下解析为
 * `rgb(249,250,251)`（近白）——拿它当按钮底色配白字就是「白底白字，按钮看不见」。
 * 因此按钮/勾选框的品牌色**不再取该 token**，直接用显式品牌蓝 `#4d6bfe`（两种主题下都够深）。
 * 其余颜色（分隔线/条底/次要文字）仍取 token + `prefers-color-scheme` 兜底，壳侧 ThemeBridge
 * 已把该媒体查询接到系统深浅色，故暗色分支就是「当前主题」的真值。
 */
export const REFERENCE_BAR_CSS: string = `
[data-dsh-ref-bar] {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
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
  color: var(--dsw-alias-text-on-brand, #ffffff);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}
[data-dsh-ref-add]:active { filter: brightness(0.92); }
[data-dsh-ref-add]:disabled { opacity: 0.5; }
[data-dsh-ref-check] {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0 8px 0 0;
  accent-color: #4d6bfe;
}
@media (prefers-color-scheme: dark) {
  [data-dsh-ref-bar] {
    border-top-color: var(--dsw-alias-border-l1, #2a2b30);
    background: var(--dsw-alias-bg-l1, #17181c);
  }
  [data-dsh-ref-bar-count] { color: var(--dsw-alias-text-l2, #9aa0a6); }
  [data-dsh-ref-add] { color: var(--dsw-alias-text-on-brand, #ffffff); }
}
`

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
      row.insertBefore(box, row.firstChild)
    }
    this.syncCheckboxes()
    this.renderBar()
  }

  /** Toggle one label in the multi-select set. */
  private toggle(label: string): void {
    if (this.checked.has(label)) this.checked.delete(label)
    else this.checked.add(label)
    this.syncCheckboxes()
    this.renderBar()
  }

  /**
   * 把集合状态回写到 DOM 复选框（0.13.8 修复）：check 手势被 preventDefault 掉之后，
   * 原生状态翻转不会发生，视觉必须由这里补上；每次 enhance 后也走一遍，
   * 免得上游重渲染列表时把已选行画成未选（状态源始终是 `checked` 集合，DOM 只是投影）。
   */
  private syncCheckboxes(): void {
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const box = row.querySelector<HTMLInputElement>('[' + CHECK_ATTR + ']')
      if (box === null) continue
      const label = box.getAttribute(CHECK_ATTR) ?? ''
      box.checked = this.checked.has(label)
    }
  }

  /**
   * 关键样式内联写入（0.13.8 修复「按键没做深色适配」）：`style.setProperty(..., 'important')`
   * 的优先级高于任何样式表规则（含上游的 button 默认样式），是唯一稳的落法。
   * 颜色优先取主题 token，取不到时按当前深浅色给品牌蓝/白字（蓝底白字在两种主题下都可读）。
   */
  private applyBarStyles(bar: HTMLElement, count: HTMLElement, add: HTMLButtonElement): void {
    const set = (el: HTMLElement, prop: string, value: string): void => {
      el.style.setProperty(prop, value, 'important')
    }
    const dark = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches
    set(bar, 'display', 'flex')
    set(bar, 'gap', '8px')
    set(bar, 'align-items', 'center')
    set(bar, 'justify-content', 'space-between')
    set(bar, 'padding', '8px 10px')
    set(bar, 'border-top', '1px solid var(--dsw-alias-border-l1, ' + (dark ? '#2a2b30' : '#e5e5e5') + ')')
    set(bar, 'background', 'var(--dsw-alias-bg-l1, ' + (dark ? '#17181c' : '#ffffff') + ')')
    set(count, 'font-size', '13px')
    set(count, 'color', 'var(--dsw-alias-text-l2, ' + (dark ? '#9aa0a6' : '#5f6368') + ')')
    // 按钮：显式品牌蓝 + 白字，且用 important 压过上游 button 默认样式（真机实测的根因）
    set(add, 'background-color', '#4d6bfe')   // 见文件头：该 token 深色下近白，不能当按钮底色
    set(add, 'background-image', 'none')
    set(add, 'color', '#ffffff')
    set(add, 'border', 'none')
    set(add, 'border-radius', '8px')
    set(add, 'padding', '6px 14px')
    set(add, 'font-size', '13px')
    set(add, 'font-weight', '500')
    set(add, 'line-height', '1.4')
    set(add, 'min-width', '64px')
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
