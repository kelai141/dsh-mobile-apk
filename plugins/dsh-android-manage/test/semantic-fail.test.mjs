// 无障碍失败回执的结构化渲染。这段此前零测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { semanticFail } from '../lib/semantic-fail.js'

test('semanticFail：三件套只在真回显时带上，且都排除空串', () => {
  // 修复点：actionMode 曾只查 typeof，空串会被带出去
  assert.deepEqual(semanticFail({ error: 'x', actionMode: '' }, '失败：'), {
    ok: false, denied: false, text: '失败：x',
  })
  assert.deepEqual(semanticFail({ error: 'x', screenId: '', guidance: '' }, '失败：'), {
    ok: false, denied: false, text: '失败：x',
  })
})

test('semanticFail：真回显的字段原样带出', () => {
  assert.deepEqual(
    semanticFail({ error: 'E', actionMode: 'coordinate', screenId: 'virtual-1', guidance: '改用坐标' }, '失败：'),
    { ok: false, denied: false, text: '失败：E', actionMode: 'coordinate', screenId: 'virtual-1', guidance: '改用坐标' },
  )
})

test('semanticFail：非字符串一律不带；error 缺失时用「未知失败」', () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    const out = semanticFail({ error: 'E', actionMode: bad, screenId: bad, guidance: bad }, 'X：')
    assert.deepEqual(Object.keys(out).sort(), ['denied', 'ok', 'text'], '不该带上非字符串字段：' + JSON.stringify(bad))
  }
  assert.equal(semanticFail({}, '失败：').text, '失败：未知失败')
  // 空 error 字符串是合法回显（不是"缺失"）
  assert.equal(semanticFail({ error: '' }, '失败：').text, '失败：')
})

test('semanticFail：永远是 ok=false / denied=false（失败回执不该被当成拒绝或成功）', () => {
  const out = semanticFail({ error: 'E' }, '')
  assert.equal(out.ok, false)
  assert.equal(out.denied, false)
})
