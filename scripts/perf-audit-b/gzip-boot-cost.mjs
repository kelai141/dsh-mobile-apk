#!/usr/bin/env node
/**
 * B1 辅助：量化「引擎每次冷启动要现算多少 gzip CPU」。
 *
 * 依据链（全部来自快照内源码，可复核）：
 *   dsh-web-app/cordis.patch.yml:163-171  webserver 行为 compression: gzip / level 1 / threshold 1024
 *   dsh-host-webserver/lib/index.js:106-131  用 npm compression 中间件逐响应压缩，**没有输出缓存**
 *   dsh-client-modules/lib/index.js:365-397  combo batch 把多个 bundle 拼成一个响应体返回
 * ⇒ 每个首次到达的 combo 批都要在引擎进程里现压一遍。这不是网络字节问题，是启动期 CPU。
 *
 * 本脚本：把首屏 68 个 bundle 按 combo 语义拼起来，用 level 1 压一次，测 5 次取中位。
 * 负控：同一份输入改用 level 0（不压缩）跑一遍，若两者耗时无差异则说明尺子测不到压缩成本。
 *
 * 用法：node scripts/perf-audit-b/gzip-boot-cost.mjs <快照根目录> --json <boot-js-surface.json> [--runs 5]
 */
import { readFileSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'

const root = process.argv[2]
const ji = process.argv.indexOf('--json')
const ri = process.argv.indexOf('--runs')
if (root === undefined || ji < 0) {
  console.error('用法: node scripts/perf-audit-b/gzip-boot-cost.mjs <快照根目录> --json <boot-js-surface.json> [--runs 5]')
  process.exit(2)
}
const RUNS = ri >= 0 ? Number(process.argv[ri + 1]) : 5
const surface = JSON.parse(readFileSync(process.argv[ji + 1], 'utf8'))

const parts = []
for (const r of surface.rows) parts.push(readFileSync(root + '/' + r.path, 'utf8'))
const combined = Buffer.from(parts.join(';' + String.fromCharCode(10)), 'utf8')

async function gzipTime(buf, level) {
  const t0 = performance.now()
  let total = 0
  const g = createGzip({ level })
  g.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), g, async (s) => { for await (const _ of s) void 0 })
  return { ms: Number((performance.now() - t0).toFixed(1)), bytes: total }
}
async function bench(level) {
  const s = []
  let bytes = 0
  for (let i = 0; i < RUNS; i += 1) {
    const r = await gzipTime(combined, level)
    s.push(r.ms)
    bytes = r.bytes
  }
  s.sort((a, b) => a - b)
  return { level, runs: RUNS, medianMs: s[Math.floor(s.length / 2)], minMs: s[0], maxMs: s[s.length - 1], outBytes: bytes }
}

const l1 = await bench(1)
const l0 = await bench(0)
const report = {
  root,
  bundles: surface.rows.length,
  combinedBytes: combined.length,
  combinedMiB: Number((combined.length / 1048576).toFixed(2)),
  level1: l1,
  level0: l0,
  deltaMs: Number((l1.medianMs - l0.medianMs).toFixed(1)),
  note: '宿主 CPU；设备上必然更慢。用于量级判断与相对比较。',
}
process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))

const NL = String.fromCharCode(10)
const out = []
out.push('拼接 ' + surface.rows.length + ' 个首屏 bundle = ' + report.combinedMiB + ' MiB')
out.push('gzip level 1: 中位 ' + l1.medianMs + ' ms（min ' + l1.minMs + ' / max ' + l1.maxMs + '）→ ' + l1.outBytes + ' B')
out.push('gzip level 0: 中位 ' + l0.medianMs + ' ms（min ' + l0.minMs + ' / max ' + l0.maxMs + '）→ ' + l0.outBytes + ' B')
out.push('负控：level1 - level0 = ' + report.deltaMs + ' ms（非 0 说明尺子测得到压缩成本）')
process.stderr.write(out.join(NL) + NL)