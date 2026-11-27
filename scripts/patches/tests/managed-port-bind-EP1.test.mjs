import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { versionedFixture } from './lib/fixture.mjs'
import { patchManagedPortBind, hasManagedPortBind, MANAGED_LISTEN_BLOCK, MANAGED_PORT_MARKER } from '../data/managed-port-bind-EP1.mjs'

const execute = new Function('process', 'return async function(){' + MANAGED_LISTEN_BLOCK + '}')
const bind = (server, port, env = { DSH_MOBILE_MANAGED_ENGINE: '1' }, host = '127.0.0.1') => {
  const instance = { server, config: { port, host }, ctx: { logger: { error() {} } } }
  return { instance, env, promise: execute({ env }).call(instance) }
}
const close = server => new Promise(resolve => server.close(resolve))

test('EP1 matches the published fixture once and rejects drift', () => {
  const source = readFileSync(versionedFixture('dsh-host-webserver', 'lib', 'index.js'), 'utf8')
  const patched = patchManagedPortBind(source)
  assert.ok(hasManagedPortBind(patched))
  assert.equal(patchManagedPortBind(patched), patched)
  assert.throws(() => patchManagedPortBind(source + source), /one listen anchor/)
  assert.throws(() => patchManagedPortBind(patched.replace('let retried = false;', 'let retried = true;')), /partial marker/)
  assert.throws(() => patchManagedPortBind(source.replace('this.server.listen(this.config.port', 'this.server.listen(9999')), /one listen anchor/)
  assert.equal(patched.split(MANAGED_PORT_MARKER).length, 2)
  const oldEP1 = patched.replace(/^.*__dshMobileBootAttribution.*\n/m, '')
  assert.equal(patchManagedPortBind(oldEP1), patched)
})

test('real occupied listener stays alive while managed bind atomically gets an OS port', async () => {
  const owner = createServer()
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve))
  const other = createServer()
  const marks = []
  globalThis.__dshMobileBootAttribution = { mark: (name, at, boundPort) => marks.push({ name, at, boundPort, listening: other.listening }) }
  try {
    const attempt = bind(other, owner.address().port)
    await attempt.promise
    assert.ok(owner.listening)
    assert.ok(other.listening)
    assert.notEqual(attempt.instance.listenedPort, owner.address().port)
    assert.equal(Number(attempt.env.DSH_ENGINE_PORT), other.address().port)
    assert.equal(other.listenerCount('listening'), 0)
    assert.equal(marks.length, 1)
    assert.deepEqual(marks[0], { name: 'listener-bound', at: marks[0].at, boundPort: other.address().port, listening: true })
    assert.ok(Number.isFinite(marks[0].at))
  } finally {
    delete globalThis.__dshMobileBootAttribution
    await close(other)
    await close(owner)
  }
})

test('unmanaged invocation preserves upstream EADDRINUSE failure', async () => {
  const owner = createServer()
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve))
  const other = createServer()
  try {
    const attempt = bind(other, owner.address().port, {})
    await assert.rejects(attempt.promise, { code: 'EADDRINUSE' })
    assert.ok(owner.listening)
    assert.equal(other.listenerCount('listening'), 0)
  } finally { await close(other); await close(owner) }
})

test('retry is bounded to one bind(0), including simultaneous collision and other errors', async () => {
  class FakeServer extends EventEmitter {
    calls = []
    listen(port) { this.calls.push(port); queueMicrotask(() => this.emit('error', Object.assign(new Error(), { code: 'EADDRINUSE' }))) }
  }
  const server = new FakeServer()
  await assert.rejects(bind(server, 4145).promise, { code: 'EADDRINUSE' })
  assert.deepEqual(server.calls, [4145, 0])
  assert.equal(server.listenerCount('error'), 0)
  assert.equal(server.listenerCount('listening'), 0)
  const denied = new FakeServer()
  denied.listen = function(port) { this.calls.push(port); queueMicrotask(() => this.emit('error', Object.assign(new Error(), { code: 'EACCES' }))) }
  await assert.rejects(bind(denied, 4145).promise, { code: 'EACCES' })
  assert.deepEqual(denied.calls, [4145])
})

test('free/port-zero startup binds once and non-loopback listeners never auto-fallback', async () => {
  const free = createServer()
  try {
    const attempt = bind(free, 0)
    await attempt.promise
    assert.ok(attempt.instance.listenedPort > 0)
    assert.equal(attempt.env.DSH_ENGINE_PORT, String(attempt.instance.listenedPort))
  } finally { await close(free) }
  const server = new EventEmitter()
  let calls = 0
  server.listen = () => { calls++; queueMicrotask(() => server.emit('error', Object.assign(new Error(), { code: 'EADDRINUSE' }))) }
  await assert.rejects(bind(server, 4145, { DSH_MOBILE_MANAGED_ENGINE: '1' }, '0.0.0.0').promise)
  assert.equal(calls, 1)
})
