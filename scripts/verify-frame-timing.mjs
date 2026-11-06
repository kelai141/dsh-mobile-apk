#!/usr/bin/env node
// verify-frame-timing.mjs — 注入层帧耗时与常驻代价的**原始读数**采集器（缺陷 3「整体卡顿」）。
//
// 这个脚本不是门禁：它不判红判绿，只把三类数字原样打出来，供人对着看趋势。
// 判据在离线侧（dsh-client-ui-responsive/tests/*-budget.spec.ts），设备侧只用它取「代价证据」。
//
// 采三组数：
//   A. 滚动帧：rAF 帧间隔的 p50 / p95 / max 与 >50ms 的帧数；同一窗口内的 longtask 条数与总阻塞时长。
//      → 区分「主线程长任务」与「渲染层掉帧」：帧间隔大且 longtask 多 = 主线程；帧间隔大而 longtask 为 0
//        = 渲染层（compositor）。
//   B. 静止：5 秒内 window.androidBridge.browserHostCommand 的调用次数，以及每次调用前后
//      performance.now() 的差值（同步跨语言调用的页面线程阻塞时长）。
//   C. 启动：performance.timing / navigation 的 domContentLoaded 与 load 时刻，以及
//      「注入标记出现」的时刻（data-dsh-mobile-form / data-dsh-incoming-draft-consumer）。
//
// 用法：
//   node scripts/verify-frame-timing.mjs --self-test                  # 无设备：跑纯函数自检
//   node scripts/verify-frame-timing.mjs --ws <cdp-ws-url> [--json <out.json>]
// 退出码：0 = 采集完成；2 = 用法/前置不满足；3 = 采集过程有读数失败（不判产品好坏）。
//
// 取 ws 地址（设备侧）：
//   adb forward tcp:29225 localabstract:webview_devtools_remote_<pid>
//   node -e "fetch('http://127.0.0.1:29225/json/list').then(r=>r.json()).then(j=>console.log(j[0].webSocketDebuggerUrl))"
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 分位数（线性插值，与 PerformanceObserver 的常见口径一致）。
 * @param values - 原始样本（会被就地排序的副本处理）。
 * @param p - 0..1 之间的分位。
 * @returns 分位值；空样本返回 NaN。
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

/**
 * 帧间隔的汇总读数。
 * @param gaps - 相邻帧的间隔（毫秒）。
 * @param longTasks - 同一窗口内 PerformanceObserver('longtask') 的 duration 列表。
 * @returns 汇总对象；`verdict` 是「主线程 / 渲染层 / 无法区分」的机械判定。
 */
export function summarizeFrames(gaps, longTasks) {
  const over50 = gaps.filter(gap => gap > 50).length
  const blocked = longTasks.reduce((total, duration) => total + duration, 0)
  // 判定口径写死在这里，避免读的人各自解释：
  //   有 longtask 且阻塞占比高 → 主线程；一帧都不长且帧间隔仍大 → 渲染层。
  let verdict = 'unknown'
  if (gaps.length > 0) {
    const p95 = percentile(gaps, 0.95)
    if (longTasks.length > 0 && blocked >= 50) verdict = 'main-thread'
    else if (p95 > 50 && longTasks.length === 0) verdict = 'renderer'
    else verdict = 'smooth'
  }
  return {
    frames: gaps.length,
    p50: percentile(gaps, 0.5),
    p95: percentile(gaps, 0.95),
    max: gaps.length === 0 ? Number.NaN : Math.max(...gaps),
    over50,
    longTasks: longTasks.length,
    blockedMs: blocked,
    verdict,
  }
}

/**
 * 静止窗口里跨桥调用的代价读数。
 * @param samples - 每次调用的 `{ action, ms }`。
 * @param windowMs - 采样窗口长度。
 * @returns 次数、频率与阻塞占比。
 */
export function summarizeIdle(samples, windowMs) {
  const blocked = samples.reduce((total, sample) => total + sample.ms, 0)
  return {
    calls: samples.length,
    perSecond: windowMs > 0 ? (samples.length * 1000) / windowMs : Number.NaN,
    blockedMs: blocked,
    blockedShare: windowMs > 0 ? blocked / windowMs : Number.NaN,
    worstMs: samples.length === 0 ? 0 : Math.max(...samples.map(sample => sample.ms)),
    actions: [...new Set(samples.map(sample => sample.action))],
  }
}

/**
 * 启动分段：把 navigation timing 与「注入标记出现」拼成分段读数。
 * @param timing - 页内读到的 `{ domContentLoaded, load, firstPaint, markerAt, now }`（毫秒，相对 timeOrigin）。
 * @returns 分段差值；缺项为 null。
 */
export function summarizeStartup(timing) {
  const diff = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : null)
  return {
    domContentLoadedMs: timing.domContentLoaded ?? null,
    loadMs: timing.load ?? null,
    firstPaintMs: timing.firstPaint ?? null,
    injectionMarkerMs: timing.markerAt ?? null,
    // 「启动到可交互」在注入层的可观测代理：首绘 → 注入标记出现。
    markerAfterFirstPaintMs: diff(timing.markerAt, timing.firstPaint),
    loadAfterMarkerMs: diff(timing.load, timing.markerAt),
  }
}

/** 页内探针：滚动窗口的帧间隔 + longtask。 */
export const SCROLL_PROBE = `(async () => {
  const gaps = []
  const longTasks = []
  let last = 0
  let running = true
  const observer = typeof PerformanceObserver === 'function'
    ? new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration) })
    : null
  try { observer?.observe({ entryTypes: ['longtask'] }) } catch { /* 老内核没有 longtask */ }
  const scroller = document.scrollingElement || document.documentElement
  const frames = 120
  for (let i = 0; i < frames && running; i++) {
    await new Promise((resolve) => requestAnimationFrame((t) => { if (last !== 0) gaps.push(t - last); last = t; resolve() }))
    scroller.scrollTop = (scroller.scrollTop + 40) % Math.max(1, scroller.scrollHeight - scroller.clientHeight)
  }
  running = false
  observer?.disconnect()
  return { gaps, longTasks }
})()`

/** 页内探针：静止窗口内跨桥调用的次数与阻塞时长。 */
export const IDLE_PROBE = `(async () => {
  const samples = []
  const bridge = window.androidBridge
  if (!bridge || typeof bridge.browserHostCommand !== 'function') return { samples, windowMs: 5000, wired: false }
  const original = bridge.browserHostCommand
  bridge.browserHostCommand = function (payload) {
    const started = performance.now()
    try { return original.apply(this, arguments) }
    finally {
      let action = ''
      try { action = String(JSON.parse(payload).action || '') } catch { action = 'unparsed' }
      samples.push({ action, ms: performance.now() - started })
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
  bridge.browserHostCommand = original
  return { samples, windowMs: 5000, wired: true }
})()`

/** 页内探针：启动分段。 */
export const STARTUP_PROBE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const paint = performance.getEntriesByType('paint')
  const firstPaint = paint.find((entry) => entry.name === 'first-paint')
  const marks = ['data-dsh-mobile-form', 'data-dsh-incoming-draft-consumer', 'data-dsh-session-id']
  let markerAt
  for (const entry of performance.getEntriesByType('mark')) {
    if (entry.name.startsWith('dsh-inject:')) markerAt = entry.startTime
  }
  return {
    domContentLoaded: nav ? nav.domContentLoadedEventEnd : undefined,
    load: nav ? nav.loadEventEnd : undefined,
    firstPaint: firstPaint ? firstPaint.startTime : undefined,
    markerAt,
    marksPresent: marks.filter((name) => document.documentElement.hasAttribute(name)),
    now: performance.now(),
  }
})()`

/**
 * 连 CDP 并逐条求值。
 * @param wsUrl - `ws://.../devtools/page/<id>`。
 * @returns `evaluate(expression)`。
 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('CDP 连接失败：' + wsUrl))
    ws.onmessage = (message) => {
      try {
        const reply = JSON.parse(message.data)
        const settle = pending.get(reply.id)
        if (settle) { pending.delete(reply.id); settle(reply) }
      } catch { /* 非 JSON 帧忽略 */ }
    }
  })
  return async (expression, timeoutMs = 30_000) => {
    const id = nextId++
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: 'timeout' } }) }, timeoutMs)
    })
    if (reply.error) throw new Error('CDP 求值失败: ' + JSON.stringify(reply.error))
    if (reply.result?.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(reply.result.exceptionDetails.text ?? reply.result.exceptionDetails))
    return reply.result?.result?.value
  }
}

const selfTest = () => {
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('./verify-frame-timing.test.mjs', import.meta.url))], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) return selfTest()
  const argOf = (name) => { const index = argv.indexOf('--' + name); return index >= 0 ? argv[index + 1] : undefined }
  const wsUrl = argOf('ws')
  if (wsUrl === undefined) {
    console.error('用法：node scripts/verify-frame-timing.mjs --ws <cdp-ws-url> [--json <out.json>]   （或 --self-test）')
    process.exit(2)
  }
  const out = argOf('json')
  const evaluate = await connect(wsUrl)
  const report = { capturedAt: new Date().toISOString(), ws: wsUrl }
  let failures = 0
  const capture = async (label, expression) => {
    try {
      return await evaluate(expression)
    } catch (error) {
      failures += 1
      console.error('[' + label + '] 采集失败：' + error.message)
      return undefined
    }
  }

  const scroll = await capture('scroll', SCROLL_PROBE)
  if (scroll !== undefined) {
    report.scroll = summarizeFrames(scroll.gaps ?? [], scroll.longTasks ?? [])
    console.log('== A. 滚动帧（' + report.scroll.frames + ' 帧）==')
    console.log('  p50=' + report.scroll.p50.toFixed(1) + 'ms p95=' + report.scroll.p95.toFixed(1) + 'ms max=' + report.scroll.max.toFixed(1) + 'ms')
    console.log('  >50ms 帧数=' + report.scroll.over50 + ' longtask 条数=' + report.scroll.longTasks + ' 总阻塞=' + report.scroll.blockedMs.toFixed(1) + 'ms')
    console.log('  判定=' + report.scroll.verdict + '（main-thread = 主线程长任务；renderer = 主线程空闲但帧间隔大）')
  }

  const idle = await capture('idle', IDLE_PROBE)
  if (idle !== undefined) {
    report.idle = summarizeIdle(idle.samples ?? [], idle.windowMs ?? 0)
    console.log('== B. 静止 ' + ((idle.windowMs ?? 0) / 1000).toFixed(0) + ' 秒内的跨桥调用 ==')
    if (idle.wired === false) console.log('  androidBridge.browserHostCommand 不在场：本机没有壳桥，跳过')
    console.log('  次数=' + report.idle.calls + ' 频率=' + report.idle.perSecond.toFixed(2) + ' 次/秒')
    console.log('  阻塞合计=' + report.idle.blockedMs.toFixed(2) + 'ms 占比=' + (report.idle.blockedShare * 100).toFixed(2) + '% 最坏单次=' + report.idle.worstMs.toFixed(2) + 'ms')
    console.log('  动作=' + JSON.stringify(report.idle.actions))
  }

  const startup = await capture('startup', STARTUP_PROBE)
  if (startup !== undefined) {
    report.startup = summarizeStartup(startup)
    console.log('== C. 启动分段 ==')
    console.log('  DOMContentLoaded=' + String(report.startup.domContentLoadedMs) + 'ms load=' + String(report.startup.loadMs) + 'ms 首绘=' + String(report.startup.firstPaintMs) + 'ms')
    console.log('  注入标记=' + String(report.startup.injectionMarkerMs) + 'ms（首绘→标记 ' + String(report.startup.markerAfterFirstPaintMs) + 'ms）')
    console.log('  已在场的根属性=' + JSON.stringify(startup.marksPresent ?? []))
  }

  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log('原始读数已写入 ' + out)
  }
  process.exit(failures === 0 ? 0 : 3)
}

// 只有被当作脚本执行时才采集；被测试 import 时只暴露纯函数（--self-test 依赖这一点）。
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) await main()
