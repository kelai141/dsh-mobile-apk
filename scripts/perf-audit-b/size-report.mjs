#!/usr/bin/env node
/**
 * B1 辅助：对任意目录下的一组 JS/CSS 产物做 raw / gzip / brotli 体积统计并排序。
 * 只用 node:zlib，不引入任何依赖。
 *
 * 用法：node scripts/perf-audit-b/size-report.mjs <目录> [--ext .js,.css,.html] [--top 30]
 * 输出：stdout JSON；stderr 人类可读表格。
 */
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const argv = process.argv.slice(2)
const dir = argv[0]
if (dir === undefined) {
  console.error('用法: node scripts/perf-audit-b/size-report.mjs <目录> [--ext .js,.css,.html] [--top 30]')
  process.exit(2)
}
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const exts = argOf('ext', '.js,.css,.html').split(',').map((s) => s.trim().toLowerCase())
const topN = Number(argOf('top', '30'))

/** @returns {string[]} */
function walk(d, out = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 压缩到内存：返回压缩后字节数。 */
async function compressedSize(buffer, kind) {
  const src = Readable.from([buffer])
  let total = 0
  if (kind === 'gzip') {
    const gz = createGzip({ level: 9 })
    gz.on('data', (c) => { total += c.length })
    await pipeline(src, gz, async (s) => { for await (const _ of s) { /* drain */ } })
  } else {
    const br = createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    })
    br.on('data', (c) => { total += c.length })
    await pipeline(src, br, async (s) => { for await (const _ of s) { /* drain */ } })
  }
  return total
}

const files = walk(dir).filter((p) => exts.includes(extname(p).toLowerCase()))
const rows = []
for (const p of files) {
  const buf = readFileSync(p)
  const raw = buf.length
  rows.push({
    file: relative(dir, p).split('\\').join('/'),
    raw,
    gzip: await compressedSize(buf, 'gzip'),
    brotli: await compressedSize(buf, 'brotli'),
  })
}
rows.sort((a, b) => b.raw - a.raw)

const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0)
const report = {
  dir,
  exts,
  fileCount: rows.length,
  totals: { raw: sum(rows, 'raw'), gzip: sum(rows, 'gzip'), brotli: sum(rows, 'brotli') },
  top: rows.slice(0, topN),
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n')

const lines = []
lines.push('目录 ' + dir + '（' + rows.length + ' 文件）')
lines.push('合计 raw=' + sum(rows, 'raw') + 'B gzip=' + sum(rows, 'gzip') + 'B brotli=' + sum(rows, 'brotli') + 'B')
lines.push('raw        gzip       brotli     file')
for (const r of rows.slice(0, topN)) {
  lines.push(String(r.raw).padStart(10) + String(r.gzip).padStart(11) + String(r.brotli).padStart(11) + '  ' + r.file)
}
process.stderr.write(lines.join('\n') + '\n')
