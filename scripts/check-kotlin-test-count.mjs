// check-kotlin-test-count.mjs — Kotlin 单测**数量**反回归门禁（0.14.1 P0）。
//
// ── 为什么必须存在 ────────────────────────────────────────────────────────────
// 0.14.1 审计发现两处同源缺口，本门禁合起来堵第二个：
//   ① **CI 从不跑 Kotlin 单测**（全仓 grep `testDebugUnitTest|:app:test` 零命中，pr-gate 只跑
//      `compileDebugKotlin`）→ 417 例契约断言只在本地手动跑过。修法见 apk 仓 pr-gate.yml。
//   ② **即使跑起来，也只按退出码判** —— 退出码 0 无法区分「全部通过」与「一个用例都没跑」。
//      `testDebugUnitTest` 在**测试类被删/被改名/漏编译/`@Test` 注解被拿掉**时依然 exit 0，
//      于是「防线消失」表现为**绿色**。这正是本轮主线缺陷的同形复发：
//      「判据真会红，但结构性绕开」与「防线被删掉却仍然绿」是同一类病。
//
// 判据不是「数量等于某个字面量」（那会把正常增删测试判红），而是**两个结构性不变量**：
//   A. **每个已跟踪的测试源文件都必须在结果里出现**（类名 = 文件名去掉 `.kt`）。
//      —— 抓「整个测试类消失/漏编译」：这是最危险也最不易察觉的防线删失形态。
//   B. **总数不得低于基线**（`scripts/kotlin-test-baseline.json`，只许升不许降）。
//      —— 抓「类还在但用例被成批删掉/@Test 被摘」。
//      基线刻意采用「文件名 → 用例数」映射而非单一总数：单看总数会被「删 3 个 A 类用例、
//      加 3 个 B 类用例」抵消（净零但对 A 的防线已消失）。
//
// 另：结果必须**新鲜**（mtime 晚于对应源码），否则是陈旧报告 → 判红而不是判绿。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/check-kotlin-test-count.mjs            # 判据 A + B（结果须已存在且新鲜）
//   node scripts/check-kotlin-test-count.mjs --update-baseline   # 基线升档（只允许升）
//   node scripts/check-kotlin-test-count.mjs --self-test         # 反向对照（见下）
//   node scripts/check-kotlin-test-count.mjs --allow-missing     # 仅「无结果」时 SKIP 而非判红（陈旧度仍走 gradle 仲裁）
//                                                                # （供无 gradle 的环境；SKIP 计数且不计入绿）
//
// 退出码：0 = 通过（或显式 SKIP）；1 = 判红；2 = 用法/环境错误。
//
// ── 反证（--self-test）────────────────────────────────────────────────────────
// ① 缺一个测试类的结果 → 判红（并必须点名缺失的类）
// ② 某类用例数低于基线 → 判红
// ③ 结果陈旧 → 判红
// ④ 基线整体高于结果总数 → 判红
// ⑤ 完全一致的合成结果 → **判绿**（证明不是「恒红」）
// 这五条保证本门禁不是「只能红」也不是「只能绿」。

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
/**
 * 壳侧树定位（**双仓可运行**）：
 *  - 协调仓：脚本在 `<coord>/scripts/`，壳侧是子目录 `<coord>/dsh-mobile-apk/`；
 *  - 壳侧仓：脚本被镜像到 `<apk>/scripts/`，壳侧**就是本仓根**。
 * 硬编码 `ROOT/dsh-mobile-apk` 会让壳侧仓的聚合门禁与 CI 找不到 `app/src/test`（实测报
 * 「找不到测试源目录 …/dsh-mobile-apk/dsh-mobile-apk/app/src/test/…」）——而 apk 仓 CI 是
 * **自包含**的（不依赖私有协调仓），必须能就地跑。判据用「app 目录是否存在于候选路径」，
 * 而不是猜仓名（仓名可能变，目录结构不会）。
 */
const APK = existsSync(join(ROOT, 'dsh-mobile-apk', 'app')) ? join(ROOT, 'dsh-mobile-apk') : ROOT
const TEST_SRC_DIR = join(APK, 'app', 'src', 'test', 'java', 'com', 'dsharnessmobile', 'shell')
const RESULTS_DIR = join(APK, 'app', 'build', 'test-results', 'testDebugUnitTest')
const BASELINE = join(HERE, 'kotlin-test-baseline.json')

const argv = process.argv.slice(2)
const SKIP_REASON = argv.includes('--allow-missing')

/**
 * 列出测试源文件（用于「每个源文件都必须有结果」的判据）。
 *
 * **不能假设「一个 .kt 一个测试类」**：本轮实测 `CallSiteContractTest.kt` 里声明了**两个**测试类
 * （`CallSiteContractTest` + `BootDiagnosticsContractTest`，后者是 bootperf 按裁定并入的），
 * 于是「类名 = 文件名」的朴素映射会把 `BootDiagnosticsContractTest` 误判成「缺席结果」。
 * 故改为**在文件内容里找 `class XxxTest` 声明**，一个文件可产出多个类名。
 */
function testSourceClasses() {
  if (!existsSync(TEST_SRC_DIR)) return null
  const out = []
  for (const f of readdirSync(TEST_SRC_DIR)) {
    if (!f.endsWith('.kt')) continue
    const text = readFileSync(join(TEST_SRC_DIR, f), 'utf8')
    // 只认顶层 `class XxxTest` 声明（含 `internal class`），忽略注释里的同名文本。
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    const re = /(?:^|\n)\s*(?:internal\s+|private\s+)?class\s+([A-Za-z0-9_]*Test)\b/g
    let m
    let found = false
    while ((m = re.exec(code)) !== null) {
      out.push(m[1])
      found = true
    }
    if (!found) {
      // 兜底：文件名本身（极少数用字符串类名或其它形态声明的文件）。
      out.push(basename(f, '.kt'))
    }
  }
  return [...new Set(out)].sort()
}

/**
 * 解析 gradle 的 TEST-*.xml → { className: { tests, skipped, failures, errors, mtimeMs } }。
 * 用正则解析而不是引入 XML 依赖：这些文件是 gradle 生成的**极简格式**（一层 testsuite + 自闭合
 * property/testcase），不需要通用解析器；引入依赖反而增加快照/CI 面。
 */
function parseResults(dir) {
  if (!existsSync(dir)) return null
  const out = {}
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.xml')) continue
    const full = join(dir, f)
    const head = readFileSync(full, 'utf8').slice(0, 2000)
    const m = /<testsuite\s+name="([^"]+)"[^>]*\btests="(\d+)"[^>]*\bskipped="(\d+)"[^>]*\bfailures="(\d+)"[^>]*\berrors="(\d+)"/.exec(head)
    if (!m) continue
    const cls = m[1].split('.').pop()
    out[cls] = {
      tests: Number(m[2]),
      skipped: Number(m[3]),
      failures: Number(m[4]),
      errors: Number(m[5]),
      mtimeMs: statSync(full).mtimeMs,
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 结果新鲜度的**仲裁**（H-2 处方：mtime 只作触发，最终由 gradle 自己的内容哈希裁决）。
 *
 * 为什么必须换：本门禁原先「结果 mtime 早于测试源码」即判红——而 gradle 的判据是**输入内容哈希**。
 * 实测（`docs/0.14.1-WRAP-UP.md` §6.3）：只触碰（robocopy/检出/编辑器保存）测试源码、内容未变时，
 * `./gradlew :app:testDebugUnitTest` 报 `UP-TO-DATE`，但 mtime 判据已经判红 61 项。
 * 这条门禁是聚合链的**最后一条**，一红即整链中止——一个纯时间戳造成的假阳性会让整条发布链停摆。
 *
 * 仲裁逻辑（fail-closed）：
 *  - 跑一次 `:app:testDebugUnitTest`；
 *  - 该任务报 `UP-TO-DATE` / `FROM-CACHE` ⇒ gradle 认定输入未变 ⇒ 旧报告与当前源码**内容等价**，放行；
 *  - 该任务真的执行过 ⇒ 报告已被刷新，重新读一遍结果（此时 mtime 自然新），放行；
 *  - gradle 不可用 / 执行失败 / 输出无法判定 ⇒ **判红**（不放过，保持原姿态）。
 * @returns {{ arbitrated: boolean, refreshed: object|null, note: string }}
 */
/**
 * 纯判据：gradle 的任务收尾行 → 该任务是否「内容等价（UP-TO-DATE / FROM-CACHE）」。
 *
 * 抽成纯函数是为了让 `--self-test` 能覆盖这条分支（否则它只能靠真跑一次 gradle 来验证，
 * 而 self-test 必须离线可跑）。
 * @param line - `> Task :app:testDebugUnitTest ...` 那一行（缺省空串）。
 * @returns `equivalent`（输入未变，报告内容等价）/ `executed`（真的跑过，报告已刷新）/ `unknown`。
 */
export function arbitrationFromTaskLine(line) {
  if (typeof line !== 'string' || line === '') return 'unknown'
  if (line.includes('UP-TO-DATE') || line.includes('FROM-CACHE')) return 'equivalent'
  if (line.includes('Task :app:testDebugUnitTest')) return 'executed'
  return 'unknown'
}

function arbitrateStaleness() {
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const args = [':app:testDebugUnitTest', '--no-daemon', '--console=plain']
  let r = spawnSync(gradlew, args, { cwd: APK, encoding: 'utf8', timeout: 15 * 60 * 1000 })
  // Windows 上 `spawnSync('gradlew.bat')` 在无 shell 时直接 EINVAL（本机实测；与 check-plugin-tests
  // 的 npm.cmd 同因）。先直调，spawn 失败再退到 shell:true 重试——只影响「怎么起 gradle」。
  if (r.error !== undefined || r.status === null) {
    r = spawnSync(gradlew, args, { cwd: APK, encoding: 'utf8', timeout: 15 * 60 * 1000, shell: true })
  }
  if (r.error !== undefined && r.error !== null) {
    return { arbitrated: false, refreshed: null, note: 'gradle 不可用：' + String(r.error.code ?? r.error.message) }
  }
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  if (r.status !== 0) {
    return { arbitrated: false, refreshed: null, note: 'gradle 执行失败（status=' + String(r.status) + '）' }
  }
  // 该任务的收尾行：UP-TO-DATE / FROM-CACHE / 真执行（无后缀）
  const line = out.split('\n').find((l) => l.includes('Task :app:testDebugUnitTest')) ?? ''
  const verdict = arbitrationFromTaskLine(line)
  const refreshed = parseResults(RESULTS_DIR)
  if (verdict === 'equivalent') {
    return {
      arbitrated: true, refreshed,
      note: 'mtime 假阳性：gradle 判定 :app:testDebugUnitTest ' + (line.includes('UP-TO-DATE') ? 'UP-TO-DATE' : 'FROM-CACHE')
        + '（输入未变 ⇒ 报告与当前源码内容等价），按新鲜继续校验',
    }
  }
  if (verdict === 'executed') {
    return { arbitrated: true, refreshed, note: 'mtime 命中后已重跑单测，报告已刷新（任务真的执行过）' }
  }
  return { arbitrated: false, refreshed: null, note: 'gradle 输出无法判定任务状态（既非 UP-TO-DATE/FROM-CACHE 也非执行行）' }
}

/**
 * 核心判据。`results` / `classes` / `baseline` 允许注入，便于 --self-test 构造反向对照。
 * @returns {{ failures: string[], notes: string[] }}
 */
export function evaluate({ results, classes, baseline, srcMtimeMs = 0, sourceCounts = null }) {
  const failures = []
  const notes = []

  // A. 每个测试源类都必须在结果里出现。
  for (const cls of classes) {
    if (results[cls] === undefined) {
      failures.push('测试类缺席结果（被删/改名/漏编译，防线整体消失）: ' + cls)
    }
  }

  // 结果新鲜度：报告必须晚于测试源码。陈旧报告 = 未真正重跑。
  for (const [cls, r] of Object.entries(results)) {
    if (r.mtimeMs < srcMtimeMs) {
      failures.push('结果陈旧（早于测试源码）: ' + cls + ' -> 未真正重跑，不得据此判绿')
    }
  }

  // 失败用例：本门禁的职责是数量反回归，但既然读了报告就一并断言（避免「有失败用例却数量达标」）。
  for (const [cls, r] of Object.entries(results)) {
    if (r.failures > 0 || r.errors > 0) {
      failures.push('存在失败/错误用例: ' + cls + ' failures=' + r.failures + ' errors=' + r.errors)
    }
  }

  // B. 逐类不得低于基线（只许升）。比单一总数强：防「删 A 加 B」净零抵消。
  if (baseline) {
    for (const [cls, need] of Object.entries(baseline.testsByClass ?? {})) {
      const r = results[cls]
      if (r === undefined) continue // A 已判红
      if (r.tests < need) {
        failures.push('用例数低于基线: ' + cls + ' 现 ' + r.tests + ' < 基线 ' + need + '（用例被删/@Test 被摘）')
      }
    }
    const totalNow = Object.values(results).reduce((s, r) => s + r.tests, 0)
    const totalBase = baseline.totalTests ?? 0
    if (totalNow < totalBase) {
      failures.push('总用例数低于基线: 现 ' + totalNow + ' < 基线 ' + totalBase)
    }
    // 新类出现是好事：提示基线可升档，不算失败。
    for (const cls of classes) {
      if (results[cls] !== undefined && baseline.testsByClass?.[cls] === undefined) {
        notes.push('新增测试类（可升基线）: ' + cls + ' tests=' + results[cls].tests)
      }
    }
  }

  // C. 源码声明的 @Test 不得多于**实际运行**的用例数（issue #1345 / gotcha 369）。
  //    失效形态：@Test 写在类的闭合花括号之后 —— Kotlin 能编译、JUnit 不收集，报告里 tests 少几条，
  //    而 A/B 两条判据**全绿**（基线只升不降，少几条刚好也能过，如果同时删了别的用例甚至更宽松）。
  if (Array.isArray(sourceCounts)) {
    for (const entry of sourceCounts) {
      const present = entry.classes.filter((c) => results[c] !== undefined)
      if (present.length === 0) continue // A 已判红，不重复报
      const ran = present.reduce((s, c) => s + results[c].tests, 0)
      if (entry.annotations > ran) {
        failures.push('源码 @Test 多于实际运行（用例未被收集，常见于 @Test 写在类的闭合花括号之后）: '
          + entry.file + ' 源码 ' + entry.annotations + ' 条，实际运行 ' + ran + ' 条')
      }
    }
  }

  return { failures, notes }
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return null
  return JSON.parse(readFileSync(BASELINE, 'utf8'))
}

function buildBaseline(results, classes) {
  const testsByClass = {}
  let totalTests = 0
  for (const cls of classes) {
    const r = results[cls]
    if (!r) continue
    testsByClass[cls] = r.tests
    totalTests += r.tests
  }
  return {
    $comment:
      'Kotlin 单测基线（0.14.1）：只许升不许降。键=测试类名（=源文件名去 .kt），值=用例数。' +
      '逐类记录而非只记总数——防「删 A 类用例 + 加 B 类用例」净零抵消。' +
      '升档：node scripts/check-kotlin-test-count.mjs --update-baseline（会拒绝降档）。',
    totalTests,
    testsByClass,
  }
}

function selfTest() {
  const failures = []
  const check = (label, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
    if (!ok) failures.push(label)
  }
  const classes = ['AlphaTest', 'BetaTest']
  const base = { totalTests: 5, testsByClass: { AlphaTest: 3, BetaTest: 2 } }
  const mk = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, mtimeMs: 1000 }]))

  // ⑤ 正向：完全一致 → 判绿（证明不是恒红）
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 3, skipped: 0, failures: 0, errors: 0 }, BetaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: base,
    })
    check('正向：与基线一致 → 无失败（不是恒红）', r.failures.length === 0, r.failures.join('; '))
  }
  // ① 缺类 → 判红且点名
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 3, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: base,
    })
    check('反向：缺一个测试类 → 判红并点名 BetaTest',
      r.failures.some((f) => f.includes('BetaTest') && f.includes('缺席')) , r.failures.join('; '))
  }
  // ② 逐类下降 → 判红（总数不变也判红：Alpha -1、Beta +1 = 净零）
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 }, BetaTest: { tests: 3, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: base,
    })
    check('反向：总数净零但 Alpha 少 1 → 仍判红（逐类基线）',
      r.failures.some((f) => f.includes('AlphaTest') && f.includes('低于基线')), r.failures.join('; '))
  }
  // ③ 陈旧结果 → 判红
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 3, skipped: 0, failures: 0, errors: 0 }, BetaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: base, srcMtimeMs: 9999,
    })
    check('反向：结果早于源码（陈旧报告）→ 判红',
      r.failures.some((f) => f.includes('陈旧')), r.failures.join('; '))
  }
  // ④ 总数低于基线 → 判红
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 1, skipped: 0, failures: 0, errors: 0 }, BetaTest: { tests: 1, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: base,
    })
    check('反向：总数低于基线 → 判红', r.failures.length > 0, r.failures.join('; '))
  }
  // ⑥ 有失败用例 → 判红
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 3, skipped: 0, failures: 1, errors: 0 }, BetaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: base,
    })
    check('反向：存在失败用例 → 判红', r.failures.some((f) => f.includes('失败')), r.failures.join('; '))
  }

  // H-2：仲裁判据的正/反向（纯函数；真跑 gradle 的分支由本轮实测覆盖）
  check('仲裁：UP-TO-DATE ⇒ 内容等价（mtime 假阳性应放行）',
    arbitrationFromTaskLine('> Task :app:testDebugUnitTest UP-TO-DATE') === 'equivalent')
  check('仲裁：FROM-CACHE ⇒ 内容等价',
    arbitrationFromTaskLine('> Task :app:testDebugUnitTest FROM-CACHE') === 'equivalent')
  check('仲裁：真执行 ⇒ 已刷新（放行且重读报告）',
    arbitrationFromTaskLine('> Task :app:testDebugUnitTest') === 'executed')
  check('仲裁：输出无法判定 ⇒ unknown（调用方必须 fail-closed）',
    arbitrationFromTaskLine('') === 'unknown' && arbitrationFromTaskLine('something else') === 'unknown')

  console.log('')
  if (failures.length > 0) {
    console.error('KOTLIN-TEST-COUNT SELF-TEST FAILED: ' + failures.join(' / '))
    process.exit(1)
  }
  // ④ issue #1345：源码 @Test 多于实际运行 → 判红（类外 @Test 被静默丢弃的形态）
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 }, BetaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: null,
      sourceCounts: [{ file: 'AlphaTest.kt', classes: ['AlphaTest'], annotations: 3 }],
    })
    check('反向：源码 3 条 @Test 只跑了 2 条 → 判红并点名文件（类外 @Test 会被静默丢弃）',
      r.failures.some((f) => f.includes('多于实际运行') && f.includes('AlphaTest.kt')), r.failures.join('; '))
  }
  // ⑤ 同一条判据不得恒红：源码数与运行数相等 → 绿
  {
    const r = evaluate({
      results: mk({ AlphaTest: { tests: 3, skipped: 0, failures: 0, errors: 0 }, BetaTest: { tests: 2, skipped: 0, failures: 0, errors: 0 } }),
      classes, baseline: null,
      sourceCounts: [{ file: 'AlphaTest.kt', classes: ['AlphaTest'], annotations: 3 }],
    })
    check('正向：源码 3 条 @Test 跑了 3 条 → 不判红（判据不得恒红）',
      r.failures.length === 0, r.failures.join('; '))
  }
  console.log('KOTLIN-TEST-COUNT SELF-TEST PASSED（12 条：2 正向 + 7 反向 + 4 条仲裁判据）')
}

// ── main ──────────────────────────────────────────────────────────────────────
if (argv.includes('--self-test')) {
  selfTest()
} else {
  const classes = testSourceClasses()
  if (classes === null) {
    console.error('CHECK-KOTLIN-TEST-COUNT FAILED：找不到测试源目录 ' + TEST_SRC_DIR)
    process.exit(2)
  }
  const results = parseResults(RESULTS_DIR)
  if (results === null) {
    if (SKIP_REASON) {
      console.log('SKIP(#1) Kotlin 单测结果缺席（' + RESULTS_DIR + '）——本次未执行本判据')
      console.log('          先跑：./gradlew :app:testDebugUnitTest（CI 由 pr-gate 的对应步骤产出）')
      console.log('SKIP=1')
      process.exit(0)
    }
    console.error('CHECK-KOTLIN-TEST-COUNT FAILED：缺 Kotlin 单测结果 ' + RESULTS_DIR)
    console.error('  先跑 ./gradlew :app:testDebugUnitTest；无 gradle 的环境用 --allow-missing 显式 SKIP。')
    process.exit(1)
  }

  if (argv.includes('--update-baseline')) {
    const cur = loadBaseline()
    const next = buildBaseline(results, classes)
    if (cur) {
      // 只许升：任何 key 的用例数下降、或总数下降 → 拒绝写盘。
      const drops = []
      for (const [cls, need] of Object.entries(cur.testsByClass ?? {})) {
        const now = next.testsByClass[cls]
        if (now === undefined) drops.push(cls + '（类消失）')
        else if (now < need) drops.push(cls + ' ' + now + ' < ' + need)
      }
      if (next.totalTests < (cur.totalTests ?? 0)) drops.push('总数 ' + next.totalTests + ' < ' + (cur.totalTests ?? 0))
      if (drops.length > 0) {
        console.error('CHECK-KOTLIN-TEST-COUNT 拒绝降档基线：' + drops.join('; '))
        console.error('  基线只许升。若确实要减少用例，那是产品决定，必须显式改本文件并在 PR 里说明理由。')
        process.exit(1)
      }
    }
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n')
    console.log('BASELINE 已更新: totalTests=' + next.totalTests + ' classes=' + Object.keys(next.testsByClass).length)
    process.exit(0)
  }

  const baseline = loadBaseline()
  if (baseline === null) {
    console.error('CHECK-KOTLIN-TEST-COUNT FAILED：缺基线 ' + BASELINE)
    console.error('  首次生成：node scripts/check-kotlin-test-count.mjs --update-baseline')
    process.exit(1)
  }

  // 源码最新 mtime（用于陈旧性判据）。按**文件**取，不按类名反推路径——
  // 多类文件（如 CallSiteContractTest.kt 含两个测试类）会让 `<类名>.kt` 不存在。
  let srcMtimeMs = 0
  for (const f of readdirSync(TEST_SRC_DIR)) {
    if (!f.endsWith('.kt')) continue
    const t = statSync(join(TEST_SRC_DIR, f)).mtimeMs
    if (t > srcMtimeMs) srcMtimeMs = t
  }

  // H-2：mtime 只是**触发**。一旦它说陈旧，先问 gradle（唯一权威的内容哈希判据）再决定红/绿。
  const staleByMtime = Object.values(results).some((r) => r.mtimeMs < srcMtimeMs)
  let adjudicated = null
  // --allow-missing 只放宽「无结果」（上面那条路径）；陈旧度仲裁不受它影响——
  // 否则打包链（build-apk-013.ps1 带 --allow-missing 调本门禁）会在任何一次干净检出、
  // 重新物化工作树之后判红，而真相本可由 gradle 内容哈希判明（0.14.1 发版链实测）。
  if (staleByMtime) {
    adjudicated = arbitrateStaleness()
  }
  // 仲裁放行（内容等价或已刷新）时，用仲裁结果替代 mtime 判据：把 srcMtimeMs 归零即「不按 mtime 判红」。
  const effectiveSrcMtime = adjudicated !== null && adjudicated.arbitrated ? 0 : srcMtimeMs
  const effectiveResults = adjudicated !== null && adjudicated.arbitrated && adjudicated.refreshed !== null
    ? adjudicated.refreshed
    : results

  const { failures, notes } = evaluate({
    results: effectiveResults, classes, baseline, srcMtimeMs: effectiveSrcMtime,
    // issue #1345 / gotcha 369：源码声明的 @Test 必须真的都跑了（写在类外的会被静默丢弃）。
    sourceCounts: sourceAnnotationCounts(),
  })
  if (adjudicated !== null) {
    if (adjudicated.arbitrated) console.log('NOTE  ' + adjudicated.note)
    else failures.push('结果陈旧且无法仲裁：' + adjudicated.note)
  }
  const totalNow = Object.values(effectiveResults).reduce((s, r) => s + r.tests, 0)

  console.log('Kotlin 单测: 源测试类=' + classes.length + ' 有结果=' + Object.keys(results).length
    + ' 用例总数=' + totalNow + '（基线 ' + baseline.totalTests + '）')
  for (const n of notes) console.log('NOTE  ' + n)
  if (failures.length > 0) {
    for (const f of failures) console.error('FAIL  ' + f)
    console.error('CHECK-KOTLIN-TEST-COUNT FAILED（' + failures.length + ' 项）：防线数量/新鲜度/通过性不达标')
    process.exit(1)
  }
  console.log('CHECK-KOTLIN-TEST-COUNT PASSED（SKIP=0；逐类不低于基线 + 无缺席 + 结果新鲜 + 无失败用例）')
}

/**
 * 每个测试源文件里**声明了多少条 `@Test`**（issue #1345 / gotcha 369）。
 *
 * 为什么要这条判据：把 `@Test` 追加到类的闭合花括号之后，Kotlin **能编译通过**、JUnit 却
 * 不收集，于是「加了 3 条用例」没有任何编译期或运行期反馈——报告里的 `tests=` 少几条，
 * 而其余判据（基线只升不降）**全绿**。对齐「源码声明数 vs 实际运行数」是唯一的外部信号。
 *
 * 为什么不用「扫 `@Test` 的大括号深度」：Kotlin 字符串字面量里到处是 `{}`（本仓测试里有大量
 * `"{0}"` 与 JSON 片段），不处理字符串就会大面积假红；而完整处理原始字符串/转义/模板的成本
 * 超过它对这条低频陷阱的收益（试过一版，8 个文件误报，见 gotcha 369）。
 *
 * 这里只做「数注解」——注释先被剥掉，且比较方向是 `>=`（参数化/多跑几轮都不误判）。
 *
 * @returns {Array<{ file: string, classes: string[], annotations: number }>|null}
 */
function sourceAnnotationCounts() {
  if (!existsSync(TEST_SRC_DIR)) return null
  const out = []
  for (const f of readdirSync(TEST_SRC_DIR)) {
    if (!f.endsWith('.kt')) continue
    const text = readFileSync(join(TEST_SRC_DIR, f), 'utf8')
    // 与 testSourceClasses 同一套剥离：先块注释、再行注释，避免注释里的 `@Test` 被计入。
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    const annotations = (code.match(/(?:^|\n)\s*@Test\b/g) ?? []).length
    const re = /(?:^|\n)\s*(?:internal\s+|private\s+)?class\s+([A-Za-z0-9_]*Test)\b/g
    const classes = []
    let m
    while ((m = re.exec(code)) !== null) classes.push(m[1])
    if (classes.length === 0) classes.push(basename(f, '.kt'))
    out.push({ file: f, classes, annotations })
  }
  return out
}
