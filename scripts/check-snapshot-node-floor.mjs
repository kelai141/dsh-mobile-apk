#!/usr/bin/env node
// check-snapshot-node-floor.mjs — 快照 node 版本下限门禁（0.2.2-rc.1 适配引入）。
//
// ── 为什么这条门存在 ────────────────────────────────────────────────────────
// @deepseek-ai/dsh@0.2.2-rc.1 是**首个在 package.json 声明 engines.node 的引擎版本**
// （0.2.1-rc.3 无该字段），声明值 ">=24.9.0"。而本仓快照里的 node 来自 Termux 签名仓库的
// nodejs-lts，**没有在仓内钉版本号**——引擎要 24.9，快照里实际是 24.18.0 这件事，
// 在此之前只存在于人读的文档里。于是下一次 Termux 侧回退到 24.8 以下（或有人把
// enginesNode 悄悄改小），整套适配在上设备前都不会红：单元测试跑在宿主 node 上，
// 快照构建成功也不代表快照内 node 达标。
//
// 这条门把两个数字绑起来：**contract.upstream.enginesNode（声明下限） vs 快照实测版本**。
// 快照实测值不是「读当前运行进程的 node」——那是宿主版本，与快照无关；它来自
// scripts/snapshot-config/snapshot-runtime.json 的取证记录（从 base/base-usr-*.tar.xz 里
// 取 usr/bin/node 读内嵌版本串与 node_module_version 得出的），并同时校验那两个基座归档
// 的存在与字节数（默认档）/ sha256（--full），防止「换了基座但没人更新取证」。
//
// ── 判据 ───────────────────────────────────────────────────────────────────
//   1. contract.upstream.enginesNode 必须是可解析的 ">=X.Y.Z" 形态（本仓口径）；
//      区间/并列/星号等其它形态一律 exit 2 —— 不猜。
//   2. snapshot-runtime.json 的 nodeVersion 必须 >= 该下限（按 semver 数值比较，不按字符串）。
//   3. 每个基座归档必须存在且字节数与记录一致；--full 追加 sha256 流式校验。
//   4. 任一字段缺失/类型不对 => exit 2（布局不可解析），不静默放过。
//
// ── 修法 ───────────────────────────────────────────────────────────────────
//   · 快照真的升级了 node：重取两个 ABI 的基座，更新 snapshot-runtime.json 的
//     nodeVersion / nodeModuleVersion / sha256 / bytes，并在 docs/adapt/ 记录取证命令。
//   · 引擎声明变了：先改 contract.upstream.enginesNode（它同时被 build-apk-source.yml 与
//     release.yml 拿去和上游 package.json 逐字比对），再确认快照仍然达标。
//   **不要**为了过门把 nodeVersion 写成没实测过的值：这道门判的就是「这个数字是不是真的」。
//
// 用法：node scripts/check-snapshot-node-floor.mjs            # 版本下限 + 字节数（便宜）
//       node scripts/check-snapshot-node-floor.mjs --full     # 追加 sha256（发布链用）
//       node scripts/check-snapshot-node-floor.mjs --self-test
// 退出码：0 通过；1 判定失败；2 布局/形态不可解析
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)

export const CONTRACT_REL = 'scripts/contract.json'
export const EVIDENCE_REL = 'scripts/snapshot-config/snapshot-runtime.json'

/** 解析 engines 下限：本仓只接受 ">=X.Y.Z"（其余形态一律不可解析，不猜）。 */
export function parseFloor(range) {
  const m = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(range ?? ''))
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** 解析实测版本 "X.Y.Z"；不接受前缀 v 之外的杂质。 */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** 数值比较：a >= b。 */
export function gte(a, b) {
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  return a.patch >= b.patch
}

export function fmt(v) {
  return v ? v.major + '.' + v.minor + '.' + v.patch : '(unparseable)'
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 纯判定：吃「已读入的数据」，不碰磁盘（自检与真检共用）。
 *
 * @param {{enginesNode: string, evidence: object, statOf: (rel: string) => {exists: boolean, bytes: number}, hashOf?: (rel: string) => string, full: boolean}} input
 * @returns {{problems: string[], failures: string[], infos: string[]}}
 */
export function evaluate(input) {
  const problems = []
  const failures = []
  const infos = []

  const floor = parseFloor(input.enginesNode)
  if (!floor) {
    problems.push('contract.upstream.enginesNode 不可解析为 ">=X.Y.Z"：' + JSON.stringify(input.enginesNode))
    return { problems, failures, infos }
  }
  infos.push('声明下限 enginesNode=' + input.enginesNode)

  const ev = input.evidence || {}
  const actual = parseVersion(ev.nodeVersion)
  if (!actual) {
    problems.push('snapshot-runtime.json 的 nodeVersion 缺失或不可解析：' + JSON.stringify(ev.nodeVersion))
  } else if (!gte(actual, floor)) {
    failures.push('快照 node ' + fmt(actual) + ' 低于引擎声明下限 ' + fmt(floor) + '（' + input.enginesNode + '）')
  } else {
    infos.push('快照 node ' + fmt(actual) + ' >= 下限 ' + fmt(floor) + '（余量 ' + (actual.minor - floor.minor) + ' 个 minor，major 相同）')
  }

  if (ev.nodeModuleVersion !== undefined && !Number.isInteger(ev.nodeModuleVersion)) {
    problems.push('nodeModuleVersion 必须是整数：' + JSON.stringify(ev.nodeModuleVersion))
  }

  const tars = ev.baseTarballs
  if (!tars || typeof tars !== 'object' || Object.keys(tars).length === 0) {
    problems.push('snapshot-runtime.json 缺 baseTarballs')
  } else {
    for (const [abi, rec] of Object.entries(tars)) {
      if (!rec || typeof rec.file !== 'string' || !rec.file) { problems.push(abi + ': 缺 file'); continue }
      if (!Number.isInteger(rec.bytes) || rec.bytes <= 0) { problems.push(abi + ': bytes 必须是正整数'); continue }
      const st = input.statOf(rec.file)
      if (!st.exists) { problems.push(abi + ': 基座归档不存在 ' + rec.file); continue }
      if (st.bytes !== rec.bytes) {
        failures.push(abi + ': ' + rec.file + ' 字节数 ' + st.bytes + ' 与记录 ' + rec.bytes + ' 不一致（换了基座却没更新取证？）')
        continue
      }
      if (input.full) {
        if (typeof rec.sha256 !== 'string' || rec.sha256.length !== 64) { problems.push(abi + ': --full 需要记录 sha256'); continue }
        const got = input.hashOf(rec.file)
        if (got !== rec.sha256) failures.push(abi + ': ' + rec.file + ' sha256 ' + got + ' 与记录 ' + rec.sha256 + ' 不一致')
        else infos.push(abi + ': sha256 与记录一致')
      } else {
        infos.push(abi + ': 字节数一致（默认档不校验 sha256，发布链用 --full）')
      }
    }
  }
  return { problems, failures, infos }
}

export function exitCodeOf(result) {
  return result.problems.length > 0 ? 2 : result.failures.length > 0 ? 1 : 0
}

function report(root, full) {
  const contractPath = join(root, CONTRACT_REL)
  const evidencePath = join(root, EVIDENCE_REL)
  if (!existsSync(contractPath) || !existsSync(evidencePath)) {
    console.error('CHECK-SNAPSHOT-NODE-FLOOR FAILED（布局不可解析）：缺 ' + (existsSync(contractPath) ? evidencePath : contractPath))
    return 2
  }
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  const result = evaluate({
    enginesNode: contract?.upstream?.enginesNode,
    evidence,
    full,
    statOf: (rel) => {
      const p = join(root, rel)
      return existsSync(p) ? { exists: true, bytes: statSync(p).size } : { exists: false, bytes: 0 }
    },
    hashOf: (rel) => sha256File(join(root, rel)),
  })
  for (const i of result.infos) console.log('INFO  ' + i)
  for (const f of result.failures) console.error('FAIL  ' + f)
  for (const p of result.problems) console.error('PROBLEM ' + p)
  const code = exitCodeOf(result)
  if (code === 2) {
    console.error('CHECK-SNAPSHOT-NODE-FLOOR FAILED（布局/形态不可解析）')
    console.error('  修法：enginesNode 必须是 ">=X.Y.Z"；snapshot-runtime.json 必须有 nodeVersion/baseTarballs(file,bytes[,sha256])。')
  } else if (code === 1) {
    console.error('CHECK-SNAPSHOT-NODE-FLOOR FAILED（快照 node 不满足引擎声明下限）')
    console.error('  修法：从 base/base-usr-*.tar.xz 取 usr/bin/node 复测版本，按实测更新 snapshot-runtime.json 并在 docs/adapt/ 记录命令；')
    console.error('  不要为了过门写没实测过的数字——这道门判的就是这个数字是不是真的。')
  } else {
    console.log('CHECK-SNAPSHOT-NODE-FLOOR PASSED（快照 node 满足引擎下限' + (full ? '，含 sha256' : '') + '）')
  }
  return code
}

function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'node-floor-'))
  const fails = []
  let count = 0
  const t = (label, ok) => { count += 1; if (!ok) fails.push(label); else console.log('PASS  [self-test] ' + label) }
  const ev = (v, extra) => ({
    nodeVersion: v, nodeModuleVersion: 137,
    baseTarballs: { x86_64: { file: 'a.tar.xz', bytes: 3 }, arm64: { file: 'b.tar.xz', bytes: 3 } },
    ...(extra || {}),
  })
  const fixed = { 'a.tar.xz': { exists: true, bytes: 3 }, 'b.tar.xz': { exists: true, bytes: 3 } }
  const run = (enginesNode, evidence, opts) => evaluate({
    enginesNode, evidence, full: !!(opts && opts.full),
    statOf: (rel) => (opts && opts.statOf ? opts.statOf(rel) : fixed[rel] || { exists: false, bytes: 0 }),
    hashOf: () => 'f'.repeat(64),
  })
  try {
    t('正控：24.18.0 >= 24.9.0 -> exit 0', exitCodeOf(run('>=24.9.0', ev('24.18.0'))) === 0)
    t('负控：24.8.0 < 24.9.0 -> exit 1', exitCodeOf(run('>=24.9.0', ev('24.8.0'))) === 1)
    t('负控：篡改版本串（24.18.0 -> 24.4.0）必须转红', exitCodeOf(run('>=24.9.0', ev('24.4.0'))) === 1)
    t('负控：主版本跨线（23.9.0 < 24.9.0）判红', exitCodeOf(run('>=24.9.0', ev('23.9.0'))) === 1)
    t('负控：下限被调高（>=25.0.0）后原版本判红', exitCodeOf(run('>=25.0.0', ev('24.18.0'))) === 1)
    t('正控：版本带 v 前缀可解析', exitCodeOf(run('>=24.9.0', ev('v24.18.0'))) === 0)
    t('形态：区间 ">=22.19 || >=24" 不可解析 -> exit 2', exitCodeOf(run('^22.19.0 || >=24.0.0', ev('24.18.0'))) === 2)
    t('形态：nodeVersion 缺失 -> exit 2', exitCodeOf(run('>=24.9.0', ev(undefined))) === 2)
    t('布局：baseTarballs 缺失 -> exit 2', exitCodeOf(run('>=24.9.0', { nodeVersion: '24.18.0' })) === 2)
    t('布局：基座归档缺失 -> exit 2', exitCodeOf(run('>=24.9.0', ev('24.18.0'), { statOf: () => ({ exists: false, bytes: 0 }) })) === 2)
    t('负控：基座字节数变化 -> exit 1', exitCodeOf(run('>=24.9.0', ev('24.18.0'), { statOf: () => ({ exists: true, bytes: 999 }) })) === 1)
    t('--full：sha256 不一致 -> exit 1', exitCodeOf(run('>=24.9.0', ev('24.18.0', { baseTarballs: { x86_64: { file: 'a.tar.xz', bytes: 3, sha256: 'e'.repeat(64) } } }), { full: true })) === 1)
    t('--full：sha256 一致 -> exit 0', exitCodeOf(run('>=24.9.0', ev('24.18.0', { baseTarballs: { x86_64: { file: 'a.tar.xz', bytes: 3, sha256: 'f'.repeat(64) } } }), { full: true })) === 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  if (fails.length > 0) {
    console.error('CHECK-SNAPSHOT-NODE-FLOOR SELF-TEST FAILED（' + fails.length + ' / ' + count + ' 项）：' + fails.join('；'))
    return 1
  }
  console.log('CHECK-SNAPSHOT-NODE-FLOOR SELF-TEST PASSED（' + count + ' 项判别力断言：正控放行 / 低于下限 / 篡改版本串 / 跨主版本 / 下限抬高 / v 前缀 / 区间不可解析 / 缺字段 / 归档缺失 / 字节漂移 / sha256 一致与不一致）')
  return 0
}

if (argv.includes('--self-test')) process.exit(selfTest())
process.exit(report(ROOT, argv.includes('--full')))
