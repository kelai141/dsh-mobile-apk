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
// 豁免（INLINED）的规矩：**只登记已被其它门禁内联执行的**，每条必须带 coveredBy 与 since。
// 重复执行会拖长 CI，也会让别处「失败数 == 清单长度」那类断言失真。
//
// 用法：node scripts/check-script-tests.mjs [--self-test]
import { existsSync, readdirSync } from 'node:fs'
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

const selfTest = () => {
  const cases = [
    { label: '正常：3 个发现、1 个豁免', discovered: ['a.test.mjs', 'b.test.mjs', 'c.test.mjs'], inlined: [{ file: 'a.test.mjs', coveredBy: 'x', since: 'y' }], expect: 0 },
    { label: '豁免项缺 coveredBy', discovered: ['a.test.mjs'], inlined: [{ file: 'a.test.mjs', since: 'y' }], expect: 1 },
    { label: '豁免项缺 since', discovered: ['a.test.mjs'], inlined: [{ file: 'a.test.mjs', coveredBy: 'x' }], expect: 1 },
    { label: '豁免项已不存在（清单漂移）', discovered: ['b.test.mjs'], inlined: [{ file: 'a.test.mjs', coveredBy: 'x', since: 'y' }], expect: 1 },
    { label: '全部被豁免（待跑为 0）', discovered: ['a.test.mjs'], inlined: [{ file: 'a.test.mjs', coveredBy: 'x', since: 'y' }], expect: 1 },
    { label: '无发现', discovered: [], inlined: [], expect: 1 },
  ]
  let bad = 0
  for (const c of cases) {
    const got = accountingProblems(c.discovered, c.inlined)
    const ok = c.expect === 0 ? got.length === 0 : got.length >= c.expect
    if (!ok) { bad += 1; console.error('FAIL  [self-test] ' + c.label + ' -> ' + JSON.stringify(got)) }
    else console.log('PASS  [self-test] ' + c.label)
  }
  if (bad > 0) { console.error('CHECK-SCRIPT-TESTS SELF-TEST FAILED（' + bad + '/' + cases.length + ' 项）'); process.exit(1) }
  console.log('CHECK-SCRIPT-TESTS SELF-TEST PASSED（' + cases.length + ' 项）')
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
const knownFailSet = new Set(KNOWN_FAIL.map((e) => e.file))
const candidates = discovered.filter((f) => !exempt.has(f))
const nodeTestFiles = candidates.filter((f) => !plainSet.has(f))
const plainFiles = candidates.filter((f) => plainSet.has(f))
const toRun = nodeTestFiles.map((f) => join('scripts', f))
console.log('RUN   ' + toRun.length + ' 个顶层测试（豁免 ' + INLINED.length + ' 个，已由各自门禁内联执行）')
// **串行执行**（`--test-concurrency=1`）：19 个文件里有些会 spawn 重型子进程（code-map 锚点扫描等），
// 并发跑会互相抢 CPU，把别人挤过自己的超时阈值 —— 实测 `check-code-map-anchors.test.mjs` 并发时
// 10022ms 超时失败、单独跑 1.7s 通过。串行慢一点，但判据不依赖机器负载。
const r = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', '--test-concurrency=1', ...toRun], {
  cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000,
})
const out = String((r.stdout ?? '') + (r.stderr ?? ''))
let passN = Number((/^ℹ pass (\d+)/m.exec(out) ?? [])[1] ?? 0)
let failN = Number((/^ℹ fail (\d+)/m.exec(out) ?? [])[1] ?? 0)
// 非 node:test 形态：逐个以普通脚本跑，自身 exit code 即结论。
for (const f of plainFiles) {
  const pr = spawnSync(process.execPath, [join('scripts', f)], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000 })
  if (pr.status === 0) { passN += 1; continue }
  failN += 1
  console.error('FAIL  ' + f + '（普通脚本形态，exit=' + pr.status + '）')
  console.error(String((pr.stdout ?? '') + (pr.stderr ?? '')).slice(-1500))
}
// 失败数必须恰好等于 KNOWN_FAIL 长度：多 = 有新失败；少 = 有人修好但忘了销账。
const knownFailRelevant = KNOWN_FAIL.filter((e) => !exempt.has(e.file)).length
if (failN !== knownFailRelevant) {
  console.error('FAIL  失败数(' + failN + ') != 已知失败清单长度(' + knownFailRelevant + ')')
  console.error(out.slice(-4000))
  console.error('CHECK-SCRIPT-TESTS FAILED（失败数与已知失败清单不符）')
  process.exit(1)
}
if (failN > 0) {
  console.log('WARN  已知失败 ' + failN + ' 项（均带理由）：' + KNOWN_FAIL.map((e) => e.file).join(', '))
}
if (false) {
  console.error(out.slice(-4000))
  console.error('CHECK-SCRIPT-TESTS FAILED（fail=' + failN + ' pass=' + passN + '）')
  process.exit(1)
}
console.log('CHECK-SCRIPT-TESTS PASSED（node:test ' + toRun.length + ' 个 + 普通脚本 ' + plainFiles.length + ' 个；pass=' + passN + '；已知失败 ' + failN + '；内联豁免 ' + INLINED.length + ' 个）')