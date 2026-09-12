#!/usr/bin/env node
// check-gate-skips.mjs — 门禁覆盖清单化 + SKIP 纪律门禁（0.13.8-b ST-31）。
//
// 断言：
//   1. 门禁清单 == 实际文件：check-release-gates.mjs 声明集合里的每个脚本都在 scripts/ 存在；
//      两条构建链（build-apk-013.ps1 / build-apk.mjs）调用的 check-*.mjs 都被声明集合覆盖
//      （覆盖清单化：不允许「有人加了一道门禁但没人接线」或反之）；
//   2. SKIP 必须计数且可见：任何 console 输出的 SKIP 行必须带计数器（SKIP(#n)）或显式 SKIP=n，
//      且该脚本必须在结尾打印汇总 SKIP=（发布链据此判 SKIP=0）；
//   3. 发布链 SKIP=0：build-release.ps1（两树）必须以 --run --require 调聚合入口，
//      且聚合入口对支持 --require 的门禁逐个传参。
//
// 用法：node scripts/check-gate-skips.mjs [--list]
// 退出码：0 = 通过；1 = 失败；2 = 布局不可解析。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SCRIPTS = join(ROOT, 'scripts')
const argv = process.argv.slice(2)

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径。
const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
const readIf = (rel) => { const p = resolveRepoPath(rel); return p === null ? null : readFileSync(p, 'utf8') }

// ── 1. 声明集合 vs 实际文件 vs 两条链 ───────────────────────────────────────
const aggText = readIf('scripts/check-release-gates.mjs')
if (aggText === null) { console.error('CHECK-GATE-SKIPS FAILED：缺 scripts/check-release-gates.mjs'); process.exit(2) }
const declared = [...aggText.matchAll(/\{ script: '([a-z0-9-]+\.mjs)'/g)].map((m) => m[1])
check('声明集合非空', declared.length > 0, 'gates=' + declared.length)
const missingFiles = declared.filter((g) => !existsSync(join(SCRIPTS, g)))
check('声明集合里的门禁全部在场', missingFiles.length === 0, '缺: ' + missingFiles.join(', '))

const invokedIn = (rel) => {
  const text = readIf(rel)
  if (text === null) return null
  // 兼容两种写法：'check-x.mjs'（node 侧数组/helper）与 "scripts\check-x.mjs"（PowerShell 调用）。
  return [...new Set([...text.matchAll(/["'\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/g)].map((m) => m[1]))]
}
const CHAINS = ['scripts/build-apk-013.ps1', 'dsh-mobile-apk/scripts/build-apk.mjs']
const declaredSet = new Set(declared)
for (const rel of CHAINS) {
  const invoked = invokedIn(rel)
  if (invoked === null) { check('构建链在场: ' + rel, false); continue }
  check('构建链在场: ' + rel, true)
  // 声明集合必须被本链**全覆盖**；链上多出来的长驻门禁（overlay/mounts/file-modes/third-party/
  // secrets/elf）不在「本迭代新增声明集合」里，属既有面——列出告警不判红（ST-31 的清单化产物）。
  const extras = invoked.filter((g) => !declaredSet.has(g) && g !== 'check-release-gates.mjs')
  if (extras.length > 0) console.log('WARN  ' + rel + ' 另有声明集合外的长驻门禁（既有面）: ' + extras.join(', '))
  const notInvoked = declared.filter((g) => !invoked.includes(g))
  check(rel + ' 调用声明集合的每一项（' + declared.length + ' 项）', notInvoked.length === 0, '未接线: ' + notInvoked.join(', '))
}

// ── 2. SKIP 纪律（逐脚本静态审计）───────────────────────────────────────────
const gateFiles = readdirSync(SCRIPTS).filter((f) => f.startsWith('check-') && f.endsWith('.mjs')).sort()
const skipAudit = []
for (const file of gateFiles) {
  const text = readFileSync(join(SCRIPTS, file), 'utf8')
  const lines = text.split('\n')
  // 只认「字符串字面量以 SKIP 开头」的发射点：审计/门禁文案里提到 SKIP 不算（否则本脚本自命中）。
  const skipLines = lines.filter((l) => /console\.(?:log|error)\(\s*[`'"]\s*(?:FAIL\s+)?SKIP/.test(l))
  if (skipLines.length === 0) { skipAudit.push({ file, sites: 0, counted: true }); continue }
  const hasSummary = /SKIP=/.test(text)
  const uncounted = skipLines.filter((l) => !/#/.test(l) && !/SKIP=/.test(l))
  const ok = hasSummary && uncounted.length === 0
  skipAudit.push({ file, sites: skipLines.length, summary: hasSummary, uncounted: uncounted.length, counted: ok })
  check('SKIP 计数: ' + file + '（' + skipLines.length + ' 处）', ok,
    '汇总 SKIP= ' + (hasSummary ? '在场' : '缺席') + '；未计数行 ' + uncounted.length
      + (uncounted.length ? '：' + uncounted[0].trim().slice(0, 90) : ''))
}

// ── 3. 发布链 SKIP=0 ───────────────────────────────────────────────────────
for (const rel of ['scripts/build-release.ps1', 'dsh-mobile-apk/scripts/build-release.ps1']) {
  const text = readIf(rel)
  if (text === null) { check('发布链在场: ' + rel, false); continue }
  check(rel + ' 以 --run --require 调聚合入口（发布链 SKIP=0）',
    /check-release-gates\.mjs/.test(text) && /--run\b[\s\S]{0,80}--require/.test(text),
    '缺 --require：发布链会以 SKIP 结案')
}
const strictPropagated = /argvFor\.push\('--require'\)/.test(aggText) && aggText.includes("'check-perf-instrumentation.mjs'")
check('聚合入口对支持 --require 的门禁传严格档', strictPropagated)

if (argv.includes('--list')) {
  console.log('== 门禁清单（声明 ' + declared.length + ' 项）')
  for (const g of declared) console.log('   ' + g.padEnd(34) + (invokedIn(CHAINS[0]).includes(g) ? 'local' : '     ') + ' ' + (invokedIn(CHAINS[1]).includes(g) ? 'cloud' : ''))
  console.log('== SKIP 审计')
  for (const a of skipAudit) console.log('   ' + a.file.padEnd(34) + 'sites=' + a.sites + (a.counted ? '' : ' UNCCOUNTED'))
  process.exit(failures.length === 0 ? 0 : 1)
}

if (failures.length > 0) {
  console.error('CHECK-GATE-SKIPS FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
console.log('CHECK-GATE-SKIPS PASSED（声明 ' + declared.length + ' 项门禁；SKIP 审计 ' + gateFiles.length + ' 个脚本；发布链 --require 在场）')
