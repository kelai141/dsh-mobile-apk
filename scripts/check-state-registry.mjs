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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)

// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径。
const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  return cands.find((c) => existsSync(join(ROOT, c))) ?? null
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
