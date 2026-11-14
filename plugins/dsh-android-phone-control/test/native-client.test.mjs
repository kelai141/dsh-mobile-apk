import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertNativeEndpoint,
  createNativeClient,
  MAX_RESPONSE_BYTES,
} from '../src/native-client.ts'

const ENDPOINT = '/data/user/0/com.dsharnessmobile.shell/files/.native-control/control-v1.sock'

class ScriptedSocket extends EventEmitter {
  writes = []
  destroyed = false
  script = () => {}

  write(chunk) {
    this.writes.push(Buffer.from(chunk))
    this.script(this)
  }

  destroy() {
    this.destroyed = true
    this.emit('close')
  }
}

function connectorFor(socket) {
  return () => {
    queueMicrotask(() => socket.emit('connect'))
    return socket
  }
}

function clientWith(socket) {
  return createNativeClient({ endpoint: ENDPOINT, connector: connectorFor(socket) })
}

function frame(value) {
  if (value instanceof Uint8Array) {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(value.byteLength)
    return Buffer.concat([header, value])
  }
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(bytes.byteLength)
  return Buffer.concat([header, bytes])
}

function sentRequest(socket) {
  const raw = socket.writes[0]
  assert.ok(raw, 'the request frame should be sent')
  assert.equal(raw.readUInt32BE(0), raw.byteLength - 4)
  return JSON.parse(raw.subarray(4).toString('utf8'))
}

function reply(socket, body, pieces = [body], end = true) {
  for (const piece of pieces) socket.emit('data', piece)
  if (end) socket.emit('end')
}

function success(overrides = {}) {
  return {
    protocolVersion: 1,
    ok: true,
    code: 'tap-executed',
    executed: 'yes',
    screenId: 'virtual-1',
    callId: 'call-1',
    ...overrides,
  }
}

test('endpoint accepts only a private absolute filesystem Unix path', () => {
  assert.equal(assertNativeEndpoint(ENDPOINT), ENDPOINT)
  assertNativeEndpoint('/data/data/app/files/.native-control/x.sock')
  for (const bad of [
    'http://127.0.0.1:1234',
    'tcp://127.0.0.1:1234',
    'unix:///tmp/x.sock',
    'relative/x.sock',
    './x.sock',
    '',
    '/data/app\u0000/files/x.sock',
    '/' + 'a'.repeat(103),
    null,
    42,
  ]) {
    assert.throws(() => assertNativeEndpoint(bad), TypeError, String(bad))
  }
})

test('invalid endpoint fails before opening any connection', async () => {
  let calls = 0
  const client = createNativeClient({
    endpoint: 'http://127.0.0.1:4444',
    connector: () => {
      calls++
      return new ScriptedSocket()
    },
  })
  const result = await client.capabilities()
  assert.equal(calls, 0)
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'no')
  assert.equal(result.error.code, 'endpoint-invalid')
})

test('capabilities sends the exact public request and keeps Rust facts verbatim', async () => {
  const socket = new ScriptedSocket()
  const capabilities = {
    protocolVersion: 1,
    ok: true,
    code: 'capabilities',
    executed: 'no',
    screenId: null,
    scope: 'virtual-only',
    epoch: '18446744073709551615',
    screens: [{ screenId: 'virtual-1', generation: '18446744073709551615' }],
  }
  socket.script = (s) => reply(s, frame(capabilities))
  const result = await clientWith(socket).capabilities()
  assert.deepEqual(sentRequest(socket), { protocolVersion: 1, method: 'capabilities' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.response, capabilities)
  assert.equal(socket.destroyed, true)
})

test('execute preserves Unicode and u64 boundary strings without Number conversion', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) => reply(s, frame(success()))
  const result = await clientWith(socket).execute({
    callId: 'call-1',
    epoch: '18446744073709551615',
    generation: '18446744073709551615',
    operation: 'click',
    screenId: 'virtual-1',
    timeoutMs: 30000,
    args: { label: '设置 · 深色模式 😀', nested: { note: '中文' } },
  })
  const request = sentRequest(socket)
  assert.equal(request.epoch, '18446744073709551615')
  assert.equal(request.generation, '18446744073709551615')
  assert.equal(typeof request.epoch, 'string')
  assert.equal(request.args.label, '设置 · 深色模式 😀')
  assert.deepEqual(Object.keys(request).sort(), [
    'args', 'callId', 'epoch', 'generation', 'method', 'operation',
    'protocolVersion', 'screenId', 'timeoutMs',
  ])
  assert.equal(result.ok, true)
  assert.equal(result.executed, 'yes')
  assert.equal(result.response.callId, 'call-1')
  assert.equal(result.response.screenId, 'virtual-1')
})

test('execute does not mutate input and exposes only the four public methods', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) => reply(s, frame(success()))
  const client = clientWith(socket)
  const request = { callId: 'call-1', epoch: '1', operation: 'click', args: { x: 1, y: 2 } }
  const snapshot = structuredClone(request)
  await client.execute(request)
  assert.deepEqual(request, snapshot)
  assert.deepEqual(Object.keys(client).sort(), ['cancel', 'capabilities', 'execute', 'status'])
})

test('internal fields are never serialized into the request', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) => reply(s, frame(success()))
  await clientWith(socket).execute({
    callId: 'call-1',
    epoch: '1',
    operation: 'click',
    facts: { scope: 'real' },
    backend: 'su',
    caller: 'node',
    uid: 1000,
    root: true,
    channel: 'adb',
  })
  const request = sentRequest(socket)
  for (const key of ['facts', 'backend', 'caller', 'uid', 'root', 'channel']) {
    assert.equal(key in request, false, key)
  }
})

test('invalid execute fields and oversize requests fail before connecting', async () => {
  let calls = 0
  const client = createNativeClient({
    endpoint: ENDPOINT,
    connector: () => {
      calls++
      return new ScriptedSocket()
    },
  })
  const cases = [
    { callId: '', epoch: '1', operation: 'click' },
    { callId: 'has space', epoch: '1', operation: 'click' },
    { callId: 'x'.repeat(65), epoch: '1', operation: 'click' },
    { callId: 'call-1', epoch: 1, operation: 'click' },
    { callId: 'call-1', epoch: '-1', operation: 'click' },
    { callId: 'call-1', epoch: '18446744073709551616', operation: 'click' },
    { callId: 'call-1', epoch: '1', operation: 'bad-op!' },
    { callId: 'call-1', epoch: '1', operation: 'click', generation: 7 },
    { callId: 'call-1', epoch: '1', operation: 'click', timeoutMs: 0 },
    { callId: 'call-1', epoch: '1', operation: 'click', timeoutMs: 30001 },
    { callId: 'call-1', epoch: '1', operation: 'click', args: [] },
    { callId: 'call-1', epoch: '1', operation: 'click', args: { pad: 'x'.repeat(65 * 1024) } },
  ]
  for (const request of cases) {
    const result = await client.execute(request)
    assert.equal(result.ok, false, JSON.stringify(request).slice(0, 80))
    assert.equal(result.executed, 'no')
    assert.equal(result.error.kind, 'configuration')
  }
  const recursive = {}
  recursive.self = recursive
  const circular = await client.execute({
    callId: 'call-1', epoch: '1', operation: 'click', args: recursive,
  })
  assert.equal(circular.error.code, 'request-invalid')
  assert.equal(calls, 0)
})

test('arbitrary response fragmentation is reassembled byte for byte', async () => {
  const response = frame(success({ args: { text: '分片 🧩' } }))
  const pieces = []
  for (let index = 0; index < response.byteLength; index += 3) {
    pieces.push(response.subarray(index, index + 3))
  }
  const socket = new ScriptedSocket()
  socket.script = (s) => reply(s, response, pieces)
  const result = await clientWith(socket).execute({
    callId: 'call-1',
    epoch: '0xFFFFFFFFFFFFFFFF',
    operation: 'click',
  })
  assert.equal(result.ok, true)
  assert.equal(result.response.args.text, '分片 🧩')
})

test('length header split across chunks is handled', async () => {
  const response = frame(success())
  const socket = new ScriptedSocket()
  socket.script = (s) => {
    s.emit('data', response.subarray(0, 1))
    s.emit('data', response.subarray(1, 2))
    s.emit('data', response.subarray(2, 4))
    s.emit('data', response.subarray(4))
    s.emit('end')
  }
  const result = await clientWith(socket).execute({
    callId: 'call-1', epoch: '1', operation: 'click',
  })
  assert.equal(result.ok, true)
})

test('oversize declared length is rejected before the body is allocated', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_RESPONSE_BYTES + 1)
    s.emit('data', header)
  }
  const result = await clientWith(socket).execute({
    callId: 'call-1', epoch: '1', operation: 'click',
  })
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'unknown')
  assert.equal(result.error.code, 'response-too-large')
})

test('streamed body beyond the declared frame is rejected', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(16)
    s.emit('data', header)
    s.emit('data', Buffer.alloc(17, 0x20))
  }
  const result = await clientWith(socket).execute({
    callId: 'call-1', epoch: '1', operation: 'click',
  })
  assert.equal(result.executed, 'unknown')
  assert.equal(result.error.code, 'response-invalid')
})

test('zero length, empty body, truncated frame and trailing frame are rejected', async () => {
  const scenarios = [
    [Buffer.alloc(4), 'response-empty'],
    [frame(''), 'response-empty'],
    [Buffer.from([0, 0, 0, 20, 123]), 'response-truncated'],
    [Buffer.concat([frame(success()), Buffer.from('tail')]), 'response-invalid'],
  ]
  for (const [bytes, code] of scenarios) {
    const socket = new ScriptedSocket()
    socket.script = (s) => {
      s.emit('data', bytes)
      s.emit('end')
    }
    const result = await clientWith(socket).execute({
      callId: 'call-1', epoch: '1', operation: 'click',
    })
    assert.equal(result.ok, false, code)
    assert.equal(result.executed, 'unknown', code)
    assert.equal(result.error.code, code)
  }
})

test('invalid UTF-8, JSON shape, version, executed, screenId and callId are rejected', async () => {
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"protocolVersion":1,"ok":true,"executed":"yes","screenId":null,"callId":"call-1","x":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ])
  const cases = [
    [invalidUtf8, 'response-invalid-utf8'],
    [Buffer.from('{"protocolVersion":1,'), 'response-invalid-json'],
    [Buffer.from('[]'), 'response-invalid'],
    [Buffer.from('null'), 'response-invalid'],
    [Buffer.from(JSON.stringify(success({ protocolVersion: 2 }))), 'response-invalid-version'],
    [Buffer.from(JSON.stringify(success({ executed: 'maybe' }))), 'response-invalid'],
    [Buffer.from(JSON.stringify(success({ screenId: 7 }))), 'response-invalid'],
    [Buffer.from(JSON.stringify(success({ ok: true, executed: 'unknown' }))), 'response-invalid'],
    [Buffer.from(JSON.stringify(success({ callId: 'other' }))), 'response-call-mismatch'],
    [Buffer.from(JSON.stringify(success({ callId: undefined }))), 'response-call-mismatch'],
  ]
  for (const [body, code] of cases) {
    const socket = new ScriptedSocket()
    socket.script = (s) => reply(s, frame(body))
    const result = await clientWith(socket).execute({
      callId: 'call-1', epoch: '1', operation: 'click',
    })
    assert.equal(result.ok, false, code)
    assert.equal(result.executed, 'unknown', code)
    assert.equal(result.error.code, code)
  }
})

test('a native unknown outcome is returned without relabeling it', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) =>
    reply(s, frame({
      protocolVersion: 1,
      ok: false,
      code: 'platform-result-unknown',
      executed: 'unknown',
      screenId: null,
      callId: 'call-1',
    }))
  const result = await clientWith(socket).execute({
    callId: 'call-1', epoch: '1', operation: 'click',
  })
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'unknown')
  assert.equal(result.response.code, 'platform-result-unknown')
})

test('connect failure before any write is executed no and is not retried', async () => {
  let calls = 0
  const client = createNativeClient({
    endpoint: ENDPOINT,
    connector: () => {
      calls++
      throw new Error('ENOENT')
    },
  })
  const result = await client.execute({ callId: 'call-1', epoch: '1', operation: 'click' })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'no')
  assert.equal(result.error.code, 'connect-failed')
})

test('close after write is executed unknown and keeps the original callId', async () => {
  const socket = new ScriptedSocket()
  let calls = 0
  const client = createNativeClient({
    endpoint: ENDPOINT,
    connector: () => {
      calls++
      queueMicrotask(() => socket.emit('connect'))
      return socket
    },
  })
  socket.script = (s) => s.emit('close')
  const result = await client.execute({ callId: 'after-1', epoch: '1', operation: 'click' })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'unknown')
  assert.equal(sentRequest(socket).callId, 'after-1')
})

test('error after a partial response is executed unknown', async () => {
  const socket = new ScriptedSocket()
  socket.script = (s) => {
    s.emit('data', Buffer.from([0, 0, 0, 40, 123]))
    s.emit('error', new Error('ECONNRESET'))
  }
  const result = await clientWith(socket).execute({
    callId: 'error-1', epoch: '1', operation: 'click',
  })
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'unknown')
  assert.equal(result.error.code, 'connection-lost')
})

test('timeout closes this socket without executing or cancelling again', async () => {
  const socket = new ScriptedSocket()
  let calls = 0
  const client = createNativeClient({
    endpoint: ENDPOINT,
    connector: () => {
      calls++
      queueMicrotask(() => socket.emit('connect'))
      return socket
    },
  })
  const result = await client.execute(
    { callId: 'timeout-1', epoch: '1', operation: 'click' },
    { timeoutMs: 20 },
  )
  assert.equal(calls, 1)
  assert.equal(result.executed, 'unknown')
  assert.equal(result.error.kind, 'timeout')
  assert.equal(socket.destroyed, true)
  assert.equal(socket.writes.length, 1)
})

test('Abort before write is executed no and sends no bytes', async () => {
  const socket = new ScriptedSocket()
  const client = clientWith(socket)
  const controller = new AbortController()
  const pending = client.execute(
    { callId: 'abort-1', epoch: '1', operation: 'click' },
    { signal: controller.signal },
  )
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'no')
  assert.equal(result.error.kind, 'aborted')
  assert.equal(socket.writes.length, 0)
  assert.equal(socket.destroyed, true)
})

test('Abort after write is executed unknown and does not send cancel', async () => {
  const socket = new ScriptedSocket()
  const client = clientWith(socket)
  const controller = new AbortController()
  const pending = client.execute(
    { callId: 'abort-2', epoch: '1', operation: 'click' },
    { signal: controller.signal },
  )
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.executed, 'unknown')
  assert.equal(result.error.kind, 'aborted')
  assert.equal(socket.destroyed, true)
  assert.equal(socket.writes.length, 1)
  assert.equal(sentRequest(socket).method, 'execute')
})

test('cancel and status are explicit forwarded methods', async () => {
  const cancelSocket = new ScriptedSocket()
  cancelSocket.script = (s) => reply(s, frame({
    protocolVersion: 1, ok: true, code: 'cancel', executed: 'no',
    screenId: null, callId: 'cancel-1',
  }))
  const statusSocket = new ScriptedSocket()
  statusSocket.script = (s) => reply(s, frame({
    protocolVersion: 1, ok: true, code: 'operationStatus', executed: 'yes',
    screenId: null, callId: 'status-1',
  }))
  await clientWith(cancelSocket).cancel('cancel-1')
  await clientWith(statusSocket).status('status-1')
  assert.deepEqual(sentRequest(cancelSocket), {
    protocolVersion: 1, method: 'cancel', callId: 'cancel-1',
  })
  assert.deepEqual(sentRequest(statusSocket), {
    protocolVersion: 1, method: 'status', callId: 'status-1',
  })
})

test('each request uses its own socket', async () => {
  const sockets = []
  const connector = () => {
    const socket = new ScriptedSocket()
    socket.script = (s) => reply(s, frame({
      protocolVersion: 1, ok: true, code: 'ok', executed: 'no', screenId: null,
    }))
    sockets.push(socket)
    queueMicrotask(() => socket.emit('connect'))
    return socket
  }
  const client = createNativeClient({ endpoint: ENDPOINT, connector })
  await client.capabilities()
  await client.capabilities()
  assert.equal(sockets.length, 2)
  assert.notEqual(sockets[0], sockets[1])
  assert.equal(sockets.every((socket) => socket.destroyed), true)
})

test('image base64 is returned verbatim without decoding or cropping', async () => {
  const jpegBase64 = '+/9BUE5H'
  const socket = new ScriptedSocket()
  socket.script = (s) => reply(s, frame(success({
    callId: 'image-1',
    image: { data: jpegBase64, bytes: 6 },
  })))
  const result = await clientWith(socket).execute({
    callId: 'image-1', epoch: '1', operation: 'screenshot',
  })
  assert.equal(result.response.image.data, jpegBase64)
  assert.equal(result.response.image.bytes, 6)
})

test('invalid timeout options fail locally', async () => {
  let calls = 0
  const client = createNativeClient({
    endpoint: ENDPOINT,
    connector: () => {
      calls++
      return new ScriptedSocket()
    },
  })
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await client.capabilities({ timeoutMs })
    assert.equal(result.ok, false)
    assert.equal(result.executed, 'no')
    assert.equal(result.error.code, 'timeout-invalid')
  }
  assert.equal(calls, 0)
})

test('real filesystem Unix socket round trip on Linux', {
  skip: process.platform !== 'linux',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-client-'))
  const endpoint = join(directory, 'control.sock')
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const length = chunk.readUInt32BE(0)
      assert.equal(length, chunk.byteLength - 4)
      const request = JSON.parse(chunk.subarray(4).toString('utf8'))
      const body = Buffer.from(JSON.stringify({
        protocolVersion: 1,
        ok: true,
        code: 'capabilities',
        executed: 'no',
        screenId: null,
        method: request.method,
        epoch: '18446744073709551615',
      }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.byteLength)
      socket.end(Buffer.concat([header, body]))
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    const client = createNativeClient({ endpoint })
    const result = await client.capabilities({ timeoutMs: 5000 })
    assert.equal(result.ok, true)
    assert.equal(result.response.epoch, '18446744073709551615')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
