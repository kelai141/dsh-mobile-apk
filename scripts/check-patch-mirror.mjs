#!/usr/bin/env node
// check-patch-mirror.mjs — 两树补丁镜像一致性门禁（0.13.8 PR-A1；apk issue #171 残留防线）
//
// 背景：scripts/patches/** 是双仓镜像面（协调仓 = 权威源；dsh-mobile-apk/scripts/patches =
// 云端自包含构建 .github/workflows/build-apk.yml 检出的副本）。单边演进 = 云端构建的快照
// 静默缺引擎树补丁（幽灵缺陷：编译与门禁全绿但功能缺失，apk #171 的实锤成因）。
//
// 断言两层：
//   A 自包含一致性（任一仓单独可跑）：registry.json 的补丁 id 集合 == apply-patches.mjs
//     IMPLS 的实现 id 集合（双向），防「登记了没实现 / 实现了没登记」。
//   B 镜像一致性（对端树在场时）：registry.json / apply-patches.mjs / README.md 逐字节一致
//     （CRLF 归一后比对）；tests/ 递归文件清单一致，共有文件逐字节一致。
//
// 对端树定位顺序：--peer <dir> > 环境变量 DSH_MIRROR_PEER > <root>/dsh-mobile-apk >
// <root>/..（该目录含 scripts/patches 即认）。对端缺席时镜像层跳过并提示（CI 单仓
// checkout 场景应显式 checkout 对端后运行，见两仓 pr-gate.yml）。
//
// 用法：node scripts/check-patch-mirror.mjs [--self] [--peer <dir>]
// 退出码：0 = 全部通过；1 = 失败（构建链与 CI 以此拒打包/拒合并）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const peerArgIdx = argv.indexOf('--peer')
const PEER_OVERRIDE = peerArgIdx >= 0 ? argv[peerArgIdx + 1] : process.env.DSH_MIRROR_PEER
const SELF_ONLY = argv.includes('--self')

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
/** 比较结果：same = 原始字节一致；eol = 仅行尾差异（工作树 autocrlf 噪声，告警不拦）；
 *  content = 归一后仍不同（真实漂移，FAIL）。 */
const cmp = (a, b) => {
  const ba = readFileSync(a)
  const bb = readFileSync(b)
  if (ba.equals(bb)) return 'same'
  const norm = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  return norm(ba).equals(norm(bb)) ? 'eol' : 'content'
}

// ── A 自包含一致性 ──────────────────────────────────────────────
const regPath = join(ROOT, 'scripts', 'patches', 'registry.json')
const implPath = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
let regIds = []
let implIds = []
try {
  regIds = JSON.parse(readFileSync(regPath, 'utf8')).patches.map((p) => p.id)
} catch (e) {
  check('registry.json 可解析', false, String(e).slice(0, 200))
}
try {
  const src = readFileSync(implPath, 'utf8')
  implIds = [...src.matchAll(/^  '([^']+)':\s*\{/gm)].map((m) => m[1])
  check('apply-patches.mjs IMPLS 条目非空', implIds.length > 0, `解析到 ${implIds.length} 条`)
} catch (e) {
  check('apply-patches.mjs 可读', false, String(e).slice(0, 200))
}
if (regIds.length > 0 && implIds.length > 0) {
  const regSet = new Set(regIds)
  const implSet = new Set(implIds)
  const missingImpl = regIds.filter((id) => !implSet.has(id))
  const missingReg = implIds.filter((id) => !regSet.has(id))
  check('registry id 集合 == IMPLS id 集合',
    missingImpl.length === 0 && missingReg.length === 0,
    `登记缺实现: [${missingImpl.join(', ')}]；实现缺登记: [${missingReg.join(', ')}]`)
}

// ── B 镜像一致性 ────────────────────────────────────────────────
let peer = null
if (!SELF_ONLY) {
  const candidates = []
  if (PEER_OVERRIDE) candidates.push(PEER_OVERRIDE)
  candidates.push(join(ROOT, 'dsh-mobile-apk'))
  candidates.push(dirname(ROOT))
  for (const c of candidates) {
    if (c === ROOT) continue
    try {
      if (statSync(join(c, 'scripts', 'patches', 'registry.json')).isFile()) { peer = c; break }
    } catch { /* 下一候选 */ }
  }
}

if (!SELF_ONLY && !peer) {
  console.log('SKIP  镜像层：对端树不在场（CI 单仓场景请 checkout 对端后运行，或传 --peer/--self）')
}
if (peer) {
  console.log(`镜像对端: ${relative(dirname(ROOT), peer) || peer}`)
  const eolWarns = []
  const MIRROR_FILES = ['registry.json', 'apply-patches.mjs', 'README.md']
  for (const f of MIRROR_FILES) {
    const mine = join(ROOT, 'scripts', 'patches', f)
    const theirs = join(peer, 'scripts', 'patches', f)
    try {
      const r = cmp(mine, theirs)
      check(`镜像一致: scripts/patches/${f}`, r !== 'content', r === 'eol' ? '仅行尾差异（见告警）' : undefined)
      if (r === 'eol') eolWarns.push(`scripts/patches/${f}`)
    } catch (e) {
      check(`镜像一致: scripts/patches/${f}`, false, String(e).slice(0, 200))
    }
  }
  // tests/ 递归清单 + 共有文件逐字节
  const walk = (dir, prefix = '') => {
    const out = new Map()
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) out.set(rel, 'dir')
      else out.set(rel, 'file')
    }
    return out
  }
  let mineTests, peerTests
  try {
    mineTests = walk(join(ROOT, 'scripts', 'patches', 'tests'))
    peerTests = walk(join(peer, 'scripts', 'patches', 'tests'))
    const mineFiles = [...mineTests.entries()].filter(([, k]) => k === 'file').map(([r]) => r)
    const peerFiles = [...peerTests.entries()].filter(([, k]) => k === 'file').map(([r]) => r)
    const onlyMine = mineFiles.filter((r) => !peerTests.has(r))
    const onlyPeer = peerFiles.filter((r) => !mineTests.has(r))
    check('tests/ 文件清单一致',
      onlyMine.length === 0 && onlyPeer.length === 0,
      `本仓独有: [${onlyMine.join(', ')}]；对端独有: [${onlyPeer.join(', ')}]`)
    let badContent = []
    for (const rel of mineFiles) {
      if (!peerTests.has(rel)) continue
      try {
        const r = cmp(join(ROOT, 'scripts', 'patches', 'tests', rel), join(peer, 'scripts', 'patches', 'tests', rel))
        if (r === 'content') badContent.push(rel)
        else if (r === 'eol') eolWarns.push(`tests/${rel}`)
      } catch { badContent.push(rel) }
    }
    check('tests/ 共有文件逐字节一致', badContent.length === 0, `内容漂移: [${badContent.join(', ')}]`)
  } catch (e) {
    check('tests/ 目录可枚举', false, String(e).slice(0, 200))
  }
  // 门禁链自身也在镜像面（0.13.8 批 H 补线）：build-apk-013.ps1 与两个常驻门禁脚本
  // 单边演进同样造成「云端自包含构建跑旧门禁/旧脚本」的幽灵面——本仓曾出现
  // bounded-io 门禁只落在 apk 兜、协调仓脚本仍带 Join-Path 拼写缺陷而无人察觉。
  // 对端缺该文件时跳过（apk 仓独占脚本合法）。
  const MIRROR_TOP = [
    'scripts/build-apk-013.ps1',
    'scripts/check-manifest-hardening.mjs',
    'scripts/check-bounded-io.mjs',
  ]
  for (const rel of MIRROR_TOP) {
    const theirs = join(peer, rel)
    if (!existsSync(theirs)) { console.log(`SKIP  镜像一致: ${rel}（对端无此文件）`); continue }
    try {
      const r = cmp(join(ROOT, rel), theirs)
      check(`镜像一致: ${rel}`, r !== 'content', r === 'eol' ? '仅行尾差异（见告警）' : undefined)
      if (r === 'eol') eolWarns.push(rel)
    } catch (e) {
      check(`镜像一致: ${rel}`, false, String(e).slice(0, 200))
    }
  }
  if (eolWarns.length > 0) {
    console.log(`WARN  仅行尾差异（git blob 层一致则无碍；本机为工作树 autocrlf 噪声）: [${eolWarns.join(', ')}]`)
  }
}

if (failures.length > 0) {
  console.error(`CHECK-PATCH-MIRROR FAILED（${failures.length} 项）：${failures.join('；')}`)
  process.exit(1)
}
console.log('CHECK-PATCH-MIRROR PASSED')
