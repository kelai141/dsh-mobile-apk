// @vitest-environment jsdom
// ST-15：会话身份标记（注入层据此按行所属会话解析文件路径）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SESSION_ID_ATTRIBUTE, SessionMarker } from '../src/client/mobile/session-marker.ts'

type Listener = () => void

function makeSessions(initial: string | undefined) {
  const listeners = new Set<Listener>()
  const state: { current: string | undefined } = { current: initial }
  return {
    state,
    emit: () => { for (const listener of listeners) listener() },
    face: {
      list: {
        getSnapshot: () => ({ current: state.current }),
        subscribe: (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
  }
}

beforeEach(() => { document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE) })
afterEach(() => { document.documentElement.removeAttribute(SESSION_ID_ATTRIBUTE) })

describe('SessionMarker（ST-15）', () => {
  it('挂载即发布当前会话 id（真源 = 客户端会话快照）', () => {
    const sessions = makeSessions('session-abc')
    const marker = new SessionMarker(sessions.face)
    marker.attach()
    expect(document.documentElement.getAttribute(SESSION_ID_ATTRIBUTE)).toBe('session-abc')
    marker.detach()
  })

  it('切换会话（只动真源）→ 标记跟随，无需重挂载', () => {
    const sessions = makeSessions('session-a')
    const marker = new SessionMarker(sessions.face)
    marker.attach()
    sessions.state.current = 'session-b'
    sessions.emit()
    expect(document.documentElement.getAttribute(SESSION_ID_ATTRIBUTE)).toBe('session-b')
    marker.detach()
  })

  it('无当前会话时移除标记（注入层据此不猜会话）', () => {
    const sessions = makeSessions('session-a')
    const marker = new SessionMarker(sessions.face)
    marker.attach()
    sessions.state.current = undefined
    sessions.emit()
    expect(document.documentElement.hasAttribute(SESSION_ID_ATTRIBUTE)).toBe(false)
    marker.detach()
  })

  it('detach 移除标记并退订（真源再变也不动 DOM）', () => {
    const sessions = makeSessions('session-a')
    const marker = new SessionMarker(sessions.face)
    marker.attach()
    marker.detach()
    expect(document.documentElement.hasAttribute(SESSION_ID_ATTRIBUTE)).toBe(false)
    sessions.state.current = 'session-z'
    sessions.emit()
    expect(document.documentElement.hasAttribute(SESSION_ID_ATTRIBUTE)).toBe(false)
  })

  it('会话面缺席/快照抛错时不崩（桌面宿主）', () => {
    const marker = new SessionMarker(undefined)
    marker.attach()
    expect(document.documentElement.hasAttribute(SESSION_ID_ATTRIBUTE)).toBe(false)
    marker.detach()
    const broken = new SessionMarker({ list: { getSnapshot: () => { throw new Error('gone') } } })
    expect(() => { broken.attach(); broken.detach() }).not.toThrow()
  })
})
