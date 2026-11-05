#!/usr/bin/env node
/**
 * B1 辅助：量化首屏 client bundle 的「可回收空白与注释」字节量。
 *
 * 为什么不用完整的 JS minifier：那是新依赖（硬约束 3）。这里只做**无歧义的字节分类**：
 *   - 行首缩进（行首连续空白）—— 删除永远安全；
 *   - 整行注释（去空白后以 // 或 * 或 /* 开头）—— 在 bundle 这种「一行一语句」的产物里可安全删除；
 *   - 行尾注释（代码后 // …）—— 只统计，不算进「安全回收」，因为可能含 URL 等字符串内 //；
 *   - 空行。
 * 这不是「minify 后体积」，而是「minify 的**确定性下界**」：任何真实 minifier 只会做得更多。
 *
 * 输出同时给出「整份文件 gzip」与「删掉安全回收部分后 gzip」，用差值说明空白/注释对传输量的贡献。
 *
 * 用法：node scripts/perf-audit-b/whitespace-budget.mjs <快照根目录> [--json <上次 boot-js-surface 输出>]
 */
import { readFileSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/whitespace-budget.mjs <快照根目录> --json <boot-js-surface.json>')
  process.exit(2)
}
const ji = process.argv.indexOf('--json')
if (ji < 0) {
  console.error('需要 --json <boot-js-surface.mjs 的输出文件>')
  process.exit(2)
}
const surface = JSON.parse(readFileSync(process.argv[ji + 1], 'utf8'))

async function gz(buf) {
  let total = 0
  const g = createGzip({ level: 1 })
  g.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), g, async (s) => { for await (const _ of s) void 0 })
  return total
}

/** 统计一份产物里可安全回收的字节。 */
function classify(text) {
  const lines = text.split(String.fromCharCode(10))
  let indent = 0, fullLineComment = 0, trailingComment = 0, blank = 0
  const kept = []
  for (const line of lines) {
    if (line.trim() === '') { blank += line.length + 1; continue }
    const lead = line.length - line.trimStart().length
    indent += lead
    const body = line.trim()
    if (body.startsWith('//') || body.startsWith('/*') || body.startsWith('*')) {
      fullLineComment += line.length + 1
      continue
    }
    const idx = line.indexOf('//')
    if (idx > 0) trailingComment += line.length - idx
    kept.push(line.trimStart())
  }
  return {
    lines: lines.length,
    blankBytes: blank,
    indentBytes: indent,
    fullLineCommentBytes: fullLineComment,
    trailingCommentBytes: trailingComment,
    safeReclaimBytes: blank + indent + fullLineComment,
    strippedText: kept.join(String.fromCharCode(10)),
  }
}

const rows = []
let totalRaw = 0, totalSafe = 0, totalGzRaw = 0, totalGzStripped = 0
for (const r of surface.rows) {
  const text = readFileSync(root + '/' + r.path, 'utf8')
  const c = classify(text)
  const rawBuf = Buffer.from(text, 'utf8')
  const stripBuf = Buffer.from(c.strippedText, 'utf8')
  const g1 = await gz(rawBuf)
  const g2 = await gz(stripBuf)
  totalRaw += rawBuf.length
  totalSafe += c.safeReclaimBytes
  totalGzRaw += g1
  totalGzStripped += g2
  rows.push({
    package: r.package,
    rawBytes: rawBuf.length,
    safeReclaimBytes: c.safeReclaimBytes,
    safeReclaimPct: Number((c.safeReclaimBytes / rawBuf.length * 100).toFixed(1)),
    gzipRawBytes: g1,
    gzipStrippedBytes: g2,
    lines: c.lines,
  })
}

rows.sort((a, b) => b.safeReclaimBytes - a.safeReclaimBytes)
const report = {
  root,
  bundles: rows.length,
  totals: {
    rawBytes: totalRaw,
    safeReclaimBytes: totalSafe,
    safeReclaimPct: Number((totalSafe / totalRaw * 100).toFixed(1)),
    gzipRawBytes: totalGzRaw,
    gzipStrippedBytes: totalGzStripped,
    gzipDeltaBytes: totalGzRaw - totalGzStripped,
  },
  top: rows.slice(0, 15),
}
process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))

const NL = String.fromCharCode(10)
const out = []
out.push('首屏 bundle ' + rows.length + ' 个')
out.push('原始 ' + (totalRaw / 1048576).toFixed(2) + ' MiB；可安全回收（空行+缩进+整行注释）'
  + ' ' + (totalSafe / 1048576).toFixed(2) + ' MiB = ' + report.totals.safeReclaimPct + '%')
out.push('gzip(level1) 原件 ' + totalGzRaw + ' B → 去空白注释 ' + totalGzStripped + ' B（差 ' + report.totals.gzipDeltaBytes + ' B）')
for (const r of rows.slice(0, 10)) {
  out.push('  ' + String(r.rawBytes).padStart(9) + ' raw  ' + String(r.safeReclaimBytes).padStart(9)
    + ' reclaim(' + String(r.safeReclaimPct).padStart(4) + '%)  ' + r.package)
}
process.stderr.write(out.join(NL) + NL)