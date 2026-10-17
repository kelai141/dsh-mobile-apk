/** Exercise the injected owner operation against the exact current published artifact. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Script } from 'node:vm'
import { FIXTURE_ENGINE, FIXTURES_DIR, versionedFixture } from './lib/fixture.mjs'
import { SIDEBAR_REORDER_MARKER, hasSidebarReorder, patchSidebarReorder } from '../data/sidebar-bubble-reorder.mjs'
const source = readFileSync(versionedFixture('dsh-client-ui-sidebar-right', 'lib', 'client.js'), 'utf8')
const patched = patchSidebarReorder(source)
const method = patched.match(/\n[\t ]*reorderIn\(sessionId, tabId, beforeId\) \{[\s\S]+?\n\t\t\t\}/)?.[0]
assert.ok(method, 'the patched artifact contains the owner operation')
const Controller = new Function('return class Controller {' + method + '\n}')()
function fixture(Owner = Controller) {
  const controller = new Owner()
  let mounted = 's'
  const tabs = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, { id, contentId: id, draft: 'draft-' + id }]))
  const p = { id: 'p', kind: 'pane', host: 'dock', tabs: ['a', 'b', 'c'], activeTabId: 'b' }
  const q = { id: 'q', kind: 'pane', host: 'dock', tabs: ['d'], activeTabId: 'd' }
  const layout = { expanded: true, tabs, nodes: { p, q }, activePaneId: 'p' }
  const calls = []
  const actions = {
    placeTab(session, tab, paneId, index) {
      calls.push(['place', session, tab, paneId, index])
      const pane = layout.nodes[paneId], at = pane.tabs.indexOf(tab)
      pane.tabs.splice(at, 1); pane.tabs.splice(index > at ? index - 1 : index, 0, tab)
      pane.activeTabId = tab; layout.activePaneId = paneId
    },
    focusTab(session, tab) {
      calls.push(['focus', session, tab])
      const pane = Object.values(layout.nodes).find(node => node.tabs.includes(tab))
      pane.activeTabId = tab; layout.activePaneId = pane.id
    },
  }
  controller.mounted = { getSnapshot: () => mounted }
  controller.adopted = new Map([['s', { store: { actions, getSnapshot: () => ({ bySession: { s: { layout } } }) } }]])
  return { controller, layout, p, q, tabs, calls, setMounted: value => { mounted = value } }
}
test('B1 patches one current artifact, parses, remains idempotent and rejects damaged anchors', () => {
  assert.ok(hasSidebarReorder(patched))
  assert.equal(patchSidebarReorder(patched), patched)
  new Script(patched)
  assert.throws(() => patchSidebarReorder(source.replaceAll('actions.focusTab(sessionId, tabId);', 'actions.changedFocus(sessionId, tabId);')), /expected one/)
  assert.throws(() => patchSidebarReorder(patched.replace('store.actions.placeTab(sessionId, tabId, pane.id, index);', 'store.actions.placeTab(sessionId, tabId, pane.id, 0);')), /incompatible existing/)
  assert.equal(patched.split(SIDEBAR_REORDER_MARKER).length - 1, 1)
})
test('reordering commits native placement and preserves the current page and every resource record', () => {
  const f = fixture(), a = f.tabs.a, b = f.tabs.b
  assert.equal(f.controller.reorderIn('s', 'a', undefined), true)
  assert.deepEqual(f.p.tabs, ['b', 'c', 'a'])
  assert.equal(f.p.activeTabId, 'b')
  assert.equal(f.layout.activePaneId, 'p')
  assert.equal(f.tabs.a, a); assert.equal(f.tabs.b, b); assert.equal(f.tabs.a.draft, 'draft-a')
  assert.deepEqual(f.calls, [['place', 's', 'a', 'p', 3], ['focus', 's', 'b']])
})
test('moving before a neighbor uses the existing strip insertion index', () => {
  const f = fixture()
  assert.equal(f.controller.reorderIn('s', 'c', 'a'), true)
  assert.deepEqual(f.p.tabs, ['c', 'a', 'b'])
  assert.equal(f.p.activeTabId, 'b')
})
test('a reorder retains the active pane when it is another pane', () => {
  const f = fixture(); f.layout.activePaneId = 'q'
  assert.equal(f.controller.reorderIn('s', 'c', 'a'), true)
  assert.equal(f.layout.activePaneId, 'q'); assert.equal(f.q.activeTabId, 'd')
})
test('stale sessions, missing tabs, cross-pane targets, floats and collapsed panels never mutate', () => {
  for (const arrange of [f => f.setMounted('other'), f => { f.layout.expanded = false }, f => { f.p.host = 'float' }]) {
    const f = fixture(); arrange(f)
    assert.equal(f.controller.reorderIn('s', 'c', 'a'), false); assert.deepEqual(f.calls, [])
  }
  for (const [tab, before] of [['missing', 'a'], ['a', 'missing'], ['a', 'd'], ['a', 'a'], ['a', 'b'], ['c', undefined]]) {
    const f = fixture(); assert.equal(f.controller.reorderIn('s', tab, before), false); assert.deepEqual(f.calls, [])
  }
  const f = fixture(); f.controller.adopted.clear()
  assert.equal(f.controller.reorderIn('s', 'c', 'a'), false)
})

// Android 源码构建产物夹具这一路本轮缺席（0.14.8 / 引擎 0.2.1-rc.2）：该类夹具只能由源码链从同代
// Android 源码构建 --capture-only 捕获，本轮构建链只产出 npm 发布 tarball 链，无法凭空生成。
// manifest 的 $comment 已登记：0.2.0-rc.2 的两份源码构建夹具随引擎换代退役，待下次源码链运行后
// 按原格式补回 0.2.1-rc.2。这里显式 skip 并打印原因：既不让「夹具缺席」冒充被测行为判红，也不静默
// 删掉这条路；源码链把夹具补回后，本用例按 existsSync 自动恢复执行（断言体保持原样、不许削弱）。
const MOBILE_FIXTURE_DIR = `dsh-client-ui-sidebar-right-mobile-${FIXTURE_ENGINE}`
const MOBILE_FIXTURE_PATH = join(FIXTURES_DIR, MOBILE_FIXTURE_DIR, 'lib', 'client.js')
const mobileFixtureSkipReason = existsSync(MOBILE_FIXTURE_PATH) ? undefined
  : `Android 源码构建产物夹具缺席: ${MOBILE_FIXTURE_PATH}`
    + `；本轮无法生成，待源码链 --capture-only 从同代 Android 源码构建补回 ${MOBILE_FIXTURE_DIR} 后自动恢复`
if (mobileFixtureSkipReason !== undefined) console.log('SKIP  ' + mobileFixtureSkipReason)

test('the captured Android source build accepts exactly one anchor and commits the same native action',
  { skip: mobileFixtureSkipReason }, () => {
  const mobile = readFileSync(versionedFixture('dsh-client-ui-sidebar-right-mobile', 'lib', 'client.js'), 'utf8')
  const result = patchSidebarReorder(mobile)
  assert.ok(hasSidebarReorder(result)); assert.equal(patchSidebarReorder(result), result)
  new Script(result)
  const member = result.match(/\n([\t ]*)reorderIn\(sessionId, tabId, beforeId\) \{[\s\S]+?\n\1\}/)?.[0]
  assert.ok(member)
  const Owner = new Function('return class Controller {' + member + '\n}')()
  const f = fixture(Owner)
  assert.equal(f.controller.reorderIn('s', 'c', 'a'), true)
  assert.deepEqual(f.p.tabs, ['c', 'a', 'b']); assert.equal(f.p.activeTabId, 'b')
  assert.throws(() => patchSidebarReorder(mobile.replaceAll('actions.focusTab(sessionId, tabId2);', 'actions.changedFocus(sessionId, tabId2);')), /expected one/)
})

test('B1 runs through the registered engine runner and rejects unknown bytes without writing', () => {
  const stage = mkdtempSync(join(tmpdir(), 'sidebar-reorder-'))
  const target = join(stage, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js')
  const runner = fileURLToPath(new URL('../apply-patches.mjs', import.meta.url))
  const run = mode => spawnSync(process.execPath, [runner, stage, mode, '--scope', 'engine', '--only', 'sidebar-bubble-reorder-B1'], { encoding: 'utf8' })
  try {
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source)
    let result = run('--apply')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(readFileSync(target, 'utf8'), patched)
    assert.equal(run('--check').status, 0)
    assert.equal(run('--apply').status, 0)
    assert.equal(readFileSync(target, 'utf8'), patched)
    const damaged = source.replaceAll('actions.focusTab(sessionId, tabId);', 'actions.unknown(sessionId, tabId);')
    writeFileSync(target, damaged); result = run('--apply')
    assert.notEqual(result.status, 0, 'unknown input must fail the actual runner')
    assert.equal(readFileSync(target, 'utf8'), damaged, 'failed patch cannot write a partial method')
  } finally { rmSync(stage, { recursive: true, force: true }) }
})
