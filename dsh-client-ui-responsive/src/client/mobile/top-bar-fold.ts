import { HeaderPopups } from './header-popups.ts'

/**
 * 竖屏顶栏插件 UI 折叠（0.14.7 / Spec 2.6）。
 *
 * ## 折叠对象
 * 上游把会话标题栏的插件 UI 渲染进 `conversation.session.header.actions` 座位
 * （ConversationSession.tsx:127-129 → div.headerActions）。真机实测该座位下当前有两个
 * 节点：ui-agent-preset 的模式标签（span，显示「标准模式」）与 vendor dsh-undo-savepoint
 * 的快照徽章（div[data-undo-header]）。本折叠读的是「座位里实际有什么」，不是插件名单 ——
 * 新插件经同一座位挂载即自动进入面板，也不存在漏登记某个插件的缺陷形态。
 *
 * ## 为什么不搬节点
 * 座位内容由 React 拥有；把节点搬进自建面板容器会让 React 的插入位置与实际 DOM 失配
 * （下一次列表变化时它按自己的父节点重排，形成抖动 / 丢状态）。这里改为**只换座位容器
 * 自己的呈现方式**：关闭时整块 display:none，打开时整块 position:fixed 成浮动面板。
 * React 树完全没有被改动，因此状态、生命周期与注册次数都不受影响。
 *
 * ## 形态门
 * 仅手机竖屏（html[data-dsh-mobile-form]，即 <=767px）。横屏 1600px 不命中该标记，
 * attach 会先解除所有标记恢复上游原样，因此横屏行为与改动前逐像素一致。
 */

/** 上游标题栏插件 UI 的座位（稳定属性，非 hashed 类名）。 */
const ACTIONS_SELECTOR = 'div[data-slot="conversation.session.header.actions"]'
/** 上游视图标签条（ConversationSession.tsx:143 的稳定锚点）。箭头挂在**它内部**末位。 */
const TABS_SELECTOR = '[data-conversation-tabs]'
/** 承载标题行 containment 的那一行（上游 .titleRow 带 container-type: inline-size）。 */
const TITLE_ROW_FALLBACK = 'div[data-slot="conversation.session.header"] > div'
/** 插件 UI 自身可能自绘的定位：折叠后必须由面板接管，否则会脱离面板跑到视口某处。 */
const OWN_POSITION_VARS = ['position', 'left', 'right', 'top', 'bottom', 'z-index'] as const

/** 手机形态判据（与 form-marker.ts 的 767px 单一来源一致）。 */
const MOBILE_QUERY = '(max-width: 767px)'

/** 折叠状态挂在容器上的属性；CSS 按它切换两种呈现。 */
const FOLD_ATTR = 'data-dsh-topbar-fold'
/** 去 containment 的标记类（内联写在标题行上，见 snapshot-panels 的同一先例）。 */
const UNCONTAINED_ATTR = 'data-dsh-topbar-fold-uncontained'
/** 折叠箭头的标记属性。 */
const ARROW_ATTR = 'data-dsh-topbar-fold-arrow'

interface Target {
  /** 标题栏插件 UI 的座位容器。 */
  readonly container: HTMLElement
  /** 承载 containment 的标题行（面板的 containing block 来源）。 */
  readonly titleRow: HTMLElement | null
}

/** 箭头图形：紧凑的向下雪佛龙。 */
function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M4 6.5 8 10.5 12 6.5')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/**
 * 折叠标题栏里经现有座位注册的插件 UI。
 * attach 挂 MutationObserver 与全局事件，detach 彻底恢复上游原样。
 */
export class TopBarFold {
  private readonly headerPopups = new HeaderPopups()
  private observer: MutationObserver | null = null
  /**
   * 形态标记的专用观察者：只盯 `<html>` 自己那一个属性（subtree 关闭）。
   * 竖屏切横屏时 form-marker 改写该属性，而**属性变化不触发任何事件** ——
   * 只靠 resize / media change 会在没有窗口尺寸变化的切换里漏掉，导致折叠状态残留。
   * 观察范围刻意不含 body：否则我们自己写的面板属性会反过来喂给自己，形成自激循环。
   */
  private formObserver: MutationObserver | null = null
  private media: MediaQueryList | null = null
  private open = false
  /** 本节流里被我们接管过的容器（收起 / 解除时必须逐项还原）。 */
  private container: HTMLElement | null = null
  private titleRow: HTMLElement | null = null
  private arrow: HTMLButtonElement | null = null
  private arrowHost: HTMLElement | null = null
  /** 容器上被我们覆盖掉的内联样式原值，解除时逐项写回。 */
  private readonly styleSnapshot = new Map<string, string>()
  private scheduled = false
  /** 上一次真正写进 DOM 的呈现状态（折叠开关 + 容器 + 标题行 + 箭头），见 syncState()。 */
  private written: readonly [boolean, HTMLElement | null, HTMLElement | null, HTMLButtonElement | null] | null = null

  private readonly onDocumentPointerDown = (event: Event): void => {
    if (!this.open) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[' + ARROW_ATTR + ']') !== null) return
    if (this.container !== null && this.container.contains(target)) return
    this.setOpen(false)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.open) this.setOpen(false)
  }

  private readonly onViewportChange = (): void => { this.schedule() }

  /** 开始观察标题栏；非手机竖屏时什么都不做。 */
  attach(): void {
    this.headerPopups.attach()
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null
    this.observer = new MutationObserver(() => { this.schedule() })
    this.observer.observe(document.body, { childList: true, subtree: true })
    this.formObserver = new MutationObserver(() => { this.schedule() })
    this.formObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dsh-mobile-form'],
    })
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true)
    document.addEventListener('mousedown', this.onDocumentPointerDown, true)
    document.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onViewportChange)
    window.addEventListener('scroll', this.onViewportChange, true)
    this.media?.addEventListener('change', this.onViewportChange)
    this.schedule()
  }

  /** 解除折叠并清理监听（HMR 安全：不留 document 监听，不改动 React 节点）。 */
  detach(): void {
    this.headerPopups.detach()
    this.observer?.disconnect()
    this.observer = null
    this.formObserver?.disconnect()
    this.formObserver = null
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true)
    document.removeEventListener('mousedown', this.onDocumentPointerDown, true)
    document.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('scroll', this.onViewportChange, true)
    this.media?.removeEventListener('change', this.onViewportChange)
    this.media = null
    this.restore()
  }

  /** Coalesce DOM churn into one pass per frame. */
  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.sync()
    })
  }

  /** 形态门 + 单次同步。 */
  private sync(): void {
    if (!this.isMobileForm()) {
      this.restore()
      return
    }
    const target = this.resolve()
    if (target === null) {
      // 标题栏还没挂载（或该会话没有标题栏）：先清干净，等下一轮 mutation 再来。
      this.restore()
      return
    }
    if (this.container !== target.container) {
      // 换了一个座位容器（会话切换 / 上游重挂）：把旧的完全还原后再接管新的。
      this.restore()
      this.container = target.container
      this.titleRow = target.titleRow
      this.snapshotStyles(target.container)
    } else if (this.titleRow !== target.titleRow) {
      this.setTitleRowUncontained(false)
      this.titleRow = target.titleRow
    }
    this.ensureArrow()
    // 重进手机竖屏默认收起（Spec 2.6）：容器换新时 this.open 未变，但首次接管必须从收起开始。
    //
    // 审计 §7.9：样式写入只在 open 边沿执行。这里不再无条件调 applyOpen() ——
    // 每批 DOM 变更都重写一遍容器属性、六个定位属性与标题行标记，等于把「状态没变」
    // 也当成「要重排」。现在由 syncState() 记住上一次写进 DOM 的状态，只有它真的变了
    // （含容器换新、箭头重建）才写。
    this.syncState()
    // 读与写分离：measure() 只读几何、只写定位属性，且只在打开态有意义。
    this.measure()
  }

  /**
   * 把「当前应有的呈现状态」与「上一次真正写进 DOM 的状态」比对，只在边沿写 DOM。
   *
   * 状态元组 = 折叠开关 + 容器 + 标题行 + 箭头。任何一项变化都必须重写（容器换新时
   * 属性写在旧容器上等于没写；箭头重建后 aria 属性要补），其余情况一次 DOM 写入都不做。
   */
  private syncState(): void {
    const container = this.container
    if (container === null) return
    const state = [this.open, this.container, this.titleRow, this.arrow] as const
    if (this.written !== null && this.written.every((value, index) => value === state[index])) return
    this.written = state
    this.applyOpen()
  }

  /** 是否手机竖屏形态（与 form-marker.ts 的单一来源一致）。 */
  private isMobileForm(): boolean {
    if (document.documentElement.hasAttribute('data-dsh-mobile-form')) return true
    return this.media?.matches === true
  }

  /** 解析折叠目标；标题栏不在场时返回 null。 */
  private resolve(): Target | null {
    const container = document.querySelector<HTMLElement>(ACTIONS_SELECTOR)
    if (container === null) return null
    const header = container.closest('header')
    if (header === null) return null
    const titleRow = container.closest<HTMLElement>(TITLE_ROW_FALLBACK)
      ?? header.querySelector<HTMLElement>('div[data-slot="conversation.session.header"] > div')
    return { container, titleRow }
  }

  /** 记录我们即将覆盖的内联样式原值（解除时逐项写回）。 */
  private snapshotStyles(element: HTMLElement): void {
    this.styleSnapshot.clear()
    for (const name of OWN_POSITION_VARS) {
      this.styleSnapshot.set(name, element.style.getPropertyValue(name))
    }
    this.styleSnapshot.set('--dsh-topbar-fold-max-height', element.style.getPropertyValue('--dsh-topbar-fold-max-height'))
  }

  /**
   * 确保折叠箭头是**标签行**的最后一个元素（标签行不在场则不动）。
   *
   * 挂到 `[data-conversation-tabs]` 的**父节点**而不是它自己：标签条是 React 拥有的列表
   * （`visibleViewLimit` 变化时它会往自己末尾插标签）。箭头一旦进了标签条内部，React 下一次
   * 追加标签就会插到箭头**之后**，箭头看起来就夹在两个视图标签中间了。父节点是那一行容器
   * （`div.tabs`），React 不往那里插标签，箭头待得住。
   *
   * 「末位」每次同步都要重新确认，不能只在首次挂载时确认一次：React 可能在我们插入之后
   * 又往行尾追加节点（例如「…」菜单晚一步出现），箭头就不再是最右了。
   */
  private ensureArrow(): void {
    // 挂进标签条**本身**，不是它的父行。
    //
    // 父行里还有「…」菜单等兄弟节点，把箭头 append 到父行只能保证它是**父行**的末位，
    // 与「标签行最右侧」不是一回事（实机实测：父行末位时箭头 x=548，视口宽 600，
    // 而最后一个标签的右边界只有 112，中间空出整段）。挂进标签条后箭头紧贴最后一个
    // 标签，才是需求说的位置。
    const host = document.querySelector<HTMLElement>(TABS_SELECTOR)
    if (host === null) return
    if (this.arrow !== null && this.arrowHost === host && host.lastElementChild === this.arrow) return
    // 方向对但位置不是末位：原地重挂即可，不必重建按钮（保焦点/保已绑监听）。
    if (this.arrow !== null && this.arrowHost === host) {
      host.appendChild(this.arrow)
      return
    }
    this.removeArrow()
    const arrow = document.createElement('button')
    arrow.type = 'button'
    arrow.setAttribute(ARROW_ATTR, '')
    arrow.setAttribute('aria-expanded', 'false')
    arrow.setAttribute('aria-label', this.foldLabel())
    arrow.appendChild(chevron())
    arrow.addEventListener('click', this.onArrowClick)
    host.appendChild(arrow)
    this.arrow = arrow
    this.arrowHost = host
  }

  private readonly onArrowClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    this.setOpen(!this.open)
  }

  /** 本地化的箭头无障碍名（本插件自有文案，无上游文案依赖）。 */
  private foldLabel(): string {
    const language = (document.documentElement.lang || navigator.language || '').toLowerCase()
    if (language.startsWith('zh')) return this.open ? '收起插件工具' : '展开插件工具'
    return this.open ? 'Collapse plugin tools' : 'Expand plugin tools'
  }

  private removeArrow(): void {
    if (this.arrow !== null) this.arrow.removeEventListener('click', this.onArrowClick)
    this.arrow?.remove()
    this.arrow = null
    this.arrowHost = null
    // 箭头没了：缓存里的「已写状态」作废，下一次 syncState() 必须重写。
    this.written = null
  }

  /** 打开 / 收起面板（用户手势：状态边沿，必须写 DOM）。 */
  private setOpen(next: boolean): void {
    this.open = next
    this.written = null
    this.syncState()
    // 只读后写：先记下打开态的几何，再让下一次 resolve/measure 按新状态写入定位。
    this.measure()
  }

  /** 把当前状态写进 DOM（容器属性 + 箭头状态 + 标题行 containment）。 */
  private applyOpen(): void {
    const container = this.container
    if (container === null) return
    container.setAttribute(FOLD_ATTR, this.open ? 'open' : 'closed')
    // 打开时由 measure() 写定位；收起时写回接管前的原值（不是一律删空 ——
    // 那会连上游/插件自己原本写在这条容器上的内联样式一起抹掉）。
    for (const name of OWN_POSITION_VARS) {
      if (this.open) container.style.setProperty(name, '')
      else {
        const original = this.styleSnapshot.get(name) ?? ''
        if (original === '') container.style.removeProperty(name)
        else container.style.setProperty(name, original)
      }
    }
    if (!this.open) {
      const originalCap = this.styleSnapshot.get('--dsh-topbar-fold-max-height') ?? ''
      if (originalCap === '') container.style.removeProperty('--dsh-topbar-fold-max-height')
      else container.style.setProperty('--dsh-topbar-fold-max-height', originalCap)
    }
    this.arrow?.setAttribute('aria-expanded', this.open ? 'true' : 'false')
    const label = this.foldLabel()
    if (this.arrow !== null && this.arrow.getAttribute('aria-label') !== label) {
      this.arrow.setAttribute('aria-label', label)
    }
    this.setTitleRowUncontained(this.open)
  }

  /**
   * 打开面板时解除标题行的 containment：上游 .titleRow 的 container-type: inline-size
   * 会成为 fixed 后代的 containing block，把面板困在那条约 30px 高的行里。
   * 与 snapshot-panels.css.ts 处理同一问题的做法一致（同一个先例，不新造手法）。
   */
  private setTitleRowUncontained(on: boolean): void {
    const row = this.titleRow
    if (row === null) return
    if (on) row.setAttribute(UNCONTAINED_ATTR, '')
    else row.removeAttribute(UNCONTAINED_ATTR)
  }

  /**
   * 按头部实测写入面板的水平范围与限高（不推动内容：面板是 fixed 覆盖层）。
   *
   * 审计 §7.9：读后写不要交错。原来每写一个属性就夹着下一次读取的输入，
   * 七个 style 写入与 rect / 视口读取混在一起；现在先把四段几何**全部读完**算好，
   * 再一次性写入 —— 中间没有任何布局读取，浏览器不会因此在同一帧里反复重排。
   * 值没变就跳过写入：即使进了 measure()，稳态也不再触发样式失效。
   */
  private measure(): void {
    const container = this.container
    if (container === null || !this.open) return
    const anchor = container.closest('header') ?? container.parentElement
    if (anchor === null) return
    // ── 读阶段：只读，不写 ──
    const rect = anchor.getBoundingClientRect()
    const clientWidth = document.documentElement.clientWidth
    const visible = window.visualViewport
    const viewportBottom = visible !== null && visible !== undefined
      ? Math.round(visible.offsetTop + visible.height)
      : Math.round(window.innerHeight)
    // ── 算阶段 ──
    const top = String(Math.round(rect.bottom)) + 'px'
    const left = String(Math.round(rect.left) + 12) + 'px'
    const right = String(Math.round(Math.max(12, clientWidth - rect.right + 12))) + 'px'
    // 限高到视口底部（留 12px）：内容更多时由面板内部滚动，而不是盖住输入框。
    const maxHeight = String(Math.max(96, viewportBottom - Math.round(rect.bottom) - 24)) + 'px'
    // ── 写阶段：只在值真的变了时写 ──
    this.setStyle(container, 'top', top)
    this.setStyle(container, 'left', left)
    this.setStyle(container, 'right', right)
    this.setStyle(container, '--dsh-topbar-fold-max-height', maxHeight)
  }

  /** 值没变就不写：样式写入本身会触发样式失效，稳态下应当一次都不发生。 */
  private setStyle(element: HTMLElement, name: string, value: string): void {
    if (element.style.getPropertyValue(name) === value) return
    element.style.setProperty(name, value)
  }

  /** 完全还原上游原样（状态、内联样式、标记、箭头）。 */
  private restore(): void {
    this.removeArrow()
    this.setTitleRowUncontained(false)
    const container = this.container
    if (container !== null) {
      container.removeAttribute(FOLD_ATTR)
      for (const [name, value] of this.styleSnapshot) {
        if (value === '') container.style.removeProperty(name)
        else container.style.setProperty(name, value)
      }
    }
    this.styleSnapshot.clear()
    this.container = null
    this.titleRow = null
    this.open = false
    // 接管关系已经拆掉：下次接管必须重新写一遍 DOM。
    this.written = null
  }
}

