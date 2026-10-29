/** Disclosure navigation over the existing dock: only chrome is adapted, never tab bodies. */
import type { TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { WORKSPACE_MAX_WIDTH, DRAG_SAFE_PX, DRAG_DWELL_MS, type WorkspaceNavigation } from './mobile-workspaces.ts'
import type {} from './sidebar-bubbles.locales.ts'

/**
 * 0.14.9：面板收起时也保持挂载。悬浮气泡头（.dsh-bubble-header）现在随内容一起滑入滑出
 * （sidebar-bubbles.css.ts 的 translateX 收起态），若仍按「打开才挂载」，收起提交的一瞬间
 * 节点就被移除，CSS 过渡无从播放 —— 用户看到的就是顶栏瞬移消失。面板本体在上游收起时
 * 本来就不卸载（dock 内容整体平移到右边缘外），所以挂载生命周期改跟随面板节点本身；
 * 交互入口仍由 current() 按 data-sidebar-right-open 把关。
 */
const PANEL = '[data-sidebar-right-panel]'
const STRIP = '[data-dockkit-host="dock"] [data-dockkit-strip]'
const OWN = '[data-dsh-bubble-nav]'
const PRESS_MS = 400
const SLOP = 10
let nextId = 0

/** Additive engine adapter; it commits the existing placeTab action in the same pane. */
export interface BubbleReorderFace {
  reorderIn(session: SessionId, tab: TabId, before: TabId | undefined): boolean
}
export interface SidebarBubblesOptions {
  readonly session: () => SessionId | undefined
  readonly tabs: (session: SessionId) => readonly TabRecord[]
  readonly reorder: BubbleReorderFace['reorderIn']
  readonly workspaces?: WorkspaceNavigation
  readonly t: TranslateNS<'androidSidebarBubbles'>
  /**
   * 顶栏「全屏 / 退出全屏」的直调通道（0.14.9）。
   *
   * 不能走 `original.click()`：上游 `toggleFullscreen` 用 `document.activeElement` 解析目标，
   * 而代理按钮挂在面板内（`[data-sidebar-right-session]` 之下），上游把这种"面板内但不在
   * 窗格里"的元素判为过期侧栏标记、直接返回 undefined —— 代理点击永远空转（实机验证：
   * 横屏停靠列点「全屏」无任何反应）。装配方用服务 API 直调，目标取挂载会话的活动停靠窗格。
   */
  readonly toggleFullscreen?: () => void
}
interface BubbleTab {
  record: TabRecord
  source: HTMLElement
  pane: string
  selected: boolean
  close: HTMLButtonElement | null
}
interface Row {
  element: HTMLLIElement
  select: HTMLButtonElement
  label: HTMLSpanElement
  close: HTMLButtonElement
  signature: string
}
interface Press {
  pointer: number
  tab: TabId
  x: number
  y: number
  latestX: number
  latestY: number
  active: boolean
  startScroll: number
  before: TabId | undefined
  valid: boolean
  outsideSince?: number
  workspaceDrop?: boolean
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}
function button(className: string): HTMLButtonElement {
  const node = element('button', className)
  node.type = 'button'
  return node
}
function glyph(kind: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('dsh-bubble-icon')
  const paths: Record<string, string> = {
    conversation: 'M3 3h14v10H9l-5 4v-4H3z',
    browser: 'M3 3h14v14H3zM3 7h14M6 5h1M9 5h1',
    terminal: 'M3 3h14v14H3zM6 7l3 3-3 3m5 0h3',
    vdisplay: 'M2 3h16v11H2zM10 14v3m-4 0h8',
    close: 'm6 6 8 8M14 6l-8 8',
    tool: 'M3 3h6v6H3zm8 0h6v6h-6zM3 11h6v6H3zm8 0h6v6h-6z',
    dots: 'M4 9h1v2H4zM9.5 9h1v2h-1zM15 9h1v2h-1z',
  }
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[kind] ?? paths.tool)
  path.setAttribute('fill', kind === 'dots' ? 'currentColor' : 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.4')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}
function typeOf(kind: string): 'conversation' | 'browser' | 'terminal' | 'vdisplay' | 'tool' {
  if (kind.includes('conversation') || kind.includes('subagent')) return 'conversation'
  if (kind.includes('browser')) return 'browser'
  if (kind.includes('terminal')) return 'terminal'
  if (kind.includes('vdisplay') || kind.includes('virtual')) return 'vdisplay'
  return 'tool'
}
/** Copy display-only title markup, excluding duplicate DOM identities and interactive controls. */
function cloneTitle(source: HTMLElement): Node {
  const original = source.querySelector('[data-dockkit-tab-title]') ?? source.firstElementChild
  if (original === null) return document.createTextNode(source.textContent ?? '')
  const clone = original.cloneNode(true) as Element
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of [...node.getAttributeNames()]) {
      if (name === 'id' || name === 'tabindex' || name === 'aria-controls' || name.startsWith('data-dockkit') || name.startsWith('data-sidebar-right')) node.removeAttribute(name)
    }
  }
  for (const control of clone.querySelectorAll('button, input, a, select, textarea')) control.remove()
  return clone
}

/** A reversible DOM enhancer. The native strip remains the order, title and close-eligibility source. */
export class SidebarBubbles {
  private attached = false
  private observer: MutationObserver | null = null
  private panelResize: ResizeObserver | null = null
  private collapseTimer: number | null = null
  private media: MediaQueryList | null = null
  private frame: number | null = null
  private panel: HTMLElement | null = null
  private owner: SessionId | undefined
  private header: HTMLDivElement | null = null
  private heading: HTMLDivElement | null = null
  private toggle: HTMLButtonElement | null = null
  private popover: HTMLElement | null = null
  private list: HTMLUListElement | null = null
  private actions: HTMLDivElement | null = null
  private mask: HTMLDivElement | null = null
  private status: HTMLDivElement | null = null
  private rows = new Map<TabId, Row>()
  private native = new Map<HTMLElement, string | null>()
  private tabs: BubbleTab[] = []
  private controls = ''
  private controlSources: HTMLButtonElement[] = []
  private open = false
  private press: Press | null = null
  private pressTimer: number | null = null
  private scrollFrame: number | null = null
  private suppressClick = false
  private ghost: HTMLElement | null = null

  constructor(private readonly options: SidebarBubblesOptions) {}

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.media = window.matchMedia?.('(max-width: ' + WORKSPACE_MAX_WIDTH + 'px)') ?? null
    this.media?.addEventListener?.('change', this.refresh)
    this.observer = new MutationObserver(records => {
      if (records.some(record => this.relevant(record))) this.refresh()
    })
    this.observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['data-dsh-mobile-form', 'data-sidebar-right-open', 'data-sidebar-right-session', 'data-dockkit-pane-active', 'aria-selected', 'aria-label', 'disabled', 'hidden', 'class', 'style'],
    })
    window.addEventListener('resize', this.refresh)
    window.visualViewport?.addEventListener('resize', this.refresh)
    window.visualViewport?.addEventListener('scroll', this.refresh)
    document.addEventListener('keydown', this.onKeyDown, true)
    document.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('pointermove', this.onPointerMove, true)
    document.addEventListener('pointerup', this.onPointerUp, true)
    document.addEventListener('pointercancel', this.onPointerCancel, true)
    document.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true })
    document.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false })
    document.addEventListener('click', this.onClick, true)
    document.addEventListener('contextmenu', this.onContextMenu, true)
    document.addEventListener('wheel', this.onWheel, true)
    window.addEventListener('blur', this.onPointerCancel)
    this.sync()
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    this.media?.removeEventListener?.('change', this.refresh)
    this.media = null
    window.removeEventListener('resize', this.refresh)
    window.visualViewport?.removeEventListener('resize', this.refresh)
    window.visualViewport?.removeEventListener('scroll', this.refresh)
    document.removeEventListener('keydown', this.onKeyDown, true)
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('pointerup', this.onPointerUp, true)
    document.removeEventListener('pointercancel', this.onPointerCancel, true)
    document.removeEventListener('touchstart', this.onTouchStart, true)
    document.removeEventListener('touchmove', this.onTouchMove, true)
    document.removeEventListener('click', this.onClick, true)
    document.removeEventListener('contextmenu', this.onContextMenu, true)
    document.removeEventListener('wheel', this.onWheel, true)
    window.removeEventListener('blur', this.onPointerCancel)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.unmount()
  }

  readonly refresh = (): void => {
    if (!this.attached || this.frame !== null) return
    this.frame = requestAnimationFrame(() => { this.frame = null; this.sync() })
  }

  private relevant(record: MutationRecord): boolean {
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    if (target?.closest(OWN)) return false
    if (target?.closest('[data-dockkit-strip]')) return true
    if (record.type === 'attributes') return target === document.documentElement || target?.hasAttribute('data-sidebar-right-panel') === true || target?.hasAttribute('data-dockkit-pane') === true || record.attributeName === 'hidden'
    return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('[data-sidebar-right-panel], [data-dockkit-strip]') || node.querySelector('[data-sidebar-right-panel], [data-dockkit-strip]') !== null))
  }

  private sync(): void {
    const owner = this.options.session()
    const narrow = this.media?.matches ?? window.innerWidth <= WORKSPACE_MAX_WIDTH
    const panel = narrow && owner !== undefined
      ? [...document.querySelectorAll<HTMLElement>(PANEL)].find(node => node.getAttribute('data-sidebar-right-session') === owner && node.closest('[hidden]') === null) ?? null : null
    if (panel !== this.panel || owner !== this.owner) {
      this.unmount()
      if (panel && owner !== undefined) this.mount(panel, owner)
    }
    if (!this.panel || this.owner === undefined) return
    this.toggle?.setAttribute('aria-label', this.options.t('toggle'))
    this.popover?.setAttribute('aria-label', this.options.t('tabs'))
    if (this.list) this.list.title = this.options.t('reorder')
    for (const [strip, aria] of this.native) if (!strip.isConnected || !this.panel.contains(strip)) {
      strip.removeAttribute('data-dsh-bubble-native')
      if (aria === null) strip.removeAttribute('aria-hidden'); else strip.setAttribute('aria-hidden', aria)
      this.native.delete(strip)
    }
    const records = new Map(this.options.tabs(this.owner).map(tab => [tab.id, tab]))
    this.tabs = [...this.panel.querySelectorAll<HTMLElement>(STRIP)].flatMap(strip => {
      if (!this.native.has(strip)) {
        this.native.set(strip, strip.getAttribute('aria-hidden'))
        strip.setAttribute('data-dsh-bubble-native', '')
        strip.setAttribute('aria-hidden', 'true')
      }
      const pane = strip.getAttribute('data-dockkit-strip') ?? ''
      return [...strip.querySelectorAll<HTMLElement>('[data-dockkit-tab]')].flatMap(source => {
        const id = source.getAttribute('data-dockkit-tab') as TabId
        const record = this.options.workspaces?.hiddenTabs.has(id) ? undefined : records.get(id)
        return record ? [{ record, source, pane, selected: source.getAttribute('aria-selected') === 'true', close: source.querySelector<HTMLButtonElement>('[data-dockkit-tab-close]') }] : []
      })
    })
    if (this.press && !this.tabs.some(tab => tab.record.id === this.press?.tab)) this.cancelPress()
    this.syncRows()
    const current = this.tabs.find(tab => tab.record.id === this.options.workspaces?.activeId) ?? this.tabs.find(tab => tab.selected && tab.source.closest('[data-dockkit-pane-active]')) ?? this.tabs.find(tab => tab.selected) ?? this.tabs[0]
    if (current && this.heading) {
      const signature = current.source.querySelector('[data-dockkit-tab-title]')?.innerHTML ?? current.record.title
      if (this.heading.dataset.title !== signature) {
        this.heading.replaceChildren(cloneTitle(current.source))
        this.heading.dataset.title = signature
      }
      this.heading.title = current.record.title
    }
    this.syncControls(current)
    this.measure()
  }

  private mount(panel: HTMLElement, owner: SessionId): void {
    this.panel = panel
    this.owner = owner
    panel.setAttribute('data-dsh-bubble-panel', '')
    if (typeof ResizeObserver !== 'undefined') {
      this.panelResize = new ResizeObserver(this.refresh)
      this.panelResize.observe(panel)
    }
    const header = this.header = element('div', 'dsh-bubble-header')
    header.setAttribute('data-dsh-bubble-nav', '')
    this.heading = element('div', 'dsh-bubble-heading')
    this.toggle = button('dsh-bubble-control')
    this.toggle.setAttribute('data-dsh-sidebar-bubbles-toggle', '')
    this.toggle.setAttribute('aria-label', this.options.t('toggle'))
    this.toggle.setAttribute('aria-expanded', 'false')
    this.toggle.append(glyph('dots'))
    this.toggle.addEventListener('click', () => { this.setOpen(!this.open, this.open) })
    header.append(this.heading, this.toggle)
    const popover = this.popover = element('nav', 'dsh-bubble-popover')
    popover.setAttribute('data-dsh-bubble-nav', '')
    popover.setAttribute('data-state', 'closed')
    popover.setAttribute('aria-label', this.options.t('tabs'))
    popover.setAttribute('aria-hidden', 'true')
    popover.setAttribute('inert', '')
    popover.id = 'dsh-sidebar-bubbles-' + (++nextId)
    this.toggle.setAttribute('aria-controls', popover.id)
    this.list = element('ul', 'dsh-bubble-list')
    this.list.title = this.options.t('reorder')
    this.actions = element('div', 'dsh-bubble-actions')
    this.status = element('div', 'dsh-bubble-status')
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    popover.append(this.list, this.actions, this.status)
    this.mask = element('div', 'dsh-bubble-mask')
    this.mask.hidden = true
    this.mask.setAttribute('data-dsh-bubble-nav', '')
    this.mask.setAttribute('aria-hidden', 'true')
    this.mask.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); this.setOpen(false, true)
    })
    panel.append(this.mask, popover, header)
  }

  private unmount(): void {
    this.cancelPress()
    this.panelResize?.disconnect(); this.panelResize = null
    if (this.collapseTimer !== null) clearTimeout(this.collapseTimer)
    this.collapseTimer = null
    this.open = false
    for (const [strip, aria] of this.native) {
      strip.removeAttribute('data-dsh-bubble-native')
      if (aria === null) strip.removeAttribute('aria-hidden')
      else strip.setAttribute('aria-hidden', aria)
    }
    this.native.clear()
    this.panel?.removeAttribute('data-dsh-bubble-panel')
    this.header?.remove(); this.popover?.remove(); this.mask?.remove()
    this.panel = null; this.owner = undefined; this.header = null; this.heading = null
    this.toggle = null; this.popover = null; this.list = null; this.mask = null; this.actions = null; this.status = null
    document.documentElement.removeAttribute('data-dsh-popover-open')
    this.rows.clear(); this.tabs = []; this.controls = ''; this.controlSources = []; this.suppressClick = false
  }

  private syncRows(): void {
    if (!this.list) return
    const ids = new Set(this.tabs.map(tab => tab.record.id))
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.element.remove(); this.rows.delete(id) }
    this.tabs.forEach((tab, index) => {
      const id = tab.record.id
      let row = this.rows.get(id)
      if (!row) {
        const item = element('li', 'dsh-bubble-row')
        item.setAttribute('data-dsh-bubble-tab', id)
        const select = button('dsh-bubble-select')
        select.setAttribute('data-dsh-bubble-select', id)
        const label = element('span', 'dsh-bubble-label')
        if (!tab.source.querySelector('[data-dockkit-tab-title] svg')) select.append(glyph(typeOf(tab.record.kind)))
        select.append(label)
        select.addEventListener('click', () => { this.choose(id) })
        const close = button('dsh-bubble-close')
        close.append(glyph('close'))
        close.addEventListener('click', () => { this.closeTab(id) })
        item.append(select, close)
        row = { element: item, select, label, close, signature: '' }
        this.rows.set(id, row)
      }
      const signature = tab.source.querySelector('[data-dockkit-tab-title]')?.innerHTML ?? tab.record.title
      if (row.signature !== signature) { row.label.replaceChildren(cloneTitle(tab.source)); row.signature = signature }
      row.select.setAttribute('aria-label', this.options.t(typeOf(tab.record.kind)) + ': ' + (row.label.textContent || tab.record.title))
      row.select.setAttribute('aria-pressed', String(tab.selected))
      row.select.title = row.label.textContent || tab.record.title
      row.close.setAttribute('aria-label', this.options.t('close', { title: row.label.textContent || tab.record.title }))
      row.close.hidden = tab.close === null
      row.element.toggleAttribute('data-selected', tab.selected)
      const focused = tab.record.id === this.options.workspaces?.activeId
      row.element.toggleAttribute('data-focused', focused)
      row.select.setAttribute('aria-description', tab.selected ? (focused ? '当前输入工作区' : '另一工作区显示中') : '')
      let focusLabel = row.select.querySelector<HTMLElement>('.dsh-bubble-focus-label')
      if (!focusLabel && this.options.workspaces) { focusLabel = element('small', 'dsh-bubble-focus-label'); row.select.append(focusLabel) }
      if (focusLabel) focusLabel.textContent = focused && tab.selected ? '当前' : ''
      row.element.toggleAttribute('data-group-start', index > 0 && this.tabs[index - 1].pane !== tab.pane)
      row.element.style.setProperty('--dsh-bubble-index', String(index))
      row.element.style.setProperty('--dsh-bubble-delay', Math.min(index, 7) * 8 + 'ms')
      if (this.list?.children[index] !== row.element) this.list?.insertBefore(row.element, this.list.children[index] ?? null)
    })
  }

  private syncControls(current: BubbleTab | undefined): void {
    if (!this.panel || !this.header || !this.actions || !this.toggle) return
    const originals = [...this.panel.querySelectorAll<HTMLButtonElement>(STRIP + ' button')].filter(node => {
      // 0.14.9：workspaces 档也要代理条带上的「新建标签」（data-dockkit-add-tab）。此前只保留
      // 两个窗格控制，原生条带又被气泡层隐藏，移动端根本没有新建标签的入口 —— 只能绕回
      // 开始页去开标签。
      if (this.options.workspaces && !node.matches('[data-sidebar-right-mode], [data-sidebar-right-toggle], [data-dockkit-add-tab]')) return false
      if (node.closest('[data-dockkit-tab]')) return false
      return node.matches('[data-sidebar-right-mode], [data-sidebar-right-toggle]') || node.closest('[data-dockkit-strip]')?.getAttribute('data-dockkit-strip') === current?.pane
    })
    const signature = originals.map(node => node.outerHTML).join('')
    if (signature === this.controls && originals.length === this.controlSources.length
      && originals.every((original, index) => original === this.controlSources[index])) return
    this.controls = signature
    this.controlSources = originals
    this.header.querySelectorAll('[data-dsh-bubble-action]').forEach(node => { node.remove() })
    this.actions.replaceChildren()
    for (const original of originals) {
      const proxy = button('dsh-bubble-control')
      proxy.setAttribute('data-dsh-bubble-action', '')
      const label = original.getAttribute('aria-label') ?? original.title
      proxy.setAttribute('aria-label', label)
      proxy.title = original.title || label
      proxy.disabled = original.disabled
      const svg = original.querySelector('svg')
      if (svg) proxy.append(svg.cloneNode(true))
      const chrome = original.matches('[data-sidebar-right-mode], [data-sidebar-right-toggle]')
      if (original.matches('[data-sidebar-right-mode]')) proxy.setAttribute('data-dsh-mode-proxy', '')
      if (!chrome) proxy.append(document.createTextNode(label))
      proxy.addEventListener('click', () => {
        if (!this.current() || !original.isConnected) return
        this.setOpen(false)
        // 全屏切换必须直调服务：走原按钮 click() 会因目标解析失败而空转（见选项注释）。
        if (chrome && original.matches('[data-sidebar-right-mode]') && this.options.toggleFullscreen) this.options.toggleFullscreen()
        else original.click()
      })
      if (chrome) this.header.insertBefore(proxy, this.toggle)
      else this.actions.append(proxy)
    }
    if (this.options.workspaces) {
      const split = button('dsh-bubble-control'); split.dataset.dshWorkspaceSplit = ''
      split.textContent = this.options.t('split')
      split.setAttribute('aria-label', this.options.t('splitLabel'))
      split.addEventListener('click', () => { if (this.options.workspaces?.split()) this.setOpen(false) })
      const float = button('dsh-bubble-control'); float.dataset.dshWorkspaceFloat = ''
      float.textContent = this.options.t('float')
      float.setAttribute('aria-label', this.options.t('floatLabel'))
      float.addEventListener('click', () => { if (this.options.workspaces?.float()) this.setOpen(false) })
      this.actions.append(split, float)
    }
    this.actions.hidden = this.actions.childElementCount === 0
  }

  private current(): boolean { return this.owner !== undefined && this.options.session() === this.owner && this.panel?.isConnected === true && this.panel.hasAttribute('data-sidebar-right-open') }

  private choose(id: TabId): void {
    if (!this.current()) { this.refresh(); return }
    const tab = this.tabs.find(tab => tab.record.id === id)
    if (!tab?.source.isConnected) return
    if (this.options.workspaces) { if (!this.options.workspaces.single(id)) return }
    else tab.source.click()
    this.setOpen(false, true)
  }

  private closeTab(id: TabId): void {
    if (!this.current()) { this.refresh(); return }
    const tab = this.tabs.find(tab => tab.record.id === id)
    if (!tab?.close?.isConnected) return
    const index = this.tabs.indexOf(tab)
    tab.close.click()
    this.sync()
    const next = this.tabs[Math.min(index, this.tabs.length - 1)]
    if (next) this.rows.get(next.record.id)?.select.focus({ preventScroll: true })
    else this.setOpen(false, true)
  }

  private setOpen(open: boolean, focus = false): void {
    if (!this.popover || !this.toggle) return
    this.cancelPress()
    this.open = open
    this.popover.setAttribute('data-state', open ? 'open' : 'closed')
    if (this.collapseTimer !== null) clearTimeout(this.collapseTimer)
    this.collapseTimer = null
    // Native BrowserHost stays hidden until the exit animation finishes.
    this.popover.setAttribute('data-dsh-sidebar-bubbles', open ? 'open' : 'closing')
    document.documentElement.toggleAttribute('data-dsh-popover-open', open)
    if (!open) this.collapseTimer = window.setTimeout(() => {
      this.collapseTimer = null
      this.popover?.setAttribute('data-dsh-sidebar-bubbles', 'closed')
    }, 240)
    this.popover.setAttribute('aria-hidden', String(!open))
    this.popover.toggleAttribute('inert', !open)
    this.toggle.setAttribute('aria-expanded', String(open))
    if (this.mask) this.mask.hidden = !open
    if (open) {
      this.sync()
      const selected = this.tabs.find(tab => tab.selected && tab.source.closest('[data-dockkit-pane-active]')) ?? this.tabs.find(tab => tab.selected) ?? this.tabs[0]
      const row = selected && this.rows.get(selected.record.id)
      row?.element.scrollIntoView?.({ block: 'nearest' })
      row?.select.focus({ preventScroll: true })
    } else if (focus) this.toggle.focus({ preventScroll: true })
  }

  private measure(): void {
    if (!this.panel || !this.header || !this.popover) return
    const panel = this.panel.getBoundingClientRect()
    const original = this.panel.querySelector<HTMLElement>(STRIP)?.getBoundingClientRect()
    const padding = getComputedStyle(this.panel)
    const topInset = parseFloat(padding.paddingTop) || 0
    const top = this.options.workspaces ? topInset : Math.max(topInset, (original?.top ?? panel.top) - panel.top)
    this.header.style.top = top + 'px'
    const visual = window.visualViewport
    const left = Math.max(panel.left, visual?.offsetLeft ?? 0)
    const right = Math.min(panel.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth))
    const root = getComputedStyle(document.documentElement)
    const nativeBottom = Math.max(0, parseFloat(root.getPropertyValue('--dsh-android-ime-bottom')) || 0, parseFloat(root.getPropertyValue('--dsh-android-system-bottom')) || 0)
    const bottom = Math.min(panel.bottom - (parseFloat(padding.paddingBottom) || 0), (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight), window.innerHeight - nativeBottom)
    const width = Math.max(1, Math.min(304, right - left - 24))
    const chromeBottom = Math.max(top + 48, ...[...this.panel.querySelectorAll<HTMLElement>('[data-dockkit-strip], [data-dsh-bubble-native]')].map(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.top < panel.top + 160 ? rect.bottom - panel.top : 0 }))
    const popTop = Math.max(chromeBottom + 8, (visual?.offsetTop ?? 0) - panel.top + 8)
    this.popover.style.width = width + 'px'
    this.popover.style.left = Math.max(left - panel.left + 12, right - panel.left - width - 12) + 'px'
    this.popover.style.top = popTop + 'px'
    this.popover.style.maxHeight = Math.max(1, bottom - panel.top - popTop - 12) + 'px'
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open || !(event.target instanceof Element) || !event.target.closest(OWN)) return
    this.suppressClick = false
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.setOpen(false, true); return }
    if (event.target === this.toggle && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); this.rows.get(this.tabs[0]?.record.id)?.select.focus(); return
    }
    const id = event.target.closest('[data-dsh-bubble-tab]')?.getAttribute('data-dsh-bubble-tab') as TabId | null
    const index = this.tabs.findIndex(tab => tab.record.id === id)
    if (index < 0) return
    const tab = this.tabs[index]
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); event.stopImmediatePropagation()
      const group = this.tabs.filter(candidate => candidate.pane === tab.pane)
      const at = group.indexOf(tab), direction = event.key === 'ArrowUp' ? -1 : 1
      if (at + direction < 0 || at + direction >= group.length) return
      const before = direction < 0 ? group[at - 1].record.id : group[at + 2]?.record.id
      this.reorder(tab.record.id, before)
      this.rows.get(tab.record.id)?.select.focus({ preventScroll: true })
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
    let next: number | undefined
    if (event.key === 'ArrowDown') next = (index + 1) % this.tabs.length
    if (event.key === 'ArrowUp') next = (index - 1 + this.tabs.length) % this.tabs.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = this.tabs.length - 1
    if (next !== undefined) { event.preventDefault(); this.rows.get(this.tabs[next].record.id)?.select.focus(); document.activeElement?.scrollIntoView?.({ block: 'nearest' }) }
    if (event.key === 'Delete') { event.preventDefault(); this.closeTab(tab.record.id) }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.press) this.cancelPress()
    this.suppressClick = false
    if (!this.open || event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return
    const select = event.target.closest('[data-dsh-bubble-select]')
    const id = select?.getAttribute('data-dsh-bubble-select') as TabId | null
    if (!id || !this.rows.has(id)) return
    this.press = { pointer: event.pointerId, tab: id, x: event.clientX, y: event.clientY, latestX: event.clientX, latestY: event.clientY, active: false, startScroll: this.popover?.scrollTop ?? 0, before: undefined, valid: false }
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = null
      if (!this.press || !this.current() || !this.open) { this.cancelPress(); return }
      this.press.active = true
      this.suppressClick = true
      const row = this.rows.get(this.press.tab)
      row?.element.setAttribute('data-dragging', '')
      if (row && this.panel) {
        const rect = row.element.getBoundingClientRect()
        this.ghost = row.element.cloneNode(true) as HTMLElement
        this.ghost.classList.add('dsh-bubble-drag-ghost'); this.ghost.removeAttribute('data-dsh-bubble-tab')
        this.ghost.setAttribute('aria-hidden', 'true'); this.ghost.querySelectorAll('button').forEach(node => { node.tabIndex = -1; node.removeAttribute('data-dsh-bubble-select') })
        Object.assign(this.ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px' })
        const colors = getComputedStyle(row.element)
        this.ghost.style.backgroundColor = colors.backgroundColor; this.ghost.style.color = colors.color
        this.panel.append(this.ghost)
      }
      row?.select.setPointerCapture?.(this.press.pointer)
      this.trackDrag()
      this.scrollFrame = requestAnimationFrame(this.autoScroll)
    }, PRESS_MS)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const press = this.press
    if (!press || event.pointerId !== press.pointer) return
    press.latestX = event.clientX; press.latestY = event.clientY
    if (!press.active) {
      if (Math.max(Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y)) > SLOP) this.cancelPress()
      return
    }
    event.preventDefault(); event.stopPropagation()
    this.trackDrag()
  }
  private readonly onPointerUp = (event: PointerEvent): void => {
    const press = this.press
    if (!press || event.pointerId !== press.pointer) return
    if (press.active) {
      event.preventDefault(); event.stopPropagation()
      press.latestX = event.clientX; press.latestY = event.clientY
      this.trackDrag()
      const { tab, before, valid, workspaceDrop, latestX, latestY } = press
      this.cancelPress()
      if (workspaceDrop) { this.options.workspaces?.drop(tab, latestX, latestY); this.setOpen(false) }
      else if (valid) this.reorder(tab, before)
      else if (this.status) this.status.textContent = '未放置标签，已恢复原布局'
    } else this.cancelPress()
  }
  private readonly onPointerCancel = (): void => { this.cancelPress(); this.suppressClick = false }
  private readonly onTouchStart = (event: TouchEvent): void => { if (event.touches.length > 1) this.onPointerCancel() }
  private readonly onTouchMove = (event: TouchEvent): void => { if (this.press?.active) event.preventDefault() }
  private readonly onWheel = (event: Event): void => {
    if (this.press && !this.press.active && event.target instanceof Element && event.target.closest('.dsh-bubble-popover')) this.cancelPress()
  }
  private readonly onContextMenu = (event: Event): void => {
    if (this.press?.active || (event.target instanceof Element && event.target.closest('[data-dsh-bubble-nav]'))) event.preventDefault()
  }
  private readonly onClick = (event: MouseEvent): void => {
    if (this.suppressClick && event.detail > 0 && event.target instanceof Element && event.target.closest('[data-dsh-bubble-tab]')) {
      event.preventDefault(); event.stopImmediatePropagation(); this.suppressClick = false
    }
  }

  private trackDrag(): void {
    const press = this.press
    if (!press?.active || !this.popover) return
    const tab = this.tabs.find(tab => tab.record.id === press.tab)
    if (!tab) { this.cancelPress(); return }
    const row = this.rows.get(press.tab)
    if (this.ghost) this.ghost.style.transform = 'translate(' + (press.latestX - press.x) + 'px,' + (press.latestY - press.y) + 'px)'
    else if (row) row.element.style.transform = 'translateY(' + (press.latestY - press.y + this.popover.scrollTop - press.startScroll) + 'px)'
    for (const candidate of this.rows.values()) candidate.element.removeAttribute('data-drop')
    const bounds = this.popover.getBoundingClientRect()
    press.valid = press.latestX >= bounds.left && press.latestX <= bounds.right && press.latestY >= bounds.top && press.latestY <= bounds.bottom
    const outside = press.latestX < bounds.left - DRAG_SAFE_PX || press.latestX > bounds.right + DRAG_SAFE_PX || press.latestY < bounds.top - DRAG_SAFE_PX || press.latestY > bounds.bottom + DRAG_SAFE_PX
    if (outside && this.options.workspaces) {
      press.outsideSince ??= performance.now()
      if (performance.now() - press.outsideSince >= DRAG_DWELL_MS) {
        this.popover.setAttribute('data-drag-out', '')
        press.workspaceDrop = this.options.workspaces.preview(press.tab, press.latestX, press.latestY)
      }
    } else {
      press.outsideSince = undefined; press.workspaceDrop = false
      this.popover.removeAttribute('data-drag-out'); this.options.workspaces?.clearPreview()
    }
    if (!press.valid) return
    const group = this.tabs.filter(candidate => candidate.pane === tab.pane && candidate.record.id !== press.tab)
    const target = group.find(candidate => {
      const rect = this.rows.get(candidate.record.id)?.element.getBoundingClientRect()
      return rect !== undefined && press.latestY < rect.top + rect.height / 2
    })
    press.before = target?.record.id
    if (target) this.rows.get(target.record.id)?.element.setAttribute('data-drop', 'before')
    else if (group.length) this.rows.get(group[group.length - 1].record.id)?.element.setAttribute('data-drop', 'after')
  }

  private readonly autoScroll = (): void => {
    this.scrollFrame = null
    const press = this.press
    if (!press?.active || !this.popover) return
    const rect = this.popover.getBoundingClientRect()
    const y = press.latestY
    const delta = y < rect.top + 44 ? -Math.min(10, Math.max(0, (rect.top + 44 - y) / 4))
      : y > rect.bottom - 44 ? Math.min(10, Math.max(0, (y - rect.bottom + 44) / 4)) : 0
    if (delta && press.latestX >= rect.left && press.latestX <= rect.right) { this.popover.scrollTop += delta; this.trackDrag() }
    this.trackDrag()
    this.scrollFrame = requestAnimationFrame(this.autoScroll)
  }

  private cancelPress(): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer)
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame)
    this.pressTimer = null; this.scrollFrame = null
    if (this.press) {
      const row = this.rows.get(this.press.tab)
      row?.element.removeAttribute('data-dragging')
      row?.element.style.removeProperty('transform')
      if (row?.select.hasPointerCapture?.(this.press.pointer)) row.select.releasePointerCapture(this.press.pointer)
    }
    for (const row of this.rows.values()) row.element.removeAttribute('data-drop')
    this.press = null
    this.ghost?.remove(); this.ghost = null
    this.popover?.removeAttribute('data-drag-out'); this.options.workspaces?.clearPreview()
  }

  private reorder(tab: TabId, before: TabId | undefined): void {
    if (!this.current() || this.owner === undefined) return
    if (this.options.reorder(this.owner, tab, before) && this.status) this.status.textContent = this.options.t('moved')
    this.sync()
  }
}
