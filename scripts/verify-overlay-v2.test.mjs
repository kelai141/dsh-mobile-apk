import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseArgs, createAdb, parseWindowDump, parseDensity, pngSize, validateWindows,
  validatePoint, handleGesture, pillGesture, touchSequence, runVerification, selfTest, outsidePoint,
  parseNativeDump, redactNativeDump, assertNativePreserved, validateChipWindows, parseForeground, pickerWindowReady,
} from './verify-overlay-v2.mjs'

// All devices and native diagnostics in this file are fixtures, NOT device acceptance.
const frame = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top })
function png(width, height) {
  const result = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(result)
  result.write('IHDR', 12); result.writeUInt32BE(width, 16); result.writeUInt32BE(height, 20)
  return result
}
function dumpOf(windows, screen, attrs = false) {
  return Object.entries(windows).map(([slot, f], index) =>
    '  Window #' + index + ' Window{window-' + slot + ' u0 ' + (attrs ? 'com.dsharnessmobile.shell' : 'dsh-overlay-v2-' + slot) + '}:\n' +
    '    mDisplayId=0 mSession=Session{opaque}\n' +
    '    mAttrs={(0,0)(wrapxwrap) ty=APPLICATION_OVERLAY' + (attrs ? ' title=dsh-overlay-v2-' + slot : '') + '}\n' +
    '    Frames: parent=[0,' + Math.round(24 * screen.density) + '][' + screen.width + ',' + screen.height + '] display=[0,0][' + screen.width + ',' + screen.height + '] frame=[' + f.left + ',' + f.top + '][' + f.right + ',' + f.bottom + ']\n',
  ).join('')
}
function mockDevice({ width = 1080, height = 1920, density = 2, bug = '', attrs = false, latest = false, diagnostics = true, motion = true, noWindowFocus = false, delayedPicker = false } = {}) {
  const screen = { width, height, density }, d = density, top = Math.round(24 * d), pillTop = top + Math.round(8 * d)
  const card = () => frame(Math.round(12 * d), top + Math.round(8 * d), width - Math.round(12 * d), top + Math.round(148 * d))
  const composer = frame(Math.round(12 * d), height - Math.round(110 * d), width - Math.round(12 * d), height - Math.round(12 * d))
  const entry = frame(width - Math.round(60 * d), Math.round(height * 0.6), width - Math.round(26 * d), Math.round(height * 0.6 + 34 * d))
  const chips = { workspace: frame(composer.left, composer.top - Math.round(42 * d), composer.left + Math.round(100 * d), composer.top - Math.round(10 * d)), session: frame(composer.left + Math.round(108 * d), composer.top - Math.round(42 * d), composer.left + Math.round(220 * d), composer.top - Math.round(10 * d)) }
  let windows = latest ? { entry, card: card(), composer: { ...composer }, ...chips } : { entry }
  const writes = new Map(), inputs = []
  let now = 0, drag = null, pickerActive = false, changed = false, pickerReads = 0
  const contains = (f, x, y) => f && x >= f.left && x < f.right && y >= f.top && y < f.bottom
  const draft = { sessionId: 'session-real-fixture', text: 'sensitive fixture draft', selectionStart: 3, selectionEnd: 8, attachmentIds: ['ref-1'] }
  const inputBounds = frame(composer.left + Math.round(56 * d), composer.top + Math.round(40 * d), composer.right - Math.round(56 * d), composer.bottom - Math.round(8 * d))
  const plusBounds = frame(composer.left + Math.round(4 * d), inputBounds.top, inputBounds.left, inputBounds.bottom)
  const fileBounds = () => frame(width - Math.round(130 * d), height - Math.round(180 * d), width - Math.round(16 * d), height - Math.round(130 * d))
  const native = () => ({
    motion: { topLimitPx: pillTop, cardCollapseDistancePx: 84 * d, topTolerancePx: 12 * d, topFadeDistancePx: 28 * d },
    schemaVersion: 1, processId: bug === 'restarted-process' && changed ? 999 : 123,
    pickerActive,
    views: Object.fromEntries(Object.keys(windows).map(slot => [slot, {
      viewId: slot + ((bug === 'recreated-view' && changed && slot === 'composer') || (bug === 'recreated-chip' && changed && slot === 'workspace') ? '-new' : '-original'),
      attached: !(bug === 'detached-view' && changed && slot === 'composer'),
      flags: pickerActive ? 0x18 : ((bug === 'flags-not-restored' && changed && slot === 'composer') || (bug === 'chip-flags-not-restored' && changed && slot === 'session') ? 0x18 : 0),
      alpha: pickerActive ? 0.2 : (bug === 'alpha-not-restored' && changed && slot === 'composer' ? 0.2 : 1),
    }])),
    draft: { ...draft,
      text: bug === 'changed-text' && changed ? 'different' : draft.text,
      sessionId: bug === 'changed-session' && changed ? 'other-session' : draft.sessionId,
      selectionStart: bug === 'changed-selection' && changed ? 2 : draft.selectionStart,
      attachmentIds: bug === 'lost-attachment' && changed ? [] : draft.attachmentIds,
    },
    nodes: [
      ...['workspace', 'session'].filter(slot => windows[slot]).map(slot => ({ tag: 'overlay-composer-' + slot, viewId: slot + (bug === 'recreated-chip' && changed && slot === 'workspace' ? '-new' : '-original'), bounds: chips[slot] })),
      ...(windows.card ? [{ tag: 'overlay-card-handle', viewId: 'original-handle', bounds: frame(windows.card.left, windows.card.bottom - Math.round(44 * d), windows.card.right, windows.card.bottom) }] : []),
      { tag: 'overlay-composer-input', viewId: bug === 'recreated-editor' && changed ? 'new-editor' : 'original-editor', bounds: inputBounds },
      { tag: 'overlay-composer-plus', viewId: 'original-plus', bounds: plusBounds },
      ...(windows.drawer ? [{ tag: 'overlay-drawer-attach-file', viewId: 'file-tile', bounds: fileBounds() }] : []),
    ],
  })
  const spawn = (_exe, argv, options) => {
    assert.equal(options.shell, false)
    assert.ok(options.timeout > 0 && options.timeout <= 20_000)
    const args = argv.slice(2)
    let output = ''
    if (args.join(' ') === 'exec-out screencap -p') output = png(width, height)
    else if (args.join(' ') === 'shell wm density') output = 'Physical density: ' + Math.round(160 * d)
    else if (args.join(' ') === 'shell wm size') output = 'Physical size: ' + Math.min(width, height) + 'x' + Math.max(width, height)
    else if (args.join(' ') === 'shell dumpsys window windows') {
      output = dumpOf(windows, screen, attrs)
      const focused = pickerActive ? (bug === 'picker-focus-unproven' ? 'com.android.permissioncontroller/.GrantPermissionsActivity' : 'com.android.documentsui/.picker.PickActivity') : 'com.example.background/.MainActivity'
      if (!noWindowFocus) output += 'mCurrentFocus=Window{focus u0 ' + focused + '}\n'
      if (pickerActive) {
        pickerReads++
        const ready = bug !== 'picker-never-drawn' && (!delayedPicker || pickerReads >= 3)
        output += '  Window #99 Window{picker u0 com.android.documentsui/com.android.documentsui.picker.PickActivity}:\n mDisplayId=0\n mHasSurface=true isReadyForDisplay()=' + ready + '\n Surface: shown=' + ready + ' mDrawState=' + (ready ? 'HAS_DRAWN' : 'DRAW_PENDING') + '\n'
      }
      if (bug === 'duplicate' && windows.card) output += dumpOf({ card: windows.card }, screen)
    } else if (args.join(' ') === 'shell dumpsys activity activities') {
      output = 'ACTIVITY MANAGER ACTIVITIES\nDisplay #0 (activities from top to bottom):\n topResumedActivity=ActivityRecord{actual u0 ' + (pickerActive ? 'com.android.documentsui/.picker.PickActivity' : 'com.example.background/.MainActivity') + ' t14}\n'
    } else if (args.join(' ') === 'shell dumpsys activity service com.dsharnessmobile.shell/.OverlayService') {
      output = diagnostics ? 'DSH_OVERLAY_V2_DUMP=' + JSON.stringify(native()) : 'No services match'
    } else if (args.join(' ') === 'shell input') output = motion ? 'motionevent <DOWN|UP|MOVE>' : 'tap swipe keyevent'
    else if (args[0] === 'shell' && args[1] === 'input') {
      inputs.push(args.slice(2))
      const action = args[2]
      if (action === 'keyevent') {
        assert.equal(args[3], 'KEYCODE_BACK')
        if (pickerActive) { pickerActive = false; if (bug === 'picker-removes-sheet') delete windows.drawer }
        else if (windows.composer) { delete windows.composer; delete windows.drawer; delete windows.workspace; delete windows.session }
        else delete windows.card
      } else if (action === 'tap') {
        const [x, y] = args.slice(3).map(Number)
        validatePoint({ x, y }, screen)
        if (latest && windows.composer && contains(plusBounds, x, y) && !windows.drawer) {
          windows.drawer = frame(Math.round(12 * d), height - Math.round(220 * d), width - Math.round(12 * d), height - Math.round(8 * d))
          if (bug === 'sheet-shifts-chip') windows.workspace = frame(chips.workspace.left, chips.workspace.top - 5, chips.workspace.right, chips.workspace.bottom - 5)
          if (bug === 'sheet-shifts-composer') windows.composer = frame(composer.left, composer.top - 100, composer.right, composer.bottom - 100)
          if (bug === 'sheet-does-not-overlap') windows.drawer = frame(12, top + 10, width - 12, composer.top - 10)
        } else if (latest && windows.drawer && contains(fileBounds(), x, y)) {
          pickerActive = bug !== 'picker-not-launched'; changed = true
          if (bug === 'picker-removes-composer') delete windows.composer
          if (bug === 'picker-removes-chip') delete windows.session
        } else if (contains(windows.entry, x, y)) {
          if (windows.card) delete windows.card
          else windows.card = card()
        } else if (contains(windows.pill, x, y)) { delete windows.pill; windows.card = card() }
        else { delete windows.composer; delete windows.drawer; if (bug !== 'outside-leaves-chip') { delete windows.workspace; delete windows.session }; if (bug === 'outside-closes-top') delete windows.card }
      } else if (action === 'swipe') {
        const [x1, y1, x2, y2, duration] = args.slice(3).map(Number)
        validatePoint({ x: x1, y: y1 }, screen); validatePoint({ x: x2, y: y2 }, screen)
        if (x1 === x2 && y1 === y2 && duration >= 500) { windows.card = card(); windows.composer = { ...composer }; Object.assign(windows, chips) }
        else if (contains(windows.card, x1, y1)) {
          if (y2 - y1 > 24 * d) windows.card = frame(windows.card.left, windows.card.top, windows.card.right, windows.card.top + Math.floor(height * 0.4))
          else if (y2 - y1 < -24 * d) windows.card = card()
        } else throw new Error('Mock swipe did not hit expected frame')
      } else if (action === 'touchscreen' && args[3] === 'motionevent') {
        const type = args[4], [x, y] = args.slice(5).map(Number)
        validatePoint({ x, y }, screen)
        if (type === 'DOWN') {
          const slot = contains(windows.card, x, y) ? 'card' : contains(windows.pill, x, y) ? 'pill' : ''
          assert.ok(slot, 'physical DOWN must hit observed card/capsule')
          drag = { slot, original: { ...windows[slot] }, startY: y, downAt: now, lastY: y }
        } else {
          assert.ok(drag)
          drag.lastY = y
          const dy = y - drag.startY
          if (type === 'UP') {
            if (drag.slot === 'card' && now - drag.downAt >= 750 && dy < -60 * d) {
              if (bug !== 'slow-collapse-broken') { delete windows.card; windows.pill = frame(Math.round(12 * d), drag.original.top, width - Math.round(12 * d), drag.original.top + Math.round(44 * d)) }
            } else if (drag.slot === 'pill') {
              const wantedTop = drag.original.top + dy
              if ((bug === 'auto-hide' && wantedTop <= pillTop) || (wantedTop < pillTop - 24 * d && bug !== 'no-dismiss')) {
                delete windows.pill
                if (bug !== 'bottom-not-linked') { delete windows.composer; delete windows.drawer; if (bug !== 'capsule-leaves-chip') { delete windows.workspace; delete windows.session } }
              } else windows.pill = frame(drag.original.left, Math.max(pillTop, wantedTop), drag.original.right, Math.max(pillTop, wantedTop) + drag.original.height)
            }
            drag = null
          }
        }
      } else throw new Error('Unexpected input: ' + action)
    } else throw new Error('Unexpected mock ADB command: ' + args.join(' '))
    return { status: 0, signal: null, stdout: Buffer.isBuffer(output) ? output : Buffer.from(output) }
  }
  return { adb: createAdb('mock', { spawn }), write: (name, data) => writes.set(name, data), settle: async ms => { now += ms }, writes, inputs, screen, native }
}

test('self-test never invokes real ADB', () => {
  assert.deepEqual(selfTest(), { status: 'SELF_TEST_PASSED', checks: 8, deviceCommands: 0 })
})
test('CLI defaults inspect and requires explicit bounded scenario consent', () => {
  assert.equal(parseArgs(['--serial', '127.0.0.1:16416']).inspect, true)
  for (const scenario of ['gestures', 'latest-ui']) assert.equal(parseArgs(['--serial', '[::1]:5555', '--scenario', scenario]).inspect, false)
  for (const args of [[], ['--serial', 'x;touch'], ['--serial', 'ok', '--scenario', 'anything'], ['--serial', 'ok', '--inspect', '--scenario', 'gestures'], ['--self-test', '--scenario', 'latest-ui'], ['--serial', 'ok', '--top-idle-ms', 'Infinity']]) assert.throws(() => parseArgs(args))
})
test('exact actual frame/Window token and sheet are parsed, requested placement is not evidence', () => {
  const screen = { width: 1200, height: 800, density: 1.5 }
  for (const attrs of [false, true]) {
    const dump = dumpOf({ entry: frame(1000, 300, 1050, 350) }, screen, attrs)
    assert.equal(parseWindowDump(dump).entry.frame.left, 1000)
    assert.equal(parseWindowDump(dump).entry.windowId, 'window-entry')
    assert.throws(() => parseWindowDump(dump.replace('frame=[1000,300][1050,350]', 'requested=[1000,300][1050,350]')), /actual frame/)
  }
  const windows = { entry: frame(1000, 300, 1050, 350), card: frame(20, 40, 1180, 200), composer: frame(20, 650, 1180, 780), drawer: frame(20, 500, 1180, 790) }
  assert.deepEqual(Object.keys(validateWindows(parseWindowDump(dumpOf(windows, screen)), screen)), Object.keys(windows))
  assert.throws(() => validateWindows({ drawer: { frame: windows.drawer } }, screen), /without composer/)
  const chips = { workspace: frame(20, 590, 160, 638), session: frame(172, 590, 340, 638) }
  for (const attrs of [false, true]) assert.deepEqual(Object.keys(validateWindows(parseWindowDump(dumpOf({ ...windows, ...chips }, screen, attrs)), screen)), [...Object.keys(windows), 'workspace', 'session'])
  assert.throws(() => validateWindows(parseWindowDump(dumpOf({ workspace: chips.workspace, composer: windows.composer }, screen)), screen), /as a pair/)
})
test('malicious/ambiguous dumps cannot manufacture evidence', () => {
  const screen = { width: 1080, height: 1920, density: 2 }
  const dump = dumpOf({ entry: frame(980, 400, 1030, 450) }, screen)
  assert.throws(() => parseWindowDump(dump + dump), /Duplicate/)
  assert.throws(() => parseWindowDump(dump.replace('mDisplayId=0', 'mDisplayId=1')), /display 0/)
  assert.throws(() => parseWindowDump(dump + '    mFrame=[0,0][1,1]\n'), /conflicting/)
  assert.equal(Object.keys(parseWindowDump(dump.replace('dsh-overlay-v2-entry', 'dsh-overlay-v2-entry-evil'))).length, 0)
  assert.equal(Object.keys(parseWindowDump(dump.replace('dsh-overlay-v2-entry', 'other').replace('Frames:', 'debug title=dsh-overlay-v2-entry\n Frames:'))).length, 0)
  assert.throws(() => validateWindows(parseWindowDump(dump.replace('[980,400]', '[-1,400]')), screen), /outside/)
  assert.throws(() => validateWindows({}, screen, ['entry']), /Missing/)
})
test('ADB failure cannot masquerade as valid stdout', () => {
  for (const result of [{ status: 1 }, { status: null }, { status: 0, signal: 'SIGTERM' }, { status: 0, error: { code: 'ETIMEDOUT' } }]) {
    const adb = createAdb('mock', { spawn: () => ({ ...result, stdout: Buffer.from('Physical size: 1080x1920') }) })
    assert.throws(() => adb.text(['shell', 'wm', 'size']), /ADB failed/)
    assert.equal(adb.commands.length, 1)
  }
})
test('screen orientation is PNG-derived; bad screenshot/density fail closed', () => {
  assert.deepEqual(pngSize(png(1920, 1080)), { width: 1920, height: 1080 })
  assert.equal(parseDensity('Physical density: 320\nOverride density: 240'), 1.5)
  assert.throws(() => pngSize(Buffer.from('error: offline')), /PNG/)
  assert.throws(() => parseDensity(''), /density/)
})
test('held slow collapse has one DOWN/UP and all MOVE samples are in actual screen', () => {
  for (const screen of [{ width: 900, height: 1600, density: 1.5 }, { width: 1600, height: 900, density: 1.5 }, { width: 1080, height: 1920, density: 2 }]) {
    const f = frame(18, 48, screen.width - 18, 380)
    const gesture = handleGesture(f, screen, 'collapse')
    assert.ok(gesture.holdMs >= 750)
    assert.ok(gesture.durationMs >= 900)
    const events = touchSequence(gesture, screen)
    assert.equal(events.filter(e => e.action === 'DOWN').length, 1)
    assert.equal(events.filter(e => e.action === 'UP').length, 1)
    assert.equal(events[0].waitMs, gesture.holdMs)
    for (const event of events) validatePoint(event.point, screen)
    const p = pillGesture(frame(300, 36, 600, 36 + 44 * screen.density), screen, 'dismiss')
    assert.ok(p.durationMs >= 900, 'distance probe must not require old 1ms velocity')
    validatePoint(p.start, screen); validatePoint(p.end, screen)
  }
  assert.throws(() => handleGesture(frame(10, 0, 200, 60), { width: 400, height: 800, density: 2 }, 'collapse'), /outside|short|insufficient/)
  assert.throws(() => validatePoint({ x: 10, y: -1 }, { width: 400, height: 800 }), /outside/)
})
test('capsule reach-top aligns physical top without artificial overshoot', () => {
  const screen = { width: 1600, height: 900, density: 1.5 }
  const f = frame(300, 200, 600, 266)
  const gesture = pillGesture(f, screen, 'top')
  assert.equal(f.top + gesture.end.y - gesture.start.y, 0)
  assert.ok(gesture.end.y >= 0)
})
test('native evidence requires schema/process/draft/selection/real identities; reports redact text', () => {
  const raw = mockDevice({ latest: true }).native()
  const dump = 'Service:\n DSH_OVERLAY_V2_DUMP=' + JSON.stringify(raw)
  const parsed = parseNativeDump(dump)
  assert.equal(parsed.draft.text, raw.draft.text)
  assert.equal(parseNativeDump('No services match'), null)
  assert.ok(!JSON.stringify(redactNativeDump(parsed)).includes(raw.draft.text))
  assert.equal(redactNativeDump(parsed).draft.textSha256.length, 64)
  assert.throws(() => parseNativeDump(dump + '\n' + dump), /Ambiguous/)
  for (const mutate of [x => { delete x.processId }, x => { x.schemaVersion = 2 }, x => { x.draft.selectionEnd = 999 }, x => { x.views.card.viewId = '' }]) {
    const invalid = structuredClone(raw); mutate(invalid)
    assert.throws(() => parseNativeDump('DSH_OVERLAY_V2_DUMP=' + JSON.stringify(invalid)))
  }
  const restarted = structuredClone(parsed); restarted.processId++
  assert.throws(() => assertNativePreserved(parsed, restarted), /process changed/)
})
test('outside point scans genuine landscape picker geometry missed by normalized grid', () => {
  const screen = { width: 1600, height: 900, density: 1.5 }
  const frames = { card: frame(18, 48, 1582, 192), entry: frame(831, 533, 882, 584), composer: frame(18, 798, 1582, 882), workspace: frame(18, 738, 144, 786), session: frame(156, 738, 260, 786), drawer: frame(18, 555, 1582, 900) }
  const windows = Object.fromEntries(Object.entries(frames).map(([slot, f]) => [slot, { frame: f }]))
  const point = outsidePoint(windows, screen)
  assert.ok(point.y >= 192 && point.y < 533, 'use observed real middle gap, not sheet or status/edge')
  assert.ok(point.x >= 72 && point.x < 1528 && point.y >= 72 && point.y < 828)
  for (const f of Object.values(frames)) assert.ok(point.x < f.left || point.x >= f.right || point.y < f.top || point.y >= f.bottom)
})
test('outside point fails closed with genuinely no safe free cell and never uses excluded edge slivers', () => {
  const screen = { width: 1600, height: 900, density: 1.5 }
  assert.throws(() => outsidePoint({ full: { frame: frame(0, 0, 1600, 900) } }, screen), /No benign/)
  assert.throws(() => outsidePoint({ center: { frame: frame(72, 72, 1528, 828) } }, screen), /No benign/)
})
test('default inspect performs no input or native draft read', async () => {
  const mock = mockDevice()
  const report = await runVerification(parseArgs(['--serial', 'mock']), mock)
  assert.equal(report.status, 'INSPECTED')
  assert.equal(report.steps.length, 1)
  assert.equal(mock.inputs.length, 0)
  assert.ok(mock.writes.has('ui-00-initial.png'))
  assert.ok(!JSON.stringify(report).includes('Session{opaque}'))
})
for (const orientation of [{ width: 1080, height: 1920, density: 2 }, { width: 1920, height: 1080, density: 1.5, attrs: true }]) {
  test('fixture gesture state machine adapts to ' + orientation.width + 'x' + orientation.height, async () => {
    const mock = mockDevice(orientation)
    const report = await runVerification(parseArgs(['--serial', 'mock', '--scenario', 'gestures']), mock)
    assert.equal(report.status, 'GESTURES_SCOPED_PASSED')
    assert.ok(report.steps.some(s => s.label === 'capsule-top-idle'))
    assert.ok(report.steps.some(s => s.label === 'handle-held-slow-up-mid-drag'))
    assert.deepEqual(Object.keys(report.steps.at(-1).windows), ['entry'])
    assert.ok(mock.inputs.every(args => !args.includes('text')))
    assert.ok(mock.writes.has('commands.json'))
  })
  test('fixture latest-ui uses native real-tap coordinates and genuine comparator contract ' + orientation.width + 'x' + orientation.height, async () => {
    const mock = mockDevice({ ...orientation, latest: true })
    const report = await runVerification(parseArgs(['--serial', 'mock', '--scenario', 'latest-ui']), mock)
    assert.equal(report.status, 'LATEST_UI_SCOPED_PASSED')
    assert.equal(report.checks.length, 4)
    assert.deepEqual(mock.inputs.map(args => args[0]), ['tap', 'tap', 'keyevent', 'tap'])
    assert.ok(mock.inputs.every(args => !args.includes('text')))
    for (const [name, data] of mock.writes) if (name.endsWith('.json')) assert.ok(!String(data).includes('sensitive fixture draft'))
  })
}
for (const bug of ['duplicate', 'outside-closes-top', 'slow-collapse-broken', 'auto-hide', 'no-dismiss', 'bottom-not-linked', 'capsule-leaves-chip']) {
  test('controlled fixture gesture negative: ' + bug, async () => {
    const mock = mockDevice({ bug })
    await assert.rejects(runVerification(parseArgs(['--serial', 'mock', '--scenario', 'gestures']), mock))
    assert.equal(JSON.parse(mock.writes.get('report.json')).status, 'FAILED')
  })
}
for (const bug of ['sheet-shifts-composer', 'sheet-shifts-chip', 'sheet-does-not-overlap', 'picker-not-launched', 'picker-removes-composer', 'picker-removes-sheet', 'picker-removes-chip', 'recreated-chip', 'chip-flags-not-restored', 'outside-leaves-chip', 'recreated-view', 'detached-view', 'recreated-editor', 'restarted-process', 'changed-text', 'changed-session', 'changed-selection', 'lost-attachment', 'flags-not-restored', 'alpha-not-restored', 'outside-closes-top']) {
  test('controlled fixture latest-ui negative: ' + bug, async () => {
    const mock = mockDevice({ bug, latest: true })
    await assert.rejects(runVerification(parseArgs(['--serial', 'mock', '--scenario', 'latest-ui']), mock))
    assert.equal(JSON.parse(mock.writes.get('report.json')).status, 'FAILED')
  })
}
test('real Android display-0 topResumed format works only as explicit fallback, never activity history', () => {
  const activity = 'ACTIVITY MANAGER ACTIVITIES\nDisplay #0 (activities from top to bottom):\n    topResumedActivity=ActivityRecord{243636369 u0 com.android.documentsui/.picker.PickActivity t14}\n    * Hist #1 ActivityRecord{old u0 com.example/.Old t10}\n'
  assert.deepEqual(parseForeground('WINDOW MANAGER WINDOWS\n', activity), { component: 'com.android.documentsui/.picker.PickActivity', source: 'dumpsys activity activities:Display #0 topResumedActivity' })
  assert.equal(parseForeground('', activity.replace('topResumedActivity=', 'mLastPausedActivity=')).component, null)
  assert.equal(parseForeground('', activity.replace('Display #0', 'Display #1')).component, null)
  const current = 'mCurrentFocus=Window{focus u0 com.android.permissioncontroller/.GrantPermissionsActivity}\n'
  assert.equal(parseForeground(current, activity).component, 'com.android.permissioncontroller/.GrantPermissionsActivity', 'never override contrary current focus with resumed fallback')
  assert.throws(() => parseForeground('', activity + ' topResumedActivity=ActivityRecord{other u0 com.other/.Foreground t15}\n'), /Ambiguous/)
})
test('picker readiness requires actual matching shown HAS_DRAWN display-0 Window, not resumed name alone', () => {
  const component = 'com.android.documentsui/.picker.PickActivity'
  const dump = '  Window #12 Window{6461a50 u0 com.android.documentsui/com.android.documentsui.picker.PickActivity}:\n mDisplayId=0\n mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false\n Surface: shown=true mDrawState=HAS_DRAWN mLastHidden=false\n'
  assert.equal(pickerWindowReady(dump, component), true)
  for (const altered of [dump.replace('mDisplayId=0', 'mDisplayId=1'), dump.replace('shown=true', 'shown=false'), dump.replace('HAS_DRAWN', 'DRAW_PENDING'), dump.replace('isReadyForDisplay()=true', 'isReadyForDisplay()=false'), dump.replaceAll('com.android.documentsui.picker.PickActivity', 'com.android.documentsui.OldActivity')]) assert.equal(pickerWindowReady(altered, component), false)
  assert.equal(pickerWindowReady(dump, 'com.example/.Other'), false)
})
test('missing WM focus falls back to observed topResumed and waits for drawn picker with bounded samples', async () => {
  const mock = mockDevice({ latest: true, noWindowFocus: true, delayedPicker: true })
  const report = await runVerification(parseArgs(['--serial', 'mock', '--scenario', 'latest-ui']), mock)
  assert.equal(report.status, 'LATEST_UI_SCOPED_PASSED')
  const picker = report.steps.filter(step => step.label.startsWith('file-picker-'))
  assert.ok(picker.some(step => step.focusedSource === 'dumpsys activity activities:Display #0 topResumedActivity' && step.pickerReady))
  assert.ok(picker.some(step => step.label.startsWith('file-picker-readiness-')))
  assert.equal(mock.inputs.filter(args => args[0] === 'keyevent').length, 1)
})
test('resumed picker that never draws is INCONCLUSIVE after six samples, never cancelled or passed', async () => {
  const mock = mockDevice({ latest: true, noWindowFocus: true, bug: 'picker-never-drawn' })
  await assert.rejects(runVerification(parseArgs(['--serial', 'mock', '--scenario', 'latest-ui']), mock), error => error.inconclusive === true)
  const report = JSON.parse(mock.writes.get('report.json'))
  assert.equal(report.status, 'INCONCLUSIVE')
  assert.equal(report.steps.filter(step => step.label.startsWith('file-picker-readiness-')).length, 6)
  assert.deepEqual(mock.inputs.map(args => args[0]), ['tap', 'tap'])
})
test('missing diagnostics is INCONCLUSIVE before any input, never same-View PASS from WM alone', async () => {
  const mock = mockDevice({ latest: true, diagnostics: false })
  await assert.rejects(runVerification(parseArgs(['--serial', 'mock', '--scenario', 'latest-ui']), mock), error => error.inconclusive === true)
  assert.equal(mock.inputs.length, 0)
  assert.equal(JSON.parse(mock.writes.get('report.json')).status, 'INCONCLUSIVE')
})
test('focused permission/unknown chooser is INCONCLUSIVE, lease alone cannot prove picker', async () => {
  const mock = mockDevice({ latest: true, bug: 'picker-focus-unproven' })
  await assert.rejects(runVerification(parseArgs(['--serial', 'mock', '--scenario', 'latest-ui']), mock), error => error.inconclusive === true)
  assert.deepEqual(mock.inputs.map(args => args[0]), ['tap', 'tap'], 'never BACK an unproven foreground activity')
  assert.equal(JSON.parse(mock.writes.get('report.json')).status, 'INCONCLUSIVE')
})
test('unavailable v2 diagnostics is absent evidence; malformed motion is not accepted', () => {
  assert.equal(parseNativeDump('DSH_OVERLAY_V2_DUMP=' + JSON.stringify({ schemaVersion: 1, available: false })), null)
  const raw = mockDevice({ latest: true }).native()
  raw.motion.topLimitPx = -1
  assert.throws(() => parseNativeDump('DSH_OVERLAY_V2_DUMP=' + JSON.stringify(raw)), /motion config/)
})
test('independent chips require native roots matching actual Window bounds, not a transparent union row', () => {
  const raw = mockDevice({ latest: true }).native()
  const windows = Object.fromEntries(['workspace', 'session'].map(slot => { const b = raw.nodes.find(node => node.tag === 'overlay-composer-' + slot).bounds; return [slot, { frame: frame(b.left, b.top, b.right, b.bottom) }] }))
  validateChipWindows(windows, raw)
  windows.workspace.frame.right += 1
  assert.throws(() => validateChipWindows(windows, raw), /exceeds actual bounded/)
})
test('native motion readback plans reachable distances without treating values as product acceptance', () => {
  const screen = { width: 1080, height: 1920, density: 2 }
  const motion = { topLimitPx: 64, cardCollapseDistancePx: 168, topTolerancePx: 24, topFadeDistancePx: 56 }
  const card = frame(24, 64, 1056, 640), handle = frame(24, 552, 1056, 640)
  const g = handleGesture(card, screen, 'collapse', motion, handle)
  assert.equal(g.start.y, 596)
  assert.ok(g.start.y - g.end.y > motion.cardCollapseDistancePx)
  const p = pillGesture(frame(24, 300, 1056, 388), screen, 'top', motion)
  assert.equal(300 + p.end.y - p.start.y, motion.topLimitPx)
  assert.throws(() => handleGesture(frame(24, 64, 1056, 150), screen, 'collapse', motion), error => error.inconclusive === true)
})
test('unsupported single-pointer injection is INCONCLUSIVE, no velocity fallback', async () => {
  const mock = mockDevice({ motion: false })
  await assert.rejects(runVerification(parseArgs(['--serial', 'mock', '--scenario', 'gestures']), mock), error => error.inconclusive === true)
  assert.equal(mock.inputs.filter(args => args.includes('motionevent')).length, 0)
  assert.equal(JSON.parse(mock.writes.get('report.json')).status, 'INCONCLUSIVE')
})
