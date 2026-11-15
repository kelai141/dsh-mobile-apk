/**
 * 原生控制的薄 IPC 客户端。只序列化请求、解析响应，不持有控制状态。
 *
 * 传输是应用私有 filesystem Unix socket 上的一帧：4 字节大端长度 +
 * 标准 UTF-8 JSON。每个请求单独一连接，不重试、不重新协商。
 *
 * 来源：逐字复制 coord/plugins/dsh-android-bridge/src/native-client.ts
 * （2026-11-14，bridge 0.2.4）。phone-control 有意的独立副本：新薄桥不依赖旧
 * androidPrivilege 服务，也不把 bridge 的其它模块带进新包。改动请在两个文件
 * 同步评审；此处只追加本段来源说明。
 */
import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'

export const NATIVE_PROTOCOL_VERSION = 1
export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type NativeExecuted = 'yes' | 'no' | 'unknown'

/** 只接受绝对路径的 filesystem Unix socket 端点。 */
export function assertNativeEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('native endpoint must be a non-empty absolute Unix socket path')
  }
  if (endpoint.includes('\u0000')) {
    throw new TypeError('native endpoint must not contain NUL')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(endpoint) || endpoint.includes('://')) {
    throw new TypeError('native endpoint must be a filesystem Unix socket path, not a URL')
  }
  if (endpoint[0] !== '/') {
    throw new TypeError('native endpoint must be an absolute Unix socket path')
  }
  // Linux sockaddr_un.sun_path 上限；Android 原生端同样要求小于 104 字节。
  if (Buffer.byteLength(endpoint, 'utf8') >= 104) {
    throw new TypeError('native endpoint path is too long for a Unix socket')
  }
  return endpoint
}

export interface NativeCapabilitiesRequest {
  method: 'capabilities'
}

export interface NativeExecuteRequest {
  method: 'execute'
  callId: string
  /** opaque unsigned u64 字符串，原样序列化。 */
  epoch: string
  operation: string
  screenId?: string
  /** opaque unsigned u64 字符串，原样序列化。 */
  generation?: string
  timeoutMs?: number
  args?: Record<string, unknown>
}

export interface NativeStatusRequest {
  method: 'status'
  callId: string
}

/** 显式取消请求；本地 Abort 不能冒充它。 */
export interface NativeCancelRequest {
  method: 'cancel'
  callId: string
}

export type NativeRequest =
  | NativeCapabilitiesRequest
  | NativeExecuteRequest
  | NativeStatusRequest
  | NativeCancelRequest

/** 可注入的连接器；测试可用任意 Duplex 模拟分片和断连。 */
export type NativeConnector = (
  endpoint: string,
  signal?: AbortSignal,
) => Duplex

export interface NativeClientOptions {
  endpoint: string
  connector?: NativeConnector
}

export interface NativeResponse {
  protocolVersion: 1
  ok: boolean
  code?: string
  executed: NativeExecuted
  screenId: string | null
  callId?: string
  [key: string]: unknown
}

export type NativeFailureCode =
  | 'endpoint-invalid'
  | 'request-invalid'
  | 'request-too-large'
  | 'timeout-invalid'
  | 'connect-failed'
  | 'write-failed'
  | 'connection-lost'
  | 'response-truncated'
  | 'response-too-large'
  | 'response-empty'
  | 'response-invalid'
  | 'response-invalid-utf8'
  | 'response-invalid-json'
  | 'response-invalid-version'
  | 'response-call-mismatch'
  | 'timeout'
  | 'aborted'
  | 'connection-closed'

/**
 * 传输层的稳定结果。ok=false 且 executed=unknown 表示无法确认是否产生了
 * 原生副作用；execute 不得自动重试或换 callId。
 */
export interface NativeTransportResult {
  ok: boolean
  executed: NativeExecuted
  response?: NativeResponse
  error?: {
    kind: 'configuration' | 'connect' | 'write' | 'timeout' | 'aborted' | 'protocol' | 'closed'
    code: NativeFailureCode
    message: string
  }
}

export interface NativeRpcOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface NativeExecuteInput {
  callId: string
  epoch: string
  operation: string
  screenId?: string
  generation?: string
  timeoutMs?: number
  args?: Record<string, unknown>
}

export interface NativeClient {
  capabilities(options?: NativeRpcOptions): Promise<NativeTransportResult>
  execute(request: NativeExecuteInput, options?: NativeRpcOptions): Promise<NativeTransportResult>
  cancel(callId: string, options?: NativeRpcOptions): Promise<NativeTransportResult>
  status(callId: string, options?: NativeRpcOptions): Promise<NativeTransportResult>
}

const DEFAULT_TIMEOUT_MS = 15_000
const HEADER_BYTES = 4
const CALL_ID = /^[A-Za-z0-9._:-]{1,64}$/
const OPERATION = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const UNSIGNED = /^(?:[0-9]{1,20}|0[xX][0-9A-Fa-f]{1,16})$/
const U64_MAX_DECIMAL = '18446744073709551615'

export function createNativeClient(options: NativeClientOptions): NativeClient {
  let endpoint: string
  try {
    endpoint = assertNativeEndpoint(options.endpoint)
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    return invalidClient('endpoint-invalid', message)
  }
  const connector = options.connector ?? defaultConnector
  return {
    capabilities: (rpc = {}) =>
      rpcCall(connector, endpoint, { method: 'capabilities' }, rpc),
    execute: (request, rpc = {}) => {
      const payload = executeRequest(request)
      if ('error' in payload) return Promise.resolve(payload.error)
      return rpcCall(connector, endpoint, payload.value, rpc)
    },
    cancel: (callId, rpc = {}) => {
      if (!CALL_ID.test(callId)) return Promise.resolve(requestFailure('callId is invalid'))
      return rpcCall(connector, endpoint, { method: 'cancel', callId }, rpc)
    },
    status: (callId, rpc = {}) => {
      if (!CALL_ID.test(callId)) return Promise.resolve(requestFailure('callId is invalid'))
      return rpcCall(connector, endpoint, { method: 'status', callId }, rpc)
    },
  }
}

function invalidClient(code: 'endpoint-invalid', message: string): NativeClient {
  const result = (): Promise<NativeTransportResult> =>
    Promise.resolve(configurationFailure(code, message))
  return {
    capabilities: result,
    execute: result,
    cancel: result,
    status: result,
  }
}

function defaultConnector(endpoint: string): Duplex {
  return createConnection({ path: endpoint, allowHalfOpen: false })
}

function executeRequest(
  request: NativeExecuteInput,
): { value: NativeExecuteRequest } | { error: NativeTransportResult } {
  if (request === null || typeof request !== 'object') {
    return { error: requestFailure('execute request must be an object') }
  }
  if (!CALL_ID.test(request.callId)) return { error: requestFailure('callId is invalid') }
  if (typeof request.epoch !== 'string' || !isUnsignedU64(request.epoch)) {
    return { error: requestFailure('epoch must be an opaque unsigned u64 string') }
  }
  if (typeof request.operation !== 'string' || !OPERATION.test(request.operation)) {
    return { error: requestFailure('operation is invalid') }
  }
  if (request.screenId !== undefined && typeof request.screenId !== 'string') {
    return { error: requestFailure('screenId must be a string') }
  }
  if (request.generation !== undefined &&
    (typeof request.generation !== 'string' || !isUnsignedU64(request.generation))) {
    return { error: requestFailure('generation must be an opaque unsigned u64 string') }
  }
  if (request.timeoutMs !== undefined &&
    (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000)) {
    return { error: requestFailure('timeoutMs must be an integer from 1 to 30000') }
  }
  const args = request.args
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return { error: requestFailure('args must be a JSON object') }
  }
  // 白名单组装；不转送 facts/backend/caller/uid 等内部字段。
  return {
    value: {
      method: 'execute',
      callId: request.callId,
      epoch: request.epoch,
      operation: request.operation,
      ...(request.screenId === undefined ? {} : { screenId: request.screenId }),
      ...(request.generation === undefined ? {} : { generation: request.generation }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(args === undefined ? {} : { args }),
    },
  }
}

/** 只校验边界；保留原字符串，不经过 JS Number。 */
function isUnsignedU64(value: string): boolean {
  if (!UNSIGNED.test(value)) return false
  if (/^0[xX]/.test(value)) return true
  return value.length < U64_MAX_DECIMAL.length ||
    (value.length === U64_MAX_DECIMAL.length && value <= U64_MAX_DECIMAL)
}

function rpcCall(
  connector: NativeConnector,
  endpoint: string,
  request: NativeRequest,
  rpc: NativeRpcOptions,
): Promise<NativeTransportResult> {
  const encoded = encodeRequest(request)
  if (!encoded.ok) return Promise.resolve(encoded.result)
  const timeout = normalizeTimeout(rpc.timeoutMs)
  if (!timeout.ok) return Promise.resolve(timeout.result)
  if (rpc.signal?.aborted) return Promise.resolve(abortedResult(false))

  return new Promise((resolve) => {
    let settled = false
    let socket: Duplex | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let sent = false
    let received = 0
    let expected: number | undefined
    let parts: Uint8Array[] = []
    let completed: NativeTransportResult | undefined

    const onAbort = (): void => finish(abortedResult(sent))

    const finish = (result: NativeTransportResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      rpc.signal?.removeEventListener('abort', onAbort)
      try {
        socket?.destroy()
      } catch {
        // 关闭失败不改变已分类的传输结果。
      }
      resolve(result)
    }

    const onData = (chunk: unknown): void => {
      if (settled) return
      if (completed !== undefined) {
        finish(protocolFailure(sent, 'response-invalid', 'trailing bytes after the response frame'))
        return
      }
      if (!(chunk instanceof Uint8Array)) {
        finish(protocolFailure(sent, 'response-invalid', 'response chunk is not bytes'))
        return
      }
      received += chunk.byteLength
      if (received > HEADER_BYTES + MAX_RESPONSE_BYTES) {
        finish(protocolFailure(sent, 'response-too-large', 'response exceeds the frame limit'))
        return
      }
      parts.push(chunk)
      if (expected === undefined) {
        if (received < HEADER_BYTES) return
        const joined = Buffer.concat(parts, received)
        expected = joined.readUInt32BE(0)
        parts = [joined.subarray(HEADER_BYTES)]
        received -= HEADER_BYTES
        if (expected === 0) {
          finish(protocolFailure(sent, 'response-empty', 'response frame is empty'))
          return
        }
        if (expected > MAX_RESPONSE_BYTES) {
          finish(protocolFailure(sent, 'response-too-large', 'response length is outside the frame limit'))
          return
        }
      }
      if (received > expected) {
        finish(protocolFailure(sent, 'response-invalid', 'trailing bytes after the response frame'))
        return
      }
      if (received === expected) {
        completed = decodeResponse(sent, Buffer.concat(parts, received), request)
      }
    }

    // 完整帧要等 end/close 确认没有尾随帧后再交付。
    const onEnd = (): void => {
      if (settled) return
      if (completed !== undefined) {
        finish(completed)
      } else if (expected === undefined || received < expected) {
        finish(protocolFailure(sent, 'response-truncated', 'connection ended before the response frame completed'))
      } else {
        finish(protocolFailure(sent, 'connection-closed', 'connection closed before a complete response'))
      }
    }

    const onError = (error: unknown): void => {
      if (settled) return
      const message = error instanceof Error ? error.message : String(error)
      finish(connectionFailure(sent, message))
    }

    const onClose = (): void => onEnd()

    try {
      socket = connector(endpoint, rpc.signal)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      finish(connectionFailure(false, message))
      return
    }
    const connected = socket
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('error', onError)
    socket.on('close', onClose)
    rpc.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      finish({
        ok: false,
        executed: sent ? 'unknown' : 'no',
        error: {
          kind: 'timeout',
          code: 'timeout',
          message: 'native request timed out',
        },
      })
    }, timeout.value)

    connected.once('connect', () => {
      if (settled) return
      try {
        // 进入 sent 后断开就是 unknown；不重发也不换 callId。
        sent = true
        connected.write(encoded.frame)
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        finish({
          ok: false,
          executed: 'unknown',
          error: { kind: 'write', code: 'write-failed', message },
        })
      }
    })
  })
}

type EncodedRequest =
  | { ok: true; frame: Uint8Array }
  | { ok: false; result: NativeTransportResult }

function encodeRequest(request: NativeRequest): EncodedRequest {
  let text: string
  try {
    text = JSON.stringify({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      ...request,
    })
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : 'request is not JSON serializable'
    return { ok: false, result: requestFailure(message) }
  }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REQUEST_BYTES) {
    return {
      ok: false,
      result: configurationFailure('request-too-large', 'request exceeds the 64 KiB frame limit'),
    }
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + bytes.byteLength)
  frame.writeUInt32BE(bytes.byteLength, 0)
  bytes.copy(frame, HEADER_BYTES)
  return { ok: true, frame }
}

function requestFailure(message: string): NativeTransportResult {
  return configurationFailure('request-invalid', message)
}

function configurationFailure(
  code: NativeFailureCode,
  message: string,
): NativeTransportResult {
  return {
    ok: false,
    executed: 'no',
    error: { kind: 'configuration', code, message },
  }
}

function normalizeTimeout(
  value: number | undefined,
): { ok: true; value: number } | { ok: false; result: NativeTransportResult } {
  if (value === undefined) return { ok: true, value: DEFAULT_TIMEOUT_MS }
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      result: configurationFailure('timeout-invalid', 'timeoutMs must be a positive finite number'),
    }
  }
  return { ok: true, value: Math.min(Math.floor(value), 2_147_483_647) }
}

function abortedResult(sent: boolean): NativeTransportResult {
  return {
    ok: false,
    executed: sent ? 'unknown' : 'no',
    error: {
      kind: 'aborted',
      code: 'aborted',
      message: 'request aborted; the native operation was not cancelled',
    },
  }
}

function connectionFailure(sent: boolean, message: string): NativeTransportResult {
  return {
    ok: false,
    executed: sent ? 'unknown' : 'no',
    error: {
      kind: sent ? 'closed' : 'connect',
      code: sent ? 'connection-lost' : 'connect-failed',
      message,
    },
  }
}

function protocolFailure(
  sent: boolean,
  code: NativeFailureCode,
  message: string,
): NativeTransportResult {
  return {
    ok: false,
    executed: sent ? 'unknown' : 'no',
    error: { kind: 'protocol', code, message },
  }
}

function decodeResponse(
  sent: boolean,
  bytes: Uint8Array,
  request: NativeRequest,
): NativeTransportResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return protocolFailure(sent, 'response-invalid-utf8', 'response is not valid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return protocolFailure(sent, 'response-invalid-json', 'response is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return protocolFailure(sent, 'response-invalid', 'response must be a JSON object')
  }
  const response = value as Record<string, unknown>
  if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    return protocolFailure(sent, 'response-invalid-version', 'response protocolVersion is not 1')
  }
  if (typeof response.ok !== 'boolean') {
    return protocolFailure(sent, 'response-invalid', 'response ok must be a boolean')
  }
  if (response.executed !== 'yes' && response.executed !== 'no' && response.executed !== 'unknown') {
    return protocolFailure(sent, 'response-invalid', 'response executed must be yes, no, or unknown')
  }
  if (!('screenId' in response) || (response.screenId !== null && typeof response.screenId !== 'string')) {
    return protocolFailure(sent, 'response-invalid', 'response screenId must be a string or null')
  }
  if (response.code !== undefined && typeof response.code !== 'string') {
    return protocolFailure(sent, 'response-invalid', 'response code must be a string when present')
  }
  if (response.ok === true && response.executed === 'unknown') {
    return protocolFailure(sent, 'response-invalid', 'an unknown outcome cannot be ok')
  }
  if ('callId' in request && response.callId !== request.callId) {
    return protocolFailure(sent, 'response-call-mismatch', 'response callId does not match the request')
  }
  return {
    ok: response.ok === true,
    executed: response.executed,
    response: response as NativeResponse,
  }
}
