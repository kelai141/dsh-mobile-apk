import { describe, expect, it, vi } from 'vitest'
import { retainDockIdentity } from '../src/client/mobile/conversation-dock'

const CHILD = 'child-42'
const OTHER_CHILD = 'child-420'
const conversation = (child = CHILD, mode = 'one-shot') =>
  `dsh-resource://conversation/session/${encodeURIComponent(child)}?parent=parent-1&mode=${mode}`
const subagentChat = (child = CHILD) => `dsh-resource://subagentchat/session/${encodeURIComponent(child)}`

function sidebarFixture(tabs: Array<{ id: string; kind: string; contentId: string }> = []) {
  const snapshot = { id: 'parent-1' }
  const owner = { getSnapshot: vi.fn(() => snapshot) }
  const original = vi.fn((_address: string, _options?: unknown) => undefined)
  const sidebar = {
    mounted: owner,
    tabsIn: vi.fn(() => tabs),
    focus: vi.fn(),
    openResource: original,
  }
  return { sidebar, original, snapshot }
}

describe('conversation and subagent chat dock identity', () => {
  it('focuses the existing child tab across both resource protocols without opening a duplicate', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-child', kind: 'conversation', contentId: conversation() },
    ])
    retainDockIdentity(sidebar as never)

    sidebar.openResource(subagentChat())

    expect(sidebar.focus).toHaveBeenCalledTimes(1)
    expect(sidebar.focus).toHaveBeenCalledWith('tab-child')
    expect(original).not.toHaveBeenCalled()
  })

  it('deduplicates in the other direction when the existing tab uses the subagentchat protocol', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-child', kind: 'subagentchat', contentId: subagentChat() },
    ])
    retainDockIdentity(sidebar as never)

    sidebar.openResource(conversation(CHILD, 'continuable'))

    expect(sidebar.focus).toHaveBeenCalledTimes(1)
    expect(sidebar.focus).toHaveBeenCalledWith('tab-child')
    expect(original).not.toHaveBeenCalled()
  })

  it('matches exact child identity and leaves a sibling id alone', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-other', kind: 'conversation', contentId: conversation(OTHER_CHILD) },
    ])
    retainDockIdentity(sidebar as never)

    sidebar.openResource(subagentChat(CHILD))

    expect(sidebar.focus).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith(subagentChat(CHILD))
  })

  it('treats mode and parent address changes as the same live child identity', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-child', kind: 'conversation', contentId: conversation(CHILD, 'one-shot') },
    ])
    retainDockIdentity(sidebar as never)

    sidebar.openResource('dsh-resource://conversation/session/child-42?parent=parent-2&mode=continuable')

    expect(sidebar.focus).toHaveBeenCalledTimes(1)
    expect(sidebar.focus).toHaveBeenCalledWith('tab-child')
    expect(original).not.toHaveBeenCalled()
  })

  it('does not swallow a non-conversation resource even if its address contains a child-like suffix', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-child', kind: 'conversation', contentId: conversation() },
    ])
    retainDockIdentity(sidebar as never)
    const resource = 'dsh-resource://browser/session/child-42'
    const options = { focus: true }

    sidebar.openResource(resource, options)

    expect(sidebar.focus).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith(resource, options)
    expect(original.mock.calls[0]?.[1]).toBe(options)
  })

  it('restores the exact original method on disposal', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-child', kind: 'conversation', contentId: conversation() },
    ])
    const dispose = retainDockIdentity(sidebar as never)
    expect(sidebar.openResource).not.toBe(original)

    dispose()

    expect(sidebar.openResource).toBe(original)
    sidebar.openResource(subagentChat())
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith(subagentChat())
  })

  it('does not overwrite a newer openResource decorator when disposed out of order', () => {
    const { sidebar, original } = sidebarFixture()
    const dispose = retainDockIdentity(sidebar as never)
    const newer = vi.fn()
    sidebar.openResource = newer as never

    dispose()

    expect(sidebar.openResource).toBe(newer)
    sidebar.openResource('dsh-resource://browser/home')
    expect(newer).toHaveBeenCalledTimes(1)
    expect(newer).toHaveBeenCalledWith('dsh-resource://browser/home')
    expect(original).not.toHaveBeenCalled()
  })

  it('does not focus a stale child tab when the mounted owner changes', () => {
    const { sidebar, original } = sidebarFixture([
      { id: 'tab-child', kind: 'conversation', contentId: conversation() },
    ])
    const currentOwner = vi.fn(() => undefined)
    sidebar.mounted.getSnapshot = currentOwner as never
    retainDockIdentity(sidebar as never)

    sidebar.openResource(subagentChat())

    expect(sidebar.tabsIn).not.toHaveBeenCalled()
    expect(sidebar.focus).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith(subagentChat())
  })
})
