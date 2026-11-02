#!/usr/bin/env node
// scripts/perf-audit-a/apk-entry-hash.mjs
// 任务 A2：APK 里 assets/snapshot.tar.xz 是 stored（method=0），可直接从字节流算 sha256，
// 与工作区上任何一份 tar 对账，回答「这个 APK 到底是用哪份快照打的」。
// 用法：node scripts/perf-audit-a/apk-entry-hash.mjs <apk> <entryName>
import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

const [apkPath, entryName] = process.argv.slice(2)
if (!apkPath || !entryName) { console.error('usage: apk-entry-hash.mjs <apk> <entry>'); process.exit(2) }
const fd = openSync(apkPath, 'r')
const fileSize = fstatSync(fd).size
const readAt = (pos, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b }

const tailLen = Math.min(fileSize, 65535 + 22)
const tail = readAt(fileSize - tailLen, tailLen)
let eocd = -1
for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
const cdSize = tail.readUInt32LE(eocd + 12)
const cdOffset = tail.readUInt32LE(eocd + 16)
const cd = readAt(cdOffset, cdSize)
let p = 0, found = null
while (p < cd.length - 4 && cd.readUInt32LE(p) === 0x02014b50) {
  const method = cd.readUInt16LE(p + 10)
  const compSize = cd.readUInt32LE(p + 20)
  const nameLen = cd.readUInt16LE(p + 28)
  const extraLen = cd.readUInt16LE(p + 30)
  const commentLen = cd.readUInt16LE(p + 32)
  const lo = cd.readUInt32LE(p + 42)
  const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8')
  if (name === entryName) { found = { method, compSize, lo }; break }
  p += 46 + nameLen + extraLen + commentLen
}
if (!found) { console.error('entry not found: ' + entryName); process.exit(1) }
if (found.method !== 0) { console.error('entry is deflated; cannot hash stored bytes directly'); process.exit(1) }
const lh = readAt(found.lo, 30)
const dataOffset = found.lo + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
const h = createHash('sha256')
const CHUNK = 8 * 1024 * 1024
let remaining = found.compSize
let pos = dataOffset
while (remaining > 0) {
  const n = Math.min(CHUNK, remaining)
  h.update(readAt(pos, n))
  pos += n; remaining -= n
}
closeSync(fd)
console.log(JSON.stringify({ apk: apkPath, entry: entryName, bytes: found.compSize, method: found.method, dataOffset, sha256: h.digest('hex') }))
