/**
 * Shared native browser adapter.
 *
 * This module is the replacement seam for the browser portion of the old
 * `androidPrivilege.controlExec` face. It forwards the exact browser op names to
 * the application-private NativeClient, which owns transport, epochs, dispatch,
 * and lifecycle. It never uses the control queue, HTTP long polling, ADB, Root,
 * or a second capability authority.
 *
 * A browser request has no Android screen target. The native session epoch is
 * read from capabilities for every call; `screenId` and `generation` are not
 * sent. The session carried in args is replaced with the id of the trusted live
 * session object, so a model-supplied value cannot select another workspace.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { NativeClient, NativeExecuted, NativeResponse, NativeTransportResult } from './native-client.js'

/** Exact browser ops implemented by the shared BrowserHost. */
export const NATIVE_SHARED_BROWSER_OPS = [
  'browserCaps',
  'browserShow',
  'browserHide',
  'browserClose',
  'browserOpen',
  'browserJs',
  'browserInput',
  'browserShot',
  'browserState',
  'browserSetUa',
  'browserViewport',
  'browserTabs',
  'browserFollowTab',
  'browserCloseTab',
] as const

export type NativeSharedBrowserOp = (typeof NATIVE_SHARED_BROWSER_OPS)[number]

const BROWSER_OPS: ReadonlySet<string> = new Set(NATIVE_SHARED_BROWSER_OPS)
const UNSIGNED_U64 = /^(?:[0-9]{1,20}|0[xX][0-9A-Fa-f]{1,16})$/u
const U64_MAX = '18446744073709551615'

/** Compatible with dsh-android-browser's ControlFace result reader. */
export type NativeSharedControlResult =
  | { ok: true; data: unknown }
  | {
    ok: false
    error: string
    code?: string
    executed?: NativeExecuted
    guidance?: string
    [key: string]: unknown
  }

export interface NativeSharedAuth {
  /**
   * A live session object or its id. An object must be the exact instance held
   * by the sessions service; an id is resolved through that service and is
   * never trusted without a live object and a danger-full-access policy.
   */
  session?: unknown
}

type SandboxPolicy = { resolve(request?: { session?: unknown }): { mode?: string } }
type Sessions = { get(id: string): unknown }

export interface NativeSharedBridgeOptions {
  /** Application-private client, normally createNativeClient({ endpoint }). */
  client?: NativeClient
  /** Overrides for host adapters and tests; defaults read ctx services. */
  sessions?: Sessions
  sandboxPolicy?: SandboxPolicy
}

export interface NativeSharedBridgeStatus {
  tier: 'T0' | 'T1' | 'unknown'
  tierSource: 'native-capabilities' | 'sync-face' | 'unavailable' | 'session-denied'
  /** True when only the old synchronous status face is available. */
  needsAsyncMigration: boolean
  capabilitiesRead: boolean
  guidance?: string
}

type SessionDecision =
  | { kind: 'allowed'; id: string; session: Record<string, unknown> }
  | { kind: 'denied' }
  | { kind: 'unreadable' }

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get?(key: string): unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Opaque unsigned u64, kept as a string and never converted through Number. */
function isU64(value: unknown): value is string {
  if (typeof value !== 'string' || !UNSIGNED_U64.test(value)) return false
  if (value.startsWith('0x') || value.startsWith('0X')) return true
  return value.length < U64_MAX.length || (value.length === U64_MAX.length && value <= U64_MAX)
}

function failure(
  code: string,
  error: string,
  executed: NativeExecuted = 'no',
  extra: Record<string, unknown> = {},
): NativeSharedControlResult {
  return { ok: false, error, code, executed, ...extra }
}

function nativeFailure(result: NativeTransportResult): NativeSharedControlResult {
  const code = result.error?.code ?? result.response?.code ?? 'native-control-failed'
  const message = result.error?.message
    ?? (typeof result.response?.detail === 'string' ? result.response.detail : undefined)
    ?? code
  return failure(code, message, result.executed)
}

function responseFailure(response: NativeResponse): NativeSharedControlResult {
  const code = typeof response.code === 'string' && response.code !== '' ? response.code : 'native-control-rejected'
  const detail = typeof response.detail === 'string' && response.detail !== '' ? response.detail : code
  return failure(code, detail, response.executed, response.data === undefined ? {} : { data: response.data })
}

function tri(value: unknown): 'yes' | 'no' | 'unknown' {
  return value === 'yes' || value === 'no' ? value : 'unknown'
}

/** Only facts actually published by the host are used; absent values stay unknown. */
function tierFromCapabilities(response: NativeResponse): 'T0' | 'T1' | 'unknown' {
  const channels = response.channels
  if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) return 'unknown'
  const record = channels as Record<string, unknown>
  const a11y = record.a11y
  const shizuku = record.shizuku
  const a11yRecord = a11y !== null && typeof a11y === 'object' ? a11y as Record<string, unknown> : undefined
  const a11yOnline = tri(a11yRecord?.online)
  const a11yEnabled = tri(a11yRecord?.enabled)
  // `enabled` only says the service is switched on; `online` proves a live
  // channel. Use online when published, and never promote unknown to yes.
  const a11yReady = a11yOnline === 'unknown' ? a11yEnabled : a11yOnline
  const shizukuReady = tri(shizuku !== null && typeof shizuku === 'object'
    ? (shizuku as Record<string, unknown>).functionalReady
    : undefined)
  if (a11yReady === 'yes' || shizukuReady === 'yes') return 'T1'
  if (a11yReady === 'no' && shizukuReady === 'no') return 'T0'
  return 'unknown'
}

/**
 * Build the shared browser face.
 *
 * The returned object exposes `controlExec` and `status` for the existing
 * browser and linux-env consumers, plus an async status read for the migration
 * away from the synchronous tier field. No capability or permission is cached.
 */
export function createNativeSharedBridge(
  ctx: Context,
  options: NativeSharedBridgeOptions = {},
): NativeSharedBridge {
  // Resolve host services on every call so a late-bound service is not frozen
  // at construction time. Authority results are still never cached.
  const sessionsOf = (): Sessions | undefined => options.sessions ?? serviceOf<Sessions>(ctx, 'sessions')
  const policyOf = (): SandboxPolicy | undefined => options.sandboxPolicy ?? serviceOf<SandboxPolicy>(ctx, 'sandboxPolicy')

  function decideSession(auth: NativeSharedAuth | undefined, fallbackId?: unknown): SessionDecision {
    const candidate = auth?.session
    const sessions = sessionsOf()
    const sandboxPolicy = policyOf()
    if (sessions === undefined) return { kind: 'denied' }
    const candidateId = typeof candidate === 'string'
      ? candidate
      : (candidate !== null && typeof candidate === 'object' ? (candidate as { id?: unknown }).id : undefined)
    const id = typeof candidateId === 'string' && candidateId.length > 0
      ? candidateId
      : (typeof fallbackId === 'string' && fallbackId.length > 0 ? fallbackId : undefined)
    if (id === undefined) return { kind: 'denied' }
    let live: unknown
    try {
      live = sessions.get(id)
    } catch {
      return { kind: 'unreadable' }
    }
    if (live === undefined) return { kind: 'denied' }
    if (candidate !== null && typeof candidate === 'object' && live !== candidate) return { kind: 'denied' }
    if (live === null || typeof live !== 'object') return { kind: 'denied' }
    if (sandboxPolicy === undefined) return { kind: 'unreadable' }
    try {
      if (sandboxPolicy.resolve({ session: live })?.mode !== 'danger-full-access') return { kind: 'denied' }
    } catch {
      return { kind: 'unreadable' }
    }
    return { kind: 'allowed', id, session: live as Record<string, unknown> }
  }

  async function readCapabilities(signal?: AbortSignal): Promise<NativeTransportResult | undefined> {
    if (options.client === undefined) return undefined
    try {
      return await options.client.capabilities({ signal })
    } catch {
      return undefined
    }
  }

  const status = (): NativeSharedBridgeStatus => ({
    tier: 'unknown',
    tierSource: 'sync-face',
    needsAsyncMigration: true,
    capabilitiesRead: false,
    guidance: 'The synchronous status face cannot read asynchronous native capabilities. Use statusAsync before displaying a tier.',
  })

  return {
    controlExec: async (op, args, timeoutMs, auth) => {
      if (!BROWSER_OPS.has(op)) {
        return failure(
          'operation-not-browser',
          'Operation ' + op + ' is not a shared browser op; phone-control tools own non-browser operations.',
        )
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return failure('args-invalid', 'browser args must be an object')
      }
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) {
        return failure('timeout-invalid', 'timeoutMs must be an integer from 1 to 30000')
      }
      if (options.client === undefined) {
        return failure('native-client-unavailable', 'The application-private NativeClient is not assembled.')
      }
      // Shared panel probes read SDK capability metadata before a model session exists.
      // No page state, navigation, JavaScript or input operation receives this exception.
      const metadataRead = op === 'browserCaps' && auth === undefined && Object.keys(args).length === 0
      const trusted = metadataRead ? { kind: 'metadata' as const } : decideSession(auth, args.session)
      if (trusted.kind === 'denied') {
        return failure('session-permission-denied', 'A trusted session with danger-full-access is required.')
      }
      if (trusted.kind === 'unreadable') {
        return failure('session-permission-unverified', 'The trusted session permission could not be read.')
      }

      const facts = await readCapabilities()
      if (facts === undefined) {
        return failure('native-facts-unavailable', 'Native capabilities could not be read.')
      }
      if (!facts.ok || !facts.response?.ok) return nativeFailure(facts)
      const epoch = facts.response.epoch
      if (!isU64(epoch)) {
        return failure('native-facts-invalid', 'Native capabilities did not publish a valid epoch.')
      }

      const forwarded: Record<string, unknown> = { ...args }
      // Identity fields are owned by this adapter. The capability epoch is read
      // above; browser targets never carry a screen or generation.
      for (const key of ['session', 'screenId', 'generation', 'epoch', 'callId']) delete forwarded[key]
      if (trusted.kind === 'allowed') forwarded.session = trusted.id

      const callId = randomUUID()
      const result = await options.client.execute({
        callId,
        epoch,
        operation: op,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        args: forwarded,
      }, { timeoutMs: timeoutMs === undefined ? 20_000 : timeoutMs + 2_000 })

      const after = metadataRead ? { kind: 'allowed' as const } : decideSession(auth, args.session)
      if (after.kind !== 'allowed') {
        const code = after.kind === 'unreadable' ? 'session-permission-unverified' : 'session-permission-revoked'
        const message = after.kind === 'unreadable'
          ? 'The trusted session permission could not be re-read after dispatch.'
          : 'The trusted session lost danger-full-access after dispatch.'
        return failure(code, message, result.executed)
      }
      if (!result.ok) return nativeFailure(result)
      const response = result.response
      if (response === undefined) return failure('native-result-unavailable', 'Native response is missing.', result.executed)
      if (!response.ok) return responseFailure(response)
      return { ok: true, data: response.data ?? {} }
    },

    status,

    async statusAsync(auth, signal) {
      // A missing auth is a read-only capability query from an already gated
      // host route. An explicit auth must still be a live, trusted session.
      if (auth !== undefined) {
        const trusted = decideSession(auth)
        if (trusted.kind !== 'allowed') {
          return {
            tier: 'unknown', tierSource: 'session-denied', needsAsyncMigration: false, capabilitiesRead: false,
          }
        }
      }
      const facts = await readCapabilities(signal)
      if (facts === undefined || !facts.ok || !facts.response?.ok) {
        return {
          tier: 'unknown', tierSource: 'unavailable', needsAsyncMigration: false, capabilitiesRead: false,
        }
      }
      return {
        tier: tierFromCapabilities(facts.response),
        tierSource: 'native-capabilities',
        needsAsyncMigration: false,
        capabilitiesRead: true,
      }
    },
  }
}

export interface NativeSharedBridge {
  controlExec(
    op: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    auth?: NativeSharedAuth,
  ): Promise<NativeSharedControlResult>
  status(): NativeSharedBridgeStatus
  statusAsync(auth?: NativeSharedAuth, signal?: AbortSignal): Promise<NativeSharedBridgeStatus>
}
