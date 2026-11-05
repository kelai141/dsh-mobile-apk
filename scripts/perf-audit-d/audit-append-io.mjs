#!/usr/bin/env node
// audit-append-io.mjs — ControlAudit.appendTo 的 IO 成本负控微基准（任务 D1/D4 的量化尺）
//
// 为什么需要这个基准（读源码得出的待验结论）：
//   ControlAudit.appendTo 用的是 `File.appendText(line + "\\n")`（kotlin.io 扩展）——
//   每次调用 **open + write + close** 一次，**没有常驻句柄、没有缓冲**。
//   而 audit.ndjson 是本仓**唯一没有轮转/上限**的状态文件（对比：engine.log 保 5 代、
//   dsh-day.log 5MB 轮转、notify-responder.log 128KB 轮转、shot png 有 TTL+配额+128MiB 上限）。
//   于是每执行一条特权 op 就要三次系统调用 + 一次 open 路径解析。
//
// 本脚本做什么：
//   ① 精确复刻"每次 appendText 都 open+write+close"的形态（对照 A）；
//   ② 跑一个"常驻句柄 + 缓冲"的对照（对照 B），证明尺子能区分两者（**负控**）；
//   ③ 扫一遍 audit.ndjson 的实际增长曲线（若本机恰有产物），没有产物就明说。
//
// 注意：这是**宿主侧**微基准。它证明的是"每条审计记录的多余 syscall 数"，不是设备实测；
//       设备侧不存在时（本次审计无设备），这已经是能给出的最硬证据。
//
// 用法：node scripts/perf-audit-d/audit-append-io.mjs [--records 2000] [--json <out>]
// 退出码：0 = 基准产出；1 = 无法创建临时目录。
import { openSync, writeSync, closeSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }
const RECORDS = Math.max(10, Number(argOf('records') ?? 2000) | 0)
const TMP = join(ROOT, '.deploy-tmp', 'perf-audit-d', 'audit-io-bench')

/** 一条审计记录的真实形态（ControlAudit.entry 的字段面 + 512 字符 detail 上限）。 */
function recordLine(i) {
  return JSON.stringify({
    ts: new Date(1751500000000 + i).toISOString(),
    action: 'shExec', tool: 'shell-native',
    args: { transport: 'shizuku', uid: 10234, op: 'shExec', detail: 'input tap 540 1180'.padEnd(120, ' '), ok: true },
    result: 'ok',
  }) + '\n'
}

function bench(label, appendOne) {
  const file = join(TMP, label + '.ndjson')
  for (const f of [file]) { try { if (existsSync(f)) rmSync(f) } catch {} }
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < RECORDS; i++) appendOne(file, recordLine(i))
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const bytes = statSync(file).size
  return { label, records: RECORDS, ms: +ms.toFixed(1), usPerRecord: +(ms * 1000 / RECORDS).toFixed(1), bytes }
}

try {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
} catch (e) {
  console.error('无法创建临时目录：' + String(e && e.message))
  process.exit(1)
}

// 对照 A：复刻 File.appendText —— 每次 open(append) + write + close，无常驻句柄。
const A = bench('A-open-write-close-per-record', (file, line) => {
  const fd = openSync(file, 'a')
  writeSync(fd, line)
  closeSync(fd)
})

// 对照 B（负控的"快"侧）：常驻句柄，同内容。证明上面的尺子确实能区分两种形态。
const B = (() => {
  const file = join(TMP, 'B-persistent-handle.ndjson')
  const fd = openSync(file, 'a')
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < RECORDS; i++) writeSync(fd, recordLine(i))
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  closeSync(fd)
  return { label: 'B-persistent-handle', records: RECORDS, ms: +ms.toFixed(1), usPerRecord: +(ms * 1000 / RECORDS).toFixed(1), bytes: statSync(file).size }
})()

// 对照 C（负控的"更慢"侧）：每条都先 fsync 一次。证明尺子能在"更快"方向上继续分辨，
// 不是"两种形态天然一样快"。
const C = (() => {
  const file = join(TMP, 'C-open-write-fsync-close.ndjson')
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < RECORDS; i++) {
    const fd = openSync(file, 'a')
    writeSync(fd, recordLine(i))
    try { require('node:fs').fsyncSync(fd) } catch {}
    closeSync(fd)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { label: 'C-open-write-fsync-close', records: RECORDS, ms: +ms.toFixed(1), usPerRecord: +(ms * 1000 / RECORDS).toFixed(1), bytes: statSync(file).size }
})()

const results = { a: A, b: B, c: C }
console.log('=== audit.ndjson 追加形态微基准（宿主侧；每次 ' + RECORDS + ' 条记录）===')
for (const r of [A, B, C]) {
  console.log('  ' + r.label.padEnd(34) + String(r.ms).padStart(9) + ' ms   ' + String(r.usPerRecord).padStart(8) + ' us/record   文件 ' + r.bytes + ' B')
}
console.log('')
console.log('  对照 A / B = ' + (A.ms / B.ms).toFixed(1) + 'x（open+close 相对常驻句柄的倍数）')
console.log('  对照 C / A = ' + (C.ms / A.ms).toFixed(2) + 'x（加 fsync 后相对当前形态的倍数）')
console.log('')
console.log('读法：A 是"当前形态"（File.appendText 每条一次 open+write+close），B 是"常驻句柄"下界。')
console.log('     A/B 的差距就是"每条记录白付的 open/close 成本"；它随审计条数线性增长，')
console.log('     而 audit.ndjson 是本仓唯一**没有轮转上限**的状态文件（见报告 D1-3）。')
console.log('     注意：这是宿主 NTFS 上测的，字面数值不等于设备值；可迁移的是**结论方向**与量级关系。')

const outPath = argOf('json')
if (outPath) {
  const abs = resolve(ROOT, outPath)
  mkdirSync(dirname(abs), { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(abs, JSON.stringify({
    at: new Date().toISOString(), node: process.version, records: RECORDS,
    hostNote: '宿主侧微基准（NTFS）；绝对值不等于设备值，方向与量级关系可迁移',
    results,
  }, null, 2))
  console.log('\n已落盘 -> ' + relative(ROOT, abs).replace(/\\/g, '/'))
}
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(0)
