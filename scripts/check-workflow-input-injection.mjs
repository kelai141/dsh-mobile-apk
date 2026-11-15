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

// ── 结构判据（issue #1645）────────────────────────────────────────────────
//
// 缺陷形态：修 #1614 时给同一个 step 写了两个同层 `env:` 键。后果不是「后者覆盖前者」，
// 而是**整份 workflow 解析失败**——GitHub 侧表现为 `This run likely failed because of a
// workflow file issue`，看起来像测试失败，实际是文件根本起不来。而本脚本此前只扫 `run:` 块内
// 有没有输入内插，**完全不看 YAML 结构**，于是「改安全了但改坏了文件」一路绿灯。
//
// 判据设计的三条约束：
//   1. **零依赖**：仓里没有 yaml/js-yaml（本脚本要在只装了 node 的门禁环境跑）。
//   2. **不误报 heredoc**：`run: |` 里的 JS/Python 对象（如 `reason: '...'`）不是 YAML 键。
//      误报会让门禁失去可信度，比漏报更糟——维护者会学会忽略它。
//   3. **精确到行号**：报 `release.yml:389 重复键 env`（并指出上一次在第几行），
//      不是笼统的「解析失败」。issue 明确要求这一条。

/**
 * 找出同一 YAML mapping 作用域内重复的键。
 *
 * 作用域模型：一个 mapping 由「缩进 + 它的直接父节点」唯一确定。实现上用一个显式栈：
 *   - 缩进回退 ⇒ 弹栈（离开那些 mapping）；
 *   - 缩进前进 ⇒ 压栈（进入子 mapping）；
 *   - 同缩进且不是序列项 ⇒ 仍在当前 mapping，键名重复即缺陷。
 *
 * @param text workflow 全文
 * @returns 重复键列表（含行号与上一次出现的位置）
 */
export function findDuplicateMappingKeys(text) {
  const lines = text.split('\n')
  const dups = []
  /** 栈项：{ indent, keys: Map<key, lineNo>, seqItem: boolean } */
  const stack = []
  /** heredoc / block scalar 的结束缩进；非 null 时整段跳过（那是内容，不是 YAML 结构）。 */
  let blockScalarIndent = null

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const lineNo = i + 1
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length

    // block scalar（run: | / run: > 等）内部：只按缩进判断是否结束，内容一律不当 YAML 键。
    // 这是「不误报 heredoc」的实现点，也是本判据能上线的关键。
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue
      blockScalarIndent = null
    }

    let body = raw.slice(indent)
    let seqItem = false
    if (body.startsWith('- ') || body === '-') {
      seqItem = true
      body = body === '-' ? '' : body.slice(2).trimStart()
    }

    // 记录 block scalar 起点：`key: |` / `- run: |` / `key: >-` 等
    const scalar = /^(?:-\s+)?[A-Za-z0-9_.\-\/]+:\s*[|>][-+]?\s*$/.exec(raw.slice(indent))
    if (scalar !== null) { blockScalarIndent = indent; continue }

    const m = /^([A-Za-z0-9_.\-\/]+):(\s|$)/.exec(body)
    if (m === null) continue
    const key = m[1]

    // 序列项 `- key:` 开启一个**新的** mapping（同一层里可以有很多个 `- env:`）。
    // 这里把序列项的 mapping 用 indent 作为它的「伪缩进」，与兄弟序列项的 mapping 互不干扰。
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop()
    if (seqItem) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ indent, keys: new Map(), seqItem: true })
    } else if (stack.length === 0 || stack[stack.length - 1].indent < indent) {
      stack.push({ indent, keys: new Map(), seqItem: false })
    }

    const top = stack[stack.length - 1]
    if (top.keys.has(key)) {
      dups.push({ key, line: lineNo, firstLine: top.keys.get(key) })
    } else {
      top.keys.set(key, lineNo)
    }
  }
  return dups
}
function runVerify() {
  let files
  try { files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')) } catch {
    console.log('PASS  .github/workflows 不存在，跳过')
    console.log('CHECK-WORKFLOW-INPUT-INJECTION PASSED')
    return 0
  }
  const problems = []
  const structural = []
  for (const f of files) {
    const text = readFileSync(join(WF_DIR, f), 'utf8')
    for (const h of findInputInterpolations(text)) {
      problems.push(f + ':' + String(h.line) + ' 的 run 块内直接内插了 ' + h.expr)
    }
    // issue #1645：结构判据。重复的同层键会让**整份 workflow 解析失败**，而 GitHub 只回
    // 「workflow file issue」，看起来像测试失败——这正是它值得单独一条判据的原因。
    for (const d of findDuplicateMappingKeys(text)) {
      structural.push(
        f + ':' + String(d.line) + ' 重复键 \'' + d.key + '\'（上一次在第 ' + String(d.firstLine) + ' 行）',
      )
    }
  }
  let failed = false
  if (structural.length > 0) {
    console.error('FAIL  workflow 同层重复键（' + String(structural.length) + ' 处）')
    for (const s of structural) console.error('  - ' + s)
    console.error('  YAML 里同层同名键不是「后者覆盖前者」——整份 workflow 解析失败，')
    console.error('  GitHub 侧只显示 "workflow file issue"，看起来像测试失败。')
    console.error('  修法：合并成一个 env: 块，或拆成两个 key 不同的步骤。')
    failed = true
  }
  if (problems.length > 0) {
    console.error('FAIL  workflow 输入内插进 run（' + String(problems.length) + ' 处）')
    for (const p of problems) console.error('  - ' + p)
    console.error('  修法：把值放进该 step 的 env:，run 里只引用 "$VAR"。不要自己写转义函数。')
    failed = true
  }
  if (failed) {
    console.error('CHECK-WORKFLOW-INPUT-INJECTION FAILED')
    return 1
  }
  console.log('PASS  ' + String(files.length) + ' 份 workflow：run 块无用户输入内插，且无同层重复键')
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

  // issue #1645：结构判据的自检。每一条都必须给出**精确行号**，不是笼统的「解析失败」。
  const structCases = [
    {
      name: '负控④：同一 step 两个同层 env:（issue #1645 原样复现）→ 必须命中第 7 行',
      text: 'jobs:\n  a:\n    steps:\n      - name: x\n        env:\n          A: 1\n        env:\n          B: 2\n',
      wantKeys: ['env'],
      wantLines: [7],
    },
    {
      name: '负控⑤：同层重复 runs-on → 必须命中第 4 行',
      text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    runs-on: windows-latest\n',
      wantKeys: ['runs-on'],
      wantLines: [4],
    },
    {
      name: '正控④：两个 step 各有一个 env:（不同 mapping）→ 不得命中',
      text: 'jobs:\n  a:\n    steps:\n      - env:\n          A: 1\n        run: echo 1\n      - env:\n          B: 2\n        run: echo 2\n',
      wantKeys: [],
      wantLines: [],
    },
    {
      name: '正控⑤：run: | 的 heredoc 里同层重复的 JS 键 → 不得命中（误报会让门禁失去可信度）',
      text: 'jobs:\n  a:\n    steps:\n      - run: |\n          const o = {\n            reason: 1,\n            reason: 2,\n          }\n',
      wantKeys: [],
      wantLines: [],
    },
    {
      name: '正控⑥：顶层 env: 与 step 的 env: 不同层 → 不得命中',
      text: 'env:\n  GLOBAL: 1\njobs:\n  a:\n    steps:\n      - env:\n          A: 1\n        run: echo 1\n',
      wantKeys: [],
      wantLines: [],
    },
  ]
  for (const c of structCases) {
    const got = findDuplicateMappingKeys(c.text)
    const keys = got.map((d) => d.key)
    const lines = got.map((d) => d.line)
    const okKeys = JSON.stringify(keys) === JSON.stringify(c.wantKeys)
    const okLines = JSON.stringify(lines) === JSON.stringify(c.wantLines)
    const ok = okKeys && okLines
    console.log(
      (ok ? 'PASS  ' : 'FAIL  ') + c.name
      + '（期望键 ' + JSON.stringify(c.wantKeys) + '@' + JSON.stringify(c.wantLines)
      + '，实测 ' + JSON.stringify(keys) + '@' + JSON.stringify(lines) + '）',
    )
    if (!ok) failed += 1
  }
  if (failed > 0) { console.error('WORKFLOW-INPUT-INJECTION SELF-TEST FAILED（' + String(failed) + ' 项）'); return 1 }
  console.log('WORKFLOW-INPUT-INJECTION SELF-TEST PASSED（' + String(cases.length + structCases.length) + ' 项）')
  return 0
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) process.exit(runSelfTest())
else process.exit(runVerify())