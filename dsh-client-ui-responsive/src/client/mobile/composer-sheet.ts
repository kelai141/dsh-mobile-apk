import { zh, en, type ComposerSheetKey } from './composer-sheet.locales.ts'

/**
 * 输入行「+」的底部 sheet（替换上游那个小弹层）。
 *
 * ## 为什么拦截「+」
 * 上游 InputBar.tsx:420-433 的「+」是一个普通 button（aria-label 取自 t('input.commands')，
 * aria-haspopup="listbox"，onClick=onToggleCommandMenu），它开的是 ui-input-trigger 的
 * MenuView 小弹层。手机竖屏下那个弹层贴着输入行、只有半屏，且不提供拍照入口。
 * 本模块把点击换成底部 sheet：上面三块瓦片（拍照 / 照片 / 本地文件），下面**自动映射**
 * 上游「+」菜单里的全部项。
 *
 * ## 自动映射（不加白名单）
 * 打开时先让上游菜单自己开（不 preventDefault，完全保留上游行为），再读
 * [data-composer-card] [role=menu] 里的 [role=option]，逐项复制成「图标 + 标题 + 副标题」
 * 的行；点击转发回原 item。第三方插件往「+」里加的东西因此自动出现，本模块不认识任何具体项。
 *
 * 转发必须用 **mousedown** 而不是 click：上游 MenuView.tsx:161-177 的每个 option 只在
 * onMouseDown 上挂 onPick（防止焦点从编辑器被抢走），合成 click 不会触发它。
 *
 * ## 键盘行为（用户明确要求，别改回去）
 * 打开：先 blur 当前焦点、再抑制键盘，sheet 全程不唤起键盘。
 * 关闭：**不自动聚焦、不自动唤起键盘**。收起后焦点落在 body 上是期望结果 ——
 * 用户下一步要么点输入框（自己唤起键盘），要么点别处。任何「顺手把焦点还给输入框」的
 * 优化都会在关闭瞬间弹出键盘，与需求相反。inputmode=none 的临时覆盖同样不得省略：
 * 没有它，某些 WebView 会在 sheet 内任何可聚焦元素被点时再次弹键盘。
 */

/** 上游「+」：ui-conversation 里唯一 aria-haspopup="listbox" 的按钮（MenuView 是 combobox）。 */
const ADD_BUTTON_SELECTOR = '[data-composer-card] button[aria-haspopup="listbox"]'
const CARD_SELECTOR = '[data-composer-card]'
/** 上游「+」弹层的根：MenuView 落在 MenuSurface 上，role=menu。 */
const UPSTREAM_MENU_SELECTOR = '[data-composer-card] [role="menu"]'
/** 弹层里的可选项（MenuView 的每条命令/文件项）。 */
const UPSTREAM_OPTION_SELECTOR = '[role="option"]'
/** 上游隐藏的 multiple file input：拍照/照片/本地文件都走它。 */
const FILE_INPUT_SELECTOR = 'input[type="file"][multiple]'

const BACKDROP_ATTR = 'data-dsh-composer-sheet-backdrop'
const PANEL_ATTR = 'data-dsh-composer-sheet-panel'
const TILES_ATTR = 'data-dsh-composer-sheet-tiles'
const TILE_ATTR = 'data-dsh-composer-sheet-tile'
const ROWS_ATTR = 'data-dsh-composer-sheet-rows'
const ROW_ATTR = 'data-dsh-composer-sheet-row'

type TileKind = 'camera' | 'photo' | 'file'

/** 一条从上游菜单复制出来的行（index 是它在上游菜单里的位置，转发时按位取回）。 */
interface MappedRow {
  readonly title: string
  readonly subtitle: string
  readonly icon: Element | null
  readonly index: number
}

/** 本地字典兜底：插件在 locale 服务就绪前也能出正确文案。 */
function copyFor(): (key: ComposerSheetKey) => string {
  const language = (document.documentElement.lang || navigator.language || '').toLowerCase()
  const dict = language.startsWith('zh') ? zh : en
  return (key) => dict[key]
}

/** 由插件主体注入的翻译函数（locale 命名空间 androidComposerSheet）。 */
export type ComposerSheetTranslate = (key: ComposerSheetKey) => string

/** 瓦片图标：24x24 viewBox，由 CSS 缩放到 28px。 */
function tileIcon(kind: TileKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const d = kind === 'camera'
    ? 'M3 8.5h3l1.5-2h9L18 8.5h3v11H3zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6'
    : kind === 'photo'
      ? 'M3 5h18v14H3zM3 16l5-5 4 4 2.5-2.5L21 19M8 9.5h.01'
      : 'M4 3.5h7l4 4v13H4zM11 3.5v4h4M7.5 13h6M7.5 16.5h6'
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

/** 行副标题：优先取上游自己的 description 节点，没有就空串（不编、不猜）。 */
function readSubtitle(option: HTMLElement): string {
  const hint = option.querySelector<HTMLElement>('[class*="itemDescription"]')
  if (hint !== null) return (hint.textContent ?? '').trim()
  const alias = option.querySelector<HTMLElement>('[class*="itemAlias"]')
  if (alias !== null) return (alias.textContent ?? '').trim()
  return ''
}

/**
 * 拦截「+」并管理底部 sheet。
 * attach 挂事件与观察器，detach 完全卸掉（HMR 安全：不留 document 监听）。
 */
export class ComposerSheet {
  /** 由外界注入的翻译函数；缺省用本地字典。 */
  private translate: ComposerSheetTranslate | null

  constructor(translate: ComposerSheetTranslate | null = null) {
    this.translate = translate
  }

  /** locale/change 后由插件主体换掉绑定的 t。 */
  setTranslate(translate: ComposerSheetTranslate | null): void {
    this.translate = translate
  }

  private text(): ComposerSheetTranslate {
    return this.translate ?? copyFor()
  }

  private backdrop: HTMLElement | null = null
  private addButton: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private attached = false
  private patchScheduled = false
  /** 打开前「+」的 aria-expanded 原值（关闭时按原样还回去）。 */
  private previousExpanded: string | null = null
  /** 被我们改过 inputmode 的元素 → 原值。 */
  private readonly inputModeSnapshot = new Map<HTMLElement, string | null>()
  /**
   * 我们自己派发上游「+」点击时的重入闸。
   *
   * readUpstreamRows 必须让上游把菜单开出来，而开菜单的唯一办法就是派发一次「+」的 click；
   * 那个 click 会再次经过本类的捕获监听。没有这道闸，onClickCapture -> open -> readUpstreamRows
   * -> 派发 click -> onClickCapture ... 会无限递归（实测 RangeError: Maximum call stack size exceeded）。
   */
  private replaying = false

  /**
   * 正在「借用」上游菜单（开一次 → 读项 → 用 Escape 关掉）。
   *
   * 借用期间我们自己派发的 Escape 会同样到达本类的 onKeyDown：不设这道闸，
   * 关上游菜单的那一下会顺手把整张 sheet 关掉（实测：容器已挂、行写不进去，
   * 因为面板刚好在这一步自我关闭）。
   */
  private borrowing = false

  /**
   * 捕获阶段拦「+」。
   *
   * 用捕获 + stopImmediatePropagation 而不是只 preventDefault：上游 onClick 会调
   * focusDraftEditor(editor) —— 那正是唤起键盘的那一步，必须整个拦掉。
   */
  private readonly onClickCapture = (event: Event): void => {
    // 我们自己合成的「+」点击：放过去，交还上游自己的 onClick。
    if (this.replaying) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (this.backdrop !== null && this.backdrop.contains(target)) return
    const button = target.closest<HTMLElement>(ADD_BUTTON_SELECTOR)
    if (button === null) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (button.hasAttribute('disabled')) return
    this.open(button)
  }

  private readonly onBackdropPointerDown = (event: Event): void => {
    if (this.backdrop === null) return
    const target = event.target
    if (!(target instanceof Node)) return
    const panel = this.panel()
    if (panel !== null && panel.contains(target)) return
    this.close()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // 借用上游菜单时派发的 Escape 只用来关上游菜单，不能连锁关掉 sheet（见 borrowing）。
    if (this.borrowing) return
    if (event.key !== 'Escape' || this.backdrop === null) return
    event.preventDefault()
    event.stopPropagation()
    this.close()
  }

  private readonly onPopState = (): void => {
    if (this.backdrop !== null) this.close()
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    try {
      // 捕获阶段：必须早于上游 React 的 onClick。
      document.addEventListener('click', this.onClickCapture, true)
      document.addEventListener('pointerdown', this.onBackdropPointerDown, true)
      document.addEventListener('keydown', this.onKeyDown, true)
      window.addEventListener('popstate', this.onPopState)
      // 「+」会随合成器重挂载（会话切换 / hero 与 dock 互切）：只盯「出现了一个带 listbox 的按钮」，
      // 不做无条件全文档查询（与 top-bar-fold 同一克制）。
      this.observer = new MutationObserver((records) => { this.onMutations(records) })
      this.observer.observe(document.documentElement, { childList: true, subtree: true })
      this.patch()
    } catch (error) {
      // 手机运行时守卫：一个便利入口的装配失败绝不能中断插件主体。
      console.warn('[dsh-composer-sheet] attach failed; upstream + keeps its own menu', error)
    }
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('click', this.onClickCapture, true)
    document.removeEventListener('pointerdown', this.onBackdropPointerDown, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('popstate', this.onPopState)
    this.observer?.disconnect()
    this.observer = null
    this.patchScheduled = false
    this.close()
    this.restoreInputMode()
    this.addButton = null
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.addButton !== null && this.addButton.isConnected) return
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(ADD_BUTTON_SELECTOR) || node.querySelector(ADD_BUTTON_SELECTOR) !== null) {
          this.schedulePatch()
          return
        }
      }
    }
  }

  private schedulePatch(): void {
    if (this.patchScheduled) return
    this.patchScheduled = true
    queueMicrotask(() => {
      this.patchScheduled = false
      if (this.attached) this.patch()
    })
  }

  /** 记住当前「+」的引用（只用于观察器判活，不接管它自己的 listener）。 */
  private patch(): void {
    this.addButton = document.querySelector<HTMLElement>(ADD_BUTTON_SELECTOR)
  }

  private panel(): HTMLElement | null {
    return this.backdrop?.querySelector<HTMLElement>('[' + PANEL_ATTR + ']') ?? null
  }

  private open(button: HTMLElement): void {
    this.close()
    const t = this.text()
    // 顺序有讲究：**先读上游菜单，再 blur**。
    // 上游 MenuView 只在编辑器持有焦点时才肯开（它把自己绑在 draft editor 的 caret 上），
    // 先 blur 会让 readUpstreamRows 读到 0 项，sheet 就只剩三块瓦片（实机复现过：
    // 面板文案只有「拍照照片本地文件」）。读完之后再压焦点，键盘照样不会弹。
    // 行容器先建好但**不读菜单**：读菜单必须等 backdrop 挂上之后再做，
    // 否则 fillRows 会在挂载前完成、被自己的「仍在面板里」守卫丢掉（实测 mapped=3 却写不进去）。
    const rows = this.buildRows()
    const active = document.activeElement
    // 键盘抑制：**先只改 inputmode，不要 blur**（issue #929）。
    // 上游 MenuView 把自己绑在 draft editor 的 caret 上，编辑器不持焦点它就不肯开；
    // 先 blur 会让 readUpstreamRows 读到 0 项 —— 这是「映射行永远 0」的真因，
    // 而且 jsdom 里的假菜单不要求焦点，所以 spec 抓不到（#892 因此带着「未验」合了）。
    this.suppressInputMode()
    this.previousExpanded = button.getAttribute('aria-expanded')

    const backdrop = document.createElement('div')
    backdrop.setAttribute(BACKDROP_ATTR, '')
    backdrop.setAttribute('role', 'presentation')

    const panel = document.createElement('div')
    panel.setAttribute(PANEL_ATTR, '')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', t('sheetLabel'))

    panel.append(this.buildTiles(t))
    panel.append(rows)

    backdrop.append(panel)
    document.body.append(backdrop)
    this.backdrop = backdrop
    button.setAttribute('aria-expanded', 'true')
    // 到这里 backdrop 已经挂到 body 上（this.backdrop 也已赋值），读菜单拿到的
    // 行才有地方写。顺序不能提前：见 fillRows 的注释。
    // issue #929：等映射读完**再**压焦点。旧实现用 `void` 丢掉了 Promise，
    // 紧接着的 blurActiveEditor() 会在读菜单**之前**跑 —— 等于又白读一次。
    void this.fillRows(rows).finally(() => {
      if (active instanceof HTMLElement) active.blur()
      // 映射过程会开一次上游菜单、那一步会调 focusDraftEditor：再压一次焦点，
      // 保证 sheet 停留期间不会有键盘。
      this.blurActiveEditor()
    })
  }

  private buildTiles(t: (key: ComposerSheetKey) => string): HTMLElement {
    const tiles = document.createElement('div')
    tiles.setAttribute(TILES_ATTR, '')
    const order: readonly [TileKind, ComposerSheetKey][] = [
      ['camera', 'camera'],
      ['photo', 'photo'],
      ['file', 'file'],
    ]
    for (const [kind, key] of order) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.setAttribute(TILE_ATTR, kind)
      tile.setAttribute('aria-label', t(key))
      tile.append(tileIcon(kind))
      const label = document.createElement('span')
      label.setAttribute('data-dsh-composer-sheet-tile-label', '')
      label.textContent = t(key)
      tile.append(label)
      tile.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.pickFile(kind)
      })
      tiles.append(tile)
    }
    return tiles
  }

  /**
   * 打开上游「+」菜单 → 读它的 option → 复制成行 → 关掉上游菜单。
   *
   * 菜单不在场（上游改了实现 / 焦点门不让开）时只留三块瓦片，不报错：映射是增强，
   * 不是这张 sheet 的存在前提。
   */
  /**
   * 造映射行的容器，并异步填内容。
   *
   * 容器同步返回（三块瓦片立刻可见），行在拿到上游菜单之后补进去 —— 因为读菜单
   * 必须跨一次 React 提交（见 withUpstreamMenu）。
   * @returns 空的行容器；内容稍后填入。
   */
  private buildRows(): HTMLElement {
    const rows = document.createElement('div')
    rows.setAttribute(ROWS_ATTR, '')
    return rows
  }

  /**
   * 读上游菜单项并填进容器。
   *
   * 目标已被关闭/替换时丢弃结果：用户在等待期间点掉了 sheet，就不能再往旧容器里写。
   * @param rows - 行容器。
   */
  private async fillRows(rows: HTMLElement): Promise<void> {
    const mapped = await this.readUpstreamRows()
    if (mapped.length === 0) return
    // 只丢「这张 sheet 已经关了」的结果：关掉后 rows 会随 backdrop 离场，
    // 再往里写就是往死节点里写。**不能**用 rows.isConnected 判断 —— 读菜单要跨
    // 一次上游提交，这几帧里面板可能还没挂到 body 上（实测：读到了 9 个上游项，
    // 却因为此刻未挂载而整批丢弃，面板只剩三块瓦片）。
    if (this.backdrop === null || !this.backdrop.contains(rows)) return
    for (const row of mapped) rows.append(this.buildRow(row))
  }

  private buildRow(row: MappedRow): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(ROW_ATTR, '')
    button.setAttribute('aria-label', row.subtitle === '' ? row.title : row.title + ' — ' + row.subtitle)
    const iconBox = document.createElement('span')
    iconBox.setAttribute('data-dsh-composer-sheet-row-icon', '')
    if (row.icon !== null) iconBox.append(row.icon.cloneNode(true))
    const text = document.createElement('span')
    text.setAttribute('data-dsh-composer-sheet-row-text', '')
    const title = document.createElement('span')
    title.setAttribute('data-dsh-composer-sheet-row-title', '')
    title.textContent = row.title
    text.append(title)
    if (row.subtitle !== '') {
      const sub = document.createElement('span')
      sub.setAttribute('data-dsh-composer-sheet-row-sub', '')
      sub.textContent = row.subtitle
      text.append(sub)
    }
    button.append(iconBox, text)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.dispatch(row.index)
      this.close()
    })
    return button
  }

  /**
   * 临时让上游「+」菜单开出来，跑完 run 之后再关掉它。
   *
   * 为什么不把菜单留着当数据源：上游 MenuView.tsx:81-92 在 document 捕获阶段监听了
   * pointerdown，目标既不在菜单里、也不在 composer card 里就自行 onDismiss。我们的 sheet
   * 挂在 body 上，用户第一次点瓦片/行时上游菜单就会被它自己关掉；那时再去转发，源节点
   * 已经脱离 DOM，转发静默失效。所以每次读写都重新开一次，用完立刻关。
   *
   * 重入闸 replays：开菜单的唯一办法是派发「+」的 click，而这次 click 会再经过本类的
   * 捕获监听。没有闸就是 onClickCapture -> open -> 派发 click -> onClickCapture 的无限递归
   * （实测 RangeError: Maximum call stack size exceeded）。
   *
   * 上游 onClick 会先 focusDraftEditor 唤起键盘，所以每次开完都补一次 blur —— 配合
   * inputmode=none，用户看不到键盘。
   */
  /**
   * 让上游菜单开出来，等 React 提交完再读，读完关掉。
   *
   * **必须跨一帧**：React 的 onClick 是委托在 root 上的合成事件，它 setState 之后
   * 菜单要到下一次提交才会挂进 DOM。派发 click 后立刻 querySelector 永远是 null
   * （实机复现：菜单能点开、但同一次同步求值里读不到任何 [role=option]）。
   * 这里用 requestAnimationFrame 等一次提交，再读。
   *
   * @param run - 拿到 option 列表后执行的读取。
   * @param fallback - 菜单始终不出现时的返回值。
   * @returns run 的结果，或 fallback。
   */
  private async withUpstreamMenu<T>(run: (options: HTMLElement[]) => T, fallback: T): Promise<T> {
    const button = this.addButton ?? document.querySelector<HTMLElement>(ADD_BUTTON_SELECTOR)
    if (button === null) return fallback
    const card = button.closest(CARD_SELECTOR)
    if (card === null) return fallback
    const openedHere = card.querySelector(UPSTREAM_MENU_SELECTOR) === null
    if (openedHere) {
      // **先把焦点还给编辑器**：上游 MenuView 绑在 draft editor 的 caret 上，编辑器
      // 不持焦点时点击「+」只置 aria-expanded、菜单节点不挂载（实机复现：同一按钮，
      // 带焦点派发 menus=1 opts=9，无焦点派发恒 0 —— sheet 的 open() 恰好总是先 blur）。
      this.refocusEditor()
      this.replaying = true
      this.borrowing = true
      try {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      } finally {
        this.replaying = false
      }
      // 等上游把菜单提交进 DOM：轮询到它真的出现（或超时），
      // 单等一帧不够 —— 实测菜单在这台设备上要过一个宏任务才挂进卡片。
      await this.waitForMenu(card)
    }
    const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
    if (menu === null) return fallback
    try {
      return run([...menu.querySelectorAll<HTMLElement>(UPSTREAM_OPTION_SELECTOR)])
    } finally {
      if (openedHere && menu.isConnected) {
        // 用 Esc（上游自己的关法）收起，不直接 remove 别人的 DOM。
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }
      // 借完就还：之后用户按 Esc 必须能正常关掉 sheet。
      this.borrowing = false
      // 上游刚刚把焦点给了编辑器：重新压回去，键盘才不会跟着冒出来。
      this.blurActiveEditor()
    }
  }

  /**
   * 等一次渲染提交。
   *
   * 先排一个 rAF（拿到 Commit 之后的时机），再用一个宏任务兜底：
   * 某些 WebView 在页面不可见时不给 rAF 回调，纯 rAF 会让整个 sheet 挂住。
   * @returns 提交时机已过。
   */
  /**
   * 等上游菜单挂进卡片。
   *
   * 逐帧轮询而不是固定延时：菜单到达时机取决于上游的提交与（可能的）动画帧，
   * 固定等待在快机上浪费、在慢机上不够。超时后照常返回，由调用方按「没读到」
   * 处理 —— 映射是增强，不是面板的前提。
   * @param card - 上游卡片（菜单挂在它里面）。
   * @returns 菜单已出现（或已超时）。
   */
  private waitForMenu(card: Element): Promise<void> {
    return new Promise<void>((resolve) => {
      let waited = 0
      const step = (): void => {
        if (card.querySelector(UPSTREAM_MENU_SELECTOR) !== null || waited >= 3000) {
          resolve()
          return
        }
        waited += 25
        setTimeout(step, 25)
      }
      step()
    })
  }

  /** 读上游菜单的项（打开-读-关），失败时返回空（只留三块瓦片）。 */
  private readUpstreamRows(): Promise<MappedRow[]> {
    return this.withUpstreamMenu((options) => options.map((option, index): MappedRow => {
      const name = (option.querySelector<HTMLElement>('[class*="itemName"]')?.textContent ?? '').trim()
      const label = (option.getAttribute('aria-label') ?? '').trim()
      return {
        title: name !== '' ? name : label,
        subtitle: readSubtitle(option),
        icon: option.querySelector('svg'),
        index,
      }
    }), [])
  }

  /**
   * 把点击转回上游那一条 item。
   *
   * 按索引转发：每次重新打开菜单，取同一位置的 option。
   * 事件类型必须是 mousedown —— 上游 MenuView.tsx:170-173 每个 option 只在 onMouseDown 上挂
   * onPick（防止焦点从编辑器被抢走），合成 click 不会触发它。
   */
  private dispatch(index: number): void {
    void this.withUpstreamMenu((options) => {
      const option = options[index]
      if (option === undefined) return
      // 不带 view：jsdom 的 window 不是 node 的 global，传了会抛
      // "member view is not of type Window"；上游 onPick 也不读 view。
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    }, undefined)
  }

  /** 把焦点从任何可编辑元素上挪走（不改变 inputmode，那份由 suppress/restore 管）。 */
  private blurActiveEditor(): void {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
  }

  /**
   * 把焦点还上游编辑器（读菜单借用期间用，键盘由 inputmode=none 压住）。
   *
   * 上游 MenuView 的打开依赖编辑器持有焦点（绑在 draft editor 的 caret 上），
   * 没有焦点时点「+」只翻转 aria-expanded，菜单节点不会挂载。
   */
  private refocusEditor(): void {
    const card = this.addButton?.closest(CARD_SELECTOR) ?? document.querySelector(CARD_SELECTOR)
    const editor = card?.querySelector<HTMLElement>('[data-composer-input]') ?? null
    if (editor !== null && !editor.contains(document.activeElement)) editor.focus()
  }

  /** 拍照 / 照片 / 本地文件：都交给上游那个 hidden multiple file input。 */
  private pickFile(kind: TileKind): void {
    const card = this.addButton?.closest(CARD_SELECTOR) ?? document.querySelector(CARD_SELECTOR)
    const input = card?.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR) ?? null
    this.close()
    if (input === null || input.disabled || !input.isConnected) return
    if (kind === 'file') {
      // 本地文件保持上游默认（不限 accept），直接开。
      input.removeAttribute('accept')
      input.removeAttribute('capture')
    } else {
      // 拍照与照片共用 image/*：Android 的系统选择器把相机作为同一 picker 的一个来源；
      // 拍照再叠 capture 让系统优先给相机。
      input.setAttribute('accept', 'image/*')
      if (kind === 'camera') input.setAttribute('capture', 'environment')
      else input.removeAttribute('capture')
    }
    try {
      input.click()
    } finally {
      // accept/capture 只影响这一次选择请求，选择器返回后清掉，避免污染后续「本地文件」。
      window.setTimeout(() => {
        input.removeAttribute('accept')
        input.removeAttribute('capture')
      }, 0)
    }
  }

  /** 临时把 inputmode 压成 none（关闭时逐个还原）。 */
  private suppressInputMode(): void {
    if (this.inputModeSnapshot.size > 0) return
    for (const element of document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]')) {
      this.inputModeSnapshot.set(element, element.getAttribute('inputmode'))
      element.setAttribute('inputmode', 'none')
    }
  }

  private restoreInputMode(): void {
    for (const [element, previous] of this.inputModeSnapshot) {
      if (!element.isConnected) continue
      if (previous === null) element.removeAttribute('inputmode')
      else element.setAttribute('inputmode', previous)
    }
    this.inputModeSnapshot.clear()
  }

  /**
   * 收起 sheet。
   *
   * 刻意**不**调用任何 focus()：见文件头「键盘行为」。除还原 inputmode 外不碰焦点。
   */
  private close(): void {
    if (this.backdrop !== null) {
      this.backdrop.remove()
      this.backdrop = null
      if (this.addButton !== null) {
        if (this.previousExpanded === null) this.addButton.removeAttribute('aria-expanded')
        else this.addButton.setAttribute('aria-expanded', this.previousExpanded)
      }
      this.previousExpanded = null
    }
    this.restoreInputMode()
  }
}
