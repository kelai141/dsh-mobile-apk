#!/usr/bin/env node
// scripts/perf-audit-a/prefix-rollup.mjs
// 任务 A2：对 tarls.py --entries 产出的 TSV 做「按路径前缀（深度 N）」的字节汇总。
// 目的：usr/ 内部到底哪里占地方（usr/lib/node_modules vs usr/share/man vs usr/lib/perl5 ...）。
//
// 用法：node scripts/perf-audit-a/prefix-rollup.mjs <entries.tsv> [--prefix usr] [--depth 2] [--top 30]
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const file = args[0]
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const prefix = opt('--prefix', '')
const depth = Number(opt('--depth', 2))
const topN = Number(opt('--top', 30))

const m = new Map()
let total = 0
let totalFiles = 0
const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
let first = true
for await (const line of rl) {
  if (first) { first = false; continue }
  if (!line) continue
  const t1 = line.indexOf('\t'); const t2 = line.indexOf('\t', t1 + 1)
  if (t1 < 0 || t2 < 0) continue
  const size = Number(line.slice(0, t1))
  const path = line.slice(t2 + 1)
  if (prefix && !path.startsWith(prefix)) continue
  total += size; totalFiles++
  const segs = path.split('/')
  const key = segs.slice(0, depth).join('/')
  const v = m.get(key) || { bytes: 0, files: 0 }
  v.bytes += size; v.files++; m.set(key, v)
}
const rows = [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, topN)
console.log(JSON.stringify({
  file, prefix: prefix || '(all)', depth, totalBytes: total, totalMiB: +(total / 1048576).toFixed(2), totalFiles,
  rows: rows.map(([k, v]) => ({ key: k, bytes: v.bytes, MiB: +(v.bytes / 1048576).toFixed(2), files: v.files, pct: +(100 * v.bytes / total).toFixed(2) })),
}, null, 1))
