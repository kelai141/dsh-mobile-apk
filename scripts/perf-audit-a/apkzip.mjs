#!/usr/bin/env node
// scripts/perf-audit-a/apkzip.mjs
// 任务 A2：读 APK(zip) 的 central directory，按条目统计体积构成。无第三方依赖：
// Node 内建 zlib 在这里用不到（不解压），只需按 ZIP 规范解析 EOCD + central directory。
// 覆盖 ZIP64（APK 里 snapshot.tar.xz 单条目 > 4GB 时不会发生，但 arsc/so 也不会；
// 仍保留 ZIP64 extra field 解析以防未来）。
//
// 用法：node scripts/perf-audit-a/apkzip.mjs <apk> [--json out.json] [--top 25]
import { readFileSync, writeFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'

const args = process.argv.slice(2)
const apkPath = args[0]
if (!apkPath) { console.error('usage: node scripts/perf-audit-a/apkzip.mjs <apk> [--json out.json] [--top N]'); process.exit(2) }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const jsonOut = opt('--json', '')
const topN = Number(opt('--top', 25))

const fd = openSync(apkPath, 'r')
const fileSize = fstatSync(fd).size
const readAt = (pos, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b }

// 1) 找 EOCD（End of Central Directory, 0x06054b50），从尾部最多扫 64KiB + 22
const tailLen = Math.min(fileSize, 65535 + 22)
const tail = readAt(fileSize - tailLen, tailLen)
let eocd = -1
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
}
if (eocd < 0) throw new Error('EOCD not found (not a zip/apk?)')
let cdEntries = tail.readUInt16LE(eocd + 10)
let cdSize = tail.readUInt32LE(eocd + 12)
let cdOffset = tail.readUInt32LE(eocd + 16)

// 2) ZIP64 EOCD locator (0x07064b50) 紧邻 EOCD 之前
const locPos = fileSize - tailLen + eocd - 20
if (locPos >= 0) {
  const loc = readAt(locPos, 20)
  if (loc.readUInt32LE(0) === 0x07064b50) {
    const z64Off = Number(loc.readBigUInt64LE(8))
    const z64 = readAt(z64Off, 56)
    if (z64.readUInt32LE(0) === 0x06064b50) {
      cdEntries = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
      if (jsonOut !== undefined) { /* recorded below */ }
    }
  }
}

// 3) 遍历 central directory
const cd = readAt(cdOffset, cdSize)
const entries = []
let p = 0
while (p < cd.length - 4 && cd.readUInt32LE(p) === 0x02014b50) {
  const flags = cd.readUInt16LE(p + 8)
  const method = cd.readUInt16LE(p + 10)
  const crc = cd.readUInt32LE(p + 16)
  const compSize = cd.readUInt32LE(p + 20)
  const uncompSize = cd.readUInt32LE(p + 24)
  const nameLen = cd.readUInt16LE(p + 28)
  const extraLen = cd.readUInt16LE(p + 30)
  const commentLen = cd.readUInt16LE(p + 32)
  const localOffset = cd.readUInt32LE(p + 42)
  const name = cd.slice(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
  // ZIP64 extra field
  let cs = compSize, us = uncompSize, lo = localOffset
  let ep = p + 46 + nameLen
  const eEnd = ep + extraLen
  while (ep < eEnd - 4) {
    const id = cd.readUInt16LE(ep)
    const len = cd.readUInt16LE(ep + 2)
    if (id === 0x0001) {
      let q = ep + 4
      if (us === 0xffffffff) { us = Number(cd.readBigUInt64LE(q)); q += 8 }
      if (cs === 0xffffffff) { cs = Number(cd.readBigUInt64LE(q)); q += 8 }
      if (lo === 0xffffffff) { lo = Number(cd.readBigUInt64LE(q)); q += 8 }
    }
    ep += 4 + len
  }
  // 本地头部：读出实际数据偏移（central dir 的 extra 长度与 local 不同，必须重读本地头）
  const lh = readAt(lo, 30)
  const lNameLen = lh.readUInt16LE(26)
  const lExtraLen = lh.readUInt16LE(28)
  const dataOffset = lo + 30 + lNameLen + lExtraLen
  // 对齐填充：Android 的 zipalign 会在本地 extra 里放 padding
  entries.push({ name, method, compSize: cs, uncompSize: us, crc, flags, dataOffset, localOffset: lo })
  p = eEnd + commentLen
}
closeSync(fd)

const totalComp = entries.reduce((a, e) => a + e.compSize, 0)
const totalUncomp = entries.reduce((a, e) => a + e.uncompSize, 0)

const map = (kf) => {
  const m = new Map()
  for (const e of entries) {
    const k = kf(e)
    if (k == null) continue
    let v = m.get(k); if (!v) { v = { comp: 0, uncomp: 0, files: 0 }; m.set(k, v) }
    v.comp += e.compSize; v.uncomp += e.uncompSize; v.files += 1
  }
  return m
}
const top = (m, n, base) => [...m.entries()].sort((a, b) => b[1].comp - a[1].comp).slice(0, n)
  .map(([k, v]) => ({ key: k, comp: v.comp, uncomp: v.uncomp, files: v.files, pctOfComp: +(100 * v.comp / base).toFixed(2) }))

const topLevel = (e) => {
  const n = e.name
  if (n.startsWith('classes') && n.endsWith('.dex')) return 'classes*.dex'
  if (n.startsWith('lib/')) return 'lib/' + (n.split('/')[1] || '') // lib/<abi>/...
  if (n.startsWith('res/')) return 'res/'
  if (n.startsWith('META-INF/')) return 'META-INF/'
  if (n.startsWith('assets/')) return 'assets/' + (n.split('/')[1] || '') + (n.split('/').length > 2 ? '/…' : '')
  if (n === 'resources.arsc') return 'resources.arsc'
  if (n === 'AndroidManifest.xml') return 'AndroidManifest.xml'
  if (n.startsWith('kotlin/')) return 'kotlin/'
  if (n.startsWith('DebugProbesKt')) return 'DebugProbesKt.bin'
  return n
}

const byExt = (e) => { const b = e.name.split('/').pop(); const d = b.lastIndexOf('.'); return d > 0 ? b.slice(d).toLowerCase() : '(no ext)' }

const summary = {
  apk: apkPath,
  fileSize,
  entries: entries.length,
  cdEntriesDeclared: cdEntries,
  totalCompressed: totalComp,
  totalUncompressed: totalUncomp,
  compressedOverhead: fileSize - totalComp, // central directory + headers + signing blocks
  topLevel: top(map(topLevel), topN, totalComp),
  byExt: top(map(byExt), topN, totalComp),
  storedEntries: entries.filter((e) => e.method === 0).length,
  deflatedEntries: entries.filter((e) => e.method === 8).length,
  otherMethods: [...new Set(entries.map((e) => e.method))],
  top50: entries.slice().sort((a, b) => b.compSize - a.compSize).slice(0, 50)
    .map((e) => ({ name: e.name, comp: e.compSize, uncomp: e.uncompSize, method: e.method, pctOfComp: +(100 * e.compSize / totalComp).toFixed(2) })),
  storedBytes: entries.filter((e) => e.method === 0).reduce((a, e) => a + e.compSize, 0),
  deflatedBytes: entries.filter((e) => e.method === 8).reduce((a, e) => a + e.compSize, 0),
  // 对齐分析：4 字节对齐的 stored 条目数（zipalign -p 4 / -c 4 要求）
  storedAlignment: (() => {
    const m = { '4': 0, '16384': 0, other: 0 }
    for (const e of entries) if (e.method === 0) (e.dataOffset % 4 === 0) ? m['4']++ : m.other++
    for (const e of entries) if (e.method === 0 && e.dataOffset % 16384 === 0) m['16384']++
    return m
  })(),
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, entries }, null, 1))
console.log(JSON.stringify(summary, null, 1))
