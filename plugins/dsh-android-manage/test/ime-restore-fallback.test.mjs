// 输入法还原的第三条路（issue #1371，2026-11-04 维护者裁定）。
//
// 不切不行：不切换 ⇒ 本通道键盘没被激活 ⇒ 广播拿 imeNotReady，文本注入整条失效，
// 而那批设备（读回值 null/非组件形态）正是本 issue 的现场。
// 也不能切换了不管还原：那正是原来的伤害（用户输入法被劫持）。
//
// 判据落在纯函数上（import 构建产物 ../lib；test 脚本里 `npm run build &&` 保证产物在）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveImeRestoreTarget, restorableImeId } from '../lib/ime-broadcast.js'

const SELF = 'com.dsharnessmobile.shell/.AdbKeyboardService'

test('能读到 prev：还原 prev（source=readback）', () => {
  const r = resolveImeRestoreTarget('com.example/.MyIme', 'com.other/.X\n', SELF)
  assert.deepEqual(r, { id: 'com.example/.MyIme', source: 'readback' })
})

test('prev 不可读但 ime list -s 有另一条：用它兜底（source=fallback）', () => {
  const r = resolveImeRestoreTarget('null', 'com.other/.X\n' + SELF + '\n', SELF)
  assert.deepEqual(r, { id: 'com.other/.X', source: 'fallback' })
})

test('两边都空：承认无法还原（source=none），调用方仍会切换', () => {
  const r = resolveImeRestoreTarget('', SELF + '\n', SELF)
  assert.deepEqual(r, { id: '', source: 'none' })
})

test('本通道自己永远不作为还原目标', () => {
  const r = resolveImeRestoreTarget(SELF, SELF + '\n', SELF)
  assert.deepEqual(r, { id: '', source: 'none' })
})

test('形态判据：null / 空 / 非组件都不可还原', () => {
  assert.equal(restorableImeId('null'), false)
  assert.equal(restorableImeId('  '), false)
  assert.equal(restorableImeId('com.example'), false)
  assert.equal(restorableImeId('com.example/.MyIme'), true)
})

test('接线：prev 为空也必须切换（否则广播拿 imeNotReady，注入整条失效）', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('const needSwitch = prev !== IME_ID'), 'prev 为空时也必须是 needSwitch=true')
  assert.ok(src.includes('const canRestore = prev.length > 0'), '还原资格与切换资格必须分开')
  assert.ok(src.includes('ime list -s'), '读回不可用时必须查已启用列表兜底')
  assert.ok(src.includes('if (needSwitch && canRestore)'), '还原只在有目标时才做')
  assert.ok(src.includes('未能还原'), '两边都空时回执必须明写未能还原')
})