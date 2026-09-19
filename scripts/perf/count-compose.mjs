// count-compose.mjs — 启动期 client compose() 计数（性能 A1/A3/A5 的度量入口，仅测量用 preload）。
//
// 用法（不改产品代码，注入引擎命令行）：
//   COMBO_LIB=<引擎树>/dsh-client-modules/lib/index.js \
//   node --import file:///.../scripts/perf/count-compose.mjs <引擎入口> web --port 3080 --no-open
// 输出口径（docs/ANDROID-RUNTIME-PERF-2026-09-12.md 附录 A.3）：每行的 at/dur/records 与设备侧
// /proc/net/tcp 的 LISTEN 时刻对齐，算出「LISTEN 之前 compose 累计 CPU / LISTEN 墙钟」比值。
//
// 0.14.1 块F 追加（check-boot-budget.mjs 的原始产物面，禁止手填）：
//   [perf] compose #N at=..ms dur=..ms instances=.. records=.. singles=.. comboCache=..
//   [perf] boot singles=.. records=..          ← compose #1 之后的启动期读数（C5 反向判据）
//   [perf] single #N at=..ms singles=..        ← 单条 URL 被请求（A5 惰性路径；C5 正向对照）
//   [perf] TOTAL calls=.. totalMs=.. instances=.. firstAt=..ms singles=.. loopP99Ms=.. loopSamples=.. comboCache=..
// 事件循环延迟用 perf_hooks.monitorEventLoopDelay()（C4：p99 < 50 ms 且样本数达标，空样本不得假绿）。
//
// 自检（不依赖设备/引擎）：node scripts/perf/count-compose.mjs --self-test
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Wrap ClientModuleRegistry.prototype.compose with counters. Returns the mutable stats object. */
export function instrumentCompose(mod, options = {}) {
  const log = options.log ?? ((line) => console.error(line))
  const proto = mod?.ClientModuleRegistry?.prototype
  if (!proto || typeof proto.compose !== 'function') {
    throw new Error('COMBO_LIB 不导出 ClientModuleRegistry.prototype.compose（引擎结构已变，请核对 dsh-client-modules）')
  }
  const stats = { calls: 0, totalMs: 0, maxMs: 0, instances: new Set(), firstAt: null, singleRequests: 0 }
  /** A3 combo 缓存统计（引擎树补丁 combo-cache-A3 在模块装载时挂到 globalThis）。 */
  const cacheStats = () => globalThis.__dshMobileComboCacheStats
  /** A5 单条惰性统计（补丁 combo-single-lazy-A5 在模块装载时挂到 globalThis）。 */
  const lazyStats = () => globalThis.__dshMobileComboLazyStats
  const cacheLine = () => {
    const c = cacheStats()
    return c === undefined ? '' : ` comboCache=${c.state} hits=${c.hits} misses=${c.misses}`
  }
  const lazyLine = () => {
    const l = lazyStats()
    return l === undefined ? '' : ` singles=${l.singleBuilds}`
  }
  // C4：事件循环延迟直方图。enable() 后由运行时持续采样；samples 为 0 时门禁必须判红（空样本假绿）。
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const t0 = performance.now()
  const orig = proto.compose
  proto.compose = function (...args) {
    stats.calls += 1
    stats.instances.add(this)
    const start = performance.now()
    stats.firstAt = stats.firstAt ?? start - t0
    const result = orig.apply(this, args)
    const dt = performance.now() - start
    stats.totalMs += dt
    stats.maxMs = Math.max(stats.maxMs, dt)
    log(`[perf] compose #${stats.calls} at=${(start - t0).toFixed(0)}ms dur=${dt.toFixed(0)}ms instances=${stats.instances.size} records=${this.table?.size ?? '?'}${lazyLine()}${cacheLine()}`)
    // C5 反向判据：boot 期（首次全量 compose 之后）单条产物构建数必须为 0。必须用原始产物，
    // 不能由人手填；也不能只看 TOTAL（TOTAL 是退出时刻的读数，boot 之后可能已允许单条请求）。
    if (stats.calls === 1) {
      const l = lazyStats()
      log(`[perf] boot singles=${l?.singleBuilds ?? 'n/a'} records=${this.table?.size ?? '?'}`)
    }
    return result
  }
  // C5 正向对照：单条 URL 真的被请求时留下「计数已变 1」的原始证据。缺这条就无法区分
  // 「已延迟」与「探针根本没接上」——正是 t_compose_total 恒为 -1 的教训。
  const origSingle = proto.dshMobileSingleComboResponse
  if (typeof origSingle === 'function') {
    proto.dshMobileSingleComboResponse = function (...args) {
      const result = origSingle.apply(this, args)
      if (result !== void 0) {
        stats.singleRequests += 1
        const l = lazyStats()
        log(`[perf] single #${stats.singleRequests} at=${(performance.now() - t0).toFixed(0)}ms singles=${l?.singleBuilds ?? 'n/a'}`)
      }
      return result
    }
  }
  const loopP99 = () => (loop.count === 0 ? 'n/a' : (loop.percentile(99) / 1e6).toFixed(1))
  const summary = () => `[perf] TOTAL calls=${stats.calls} totalMs=${stats.totalMs.toFixed(0)} instances=${stats.instances.size} firstAt=${stats.firstAt === null ? 'n/a' : stats.firstAt.toFixed(0) + 'ms'}${lazyLine()} loopP99Ms=${loopP99()} loopSamples=${loop.count}${cacheLine()}`
  return { stats, summary, loop }
}

const isSelfTest = process.argv.includes('--self-test')

if (isSelfTest) {
  const dir = mkdtempSync(join(tmpdir(), 'count-compose-'))
  const failures = []
  const check = (label, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
    if (!ok) failures.push(label)
  }
  try {
    // ① 只测 compose 的桩：计数、返回值不被破坏、TOTAL 出现
    const stub = join(dir, 'stub.mjs')
    writeFileSync(stub, [
      'export class ClientModuleRegistry {',
      '  constructor() { this.table = new Map([["a", 1], ["b", 2]]) }',
      '  compose(records) { let n = 0; for (let i = 0; i < 20000; i += 1) n += i; return records + n }',
      '}',
    ].join('\n'))
    const mod = await import(pathToFileURL(stub).href)
    const lines = []
    const { stats, summary } = instrumentCompose(mod, { log: (l) => lines.push(l) })
    const registry = new mod.ClientModuleRegistry()
    const out1 = registry.compose(10)
    const out2 = registry.compose(20)
    check('compose 计数 = 2', stats.calls === 2, 'calls=' + stats.calls)
    check('instances = 1', stats.instances.size === 1, 'instances=' + stats.instances.size)
    check('compose 返回值未被破坏', out1 > 10 && out2 > 20)
    check('逐行输出含 records=2', lines.some((l) => l.includes('records=2')))
    check('compose #1 后输出 boot 行（C5 反向判据原始产物）', lines.some((l) => l.includes('[perf] boot singles=')))
    check('summary 含 TOTAL calls=2', summary().includes('TOTAL calls=2'))
    check('summary 含事件循环 p99 与样本数（C4 原始产物）',
      /loopP99Ms=\S+ loopSamples=\d+/.test(summary()), summary().slice(-60))

    // ② 带 A5 惰性面的桩：正向对照必须留下 singles>=1 的原始证据
    delete globalThis.__dshMobileComboLazyStats
    Object.defineProperty(globalThis, '__dshMobileComboLazyStats', {
      value: { records: 4, singleBuilds: 0, maxMs: 0 }, configurable: true,
    })
    const lazyStub = join(dir, 'lazy.mjs')
    writeFileSync(lazyStub, [
      'export class ClientModuleRegistry {',
      '  constructor() { this.table = new Map([["a", 1]]) }',
      '  compose() { return "graph" }',
      '  dshMobileSingleComboResponse(url) {',
      '    if (url !== "/plugins/??a/client.js&rev=x") return undefined',
      '    globalThis.__dshMobileComboLazyStats.singleBuilds += 1',
      '    return { body: "BODY" }',
      '  }',
      '}',
    ].join('\n'))
    const lazyMod = await import(pathToFileURL(lazyStub).href)
    const lazyLines = []
    const lazyHarness = instrumentCompose(lazyMod, { log: (l) => lazyLines.push(l) })
    const lazyRegistry = new lazyMod.ClientModuleRegistry()
    lazyRegistry.compose()
    check('boot 期 singles=0 被如实上报（未请求单条时不虚增）',
      lazyLines.some((l) => l.includes('[perf] boot singles=0')))
    lazyRegistry.dshMobileSingleComboResponse('/plugins/??a/client.js&rev=x')
    check('正向对照：请求单条 URL 后 singles 变 1（C5 反假绿）',
      lazyLines.some((l) => /\[perf\] single #1 .*singles=1/.test(l)),
      lazyLines.filter((l) => l.includes('[perf] single')).join(' | '))
    check('未命中单条 URL 不产生 single 行（不虚增正向对照）',
      lazyRegistry.dshMobileSingleComboResponse('/plugins/??nope/client.js&rev=y') === void 0
      && lazyLines.filter((l) => l.includes('[perf] single')).length === 1)
    check('summary 含 singles 口径', lazyHarness.summary().includes('singles=1'), lazyHarness.summary().slice(-70))
    delete globalThis.__dshMobileComboLazyStats
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(failures.length === 0 ? 'COUNT-COMPOSE SELF-TEST PASSED' : 'COUNT-COMPOSE SELF-TEST FAILED: ' + failures.join('; '))
  process.exit(failures.length === 0 ? 0 : 1)
} else {
  const lib = process.env.COMBO_LIB
  if (!lib) {
    console.error('count-compose：缺 COMBO_LIB（引擎树 dsh-client-modules/lib/index.js 绝对路径）；本地自检用 --self-test')
    process.exit(2)
  }
  const mod = await import(pathToFileURL(lib).href)
  const { summary } = instrumentCompose(mod)
  process.on('exit', () => console.error(summary()))
}
