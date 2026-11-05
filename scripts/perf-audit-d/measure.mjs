#!/usr/bin/env node
// measure.mjs — 性能审计 D 的唯一可复现基线入口（第二阶段改代码前后的对比尺）
//
// 设计纪律（来自任务共享上下文）：
//   1. **优先字节级/静态计数**：体积、文件数、命中点数不受宿主 CPU 抖动影响，是最硬的证据。
//      计时类只保留一条，且必须跑多次取中位数与 min/max，并显式标注"宿主并发负载下测得"。
//   2. **不引入依赖**：只用 node:fs / node:crypto / node:zlib 与内置能力。
//   3. **产物在主工作区只读**：本脚本不写任何产物到主工作区，只读 + 在 stdout/--json 输出。
//   4. **缺输入就明说**：产物缺席记为 "absent" 并继续；不编造数字。
//
// 用法：
//   node scripts/perf-audit-d/measure.mjs                       # 默认档：体积 + 静态计数（秒级）
//   node scripts/perf-audit-d/measure.mjs --json .deploy-tmp/perf-audit-d/baseline.json
//   node scripts/perf-audit-d/measure.mjs --with-gates          # 附带 gates-baseline.json 的汇总（若已生成）
//   node scripts/perf-audit-d/measure.mjs --artifacts <apk 仓根>  # 指定产物所在树（默认取本仓根）
//   node scripts/perf-audit-d/measure.mjs --timing-rounds 7     # 计时类重复次数（默认 5）
//
// 退出码：0 = 全部读数产出（**不代表指标好坏**）；2 = 连基本静态面都读不到。
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }
const has = (n) => argv.includes('--' + n)

const ARTIFACTS = resolve(argOf('artifacts') ?? ROOT)
const ROUNDS = Math.max(1, Number(argOf('timing-rounds') ?? 5) | 0)
const out = { meta: {}, artifacts: {}, apkEntries: {}, staticCounts: {}, timing: {} }

out.meta = {
  script: 'scripts/perf-audit-d/measure.mjs',
  at: new Date().toISOString(),
  node: process.version,
  repoRoot: ROOT,
  artifactsRoot: ARTIFACTS,
  rounds: ROUNDS,
  note: '体积/计数为字节级确定量；timing 为宿主并发负载下的墙钟，绝对值偏高，仅可用于同机前后对比',
}

// ── 1. 产物体积 ────────────────────────────────────────────────────────────────
const ARTIFACT_REL = [
  'app/src/main/assets/snapshot.tar.xz',
  'assets/snapshot.tar.xz',
  'snapshot/snapshot-x86_64.tar.xz',
  'snapshot/snapshot-arm64.tar.xz',
  'base/base-dsh.tar.xz',
  'base/base-usr-x86_64.tar.xz',
  'base/base-usr-arm64.tar.xz',
]
/** 已发布 APK：扫 out 下的版本目录，取最新版本里的 arm64 包（版本号不写死）。 */
function findReleasedApk() {
  const outDir = join(ARTIFACTS, 'out')
  if (!existsSync(outDir)) return null
  const versions = readdirSync(outDir).filter((n) => /^v\d/.test(n)).sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number); const pb = b.slice(1).split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d
    }
    return 0
  })
  for (let i = versions.length - 1; i >= 0; i--) {
    const dir = join(outDir, versions[i])
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    const hits = names.filter((n) => n.endsWith('-arm64.apk') || n.endsWith('.apk')).sort((a, b) => b.length - a.length)
    if (hits.length > 0) return { version: versions[i], path: join(dir, hits[0]) }
  }
  return null
}
for (const rel of ARTIFACT_REL) {
  const abs = join(ARTIFACTS, rel)
  out.artifacts[rel] = existsSync(abs) ? statSync(abs).size : 'absent'
}
const apk = findReleasedApk()
if (apk) {
  out.artifacts['out/' + apk.version + '/' + apk.path.split(/[\\/]/).pop()] = statSync(apk.path).size
  out.meta.releasedApk = relative(ARTIFACTS, apk.path).replace(/\\/g, '/')
} else {
  out.artifacts['out/<latest>/*.apk'] = 'absent'
}

// ── 2. APK zip 中央目录构成（只用 node:zlib，不引依赖）──────────────────────────
/**
 * 读 zip 中央目录。APK 是 zip（可能带 zip64）；这里只解析中央目录里的
 * 文件名 / 压缩方式 / 压缩后大小 / 原始大小 / 本地头偏移，够做体积构成账。
 */
function readZipEntries(file) {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const tailLen = Math.min(size, 66 * 1024)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    // EOCD: 0x06054b50
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
    if (eocd < 0) throw new Error('EOCD not found')
    let cdCount = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOff = tail.readUInt32LE(eocd + 16)
    // zip64：EOCD locator 0x07064b50 在 EOCD 前 20 字节
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
      const loc = eocd - 20
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64Off = Number(tail.readBigUInt64LE(loc + 8))
        const z64 = Buffer.alloc(56)
        readSync(fd, z64, 0, 56, z64Off)
        if (z64.readUInt32LE(0) === 0x06064b50) {
          cdCount = Number(z64.readBigUInt64LE(32))
          cdSize = Number(z64.readBigUInt64LE(40))
          cdOff = Number(z64.readBigUInt64LE(48))
        }
      }
    }
    const cd = Buffer.alloc(cdSize)
    readSync(fd, cd, 0, cdSize, cdOff)
    const entries = []
    let p = 0
    for (let k = 0; k < cdCount && p + 46 <= cd.length; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const method = cd.readUInt16LE(p + 10)
      let compSize = cd.readUInt32LE(p + 20)
      let rawSize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      // extra 里的 zip64（0x0001）按出现顺序补 0xFFFFFFFF 字段
      let ep = p + 46 + nameLen
      const epEnd = ep + extraLen
      while (ep + 4 <= epEnd) {
        const hid = cd.readUInt16LE(ep); const hlen = cd.readUInt16LE(ep + 2)
        if (hid === 0x0001) {
          let q = ep + 4
          if (rawSize === 0xffffffff && q + 8 <= ep + 4 + hlen) { rawSize = Number(cd.readBigUInt64LE(q)); q += 8 }
          if (compSize === 0xffffffff && q + 8 <= ep + 4 + hlen) { compSize = Number(cd.readBigUInt64LE(q)); q += 8 }
        }
        ep += 4 + hlen
      }
      entries.push({ name, method, compSize, rawSize })
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally { closeSync(fd) }
}

/** 按前缀归类 APK 条目（报告要用这几个桶）。 */
function bucketOf(name) {
  if (name === 'assets/snapshot.tar.xz' || name.endsWith('snapshot.tar.xz')) return 'snapshot.tar.xz（内嵌快照）'
  if (/^classes.*\.dex$/.test(name)) return 'dex（代码）'
  if (name.startsWith('lib/')) return 'lib/*.so（原生库）'
  if (name === 'resources.arsc') return 'resources.arsc'
  if (name.startsWith('res/')) return 'res/（资源）'
  if (name.startsWith('META-INF/')) return 'META-INF/（签名+清单）'
  if (name.startsWith('assets/')) return 'assets/（其余）'
  return '其它'
}
const apkPath = apk?.path ?? (existsSync(join(ARTIFACTS, 'app/src/main/assets/snapshot.tar.xz')) ? null : null)
if (apk) {
  try {
    const entries = readZipEntries(apk.path)
    const apkBytes = statSync(apk.path).size
    const byBucket = {}
    for (const e of entries) {
      const b = bucketOf(e.name)
      if (!byBucket[b]) byBucket[b] = { files: 0, comp: 0, raw: 0 }
      byBucket[b].files += 1
      byBucket[b].comp += e.compSize
      byBucket[b].raw += e.rawSize
    }
    const buckets = Object.entries(byBucket)
      .map(([bucket, v]) => ({ bucket, files: v.files, compBytes: v.comp, rawBytes: v.raw, pctOfApk: +(100 * v.comp / apkBytes).toFixed(2) }))
      .sort((a, b) => b.compBytes - a.compBytes)
    const top = [...entries].sort((a, b) => b.compSize - a.compSize).slice(0, 15)
      .map((e) => ({ name: e.name, compBytes: e.compSize, rawBytes: e.rawSize, stored: e.method === 0, pctOfApk: +(100 * e.compSize / apkBytes).toFixed(2) }))
    out.apkEntries = {
      apk: out.meta.releasedApk, apkBytes, entryCount: entries.length, buckets, topByCompressedSize: top,
      storedEntryCount: entries.filter((e) => e.method === 0).length,
      storedBytes: entries.filter((e) => e.method === 0).reduce((s, e) => s + e.compSize, 0),
    }
  } catch (e) {
    out.apkEntries = { error: String(e && e.message).slice(0, 200) }
  }
} else {
  out.apkEntries = { error: 'no released apk under out/v*/' }
}

// ── 3. 静态计数（不受 CPU 抖动；第二阶段改代码后这里必须能证明"没弄坏"）──────────
const walk = (dir, filter, acc = []) => {
  let names = []
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const d of names) {
    const p = join(dir, d.name)
    if (d.isDirectory()) walk(p, filter, acc)
    else if (filter(d.name, p)) acc.push(p)
  }
  return acc
}
const byteSum = (files) => files.reduce((s, f) => { try { return s + statSync(f).size } catch { return s } }, 0)
const countOf = (files, pred) => files.reduce((n, f) => {
  let t = ''
  try { t = readFileSync(f, 'utf8') } catch { return n }
  const m = t.match(pred)
  return n + (m ? m.length : 0)
}, 0)

const mainJava = join(ROOT, 'app/src/main/java')
const testJava = [join(ROOT, 'app/src/test/java'), join(ROOT, 'app/src/androidTest/java')].filter(existsSync)
const ktMain = existsSync(mainJava) ? walk(mainJava, (n) => n.endsWith('.kt')) : []
const ktTest = testJava.flatMap((d) => walk(d, (n) => n.endsWith('.kt')))
const scriptsDir = join(ROOT, 'scripts')
const checkScripts = existsSync(scriptsDir) ? readdirSync(scriptsDir).filter((n) => /^check-.*\.mjs$/.test(n)) : []

// IO 命中点计数：这是 D 块的核心静态面，第二阶段用同一口径复测即可证明增减。
const IO_PATTERNS = {
  readText: /\breadText\s*\(/g,
  readBytes: /\breadBytes\s*\(|Files\.readAllBytes\s*\(/g,
  copyTo: /\bcopyTo\s*\(/g,
  createTempFile: /createTempFile\s*\(/g,
  appendText: /\bappendText\s*\(/g,
  writeText: /\bwriteText\s*\(/g,
  randomAccessFile: /RandomAccessFile\s*\(/g,
}
const ioCounts = {}
for (const [k, re] of Object.entries(IO_PATTERNS)) ioCounts[k] = countOf(ktMain, re)

// 有界读纪律的落地密度：ByteArray(n) 字面量块 vs 无界 readBytes()。
const boundedByteArrays = countOf(ktMain, /ByteArray\s*\(/g)
const MAX_CONST = countOf(ktMain, /(?:const|val)\s+\w*(?:MAX|LIMIT|CAP)\w*\s*(?::\s*Long)?\s*=/g)

out.staticCounts = {
  kotlinProdFiles: ktMain.length,
  kotlinProdBytes: byteSum(ktMain),
  kotlinTestFiles: ktTest.length,
  kotlinTestBytes: byteSum(ktTest),
  checkScripts: checkScripts.length,
  ioSiteCounts: ioCounts,
  boundedAllocations: boundedByteArrays,
  maxLimitConstants: MAX_CONST,
  // 判定 "整文件读入且无上限" 的代理量：readText/readBytes 命中数 / (MAX* 常量 + ByteArray())
  ioUnboundedRatio: +((ioCounts.readText + ioCounts.readBytes) / Math.max(1, boundedByteArrays + MAX_CONST)).toFixed(3),
}

// ── 4. 计时（唯一一条；宿主并发负载下测得，绝对值偏高，仅用于同机前后对比）────────
/** 内嵌快照全量 SHA-256：App 启动前的 digest 预检走的就是这条 IO 路径（流式 64KB）。 */
function timeFullSha256(file, rounds) {
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint()
    const fd = openSync(file, 'r')
    const h = createHash('sha256')
    const buf = Buffer.alloc(64 * 1024)
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null)
        if (n <= 0) break
        h.update(buf.subarray(0, n))
      }
      h.digest('hex')
    } finally { closeSync(fd) }
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return {
    n: rounds, minMs: +samples[0].toFixed(1), maxMs: +samples[samples.length - 1].toFixed(1),
    medianMs: +samples[Math.floor(samples.length / 2)].toFixed(1),
    mbPerSec: +(statSync(file).size / 1024 / 1024 / (samples[Math.floor(samples.length / 2)] / 1000)).toFixed(1),
  }
}
const snapshotAsset = [join(ARTIFACTS, 'app/src/main/assets/snapshot.tar.xz'), join(ARTIFACTS, 'assets/snapshot.tar.xz')]
  .find((p) => existsSync(p))
if (snapshotAsset) {
  out.timing.snapshotSha256Stream = { input: relative(ARTIFACTS, snapshotAsset).replace(/\\/g, '/'), bytes: statSync(snapshotAsset).size, ...timeFullSha256(snapshotAsset, ROUNDS) }
} else {
  out.timing.snapshotSha256Stream = { error: 'assets/snapshot.tar.xz absent' }
}

// ── 5. 门禁基线（可选；来自 gates-baseline.mjs 的落盘）──────────────────────────
if (has('with-gates')) {
  const p = join(ROOT, '.deploy-tmp/perf-audit-d/gates-baseline.json')
  if (existsSync(p)) {
    try {
      const g = JSON.parse(readFileSync(p, 'utf8'))
      out.gates = { at: g.at, declared: g.declared, ran: g.ran, totalMs: g.totalMs, tally: g.tally,
        slowest: [...g.results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => ({ script: r.script, ms: r.ms, outBytes: r.outBytes, verdict: r.verdict })) }
    } catch (e) { out.gates = { error: String(e && e.message) } }
  } else { out.gates = { error: '.deploy-tmp/perf-audit-d/gates-baseline.json 不存在；先跑 gates-baseline.mjs' } }
}

// ── 输出 ────────────────────────────────────────────────────────────────────────
const fmt = (n) => typeof n === 'number' ? n.toLocaleString('en-US') : String(n)
console.log('=== PERF-AUDIT-D 基线读数 ===')
console.log('仓根: ' + ROOT)
console.log('产物根: ' + ARTIFACTS + (ARTIFACTS === ROOT ? '（默认＝本树；主工作区产物请用 --artifacts 指定）' : ''))
console.log('')
console.log('-- 产物体积 --')
for (const [k, v] of Object.entries(out.artifacts)) {
  console.log('  ' + (v === 'absent' ? 'ABSENT     ' : fmt(v).padStart(11) + ' B') + '  ' + k)
}
if (out.apkEntries.buckets) {
  console.log('')
  console.log('-- APK 构成（' + fmt(out.apkEntries.apkBytes) + ' B / ' + out.apkEntries.entryCount + ' 条目；stored ' + out.apkEntries.storedEntryCount + ' 条共 ' + fmt(out.apkEntries.storedBytes) + ' B）--')
  for (const b of out.apkEntries.buckets) {
    console.log('  ' + fmt(b.compBytes).padStart(11) + ' B  ' + String(b.pctOfApk).padStart(6) + '%  ' + b.bucket + '  (files=' + b.files + ', raw=' + fmt(b.rawBytes) + ')')
  }
} else { console.log('  APK 条目解析不可用: ' + out.apkEntries.error) }
console.log('')
console.log('-- 静态计数（字节级；不受 CPU 抖动）--')
console.log('  生产 Kotlin: ' + out.staticCounts.kotlinProdFiles + ' 文件 / ' + fmt(out.staticCounts.kotlinProdBytes) + ' B')
console.log('  测试 Kotlin: ' + out.staticCounts.kotlinTestFiles + ' 文件 / ' + fmt(out.staticCounts.kotlinTestBytes) + ' B')
console.log('  check-*.mjs: ' + out.staticCounts.checkScripts)
console.log('  IO 命中点: ' + Object.entries(out.staticCounts.ioSiteCounts).map(([k, v]) => k + '=' + v).join('  '))
console.log('  有界分配 ByteArray(): ' + out.staticCounts.boundedAllocations + '；MAX/LIMIT/CAP 常量: ' + out.staticCounts.maxLimitConstants + '；无界比 ' + out.staticCounts.ioUnboundedRatio)
console.log('')
console.log('-- 计时（宿主并发负载下测得；绝对值偏高，只可用于同机前后对比）--')
const t = out.timing.snapshotSha256Stream
console.log(t.error ? '  ' + t.error
  : '  snapshot SHA-256 流式全量: median=' + t.medianMs + ' ms  min=' + t.minMs + '  max=' + t.maxMs + '  (' + t.mbPerSec + ' MB/s, n=' + t.n + ', ' + fmt(t.bytes) + ' B)')
if (out.gates) {
  console.log('')
  if (out.gates.error) console.log('-- 门禁基线: ' + out.gates.error)
  else console.log('-- 门禁基线: ' + out.gates.ran + '/' + out.gates.declared + ' 条 / ' + out.gates.totalMs + ' ms；' + JSON.stringify(out.gates.tally))
}

const outPath = argOf('json')
if (outPath) {
  const abs = resolve(ROOT, outPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(out, null, 2))
  console.log('\n已落盘 -> ' + relative(ROOT, abs).replace(/\\/g, '/'))
}
process.exit(0)
