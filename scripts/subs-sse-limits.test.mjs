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

// ── issue #1309：#1284 的修法把两处边界改坏了 ────────────────────────────────────
//
// ① 派发面：`dispatch()` 开始把「有 event 名但没 data 行」的帧也交出去，`{ data: '' }`。
//    保活帧 `event: ping\n\n` 正是这个形状，于是三条 wire 的 `JSON.parse('')` 抛
//    MALFORMED_RESPONSE —— 一条心跳打掉整条 chat 流。WHATWG 的「dispatch the event」
//    明确要求 data 缓冲为空时不派发。
//
// ② 上限面：判据写在扫描换行**之前**，量的是「这次 read 带来了多少字节」，而该常量的
//    推导（见 sse.js 头注）依据的是「**一个**合法帧能有多大」。两次的差别不是措辞：
//    一次 read 送 9 MiB 的完整小帧会被拒，同样的字节按 64 KiB 分片就全过。

test('#1309 ① event-only 帧（event: ping）不得派发：它是心跳，不是空负载', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const events = []
  for await (const event of parseSse(streamOf(['event: ping\n\n']))) events.push(event)
  assert.deepEqual(events, [],
    'event-only 帧被派发了，消费者会拿空字符串去 JSON.parse：' + JSON.stringify(events))
})

test('#1309 ① 前置一条 ping 帧时，chat wire 仍必须正常收流（不得 MALFORMED_RESPONSE）', async () => {
  const { streamChatCompletions } = await loadWithStubs('translate/chat-completions.js')
  const wire = 'event: ping\n\ndata: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
  const chunks = []
  let error
  try {
    for await (const chunk of streamChatCompletions(streamOf([wire]), undefined, undefined)) chunks.push(chunk)
  }
  catch (e) { error = e }
  assert.equal(error, undefined, '一条保活帧把整条流打断了：' + (error && error.code + ' ' + error.message))
  assert.ok(chunks.length > 0, '真帧必须被翻译成 StreamChunk，实得 ' + chunks.length + ' 个')
})

test('#1309 ① ping 之后的那一帧不得继承上一个 event 名', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const events = []
  for await (const event of parseSse(streamOf(['event: ping\n\n', 'event: delta\ndata: {"a":1}\n\n']))) events.push(event)
  assert.deepEqual(events, [{ data: '{"a":1}', event: 'delta' }],
    'event 名状态没有在「不派发」时清干净：' + JSON.stringify(events))
})

test('#1309 ② 一次 read 送入 9.4 MiB 的完整小帧：不得被判超限（上限按帧不按 read）', async () => {
  const { parseSse, MAX_PENDING_CHARS } = await loadWithStubs('translate/sse.js')
  // 943,719 个 `data: {}\n\n`，每个都以换行结尾 —— 没有一帧超过上限。
  const frame = 'data: {}\n\n'
  const count = Math.ceil((9 * 1024 * 1024) / frame.length)
  const bytes = new TextEncoder().encode(frame.repeat(count))
  assert.ok(bytes.length > MAX_PENDING_CHARS, '夹具必须真的超过上限值（实得 ' + bytes.length + ' B）')

  let events = 0
  let error
  try {
    for await (const _event of parseSse(streamOf([bytes]))) events += 1
  }
  catch (e) { error = e }
  assert.equal(error, undefined, '单次 read 携带的完整小帧被误判成超长帧：' + (error && error.message))
  assert.equal(events, count, '每个完整帧都必须派发一次，实得 ' + events + ' / ' + count)
})

test('#1309 ② 分片与整块必须给同一结论（判据不得依赖网络分片形状）', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const bytes = new TextEncoder().encode('data: {}\n\n'.repeat(Math.ceil((9 * 1024 * 1024) / 11)))
  const countOf = async (chunks) => {
    let n = 0
    for await (const _ of parseSse(streamOf(chunks))) n += 1
    return n
  }
  const whole = await countOf([bytes])
  const chunks = []
  for (let i = 0; i < bytes.length; i += 65536) chunks.push(bytes.slice(i, i + 65536))
  const split = await countOf(chunks)
  assert.equal(whole, split, '同一份字节因分片不同得到不同结论：整块 ' + whole + ' vs 分片 ' + split)
})

test('#1309 ② 真正超限的帧仍必须失败关闭，且文案说的是「帧」而不是「没换行」', async () => {
  const { parseSse, MAX_PENDING_CHARS } = await loadWithStubs('translate/sse.js')
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(120 /* 'x' */)
  let error
  let events = 0
  try {
    for await (const _ of parseSse(streamOf(Array.from({ length: 8 }, () => chunk)))) events += 1
  }
  catch (e) { error = e }
  assert.ok(error !== undefined, '无换行的 32 MiB 单帧必须失败关闭（实得 ' + events + ' 个事件、无错误）')
  assert.match(String(error.message), new RegExp(String(MAX_PENDING_CHARS)), '错误必须带上限值：' + error.message)
  // 旧文案 'without a newline' 在每个字节都带换行的场景下是假的——判据本身也会照着它查错方向。
  assert.equal(/without a newline/.test(String(error.message)), false,
    '错误文案仍声称「没有换行」，但它量的是帧长度：' + error.message)
  assert.match(String(error.message), /terminating blank line|frame /, '文案应指名是帧超限：' + error.message)
})

test('#1309 ② 改成按帧判之后，内存上限不得退化成「读完才拒」', async () => {
  const { parseSse, MAX_PENDING_CHARS } = await loadWithStubs('translate/sse.js')
  // 把判据挪到扫描之后，风险是「不换行的流要等 EOF 才判」——那时堆已经吃光了。
  // 用受控流数 read 次数：4 MiB × 未知数量，必须在越过上限的那一两个 chunk 内停下。
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(120)
  let reads = 0
  const stream = new ReadableStream({
    pull(controller) {
      reads += 1
      if (reads > 40) { controller.close(); return }
      controller.enqueue(chunk)
    },
  })
  let error
  try { for await (const _ of parseSse(stream)) { /* consume */ } }
  catch (e) { error = e }
  assert.ok(error !== undefined, '无换行流必须失败关闭（实得无错误，读了 ' + reads + ' 个 chunk）')
  const limitChunks = Math.ceil(MAX_PENDING_CHARS / chunk.byteLength)
  assert.ok(reads <= limitChunks + 2,
    '判据拖到「读完再拒」了：读了 ' + reads + ' 个 4 MiB chunk，而上限只允许 ' + limitChunks + ' 个左右')
})

// ── issue #1340：#1309 ② 把上限挪到扫描之后，但只量了「未闭合的帧」 ──────────────
//
// 判据在扫描**之后**跑，而扫描会把已闭合的帧就地派发掉。于是「一次 read 送来
// 完整帧（含终止空行）」走的是派发路径，长度判据根本没机会看到它：9.4 MiB 单帧
// 直接进 `JSON.parse`；同样的字节按 64 KiB 分块则被拒。同一份字节、同一个帧，
// 两种结论——上限仍是「网络分片形状」的属性，只是方向反了过来。

test('#1340 同一超限帧：一次 read 与 64 KiB 分块必须给同一结论（都拒绝）', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const payload = 'x'.repeat(9 * 1024 * 1024)
  const frame = new TextEncoder().encode('data: ' + payload + '\n\n')
  const verdict = async (chunks) => {
    try {
      for await (const _ of parseSse(streamOf(chunks))) { /* consume */ }
      return 'accepted'
    }
    catch (e) { return 'rejected: ' + String(e.message).slice(0, 60) }
  }
  const whole = await verdict([frame])
  const parts = []
  for (let i = 0; i < frame.length; i += 65536) parts.push(frame.slice(i, i + 65536))
  const split = await verdict(parts)
  assert.equal(whole.split(':')[0], 'rejected',
    '一次 read 送来的超限帧被放行了——上限只对分块生效：' + whole)
  assert.equal(split.split(':')[0], 'rejected', '64 KiB 分块送来的超限帧也应被拒：' + split)
})

test('#1340 超限帧不得进入下游：拒绝必须发生在派发之前', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  // 关键不是「最后抛了错」，而是「有没有先吐出一个事件」。先 yield 再抛，
  // 调用方已经拿到 9 MiB 的 data 并 JSON.parse 过了，之后再抛也来不及。
  const payload = 'y'.repeat(9 * 1024 * 1024)
  const frame = new TextEncoder().encode('data: ' + payload + '\n\n')
  let events = 0
  let error
  try {
    for await (const _ of parseSse(streamOf([frame]))) events += 1
  }
  catch (e) { error = e }
  assert.ok(error !== undefined, '超限帧必须失败关闭')
  assert.equal(events, 0, '超限帧被派发了 ' + events + ' 次才抛错——调用方已经拿到它的正文了')
})

test('#1340 上限以下的大帧仍必须逐字节送达（反向用例：判据不得误伤合法帧）', async () => {
  const { parseSse, MAX_PENDING_CHARS } = await loadWithStubs('translate/sse.js')
  // 贴着上限的合法帧，两种投递方式都要原样通过——修法不能把「接近上限」一并否掉。
  const payload = 'z'.repeat(MAX_PENDING_CHARS - 64)
  const frame = new TextEncoder().encode('data: ' + payload + '\n\n')
  assert.ok(frame.length <= MAX_PENDING_CHARS, '夹具必须不超过上限（实得 ' + frame.length + '）')
  const collect = async (chunks) => {
    const out = []
    for await (const ev of parseSse(streamOf(chunks))) out.push(ev)
    return out
  }
  const whole = await collect([frame])
  const parts = []
  for (let i = 0; i < frame.length; i += 65536) parts.push(frame.slice(i, i + 65536))
  const split = await collect(parts)
  assert.equal(whole.length, 1, '一次 read 的合法大帧必须派发一次，实得 ' + whole.length)
  assert.equal(split.length, 1, '分块的合法大帧必须派发一次，实得 ' + split.length)
  assert.equal(whole[0].data.length, payload.length, '一次 read：正文被截断了')
  assert.equal(split[0].data.length, payload.length, '分块：正文被截断了')
})

test('#1340 负控：把判据从 dispatch() 挪回「只量未闭合帧」，一次 read 用例必须变红', async () => {
  const fs = await import('node:fs')
  const { mkdtempSync, writeFileSync } = fs
  const { tmpdir } = await import('node:os')
  const source = fs.readFileSync(join(VENDOR, 'translate/sse.js'), 'utf8')
  const guard = `        const consumed = frameChars();
        if (consumed > MAX_PENDING_CHARS)
            throw oversizedFrame(consumed, consumed + pending.length);
`
  assert.equal(source.split(guard).length - 1, 1, '负控锚点应恰好命中一次——sse.js 漂移了就要同步这里')
  const mutant = source.replace(guard, '')
  assert.notEqual(mutant, source, '负控没有产生任何变异')
  const dir = mkdtempSync(join(tmpdir(), 'sse-mutant3-'))
  const file = join(dir, 'sse.js')
  writeFileSync(file, mutant)
  const { parseSse } = await import(pathToFileURL(file).href + '?t=' + Math.random())
  const payload = 'w'.repeat(9 * 1024 * 1024)
  const frame = new TextEncoder().encode('data: ' + payload + '\n\n')
  let events = 0
  let error
  try { for await (const _ of parseSse(streamOf([frame]))) events += 1 }
  catch (e) { error = e }
  assert.equal(error, undefined,
    '负控失效：抽掉 dispatch() 的判据后一次 read 的超限帧仍被拒，说明正控没守住这条')
  assert.equal(events, 1, '负控失效：抽掉判据后应放行（这正是修复前的缺陷形态）')
})

test('#1309 负控：把 dispatch 改回「空 data 也派发」，event-only 用例必须变红', async () => {
  const fs = await import('node:fs')
  const { mkdtempSync, writeFileSync } = fs
  const { tmpdir } = await import('node:os')
  const source = fs.readFileSync(join(VENDOR, 'translate/sse.js'), 'utf8')
  // 锚点按内容钉：只认「无 data 行就不派发」这条判据本身，不认它前后的注释与
  // issue #1340 新加的上限检查（那些会随本轮改动变化，锚死它们等于给自己埋漂移）。
  const before = `        if (dataLines.length === 0) {
            eventName = undefined;
            return undefined;
        }`
  const after = `        if (dataLines.length === 0 && eventName === undefined)
            return undefined;`
  assert.equal(source.split(before).length - 1, 1, '负控锚点应恰好命中一次——sse.js 漂移了就要同步这里')
  // 「没有 data 行」时仍然构造出带 data 的事件，才是修复前的形态
  const oldShape = `        const event = dataLines.length === 0
            ? { data: '', ...eventName === undefined ? {} : { event: eventName } }
            : { data: dataLines.join('\\n'), ...eventName === undefined ? {} : { event: eventName } };`
  const curShape = `        const event = { data: dataLines.join('\\n'), ...eventName === undefined ? {} : { event: eventName } };`
  assert.equal(source.split(curShape).length - 1, 1, '当前形态锚点应恰好命中一次')
  // 两处一起回退才是完整的「修复前形态」：既要有 event-only 就派发的分支，
  // 也要有它构造出的 `data: ''` 事件。
  const mutant = source.replace(before, after).replace(curShape, oldShape)
  assert.notEqual(mutant, source, '负控没有产生任何变异')
  const dir = mkdtempSync(join(tmpdir(), 'sse-mutant-'))
  const file = join(dir, 'sse.js')
  writeFileSync(file, mutant)
  const { parseSse } = await import(pathToFileURL(file).href + '?t=' + Math.random())
  const events = []
  for await (const e of parseSse(streamOf(['event: ping\n\n']))) events.push(e)
  assert.notDeepEqual(events, [], '负控失效：改回「空 data 也派发」后仍然什么都不派发，说明用例没守住这条')
})

test('#1309 负控：把上限改回「扫描前按 read 量 pending」，9.4 MiB 完整小帧用例必须变红', async () => {
  const fs = await import('node:fs')
  const { mkdtempSync, writeFileSync } = fs
  const { tmpdir } = await import('node:os')
  const source = fs.readFileSync(join(VENDOR, 'translate/sse.js'), 'utf8')
  const marker = '            let newline = pending.indexOf(\'\\n\');'
  const before = marker
  const after = `            if (pending.length > MAX_PENDING_CHARS)
                throw oversizedFrame(pending.length, pending.length);
` + marker
  assert.equal(source.split(before).length - 1, 1, '负控锚点应恰好命中一次——sse.js 漂移了就要同步这里')
  const dir = mkdtempSync(join(tmpdir(), 'sse-mutant2-'))
  const file = join(dir, 'sse.js')
  writeFileSync(file, source.replace(before, after))
  const { parseSse } = await import(pathToFileURL(file).href + '?t=' + Math.random())
  const bytes = new TextEncoder().encode('data: {}\n\n'.repeat(Math.ceil((9 * 1024 * 1024) / 11)))
  let error
  try { for await (const _ of parseSse(streamOf([bytes]))) { /* consume */ } }
  catch (e) { error = e }
  assert.ok(error !== undefined, '负控失效：改回「按 read 量」后 9.4 MiB 完整小帧仍然通过，说明用例没守住这条')
})

test('#1340 两份打包副本都带上了同一处修复（改一份漏一份 = 缺陷照旧出厂）', async () => {
  const { readFileSync } = await import('node:fs')
  const sseSource = readFileSync(join(VENDOR, 'translate/sse.js'), 'utf8')
  const bundle = readFileSync(join(VENDOR, 'index.js'), 'utf8')
  for (const [name, source] of [['translate/sse.js', sseSource], ['index.js', bundle]]) {
    assert.ok(source.includes('issue #1340'), name + ' 缺 #1340 标记（另一份改了、这份没改？）')
    // 判据必须落在 dispatch() 内部：这是帧变成事件的唯一出口。
    assert.match(source, /const frameChars = \(\) =>/, name + ' 缺少 frameChars 辅助')
    assert.match(source, /const consumed = frameChars\(\);/, name + ' 的 dispatch 未在派发前量帧长')
    assert.match(source, /if \(consumed > MAX_PENDING_CHARS\)/, name + ' 的 dispatch 缺超限失败关闭')
    // 未闭合帧那条判据必须仍在（否则不换行的流会无限增长到 EOF）
    assert.match(source, /openFrameChars/, name + ' 丢了未闭合帧的判据（不换行的流会无界增长）')
  }
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

test('#1309 两份打包副本都带上了同一处修复（改一份漏一份 = 缺陷照旧出厂）', async () => {
  const { readFileSync } = await import('node:fs')
  const sseSource = readFileSync(join(VENDOR, 'translate/sse.js'), 'utf8')
  const bundle = readFileSync(join(VENDOR, 'index.js'), 'utf8')
  for (const [name, source] of [['translate/sse.js', sseSource], ['index.js', bundle]]) {
    assert.ok(source.includes('issue #1309 ①'), name + ' 缺 #1309 ① 标记（另一份改了、这份没改？）')
    assert.ok(source.includes('issue #1309 ②'), name + ' 缺 #1309 ② 标记')
    // ①：event-only 不派发 —— 旧形态是「有 eventName 就构造 { data: '' }」
    assert.equal(/dataLines\.length === 0 && eventName === undefined/.test(source), false,
      name + ' 的 dispatch 仍是旧形态（event-only 照旧派发空 data）')
    assert.match(source, /if \(dataLines\.length === 0\) \{/, name + ' 的 dispatch 缺「无 data 行就不派发」分支')
    // ②：按帧计而不是按 read 计 —— 旧形态是扫描前量 pending
    assert.match(source, /openFrameChars/, name + ' 缺少按帧计的 openFrameChars')
    assert.equal(/chars without a newline/.test(source), false,
      name + ' 的超限文案仍是旧措辞（「没有换行」是假的，它量的是帧长度）')
  }
})

test('#1284 ③ 对照：带空行的末帧仍然只派发一次（不得重复派发）', async () => {
  const { parseSse } = await loadWithStubs('translate/sse.js')
  const events = []
  for await (const event of parseSse(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\n']))) events.push(event)
  assert.equal(events.length, 2, '两帧必须派发两次（EOF 收尾不得把已派发的帧再算一次）')
  assert.deepEqual(events.map((e) => e.data), ['{"a":1}', '{"b":2}'])
})
