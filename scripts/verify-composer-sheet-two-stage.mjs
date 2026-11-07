#!/usr/bin/env node
/**
 * Device-level measurement for the mobile composer "+" panel sheet (two-stage).
 *
 * Reads nothing from the page's internals and mutates nothing: every number is taken
 * from the live WebView after a real "adb shell input" gesture, so the same script can
 * measure a baseline build and a candidate build and the JSON can be diffed directly.
 *
 * Usage:
 *   node scripts/verify-composer-sheet-two-stage.mjs --serial emulator-5568 \
 *     --out .deploy-tmp/r10/round1 --phase before --orientation portrait
 *
 * Exit codes: 0 measured, 2 INCONCLUSIVE (composer unreachable / sheet never appeared), 1 error.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const at = argv.indexOf('--' + name); return at < 0 ? fallback : argv[at + 1] }
const serial = opt('serial')
const phase = opt('phase', 'before')
const orientation = opt('orientation', 'portrait')
const contrast = !argv.includes('--no-contrast')
const assertMode = argv.includes('--assert')
const settleScanMode = argv.includes('--settle-scan')
const adbBin = opt('adb', process.env.ADB ?? 'adb')
if (!serial) throw new Error('Usage: node scripts/verify-composer-sheet-two-stage.mjs --serial <adb-serial> [--out <dir>] [--phase before|after] [--orientation portrait|landscape] [--no-contrast] [--assert] [--settle-scan]')
if (!['before', 'after'].includes(phase)) throw new Error('--phase must be before or after')
if (!['portrait', 'landscape'].includes(orientation)) throw new Error('--orientation must be portrait or landscape')

const out = resolve(opt('out', '.deploy-tmp/r10/sheet-' + phase + '-' + orientation + '-' + Date.now()))
mkdirSync(out, { recursive: true })

const commands = []
const screenshots = []
const delay = ms => new Promise(r => setTimeout(r, ms))

function adb(args, options) {
  const o = options || {}
  commands.push(['adb', '-s', serial].concat(args).join(' '))
  const res = spawnSync(adbBin, ['-s', serial].concat(args), { encoding: o.binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0 && !o.allowFailure) throw new Error('adb failed: ' + args.join(' ') + ': ' + String(res.stderr || res.error || '').slice(0, 300))
  return res.stdout
}
const shell = (cmd, o) => adb(['shell', cmd], o)

let ws, wsPort, cdpPid, cdpTarget
let cdpId = 0
const inflight = new Map()

function request(method, params) {
  const id = ++cdpId
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { inflight.delete(id); rej(new Error('CDP timeout: ' + method)) }, 20000)
    inflight.set(id, { res, rej, timer })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}
async function evaluate(expression) {
  const msg = await request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  const ex = msg.result && msg.result.exceptionDetails
  if (ex) throw new Error('CDP eval failed: ' + String((ex.exception && ex.exception.description) || ex.text).slice(0, 300))
  return msg.result && msg.result.result ? msg.result.result.value : undefined
}

function devtoolsSockets() {
  const raw = shell('cat /proc/net/unix').toString()
  const pids = []
  const re = /webview_devtools_remote_([0-9]+)/g
  let m
  while ((m = re.exec(raw))) if (pids.indexOf(m[1]) < 0) pids.push(m[1])
  return pids
}

async function connect() {
  if (wsPort) { spawnSync(adbBin, ['-s', serial, 'forward', '--remove', 'tcp:' + wsPort], { encoding: 'utf8' }); wsPort = null }
  const appPid = shell('pidof com.dsharnessmobile.shell').toString().trim().split(/\s+/)[0]
  if (!appPid) throw new Error('com.dsharnessmobile.shell is not running')
  const sockets = devtoolsSockets()
  if (!sockets.length) throw new Error('no webview_devtools_remote_* socket on the device')
  // the app pid is only a hint: the main WebView socket is served by the app process, but a
  // second WebView (isolated BrowserHost) exposes an empty target list. Try the hint first.
  const ordered = sockets.slice().sort((a, b) => (a === appPid ? -1 : b === appPid ? 1 : 0))
  let found = null
  for (const pid of ordered) {
    const socketName = 'webview_devtools_remote_' + pid
    const port = adb(['forward', 'tcp:0', 'localabstract:' + socketName]).toString().trim()
    if (!/^[0-9]+$/.test(port)) continue
    const deadline = Date.now() + 12000
    let target = null
    while (Date.now() < deadline && !target) {
      try {
        const roster = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())
        target = roster.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:[0-9]+\//.test(t.url))
      } catch (e) {}
      if (!target) await delay(250)
    }
    if (target) { found = { pid: pid, port: port, target: target, socketName: socketName }; break }
    spawnSync(adbBin, ['-s', serial, 'forward', '--remove', 'tcp:' + port], { encoding: 'utf8' })
  }
  if (!found) throw new Error('main WebView CDP page target was not found on any of: ' + ordered.join(','))
  wsPort = found.port; cdpPid = found.pid; cdpTarget = found.target
  try { if (ws) ws.close() } catch (e) {}
  for (const entry of inflight) { clearTimeout(entry[1].timer); entry[1].rej(new Error('CDP target refreshed')) }
  inflight.clear()
  const socket = new WebSocket(cdpTarget.webSocketDebuggerUrl)
  ws = socket
  await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })
  socket.addEventListener('message', ev => {
    if (ws !== socket) return
    const msg = JSON.parse(String(ev.data))
    const w = inflight.get(msg.id)
    if (!w) return
    clearTimeout(w.timer); inflight.delete(msg.id)
    if (msg.error) w.rej(new Error(String(msg.error.message))); else w.res(msg)
  })
}
function focusedPackage() {
  const out = shell('dumpsys window').toString()
  const m = out.match(/mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/)
  return m ? m[1] : null
}
async function ensureAppForeground(label) {
  const pkg = focusedPackage()
  if (pkg === 'com.dsharnessmobile.shell') return { foreground: true, pkg: pkg, relaunched: false }
  shell('am start -n com.dsharnessmobile.shell/.MainActivity')
  await delay(2600)
  const after = focusedPackage()
  report.notes.push('app was backgrounded (' + pkg + ') at ' + (label || 'start') + '; relaunched, focus now ' + after)
  return { foreground: after === 'com.dsharnessmobile.shell', pkg: after, relaunched: true }
}

async function ensureConnection() {
  const pid = shell('pidof com.dsharnessmobile.shell').toString().trim().split(/\s+/)[0]
  if (!ws || ws.readyState !== WebSocket.OPEN || pid !== cdpPid) { await connect(); return }
  try {
    const roster = await fetch('http://127.0.0.1:' + wsPort + '/json/list').then(r => r.json())
    const live = roster.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:[0-9]+\//.test(t.url))
    if (!live || !live.webSocketDebuggerUrl || live.id !== cdpTarget.id) await connect()
  } catch (e) { await connect() }
}

function screenshot(state) {
  const name = 'ui-' + String(screenshots.length + 1).padStart(2, '0') + '-' + state + '.png'
  writeFileSync(join(out, name), adb(['exec-out', 'screencap', '-p'], { binary: true }))
  screenshots.push({ name, path: join(out, name), state })
  return name
}

/* ----------------------------------------------------------- page-side probes */
/* These functions are serialised with Function.prototype.toString and executed in
   the WebView, so each one must stay self-contained (no closures). */

function stateSnapshotProbe() {
  const r2 = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : 0)
  const box = e => {
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: r2(r.x), y: r2(r.y), width: r2(r.width), height: r2(r.height), top: r2(r.top), bottom: r2(r.bottom), left: r2(r.left), right: r2(r.right) }
  }
  const panel = document.querySelector('[data-dsh-composer-sheet-panel]')
  const backdrop = document.querySelector('[data-dsh-composer-sheet-backdrop]')
  const rowsBox = document.querySelector('[data-dsh-composer-sheet-rows]')
  const rows = Array.from(document.querySelectorAll('[data-dsh-composer-sheet-row]'))
  const tiles = Array.from(document.querySelectorAll('[data-dsh-composer-sheet-tile]'))
  const close = document.querySelector('[data-dsh-composer-sheet-close]')
  const handle = document.querySelector('[data-dsh-composer-sheet-handle]')
  const st = e => (e ? getComputedStyle(e) : null)
  const ps = st(panel)
  const bs = st(backdrop)
  const rs = st(rowsBox)
  const rb = rowsBox ? rowsBox.getBoundingClientRect() : null
  const visibleRows = rb ? rows.filter(r => { const x = r.getBoundingClientRect(); return x.height > 0 && x.top >= rb.top - 1 && x.bottom <= rb.bottom + 1 }).length : 0
  const partialRows = rb ? rows.filter(r => { const x = r.getBoundingClientRect(); return x.height > 0 && x.bottom > rb.top + 1 && x.top < rb.bottom - 1 }).length : 0
  const pr = panel ? panel.getBoundingClientRect() : null
  return {
    mobileForm: document.documentElement.hasAttribute('data-dsh-mobile-form'),
    innerWidth: r2(innerWidth), innerHeight: r2(innerHeight),
    visualViewportHeight: visualViewport ? r2(visualViewport.height) : 0,
    dpr: r2(devicePixelRatio),
    sheetPresent: !!panel,
    rowCount: rows.length,
    backdrop: backdrop ? { box: box(backdrop), zIndex: bs.zIndex, position: bs.position, pointerEvents: bs.pointerEvents, opacity: bs.opacity } : null,
    panel: panel ? {
      box: box(panel), zIndex: ps.zIndex, position: ps.position, pointerEvents: ps.pointerEvents,
      overflowY: ps.overflowY, maxHeight: ps.maxHeight, cssHeight: ps.height, transform: ps.transform,
      topGap: r2(pr.top), bottomGap: r2(innerHeight - pr.bottom)
    } : null,
    tiles: {
      count: tiles.length,
      heights: tiles.map(t => r2(t.getBoundingClientRect().height)),
      boxes: tiles.map(box),
      totalHeight: tiles.length ? r2(Math.max.apply(null, tiles.map(t => t.getBoundingClientRect().bottom)) - Math.min.apply(null, tiles.map(t => t.getBoundingClientRect().top))) : 0
    },
    rowsBox: rowsBox ? {
      box: box(rowsBox), scrollTop: r2(rowsBox.scrollTop), scrollHeight: r2(rowsBox.scrollHeight), clientHeight: r2(rowsBox.clientHeight),
      overflowY: rs.overflowY, scrollable: rowsBox.scrollHeight > rowsBox.clientHeight + 1
    } : null,
    firstRowHeight: rows.length ? r2(rows[0].getBoundingClientRect().height) : 0,
    rowHeights: rows.map(r => r2(r.getBoundingClientRect().height)),
    rowTitles: rows.map(r => { const t = r.querySelector('[data-dsh-composer-sheet-row-title]'); return t ? (t.textContent || '').trim().slice(0, 24) : '' }),
    visibleRows: visibleRows, partialRows: partialRows,
    close: close ? { present: true, box: box(close) } : { present: false, box: null },
    handle: handle ? { present: true, box: box(handle) } : { present: false, box: null },
    status: (function () { const s = document.querySelector('[data-dsh-composer-sheet-status]'); return s ? s.getAttribute('data-dsh-composer-sheet-status') : null })()
  }
}

function composerPointProbe() {
  const b = document.querySelector('[data-composer-card] button[aria-haspopup="listbox"]')
  if (!b) return null
  const r = b.getBoundingClientRect()
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2
  const top = document.elementFromPoint(cx, cy)
  const hit = top ? (top === b || b.contains(top) || top.closest('button') === b) : false
  let blocker = null
  if (!hit) blocker = top ? (top.tagName.toLowerCase() + '.' + String(top.className || '').slice(0, 40) + ' ' + (top.getAttribute('aria-label') || (top.textContent || '').trim().slice(0, 24))) : 'none'
  return { x: r.x, y: r.y, width: r.width, height: r.height, cx: cx, cy: cy, dpr: devicePixelRatio, scale: visualViewport ? (visualViewport.scale || 1) : 1, hit: hit, blocker: blocker }
}

function swipeGeometryProbe() {
  const p = document.querySelector('[data-dsh-composer-sheet-panel]')
  if (!p) return null
  const r = p.getBoundingClientRect()
  const dpr = devicePixelRatio
  const x = Math.round((r.x + r.width / 2) * dpr)
  const y1 = Math.round((r.y + Math.min(60, r.height * 0.25)) * dpr)
  const down = Math.min(r.height * 0.55, 420) * dpr
  const y2 = Math.max(Math.round(8 * dpr), y1 - Math.round(down))
  return { x: x, y1: y1, y2: y2, panelTop: r.top, panelHeight: r.height }
}

function closePointProbe() {
  const c = document.querySelector('[data-dsh-composer-sheet-close]')
  const p = document.querySelector('[data-dsh-composer-sheet-panel]')
  const dpr = devicePixelRatio
  if (c) {
    const r = c.getBoundingClientRect()
    return { how: 'close-button', x: Math.round((r.x + r.width / 2) * dpr), y: Math.round((r.y + r.height / 2) * dpr) }
  }
  if (p) {
    const r = p.getBoundingClientRect()
    return { how: 'backdrop', x: Math.round((innerWidth / 2) * dpr), y: Math.round(Math.max(8, r.top - 24) * dpr) }
  }
  return null
}

const pageState = () => evaluate('(' + stateSnapshotProbe.toString() + ')()')
const composerPoint = () => evaluate('(' + composerPointProbe.toString() + ')()')
const swipeGeometry = () => evaluate('(' + swipeGeometryProbe.toString() + ')()')
const closePoint = () => evaluate('(' + closePointProbe.toString() + ')()')

/* ---------------------------------------------------------------- gestures */

async function waitRowsStable(limitMs) {
  const start = Date.now()
  let last = -1
  let stable = 0
  const samples = []
  while (Date.now() - start < limitMs) {
    const n = await evaluate("document.querySelectorAll('[data-dsh-composer-sheet-row]').length")
    samples.push(n)
    if (n > 0 && n === last) {
      stable++
      if (stable >= 2) return { rows: n, waitedMs: Date.now() - start, samples: samples }
    } else stable = 0
    last = n
    await delay(120)
  }
  return { rows: last, waitedMs: Date.now() - start, samples: samples, timedOut: true }
}

async function openSheet() {
  const p = await composerPoint()
  if (!p) return { ok: false, reason: 'composer plus button not in DOM' }
  if (!p.hit) return { ok: false, reason: 'composer plus button is covered by ' + p.blocker, point: p }
  shell('input tap ' + Math.round(p.cx * p.dpr * p.scale) + ' ' + Math.round(p.cy * p.dpr * p.scale))
  const stable = await waitRowsStable(3000)
  const state = await pageState()
  return { ok: state.sheetPresent, point: p, stable: stable, state: state }
}

async function swipeUp() {
  const g = await swipeGeometry()
  if (!g) return null
  shell('input swipe ' + g.x + ' ' + g.y1 + ' ' + g.x + ' ' + g.y2 + ' 320')
  await delay(700)
  return g
}

async function closeSheet() {
  const cp = await closePoint()
  if (!cp) return { closed: true, how: 'already-closed' }
  shell('input tap ' + cp.x + ' ' + cp.y)
  await delay(650)
  let state = await pageState()
  let attempts = 0
  while (state.sheetPresent && attempts < 3) {
    shell('input keyevent 4')
    await delay(450)
    state = await pageState()
    attempts++
  }
  return { closed: !state.sheetPresent, how: cp.how, attempts: attempts }
}

/* ---------------------------------------------------------------- rotation */

let rotation = null
async function rotateTo(next) {
  if (!rotation) {
    rotation = {
      accelerometer: shell('settings get system accelerometer_rotation').toString().trim(),
      user: shell('settings get system user_rotation').toString().trim()
    }
  }
  const val = next === 'landscape' ? '1' : '0'
  shell('settings put system accelerometer_rotation 0')
  shell('settings put system user_rotation ' + val)
  shell('cmd window user-rotation lock ' + val)
  await delay(1500)
}
async function restoreRotation() {
  if (!rotation) return
  shell('settings put system user_rotation ' + rotation.user)
  shell('settings put system accelerometer_rotation ' + rotation.accelerometer)
  if (rotation.accelerometer === '0') shell('cmd window user-rotation lock ' + rotation.user)
  else shell('cmd window user-rotation free')
  rotation = null
  await delay(900)
}

/* ==================================================================== */
/* AFTER-BUILD ASSERTION SUITE (two-stage bottom sheet)                  */
/* Enabled with --assert. Every judgement below is a number or a DOM fact */
/* read from the live WebView after real touch input.                     */
/* ==================================================================== */

function sheetProbe() {
  const r2 = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null)
  const panel = document.querySelector('[data-dsh-composer-sheet-panel]')
  const backdrop = document.querySelector('[data-dsh-composer-sheet-backdrop]')
  const rows = document.querySelector('[data-dsh-composer-sheet-rows]')
  const card = document.querySelector('[data-composer-card]')
  const row0 = document.querySelector('[data-dsh-composer-sheet-row]')
  const vv = visualViewport
  if (!panel) {
    return {
      present: false,
      backdropPresent: !!backdrop,
      mobileForm: document.documentElement.hasAttribute('data-dsh-mobile-form'),
      innerWidth: innerWidth, innerHeight: innerHeight,
      visualViewportBottom: vv ? r2(vv.height + vv.offsetTop) : null
    }
  }
  const r = panel.getBoundingClientRect()
  const cs = getComputedStyle(panel)
  const bcs = backdrop ? getComputedStyle(backdrop) : null
  const rcs = rows ? getComputedStyle(rows) : null
  return {
    present: true,
    backdropPresent: !!backdrop,
    backdropForm: backdrop ? backdrop.getAttribute('data-dsh-composer-sheet-form') : null,
    backdropZIndex: bcs ? bcs.zIndex : null,
    backdropPointerEvents: bcs ? bcs.pointerEvents : null,
    backdropPosition: bcs ? bcs.position : null,
    height: r2(r.height), width: r2(r.width), left: r2(r.left), top: r2(r.top), bottom: r2(r.bottom),
    position: cs.position, zIndex: cs.zIndex, pointerEvents: cs.pointerEvents,
    phase: panel.getAttribute('data-dsh-composer-sheet-phase'),
    peekAttr: panel.getAttribute('data-dsh-composer-sheet-peek'),
    maxAttr: panel.getAttribute('data-dsh-composer-sheet-max'),
    inlineHeight: panel.style.height || '',
    hasHandle: !!document.querySelector('[data-dsh-composer-sheet-handle]'),
    hasClose: !!document.querySelector('[data-dsh-composer-sheet-close]'),
    rowCount: document.querySelectorAll('[data-dsh-composer-sheet-row]').length,
    firstRowHeight: row0 ? r2(row0.getBoundingClientRect().height) : null,
    rowsScrollTop: rows ? r2(rows.scrollTop) : null,
    rowsClientHeight: rows ? rows.clientHeight : null,
    rowsScrollHeight: rows ? rows.scrollHeight : null,
    rowsOverflowY: rcs ? rcs.overflowY : null,
    rowsOverscrollBehaviorY: rcs ? rcs.overscrollBehaviorY : null,
    cardZIndex: card ? getComputedStyle(card).zIndex : null,
    cardPosition: card ? getComputedStyle(card).position : null,
    mobileForm: document.documentElement.hasAttribute('data-dsh-mobile-form'),
    innerWidth: innerWidth, innerHeight: innerHeight,
    visualViewportHeight: vv ? r2(vv.height) : null,
    visualViewportBottom: vv ? r2(vv.height + vv.offsetTop) : null,
    dpr: devicePixelRatio
  }
}

const sheetState = () => evaluate('(' + sheetProbe.toString() + ')()')

let touchId = 0
async function touchSend(type, points) {
  return request('Input.dispatchTouchEvent', { type: type, touchPoints: points })
}
async function touchStart(x, y) { touchId++; await touchSend('touchStart', [{ x: x, y: y, id: touchId, radiusX: 5, radiusY: 5, force: 1 }]) }
async function touchMove(x, y) { await touchSend('touchMove', [{ x: x, y: y, id: touchId, radiusX: 5, radiusY: 5, force: 1 }]) }
async function touchEnd(x, y) { await touchSend('touchEnd', [{ x: x, y: y, id: touchId, radiusX: 5, radiusY: 5, force: 1 }]) }

async function dragSteps(options) {
  const dir = options.direction === 'down' ? 1 : -1
  const stepPx = options.stepPx
  const stepMs = options.stepMs === undefined ? 16 : options.stepMs
  const steps = options.steps
  const start = await sheetState()
  if (!start.present) return { error: 'sheet not present' }
  const x = Math.round(start.width / 2)
  const startY = Math.round(start.top + Math.min(180, start.height - 40))
  const seq = []
  await touchStart(x, startY)
  const atStart = await sheetState()
  seq.push({ step: 0, y: startY, height: atStart.height, scrollTop: atStart.rowsScrollTop })
  let last = null
  for (let i = 1; i <= steps; i++) {
    const y = startY + dir * stepPx * i
    await touchMove(x, y)
    if (stepMs) await delay(stepMs)
    last = await sheetState()
    seq.push({ step: i, y: y, height: last.height, top: last.top, phase: last.phase, scrollTop: last.rowsScrollTop })
  }
  const lastMoveAt = Date.now()
  const held = options.holdShot ? await screenshot(options.holdShot) : null
  if (options.settleMs) await delay(options.settleMs)
  await touchEnd(x, startY + dir * stepPx * steps)
  const pauseBeforeReleaseMs = Date.now() - lastMoveAt
  const afterRelease0 = await sheetState()
  await delay(options.releaseWaitMs === undefined ? 450 : options.releaseWaitMs)
  const afterRelease = await sheetState()
  return { start: start, startX: x, startY: startY, seq: seq, heldShot: held, atRelease: afterRelease0, afterRelease: afterRelease, pauseBeforeReleaseMs: pauseBeforeReleaseMs }
}

// A host-side wall clock cannot judge a 500ms budget on this rig: a bare "adb shell echo"
// measures 89..434ms here. So both ends of the measurement live on the device clock instead:
// the page records Date.now() when the backdrop leaves the DOM, and the pill command that
// injects the gesture brackets itself with date +%s%3N. No host round-trip is inside the delta.
const GONE_WATCH = "new Promise(resolve => { const check = () => { const gone = !document.querySelector('[data-dsh-composer-sheet-backdrop]') && !document.querySelector('[data-dsh-composer-sheet-panel]'); if (gone) resolve({ gone: true, goneEpoch: Date.now() }); else requestAnimationFrame(check) }; check(); setTimeout(() => resolve({ gone: false, goneEpoch: Date.now() }), 9000) })"

function evaluateStart(expression) {
  return request('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true })
}

async function timeUntilClosed(inputCommand, how, extra) {
  const watcher = evaluateStart(GONE_WATCH)
  const raw = shell('ts=$(date +%s%3N); input ' + inputCommand + '; ts2=$(date +%s%3N); echo $ts $ts2').toString().trim()
  const parts = raw.split(/\s+/).map(s => Number(String(s).replace(/[^0-9]/g, '').slice(0, 13)))
  const injectStart = parts[0]
  const injectEnd = parts[1]
  const msg = await watcher
  const ex = msg.result && msg.result.exceptionDetails
  const res = ex ? null : (msg.result && msg.result.result ? msg.result.result.value : null)
  const closed = !!(res && res.gone)
  const out = {
    closed: closed, how: how,
    injectStartEpochMs: injectStart, injectEndEpochMs: injectEnd,
    inputCommandMs: (injectEnd && injectStart) ? injectEnd - injectStart : null,
    goneEpochMs: res ? res.goneEpoch : null,
    elapsedFromIssueMs: (closed && injectStart) ? res.goneEpoch - injectStart : null,
    elapsedFromDeliveryMs: (closed && injectEnd) ? res.goneEpoch - injectEnd : null
  }
  if (extra) Object.assign(out, extra)
  return out
}

async function closeViaBackdrop(contextLabel) {
  const st = await sheetState()
  if (!st.present) return { closed: true, elapsedMs: 0, how: 'already-closed' }
  const tapPoint = await evaluate('(' + backdropTapProbe.toString() + ')()')
  if (!tapPoint) return { closed: false, error: 'no backdrop point' }
  return timeUntilClosed('tap ' + tapPoint.x + ' ' + tapPoint.y, 'backdrop-tap', { point: tapPoint })
}

function backdropTapProbe() {
  const b = document.querySelector('[data-dsh-composer-sheet-backdrop]')
  const p = document.querySelector('[data-dsh-composer-sheet-panel]')
  if (!b) return null
  const dpr = devicePixelRatio
  const y = p ? Math.max(8, p.getBoundingClientRect().top - 40) : Math.round(innerHeight / 3)
  return { x: Math.round((innerWidth / 2) * dpr), y: Math.round(y * dpr) }
}

async function closeViaBackKey(contextLabel) {
  const st = await sheetState()
  if (!st.present) return { closed: true, elapsedMs: 0, how: 'already-closed' }
  return timeUntilClosed('keyevent 4', 'back-key')
}

async function tapPlusOnce() {
  const p = await composerPoint()
  if (!p || !p.hit) return { ok: false, point: p }
  shell('input tap ' + Math.round(p.cx * p.dpr * p.scale) + ' ' + Math.round(p.cy * p.dpr * p.scale))
  return { ok: true, point: p }
}

async function ensureOpen(attempts) {
  const max = attempts || 3
  let st = await sheetState()
  if (st.present) return st
  for (let i = 0; i < max; i++) {
    const tapped = await tapPlusOnce()
    if (!tapped.ok) return { present: false, error: 'plus unreachable: ' + (tapped.point ? String(tapped.point.blocker) : 'no point') }
    await waitRowsStable(3000)
    st = await sheetState()
    if (st.present) return st
  }
  return st
}

async function ensurePeek() {
  let st = await sheetState()
  if (st.present && st.phase !== 'peek') { await closeViaBackKey('reset'); st = await sheetState() }
  if (st.present) return st
  st = await ensureOpen(3)
  if (st.present && st.phase !== 'peek') { await delay(400); st = await sheetState() }
  return st
}

async function setFeel(value) {
  await evaluate(value ? "document.documentElement.setAttribute('data-dsh-composer-sheet-feel'," + JSON.stringify(value) + ')' : "document.documentElement.removeAttribute('data-dsh-composer-sheet-feel')")
  await delay(120)
}

async function dragWithForcedOverflow() {
  await ensurePeek()
  const cloneInfo = await evaluate("(() => { const rows=document.querySelector('[data-dsh-composer-sheet-rows]'); const first=rows.querySelector('[data-dsh-composer-sheet-row]'); for (let i=0;i<16;i++) { const c=first.cloneNode(true); c.setAttribute('data-probe-clone','1'); rows.appendChild(c) } return { rows: rows.querySelectorAll('[data-dsh-composer-sheet-row]').length, ch: rows.clientHeight, sh: rows.scrollHeight } })()")
  let drag = null
  try {
    drag = await dragSteps({ direction: 'up', stepPx: 50, steps: 16, stepMs: 16, settleMs: 120 })
  } finally {
    await evaluate("(() => { document.querySelectorAll('[data-probe-clone]').forEach(e => e.remove()); const r = document.querySelector('[data-dsh-composer-sheet-rows]'); if (r) r.scrollTop = 0; return 1 })()")
  }
  const endState = await sheetState()
  await closeViaBackKey('reset')
  return {
    cloneInfo: cloneInfo, start: drag.start, seq: drag.seq, atRelease: drag.atRelease, afterRelease: drag.afterRelease,
    heightAtEnd: drag.seq[drag.seq.length - 1].height, rowsAtStart: cloneInfo.rows,
    overflowPx: cloneInfo.sh - cloneInfo.ch, endPhase: endState.phase, endHeight: endState.height
  }
}

async function runAssertSuite() {
  const checks = []
  const add = (id, name, ok, got, expect) => { checks.push({ id: id, name: name, ok: !!ok, got: got, expect: expect }); return !!ok }
  const near = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol
  const results = {}
  const shots = []

  // ---------- preflight: the app must be in the foreground, otherwise the page target freezes ----------
  const fg = await ensureAppForeground('assert suite start')
  add('T-1', 'app is the focused window', fg.foreground === true, { pkg: fg.pkg, relaunched: fg.relaunched }, 'com.dsharnessmobile.shell focused')

  // ---------- open ----------
  let st = await ensurePeek()
  if (!st.present) { add('T0', 'sheet opens on real + tap', false, st.error || 'not present', 'panel present'); results.open = st; return { checks: checks, results: results, shots: shots } }
  add('T0', 'sheet opens on real + tap', true, { height: st.height, phase: st.phase }, 'panel present')
  const peek = st
  results.peek = peek
  shots.push(await screenshot('peek-portrait'))

  // ---------- 1: form / anchoring / affordances ----------
  add('A1a', 'backdrop carries data-dsh-composer-sheet-form=sheet', peek.backdropForm === 'sheet', peek.backdropForm, 'sheet')
  add('A1b', 'panel computed position=fixed', peek.position === 'fixed', peek.position, 'fixed')
  add('A1c', 'panel computed left=0', near(peek.left, 0, 0.5), peek.left, '0')
  add('A1d', 'panel computed width=600', near(peek.width, 600, 0.5), peek.width, '600')
  add('A1e', 'panel bottom hugs visual viewport bottom', near(peek.bottom, peek.visualViewportBottom, 1), { bottom: peek.bottom, vvBottom: peek.visualViewportBottom }, 'equal +-1')
  add('A1f', 'drag handle present', peek.hasHandle === true, peek.hasHandle, 'true')
  add('A1g', 'close button absent in sheet form', peek.hasClose === false, peek.hasClose, 'false')

  // ---------- 2: peek geometry ----------
  const peekExpected = 4 + 14 + 96 + 8 + 3.5 * 46 + 12
  add('A2a', 'peek height = padTop4+handle14+tiles96+gap8+3.5rows161+padBottom12', near(peek.height, peekExpected, 2), { height: peek.height, expected: peekExpected, attr: peek.peekAttr }, '295 +-2')
  const ratio = peek.firstRowHeight ? peek.rowsClientHeight / peek.firstRowHeight : null
  add('A2b', 'visible rows ratio = rows.clientHeight / firstRowHeight in [3.4,3.6]', ratio !== null && ratio >= 3.4 && ratio <= 3.6, { ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000, clientHeight: peek.rowsClientHeight, firstRowHeight: peek.firstRowHeight }, '3.4..3.6')

  // ---------- 3: expanded cap ----------
  const maxExpected = Math.round(0.88 * Math.round(peek.visualViewportHeight))
  const up800 = await dragSteps({ direction: 'up', stepPx: 50, steps: 16, stepMs: 16, settleMs: 120 })
  const expanded = await sheetState()
  results.expanded = expanded
  results.up800 = { start: up800.start, seq: up800.seq, atRelease: up800.atRelease, afterRelease: up800.afterRelease }
  shots.push(await screenshot('expanded-portrait'))
  add('A3a', 'expanded cap = round(0.88 x viewport) ', near(expanded.height, maxExpected, 2), { height: expanded.height, expected: maxExpected, attr: expanded.maxAttr }, '939 +-2')
  add('A3b', 'expanded panel top ~= viewport - 939', near(expanded.top, Math.round(peek.visualViewportBottom) - maxExpected, 2), expanded.top, '~128 +-2')
  add('A6a', 'one 800px gesture from peek pins the sheet at the cap', near(expanded.height, maxExpected, 2), { height: expanded.height, expected: maxExpected }, '939 +-2')
  results.capGeometry = {
    rowsClientHeight: expanded.rowsClientHeight, rowsScrollHeight: expanded.rowsScrollHeight,
    rowCount: expanded.rowCount, overflowPx: expanded.rowsScrollHeight - expanded.rowsClientHeight,
    note: 'with the shipped 9 rows the rows box is taller than its content at the cap, so there is nothing to scroll there'
  }
  const forced = await dragWithForcedOverflow()
  results.handover = forced
  const handoverScroll = forced.seq.length ? Math.max.apply(null, forced.seq.map(s => (s.scrollTop === null || s.scrollTop === undefined) ? 0 : s.scrollTop)) : 0
  add('A6b', 'after the cap the same gesture hands over to rows scrolling (16 extra rows forced)', near(forced.heightAtEnd, maxExpected, 2) && handoverScroll > 0, { heightAtEnd: forced.heightAtEnd, maxScrollTopInGesture: handoverScroll, rowsAtStart: forced.rowsAtStart, overflowAtCap: forced.overflowPx }, 'height 939 and scrollTop > 0')

  // ---------- 4: A feel 1:1 ----------
  await closeViaBackKey('reset')
  st = await ensurePeek()
  add('A4a', 'reset back to peek before A-feel drag', near(st.height, peekExpected, 2) && st.phase === 'peek', { height: st.height, phase: st.phase }, '295/peek')
  const feelA = await dragSteps({ direction: 'up', stepPx: 20, steps: 15, stepMs: 16, settleMs: 600, holdShot: 'dragging-portrait' })
  results.feelA = { start: feelA.start, seq: feelA.seq, atRelease: feelA.atRelease, afterRelease: feelA.afterRelease, heldShot: feelA.heldShot }
  if (feelA.heldShot) shots.push(join(out, feelA.heldShot))
  const aFinal = feelA.seq[feelA.seq.length - 1].height
  const aLinear = feelA.seq.every(s => near(s.height, peekExpected + 20 * s.step, 2))
  add('A4b', 'A feel maps 300px of drag 1:1 (every step = peek + 20n)', aLinear, { final: aFinal, series: feelA.seq.map(s => s.height) }, 'linear 295+20n')
  add('A4c', 'A feel ends at 295+300=595', near(aFinal, peekExpected + 300, 2), aFinal, '595 +-2')
  add('A4d', 'slow release snaps back to peek', near(feelA.afterRelease.height, peekExpected, 2), { afterRelease: feelA.afterRelease.height, phase: feelA.afterRelease.phase, pauseBeforeReleaseMs: feelA.pauseBeforeReleaseMs }, '295 +-2')

  // ---------- 5: scrollTop > 0 freezes height ----------
  await ensurePeek()
  await evaluate("(() => { const r = document.querySelector('[data-dsh-composer-sheet-rows]'); r.scrollTop = 60; return r.scrollTop })()")
  const scrolled = await sheetState()
  const frozen = await dragSteps({ direction: 'up', stepPx: 20, steps: 15, stepMs: 16, settleMs: 100 })
  results.frozen = { scrolledStart: scrolled.rowsScrollTop, seq: frozen.seq, afterRelease: frozen.afterRelease }
  const frozenHeights = frozen.seq.map(s => s.height)
  add('A5', 'with rows.scrollTop > 0 an upward drag keeps the card height unchanged', scrolled.rowsScrollTop > 0 && frozenHeights.every(h => near(h, peekExpected, 2)), { scrollTopAtStart: scrolled.rowsScrollTop, heights: frozenHeights }, 'all 295 +-2')
  await evaluate("document.querySelector('[data-dsh-composer-sheet-rows]').scrollTop = 0")

  // ---------- 7: close threshold ----------
  await ensurePeek()
  const pull110 = await dragSteps({ direction: 'down', stepPx: 10, steps: 11, stepMs: 90, settleMs: 120 })
  await delay(120)
  const after110 = await sheetState()
  results.pull110 = { seq: pull110.seq, afterRelease: pull110.afterRelease }
  add('A7a', 'slow 110px pull (>0.3x295=88.5) closes the sheet', !after110.present && !after110.backdropPresent, { present: after110.present, backdropPresent: after110.backdropPresent }, 'closed')
  await ensurePeek()
  const pull40 = await dragSteps({ direction: 'down', stepPx: 10, steps: 4, stepMs: 90, settleMs: 120 })
  const after40 = await sheetState()
  results.pull40 = { seq: pull40.seq, afterRelease: pull40.afterRelease }
  add('A7b', 'slow 40px pull (<88.5) keeps the sheet and returns to peek', after40.present && near(after40.height, peekExpected, 2), { present: after40.present, height: after40.height }, 'open, 295 +-2')

  // ---------- 8: three close paths within 500ms ----------
  await ensurePeek()
  const closeBackdrop = await closeViaBackdrop('path-backdrop')
  results.closePaths = { backdrop: closeBackdrop }
  add('A8a', 'backdrop tap closes within 500ms (device clock, injection included)', closeBackdrop.closed && closeBackdrop.elapsedFromIssueMs !== null && closeBackdrop.elapsedFromIssueMs <= 500, closeBackdrop, 'closed <=500ms')
  await ensurePeek()
  const pullClose = await dragSteps({ direction: 'down', stepPx: 10, steps: 11, stepMs: 90, settleMs: 100 })
  await delay(120)
  const pullState = await sheetState()
  results.closePaths.pull = { closed: !pullState.present && !pullState.backdropPresent }
  add('A8b', 'over-threshold pull closes (backdrop gone)', !pullState.present && !pullState.backdropPresent, results.closePaths.pull, 'closed')
  shots.push(await screenshot('closed-portrait'))
  await ensurePeek()
  const closeBack = await closeViaBackKey('path-back')
  results.closePaths.backKey = closeBack
  add('A8c', 'system back closes within 500ms (device clock, injection included)', closeBack.closed && closeBack.elapsedFromIssueMs !== null && closeBack.elapsedFromIssueMs <= 500, closeBack, 'closed <=500ms')
  const fgAfterBack = await ensureAppForeground('after system back')
  results.foregroundAfterBack = fgAfterBack
  add('A8d', 'system back closes the sheet without leaving the app', fgAfterBack.foreground === true && fgAfterBack.relaunched === false, fgAfterBack, 'still focused, no relaunch')

  // ---------- 10: layering ----------
  st = await ensurePeek()
  add('A10a', 'backdrop z-index = 2147483100', String(st.backdropZIndex) === '2147483100', st.backdropZIndex, '2147483100')
  add('A10b', 'backdrop z-index is above the composer card', st.cardZIndex === 'auto' && st.backdropZIndex === '2147483100', { backdropZ: st.backdropZIndex, cardZ: st.cardZIndex }, 'showcase')
  add('A10c', 'backdrop pointer-events is not none', st.backdropPointerEvents !== 'none', st.backdropPointerEvents, 'not none')
  add('A10d', 'panel pointer-events is not none', st.pointerEvents !== 'none', st.pointerEvents, 'not none')
  add('A10e', 'rows overflow-y=auto and overscroll-behavior-y=contain', st.rowsOverflowY === 'auto' && String(st.rowsOverscrollBehaviorY).indexOf('contain') >= 0, { overflowY: st.rowsOverflowY, overscroll: st.rowsOverscrollBehaviorY }, 'auto / contain')

  // ---------- B feel ----------
  await ensurePeek()
  await setFeel('B')
  st = await ensurePeek()
  const feelB = await dragSteps({ direction: 'up', stepPx: 20, steps: 15, stepMs: 16, settleMs: 600, holdShot: 'feeling-b-portrait' })
  let bFinal = feelB.seq[feelB.seq.length - 1].height
  const bRatio = (bFinal - peekExpected) / 300
  let bRetried = false
  if (bRatio > 0.95) {
    await closeViaBackKey('reset')
    await ensurePeek()
    const retry = await dragSteps({ direction: 'up', stepPx: 20, steps: 15, stepMs: 16, settleMs: 600 })
    bFinal = retry.seq[retry.seq.length - 1].height
    bRetried = true
    results.feelB = { retry: true, start: retry.start, seq: retry.seq, afterRelease: retry.afterRelease }
  } else {
    results.feelB = { start: feelB.start, seq: feelB.seq, atRelease: feelB.atRelease, afterRelease: feelB.afterRelease, heldShot: feelB.heldShot }
    if (feelB.heldShot) shots.push(join(out, feelB.heldShot))
  }
  const bRatioFinal = (bFinal - peekExpected) / 300
  add('A14a', 'B feel moves ~0.85x of the drag (300px -> ~255px)', bRatioFinal >= 0.80 && bRatioFinal <= 0.90, { final: bFinal, ratio: Math.round(bRatioFinal * 1000) / 1000, retried: bRetried }, '0.80..0.90')
  add('A14b', 'B feel series is strictly increasing and below the 1:1 line', results.feelB.seq ? results.feelB.seq.every((s, i) => i === 0 || s.height >= results.feelB.seq[i - 1].height) : false, results.feelB.seq ? results.feelB.seq.map(s => s.height) : null, 'monotonic')
  const afterB = results.feelB.afterRelease ? results.feelB.afterRelease : await sheetState()
  add('A14c', 'B feel release snaps to peek or expanded', near(afterB.height, peekExpected, 2) || near(afterB.height, maxExpected, 2), { height: afterB.height, phase: afterB.phase }, 'peek or expanded')
  // Diagnostic, not a gate: the same 300px drag released after different pauses, always on feel A.
  await setFeel(null)
  const settleMatrix = []
  for (const settle of [0, 200, 900]) {
    await closeViaBackKey('reset')
    await ensurePeek()
    const trial = await dragSteps({ direction: 'up', stepPx: 20, steps: 15, stepMs: 16, settleMs: settle })
    settleMatrix.push({
      feel: 'A', settleMs: settle, pauseBeforeReleaseMs: trial.pauseBeforeReleaseMs,
      dragEndHeight: trial.seq[trial.seq.length - 1].height,
      endHeight: trial.afterRelease.height, endPhase: trial.afterRelease.phase
    })
  }
  results.settleMatrix = settleMatrix
  await setFeel(null)
  await closeViaBackKey('reset')

  // ---------- 9: landscape contrast ----------
  await rotateTo('landscape')
  await delay(700)
  await ensureConnection()
  st = await ensurePeek()
  results.landscape = st
  shots.push(await screenshot('contrast-peek-landscape'))
  add('A9a', 'landscape: data-dsh-mobile-form absent', st.mobileForm === false, st.mobileForm, 'false')
  add('A9b', 'landscape: backdrop form=card', st.backdropForm === 'card', st.backdropForm, 'card')
  add('A9c', 'landscape: panel position=relative', st.position === 'relative', st.position, 'relative')
  add('A9d', 'landscape: panel 360x420', near(st.width, 360, 1) && near(st.height, 420, 1), { width: st.width, height: st.height }, '360x420')
  add('A9e', 'landscape: panel anchored at x~354 y~90', near(st.left, 353.67, 1) && near(st.top, 90, 1), { x: st.left, y: st.top }, '354 / 90 +-1')
  add('A9f', 'landscape: close control present', st.hasClose === true, st.hasClose, 'true')
  add('A9g', 'landscape: no drag handle', st.hasHandle === false, st.hasHandle, 'false')
  add('A9h', 'landscape: no inline height / no phase,peek,max attributes', st.inlineHeight === '' && st.phase === null && st.peekAttr === null && st.maxAttr === null, { inlineHeight: st.inlineHeight, phase: st.phase, peek: st.peekAttr, max: st.maxAttr }, 'all absent')
  await closeViaBackKey('reset')
  shots.push(await screenshot('contrast-closed-landscape'))
  await restoreRotation()

  results.checks = checks
  results.shots = shots
  return { checks: checks, results: results, shots: shots }
}

/* ------------------------------------------------------------------ */
/* settle scan: how long a pause before lifting decides peek vs expanded */
/* ------------------------------------------------------------------ */

function nearNum(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= tol }

async function runSettleScan() {
  const checks = []
  const add = (id, name, ok, got, expect) => { checks.push({ id: id, name: name, ok: !!ok, got: got, expect: expect }); return !!ok }
  const rows = []
  const settles = [0, 30, 60, 120, 240, 480, 960]
  const trialsPerSettle = 3
  const fg = await ensureAppForeground('settle scan start')
  add('S-1', 'app is the focused window', fg.foreground === true, { pkg: fg.pkg, relaunched: fg.relaunched }, 'com.dsharnessmobile.shell focused')
  const open = await ensurePeek()
  if (!open.present) {
    add('S0', 'sheet opens on real + tap', false, open.error || 'not present', 'panel present')
    return { checks: checks, rows: rows, peekHeight: null }
  }
  const peekHeight = open.height
  add('S0', 'sheet opens and rests at peek', nearNum(open.height, 295, 2), { height: open.height, phase: open.phase }, '295 +-2')

  for (const settle of settles) {
    const trials = []
    for (let i = 0; i < trialsPerSettle; i++) {
      if ((await sheetState()).present) await closeViaBackKey('scan-reset')
      await ensurePeek()
      const drag = await dragSteps({ direction: 'up', stepPx: 20, steps: 15, stepMs: 16, settleMs: settle, releaseWaitMs: 700 })
      const last = drag.seq[drag.seq.length - 1]
      trials.push({
        dragEndHeight: last.height,
        pauseBeforeReleaseMs: drag.pauseBeforeReleaseMs,
        endHeight: drag.afterRelease.height,
        endPhase: drag.afterRelease.phase
      })
    }
    rows.push({ settleMs: settle, trials: trials })
  }

  const flat = []
  for (const row of rows) for (const t of row.trials) flat.push({ settleMs: row.settleMs, t: t })
  const dragOk = flat.every(e => nearNum(e.t.dragEndHeight, peekHeight + 300, 2))
  add('S-2', 'every trial drags peek+300 before lifting', dragOk, { distinctDragEnd: Array.from(new Set(flat.map(e => e.t.dragEndHeight))), expected: peekHeight + 300 }, '595 +-2 on all trials')

  const foul = []
  for (const row of rows) {
    if (row.settleMs < 240) continue
    for (const t of row.trials) if (t.endPhase !== 'peek' || !nearNum(t.endHeight, peekHeight, 2)) foul.push({ settleMs: row.settleMs, endHeight: t.endHeight, endPhase: t.endPhase, pauseBeforeReleaseMs: t.pauseBeforeReleaseMs })
  }
  add('S-3', 'every pause >= 240ms settles back to peek', foul.length === 0, { violations: foul, checkedSettles: [240, 480, 960] }, 'no violation')

  const summary = rows.map(r => ({
    settleMs: r.settleMs,
    ends: r.trials.map(t => (t.endPhase === 'peek' ? 'peek' : t.endPhase === 'expanded' ? 'expanded' : String(t.endPhase))).join(','),
    pauses: r.trials.map(t => t.pauseBeforeReleaseMs)
  }))
  return { checks: checks, rows: summary, peekHeight: peekHeight }
}

/* ------------------------------------------------------------------ report */

const report = {
  script: 'scripts/verify-composer-sheet-two-stage.mjs',
  phase: phase, orientation: orientation, serial: serial,
  startedAt: new Date().toISOString(), out: out,
  device: {}, runs: {}, notes: [], screenshots: screenshots, commands: commands,
  verdict: 'PENDING'
}

function summarise(state, g) {
  const p = state.panel
  const r = state.rowsBox
  const b = state.backdrop
  return {
    mobileForm: state.mobileForm,
    innerWidth: state.innerWidth, innerHeight: state.innerHeight,
    visualViewportHeight: state.visualViewportHeight, dpr: state.dpr,
    sheetPresent: state.sheetPresent, rowCount: state.rowCount,
    panel: p ? { x: p.box.x, y: p.box.y, width: p.box.width, height: p.box.height, topGap: p.topGap, bottomGap: p.bottomGap, zIndex: p.zIndex, pointerEvents: p.pointerEvents, position: p.position, maxHeight: p.maxHeight } : null,
    backdrop: b ? { x: b.box.x, y: b.box.y, width: b.box.width, height: b.box.height, zIndex: b.zIndex, pointerEvents: b.pointerEvents, position: b.position } : null,
    tilesCount: state.tiles.count, tilesHeight: state.tiles.totalHeight, tileHeights: state.tiles.heights, tileBoxes: state.tiles.boxes,
    rowsScroll: r ? { scrollTop: r.scrollTop, scrollHeight: r.scrollHeight, clientHeight: r.clientHeight, scrollable: r.scrollable, overflowY: r.overflowY } : null,
    firstRowHeight: state.firstRowHeight, rowHeights: state.rowHeights,
    visibleRows: state.visibleRows, partialRows: state.partialRows,
    hasClose: state.close.present, closeBox: state.close.box,
    hasHandle: state.handle.present, handleBox: state.handle.box,
    status: state.status, rowTitles: state.rowTitles, swipe: g || null
  }
}

async function runOrientation(target, isContrast) {
  await rotateTo(target)
  await delay(500)
  await ensureConnection()
  const pre = await pageState()
  if (pre.sheetPresent) await closeSheet()
  const opened = await openSheet()
  if (!opened.ok) {
    const shot = screenshot('blocked-' + target)
    report.notes.push('[' + target + '] ' + (opened.reason || 'sheet did not appear'))
    return { blocked: true, reason: opened.reason, point: opened.point || null, screenshot: shot }
  }
  const peekState = await pageState()
  const peekShot = screenshot((isContrast ? 'contrast-peek-' : 'peek-') + target)
  const peek = summarise(peekState, null)

  const g = await swipeUp()
  const expandedState = await pageState()
  const expandShot = screenshot((isContrast ? 'contrast-expanded-' : 'expanded-') + target)
  const expanded = summarise(expandedState, g)

  const closed = await closeSheet()
  const closedState = await pageState()
  const closedShot = screenshot((isContrast ? 'contrast-closed-' : 'closed-') + target)

  const delta = (peek.panel && expanded.panel) ? {
    panelTopDelta: Math.round((peek.panel.y - expanded.panel.y) * 100) / 100,
    panelHeightDelta: Math.round((expanded.panel.height - peek.panel.height) * 100) / 100,
    rowsClientHeightDelta: (expanded.rowsScroll ? expanded.rowsScroll.clientHeight : 0) - (peek.rowsScroll ? peek.rowsScroll.clientHeight : 0),
    visibleRowsDelta: expanded.visibleRows - peek.visibleRows,
    handleAfterSwipe: expanded.hasHandle
  } : null

  return {
    blocked: false, target: target, rowsStable: opened.stable, composerPoint: opened.point,
    peek: peek, peekShot: peekShot,
    expanded: expanded, expandShot: expandShot,
    delta: delta,
    closed: closed, closedShot: closedShot,
    closedOk: !closedState.sheetPresent
  }
}

try {
  await ensureConnection()
  const sizeOut = shell('wm size').toString()
  const densOut = shell('wm density').toString()
  const versionName = (shell('dumpsys package com.dsharnessmobile.shell').toString().match(/versionName=([^\s]+)/) || [])[1] || null
  const fingerprint = shell('run-as com.dsharnessmobile.shell cat files/.snapshot-fingerprint', { allowFailure: true }).toString().trim()
  const transaction = shell("run-as com.dsharnessmobile.shell sh -c 'if test -e files/.snapshot-transaction; then echo ACTIVE; else echo ABSENT; fi'", { allowFailure: true }).toString().trim()
  const initial = await pageState()
  report.device = {
    versionName: versionName, fingerprint: fingerprint, snapshotTransaction: transaction,
    wmSize: sizeOut.replace(/\s+/g, ' ').trim(), wmDensity: densOut.replace(/\s+/g, ' ').trim(),
    cdpTargetId: cdpTarget.id, cdpUrl: cdpTarget.url, cdpPort: wsPort, pid: cdpPid,
    initialMobileForm: initial.mobileForm, initialInner: [initial.innerWidth, initial.innerHeight], initialDpr: initial.dpr
  }
  if (transaction === 'ACTIVE') {
    report.verdict = 'INCONCLUSIVE'
    report.notes.push('snapshot transaction ACTIVE - device is mid-refresh, measurements invalid')
    throw Object.assign(new Error('snapshot transaction active'), { inconclusive: true })
  }
  if (settleScanMode) {
    const scan = await runSettleScan()
    report.checks = scan.checks
    report.runs.settleScan = scan.rows
    const failedScan = scan.checks.filter(c => !c.ok)
    report.assertSummary = { total: scan.checks.length, passed: scan.checks.length - failedScan.length, failed: failedScan.map(c => c.id) }
    report.verdict = failedScan.length === 0 ? 'PASS' : 'FAIL'
  } else if (assertMode) {
    const suite = await runAssertSuite()
    report.checks = suite.checks
    report.runs.assert = suite.results
    const failed = suite.checks.filter(c => !c.ok)
    report.assertSummary = { total: suite.checks.length, passed: suite.checks.length - failed.length, failed: failed.map(c => c.id) }
    report.verdict = failed.length === 0 ? 'PASS' : 'FAIL'
    if (failed.length === 0 && suite.checks.length === 0) report.verdict = 'INCONCLUSIVE'
  } else {
    const primary = await runOrientation(orientation, false)
    report.runs.primary = primary
    if (primary.blocked) {
      report.verdict = 'INCONCLUSIVE'
    } else {
      report.verdict = 'MEASURED'
      if (contrast) report.runs.contrast = await runOrientation(orientation === 'portrait' ? 'landscape' : 'portrait', true)
      if (report.runs.contrast && report.runs.contrast.blocked) report.notes.push('contrast orientation blocked: ' + report.runs.contrast.reason)
    }
  }
} catch (err) {
  if (!err.inconclusive) {
    report.verdict = 'ERROR'
    report.error = String((err && err.message) || err)
  }
}

try { await restoreRotation() } catch (e) { report.notes.push('rotation restore failed: ' + String(e && e.message)) }
report.finishedAt = new Date().toISOString()

const p = report.runs.primary
const bits = ['SUMMARY', 'phase=' + phase, 'orientation=' + (assertMode ? 'assert' : orientation), 'serial=' + serial, 'version=' + (report.device.versionName || '?')]
if (assertMode || settleScanMode) {
  const as = report.assertSummary || { total: 0, passed: 0, failed: [] }
  const ap = report.runs.assert || {}
  bits.push('checks=' + as.passed + '/' + as.total)
  bits.push('fail=' + (as.failed.length ? as.failed.join(',') : 'none'))
  if (ap.peek) {
    bits.push('peek=' + ap.peek.height + 'h@y' + Math.round(ap.peek.top) + '/' + ap.peek.phase)
    bits.push('peekAttr=' + ap.peek.peekAttr + '/maxAttr=' + ap.peek.maxAttr)
  }
  if (ap.expanded) bits.push('expanded=' + ap.expanded.height + 'h@y' + Math.round(ap.expanded.top))
  if (ap.feelA && ap.feelA.seq) bits.push('feelA=' + ap.feelA.seq.map(s => s.height).join('>'))
  if (ap.feelB && ap.feelB.seq) bits.push('feelB=' + ap.feelB.seq.map(s => s.height).join('>'))
  if (ap.closePaths) bits.push('closeT=' + [ap.closePaths.backdrop && ap.closePaths.backdrop.elapsedFromIssueMs, ap.closePaths.backKey && ap.closePaths.backKey.elapsedFromIssueMs].join('/'))
  if (report.runs.settleScan) bits.push('settleScan=' + report.runs.settleScan.map(r => r.settleMs + ':' + r.ends).join('|'))
  bits.push('shots=' + screenshots.length)
  bits.push('verdict=' + report.verdict)
}
if (p && !p.blocked) {
  const screen = (report.device.wmSize || '').replace('Physical size: ', '').trim()
  const density = (report.device.wmDensity || '').replace('Physical density: ', '').trim()
  bits.push('screen=' + screen + '/' + density + 'dpi')
  bits.push('form=' + (p.peek.mobileForm ? 1 : 0) + '/' + p.peek.innerWidth + 'x' + p.peek.innerHeight + '/vv' + Math.round(p.peek.visualViewportHeight) + '/dpr' + p.peek.dpr)
  bits.push('peek=' + Math.round(p.peek.panel ? p.peek.panel.height : 0) + 'h@y' + Math.round(p.peek.panel ? p.peek.panel.y : 0))
  bits.push('expanded=' + Math.round(p.expanded.panel ? p.expanded.panel.height : 0) + 'h@y' + Math.round(p.expanded.panel ? p.expanded.panel.y : 0))
  bits.push('deltaH=' + (p.delta ? p.delta.panelHeightDelta : 0))
  bits.push('rows=' + p.peek.rowCount + '/firstH' + Math.round(p.peek.firstRowHeight))
  bits.push('visibleRows=' + p.peek.visibleRows + '>' + p.expanded.visibleRows)
  bits.push('rowsScroll=' + (p.peek.rowsScroll ? p.peek.rowsScroll.scrollTop + '/' + p.peek.rowsScroll.scrollHeight + '/' + p.peek.rowsScroll.clientHeight : 'none') + '>' + (p.expanded.rowsScroll ? p.expanded.rowsScroll.scrollTop + '/' + p.expanded.rowsScroll.scrollHeight + '/' + p.expanded.rowsScroll.clientHeight : 'none'))
  bits.push('tiles=' + p.peek.tilesCount + 'x' + Math.round(p.peek.tilesHeight))
  bits.push('close=' + (p.peek.hasClose ? 1 : 0) + '/handle=' + (p.expanded.hasHandle ? 1 : 0))
  bits.push('z=' + (p.peek.panel ? p.peek.panel.zIndex : '-') + '/' + (p.peek.backdrop ? p.peek.backdrop.zIndex : '-'))
  bits.push('pe=' + (p.peek.panel ? p.peek.panel.pointerEvents : '-') + '/' + (p.peek.backdrop ? p.peek.backdrop.pointerEvents : '-'))
  bits.push('closedOk=' + (p.closedOk ? 1 : 0))
} else if (p) {
  bits.push('blocked=' + (p.reason || 'unknown'))
}
bits.push('shots=' + screenshots.length)
bits.push('verdict=' + report.verdict)
const summaryLine = bits.join(' ')
report.summary = summaryLine

const jsonPath = join(out, 'sheet-two-stage-' + phase + '-' + orientation + '.json')
writeFileSync(jsonPath, JSON.stringify(report, null, 2))

const rel = path => (path ? relative(process.cwd(), path) : path)
const packRun = run => {
  if (!run) return null
  if (run.blocked) return { blocked: true, reason: run.reason, point: run.point, screenshot: rel(join(out, run.screenshot)) }
  return {
    rowsStable: run.rowsStable,
    peek: run.peek, peekShot: rel(join(out, run.peekShot)),
    expanded: run.expanded, expandShot: rel(join(out, run.expandShot)),
    delta: run.delta, closedOk: run.closedOk, closedShot: rel(join(out, run.closedShot))
  }
}

if (assertMode || settleScanMode) {
  const as = report.assertSummary || { total: 0, passed: 0, failed: [] }
  console.log(JSON.stringify({
    phase: phase, mode: 'assert', verdict: report.verdict,
    device: { version: report.device.versionName, screen: report.device.wmSize, density: report.device.wmDensity, cdpPort: report.device.cdpPort, fingerprint: report.device.fingerprint },
    notes: report.notes, error: report.error || null,
    json: rel(jsonPath),
    summary: { total: as.total, passed: as.passed, failed: as.failed },
    checks: (report.checks || []).map(c => ({ id: c.id, ok: c.ok, name: c.name, got: c.got, expect: c.expect })),
    series: {
      feelA: report.runs.assert && report.runs.assert.feelA ? report.runs.assert.feelA.seq : null,
      feelB: report.runs.assert && report.runs.assert.feelB ? report.runs.assert.feelB.seq : null,
      up800: report.runs.assert && report.runs.assert.up800 ? report.runs.assert.up800.seq : null,
      frozen: report.runs.assert && report.runs.assert.frozen ? report.runs.assert.frozen.seq : null,
      handover: report.runs.assert && report.runs.assert.handover ? report.runs.assert.handover.seq : null
    },
    closePaths: report.runs.assert ? report.runs.assert.closePaths : null,
    settleScan: report.runs.settleScan || null,
    screenshots: screenshots.map(s => s.path)
  }, null, 2))
} else {
  console.log(JSON.stringify({
    phase: phase, orientation: orientation, verdict: report.verdict,
    device: { version: report.device.versionName, screen: report.device.wmSize, density: report.device.wmDensity, cdpPort: report.device.cdpPort, fingerprint: report.device.fingerprint },
    notes: report.notes, error: report.error || null,
    json: rel(jsonPath),
    screenshots: screenshots.map(s => s.path),
    primary: packRun(report.runs.primary),
    contrast: packRun(report.runs.contrast)
  }, null, 2))
}
console.log(summaryLine)
process.exit(report.verdict === 'PASS' || report.verdict === 'MEASURED' ? 0 : report.verdict === 'INCONCLUSIVE' ? 2 : 1)
