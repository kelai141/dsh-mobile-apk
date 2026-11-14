#!/usr/bin/env node
// Explicit ADB user-layer helper, not a substitute for Kotlin/CDP/real-task acceptance.
// Default: inspect only. Prepare a benign background app and enable v2 before gestures.
// node scripts/verify-overlay-v2.mjs --serial <serial> [--out <dir>] [--inspect]
// node scripts/verify-overlay-v2.mjs --serial <serial> --scenario gestures [--top-idle-ms 1200]
// node scripts/verify-overlay-v2.mjs --serial <serial> --scenario latest-ui
// latest-ui: DEBUG APK with native Service.dump; prepare nonempty real draft, card+composer, closed sheet.
// Uses actual tagged View bounds for taps; files picker CANCEL only. Does not type/send/select files.
// JSON hashes draft text; screenshots still contain visible user content. Keep evidence private.
// Both gesture scenarios require DEBUG native readback. Exit 2 = prerequisite unavailable, never PASS.
// node scripts/verify-overlay-v2.mjs --self-test  (mock only; never calls ADB)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const SLOTS = ['halo', 'entry', 'recall', 'card', 'pill', 'composer', 'workspace', 'session', 'drawer']
const NATIVE_DUMP_MARKER = 'DSH_OVERLAY_V2_DUMP='
const prerequisite = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { inconclusive: true }) }
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
const safeSerial = value => typeof value === 'string' && /^[A-Za-z0-9_.:\[\]-]{1,160}$/.test(value)

export function parseArgs(argv) {
  const options = { inspect: true, serial: '', out: '', scenario: '', topIdleMs: 1200, selfTest: false }
  let explicitInspect = false
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--self-test') options.selfTest = true
    else if (key === '--inspect') explicitInspect = true
    else {
      requireThat(['--serial', '--out', '--scenario', '--top-idle-ms'].includes(key), 'Unknown option: ' + key)
      const value = argv[++i]
      requireThat(value && !value.startsWith('--'), 'Missing value for ' + key)
      if (key === '--serial') options.serial = value
      if (key === '--out') options.out = value
      if (key === '--scenario') options.scenario = value
      if (key === '--top-idle-ms') options.topIdleMs = Number(value)
    }
  }
  requireThat(!options.scenario || ['gestures', 'latest-ui'].includes(options.scenario), 'Only --scenario gestures|latest-ui is supported')
  requireThat(!(explicitInspect && options.scenario), '--inspect cannot be combined with --scenario')
  requireThat(Number.isInteger(options.topIdleMs) && options.topIdleMs >= 500 && options.topIdleMs <= 60_000, 'top-idle-ms must be 500..60000')
  requireThat(options.selfTest || safeSerial(options.serial), 'An explicit safe --serial is required')
  requireThat(!options.selfTest || !options.scenario, '--self-test cannot operate a device')
  options.inspect = !options.scenario
  return options
}

export function createAdb(serial, { spawn = spawnSync, executable = 'adb' } = {}) {
  requireThat(safeSerial(serial), 'Unsafe serial')
  const commands = []
  const call = args => {
    requireThat(Array.isArray(args) && args.every(x => typeof x === 'string' && !x.includes('\0')), 'Invalid ADB arguments')
    const argv = ['-s', serial, ...args]
    const result = spawn(executable, argv, { shell: false, encoding: null, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    commands.push({ argv, status: result.status ?? null, signal: result.signal ?? null, error: result.error?.code ?? null })
    requireThat(!result.error && result.status === 0 && !result.signal, 'ADB failed: ' + args.join(' ') + ' (exit=' + result.status + ', signal=' + (result.signal ?? 'none') + ', error=' + (result.error?.code ?? 'none') + ')')
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '')
  }
  return { commands, binary: call, text: args => call(args).toString('utf8') }
}

function rect(values) {
  const [left, top, right, bottom] = values.map(Number)
  requireThat([left, top, right, bottom].every(Number.isSafeInteger) && right > left && bottom > top, 'Invalid window rectangle')
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

export function parseWindowDump(dump) {
  requireThat(typeof dump === 'string' && dump.length <= 16 * 1024 * 1024, 'Invalid or oversized window dump')
  const windows = {}
  const blocks = dump.split(/(?=^[ \t]*Window #\d+ Window\{)/m).filter(block => /^[ \t]*Window #\d+ Window\{/m.test(block))
  for (const block of blocks) {
    const heading = block.split('\n')[0]
    const tokens = [...heading.matchAll(/(?:^|\s)dsh-overlay-v2-(halo|entry|recall|card|pill|composer|workspace|session|drawer)(?=[\s}'"]|$)/g)].map(m => m[1])
    const attrsStart = block.indexOf('mAttrs={')
    let attrs = ''
    if (attrsStart >= 0) {
      let depth = 0
      for (let index = attrsStart + 'mAttrs='.length; index < block.length; index++) {
        if (block[index] === '{') depth++
        if (block[index] === '}' && --depth === 0) { attrs = block.slice(attrsStart, index + 1); break }
      }
    }
    for (const match of attrs.matchAll(/\btitle=(?:["'])?dsh-overlay-v2-(halo|entry|recall|card|pill|composer|workspace|session|drawer)(?=[\s}'"]|$)/g)) tokens.push(match[1])
    const titles = [...new Set(tokens)]
    if (titles.length === 0) continue
    requireThat(titles.length === 1, 'Ambiguous v2 window titles')
    const slot = titles[0]
    requireThat(!windows[slot], 'Duplicate v2 window slot: ' + slot)
    requireThat(/\bmDisplayId=0(?:\s|$)/m.test(block), slot + ': expected display 0')
    const matches = [...block.matchAll(/(?:\bmFrame=|\bframe=)\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g)]
    const rectMatches = [...block.matchAll(/\bmFrame=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/g)]
    const frames = [...matches, ...rectMatches].map(m => rect(m.slice(1)))
    requireThat(frames.length > 0, slot + ': no actual frame (requested x/y are not evidence)')
    requireThat(frames.every(frame => JSON.stringify(frame) === JSON.stringify(frames[0])), slot + ': conflicting actual frames')
    const parentMatch = block.match(/\bparent=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
    const windowId = heading.match(/Window\{([^\s}]+)/)?.[1]
    requireThat(windowId, slot + ': missing actual Window identity')
    windows[slot] = { slot, windowId, frame: frames[0], parent: parentMatch ? rect(parentMatch.slice(1)) : null }
  }
  return windows
}

const canonicalComponent = component => {
  const [pkg, name] = component.split('/')
  return pkg + '/' + (name.startsWith('.') ? pkg + name : name)
}
export function parseForeground(windowDump, activityDump = '') {
  const matches = [...windowDump.matchAll(/^[ \t]*mCurrentFocus=Window\{[^\n}]*?\s([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)(?=[\s}])/gm)]
  requireThat(matches.length <= 1, 'Ambiguous focused window evidence')
  if (matches.length) return { component: matches[0][1], source: 'dumpsys window windows:mCurrentFocus' }
  const displays = activityDump.split(/(?=^Display #\d+ \(activities from top to bottom\):)/m)
  const primary = displays.find(block => /^Display #0 \(activities from top to bottom\):/m.test(block))
  if (!primary) return { component: null, source: null }
  const resumed = [...primary.matchAll(/^[ \t]*topResumedActivity=ActivityRecord\{[^\n}]*?\s([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)(?=[\s}])/gm)].map(match => match[1])
  const components = [...new Set(resumed)]
  requireThat(components.length <= 1, 'Ambiguous display 0 topResumedActivity evidence')
  return { component: components[0] ?? null, source: components.length ? 'dumpsys activity activities:Display #0 topResumedActivity' : null }
}
export function pickerWindowReady(windowDump, component) {
  if (!component || !/(?:^|\.)documentsui\/.*(?:PickActivity|DocumentsActivity)$/.test(component)) return false
  const windows = windowDump.split(/(?=^[ \t]*Window #\d+ Window\{)/m).filter(block => /^[ \t]*Window #\d+ Window\{/m.test(block))
  return windows.some(block => {
    const heading = block.split('\n')[0]
    const match = heading.match(/\s([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)(?=[\s}])/)
    return match && canonicalComponent(match[1]) === canonicalComponent(component) && /\bmDisplayId=0(?:\s|$)/m.test(block) && /\bisReadyForDisplay\(\)=true\b/.test(block) && /\bSurface: shown=true\s+mDrawState=HAS_DRAWN\b/.test(block)
  })
}

export function parseDensity(text) {
  const matches = [...String(text).matchAll(/(?:Physical|Override) density:\s*(\d+)/g)]
  requireThat(matches.length > 0, 'wm density unavailable')
  const dpi = Number(matches.at(-1)[1])
  requireThat(dpi >= 72 && dpi <= 1280, 'Unsupported density')
  return dpi / 160
}

export function pngSize(png) {
  requireThat(Buffer.isBuffer(png) && png.length >= 24 && png.subarray(0, 8).equals(PNG_SIGNATURE) && png.toString('ascii', 12, 16) === 'IHDR', 'screencap did not return PNG')
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  requireThat(width >= 100 && height >= 100 && width <= 16384 && height <= 16384, 'Invalid screenshot dimensions')
  return { width, height }
}

export function validateWindows(windows, screen, required = []) {
  for (const slot of required) requireThat(windows[slot], 'Missing required window: ' + slot)
  for (const [slot, { frame }] of Object.entries(windows)) {
    requireThat(SLOTS.includes(slot), 'Unknown window slot')
    requireThat(frame.left >= 0 && frame.top >= 0 && frame.right <= screen.width && frame.bottom <= screen.height, slot + ': actual frame is outside screenshot screen')
  }
  requireThat(!(windows.card && windows.pill), 'Card and pill must not coexist')
  requireThat(Object.keys(windows).length <= 9, 'Unexpected v2 window count')
  requireThat(!windows.drawer || windows.composer, 'Sheet exists without composer')
  requireThat((!windows.workspace && !windows.session) || (windows.workspace && windows.session && windows.composer), 'Independent chip windows must occur as a pair with composer')
  return windows
}

export function center(frame) { return { x: Math.floor((frame.left + frame.right) / 2), y: Math.floor((frame.top + frame.bottom) / 2) } }
export function validatePoint(point, screen) {
  requireThat(Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.y >= 0 && point.x < screen.width && point.y < screen.height, 'Input point outside actual screen')
  return point
}

// Identity/draft evidence must come from the running DEBUG service, never inferred from WM geometry.
export function parseNativeDump(text) {
  requireThat(typeof text === 'string' && text.length <= 1024 * 1024, 'Invalid native diagnostic dump')
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(NATIVE_DUMP_MARKER))
  if (!lines.length) return null
  requireThat(lines.length === 1, 'Ambiguous native diagnostic dumps')
  let data
  try { data = JSON.parse(lines[0].slice(NATIVE_DUMP_MARKER.length)) } catch { throw new Error('Malformed native diagnostic JSON') }
  if (data?.schemaVersion === 1 && data.available === false) return null
  requireThat(data?.schemaVersion === 1 && Number.isSafeInteger(data.processId) && data.processId > 0, 'Unsupported native diagnostic schema/process identity')
  requireThat(typeof data.pickerActive === 'boolean' && data.views && typeof data.views === 'object' && !Array.isArray(data.views), 'Incomplete native diagnostic state')
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  const views = {}
  requireThat(Object.keys(data.views).length <= 9, 'Too many native view slots')
  for (const [slot, view] of Object.entries(data.views)) {
    requireThat(SLOTS.includes(slot) && identity(view?.viewId) && typeof view.attached === 'boolean' && Number.isInteger(view.flags) && Number.isFinite(view.alpha) && view.alpha >= 0 && view.alpha <= 1, 'Invalid native view diagnostic')
    views[slot] = { viewId: view.viewId, attached: view.attached, flags: view.flags, alpha: view.alpha }
  }
  const draft = data.draft
  requireThat(draft && typeof draft.sessionId === 'string' && draft.sessionId.length <= 512 && typeof draft.text === 'string' && draft.text.length <= 65536, 'Missing native draft evidence')
  requireThat(Number.isInteger(draft.selectionStart) && Number.isInteger(draft.selectionEnd) && draft.selectionStart >= 0 && draft.selectionEnd >= 0 && draft.selectionStart <= draft.text.length && draft.selectionEnd <= draft.text.length, 'Invalid native draft selection')
  requireThat(Array.isArray(draft.attachmentIds) && draft.attachmentIds.length <= 128 && draft.attachmentIds.every(identity), 'Invalid native attachment identities')
  requireThat(Array.isArray(data.nodes) && data.nodes.length <= 2048, 'Missing native tagged View evidence')
  const nodes = data.nodes.map(node => {
    requireThat(typeof node?.tag === 'string' && node.tag.length <= 256 && identity(node.viewId), 'Invalid native tagged View')
    const b = node.bounds
    requireThat(b && [b.left, b.top, b.right, b.bottom].every(Number.isSafeInteger) && b.right >= b.left && b.bottom >= b.top, 'Invalid native View bounds')
    return { tag: node.tag, viewId: node.viewId, bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }
  })
  const motion = data.motion ?? null
  if (motion) for (const key of ['topLimitPx', 'cardCollapseDistancePx', 'topTolerancePx', 'topFadeDistancePx']) requireThat(Number.isFinite(motion[key]) && motion[key] >= 0 && motion[key] <= 32768, 'Invalid native motion config ' + key)
  return { schemaVersion: 1, processId: data.processId, pickerActive: data.pickerActive, motion, views, draft: { sessionId: draft.sessionId, text: draft.text, selectionStart: draft.selectionStart, selectionEnd: draft.selectionEnd, attachmentIds: [...draft.attachmentIds] }, nodes }
}

export function redactNativeDump(data) {
  if (!data) return null
  const { text, ...draft } = data.draft
  return { ...data, draft: { ...draft, textLength: text.length, textSha256: createHash('sha256').update(text).digest('hex') } }
}

export function nativeNode(data, tag) {
  const nodes = data?.nodes.filter(node => node.tag === tag) ?? []
  prerequisite(nodes.length === 1, 'Need one observed native View tagged ' + tag)
  return nodes[0]
}

export function validateChipWindows(windows, native) {
  for (const slot of ['workspace', 'session']) {
    if (!windows[slot]) continue
    const node = nativeNode(native, 'overlay-composer-' + slot)
    const view = native.views[slot]
    const f = windows[slot].frame, b = node.bounds
    requireThat(view?.attached && view.viewId === node.viewId, slot + ': chip must be its actual independent native root')
    requireThat(['left', 'top', 'right', 'bottom'].every(key => f[key] === b[key]), slot + ': Window frame exceeds actual bounded chip View')
  }
  if (windows.workspace && windows.session) requireThat(windows.workspace.frame.right <= windows.session.frame.left || windows.session.frame.right <= windows.workspace.frame.left, 'Independent chip frames overlap')
}

export function assertNativePreserved(before, after, { restoreFlags = false } = {}) {
  requireThat(before && after && before.processId === after.processId, 'Native process changed; View identities are not comparable')
  requireThat(JSON.stringify(before.draft) === JSON.stringify(after.draft), 'Native session/text/selection/attachments changed')
  for (const [slot, original] of Object.entries(before.views)) {
    requireThat(original.attached, slot + ': baseline native View is not attached')
    const view = after.views[slot]
    requireThat(view?.attached && view.viewId === original.viewId, slot + ': native View was detached/recreated')
    if (restoreFlags) requireThat(view.flags === original.flags && view.alpha === original.alpha, slot + ': original interaction flags/alpha not restored')
  }
  const originalInput = nativeNode(before, 'overlay-composer-input')
  const input = nativeNode(after, 'overlay-composer-input')
  requireThat(originalInput.viewId === input.viewId, 'Native editor View was recreated')
  requireThat(JSON.stringify(originalInput.bounds) === JSON.stringify(input.bounds), 'Native editor moved or resized')
}

// These are physical test probes, not confirmed product thresholds. No speed predicate is asserted.
export function handleGesture(frame, screen, action, motion = null, handleBounds = null) {
  const d = screen.density
  const start = handleBounds ? center(handleBounds) : { x: center(frame).x, y: Math.round(frame.bottom - 22 * d) }
  requireThat(start.y > frame.top && start.y < frame.bottom, 'Card too short for handle')
  const distances = { down: 36, restore: -30, collapse: -(motion ? Math.ceil(motion.cardCollapseDistancePx / d + 8) : 100) }
  requireThat(Object.hasOwn(distances, action), 'Unknown handle gesture')
  const end = { x: start.x, y: Math.round(start.y + distances[action] * d) }
  if (action === 'collapse') prerequisite(end.y >= 0, 'Actual card handle has insufficient physical upward travel for observed collapse distance; prepare taller real history, never inject negative coordinates')
  validatePoint(start, screen); validatePoint(end, screen)
  return { start, end, durationMs: action === 'collapse' ? 900 : 300, holdMs: action === 'collapse' ? 750 : 0 }
}

export function pillGesture(frame, screen, action, motion = null) {
  const x = center(frame).x
  let start, end
  if (action === 'top') {
    // Read the running build's provisional stop; do not invent product thresholds.
    start = center(frame)
    end = { x, y: Math.round(start.y - (frame.top - (motion?.topLimitPx ?? 0))) }
  } else if (action === 'away') {
    start = center(frame)
    end = { x, y: Math.min(screen.height - frame.height, Math.round(start.y + 120 * screen.density)) }
    prerequisite(end.y > start.y, 'Not enough reachable downward capsule travel')
  } else {
    requireThat(action === 'dismiss', 'Unknown pill gesture')
    start = { x, y: frame.bottom - 2 }
    end = { x, y: 1 }
    prerequisite(start.y > end.y, 'Not enough reachable in-screen upward capsule travel')
  }
  validatePoint(start, screen); validatePoint(end, screen)
  return { start, end, durationMs: 900, holdMs: 0 }
}

// One DOWN/UP with slow MOVE samples; unlike two swipes this preserves longpress and continued push.
export function touchSequence(gesture, screen) {
  validatePoint(gesture.start, screen); validatePoint(gesture.end, screen)
  requireThat(Number.isInteger(gesture.durationMs) && gesture.durationMs >= 100 && gesture.durationMs <= 10000 && Number.isInteger(gesture.holdMs ?? 0) && (gesture.holdMs ?? 0) >= 0 && (gesture.holdMs ?? 0) <= 10000, 'Invalid bounded touch duration')
  const events = [{ action: 'DOWN', point: gesture.start, waitMs: gesture.holdMs ?? 0 }]
  const count = Math.ceil(gesture.durationMs / 60)
  for (let i = 1; i <= count; i++) events.push({ action: 'MOVE', point: validatePoint({ x: Math.round(gesture.start.x + (gesture.end.x - gesture.start.x) * i / count), y: Math.round(gesture.start.y + (gesture.end.y - gesture.start.y) * i / count) }, screen), waitMs: gesture.durationMs / count })
  events.push({ action: 'UP', point: gesture.end, waitMs: 0 })
  return events
}

export function outsidePoint(windows, screen) {
  const margin = Math.ceil(48 * screen.density)
  const safe = { left: margin, top: margin, right: screen.width - margin, bottom: screen.height - margin }
  requireThat(safe.right > safe.left && safe.bottom > safe.top, 'No benign in-screen point outside overlay frames')
  // Partition the bounded safe screen by every actual obstacle edge. Membership is constant
  // within each cell, so a finite midpoint scan cannot miss a free rectangle like the old grid.
  const obstacles = Object.values(windows).map(({ frame }) => frame)
  const xs = [...new Set([safe.left, safe.right, ...obstacles.flatMap(f => [Math.max(safe.left, Math.min(safe.right, f.left)), Math.max(safe.left, Math.min(safe.right, f.right))])])].sort((a, b) => a - b)
  const ys = [...new Set([safe.top, safe.bottom, ...obstacles.flatMap(f => [Math.max(safe.top, Math.min(safe.bottom, f.top)), Math.max(safe.top, Math.min(safe.bottom, f.bottom))])])].sort((a, b) => a - b)
  let best = null
  for (let x = 1; x < xs.length; x++) for (let y = 1; y < ys.length; y++) {
    const width = xs[x] - xs[x - 1], height = ys[y] - ys[y - 1]
    if (width <= 0 || height <= 0) continue
    const point = { x: Math.floor((xs[x - 1] + xs[x]) / 2), y: Math.floor((ys[y - 1] + ys[y]) / 2) }
    if (obstacles.some(f => point.x >= f.left && point.x < f.right && point.y >= f.top && point.y < f.bottom)) continue
    const area = width * height
    if (!best || area > best.area) best = { point, area }
  }
  requireThat(best, 'No benign in-screen point outside overlay frames')
  return validatePoint(best.point, screen)
}

export async function runVerification(options, { adb, write, settle = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const latest = options.scenario === 'latest-ui'
  const readNative = Boolean(options.scenario)
  const report = { mode: options.scenario || 'inspect', status: 'RUNNING', scope: 'Physical ADB inputs + observed WM/native evidence only; not full three-layer acceptance', steps: [], checks: [], limitations: ['No CDP/session/Agent/backend correctness is inferred.', 'Outside tap propagation and IME visibility require screenshot/human confirmation.', 'Snapshots do not prove frame-time, nonlinear motion continuity, Markdown fidelity or absence of invisible hit areas.', 'Short top idle does not prove 60s idle.', 'latest-ui covers file picker cancellation only, not successful append, camera/photo, rotation or late receipt.'] }
  let current
  const snapshot = label => {
    const image = adb.binary(['exec-out', 'screencap', '-p'])
    const size = pngSize(image)
    const density = parseDensity(adb.text(['shell', 'wm', 'density']))
    requireThat(/(?:Physical|Override) size:\s*\d+x\d+/.test(adb.text(['shell', 'wm', 'size'])), 'wm size unavailable')
    const screen = { ...size, density }
    const windowDump = adb.text(['shell', 'dumpsys', 'window', 'windows'])
    const windows = validateWindows(parseWindowDump(windowDump), screen)
    let foreground = parseForeground(windowDump)
    if (latest && !foreground.component) foreground = parseForeground(windowDump, adb.text(['shell', 'dumpsys', 'activity', 'activities']))
    const focusedComponent = foreground.component
    const focusedSource = foreground.source
    const pickerReady = pickerWindowReady(windowDump, focusedComponent)
    const native = readNative ? parseNativeDump(adb.text(['shell', 'dumpsys', 'activity', 'service', 'com.dsharnessmobile.shell/.OverlayService'])) : null
    if (native) validateChipWindows(windows, native)
    const stem = 'ui-' + String(report.steps.length).padStart(2, '0') + '-' + label
    write(stem + '.png', image)
    const evidence = { screen, windows, focusedComponent, focusedSource, pickerReady, ...(readNative ? { native: redactNativeDump(native) } : {}) }
    write(stem + '.json', JSON.stringify(evidence, null, 2))
    current = { screen, windows, native, focusedComponent, focusedSource, pickerReady }
    report.steps.push({ label, screenshot: stem + '.png', structure: stem + '.json', ...evidence })
    return current
  }
  const expected = (present, absent = []) => {
    const required = present.includes('composer') ? [...new Set([...present, 'workspace', 'session'])] : present
    const forbidden = absent.includes('composer') ? [...new Set([...absent, 'workspace', 'session'])] : absent
    validateWindows(current.windows, current.screen, required)
    for (const slot of forbidden) requireThat(!current.windows[slot], 'Window should be removed: ' + slot)
  }
  const input = async (args, label, wait = 450) => {
    adb.text(['shell', 'input', ...args.map(String)])
    await settle(wait)
    return snapshot(label)
  }
  const tap = (point, label) => { validatePoint(point, current.screen); return input(['tap', point.x, point.y], label) }
  const swipe = (gesture, label) => {
    validatePoint(gesture.start, current.screen); validatePoint(gesture.end, current.screen)
    return input(['swipe', gesture.start.x, gesture.start.y, gesture.end.x, gesture.end.y, gesture.durationMs], label)
  }
  const touch = async (gesture, label) => {
    const events = touchSequence(gesture, current.screen)
    let down = false
    try {
      for (const [index, event] of events.entries()) {
        adb.text(['shell', 'input', 'touchscreen', 'motionevent', event.action, String(event.point.x), String(event.point.y)])
        down = event.action !== 'UP'
        if (index === Math.floor(events.length / 2)) snapshot(label + '-mid-drag')
        if (event.waitMs) await settle(event.waitMs)
      }
    } finally {
      if (down) adb.text(['shell', 'input', 'touchscreen', 'motionevent', 'UP', String(gesture.end.x), String(gesture.end.y)])
    }
    await settle(450)
    return snapshot(label)
  }
  const sameWindow = (before, slot) => {
    const a = before.windows[slot], b = current.windows[slot]
    requireThat(a && b && a.windowId === b.windowId, slot + ': actual Window was replaced')
    requireThat(JSON.stringify(a.frame) === JSON.stringify(b.frame), slot + ': actual frame moved/resized')
  }
  const openCard = async label => { expected(['entry'], ['card', 'pill', 'composer', 'drawer']); await tap(center(current.windows.entry.frame), label); expected(['entry', 'card'], ['pill', 'composer', 'drawer']) }
  const handleProbe = action => handleGesture(current.windows.card.frame, current.screen, action, current.native.motion, nativeNode(current.native, 'overlay-card-handle').bounds)
  const closeCard = async label => {
    expected(['entry', 'card'], ['composer', 'drawer'])
    await tap(center(current.windows.entry.frame), label) // Removed top X is never a target.
    expected(['entry'], ['card', 'pill', 'composer', 'drawer'])
  }
  try {
    snapshot('initial')
    if (!options.scenario) { report.status = 'INSPECTED'; return report }
    if (latest) {
      prerequisite(current.native, 'Install DEBUG APK exposing DSH_OVERLAY_V2_DUMP; WM frames alone cannot prove same View/draft')
      prerequisite(current.windows.entry && current.windows.card && current.windows.composer && current.windows.workspace && current.windows.session && !current.windows.drawer && !current.windows.pill && !current.native.pickerActive, 'Prepare entry+card+composer with sheet/picker closed over a benign background app')
      prerequisite(current.native.draft.sessionId && current.native.draft.text.length > 0, 'Prepare a real nonempty text draft and session via user/ADB input; verifier never fabricates draft evidence')
      const before = current
      const tapNode = async (tag, slot, label) => {
        const node = nativeNode(current.native, tag)
        const point = validatePoint(center(node.bounds), current.screen)
        const f = current.windows[slot]?.frame
        prerequisite(f && point.x >= f.left && point.x < f.right && point.y >= f.top && point.y < f.bottom, 'Observed ' + tag + ' is not a visible hit target inside ' + slot)
        return tap(point, label)
      }
      await tapNode('overlay-composer-plus', 'composer', 'sheet-open')
      expected(['entry', 'card', 'composer', 'drawer'], ['pill'])
      for (const slot of Object.keys(before.windows)) sameWindow(before, slot)
      assertNativePreserved(before.native, current.native, { restoreFlags: true })
      const c = current.windows.composer.frame, d = current.windows.drawer.frame
      requireThat(Math.max(c.left, d.left) < Math.min(c.right, d.right) && Math.max(c.top, d.top) < Math.min(c.bottom, d.bottom), 'Sheet does not overlap original composer frame')
      report.checks.push('F35 actual composer/chip frames/Windows/Views/editor unchanged; independent sheet overlaps input')
      const pickerBefore = current
      await tapNode('overlay-drawer-attach-file', 'drawer', 'file-picker-open')
      expected(['entry', 'card', 'composer', 'drawer'], ['pill'])
      for (let attempt = 0; attempt < 6 && current.native?.pickerActive && !current.pickerReady; attempt++) {
        await settle(300) // Bounded UI readiness samples, never synthesize focus or treat lease as launch proof.
        snapshot('file-picker-readiness-' + attempt)
      }
      requireThat(current.native?.pickerActive === true, 'File picker interaction lease not observed; do not infer from tap alone')
      prerequisite(current.focusedComponent && /(?:^|\.)documentsui\/.*(?:PickActivity|DocumentsActivity)$/.test(current.focusedComponent), 'Need observed focused DocumentsUI file picker; lease alone is not proof. OEM chooser/permission screen needs manual confirmation before cancellation')
      prerequisite(current.pickerReady, 'DocumentsUI resumed/focused but no actual display 0 shown HAS_DRAWN picker Window within bounded readiness samples')
      for (const slot of Object.keys(pickerBefore.windows)) sameWindow(pickerBefore, slot)
      assertNativePreserved(pickerBefore.native, current.native)
      for (const slot of Object.keys(pickerBefore.native.views)) requireThat((current.native.views[slot]?.flags & 0x18) === 0x18, slot + ': did not yield focus/touch to system picker')
      report.checks.push('F33 picker active with same attached native Views, draft/selection/session/refs and actual frames')
      await input(['keyevent', 'KEYCODE_BACK'], 'file-picker-cancel', 900)
      requireThat(current.native?.pickerActive === false, 'Picker cancellation not observed after BACK')
      expected(['entry', 'card', 'composer', 'drawer'], ['pill'])
      requireThat(!current.focusedComponent || !/(?:^|\.)documentsui\//.test(current.focusedComponent), 'System file picker still focused after cancellation')
      for (const slot of Object.keys(pickerBefore.windows)) sameWindow(pickerBefore, slot)
      assertNativePreserved(pickerBefore.native, current.native, { restoreFlags: true })
      report.checks.push('F33 cancellation preserves original draft and restores original per-window flags/alpha')
      // All observed pre-picker windows (including sheet) must retain their original identities.
      await tap(outsidePoint(current.windows, current.screen), 'outside-bottom-only')
      expected(['entry', 'card'], ['composer', 'drawer', 'pill'])
      sameWindow(before, 'card')
      requireThat(current.native?.processId === before.native.processId && current.native.views.card?.viewId === before.native.views.card.viewId, 'Outside tap replaced native card')
      requireThat(JSON.stringify(current.native.draft) === JSON.stringify(before.native.draft), 'Outside tap changed original draft/session/selection/refs')
      report.checks.push('F17 middle blank closes bottom only; original top Window/View and draft remain')
      report.status = 'LATEST_UI_SCOPED_PASSED'
      return report
    }
    prerequisite(current.native?.motion, 'Gestures require DEBUG native motion readback; no fixed thresholds or fake stop evidence')
    expected(['entry'])
    // Normalize only overlay UI; no app launch/prefs/backend/force-stop mutations.
    if (current.windows.composer) { await tap(outsidePoint(current.windows, current.screen), 'normalize-bottom-outside'); expected(['entry'], ['composer', 'drawer']) }
    if (current.windows.pill) await tap(center(current.windows.pill.frame), 'normalize-capsule-open')
    if (current.windows.card) await closeCard('normalize-entry-toggle-close')
    await openCard('entry-tap')
    await closeCard('entry-toggle-close')
    await openCard('outside-top-open')
    const outsideBefore = current
    await tap(outsidePoint(current.windows, current.screen), 'outside-keeps-top')
    expected(['entry', 'card'], ['pill', 'composer', 'drawer']); sameWindow(outsideBefore, 'card')
    const entry = center(current.windows.entry.frame)
    await swipe({ start: entry, end: entry, durationMs: 750 }, 'entry-longpress')
    expected(['entry', 'card', 'composer'], ['pill'])
    const bottomBefore = current
    await tap(outsidePoint(current.windows, current.screen), 'outside-bottom-only')
    expected(['entry', 'card'], ['composer', 'drawer', 'pill']); sameWindow(bottomBefore, 'card')
    const initialHeight = current.windows.card.frame.height
    await swipe(handleProbe('down'), 'handle-down')
    expected(['entry', 'card'], ['pill'])
    requireThat(current.windows.card.frame.height > initialHeight, 'Down handle did not expand actual card frame')
    const expandedHeight = current.windows.card.frame.height
    await swipe(handleProbe('restore'), 'handle-restore')
    requireThat(current.windows.card?.frame.height < expandedHeight, 'Up handle did not restore actual card frame')
    const help = adb.text(['shell', 'input'])
    prerequisite(/motionevent/.test(help), 'Android input motionevent is required for one held slow DOWN/MOVE/UP; no fast-fling fallback')
    await touch(handleProbe('collapse'), 'handle-held-slow-up')
    expected(['entry', 'pill'], ['card', 'composer', 'drawer'])
    requireThat(current.windows.pill.frame.width >= current.screen.width * 0.6, 'Collapsed output is not a long capsule')
    await touch(pillGesture(current.windows.pill.frame, current.screen, 'away', current.native.motion), 'capsule-move-away-from-top')
    const capsule = current.windows.pill
    await touch(pillGesture(capsule.frame, current.screen, 'top', current.native.motion), 'capsule-reach-top')
    expected(['entry', 'pill'], ['card', 'composer', 'drawer'])
    requireThat(Math.abs(current.windows.pill.frame.top - current.native.motion.topLimitPx) <= 1, 'Capsule did not reach observed native top limit')
    await settle(options.topIdleMs ?? 1200)
    snapshot('capsule-top-idle'); expected(['entry', 'pill'], ['card', 'composer', 'drawer'])
    await tap(center(current.windows.pill.frame), 'capsule-tap-restore-card')
    expected(['entry', 'card'], ['pill', 'composer', 'drawer'])
    const secondEntry = center(current.windows.entry.frame)
    await swipe({ start: secondEntry, end: secondEntry, durationMs: 750 }, 'linkage-open-bottom')
    expected(['entry', 'card', 'composer'], ['pill', 'drawer'])
    await touch(handleProbe('collapse'), 'linkage-held-slow-collapse')
    expected(['entry', 'pill', 'composer'], ['card', 'drawer'])
    await touch(pillGesture(current.windows.pill.frame, current.screen, 'away', current.native.motion), 'linkage-capsule-move-away')
    requireThat(current.windows.pill?.frame.top > current.native.motion.topLimitPx, 'Capsule did not move below top before continuous probe')
    // Starts below top; one DOWN continues through top contact and distance-only dismissal.
    await touch(pillGesture(current.windows.pill.frame, current.screen, 'dismiss'), 'capsule-continuous-top-distance-push')
    expected(['entry'], ['card', 'pill', 'composer', 'drawer'])
    for (let i = 0; i < 3; i++) { await openCard('repeat-open-' + i); await closeCard('repeat-entry-toggle-close-' + i) }
    report.checks.push('F04/F06/F17: real entry toggles/longpress and bottom-only outside; F20/F23/F24 slow held probes reached terminal states')
    report.limitations.push('Separate first top-idle probe plus one-DOWN continuous reach/push and open-bottom removal prove observed terminal states only, not tolerance alpha/rebound/CANCEL, ongoing Agent/draft preservation or IME disappearance. Those require additional native in-gesture/manual evidence.')
    report.status = 'GESTURES_SCOPED_PASSED'
    return report
  } catch (error) {
    report.status = error.inconclusive ? 'INCONCLUSIVE' : 'FAILED'
    report.error = error.message
    throw Object.assign(error, { report })
  } finally {
    write('report.json', JSON.stringify(report, null, 2))
    write('commands.json', JSON.stringify(adb.commands ?? [], null, 2))
  }
}

export function selfTest() {
  const dump = '  Window #0 Window{a u0 dsh-overlay-v2-entry}:\n mDisplayId=0\n Frames: parent=[0,0][1080,1920] display=[0,0][1080,1920] frame=[980,400][1030,450]\n'
  assert.equal(parseWindowDump(dump).entry.frame.top, 400)
  assert.throws(() => parseWindowDump(dump + dump), /Duplicate/)
  assert.throws(() => parseWindowDump(dump.replace('frame=[980,400][1030,450]', 'requested=[980,400][1030,450]')), /no actual frame/)
  assert.throws(() => createAdb('mock', { spawn: () => ({ status: 1, stdout: Buffer.from('looks good') }) }).text(['shell', 'wm', 'size']), /ADB failed/)
  assert.throws(() => validateWindows({}, { width: 1080, height: 1920 }, ['entry']), /Missing/)
  assert.throws(() => validatePoint({ x: 10, y: -1 }, { width: 1080, height: 1920 }), /outside/)
  assert.equal(parseArgs(['--serial', 'mock']).inspect, true)
  assert.equal(parseDensity('Physical density: 320\nOverride density: 240'), 1.5)
  return { status: 'SELF_TEST_PASSED', checks: 8, deviceCommands: 0 }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfTest) { console.log(JSON.stringify(selfTest(), null, 2)); return }
  const out = path.resolve(options.out || path.join('.deploy-tmp', 'overlay-v2-' + new Date().toISOString().replace(/[:.]/g, '-')))
  fs.mkdirSync(out, { recursive: true })
  const write = (name, data) => fs.writeFileSync(path.join(out, name), data)
  const report = await runVerification(options, { adb: createAdb(options.serial), write })
  console.log(JSON.stringify({ status: report.status, mode: report.mode, steps: report.steps.length, out, scope: report.scope }, null, 2))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('OVERLAY-V2 ' + (error.inconclusive ? 'INCONCLUSIVE' : 'FAILED') + ': ' + error.message); process.exitCode = error.inconclusive ? 2 : 1 })
}
