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
//   node scripts/check-kotlin-test-count.mjs --allow-missing     # 无结果时 SKIP 而非判红
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
 * 核心判据。`results` / `classes` / `baseline` 允许注入，便于 --self-test 构造反向对照。
 * @returns {{ failures: string[], notes: string[] }}
 */
export function evaluate({ results, classes, baseline, srcMtimeMs = 0 }) {
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

  console.log('')
  if (failures.length > 0) {
    console.error('KOTLIN-TEST-COUNT SELF-TEST FAILED: ' + failures.join(' / '))
    process.exit(1)
  }
  console.log('KOTLIN-TEST-COUNT SELF-TEST PASSED（6 条：1 正向 + 5 反向）')
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

  const { failures, notes } = evaluate({ results, classes, baseline, srcMtimeMs })
  const totalNow = Object.values(results).reduce((s, r) => s + r.tests, 0)

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
