// combo-probe-p1.test.mjs — P1 补丁回归：把 compose 探针送进产品内（0.14.1 块F，收口 C6 的 -1）。
//
// 背景：t_compose_total 在设备上 42/42 恒为 -1——探针从未接进产品。preload/注入方案结构性无效
// （T6 设备实测）：count-compose 的 TOTAL 只在 process.on('exit') 打印，落在 killExistingEngine() 内、
// 早于 rotateEngineLog() ⇒ 被搬进 engine.log.1；且 --import/NODE_OPTIONS 在 file-based worker 线程也
// 执行，worker 临终打 calls=0 而壳侧解析取最后一条 ⇒ 「非 -1 但为 0」的假绿（C6 只查 != -1，抓不到）。
// P1 把探针放进产品内 compose() 返回处（= LISTEN 之后、首个页面请求路径上，即 C2 要测的同步块）。
//
// 三条反证（派工要求逐条）：
//   ① 不装 P1 时，同一构造下**取不到** TOTAL 行（保持 -1/unknown 语义）；
//   ② 装了 P1 后，同一构造能取到真实值（calls/totalMs/records 与实测一致）；
//   ③ 断言**不得用 worker 线程的 TOTAL 冒充**：构造含 worker 的场景，证明壳侧口径（取最后一条 TOTAL）
//      取到的是主线程真读数、且 worker 侧根本不打探针；并证明若允许 worker 打印会得到 0 的假绿。
//
// 用法：node scripts/patches/tests/combo-probe-p1.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-client-modules-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('function not found: ' + signature)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}
/** 壳侧解析口径（T6 已定稿）：取**最后一条** TOTAL 行。 */
function parseShellProbeTotal(text) {
  const matches = [...String(text).matchAll(/\[perf\] TOTAL calls=(\d+) totalMs=(\d+)/g)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  return { calls: Number(last[1]), totalMs: Number(last[2]) }
}
/** 与 scripts/check-boot-budget.mjs 的 parseProbe 同源字段口径。 */
function parseGateProbe(text) {
  const body = String(text)
  const total = /\[perf\] TOTAL calls=(\d+) totalMs=(\d+)/.exec(body)
  const durs = [...body.matchAll(/\[perf\] compose #(\d+) at=(\d+)ms dur=(\d+)ms/g)].map((m) => Number(m[3]))
  const singles = /singles=(\d+)/.exec(body)
  const p99 = /loopP99Ms=([\d.]+|-?\d+)/.exec(body)
  const samples = /loopSamples=(\d+)/.exec(body)
  return {
    hasProbe: total !== null,
    calls: total ? Number(total[1]) : undefined,
    totalMs: total ? Number(total[2]) : undefined,
    maxDur: durs.length > 0 ? Math.max(...durs) : undefined,
    singles: singles ? Number(singles[1]) : undefined,
    loopP99Ms: p99 ? Number(p99[1]) : undefined,
    loopSamples: samples ? Number(samples[1]) : undefined,
  }
}
/** 抽出类 + 全部依赖 helper + 探针块，供 node 进程内真实调用 compose()（与 C3 测试同法）。 */
function buildFixtureModule(source) {
  const grab = (signature) => extractFunction(source, signature)
  const classSrc = (() => {
    const start = source.indexOf('var ClientModuleRegistry = class extends Service {')
    let depth = 0
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, i + 2)
      }
    }
    throw new Error('class not found')
  })()
  const consts = ['SOURCE_MAP_TRAILER', 'SOURCE_URL_TRAILER', 'HASH_REVISION_LENGTH', 'COMBO_REVISION_PLACEHOLDER',
    'MAX_COMBO_URL_BYTES', 'IMMUTABLE_CACHE', 'CLIENT_MODULES_ID', 'PARSER_PRELOAD_IDS'].map((name) => {
    const m = source.match(new RegExp('const ' + name + ' = [^\\n]+'))
    if (!m) throw new Error('const not found: ' + name)
    return m[0]
  }).join('\n')
  const a3Report = grab('function dshMobileComboCacheReport() {')
  const a3Start = source.indexOf('/* dsh-mobile combo cache (A3)')
  const a3Block = source.slice(a3Start, source.indexOf(a3Report) + a3Report.length)
  const a5Start = source.indexOf('/* dsh-mobile combo single lazy (A5)')
  const a5End = source.indexOf('\n', source.indexOf('Object.defineProperty(globalThis, "__dshMobileComboLazyStats"', a5Start))
  const a5Block = source.slice(a5Start, a5End)
  const c3Start = source.indexOf('Object.defineProperty(globalThis, "__dshMobileComboLazyStats"')
  const c3End = grab('function dshMobileComboPrepareRecords(records) {')
  const c3Block = source.slice(source.indexOf('\n', c3Start) + 1, source.indexOf(c3End) + c3End.length)
  // 注意：P1 注释在文件里出现两次，锚在唯一的 stats 常量上（否则会从 import 段起切）。
  const probeStart = source.indexOf('const DSH_MOBILE_COMBO_PROBE_STATS = {')
  if (probeStart < 0) throw new Error('P1 probe block not found')
  const probeSrc = source.slice(probeStart, source.indexOf('export { ClientModuleRegistry', probeStart))
  return [
    'import { monitorEventLoopDelay } from "node:perf_hooks";',
    'import { isMainThread } from "node:worker_threads";',
    'import { createHash, randomBytes } from "node:crypto";',
    'import { existsSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { availableParallelism } from "node:os";',
    'import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";',
    'const Service = class { constructor() {} };',
    consts,
    a5Block,
    c3Block,
    grab('function shortHash(input) {'),
    grab('function framedHash(domain, parts) {'),
    grab('function comboUrl(ids, rev, sourceMap = false) {'),
    grab('function projectedComboUrlBytes(records) {'),
    grab('function partitionComboRecords(records) {'),
    grab('function comboSource(record) {'),
    grab('function comboScript(input, sourceMapUrl) {'),
    grab('function newlineCount(value) {'),
    grab('function comboSectionMap(record) {'),
    grab('function identitySectionMap(source, sourceUrl) {'),
    a3Block,
    grab('function buildCombo(records, revision) {'),
    grab('function buildBatch(phase, records) {'),
    grab('function graphRow(id, rev, fields) {'),
    grab('function orderByModuleGraph(entries) {'),
    `const ClientModuleRegistry = ${classSrc.replace(/^var ClientModuleRegistry = /, '')}`,
    probeSrc,
    'export { ClientModuleRegistry };',
  ].join('\n')
}

const scratch = mkdtempSync(join(tmpdir(), 'p1-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  const fixtureText = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')
  writeFileSync(target, fixtureText)

  const applyOnly = (ids) => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', ids],
    { encoding: 'utf8' })
  const CHAIN = 'combo-lazy-A4,combo-cache-A3,combo-single-lazy-A5,combo-parallel-C3,combo-probe-P1'
  const chainMinusP1 = 'combo-lazy-A4,combo-cache-A3,combo-single-lazy-A5,combo-parallel-C3'

  // ── ① 不装 P1 的臂（先固化文本）──
  const withoutP1 = applyOnly(chainMinusP1)
  check('① 前置链（A4+A3+A5+C3）施加成功', withoutP1.status === 0,
    (withoutP1.stdout || withoutP1.stderr || '').trim().split('\n').slice(-2).join(' | '))
  const noProbeText = readFileSync(target, 'utf8')
  check('① 未装 P1 时产品内无探针（无 [perf] TOTAL 产出点）',
    !noProbeText.includes('dshMobileComboProbeEmit'))

  // ── 装上 P1（第二次 apply 针对同文件增量）──
  const withP1 = applyOnly(CHAIN)
  check('apply-patches exits 0（A4+A3+A5+C3+P1）', withP1.status === 0,
    (withP1.stdout || withP1.stderr || '').trim().split('\n').slice(-2).join(' | '))
  const patched = readFileSync(target, 'utf8')
  check('P1 marker 在场', patched.includes('dsh-mobile combo probe (P1)'))
  check('探针打印器在场', patched.includes('dshMobileComboProbeEmit'))
  check('主线程门在场（worker 不得打探针）',
    patched.includes('if (!isMainThread) {') && patched.includes('import { isMainThread } from "node:worker_threads";'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])

  // ── 幂等：再 apply 一次 changed=0 / 文件不变 ──
  const before = readFileSync(target, 'utf8')
  const again = applyOnly(CHAIN)
  check('re-apply 幂等（文件逐字节不变，changed=0）',
    again.status === 0 && readFileSync(target, 'utf8') === before,
    (again.stdout || '').trim().split('\n').slice(-1)[0])

  // ── 行为臂：把 patched 的类 + 探针块抽成可运行模块，主线程跑一次 compose ──
  // 驱动脚本用真实 ctx 桩满足构造期（on/loader.entries/get/inject/effect），再调一次 compose()。
  const patchedMod = join(scratch, 'patched-probe.mjs')
  writeFileSync(patchedMod, buildFixtureModule(patched))
  const driver = join(scratch, 'drive.mjs')
  writeFileSync(driver, [
    'process.env.DSH_COMBO_CACHE = "";',
    `const m = await import(${JSON.stringify(pathToFileURL(patchedMod).href)});`,
    'const ctx = {',
    '  on: () => {},',
    '  loader: { entries: () => [] },',
    '  effect: (cb) => cb(),',
    '  webServer: { register: () => () => {} },',
    '  get: () => undefined,',
    '  inject: () => {},',
    '  logger: { warn: () => {}, error: () => {} },',
    '};',
    'const registry = new m.ClientModuleRegistry(ctx);',
    'registry.compose();',
  ].join('\n'))
  const mainRun = spawnSync(process.execPath, [driver], { encoding: 'utf8' })
  const mainOut = (mainRun.stdout || '') + (mainRun.stderr || '')
  const shellTotal = parseShellProbeTotal(mainOut)
  const gate = parseGateProbe(mainOut)

  // ── ② 装了 P1：同一构造能取到真实值（不再是 -1/unknown）──
  check('② 壳侧口径取到 TOTAL 行（非 unknown，即不再是 -1 语义）', shellTotal !== null,
    'exit=' + mainRun.status + ' output=' + mainOut.split('\n').slice(0, 4).join(' | ').slice(0, 240))
  check('② 门禁口径 hasProbe=true（C6/C2 可判定）', gate.hasProbe === true, 'hasProbe=' + gate.hasProbe)
  check('② 取到真实 calls=1（一次组合）', shellTotal && shellTotal.calls === 1,
    'calls=' + (shellTotal && shellTotal.calls))
  check('② 取到真实 totalMs ≥ 0（非 -1）', shellTotal && shellTotal.totalMs >= 0, 'totalMs=' + (shellTotal && shellTotal.totalMs))
  check('② C2 需要的单次 dur 在场（maxDur 为有限数）', gate.maxDur !== undefined && Number.isFinite(gate.maxDur),
    'maxDur=' + gate.maxDur)
  check('② C4 字段齐备且无值时报 -1（不得省字段）',
    gate.loopP99Ms !== undefined && gate.loopSamples !== undefined,
    'loopP99Ms=' + gate.loopP99Ms + ' loopSamples=' + gate.loopSamples)
  check('② C5 singles 字段在场（无 A5 统计时报 -1，不省略）', gate.singles !== undefined, 'singles=' + gate.singles)
  check('② 输出行与定稿格式逐字一致（compose 行 + TOTAL 行字段序）',
    /\[perf\] compose #1 at=\d+ms dur=\d+ms instances=1 records=-?\d+ singles=-?\d+ comboCache=/.test(mainOut)
    && /\[perf\] TOTAL calls=1 totalMs=\d+ instances=1 firstAt=(\d+ms|-1) singles=-?\d+ loopP99Ms=([\d.]+|-1) loopSamples=(-?\d+) comboCache=/.test(mainOut),
    mainOut.split('\n').filter((l) => l.includes('[perf]')).join(' | ').slice(0, 260))
  // 产品内也产出 C5 的反向判据行（不再依赖测量 preload；否则设备上 C5 永久不可判）。
  check('② C1~C6 可判性：产品内产出 C5 反向判据行 `[perf] boot singles=`',
    /\[perf\] boot singles=-?\d+ records=-?\d+/.test(mainOut),
    mainOut.split('\n').filter((l) => l.includes('[perf] boot')).join(' | ').slice(0, 160))

  // ── ① 反证：不装 P1 时，同一构造取不到 TOTAL（保持 -1/unknown 语义）──
  const withoutMod = join(scratch, 'without-probe.mjs')
  const noProbeClass = noProbeText.slice(noProbeText.indexOf('var ClientModuleRegistry = class extends Service {'))
  const noProbeClassEnd = (() => {
    let depth = 0
    for (let i = noProbeClass.indexOf('{'); i < noProbeClass.length; i += 1) {
      if (noProbeClass[i] === '{') depth += 1
      else if (noProbeClass[i] === '}') {
        depth -= 1
        if (depth === 0) return noProbeClass.slice(0, i + 2)
      }
    }
    throw new Error('unbalanced')
  })()
  writeFileSync(withoutMod, [
    'import { monitorEventLoopDelay } from "node:perf_hooks";',
    'const Service = class { constructor() {} };',
    `const ClientModuleRegistry = ${noProbeClassEnd.replace(/^var ClientModuleRegistry = /, '')}`,
    'export { ClientModuleRegistry };',
  ].join('\n'))
  const noProbeRun = spawnSync(process.execPath, ['-e',
    `import(${JSON.stringify(pathToFileURL(withoutMod).href)}).then((m) => { new m.ClientModuleRegistry(); })`
    + '.catch((e) => { console.error(e); process.exit(1); });',
  ], { encoding: 'utf8' })
  const noProbeOut = (noProbeRun.stdout || '') + (noProbeRun.stderr || '')
  check('① 反证：不装 P1 时壳侧取不到 TOTAL 行（保持 -1/unknown 语义）',
    parseShellProbeTotal(noProbeOut) === null && parseGateProbe(noProbeOut).hasProbe === false,
    'output=' + noProbeOut.split('\n').filter((l) => l.includes('[perf]')).join(' | ').slice(0, 160))

  // ── ③ 反证：worker 线程的 TOTAL 不得冒充主线程读数 ──
  // 关键：worker 必须**真的载入模块并在 worker 线程内调用 compose()**——只载入不组合的话，
  // 即使没有主线程门也不会有 TOTAL，那样的对照是空的（不承重）。
  const inWorker = join(scratch, 'run-in-worker.mjs')
  writeFileSync(inWorker, [
    'import { Worker } from "node:worker_threads";',
    'const modulePath = process.argv[2];',
    'const worker = new Worker(new URL("./worker-body.mjs", import.meta.url), { workerData: modulePath });',
    'worker.on("error", (e) => { console.error("WORKER-ERROR " + e.message); process.exit(1); });',
    // 用 exit 保证 worker 的 stdout 已 flush 完再退。
    'worker.on("exit", (code) => process.exit(code === 0 ? 0 : 1));',
  ].join('\n'))
  writeFileSync(join(scratch, 'worker-body.mjs'), [
    'import { workerData } from "node:worker_threads";',
    'const mod = await import(workerData);',
    'const ctx = { on: () => {}, loader: { entries: () => [] }, effect: (cb) => cb(),',
    '  webServer: { register: () => () => {} }, get: () => undefined, inject: () => {},',
    '  logger: { warn: () => {}, error: () => {} } };',
    'new mod.ClientModuleRegistry(ctx).compose();',
  ].join('\n'))
  const runInWorker = (modulePath) => spawnSync(process.execPath, [inWorker, modulePath],
    { encoding: 'utf8', env: { ...process.env, DSH_COMBO_CACHE: '' } })
  const workerRun = runInWorker(pathToFileURL(patchedMod).href)
  const workerOut = (workerRun.stdout || '') + (workerRun.stderr || '')
  const workerTotal = parseShellProbeTotal(workerOut)
  check('③ 反证：worker 线程内真的组合了一次，但 P1 不打探针（主线程门生效，无 TOTAL 行）',
    workerTotal === null && parseGateProbe(workerOut).hasProbe === false,
    'worker exit=' + workerRun.status + ' output=' + workerOut.split('\n').filter((l) => l.includes('[perf]')).join(' | ').slice(0, 200))
  check('③ 反证：主线程真读数 calls=1 ≠ worker 若冒充会得到的 calls=0（口径不可被 0 覆盖）',
    shellTotal !== null && shellTotal.calls === 1 && shellTotal.calls !== 0,
    'main calls=' + (shellTotal && shellTotal.calls))

  // ── ③b 反向对照：把主线程门替换为恒 false（模拟坏形态），证明**同一个 worker 场景**下
  // worker 的读数会真的产出——这才是「这门是承重的」的实证，也是 (b) 方案假绿的形态复现。
  {
    const brokenMod = join(scratch, 'broken-no-gate.mjs')
    const patchedWithGate = readFileSync(patchedMod, 'utf8')
    const brokenSrc = patchedWithGate.replace('if (!isMainThread) {', 'if (false) {')
    check('③b 坏形态构造成功（主线程门被替换为恒 false）',
      brokenSrc !== patchedWithGate && brokenSrc.includes('if (false) {'))
    writeFileSync(brokenMod, brokenSrc)
    const brokenRun = runInWorker(pathToFileURL(brokenMod).href)
    const brokenOut = (brokenRun.stdout || '') + (brokenRun.stderr || '')
    const brokenTotal = parseShellProbeTotal(brokenOut)
    check('③b 坏形态下 worker 内组合会产出 TOTAL（无门即泄漏，输出含 TOTAL 行）',
      brokenTotal !== null,
      'output=' + brokenOut.split('\n').filter((l) => l.includes('[perf]')).join(' | ').slice(0, 200))
    check('③b 对照成立：同一 worker 场景，有门静默 / 无门产出 TOTAL（门是承重的）',
      workerTotal === null && brokenTotal !== null,
      'gated=' + JSON.stringify(workerTotal) + ' ungated=' + JSON.stringify(brokenTotal))
    // 假绿的精确形态：泄漏出来的那条读数 totalMs >= 0，于是「!= -1」的 C6 判据**照样放行**它——
    // 即无门形态下门禁无法区分「主线程真实读数」与「某个 worker 线程的读数」。
    check('③b 泄漏读数对 C6 不可区分（totalMs >= 0 ⇒ `!= -1` 判据照样放行，这是假绿的精确形态）',
      brokenTotal !== null && brokenTotal.totalMs >= 0,
      'ungated=' + JSON.stringify(brokenTotal))

    // ③c 顺序危害（壳侧口径 = 取**最后一条** TOTAL）：把主线程真读数与泄漏读数放进同一条流，
    // 证明「取最后一条」会被后到的 worker 读数替换。这是 (b) 方案在本仓口径下的具体失效路径。
    const combined = mainOut + '\n' + brokenOut
    const combinedTotal = parseShellProbeTotal(combined)
    check('③c 顺序危害：主线程真读数在前、worker 泄漏读数在后时，壳侧「取最后一条」取到的是泄漏读数',
      shellTotal !== null && combinedTotal !== null
      && combinedTotal.calls === brokenTotal.calls
      && combinedTotal.totalMs === brokenTotal.totalMs,
      'main=' + JSON.stringify(shellTotal) + ' combined(last)=' + JSON.stringify(combinedTotal))
  }

  console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
  process.exit(failures.length === 0 ? 0 : 1)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
