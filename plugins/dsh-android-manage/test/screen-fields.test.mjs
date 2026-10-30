// 屏幕三件套的字段归一化。这三段此前在 tools() 闭包里，零测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenArgs, screenOut, coordinateMode } from '../lib/screen-fields.js'

test('screenArgs：只有非空字符串才下发 screenId（缺省不发键＝真实屏语义）', () => {
  assert.deepEqual(screenArgs({ screenId: 'virtual-1' }), { screenId: 'virtual-1' })
  for (const a of [undefined, null, {}, { screenId: '' }, { screenId: 123 }, { screenId: null }]) {
    assert.deepEqual(screenArgs(a), {}, '不该下发 screenId：' + JSON.stringify(a))
  }
})

test('screenOut：只带真回显的字段，不编造默认值', () => {
  assert.deepEqual(screenOut({
    screenId: 'virtual-1', displayId: 7, scope: 'virtual-only', actionMode: 'coordinate',
  }), { screenId: 'virtual-1', displayId: 7, scope: 'virtual-only', actionMode: 'coordinate' })
  for (const d of [undefined, null, {}, { screenId: '' }, { scope: '' }, { actionMode: '' }]) {
    assert.deepEqual(screenOut(d), {}, '不该造键：' + JSON.stringify(d))
  }
})

test('screenOut：NaN / Infinity 不得透传（不是合法 JSON，引擎会整值拒绝）', () => {
  // 0.13.8 #204 同族：`{type:'number'}` 下 NaN/Infinity 会让整条 ToolOutput 被拒，模型拿不到数据。
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(screenOut({ displayId: bad }), {}, '透传了非有限数：' + String(bad))
  }
  assert.deepEqual(screenOut({ displayId: 0 }), { displayId: 0 }, '0 是合法值，不该被丢')
  assert.deepEqual(screenOut({ displayId: -1 }), { displayId: -1 }, '负数合法（壳侧自行约束）')
})

test('coordinateMode：结构化坐标模式响应', () => {
  assert.deepEqual(coordinateMode('virtual-2', '无障碍未开启', '改用 android_vdisplay_input'), {
    ok: false, actionMode: 'coordinate', screenId: 'virtual-2', reason: '无障碍未开启', guidance: '改用 android_vdisplay_input',
  })
})
