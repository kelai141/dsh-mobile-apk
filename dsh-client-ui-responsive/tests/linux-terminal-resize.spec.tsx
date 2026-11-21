// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LinuxTerminal } from '../src/client/linux-environment/LinuxTerminal.tsx'

const { terminalRequest, state } = vi.hoisted(() => ({
  terminalRequest: vi.fn(),
  state: { resize: undefined as ((size: { rows: number; cols: number }) => void) | undefined },
}))
vi.mock('../src/client/linux-environment/transport.ts', () => ({ terminalRequest, RouteError: Error }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24
    cols = 80
    options = {}
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    onResize(callback: typeof state.resize) { state.resize = callback; return { dispose() {} } }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button' }))

it('sends one PTY resize at a time and only sends the newest queued dimensions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const host = document.createElement('div')
  const root = createRoot(host)
  document.body.appendChild(host)
  const pending: (() => void)[] = []
  terminalRequest.mockImplementation(async ({ action }) => {
    if (action === 'resize') return await new Promise(resolve => pending.push(() => resolve({ ok: true })))
    return { id: 'pty', running: true, next: 0 }
  })
  const sizes = () => terminalRequest.mock.calls
    .map(([action]) => action)
    .filter(action => action.action === 'resize')
    .map(({ rows, cols }) => [rows, cols])
  try {
    await act(async () => { root.render(<LinuxTerminal />) })
    expect(sizes()).toEqual([[24, 80]])
    state.resize!({ rows: 25, cols: 80 })
    state.resize!({ rows: 26, cols: 100 })
    expect(sizes()).toEqual([[24, 80]])
    await act(async () => { pending.shift()!() })
    expect(sizes()).toEqual([[24, 80], [26, 100]])
    state.resize!({ rows: 26, cols: 100 })
    await act(async () => { pending.shift()!() })
    expect(sizes()).toEqual([[24, 80], [26, 100]])
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  }
})
