#!/usr/bin/env node
// check-release-gates.mjs — 门禁聚合入口（0.13.8-b 批 B2：#208.E2 + F-ENV-13）
//
// 为什么需要它：issue #208 的根因是「同一批门禁在四条路径上有四份实现」——云端链只调 4 项、
// 两仓 CI 未接、发布链只跑机密与 elf。各自再写一份必然第三次漂移。本脚本是**唯一声明处**：
//   1) 声明本迭代要求的门禁集合（GATES），并断言每条接线路径实际调用 ⊇ 该集合；
//   2) 断言 build-release.ps1 走本聚合入口（`--run`），即发布链跑的是与打包同源的门禁集；
//   3) 断言 build-release.ps1 的 $pluginSrcs ⊇ build-apk-013.ps1 的 $pluginDirs（差集须显式声明理由）。
//
// 用法：
//   node scripts/check-release-gates.mjs                      # 静态接线断言（CI 可直接跑）
//   node scripts/check-release-gates.mjs --list               # 打印声明的门禁集合
//   node scripts/check-release-gates.mjs --run [--snapshot-dir <dir>]   # 顺序执行门禁集（发布链用）
// 退出码：0 = 通过；1 = 接线缺口 / 门禁失败 / 树定位失败。
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const RUN = argv.includes('--run')
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

/** 本迭代要求的门禁集合（唯一声明处）。needsSnapshot=true 的门禁由构建/发布链调用，CI 不跑。 */
const GATES = [
  { script: 'check-patch-mirror.mjs', ci: true, needsSnapshot: false },
  { script: 'check-manifest-hardening.mjs', ci: true, needsSnapshot: false },
  { script: 'check-bounded-io.mjs', ci: true, needsSnapshot: false },
  { script: 'check-snapshot-fingerprint.mjs', ci: true, needsSnapshot: true },
  { script: 'check-tool-output-schema.mjs', ci: true, needsSnapshot: false },
  { script: 'check-protocol-v2.mjs', ci: true, needsSnapshot: false },
  { script: 'check-control-ops.mjs', ci: true, needsSnapshot: false },
  { script: 'check-runtime-assets.mjs', ci: false, needsSnapshot: true },
  // 0.13.8-b B2（ST-25/26/31 + §7.2 度量）：制度性门禁与性能度量入口一并进声明集合，
  // 由本聚合入口保证两条链 + 两仓 CI 都跑到（接线面只此一处）。
  { script: 'check-state-registry.mjs', ci: true, needsSnapshot: false },
  { script: 'check-bridge-symmetry.mjs', ci: true, needsSnapshot: false },
  { script: 'check-gate-skips.mjs', ci: true, needsSnapshot: false },
  { script: 'check-perf-instrumentation.mjs', ci: true, needsSnapshot: true },
  // 注入面成员完整性（P0：包内新增文件曾被静默丢弃 → ERR_MODULE_NOT_FOUND/引擎启动即死）：
  // 需要「注入后」tar，故 CI 不跑，由两条构建链在注入步骤之后调用 + 发布链按快照面跑。
  { script: 'check-inject-completeness.mjs', ci: false, needsSnapshot: true },
  // Kotlin 块注释嵌套静态检查（KDoc 里写 node_modules/** 会吞掉整个文件；dev-shell 实测）。
  { script: 'check-kotlin-comments.mjs', ci: true, needsSnapshot: false },
  // 剥离清单后置断言（ST-16）：清单项在产物里必须不存在 + 反 no-op（基座命中的必须消失）。
  { script: 'check-strip-noop.mjs', ci: false, needsSnapshot: true },
]
const CI_GATES = GATES.filter((g) => g.ci).map((g) => g.script)
const ALL_GATES = GATES.map((g) => g.script)

if (argv.includes('--list')) {
  for (const g of GATES) console.log(g.script.padEnd(34) + (g.ci ? 'CI+构建' : '仅构建/发布') + (g.needsSnapshot ? ' 需要快照' : ''))
  process.exit(0)
}

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
/** 布局无关解析：协调仓根用 `dsh-mobile-apk/...`；apk 仓自包含根落到同名相对路径。 */
const resolveRel = (p) => {
  const cands = p.startsWith('dsh-mobile-apk/') ? [p, p.slice('dsh-mobile-apk/'.length)] : [p]
  return cands.find((c) => existsSync(join(ROOT, c)))
}
const readOrFail = (p) => {
  const hit = resolveRel(p)
  if (!hit) { check('接线面存在: ' + p, false, '文件缺席（协调仓根与 apk 仓根布局均未命中）'); return null }
  return readFileSync(join(ROOT, hit), 'utf8')
}

// ── 1. 接线面（§8.3 C 的五位置 + apk 仓同版）────────────────────────────────
const POSITIONS = [
  { id: 'local-chain', file: 'scripts/build-apk-013.ps1', gates: ALL_GATES, kind: 'gate-names' },
  { id: 'cloud-chain', file: 'dsh-mobile-apk/scripts/build-apk.mjs', gates: ALL_GATES, kind: 'gate-names' },
  { id: 'ci-coord', file: '.github/workflows/pr-gate.yml', gates: CI_GATES, kind: 'gate-names' },
  { id: 'ci-apk', file: 'dsh-mobile-apk/.github/workflows/pr-gate.yml', gates: CI_GATES, kind: 'gate-names' },
  { id: 'release-coord', file: 'scripts/build-release.ps1', gates: ALL_GATES, kind: 'aggregator' },
  { id: 'release-apk', file: 'dsh-mobile-apk/scripts/build-release.ps1', gates: ALL_GATES, kind: 'aggregator' },
]
for (const pos of POSITIONS) {
  const text = readOrFail(pos.file)
  if (text === null) continue
  if (pos.kind === 'aggregator') {
    const hasEntry = text.includes('check-release-gates.mjs') && text.includes('--run')
    check(pos.id + ' 走聚合入口（check-release-gates.mjs --run，与打包同源门禁集）', hasEntry,
      '缺聚合入口调用：发布链不得只跑机密/elf 门禁')
    continue
  }
  const missing = pos.gates.filter((g) => !text.includes(g))
  check(pos.id + ' 门禁集 ⊇ 声明集合（' + pos.gates.length + ' 项）', missing.length === 0,
    '未接线: ' + missing.join(', '))
}

// ── 2. $pluginSrcs ⊇ $pluginDirs（构建/发布章 F-ENV-13）────────────────────
const GAPS_PATH = join(ROOT, 'scripts', 'release-plugin-src-gaps.json')
const gaps = existsSync(GAPS_PATH) ? (JSON.parse(readFileSync(GAPS_PATH, 'utf8')).gaps ?? []) : []
const buildPs1 = readFileSync(join(ROOT, 'scripts', 'build-apk-013.ps1'), 'utf8')
const releasePs1 = readFileSync(join(ROOT, 'scripts', 'build-release.ps1'), 'utf8')
// 注入集单一常量（0.13.8-b ST-06 / F-ENV-04）：$pluginDirs 已外提到 scripts/plugin-dirs.json，
// 本地链与云端链 build-apk.mjs 共用同一份（旧实现两处各写一份，云端少一个包且无从发现）。
const pluginManifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'plugin-dirs.json'), 'utf8'))
const pluginDirs = new Set(pluginManifest.dirs.map((p) => p.split('/').pop()))
const pluginSrcs = new Set((releasePs1.match(/\$pluginSrcs\s*=\s*@\(([^)]*)\)/) ?? [,''])[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).map((p) => p.split('/').pop()))
check('$pluginDirs / $pluginSrcs 可解析', pluginDirs.size > 0 && pluginSrcs.size > 0,
  'pluginDirs=' + pluginDirs.size + ' pluginSrcs=' + pluginSrcs.size)

const missingFromSrcs = [...pluginDirs].filter((p) => !pluginSrcs.has(p)).sort()
const undeclared = missingFromSrcs.filter((p) => !gaps.some((g) => (g.plugin ?? '').split('/').pop() === p))
const badGap = gaps.filter((g) => !g.reason || !String(g.reason).trim())
const staleGap = gaps.filter((g) => !missingFromSrcs.includes((g.plugin ?? '').split('/').pop()))
for (const g of gaps) console.log('WARN  $pluginSrcs 差集显式声明: ' + g.plugin + ' -> ' + g.reason)
check('build-release.ps1 $pluginSrcs ⊇ build-apk-013.ps1 $pluginDirs（差集须显式声明理由）',
  undeclared.length === 0 && badGap.length === 0,
  '未声明或空理由: ' + [...undeclared, ...badGap.map((g) => g.plugin)].join(', '))
check('release-plugin-src-gaps.json 无过期条目', staleGap.length === 0,
  '已不再缺失却仍声明: ' + staleGap.map((g) => g.plugin).join(', '))

// ── 3. 两树同版（同源文件逐字节由 check-patch-mirror 守；此处守本次新增/改动的接线文件）──
for (const f of ['scripts/build-release.ps1', 'scripts/build-apk-013.ps1']) {
  const a = join(ROOT, f)
  const b = join(ROOT, 'dsh-mobile-apk', f)
  if (!existsSync(b)) { check('两树同版: ' + f, true, '（对端缺席，跳过）'); continue }
  const same = readFileSync(a).equals(readFileSync(b))
  check('两树同版: ' + f, same, '逐字节不一致（autocrlf 噪声也会计入——请同步镜像）')
}

// ── 3b. 两份编排器门禁集差集 = 0（0.13.8-b ST-06 / F-ENV-04 ④）────────────────
// 本地链（PowerShell）与云端链（node）必须调用同一组门禁：任一链少一道 = 该路径缺防线。
const parseGateSetFromPs1 = (text) => new Set(
  [...text.matchAll(/scripts\\(check-[a-z0-9-]+\.mjs|elf-check\.mjs)/g)].map((m) => m[1]),
)
const parseGateSetFromMjs = (text) => {
  const i = text.indexOf('const GATE_SCRIPTS = [')
  if (i < 0) return null
  const j = text.indexOf(']', i)
  return new Set([...text.slice(i, j).matchAll(/'([a-z0-9-]+\.mjs)'/g)].map((m) => m[1]))
}
const mjsRel = resolveRel('dsh-mobile-apk/scripts/build-apk.mjs')
const mjsText = mjsRel ? readFileSync(join(ROOT, mjsRel), 'utf8') : null
const ps1Gates = parseGateSetFromPs1(buildPs1)
const mjsGates = mjsText ? parseGateSetFromMjs(mjsText) : null
if (!mjsGates) {
  check('云端编排器门禁集可解析（dsh-mobile-apk/scripts/build-apk.mjs 的 GATE_SCRIPTS）', false,
    mjsRel ? 'GATE_SCRIPTS 数组缺席' : '文件在两仓布局下均未命中')
} else {
  const onlyPs1 = [...ps1Gates].filter((g) => !mjsGates.has(g)).sort()
  const onlyMjs = [...mjsGates].filter((g) => !ps1Gates.has(g)).sort()
  check('两份编排器门禁集差集 = 0（本地链 ' + ps1Gates.size + ' 项 / 云端链 ' + mjsGates.size + ' 项）',
    onlyPs1.length === 0 && onlyMjs.length === 0,
    '仅本地链: [' + onlyPs1.join(', ') + ']；仅云端链: [' + onlyMjs.join(', ') + ']')
}

if (!RUN) {
  if (failures.length > 0) {
    console.error('CHECK-RELEASE-GATES FAILED（' + failures.length + ' 项接线缺口）：' + failures.join('；'))
    process.exit(1)
  }
  console.log('CHECK-RELEASE-GATES PASSED（静态接线断言；声明门禁集 ' + ALL_GATES.length + ' 项）')
  process.exit(0)
}

// ── 4. --run：顺序执行声明门禁集（发布链唯一入口；失败即中止）────────────────
if (failures.length > 0) {
  console.error('CHECK-RELEASE-GATES FAILED（接线缺口先修）：' + failures.join('；'))
  process.exit(1)
}
const STRICT = argv.includes('--require')
const snapshotDir = argOf('snapshot-dir')
const abis = ['arm64', 'x86_64'].filter((abi) => {
  if (snapshotDir) return existsSync(join(resolve(snapshotDir), 'snapshot-' + abi + '.tar.xz'))
  return existsSync(join(ROOT, '.deploy-tmp', 'snapshot-013', abi, 'snapshot.tar.xz'))
})
console.log('发布门禁集：' + ALL_GATES.join(' → '))
console.log('快照面：' + (abis.length > 0 ? abis.join(', ') : '（无：snapshot-fingerprint/runtime-assets 将按 --require 失败）'))
let ran = 0
// SKIP 合计（ST-31 / ST-16）：逐门禁捕获输出并解析 SKIP=n；发布链（--require）要求合计 = 0。
let skipTotal = 0
const runGate = (argvFor, label) => {
  const r = spawnSync(process.execPath, argvFor, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  const m = /SKIP=(\d+)/.exec((r.stdout || '') + (r.stderr || ''))
  if (m) skipTotal += Number(m[1])
  if (r.status !== 0) {
    console.error('CHECK-RELEASE-GATES FAILED：' + label + ' 退出码 ' + r.status + '，中止组装')
    process.exit(1)
  }
}
const snapshotTar = (abi) => join(resolve(snapshotDir), 'snapshot-' + abi + '.tar.xz')
for (const gate of ALL_GATES) {
  const argvFor = [join('scripts', gate)]
  // 严格档（发布链 --require）：凡支持 --require 的门禁一律传，SKIP 即失败（ST-31：发布链 SKIP=0）。
  if (STRICT && ['check-snapshot-fingerprint.mjs', 'check-perf-instrumentation.mjs'].includes(gate)) argvFor.push('--require')
  if (gate === 'check-runtime-assets.mjs') {
    if (snapshotDir && abis.length > 0) {
      for (const abi of abis) runGate([join('scripts', gate), abi, '--require', '--snapshot', snapshotTar(abi)], gate + '(' + abi + ')')
      ran += 1
      console.log('PASS  ' + gate + '（' + abis.join(', ') + '）')
      continue
    }
    argvFor.push(...(abis.length > 0 ? [abis[0]] : ['arm64']), ...(STRICT ? ['--require'] : []))
  }
  // 需要「产物 tar」的门禁（P0 注入完整性 / 剥离清单后置断言）：发布链有快照面时按 ABI 跑；
  // 没有则计一条 SKIP —— 严格档随后判红（不得以 SKIP 结案）。
  if (['check-inject-completeness.mjs', 'check-strip-noop.mjs'].includes(gate)) {
    if (snapshotDir && abis.length > 0) {
      for (const abi of abis) runGate([join('scripts', gate), snapshotTar(abi)], gate + '(' + abi + ')')
      ran += 1
      console.log('PASS  ' + gate + '（' + abis.join(', ') + '）')
      continue
    }
    skipTotal += 1
    console.log('SKIP(#' + skipTotal + ')  ' + gate + '：发布链未提供快照面（--snapshot-dir 下无 tar）')
    ran += 1
    continue
  }
  runGate(argvFor, gate)
  ran += 1
  console.log('PASS  ' + gate)
}
console.log('SKIP=' + skipTotal + ' 合计' + (STRICT ? '（发布链要求 0）' : ''))
if (STRICT && skipTotal > 0) {
  console.error('CHECK-RELEASE-GATES FAILED：发布链要求 SKIP=0，实测 ' + skipTotal + ' —— 不得以 SKIP 结案（ST-31/ST-16）')
  process.exit(1)
}
console.log('CHECK-RELEASE-GATES --run PASSED（已执行 ' + ran + '/' + ALL_GATES.length + ' 项，SKIP=' + skipTotal + '）')
