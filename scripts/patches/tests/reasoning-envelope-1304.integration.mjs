/** Test-only HTTP/SSE integration. Install pi-ai in an isolated directory, never in the shipping tree.
 * DSH_REASONING_RUNTIME=<absolute pi-ai package directory> node --test <this file>
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { planReasoning, REASONING_FILES, patchReasoningAdapter } from '../data/reasoning-envelope-1304.mjs'
import { planPiStreaming } from '../pi-upstream-streaming-020.mjs'
import { CIPHER, DISPLAY, reasoningMock, tool, assertReplay } from './lib/reasoning-mock.mjs'

const root = process.env.DSH_REASONING_RUNTIME
assert.ok(root, 'DSH_REASONING_RUNTIME must name an isolated installed pi-ai directory')
const prepared = process.env.DSH_REASONING_PREPARED === '1'
const versionedFixture = prepared ? undefined : (await import('./lib/fixture.mjs')).versionedFixture
const pathOf = file => file.includes('/dsh-llm-pi-ai/') ? null : join(root, file.split('/pi-ai/')[1])
// Prepare raw files from the exact captured artifacts; official patches precede adaptation patches.
if (!prepared) {
for (const file of REASONING_FILES.slice(1, -1)) {
  const relative = file.split('/pi-ai/')[1]
  writeFileSync(pathOf(file), readFileSync(versionedFixture('pi-ai', ...relative.split('/'))))
}
for (const item of planPiStreaming(root)) writeFileSync(join(root, item.file), item.after)
const plan = planReasoning(file => file.includes('/dsh-llm-pi-ai/')
  ? readFileSync(versionedFixture('dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8')
  : file.includes('/dsh-client-ui-chat/') ? readFileSync(versionedFixture('dsh-client-ui-chat', 'lib', 'client.js'), 'utf8')
  : readFileSync(pathOf(file), 'utf8'))
for (const item of plan.slice(1, -1)) writeFileSync(pathOf(item.file), item.after)
writeFileSync(resolve(root, '../../@deepseek-ai/dsh-llm-pi-ai/lib/index.js'), plan[0].after)
}
const load = relative => import(pathToFileURL(resolve(root, relative)).href)
const { createModels } = await load('dist/models.js')
const { InMemoryCredentialStore } = await load('dist/auth/credential-store.js')
const responses = await load('dist/api/openai-responses.js')
const codex = await load('dist/api/openai-codex-responses.js')
const claude = await load('dist/api/anthropic-messages.js')
const chat = await load('dist/api/openai-completions.js')
const { idleWatchdog } = await import(pathToFileURL(resolve(root, '../../@deepseek-ai/dsh-timeout/lib/index.js')).href)
const { PiAiAdapter } = await import(pathToFileURL(resolve(root, '../../@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).href)
const { BlockAssembler } = await import(pathToFileURL(resolve(root, '../../@deepseek-ai/dsh-llm/lib/index.js')).href)

// Execute the real adapter's replay projection and reconstruction across JSON persistence.
const adapter = prepared ? readFileSync(process.env.DSH_REASONING_ADAPTER, 'utf8')
  : patchReasoningAdapter(readFileSync(versionedFixture('dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8'))
class LlmError extends Error { constructor(message, code) { super(message); this.code = code } }
const replaySource = adapter.slice(adapter.indexOf('function parseArguments('), adapter.indexOf('//#endregion'))
const { save, restore } = new Function('LlmError', replaySource + ';return {save:toPiReplayState,restore:toPiAssistant}')(LlmError)
function persist(message) {
  return JSON.parse(JSON.stringify({ source: { provider: message.provider, model: message.model, replayState: save(message) },
    content: message.content.map(block => block.type === 'thinking' ? { type: 'reasoning', text: block.thinking }
      : block.type === 'text' ? block : { type: 'tool-call', id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) }) }))
}
function modelsFor(provider, api, server) {
  const model = { provider, api, id: api === 'anthropic-messages' ? 'claude-sonnet-4-6' : 'test-model',
    name: 'Test', baseUrl: server.url + '/v1', reasoning: true, input: ['text'], contextWindow: 32000,
    maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const client = api === 'anthropic-messages' ? claude : api === 'openai-codex-responses' ? codex
    : api === 'openai-responses' ? responses : chat
  const models = createModels()
  models.setProvider({ id: provider, name: provider, getModels: () => [model],
    auth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'test-only-key' } }) } },
    stream: client.stream, streamSimple: client.streamSimple })
  const apiKey = api === 'openai-codex-responses'
    ? 'x.' + Buffer.from(JSON.stringify({ sub: 'test', 'https://api.openai.com/auth': { chatgpt_account_id: 'test' } })).toString('base64url') + '.x'
    : 'test-only-key'
  const options = { apiKey, transport: 'sse', maxTokens: 2048, reasoning: 'low', maxRetries: 0 }
  return { model, models, options }
}

for (const [provider, api, wire] of [
  ['openai-codex', 'openai-codex-responses', 'responses'], ['xai', 'openai-responses', 'responses'],
  ['anthropic', 'anthropic-messages', 'messages'], ['github-copilot', 'openai-completions', 'chat'],
  ['github-copilot', 'anthropic-messages', 'messages'], ['github-copilot', 'openai-responses', 'responses'],
]) test(`${provider}/${api}: two tool turns, native HTTP/SSE, durable replay and field-only probe`, async () => {
  const server = await reasoningMock(assert, { wire })
  try {
    const { models, model, options } = modelsFor(provider, api, server)
    const context = { messages: [{ role: 'user', content: 'Inspect the workspace and report.', timestamp: 1 }], tools: [tool] }
    const first = await models.completeSimple(model, context, options)
    assert.equal(first.stopReason, 'toolUse', first.errorMessage)
    const durable = persist(first)
    assert.ok(durable.source.replayState.response.dshReasoningScope)
    const recovered = restore(durable, assert.fail)
    assert.deepEqual(recovered.content, first.content)
    const call = first.content.find(block => block.type === 'toolCall')
    const second = await models.completeSimple(model, { ...context, messages: [...context.messages, recovered,
      { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'README.md exists.' }], isError: false, timestamp: 2 }] }, options)
    assert.equal(second.stopReason, 'stop', second.errorMessage)
    assert.equal(server.requests.length, 2)
    assert.deepEqual(server.failures, [])
    assertReplay(server.requests[1], wire, assert)
    assert.ok(!JSON.stringify([...server.inventory]).includes(CIPHER))
    console.log(JSON.stringify({ provider, api, simulated: true, fields: [...server.inventory].filter(field => /reasoning|thinking|signature|encrypted|data:/.test(field)).sort() }))
  } finally { await server.close() }
})

test('Grok: encrypted reasoning only in terminal response, with no summary', async () => {
  const server = await reasoningMock(assert, { wire: 'responses', terminalOnly: true })
  try {
    const { models, model, options } = modelsFor('xai', 'openai-responses', server)
    const first = await models.completeSimple(model, { messages: [], tools: [tool] }, options)
    assert.equal(first.stopReason, 'toolUse', first.errorMessage)
    assert.equal(first.content[0].type, 'thinking')
    assert.equal(first.content[0].thinking, '')
    assert.equal(JSON.parse(first.content[0].thinkingSignature).encrypted_content, CIPHER)
    assert.equal(first.content[1].type, 'toolCall')
  } finally { await server.close() }
})

test('late summary updates the original row; duplicate reasoning completion does not add another block', async () => {
  const server = await reasoningMock(assert, { wire: 'responses', terminalSummary: true, duplicateDone: true })
  try {
    const { models, model, options } = modelsFor('xai', 'openai-responses', server)
    const events = []
    const stream = models.streamSimple(model, { messages: [], tools: [tool] }, options)
    for await (const event of stream) events.push(event)
    const result = await stream.result()
    assert.equal(result.content.filter(block => block.type === 'thinking').length, 1)
    assert.equal(result.content[0].thinking, DISPLAY)
    assert.equal(events.filter(event => event.type === 'thinking_end').at(-1).content, DISPLAY)
    assert.equal(JSON.parse(result.content[0].thinkingSignature).encrypted_content, CIPHER)
  } finally { await server.close() }
})

for (const blankChat of [true, false]) test(`Copilot opaque segments with ${blankChat ? 'empty' : 'visible'} summaries survive two-turn replay`, async () => {
  const server = await reasoningMock(assert, { wire: 'chat', blankChat, copilotSegments: 2 })
  try {
    const { models, model, options } = modelsFor('github-copilot', 'openai-completions', server)
    const context = { messages: [{ role: 'user', content: 'Inspect both workspaces.', timestamp: 1 }], tools: [tool] }
    const first = await models.completeSimple(model, context, options)
    assert.equal(first.stopReason, 'toolUse', first.errorMessage)
    const thoughts = first.content.filter(block => block.type === 'thinking')
    assert.equal(thoughts.length, 2)
    assert.deepEqual(thoughts.map(block => JSON.parse(block.dshSealed).reasoning_opaque), [CIPHER, CIPHER + '#1'])
    assert.ok(thoughts.every(block => block.thinking === (blankChat ? '' : DISPLAY)))
    const recovered = restore(persist(first), assert.fail)
    const calls = first.content.filter(block => block.type === 'toolCall')
    const second = await models.completeSimple(model, { ...context, messages: [...context.messages, recovered,
      ...calls.map(call => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: 'README.md exists.' }], isError: false, timestamp: 2 }))] }, options)
    assert.equal(second.stopReason, 'stop', second.errorMessage)
    assert.deepEqual(server.failures, [])
    assertReplay(server.requests[1], 'chat', assert, { blankChat, copilotSegments: 2 })
  } finally { await server.close() }
})

test('strict HTTP negative controls: missing replay is rejected with 400 invalid_request_error for all native wires', async () => {
  for (const [wire, provider, api] of [['responses', 'xai', 'openai-responses'], ['messages', 'anthropic', 'anthropic-messages'], ['chat', 'github-copilot', 'openai-completions']]) {
    const server = await reasoningMock(assert, { wire })
    try {
      const { models, model, options } = modelsFor(provider, api, server)
      const context = { messages: [{ role: 'user', content: 'Inspect workspace.', timestamp: 1 }], tools: [tool] }
      const first = await models.completeSimple(model, context, options)
      const call = first.content.find(block => block.type === 'toolCall')
      await models.completeSimple(model, { ...context, messages: [...context.messages, restore(persist(first), assert.fail),
        { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'ok' }], timestamp: 2 }] }, options)
      const broken = structuredClone(server.requests[1])
      if (wire === 'responses') broken.input = broken.input.filter(item => item.type !== 'reasoning')
      else for (const message of broken.messages) {
        if (wire === 'chat') delete message.reasoning_opaque
        else if (message.role === 'assistant') message.content = message.content.filter(block => !['thinking', 'redacted_thinking'].includes(block.type))
      }
      const response = await fetch(server.url, { method: 'POST', body: JSON.stringify(broken), headers: { 'content-type': 'application/json' } })
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error.type, 'invalid_request_error')
    } finally { await server.close() }
  }
})

test('opaque OAuth refresh and collection restart preserve replay; a new login isolates the previous account', async () => {
  const server = await reasoningMock(assert, { wire: 'responses' })
  try {
    const initial = modelsFor('xai', 'openai-responses', server)
    const store = new InMemoryCredentialStore()
    const grant = (account, expires = Date.now() + 3600_000) => ({ type: 'oauth', access: 'opaque-access-' + account, refresh: 'refresh-' + account, expires })
    await store.modify('xai', async () => grant('one'))
    let refreshes = 0
    let heldAuth
    const provider = { ...initial.models.getProvider('xai'), auth: { oauth: {
      name: 'Test OAuth', login: async () => grant('two'),
      refresh: async () => { refreshes++; return grant('one-refreshed') },
      toAuth: async credential => {
        const held = heldAuth
        if (held) { held.entered.resolve(); await held.release.promise }
        return { apiKey: credential.access }
      },
    } } }
    const models = createModels({ credentials: store }); models.setProvider(provider)
    const { apiKey: ignored, ...options } = initial.options
    const context = { messages: [{ role: 'user', content: 'Inspect workspace.', timestamp: 1 }], tools: [tool] }
    const first = await models.completeSimple(initial.model, context, options)
    assert.equal(first.stopReason, 'toolUse', first.errorMessage)
    const identity = (await store.read('xai')).dshReasoningIdentity
    assert.ok(identity)
    const recovered = restore(persist(first), assert.fail)
    const call = first.content.find(block => block.type === 'toolCall')
    const nextContext = { ...context, messages: [...context.messages, recovered,
      { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'ok' }], timestamp: 2 }] }
    await store.modify('xai', async current => ({ ...current, expires: 0 }))
    const second = await models.completeSimple(initial.model, nextContext, options)
    assert.equal(second.stopReason, 'stop', second.errorMessage)
    assert.equal(refreshes, 1)
    assert.equal((await store.read('xai')).dshReasoningIdentity, identity)
    assert.equal(second.dshReasoningScope, first.dshReasoningScope)
    const restarted = createModels({ credentials: store }); restarted.setProvider(provider)
    assert.equal((await restarted.completeSimple(initial.model, nextContext, options)).stopReason, 'stop')
    heldAuth = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
    const held = heldAuth
    const pending = restarted.completeSimple(initial.model, context, options)
    await held.entered.promise
    await restarted.login('xai', 'oauth', { prompt: async () => '', notify: () => {} })
    heldAuth = undefined
    held.release.resolve()
    assert.equal((await pending).dshReasoningScope, first.dshReasoningScope,
      'an in-flight old-account request must not acquire the new account identity')
    assert.notEqual((await store.read('xai')).dshReasoningIdentity, identity)
    const diagnostics = []
    const switched = await restarted.completeSimple(initial.model, nextContext, { ...options, onReasoningDegrade: code => diagnostics.push(code) })
    assert.equal(switched.stopReason, 'error')
    assert.deepEqual(diagnostics, ['REASONING_SCOPE_MISMATCH'])
    assert.ok(!JSON.stringify(server.requests.at(-1).input).includes('encrypted_content'))
  } finally { await server.close() }
})

test('Responses summary is display-only; Copilot unsupported opaque chat fields fail explicitly', async () => {
  for (const opaqueChat of [false, true]) {
    const server = await reasoningMock(assert, { wire: opaqueChat ? 'chat' : 'responses', summary: true, opaqueChat })
    try {
      const { models, model, options } = modelsFor(opaqueChat ? 'github-copilot' : 'xai', opaqueChat ? 'openai-completions' : 'openai-responses', server)
      const message = await models.completeSimple(model, { messages: [], tools: [tool] }, options)
      if (opaqueChat) {
        assert.equal(message.stopReason, 'error')
        assert.match(message.errorMessage, /unsupported opaque Chat Completions field/)
      } else {
        assert.equal(message.content[0].thinking, DISPLAY)
        assert.ok(!JSON.stringify(persist(message).content).includes(CIPHER))
      }
    } finally { await server.close() }
  }
})

test('long thinking with empty summary: actual provider activity rearms idle timeout; no pulse still times out', async () => {
  for (const pulse of [true, false]) {
    const server = await reasoningMock(assert, { wire: 'responses', thinkingDelayMs: 160 })
    const caller = new AbortController()
    const watchdog = idleWatchdog(caller.signal, 80, 'LLM_STREAM_IDLE_TIMEOUT')
    try {
      const { models, model, options } = modelsFor('xai', 'openai-responses', server)
      const iterator = models.streamSimple(model, { messages: [], tools: [tool] }, {
        ...options, signal: watchdog.signal,
        onProviderStreamEvent: () => { if (pulse) watchdog.pulse() },
      })[Symbol.asyncIterator]()
      const consume = async () => {
        let done
        while (true) {
          const next = await watchdog.next(iterator)
          if (next.done) break
          if (next.value.type === 'done') done = next.value.message
        }
        assert.equal(done?.stopReason, 'toolUse')
      }
      if (pulse) await consume()
      else await assert.rejects(consume(), /LLM_STREAM_IDLE_TIMEOUT/)
    } finally {
      caller.abort(); watchdog[Symbol.dispose](); await server.close()
    }
  }
})

for (const [provider, api, wire] of [
  ['openai-codex', 'openai-codex-responses', 'responses'], ['xai', 'openai-responses', 'responses'],
  ['anthropic', 'anthropic-messages', 'messages'], ['github-copilot', 'openai-completions', 'chat'],
]) test(`${provider}: full Harness adapter, real BlockAssembler, JSON history, and empty-summary replay`, async () => {
  const server = await reasoningMock(assert, { wire, thinkingDelayMs: wire === 'responses' ? 160 : 0 })
  try {
    const { model, models, options } = modelsFor(provider, api, server)
    const diagnostics = []
    const adapter = new PiAiAdapter({ resolveApiKey: async () => options.apiKey,
      onReplayDegrade: value => diagnostics.push(value) })
    const snapshot = { models, profiles: new Map([[provider, { modelErrors: new Map(), piProvider: models.getProvider(provider),
      transport: 'sse', streamIdleTimeoutMs: 80 }]]) }
    const request = { provider, model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the workspace and report.' }] }], tools: [tool] }
    const collect = async request => {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.streamWithSnapshot(request, snapshot)) assembler.push(chunk)
      return assembler
    }
    const first = await collect(request)
    assert.equal(first.finish.kind, 'tool-calls', JSON.stringify(first.finish))
    const content = first.blocks()
    assert.equal(first.replayState.blocks.length, content.length)
    assert.ok(content.some(block => block.type === 'reasoning'))
    if (wire === 'responses') assert.equal(content[0].text, '')
    const saved = JSON.parse(JSON.stringify({ role: 'assistant', content,
      source: { provider, model: model.id, replayState: first.replayState } }))
    const call = content.find(block => block.type === 'tool-call')
    const second = await collect({ ...request, messages: [...request.messages, saved,
      { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'README.md exists.' }] }] })
    assert.equal(second.finish.kind, 'stop', JSON.stringify(second.finish))
    assert.deepEqual(diagnostics, [])
    assertReplay(server.requests[1], wire, assert)
  } finally { await server.close() }
})
