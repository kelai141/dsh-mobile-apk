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
const DECLARED_RE = /\{ script: '([a-z0-9-]+\.mjs)'/g
/** 从聚合入口源码提取声明集合（纯函数：自测可直接喂合成文本）。 */
const parseDeclared = (text) => [...text.matchAll(DECLARED_RE)].map((m) => m[1])

/**
 * 宽松「出现过这个名字」扫描。
 *
 * **只可用于正向断言**（声明集合 ⊆ 本链提到的），**绝不可用来判「是否真的执行」**：
 * 它会把 GATE_SCRIPTS 声明数组里的字符串字面量也算成"调用过"，于是反向断言自我满足。
 * 这条纪律由 `--self-test` 守住（见文件末）。
 */
const parseInvoked = (text) =>
  // 兼容两种写法：'check-x.mjs'（node 侧数组/helper）与 "scripts\check-x.mjs"（PowerShell 调用）。
  [...new Set([...text.matchAll(/["'\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/g)].map((m) => m[1]))]

/**
 * 执行点解析（纯函数）：只认「真的会 spawn 这个门禁」的写法。
 *   - node 链：`gate('check-x.mjs')`（数组字面量没有 gate(...) 包裹，天然排除）
 *   - pwsh 链：行首（可带 `$var =`）`node ... scripts\check-x.mjs`，注释行不命中
 */
const parseExecutionSites = (text, isNode) => {
  const out = new Set()
  if (isNode) {
    for (const m of text.matchAll(/gate\(\s*['"]([a-z0-9-]+\.mjs|elf-check\.mjs)['"]\s*\)/g)) out.add(m[1])
  } else {
    for (const m of text.matchAll(/^\s*(?:\$\w+\s*=\s*)?node\s+[^\n]*?scripts[\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/gm)) out.add(m[1])
  }
  return out
}

/** SKIP 发射点判据（纯函数）：只认「字符串字面量以 SKIP 开头」的 console 调用。 */
const emitsSkip = (line) => /console\.(?:log|error)\(\s*[`'"]\s*(?:FAIL\s+)?SKIP/.test(line)

const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
const readIf = (rel) => { const p = resolveRepoPath(rel); return p === null ? null : readFileSync(p, 'utf8') }

const invokedIn = (rel) => {
  const text = readIf(rel)
  return text === null ? null : parseInvoked(text)
}
/**
 * 执行点解析（0.14.2 实修）：只认「真的会 spawn 这个门禁」的写法，不认声明数组里的字符串字面量。
 *
 * 为什么必须与 invokedIn() 分开：上面那个宽松正则会把 GATE_SCRIPTS 声明数组里的 'check-x.mjs'
 * 也算成「调用过」，于是下面「调用声明集合的每一项」这条断言对 build-apk.mjs **自我满足**——
 * 声明了却没接线照样判绿。本轮实测：build-apk.mjs 声明 37 项、真实执行 36 项，差的正是新加的
 * check-dead-tokens.mjs（只登记未接线），而旧断言 PASSED。修法 = 反向断言必须建立在「执行点」之上，
 * 而不是「文件里出现过这个名字」。
 *
 * 形态只取本仓两条链的实际写法，不做泛化猜测：
 *   - build-apk.mjs（node）：gate('check-x.mjs') 调用点（数组字面量没有 gate(...) 包裹，天然排除）
 *   - build-apk-013.ps1（pwsh）：行首（可带 $var =）node ... scripts\check-x.mjs，跳过注释行
 * 反向断言**只针对 GATE_SCRIPTS 声明清单项**；两条链上另有若干在条件分支内调用的门禁
 * （elf-check / runtime-assets / file-modes / 逐 ABI 段等），不属声明清单，一律不纳入，
 * 避免把合法的分支调用误判成未接线。
 */
const executionSites = (rel, textOverride) => {
  // textOverride 供 --self-test 用：让自测能测到**包装层本身**。
  // 只测 parseExecutionSites 是不够的 —— 把本函数退回宽松实现（缺陷复发）自测会仍全绿（实测踩过）。
  const text = textOverride === undefined ? readIf(rel) : textOverride
  if (text === null) return null
  return parseExecutionSites(text, rel.endsWith('.mjs'))
}
// ── --self-test：无仓库依赖的判别力自检（含故意失败样本）──────────────────────
// 为什么必须有：本门禁曾经有过一次「声明即视为调用」的自满足缺陷（build-apk.mjs 声明 37 项、
// 真实执行 36 项，差的正是只登记未接线的 check-dead-tokens，而旧断言 PASSED）。那次修法是把
// 宽松扫描换成执行点扫描，但**没有任何用例守住这个区别**——把 executionSites 退回 invokedIn 实现，
// 全仓门禁依旧全绿。下面 ② 就是那条区别的独家守门人。
const NODE_CHAIN = 'scripts/build-apk.mjs'
const PWSH_CHAIN = 'scripts/build-apk-013.ps1'
const selfTest = (silent) => {
  const fails = []
  const t = (label, ok, detail) => {
    if (!ok) fails.push(label + (detail === undefined ? '' : ' -> ' + detail))
    else if (!silent) console.log('PASS  [self-test] ' + label)
  }
  // ① 声明提取：只认 `{ script: 'x.mjs' }` 单引号形态（聚合入口的唯一写法）。
  t('声明提取认 { script: \'x.mjs\' }',
    parseDeclared("const G = [{ script: 'check-a.mjs', label: 'A' }, { script: 'check-b.mjs' }]").join(',') === 'check-a.mjs,check-b.mjs')
  t('声明提取不吃双引号/裸字符串（写错形态会立刻暴露）',
    parseDeclared('{ script: "check-a.mjs" }').length === 0)

  // ② 独家守护：声明数组字面量 —— 宽松扫描必须命中，执行点扫描必须不命中。
  const declOnly = "const GATE_SCRIPTS = [\n  'check-a.mjs',\n  'check-b.mjs',\n]\n"
  t('宽松扫描认得出声明字面量（它本来就该命中）', parseInvoked(declOnly).length === 2)
  t('执行点扫描不把声明字面量当执行（防自满足）',
    executionSites(NODE_CHAIN, declOnly).size === 0, '命中=' + [...executionSites(NODE_CHAIN, declOnly)].join(','))

  // ③④ node 链：只有 gate(...) 包裹才算执行点。
  // 断言刻意见用 [...].includes 而不是 .has：包装层若被退回返回数组的实现，
  // .has 会抛 TypeError（红是红了，但报错不可读），[...].includes 会优雅判红。
  t('node 链 gate(\'x\') 命中', [...executionSites(NODE_CHAIN, "gate('check-a.mjs')")].includes('check-a.mjs'))
  t('node 链 gate("x") 双引号同样命中', [...executionSites(NODE_CHAIN, 'gate("check-b.mjs")')].includes('check-b.mjs'))
  t('node 链 数组下标写法不算执行点', executionSites(NODE_CHAIN, 'GATE_SCRIPTS[0]').size === 0)
  t('node 链 gate(x) 无引号变量不算执行点', executionSites(NODE_CHAIN, 'gate(name)').size === 0)

  // ⑤⑥⑦ pwsh 链：行首 node ... scripts\check-x.mjs 才算；注释与字符串里的不算。
  t('pwsh 链 node ... scripts\\check-x.mjs 命中',
    [...executionSites(PWSH_CHAIN, 'node "$PSScriptRoot\\scripts\\check-a.mjs"')].includes('check-a.mjs'))
  t('pwsh 链 带 $var = 前置同样命中',
    [...executionSites(PWSH_CHAIN, '$r = node scripts/check-b.mjs --x')].includes('check-b.mjs'))
  t('pwsh 链 注释行不算执行点', executionSites(PWSH_CHAIN, '# node scripts\\check-a.mjs').size === 0)
  t('pwsh 链 字符串里提到不算执行点',
    executionSites(PWSH_CHAIN, 'Write-Host "见 scripts\\check-a.mjs"').size === 0)

  // ⑧⑨⑩ SKIP 发射点判据：计数形态与未计数形态都要命中（否则后者判不出），纯文案提及不命中。
  // 样本必须**拆开拼接**：写成字面量会让本文件自己出现「console 点 log 左括号 引号 紧接 SKIP」
  // 的连续串，从而被本门禁自己的 SKIP 审计当成发射点命中（自指陷阱；实测报过 3 处，注释里提到同样算）。
  const S = (...parts) => parts.join('')
  t('SKIP 计数形态命中', emitsSkip(S('console.', 'log(', "'SKIP(#1)  x'")))
  t('SKIP 未计数形态也命中（否则它判不出未计数）', emitsSkip(S('console.', 'log(', "'SKIP foo'")))
  t('SKIP 带 FAIL 前缀命中', emitsSkip(S('console.', 'error(', "'FAIL SKIP bar'")))
  t('文案里提到 SKIP 但非发射点不命中', !emitsSkip('// 这里会打印 SKIP 行'))
  t('console.warn 不在面内（口径与实现一致：只认 log/error）', !emitsSkip("console.warn('SKIP x')"))

  return fails
}

if (argv.includes('--self-test')) {
  const stFails = selfTest(false)
  if (stFails.length > 0) {
    console.error('CHECK-GATE-SKIPS SELF-TEST FAILED（' + stFails.length + ' 项）：' + stFails.join('；'))
    process.exit(1)
  }
  console.log('CHECK-GATE-SKIPS SELF-TEST PASSED（17 项判别力断言）')
  process.exit(0)
}

// 判据自证：主体每次运行都先自证判别力（静默，仅失败时出声）。
// 变异 —— 例如把 executionSites 退回 invokedIn 的宽松实现 —— 会在这里当场被判红，
// 不依赖任何人记得传 --self-test。
{
  const stFails = selfTest(true)
  if (stFails.length > 0) {
    console.error('CHECK-GATE-SKIPS FAILED：判据自证不通过（' + stFails.length + ' 项）—— ' + stFails.join('；'))
    process.exit(1)
  }
}

// ── 1. 声明集合 vs 实际文件 vs 两条链 ───────────────────────────────────────
const aggText = readIf('scripts/check-release-gates.mjs')
if (aggText === null) { console.error('CHECK-GATE-SKIPS FAILED：缺 scripts/check-release-gates.mjs'); process.exit(2) }
const declared = parseDeclared(aggText)
check('声明集合非空', declared.length > 0, 'gates=' + declared.length)
const missingFiles = declared.filter((g) => !existsSync(join(SCRIPTS, g)))
check('声明集合里的门禁全部在场', missingFiles.length === 0, '缺: ' + missingFiles.join(', '))

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
  // ── 反向断言（0.14.2 实修）：声明集合每一项都必须在**执行点**被真实调用 ──────────────────
  // 旧断言只做「被调用的 ⊆ 声明的」，抓不到「声明了却没接线」；而 invokedIn() 的宽松正则又会把声明
  // 数组本身当成调用证据，使该断言对 build-apk.mjs 恒真。此处改用 executionSites()，两个方向都堵。
  const exec = executionSites(rel)
  if (exec === null) { check('执行点可解析: ' + rel, false); continue }
  const declaredButNotExecuted = declared.filter((g) => !exec.has(g))
  check(rel + ' 声明集合每一项都有真实执行点（反向断言，' + declared.length + ' 项）',
    declaredButNotExecuted.length === 0,
    '只登记未接线: ' + declaredButNotExecuted.join(', '))
}

// ── 2. SKIP 纪律（逐脚本静态审计）───────────────────────────────────────────
// 递归覆盖 scripts/ 全树（原先只列顶层）：来源审计链的 check-*.mjs 全部在 scripts/source-build/，
// 旧实现下它们不在审计面内——将来新增一道「拿不到产物就 SKIP」的来源链门禁，其未计数的 SKIP
// 不会被抓，发布链 SKIP=0 的口径对来源面也就失效。返回相对 SCRIPTS 的路径（便于报出子目录）。
const collectGateFiles = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
  const rel = prefix ? prefix + '/' + entry.name : entry.name
  if (entry.isDirectory()) return collectGateFiles(join(dir, entry.name), rel)
  return entry.name.startsWith('check-') && entry.name.endsWith('.mjs') ? [rel] : []
})
const gateFiles = collectGateFiles(SCRIPTS).sort()
const skipAudit = []
for (const file of gateFiles) {
  const text = readFileSync(join(SCRIPTS, file), 'utf8')
  const lines = text.split('\n')
  // 只认「字符串字面量以 SKIP 开头」的发射点：审计/门禁文案里提到 SKIP 不算（否则本脚本自命中）。
  const skipLines = lines.filter(emitsSkip)
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

