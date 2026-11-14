// live 流新增面回归（悬浮重构 P2 前置）：`k=think` 思考行与 `tool_call` 的 `callId` 配对。
//
// 为什么是行为测试而不是 grep 源码：这两项都是「写给壳侧消费的线上格式」，
// 唯一判据是**真的走 apply() 注册的 session/event 监听、把 .live.ndjson 读回来**。
// 设计来源：docs/overlay-refactor-2026-11/design.md §5.3（思考行）与 §6.2 N1/N2（callId）。
//
// 旧壳兼容口径（本文件同时钉住）：
//   - 未知 k 由壳侧 else 分支忽略，故 think 行是纯加法；
//   - callId 是纯加字段，既有 name/args/dur/err 字段名与语义不变。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, flushPendingAppends } from '../lib/index.js'

const SAVED_DSH_HOME = process.env.DSH_HOME
after(() => {
  if (SAVED_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = SAVED_DSH_HOME
})

/** 用桩 ctx 跑一次 apply()，emit 事件序列，回读 .live.ndjson 的全部行。 */
function liveLines(events, sessionId = 's1') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-think-'))
  process.env.DSH_HOME = dir
  const listeners = new Map()
  const ctx = {
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: () => {} },
    get: () => undefined,
    provide: () => {},
    effect: () => () => {},
    on: (event, handler) => { listeners.set(event, handler); return () => {} },
  }
  apply(ctx)
  const emit = listeners.get('session/event')
  assert.equal(typeof emit, 'function', 'apply() 必须注册 session/event 监听')
  for (const ev of events) emit({ id: sessionId }, ev)
  // 写侧是 100ms 批量：读之前必须走同步出口。
  flushPendingAppends()
  let raw = ''
  try { raw = readFileSync(join(dir, '.live.ndjson'), 'utf8') } catch { return [] }
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

function assistant(content) {
  return { type: 'assistant/message', data: { message: { content } } }
}

// ── k=think 行形态 ──────────────────────────────────────────────────────────

test('think 行：只取 reasoning 块的首行，且行形态是 {t,s,k,sum}', () => {
  const lines = liveLines([
    assistant([
      { type: 'reasoning', text: '先确认设备是否在线\n再决定用哪个工具' },
      { type: 'text', text: '已完成。' },
    ]),
  ])
  const think = lines.filter((line) => line.k === 'think')
  assert.equal(think.length, 1, '一条 assistant message 必须写一条 think 行')
  const [row] = think
  assert.equal(row.s, 's1', '会话 id 必填')
  assert.equal(typeof row.t, 'number', 't 必须是 epoch 毫秒')
  assert.equal(typeof row.sum, 'string', 'sum 必须是字符串')
  assert.equal(row.sum, '先确认设备是否在线', '只取首行，不得把第二行拼接进来')
  // 反证：思考行不得污染既有 text 行（旧壳仍读它）。
  const text = lines.find((line) => line.k === 'text')
  assert.equal(text.sum, '已完成。')
})

test('think 行：超过 120 字必须截断并带省略号', () => {
  const long = '思'.repeat(200)
  const lines = liveLines([assistant([{ type: 'reasoning', text: long }])])
  const think = lines.find((line) => line.k === 'think')
  assert.ok(think, '长思考必须仍写一行')
  assert.equal(Array.from(think.sum).length, 120, '思考行上限 120 字符（与设计的 thinkingLine 同口径）')
  assert.ok(think.sum.endsWith('…'), '截断必须显式带省略号，不得让用户把截断处当结尾')
})

test('think 行：≤120 字的短思考原样保留，不加省略号', () => {
  const lines = liveLines([assistant([{ type: 'reasoning', text: '短思考' }])])
  const think = lines.find((line) => line.k === 'think')
  assert.equal(think.sum, '短思考')
})

test('think 行：空/纯空白不写行', () => {
  for (const text of ['', '   \n\t  ', '\n']) {
    const lines = liveLines([assistant([{ type: 'reasoning', text }, { type: 'text', text: '正文' }])])
    assert.equal(lines.filter((line) => line.k === 'think').length, 0, JSON.stringify(text) + ' 不得写 think 行')
  }
})

test('think 行：没有任何带 type 的块时不猜（不写行）', () => {
  // 未知 provider 的旧形状：content 项只有 text 字段。猜哪一段是思考比没有更糟。
  const lines = liveLines([assistant([{ text: '可能是思考也可能是正文' }])])
  assert.equal(lines.filter((line) => line.k === 'think').length, 0)
})

test('think 行：多段 reasoning 取最后一版（最新思路）', () => {
  const lines = liveLines([assistant([
    { type: 'reasoning', text: '第一版思路' },
    { type: 'reasoning', text: '第二版思路\n细节' },
  ])])
  const think = lines.find((line) => line.k === 'think')
  assert.equal(think.sum, '第二版思路')
})

// ── tool_call 的 callId 配对 ────────────────────────────────────────────────

test('callId：上游给了 id 时 tool_call 与 tool_result 逐字相同', () => {
  const lines = liveLines([
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'call-abc' } },
    { type: 'tool/result', data: { message: { source: { callId: 'call-abc' }, content: [{ type: 'text', text: 'ok' }] } } },
  ])
  const call = lines.find((line) => line.k === 'tool_call')
  const result = lines.find((line) => line.k === 'tool_result')
  assert.equal(call.callId, 'call-abc')
  assert.equal(result.callId, 'call-abc', '结果行必须能按同一个 callId 配回调用行')
  // 既有字段不变（纯加字段的判据）。
  assert.equal(call.name, 'bash')
  assert.equal(call.args, '{"command":"ls"}')
  assert.equal(result.name, 'bash')
  assert.equal(result.err, false)
  assert.equal(typeof result.dur, 'number')
})

test('callId：上游缺 id 时用会话内递增序号，且两次调用不串行', () => {
  const lines = liveLines([
    { type: 'tool/call', data: { name: 'read', arguments: '{"path":"a"}' } },
    { type: 'tool/call', data: { name: 'read', arguments: '{"path":"b"}' } },
    { type: 'tool/result', data: { message: { source: {}, content: [] } } },
    { type: 'tool/result', data: { message: { source: {}, content: [] } } },
  ])
  const calls = lines.filter((line) => line.k === 'tool_call')
  const results = lines.filter((line) => line.k === 'tool_result')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((line) => line.callId), ['anon-1', 'anon-2'], '生成 id 必须是会话内递增序号')
  assert.deepEqual(results.map((line) => line.callId), ['anon-1', 'anon-2'], '结果侧按 FIFO 配回最早的未配对调用')
  // 参数按配对取：第一把 read 不得拿到第二把的参数。
  assert.equal(results[0].args, '{"path":"a"}')
  assert.equal(results[1].args, '{"path":"b"}')
})

test('callId：有上游 id 与匿名 id 混用时不串号', () => {
  const lines = liveLines([
    { type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'call-x' } },
    { type: 'tool/result', data: { message: { source: { callId: 'call-x' }, content: [] } } },
    { type: 'tool/result', data: { message: { source: {}, content: [] } } },
  ])
  const calls = lines.filter((line) => line.k === 'tool_call')
  const results = lines.filter((line) => line.k === 'tool_result')
  assert.deepEqual(calls.map((line) => line.callId), ['anon-1', 'call-x'])
  assert.deepEqual(results.map((line) => line.callId), ['call-x', 'anon-1'])
})

test('callId：每一行 tool_call 都必须带 callId（壳侧工具行配对的前提）', () => {
  const lines = liveLines([
    { type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
  ])
  const call = lines.find((line) => line.k === 'tool_call')
  assert.equal(typeof call.callId, 'string')
  assert.notEqual(call.callId, '')
})
