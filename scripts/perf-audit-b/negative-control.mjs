#!/usr/bin/env node
/**
 * B 组统一负控（negative control）：证明本组用的「尺子」真的能区分快/慢、大/小。
 *
 * 做法：对三把尺子各构造一对**已知答案**的输入——
 *   1. 压缩尺（gzip/brotli）：高可压缩 vs 不可压缩，前者必须显著更小；
 *   2. 体积尺（字节计数）：1000 个短串 vs 2000 个短串，必须线性可比；
 *   3. 解析尺（V8 编译）：小源码 vs 大源码，后者必须更慢。
 * 任何一项没通过，说明本报告里的对应数字不可信，必须当场作废。
 *
 * 用法：node scripts/perf-audit-b/negative-control.mjs
 */
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'

async function gz(buf, level) {
  let total = 0
  const g = createGzip({ level })
  g.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), g, async (s) => { for await (const _ of s) void 0 })
  return total
}
async function br(buf) {
  let total = 0
  const b = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
  b.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), b, async (s) => { for await (const _ of s) void 0 })
  return total
}

const checks = []

// 1. 压缩尺：高可压缩 vs 真随机（不可压缩）
const repetitive = Buffer.alloc(1 << 20, 'a')
const random = cryptoRandomBytes(1 << 20)
const gzRep = await gz(repetitive, 1)
const gzRnd = await gz(random, 1)
const brRep = await br(repetitive)
const brRnd = await br(random)
checks.push({
  ruler: '压缩尺',
  expect: '高可压缩输入必须显著小于不可压缩输入',
  a: { label: '1 MiB 全 a', gzip1: gzRep, brotli: brRep },
  b: { label: '1 MiB 真随机', gzip1: gzRnd, brotli: brRnd },
  pass: gzRep < gzRnd / 100 && brRep < brRnd / 100,
})

// 2. 体积尺：N 与 2N 必须成比例
const mk = (n) => Buffer.from(Array.from({ length: n }, (_, i) => 'line' + i).join(String.fromCharCode(10)))
const b1 = mk(1000)
const b2 = mk(2000)
checks.push({
  ruler: '体积尺',
  expect: '2000 行输入的字节数必须约为 1000 行的 2 倍（1.8x-2.2x）',
  a: { label: '1000 行', bytes: b1.length },
  b: { label: '2000 行', bytes: b2.length },
  ratio: Number((b2.length / b1.length).toFixed(2)),
  pass: b2.length / b1.length > 1.8 && b2.length / b1.length < 2.2,
})

// 3. 解析尺：源码越长编译越慢（同一先构预热后各跑 5 次取中位）
const smallSrc = 'return 1'
const bigSrc = 'return 1;' + 'var x0 = 1;'.repeat(200000)
function compileBench(src, runs = 5) {
  new Function(src) // warm
  const s = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now()
    new Function(src)
    s.push(performance.now() - t0)
  }
  s.sort((a, b) => a - b)
  return Number(s[Math.floor(s.length / 2)].toFixed(3))
}
const cSmall = compileBench(smallSrc)
const cBig = compileBench(bigSrc)
checks.push({
  ruler: '解析尺',
  expect: '大源码的 V8 编译中位耗时必须显著高于小源码',
  a: { label: '小源码', bytes: smallSrc.length, medianMs: cSmall },
  b: { label: '大源码', bytes: bigSrc.length, medianMs: cBig },
  pass: cBig > cSmall * 5,
})

const allPass = checks.every((c) => c.pass === true)
const report = { allPass, checks }
process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))

const NL = String.fromCharCode(10)
const out = []
for (const c of checks) {
  out.push((c.pass ? 'PASS ' : 'FAIL ') + c.ruler + ' — ' + c.expect)
  out.push('   A: ' + JSON.stringify(c.a))
  out.push('   B: ' + JSON.stringify(c.b))
}
out.push(allPass ? '全部通过：本组尺子可用' : '有尺子失明：对应结论必须作废')
process.stderr.write(out.join(NL) + NL)
process.exit(allPass ? 0 : 1)