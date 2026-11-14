// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { IncomingDraftConsumer, type IncomingDraftFetch } from '../src/client/mobile/incoming-draft.ts'
import { createIncomingDraftRuntime } from '../src/client/mobile/incoming-runtime.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('bounds incoming Session.ready, releases timed-out reference and permits retry after late settlement', async () => {
  vi.useFakeTimers()
  let ready!: () => void
  const release = vi.fn(), pending = new Promise<void>(resolve => { ready = resolve })
  const runtime = createIncomingDraftRuntime({
    sessions: () => ({ refresh: async () => {}, scope: () => ({}), retain: () => ({ ready: pending, release }) }),
    workspaces: () => ({ create: async () => ({ workspaceId: 'w' }) }),
    uiWorkspace: () => ({ connectWorkspace: async () => 'A', openSession() {} }),
    conversation: () => ({ input: { for: () => ({ notify() {} }) } }),
  })
  const first = runtime.retainSession!('A')
  const rejected = expect(first).rejects.toThrow('session-not-ready')
  await vi.advanceTimersByTimeAsync(4001)
  await rejected
  expect(release).toHaveBeenCalledOnce()
  ready(); await vi.advanceTimersByTimeAsync(0)
  expect(release).toHaveBeenCalledOnce()
  const completed = await runtime.retainSession!('A')
  completed()
  expect(release).toHaveBeenCalledTimes(2)
})

it('uses public createDrafts/input.addAttachments, releases rejected drafts and retains exact target', async () => {
  const scope = {}, release = vi.fn(), addAttachments = vi.fn(() => true), drop = vi.fn()
  const createDrafts = vi.fn(() => [{ id: 'draft-a' }])
  const runtime = createIncomingDraftRuntime({
    sessions: () => ({ refresh: async () => {}, scope: () => scope, retain: () => ({ ready: Promise.resolve({}), release }) }),
    workspaces: () => ({ create: async () => ({ workspaceId: 'w' }) }),
    uiWorkspace: () => ({ connectWorkspace: async () => 's', openSession() {} }),
    conversation: () => ({ createDrafts, releaseDraftAttachment: drop, input: { for: () => ({ notify() {}, addAttachments }) } }),
  })
  const held = await runtime.retainSession!('target-A')
  const file = new File(['data'], 'pic.png', { type: 'image/png' })
  expect(runtime.attachGenericFile('target-A', file)).toBe(true)
  expect(createDrafts).toHaveBeenCalledWith('target-A', [file], true)
  expect(addAttachments).toHaveBeenCalledWith(['draft-a'])
  addAttachments.mockReturnValue(false)
  expect(runtime.attachGenericFile('target-A', file)).toBe(false)
  expect(drop).toHaveBeenCalledWith('draft-a')
  held(); expect(release).toHaveBeenCalledOnce()
})

it('opens through rc.2 uiWorkspace and retains the target scope before claiming the file', async () => {
  const scope = {}; let opened = false
  const sessions = { refresh: vi.fn(async () => {}), scope: vi.fn(() => opened ? scope : undefined) }
  // Actual rc.2 ISessions deliberately has no open method.
  const navigation = { connectWorkspace: vi.fn(async () => 'session-fixture'), openSession: vi.fn(() => { opened = true }) }
  const addFiles = vi.fn((_id: unknown, _files: readonly File[]) => true)
  const runtime = createIncomingDraftRuntime({
    sessions: () => sessions,
    workspaces: () => ({ create: async () => ({ workspaceId: 'workspace-fixture' }) }),
    uiWorkspace: () => navigation,
    conversation: () => ({ addFiles, input: { for: () => ({ notify: vi.fn() }) } }),
  })
  const original = window.androidBridge
  Object.defineProperty(window, 'androidBridge', { configurable: true, value: { incomingWorkspacePath: () => '/fixture/incoming' } })
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob(['old bytes']) })
  const fetchImpl = vi.fn<IncomingDraftFetch>()
    .mockResolvedValueOnce(json({ items: [{ entryId: 'entry-fixture', state: 'received', name: 'old.txt', bytes: 9 }] }))
    .mockResolvedValueOnce(json({ ok: true, ticket: 'fixture-ticket', name: 'old.txt' }))
    .mockResolvedValueOnce(json({}))
    .mockResolvedValueOnce(json({ ok: true }))
  try {
    await new IncomingDraftConsumer(fetchImpl, runtime).poll()
    expect(navigation.openSession).toHaveBeenCalledWith('session-fixture')
    expect(opened).toBe(true)
    expect(addFiles).toHaveBeenCalledTimes(1)
    expect(addFiles.mock.calls[0]?.[0]).toBe('session-fixture')
    expect(String(fetchImpl.mock.calls[3]?.[1]?.body)).toContain('draft-ready')
    expect('open' in sessions).toBe(false)
  } finally {
    Object.defineProperty(window, 'androidBridge', { configurable: true, value: original })
  }
})
