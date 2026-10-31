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
/**
 * 上游「+」弹层的根。
 *
 * **是 role="listbox"，不是 role="menu"**（MenuView.tsx:132）。上游整条链自洽：
 * 按钮 aria-haspopup="listbox" → 弹层 role="listbox" → 每项 role="option"。
 * 曾经写成 [role="menu"]，查不到就把「选择器错」误判成「上游不渲染菜单」，
 * 导致映射行长期恒 0（实机取证：同一次点击 [role="menu"] 为 null 而
 * [role="option"] 有 9 项）。
 */
const UPSTREAM_MENU_SELECTOR = '[data-composer-card] [role="listbox"]'
/** 弹层里的可选项（MenuView 的每条命令/文件项）。 */
const UPSTREAM_OPTION_SELECTOR = '[role="option"]'
/** 等上游菜单出现的轮询间隔与超时（超时后按「没读到」处理，只留三块瓦片）。 */
const MENU_POLL_INTERVAL_MS = 25
const MENU_WAIT_TIMEOUT_MS = 3000
/** 上游隐藏的 multiple file input：拍照/照片/本地文件都走它。 */
const FILE_INPUT_SELECTOR = 'input[type="file"][multiple]'
/**
 * 上游编辑器根元素（ComposerContentEditable 渲染的 contenteditable div）。
 *
 * Lexical 把 keydown 挂在这个元素上，关「+」菜单的链路就从这里起（#998）。
 */
const EDITOR_ROOT_SELECTOR = '[data-composer-input]'
/** 编辑器根元素缺失时的退化判据（上游不再打 data-composer-input）。 */
const EDITABLE_SELECTOR = '[contenteditable="true"]'

const BACKDROP_ATTR = 'data-dsh-composer-sheet-backdrop'
const PANEL_ATTR = 'data-dsh-composer-sheet-panel'
const TILES_ATTR = 'data-dsh-composer-sheet-tiles'
const TILE_ATTR = 'data-dsh-composer-sheet-tile'
const ROWS_ATTR = 'data-dsh-composer-sheet-rows'
/** 关闭按钮（×）。三条关闭路径之一，必须与点外部 / 系统返回走同一个离场动画。 */
const CLOSE_ATTR = 'data-dsh-composer-sheet-close'
const ROW_ATTR = 'data-dsh-composer-sheet-row'
/**
 * 收场动画标记：挂在 backdrop 上，CSS 据此播放「飞回视口底」的退场动画。
 *
 * 为什么要一个属性而不是直接 remove：remove() 是瞬时的，用户看不到卡片飞回去，
 * 观感上像「闪一下消失」。加了标记之后由 CSS 播 160ms，脚本等动画结束再 remove。
 * 真机 WebView 有 WAAPI（Element.getAnimations），jsdom 没有 —— 没有动画就不等，
 * 立刻 remove，测试与无动画环境的行为保持一致。
 */
const LEAVING_ATTR = 'data-dsh-composer-sheet-leaving'
/** 退场动画时长（规格 140-160ms）。与 CSS 里 dsh-composer-card-out/panel-out 同值。 */
const EXIT_ANIMATION_MS = 160
/**
 * 借用上游菜单期间，菜单外层容器上的临时隐藏标记。
 *
 * 为什么必须隐藏（而不是只「读完就关」）：读菜单要跨一次上游提交，实测在这台设备上
 * 从派发 click 到选项出现约 1.2s。这 1.2s 里上游 listbox 是**真的画在屏幕上**的 ——
 * 设备实测它 right=1022.33，而卡片 right=682.33，那一列 role=option 的副标题就露在
 * 卡片右侧外面。用户在开面板的瞬间会看到上游菜单闪一下，正是要消掉的「漏字」现象。
 *
 * 用 visibility: hidden 而不是 display: none / remove()：
 *   - display: none 会让上游的测量与定位拿到 0 尺寸，菜单可能因此改变挂载行为；
 *   - remove() 是别人的 DOM，且我们后面还要在这棵树上按索引取 option 转发 mousedown。
 * visibility: hidden 保留布局与节点身份，只是不可见 —— 合成事件仍能直接派发到节点上。
 */
const CONCEAL_ATTR = 'data-dsh-composer-sheet-concealed'

/**
 * 附件入口在行列表里的标题（中英两套文案，精确匹配的闭集）。
 *
 * 三块瓦片（拍照 / 照片 / 本地文件）已经覆盖了附件入口，上游「+」菜单里那条
 * 同义的「文件 / file」行是重复的。
 *
 * **必须是精确匹配的闭集，不能用位置或前缀**：
 *   - 按位置（li:first-child / index === 0）会连带隐掉插件插到最前面的项；
 *   - 按前缀（startsWith 文件）会误伤「文件预览」「文件管理」这类真实功能项。
 * 两条都会让用户丢功能，而不是少一条冗余项。负控用例见 composer-sheet.spec.ts。
 */
const ATTACHMENT_ROW_TITLES: ReadonlySet<string> = new Set([
  '文件', '本地文件', 'file', 'files', 'local file', 'local files',
])

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

/** 卡片里当前读得到的上游选项（菜单容器不在场时是空表）。 */
function findOptions(card: Element): HTMLElement[] {
  const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
  if (menu === null) return []
  return [...menu.querySelectorAll<HTMLElement>(UPSTREAM_OPTION_SELECTOR)]
}

/**
 * 关掉上游「+」菜单时 Escape 的派发目标。
 *
 * 上游的关闭链挂在**编辑器根元素**上（Lexical 在 contenteditable 上监听 keydown），
 * 而 document.dispatchEvent 的传播路径只有 [document, window]，根本到不了那个元素，
 * 菜单就留在屏幕上（#998）。所以在编辑器根上派发，让它自己冒泡回 document ——
 * 这样两套监听（Lexical 的元素级、MenuView 的 document 级）都能收到。
 *
 * 退化目标是 **card 本身**，这是最后手段而不是等价修法：card 也是 document 的后代，
 * 事件能冒泡到 document 级监听，所以「与旧行为等价、不会让菜单卡死」——
 * 但它**触发不了**挂在上游编辑器根上的元素级监听（Lexical 那一套）。
 * 也就是说退化只保住「菜单还能关」，保不住真正要修的那条链路；
 * 一旦上游改掉 data-composer-input，这条退化路径应当被当成待修的信号。
 * @param card - 上游合成器卡片（菜单与编辑器都挂在它里面）。
 * @returns 派发 Escape 的目标元素。
 */
function upstreamEscapeTarget(card: Element): Element {
  return card.querySelector(EDITOR_ROOT_SELECTOR) ?? card.querySelector(EDITABLE_SELECTOR) ?? card
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
   * 打开代次：每次 open() 自增，close() 也自增。
   *
   * open() 里读上游菜单的收尾是异步的，用户完全可能在它跑完之前就关掉 sheet
   * （下滑 / 点遮罩 / 返回键）。收尾一旦无条件执行，就会把**用户此刻**的焦点
   * blur 掉，正在用的键盘被凭空收回（#999）。收尾前比对代次即可识别这种过期回调。
   */
  private generation = 0
  /**
   * 被折叠的滚动容器（通常是 body）→ 打开前的 overflow 原值。
   *
   * 只存快照、关闭时按原样还原：无条件写 style.removeProperty 会把别处
   * （或用户自己）设的 overflow 一起抹掉（#1009）。
   */
  private readonly overflowSnapshot = new Map<HTMLElement, string>()

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
    panel.append(this.buildClose(t))

    backdrop.append(panel)
    document.body.append(backdrop)
    this.backdrop = backdrop
    button.setAttribute('aria-expanded', 'true')
    // 几何全部交给 CSS（居中卡片），脚本不写内联定位，因此不需要 relayout /
    // 视口变化监听：转屏后 grid + place-items: center 自动重新居中。
    this.lockBodyScroll()
    // 到这里 backdrop 已经挂到 body 上（this.backdrop 也已赋值），读菜单拿到的
    // 行才有地方写。顺序不能提前：见 fillRows 的注释。
    // issue #929：等映射读完**再**压焦点。旧实现用 `void` 丢掉了 Promise，
    // 紧接着的 blurActiveEditor() 会在读菜单**之前**跑 —— 等于又白读一次。
    const generation = this.generation
    void this.fillRows(rows).finally(() => {
      // issue #999：收尾只在「这次打开的 sheet 还开着」时做 —— 代次没变，且这块
      // backdrop 仍是当前那块、还挂在文档里。用户已经关掉的话，这里的 blur 会打断
      // 他此刻的输入（键盘自己缩回）。
      if (this.generation !== generation) return
      if (this.backdrop !== backdrop || !backdrop.isConnected) return
      if (active instanceof HTMLElement) active.blur()
      // 映射过程会开一次上游菜单、那一步会调 focusDraftEditor：再压一次焦点，
      // 保证 sheet 停留期间不会有键盘。
      this.blurActiveEditor()
      // 焦点进入第一项：必须放在**压焦点之后**。
      // 写在打开时同步段会被这里的 blurActiveEditor 清掉（实测 activeElement 退回 body）。
      // 瓦片是 <button>，focus 不会唤起软键盘（编辑器才是会被唤起的那个）。
      const first = this.panel()?.querySelector<HTMLElement>('[' + TILE_ATTR + ']')
      if (first !== null && first !== undefined) first.focus({ preventScroll: true })
    })
  }

  /**
   * 打开期间锁住背景滚动（aria-modal=true 的会话框不能滚后面那一页，#1009）。
   *
   * 选的是「快照 + 还原 body 的 overflow」：快照能保证不覆盖别处设过的值，
   * 也不引入 position:fixed 那套会重置滚动位置的副作用（键盘与滚动位置都会因此跳）。
   * 滚动锁随 close() 一起还原，所以 Sheet 不会跨开关泄留状态。
   */
  private lockBodyScroll(): void {
    if (this.overflowSnapshot.size > 0) return
    const body = document.body
    this.overflowSnapshot.set(body, body.style.overflow)
    body.style.overflow = 'hidden'
  }

  /**
   * 把上游「+」菜单临时藏起来（借用期间），返回还原函数。
   *
   * 藏的是菜单的**最外层容器**（有 [data-trigger-menu] 的那层），没有就退到 listbox
   * 本身：只藏 listbox 时，上游可能还有一个定位用的外壳留在屏幕上。
   * @param card - 上游合成器卡片（菜单挂在它里面）。
   * @returns 还原函数；没有菜单可藏时返回空操作。
   */
  private concealUpstreamMenu(card: Element): () => void {
    /** 被我们隐藏过的节点：还原时直接遍历它，不依赖节点是否还挂在 DOM 上。 */
    const pending = new Set<HTMLElement>()
    const apply = (): void => {
      const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
      if (menu === null) return
      const target = menu.closest('[data-trigger-menu]') ?? menu
      if (!(target instanceof HTMLElement)) return
      if (target.getAttribute(CONCEAL_ATTR) !== null) return
      target.setAttribute(CONCEAL_ATTR, '')
      target.style.setProperty('visibility', 'hidden', 'important')
      pending.add(target)
    }
    apply()
    // **必须持续盯，不能只在挂上之后藏一次**：菜单是异步提交进 DOM 的，
    // 等 waitForMenu 轮询到选项再藏，中间那几百毫秒到 1.2s 它已经画在屏幕上了
    // （实测正是这段窗口让上游副标题露在卡片外）。观察器让它在出现的**第一帧**
    // 就不可见：MutationObserver 回调在提交后、绘制前同步跑。
    const observer = new MutationObserver(apply)
    observer.observe(card, { childList: true, subtree: true })
    return () => {
      // **顺序是判据，不是风格**：观察器回调是微任务，会排在本函数之后。
      // 先 disconnect 再还原，否则那条排队的回调会在还原**之后**再藏一次，
      // 于是「还原」看似执行了、节点却仍然是 hidden（实测：撤掉还原代码后
      // 断言照样绿，因为两种写法最终都停在 hidden 上——那条断言当时是假绿）。
      observer.disconnect()
      // 用 pending 记录，而不是事后 querySelector：节点可能已被上游卸载（脱 DOM），
      // querySelector 就找不到它，还原也就漏掉了（那正是「脱离后仍要保持已还原」的情形）。
      for (const node of pending) {
        node.removeAttribute(CONCEAL_ATTR)
        node.style.removeProperty('visibility')
      }
      pending.clear()
    }
  }
  /**
   * 播退场动画并真正移除面板。
   *
   * 为什么不用 `animationend` 一个事件了事：动画可能因为元素不可见、
   * prefers-reduced-motion、或浏览器跳过动画而**根本不触发** animationend，
   * 那种情况下监听器永远等不到，面板就永久留在 DOM 里（比不播动画严重得多）。
   * 所以「事件」与「超时」两条路都要走，先到先算，且用幂等闸保证只 remove 一次。
   *
   * 无 WAAPI（jsdom / 老 WebView）时立刻 remove：那种环境本来就没有动画可播。
   * @param backdrop - 正在离场的遮罩（已经不再挂在 this.backdrop 上）。
   */
  private playExit(backdrop: HTMLElement): void {
    const supportsAnimations = typeof backdrop.getAnimations === 'function'
    // **必须先挂标记再取动画，顺序反了就没有退场动画**（设备实测 0 帧）：
    // getAnimations() 返回的是**当前已存在**的动画对象，而退场动画由 LEAVING_ATTR
    // 那条 CSS 规则定义。先取后挂 = 取到的是入场动画（或空集），
    // 于是「没有动画就立刻 remove」把面板直接抹掉，用户看不到收回。
    backdrop.setAttribute(LEAVING_ATTR, '')
    // subtree: true 是必须的：竖屏的退场动画挂在**子元素** panel 上，遮罩自己只有
    // backdrop-out。只查遮罩自身会漏掉 panel 那条。
    const animations = supportsAnimations ? backdrop.getAnimations({ subtree: true }) : []
    if (animations.length === 0) {
      // 无 WAAPI（jsdom / 老 WebView）或动画被浏览器跳过：立刻移除，
      // 否则面板会永久留在 DOM 里（比没有动画严重得多）。
      backdrop.remove()
      return
    }
    // 收场期间**保留**事件接收（不加 pointer-events: none）：遮罩此刻已不在 this.backdrop 上，
    // onBackdropPointerDown 会直接早退，重复点击不会再次触发 close()；
    // 而一旦关掉事件，这 160ms 里点击会穿透到背后页面（与「透明遮罩必须能接住点击」
    // 同一条理由）。要防的只是「点到半透明卡片」，那由 CSS 的 pointer-events 维持原样即可。
    let removed = false
    const finish = (): void => {
      if (removed) return
      removed = true
      backdrop.remove()
    }
    for (const animation of animations) {
      animation.addEventListener('finish', finish, { once: true })
      animation.addEventListener('cancel', finish, { once: true })
    }
    // 兜底：动画被跳过 / 被打断 / 事件丢失时也必须收场。比动画时长多留一档余量。
    window.setTimeout(finish, EXIT_ANIMATION_MS + 120)
  }
  /** 按快照还原背景滚动（没有快照就什么都不做，不无条件清空）。 */
  private restoreBodyScroll(): void {
    for (const [element, previous] of this.overflowSnapshot) {
      if (previous === '') element.style.removeProperty('overflow')
      else element.style.overflow = previous
    }
    this.overflowSnapshot.clear()
  }

  /**
   * 关闭按钮（×）。
   *
   * 存在的理由：居中卡片是模态形态，没有可见的关闭控件时用户只能靠「点外面」或
   * 系统返回；而系统返回在平板 / 多窗口下不一定贴着用户的直觉。
   *
   * **它只是三条关闭路径之一**：点它 → this.close() → playExit()（160ms 向下沉出）。
   * 点外部、系统返回（BackStackSignal 的 composer-sheet 层）走的是同一个 close()，
   * 所以三者的离场动画天然一致，不存在某条路径瞬关。
   */
  private buildClose(t: (key: ComposerSheetKey) => string): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(CLOSE_ATTR, '')
    button.setAttribute('aria-label', t('close'))
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    for (const d of ['M6 6 L18 18', 'M18 6 L6 18']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    button.append(svg)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.close()
    })
    return button
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
    for (const row of mapped) {
      // 附件入口那条（文件 / file）不复制：三块瓦片已经覆盖它。
      // 用标题精确命中而不是位置/前缀，理由见 ATTACHMENT_ROW_TITLES。
      if (ATTACHMENT_ROW_TITLES.has(row.title.trim().toLowerCase())) continue
      rows.append(this.buildRow(row))
    }
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
    // 这次借用属于哪一代：借用期间 sheet 可能已经被关掉，收尾就不能再去碰用户的焦点（#999）。
    const generation = this.generation
    // 借用闸从「派发打开」之前就合上，到**函数真正退出**才断开（#1001）：
    // 以前复位写在菜单读到之后的 finally 里，菜单没读到时那条早退路径会把它永远留在 true，
    // 用户此后再按 Escape 都关不掉 sheet。
    this.borrowing = true
    // 从**派发打开之前**就开始藏：菜单会在我们不知情的某一帧挂进 DOM，
    // 事后藏已经晚了一步（那时它已经可见过一次）。观察器在挂载那一帧就把它按下去。
    const restoreVisibility = this.concealUpstreamMenu(card)
    try {
      if (openedHere) {
        // **先把焦点还给编辑器**：上游 MenuView 绑在 draft editor 的 caret 上，编辑器
        // 不持焦点时点击「+」只置 aria-expanded、菜单节点不挂载（实机复现：同一按钮，
        // 带焦点派发 menus=1 opts=9，无焦点派发恒 0 —— sheet 的 open() 恰好总是先 blur）。
        this.refocusEditor()
        this.replaying = true
        try {
          button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        } finally {
          this.replaying = false
        }
        // 等上游把菜单**和选项**提交进 DOM：轮询到选项真的出现（或超时），
        // 单等一帧不够 —— 实测菜单在这台设备上要过一个宏任务才挂进卡片（#1002）。
        await this.waitForMenu(card)
      }
      const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
      const options = menu === null ? [] : [...menu.querySelectorAll<HTMLElement>(UPSTREAM_OPTION_SELECTOR)]
      try {
        return run(options)
      } finally {
        this.closeUpstreamMenu(card)
        restoreVisibility()
      }
    } finally {
      // 借完就还：之后用户按 Esc 必须能正常关掉 sheet。
      this.borrowing = false
      restoreVisibility()
      // 上游刚刚把焦点给了编辑器：重新压回去，键盘才不会跟着冒出来。
      // 只在 sheet 还开着这次借用的那一代时做 —— 用户已经关掉的话，这一下会把他
      // 此刻正在用的输入框 blur 掉，键盘自己缩回（#999）。
      if (this.generation === generation) this.blurActiveEditor()
    }
  }

  /**
   * 用上游自己的关法收起「+」菜单（不直接 remove 别人的 DOM）。
   *
   * Escape 必须派发到编辑器根元素：document.dispatchEvent 的传播路径只有
   * [document, window]，到不了 Lexical 挂在编辑器上的 keydown，菜单不卸载（#998）。
   *
   * **不区分菜单是谁开的**：用户直接点「+」时菜单由上游自己打开（openedHere=false），
   * 旧实现据此直接 return，结果上游 listbox 一直浮在页面上 —— 卡片开着的时候，
   * 它那一列 role=option 的副标题就露在卡片右侧外面（2026-10-30 设备实测：
   * listbox left=318 right=1022，卡片 right=682）。菜单留着没有正当用途：
   * 卡片已经把同样的项映射成自己的行，两个列表同时在屏上只会互相遮挡。
   * @param card - 上游合成器卡片。
   */
  private closeUpstreamMenu(card: Element): void {
    const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
    // 已经关掉了（用户自己按了 Esc / 点掉了）：不再空派发。
    if (menu === null || !menu.isConnected) return
    upstreamEscapeTarget(card).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
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
        // 判据必须是**选项**，不能只看容器：上游常先提交容器、下一帧才填 [role=option]，
        // 只等容器会在这两帧之间 resolve，读到的是一张空表（#1002）。
        if (findOptions(card).length > 0 || waited >= MENU_WAIT_TIMEOUT_MS) {
          resolve()
          return
        }
        waited += MENU_POLL_INTERVAL_MS
        setTimeout(step, MENU_POLL_INTERVAL_MS)
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
    // 先让代次失效：open() 里还在跑的 fillRows 收尾拿到的是旧代次，之后一律不再碰焦点（#999）。
    this.generation += 1
    // 关掉 sheet 时借用一定结束：万一借用段还没走到自己的 finally，这里的复位
    // 保证 Escape 立刻可用（#1001）。
    this.borrowing = false

    if (this.backdrop !== null) {
      // 先摘掉引用，再播退场动画：close() 是同步语义（调用方回来时面板状态已归零），
      // 动画只是视觉上的余韵，不能让它决定「关没关」。
      const leaving = this.backdrop
      this.backdrop = null
      this.playExit(leaving)
      if (this.addButton !== null) {
        if (this.previousExpanded === null) this.addButton.removeAttribute('aria-expanded')
        else this.addButton.setAttribute('aria-expanded', this.previousExpanded)
      }
      this.previousExpanded = null
    }
    this.restoreInputMode()
    this.restoreBodyScroll()
  }
}
