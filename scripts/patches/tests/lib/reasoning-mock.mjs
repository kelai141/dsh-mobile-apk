/** Test-only native protocol server. Never imported into a shipping plugin or patch. */
import { createServer } from 'node:http'
import { zstdDecompressSync } from 'node:zlib'

export const CIPHER = 'opaque+/_凭证==\r\n  no-trimming  '
export const SIG = 'sig+/==\r\n unchanged '
export const DISPLAY = 'I will inspect the workspace before answering.'
export const tool = { name: 'inspect', description: 'Inspect the workspace', parameters: { type: 'object', properties: {} } }

export function assertReplay(body, wire, assert, { blankChat = false, copilotSegments = 1 } = {}) {
  if (wire === 'responses') {
    const input = body.input
    const call = input.findIndex(item => item.type === 'function_call')
    assert.ok(call > 0, 'missing function call')
    const reasoning = input[call - 1]
    assert.equal(reasoning.type, 'reasoning', 'reasoning must immediately precede its tool call')
    assert.equal(reasoning.encrypted_content, CIPHER)
    assert.deepEqual(reasoning.summary, [])
    assert.equal(Object.hasOwn(reasoning, 'content'), false)
    assert.ok(input.findIndex(item => item.type === 'function_call_output') > call)
  } else if (wire === 'messages') {
    const assistant = body.messages.filter(item => item.role === 'assistant').at(-1)
    assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: DISPLAY, signature: SIG })
    assert.deepEqual(assistant.content[1], { type: 'thinking', thinking: '', signature: SIG + '2', display: 'omitted' })
    assert.deepEqual(assistant.content[2], { type: 'redacted_thinking', data: CIPHER })
    assert.equal(assistant.content[3].type, 'tool_use')
  } else {
    const parts = body.messages.filter(item => item.role === 'assistant' && Object.hasOwn(item, 'reasoning_opaque'))
    assert.equal(parts.length, copilotSegments)
    for (const [index, assistant] of parts.entries()) {
      assert.equal(assistant.reasoning_opaque, CIPHER + (index ? '#' + index : ''))
      assert.equal(assistant.reasoning_text, blankChat ? '' : DISPLAY)
      if (copilotSegments > 1) assert.equal(assistant.content, 'segment ' + index)
      assert.ok(assistant.tool_calls.length)
      const position = body.messages.indexOf(assistant)
      assert.equal(body.messages[position + 1].role, 'tool')
      assert.equal(body.messages[position + 1].tool_call_id, assistant.tool_calls[0].id)
    }
  }
}

/** Field names/types only. Probe output never contains values, token fragments, or seals. */
export function fieldInventory(value, path = '', fields = new Set()) {
  if (Array.isArray(value)) for (const item of value) fieldInventory(item, path + '[]', fields)
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    const child = path ? path + '.' + key : key
    fields.add(child + ':' + (Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item))
    fieldInventory(item, child, fields)
  }
  return [...fields].sort()
}

export async function reasoningMock(assert, { wire, terminalOnly = false, summary = false, opaqueChat = false, thinkingDelayMs = 0, terminalSummary = false, duplicateDone = false, blankChat = false, copilotSegments = 1 } = {}) {
  const requests = []
  const failures = []
  const inventory = new Set()
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const body = JSON.parse(req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes)
      requests.push(body)
      const second = wire === 'responses' ? body.input.some(item => item.type === 'function_call_output')
        : body.messages.some(item => item.role === 'tool' || (Array.isArray(item.content) && item.content.some(b => b.type === 'tool_result')))
      if (second) assertReplay(body, wire, assert, { blankChat, copilotSegments })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const emit = event => {
        for (const field of fieldInventory(event)) inventory.add(field)
        res.write(`event: ${event.type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      if (wire === 'responses') {
        const reasoning = { type: 'reasoning', id: 'rs_test', ...(summary ? { summary: [{ type: 'summary_text', text: DISPLAY }] } : {}), encrypted_content: CIPHER, content: null }
        const result = second
          ? { type: 'message', role: 'assistant', id: 'msg_test', content: [{ type: 'output_text', text: 'Workspace checked.', annotations: [] }] }
          : { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'inspect', arguments: '{}' }
        emit({ type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } })
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_test', summary: [] } })
        const until = Date.now() + thinkingDelayMs
        while (Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 10))
          emit({ type: 'response.in_progress', response: { id: 'resp_test', status: 'in_progress' } })
        }
        if (summary) emit({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: DISPLAY })
        if (!terminalOnly) {
          emit({ type: 'response.output_item.done', output_index: 0, item: reasoning })
          if (duplicateDone) emit({ type: 'response.output_item.done', output_index: 0, item: reasoning })
        }
        emit({ type: 'response.output_item.added', output_index: 1, item: result })
        emit({ type: 'response.output_item.done', output_index: 1, item: result })
        emit({ type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [terminalSummary ? { ...reasoning, summary: [{ type: 'summary_text', text: DISPLAY }] } : reasoning, result], usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 } } })
      } else if (wire === 'messages') {
        emit({ type: 'message_start', message: { id: 'msg_claude', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 } } })
        const blocks = second ? [{ type: 'text', text: 'Workspace checked.' }] : [
          { type: 'thinking', thinking: DISPLAY, signature: SIG },
          { type: 'thinking', thinking: '', signature: SIG + '2', display: 'omitted' },
          { type: 'redacted_thinking', data: CIPHER },
          { type: 'tool_use', id: 'call_test', name: 'inspect', input: {} },
        ]
        for (const [index, block] of blocks.entries()) {
          const initial = block.type === 'thinking' ? { ...block, thinking: '', signature: '' } : block
          emit({ type: 'content_block_start', index, content_block: initial })
          if (block.type === 'thinking') {
            if (block.thinking) emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
            // Signature arrives fragmented; no chunk may get trimmed or reordered.
            for (const signature of [block.signature.slice(0, 5), block.signature.slice(5)])
              emit({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } })
          }
          emit({ type: 'content_block_stop', index })
        }
        emit({ type: 'message_delta', delta: { stop_reason: second ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
        emit({ type: 'message_stop' })
      } else {
        for (let index = 0; index < (second ? 1 : copilotSegments); index++) {
          const delta = second ? { content: 'Workspace checked.' } : {
            reasoning_text: blankChat ? '' : DISPLAY,
            reasoning_opaque: CIPHER + (index ? '#' + index : ''),
            ...(copilotSegments > 1 ? { content: 'segment ' + index } : {}),
            ...(opaqueChat ? { encrypted_content: CIPHER } : {}),
            tool_calls: [{ index, id: 'call_test' + (index ? '_' + index : ''), type: 'function', function: { name: 'inspect', arguments: '{}' } }],
          }
          emit({ id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
        }
        emit({ id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0,
          delta: second ? {} : { reasoning_opaque: CIPHER + (copilotSegments > 1 ? '#' + (copilotSegments - 1) : '') },
          finish_reason: second ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })
        res.write('data: [DONE]\n\n')
      }
      res.end()
    } catch (error) {
      failures.push(error.message)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: error.message } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, failures, inventory,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
