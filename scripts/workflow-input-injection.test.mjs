#!/usr/bin/env node
// workflow-input-injection.test.mjs — workflow 输入不得内插进 run 脚本（issue #1614）。
//
// 【为什么必须存在（实锤形态）】
// build-apk.yml 的构建步骤旧写法是：
//     node scripts/build-apk.mjs --abi "${{ matrix.abi }}" --suffix "${{ github.event.inputs.suffix }}"
// 双引号**不阻止命令替换**：有 dispatch 权限的人把 suffix 填成 `$(curl -s …|sh)`，runner 上即以该
// job 身份执行（该 job 只有 contents: read，但 runner 上有 GITHUB_TOKEN 与完整工作区，含
// keystore/debug.keystore）。反过来 `$VAR` 形态的 suffix 又会被 shell 先展开 —— 输入既不是数据，
// 也不是原文。同文件其余步骤都走 env:（或单引号），只有这一处直插。
//
// 【判据（行为判据，不是 code.contains）】
//   ① 从**真实 workflow** 抽出该步骤的 env: 与 run: 两段（按缩进解析，不猜）；
//   ② run 脚本里不得残留非 matrix 的 `${{ … }}` 表达式（GitHub 会在执行前把它展开成原文）；
//   ③ 用**敌意 suffix** 真跑同一段脚本（node 换成记录实参的桩）：payload 文件不得出现，且脚本
//      收到的 --suffix 实参必须与输入逐字节相同（旧写法两条都失败：payload 被执行、$VAR 被吃掉）；
//   ④ 反证：把同一段脚本改回内插写法后，同一敌意输入**必须**被执行 —— 证明判据在判别
//      「数据 vs 代码」，而不是碰巧绿。
//
// 需要 bash（Linux 原生 / Windows 经 WSL，与构建链 lib/shell.mjs 同一路径）。拿不到时显式 skip。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'build-apk.yml')
const MARKER = 'node scripts/build-apk.mjs --abi'

/** 抽出「调用 build-apk.mjs」那一步的 env: 与 run: 两段（按 YAML 缩进解析，不做文本切片）。 */
function extractStep(text) {
  const lines = text.split(/\r?\n/)
  const callIndex = lines.findIndex((l) => l.includes(MARKER))
  assert.ok(callIndex >= 0, 'build-apk.yml 里找不到 build-apk.mjs 调用行')
  const isStepStart = (l) => /^ {0,8}- /.test(l)
  let start = callIndex
  while (start > 0 && !isStepStart(lines[start])) start -= 1
  assert.ok(isStepStart(lines[start]), '找不到该调用所在步骤的起点（"- name:"）')
  let end = callIndex + 1
  while (end < lines.length && !isStepStart(lines[end])) end += 1
  const block = lines.slice(start, end)
  const indentOf = (l) => l.length - l.replace(/^\s*/, '').length
  const env = {}
  let runBody = null
  for (let i = 0; i < block.length; i += 1) {
    const line = block[i]
    if (line.trim() === 'env:') {
      const base = indentOf(line)
      for (let j = i + 1; j < block.length; j += 1) {
        if (block[j].trim() === '') continue
        if (indentOf(block[j]) <= base) break
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(block[j])
        if (m) env[m[1]] = m[2].trim()
      }
    }
    if (/^run:\s*\|\s*$/.test(line.trim())) {
      const base = indentOf(line)
      const body = []
      for (let j = i + 1; j < block.length; j += 1) {
        if (block[j].trim() !== '' && indentOf(block[j]) <= base) break
        body.push(block[j].replace(/^\s{0,12}/, ''))
      }
      runBody = body.join('\n')
    }
  }
  assert.ok(runBody !== null, '该步骤没有 run: | 段')
  return { env, run: runBody }
}

const step = extractStep(readFileSync(WORKFLOW, 'utf8'))

/** Windows 盘符路径 -> WSL 挂载路径（与 scripts/lib/shell.mjs 的 wslPath 同形）。 */
const shPath = (p) => {
  if (process.platform !== 'win32') return String(p)
  const m = /^([A-Za-z]):(.*)$/.exec(String(p))
  return m ? '/mnt/' + m[1].toLowerCase() + String(m[2]).replace(/\\/g, '/') : String(p).replace(/\\/g, '/')
}
const bash = (script, env = {}) => {
  if (process.platform === 'win32') {
    const exports = Object.entries(env).map(([k, v]) => 'export ' + k + "='" + String(v).replace(/'/g, "'\\''") + "'").join('; ')
    return spawnSync('wsl.exe', ['-e', 'bash', '-lc', (exports ? exports + '; ' : '') + script], { encoding: 'utf8', timeout: 180000 })
  }
  return spawnSync('/bin/bash', ['-lc', script], { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } })
}
const bashUsable = bash('command -v bash >/dev/null && echo ok').status === 0
const skipReason = 'bash 不可用（既非 Linux 原生也无 WSL）——本判据需要真 shell 才能区分「数据」与「代码」'

/** 造一个「记录实参的 node 桩」+ 一份待跑脚本，返回 { run } 供测试调用。 */
function fixture(t, tag) {
  const work = mkdtempSync(join(tmpdir(), 'wf-inject-' + tag + '-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const bin = join(work, 'bin')
  mkdirSync(bin, { recursive: true })
  const argsOut = join(work, 'args.txt')
  const stub = join(bin, 'node')
  writeFileSync(stub, '#!/bin/sh\n: > ' + shPath(argsOut) + '\nfor a in "$@"; do printf "%s\\n" "$a" >> ' + shPath(argsOut) + '; done\n')
  bash('chmod +x ' + shPath(stub))
  return { work, bin, argsOut, pathPrefix: shPath(bin) }
}

test('workflow 步骤：run 脚本里不得残留非 matrix 的 ${{ … }} 表达式（输入不得内插进脚本）', () => {
  // 先把 workflow 自己算出来的 matrix.abi 摘掉，再看**剩余**表达式：同一行里既可能有 matrix 也可能有输入，
  // 按行过滤会漏判（旧实现的缺陷行正是两者同行）。
  const leftover = step.run.split(/\r?\n/)
    .map((l) => ({ line: l, rest: l.replace(/\$\{\{\s*matrix\.abi\s*\}\}/g, '') }))
    .filter((x) => /\$\{\{/.test(x.rest))
    .map((x) => x.line)
  assert.deepEqual(leftover, [],
    'run 脚本里出现了非 matrix 的 GitHub 表达式（执行前会被展开成原文，双引号不阻止命令替换）：' + leftover.join(' | '))
})

test('workflow 步骤：敌意 suffix 不得被执行，且必须逐字节到达脚本（issue #1614）', { skip: bashUsable ? false : skipReason }, (t) => {
  const { work, argsOut, pathPrefix } = fixture(t, 'hostile')
  const payload = join(work, 'PWNED')
  // 敌意输入：命令替换 + 变量展开两种形态各一条（旧实现前者执行、后者吃掉）。
  const hostile = '$(touch ' + shPath(payload) + ')-$HOME'
  const script = step.run.replace(/\$\{\{\s*matrix\.abi\s*\}\}/g, 'arm64')
  // env 值里的 ${{ github.event.inputs.X }} 在 GitHub 侧被替换成**输入原文**，这里同样代入敌意值。
  const env = {}
  for (const [k, v] of Object.entries(step.env)) {
    env[k] = v.replace(/\$\{\{\s*github\.event\.inputs\.[A-Za-z0-9_.]+\s*\}\}/g, hostile)
  }
  const r = bash('export PATH="' + pathPrefix + ':$PATH"; cd ' + shPath(work) + '; ' + script, env)
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  assert.equal(existsSync(payload), false, '敌意 suffix 的 payload 不得被执行（命令替换必须无效）：' + out.slice(-400))
  const args = existsSync(argsOut) ? readFileSync(argsOut, 'utf8').split(/\r?\n/).filter(Boolean) : []
  const suffixArg = args[args.indexOf('--suffix') + 1]
  assert.equal(suffixArg, hostile,
    'suffix 必须逐字节到达脚本（不得被 shell 展开）：实得 ' + JSON.stringify(suffixArg) + ' out=' + out.slice(-400))
})

test('反证：改回内插写法后，同一敌意输入必须被执行（判据在判别数据与代码）', { skip: bashUsable ? false : skipReason }, (t) => {
  const { work, pathPrefix } = fixture(t, 'legacy')
  const payload = join(work, 'PWNED')
  const hostile = '$(touch ' + shPath(payload) + ')'
  const legacy = step.run
    .replace(/\$\{\{\s*matrix\.abi\s*\}\}/g, 'arm64')
    .replace(/"\$SUFFIX"/, '"' + hostile + '"')
  assert.notEqual(legacy, step.run, '反证前提不成立：脚本里找不到 "$SUFFIX" 形态')
  bash('export PATH="' + pathPrefix + ':$PATH"; cd ' + shPath(work) + '; ' + legacy)
  assert.equal(existsSync(payload), true, '内插写法下敌意输入必须被执行（否则反证没有判别力）')
})
