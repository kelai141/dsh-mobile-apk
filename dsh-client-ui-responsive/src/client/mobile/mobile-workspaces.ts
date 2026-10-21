/** Versioned Android presentation over the existing Sidebar store. Never reparent a tab body. */
import { FLOAT_MIN_SIZE } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { LayoutState, PaneId, PaneNode, TabId, TabRecord, FloatRect, SplitId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const WORKSPACE_MAX_WIDTH = 1100
export const DRAG_SAFE_PX = 24
export const DRAG_DWELL_MS = 150
/** Single source for the transparent divider hit track used by CSS, grid and drag math. */
export const DIVIDER_HIT_SIZE = 20
export interface TabCapability { readonly split: boolean; readonly float: boolean; readonly nativeSurface?: 'browser' }
const NONE: TabCapability = { split: false, float: false }
/**
 * Explicit opt-in: dedicated native surfaces and unknown third-party types keep their own
 * lifecycle. File previews are the right column's primary content on phones, so every
 * built-in DOM-backed tab type must stay eligible; otherwise 分栏/小窗 refuse precisely
 * where the user needs them.
 */
export const TAB_CAPABILITIES: Readonly<Record<string, TabCapability>> = {
  conversation: { split: true, float: true },
  subagentchat: { split: true, float: true },
  terminal: { split: true, float: true },
  browser: { split: true, float: true, nativeSurface: 'browser' },
  'android-browser': { split: true, float: true, nativeSurface: 'browser' },
  files: { split: true, float: true },
  text: { split: true, float: true },
  plan: { split: true, float: true },
  'changes-review': { split: true, float: true },
  scheduleTask: { split: true, float: true },
  'open-with': { split: true, float: true },
  'android-vdisplay': NONE,
}
export const tabCapability = (tab: TabRecord): TabCapability => TAB_CAPABILITIES[tab.kind] ?? NONE
export function compatibleTabs(a: TabRecord, b: TabRecord): boolean {
  return a.id !== b.id && a.contentId !== b.contentId && tabCapability(a).split && tabCapability(b).split
    && !(tabCapability(a).nativeSurface === 'browser' && tabCapability(b).nativeSurface === 'browser')
}
/**
 * The viewport is the layout truth here. Android WebViews can report the display's natural
 * orientation through `screen.orientation`, which turned a portrait phone split into two
 * side-by-side columns; the visible aspect ratio cannot disagree with the grid we paint.
 */
export function portraitWorkspace(): boolean {
  const width = document.documentElement.clientWidth || window.innerWidth
  const height = document.documentElement.clientHeight || window.innerHeight
  return height >= width
}
export function splitFraction(position: number, extent: number, minimum = 128): number {
  const available = Math.max(1, extent - DIVIDER_HIT_SIZE)
  const min = Math.min(.45, minimum / available)
  return Math.max(min, Math.min(1 - min, (position - DIVIDER_HIT_SIZE / 2) / available))
}

/** The viewport-relative box a floating pane must stay inside. */
export interface FloatBounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/**
 * Clamp a float to the usable sidebar area. The dockkit model stores viewport coordinates
 * and its own move/resize gestures do not bound them, so a phone drag can leave the header
 * under the top bar or push the corner grip off-screen. Keep the whole frame inside the
 * bounds, including the minimum size: when the origin no longer leaves room, move it back
 * instead of shrinking below what the header controls need.
 */
export function clampFloatRect(rect: FloatRect, bounds: FloatBounds, gap = 8): FloatRect {
  const availableWidth = Math.max(FLOAT_MIN_SIZE.width, bounds.right - bounds.left - gap * 2)
  const availableHeight = Math.max(FLOAT_MIN_SIZE.height, bounds.bottom - bounds.top - gap * 2)
  const width = Math.min(Math.max(FLOAT_MIN_SIZE.width, rect.width), availableWidth)
  const height = Math.min(Math.max(FLOAT_MIN_SIZE.height, rect.height), availableHeight)
  const minX = bounds.left + gap, maxX = bounds.right - gap - width
  const minY = bounds.top + gap, maxY = bounds.bottom - gap - height
  return {
    x: maxX >= minX ? Math.min(Math.max(rect.x, minX), maxX) : minX,
    y: maxY >= minY ? Math.min(Math.max(rect.y, minY), maxY) : minY,
    width,
    height,
  }
}
interface Actions {
  focusTab(session: SessionId, tab: TabId): void
  focusPane(session: SessionId, pane: PaneId): void
  splitPane(session: SessionId, pane: PaneId, settled: (created: PaneId) => void): void
  placeTab(session: SessionId, tab: TabId, pane: PaneId, index: number): void
  closeTab(session: SessionId, tab: TabId): void
  floatTab(session: SessionId, tab: TabId, rect: FloatRect): void
  unfloatPane(session: SessionId, pane: PaneId): void
  resizeSplit(session: SessionId, split: SplitId, sizes: readonly number[]): void
  /** Present in the 0.2.1 store; optional here so older hosts and fixtures fail closed. */
  moveFloat?(session: SessionId, pane: PaneId, x: number, y: number): void
  resizeFloat?(session: SessionId, pane: PaneId, rect: FloatRect): void
}
interface SurfaceStore {
  getSnapshot(): { bySession: Record<string, { layout: LayoutState }> }
  subscribe(callback: () => void): () => void
  actions: Actions
}
/** The 0.2.x owner also used by B1. Isolate this pinned integration point and fail closed. */
interface Owner {
  mounted: { getSnapshot(): SessionId | undefined }
  adopted?: Map<SessionId, { store: SurfaceStore }>
}
export interface WorkspaceNavigation {
  single(tab: TabId): boolean
  split(): boolean
  float(): boolean
  preview(tab: TabId, x: number, y: number): boolean
  drop(tab: TabId, x: number, y: number): boolean
  clearPreview(): void
  readonly activeId: TabId | undefined
  readonly hiddenTabs: ReadonlySet<TabId>
}

export class MobileWorkspaces implements WorkspaceNavigation {
  private readonly owner: Owner
  private panel: HTMLElement | undefined
  private session: SessionId | undefined
  private unsubscribe: (() => void) | undefined
  private observer: MutationObserver | undefined
  private frame = 0
  private attached = false
  private history = new Map<SessionId, TabId[]>()
  private pickers = new Map<SessionId, Map<PaneId, TabId | undefined>>()
  private get picker(): Map<PaneId, TabId | undefined> {
    if (!this.session) return new Map()
    let map = this.pickers.get(this.session)
    if (!map) { map = new Map(); this.pickers.set(this.session, map) }
    return map
  }
  private swapped = new Set<SessionId>()
  private previewPane: PaneId | undefined
  private previewNew = false
  private previewKey = ''
  private previewElement: HTMLElement | undefined
  private headers = new Map<PaneId, HTMLElement>()
  /** Stores whose float actions already carry the viewport clamp. */
  private readonly bounded = new WeakSet<object>()
  /** Float panes already clamped in this viewport epoch (reset on rotation/resize). */
  private readonly clamped = new Set<string>()
  private gesture: { pointer: number; kind: 'divider' | 'swap'; pane?: PaneId; startX: number; startY: number; moved: boolean } | undefined
  private pointerOwner: HTMLElement | undefined
  private snapshotAtPress: LayoutState | undefined
  private status: HTMLElement | undefined
  private statusTimer: number | undefined

  constructor(owner: unknown, private readonly overlay?: (fullscreen: boolean) => void) { this.owner = owner as Owner }
  get hiddenTabs(): ReadonlySet<TabId> { return new Set([...this.picker.values()].filter((id): id is TabId => id !== undefined)) }
  private store(): SurfaceStore | undefined {
    if (!this.session || this.owner.mounted.getSnapshot() !== this.session || !this.panel?.isConnected) return
    const store = this.owner.adopted?.get(this.session)?.store
    if (!store?.actions || typeof store.getSnapshot !== 'function' || typeof store.actions.placeTab !== 'function') return
    return store
  }
  layout(): LayoutState | undefined { return this.store()?.getSnapshot().bySession[this.session!]?.layout }
  private panes(layout = this.layout()): PaneNode[] {
    if (!layout) return []
    const root = layout.nodes[layout.rootId]
    return root?.kind === 'pane' ? [root] : root?.kind === 'split' && root.axis === 'row' && root.children.length === 2
      ? root.children.map(id => layout.nodes[id]).filter((node): node is PaneNode => node?.kind === 'pane') : []
  }
  get activeId(): TabId | undefined {
    const layout = this.layout(), node = layout?.nodes[layout.activePaneId]
    return node?.kind === 'pane' ? node.activeTabId : undefined
  }
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-dsh-workspace-chrome]'))) this.refresh()
    })
    this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-sidebar-right-open', 'data-sidebar-right-session', 'data-dockkit-pane-active', 'data-rightbar-collapsed', 'data-rightbar-fullscreen', 'hidden'] })
    window.addEventListener('resize', this.onResize)
    window.visualViewport?.addEventListener('resize', this.refresh)
    document.addEventListener('pointerdown', this.onDown, true)
    document.addEventListener('pointermove', this.onMove, true)
    document.addEventListener('pointerup', this.onUp, true)
    document.addEventListener('pointercancel', this.onCancel, true)
    document.addEventListener('keydown', this.onKey, true)
    document.addEventListener('focusin', this.onFocus, true)
    window.addEventListener('blur', this.onCancel)
    this.sync()
  }
  detach(): void {
    this.attached = false
    this.observer?.disconnect(); this.observer = undefined
    window.removeEventListener('resize', this.onResize); window.visualViewport?.removeEventListener('resize', this.refresh)
    document.removeEventListener('pointerdown', this.onDown, true); document.removeEventListener('pointermove', this.onMove, true)
    document.removeEventListener('pointerup', this.onUp, true); document.removeEventListener('pointercancel', this.onCancel, true)
    document.removeEventListener('keydown', this.onKey, true); document.removeEventListener('focusin', this.onFocus, true)
    window.removeEventListener('blur', this.onCancel)
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.unmount()
  }
  readonly refresh = (): void => {
    if (this.attached && !this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.sync() })
  }
  private unmount(): void {
    this.onCancel(); this.unsubscribe?.(); this.unsubscribe = undefined
    this.clearPreview()
    this.headers.forEach(node => node.remove()); this.headers.clear()
    this.panel?.querySelectorAll('[data-dsh-workspace-picker]').forEach(node => node.remove())
    this.panel?.querySelectorAll('[data-dsh-workspace-choosing]').forEach(node => node.removeAttribute('data-dsh-workspace-choosing'))
    this.panel?.querySelectorAll('[data-dsh-workspace-slot]').forEach(node => node.removeAttribute('data-dsh-workspace-slot'))
    this.panel?.removeAttribute('data-dsh-workspaces'); this.panel?.removeAttribute('data-dsh-workspace-orientation')
    this.panel?.style.removeProperty('--dsh-dockkit-float-top')
    this.clamped.clear()
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer)
    this.resizeTimer = undefined
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.statusTimer = undefined
    this.status?.remove(); this.status = undefined
    this.panel = undefined; this.session = undefined
  }
  private notify(message: string): false {
    if (this.status) this.status.textContent = message
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.statusTimer = window.setTimeout(() => { if (this.status) this.status.textContent = ''; this.statusTimer = undefined }, 4000)
    return false
  }
  /** The usable area floats may occupy: the panel, below its pinned title bar. */
  private floatBounds(): FloatBounds {
    const rect = this.panel?.getBoundingClientRect()
    const left = Math.max(0, rect?.left ?? 0)
    const top = Math.max(0, rect?.top ?? 0)
    const header = this.panel?.querySelector<HTMLElement>('.dsh-bubble-header')?.getBoundingClientRect().bottom
    return {
      left,
      top: Math.max(top, header ?? top + 48),
      right: Math.min(window.innerWidth, rect?.right ?? window.innerWidth),
      bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight),
    }
  }
  /**
   * The dockkit intents call the store's float actions directly, so a wrapper local to
   * `float()` cannot bound header drags or corner resizes. Re-wrap the shared action object
   * once; the upstream intents look the methods up at call time, and the store is per session.
   */
  private ensureFloatBounds(store: SurfaceStore): void {
    const actions = store.actions
    if (this.bounded.has(actions)) return
    this.bounded.add(actions)
    const mobile = (): boolean => this.panel !== undefined && window.innerWidth <= WORKSPACE_MAX_WIDTH
    const bound = (rect: FloatRect): FloatRect => clampFloatRect(rect, this.floatBounds())
    const floatTab = actions.floatTab
    actions.floatTab = (session, tab, rect) => floatTab(session, tab, mobile() ? bound(rect) : rect)
    const moveFloat = actions.moveFloat
    if (moveFloat !== undefined) {
      actions.moveFloat = (session, pane, x, y) => {
        if (!mobile()) { moveFloat(session, pane, x, y); return }
        const node = store.getSnapshot().bySession[session]?.layout.nodes[pane]
        const rect = node?.kind === 'pane' ? node.rect : undefined
        if (rect === undefined) { moveFloat(session, pane, x, y); return }
        const clamped = bound({ ...rect, x, y })
        moveFloat(session, pane, clamped.x, clamped.y)
      }
    }
    const resizeFloat = actions.resizeFloat
    if (resizeFloat !== undefined) {
      actions.resizeFloat = (session, pane, rect) => resizeFloat(session, pane, mobile() ? bound(rect) : rect)
    }
  }
  /** Persisted or pre-fix floats may sit outside today's viewport; settle them once per epoch. */
  private clampFloats(layout: LayoutState, session: SessionId): void {
    const store = this.store()
    if (!store) return
    for (const paneId of layout.floats) {
      const key = session + ':' + paneId
      if (this.clamped.has(key)) continue
      const node = layout.nodes[paneId]
      if (node?.kind !== 'pane' || node.rect === undefined) continue
      this.clamped.add(key)
      const clamped = clampFloatRect(node.rect, this.floatBounds())
      const moved = Math.abs(clamped.x - node.rect.x) > .5 || Math.abs(clamped.y - node.rect.y) > .5
      const sized = Math.abs(clamped.width - node.rect.width) > .5 || Math.abs(clamped.height - node.rect.height) > .5
      if (moved) store.actions.moveFloat?.(session, paneId, clamped.x, clamped.y)
      if (sized) store.actions.resizeFloat?.(session, paneId, clamped)
    }
  }
  private sync(): void {
    const session = this.owner.mounted.getSnapshot()
    const panel = window.innerWidth <= WORKSPACE_MAX_WIDTH && session ? [...document.querySelectorAll<HTMLElement>('[data-sidebar-right-panel][data-sidebar-right-open]')]
      .find(node => node.getAttribute('data-sidebar-right-session') === session && !node.closest('[hidden]')) : undefined
    if (panel !== this.panel || session !== this.session) {
      this.unmount(); this.panel = panel; this.session = session
      if (panel) {
        this.status = document.createElement('div'); this.status.className = 'dsh-workspace-status'; this.status.setAttribute('role', 'status')
        this.status.setAttribute('data-dsh-workspace-chrome', ''); panel.append(this.status)
        this.unsubscribe = this.store()?.subscribe(this.refresh)
        try { if (localStorage.getItem('dsh-mobile-workspace-swap:' + session) === '1') this.swapped.add(session!) } catch { /* private storage */ }
      }
    }
    const layout = this.layout(), panes = this.panes(layout)
    if (!panel || !layout || !session || panes.length === 0) return
    const store = this.store()
    if (store) this.ensureFloatBounds(store)
    this.clampFloats(layout, session)
    // The pinned title bar is part of the app surface: a float may never slide under it.
    const floatTop = Math.round(this.floatBounds().top + 4)
    if (panel.style.getPropertyValue('--dsh-dockkit-float-top') !== floatTop + 'px') {
      panel.style.setProperty('--dsh-dockkit-float-top', floatTop + 'px')
    }
    this.overlay?.(panel.getAttribute('data-sidebar-right-panel') === 'fullscreen')
    const active = this.activeId
    if (active && !this.hiddenTabs.has(active)) {
      const history = this.history.get(session) ?? []
      this.history.set(session, [active, ...history.filter(id => id !== active && layout.tabs[id])])
    }
    panel.setAttribute('data-dsh-workspaces', String(panes.length))
    const vertical = portraitWorkspace()
    panel.setAttribute('data-dsh-workspace-orientation', vertical ? 'vertical' : 'horizontal')
    // The native model remains a supported row split; only physical tracks change. Tracks
    // and cell slots are CSS custom properties/attributes, never inline style writes:
    // React owns the element's style, and a written inline grid must not outlive the split
    // (that left the collapsed single pane half-height with two tab bodies stacked).
    const grid = panel.querySelector<HTMLElement>('[data-dockkit-split]')
    if (grid && panes.length === 2) {
      grid.style.setProperty('--dsh-divider-hit', DIVIDER_HIT_SIZE + 'px')
      const root = layout.nodes[layout.rootId]
      const sizes = root.kind === 'split' ? root.sizes : [.5, .5]
      this.paintRatio(grid, sizes[0] / (sizes[0] + sizes[1]), vertical)
      for (const cell of grid.querySelectorAll<HTMLElement>(':scope > [data-dockkit-host="dock"]')) {
        const logical = Number(cell.getAttribute('data-dockkit-column'))
        const physical = this.swapped.has(session) ? 1 - logical : logical
        cell.setAttribute('data-dsh-workspace-slot', String(physical))
      }
      const divider = grid.querySelector<HTMLElement>(':scope > [data-dockkit-divider]')
      if (divider) {
        divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical')
        const bounds = grid.getBoundingClientRect(), extent = vertical ? bounds.height : bounds.width
        divider.setAttribute('aria-valuenow', String(Math.round(sizes[0] * 100))); divider.setAttribute('aria-valuemin', String(Math.round(splitFraction(0, extent) * 100))); divider.setAttribute('aria-valuemax', String(Math.round(splitFraction(extent, extent) * 100)))
        divider.tabIndex = 0; divider.setAttribute('aria-label', '调整工作区比例；双击恢复均分')
        divider.ondblclick = () => { const current = this.layout(); if (current && current.nodes[current.rootId].kind === 'split') this.store()?.actions.resizeSplit(session, current.rootId as SplitId, [.5, .5]) }
      }
    } else {
      for (const cell of panel.querySelectorAll<HTMLElement>('[data-dsh-workspace-slot]')) cell.removeAttribute('data-dsh-workspace-slot')
    }
    const live = new Set(panes.map(pane => pane.id))
    for (const id of this.picker.keys()) if (!live.has(id)) this.picker.delete(id)
    for (const [id, node] of this.headers) if (!live.has(id) || !node.isConnected) { node.remove(); this.headers.delete(id) }
    for (const pane of panes) {
      const section = [...panel.querySelectorAll<HTMLElement>('[data-dockkit-pane]')].find(node => node.getAttribute('data-dockkit-pane') === pane.id)
      if (!section) continue
      section.toggleAttribute('data-dsh-workspace-choosing', this.picker.has(pane.id))
      let chrome = this.headers.get(pane.id)
      if (!chrome || chrome.parentElement !== section) {
        chrome?.remove(); chrome = document.createElement('div'); chrome.className = 'dsh-workspace-bar'; chrome.setAttribute('data-dsh-workspace-chrome', '')
        const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'dsh-workspace-grip'; grip.dataset.workspaceGrip = pane.id
        grip.setAttribute('aria-label', '拖动交换工作区；按 Enter 交换'); grip.innerHTML = '<span></span>'
        const title = document.createElement('span'); title.className = 'dsh-workspace-title'
        const close = document.createElement('button'); close.type = 'button'; close.className = 'dsh-workspace-close'; close.textContent = '×'
        close.setAttribute('aria-label', '关闭此工作区，恢复单屏')
        close.onclick = () => { const other = this.panes().find(item => item.id !== pane.id); if (other?.activeTabId) this.single(other.activeTabId) }
        chrome.append(grip, title, close); section.append(chrome); this.headers.set(pane.id, chrome)
      }
      chrome.hidden = panes.length !== 2
      const tab = pane.activeTabId && layout.tabs[pane.activeTabId]
      const nativeTitle = section.querySelector('[data-dockkit-tab][aria-selected="true"] [data-dockkit-tab-title]')?.textContent
      const title = chrome.querySelector('.dsh-workspace-title')!
      const text = this.picker.has(pane.id) ? '选择标签' : nativeTitle || (tab ? tab.title : '选择标签')
      if (title.textContent !== text) title.textContent = text
      this.renderPicker(section, pane, layout)
    }
  }
  private paintRatio(grid: HTMLElement, ratio: number, vertical: boolean): void {
    const physical = this.session && this.swapped.has(this.session) ? 1 - ratio : ratio
    grid.style.setProperty('--dsh-workspace-columns', vertical ? 'minmax(0, 1fr)' : `minmax(0, ${physical}fr) ${DIVIDER_HIT_SIZE}px minmax(0, ${1 - physical}fr)`)
    grid.style.setProperty('--dsh-workspace-rows', vertical ? `minmax(0, ${physical}fr) ${DIVIDER_HIT_SIZE}px minmax(0, ${1 - physical}fr)` : 'minmax(0, 1fr)')
  }
  private nativeSurfaceConflict(tabId: TabId, layout: LayoutState): boolean {
    return !!tabCapability(layout.tabs[tabId]).nativeSurface && layout.floats.some(id => {
      const pane = layout.nodes[id]
      return pane.kind === 'pane' && pane.activeTabId && pane.activeTabId !== tabId
        && tabCapability(layout.tabs[pane.activeTabId]).nativeSurface
    })
  }
  private renderPicker(section: HTMLElement, pane: PaneNode, layout: LayoutState): void {
    let picker = section.querySelector<HTMLElement>(':scope > [data-dsh-workspace-picker]')
    if (!this.picker.has(pane.id)) { picker?.remove(); return }
    const key = JSON.stringify({
      tabs: Object.values(layout.tabs).map(tab => [tab.id, tab.title, tab.kind, tab.contentId, tabCapability(tab)]),
      panes: this.panes(layout).map(item => [item.id, item.activeTabId]),
      floats: layout.floats.map(id => { const node = layout.nodes[id]; return [id, node.kind === 'pane' ? node.activeTabId : undefined] }),
      pickers: [...this.picker],
    })
    if (picker?.dataset.signature === key) return
    picker?.remove(); picker = document.createElement('div'); picker.className = 'dsh-workspace-picker'; picker.dataset.dshWorkspacePicker = ''; picker.dataset.signature = key
    picker.setAttribute('data-dsh-workspace-chrome', '')
    const label = document.createElement('p'); label.textContent = '选择已有标签以打开此工作区'; picker.append(label)
    const other = this.panes(layout).find(item => item.id !== pane.id)
    const otherTab = other?.activeTabId && layout.tabs[other.activeTabId]
    let candidates = 0, incompatible = 0
    for (const tab of Object.values(layout.tabs)) {
      if (this.hiddenTabs.has(tab.id) || tab.id === other?.activeTabId) continue
      candidates++
      const button = document.createElement('button'); button.type = 'button'; button.textContent = tab.title
      button.disabled = (otherTab ? !compatibleTabs(otherTab, tab) : !tabCapability(tab).float) || this.nativeSurfaceConflict(tab.id, layout)
      if (button.disabled) incompatible++
      button.title = button.disabled ? '此标签不支持当前分屏组合' : tab.title
      button.setAttribute('aria-label', button.disabled ? button.title + '：' + tab.title : tab.title)
      button.onclick = () => { this.place(tab.id, pane.id) }; picker.append(button)
    }
    if (candidates === 0) {
      const empty = document.createElement('p'); empty.className = 'dsh-workspace-picker-empty'
      empty.setAttribute('role', 'status'); empty.textContent = '暂无可用于当前分屏的标签'; picker.append(empty)
    } else if (incompatible > 0) {
      const note = document.createElement('p'); note.className = 'dsh-workspace-picker-note'
      note.textContent = '灰色标签与当前分屏不兼容'; picker.insertBefore(note, picker.children[1] ?? null)
    }
    section.append(picker)
  }
  single(tabId: TabId): boolean {
    const layout = this.layout(), store = this.store(), session = this.session
    if (!layout?.tabs[tabId] || !store || !session) return false
    const before = this.activeId
    const history = this.history.get(session) ?? []
    this.history.set(session, [tabId, ...(before && before !== tabId ? [before] : []), ...history.filter(id => id !== tabId && id !== before && layout.tabs[id])])
    let target = this.panes(layout).find(pane => pane.tabs.includes(tabId)) ?? this.panes(layout)[0]
    if (!target) return false
    const source = Object.values(layout.nodes).find((node): node is PaneNode => node.kind === 'pane' && node.tabs.includes(tabId))
    if (source?.host === 'float') { store.actions.unfloatPane(session, source.id); target = this.panes().find(pane => pane.tabs.includes(tabId)) ?? target }
    for (const pane of this.panes()) if (pane.id !== target.id) {
      for (const id of [...pane.tabs]) {
        if (this.hiddenTabs.has(id)) continue
        store.actions.placeTab(session, id, target.id, this.panes().find(p => p.id === target.id)?.tabs.length ?? 0)
      }
      const placeholder = this.picker.get(pane.id)
      this.picker.delete(pane.id)
      if (placeholder && this.layout()?.tabs[placeholder]) store.actions.closeTab(session, placeholder)
    }
    const targetPlaceholder = this.picker.get(target.id)
    this.picker.delete(target.id)
    if (targetPlaceholder && targetPlaceholder !== tabId && this.layout()?.tabs[targetPlaceholder]) store.actions.closeTab(session, targetPlaceholder)
    store.actions.focusTab(session, tabId); this.refresh(); return true
  }
  split(): boolean {
    const layout = this.layout(), store = this.store(), session = this.session
    if (!store || !layout || !session) return this.notify('当前版本的工作区适配不可用')
    const panes = this.panes(layout), active = this.activeId && layout.tabs[this.activeId]
    if (panes.length !== 1) return this.notify('已打开两个工作区')
    if (!active || !tabCapability(active).split) return this.notify('当前标签使用专用视图，不能进入通用分屏')
    const bounds = this.panel!.getBoundingClientRect(), vertical = portraitWorkspace()
    if ((vertical ? bounds.height - 48 : bounds.width) < (vertical ? 300 : 400)) return this.notify('可用空间不足，请收起键盘或旋转屏幕')
    let created: PaneId | undefined
    store.actions.splitPane(session, panes[0].id, id => { created = id })
    if (!created) return this.notify('无法创建工作区')
    const node = this.layout()?.nodes[created]
    if (node?.kind === 'pane') this.picker.set(created, node.activeTabId && !layout.tabs[node.activeTabId] ? node.activeTabId : undefined)
    this.refresh(); return true
  }
  private place(tabId: TabId, paneId: PaneId): boolean {
    const layout = this.layout(), store = this.store(), session = this.session
    if (!layout || !store || !session || !layout.tabs[tabId]) return false
    if (!this.panes(layout).some(pane => pane.id === paneId)) return this.notify('工作区已变更，请重新选择标签')
    if (this.panes(layout).length === 1) return this.single(tabId)
    const other = this.panes(layout).find(pane => pane.id !== paneId), otherTab = other?.activeTabId && layout.tabs[other.activeTabId]
    if (this.nativeSurfaceConflict(tabId, layout)) return this.notify('已有浏览器小窗，请先将其放回工作区')
    if (!otherTab || !compatibleTabs(otherTab, layout.tabs[tabId])) return this.notify('此标签不支持当前分屏组合')
    const placeholder = this.picker.get(paneId)
    store.actions.placeTab(session, tabId, paneId, this.panes().find(p => p.id === paneId)?.tabs.length ?? 0)
    const placed = this.layout()?.nodes[paneId]
    if (placed?.kind !== 'pane' || !placed.tabs.includes(tabId)) return this.notify('标签未能放入工作区，请重试')
    this.picker.delete(paneId)
    if (placeholder && placeholder !== tabId && this.layout()?.tabs[placeholder]) store.actions.closeTab(session, placeholder)
    this.refresh(); return true
  }
  float(): boolean {
    const layout = this.layout(), store = this.store(), session = this.session, id = this.activeId
    if (!layout || !store || !session || !id || !tabCapability(layout.tabs[id]).float) return this.notify('当前标签不支持小窗；虚拟屏请使用原有专用浮窗入口')
    const node = Object.values(layout.nodes).find(node => node.kind === 'pane' && node.tabs.includes(id))
    if (node?.kind !== 'pane' || node.host === 'float') return false
    const recent = (this.history.get(session) ?? []).find(candidate => candidate !== id && layout.tabs[candidate]
      && !this.hiddenTabs.has(candidate) && this.panes(layout).some(pane => pane.tabs.includes(candidate))
      && !(tabCapability(layout.tabs[id]).nativeSurface && tabCapability(layout.tabs[candidate]).nativeSurface))
    const bounds = this.floatBounds()
    const width = Math.min(420, bounds.right - bounds.left - 24)
    const height = Math.min(480, bounds.bottom - bounds.top - 24)
    store.actions.floatTab(session, id, clampFloatRect({ x: bounds.left + 12, y: bounds.top + 12, width, height }, bounds))
    if (recent) store.actions.focusTab(session, recent)
    else {
      const after = this.layout()
      const dock = this.panes(after).find(pane => pane.host === 'dock')
      if (dock) {
        this.picker.set(dock.id, dock.activeTabId && !layout.tabs[dock.activeTabId] ? dock.activeTabId : undefined)
        store.actions.focusPane(session, dock.id)
      }
    }
    this.refresh(); return true
  }
  preview(tabId: TabId, x: number, y: number): boolean {
    const key = tabId + ":" + Math.round(x) + ":" + Math.round(y)
    if (this.previewElement && this.previewKey === key) return true
    this.clearPreview()
    const layout = this.layout(), tab = layout?.tabs[tabId], panes = this.panes(layout)
    if (!tab || !tabCapability(tab).split || !this.panel) return false
    if (this.nativeSurfaceConflict(tabId, layout!)) return false
    const panel = this.panel.getBoundingClientRect()
    if (x < panel.left || x > panel.right || y < panel.top + 48 || y > panel.bottom) return false
    const vertical = portraitWorkspace()
    if (panes.length === 1 && (vertical ? panel.height - 48 : panel.width) < (vertical ? 300 : 400)) return false
    this.previewNew = panes.length === 1
    const pane = panes.length === 1 ? panes[0] : panes.find(candidate => {
      const section = [...this.panel!.querySelectorAll<HTMLElement>('[data-dockkit-pane]')].find(node => node.dataset.dockkitPane === candidate.id)
      const rect = section?.getBoundingClientRect(); return rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    })
    if (!pane) return false
    const other = panes.length === 1 ? pane : panes.find(p => p.id !== pane.id)
    const otherTab = other?.activeTabId && layout!.tabs[other.activeTabId]
    if (!otherTab || !compatibleTabs(otherTab, tab)) return false
    this.previewPane = pane.id
    const preview = this.previewElement = document.createElement('div'); preview.className = 'dsh-workspace-drop-preview'
    preview.setAttribute('data-dsh-workspace-chrome', ''); preview.setAttribute('role', 'status')
    preview.textContent = panes.length === 1 ? '松开创建分屏' : '松开在此工作区打开'
    const rect = this.previewNew ? panel : [...this.panel.querySelectorAll<HTMLElement>('[data-dockkit-pane]')].find(node => node.dataset.dockkitPane === pane.id)!.getBoundingClientRect()
    Object.assign(preview.style, { left: rect.left + 'px', top: (this.previewNew && vertical ? rect.top + rect.height / 2 : rect.top) + 'px',
      width: (this.previewNew && !vertical ? rect.width / 2 : rect.width) + 'px', height: (this.previewNew && vertical ? rect.height / 2 : rect.height) + 'px' })
    if (this.previewNew && !vertical) preview.style.left = rect.left + rect.width / 2 + 'px'
    this.previewKey = key
    document.body.append(preview); return true
  }
  drop(tab: TabId, x: number, y: number): boolean {
    if (!this.preview(tab, x, y)) return this.notify('此位置不能放置标签，已取消')
    let pane = this.previewPane
    if (this.previewNew) {
      if (!this.split()) { this.clearPreview(); return false }
      pane = this.panes().find(item => item.id !== pane)?.id
    }
    this.clearPreview()
    return pane ? this.place(tab, pane) : false
  }
  clearPreview(): void { this.previewElement?.remove(); this.previewElement = undefined; this.previewPane = undefined; this.previewNew = false; this.previewKey = '' }
  private readonly onDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element) || !this.panel?.contains(event.target)) return
    const divider = event.target.closest<HTMLElement>('[data-dockkit-divider]'), grip = event.target.closest<HTMLElement>('[data-workspace-grip]')
    if (!divider && !grip) return
    const layout = this.layout(); if (!layout || this.panes(layout).length !== 2 || !event.isPrimary || event.button !== 0) return
    event.preventDefault(); event.stopImmediatePropagation()
    this.snapshotAtPress = layout
    this.gesture = { pointer: event.pointerId, kind: divider ? 'divider' : 'swap', pane: grip?.dataset.workspaceGrip as PaneId | undefined, startX: event.clientX, startY: event.clientY, moved: false }
    this.pointerOwner = divider ?? grip ?? undefined
    this.pointerOwner?.setAttribute('data-dockkit-pointer', String(event.pointerId))
    this.pointerOwner?.setPointerCapture?.(event.pointerId)
    document.documentElement.setAttribute('data-dsh-workspace-dragging', '')
  }
  private readonly onMove = (event: PointerEvent): void => {
    const drag = this.gesture; if (!drag || event.pointerId !== drag.pointer) return
    if (!this.store() || this.layout()?.rootId !== this.snapshotAtPress?.rootId) { this.onCancel(); return }
    event.preventDefault(); event.stopImmediatePropagation()
    drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 10
    if (drag.kind === 'divider') {
      const grid = this.panel?.querySelector<HTMLElement>('[data-dockkit-split]'); if (!grid) return
      const bounds = grid.getBoundingClientRect(), vertical = portraitWorkspace()
      const ratio = splitFraction(vertical ? event.clientY - bounds.top : event.clientX - bounds.left, vertical ? bounds.height : bounds.width)
      grid.style.setProperty('--dsh-workspace-preview-ratio', String(ratio))
      this.paintRatio(grid, this.swapped.has(this.session!) ? 1 - ratio : ratio, vertical)
    }
  }
  private readonly onUp = (event: PointerEvent): void => {
    const drag = this.gesture; if (!drag || event.pointerId !== drag.pointer) return
    event.preventDefault(); event.stopImmediatePropagation()
    const layout = this.layout(), store = this.store(), session = this.session
    if (layout && store && session && drag.moved) {
      if (drag.kind === 'divider') {
        const grid = this.panel?.querySelector<HTMLElement>('[data-dockkit-split]'), raw = Number(grid?.style.getPropertyValue('--dsh-workspace-preview-ratio'))
        if (Number.isFinite(raw) && raw > 0 && raw < 1) { const ratio = this.swapped.has(session) ? 1 - raw : raw; store.actions.resizeSplit(session, layout.rootId as SplitId, [ratio, 1 - ratio]) }
      } else {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-dockkit-pane]')
        if (target && target.dataset.dockkitPane !== drag.pane) this.swap()
      }
    }
    this.onCancel(); this.refresh()
  }
  private swap(): void {
    if (!this.session || this.panes().length !== 2) return
    if (this.swapped.has(this.session)) this.swapped.delete(this.session); else this.swapped.add(this.session)
    try { localStorage.setItem('dsh-mobile-workspace-swap:' + this.session, this.swapped.has(this.session) ? '1' : '0') } catch { /* private storage */ }
    this.refresh()
  }
  private readonly onCancel = (): void => {
    if (this.pointerOwner && this.gesture) {
      if (this.pointerOwner.hasPointerCapture?.(this.gesture.pointer)) this.pointerOwner.releasePointerCapture(this.gesture.pointer)
      this.pointerOwner.removeAttribute('data-dockkit-pointer')
    }
    this.pointerOwner = undefined
    this.gesture = undefined; this.snapshotAtPress = undefined
    document.documentElement.removeAttribute('data-dsh-workspace-dragging')
    this.panel?.querySelector<HTMLElement>('[data-dockkit-split]')?.style.removeProperty('--dsh-workspace-preview-ratio')
    this.refresh()
  }
  private readonly onKey = (event: KeyboardEvent): void => {
    if (!(event.target instanceof Element)) return
    if (event.key === 'Escape' && this.gesture) { event.preventDefault(); this.onCancel(); return }
    if (event.target.closest('[data-workspace-grip]') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); this.swap() }
    const separator = event.target.closest('[data-dockkit-divider]')
    if (!separator || !this.panel?.contains(separator) || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    const layout = this.layout(), root = layout?.nodes[layout.rootId]
    if (!layout || root?.kind !== 'split' || !this.session) return
    event.preventDefault(); event.stopImmediatePropagation()
    const grid = this.panel?.querySelector<HTMLElement>('[data-dockkit-split]'), bounds = grid?.getBoundingClientRect()
    const extent = bounds ? (portraitWorkspace() ? bounds.height : bounds.width) : 300
    const proposed = root.sizes[0] + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -.05 : .05)
    const ratio = event.key === 'Home' ? .5 : splitFraction(proposed * (extent - DIVIDER_HIT_SIZE) + DIVIDER_HIT_SIZE / 2, extent)
    this.store()?.actions.resizeSplit(this.session, root.id, [ratio, 1 - ratio])
  }
  private resizeTimer: number | undefined
  private readonly onResize = (): void => {
    this.clamped.clear()
    if (this.gesture) this.onCancel()
    this.refresh()
    // The rotated layout can settle after the resize event itself (the panel may still report
    // its portrait rect on the first sync). Clamp again against the settled panel so a float
    // does not stay at the old side of the screen.
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = undefined
      this.clamped.clear()
      this.refresh()
    }, 250)
  }
  private readonly onFocus = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.panel?.contains(event.target)) return
    const section = event.target.closest<HTMLElement>('[data-dockkit-pane]'), pane = section?.dataset.dockkitPane as PaneId | undefined
    if (pane && this.session && this.layout()?.activePaneId !== pane) this.store()?.actions.focusPane(this.session, pane)
    if (event.target.matches('input,textarea,[contenteditable=true]')) requestAnimationFrame(() => { if (event.target instanceof HTMLElement) event.target.scrollIntoView?.({ block: 'nearest' }) })
  }
}

/** 0.2.x definitions are shared objects. Retain the terminal view without replacing its provider/key. */
export function retainWorkspaceTypes(registry: {
  get(kind: string): { readonly keepMounted?: boolean } | undefined
  subscribe(listener: () => void): () => void
}): () => void {
  const previous = new Map<object, PropertyDescriptor | undefined>()
  const sync = (): void => {
    for (const kind of Object.keys(TAB_CAPABILITIES)) {
      if (!TAB_CAPABILITIES[kind].split) continue
      const definition = registry.get(kind)
      if (!definition || definition.keepMounted === true || previous.has(definition)) continue
      const descriptor = Object.getOwnPropertyDescriptor(definition, 'keepMounted')
      if (descriptor?.configurable === false || !Object.isExtensible(definition)) continue
      previous.set(definition, descriptor)
      Object.defineProperty(definition, 'keepMounted', { value: true, enumerable: true, writable: true, configurable: true })
    }
  }
  sync()
  const unsubscribe = registry.subscribe(sync)
  return () => {
    unsubscribe()
    for (const [definition, descriptor] of previous) {
      if (descriptor) Object.defineProperty(definition, 'keepMounted', descriptor)
      else Reflect.deleteProperty(definition, 'keepMounted')
    }
  }
}
