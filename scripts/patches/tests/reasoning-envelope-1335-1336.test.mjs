// issue #1335 + #1336：`661c3386` 引入的两处推理信封回归。
//
// #1335 ① catch 把 provider 抛出的**任何**异常改写成固定文案，上游
//   `classifyPiAiError` 是按原文匹配分类的（上下文超限 / 鉴权 / 限流 / 超时），
//   分类全部丢失。
// #1335 ② 迭代器正常结束但没有终止事件时，包装器**伪造**一个终止错误事件，
//   于是上游「缺终止事件」的判据永远不触发 —— STREAM_CLOSED 对包装流不可达。
// #1336 ① `response.completed` 用 summary 重算 text，缺 content 回退：
//   对「只有 content、summary 为空」的推理项会把已显示的思考清空。
// #1336 ② 写回的 signature 丢掉 content，重放无法还原思考正文。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { replayReasoningItem, scopedReasoningStream, patchReasoningResponses } from '../data/reasoning-envelope-1304.mjs'
import { versionedFixture } from './lib/fixture.mjs'

/** 假的 EventStream：只记 push / end，够 scopedReasoningStream 用。 */
function fakeStream() {
  const pushed = []
  let ended = false
  return {
    pushed,
    get ended() { return ended },
    push(event) { pushed.push(event) },
    end() { ended = true },
    async result() { return pushed },
  }
}

/** 让 fire-and-forget 的异步 IIFE 跑完（它不返回 promise）。 */
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r))
}

// ── #1335 ①：保留原始 error 文本与 code ────────────────────────────────────────

test('#1335 ① provider 抛上下文超限时，带内错误必须保留原文（分类不能丢）', async () => {
  const original = 'Error Code context_length_exceeded: Your input exceeds the context window of this model.'
  async function* throwing() {
    yield { type: 'delta', partial: { role: 'assistant' } }
    throw Object.assign(new Error(original), { code: 'context_length_exceeded' })
  }
  const out = fakeStream()
  scopedReasoningStream(throwing(), 'scope-1335', () => out)
  await settle()

  const errors = out.pushed.filter(e => e.type === 'error')
  assert.equal(errors.length, 1, '应恰好产出一个带内错误事件，实得 ' + errors.length)
  const message = String(errors[0].error.errorMessage)
  assert.ok(message.includes('context_length_exceeded'),
    '错误文本里必须仍有 context_length_exceeded（上游按原文分类），实得: ' + message)
  assert.ok(message.includes('context window'), '必须保留原文其余部分，实得: ' + message)
  assert.equal(/reasoning-1304: provider stream failed/.test(message), false,
    '仍是固定文案，分类会被抹平: ' + message)
  assert.equal(errors[0].error.errorCode, 'context_length_exceeded', '必须保留原始 code')
})

test('#1335 ① 非 Error 抛出物也必须如实转写，不得退化成固定文案', async () => {
  async function* throwing() {
    yield { type: 'delta', partial: { role: 'assistant' } }
    throw 'plain-string-failure'
  }
  const out = fakeStream()
  scopedReasoningStream(throwing(), 'scope-1335b', () => out)
  await settle()
  const errors = out.pushed.filter(e => e.type === 'error')
  assert.equal(errors.length, 1)
  assert.equal(String(errors[0].error.errorMessage), 'plain-string-failure')
})

// ── #1335 ②：EOF 不伪造终止事件 ────────────────────────────────────────────────

test('#1335 ② 迭代器结束但没有终止事件时，不得伪造错误事件（让 STREAM_CLOSED 可达）', async () => {
  async function* truncated() {
    yield { type: 'delta', partial: { role: 'assistant' } }
    // 连接被掐：没有 done / error
  }
  const out = fakeStream()
  scopedReasoningStream(truncated(), 'scope-1335c', () => out)
  await settle()

  assert.equal(out.ended, true, '流仍必须正常收尾')
  const errors = out.pushed.filter(e => e.type === 'error')
  assert.equal(errors.length, 0,
    '不得伪造终止错误事件：伪造会让上游「缺终止事件」判据永不触发，STREAM_CLOSED 不可达')
  const deltas = out.pushed.filter(e => e.type === 'delta')
  assert.equal(deltas.length, 1, '真事件必须原样透传')
})

test('#1335 ② 反向：provider 正常给出 done 时仍应原样收尾（不得连带改坏）', async () => {
  async function* healthy() {
    yield { type: 'delta', partial: { role: 'assistant' } }
    yield { type: 'done' }
  }
  const out = fakeStream()
  scopedReasoningStream(healthy(), 'scope-1335d', () => out)
  await settle()
  assert.equal(out.ended, true)
  assert.equal(out.pushed.filter(e => e.type === 'error').length, 0)
  assert.equal(out.pushed.filter(e => e.type === 'done').length, 1)
})

// ── #1336 ②：signature 保留 content ───────────────────────────────────────────

test('#1336 ② 非 null 的 content 必须进 signature（重放要能还原思考正文）', () => {
  const content = [{ type: 'reasoning_text', text: 'step one: check the repo' }]
  const item = replayReasoningItem({ type: 'reasoning', id: 'rs_1', summary: [], content, encrypted_content: 'CIPHER' })
  assert.deepEqual(item.content, content, 'content 被丢弃了，重放无法还原思考正文')
  assert.deepEqual(item.summary, [])
})

test('#1336 ② 对照：content:null 仍必须省略（不得把 null 送回去）', () => {
  const item = replayReasoningItem({ type: 'reasoning', id: 'rs_2', summary: [], content: null })
  assert.equal(Object.hasOwn(item, 'content'), false, 'content:null 不得出现在回放项里')
})

// ── #1336 ①：summary || content || 既有正文 ───────────────────────────────────

/** 从**打过补丁的产物**里抽出终止推理块，用 harness 真跑一遍。
 *  为什么不直接断言源码字符串：那只能证明「有这行字」，证明不了它算得对。 */
function finalizeHarness() {
  const fixture = versionedFixture('pi-ai', 'dist', 'api', 'openai-responses-shared.js')
  const patched = patchReasoningResponses(readFileSync(fixture, 'utf8'))
  const start = patched.indexOf('for (const [index, item] of (response.output ?? []).entries()) {')
  assert.ok(start > 0, '补丁产物里找不到终止推理块（锚点漂移？）')
  const tail = patched.indexOf('backfillReasoningSignatures(response.output ?? []);', start)
  assert.ok(tail > start, '找不到终止推理块的收尾')
  const block = patched.slice(start, tail)
  return { block, patched }
}

function runFinalize(block, { item, previous, outputContent }) {
  const pushed = []
  const reasoningBlocksById = new Map([[item.id, previous]])
  const output = { content: outputContent }
  const stream = { push: e => pushed.push(e) }
  const noop = () => {}
  // eslint-disable-next-line no-new-func
  const fn = new Function('response', 'reasoningBlocksById', 'output', 'stream', 'getOrCreateSlot',
    'replayReasoningItem', 'outputSlots', 'backfillReasoningSignatures', block)
  fn({ output: [item] }, reasoningBlocksById, output, stream, noop, replayReasoningItem, new Map(), noop)
  return { pushed, previous }
}

test('#1336 ① 只有 content、summary 为空的推理项：思考正文不得被清空', () => {
  const { block } = finalizeHarness()
  const body = 'step one: check the repo'
  const previous = { type: 'thinking', thinking: body, thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_1', summary: [] }) }
  const item = {
    type: 'reasoning', id: 'rs_1', summary: [],
    content: [{ type: 'reasoning_text', text: body }],
    encrypted_content: 'CIPHER',
  }
  const { pushed, previous: after } = runFinalize(block, { item, previous, outputContent: [previous] })
  assert.equal(after.thinking, body, '思考正文被空 summary 清空了（缺 content 回退）')
  const ends = pushed.filter(e => e.type === 'thinking_end')
  assert.equal(ends.length, 0, '正文没变就不该多推 thinking_end，实得 ' + ends.length)
})

test('#1336 ① summary 优先于 content（不得把优先级弄反）', () => {
  const { block } = finalizeHarness()
  const previous = { type: 'thinking', thinking: 'from-stream', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_3', summary: [] }) }
  const item = {
    type: 'reasoning', id: 'rs_3',
    summary: [{ type: 'summary_text', text: 'summarized' }],
    content: [{ type: 'reasoning_text', text: 'raw content' }],
  }
  const { previous: after } = runFinalize(block, { item, previous, outputContent: [previous] })
  assert.equal(after.thinking, 'summarized', 'summary 存在时必须用 summary')
})

test('#1336 ① 两者都空时保留既有正文（不得清空）', () => {
  const { block } = finalizeHarness()
  const previous = { type: 'thinking', thinking: 'keep-me', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_4', summary: [] }) }
  const item = { type: 'reasoning', id: 'rs_4', summary: [], content: [] }
  const { previous: after } = runFinalize(block, { item, previous, outputContent: [previous] })
  assert.equal(after.thinking, 'keep-me', 'summary 与 content 都空时必须保留既有正文')
})
