// 订阅 provider 的 SSE 面（issue #1284）：待处理缓冲要有上限，空闲看门狗要按**整体停滞**判、
// 并且必须给出能区分「慢但在走」与「真卡住」的可观测事实。
//
// 判据分三组：
//   ① 上限：不换行的大流量必须在越过上限时失败关闭，且不得把内存吃光；
//   ② 看门狗：滴流（每 chunk 重置）不得让超时永不触发，同时**不能**把「慢但在走」误杀；
//   ③ 末帧：只以 \n 结尾的合法末帧必须被派发，而不是 STREAM_CLOSED。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(HERE, '..', 'vendor', 'dsh-plugin-subscriptions', 'lib')

/**
 * 载入 vendored 文件。它 import 的 `@deepseek-ai/dsh-llm` 在本仓不可解析（引擎树提供），
 * 用 `module.registerHooks` 打桩成最小实现：只提供本文件真正用到的 `LlmError`。
 * 断言的都是纯逻辑，不依赖引擎其余行为。
 */
function loadWithStubs(relPath) {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-llm') return { url: 'subs-stub:dsh-llm', shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url === 'subs-stub:dsh-llm') {
        return {
          format: 'module',
          source: 'export class LlmError extends Error { constructor(message, code, extra) { super(message); this.name = "LlmError"; this.code = code; if (extra) Object.assign(this, extra) } }\n'
            + 'export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"\n'
            + 'export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED"\n'
            + 'export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED"\n'
            + 'export const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL"\n'
            + 'export class LlmAdapter {}\n'
            + 'export class ReasoningEffortId {}\n'
            + 'export const RetryPolicySchema = {}\n'
            + 'export function isContextWindowExceededError() { return false }\n'
            + 'export function isQuotaExceededError() { return false }\n'
            + 'export function resolveRetryPolicy() { return { maxDelayMs: 0 } }\n'
            + 'export function attributionHeaders() { return {} }\n'
            + 'export function errorChain() { return "" }\n'
            + 'export const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED"\n',
          shortCircuit: true,
        }
      }
      return next(url, context)
    },
  })
  return import(pathToFileURL(join(VENDOR, relPath)).href + '?t=' + Math.random())
}

/** 造一条「按给定分片吐字节」的 ReadableStream。 */
function streamOf(chunks) {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      const chunk = chunks[i]
      i += 1
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
    },
  })
}

test('#1284 ① 不换行的巨量输入：越过上限即失败关闭，错误里带观测到的尺寸', async () => {
  const { parseSse, MAX_PENDING_CHARS } = await loadWithStubs('translate/sse.js')
  // 4 MiB × 8 片，全无换行 —— 与 issue 里的复现同形（原实现 heapUsed +132 MiB）
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(120 /* 'x' */)
  const events = []
  let error
  try {
    for await (const event of parseSse(streamOf(Array.from({ length: 8 }, () => chunk)))) events.push(event)
  }
  catch (e) { error = e }
  assert.ok(error !== undefined, '无换行巨量输入必须失败关闭，而不是无限缓冲（实得 ' + events.length + ' 个事件、无错误）')
  assert.match(String(error.message), /SSE frame exceeded/, '错误必须点名是帧超限：' + error.message)
  assert.match(String(error.message), new RegExp(String(MAX_PENDING_CHARS)), '错误必须带上限值，便于现场判断')
  assert.equal(events.length, 0, '超限之前不应派发任何事件')
})

test('#1284 ① 上限以下的大帧仍必须被接受（不能把合法大帧一并否掉）', async () => {
  const { parseSse, MAX_PENDING_CHARS } = await loadWithStubs('translate/sse.js')
  // 合法最大形态：一个 5 MiB 附件的 base64（约 6.99 M 字符）装进一条 data: 行
  const payload = 'A'.repeat(6.9 * 1024 * 1024)
  const frame = 'data: {"choices":[{"delta":{"content":"' + payload + '"}}]}\n\n'
  const events = []
  for await (const event of parseSse(streamOf([frame]))) events.push(event)
  assert.equal(events.length, 1, '合法大帧必须派发（上限不得小到把 5 MiB 附件形态否掉）')
  assert.ok(events[0].data.length > 6 * 1024 * 1024)
  assert.ok(MAX_PENDING_CHARS >= payload.length, '上限必须容得下 5 MiB 附件的 base64 形态')
})

test('#1284 ② 只送字节不完成帧：判 trickling（不误杀，但能被看见）', async () => {
  const { idleWatchdog } = await loadWithStubs('providers/common.js')
  const watchdog = idleWatchdog(undefined, 120)
  try {
    // 有字节、无帧：这正是 issue 里的形态（无限缓冲 + 每 chunk 重置计时）。原实现里
    // 它同时是「内存涨」与「超时永不触发」；修法要让它**保持存活**但**可被识别**。
    let ticks = 0
    const started = Date.now()
    while (Date.now() - started < 400) {
      watchdog.progress()
      ticks += 1
      await new Promise((r) => setTimeout(r, 30))
    }
    const snapshot = watchdog.snapshot()
    assert.ok(ticks > 5, '本用例必须真的滴流过（实得 ' + ticks + ' 次）')
    assert.equal(watchdog.timedOut(), false, '还在送字节的流不得被判空闲超时（那是反向 bug）')
    assert.equal(snapshot.verdict, 'trickling',
      '有字节无帧必须判 trickling：实得 ' + snapshot.verdict + '，快照 ' + JSON.stringify(snapshot))
    assert.ok(snapshot.sinceEventMs > 120, 'sinceEventMs 必须真的超过上限：' + snapshot.sinceEventMs)
    assert.match(watchdog.stallReport(), /stream trickling \d+ms of 120ms cap \(last byte \d+ms ago, last frame \d+ms ago, \d+ chunks, \d+ events\)/,
      'stallReport 必须是可贴进日志的单行事实：' + watchdog.stallReport())
  }
  finally { watchdog.stop() }
})

test('#1284 ② 真的卡住（零进展）必须超时，且快照里 verdict=idle', async () => {
  const { idleWatchdog } = await loadWithStubs('providers/common.js')
  const watchdog = idleWatchdog(undefined, 80)
  try {
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(watchdog.timedOut(), true, '零进展必须触发空闲超时')
    const snapshot = watchdog.snapshot()
    assert.equal(snapshot.verdict, 'idle', 'verdict 必须是 idle，实得 ' + snapshot.verdict)
    assert.equal(snapshot.chunks, 0, '没有任何 chunk 时应为 0')
  }
  finally { watchdog.stop() }
})

test('#1284 ② 字节与帧都在走：判 healthy（反向用例，修法不得把正常流当异常）', async () => {
  const { idleWatchdog } = await loadWithStubs('providers/common.js')
  const watchdog = idleWatchdog(undefined, 100)
  try {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 40))
      watchdog.progress()
      watchdog.event()
    }
    assert.equal(watchdog.timedOut(), false, '每 40ms 都有进度的流不得超时')
    const snapshot = watchdog.snapshot()
    assert.equal(snapshot.verdict, 'healthy', '健康流 verdict 应为 healthy，实得 ' + snapshot.verdict)
    assert.equal(snapshot.events, 8, 'events 必须被记录')
    assert.ok(snapshot.sinceEventMs < 100, 'healthy 时 sinceEventMs 必须在上限内')
  }
  finally { watchdog.stop() }
})

test('#1284 ③ 末帧只有 \n、没有空行时也必须派发（三条 wire 共用同一解析器）', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const frame = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n'
  const events = []
  for await (const event of parseSse(streamOf([frame]))) events.push(event)
  assert.equal(events.length, 1, 'EOF 前的完整帧必须派发（旧实现丢弃 ⇒ 三条 wire 全报 STREAM_CLOSED）')
  assert.match(events[0].data, /finish_reason/)
})

test('#1284 两份打包副本都带上了同一处修复（改一份漏一份是这里的既定坑）', async () => {
  // lib/translate/sse.js + lib/providers/common.js 是源码形态，lib/index.js 是 rollup 打包副本：
  // 同一处逻辑存在两份。历史坑（#1282 实测）：只改一份，另一份照旧出厂，测试全绿。
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(join(VENDOR, 'index.js'), 'utf8')
  assert.match(bundle, /const MAX_PENDING_CHARS = 8 \* 1024 \* 1024/, 'index.js 缺 MAX_PENDING_CHARS（或数值与源码副本不一致）')
  assert.match(bundle, /SSE frame exceeded/, 'index.js 缺帧超限的失败关闭分支')
  assert.match(bundle, /sinceEventMs/, 'index.js 缺「帧停滞」时钟（看门狗仍是每 chunk 重置）')
  assert.match(bundle, /verdict: expired \? "idle" : trickling \? "trickling" : "healthy"/, 'index.js 缺三态判定')
  assert.match(bundle, /last frame \$\{String\(s\.sinceEventMs\)\}ms ago/, 'index.js 缺 stallReport 的可观测事实')
  assert.equal(/watchdog\.pulse\(\)/.test(bundle), false, 'index.js 仍有调用点用旧的 pulse()（未接帧计数）')

  const sseSource = readFileSync(join(VENDOR, 'translate/sse.js'), 'utf8')
  assert.match(sseSource, /export const MAX_PENDING_CHARS = 8 \* 1024 \* 1024/, 'sse.js 的上限必须导出且为同一数值')
})

test('#1284 ③ 对照：带空行的末帧仍然只派发一次（不得重复派发）', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const events = []
  for await (const event of parseSse(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\n']))) events.push(event)
  assert.equal(events.length, 2, '两帧必须派发两次（EOF 收尾不得把已派发的帧再算一次）')
  assert.deepEqual(events.map((e) => e.data), ['{"a":1}', '{"b":2}'])
})
