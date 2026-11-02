#!/usr/bin/env node
// gates-baseline.mjs — 逐门禁基线快照（性能审计 D3 的测量工具，不是门禁本身）
//
// 为什么不能直接用 `check-release-gates.mjs --run` 取基线：
//   聚合入口在第一条非零退出处**中止组装**（"CHECK-RELEASE-GATES FAILED：<gate> 退出码 N，中止组装"），
//   干净 worktree 上第 2 条 check-dead-tokens 就因缺上游树 exit 2，后面 35 条一条没跑。
//   基线需要的是"每条门禁各自的真实状态 + 真实耗时"，所以这里逐条 spawn、逐条记账，不从流中断言。
//
// 记账口径（与聚合入口一致，便于横向对比）：
//   · 墙钟时间（wall clock），含子进程与全部输出；
//   · stdout+stderr 字节数（"耗时/产出" 比才是优化判据）；
//   · 分类：GREEN（exit 0 且无 SKIP）/ GREEN-WITH-SKIP（exit 0 但发了 SKIP）/
//           RED（exit != 0）/ DEPENDENCY-ABSENT（退出码 != 0 且判据根本没执行）。
//   "GREEN-WITH-SKIP" 单列，是因为 exit 0 不等于判据跑过——check-dead-tokens 在缺上游树时
//   打印 NO-CRITERIA 并 exit 2（这点它做对了），但其它门禁可能以 SKIP=1 结案仍 exit 0。
//
// 用法：node scripts/perf-audit-d/gates-baseline.mjs [--json <out.json>] [--only a.mjs,b.mjs]
// 退出码：0 = 记账完成（**不代表门禁全绿**）；2 = 无法拿到门禁清单。
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }

const listOut = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-release-gates.mjs'), '--list'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (listOut.status !== 0) {
  console.error('GATES-BASELINE：无法取得门禁清单（check-release-gates.mjs --list 退出码 ' + listOut.status + '）')
  process.exit(2)
}

/** 解析 --list 的表格行：\`<script> <owner> [备注]\` */
const rows = []
for (const line of listOut.stdout.split(/\r?\n/)) {
  const m = /^(check-[a-z0-9-]+\.mjs)\s+(\S+)\s*(.*)$/.exec(line)
  if (!m) continue
  rows.push({ script: m[1], owner: m[2], note: m[3].trim() })
}
if (rows.length === 0) {
  console.error('GATES-BASELINE：清单解析出 0 条，布局不可解析')
  process.exit(2)
}

const onlyRaw = argOf('only')
const onlySet = onlyRaw ? new Set(onlyRaw.split(',').map((s) => s.trim())) : null
const target = onlySet ? rows.filter((r) => onlySet.has(r.script)) : rows

/**
 * 需要**位置参数 tar** 的门禁（否则只打印用法行并 exit 2——那是"我没给输入"，不是"门禁红了"）。
 *
 * 口径与聚合入口一致：它把 `snapshotTar(abi)` 当位置参数传下去。
 * 这里默认指向**真正打进 APK 的那一份**（app/src/main/assets/snapshot.tar.xz，注入后产物），
 * 因为它才是`check-inject-completeness` / `check-strip-noop` / `check-snapshot-secrets` 要验的对象。
 * 用 --snapshot-dir 可换成 .deploy-tmp 下的双 ABI 面。
 */
const SNAPSHOT_ARG_GATES = new Set([
  'check-snapshot-secrets.mjs',
  'check-inject-completeness.mjs',
  'check-strip-noop.mjs',
])
/**
 * --injected <path>：直接指到"注入后、已打进 APK 的那一份" tar.xz。
 *
 * 为什么需要它：worktree 是净检出，app/src/main/assets/snapshot.tar.xz 被 .gitignore 忽略，
 * 这里必然缺席。真实产物在主工作区——用 --injected 指过去，**不把 191MB 复制进工作区**。
 */
const injectedArg = argOf('injected')
const snapshotDir = argOf('snapshot-dir')
const injectedTar = injectedArg
  ? resolve(injectedArg)
  : snapshotDir
    ? join(resolve(snapshotDir), 'snapshot-arm64.tar.xz')
    : join(ROOT, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz')
/** check-strip-noop 还需要 --base 用来对照"剥了跟没剥一样" */const baseDsh = join(ROOT, 'base', 'base-dsh.tar.xz')
const argsFor = (script) => {
  if (SNAPSHOT_ARG_GATES.has(script)) {
    if (!existsSync(injectedTar)) return null
    const extra = script === 'check-strip-noop.mjs' && existsSync(baseDsh) ? ['--base', baseDsh] : []
    return [injectedTar, ...extra]
  }
  return []
}

const results = []
for (const row of target) {
  const extraArgs = argsFor(row.script)
  if (extraArgs === null) {
    // 位置参数门禁缺输入：如实记为 INPUT-ABSENT，不冒充"判据红了"，也不冒充绿。
    results.push({ script: row.script, owner: row.owner, needsSnapshot: true, exit: null, ms: 0, outBytes: 0,
      skips: 0, verdict: 'INPUT-ABSENT', firstFail: '缺少位置参数 tar：' + injectedTar })
    console.log('INPUT-ABSENT         --- ms  out=      0 B  ' + row.script + '  -> 缺少位置参数 tar：' + injectedTar)
    continue
  }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join('scripts', row.script), ...extraArgs],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  const ms = Date.now() - t0
  const out = (r.stdout || '') + (r.stderr || '')
  const skips = [...out.matchAll(/SKIP=(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0)
  const dependencyAbsent = /DEPENDENCY-ABSENT|NO-CRITERIA|判据未执行|对端树不在场|不在场/i.test(out)
  const exit = r.status === null ? -1 : r.status
  const verdict = exit === 0
    ? (skips > 0 ? 'GREEN-WITH-SKIP' : 'GREEN')
    : (dependencyAbsent ? 'DEPENDENCY-ABSENT' : 'RED')
  // 首条 FAIL / 错误行：报告里要能落到具体判据，而不是"它红了"。
  const firstFail = (out.split(/\r?\n/).find((l) => /^(FAIL|CHECK-[A-Z-]+ FAILED|NO-CRITERIA)/.test(l.trim())) || '').trim().slice(0, 200)
  results.push({
    script: row.script, owner: row.owner, needsSnapshot: /需要快照/.test(row.note),
    exit, ms, outBytes: Buffer.byteLength(out, 'utf8'), skips, verdict,
    firstFail,
  })
  console.log(
    (verdict + '          ').slice(0, 19)
    + String(ms).padStart(7) + ' ms  out=' + String(Buffer.byteLength(out, 'utf8')).padStart(7) + ' B  ' + row.script
    + (row.note ? '  [' + row.note + ']' : '')
    + (firstFail ? '  -> ' + firstFail : ''),
  )
}

const tally = {}
for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1
const totalMs = results.reduce((s, r) => s + r.ms, 0)
console.log('')
console.log('GATES-BASELINE 合计 ' + results.length + ' 条 / ' + totalMs + ' ms；分布 ' +
  Object.entries(tally).map(([k, v]) => k + '=' + v).join('  '))

const outPath = argOf('json')
if (outPath) {
  const abs = join(ROOT, outPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify({
    at: new Date().toISOString(),
    node: process.version,
    declared: rows.length,
    ran: results.length,
    totalMs,
    tally,
    results,
  }, null, 2))
  console.log('已落盘 -> ' + relative(ROOT, abs).replace(/\\/g, '/'))
}
process.exit(0)
