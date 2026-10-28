#!/usr/bin/env node
// check-state-registry.mjs — 状态登记制门禁（0.13.8-b ST-25 / 计划 §4.5）。
//
// 三层断言：
//   1. 两份 PR 模板（协调仓 + apk 仓）都在场，且四栏齐全（持有者/写路径/外部真源/同步路径）
//      并带 state-registry 标记——缺栏即评审拒（模板是登记制的入口，不得先烂）；
//   2. scripts/state-registry.json 的每条状态四栏非空、id 唯一、evidence **机器可核对**：
//      kind=file → 路径在场；kind=grep → 文件里命中 pattern；kind=gate → 门禁脚本在场；
//   3. 写路径在场：条目的 writePath 必须以存在的文件路径开头（符号部分不校验），
//      防「登记表指向已删除的文件」这种最典型的 stale。
//
// 用法：node scripts/check-state-registry.mjs [--list]
// 退出码：0 = 通过；1 = 失败；2 = 登记表/模板不可解析。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
// 与同类门禁（snapshot-file-modes / snapshot-secrets / snapshot-fingerprint / bounded-io）对齐：
// 支持 --root 指向合成树，否则这条门禁的判据无法用合成夹具反证（只能对着真登记表说 PASS）。
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : dirname(HERE)

// ── --self-test：判别力自证（2026-10-29 补；此前这条门禁零判别力面）──────────────────
//
// 它守的是「跨层状态登记制」：PR 模板四栏齐全 + 登记表四栏非空 + id 唯一 + evidence 机器可核对
// + 写路径必须指向在场文件。此前只能对着真登记表说 PASS，看不出它在本该红的时候会不会红。
// 自证造合成树（--root），把七个判据分支全打一遍。
if (process.argv.includes('--self-test')) {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const selfPath = fileURLToPath(import.meta.url)
  const TEMPLATE_OK = [
    '# 变更说明',
    '- 持有者：谁持有该状态',
    '- 写路径：app/src/main/java/X.kt',
    '- 外部真源：外部真源说明',
    '- 同步路径：同步方式（附可执行证据）',
    'state-registry',
    '',
  ].join('\n')
  const GOOD_STATE = {
    id: 'demo-state',
    holder: 'h',
    writePath: 'app/src/main/java/X.kt:symbol',
    sourceOfTruth: 's',
    syncPath: 'y',
    evidence: { kind: 'file', file: 'app/src/main/java/X.kt' },
  }
  const runGate = (treeArgs) => {
    try {
      const out = execFileSync(process.execPath, [selfPath, ...treeArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }
  const buildTree = (tag, opts) => {
    const dir = mkdtempSync(join(tmpdir(), 'statereg-' + tag + '-'))
    mkdirSync(join(dir, '.github'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'app', 'src', 'main', 'java'), { recursive: true })
    writeFileSync(join(dir, 'app', 'src', 'main', 'java', 'X.kt'), 'class X\n')
    writeFileSync(join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), opts.template ?? TEMPLATE_OK)
    const states = opts.states ?? [GOOD_STATE]
    writeFileSync(join(dir, 'scripts', 'state-registry.json'),
      JSON.stringify({ $comment: 'synthetic', fields: ['holder', 'writePath', 'sourceOfTruth', 'syncPath'], states }, null, 1))
    return dir
  }

  const ok = buildTree('ok', {})
  // 缺栏模板直接构造（不靠 replace：一旦字面量里的全角冒号/换行有偏差，replace 会静默不生效，
  // 自证就变成假绿——这本身是「自证必须自己先过硬」的例子）。
  const TEMPLATE_NO_SOT = [
    '# 变更说明',
    '- 持有者：谁持有该状态',
    '- 写路径：app/src/main/java/X.kt',
    '- 同步路径：同步方式（附可执行证据）',
    'state-registry',
    '',
  ].join('\n')
  const noField = buildTree('nofield', { template: TEMPLATE_NO_SOT })
  const emptyStates = buildTree('empty', { states: [] })
  const dupIds = buildTree('dup', { states: [GOOD_STATE, { ...GOOD_STATE }] })
  const badWritePath = buildTree('badpath', { states: [{ ...GOOD_STATE, writePath: 'app/src/main/java/Missing.kt:sym' }] })
  const badEvidence = buildTree('badev', { states: [{ ...GOOD_STATE, evidence: { kind: 'file', file: 'app/src/main/java/Nope.kt' } }] })
  const badKind = buildTree('badkind', { states: [{ ...GOOD_STATE, evidence: { kind: 'telepathy', file: 'x' } }] })

  const checks = [
    ['合规合成树 → PASSED 且 exit 0', runGate(['--root', ok]), (r) => r.code === 0 && r.out.includes('CHECK-STATE-REGISTRY PASSED')],
    ['PR 模板缺一栏（外部真源）→ FAILED', runGate(['--root', noField]), (r) => r.code === 1 && r.out.includes('PR 模板四栏齐全')],
    ['登记表 states 为空 → FAILED（跨层状态矩阵起点不得为空）', runGate(['--root', emptyStates]), (r) => r.code === 1 && r.out.includes('登记表非空')],
    ['id 重复 → FAILED', runGate(['--root', dupIds]), (r) => r.code === 1 && r.out.includes('状态 id 唯一且非空')],
    ['writePath 指向已删除文件 → FAILED（最典型的 stale）', runGate(['--root', badWritePath]), (r) => r.code === 1 && r.out.includes('写路径在场')],
    ['evidence(file) 路径不在场 → FAILED', runGate(['--root', badEvidence]), (r) => r.code === 1 && r.out.includes('evidence(file) 在场')],
    ['evidence kind 非法 → FAILED（只认 file|grep|gate）', runGate(['--root', badKind]), (r) => r.code === 1 && r.out.includes('evidence kind 合法')],
  ]
  let bad = 0
  for (const [label, result, verify] of checks) {
    const pass = verify(result)
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (pass ? '' : '  -> exit=' + result.code + ' out=' + result.out.trim().slice(0, 200)))
    if (!pass) bad += 1
  }
  for (const dir of [ok, noField, emptyStates, dupIds, badWritePath, badEvidence, badKind]) rmSync(dir, { recursive: true, force: true })
  console.log(bad === 0
    ? 'STATE_REGISTRY_SELF_TEST_PASSED（' + checks.length + ' 项）'
    : 'STATE_REGISTRY_SELF_TEST_FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径。
const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  // 必须返回**绝对路径**：调用方用 readFileSync(p) 读模板与 evidence 目标，而相对路径会被
  // 按 **cwd** 解析。原来 ROOT 恒等于仓库根、cwd 也恰好在仓库根，所以这个错被掩盖了 ——
  // 一旦 cwd 不是仓库根（从别处调用 / 用 --root 指向合成树），就会去读错位置的文件甚至 ENOENT。
  // 2026-10-29 加 --self-test 时由合成树直接暴露：模板明明是缺栏的三栏版本，判据却读到了
  // 仓库里那份四栏齐全的模板并判 PASS。
  return cands.map((c) => join(ROOT, c)).find((abs) => existsSync(abs)) ?? null
}
const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

// ── 1. PR 模板四栏 ─────────────────────────────────────────────────────────
const REQUIRED_FIELDS = ['持有者', '写路径', '外部真源', '同步路径']
const TEMPLATES = ['.github/PULL_REQUEST_TEMPLATE.md', 'dsh-mobile-apk/.github/PULL_REQUEST_TEMPLATE.md']
for (const rel of TEMPLATES) {
  // 布局无关：apk 自包含根下 dsh-mobile-apk/... 落到本仓同名相对路径（两份模板各自必须存在）。
  const p = resolveRepoPath(rel)
  if (p === null) { check('PR 模板在场: ' + rel, false); continue }
  const text = readFileSync(p, 'utf8')
  const missing = REQUIRED_FIELDS.filter((f) => !text.includes(f))
  check('PR 模板四栏齐全: ' + rel, missing.length === 0, '缺: ' + missing.join(', '))
  check('PR 模板带 state-registry 标记: ' + rel, text.includes('state-registry'))
  check('PR 模板要求同步路径附可执行证据: ' + rel, /可执行证据/.test(text))
}

// ── 2/3. 登记表 ────────────────────────────────────────────────────────────
const regPath = join(ROOT, 'scripts', 'state-registry.json')
if (!existsSync(regPath)) {
  console.error('CHECK-STATE-REGISTRY FAILED：登记表缺席 ' + regPath)
  process.exit(2)
}
const registry = JSON.parse(readFileSync(regPath, 'utf8'))
const states = registry.states ?? []
check('登记表非空（跨层状态矩阵起点）', states.length > 0, 'states=' + states.length)
const ids = states.map((s) => s.id)
check('状态 id 唯一且非空', ids.every((id) => typeof id === 'string' && id.trim() !== '') && new Set(ids).size === ids.length,
  '重复: ' + ids.filter((id, i) => ids.indexOf(id) !== i).join(', '))

for (const state of states) {
  const label = 'state ' + state.id
  for (const field of registry.fields ?? ['holder', 'writePath', 'sourceOfTruth', 'syncPath']) {
    const value = state[field]
    check(label + ' 四栏非空: ' + field, typeof value === 'string' && value.trim() !== '')
  }
  // 写路径在场（路径部分必须存在）
  const pathPart = String(state.writePath ?? '').split(':')[0].replace(/\\/g, '/')
  const pathExists = pathPart.split(' + ').every((candidate) => resolveRepoPath(candidate.trim()) !== null)
  check(label + ' 写路径在场', pathExists, pathPart)
  // evidence 机器可核对
  const ev = state.evidence ?? {}
  if (ev.kind === 'file') {
    check(label + ' evidence(file) 在场', resolveRepoPath(ev.file) !== null, String(ev.file))
  } else if (ev.kind === 'grep') {
    const target = resolveRepoPath(ev.file)
    if (target === null) { check(label + ' evidence(grep) 文件在场', false, String(ev.file)) }
    else {
      const hit = new RegExp(ev.pattern).test(readFileSync(target, 'utf8'))
      check(label + ' evidence(grep) 命中: ' + ev.pattern, hit, String(ev.file))
    }
  } else if (ev.kind === 'gate') {
    check(label + ' evidence(gate) 门禁在场', existsSync(join(ROOT, ev.file)), String(ev.file))
  } else {
    check(label + ' evidence kind 合法（file|grep|gate）', false, JSON.stringify(ev.kind))
  }
}

if (argv.includes('--list')) {
  for (const s of states) console.log(s.id.padEnd(26) + ' | ' + s.holder + ' | ' + s.sourceOfTruth)
  process.exit(failures.length === 0 ? 0 : 1)
}

if (failures.length > 0) {
  console.error('CHECK-STATE-REGISTRY FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
console.log('CHECK-STATE-REGISTRY PASSED（' + states.length + ' 条状态登记，四栏 + evidence 全部可核对）')
