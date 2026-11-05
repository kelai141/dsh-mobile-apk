// check-script-tests.mjs — 顶层 `scripts/*.test.mjs` 必须真的跑起来（issue #973）。
//
// 真因：`scripts/` 下已有四处目录级 sweep（plugins / patches / fixtures / 构建期），
// 但**没有一处覆盖顶层的 `scripts/*.test.mjs`**。于是新增一个顶层测试，只有有人记得去
// `pr-gate.yml` 加一行才会跑；忘了就是静默不跑。实测发现时 `check-runtime-assets.test.mjs`
// 已经 fail 8 条，而 CI 一直绿。
//
// 本门禁的三条判据：
//   ① 发现：`readdirSync(scripts).filter(f => f.endsWith('.test.mjs'))` —— 目录枚举，不维护清单；
//   ② 执行：全部待跑文件**一次** `node --test`，要求 fail === 0 且有效通过数 > 0（全 skip = 假绿）；
//   ③ 元断言：发现数 === 豁免数 + 待跑数；且每个豁免项都必须真实存在（清单漂移即红）。
//
// issue #980（判据失效模式：vacuous pass / 空集恒真）：判据 ② 里的「有效通过数 > 0」曾被写死成
// `if (false)`，于是两种假绿形态都判过：
//   - **全 skip**：`node --test` 输出 pass 0 / fail 0 且 exit 0，
//     `failN === knownFailRelevant` 成立即放行（通过数算出来只用于打印）；
//   - **runner 崩溃没打汇总行**：解析不到 `ℹ pass`/`ℹ fail` 时 `Number(undefined ?? 0) === 0`，
//     两个数都成了 0，于是「跑都没跑起来」被算成「零失败」。
// 本机实测（Node v24.17.0）两种形态：只含 `test.skip` 的文件 = exit 0 + pass 0 + fail 0；
// 把一个 `*.test.mjs` 换成同名目录 = 只打 `Cannot find module`、exit 1、**无汇总行**。
// 旧代码对前者打印 `CHECK-SCRIPT-TESTS PASSED（… pass=0 …）`，对后者也是 PASSED。
//
// 修法：把执行结果判定抽成纯函数 `evaluateRun`（`--self-test` 直接钉住它的双向判别力），
// 判据按**段**分开——两段的通过数含义不同，混加会互相掩盖：
//   - node:test 段：必须解析到汇总行；pass 必须 > 0（全 skip / 一个文件都没跑起来都算假绿）；
//     fail 数必须**恰好**等于已知失败清单长度；汇总说 fail 0 时退出码必须为 0（否则两者矛盾）。
//   - 普通脚本段（PLAIN_SCRIPT）：逐条 exit 0，任一条非 0 或起不来即红；这一段的「通过」**不计入**
//     node:test 段的 pass 下限（否则「node:test 全 skip + 3 个普通脚本通过」会被算成 pass 3 而假绿）。
//
// 豁免（INLINED）的规矩：**只登记已被其它门禁内联执行的**，每条必须带 coveredBy 与 since。
// 重复执行会拖长 CI，也会让别处「失败数 == 清单长度」那类断言失真。
//
// 用法：node scripts/check-script-tests.mjs [--self-test]
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_DIR = join(ROOT, 'scripts')

/**
 * 已由各自门禁**内联执行**的顶层测试 —— 这里不再跑第二遍。
 *
 * 每条必须写清 `coveredBy`（谁在跑）与 `since`（何时起如此），
 * 否则「豁免」会变成「永久静默」。
 */
export const INLINED = [
  { file: 'build-hard-manifest.test.mjs', coveredBy: 'build-apk.mjs / check-patch-mirror.mjs', since: '2026-10' },
  { file: 'build-injection-staging.test.mjs', coveredBy: 'check-inject-completeness.mjs', since: '2026-10' },
  { file: 'check-api-route-auth-artifact.test.mjs', coveredBy: 'check-api-route-auth.mjs', since: '2026-10' },
  { file: 'check-inject-completeness.test.mjs', coveredBy: 'check-inject-completeness.mjs', since: '2026-10' },
  { file: 'verify-webview-settings.test.mjs', coveredBy: 'verify-webview-015.mjs', since: '2026-10' },
]

/**
 * 命名是 `*.test.mjs` 但**不是 `node:test` 文件**的脚本（没有 `test()` 调用，靠自身 exit code 表达结果）。
 * 必须单独登记：`node --test` 会把「跑完但没有 test」当失败，而这几个本来就不是测试清单的一员。
 */
export const PLAIN_SCRIPT = [
  'check-code-map-anchors.test.mjs',
  'check-perf-instrumentation.test.mjs',
  'verify-state-sync-modep.test.mjs',
]

/**
 * 已知失败清单（与 `check-patch-test-manifest.mjs` 的 KNOWN_FAIL 同款）。
 * 每条**必须**有 reason 与 since —— 不许无理由豁免，也不许把新失败塞进来当没看见。
 * 失败数必须恰好等于本清单长度：多一个说明有新失败，少一个说明有人修好了但忘了销账。
 */
export const KNOWN_FAIL = [
  // 当前为空：接入时实测 check-code-map-anchors.test.mjs 是红的，但真因是**接入改动自身**引起的
  // 符号锚点漂移（插了 4 行 pr-gate 步骤），刷新锚点基线后 8 组变异反证全绿（ALL 8 MUTATION CONTROLS PASSED）。
  // 记在这里是因为这一类「先红后绿」必须留下判断痕迹：当时若直接塞进 KNOWN_FAIL 就永久静默了一条真门禁。
]
/** 目录枚举：顶层 `scripts/*.test.mjs`（不递归 —— 子目录各有自己的 sweep）。 */
export const discover = (dir = SCRIPT_DIR) =>
  readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()

/**
 * 元断言（纯函数，供 --self-test 直接钉判据）。
 *
 * @param {string[]} discovered 目录里实际存在的顶层测试文件。
 * @param {{file: string}[]} inlined 豁免清单。
 * @returns {string[]} 问题列表（空 = 合规）。
 */
export const accountingProblems = (discovered, inlined) => {
  const problems = []
  const names = new Set(discovered)
  for (const entry of inlined) {
    if (!entry.file || !entry.coveredBy || !entry.since) {
      problems.push('豁免项缺字段（file/coveredBy/since 必填）：' + JSON.stringify(entry))
      continue
    }
    if (!names.has(entry.file)) {
      problems.push('豁免项已不存在（清单漂移，请删掉）：' + entry.file)
    }
  }
  const exempt = new Set(inlined.map((e) => e.file))
  const toRun = discovered.filter((f) => !exempt.has(f))
  if (toRun.length === 0) problems.push('待跑的顶层测试为 0 —— 要么全被豁免，要么发现逻辑坏了')
  return problems
}

/**
 * `node --test` 汇总行的字段形态：spec reporter（本门禁在用）与 TAP（另一条链在用）都接受。
 *
 * 必须锚定行首 + 字段名，不能用裸 `/(\d+) pass/`：输出里 `ℹ cancelled 0` 与失败用例标题里的数字
 * 都会给出相邻假命中（check-plugin-tests 实测踩过同类误判）。
 */
const SUMMARY_FIELDS = {
  tests: [/^ℹ tests (\d+)$/m, /^# tests (\d+)$/m],
  pass: [/^ℹ pass (\d+)$/m, /^# pass (\d+)$/m],
  fail: [/^ℹ fail (\d+)$/m, /^# fail (\d+)$/m],
  skipped: [/^ℹ skipped (\d+)$/m, /^# skip (\d+)$/m],
}

/**
 * 解析 `node --test` 汇总行。
 *
 * 先统一换行符：Windows 下经管道拿到的输出可能是 CRLF，而多行模式下的行尾锚点只匹配 `\n` 之前，
 * 带 `\r` 的行会让**所有**字段都解析不到 —— 那正好就是「解析不到汇总行」的假红形态。
 *
 * @param {string} stdout 子进程 stdout + stderr 合并输出。
 * @returns {{tests: number|null, pass: number|null, fail: number|null, skipped: number|null, hasSummary: boolean}}
 */
export const parseNodeTestSummary = (stdout) => {
  const text = String(stdout ?? '').replace(/\r/g, '')
  const pick = (patterns) => {
    for (const re of patterns) {
      const m = re.exec(text)
      if (m) return Number(m[1])
    }
    return null
  }
  const out = {
    tests: pick(SUMMARY_FIELDS.tests),
    pass: pick(SUMMARY_FIELDS.pass),
    fail: pick(SUMMARY_FIELDS.fail),
    skipped: pick(SUMMARY_FIELDS.skipped),
  }
  return { ...out, hasSummary: out.pass !== null && out.fail !== null }
}

/**
 * 执行结果判定（纯函数）。**这是本门禁唯一的判据实现**，主流程与 `--self-test` 走同一份代码。
 *
 * 为什么分段（issue #980 的真因）：旧的单段写法把「node:test 的 pass」与「普通脚本的 exit 0」
 * 加进同一个 passN，于是 3 个普通脚本通过就能把「node:test 全 skip（pass 0）」抬到 pass=3，
 * 下限判据形同不存在；更根本的是那条下限被写成了 `if (false)`，加上 `Number(undefined ?? 0) = 0`，
 * 连「runner 没打汇总行」也被算成零失败。
 *
 * @param {object} input
 * @param {string} [input.stdout] `node --test` 的 stdout + stderr 合并输出。
 * @param {number|null} [input.status] 子进程退出码（起不来/超时为 null）。
 * @param {string|null} [input.error] 启动错误码（spawnSync 的 `error.code`，如 ETIMEDOUT）。
 * @param {{file: string, status: number|null, error?: string|null}[]} [input.plainResults]
 *        普通脚本段逐条结果；`status === 0` 才算通过。
 * @param {({file: string}|string)[]} [input.knownFail] 已知失败清单（调用方已按豁免过滤）。
 * @returns {string[]} 问题列表（空 = 合规）。
 */
export const evaluateRun = ({ stdout = '', status = null, error = null, plainResults = [], knownFail = [] } = {}) => {
  const problems = []
  const knownFailFiles = (knownFail ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
    .filter((f) => typeof f === 'string' && f !== '')

  if (error) problems.push('node --test 无法启动（' + String(error) + '）')

  const summary = parseNodeTestSummary(stdout)
  if (!summary.hasSummary) {
    // 汇总行缺席 = 一个用例都没跑完就被打断。不能把「没数」当成「零失败」（旧代码正是如此）。
    problems.push('解析不到 node:test 汇总行（pass/fail）：runner 崩溃、超时或根本没跑起来（exit='
      + String(status) + '）—— 不得当作通过')
  } else {
    if (summary.fail === 0 && status !== 0) {
      // 汇总说零失败、进程却非 0 退出：两者矛盾，至少一方不可信，按红处理。
      problems.push('node --test 退出码 ' + String(status) + '，但汇总行说 fail 0（矛盾，按红处理）')
    }
    if (summary.pass === 0) {
      // 全 skip / 一个用例都没执行：exit 0 与 fail 0 都成立，只能靠通过数识别 —— 正是 #980 的缺口。
      problems.push('node:test 有效通过数 0（全 skip = 假绿；tests=' + String(summary.tests)
        + '，skipped=' + String(summary.skipped) + '）')
    }
    if (summary.fail !== knownFailFiles.length) {
      problems.push('失败数(' + String(summary.fail) + ') != 已知失败清单长度(' + knownFailFiles.length + ')')
    }
  }

  // 普通脚本段：不参与 node:test 的通过数下限，只要求逐条 exit 0。
  for (const result of plainResults ?? []) {
    const file = result?.file ?? '(未登记)'
    if (result?.error) {
      problems.push('普通脚本 ' + file + ' 无法启动（' + String(result.error) + '）')
      continue
    }
    if (result?.status !== 0) {
      problems.push('普通脚本 ' + file + ' exit=' + String(result?.status) + '（必须 0）')
    }
  }
  return problems
}

const selfTest = () => {
  /** 造一段 spec reporter 的汇总行（字段顺序与真实 node --test 一致）。 */
  const summary = ({ tests = 1, pass = 1, fail = 0, skipped = 0 } = {}) => [
    'ℹ tests ' + tests,
    'ℹ suites 0',
    'ℹ pass ' + pass,
    'ℹ fail ' + fail,
    'ℹ cancelled 0',
    'ℹ skipped ' + skipped,
    'ℹ todo 0',
    'ℹ duration_ms 12.3456',
  ].join('\n')

  const accounting = [
    { label: '元断言：正常（3 个发现、1 个豁免）', args: [['a.test.mjs', 'b.test.mjs', 'c.test.mjs'], [{ file: 'a.test.mjs', coveredBy: 'x', since: 'y' }]], expect: 0 },
    { label: '元断言：豁免项缺 coveredBy', args: [['a.test.mjs'], [{ file: 'a.test.mjs', since: 'y' }]], expect: 1 },
    { label: '元断言：豁免项缺 since', args: [['a.test.mjs'], [{ file: 'a.test.mjs', coveredBy: 'x' }]], expect: 1 },
    { label: '元断言：豁免项已不存在（清单漂移）', args: [['b.test.mjs'], [{ file: 'a.test.mjs', coveredBy: 'x', since: 'y' }]], expect: 1 },
    { label: '元断言：全部被豁免（待跑为 0）', args: [['a.test.mjs'], [{ file: 'a.test.mjs', coveredBy: 'x', since: 'y' }]], expect: 1 },
    { label: '元断言：无发现', args: [[], []], expect: 1 },
  ]

  // 执行判定的双向用例：正向（必须放行）与反向（必须以预期理由判红）。
  // 反向用例的理由用正则钉住，不能只数条数 —— 否则「任何输入都报一条」也能过自检。
  const runs = [
    { label: '放行：正常跑出 pass>0 且 fail 0', input: { stdout: summary({ tests: 12, pass: 12 }), status: 0 }, expect: 0 },
    { label: '放行：已知失败恰好匹配清单（node --test 因此非 0 退出）', input: { stdout: summary({ tests: 3, pass: 2, fail: 1 }), status: 1, knownFail: [{ file: 'a.test.mjs' }] }, expect: 0 },
    { label: '放行：普通脚本段逐条 exit 0', input: { stdout: summary({ tests: 2, pass: 2 }), status: 0, plainResults: [{ file: 'p1.test.mjs', status: 0 }, { file: 'p2.test.mjs', status: 0 }] }, expect: 0 },
    { label: '放行：CRLF 汇总行也必须解析（Windows 管道）', input: { stdout: summary({ tests: 2, pass: 2 }).replaceAll('\n', '\r\n'), status: 0 }, expect: 0 },
    { label: '反向：全 skip（pass 0 / fail 0 / exit 0）', input: { stdout: summary({ tests: 2, pass: 0, skipped: 2 }), status: 0 }, expect: 1, match: /有效通过数 0/ },
    { label: '反向：runner 崩溃无汇总行（非 0 退出）', input: { stdout: "Could not find 'nosuch.test.mjs'\n", status: 1 }, expect: 1, match: /解析不到 node:test 汇总行/ },
    { label: '反向：无汇总行且退出码 0（Number(undefined ?? 0) 的假绿形态）', input: { stdout: '', status: 0 }, expect: 1, match: /解析不到 node:test 汇总行/ },
    { label: '反向：runner 起不来（ETIMEDOUT，无输出）', input: { stdout: '', status: null, error: 'ETIMEDOUT' }, expect: 1, match: /无法启动/ },
    { label: '反向：fail 数 != 已知失败清单（清单为空却有失败）', input: { stdout: summary({ tests: 3, pass: 1, fail: 2 }), status: 1, knownFail: [] }, expect: 1, match: /失败数\(2\) != 已知失败清单长度\(0\)/ },
    { label: '反向：已知失败清单比实际长（修好了没销账）', input: { stdout: summary({ tests: 3, pass: 2, fail: 1 }), status: 1, knownFail: [{ file: 'a.test.mjs' }, { file: 'b.test.mjs' }] }, expect: 1, match: /失败数\(1\) != 已知失败清单长度\(2\)/ },
    { label: '反向：汇总说 fail 0 但退出码非 0（矛盾）', input: { stdout: summary({ tests: 3, pass: 3 }), status: 1 }, expect: 1, match: /矛盾/ },
    { label: '反向：普通脚本段一条 exit 1', input: { stdout: summary({ tests: 2, pass: 2 }), status: 0, plainResults: [{ file: 'p1.test.mjs', status: 0 }, { file: 'p2.test.mjs', status: 1 }] }, expect: 1, match: /普通脚本 p2\.test\.mjs exit=1/ },
    { label: '反向：普通脚本段起不来（error 非空）', input: { stdout: summary({ tests: 2, pass: 2 }), status: 0, plainResults: [{ file: 'p1.test.mjs', status: null, error: 'ETIMEDOUT' }] }, expect: 1, match: /普通脚本 p1\.test\.mjs 无法启动/ },
    { label: '反向：node:test 全 skip + 普通脚本全过（分段后仍须判红）', input: { stdout: summary({ tests: 2, pass: 0, skipped: 2 }), status: 0, plainResults: [{ file: 'p1.test.mjs', status: 0 }, { file: 'p2.test.mjs', status: 0 }, { file: 'p3.test.mjs', status: 0 }] }, expect: 1, match: /有效通过数 0/ },
  ]

  let bad = 0
  const check = (label, problems, expect, match) => {
    const enough = problems.length >= expect
    const kindOk = match === undefined || problems.some((p) => match.test(p))
    if (enough && kindOk) { console.log('PASS  [self-test] ' + label); return }
    bad += 1
    console.error('FAIL  [self-test] ' + label + ' -> ' + JSON.stringify(problems)
      + (kindOk ? '' : '（未报出预期理由 ' + String(match) + '）'))
  }
  for (const c of accounting) check(c.label, accountingProblems(c.args[0], c.args[1]), c.expect, c.match)
  for (const c of runs) check(c.label, evaluateRun(c.input), c.expect, c.match)

  const total = accounting.length + runs.length
  if (bad > 0) { console.error('CHECK-SCRIPT-TESTS SELF-TEST FAILED（' + bad + '/' + total + ' 项）'); process.exit(1) }
  console.log('CHECK-SCRIPT-TESTS SELF-TEST PASSED（' + total + ' 项）')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

const discovered = discover()
const problems = accountingProblems(discovered, INLINED)
for (const p of problems) console.error('FAIL  ' + p)
if (problems.length > 0) {
  console.error('CHECK-SCRIPT-TESTS FAILED（清单/发现不一致）')
  process.exit(1)
}
const exempt = new Set(INLINED.map((e) => e.file))
const plainSet = new Set(PLAIN_SCRIPT)
const candidates = discovered.filter((f) => !exempt.has(f))
const nodeTestFiles = candidates.filter((f) => !plainSet.has(f))
const plainFiles = candidates.filter((f) => plainSet.has(f))
const toRun = nodeTestFiles.map((f) => join('scripts', f))
console.log('RUN   ' + toRun.length + ' 个顶层测试（豁免 ' + INLINED.length + ' 个，已由各自门禁内联执行）')
// **串行执行**（`--test-concurrency=1`）：19 个文件里有些会 spawn 重型子进程（code-map 锚点扫描等），
// 并发跑会互相抢 CPU，把别人挤过自己的超时阈值 —— 实测 `check-code-map-anchors.test.mjs` 并发时
// 10022ms 超时失败、单独跑 1.7s 通过。串行慢一点，但判据不依赖机器负载。
// 待跑为 0 时**不得**照样 spawn：`node --test` 不带文件参数会递归扫 cwd，把插件测试一起拉进来。
const r = toRun.length === 0
  ? null
  : spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', '--test-concurrency=1', ...toRun], {
    cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000,
  })
const out = r === null ? '' : String((r.stdout ?? '') + (r.stderr ?? ''))
// 非 node:test 形态：逐个以普通脚本跑，自身 exit code 即结论。
const plainResults = []
for (const f of plainFiles) {
  const pr = spawnSync(process.execPath, [join('scripts', f)], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000 })
  plainResults.push({ file: f, status: pr.status, error: pr.error?.code ?? null })
  if (pr.status !== 0) {
    console.error('FAIL  ' + f + '（普通脚本形态，exit=' + pr.status + '）')
    console.error(String((pr.stdout ?? '') + (pr.stderr ?? '')).slice(-1500))
  }
}
const knownFailRelevant = KNOWN_FAIL.filter((e) => !exempt.has(e.file))
const runProblems = evaluateRun({
  stdout: out,
  status: r === null ? null : r.status,
  error: r?.error?.code ?? null,
  plainResults,
  knownFail: knownFailRelevant,
})
if (runProblems.length > 0) {
  for (const p of runProblems) console.error('FAIL  ' + p)
  console.error(out.slice(-4000))
  console.error('CHECK-SCRIPT-TESTS FAILED（' + runProblems.length + ' 项判据不成立）')
  process.exit(1)
}
const ran = parseNodeTestSummary(out)
if (ran.fail > 0) {
  console.log('WARN  已知失败 ' + ran.fail + ' 项（均带理由）：' + KNOWN_FAIL.map((e) => e.file).join(', '))
}
console.log('CHECK-SCRIPT-TESTS PASSED（node:test ' + toRun.length + ' 个 + 普通脚本 ' + plainFiles.length
  + ' 个；pass=' + ran.pass + '；skip=' + ran.skipped + '；已知失败 ' + ran.fail + '；内联豁免 ' + INLINED.length + ' 个）')
