/**
 * Shared notification, task-done, and live-event bridge.
 *
 * These channels describe session events; they do not dispatch device control.
 * Writes stay batched at a 100 ms window with a synchronous flush path so a
 * reader that needs an immediate tail can call `flushPendingAppends()`.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  SessionNotifyState,
  formatDuration,
  reportOutcomeLabel,
  shouldPopupReport,
  todoProgress,
  turnEndKind,
  turnEndOk,
  visibleText,
} from './notify-projection.js'
import { controlTokenFrom } from './route-auth.js'

export interface AppendBatcher {
  push(line: string): void
  flush(): void
  pending(): boolean
  dispose(): void
}

export const APPEND_BATCH_WINDOW_MS = 100
const APPEND_BATCH_MAX_BYTES = 64 * 1024
/** Rotation ceiling for `.notify.ndjson`; the shell reads by byte offset. */
export const NOTIFY_MAX = 512 * 1024
/** Rotation ceiling for `.live.ndjson`. */
export const LIVE_MAX = 512 * 1024

export function createAppendBatcher(file: string, options: {
  windowMs?: number
  maxBytes?: number
  append?: (file: string, text: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
} = {}): AppendBatcher {
  const windowMs = options.windowMs ?? APPEND_BATCH_WINDOW_MS
  const maxBytes = options.maxBytes ?? APPEND_BATCH_MAX_BYTES
  const append = options.append ?? ((target: string, text: string) => { appendFileSync(target, text) })
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  let queue: string[] = []
  let bytes = 0
  let timer: unknown = null
  let disposed = false
  const stopTimer = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }
  const flush = (): void => {
    if (queue.length === 0) { stopTimer(); return }
    const text = queue.join('')
    try { append(file, text) } catch { return }
    let dropped = 0
    let removedBytes = 0
    while (dropped < queue.length && removedBytes < text.length) {
      removedBytes += queue[dropped].length
      dropped += 1
    }
    queue = queue.slice(dropped)
    bytes = Math.max(0, bytes - removedBytes)
    if (queue.length === 0) stopTimer()
  }
  const ensureTimer = (): void => {
    if (timer !== null || disposed) return
    timer = setTimer(() => { timer = null; flush() }, windowMs)
  }
  return {
    push(line) {
      if (disposed) return
      const text = line.endsWith('\n') ? line : line + '\n'
      queue.push(text)
      bytes += text.length
      if (bytes >= maxBytes) { stopTimer(); flush(); return }
      ensureTimer()
    },
    flush,
    pending: () => timer !== null,
    dispose() { disposed = true; stopTimer() },
  }
}

const EXIT_FLUSHERS = new Set<() => void>()
let exitHooksInstalled = false

function installExitHooks(): void {
  if (exitHooksInstalled) return
  exitHooksInstalled = true
  const runAll = (): void => {
    for (const flush of [...EXIT_FLUSHERS]) {
      try { flush() } catch { /* exit path: best effort */ }
    }
  }
  try { process.on('exit', runAll) } catch { /* non-node host */ }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    try { process.on(signal, runAll) } catch { /* signal unavailable */ }
  }
}

export function flushPendingAppends(): void {
  for (const flush of [...EXIT_FLUSHERS]) {
    try { flush() } catch { /* best effort */ }
  }
}

export function createFileAppendix(file: string, options: Parameters<typeof createAppendBatcher>[1] = {}): AppendBatcher {
  const batcher = createAppendBatcher(file, options)
  installExitHooks()
  EXIT_FLUSHERS.add(batcher.flush)
  return {
    push: batcher.push,
    flush: batcher.flush,
    pending: batcher.pending,
    dispose() {
      batcher.dispose()
      EXIT_FLUSHERS.delete(batcher.flush)
    },
  }
}

export interface ShellAdbPrefs {
  allowSwitch: boolean
  paired: boolean
  connected?: boolean
  a11yEnabled?: boolean
  controlToken?: string
  fullAccess?: boolean
}

/** Parse the shared-prefs XML without inventing values for absent keys. */
export function parseAdbPrefsXml(xml: string): ShellAdbPrefs | null {
  const bool = (name: string): boolean | undefined => {
    const hit = new RegExp('<boolean\\s+name="' + name + '"\\s+value="(true|false)"\\s*\\/?>').exec(xml)
    return hit === null ? undefined : hit[1] === 'true'
  }
  const token = /<string\s+name="controlToken">([^<]*)<\/string>/.exec(xml)?.[1]
  const allow = bool('allowSwitch')
  const paired = bool('paired')
  const a11y = bool('a11yEnabled')
  const fullAccess = bool('fullAccess')
  if (allow === undefined && paired === undefined && a11y === undefined && token === undefined && fullAccess === undefined) return null
  return {
    allowSwitch: allow === true,
    paired: paired === true,
    ...(bool('connected') === undefined ? {} : { connected: bool('connected') }),
    ...(a11y === undefined ? {} : { a11yEnabled: a11y }),
    ...(token === undefined || token === '' ? {} : { controlToken: token }),
    ...(fullAccess === undefined ? {} : { fullAccess }),
  }
}

const SHELL_PREFS_DEFAULT = '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh-adb.xml'

function shellPrefsPath(): string | null {
  const explicit = process.env.DSH_ADB_PREFS_PATH
  if (explicit) return explicit
  if (process.env.TERMUX__PREFIX && process.env.DSH_HOME) return SHELL_PREFS_DEFAULT
  return null
}

/** Live shell token used by Android-owned routes; absent means fail closed. */
export function shellControlToken(): string | undefined {
  let prefs: ShellAdbPrefs | undefined
  const path = shellPrefsPath()
  if (path) {
    try { prefs = parseAdbPrefsXml(readFileSync(path, 'utf8')) ?? undefined } catch { prefs = undefined }
  }
  return controlTokenFrom(process.env, prefs)
}

export interface SharedNotificationOptions {
  env?: NodeJS.ProcessEnv
  logger?: { warn?: (msg: string) => void }
}

export interface SharedNotificationBridge {
  flush(): void
  dispose(): void
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
}

/** Register the session event projection used by the shell notification channels. */
export function installSharedNotifications(
  ctx: Context,
  options: SharedNotificationOptions = {},
): SharedNotificationBridge {
  const env = options.env ?? process.env
  const home = homeDir(env)
  const taskDoneFile = home + '/.task-done.ndjson'
  const notifyFile = home + '/.notify.ndjson'
  const liveFile = home + '/.live.ndjson'
  const taskMarkerBatch = createFileAppendix(taskDoneFile)
  let notifyBytes = 0
  try { notifyBytes = statSync(notifyFile).size } catch { notifyBytes = 0 }
  const notifyBatch = createFileAppendix(notifyFile, {
    append: (target, text) => { appendFileSync(target, text); notifyBytes += Buffer.byteLength(text) },
  })
  let liveBytes = 0
  try { liveBytes = statSync(liveFile).size } catch { liveBytes = 0 }
  const liveBatch = createFileAppendix(liveFile, {
    append: (target, text) => { appendFileSync(target, text); liveBytes += Buffer.byteLength(text) },
  })
  const notifyState = new SessionNotifyState()
  const appendTaskMarker = (sessionId: unknown, title: string | undefined, text: string): void => {
    try {
      taskMarkerBatch.push(JSON.stringify({ ts: new Date().toISOString(), sessionId: String(sessionId), title: title ?? '', text }))
    } catch { /* notification best effort */ }
  }
  const rotateNotify = (incoming: number): void => {
    if (notifyBytes + incoming <= NOTIFY_MAX) return
    notifyBatch.flush()
    try { renameSync(notifyFile, notifyFile + '.1') } catch { rmSync(notifyFile, { force: true }) }
    notifyBytes = 0
  }
  const appendNotify = (entry: Record<string, unknown>): void => {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
      rotateNotify(Buffer.byteLength(line) + 1)
      notifyBatch.push(line)
    } catch { /* notification best effort */ }
  }
  const rotateLive = (incoming: number): void => {
    if (liveBytes + incoming <= LIVE_MAX) return
    liveBatch.flush()
    try { renameSync(liveFile, liveFile + '.1') } catch { rmSync(liveFile, { force: true }) }
    liveBytes = 0
  }
  const appendLive = (line: string): void => {
    try {
      const text = line.endsWith('\n') ? line : line + '\n'
      rotateLive(Buffer.byteLength(text))
      liveBatch.push(text)
    } catch { /* live best effort */ }
  }
  const liveCalls = new Map<string, { name: string; args: string; start: number }>()
  const live = (session: unknown, ev: { type?: string; data?: Record<string, unknown> }): void => {
    const sessionId = String((session as { id?: unknown } | undefined)?.id ?? '')
    const t = Date.now()
    const kind = ev.type ?? ''
    if (kind === 'tool/call') {
      const data = ev.data as { name?: string; arguments?: string; callId?: string }
      const args = String(data.arguments ?? '').slice(0, 240)
      if (data.callId) liveCalls.set(String(data.callId), { name: String(data.name ?? ''), args, start: t })
      appendLive(JSON.stringify({ t, s: sessionId, k: 'tool_call', name: String(data.name ?? ''), args }))
      return
    }
    if (kind === 'tool/result') {
      const data = ev.data as { message?: { source?: { callId?: string }; content?: Array<Record<string, unknown>> } }
      const callId = data?.message?.source?.callId ? String(data.message.source.callId) : ''
      const call = callId ? liveCalls.get(callId) : undefined
      const err = Array.isArray(data?.message?.content) && data.message.content.some((item) => item.isError === true)
      appendLive(JSON.stringify({
        t, s: sessionId, k: 'tool_result', name: call?.name ?? '', args: call?.args ?? '',
        dur: call ? t - call.start : undefined, err,
      }))
      if (callId) liveCalls.delete(callId)
      if (liveCalls.size > 256) {
        const first = liveCalls.keys().next().value
        if (first !== undefined) liveCalls.delete(first)
      }
      return
    }
    if (kind === 'assistant/message') {
      const content = (ev.data as { message?: { content?: unknown } })?.message?.content
      const text = visibleText(content)
      appendLive(JSON.stringify({ t, s: sessionId, k: 'text', sum: text.slice(0, 160) || '（空回复）' }))
      return
    }
    if (kind === 'turn/end') {
      const reason = (ev.data as { reason?: unknown })?.reason
      appendLive(JSON.stringify({ t, s: sessionId, k: 'turn_end', ok: turnEndOk(reason), kind: turnEndKind(reason) }))
      return
    }
    if (kind === 'session/title') {
      appendLive(JSON.stringify({ t, s: sessionId, k: 'title', title: String((ev.data as { title?: unknown })?.title ?? '').slice(0, 80) }))
    }
  }
  // The upstream event map is declared in a peer package whose published types
  // do not list `session/event`; the old bridge used the same runtime event name.
  const onEvent = (ctx as unknown as {
    on(name: string, handler: (session: unknown, event: unknown) => void): () => void
  }).on
  onEvent.call(ctx, 'session/event', (session: unknown, event: unknown) => {
    if (event === null || typeof event !== 'object') return
    const ev = event as { type?: string; data?: Record<string, unknown> }
    const type = ev.type ?? ''
    const sessionId = String((session as { id?: unknown } | undefined)?.id ?? '')
    const now = Date.now()
    try {
      switch (type) {
        case 'session/title': notifyState.setTitle(sessionId, ev.data?.title); break
        case 'turn/start': notifyState.startTurn(sessionId, ev.data?.turn, now); break
        case 'tool/call': notifyState.countToolCall(sessionId); break
        case 'assistant/message':
          {
            const content = (ev.data as { message?: { content?: unknown } })?.message?.content
            notifyState.setSummary(sessionId, visibleText(content))
          }
          break
        case 'deliverables/presented':
          notifyState.setPresented(sessionId, (ev.data as { files?: unknown } | undefined)?.files)
          break
        case 'todo/write': {
          const progress = todoProgress(ev.data?.todos)
          if (notifyState.acceptTodo(sessionId, progress, now)) {
            appendNotify({ kind: 'todo', done: progress.done, total: progress.total, current: progress.current, sessionId, title: notifyState.titleFor(sessionId) })
          }
          break
        }
        case 'turn/end': {
          const kind = turnEndKind(ev.data?.reason)
          if (kind === 'unknown') options.logger?.warn?.('turn/end reason.kind 未知（上游新增 kind？）：' + JSON.stringify(ev.data?.reason ?? null))
          const report = notifyState.endTurn({ sessionId, turn: ev.data?.turn, reason: ev.data?.reason, now })
          if (shouldPopupReport(report.outcome)) appendTaskMarker(report.sessionId, report.title, report.summary || '任务完成')
          appendNotify({
            kind: 'report', outcome: report.outcome, outcomeLabel: reportOutcomeLabel(report.outcome),
            sessionId: report.sessionId, title: report.title, summary: report.summary, body: report.body,
            durationMs: report.durationMs, durationLabel: formatDuration(report.durationMs),
            toolCount: report.toolCount, turn: report.turn, presentedFiles: report.presentedFiles,
            popup: shouldPopupReport(report.outcome),
          })
          break
        }
        default: break
      }
    } catch (failure) {
      options.logger?.warn?.('notify projection failed: ' + String((failure as Error).message))
    }
    try { live(session, ev) } catch { /* one event failed */ }
  })
  const cleanup = (): void => {
    for (const batch of [taskMarkerBatch, notifyBatch, liveBatch]) {
      try { batch.flush() } catch { /* best effort */ }
      try { batch.dispose() } catch { /* best effort */ }
    }
  }
  return { flush: flushPendingAppends, dispose: cleanup }
}
