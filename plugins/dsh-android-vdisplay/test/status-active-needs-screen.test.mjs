// issue #1211：vdisplay 自报 `active`/`ready` **不等于**有对应屏幕。
//
// 旧实现把载荷自报的 state 直接当 ok:true，从不与 screens 对账：
//   {state:'active', displayId:7, screens:[{alias:'real',displayId:0}]} -> ok:true（7 不在 screens 里）
//   {state:'active', screens:[]}                                   -> ok:true（空集也报已激活）
// 影响：模型被告知虚拟屏可用并据此下发 vdInput/vdLaunch，随后拿到壳侧失败回执——先假成功再失败。
//
// 判据（行为，import 构建产物）：ok 必须有功能证据 = 已注册屏幕里有它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotFromRaw } from '../lib/status.js'

const real = { alias: 'real', displayId: 0, kind: 'real', label: 'real', state: 'on', width: 1080, height: 2400, densityDpi: 440, selectable: true, reason: '' }
const vd25 = { alias: 'vd25', displayId: 25, kind: 'virtual', label: 'vd25', state: 'on', width: 800, height: 600, densityDpi: 160, selectable: true, reason: '' }

test('判据 1：displayId 不在 screens 里 → 不得 ok:true', () => {
  const out = snapshotFromRaw({ enabled: true, state: 'active', displayId: 7, screens: [real] })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'vdisplay-display-missing')
  assert.match(out.guidance, /displayId=7/)
})

test('判据 2：screens 为空 → 不得 ok:true（active 与 ready 都是）', () => {
  for (const state of ['active', 'ready']) {
    const out = snapshotFromRaw({ enabled: true, state, screens: [] })
    assert.equal(out.ok, false, state + ' 不得报 ok')
    assert.equal(out.code, 'vdisplay-no-screens')
  }
})

test('判据 3：自报 active 但无 displayId → 专用 code，且不与「未创建/未开启」混', () => {
  const out = snapshotFromRaw({ enabled: true, state: 'active', screens: [real] })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'vdisplay-display-missing')
  assert.notEqual(out.code, 'vdisplay-disabled')
  assert.notEqual(out.code, 'vdisplay-blocked')
  assert.notEqual(out.code, 'vdisplay-ok')
})

test('正向：active 且 displayId 在 screens 里 → ok:true（不是恒红）', () => {
  const out = snapshotFromRaw({ enabled: true, state: 'active', displayId: 25, screens: [real, vd25] })
  assert.equal(out.ok, true)
  assert.equal(out.displayId, 25)
})

test('正向：ready + 有屏幕（尚未建屏）→ ok:true', () => {
  const out = snapshotFromRaw({ enabled: true, state: 'ready', screens: [real] })
  assert.equal(out.ok, true)
  assert.equal(out.state, 'ready')
})

test('既有 fail-closed 不受影响：blocked / disabled 仍 ok:false', () => {
  assert.equal(snapshotFromRaw({ enabled: true, state: 'blocked', screens: [] }).ok, false)
  assert.equal(snapshotFromRaw({ enabled: false, state: 'disabled', screens: [] }).ok, false)
})