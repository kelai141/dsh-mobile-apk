#!/usr/bin/env node
// Read a real workspace fixture through Better Sidebar. CDP observes; adb taps.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values: { serial, out } } = parseArgs({ options: {
  serial: { type: 'string' }, out: { type: 'string' },
} })
assert.ok(serial && out, 'Usage: --serial <isolated-debug-device> --out <directory>')
const output = resolve(out)
const pkg = 'com.dsharnessmobile.shell'
const name = 'dsh-sidecar-fixture-20261108.txt'
const content = 'dsh sidebar verification marker 20261108'
const adb = (args, encoding = 'utf8') => execFileSync('adb', ['-s', serial, ...args], {
  encoding, timeout: 15000, maxBuffer: 10 * 1024 * 1024,
})

const pid = adb(['shell', 'pidof', pkg]).trim().split(/\s+/)[0]
assert.match(pid, /^\d+$/)
const port = adb(['forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid]).trim()
assert.match(port, /^\d+$/)
let socket
let sequence = 0

async function until(fn, label, ms = 12000) {
  const end = Date.now() + ms
  do {
    const value = await fn()
    if (value) return value
    await delay(350)
  } while (Date.now() < end)
  throw new Error(label)
}

function evaluate(fn, ...args) {
  const id = ++sequence
  const expression = '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')'
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', receive)
      reject(new Error('CDP evaluation timed out'))
    }, 8000)
    const receive = ({ data }) => {
      const msg = JSON.parse(data)
      if (msg.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', receive)
      if (msg.error || msg.result.exceptionDetails) reject(new Error('CDP evaluation failed'))
      else resolveValue(msg.result.result.value)
    }
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({
      id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
    }))
  })
}

function point(selector, label, fileName) {
  for (const e of document.querySelectorAll(selector)) {
    const name = e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.innerText
    if (label && name?.trim() !== label) continue
    if (fileName && e.textContent.trim() !== fileName) continue
    const r = e.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (!r.width || !r.height || !e.contains(document.elementFromPoint(x, y))) continue
    const scale = devicePixelRatio * visualViewport.scale
    return [Math.round(x * scale), Math.round(y * scale)]
  }
  return null
}

function tap(p) {
  adb(['shell', 'input', 'tap', ...p.map(String)])
}

function screenshot(name) {
  writeFileSync(join(output, name), adb(['exec-out', 'screencap', '-p'], null))
}

try {
  const url = await until(async () => {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2500) })
      const items = await r.json()
      return items.find(x => x.type === 'page'
        && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(x.url))?.webSocketDebuggerUrl
    } catch { return null }
  }, 'Application WebView not ready', 90000)
  socket = new WebSocket(url)
  await until(() => socket.readyState === WebSocket.OPEN, 'CDP socket not ready')
  const entry = await until(() => evaluate(() => {
    const entries = window.__DSH_BOOT__?.entries ?? []
    return entries.find(e => ['dsh-better-sidebar', 'better-sidebar'].includes(e.id)
      && JSON.stringify(e).includes('dsh-better-sidebar'))?.id
  }), 'Better Sidebar client entry not loaded')
  const steps = []
  const fileTree = () => evaluate(point, '[data-dsh-panel-host] button', 'Upload files')
  const refresh = () => evaluate(point, '[data-dsh-panel-host] button', 'Refresh')
  const readEditor = () => evaluate((file, expected) => {
    const title = [...document.querySelectorAll('input')].some(e => e.value === file)
    const body = [...document.querySelectorAll('.cm-content')].some(e => {
      const r = e.getBoundingClientRect()
      return r.height > 0 && e.textContent.trim() === expected
        && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
    return title && body
  }, name, content)
  await until(fileTree, 'Open the Files panel in the test workspace before running')
  assert.equal(await readEditor(), false, 'Close the existing fixture editor before the test')
  const refreshPoint = await until(refresh, 'Files panel not visible')
  tap(refreshPoint)
  steps.push('refresh-real-tree')
  const fixturePoint = await until(() => evaluate(point, '[data-dsh-panel-host] span', null, name),
    'Fixture missing from the visible workspace tree')
  mkdirSync(output, { recursive: true })
  screenshot('file-tree.png')
  tap(fixturePoint)
  steps.push('open-fixture')
  const editor = await until(readEditor, 'Editor did not display the exact fixture body', 20000)
  // CDP can see the new tree before Android composites the WebView's next frame.
  await delay(700)
  assert.equal(await readEditor(), true, 'Fixture editor did not remain visible')
  screenshot('file-content.png')
  const result = { entry, editor, steps, fixture: name, screenshots: ['file-tree.png', 'file-content.png'] }
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('BETTER SIDEBAR PASS: actual file listed and opened via Android input')
} finally {
  socket?.close()
  adb(['forward', '--remove', 'tcp:' + port])
}
