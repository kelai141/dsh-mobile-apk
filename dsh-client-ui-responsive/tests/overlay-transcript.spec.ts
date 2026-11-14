// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { OverlayHost, projectOverlayTranscript, type OverlayEventWindow, type OverlaySessionBinding } from '../src/client/mobile/overlay-host.ts'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'
const entry = (type: string, seq: number, data: unknown, transient = false): OverlayEventWindow['entries'][number] => ({ type: transient ? 'transient' : 'event', event: { type, seq, data } })
const user = (seq: number, text: string) => entry('user/message', seq, { id: 'u-' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (seq: number, text: string, turn = 1, step = 1) => entry('assistant/message', seq, { turn, step, message: { id: 'a-' + seq, role: 'assistant', content: [{ type: 'text', text }] } })
const delta = (seq: number, text: string, attemptId = 'attempt-1', index = 0) => entry('assistant/live-chunk', seq, { attemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index, text } }, true)
beforeEach(() => { document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'A') })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fixture() {
  const a = createSnapshotStore<OverlayEventWindow>({ entries: [user(1, 'old question'), assistant(2, 'old answer')], revision: 1 })
  const b = createSnapshotStore<OverlayEventWindow>({ entries: [user(1, 'B only')], revision: 1 })
  const la = createSnapshotStore({ sessionId: 'A', openState: 'open', removed: false })
  const lb = createSnapshotStore({ sessionId: 'B', openState: 'open', removed: false })
  const scopeA = {}, scopeB = {}
  const bindings: Record<string, OverlaySessionBinding> = {
    A: { sessionId: 'A', ctx: scopeA, session: { sessionId: 'A', ...la }, eventSource: a },
    B: { sessionId: 'B', ctx: scopeB, session: { sessionId: 'B', ...lb }, eventSource: b },
  }
  const list = createSnapshotStore({ phase: 'ready' as const, ids: ['A', 'B'], byId: { A: { title: 'A', running: false }, B: { title: 'B', running: false } } })
  const host = new OverlayHost({ sessions: () => ({ list, binding: id => bindings[id], scope: id => bindings[id]?.ctx, sessionOf: scope => scope === scopeA ? bindings.A.session : bindings.B.session }) })
  return { host, a, b, la, list, bindings }
}

describe('real overlay transcript projection', () => {
  it('reopens an existing idle Session from its public event window without DOM text or a running event', () => {
    const f = fixture()
    const state = JSON.parse(f.host.state())
    expect(state.busy).toBe(false)
    expect(state.transcriptReady).toBe(true)
    expect(state.transcript.map((row: { role: string; text: string }) => [row.role, row.text])).toEqual([['user', 'old question'], ['assistant', 'old answer']])
    f.host.watchState(true); f.host.watchState(false)
    expect(JSON.parse(f.host.state()).transcript).toEqual(state.transcript)
    f.host.dispose()
  })

  it('excludes unpaired/malformed tools, reasoning, and injected context from actual dialog', () => {
    const rows = projectOverlayTranscript('A', { entries: [
      user(1, 'human'), entry('tool/result', 2, { content: [{ type: 'text', text: 'secret tool' }] }),
      entry('user/message', 3, { source: { kind: 'instructions' }, content: [{ type: 'text', text: 'AGENTS instructions' }] }),
      entry('assistant/message', 4, { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'private thought' }, { type: 'tool-call', name: 'exec' }, { type: 'text', text: 'answer' }] } }),
    ] })
    expect(rows.map(row => row.text)).toEqual(['human', 'answer'])
  })

  it('merges stream text per attempt/index and final message replaces same stable assistant row', () => {
    const live = [user(1, 'q'), delta(2, 'hello'), delta(3, ' world'), entry('assistant/live-chunk', 4, { attemptId: 'attempt-1', turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 5, text: 'not dialog' } }, true)]
    const first = projectOverlayTranscript('A', { entries: live })
    expect(first.map(row => row.text)).toEqual(['q', 'hello world'])
    const withBlockEnd = [...live, entry('assistant/live-chunk', 5, { attemptId: 'attempt-1', turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world!' } } }, true), delta(6, 'ignored closed delta')]
    expect(projectOverlayTranscript('A', { entries: withBlockEnd })[1].text).toBe('hello world!')
    const settled = projectOverlayTranscript('A', { entries: [...withBlockEnd, assistant(7, 'final text')] })
    expect(settled).toHaveLength(2)
    expect(settled[1]).toEqual({ ...first[1], text: 'final text' })
  })

  it('never appends a previous failed attempt prefix to a replacement attempt', () => {
    const rows = projectOverlayTranscript('A', { entries: [delta(1, 'wrong prefix', 'old'), delta(2, 'replacement', 'new')] })
    expect(rows.map(row => row.text)).toEqual(['replacement'])
  })

  it('binds visible history and streaming invalidation, rebinds on Session change and removes all listeners when hidden', async () => {
    vi.useFakeTimers()
    const f = fixture(), log = vi.spyOn(console, 'info').mockImplementation(() => {})
    f.host.watchState(true)
    await vi.advanceTimersByTimeAsync(101); log.mockClear()
    f.a.set({ entries: [user(1, 'q'), delta(3, 'live')], revision: 2 })
    f.a.set({ entries: [user(1, 'q'), delta(3, 'live'), delta(4, ' update')], revision: 3 })
    await vi.advanceTimersByTimeAsync(101)
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(f.host.state()).transcript[1].text).toBe('live update')
    document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 'B')
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(101); log.mockClear()
    expect(JSON.parse(f.host.state()).transcript.map((row: { text: string }) => row.text)).toEqual(['B only'])
    f.a.set({ entries: [user(1, 'A late')], revision: 4 })
    await vi.advanceTimersByTimeAsync(101); expect(log).not.toHaveBeenCalled()
    f.b.set({ entries: [user(1, 'B only'), assistant(2, 'B answer')], revision: 2 })
    await vi.advanceTimersByTimeAsync(101); expect(log).toHaveBeenCalledOnce()
    f.host.watchState(false); log.mockClear()
    f.b.set({ entries: [], revision: 3 }); await vi.advanceTimersByTimeAsync(1000)
    expect(log).not.toHaveBeenCalled()
    f.host.dispose()
  })

  it('repeated visible enable does not duplicate subscriptions and lifecycle recovery invalidates once', async () => {
    vi.useFakeTimers()
    const f = fixture(), subscribe = vi.spyOn(f.a, 'subscribe'), log = vi.spyOn(console, 'info').mockImplementation(() => {})
    f.host.watchState(true); f.host.watchState(true); f.host.watchState(true)
    expect(subscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(101); log.mockClear()
    f.la.set({ sessionId: 'A', openState: 'error', removed: false })
    await vi.advanceTimersByTimeAsync(101)
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(f.host.state()).transcriptReady).toBe(false)
    f.host.watchState(false); f.host.watchState(true)
    expect(subscribe).toHaveBeenCalledTimes(2)
    f.host.dispose(); await vi.advanceTimersByTimeAsync(101); log.mockClear()
    f.a.set({ entries: [user(1, 'after disposal')], revision: 9 })
    await vi.advanceTimersByTimeAsync(1000); expect(log).not.toHaveBeenCalled()
  })

  it('clears failed or mismatched history instead of leaking prior Session data; ready empty is explicit', () => {
    const f = fixture()
    f.la.set({ sessionId: 'A', openState: 'error', removed: false })
    expect(JSON.parse(f.host.state())).toMatchObject({ transcript: [], transcriptReady: false, transcriptError: 'transcript-history-error' })
    f.la.set({ sessionId: 'A', openState: 'open', removed: false }); f.a.set({ entries: [], revision: 2 })
    expect(JSON.parse(f.host.state())).toMatchObject({ transcript: [], transcriptReady: true, transcriptError: '' })
    f.bindings.A = f.bindings.B
    expect(JSON.parse(f.host.state()).transcript).toEqual([])
  })

  it('bounds latest 40 rows, each 4000 unicode characters, and the complete UTF8 JSON payload to 24KiB', () => {
    const count = projectOverlayTranscript('A', { entries: Array.from({ length: 60 }, (_, i) => user(i, 'row-' + i)) })
    expect(count).toHaveLength(40); expect(count[0].text).toBe('row-20'); expect(count.at(-1)?.text).toBe('row-59')
    const big = projectOverlayTranscript('A', { entries: Array.from({ length: 15 }, (_, i) => assistant(i, '界😀'.repeat(5000), i, 1)) })
    expect(big.length).toBeGreaterThan(0)
    expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeLessThanOrEqual(24 * 1024)
    expect(big.every(row => Array.from(row.text).length <= 4000)).toBe(true)
    expect(big.at(-1)?.id).toBe('A:assistant:14:1')
  })

  it('pairs real calls and results by turn/step/callId without inventing assistant text or duplicating durable calls', () => {
    const block = { type: 'tool-call', id: 'call-1', name: 'functions.read', arguments: '{"path":"a.md"}' }
    const call = entry('tool/call', 3, { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments })
    const start = [user(1, 'read it'), entry('assistant/message', 2, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Checking.' }, block] } }), call]
    const running = projectOverlayTranscript('A', { entries: start })
    expect(running.map(row => row.role)).toEqual(['user', 'assistant', 'tool'])
    expect(running[2]).toEqual({ id: 'A:tool:1:1:call-1', role: 'tool', text: '', toolName: block.name, arguments: block.arguments, result: '', state: 'running' })
    const settled = projectOverlayTranscript('A', { entries: [...start,
      entry('tool/result', 4, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'line one\nline two' }, { type: 'reasoning', text: 'not result' }, { type: 'image', data: 'base64-secret' }] }, meta: { private: 'not result' } }),
      assistant(5, '**Done**', 1, 2),
    ] })
    expect(settled.map(row => row.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(settled[2]).toEqual({ ...running[2], result: 'line one\nline two', state: 'done' })
    expect(JSON.stringify(settled)).not.toMatch(/base64-secret|not result/)
    expect(settled.at(-1)?.text).toBe('**Done**')
  })

  it('preserves text-block blank lines and projects tool-only assistant messages without fabricating output', () => {
    const rows = projectOverlayTranscript('A', { entries: [
      entry('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '' }, { type: 'text', text: 'first' }, { type: 'text', text: '' }, { type: 'text', text: 'last' }] } }),
      entry('assistant/message', 2, { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'tool-call', id: 'only', name: 'read', arguments: '{}' }] } }),
    ] })
    expect(rows.map(row => row.role)).toEqual(['assistant', 'tool'])
    expect(rows[0].text).toBe('\nfirst\n\nlast')
    expect(rows[1]).toMatchObject({ text: '', toolName: 'read', state: 'running' })
  })

  it('keeps concurrent/reused call IDs distinct, records failure, and ignores malformed/orphan/transient tool records', () => {
    const call = (seq: number, step: number, callId = 'same') => entry('tool/call', seq, { turn: 1, step, callId, name: 'read', arguments: '{malformed JSON is still literal}' })
    const rows = projectOverlayTranscript('A', { entries: [
      call(1, 1), call(2, 2), call(3, 2, 'parallel'),
      entry('tool/result', 4, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'same', isError: true, content: [] }, error: { name: 'ReadError', reason: 'Access denied' } }),
      entry('tool/result', 5, { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'same', content: [{ type: 'text', text: 'good' }] } }),
      entry('tool/result', 6, { turn: 99, step: 2, message: { role: 'tool', toolCallId: 'same', content: [{ type: 'text', text: 'orphan' }] } }),
      entry('tool/call', 7, { turn: 1, step: 2, callId: 'bad', name: 'read', arguments: { not: 'a string' } }),
      entry('tool/call', 8, { turn: 1, step: 2, callId: 'live', name: 'read', arguments: '{}' }, true),
    ] })
    expect(rows).toHaveLength(3)
    expect(rows.map(row => [row.id, row.state, row.result])).toEqual([
      ['A:tool:1:1:same', 'failed', 'Access denied'], ['A:tool:1:2:same', 'done', 'good'], ['A:tool:1:2:parallel', 'running', ''],
    ])
    expect(projectOverlayTranscript('B', { entries: [call(1, 1)] })[0].id).not.toBe(rows[0].id)
  })

  it('budgets tool fields, escaped controls and identity metadata globally while retaining latest real output', () => {
    const huge = '界😀\u0000"\\'.repeat(5000)
    const rows = projectOverlayTranscript('A', { entries: [
      ...Array.from({ length: 20 }, (_, i) => entry('tool/call', i, { turn: 1, step: i, callId: 'c-' + i, name: 'tool-' + huge, arguments: huge })),
      entry('tool/result', 21, { turn: 1, step: 19, message: { role: 'tool', toolCallId: 'c-19', content: [{ type: 'text', text: huge }] } }),
      assistant(22, 'latest visible answer', 2, 1),
    ] })
    expect(rows.length).toBeGreaterThan(1)
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeLessThanOrEqual(24 * 1024)
    expect(rows.filter(row => row.role === 'tool').every(row => row.truncated && Array.from(row.arguments ?? '').length <= 1600 && Array.from(row.result ?? '').length <= 1600 && Array.from(row.toolName ?? '').length <= 256)).toBe(true)
    expect(rows.at(-1)?.text).toBe('latest visible answer')
    const escaped = projectOverlayTranscript('S'.repeat(800), { entries: [assistant(1, '\u0000'.repeat(4000))] })
    expect(escaped).toHaveLength(1)
    expect(escaped[0].truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(escaped)).byteLength).toBeLessThanOrEqual(24 * 1024)
    expect(projectOverlayTranscript('A', { entries: [user(1, 'tail')], hasMore: true })[0].truncated).toBe(true)
  })

  it('exposes tool settlement through the existing visible-session invalidation subscription at idle', async () => {
    vi.useFakeTimers()
    const f = fixture(), log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const call = entry('tool/call', 3, { turn: 1, step: 1, callId: '1', name: 'read', arguments: '{}' })
    f.a.set({ entries: [user(1, 'q'), call], revision: 2 }); f.host.watchState(true)
    await vi.advanceTimersByTimeAsync(101); log.mockClear()
    f.a.set({ entries: [user(1, 'q'), call, entry('tool/result', 4, { turn: 1, step: 1, message: { role: 'tool', toolCallId: '1', content: [{ type: 'text', text: 'actual result' }] } })], revision: 3 })
    await vi.advanceTimersByTimeAsync(101)
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(f.host.state()).transcript[1]).toMatchObject({ role: 'tool', state: 'done', result: 'actual result' })
    expect(JSON.parse(f.host.state()).busy).toBe(false)
    f.host.dispose()
  })
})
