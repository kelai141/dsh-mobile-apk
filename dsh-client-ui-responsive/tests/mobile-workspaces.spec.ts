// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseFillRegular: () => null,
  IconCloseOutlineRegular: () => null,
  IconPanelLeftOutlineRegular: () => null,
  IconPlusOutlineRegular: () => null,
  MenuSurface: () => null,
  Tooltip: ({ children }: { children?: unknown }) => children,
  focusWithoutRing: () => {},
  modalSelector: '',
  observeComposition: () => () => {},
}))
import {
  Sequencer, applyOp, createIdMinter, createInitialState,
  planFloatTab, planOpenContent, planPlaceTab, planResizeSplit, planSettle, planSplitPane, planUnfloatPane,
  type PaneId, type TabId, type TabRecord, type LayoutOp, type LayoutState, type FloatRect, type SplitId,
} from '@deepseek-ai/dsh-client-ui-dockkit'
import {
  DIVIDER_HIT_SIZE, MobileWorkspaces, clampFloatRect, portraitWorkspace, retainWorkspaceTypes, splitFraction, tabCapability,
} from '../src/client/mobile/mobile-workspaces.ts'

const SESSION = 'workspace-session'
const drafts = new Map<string, { text: string }>()
const mounted: MobileWorkspaces[] = []

describe('mobile float bounds and orientation', () => {
  it('keeps the whole floating frame inside the panel below the title bar', () => {
    expect(clampFloatRect({ x: -50, y: -20, width: 500, height: 800 }, { left: 0, top: 48, right: 360, bottom: 640 }))
      .toEqual({ x: 8, y: 56, width: 344, height: 576 })
  })

  it('moves the origin back when the minimum frame no longer fits at the current edge', () => {
    const rect = clampFloatRect({ x: 240, y: 290, width: 100, height: 100 }, { left: 0, top: 0, right: 260, bottom: 300 })
    expect(rect).toEqual({ x: 32, y: 152, width: 220, height: 140 })
  })

  it('prefers the visible viewport over a stale screen orientation report', () => {
    viewport(400, 800)
    const screen = window.screen as Screen & { orientation?: unknown }
    const original = Object.getOwnPropertyDescriptor(screen, 'orientation')
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'landscape-primary' } })
    try {
      expect(portraitWorkspace()).toBe(true)
    } finally {
      if (original === undefined) Reflect.deleteProperty(screen, 'orientation')
      else Object.defineProperty(screen, 'orientation', original)
    }
  })

  it('treats every built-in file preview kind as split and float capable', () => {
    for (const kind of ['files', 'text', 'plan', 'changes-review', 'scheduleTask', 'open-with']) {
      expect(tabCapability({ id: 'tab', kind, contentId: kind, title: kind } as TabRecord)).toEqual({ split: true, float: true })
    }
    expect(tabCapability({ id: 'display', kind: 'android-vdisplay', contentId: 'display', title: '虚拟屏' } as TabRecord))
      .toEqual({ split: false, float: false })
  })
})

describe('workspace divider fraction geometry', () => {
  it('uses one 20px hit track for both the accessible divider and the fraction math', () => {
    expect(DIVIDER_HIT_SIZE).toBe(20)
  })

  it.each([400, 800, 600])('keeps both content tracks at least 128px with the shared divider track at extent %i', extent => {
    const left = splitFraction(0, extent)
    const right = splitFraction(extent, extent)
    const available = extent - DIVIDER_HIT_SIZE

    // Allow only floating-point noise; CSS grid can retain fractional pixels.
    expect(left * available).toBeCloseTo(128, 8)
    expect((1 - right) * available).toBeCloseTo(128, 8)
  })

  it.each([400, 800, 600])('keeps the divider centered position at an even split for extent %i', extent => {
    const ratio = splitFraction(extent / 2, extent)
    expect(ratio).toBeCloseTo(.5, 10)
  })
})

function viewport(width = 800, height = 1200) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect
}

function pointer(type: string, target: EventTarget, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: 4 }, button: { value: 0 }, isPrimary: { value: true },
    clientX: { value: x }, clientY: { value: y },
  })
  target.dispatchEvent(event)
}

/** Native Sidebar store action shape backed by the shipped Dockkit planners and settle planner. */
class NativeActionFixture {
  private readonly mint = createIdMinter()
  private readonly initialTab = (id: TabId): TabRecord => {
    drafts.set('draft-a', { text: 'draft:draft-a' })
    return { id, kind: 'conversation', title: '初始对话', contentId: 'draft-a' }
  }
  private placeholder = 0
  private readonly paneTab = (id: TabId): TabRecord => {
    const contentId = `placeholder-${++this.placeholder}`
    drafts.set(contentId, { text: `draft:${contentId}` })
    return { id, kind: 'workspace-placeholder', title: '工作区占位', contentId }
  }
  private readonly sequence = new Sequencer(createInitialState(this.mint, this.initialTab))
  private readonly listeners = new Set<() => void>()
  private snapshot: { state: LayoutState } = { state: this.sequence.state }

  getSnapshot(): { state: LayoutState } { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private commit(ops: readonly LayoutOp[], settle = true): void {
    if (!ops.length) return
    let after = this.sequence.state
    for (const op of ops) after = applyOp(after, op).state
    const followups = settle ? planSettle(after, this.mint.next, this.initialTab) : []
    this.sequence.dispatchAll([...ops, ...followups])
    this.snapshot = { state: this.sequence.state }
    this.listeners.forEach(listener => listener())
  }
  openContent(input: { kind: string; contentId: string; title: string }): TabId {
    if (!drafts.has(input.contentId)) drafts.set(input.contentId, { text: `draft:${input.contentId}` })
    const planned = planOpenContent(this.sequence.state, this.mint.next, input)
    this.commit(planned.ops)
    return planned.tabId
  }
  focusTab(tabId: TabId): void { this.commit([{ type: 'focusTab', tabId }]) }
  focusPane(paneId: PaneId): void { this.commit([{ type: 'focusPane', paneId }]) }
  splitPane(paneId: PaneId): PaneId | undefined {
    const before = new Set(Object.keys(this.sequence.state.nodes))
    const ops = planSplitPane(this.sequence.state, this.mint.next, paneId, this.paneTab)
    if (!ops.length) return
    this.commit(ops)
    const pane = Object.values(this.sequence.state.nodes).find(node => node.kind === 'pane' && !before.has(node.id))
    return pane?.kind === 'pane' ? pane.id : undefined
  }
  placeTab(tabId: TabId, paneId: PaneId, index: number): void {
    this.commit(planPlaceTab(this.sequence.state, tabId, paneId, index))
  }
  closeTab(tabId: TabId): void { this.commit([{ type: 'closeTab', tabId }]) }
  floatTab(tabId: TabId, rect: FloatRect): PaneId {
    const planned = planFloatTab(this.sequence.state, this.mint.next, tabId, rect)
    this.commit(planned.ops)
    return planned.paneId
  }
  unfloatPane(paneId: PaneId): void { this.commit(planUnfloatPane(this.sequence.state, paneId)) }
  resizeSplit(splitId: SplitId, sizes: readonly number[]): void { this.commit(planResizeSplit(splitId, sizes), false) }
}

function makeHarness() {
  const dock = new NativeActionFixture()
  const nativeSnapshot = { bySession: { [SESSION]: { layout: dock.getSnapshot().state } } }
  let mountedSession: string | undefined = SESSION
  const contentBodies = new Map<TabId, HTMLElement>()
  const panel = document.createElement('aside')
  panel.setAttribute('data-sidebar-right-panel', '')
  panel.setAttribute('data-sidebar-right-open', '')
  panel.setAttribute('data-sidebar-right-session', SESSION)
  panel.getBoundingClientRect = () => rect(0, 0, 640, 720)
  const surface = document.createElement('div')
  surface.setAttribute('data-dockkit-surface', '')
  const grid = document.createElement('div')
  grid.setAttribute('data-dockkit-split', '')
  grid.getBoundingClientRect = () => rect(0, 48, 640, 600)
  surface.append(grid)
  panel.append(surface)
  document.body.append(panel)

  const renderNativeLayout = () => {
    const state = dock.getSnapshot().state
    const root = state.nodes[state.rootId]
    const paneIds = root.kind === 'pane' ? [root.id] : root.children.map(id => state.nodes[id]).filter(node => node.kind === 'pane').map(node => node.id)
    grid.replaceChildren()
    if (root.kind === 'split') {
      const divider = document.createElement('div')
      divider.setAttribute('data-dockkit-divider', '')
      divider.getBoundingClientRect = () => rect(314, 48, 12, 600)
      grid.append(divider)
    }
    paneIds.forEach((paneId, index) => {
      const pane = state.nodes[paneId]
      if (pane.kind !== 'pane') return
      const section = document.createElement('section')
      section.setAttribute('data-dockkit-pane', pane.id)
      if (pane.id === state.activePaneId) section.setAttribute('data-dockkit-pane-active', '')
      const cell = document.createElement('div')
      cell.setAttribute('data-dockkit-host', 'dock')
      cell.setAttribute('data-dockkit-column', String(index))
      cell.style.gridColumn = String(index * 2 + 1)
      const strip = document.createElement('div')
      strip.setAttribute('data-dockkit-strip', pane.id)
      const inactiveBodies: Array<{ id: TabId; body: HTMLElement }> = []
      for (const id of pane.tabs) {
        const tab = state.tabs[id]
        const chip = document.createElement('button')
        chip.setAttribute('data-dockkit-tab', id)
        chip.setAttribute('aria-selected', String(pane.activeTabId === id))
        const title = document.createElement('span')
        title.setAttribute('data-dockkit-tab-title', '')
        title.textContent = tab.title
        chip.append(title)
        strip.append(chip)
        let body = contentBodies.get(id)
        if (!body) {
          body = document.createElement('div')
          body.dataset.contentId = tab.contentId
          body.textContent = drafts.get(tab.contentId)?.text ?? ''
          contentBodies.set(id, body)
        }
        if (id !== pane.activeTabId) inactiveBodies.push({ id, body })
      }
      const header = document.createElement('div')
      header.className = 'test-tabHostHeader'
      header.append(strip)
      const body = document.createElement('div')
      body.className = 'test-tabHostBody'
      const activeBody = pane.activeTabId && contentBodies.get(pane.activeTabId)
      if (activeBody) body.append(activeBody)
      section.append(header, body)
      section.getBoundingClientRect = () => rect(index * 320, 48, 308, 600)
      cell.append(section)
      grid.append(cell)
      for (const item of inactiveBodies) {
        const hiddenCell = document.createElement('div')
        hiddenCell.setAttribute('data-dockkit-host', 'dock')
        hiddenCell.setAttribute('data-dockkit-column', String(index))
        hiddenCell.setAttribute('data-dockkit-content', item.id)
        hiddenCell.hidden = true
        const hiddenSection = document.createElement('section')
        hiddenSection.append(item.body)
        hiddenCell.append(hiddenSection)
        grid.append(hiddenCell)
      }
    })
  }
  renderNativeLayout()
  const store = {
    getSnapshot: () => nativeSnapshot,
    subscribe: (listener: () => void) => dock.subscribe(listener),
    actions: {
      focusTab: (_session: string, id: TabId) => dock.focusTab(id),
      focusPane: (_session: string, id: PaneId) => dock.focusPane(id),
      splitPane: (_session: string, pane: PaneId, settled: (created: PaneId) => void) => {
        const created = dock.splitPane(pane)
        if (created) settled(created)
      },
      placeTab: (_session: string, id: TabId, pane: PaneId, index: number) => { dock.placeTab(id, pane, index) },
      closeTab: (_session: string, id: TabId) => dock.closeTab(id),
      floatTab: (_session: string, id: TabId, bounds: { x: number; y: number; width: number; height: number }) => { dock.floatTab(id, bounds) },
      unfloatPane: (_session: string, id: PaneId) => dock.unfloatPane(id),
      resizeSplit: (_session: string, id: string, sizes: readonly number[]) => dock.resizeSplit(id as never, sizes),
    },
  }
  const owner = {
    mounted: { getSnapshot: () => mountedSession },
    adopted: new Map([[SESSION, { store }]]),
  }
  const workspaces = new MobileWorkspaces(owner)
  mounted.push(workspaces)
  dock.subscribe(() => { nativeSnapshot.bySession[SESSION].layout = dock.getSnapshot().state })
  dock.subscribe(() => renderNativeLayout())
  workspaces.attach()
  const flush = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const open = (kind: string, contentId: string, title = contentId) => dock.openContent({ kind, contentId, title })
  return {
    dock, panel, grid, workspaces, contentBodies, open, flush,
    setMountedSession: (id: string | undefined) => { mountedSession = id },
  }
}

afterEach(() => {
  for (const workspaces of mounted.splice(0)) workspaces.detach()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-workspace-dragging')
  drafts.clear()
  vi.restoreAllMocks()
})

describe('mobile workspace navigation over native Dockkit planners', () => {
  it('rejects the dedicated virtual-display surface without splitting the native layout', async () => {
    viewport()
    const h = makeHarness()
    const display = h.open('android-vdisplay', 'display:one', '虚拟屏')
    await h.flush()
    const before = h.dock.getSnapshot()

    expect(h.workspaces.activeId).toBe(display)
    expect(h.workspaces.split()).toBe(false)
    expect(h.dock.getSnapshot()).toBe(before)
    expect(h.panel.querySelector('[role="status"]')?.textContent).toContain('专用视图')
    h.workspaces.detach()
  })

  it('fails closed when the mounted session changes before a split action', async () => {
    viewport()
    const h = makeHarness()
    await h.flush()
    const before = h.dock.getSnapshot()
    const split = vi.spyOn(h.dock, 'splitPane')
    h.setMountedSession('another-session')

    expect(h.workspaces.split()).toBe(false)
    expect(split).not.toHaveBeenCalled()
    expect(h.dock.getSnapshot()).toBe(before)
    h.workspaces.detach()
  })

  it('filters the split selector by tab capability and native-surface compatibility', async () => {
    viewport()
    const h = makeHarness()
    const browser = h.open('browser', 'browser:one', '浏览器一')
    const secondBrowser = h.open('android-browser', 'browser:two', '浏览器二')
    const conversation = h.open('conversation', 'conversation:two', '另一对话')
    const display = h.open('android-vdisplay', 'display:two', '虚拟屏二')
    h.dock.focusTab(browser)
    await h.flush()

    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    expect(h.panel.querySelector('[data-dsh-workspace-picker]')?.parentElement?.hasAttribute('data-dsh-workspace-choosing')).toBe(true)
    const buttons = [...h.panel.querySelectorAll<HTMLButtonElement>('[data-dsh-workspace-picker] button')]
    const byLabel = new Map(buttons.map(button => [button.textContent, button]))
    expect(byLabel.get('浏览器二')?.disabled).toBe(true)
    expect(byLabel.get('另一对话')?.disabled).toBe(false)
    expect(byLabel.get('虚拟屏二')?.disabled).toBe(true)
    byLabel.get('另一对话')?.click()
    await h.flush()
    expect(h.panel.querySelector('[data-dsh-workspace-choosing]')).toBeNull()
    expect(Object.values(h.dock.getSnapshot().state.tabs).some(tab => tab.id === conversation)).toBe(true)
    expect(Object.values(h.dock.getSnapshot().state.tabs).some(tab => tab.id === secondBrowser)).toBe(true)
    expect(Object.values(h.dock.getSnapshot().state.tabs).some(tab => tab.id === display)).toBe(true)
    h.workspaces.detach()
  })

  it('lets a file preview tab join a split and then become the small window', async () => {
    viewport()
    const h = makeHarness()
    const first = Object.keys(h.dock.getSnapshot().state.tabs)[0] as TabId
    const files = h.open('files', 'files:workspace', '文件')
    await h.flush()
    h.dock.focusTab(first)
    await h.flush()

    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    const filesButton = [...h.panel.querySelectorAll<HTMLButtonElement>('[data-dsh-workspace-picker] button')]
      .find(button => button.textContent === '文件')
    expect(filesButton?.disabled).toBe(false)
    filesButton?.click()
    await h.flush()
    expect(h.panel.querySelector('[data-dsh-workspace-choosing]')).toBeNull()
    expect(h.panel.querySelectorAll('[data-dsh-workspace-slot]').length).toBeGreaterThan(0)

    h.dock.focusTab(files)
    await h.flush()
    expect(h.workspaces.float()).toBe(true)
    await h.flush()
    const floated = Object.values(h.dock.getSnapshot().state.nodes)
      .find(node => node.kind === 'pane' && node.host === 'float')
    expect(floated?.kind === 'pane' ? floated.tabs : []).toContain(files)
    h.workspaces.detach()
  })

  it('drops the split slot markers when the layout collapses to one pane', async () => {
    viewport()
    const h = makeHarness()
    const first = Object.keys(h.dock.getSnapshot().state.tabs)[0] as TabId
    const second = h.open('terminal', 'terminal:slot', '终端')
    await h.flush()
    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    expect(h.grid.querySelectorAll('[data-dsh-workspace-slot]').length).toBeGreaterThan(0)

    const state = h.dock.getSnapshot().state
    const root = state.nodes[state.rootId]
    const side = root.kind === 'split'
      ? root.children.map(id => state.nodes[id]).find(node => node.kind === 'pane' && !node.tabs.includes(first))
      : undefined
    expect(side?.kind).toBe('pane')
    h.dock.placeTab(second, side!.kind === 'pane' ? side!.id : first, 999999)
    await h.flush()
    expect(h.workspaces.single(first)).toBe(true)
    await h.flush()
    expect(h.grid.querySelectorAll('[data-dsh-workspace-slot]')).toHaveLength(0)
    h.workspaces.detach()
  })

  it('collapses to one pane while retaining each real tab id and its content draft', async () => {
    viewport()
    const h = makeHarness()
    const first = Object.keys(h.dock.getSnapshot().state.tabs)[0] as TabId
    const second = h.open('terminal', 'terminal:work', '终端草稿')
    drafts.set('draft-a', { text: 'unsubmitted first draft' })
    drafts.set('terminal:work', { text: 'unsubmitted terminal command' })
    await h.flush()
    const root = h.dock.getSnapshot().state.nodes[h.dock.getSnapshot().state.rootId]
    const rootPane = root.kind === 'pane' ? root.id : root.children.map(id => h.dock.getSnapshot().state.nodes[id]).find(node => node.kind === 'pane')!.id

    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    const panes = Object.values(h.dock.getSnapshot().state.nodes).filter(node => node.kind === 'pane')
    const side = panes.find(pane => pane.id !== rootPane)!
    h.dock.placeTab(second, side.id, 999999)
    await h.flush()
    const firstBody = h.contentBodies.get(first)!
    const secondBody = h.contentBodies.get(second)!
    const draftsBefore = [drafts.get('draft-a')?.text, drafts.get('terminal:work')?.text]

    expect(h.workspaces.single(first)).toBe(true)
    await h.flush()
    const finalState = h.dock.getSnapshot().state
    expect(Object.values(finalState.nodes).filter(node => node.kind === 'pane' && node.host === 'dock')).toHaveLength(1)
    expect(finalState.tabs[first]?.id).toBe(first)
    expect(finalState.tabs[second]?.id).toBe(second)
    expect(Object.values(finalState.tabs).map(tab => tab.id).sort()).toEqual([first, second].sort())
    expect(h.contentBodies.get(first)).toBe(firstBody)
    expect(h.contentBodies.get(second)).toBe(secondBody)
    expect([drafts.get('draft-a')?.text, drafts.get('terminal:work')?.text]).toEqual(draftsBefore)
    h.workspaces.detach()
  })

  it('floats the active tab and restores focus to the most recently used remaining tab', async () => {
    viewport(360, 640)
    const h = makeHarness()
    const first = Object.keys(h.dock.getSnapshot().state.tabs)[0] as TabId
    const second = h.open('terminal', 'terminal:second', '终端二')
    const third = h.open('conversation', 'conversation:third', '对话三')
    await h.flush()
    h.dock.focusTab(second)
    await h.flush()
    h.dock.focusTab(third)
    await h.flush()
    drafts.set('conversation:third', { text: 'draft kept while floating' })

    expect(h.workspaces.activeId).toBe(third)
    expect(h.workspaces.float()).toBe(true)
    await h.flush()
    const floated = Object.values(h.dock.getSnapshot().state.nodes).find(node => node.kind === 'pane' && node.host === 'float')
    expect(floated?.kind).toBe('pane')
    expect(floated?.tabs).toContain(third)
    expect(h.workspaces.activeId).toBe(second)
    expect(h.dock.getSnapshot().state.tabs[third]?.contentId).toBe('conversation:third')
    expect(drafts.get('conversation:third')?.text).toBe('draft kept while floating')
    expect(h.dock.getSnapshot().state.tabs[first]?.id).toBe(first)
    h.workspaces.detach()
  })

  it('shows the selector when floating leaves no alternate dock tab', async () => {
    viewport(360, 640)
    const h = makeHarness()
    const only = Object.keys(h.dock.getSnapshot().state.tabs)[0] as TabId
    await h.flush()

    expect(h.workspaces.float()).toBe(true)
    await h.flush()
    const floats = Object.values(h.dock.getSnapshot().state.nodes).filter(node => node.kind === 'pane' && node.host === 'float')
    expect(floats).toHaveLength(1)
    expect(h.panel.querySelector('[data-dsh-workspace-picker]')).not.toBeNull()
    expect(h.panel.querySelector('[data-dsh-workspace-picker] button')?.textContent).toBe('初始对话')
    expect(h.workspaces.single(only)).toBe(true)
    await h.flush()
    expect(Object.values(h.dock.getSnapshot().state.nodes).some(node => node.kind === 'pane' && node.host === 'float')).toBe(false)
    expect(h.dock.getSnapshot().state.tabs[only]?.id).toBe(only)
    h.workspaces.detach()
  })

  it('keeps an unvisited real dock tab when a no-history float selector is dismissed', async () => {
    viewport(360, 640)
    const h = makeHarness()
    const initial = Object.keys(h.dock.getSnapshot().state.tabs)[0] as TabId
    const unseen = h.open('terminal', 'terminal:unvisited', '未访问终端')
    const floated = h.open('conversation', 'conversation:floating', '小窗对话')
    h.dock.closeTab(initial)
    expect(h.workspaces.float()).toBe(true)
    await h.flush()
    expect(h.workspaces.single(floated)).toBe(true)
    await h.flush()
    expect(h.dock.getSnapshot().state.tabs[unseen]?.contentId).toBe('terminal:unvisited')
    expect(h.dock.getSnapshot().state.tabs[floated]?.id).toBe(floated)
  })

  it('places an existing browser float back through its enabled split picker entry', async () => {
    viewport()
    const h = makeHarness()
    const browser = h.open('browser', 'browser:return-existing', '已有浏览器')
    await h.flush()
    expect(h.workspaces.float()).toBe(true)
    await h.flush()
    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    const button = [...h.panel.querySelectorAll<HTMLButtonElement>('[data-dsh-workspace-picker] button')].find(node => node.textContent === '已有浏览器')!
    expect(button.disabled).toBe(false)
    button.click()
    await h.flush()
    const layout = h.dock.getSnapshot().state
    expect(Object.values(layout.nodes).some(pane => pane.kind === 'pane' && pane.host === 'dock' && pane.tabs.includes(browser))).toBe(true)
    expect(layout.floats).toHaveLength(0)
    expect(Object.values(layout.tabs).filter(tab => tab.contentId === 'browser:return-existing')).toHaveLength(1)
  })

  it('rebuilds a stale selector when the same tab title changes', async () => {
    viewport()
    const h = makeHarness()
    const second = h.open('terminal', 'terminal:title', '旧标题')
    const first = Object.keys(h.dock.getSnapshot().state.tabs).find(id => id !== second) as TabId
    h.dock.focusTab(first)
    await h.flush()
    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    const picker = () => h.panel.querySelector<HTMLElement>('[data-dsh-workspace-picker]')!
    expect(picker().textContent).toContain('旧标题')
    const oldSignature = picker().dataset.signature
    const tabs = h.dock.getSnapshot().state.tabs
    Object.assign(tabs[second]!, { title: '新标题' })
    h.workspaces.refresh()
    await h.flush()
    expect(picker().dataset.signature).not.toBe(oldSignature)
    expect(picker().textContent).toContain('新标题')
    h.workspaces.detach()
  })

  it('clamps an extreme divider drag and cancels a later drag without committing it', async () => {
    viewport()
    const h = makeHarness()
    expect(h.workspaces.split()).toBe(true)
    await h.flush()
    const divider = h.panel.querySelector<HTMLElement>('[data-dockkit-divider]')!
    const splitId = h.dock.getSnapshot().state.rootId as never
    const startSizes = [...(h.dock.getSnapshot().state.nodes[splitId] as { sizes: readonly number[] }).sizes]

    pointer('pointerdown', divider, 320, 300)
    pointer('pointermove', document, 300, -900)
    pointer('pointerup', document, 300, -900)
    await h.flush()
    const clamped = (h.dock.getSnapshot().state.nodes[splitId] as { sizes: readonly number[] }).sizes
    expect(clamped[0]).toBeCloseTo(128 / (600 - DIVIDER_HIT_SIZE), 8)
    expect(clamped[1]).toBeCloseTo(1 - 128 / (600 - DIVIDER_HIT_SIZE), 8)

    const currentDivider = h.panel.querySelector<HTMLElement>('[data-dockkit-divider]')!
    pointer('pointerdown', currentDivider, 320, 300)
    pointer('pointermove', document, 300, 700)
    expect(document.documentElement.hasAttribute('data-dsh-workspace-dragging')).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await h.flush()
    const afterCancel = (h.dock.getSnapshot().state.nodes[splitId] as { sizes: readonly number[] }).sizes
    expect(afterCancel).toEqual(clamped)
    expect(document.documentElement.hasAttribute('data-dsh-workspace-dragging')).toBe(false)
    expect(h.grid.style.getPropertyValue('--dsh-workspace-preview-ratio')).toBe('')
    expect(startSizes).toEqual([0.5, 0.5])
    h.workspaces.detach()
  })

  it('cancels an invalid drop without changing tab identity or leaving a preview', async () => {
    viewport()
    const h = makeHarness()
    const tab = h.open('conversation', 'conversation:drop', '待放置对话')
    await h.flush()
    const before = h.dock.getSnapshot()

    expect(h.workspaces.drop(tab, 900, 900)).toBe(false)
    expect(h.dock.getSnapshot()).toBe(before)
    expect(h.panel.querySelector('.dsh-workspace-drop-preview')).toBeNull()
    expect(h.dock.getSnapshot().state.tabs[tab]?.contentId).toBe('conversation:drop')
    h.workspaces.detach()
  })

  it('retains eligible shared tab definitions and restores their original descriptors on dispose', () => {
    const provider = { render: vi.fn() }
    const conversation = { provider, keepMounted: false }
    const terminal = { provider, key: 'terminal-provider-key' }
    const alreadyRetained = { keepMounted: true, provider }
    const virtualDisplay = { provider }
    const definitions = new Map<string, { keepMounted?: boolean; provider: typeof provider; key?: string }>([
      ['conversation', conversation], ['terminal', terminal], ['browser', alreadyRetained], ['android-vdisplay', virtualDisplay],
    ])
    const listener = vi.fn()
    const unsubscribe = vi.fn()
    const registry = {
      get: (kind: string) => definitions.get(kind),
      subscribe: (callback: () => void) => { listener.mockImplementation(callback); return unsubscribe },
    }
    const originalConversation = Object.getOwnPropertyDescriptor(conversation, 'keepMounted')
    const dispose = retainWorkspaceTypes(registry)

    expect(conversation.keepMounted).toBe(true)
    expect(terminal.keepMounted).toBe(true)
    expect(alreadyRetained.keepMounted).toBe(true)
    expect(Object.hasOwn(virtualDisplay, 'keepMounted')).toBe(false)
    expect(conversation.provider).toBe(provider)
    expect(terminal.provider).toBe(provider)
    expect(terminal.key).toBe('terminal-provider-key')

    const lateTerminal = { provider, key: 'late-terminal-key' }
    definitions.set('terminal', lateTerminal)
    listener()
    expect(lateTerminal.keepMounted).toBe(true)
    expect(lateTerminal.provider).toBe(provider)
    expect(lateTerminal.key).toBe('late-terminal-key')

    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(conversation, 'keepMounted')).toEqual(originalConversation)
    expect(Object.hasOwn(terminal, 'keepMounted')).toBe(false)
    expect(Object.hasOwn(lateTerminal, 'keepMounted')).toBe(false)
    expect(alreadyRetained.keepMounted).toBe(true)
  })
})
