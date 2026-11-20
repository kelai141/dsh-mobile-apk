import { randomUUID } from 'node:crypto'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const HISTORY_LIMIT = 512 * 1024
const PAGE_LIMIT = 32 * 1024

interface RuntimePaths {
  launcher: string
  [name: string]: unknown
}

interface TrackedChild {
  abort(): void
  promise: Promise<unknown>
}

/** Bionilux runtime manager interface used by the Android PTY adapter. */
interface TerminalRuntime {
  dataDir: string
  gate: { managementPending: boolean; acquireShared(): Promise<void>; releaseShared(): void }
  children: Set<TrackedChild>
  processScope: { environment(env: Record<string, string>): Record<string, string> }
  _ensureStartupRecovery(): Promise<void>
  _verifyLocked(): Promise<{ healthy: boolean; reason?: string; paths?: RuntimePaths }>
  _executionEnvironment(paths: RuntimePaths, cwd: { guestCwd: string; hostPaths: string[] }): Record<string, string>
  _sessionLaunch(paths: RuntimePaths): { file: string; args: string[] }
}

function terminalRuntime(value: unknown): TerminalRuntime {
  const manager = value as Partial<TerminalRuntime> | null | undefined
  if (manager == null ||
    typeof manager.dataDir !== 'string' ||
    typeof manager.gate?.acquireShared !== 'function' ||
    typeof manager.gate.releaseShared !== 'function' ||
    !(manager.children instanceof Set) ||
    typeof manager.processScope?.environment !== 'function' ||
    typeof manager._ensureStartupRecovery !== 'function' ||
    typeof manager._verifyLocked !== 'function' ||
    typeof manager._executionEnvironment !== 'function' ||
    typeof manager._sessionLaunch !== 'function') {
    throw new TerminalError(409, 'linux-terminal-runtime-unavailable')
  }
  return manager as TerminalRuntime
}

export class TerminalError extends Error {
  constructor(readonly status: number, code: string, readonly detail?: string) { super(code) }
}

type TerminalSize = { rows: number; cols: number }
type TerminalRequest =
  | ({ action: 'open' | 'restart' } & TerminalSize)
  | { action: 'read'; after: number; id: string }
  | { action: 'write'; data: string; id: string }
  | ({ action: 'resize'; id: string } & TerminalSize)
  | { action: 'stop'; id: string }

export function parseTerminalRequest(value: unknown): TerminalRequest {
  if (typeof value !== 'object' || value === null) throw new TerminalError(400, 'linux-terminal-request-invalid')
  const data = value as Record<string, unknown>
  const id = typeof data.id === 'string' && /^[0-9a-f-]{36}$/.test(data.id) ? data.id : undefined
  const dimension = (input: unknown, min: number) =>
    typeof input === 'number' && Number.isInteger(input) && input >= min && input <= 500 ? input : undefined
  const rows = dimension(data.rows, 2)
  const cols = dimension(data.cols, 2)
  switch (data.action) {
    case 'open':
    case 'restart':
      if (rows !== undefined && cols !== undefined) return { action: data.action, rows, cols }
      break
    case 'read':
      if (id && typeof data.after === 'number' && Number.isSafeInteger(data.after) && data.after >= 0) {
        return { action: 'read', after: data.after, id }
      }
      break
    case 'resize':
      if (id && rows !== undefined && cols !== undefined) return { action: 'resize', rows, cols, id }
      break
    case 'write':
      if (id && typeof data.data === 'string' && data.data.length <= 4096) return { action: 'write', data: data.data, id }
      break
    case 'stop':
      if (id) return { action: 'stop', id }
  }
  throw new TerminalError(400, 'linux-terminal-request-invalid')
}

function recordTerminal(handle: SubprocessTerminalHandle) {
  let history = ''
  let first = 0
  let running = true
  let outcome: { exitCode: number | null; signal: string | null } | undefined
  let stopPromise: Promise<void> | undefined
  const stop = () => stopPromise ??= handle.terminate()
  handle.output.setEncoding('utf8')
  handle.output.on('data', (output: string) => {
    history += output
      let excess = history.length - HISTORY_LIMIT
    if (excess > 0) {
      if (history.charCodeAt(excess) >= 0xdc00 && history.charCodeAt(excess) <= 0xdfff) excess++
      first += excess
      history = history.slice(excess)
    }
  })
  handle.output.on('error', () => { void stop().catch(() => {}) })
  const settled = handle.done.then(result => { outcome = result }, () => {
    outcome = { exitCode: null, signal: null }
  }).then(() => {
    running = false
    return stop()
  })
  const id = randomUUID()
  return {
    id,
    handle,
    settled,
    stop,
    running: () => running,
    read(after: number) {
      const end = first + history.length
      const reset = after < first || after > end
      const start = reset ? first : after
      let next = Math.min(start + PAGE_LIMIT, end)
      const nextCode = history.charCodeAt(next - first)
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) next--
      return { id, running, outcome, reset, next, more: next < end, output: history.slice(start - first, next - first) }
    },
  }
}

/** One app-wide PTY. Views attach with a cursor and may detach without stopping it. */
export function createLinuxTerminal(options: {
  runtime(): unknown
  spawn(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}) {
  let session: ReturnType<typeof recordTerminal> | undefined
  let opening: Promise<ReturnType<typeof recordTerminal>> | undefined

  async function start(size: TerminalSize) {
    const manager = terminalRuntime(options.runtime())
    await manager._ensureStartupRecovery()
    await manager.gate.acquireShared()
    try {
      if (manager.gate.managementPending) throw new TerminalError(409, 'linux-terminal-runtime-busy')
      const verified = await manager._verifyLocked()
      if (!verified.healthy || !verified.paths) {
        throw new TerminalError(409, 'linux-terminal-runtime-unavailable', verified.reason)
      }
      if (manager.gate.managementPending) throw new TerminalError(409, 'linux-terminal-runtime-busy')
      const launch = manager._sessionLaunch(verified.paths)
      if (launch.args.at(-2) !== '--norc' || launch.args.at(-1) !== '-s') {
        throw new TerminalError(409, 'linux-terminal-runtime-incompatible')
      }
      const environment = manager._executionEnvironment(verified.paths, { guestCwd: '/root', hostPaths: [] })
      const handle = await options.spawn({
        argv: [launch.file, ...launch.args.slice(0, -1), '-i'],
        cwd: manager.dataDir,
        env: manager.processScope.environment(environment),
        terminalType: 'xterm-256color',
        graceMs: 500,
        ...size,
      })
      const started = recordTerminal(handle)
      const child = { abort: () => { void started.stop().catch(() => {}) }, promise: started.settled }
      manager.children.add(child)
      void started.settled.then(() => manager.children.delete(child), () => {})
      if (manager.gate.managementPending) {
        await started.stop()
        throw new TerminalError(409, 'linux-terminal-runtime-busy')
      }
      return started
    } finally {
      manager.gate.releaseShared()
    }
  }

  const open = async (size: TerminalSize, restart: boolean) => {
    if (session?.running() || (session && !restart)) return session
    opening ??= start(size).then(started => session = started).finally(() => { opening = undefined })
    return opening
  }

  return {
    async request(request: TerminalRequest) {
      if (request.action === 'open' || request.action === 'restart') {
        const attached = await open({ cols: request.cols, rows: request.rows }, request.action === 'restart')
        return attached.read(0)
      }
      if (!('id' in request) || session?.id !== request.id) throw new TerminalError(409, 'linux-terminal-stale')
      if (request.action === 'read') return session.read(request.after)
      if (!session.running()) throw new TerminalError(409, 'linux-terminal-exited')
      if (request.action === 'write') await session.handle.write(request.data)
      if (request.action === 'resize') await session.handle.resize(request.cols, request.rows)
      if (request.action === 'stop') await session.stop()
      return { id: session.id, ok: true }
    },
  }
}
