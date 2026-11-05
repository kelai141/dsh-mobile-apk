#!/usr/bin/env node
// check-workflow-input-injection.mjs —— workflow 输入不得内插进 `run:`（issue #1614）。
//
// 缺陷形态：`run: |` 里直接写 `"${{ inputs.suffix }}"`。GitHub 在**求值 shell 之前**就把表达式替换成
// 原始文本，于是用户输入的 `$(id)`、反引号、`"` 全部逃出引号被 bash 执行；即使不是恶意输入，
// 普通值里的 `$` 也会被吃掉、让参数变成半截字符串。
//
// 正确形态：值走 `env:`，run 里只引用 `"$VAR"`——shell 展开时不会二次求值。
//
// 判据：扫描所有 workflow，凡是 `run:` 块内出现 `${{ ... inputs.* }}` / `${{ github.event.inputs.* }}`
// 一律判红。`env:` / `with:` / `name:` / `path:` 等非 shell 字段不受影响。
//
// 用法：node scripts/check-workflow-input-injection.mjs [--self-test]
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WF_DIR = join(ROOT, '.github', 'workflows')

/** 用户可控的输入表达式（只有这些算注入面；matrix.* 来自固定枚举，不算）。 */
const USER_INPUT = /\$\{\{\s*(?:github\.event\.)?inputs\.[A-Za-z0-9_]+\s*\}\}/g

/**
 * 从一份 workflow 文本里找出「run 块内的用户输入内插」。
 * @param {string} text workflow 全文
 * @returns {{line: number, expr: string}[]} 命中列表
 */
export function findInputInterpolations(text) {
  const lines = text.split('\n')
  const hits = []
  let inRun = false
  let runIndent = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const indent = line.length - line.trimStart().length
    if (inRun) {
      // run 块在缩进回退到 <= runIndent 时结束（空行不算结束）
      if (line.trim() !== '' && indent <= runIndent) { inRun = false } else {
        for (const m of line.matchAll(USER_INPUT)) hits.push({ line: i + 1, expr: m[0] })
        continue
      }
    }
    const runMatch = /^(\s*)(?:-\s+)?run:\s*(\||>)?\s*$/.exec(line)
    if (runMatch) { inRun = true; runIndent = runMatch[1].length; continue }
    // `run: <单行>` 形态也要查
    const inline = /^(\s*)(?:-\s+)?run:\s*(.+)$/.exec(line)
    if (inline && !/^[|>]/.test(inline[2])) {
      for (const m of inline[2].matchAll(USER_INPUT)) hits.push({ line: i + 1, expr: m[0] })
    }
  }
  return hits
}

function runVerify() {
  let files
  try { files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')) } catch {
    console.log('PASS  .github/workflows 不存在，跳过')
    console.log('CHECK-WORKFLOW-INPUT-INJECTION PASSED')
    return 0
  }
  const problems = []
  for (const f of files) {
    const hits = findInputInterpolations(readFileSync(join(WF_DIR, f), 'utf8'))
    for (const h of hits) problems.push(f + ':' + String(h.line) + ' 的 run 块内直接内插了 ' + h.expr)
  }
  if (problems.length > 0) {
    console.error('FAIL  workflow 输入内插进 run（' + String(problems.length) + ' 处）')
    for (const p of problems) console.error('  - ' + p)
    console.error('  修法：把值放进该 step 的 env:，run 里只引用 "$VAR"。不要自己写转义函数。')
    console.error('CHECK-WORKFLOW-INPUT-INJECTION FAILED')
    return 1
  }
  console.log('PASS  ' + String(files.length) + ' 份 workflow 的 run 块均无用户输入内插')
  console.log('CHECK-WORKFLOW-INPUT-INJECTION PASSED')
  return 0
}

function runSelfTest() {
  const cases = [
    { name: '负控①：run 块内内插 inputs.suffix → 必须命中', text: 'jobs:\n  a:\n    steps:\n      - run: |\n          node x --suffix "${{ inputs.suffix }}"\n', want: 1 },
    { name: '负控②：run 块内内插 github.event.inputs.version → 必须命中', text: 'jobs:\n  a:\n    steps:\n      - run: |\n          VER="${{ github.event.inputs.version }}"\n', want: 1 },
    { name: '负控③：单行 run 内插 → 必须命中', text: 'jobs:\n  a:\n    steps:\n      - run: echo "${{ inputs.notes }}"\n', want: 1 },
    { name: '正控①：值走 env、run 只引用 $VAR → 不得命中', text: 'jobs:\n  a:\n    steps:\n      - env:\n          SUFFIX: ${{ inputs.suffix }}\n        run: |\n          node x --suffix "$SUFFIX"\n', want: 0 },
    { name: '正控②：env 里的 inputs 不算命中', text: 'jobs:\n  a:\n    steps:\n      - env:\n          V: ${{ inputs.version }}\n        run: |\n          echo "$V"\n', want: 0 },
    { name: '正控③：matrix.* 不是用户输入 → 不得命中', text: 'jobs:\n  a:\n    steps:\n      - run: |\n          node x "${{ matrix.abi }}"\n', want: 0 },
  ]
  let failed = 0
  for (const c of cases) {
    const got = findInputInterpolations(c.text).length
    const ok = got === c.want
    console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name + '（期望 ' + String(c.want) + '，实测 ' + String(got) + '）')
    if (!ok) failed += 1
  }
  if (failed > 0) { console.error('WORKFLOW-INPUT-INJECTION SELF-TEST FAILED（' + String(failed) + ' 项）'); return 1 }
  console.log('WORKFLOW-INPUT-INJECTION SELF-TEST PASSED（' + String(cases.length) + ' 项）')
  return 0
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) process.exit(runSelfTest())
else process.exit(runVerify())