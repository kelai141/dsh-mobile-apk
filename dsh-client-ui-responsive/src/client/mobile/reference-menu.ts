/**
 * Mobile reference-menu enhancer (apk #163 / 多选 chrome 审计 apk #169)。
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
 * ## 0.13.8（本版按审计 #169 的六条逐条修）
 *
 * 1. **勾选态落地**：状态挂在**行元素**上（`data-dsh-ref-on`），视觉 100% 由 CSS 从该属性派生；
 *    没有任何 JS「视觉同步」步骤，因此不存在「集合已选中而方框未勾」的失配窗口。
 * 2. **不再有无界 rAF/DOM 抖动**：`renderBar()` 幂等——节点只建一次，之后只改文本；
 *    绝不 `innerHTML=''` 重建（旧实现在选中期间每帧重建 → 触发 observer → 再重建）。
 * 3. **不再静默丢弃选择**：多选插入逐个进行，某个候选找不到时**保留剩余选择**并在底部条
 *    如实报告「已插入 k 项 / m 项未找到（可能已下钻目录）」，不再无声清空。
 * 4. **移动形态门**：非移动形态（宽视口 / 桌面模式）直接不注入——审计指出旧实现会在宽视口
 *    装一套手机专用 chrome，而此时 F6 不生效，形成未验证的第三种行为。
 * 5. **稳定身份**：多选键是「标签 + 同标签内序号」（`data-dsh-ref-key`），不是裸显示文本——
 *    同名文件/同名会话不再互相塌缩；已存在的键优先保留，列表变化时不打散已选项。
 * 6. **按行去抖 + 关菜单即清态**：去抖按「目标行」而非全局时间戳（400ms 内点第二行不再被吞）；
 *    菜单关闭时清空集合与底部条，重开不会出现幻影「已选 N 项」。
 */
const ROW_SELECTOR = '[data-trigger-menu] [role="option"]'
const MENU_SELECTOR = '[data-trigger-menu]'
/** 行元素 id 的固定前缀（上游 MenuView 的 optionId(source, index)）。 */
const OPTION_ID_PREFIX = 'dsh-slash-option-'
/** 引用源（ui-reference）的注册名；只有它的菜单才配多选 chrome。 */
const REFERENCE_SOURCE = 'reference'
const CHECK_ATTR = 'data-dsh-ref-check'
/** 选中标记（**视觉状态的唯一来源**：属性是状态，样式是后果，由 CSS 消费）。 */
const ON_ATTR = 'data-dsh-ref-on'
/** 多选键（稳定身份：标签 + 同标签内序号），挂在行上。 */
const KEY_ATTR = 'data-dsh-ref-key'
const BAR_ATTR = 'data-dsh-ref-bar'
const COUNT_ATTR = 'data-dsh-ref-bar-count'
const ADD_ATTR = 'data-dsh-ref-add'
const NAME_CLASS_HINT = 'itemName'
/** Gesture kinds one tap can arrive as; only the first of an interaction acts. */
const GESTURES = ['pointerdown', 'mousedown', 'click'] as const
/** 同一行的一次点按（pointerdown + mousedown + click）折叠成一个动作的时间窗。 */
const ROW_DEBOUNCE_MS = 400
/** 移动形态门（与 form-marker.ts 的 767px 单一来源一致）。 */
const MOBILE_QUERY = '(max-width: 767px)'
/** 品牌蓝。**不取 `--dsw-alias-brand-primary`**：该 token 在深色主题下实测解析为
 *  rgb(249,250,251)（近白），当底色配白字就是「白底白字不可见」。 */
const BRAND = '#4d6bfe'

/**
 * 勾选框与底部条样式。
 *
 * - 勾选框用 `<span>` + CSS 画（原生 input 在深色主题里是浏览器默认方块，与上游行样式不融）；
 * - 选中态由 `[data-dsh-ref-on]` 属性派生 —— 属性是状态，样式是后果，中间没有 JS 同步步骤；
 * - 底部条的关键样式在 JS 里内联 `!important`（上游 button 默认样式会盖过注入样式表）。
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
  background: ${BRAND};
  border-color: ${BRAND};
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
  background: var(--dsw-alias-bg-layer-2, #ffffff);
}
[data-dsh-ref-bar-count] {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #5f6368);
}
[data-dsh-ref-add] {
  padding: 6px 14px;
  border-radius: 8px;
  border: none;
  background: ${BRAND};
  color: #ffffff;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}
[data-dsh-ref-add]:active { filter: brightness(0.92); }
@media (prefers-color-scheme: dark) {
  [data-dsh-ref-check] { border-color: #6b7075; }
  [data-dsh-ref-bar] {
    border-top-color: var(--dsw-alias-border-l1, #2a2b30);
    background: var(--dsw-alias-bg-layer-2, #17181c);
  }
  [data-dsh-ref-bar-count] { color: var(--dsw-alias-label-secondary, #9aa0a6); }
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

/** 是否移动形态（#169-4）：以页面标记或 767px 视口为准，宽视口不注入手机专用 chrome。 */
function isMobileForm(): boolean {
  if (document.documentElement.hasAttribute('data-dsh-mobile-form')) return true
  return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches
}

/**
 * 一行属于哪个触发源。行 id 由上游 MenuView 的 optionId(source, index) 生成，源名是它
 * 唯一稳定在场的语义字段（data-ref-key 是本插件自己写的，不能反过来当判据）。
 * @param row - the candidate row.
 * @returns 该行的源名；id 缺失或前缀不符时 null。
 */
function sourceOfRow(row: HTMLElement): string | null {
  const id = row.id
  if (!id.startsWith(OPTION_ID_PREFIX)) return null
  // 末尾是 index、源名自身不含 '-'（上游注册名是 'command' / 'reference'），
  // 所以从右往左切一次：id = prefix + source + '-' + index。
  const rest = id.slice(OPTION_ID_PREFIX.length)
  const at = rest.lastIndexOf('-')
  return at <= 0 ? null : rest.slice(0, at)
}

/**
 * 菜单里是否含「引用源」的行。
 *
 * 上游把 /（指令）与 @（文件引用）渲染进**同一个** [data-trigger-menu] 容器
 * （MenuView.tsx 一个 MenuSurface 承载全部 group），所以容器属性无法区分二者；
 * 真机实测容器上没有 data-source，分组标题的 data-source 也只在 groupTitle 那一支出现，
 * 而 / 菜单因为每行都带 section 而从不渲染 groupTitle —— 靠这些属性判别会静默漏判。
 * 行 id 里的源名则是两种菜单里都在场、且语义正确的字段。
 * @param menu - the open trigger menu.
 * @returns 含引用源行为 true。
 */
function hasReferenceRows(menu: Element): boolean {
  for (const row of menu.querySelectorAll<HTMLElement>('[role="option"]')) {
    if (sourceOfRow(row) === REFERENCE_SOURCE) return true
  }
  return false
}

/** Multi-select state plus the mobile-only row behavior for the reference menu. */
export class ReferenceMenuEnhancer {
  /** 多选集合：**稳定键**（标签 + 同标签内序号），不是裸显示文本（#169-5）。 */
  private readonly checked = new Set<string>()
  private observer: MutationObserver | null = null
  /** 按行去抖（#169-6）：同一行的三连手势只动作一次，但**不**吞掉别的行。 */
  private readonly lastGesture = new WeakMap<Element, number>()
  private scheduled = false

  private readonly onGesture = (event: MouseEvent): void => {
    if (!isMobileForm()) return
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest<HTMLElement>(ROW_SELECTOR)
    if (row === null) return
    if (target.closest('[' + CHECK_ATTR + ']') === null) return
    // Own the gesture so upstream's settle-pick never sees it, and act only on the first kind
    // of one tap (a tap arrives as pointerdown + mousedown + click — measured on device).
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
    const now = Date.now()
    const last = this.lastGesture.get(row) ?? 0
    if (now - last < ROW_DEBOUNCE_MS) return
    this.lastGesture.set(row, now)
    this.toggle(row)
  }

  private readonly onMenuClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element) || target.closest('[' + BAR_ATTR + ']') === null) return
    if (target.closest('[' + ADD_ATTR + ']') === null) return
    event.preventDefault()
    event.stopPropagation()
    // issue #1404：在途期间第二次点按直接忽略（按钮同时被置 disabled/aria-busy）。
    if (this.busy) return
    void this.addSelected()
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
    // issue #1527：在途标志不能带过 detach。整段插入是异步的（每项最长 1500+600ms），
    // 在途时关面板再 re-attach（enhancer 实例被复用）会让 `if (this.busy) return` 一直挡住点击：
    // 按钮看着可用、点下去什么都不发生，且没有任何提示。
    // 代次 +1 让**旧插入链**的 finally 不再动新链的在途标志（否则旧链收尾会把新链的守卫抹掉，
    // 双击又能起第三条链 —— #1404 的重复插入原样复发）。
    this.generation += 1
    this.busy = false
    this.syncBusy()
    this.clearState()
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
   * 清空多选状态、行上的勾选标记、注入的复选框与底部条
   * （菜单关闭 / 卸载 / 切到非引用菜单时；#169-6 的幻影残留防线）。
   * 复选框必须一并撤掉：上游复用同一个 MenuSurface 节点承载 / 与 @ 两种菜单，
   * 只清属性会把它留在普通「+」菜单里。
   */
  private clearState(): void {
    this.checked.clear()
    document.querySelectorAll('[' + ON_ATTR + ']').forEach((el) => { el.removeAttribute(ON_ATTR) })
    document.querySelectorAll('[' + CHECK_ATTR + ']').forEach((el) => { el.remove() })
    document.querySelectorAll('[' + KEY_ATTR + ']').forEach((el) => { el.removeAttribute(KEY_ATTR) })
    document.querySelector<HTMLElement>('[' + BAR_ATTR + ']')?.remove()
  }

  /**
   * Ensure every row carries a checkbox + a stable key, re-apply the checked mark, refresh the bar.
   * 菜单不在场时清态（避免关掉菜单后重开还看到「已选 N 项」）。
   * 非移动形态直接不注入（#169-4）。
   */
  private enhance(): void {
    if (!isMobileForm()) {
      if (this.checked.size > 0) this.clearState()
      return
    }
    const menu = document.querySelector(MENU_SELECTOR)
    // 触发源门（2026-10-11）：「/」指令菜单与「@」引用菜单共用同一个 [data-trigger-menu]
    // 容器，"菜单在场" 不等于 "这是引用菜单"。旧实现只问前者，于是普通「+」菜单的每一行
    // 都被插上复选框（真机实测 9/9 行：文件/目标/计划/反馈/压缩/权限/模型/下载日志/插件项），
    // 图标、分组标题与菜单项挤在一起。多选只属于引用源，其余菜单上主动撤掉已注入的 chrome。
    if (menu === null) {
      if (this.checked.size > 0 || document.querySelector('[' + BAR_ATTR + ']') !== null) this.clearState()
      return
    }
    const rows = menu.querySelectorAll<HTMLElement>('[role="option"]')
    // 候选还在路上（上游先渲染 pending 骨架行，没有 option 行）：既不注入也不清态 ——
    // 清态会把用户刚勾的项连同底部条一起抹掉，"换个查询词就丢选择" 是比旧缺陷更难发现的坏行为。
    if (rows.length === 0) return
    if (!hasReferenceRows(menu)) {
      if (this.checked.size > 0 || document.querySelector('[' + BAR_ATTR + ']') !== null) this.clearState()
      return
    }
    const seen = new Map<string, number>()
    for (const row of rows) {
      if (sourceOfRow(row) !== REFERENCE_SOURCE) continue
      const label = rowLabel(row)
      const occurrence = (seen.get(label) ?? 0) + 1
      seen.set(label, occurrence)
      const candidate = label + '#' + String(occurrence)
      // 已存在的键优先保留（列表变化时不打散已选项），否则用本轮算出的候选键。
      const current = row.getAttribute(KEY_ATTR)
      const key = current !== null && this.checked.has(current) ? current : candidate
      if (current !== key) row.setAttribute(KEY_ATTR, key)

      let box = row.querySelector<HTMLElement>('[' + CHECK_ATTR + ']')
      if (box === null) {
        box = document.createElement('span')
        box.setAttribute(CHECK_ATTR, '')
        box.setAttribute('role', 'checkbox')
        box.setAttribute('aria-label', label)
        row.insertBefore(box, row.firstChild)
      }
      const on = this.checked.has(key)
      if (on) row.setAttribute(ON_ATTR, '')
      else row.removeAttribute(ON_ATTR)
      box.setAttribute('aria-checked', on ? 'true' : 'false')
    }
    this.renderBar()
  }

  /** Toggle one row：状态落在行元素上，随后由 CSS 呈现（无二次同步步骤）。 */
  private toggle(row: HTMLElement): void {
    if (sourceOfRow(row) !== REFERENCE_SOURCE) return
    const key = row.getAttribute(KEY_ATTR)
    if (key === null) return
    const on = !row.hasAttribute(ON_ATTR)
    if (on) {
      row.setAttribute(ON_ATTR, '')
      this.checked.add(key)
    } else {
      row.removeAttribute(ON_ATTR)
      this.checked.delete(key)
    }
    row.querySelector<HTMLElement>('[' + CHECK_ATTR + ']')
      ?.setAttribute('aria-checked', on ? 'true' : 'false')
    this.renderBar()
  }

  /**
   * 底部条关键样式内联写入：`style.setProperty(..., 'important')` 优先级高于任何样式表规则
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
    set(bar, 'background', 'var(--dsw-alias-bg-layer-2, ' + (dark ? '#17181c' : '#ffffff') + ')')
    set(count, 'font-size', '13px')
    set(count, 'color', 'var(--dsw-alias-label-secondary, ' + (dark ? '#9aa0a6' : '#5f6368') + ')')
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

  /**
   * 底部条渲染（**幂等**，#169-2）：节点只建一次，之后只更新文本；绝不 `innerHTML=''` 重建
   * ——旧实现每帧重建子节点会触发 MutationObserver → schedule() → 再重建，选中期间持续抖动。
   */
  private renderBar(): void {
    const menu = document.querySelector(MENU_SELECTOR)
    const existing = document.querySelector<HTMLElement>('[' + BAR_ATTR + ']')
    if (menu === null || this.checked.size === 0) {
      existing?.remove()
      return
    }
    let bar = existing
    if (bar === null) {
      bar = document.createElement('div')
      bar.setAttribute(BAR_ATTR, '')
      const count = document.createElement('span')
      count.setAttribute(COUNT_ATTR, '')
      const add = document.createElement('button')
      add.type = 'button'
      add.setAttribute(ADD_ATTR, '')
      bar.append(count, add)
      this.applyBarStyles(bar, count, add)
      menu.appendChild(bar)
    }
    const count = bar.querySelector<HTMLElement>('[' + COUNT_ATTR + ']')
    const add = bar.querySelector<HTMLButtonElement>('[' + ADD_ATTR + ']')
    if (count !== null) count.textContent = this.statusText('已选 ' + String(this.checked.size) + ' 项')
    if (add !== null) add.textContent = '添加 ' + String(this.checked.size) + ' 项'
  }

  /** 上一次插入的残留提示（#169-3：失败要如实说，不能无声清空选择）。 */
  private lastReport = ''

  /**
   * 「添加 N 项」在途标志（issue #1404）：整段插入是异步的（每项最长 1500+600ms），而按钮期间
   * 一直可点——双击会起两个循环对同一批 key 重复 pickByKey，同一引用被插两次。
   */
  private busy = false

  /**
   * 在途代次（issue #1527）：`detach` 时 +1。
   *
   * `busy` 是**实例级**状态，而 `addSelected` 的收尾是异步的：detach 之后旧链仍在跑，
   * 它无条件把 `busy` 置回 false 就会抹掉 re-attach 之后新链的在途标志。代次让「收尾」
   * 只对它自己那条链生效。
   */
  private generation = 0

  private statusText(base: string): string {
    return this.lastReport === '' ? base : base + ' · ' + this.lastReport
  }

  /** Insert every checked candidate through upstream's settle-pick, one reference at a time. */
  private async addSelected(): Promise<void> {
    if (this.busy) return
    const generation = this.generation
    this.busy = true
    this.syncBusy()
    try {
      await this.insertChecked()
    } finally {
      // 只收自己那条链的尾：detach 之后重新起来的链由它自己收（issue #1527）。
      if (this.generation === generation) {
        this.busy = false
        this.syncBusy()
      }
    }
  }

  /** 在途态同步到按钮（issue #1404）：disabled + aria-busy，避免用户以为没响应而反复点。 */
  private syncBusy(): void {
    const add = document.querySelector<HTMLButtonElement>('[' + ADD_ATTR + ']')
    if (add === null) return
    add.disabled = this.busy
    if (this.busy) add.setAttribute('aria-busy', 'true')
    else add.removeAttribute('aria-busy')
  }

  private async insertChecked(): Promise<void> {
    const keys = [...this.checked]
    let inserted = 0
    this.lastReport = ''
    for (const key of keys) {
      const ok = await this.pickByKey(key)
      if (!ok) break
      inserted++
      this.checked.delete(key)
    }
    if (this.checked.size === 0) {
      this.clearState()
      return
    }
    // 未能插入的（多为目录行：F6 下钻改变了候选列表）**保留在选择里**并如实报告，
    // 用户可以逐个手动处理，而不是被无声丢弃（#169-3）。
    this.lastReport = '已插入 ' + String(inserted) + ' 项，' + String(this.checked.size) + ' 项未找到（可能已下钻目录）'
    // 同步视觉：已插入的取消勾选，剩下的保持勾选。
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (sourceOfRow(row) !== REFERENCE_SOURCE) continue
      const key = row.getAttribute(KEY_ATTR)
      if (key === null) continue
      const on = this.checked.has(key)
      if (on) row.setAttribute(ON_ATTR, '')
      else row.removeAttribute(ON_ATTR)
    }
    this.renderBar()
  }

  /**
   * Drive one upstream pick for `key`: focus the composer, (re)open the menu with `@` when it
   * closed, then settle the matching row. Upstream owns the reference it inserts; a row that never
   * appears ends the sequence (reported by the caller) rather than inventing text upstream would
   * not have produced.
   */
  private async pickByKey(key: string): Promise<boolean> {
    const editable = composerEditable()
    if (editable === null) return false
    editable.focus()
    if (document.querySelector(MENU_SELECTOR) === null) {
      document.execCommand('insertText', false, '@')
      if (!(await this.waitFor(() => this.findRow(key) !== null))) return false
    }
    const row = this.findRow(key)
    if (row === null) return false
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await this.waitFor(() => document.querySelector(MENU_SELECTOR) === null || this.findRow(key) === null, 600)
    return true
  }

  /** The row whose stable key matches（#169-5：不再按显示文本取第一个同名行）。 */
  private findRow(key: string): HTMLElement | null {
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (row.getAttribute(KEY_ATTR) === key) return row
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
