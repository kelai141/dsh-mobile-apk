import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { planReasoning, REASONING_FILES, reasoningScope, scopeReasoningHistory, replayReasoningItem,
  patchReasoningAdapter, patchReasoningUi, reasonFirst, readClaudeSeal, readReasoningSignature,
  readCopilotSeal, copilotAssistantParts, copilotToolRuns } from '../data/reasoning-envelope-1304.mjs'
import { versionedFixture } from './lib/fixture.mjs'
import { CIPHER, SIG, assertReplay, fieldInventory } from './lib/reasoning-mock.mjs'

const read = file => readFileSync(file.includes('/dsh-llm-pi-ai/')
  ? versionedFixture('dsh-llm-pi-ai', 'lib', 'index.js')
  : file.includes('/dsh-client-ui-chat/') ? versionedFixture('dsh-client-ui-chat', 'lib', 'client.js')
  : versionedFixture('pi-ai', ...file.split('/pi-ai/')[1].split('/')), 'utf8')

test('upgrade gate: real current artifacts, syntax, idempotency, exact anchors and partial-patch refusal', () => {
  const plan = planReasoning(read)
  assert.equal(plan.length, 7)
  const installed = Object.fromEntries(plan.map(item => [item.file, item.after]))
  assert.ok(planReasoning(file => installed[file]).every(item => item.before === item.after))
  for (const item of plan) {
    const source = item.after.replace(/^import .*?;\r?\n/gm, '').replace(/^export \{.*?;\r?\n/gm, '')
      .replace(/^export /gm, '')
    assert.doesNotThrow(() => new Function(source), item.file)
  }
  // A future engine release may alter non-contract bytes without requiring a version whitelist.
  assert.equal(planReasoning(file => '// future compatible build\n' + read(file)).length, 7)
  assert.throws(() => planReasoning(file => file === REASONING_FILES[0]
    ? read(file).replace('kind: "pi-ai",', 'kind: "new-adapter",') : read(file)), /contract drift/)
  assert.throws(() => planReasoning(file => file === REASONING_FILES[0]
    ? installed[file].replace('onReasoningDegrade: onReplayDegrade', 'missing: true') : installed[file]), /incomplete installed patch/)
})

test('Responses shape: exact opaque bytes, empty summary, omit null content and output-only fields', () => {
  const item = replayReasoningItem({ type: 'reasoning', id: 'rs_test', encrypted_content: CIPHER, content: null, status: 'completed' })
  assert.deepEqual(item, { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: CIPHER })
  assert.equal(JSON.parse(JSON.stringify(item)).encrypted_content, CIPHER)
  assert.throws(() => replayReasoningItem({ type: 'reasoning', summary: 'invalid' }), /summary/)
})

test('reasonFirst repairs text before reasoning without crossing interleaved tool batches; malformed seals never leak in errors', () => {
  const first = { type: 'reasoning', encrypted_content: CIPHER }
  const second = { type: 'reasoning', encrypted_content: SIG }
  const text = { type: 'message' }, call = { type: 'function_call' }
  assert.deepEqual(reasonFirst([text, first, call, call, text, second, call]), [first, text, call, call, second, text, call])
  for (const parse of [readClaudeSeal, readReasoningSignature, readCopilotSeal]) {
    assert.throws(() => parse(CIPHER), error => !error.message.includes(CIPHER) && /invalid/.test(error.message))
  }
})

test('Copilot keeps every sealed segment and rejects orphaned or duplicated tool runs', () => {
  const block = { type: 'thinking', thinking: '', dshSealed: JSON.stringify({ sealedBy: 'github-copilot', reasoning_opaque: CIPHER }) }
  assert.deepEqual(copilotAssistantParts([block], { role: 'assistant', content: null }),
    [{ role: 'assistant', content: '', reasoning_opaque: CIPHER, reasoning_text: '' }])
  assert.deepEqual(copilotAssistantParts([block, { type: 'toolCall', id: 'bad', name: '' }], { role: 'assistant' }),
    [{ role: 'assistant', content: '', reasoning_opaque: CIPHER, reasoning_text: '' }])
  const assistant = { role: 'assistant', content: '', reasoning_opaque: CIPHER, tool_calls: [{ id: 'one' }] }
  const output = { role: 'tool', tool_call_id: 'one', content: 'ok' }
  assert.throws(() => copilotToolRuns([assistant]), /incomplete/)
  assert.throws(() => copilotToolRuns([assistant, output, output]), /duplicate/)
  assert.throws(() => readCopilotSeal(JSON.stringify({ sealedBy: 'other', reasoning_opaque: CIPHER })), /invalid/)
})

test('negative controls: removed replay, null content, misplaced reasoning and changed opaque bytes all fail', () => {
  const body = { input: [replayReasoningItem({ type: 'reasoning', encrypted_content: CIPHER }),
    { type: 'function_call' }, { type: 'function_call_output' }] }
  assertReplay(body, 'responses', assert)
  for (const mutate of [
    input => input.shift(),
    input => { input[0].content = null },
    input => { input.splice(1, 0, { type: 'message' }) },
    input => { input[0].encrypted_content = CIPHER.trim() },
  ]) {
    const invalid = structuredClone(body)
    mutate(invalid.input)
    assert.throws(() => assertReplay(invalid, 'responses', assert))
  }
})

test('durable replay separates display from Claude blocks and preserves empty/redacted seals through JSON storage', () => {
  const source = patchReasoningAdapter(read(REASONING_FILES[0]))
  class LlmError extends Error { constructor(message, code) { super(message); this.code = code } }
  const replay = source.slice(source.indexOf('function parseArguments('), source.indexOf('//#endregion'))
  const { save, restore } = new Function('LlmError', replay + ';return { save:toPiReplayState, restore:toPiAssistant }')(LlmError)
  for (const api of ['openai-codex-responses', 'openai-responses', 'anthropic-messages', 'openai-completions']) {
    const message = { api, model: 'test', provider: 'test', stopReason: 'toolUse', dshReasoningScope: 'scope', content: [
      { type: 'thinking', thinking: '', thinkingSignature: SIG,
        dshSealed: JSON.stringify({ type: 'thinking', thinking: '', signature: SIG, display: 'omitted' }) },
      { type: 'thinking', thinking: '', thinkingSignature: CIPHER, redacted: true,
        dshSealed: JSON.stringify({ type: 'redacted_thinking', data: CIPHER }) },
      { type: 'toolCall', id: 'call_test', name: 'inspect', arguments: {} },
    ] }
    const durable = { source: { provider: 'test', model: 'test', replayState: save(message) }, content: [
      { type: 'reasoning', text: '' }, { type: 'reasoning', text: '' },
      { type: 'tool-call', id: 'call_test', name: 'inspect', arguments: '{}' },
    ] }
    const diagnostics = []
    const recovered = restore(JSON.parse(JSON.stringify(durable)), code => diagnostics.push(code))
    assert.deepEqual(recovered.content, message.content, api)
    assert.equal(recovered.dshReasoningScope, 'scope')
    assert.deepEqual(diagnostics, [])
    assert.ok(!JSON.stringify(durable.content).includes('signature'))
    durable.source.replayState.response.version = 99
    restore(durable, code => diagnostics.push(code))
    assert.deepEqual(diagnostics, ['INVALID_REPLAY_STATE'])
  }
})

test('account/model/endpoint isolation after auth refresh, safe diagnostics, no foreign thinking-as-text', () => {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const model = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-test', baseUrl: 'https://first.example' }
  const jwt = (sub, expiry) => 'x.' + Buffer.from(JSON.stringify({ iss: 'issuer', sub, exp: expiry })).toString('base64url') + '.x'
  const scope = reasoningScope(model, { apiKey: jwt('one', 1) }, hash)
  assert.equal(reasoningScope(model, { apiKey: jwt('one', 2) }, hash), scope)
  assert.equal(reasoningScope(model, { apiKey: jwt('one', 2), headers: { 'User-Agent': 'dsh-future', 'X-Request-Id': 'new-request' } }, hash), scope)
  assert.notEqual(reasoningScope(model, { apiKey: jwt('one', 2), headers: { 'ChatGPT-Account-Id': 'different' } }, hash), scope)
  const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, dshReasoningScope: scope,
    content: [{ type: 'thinking', thinking: 'display', thinkingSignature: CIPHER }, { type: 'toolCall', id: 'x', name: 'inspect', thoughtSignature: SIG }] }
  assert.equal(scopeReasoningHistory({ messages: [message] }, scope, model, assert.fail).messages[0], message)
  for (const [target, options] of [[model, { apiKey: jwt('two', 2) }], [{ ...model, id: 'other' }, { apiKey: jwt('one', 2) }],
    [{ ...model, baseUrl: 'https://second.example' }, { apiKey: jwt('one', 2) }], [{ ...model, api: 'openai-completions' }, { apiKey: jwt('one', 2) }]]) {
    const diagnostics = []
    const result = scopeReasoningHistory({ messages: [message] }, reasoningScope(target, options, hash), target, code => diagnostics.push(code))
    assert.deepEqual(diagnostics, ['REASONING_SCOPE_MISMATCH'])
    assert.deepEqual(result.messages[0].content, [{ type: 'toolCall', id: 'x', name: 'inspect' }])
    assert.ok(!JSON.stringify(result).includes(CIPHER))
  }
})

test('diagnostic probe outputs only field names/types, original seal remains replayable', () => {
  const original = { thinking: '', signature: SIG, data: CIPHER }
  const inventory = fieldInventory(original)
  assert.deepEqual(inventory, ['data:string', 'signature:string', 'thinking:string'])
  assert.equal(original.signature, SIG)
  assert.equal(original.data, CIPHER)
})

test('empty and nonempty summaries both remain visible, streaming and settled; transport activity pulses idle watchdog', () => {
  const ui = patchReasoningUi(read(REASONING_FILES.at(-1)))
  const start = ui.indexOf('function blockIsVisible(')
  // 0.2.2-rc.1 起 blockIsVisible 后面接的是 hasVisibleContent（原 countVisibleBlocks 已不存在）；
  // 分隔符跟着换，仍然只截「这一个函数」求值，不放宽到整文件。
  const end = ui.indexOf('\n\t\tfunction hasVisibleContent', start)
  const visible = new Function(ui.slice(start, end) + ';return blockIsVisible')()
  assert.equal(visible({ kind: 'reasoning', text: '' }), true)
  assert.equal(visible({ kind: 'reasoning', text: 'summary' }), true)
  assert.equal(visible({ kind: 'text', text: '' }), false)
  assert.doesNotMatch(ui, /if \(block.text.trim\(\) === ""\) break;/)
  const patched = patchReasoningAdapter(read(REASONING_FILES[0]))
  assert.match(patched, /onProviderStreamEvent: \(\) => watchdog\.pulse\(\)/)
})
