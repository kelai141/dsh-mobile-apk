// 输入法还原的第三条路（issue #1371，2026-11-04 维护者裁定）+ 兜底排序（issue #1517）。
//
// 不切不行：不切换 ⇒ 本通道键盘没被激活 ⇒ 广播拿 imeNotReady，文本注入整条失效，
// 而那批设备（读回值 null/非组件形态）正是本 issue 的现场。
// 也不能切换了不管还原：那正是原来的伤害（用户输入法被劫持）。
//
// 判据落在纯函数上（import 构建产物 ../lib；test 脚本里 `npm run build &&` 保证产物在）。
// 原来这里还有一条读 src/index.ts 文本的「接线」断言（`src.includes('needSwitch = prev !== IME_ID')`），
// 改一行注释就能让它失真——已换成驱动真工具的行为判据，见 ime-borrow-window.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createImeHistory,
  normalizeImeId,
  rankImeRestoreCandidates,
  resolveImeRestoreTarget,
  restorableImeId,
} from '../lib/ime-broadcast.js'

const SELF = 'com.dsharnessmobile.shell/.AdbKeyboardService'
const SELF_FULL = 'com.dsharnessmobile.shell/com.dsharnessmobile.shell.AdbKeyboardService'

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

test('本通道自己永远不作为还原目标（短形态与全形态都算）', () => {
  assert.deepEqual(resolveImeRestoreTarget(SELF, SELF + '\n', SELF), { id: '', source: 'none' })
  assert.deepEqual(resolveImeRestoreTarget(SELF_FULL, SELF + '\n', SELF), { id: '', source: 'none' })
  assert.deepEqual(resolveImeRestoreTarget(SELF_FULL, SELF_FULL + '\n', SELF), { id: '', source: 'none' })
})

test('#1520 归一化：pkg/pkg.Class 与 pkg/.Class 等价，其它原样', () => {
  assert.equal(normalizeImeId(SELF_FULL), SELF)
  assert.equal(normalizeImeId(SELF), SELF)
  assert.equal(normalizeImeId('  "' + SELF_FULL + '"  '), SELF)
  // 非本包类名（外部包引用自己的类时短形态无法表达）保持原样，只剥引号与空白。
  assert.equal(normalizeImeId('com.a/com.b.Board'), 'com.a/com.b.Board')
  assert.equal(normalizeImeId('null'), 'null')
})

test('形态判据：null / 空 / 非组件都不可还原，两种组件形态都可还原', () => {
  assert.equal(restorableImeId('null'), false)
  assert.equal(restorableImeId('  '), false)
  assert.equal(restorableImeId('com.example'), false)
  assert.equal(restorableImeId('com.example/.MyIme'), true)
  assert.equal(restorableImeId(SELF_FULL), true)
})

test('#1517 候选排序：引用形态过滤、去重、排除自身，偏好命中排最前', () => {
  const list = 'com.other/.First\n' + SELF + '\nnull\ncom.user/.Mine\ncom.other/.First\n' + SELF_FULL + '\n'
  assert.deepEqual(rankImeRestoreCandidates(list, SELF), ['com.other/.First', 'com.user/.Mine'],
    '不取自身、跳过不可还原形态与重复项，其余保持 ROM 顺序')
  assert.deepEqual(rankImeRestoreCandidates(list, SELF, ['com.user/.Mine']), ['com.user/.Mine', 'com.other/.First'],
    '偏好命中的候选必须排到最前')
  assert.deepEqual(rankImeRestoreCandidates(list, SELF, ['com.absent/.Gone']), ['com.other/.First', 'com.user/.Mine'],
    '偏好里已不在列表中的条目不得凭空成为还原目标')
})

test('#1517 偏好记忆：最近使用优先、去重、截断', () => {
  const history = createImeHistory(2)
  assert.deepEqual(history.list(), [])
  history.remember('com.a/.A')
  history.remember('com.b/.B')
  history.remember('com.a/.A')
  assert.deepEqual(history.list(), ['com.a/.A', 'com.b/.B'], '重复记得要前插而不是重复出现')
  history.remember('com.c/.C')
  assert.deepEqual(history.list(), ['com.c/.C', 'com.a/.A'], '必须按上限截断（最近使用优先）')
  history.remember('null')
  history.remember('')
  history.remember('com.not-a-component')
  assert.deepEqual(history.list(), ['com.c/.C', 'com.a/.A'], '不可还原形态不得进偏好表')
})

test('#1517 偏好命中时 resolveImeRestoreTarget 取偏好项而不是列表第一行', () => {
  const list = 'com.other/.First\ncom.user/.Mine\n'
  assert.deepEqual(resolveImeRestoreTarget('null', list, SELF, ['com.user/.Mine']),
    { id: 'com.user/.Mine', source: 'fallback' })
  assert.deepEqual(resolveImeRestoreTarget('null', list, SELF),
    { id: 'com.other/.First', source: 'fallback' }, '没有偏好时退回 ROM 顺序（确定即可）')
})
