#!/usr/bin/env node
// check-state-registry.mjs — 状态登记制门禁（0.13.8-b ST-25 / 计划 `4.5）。
//
// 三层断言：
//   1. 两份 PR 模板（协调仓 + apk 仓）都在场，且四栏齐全（持有者/写路径/外部真源/同步路径）
//      并带 state-registry 标记——缺栏即评审拒（模板是登记制的入口，不得先烂）；
//   2. scripts/state-registry.json 的每条状态四栏非空、id 唯一、evidence **机器可核对**：
//      kind=file → 路径在场；kind=grep → 文件里命中 pattern；kind=gate → 门禁脚本在场；
//   3. 写路径在场：条目的 writePath 必须以存在的文件路径开头（符号部分不校验），
//      防「登记表指向已删除的文件」这种最典型的 stale。
//
// issue #1019（判据失效模式：vacuous pass——判据输入来自被检对象自己）：
//   三处判据在「输入为空」时恒真，等于把自己关掉：
//   - **四栏字段清单从被检登记表自己读**：`registry.fields ?? [...]`，只写 `"fields": []` 就让
//     `for (const field of ...)` 一次都不执行，门禁照打「四栏 + evidence 全部可核对」。
//   - **writePath ":" 命中仓库根**：`String(s.writePath).split(':')[0]` 切出空串，
//     `join(ROOT, '')` 是仓库根目录、存在，于是「写路径在场」判绿，而它没指向任何文件。
//   - **evidence(gate) 只判 existsSync**：指向一个目录（如 `scripts`）也过。
//   修法 = 判据的**字段清单/规模基线不来自被检文件**：`REQUIRED_FIELDS` 在门禁里写死；
//   writePath 的路径段必须非空且是**文件**；gate evidence 必须是可执行门禁脚本（`check-*.mjs` 等），
//   不能是目录。同时给登记表补**非空下限**（`states.length > 0` 已有，verdict 也要求 evidence 条数 > 0）。
//
// 用法：node scripts/check-state-registry.mjs [--list] [--root <树>] [--self-test]
// 退出码：0 = 通过；1 = 失败；2 = 登记表/模板不可解析。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
// 与同类门禁（snapshot-file-modes / snapshot-secrets / snapshot-fingerprint / bounded-io）对齐：
// 支持 --root 指向合成树，否则这条门禁的判据无法用合成夹具反证（只能对着真登记表说 PASS）。
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : dirname(HERE)

/**
 * 四栏（issue #1019）：**门禁自己**持有的必需字段清单，两种形态各一份、**不得**互相顶替。
 *
 * - `REQUIRED_FIELDS`：登记表 `state-registry.json` 的**键名**（英文）；
 * - `TEMPLATE_FIELDS`：PR 模板里的**中文栏名**，模板是给人填的，栏名必须与说明同语言。
 *
 * 旧实现里登记表的字段清单来自 `registry.fields ?? [...]` —— 被检登记表决定「要检查哪些字段」，
 * 写 `"fields": []` 即整条判据消失，而门禁仍然打印「四栏 + evidence 全部可核对」。
 * 判据的规模/字段基线绝不能从被检对象里读：那是 vacuous pass 的标准形态。
 */
export const REQUIRED_FIELDS = ['holder', 'writePath', 'sourceOfTruth', 'syncPath']
/** PR 模板的四栏名（中文）。与 `REQUIRED_FIELDS` 是同一件事的两种书写面，顺序一一对应。 */
export const TEMPLATE_FIELDS = ['持有者', '写路径', '外部真源', '同步路径']

/**
 * writePath 的路径段判定（纯函数，供 --self-test 直接钉住）。
 *
 * 逐段检查（多个写路径用 ` + ` 连接）：
 *   - 段必须**非空**：空串会被 `join(ROOT, '')` 解析成仓库根，而根目录永远存在，
 *     于是 `writePath: ":"` 这种没有指向任何文件的登记也能通过（issue #1019 第二处）；
 *   - 段必须是**文件**（不能是目录）：`writePath: "scripts"` 这类指向目录的登记同样是 stale，
 *     符号部分（`:` 之后）不参与校验。
 *
 * @param {string} writePath 登记表里的 writePath 原值。
 * @param {(rel: string) => string|null} resolveFile 相对路径 → 绝对文件路径（不在场返回 null）。
 * @returns {string|null} null = 合规；否则返回判红理由。
 */
export const writePathProblem = (writePath, resolveFile) => {
  const text = String(writePath ?? '')
  if (text.trim() === '') return 'writePath 为空'
  // 符号部分不校验：`A.kt:sym → B.kt:sym2` 里的 `:` 之后是符号描述。
  const pathPart = text.split(':')[0].replace(/\\/g, '/')
  if (pathPart.trim() === '') {
    // `":"` / `" : sym"` 这类形态：切出空串，而空串被 `join(ROOT, '')` 解析成仓库根（永远存在）。
    return 'writePath 含空路径段（writePath=' + JSON.stringify(text) + '）——空路径会命中仓库根，'
      + '「写路径在场」对它恒真'
  }
  const segments = pathPart.split(' + ').map((candidate) => candidate.trim())
  for (const segment of segments) {
    if (segment === '') {
      // 空段是真形态：`:` 或 `a.kt: + b.kt` 都会切出空串并被解析成仓库根。
      return 'writePath 含空路径段（writePath=' + JSON.stringify(text) + '）——空路径会命中仓库根，'
        + '「写路径在场」对它恒真'
    }
    const abs = resolveFile(segment)
    if (abs === null) return '写路径不在场：' + segment
    try {
      if (statSync(abs).isDirectory()) return '写路径是目录而不是文件：' + segment
    } catch {
      return '写路径不可读：' + segment
    }
  }
  return null
}

/**
 * 门禁 evidence 的目标判定（纯函数）。issue #1019 第三处：旧实现只做 `existsSync`，
 * `scripts` 这种目录也过——而「门禁脚本在场」这句话对目录毫无意义。
 *
 * @param {string} rel evidence.file
 * @param {string} root 仓库根
 * @returns {string|null} null = 合规；否则理由。
 */
export const gateEvidenceProblem = (rel, root) => {
  const text = String(rel ?? '').trim()
  // 有非空下限：空串会被 `join(root, '')` 解析成根目录。
  if (text === '') return 'evidence(gate) 指向空路径'
  const abs = join(root, text)
  if (!existsSync(abs)) return 'evidence(gate) 门禁不在场：' + text
  let isFile = false
  try { isFile = statSync(abs).isFile() } catch { isFile = false }
  if (!isFile) return 'evidence(gate) 指向的不是文件（目录不算门禁脚本）：' + text
  if (!/\.(mjs|cjs|js|ps1|py|sh)$/.test(text)) {
    return 'evidence(gate) 不是可执行门禁脚本（后缀须为 mjs/cjs/js/ps1/py/sh）：' + text
  }
  return null
}

/**
 * 字段清单判定（纯函数）。issue #1019 第一处的直接守门人。
 *
 * 为什么单独抽出来：这条判据的失效形态是「循环体一次都不执行」，**输出上完全看不出来**
 * （既没有 PASS 也没有 FAIL 行）。只能靠「字段清单 ⊆ 门禁自己持有的必需字段」与
 * 「必需字段一条也不能少」两条结构性断言把它钉住。
 *
 * @param {string[]} fields 登记表声明的字段清单。
 * @returns {string|null} null = 合规；否则理由。
 */
export const fieldsProblem = (fields) => {
  if (!Array.isArray(fields)) return '登记表缺 fields 数组'
  if (fields.length === 0) return '登记表 fields 为空 —— 四栏判据会被静默关掉（字段清单不得由被检对象自定义为空）'
  const missing = REQUIRED_FIELDS.filter((f) => !fields.includes(f))
  if (missing.length > 0) return '登记表 fields 漏必需栏：' + missing.join(', ')
  return null
}

// ── --self-test：判别力自证（2026-10-29 补；此前这条门禁零判别力面）──────────────────
//
// 它守的是「跨层状态登记制」：PR 模板四栏齐全 + 登记表四栏非空 + id 唯一 + evidence 机器可核对
// + 写路径必须指向在场文件。此前只能对着真登记表说 PASS，看不出它在本该红的时候会不会红。
// 自证造合成树（--root），把全部判据分支打一遍，外加 issue #1019 的三处 vacuous 形态。
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
    writeFileSync(join(dir, 'scripts', 'check-demo.mjs'), '// demo gate\n')
    writeFileSync(join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), opts.template ?? TEMPLATE_OK)
    const states = opts.states ?? [GOOD_STATE]
    const fields = opts.fields === undefined ? REQUIRED_FIELDS : opts.fields
    const payload = { $comment: 'synthetic', states }
    if (fields !== null) payload.fields = fields
    writeFileSync(join(dir, 'scripts', 'state-registry.json'), JSON.stringify(payload, null, 1))
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
  // issue #1019 的三处 vacuous 形态。
  const emptyFields = buildTree('emptyfields', { fields: [] })
  const noFields = buildTree('nofields', { fields: null })
  const partialFields = buildTree('partialfields', { fields: ['holder'] })
  const colonWritePath = buildTree('colonpath', { states: [{ ...GOOD_STATE, writePath: ':' }] })
  const dirWritePath = buildTree('dirpath', { states: [{ ...GOOD_STATE, writePath: 'scripts' }] })
  const gateDir = buildTree('gatedir', { states: [{ ...GOOD_STATE, evidence: { kind: 'gate', file: 'scripts' } }] })
  const gateOk = buildTree('gateok', { states: [{ ...GOOD_STATE, evidence: { kind: 'gate', file: 'scripts/check-demo.mjs' } }] })
  const gateMissing = buildTree('gatemissing', { states: [{ ...GOOD_STATE, evidence: { kind: 'gate', file: 'scripts/check-nope.mjs' } }] })

  const checks = [
    ['合规合成树 → PASSED 且 exit 0', runGate(['--root', ok]), (r) => r.code === 0 && r.out.includes('CHECK-STATE-REGISTRY PASSED')],
    ['evidence(gate) 指向真实门禁脚本 → 放行', runGate(['--root', gateOk]), (r) => r.code === 0 && r.out.includes('CHECK-STATE-REGISTRY PASSED')],
    ['PR 模板缺一栏（外部真源）→ FAILED', runGate(['--root', noField]), (r) => r.code === 1 && r.out.includes('PR 模板四栏齐全')],
    ['登记表 states 为空 → FAILED（跨层状态矩阵起点不得为空）', runGate(['--root', emptyStates]), (r) => r.code === 1 && r.out.includes('登记表非空')],
    ['id 重复 → FAILED', runGate(['--root', dupIds]), (r) => r.code === 1 && r.out.includes('状态 id 唯一且非空')],
    ['writePath 指向已删除文件 → FAILED（最典型的 stale）', runGate(['--root', badWritePath]), (r) => r.code === 1 && r.out.includes('写路径在场')],
    ['evidence(file) 路径不在场 → FAILED', runGate(['--root', badEvidence]), (r) => r.code === 1 && r.out.includes('evidence(file) 在场')],
    ['evidence kind 非法 → FAILED（只认 file|grep|gate）', runGate(['--root', badKind]), (r) => r.code === 1 && r.out.includes('evidence kind 合法')],
    // ── issue #1019：三处 vacuous pass 的负控 ──────────────────────────────────
    ['#1019 fields: [] → FAILED（字段清单不得由被检对象关掉）', runGate(['--root', emptyFields]), (r) => r.code === 1 && r.out.includes('fields 为空')],
    ['#1019 登记表缺 fields 键 → FAILED（不得退回默认值放行）', runGate(['--root', noFields]), (r) => r.code === 1 && r.out.includes('缺 fields 数组')],
    ['#1019 fields 漏必需栏 → FAILED', runGate(['--root', partialFields]), (r) => r.code === 1 && r.out.includes('fields 漏必需栏')],
    ['#1019 writePath ":" → FAILED（空路径段命中仓库根，不得放行）', runGate(['--root', colonWritePath]), (r) => r.code === 1 && r.out.includes('空路径段')],
    ['#1019 writePath 指向目录 → FAILED（目录不是写路径）', runGate(['--root', dirWritePath]), (r) => r.code === 1 && r.out.includes('目录而不是文件')],
    ['#1019 evidence(gate) 指向目录 → FAILED（目录不算门禁脚本）', runGate(['--root', gateDir]), (r) => r.code === 1 && r.out.includes('不是文件')],
    ['#1019 evidence(gate) 指向不存在的脚本 → FAILED', runGate(['--root', gateMissing]), (r) => r.code === 1 && r.out.includes('门禁不在场')],
  ]
  let bad = 0
  for (const [label, result, verify] of checks) {
    const pass = verify(result)
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (pass ? '' : '  -> exit=' + result.code + ' out=' + result.out.trim().slice(0, 200)))
    if (!pass) bad += 1
  }
  for (const dir of [ok, noField, emptyStates, dupIds, badWritePath, badEvidence, badKind,
    emptyFields, noFields, partialFields, colonWritePath, dirWritePath, gateDir, gateOk, gateMissing]) {
    rmSync(dir, { recursive: true, force: true })
  }
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
/**
 * 模板形态判据（issue #1019 末段）：旧实现把「协调仓模板」与「apk 仓模板」两条路径都交给
 * `resolveRepoPath`，而它在 apk 自包含布局下会把同一条 `.github/PULL_REQUEST_TEMPLATE.md`
 * 解析两次，于是「两份模板各自必须存在」实际只有一份在场也判绿。
 *
 * 判据改成**布局相关**：apk 自包含树（根下没有 `dsh-mobile-apk/`）只要求一份模板在场；
 * 协调仓布局（根下有 `dsh-mobile-apk/`）要求两份各自在场。这样「在场」与「两条路径」
 * 不再可混淆，也不会把自包含树的正常形态判红。
 */
const TEMPLATES = ['.github/PULL_REQUEST_TEMPLATE.md', 'dsh-mobile-apk/.github/PULL_REQUEST_TEMPLATE.md']
const COORD_LAYOUT = existsSync(join(ROOT, 'dsh-mobile-apk'))
const requiredTemplates = COORD_LAYOUT ? TEMPLATES : TEMPLATES.slice(0, 1)
const seenTemplateFiles = new Set()
for (const rel of requiredTemplates) {
  const p = resolveRepoPath(rel)
  if (p === null) { check('PR 模板在场: ' + rel, false); continue }
  seenTemplateFiles.add(p)
  const text = readFileSync(p, 'utf8')
  const missing = TEMPLATE_FIELDS.filter((f) => !text.includes(f))
  check('PR 模板四栏齐全: ' + rel, missing.length === 0, '缺: ' + missing.join(', '))
  check('PR 模板带 state-registry 标记: ' + rel, text.includes('state-registry'))
  check('PR 模板要求同步路径附可执行证据: ' + rel, /可执行证据/.test(text))
}
// 同一份文件不得被算成「两份模板」：上面已按布局决定要不要两条，这里再钉一次事实。
if (requiredTemplates.length > 1) {
  check('两份 PR 模板是**不同文件**（不得同一文件解析两次）', seenTemplateFiles.size === requiredTemplates.length,
    '仅解析到 ' + seenTemplateFiles.size + ' 个文件')
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

/**
 * issue #1019（第一处）：字段清单**不再**从被检登记表读。
 *
 * 旧实现 `registry.fields ?? REQUIRED_FIELDS` 的失效形态是「循环体一次都不执行」——
 * 输出上既没有 PASS 也没有 FAIL，只有一句「四栏 + evidence 全部可核对」的总结，
 * 肉眼与机器都看不出来。所以现在先把 fields 本身当成一条判据：
 * 它必须存在、非空、且是 REQUIRED_FIELDS 的超集（多登记的额外栏也照样逐条判非空）。
 */
const fieldsDeclared = fieldsProblem(registry.fields)
check('登记表 fields 声明完整（不得由被检对象关掉四栏判据）', fieldsDeclared === null, String(fieldsDeclared ?? ''))
const fieldsToCheck = Array.isArray(registry.fields) && registry.fields.length > 0 ? registry.fields : REQUIRED_FIELDS

for (const state of states) {
  const label = 'state ' + state.id
  for (const field of fieldsToCheck) {
    const value = state[field]
    check(label + ' 四栏非空: ' + field, typeof value === 'string' && value.trim() !== '')
  }
  // 写路径在场（路径部分必须存在，且必须是文件 —— 空段/目录都会被判红）
  const writeProblem = writePathProblem(state.writePath, resolveRepoPath)
  check(label + ' 写路径在场', writeProblem === null, String(writeProblem ?? state.writePath))
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
    // issue #1019（第三处）：旧实现只判 existsSync，指向目录也过。
    const gateProblem = gateEvidenceProblem(ev.file, ROOT)
    check(label + ' evidence(gate) 门禁在场', gateProblem === null, String(gateProblem ?? ev.file))
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
