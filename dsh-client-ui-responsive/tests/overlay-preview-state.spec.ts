// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { OverlayHost } from '../src/client/mobile/overlay-host.ts'
import { SESSION_ID_ATTRIBUTE } from '../src/client/mobile/session-marker.ts'

beforeEach(() => { document.documentElement.setAttribute(SESSION_ID_ATTRIBUTE, 's1') })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture() {
  const list = createSnapshotStore({ phase: 'ready' as const, ids: ['s1'], byId: { s1: { title: 'first' } } })
  const workspaces = createSnapshotStore({ phase: 'ready' as const, state: 'idle' as const, items: [{ workspaceId: 'w1', title: 'Workspace', sessionIds: ['s1'] }] })
  const rail = createSnapshotStore({ draft: '', attachmentIds: ['image1'] })
  const draft = { id: 'image1', kind: 'image' as const, previewUrl: 'blob:owned', file: { name: 'photo.png' }, width: 400, height: 200 }
  const host = new OverlayHost({ sessions: () => ({ list, scope: () => ({}), sessionOf: () => ({ sessionId: 's1' }) }), workspaces: () => ({ list: workspaces }), conversation: () => ({ input: { for: () => ({ state: rail, setDraft() {}, submit() {}, removeAttachment: () => true }) }, resolveDraftAttachments: () => [draft] }) })
  return { host, list, workspaces, rail, draft }
}
describe('native composer event invalidation and image projection', () => {
  it('subscribes only while visible and coalesces store updates; stopping/disposal removes callbacks', async () => {
    const f = fixture(), info = vi.spyOn(console, 'info').mockImplementation(() => {})
    f.host.watchState(true)
    f.list.set({ ...f.list.getSnapshot(), byId: { s1: { title: 'renamed' } } })
    f.rail.set({ ...f.rail.getSnapshot(), draft: 'changed' })
    await vi.waitFor(() => expect(info).toHaveBeenCalledOnce())
    expect(JSON.parse(f.host.state()).sessionTitle).toBe('renamed')
    f.host.watchState(false); info.mockClear()
    f.rail.set({ ...f.rail.getSnapshot(), draft: 'hidden change' })
    await new Promise(r => setTimeout(r, 150)); expect(info).not.toHaveBeenCalled()
    f.host.watchState(true); f.host.dispose(); info.mockClear()
    f.list.set({ ...f.list.getSnapshot() }); await new Promise(r => setTimeout(r, 150)); expect(info).not.toHaveBeenCalled()
  })
  it('uses only owned blob URLs, preserves aspect ratio, bounds JPEG payload and caches decoding', async () => {
    const f = fixture(), close = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) })))
    const decode = vi.fn(async () => ({ width: 256, height: 128, close }))
    vi.stubGlobal('createImageBitmap', decode)
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA')
    expect(JSON.parse(f.host.state()).attachments[0].thumbnail).toBe('')
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(decode.mock.calls[0]?.[1]).toMatchObject({ resizeWidth: 256, resizeHeight: 128 })
    expect(JSON.parse(f.host.state()).attachments[0].thumbnail).toBe('data:image/jpeg;base64,AAAA')
    f.host.state(); expect(decode).toHaveBeenCalledOnce(); f.host.dispose()
  })
  it('does not fetch arbitrary remote URLs or return oversized image data', async () => {
    const f = fixture(), fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob() }))
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 128, close() {} })))
    f.draft.previewUrl = 'https://untrusted.invalid/image'
    expect(JSON.parse(f.host.state()).attachments[0].thumbnail).toBe(''); expect(fetch).not.toHaveBeenCalled()
    f.draft.previewUrl = 'blob:owned'
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,' + 'A'.repeat(50000))
    f.host.state(); await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(JSON.parse(f.host.state()).attachments[0].thumbnail).toBe(''); f.host.dispose()
  })
})
