// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayHost } from '../src/client/mobile/overlay-host.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function receipt(state: string): Response {
  return { ok: true, json: async () => ({ ok: true, state }) } as Response
}

describe('overlay incoming receipt deadline', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(['fetch', 'json'] as const)('retries unresolved receipt %s at four seconds while retaining pending and ignoring a late result', async stage => {
    const late = deferred<Response>(), body = deferred<unknown>()
    const retry = deferred<Response>()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => late.promise)
      .mockImplementationOnce(() => retry.promise)
      .mockResolvedValue(receipt('draft-ready'))
    vi.stubGlobal('fetch', fetchImpl)
    const wake = vi.fn()
    window.addEventListener('dsh:overlay-incoming', wake)
    const host = new OverlayHost({})
    try {
      expect(JSON.parse(host.incoming('request-timeout'))).toEqual({ ok: true, state: 'pending' })
      await vi.advanceTimersByTimeAsync(0)
      const signal = fetchImpl.mock.calls[0]?.[1]?.signal
      expect(signal?.aborted).toBe(false)
      if (stage === 'json') {
        await vi.advanceTimersByTimeAsync(3000)
        late.resolve({ ok: true, json: () => body.promise } as Response)
        await vi.advanceTimersByTimeAsync(999)
      } else await vi.advanceTimersByTimeAsync(3999)
      expect(JSON.parse(host.incoming('request-timeout')).state).toBe('pending')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal?.aborted).toBe(true)
      expect(JSON.parse(host.incoming('request-timeout')).state).toBe('pending')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/android/file-incoming?requestId=request-timeout')
      expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
      late.resolve(receipt('removed')); body.resolve({ ok: true, state: 'removed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(JSON.parse(host.incoming('request-timeout')).state).toBe('pending')
      expect(fetchImpl).toHaveBeenCalledTimes(2) // The stale request must not clear the new read latch.
      retry.resolve(receipt('draft-ready'))
      await vi.advanceTimersByTimeAsync(0)
      expect(JSON.parse(host.incoming('request-timeout')).state).toBe('draft-ready')
      await vi.advanceTimersByTimeAsync(0)
      expect(wake).toHaveBeenCalledTimes(5)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      host.dispose()
      window.removeEventListener('dsh:overlay-incoming', wake)
    }
  })
})
