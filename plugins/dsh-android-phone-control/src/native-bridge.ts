/**
 * phone-control 的独立原生薄桥。
 *
 * 只做四件事：读取可信会话、校验完全权限、读取壳侧 capabilities、按其中的
 * epoch/generation 发一次 execute。能力与通道由壳侧原生宿主发布，本文件不根据
 * 工具名或旧 androidPrivilege 状态推断可用性。
 *
 * 不依赖旧控制队列、HTTP pending/result、ADB 或视觉回落。传输层见
 * native-client.ts（逐字复制自 dsh-android-bridge，来源说明在该文件头）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertNativeEndpoint, createNativeClient, type NativeClient } from './native-client.js'

export const NATIVE_CONTROL_SOCKET = '.native-control/control-v1.sock'
export const NATIVE_CONTROL_OPERATIONS = [
  'snapshot', 'click', 'longClick', 'setText', 'keyEvent', 'scroll', 'swipe', 'global', 'nodeText', 'screenshot', 'readRegion',
  'vdCreate', 'vdDestroy', 'vdLaunchApp', 'vdInfo', 'launchApp', 'webSnapshot', 'webAction',
  'shExec', 'rootExec', 'termuxExec', 'prepareEnvironment',
] as const

export type NativeControlOperation = (typeof NATIVE_CONTROL_OPERATIONS)[number]
export type NativeControlReply = Record<string, unknown>

/** 与 phone-control index.ts 现有 Bridge 同形，apply 可直接把返回值当 androidPrivilege 面使用。 */
export interface PhoneControlBridge {
  nativeControlCapabilities(session: unknown, signal?: AbortSignal): Promise<NativeControlReply>
  nativeControlExecute(
    operation: NativeControlOperation,
    screenId: string,
    args: Record<string, unknown>,
    session: unknown,
    signal?: AbortSignal,
  ): Promise<NativeControlReply>
}

type SandboxPolicy = { resolve(request?: { session?: unknown }): { mode?: string } }
type Sessions = { get(id: string): unknown }

export interface PhoneControlBridgeOptions {
  /** 测试或宿主显式提供的原生客户端；缺省从 DSH_FILES_DIR 构造。 */
  client?: NativeClient
  /** 仅覆盖客户端端点；仍必须是私有绝对 Unix socket 路径。 */
  endpoint?: string
  /** 缺省读取 ctx.sandboxPolicy。用于宿主适配，不绕过完全权限门。 */
  sandboxPolicy?: SandboxPolicy
  /** 缺省读取 ctx.sessions。只接受该服务返回同一对象实例的会话。 */
  sessions?: Sessions
  /** 缺省读取 DSH_FILES_DIR；显式传入时同样按 <dir>/.native-control/control-v1.sock 拼。 */
  filesDir?: string
}

export class PhoneControlBridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PhoneControlBridgeError'
    this.code = code
  }
}

/** 从应用私有 files 目录得到唯一协商过的原生控制 socket。 */
export function nativeControlEndpoint(filesDir: unknown): string {
  if (typeof filesDir !== 'string' || filesDir.length === 0 || filesDir.trim() !== filesDir) {
    throw new PhoneControlBridgeError('files-dir-unavailable', 'DSH_FILES_DIR is not available')
  }
  if (!filesDir.startsWith('/') || filesDir.includes('\\')) {
    throw new PhoneControlBridgeError('files-dir-invalid', 'DSH_FILES_DIR must be an absolute path')
  }
  // Android 路径是 POSIX 语义；Windows 上的 node:path.join 会产出反斜杠，必须显式拼接。
  const endpoint = filesDir.replace(/\/+$/u, '') + '/' + NATIVE_CONTROL_SOCKET
  try {
    return assertNativeEndpoint(endpoint)
  } catch (failure) {
    throw new PhoneControlBridgeError(
      'endpoint-invalid',
      failure instanceof Error ? failure.message : 'native control endpoint is invalid',
    )
  }
}

const OPERATION_SET: ReadonlySet<string> = new Set(NATIVE_CONTROL_OPERATIONS)
const UNSIGNED_U64 = /^(?:[0-9]{1,20}|0x[0-9A-Fa-f]{1,16})$/u
const U64_MAX = '18446744073709551615'

/** 保留线上字符串，绝不经过 Number。 */
function isU64(value: unknown): value is string {
  if (typeof value !== 'string' || !UNSIGNED_U64.test(value)) return false
  if (value.startsWith('0x')) return true
  return value.length < U64_MAX.length || (value.length === U64_MAX.length && value <= U64_MAX)
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get?(key: string): unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 创建独立薄桥。
 *
 * 端点无效时不在调用 `apply` 时抛错；两个方法都返回可诊断的失败回执，
 * 保持与现有手机工具面兼容。会话或客户端只在每次调用时读取，不缓存权限。
 */
export function createPhoneControlBridge(
  ctx: Context,
  options: PhoneControlBridgeOptions = {},
): PhoneControlBridge {
  const sessions = options.sessions ?? serviceOf<Sessions>(ctx, 'sessions')
  const sandboxPolicy = options.sandboxPolicy ?? serviceOf<SandboxPolicy>(ctx, 'sandboxPolicy')
  let client = options.client
  let clientError: string | undefined
  if (client === undefined) {
    try {
      const endpoint = options.endpoint === undefined ? undefined : assertNativeEndpoint(options.endpoint)
      const resolved = endpoint ?? nativeControlEndpoint(options.filesDir ?? process.env.DSH_FILES_DIR)
      client = createNativeClient({ endpoint: resolved })
    } catch (failure) {
      clientError = failure instanceof PhoneControlBridgeError ? failure.code : 'endpoint-invalid'
    }
  }

  /** 可信会话：身份必须来自 sessions 服务，且 resolve 出的档位为完全权限。 */
  function allowed(session: unknown): boolean {
    if (session === null || typeof session !== 'object' || sessions === undefined) return false
    const id = (session as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) return false
    try {
      if (sessions.get(id) !== session) return false
      return sandboxPolicy?.resolve({ session })?.mode === 'danger-full-access'
    } catch {
      return false
    }
  }

  function unavailable(code: string, screenId?: string): NativeControlReply {
    return { ok: false, code, executed: 'no', ...(screenId === undefined ? {} : { screenId }) }
  }

  return {
    async nativeControlCapabilities(session, signal) {
      if (client === undefined) return unavailable(clientError ?? 'native-control-unavailable')
      if (!allowed(session)) return unavailable('session-permission-denied')
      const facts = await client.capabilities({ signal })
      if (signal?.aborted) return unavailable('operation-aborted')
      if (!allowed(session)) return unavailable('session-permission-revoked')
      if (!facts.ok || !facts.response?.ok) {
        return unavailable(facts.response?.code ?? facts.error?.code ?? 'native-facts-unavailable')
      }
      return facts.response as NativeControlReply
    },

    async nativeControlExecute(operation, screenId, args, session, signal) {
      const reject = (code: string, executed = 'no') =>
        ({ ok: false, code, executed, screenId })
      if (client === undefined) return reject(clientError ?? 'native-control-unavailable')
      if (typeof operation !== 'string' || !OPERATION_SET.has(operation)) {
        return reject('operation-unsupported')
      }
      const shared = operation === 'webSnapshot' || operation === 'webAction' || operation === 'shExec' ||
        operation === 'rootExec' || operation === 'termuxExec' || operation === 'prepareEnvironment'
      if (shared && screenId !== '') return reject('screen-id-invalid')
      if (!shared && (typeof screenId !== 'string' || screenId.length === 0)) return reject('screen-id-invalid')
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return reject('args-invalid')
      if (!allowed(session)) return reject('session-permission-denied')

      const facts = await client.capabilities({ signal })
      if (!facts.ok || !facts.response?.ok) {
        return reject(facts.response?.code ?? facts.error?.code ?? 'native-facts-unavailable')
      }
      const { epoch, screens } = facts.response
      const screen = Array.isArray(screens)
        ? (screens as Array<{ screenId?: unknown; generation?: unknown } | null>)
          .find((row) => row?.screenId === screenId)
        : undefined
      // 原样回传字符串，不做数值归一化；缺代次时拒绝，绝不猜目标屏。
      const newVirtual = operation === 'vdCreate' || operation === 'vdInfo'
      if (!isU64(epoch) || (!newVirtual && !shared && !isU64(screen?.generation))) return reject('screen-not-ready')
      if (signal?.aborted) return reject('operation-aborted')
      if (!allowed(session)) return reject('session-permission-denied')

      const sessionId = (session as { id: string }).id
      const payload = operation.startsWith('vd') ? { ...args, session: sessionId } : args
      const shell = operation === 'shExec' || operation === 'rootExec' || operation === 'termuxExec' || operation === 'prepareEnvironment'
      const result = await client.execute({
        callId: randomUUID(), operation, epoch, ...(!shared ? { screenId } : {}),
        ...(!newVirtual && !shared && screen ? { generation: screen.generation as string } : {}), args: payload,
        ...(shell ? { timeoutMs: 25_000 } : {}),
      }, { signal, ...(shell ? { timeoutMs: 27_000 } : {}) })
      if (!allowed(session)) return reject('session-permission-revoked', result.executed)
      return result.response ?? reject(result.error?.code ?? 'native-result-unavailable', result.executed)
    },
  }
}
