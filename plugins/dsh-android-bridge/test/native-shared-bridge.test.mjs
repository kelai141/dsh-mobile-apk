// Shared browser adapter contract. These are source-level tests with an injected
// NativeClient; they do not claim Android, Rust, or device verification.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createNativeSharedBridge,
  NATIVE_SHARED_BROWSER_OPS,
} from '../src/native-shared-bridge.ts'

const EPOCH = '18446744073709551615'

function harness({
  mode = 'danger-full-access',
  caps,
  executeResult,
  afterExecuteMode,
  afterExecuteThrows = false,
  policyThrowsAfterExecute = false,
} = {}) {
  const session = { id: 'shared-browser-session', marker: 'live' }
  const calls = []
  const client = {
    async capabilities() {
      calls.push({ method: 'capabilities' })
      if (caps !== undefined) return caps
      return {
        ok: true,
        executed: 'no',
        response: {
          protocolVersion: 1,
          ok: true,
          code: 'capabilities',
          executed: 'no',
          screenId: null,
          epoch: EPOCH,
          screens: [],
          channels: {
            a11y: { enabled: 'yes' },
            shizuku: { functionalReady: 'no' },
          },
        },
      }
    },
    async execute(request, rpc) {
      calls.push({ method: 'execute', request, rpc })
      if (afterExecuteThrows) throw new Error('permission read failed')
      if (afterExecuteMode !== undefined) mode = afterExecuteMode
      if (executeResult !== undefined) return executeResult
      return {
        ok: true,
        executed: 'yes',
        response: {
          protocolVersion: 1,
          ok: true,
          code: 'browser-result',
          executed: 'yes',
          screenId: null,
          callId: request.callId,
          data: { ok: true, url: 'https://example.test/' },
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => id === session.id ? session : undefined }
      if (name === 'sandboxPolicy') return { resolve: () => {
        if (policyThrowsAfterExecute && calls.some((call) => call.method === 'execute')) {
          throw new Error('policy backend unavailable')
        }
        return { mode }
      } }
      if (name === 'androidPrivilege') throw new Error('legacy bridge must not be read')
      return undefined
    },
  }
  const bridge = createNativeSharedBridge(ctx, { client })
  return { bridge, session, calls, mode: () => mode }
}

test('exact browser op list is forwarded and every non-browser op is rejected', async () => {
  assert.deepEqual(NATIVE_SHARED_BROWSER_OPS, [
    'browserCaps', 'browserShow', 'browserHide', 'browserClose', 'browserOpen', 'browserJs',
    'browserInput', 'browserShot', 'browserState', 'browserSetUa', 'browserViewport',
    'browserTabs', 'browserFollowTab', 'browserCloseTab',
  ])
  const h = harness()
  for (const op of ['click', 'snapshot', 'webAction', 'vdInfo', 'shExec', 'browser']) {
    assert.deepEqual(await h.bridge.controlExec(op, {}, undefined, { session: h.session }), {
      ok: false,
      error: 'Operation ' + op + ' is not a shared browser op; phone-control tools own non-browser operations.',
      code: 'operation-not-browser',
      executed: 'no',
    })
  }
  assert.deepEqual(h.calls, [])
})

test('sessionless shared panel can only read fixed browser capability metadata', async () => {
  const h = harness({ mode: 'workspace-write' })
  assert.equal((await h.bridge.controlExec('browserCaps', {})).ok, true)
  const request = h.calls.find(call => call.method === 'execute').request
  assert.equal(Object.hasOwn(request.args, 'session'), false)
  const calls = h.calls.length
  for (const operation of ['browserOpen', 'browserJs', 'browserInput', 'browserState', 'browserShot']) {
    assert.equal((await h.bridge.controlExec(operation, {})).ok, false)
  }
  assert.equal((await h.bridge.controlExec('browserCaps', { session: 'forged' })).ok, false)
  assert.equal(h.calls.length, calls)
})

test('trust requires the exact live session object and danger-full-access', async () => {
  const h = harness()
  const forged = { ...h.session }
  assert.equal((await h.bridge.controlExec('browserState', {}, undefined, { session: forged })).code,
    'session-permission-denied')
  // An id is resolved to the live object; it never means an unverified session.
  const byId = await h.bridge.controlExec('browserState', { session: h.session.id }, undefined)
  assert.equal(byId.ok, true)
  assert.equal(h.calls[1].request.args.session, h.session.id)
  const missing = harness()
  assert.equal((await missing.bridge.controlExec('browserState', { session: 'unknown-session' }, undefined)).code,
    'session-permission-denied')
  const limited = harness({ mode: 'workspace-write' })
  assert.equal((await limited.bridge.controlExec('browserState', {}, undefined, { session: limited.session })).code,
    'session-permission-denied')
  assert.deepEqual(limited.calls, [])
})

test('one execute reads capabilities and sends no screen, generation, or model session', async () => {
  const h = harness()
  const result = await h.bridge.controlExec('browserOpen', {
    url: 'https://example.test/',
    session: 'attacker-chosen',
    screenId: 'real',
    generation: '7',
    epoch: '7',
    callId: 'model-call-id',
  }, 20_000, { session: h.session })
  assert.deepEqual(result, { ok: true, data: { ok: true, url: 'https://example.test/' } })
  assert.equal(h.calls.length, 2)
  const sent = h.calls[1]
  assert.equal(sent.request.epoch, EPOCH)
  assert.equal(sent.request.operation, 'browserOpen')
  assert.equal(sent.request.timeoutMs, 20_000)
  assert.equal(sent.request.callId === 'model-call-id', false)
  assert.match(sent.request.callId, /^[0-9a-f-]+$/)
  assert.equal('screenId' in sent.request, false)
  assert.equal('generation' in sent.request, false)
  assert.deepEqual(sent.request.args, {
    url: 'https://example.test/',
    session: h.session.id,
  })
  assert.equal(sent.rpc.timeoutMs, 22_000)
})

test('capabilities failure rejects before dispatch and keeps executed=no', async () => {
  const h = harness({
    caps: { ok: false, executed: 'no', error: { code: 'connect-failed', message: 'socket missing' } },
  })
  assert.deepEqual(await h.bridge.controlExec('browserState', {}, undefined, { session: h.session }), {
    ok: false,
    error: 'socket missing',
    code: 'connect-failed',
    executed: 'no',
  })
  assert.equal(h.calls.length, 1)
})

test('invalid epoch and invalid timeout fail before execute', async () => {
  const badEpoch = harness({
    caps: {
      ok: true, executed: 'no',
      response: {
        protocolVersion: 1, ok: true, executed: 'no', screenId: null, epoch: '18446744073709551616',
      },
    },
  })
  assert.equal((await badEpoch.bridge.controlExec('browserState', {}, undefined, { session: badEpoch.session })).code,
    'native-facts-invalid')
  assert.equal(badEpoch.calls.length, 1)

  const h = harness()
  assert.equal((await h.bridge.controlExec('browserState', {}, 30_001, { session: h.session })).code, 'timeout-invalid')
  assert.equal((await h.bridge.controlExec('browserState', [], undefined, { session: h.session })).code, 'args-invalid')
  assert.deepEqual(h.calls, [])
})

test('transport failure is returned once without retry and preserves unknown', async () => {
  const h = harness({
    executeResult: {
      ok: false,
      executed: 'unknown',
      error: { kind: 'closed', code: 'connection-lost', message: 'connection closed' },
    },
  })
  assert.deepEqual(await h.bridge.controlExec('browserInput', { kind: 'tap', ref: 'bx1' }, undefined, { session: h.session }), {
    ok: false,
    error: 'connection closed',
    code: 'connection-lost',
    executed: 'unknown',
  })
  assert.equal(h.calls.filter((call) => call.method === 'execute').length, 1)
})

test('native rejection maps to error/code and keeps its executed value', async () => {
  const h = harness({
    executeResult: {
      ok: false,
      executed: 'yes',
      response: {
        protocolVersion: 1,
        ok: false,
        code: 'browser-session-closed',
        detail: 'the BrowserHost workspace was closed',
        executed: 'yes',
        screenId: null,
      },
    },
  })
  assert.deepEqual(await h.bridge.controlExec('browserTabs', {}, undefined, { session: h.session }), {
    ok: false,
    error: 'the BrowserHost workspace was closed',
    code: 'browser-session-closed',
    executed: 'yes',
  })
})

test('permission revocation after dispatch never reports executed=no', async () => {
  const revoked = harness({
    afterExecuteMode: 'workspace-write',
    executeResult: {
      ok: true,
      executed: 'yes',
      response: {
        protocolVersion: 1, ok: true, code: 'browser-result', executed: 'yes', screenId: null,
        data: { ok: true },
      },
    },
  })
  const result = await revoked.bridge.controlExec('browserShow', {}, undefined, { session: revoked.session })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session-permission-revoked')
  assert.equal(result.executed, 'yes')
})

test('synchronous status never invents a tier and marks the async migration', () => {
  const h = harness()
  assert.deepEqual(h.bridge.status(), {
    tier: 'unknown',
    tierSource: 'sync-face',
    needsAsyncMigration: true,
    capabilitiesRead: false,
    guidance: 'The synchronous status face cannot read asynchronous native capabilities. Use statusAsync before displaying a tier.',
  })
})

test('async status reflects published capabilities and keeps unknown unknown', async () => {
  const yes = harness()
  assert.deepEqual(await yes.bridge.statusAsync({ session: yes.session }), {
    tier: 'T1', tierSource: 'native-capabilities', needsAsyncMigration: false, capabilitiesRead: true,
  })

  const no = harness({
    caps: {
      ok: true, executed: 'no',
      response: {
        protocolVersion: 1, ok: true, executed: 'no', screenId: null, epoch: EPOCH,
        channels: { a11y: { enabled: 'no' }, shizuku: { functionalReady: 'no' } },
      },
    },
  })
  assert.equal((await no.bridge.statusAsync({ session: no.session })).tier, 'T0')

  const unknown = harness({
    caps: {
      ok: true, executed: 'no',
      response: {
        protocolVersion: 1, ok: true, executed: 'no', screenId: null, epoch: EPOCH,
        channels: { a11y: { enabled: 'unknown' }, shizuku: { functionalReady: 'no' } },
      },
    },
  })
  assert.equal((await unknown.bridge.statusAsync({ session: unknown.session })).tier, 'unknown')
})

test('a failed permission re-read after dispatch keeps executed=yes and does not claim denial', async () => {
  const h = harness({
    policyThrowsAfterExecute: true,
    executeResult: {
      ok: true,
      executed: 'yes',
      response: {
        protocolVersion: 1, ok: true, code: 'browser-result', executed: 'yes', screenId: null,
        data: { ok: true, visible: true },
      },
    },
  })
  const result = await h.bridge.controlExec('browserHide', {}, undefined, { session: h.session })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session-permission-unverified')
  assert.equal(result.executed, 'yes', 'a completed native action must never be downgraded to executed=no')
})
