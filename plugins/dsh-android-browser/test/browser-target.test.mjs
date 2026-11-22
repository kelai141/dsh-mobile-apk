// Source regression fixtures only in this change. Run against rebuilt lib later, not stale artifacts.
// Real tool execute() paths + an adversarial control face; not Android/provider/runtime evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserTools, resetBrowserMemory } from '../lib/tools.js'
import { BROWSER_OPS, BROWSER_TOOLS } from '../lib/contract.js'

const exec = (session) => ({ agent: { session } })
const page = (tabId, url, pageGeneration = 1) => ({ tabId, url, pageGeneration, title: tabId, loadState: 'loaded', reason: '' })

function harness(handler) {
  resetBrowserMemory()
  const calls = []
  const face = {
    controlExec: async (op, args) => {
      calls.push({ op, args })
      return { ok: true, data: await handler(op, args) }
    },
  }
  const tools = browserTools(() => face)
  const tool = (name) => { const found = tools.find((t) => t.name === name); assert.ok(found, name); return found }
  return { calls, tool }
}

function atomicHost() {
  const old = { ...page('old-tab', 'https://example.com/form'), identity: 'android-real', viewport: 'device', replayCount: 0 }
  const tabs = new Map([[old.tabId, old]])
  let selected = old
  const h = harness((op, args) => {
    // Deliberately model the old hazardous setters: a pre-open call changes/replays the old form.
    if (op === BROWSER_OPS.viewport || op === BROWSER_OPS.setUa) { selected.replayCount++; return { ok: true } }
    if (op === BROWSER_OPS.state) return page('foreign-tab', 'https://foreign.example/', 999)
    assert.equal(op, BROWSER_OPS.open)
    const id = args.tabId ?? 'new-tab'
    const target = tabs.get(id) ?? { ...page(id, args.url), identity: 'android-real', viewport: 'device', replayCount: 0 }
    if (args.viewportConfig) target.viewport = args.viewportConfig.preset
    if (args.identityConfig) target.identity = args.identityConfig.profile
    target.url = args.url
    target.pageGeneration++
    tabs.set(id, target)
    selected = target
    return { ...target }
  })
  return { ...h, old, tabs }
}

test('open sends both options in one captured new-tab payload; old form and readback remain untouched', async () => {
  const { tool, calls, old, tabs } = atomicHost()
  const value = await tool(BROWSER_TOOLS.open).execute({ url: 'https://example.com/new', viewport: 'desktop-720', identity: 'linux-desktop' }, exec('A'))
  assert.equal(value.ok, true)
  assert.deepEqual(calls.map((c) => c.op), [BROWSER_OPS.open], 'no pre-setter, replay or global active-page poll')
  const args = calls[0].args
  assert.equal(args.session, 'A')
  assert.equal(args.newTab, true)
  assert.equal(args.viewportConfig.preset, 'desktop-720')
  assert.equal(args.viewportConfig.width, 1280)
  assert.equal(args.viewportConfig.height, 720)
  assert.equal(args.identityConfig.profile, 'linux-desktop')
  assert.equal(value.tabId, 'new-tab')
  assert.equal(value.url, 'https://example.com/new')
  assert.equal(value.pageGeneration, 2)
  assert.equal(tabs.get('new-tab').identity, 'linux-desktop')
  assert.equal(old.identity, 'android-real')
  assert.equal(old.viewport, 'device')
  assert.equal(old.replayCount, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(args)), args, 'private payload is lossless JSON')
  assert.deepEqual(Object.keys(tool(BROWSER_TOOLS.open).parameters.properties ?? tool(BROWSER_TOOLS.open).parameters).sort(), ['identity', 'tabId', 'url', 'viewport'])
})

test('invalid second option is rejected before any browser-side effect; invalid first option likewise', async () => {
  const { tool, calls, old } = atomicHost()
  const open = tool(BROWSER_TOOLS.open)
  assert.equal((await open.execute({ url: 'https://example.com/', viewport: 'desktop-720', identity: 'unknown' }, exec('A'))).error, 'unknown-identity')
  assert.equal((await open.execute({ url: 'https://example.com/', viewport: 'unknown', identity: 'linux-desktop' }, exec('A'))).error, 'unknown-viewport')
  assert.equal(calls.length, 0)
  assert.equal(old.replayCount, 0)
})

test('named existing target and follow-screen alias stay atomic without loading the old URL first', async () => {
  const { tool, calls, old } = atomicHost()
  const value = await tool(BROWSER_TOOLS.open).execute({ url: 'https://example.com/replacement', tabId: 'old-tab', viewport: 'follow-screen', identity: 'windows-desktop' }, exec('A'))
  assert.equal(value.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.tabId, 'old-tab')
  assert.ok(!Object.hasOwn(calls[0].args, 'newTab'))
  assert.deepEqual(calls[0].args.viewportConfig, { preset: 'device', route: 'S2', width: 0, height: 0 })
  assert.equal(old.url, 'https://example.com/replacement')
  assert.equal(old.identity, 'windows-desktop')
  assert.equal(old.replayCount, 0)
})

test('interleaved sessions keep snapshot tab/generation; opening B cannot erase A or lend refs to C', async () => {
  let releaseA
  let startedA
  const aStarted = new Promise((resolve) => { startedA = resolve })
  const aGate = new Promise((resolve) => { releaseA = resolve })
  const pages = { A: page('A-tab', 'https://a.example/', 7), B: page('B-tab', 'https://b.example/', 23) }
  const { tool, calls } = harness(async (op, args) => {
    const own = pages[args.session]
    if (op === BROWSER_OPS.js && args.snapshot) {
      if (args.session === 'A') { startedA(); await aGate }
      return { ...own, nodes: [{ ref: 'bx1', role: 'button', name: args.session }], viewport: {}, truncated: false }
    }
    if (op === BROWSER_OPS.input || op === BROWSER_OPS.state) {
      assert.equal(args.tabId, own.tabId, 'must address the snapshot tab, not current UI focus')
      if (op === BROWSER_OPS.input) assert.equal(args.pageGeneration, own.pageGeneration)
      return { ...own, changed: false, value: 'typed' }
    }
    if (op === BROWSER_OPS.open) return page('B-new', args.url, 24)
    throw new Error('unexpected operation ' + op)
  })
  const pendingA = tool(BROWSER_TOOLS.snapshot).execute({}, exec('A'))
  await aStarted
  await tool(BROWSER_TOOLS.snapshot).execute({}, exec('B'))
  releaseA()
  await pendingA
  await Promise.all([
    tool(BROWSER_TOOLS.click).execute({ ref: 'bx1' }, exec('A')),
    tool(BROWSER_TOOLS.type).execute({ ref: 'bx1', text: 'typed' }, exec('B')),
  ])
  await tool(BROWSER_TOOLS.open).execute({ url: 'https://b.example/new' }, exec('B'))
  assert.equal((await tool(BROWSER_TOOLS.click).execute({ ref: 'bx1' }, exec('A'))).ok, true)
  const before = calls.length
  assert.equal((await tool(BROWSER_TOOLS.click).execute({ ref: 'bx1' }, exec('B'))).error, 'snapshot-required')
  assert.equal((await tool(BROWSER_TOOLS.click).execute({ ref: 'bx1' }, exec('C'))).error, 'snapshot-required')
  assert.equal(calls.length, before, 'missing own snapshot cannot borrow another session ref')
})

test('native stale-own-ref rejection is surfaced without retrying a foreign active tab', async () => {
  const { tool, calls } = harness((op) => op === BROWSER_OPS.js
    ? { ...page('A-tab', 'https://a.example/', 7), nodes: [{ ref: 'bx1' }] }
    : { ok: false, reason: 'stale-page-generation' })
  await tool(BROWSER_TOOLS.snapshot).execute({}, exec('A'))
  const value = await tool(BROWSER_TOOLS.click).execute({ ref: 'bx1' }, exec('A'))
  assert.equal(value.error, 'stale-page-generation')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].args.tabId, 'A-tab')
  assert.equal(calls[1].args.session, 'A')
})

test('mounts a missing surface once and never replays timed-out input', async () => {
  let mounted = false
  const target = page('tab-1', 'https://example.com/')
  const { tool, calls } = harness((op) => {
    if (op === BROWSER_OPS.js) return mounted
      ? { ...target, nodes: [{ ref: 'bx1' }] }
      : { ok: false, reason: 'browser-not-created' }
    if (op === BROWSER_OPS.show) { mounted = true; return { ok: true, created: true } }
    assert.equal(op, BROWSER_OPS.input)
    return { ok: false, reason: 'browser-js-reply-timeout', guidance: 'Check state before retrying input.' }
  })
  assert.equal((await tool(BROWSER_TOOLS.snapshot).execute({}, exec('A'))).ok, true)
  assert.equal((await tool(BROWSER_TOOLS.click).execute({ ref: 'bx9' }, exec('A'))).error, 'stale-ref')
  const input = await tool(BROWSER_TOOLS.click).execute({ ref: 'bx1' }, exec('A'))
  assert.equal(input.error, 'browser-js-reply-timeout')
  assert.equal(input.guidance, 'Check state before retrying input.')
  assert.deepEqual(calls.map(({ op }) => op), [BROWSER_OPS.js, BROWSER_OPS.show, BROWSER_OPS.js, BROWSER_OPS.input])
})
