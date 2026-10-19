// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { SidebarReorder, REORDER_ATTR } from '../src/client/mobile/sidebar-reorder.ts'
import { ConversationDropZone, conversationAddress, conversationId, conversationTarget, existingConversation, resolveDockSubagent, registerConversationDock } from '../src/client/mobile/conversation-dock.tsx'

function touch(type: string, target: HTMLElement, x: number, y = 100, multiple = false) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  const point = { identifier: 1, clientX: x, clientY: y }
  Object.defineProperties(e, { touches: { value: type === 'touchend' ? [] : multiple ? [point, { ...point, identifier: 2 }] : [point] }, changedTouches: { value: [point] } })
  target.dispatchEvent(e)
}
let drag: SidebarReorder
let zone: ConversationDropZone
let open: ReturnType<typeof vi.fn>
function row(child = false) {
  const el = document.createElement('div')
  if (child) { el.setAttribute('role', 'treeitem'); el.innerHTML = '<button class="subagent_sidebarButton_x">侧开</button>' }
  else { el.dataset.rowKey = 'session:session/a'; el.draggable = true }
  document.body.append(el)
  return el
}
beforeEach(() => {
  vi.useFakeTimers()
  open = vi.fn()
  zone = new ConversationDropZone(open)
  drag = new SidebarReorder(zone)
  Object.defineProperty(document, 'elementFromPoint', { value: () => document.body, configurable: true })
  drag.attach()
})
afterEach(() => { drag.detach(); zone.detach(); document.body.innerHTML = ''; vi.useRealTimers() })
describe('conversation docking', () => {
  it('keeps resource identities unambiguous', () => {
    expect(conversationId(conversationAddress('a/b?中文'))).toBe('a/b?中文')
    expect(conversationId('invalid')).toBeUndefined()
    expect(conversationId('dsh-resource://conversation/session/%xx')).toBeUndefined()
  })
  it('prompts to drag in first and only says release after entering the target', () => {
    const source = row()
    touch('touchstart', source, 80); vi.advanceTimersByTime(400)
    const target = () => document.querySelector('.dsh-conversation-drop-zone:not([data-leaving])')
    expect(target()?.textContent).toBe('拖到此处以在侧边栏打开')
    expect(target()?.hasAttribute('data-over')).toBe(false)
    touch('touchmove', source, innerWidth - 8)
    expect(target()?.textContent).toBe('松开于侧边栏打开')
    expect(target()?.hasAttribute('data-over')).toBe(true)
    // 移出接收区回到列表：必须退回「拖到此处」，不能停在「松开」。
    touch('touchmove', source, 80)
    expect(target()?.textContent).toBe('拖到此处以在侧边栏打开')
    expect(target()?.hasAttribute('data-over')).toBe(false)
  })
  it('opens once after settling reorder and removes the target (also in landscape)', () => {
    const source = row()
    const events: string[] = []
    source.addEventListener('drop', () => { events.push('cancel-order'); source.remove() })
    open.mockImplementation(() => { expect(document.documentElement.hasAttribute(REORDER_ATTR)).toBe(false); events.push('open') })
    touch('touchstart', source, 80); vi.advanceTimersByTime(400)
    expect(document.querySelector('.dsh-conversation-drop-zone')).not.toBeNull()
    touch('touchmove', source, innerWidth - 8)
    touch('touchend', source, innerWidth - 8)
    touch('touchend', source, innerWidth - 8)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('session/a')
    expect(events).toEqual(['cancel-order', 'open'])
    expect(document.querySelector('.dsh-conversation-drop-zone:not([data-leaving])')).toBeNull()
  })
  it('uses the subagent row action without navigating the main conversation', () => {
    const source = row(true)
    const aside = vi.fn()
    source.querySelector('button')!.addEventListener('click', aside)
    const main = vi.fn(); source.addEventListener('click', main)
    source.querySelector('button')!.addEventListener('click', e => e.stopPropagation())
    touch('touchstart', source, 80); vi.advanceTimersByTime(400)
    touch('touchend', source, innerWidth - 8)
    expect(aside).toHaveBeenCalledTimes(1); expect(main).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  })
  it('ignores title marquee scroll but cancels real ancestor scrolling', () => {
    const source = row(); const title = document.createElement('span'); source.append(title)
    touch('touchstart', title, 80); title.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(400)
    expect(document.documentElement.hasAttribute(REORDER_ATTR)).toBe(true)
    touch('touchend', source, innerWidth - 8)
    expect(open).toHaveBeenCalledTimes(1)
    touch('touchstart', source, 80); document.body.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(400)
    expect(document.documentElement.hasAttribute(REORDER_ATTR)).toBe(false)
  })
  it('does not claim workspace rows even though they are draggable treeitems', () => {
    const source = row(true); source.dataset.rowKey = 'workspace:project'; source.draggable = true; source.innerHTML = '项目'
    touch('touchstart', source, 80); vi.advanceTimersByTime(400)
    expect(document.documentElement.hasAttribute(REORDER_ATTR)).toBe(false)
    touch('touchend', source, innerWidth - 8)
    expect(open).not.toHaveBeenCalled()
  })
  it('does not open a source removed while dragging', () => {
    const source = row(); touch('touchstart', source, 80); vi.advanceTimersByTime(400)
    source.remove(); touch('touchend', document.body, innerWidth - 8)
    expect(open).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute(REORDER_ATTR)).toBe(false)
  })
  it.each(['touchcancel', 'multitouch', 'outside', 'detach'])('cancels %s without opening', mode => {
    const source = row()
    touch('touchstart', source, 80); vi.advanceTimersByTime(400)
    if (mode === 'detach') drag.detach()
    else if (mode === 'multitouch') touch('touchmove', source, innerWidth - 8, 100, true)
    else touch(mode === 'outside' ? 'touchend' : 'touchcancel', source, 10)
    expect(open).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute(REORDER_ATTR)).toBe(false)
    expect(document.querySelector('.dsh-conversation-drop-zone:not([data-leaving])')).toBeNull()
  })
})


describe('conversation resource lifetime', () => {
  function provider() {
    let resource: any
    const releases: ReturnType<typeof vi.fn>[] = []
    const retain = vi.fn(() => { const release = vi.fn(); releases.push(release); return { release } })
    const context = {
      effect: (mount: () => unknown) => mount(),
      resources: { register: (value: unknown) => { resource = value } },
      sessions: { retain },
      sidebarRightTabs: { register: () => {} },
      slots: { inject: () => {} },
    }
    registerConversationDock(context as any)
    return { resource, retain, releases }
  }
  it('does not acquire an already cancelled occurrence', async () => {
    const { resource, retain } = provider()
    const controller = new AbortController(); controller.abort()
    const stream = resource.open(conversationAddress('a'), { signal: controller.signal })
    expect((await stream.next()).done).toBe(true)
    expect(retain).not.toHaveBeenCalled()
  })
  it('releases each retained generation once and leaves other occurrences alive', async () => {
    const { resource, retain, releases } = provider()
    const first = new AbortController(), second = new AbortController()
    const a = resource.open(conversationAddress('a'), { signal: first.signal })
    const b = resource.open(conversationAddress('b'), { signal: second.signal })
    expect((await a.next()).done).toBe(false)
    expect((await b.next()).done).toBe(false)
    expect(retain).toHaveBeenCalledTimes(2)
    first.abort(); expect((await a.next()).done).toBe(true)
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(releases[1]).not.toHaveBeenCalled()
    second.abort(); expect((await b.next()).done).toBe(true)
    expect(releases[1]).toHaveBeenCalledTimes(1)
  })
})


describe('subagent identity resolution', () => {
  function catalogFixture() {
    document.body.innerHTML = '<div role="tree"><div role="treeitem" aria-level="1"><span class="test_label">same</span></div><div role="treeitem" aria-level="1"><span class="test_label">same</span></div></div>'
    const rows = [...document.querySelectorAll<HTMLElement>('[role=treeitem]')]
    const state = { projectionsBySession: { parent: { values: { subagentCatalog: [
      { id: 'a', label: 'same', mode: 'one-shot' }, { id: 'b', label: 'same', mode: 'continuable' },
    ] } } } }
    const sessions = { list: { getSnapshot: () => state }, subagentAddress: () => undefined }
    return { rows, sessions }
  }
  it('resolves duplicate labels by complete catalog order, never by title matching alone', () => {
    const { rows, sessions } = catalogFixture()
    const target = resolveDockSubagent(rows[1]!, sessions as any, 'parent' as any)
    expect(target).toEqual({ parentSessionId: 'parent', childSessionId: 'b', mode: 'continuable' })
    expect(conversationTarget(conversationAddress(target!))).toEqual(target)
    expect(conversationId(conversationAddress(target!))).toBe('b')
  })
  it('fails closed when visible catalog rows no longer agree with the snapshot', () => {
    const { rows, sessions } = catalogFixture()
    rows[0]!.querySelector('span')!.textContent = 'different'
    expect(resolveDockSubagent(rows[1]!, sessions as any, 'parent' as any)).toBeUndefined()
  })
  it('rejects malformed direct-parent routes', () => {
    expect(conversationTarget('dsh-resource://conversation/session/child?parent=p&mode=broken')).toBeUndefined()
    expect(conversationTarget('dsh-resource://conversation/session/child?parent=&mode=continuable')).toBeUndefined()
  })
})


describe('stable child tab identity', () => {
  it('locates the same live child across direct and catalog addresses without confusing two children', () => {
    const child = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' as const }
    const tabs = [{ id: 'child-tab', kind: 'conversation', contentId: conversationAddress(child) }]
    expect(existingConversation(tabs, 'child')).toBe('child-tab')
    expect(existingConversation(tabs, { ...child, mode: 'one-shot' })).toBe('child-tab')
    expect(existingConversation(tabs, 'different-child')).toBeUndefined()
    expect(existingConversation([{ ...tabs[0], kind: 'browser' }], 'child')).toBeUndefined()
  })
})
