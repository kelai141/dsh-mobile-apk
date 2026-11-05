#!/usr/bin/env node
/**
 * B1/B2 微基准：首屏 client bundle 的「解析 / 压缩」成本，含负控。
 *
 * 为什么在宿主上测 V8：WebView 与 Node 同为 V8，解析同形态源码的量级可比；绝对值必然不同
 * （Android 上的 WebView 更慢），所以这里只做**相对**判断：同一份源码「带 3.6 MiB base64 载荷」
 * 与「剥掉载荷」的解析耗时差，就是载荷本身买来的 CPU 成本。这个差值就是负控：
 * 如果尺子分不出两者，差值会贴近 0。
 *
 * 计时纪律（任务书度量纪律）：每档跑 5 次，报中位数与 min/max；标注宿主并发负载。
 *
 * 用法：node scripts/perf-audit-b/parse-cost.mjs <快照根目录> [--runs 5]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/parse-cost.mjs <快照根目录> [--runs 5]')
  process.exit(2)
}
const ri = process.argv.indexOf('--runs')
const RUNS = ri >= 0 ? Number(process.argv[ri + 1]) : 5

const ENGINE_MODULES = join(root, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules')
const BIG = join(ENGINE_MODULES, '@deepseek-ai/dsh-client-ui-settings-account/lib/client.js')

const IMG = new RegExp('data:image/([a-z+]+);base64,([A-Za-z0-9+/=]+)', 'g')
const original = readFileSync(BIG, 'utf8')
const stripped = original.replace(IMG, 'data:image/$1;base64,')

/** 解析成本：把源码交给 V8 编译成函数（不执行函数体），只量编译。 */
function compile(text) {
  // 包一层函数避免顶层 return/import 之类的语法差异；bundle 本身是 CJS 工厂，安全。
  return new Function('require', 'module', 'exports', text)
}

function bench(label, text) {
  const samples = []
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now()
    compile(text)
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const med = samples[Math.floor(samples.length / 2)]
  return { label, runs: RUNS, medianMs: Number(med.toFixed(2)), minMs: Number(samples[0].toFixed(2)), maxMs: Number(samples[samples.length - 1].toFixed(2)), samplesMs: samples.map((s) => Number(s.toFixed(2))) }
}

async function gzipOnce(buf) {
  const t0 = performance.now()
  let total = 0
  const g = createGzip({ level: 1 })
  g.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), g, async (s) => { for await (const _ of s) void 0 })
  return { ms: performance.now() - t0, bytes: total }
}

async function benchGzip(label, text) {
  const buf = Buffer.from(text, 'utf8')
  const samples = []
  let out = 0
  for (let i = 0; i < RUNS; i += 1) {
    const r = await gzipOnce(buf)
    samples.push(r.ms)
    out = r.bytes
  }
  samples.sort((a, b) => a - b)
  return { label, runs: RUNS, medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)), minMs: Number(samples[0].toFixed(2)), maxMs: Number(samples[samples.length - 1].toFixed(2)), gzipBytes: out, inputBytes: buf.length }
}

// 预热一次，避免 JIT 冷启动把第一档抬高
compile(original)
compile(stripped)

const parseOrig = bench('parse: 原始 bundle（含内联图）', original)
const parseStrip = bench('parse: 剥掉内联图', stripped)
const gzOrig = await benchGzip('gzip1: 原始 bundle', original)
const gzStrip = await benchGzip('gzip1: 剥掉内联图', stripped)

const report = {
  root,
  input: BIG,
  originalChars: original.length,
  strippedChars: stripped.length,
  runs: RUNS,
  parse: { original: parseOrig, stripped: parseStrip, deltaMedianMs: Number((parseOrig.medianMs - parseStrip.medianMs).toFixed(2)) },
  gzip: { original: gzOrig, stripped: gzStrip, deltaMedianMs: Number((gzOrig.medianMs - gzStrip.medianMs).toFixed(2)) },
  note: '宿主并发负载下测得；绝对值不可移植到设备，只用于相对比较',
}
process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))

const NL = String.fromCharCode(10)
const out = []
out.push('输入 ' + BIG)
out.push('原始 ' + original.length + ' 字符；剥掉载荷后 ' + stripped.length + ' 字符')
out.push('V8 编译 原始 中位 ' + parseOrig.medianMs + ' ms（min ' + parseOrig.minMs + ' / max ' + parseOrig.maxMs + '）')
out.push('V8 编译 剥壳 中位 ' + parseStrip.medianMs + ' ms（min ' + parseStrip.minMs + ' / max ' + parseStrip.maxMs + '）')
out.push('  => 载荷带来的编译差 ' + report.parse.deltaMedianMs + ' ms（负控：非 0 说明尺子能分辨）')
out.push('gzip(level1) 原始 中位 ' + gzOrig.medianMs + ' ms → ' + gzOrig.gzipBytes + ' B')
out.push('gzip(level1) 剥壳 中位 ' + gzStrip.medianMs + ' ms → ' + gzStrip.gzipBytes + ' B')
out.push('  => 载荷带来的压缩差 ' + report.gzip.deltaMedianMs + ' ms')
process.stderr.write(out.join(NL) + NL)