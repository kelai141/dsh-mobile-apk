import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CASES, makeCdp, runCase, selectEngineTarget } from './verify-state-sync.mjs'

const bool = value => ({ result: { result: { type: 'boolean', value } } })
const missing = { result: { result: { type: 'undefined' } } }
function harness(answer, { delayedClose = true, factory = makeCdp } = {}) {
  const sockets = [], resolved = []
  class Socket {
    constructor(url) { this.url = url; this.index = sockets.length; this.sends = 0; sockets.push(this); queueMicrotask(() => this.onopen?.()) }
    send(raw) {
      const { id } = JSON.parse(raw)
      this.sends++
      this.lastId = id
      const reply = answer(this.index, this.sends)
      if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...reply }) }))
    }
    close() { this.closed = true; if (!delayedClose) this.fireClose() }
    fireClose() { this.onclose?.() }
  }
  const page = factory(force => { resolved.push(force); return 'ws://mock/' + resolved.length }, { WebSocketImpl: Socket })
  return { page, sockets, resolved }
}
const expression = 'window.androidBridge?.hasAllFilesAccess?.()'
const options = { readOnlyBoolean: true }

test('undefined from a live old target re-resolves once; new target false is valid', async () => {
  const h = harness(index => index === 0 ? missing : bool(false))
  try {
    assert.equal(await h.page.evaluate(expression, options), false)
    assert.deepEqual(h.resolved, [false, true])
    assert.equal(h.sockets[0].closed, true)
    assert.equal(h.page.diagnostic().kind, 'bridge-not-ready')
  } finally { h.page.close() }
})

test('legitimate false passes ST-01 off in one observation without reconnect', async () => {
  const h = harness(() => bool(false))
  try {
    const r = await runCase(CASES[0], { adb: () => ({ status: 0 }), page: h.page }, false)
    assert.equal(r.ok, true)
    assert.equal(h.resolved.length, 1)
    assert.equal(h.sockets[0].sends, 1)
  } finally { h.page.close() }
})

test('getter permanently absent fails at original runCase budget; never coerces undefined to false', async () => {
  const h = harness(() => missing)
  let now = 0
  try {
    const r = await runCase(CASES[0], { adb: () => ({ status: 0 }), page: h.page, now: () => now, pause: async ms => { now += ms } }, false)
    assert.equal(r.ok, false)
    assert.equal(r.ms, CASES[0].convergeMs + 7000)
    assert.match(r.detail, /undefined/)
    assert.equal(r.diagnostic.kind, 'bridge-not-ready')
    assert.ok(h.resolved.length > 1)
  } finally { h.page.close() }
})

test('destroyed execution context reconnects with diagnostic; security/real getter errors remain errors', async () => {
  const h = harness(index => index === 0 ? { result: { exceptionDetails: { text: 'Execution context was destroyed.' } } } : bool(false))
  try {
    assert.equal(await h.page.evaluate(expression, options), false)
    assert.equal(h.resolved.length, 2)
    assert.match(h.page.diagnostic().detail, /Execution context was destroyed/)
  } finally { h.page.close() }
  const refused = harness(() => ({ result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'SecurityException: untrusted frame' } } } }))
  try {
    await assert.rejects(refused.page.evaluate(expression, options), /SecurityException.*untrusted frame/)
    assert.equal(refused.resolved.length, 1)
    assert.equal(refused.page.diagnostic().kind, 'javascript-exception')
  } finally { refused.page.close() }
})

test('late close from superseded socket cannot clear new socket or new pending', async () => {
  const h = harness(index => index === 0 ? missing : bool(false))
  try {
    assert.equal(await h.page.evaluate(expression, options), false)
    h.sockets[0].fireClose()
    assert.equal(await h.page.evaluate(expression, options), false)
    assert.equal(h.resolved.length, 2)
    assert.equal(h.sockets[1].sends, 2)
  } finally { h.page.close() }
})

test('target selection is exact engine origin/root; never list[0], non-engine or ambiguous', () => {
  const list = [
    { type: 'page', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://wrong' },
    { type: 'page', url: 'http://127.0.0.1:4145/console', webSocketDebuggerUrl: 'ws://console' },
    { type: 'page', url: 'http://127.0.0.1:4146/', webSocketDebuggerUrl: 'ws://other' },
    { type: 'page', url: 'http://127.0.0.1:4145/?token=secret', webSocketDebuggerUrl: 'ws://engine' },
  ]
  assert.equal(selectEngineTarget(list, 'http://127.0.0.1:4145'), 'ws://engine')
  assert.throws(() => selectEngineTarget(list.slice(0, 3), 'http://127.0.0.1:4145'), /not ready/)
  assert.throws(() => selectEngineTarget([...list, list[3]], 'http://127.0.0.1:4145'), /ambiguous/)
  assert.throws(() => selectEngineTarget(list, 'http://evil.test:4145'), /Invalid engine origin/)
})

test('stalled target resolver is bounded by caller budget, not a new extended deadline', async () => {
  const scheduled = []
  let clock = 0
  const page = makeCdp(() => new Promise(() => {}), { now: () => clock, setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length }, clearTimer: () => {} })
  try {
    const pending = page.evaluate(expression, { readOnlyBoolean: true, timeoutMs: 20 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].ms, 20)
    clock = 20
    scheduled[0].fn()
    assert.equal(await pending, undefined)
    assert.match(page.diagnostic().detail, /connection timeout/)
    assert.doesNotMatch(page.diagnostic().detail, /superseded/)
    assert.equal(scheduled.length, 1) // caller budget exhausted; no new window.
  } finally { page.close() }
})

test('controlled negative: removing Boolean-readiness check reintroduces undefined failure', async () => {
  const source = readFileSync(new URL('./verify-state-sync.mjs', import.meta.url), 'utf8')
  const needle = "(!readOnlyBoolean || typeof result.value === 'boolean')"
  assert.equal(source.split(needle).length - 1, 1)
  const mutant = source.replace(needle, 'true')
  const legacyModule = await import('data:text/javascript;base64,' + Buffer.from(mutant).toString('base64'))
  const broken = harness(index => index === 0 ? missing : bool(false), { factory: legacyModule.makeCdp })
  try {
    assert.equal(await broken.page.evaluate(expression, options), undefined)
    assert.equal(broken.resolved.length, 1)
  } finally { broken.page.close() }
  const repaired = harness(index => index === 0 ? missing : bool(false))
  try {
    assert.equal(await repaired.page.evaluate(expression, options), false)
    assert.equal(repaired.resolved.length, 2)
  } finally { repaired.page.close() }
})

test('old socket close cannot settle the replacement connection pending request', async () => {
  const h = harness((index, send) => index === 0 ? missing : send === 1 ? bool(false) : null)
  try {
    assert.equal(await h.page.evaluate(expression, options), false)
    const waiting = h.page.evaluate(expression, options)
    await new Promise(resolve => setImmediate(resolve))
    h.sockets[0].fireClose()
    h.sockets[1].onmessage({ data: JSON.stringify({ id: h.sockets[1].lastId, ...bool(false) }) })
    assert.equal(await waiting, false)
    assert.equal(h.resolved.length, 2)
  } finally { h.page.close() }
})

test('first socket connect error retries the fresh target inside the same budget', async () => {
  let connections = 0
  const forced = []
  class Socket {
    constructor() { const index = connections++; queueMicrotask(() => index === 0 ? this.onerror?.() : this.onopen?.()) }
    send(raw) { const { id } = JSON.parse(raw); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...bool(false) }) })) }
    close() { this.onclose?.() }
  }
  const page = makeCdp(force => { forced.push(force); return 'ws://mock/' + connections }, { WebSocketImpl: Socket })
  try {
    assert.equal(await page.evaluate(expression, options), false)
    assert.equal(connections, 2)
    assert.deepEqual(forced, [false, true])
    assert.match(page.diagnostic().detail, /CDP 连接失败/)
  } finally { page.close() }
})

test('missing engine target remains a failed observation within original budget', async () => {
  let clock = 0, resolves = 0
  const page = makeCdp(() => { resolves++; throw new Error('Engine main WebView target not ready or ambiguous (matches=0)') })
  try {
    const result = await runCase(CASES[0], { adb: () => ({ status: 0 }), page, now: () => clock, pause: async ms => { clock += ms } }, false)
    assert.equal(result.ok, false)
    assert.equal(result.ms, CASES[0].convergeMs + 7000)
    assert.match(result.diagnostic.detail, /matches=0/)
    assert.ok(resolves > 1)
  } finally { page.close() }
})

