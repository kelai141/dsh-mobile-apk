import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createLinuxTerminal, parseTerminalRequest } from '../lib/linux-terminal.js'

function harness() {
  const children = new Set()
  const gate = { managementPending: false, acquireShared: async () => {}, releaseShared() {} }
  const changes = []
  const manager = {
    dataDir: '/runtime',
    children, gate,
    processScope: { environment: env => ({ ...env, BIONILUX_PROCESS_SCOPE: 'scope' }) },
    _ensureStartupRecovery: async () => {},
    _verifyLocked: async () => ({ healthy: true, paths: { launcher: '/runtime/bionilux' } }),
    _executionEnvironment: (_paths, { guestCwd }) => ({ BIONILUX_GUEST_CWD: guestCwd }),
    _sessionLaunch: ({ launcher }) => ({ file: '/system/bin/linker64', args: [launcher, '/bin/bash', '--norc', '-s'] }),
  }
  const output = new PassThrough()
  const terminal = createLinuxTerminal({
    runtime: () => manager,
    spawn: async spec => {
      changes.push(spec)
      const { promise: done, resolve } = Promise.withResolvers()
      return {
        output, done,
        async write(value) { output.write(value) },
        async resize(cols, rows) { changes.push({ cols, rows }) },
        async terminate() { output.end(); resolve({ exitCode: null, signal: 'SIGTERM' }) },
      }
    },
  })
  return { terminal, output, changes, children, gate }
}

test('concurrent opens and later attachments share one interactive PTY and output cursor', async () => {
  const { terminal, changes, children } = harness()
  const opening = { action: 'open', rows: 24, cols: 80 }
  const [first, parallel] = await Promise.all([terminal.request(opening), terminal.request(opening)])
  assert.equal(first.id, parallel.id)
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0].argv, ['/system/bin/linker64', '/runtime/bionilux', '/bin/bash', '--norc', '-i'])
  assert.equal(changes[0].env.BIONILUX_PROCESS_SCOPE, 'scope')
  await terminal.request({ action: 'write', id: first.id, data: 'test\x03' })
  const attached = await terminal.request(opening)
  assert.equal(attached.id, first.id)
  assert.equal(attached.output, 'test\x03')
  assert.equal((await terminal.request({ action: 'read', id: first.id, after: attached.next })).output, '')
  await terminal.request({ action: 'resize', id: first.id, cols: 60, rows: 16 })
  assert.deepEqual(changes[1], { cols: 60, rows: 16 })
  const [child] = children
  child.abort()
  await child.promise
  assert.equal(children.size, 0)
  assert.equal((await terminal.request(opening)).running, false)
})

test('invalid actions and stale terminals are refused, and cutover blocks PTY creation', async () => {
  const { terminal, gate, changes } = harness()
  assert.throws(() => parseTerminalRequest({ action: 'open', rows: '24', cols: -1 }), { status: 400 })
  await assert.rejects(terminal.request({ action: 'write', id: 'stale', data: 'exit\r' }), { status: 409 })
  gate.managementPending = true
  await assert.rejects(terminal.request({ action: 'open', rows: 24, cols: 80 }), { status: 409 })
  assert.equal(changes.length, 0)
})
