#!/usr/bin/env node
// scripts/perf-audit-a/compare-tars.mjs
// 任务 A2：对比两份 tar 的成员集合（路径 + 字节数），回答「为什么 assets/snapshot.tar.xz
// 比已发布的 snapshot-arm64.tar.xz 大 47MB」这类同源不同体量问题。
// 输入是 tarls.py --entries 产出的 TSV（size\tF\tpath），避免重复解 xz。
//
// 用法：node scripts/perf-audit-a/compare-tars.mjs a.tsv b.tsv [--top 20]
import { readFileSync } from 'node:fs'

const [aPath, bPath] = process.argv.slice(2)
if (!aPath || !bPath) { console.error('usage: node scripts/perf-audit-a/compare-tars.mjs a.tsv b.tsv [--top N]'); process.exit(2) }
const topIdx = process.argv.indexOf('--top')
const topN = topIdx >= 0 ? Number(process.argv[topIdx + 1]) : 20

function load(p) {
  const m = new Map()
  const txt = readFileSync(p, 'utf8').split('\n')
  for (let i = 1; i < txt.length; i++) {
    const line = txt[i]
    if (!line) continue
    const t1 = line.indexOf('\t'); const t2 = line.indexOf('\t', t1 + 1)
    if (t1 < 0 || t2 < 0) continue
    m.set(line.slice(t2 + 1), Number(line.slice(0, t1)))
  }
  return m
}
const A = load(aPath)   // 基线（已发布 snapshot-arm64）
const B = load(bPath)   // 被解释的一方（assets/snapshot.tar.xz）

let onlyB = 0, onlyA = 0, same = 0, diffSize = 0
const added = []
const removed = []
const changed = []
let bTotal = 0, aTotal = 0
for (const [k, v] of B) {
  bTotal += v
  if (!A.has(k)) { onlyB += v; added.push([k, v]) }
  else { const av = A.get(k); if (av !== v) { diffSize++; changed.push([k, av, v]) } else same++ }
}
for (const [k, v] of A) { aTotal += v; if (!B.has(k)) { onlyA += v; removed.push([k, v]) } }
const s = (a) => a.sort((x, y) => y[y.length - 1] - x[y.length - 1]).slice(0, topN)
const addDir = new Map()
for (const [k, v] of added) {
  const seg = k.split('/').slice(0, 6).join('/')
  addDir.set(seg, (addDir.get(seg) || 0) + v)
}
const topAddDir = [...addDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
const remDir = new Map()
for (const [k, v] of removed) {
  const seg = k.split('/').slice(0, 6).join('/')
  remDir.set(seg, (remDir.get(seg) || 0) + v)
}
const topRemDir = [...remDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)

console.log(JSON.stringify({
  aPath, bPath,
  aFiles: A.size, bFiles: B.size,
  aUncompressed: aTotal, bUncompressed: bTotal,
  deltaUncompressed: bTotal - aTotal,
  sameSizeFiles: same,
  onlyInB: { files: added.length, bytes: onlyB },
  onlyInA: { files: removed.length, bytes: onlyA },
  sizeChanged: { files: diffSize, bytes: changed.reduce((acc, c) => acc + (c[2] - c[1]), 0) },
  topAddedFiles: s(added).map(([k, v]) => ({ path: k, bytes: v })),
  topRemovedFiles: s(removed).map(([k, v]) => ({ path: k, bytes: v })),
  topAddedDirs: topAddDir.map(([k, v]) => ({ dir: k, bytes: v })),
  topRemovedDirs: topRemDir.map(([k, v]) => ({ dir: k, bytes: v })),
  sizeChangedTop: changed.sort((x, y) => Math.abs(y[2] - y[1]) - Math.abs(x[2] - x[1])).slice(0, topN)
    .map(([k, a, b]) => ({ path: k, aBytes: a, bBytes: b })),
}, null, 1))
