// combo-probe-P1.test.mjs — compose 探针在 rc.1 上的安装回归（0.14.1 块F P0-2，0.14.2 随版重写）。
//
// P1 的产品意义：设备上 `t_compose_total` 曾恒为 -1，因为 `[perf] TOTAL` 只有**测量 preload** 会产，
// 而发行路径里没有探针——「我们在量」与「壳侧读得到」互相假装成立。P1 把探针装进引擎产物本身。
//
// 本测试守四件事（combo 家族 A3/A4/A5/C3 全部撤销后，P1 是仅存的 combo 侧补丁，且已无前置）：
//   ① 前置声明与登记表一致（requires 里的 id 都存在，且不牵连已撤销的补丁）；
//   ② 在**未打补丁的 rc.1 真产物夹具**上可施加、幂等、且 `node --check` 过；
//   ③ TOTAL 同步输出并保留壳侧/count-compose 的解析契约；
//   ④ 主线程门：worker 不得成为 TOTAL 的最后一个打印者（0.14.1 的假绿形态）。
//
// 用法：node scripts/patches/tests/combo-probe-p1.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const FIXTURE = versionedFixture('dsh-client-modules', 'lib', 'index.js')

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const registry = JSON.parse(readFileSync(join(here, '..', 'registry.json'), 'utf8'))
const p1 = registry.patches.find((p) => p.id === 'combo-probe-P1')
check('P1 在登记表内且 scope=engine', Boolean(p1) && p1.scope === 'engine')
check('P1 前置全部存在（不牵连已撤销的 combo 补丁；A4 退役后应为空）',
  (p1.requires ?? []).every((id) => registry.patches.some((x) => x.id === id)), JSON.stringify(p1.requires ?? []))
check('P1 的 requires 为空（A4 退役后无前置）',
  JSON.stringify(p1?.requires ?? []) === JSON.stringify([]), JSON.stringify(p1?.requires ?? null))

const scratch = mkdtempSync(join(tmpdir(), 'p1-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(FIXTURE, target)
  const pristine = readFileSync(target, 'utf8')
  check('前置：夹具是未打本方补丁的真产物', !pristine.includes('dsh-mobile'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine',
      '--only', 'combo-probe-P1,client-registry-scan-C4'], { encoding: 'utf8' })
  const first = apply()
  check('P1 在 rc.1 真产物上施加成功（A4 已于 2026-09-25 退役，不再作为前置）', first.status === 0,
    (first.stdout + first.stderr).trim().split('\n').slice(-2).join(' | '))
  const patched = readFileSync(target, 'utf8')
  check('探针标记与打印器在场',
    patched.includes('dsh-mobile combo probe (P1)') && patched.includes('dshMobileComboProbeEmit'))
  check('C3 启动收敛与空图初始化逻辑已安装',
    patched.includes('dshMobileComboProbeStartupFlush') && patched.includes('dshMobileComboProbeEmptyGraph'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('打过探针的产物可被 node 解析', parse.status === 0, (parse.stderr || '').split('\n')[0])
  apply()
  check('再施加零改动（幂等）', readFileSync(target, 'utf8') === patched)

  // ③ 解析契约：三行各自的字段集合（壳侧 LogCollector 与 scripts/perf/count-compose.mjs 按此解析）
  const composeLine = (patched.match(/console\.log\(`\[perf\] compose [^\n]*/) || [''])[0]
  const totalLine = (patched.match(/console\.log\(`\[perf\] TOTAL[^\n]*/) || [''])[0]
  check('compose 行字段齐全（#n/at/dur/instances/records/singles/cache）',
    ['at=', 'dur=', 'instances=', 'records=', 'singles='].every((f) => composeLine.includes(f)), composeLine.slice(0, 80))
  check('TOTAL 行字段齐全（调用累计 + 同步 C4 loop/cache 快照）',
    ['calls=', 'totalMs=', 'instances=', 'firstAt=', 'singles='].every((f) => totalLine.includes(f))
    && totalLine.includes('${dshMobileComboProbeLoopLine()}') && totalLine.includes('${cache}'), totalLine.slice(0, 100))
  check('TOTAL 在 compose emit 中同步输出且不存在排队历史',
    patched.includes('console.log(`[perf] TOTAL calls=${stats.calls}')
      && !patched.includes('dshMobileComboProbeTotals') && !patched.includes('dshMobileComboProbeScheduleTotals'))
  check('phase 使用固定阶段 allowlist/Map 聚合，250ms deadline 不被后续事件重置',
    patched.includes('dshMobileComboProbePhaseNames = new Set(')
      && patched.includes('dshMobileComboProbePhases = new Map()')
      && patched.includes('if (dshMobileComboProbePhaseTimer !== void 0) return;')
      && patched.includes('}, dshMobileComboProbePhaseWindowMs)')
      && patched.includes('dshMobileComboProbePhases.clear()'))
  check('启动阶段诊断与 TOTAL 契约分离，且相位名和值语义固定',
    patched.includes('[perf] phase name=${phase.name}')
    && ['constructor-flush', 'loader-settle-wait', 'deferred-startup-flush', 'loader-settle-to-first-compose-start']
      .every((name) => patched.includes(name)), '缺阶段字段或阶段名')
  const loopLine = (patched.match(/function dshMobileComboProbeLoopLine\(\) \{[\s\S]*?\n\}/) || [''])[0]
  check('loop 字段无 monitor 时打印 -1（省字段与造假同级）',
    loopLine.includes('loopP99Ms=-1 loopSamples=-1') && loopLine.includes('loopP99Ms='))
  const scheduleLine = (patched.match(/function dshMobileComboProbeSchedulePhases\(\) \{[\s\S]*?\n\}/) || [''])[0]
  check('phase timer unref 且只启动一次，不触碰 C4 monitor',
    scheduleLine.includes('if (dshMobileComboProbePhaseTimer !== void 0) return;')
      && scheduleLine.includes('unref?.()') && scheduleLine.includes('dshMobileComboProbePhases.clear()')
      && !scheduleLine.includes('dshMobileComboProbeLoopLine'))
  check('cache/singles 以哨兵值缺席而非省字段',
    patched.includes('"comboCache=none hits=0 misses=0"') && /\? value : -1/.test(patched))
  // C4 口径反证（2026-10-06 设备根因）：monitorEventLoopDelay 对「与 enable() 同 tick 开始的同步块」
  // 结构性失明（设备实测：2.0s 整段阻塞被读成 11ms）。装进产品的必须是自建、arming 时锚定墙钟基线
  // 的采样器，而不是该 API。缺了这条，旧实现会一路绿到设备上再次把卡顿报成健康。
  check('C4 采样器 arming 时锚定基线（不是 monitorEventLoopDelay）',
    patched.includes('dshMobileComboProbeArmLoopSampler')
      && patched.includes('let last = performance.now();')
      && patched.includes('function dshMobileComboProbeLoopHistogram()')
      && !patched.includes('monitorEventLoopDelay('),
    'arm=' + patched.includes('dshMobileComboProbeArmLoopSampler')
      + ' anchor=' + patched.includes('let last = performance.now();')
      + ' blindApi=' + patched.includes('monitorEventLoopDelay('))
  check('C4 采样器在模块加载期即刻 arming（推迟会让基线落在块之后）',
    /dshMobileComboProbeArmLoopSampler\(\);/.test(patched))
  // ④ 主线程门：非主线程块必须是**空**的，探针安装只发生在 else 分支
  const gateAt = patched.indexOf('if (!isMainThread) {')
  const elseAt = patched.indexOf('} else {', gateAt)
  const wrapAt = patched.indexOf('dshMobileComboProbeProto.compose = function')
  check('worker 不安装探针（gate 块内无打印，安装在 else 分支）',
    gateAt >= 0 && elseAt > gateAt && wrapAt > elseAt, `gate=${gateAt} else=${elseAt} wrap=${wrapAt}`)

  // 行为夹具：三个分时到达的启动 Fiber 必须保留 dirty，loader settle 后只发布一次完整图；
  // 运行期增删仍即时 flush，rebuilt/HMR 仍同步 compose。使用同一个 await Promise 模拟 DSH barrier。
  const cordis = join(scratch, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis')
  mkdirSync(cordis, { recursive: true })
  writeFileSync(join(cordis, 'package.json'), '{"name":"@deepseek-ai/cordis","type":"module","exports":"./index.js"}')
  writeFileSync(join(cordis, 'index.js'), 'export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }')
  const moduleUrl = `${pathToFileURL(target).href}?behavior=${Date.now()}`
  const { ClientModuleRegistry } = await import(moduleUrl)
  let settle
  const loaderWait = new Promise((resolve) => { settle = resolve })
  const listeners = new Map()
  const entries = []
  const errors = []
  const ctx = {
    loader: { entries: () => entries, await: () => loaderWait },
    logger: { warn: (error) => errors.push(error), error: (error) => errors.push(error) },
    on: (name, listener) => { const rows = listeners.get(name) ?? []; rows.push(listener); listeners.set(name, rows) },
    inject: () => {},
    emit: (name, payload) => { for (const listener of listeners.get(name) ?? []) listener(payload) },
  }
  const composeLines = []
  const totalLines = []
  const phaseLines = []
  const originalLog = console.log
  console.log = (...args) => {
    if (String(args[0]).startsWith('[perf] compose')) composeLines.push(String(args[0]))
    else if (String(args[0]).startsWith('[perf] TOTAL')) totalLines.push(String(args[0]))
    else if (String(args[0]).startsWith('[perf] phase')) phaseLines.push(String(args[0]))
    else originalLog(...args)
  }
  try {
    const registryInstance = new ClientModuleRegistry(ctx)
    const emptyHash = createHash('sha1').update(JSON.stringify({ entries: [], batches: [] })).digest('hex').slice(0, 12)
    check('初始空图保持原 compose shape/hash，构造期间 compose 次数为0',
      registryInstance.graph().rev === emptyHash && Array.isArray(registryInstance.graph().entries)
        && Array.isArray(registryInstance.graph().batches) && registryInstance.graph().entries.length === 0
        && composeLines.length === 0 && totalLines.length === 0, `compose=${composeLines.length} total=${totalLines.length}`)
    const appRoot = join(scratch, 'behavior-app')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(appRoot, 'entry.mjs'), '')
    const active = []
    const addFiber = (n) => {
      const name = `fixture-plugin-${n}`
      const pkg = join(appRoot, 'node_modules', name)
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name, type: 'module', exports: { './client': './client.js', './package.json': './package.json' },
        dsh: { client: { platform: 'web' } },
      }))
      writeFileSync(join(pkg, 'client.js'), `export const plugin${n} = ${n};\n`)
      const entry = { options: { name }, fiber: {}, disabled: false, parent: { tree: { ctx: { baseUrl: pathToFileURL(join(appRoot, 'entry.mjs')).href } } } }
      entries.push(entry)
      active.push(entry)
      ctx.emit('internal/plugin', { entry })
    }
    const readyOrder = []
    registryInstance.onGraphChanged(() => readyOrder.push(`graph:${registryInstance.graph().entries.length}`))
    loaderWait.then(() => readyOrder.push(`ready:${registryInstance.graph().entries.length}`))
    addFiber(1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    addFiber(2)
    await new Promise((resolve) => setTimeout(resolve, 15))
    addFiber(3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('loader settle 前不丢失多批 activation、无半成品 graph 且 compose 次数仍为0',
      registryInstance.graph().entries.length === 0 && composeLines.length === 0, `graph=${registryInstance.graph().entries.length} compose=${composeLines.length}`)
    settle()
    await loaderWait
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('loader settle 发布完整图且先于 ready continuation',
      registryInstance.graph().entries.length === 3 && readyOrder[0] === 'graph:3' && readyOrder.at(-1) === 'ready:3', readyOrder.join(' → '))
    check('多个延迟启动 Fiber 合并为单次实际 compose（累计次数恰为1）', composeLines.length === 1, String(composeLines.length))
    check('首次 TOTAL 与 compose 同步出现并带有效 C4 哨兵/快照字段',
      totalLines.length === 1 && /calls=1 .*loopP99Ms=(-1|\d+(?:\.\d+)?) loopSamples=(-1|\d+)/.test(totalLines[0]),
      totalLines.at(-1))
    const beforeAdd = registryInstance.graph().entries.length
    addFiber(4)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('settle 后运行期 add 仍在下个 microtask 即时可见且 TOTAL 同步',
      beforeAdd === 3 && registryInstance.graph().entries.length === 4 && totalLines.length === composeLines.length)
    entries.splice(entries.indexOf(active[0]), 1)
    ctx.emit('internal/plugin', { entry: active[0] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('settle 后运行期 remove 仍即时可见且 TOTAL 同步',
      registryInstance.graph().entries.length === 3 && totalLines.length === composeLines.length)
    const beforeHmrCalls = composeLines.length
    const hmrPath = registryInstance.clientPath('fixture-plugin-2')
    const stamp = new Date(Date.now() + 2500)
    writeFileSync(hmrPath, 'export const plugin2 = 222222;\n')
    utimesSync(hmrPath, stamp, stamp)
    registryInstance.rebuilt('fixture-plugin-2')
    check('HMR rebuilt 保持同步 compose/TOTAL/通知语义',
      composeLines.length === beforeHmrCalls + 1 && totalLines.length === composeLines.length)
    for (let i = 0; i < 256; i++) registryInstance.rebuilt('fixture-plugin-2')
    check('连续 256 次 compose 均即时输出 TOTAL，累计 calls 同步增长',
      totalLines.length === composeLines.length
        && new RegExp(`calls=${composeLines.length} `).test(totalLines.at(-1)),
      `compose=${composeLines.length} total=${totalLines.length} last=${totalLines.at(-1)}`)
    await new Promise((resolve) => setTimeout(resolve, 275))
    const parsedPhases = phaseLines.map((line) => {
      const match = /^\[perf\] phase name=(\S+) startMs=([\d.]+) durTotalMs=([\d.]+) durMaxMs=([\d.]+) observations=(\d+) forwardedCallbacks=(\d+)$/.exec(line)
      return match && { name: match[1], startMs: Number(match[2]), total: Number(match[3]), max: Number(match[4]), observations: Number(match[5]), callbacks: Number(match[6]) }
    }).filter(Boolean)
    check('启动阶段测量在固定窗口后可观察，数值有限非负且聚合语义明确',
      ['constructor-flush', 'loader-settle-wait', 'deferred-startup-flush', 'loader-settle-to-first-compose-start']
        .every((name) => parsedPhases.some((phase) => phase.name === name))
        && parsedPhases.every((phase) => [phase.startMs, phase.total, phase.max, phase.observations, phase.callbacks].every(Number.isFinite)
          && phase.startMs >= 0 && phase.total >= phase.max && phase.max >= 0 && phase.observations >= 1 && phase.callbacks >= 0),
      phaseLines.join(' | '))
    const deferred = parsedPhases.find((phase) => phase.name === 'deferred-startup-flush')
    check('deferred phase 的 observations 与 forwarded callback 数分开表达',
      deferred?.observations === 1 && deferred.callbacks === 3, JSON.stringify(deferred))

    const phaseCountBeforeFlood = phaseLines.length
    const FLOOD_ROUNDS = 16
    const floodStartedAt = Date.now()
    let finalizedDuringFlood = false
    for (let i = 0; i < FLOOD_ROUNDS; i++) {
      new ClientModuleRegistry(ctx)
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (i >= 10 && phaseLines.length > phaseCountBeforeFlood) finalizedDuringFlood = true
    }
    check('phase 持续到达时仍按固定 deadline 收口，不等静默 debounce', finalizedDuringFlood,
      `before=${phaseCountBeforeFlood} after=${phaseLines.length}`)
    await new Promise((resolve) => setTimeout(resolve, 275))
    const floodElapsedMs = Date.now() - floodStartedAt
    const floodRows = phaseLines.slice(phaseCountBeforeFlood).filter((line) => line.includes('name=constructor-flush '))
    // 断言的**是被守着的不变量，不是这台机器的速度**。
    // 旧判据写死 `<= 2`，实际在断言「这段洪水必须在 2 个窗口（500ms）内跑完」——窗口本身是 250ms
    // （dshMobileComboProbePhaseWindowMs），而 16 轮 × 25ms 的 sleep 加上每轮构造的真实开销必然落在
    // 1~3 个窗口里。机器一慢（或构造变重）就 3 行 ⇒ 假红。实测本机稳定 3 行、且纯净 origin/main 上同样红。
    // 真正要守的两件事：① 有记录（不是被静默丢弃）；② **聚合**——行数由窗口数决定、远少于事件数
    // （若退化成事件级 push，16 轮会产出 16 行）。故按实测耗时算窗口上界，并明确要求行数 < 轮数。
    const maxWindows = Math.ceil(floodElapsedMs / 250) + 1
    check('重复 phase 记录聚合到固定阶段行（行数由 250ms 窗口数决定，不随事件数增长）',
      floodRows.length > 0 && floodRows.length < FLOOD_ROUNDS && floodRows.length <= maxWindows
        && !patched.includes('dshMobileComboProbePhases.push'),
      `constructorRows=${floodRows.length} rounds=${FLOOD_ROUNDS} elapsedMs=${floodElapsedMs} maxWindows=${maxWindows}`)
  } finally {
    console.log = originalLog
  }
  check('行为夹具无 activation/compose 报错', errors.length === 0, errors.map(String).join(' | '))

  // ⑤ C4 采样器行为反证（2026-10-06）：把「与 arming 同 tick 的同步块」喂给装进产品的采样器，
  //    它必须看见整段。旧实现（monitorEventLoopDelay）在同一场景下恒报 ~11ms（设备 2.0s 块被报成
  //    11ms），本用例就是为那个假绿形态存在的：换回旧 API 即判红。
  {
    const samplerRegion = patched.match(/function dshMobileComboProbeLoopHistogram\(\)[\s\S]*?\n\}/)
      && patched.match(/function dshMobileComboProbeArmLoopSampler\(\)[\s\S]*?\n\}/)
    check('采样器可从产物中提取（行为反证前置）', Boolean(samplerRegion))
    if (samplerRegion) {
      // 取连续区间：直方图 + 其间的 let/const 声明 + arm 函数（分开取会漏掉声明，harness 直接 ReferenceError）
      const hist = patched.match(/function dshMobileComboProbeLoopHistogram\(\)[\s\S]*?dshMobileComboProbeArmLoopSampler\(\) \{[\s\S]*?\n\}/)[0]
      const harness = [
        hist,
        'function dshMobileComboProbeLoopLine() {',
        '  const stats = dshMobileComboProbeLoopStats;',
        '  if (stats === void 0 || stats.samples === 0) return "loopP99Ms=-1 loopSamples=-1";',
        '  const p99 = stats.percentile(99);',
        '  return "loopP99Ms=" + (p99 < 0 ? -1 : p99) + " loopSamples=" + stats.samples;',
        '}',
        'const block = (ms) => { const s = performance.now(); while (performance.now() - s < ms) {} };',
        'dshMobileComboProbeArmLoopSampler();',
        'block(400);',
        'await new Promise(r => setTimeout(r, 250));',
        'console.log(dshMobileComboProbeLoopLine());',
      ].join('\n')
      const harnessPath = join(scratch, 'sampler-harness.mjs')
      writeFileSync(harnessPath, harness)
      const witness = spawnSync(process.execPath, [harnessPath], { encoding: 'utf8' })
      const line = (witness.stdout || '').trim()
      const p99 = Number((line.match(/loopP99Ms=([\d.-]+)/) || [])[1])
      // 同一 tick 的 400ms 块：可接受区间取 >250ms（调度抖动与 arming 开销留余量），
      // 旧实现恒为 ~11ms，落不进该区间。
      check('行为反证：arming 同 tick 的 400ms 同步块必须可见（旧实现在此恒报 ~11ms）',
        Number.isFinite(p99) && p99 > 250, line + '（p99=' + String(p99) + '）')
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`combo-probe-p1: ${failures.length} 项失败`)
  process.exit(1)
}
console.log('combo-probe-p1: 全部检查通过（rc.1 真产物上安装 + 解析契约）')
