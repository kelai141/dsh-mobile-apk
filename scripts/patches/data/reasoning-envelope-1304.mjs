/** Provider-native reasoning stays sealed; only the display text enters Harness content. */
export const REASONING_MARKER = 'dsh-mobile sealed reasoning (1304)'
const NM = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/'
export const REASONING_FILES = [
  NM + '@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  NM + '@earendil-works/pi-ai/dist/models.js',
  ...['openai-responses-shared', 'anthropic-messages', 'openai-completions', 'transform-messages']
    .map(name => NM + '@earendil-works/pi-ai/dist/api/' + name + '.js'),
  NM + '@deepseek-ai/dsh-client-ui-chat/lib/client.js',
]

function replace(source, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`reasoning-1304: upstream contract drift (${count} matches): ${before.slice(0, 100)}`)
  return source.replace(before, after)
}

/** Strict Responses replay shape. Opaque strings are never normalized or trimmed. */
export function replayReasoningItem(value) {
  if (!value || value.type !== 'reasoning') throw new Error('reasoning-1304: invalid reasoning item type')
  if (value.encrypted_content !== undefined && value.encrypted_content !== null
      && typeof value.encrypted_content !== 'string') throw new Error('reasoning-1304: invalid encrypted reasoning')
  if (value.summary != null && !Array.isArray(value.summary)) throw new Error('reasoning-1304: invalid reasoning summary')
  // No content:null, status, or provider-only output properties in input items.
  return {
    type: 'reasoning',
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    summary: value.summary ?? [],
    ...(typeof value.encrypted_content === 'string' ? { encrypted_content: value.encrypted_content } : {}),
  }
}

export function readReasoningSignature(signature) {
  try { return replayReasoningItem(JSON.parse(signature)) }
  catch { throw new Error('reasoning-1304: invalid sealed Responses item') }
}

export function readClaudeSeal(signature) {
  try {
    const block = JSON.parse(signature)
    if (block.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string') return block
    if (block.type === 'redacted_thinking' && typeof block.data === 'string') return block
  } catch {}
  throw new Error('reasoning-1304: invalid Claude sealed block')
}

/** Each Responses tool step begins with its reasoning, without moving seals across tool batches. */
export function reasonFirst(items) {
  const result = []
  let step = []
  const flush = () => {
    result.push(...step.filter(item => item.type === 'reasoning'), ...step.filter(item => item.type !== 'reasoning'))
    step = []
  }
  for (const item of items) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') { flush(); result.push(item) }
    else step.push(item)
  }
  flush()
  return result
}

export function readCopilotSeal(bytes) {
  try {
    const seal = JSON.parse(bytes)
    if (seal.sealedBy === 'github-copilot' && typeof seal.reasoning_opaque === 'string') return seal
  } catch {}
  throw new Error('reasoning-1304: invalid Copilot sealed block')
}

/** CAPI permits one reasoning_opaque per message. Keep segments separate, never concatenate credentials. */
export function copilotAssistantParts(blocks, assistant) {
  if (!blocks.some(block => block.type === 'thinking' && block.dshSealed !== undefined)) return [assistant]
  const result = []
  let part
  const flush = () => { if (part) result.push(part) }
  for (const block of blocks) {
    if (block.type === 'thinking' && block.dshSealed !== undefined) {
      flush()
      const seal = readCopilotSeal(block.dshSealed)
      part = { role: 'assistant', content: '', reasoning_opaque: seal.reasoning_opaque, reasoning_text: block.thinking }
    } else if (block.type === 'text') {
      part ??= { role: 'assistant', content: '' }
      part.content += block.text
    } else if (block.type === 'toolCall') {
      part ??= { role: 'assistant', content: '' }
      const call = assistant.tool_calls?.find(call => call.id === block.id)
      // The existing G2 history guard deliberately drops unnamed calls and their results.
      if (!call && (typeof block.name !== 'string' || block.name.trim() === '')) continue
      if (!call) throw new Error('reasoning-1304: missing Copilot tool mapping')
      ;(part.tool_calls ??= []).push(call)
    }
  }
  flush()
  return result
}

/** Restore tool-call/result adjacency after splitting interleaved CAPI reasoning segments. */
export function copilotToolRuns(messages) {
  if (!messages.some(message => Object.hasOwn(message, 'reasoning_opaque'))) return messages
  const result = []
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]
    if (current.role !== 'assistant' || !current.tool_calls?.length) { result.push(current); continue }
    let end = i + 1
    while (end < messages.length && (messages[end].role === 'assistant' || messages[end].role === 'tool')) end++
    const run = messages.slice(i, end)
    const outputs = new Map(run.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message]))
    if (outputs.size !== run.filter(message => message.role === 'tool').length)
      throw new Error('reasoning-1304: duplicate Copilot tool output')
    for (const message of run) {
      if (message.role !== 'assistant') continue
      result.push(message)
      for (const call of message.tool_calls ?? []) {
        const output = outputs.get(call.id)
        if (!output) throw new Error('reasoning-1304: incomplete Copilot tool run')
        result.push(output)
        outputs.delete(call.id)
      }
    }
    if (outputs.size) throw new Error('reasoning-1304: orphan Copilot tool output')
    i = end - 1
  }
  return result
}

/** Bind to the actual resolved request identity, after OAuth refresh and endpoint overrides. */
export function reasoningScope(model, options, hash) {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  // JWT account identity survives token refresh; opaque keys fail closed on rotation.
  const identity = token => {
    try {
      const claims = JSON.parse(Buffer.from(String(token).replace(/^Bearer /i, '').split('.')[1], 'base64url').toString())
      const tenant = claims['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.account_id ?? claims.tid
      if (typeof claims.sub === 'string') return [claims.iss, claims.sub, tenant]
    } catch {}
    return token ?? ''
  }
  return hash(JSON.stringify([model.provider, model.api, model.id, model.baseUrl, identity(options.apiKey),
    Object.keys(headers).sort().map(key => [key, /authorization|api-key/.test(key) ? identity(headers[key]) : headers[key]])]))
}

/** Drop foreign seals with a safe diagnostic. Never turn foreign thinking into assistant prose. */
export function scopeReasoningHistory(context, scope, model, report) {
  return { ...context, messages: context.messages.map(message => {
    if (message.role !== 'assistant') return message
    const hasThinking = message.content.some(block => block.type === 'thinking' || block.thoughtSignature)
    const same = message.dshReasoningScope === scope && message.provider === model.provider
      && message.api === model.api && message.model === model.id
    if (same || !hasThinking) return message
    report('REASONING_SCOPE_MISMATCH')
    return { ...message, api: 'dsh-foreign', content: message.content.filter(block => block.type !== 'thinking')
      .map(block => {
        const { thoughtSignature, textSignature, ...plain } = block
        return plain
      }) }
  }) }
}

/** Preserve the native EventStream contract, including .result() and terminal errors. */
export function scopedReasoningStream(stream, scope, createStream) {
  const result = createStream()
  ;(async () => {
    try {
      let terminal = false
      for await (const event of stream) {
        terminal ||= event.type === 'done' || event.type === 'error'
        for (const message of [event.partial, event.message, event.error]) {
          if (message) message.dshReasoningScope = scope
        }
        result.push(event)
      }
      if (!terminal) throw new Error('missing terminal event')
      result.end()
    } catch (error) {
      // Native streams normally report errors in-band. A thrown stream remains loud.
      result.push({ type: 'error', reason: 'error', error: {
        role: 'assistant', content: [], stopReason: 'error', errorMessage: 'reasoning-1304: provider stream failed',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } })
      result.end()
    }
  })()
  return result
}

export function patchReasoningAdapter(source) {
  let out = replace(source, 'kind: "pi-ai",\n\t\t\tversion: 2,',
    'kind: "pi-ai",\n\t\t\tversion: 2,\n\t\t\t...message.dshReasoningScope === void 0 ? {} : { dshReasoningScope: message.dshReasoningScope },')
  out = replace(out, '...block.redacted === void 0 ? {} : { redacted: block.redacted }',
    '...block.redacted === void 0 ? {} : { redacted: block.redacted },\n\t\t\t\t\t...block.dshSealed === void 0 ? {} : { dshSealed: block.dshSealed }')
  out = replace(out, '"thinkingSignature",\n\t\t\t"thoughtSignature",',
    '"thinkingSignature",\n\t\t\t"dshSealed",\n\t\t\t"thoughtSignature",')
  out = replace(out, '...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {}',
    '...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {},\n\t\t\t\t\t...replay.type === "reasoning" && replay.dshSealed !== void 0 ? { dshSealed: replay.dshSealed } : {}')
  out = replace(out, 'api: state.response.api,', 'dshReasoningScope: state.response.dshReasoningScope,\n\t\tapi: state.response.api,')
  // Errors may contain malformed replay values: log codes, never credentials or sealed bytes.
  out = replace(out, 'onDegrade?.(error.message);', 'onDegrade?.("INVALID_REPLAY_STATE");')
  out = replace(out, 'headers: requestHeaders(profile.headers)',
    'headers: requestHeaders(profile.headers),\n\t\t\t\t\tonReasoningDegrade: onReplayDegrade,\n\t\t\t\t\tonProviderStreamEvent: () => watchdog.pulse()')
  return out
}

export function patchReasoningModels(source) {
  let out = 'import { createHash as dshReasoningHash } from "node:crypto";\n'
    + 'import { createAssistantMessageEventStream as dshReasoningStream } from "./utils/event-stream.js";\n'
    + [reasoningScope, scopeReasoningHistory, scopedReasoningStream].map(fn => fn.toString()).join('\n') + '\n' + source
  for (const method of ['stream', 'streamSimple']) {
    out = replace(out, `return provider.${method}(requestModel, transcript, requestOptions);`,
      `const scope = reasoningScope(requestModel, requestOptions, value => dshReasoningHash("sha256").update(value).digest("hex"));
            const report = requestOptions.onReasoningDegrade ?? (code => console.warn("llm-pi-ai: " + code));
            const history = scopeReasoningHistory(transcript, scope, requestModel, report);
            return scopedReasoningStream(provider.${method}(requestModel, history, requestOptions), scope, dshReasoningStream);`)
  }
  return out
}

export function patchReasoningResponses(source) {
  let out = [replayReasoningItem, readReasoningSignature, reasonFirst].map(fn => fn.toString()).join('\n') + '\n' + source
  out = replace(out, 'const reasoningItem = JSON.parse(block.thinkingSignature);',
    'const reasoningItem = readReasoningSignature(block.thinkingSignature);')
  out = replace(out, 'return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);',
    `const completed = item.type === "reasoning" ? reasoningBlocksById.get(item.id) : undefined;
        if (completed) return { type: "thinking", block: completed, contentIndex: output.content.indexOf(completed) };
        return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);`)
  // Do not reorder native blocks: interleaved reasoning/tool batches must keep their boundaries.
  // Terminal-only items (and omitted output_item.done events) must still produce blocks.
  out = replace(out, 'backfillReasoningSignatures(response.output ?? []);',
    `for (const [index, item] of (response.output ?? []).entries()) {
            if (item.type !== "reasoning") continue;
            const previous = reasoningBlocksById.get(item.id);
            if (previous) {
                const stored = JSON.parse(previous.thinkingSignature);
                previous.thinkingSignature = JSON.stringify(replayReasoningItem({ ...stored, ...item,
                    encrypted_content: item.encrypted_content ?? stored.encrypted_content }));
                const text = Array.isArray(item.summary) ? item.summary.map(part => part.text ?? "").join("\\n\\n") : previous.thinking;
                if (text !== previous.thinking) {
                    previous.thinking = text;
                    stream.push({ type: "thinking_end", contentIndex: output.content.indexOf(previous), content: text, partial: output });
                }
                continue;
            }
            const slot = getOrCreateSlot(index, item);
            if (slot?.type !== "thinking") throw new Error("reasoning-1304: terminal reasoning slot mismatch");
            slot.block.thinking = item.summary?.map(s => s.text ?? "").join("\\n\\n") || slot.block.thinking;
            slot.block.thinkingSignature = JSON.stringify(replayReasoningItem(item));
            reasoningBlocksById.set(item.id, slot.block);
            stream.push({ type: "thinking_end", contentIndex: slot.contentIndex, content: slot.block.thinking, partial: output });
            outputSlots.delete(index);
        }
        backfillReasoningSignatures(response.output ?? []);`)
  out = replace(out, 'slot.block.thinkingSignature = JSON.stringify(item);',
    'slot.block.thinkingSignature = JSON.stringify(replayReasoningItem(item));')
  out = replace(out, 'messages.push(...output);', 'messages.push(...reasonFirst(output));')
  return out
}

export function patchReasoningAnthropic(source) {
  let out = readClaudeSeal.toString() + '\n' + source
  out = replace(out, 'thinkingSignature: event.content_block.signature ?? "",',
    'thinkingSignature: event.content_block.signature ?? "",\n                            dshSealed: JSON.stringify(event.content_block),')
  out = replace(out, 'thinking: "[Reasoning redacted]",', 'thinking: "",')
  out = replace(out, 'thinkingSignature: event.content_block.data,',
    'thinkingSignature: event.content_block.data,\n                            dshSealed: JSON.stringify(event.content_block),')
  out = replace(out, 'else if (block.type === "thinking") {\n                            stream.push({',
    `else if (block.type === "thinking") {
                            const sealed = JSON.parse(block.dshSealed);
                            block.dshSealed = JSON.stringify(block.redacted ? sealed : {
                                ...sealed, thinking: block.thinking, signature: block.thinkingSignature,
                            });
                            stream.push({`)
  out = replace(out, '// Redacted thinking: pass the opaque payload back as redacted_thinking',
    `if (block.dshSealed !== undefined) {
                        const sealed = readClaudeSeal(block.dshSealed);
                        blocks.push(sealed);
                        continue;
                    }
                    // Redacted thinking: pass the opaque payload back as redacted_thinking`)
  return out
}

export function patchReasoningCompletions(source) {
  // Copilot also routes Claude and Responses models; never infer one wire from the provider name.
  // CAPI reasoning_opaque/reasoning_text are defined by Microsoft's Copilot client:
  // src/platform/thinking/common/thinking.ts and endpoint/node/copilotChatEndpoint.ts.
  // The field inventory probe remains test-only; no claim of a real-account probe.
  let out = [readCopilotSeal, copilotAssistantParts, copilotToolRuns].map(fn => fn.toString()).join('\n') + '\n' + source
  out = replace(out,
    'const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"];',
    'const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text", "reasoning_summary"];')
  out = replace(out, 'const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];',
    'const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text", "reasoning_summary"];')
  out = replace(out, 'if (choice.delta) {\n                    if (choice.delta.content !== null',
    `if (choice.delta) {
                    const opaque = choice.delta.reasoning_opaque;
                    if (opaque != null) {
                        if (model.provider !== "github-copilot" || typeof opaque !== "string")
                            throw new Error("reasoning-1304: unsupported reasoning_opaque issuer or shape");
                        if (opaque.length > 0) {
                            const previous = thinkingBlock?.dshSealed === undefined ? undefined : readCopilotSeal(thinkingBlock.dshSealed);
                            if (!previous || previous.reasoning_opaque !== opaque) {
                                if (previous) thinkingBlock = null;
                                textBlock = null;
                            }
                            const sealedBlock = ensureThinkingBlock("reasoning_text");
                            sealedBlock.dshSealed = JSON.stringify({ sealedBy: "github-copilot", reasoning_opaque: opaque });
                        }
                    }
                    if (choice.delta.content !== null`)
  out = replace(out, 'const deltaFields = choice.delta;',
    `const deltaFields = choice.delta;
                    if (deltaFields.encrypted_content !== undefined || deltaFields.signature !== undefined)
                        throw new Error("reasoning-1304: unsupported opaque Chat Completions field; use native Responses/Messages");`)
  // Missing reasoning is required only by upstreams that explicitly opt in (DeepSeek/MiMo).
  // Use an actual character so gateways that elide empty strings cannot lose the required key.
  out = replace(out, 'assistantMsg.reasoning_content = "";', 'assistantMsg.reasoning_content = " ";')
  out = replace(out, 'params.push(assistantMsg);',
    'params.push(...(model.provider === "github-copilot" ? copilotAssistantParts(msg.content, assistantMsg) : [assistantMsg]));')
  out = replace(out, 'if (!hasContent && !assistantMsg.tool_calls) {',
    'if (!hasContent && !assistantMsg.tool_calls && !thinkingBlocks.some(block => block.dshSealed !== undefined) && !preservedReasoningDetails?.length) {')
  out = replace(out, 'lastRole = msg.role;\n    }\n    return params;',
    'lastRole = msg.role;\n    }\n    return model.provider === "github-copilot" ? copilotToolRuns(params) : params;')
  return out
}

export function patchReasoningTransform(source) {
  return replace(source, 'return {\n                        type: "text",\n                        text: block.thinking,\n                    };',
    '// Foreign reasoning is display-only and cannot be replayed as assistant prose.\n                    return [];')
}

export function patchReasoningUi(source) {
  let out = replace(source, 'if (block.text.trim() === "") break;',
    '// Empty summaries still own a normal reasoning disclosure (1304).')
  // Published and source-built bundles differ in indentation. Match these exact two
  // statements with indentation ignored; still reject missing or duplicate semantic anchors.
  const visible = /function blockIsVisible\(block\) \{\r?\n[\t ]*if \(block === void 0 \|\| block.kind === "tool-call"\) return false;/g
  const matches = [...out.matchAll(visible)]
  if (matches.length !== 1) throw new Error('reasoning-1304: UI visibility contract drift')
  out = out.replace(visible, 'function blockIsVisible(block) {\n\t\t\tif (block?.kind === "reasoning") return true;\n\t\t\tif (block === void 0 || block.kind === "tool-call") return false;')
  out = replace(out, 'if (chunk.type === "block-start") return chunk.blockType !== "text" && chunk.blockType !== "reasoning" && chunk.blockType !== "tool-call";',
    'if (chunk.type === "block-start") return chunk.blockType === "reasoning" || (chunk.blockType !== "text" && chunk.blockType !== "tool-call");')
  out = replace(out, 'const inlineReasoning = answer.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");',
    'const inlineReasoning = answer.blocks.some((block) => block.kind === "reasoning");')
  out = replace(out, 'return node.kind === "assistant-step" && node.data.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");',
    'return node.kind === "assistant-step" && node.data.blocks.some((block) => block.kind === "reasoning");')
  return out
}

const PATCHERS = [patchReasoningAdapter, patchReasoningModels, patchReasoningResponses,
  patchReasoningAnthropic, patchReasoningCompletions, patchReasoningTransform, patchReasoningUi]

const CONTRACTS = [
  ['{ dshReasoningScope: message.dshReasoningScope }', '{ dshSealed: block.dshSealed }',
    '{ dshSealed: replay.dshSealed }', 'onReasoningDegrade: onReplayDegrade'],
  ['scopeReasoningHistory(transcript, scope, requestModel, report)',
    'scopedReasoningStream(provider.streamSimple', 'scopedReasoningStream(provider.stream('],
  ['readReasoningSignature(block.thinkingSignature)', 'terminal reasoning slot mismatch',
    'JSON.stringify(replayReasoningItem(item))', 'messages.push(...reasonFirst(output));'],
  ['dshSealed: JSON.stringify(event.content_block)', 'blocks.push(sealed)', 'JSON.parse(block.dshSealed)'],
  ['"reasoning_text", "reasoning_summary"', 'unsupported opaque Chat Completions field', 'assistantMsg.reasoning_content = " "',
    'copilotAssistantParts(msg.content, assistantMsg)', 'copilotToolRuns(params)', 'sealedBlock.dshSealed = JSON.stringify'],
  ['// Foreign reasoning is display-only and cannot be replayed as assistant prose.\n                    return [];'],
  ['// Empty summaries still own a normal reasoning disclosure (1304).', 'if (block?.kind === "reasoning") return true;',
    'const inlineReasoning = answer.blocks.some((block) => block.kind === "reasoning");'],
]

/** Exact anchors, no version whitelist: compatible upgrades work, drift blocks injection atomically. */
export function planReasoning(read) {
  return REASONING_FILES.map((file, index) => {
    const before = read(file)
    if (before.includes('// ' + REASONING_MARKER)) {
      if (!CONTRACTS[index].every(token => before.includes(token)))
        throw new Error('reasoning-1304: incomplete installed patch: ' + file)
      return { file, before, after: before }
    }
    const after = PATCHERS[index](before) + '\n// ' + REASONING_MARKER + '\n'
    return { file, before, after }
  })
}
