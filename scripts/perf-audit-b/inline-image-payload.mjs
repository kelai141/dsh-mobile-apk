#!/usr/bin/env node
/**
 * B1 辅助：从 client bundle 里剥出内联的 data:image 载荷，量化它对首屏 JS 的贡献。
 *
 * 为什么要单独量：bundle 的字节里混着代码与内联位图，粗看只知道「这个 chunk 大」，
 * 不知道能砍掉多少。这里把 base64 载荷解出来，并在**同一份文件上**构造一个「剥掉载荷」的
 * 变体，两次都过 gzip/brotli 与字节计数 —— 差值就是可回收量，同时这个差值本身就是负控：
 * 如果尺子分不出「有载荷」与「无载荷」，差值会是 0。
 *
 * 用法：node scripts/perf-audit-b/inline-image-payload.mjs <client.js 路径> [--gzip-level 1]
 */
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const file = process.argv[2]
if (file === undefined) {
  console.error('用法: node scripts/perf-audit-b/inline-image-payload.mjs <client.js 路径> [--gzip-level 1]')
  process.exit(2)
}
const li = process.argv.indexOf('--gzip-level')
const gzipLevel = li >= 0 && process.argv[li + 1] !== undefined ? Number(process.argv[li + 1]) : 1

async function gz(buf) {
  let total = 0
  const g = createGzip({ level: gzipLevel })
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

/** 读 PNG 的 IHDR：宽高从第 16..24 字节起（8 字节签名 + 4 长度 + 4 'IHDR'）。 */
function pngSize(buf) {
  if (buf.length < 24) return undefined
  if (buf.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const text = readFileSync(file, 'utf8')
const re = new RegExp('data:image/([a-z+]+);base64,([A-Za-z0-9+/=]+)', 'g')
const items = []
let m
while ((m = re.exec(text)) !== null) {
  const mime = m[1]
  const b64 = m[2]
  const bytes = Buffer.from(b64, 'base64')
  const dims = pngSize(bytes)
  items.push({
    mime,
    base64Chars: b64.length,
    decodedBytes: bytes.length,
    argb8888Bytes: dims === undefined ? undefined : dims.width * dims.height * 4,
    width: dims === undefined ? undefined : dims.width,
    height: dims === undefined ? undefined : dims.height,
  })
}

const stripped = text.replace(re, 'data:image/$1;base64,')
const origBuf = Buffer.from(text, 'utf8')
const stripBuf = Buffer.from(stripped, 'utf8')

const totalDecoded = items.reduce((a, i) => a + i.decodedBytes, 0)
const totalB64 = items.reduce((a, i) => a + i.base64Chars, 0)
const totalArgb = items.reduce((a, i) => a + (i.argb8888Bytes ?? 0), 0)

const report = {
  file,
  gzipLevel,
  fileBytes: origBuf.length,
  inlineImageCount: items.length,
  base64CharsTotal: totalB64,
  decodedBytesTotal: totalDecoded,
  decodedMiB: Number((totalDecoded / 1048576).toFixed(2)),
  argb8888PixelsMiB: Number((totalArgb / 1048576).toFixed(2)),
  share: {
    ofFileRaw: Number((totalB64 / origBuf.length * 100).toFixed(1)),
  },
  compressed: {
    original: { gzip: await gz(origBuf), brotli: await br(origBuf) },
    stripped: { gzip: await gz(stripBuf), brotli: await br(stripBuf) },
  },
  items: items.sort((a, b) => b.decodedBytes - a.decodedBytes),
}
report.compressed.deltaGzipBytes = report.compressed.original.gzip - report.compressed.stripped.gzip
report.compressed.deltaBrotliBytes = report.compressed.original.brotli - report.compressed.stripped.brotli

process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))

const out = []
out.push('文件 ' + report.file)
out.push('内联图片 ' + items.length + ' 张，base64 ' + totalB64 + ' 字符 = 原文件 ' + report.share.ofFileRaw + '%')
out.push('解出 ' + report.decodedMiB + ' MiB 位图；若同时解码为 ARGB_8888 常驻 ' + report.argb8888PixelsMiB + ' MiB')
out.push('gzip(level ' + gzipLevel + ') 原件 ' + report.compressed.original.gzip + ' B → 剥掉载荷 ' + report.compressed.stripped.gzip
  + ' B（差 ' + report.compressed.deltaGzipBytes + ' B）')
out.push('brotli 原件 ' + report.compressed.original.brotli + ' B → 剥掉载荷 ' + report.compressed.stripped.brotli
  + ' B（差 ' + report.compressed.deltaBrotliBytes + ' B）')
process.stderr.write(out.join(String.fromCharCode(10)) + String.fromCharCode(10))