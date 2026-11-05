import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../app/src/main/assets/console.html', import.meta.url), 'utf8')
const start = html.indexOf('  var consoleBottomInset =')
const end = html.indexOf("  window.addEventListener('resize', updateConsoleLayout);", start)
assert.ok(start >= 0 && end > start, 'The production layout update must remain discoverable')
const layout = html.slice(start, end + "  window.addEventListener('resize', updateConsoleLayout);".length)

function page(height) {
  const properties = new Map()
  const attributes = new Map()
  const listeners = new Map()
  const root = {
    style: { setProperty: (name, value) => properties.set(name, value) },
    toggleAttribute: (name, value) => attributes.set(name, value),
  }
  const window = { innerHeight: height, addEventListener: (name, callback) => listeners.set(name, callback) }
  vm.runInNewContext(layout, { document: { documentElement: root }, window })
  return { window, properties, attributes, listeners }
}

for (const scenario of [
  { name: 'portrait keyboard', height: 800, nav: 24, ime: 308, overlap: '284px', compact: false },
  { name: 'landscape keyboard', height: 450, nav: 24, ime: 261, overlap: '237px', compact: true },
  { name: 'already resized portrait', height: 492, nav: 24, ime: 0, overlap: '0px', compact: false },
  { name: 'already resized landscape', height: 189, nav: 24, ime: 0, overlap: '0px', compact: true },
  { name: 'no navigation inset', height: 450, nav: 0, ime: 261, overlap: '261px', compact: true },
]) {
  test(scenario.name + ' reserves each occluded pixel once', () => {
    const state = page(scenario.height)
    state.window.__consoleInsets(28, scenario.nav, scenario.ime)
    assert.equal(state.properties.get('--ime-occlusion'), scenario.overlap)
    assert.equal(state.properties.get('--inset-bottom'), scenario.nav + 'px')
    assert.equal(state.attributes.get('data-console-compact'), scenario.compact)
  })
}

test('closing the keyboard restores the regular layout', () => {
  const state = page(450)
  state.window.__consoleInsets(28, 24, 261)
  state.window.__consoleInsets(28, 24, 0)
  assert.equal(state.properties.get('--ime-occlusion'), '0px')
  assert.equal(state.attributes.get('data-console-compact'), false)
})

test('viewport resizing recalculates compact mode at its boundary', () => {
  const state = page(344)
  state.window.__consoleInsets(0, 24, 0)
  assert.equal(state.attributes.get('data-console-compact'), false)
  state.window.innerHeight = 343
  state.listeners.get('resize')()
  assert.equal(state.attributes.get('data-console-compact'), true)
})

test('negative native insets cannot create negative padding', () => {
  const state = page(450)
  state.window.__consoleInsets(0, -24, -100)
  assert.equal(state.properties.get('--inset-bottom'), '0px')
  assert.equal(state.properties.get('--ime-occlusion'), '0px')
})
