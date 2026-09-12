// count-compose.mjs — 启动期 client compose() 计数（性能 A1/A3 的度量入口，仅测量用 preload）。
//
// 用法（不改产品代码，注入引擎命令行）：
//   COMBO_LIB=<引擎树>/dsh-client-modules/lib/index.js \
//   node --import file:///.../scripts/perf/count-compose.mjs <引擎入口> web --port 3080 --no-open
// 输出口径（docs/ANDROID-RUNTIME-PERF-2026-09-12.md 附录 A.3）：每行的 at/dur/records 与设备侧
// /proc/net/tcp 的 LISTEN 时刻对齐，算出「LISTEN 之前 compose 累计 CPU / LISTEN 墙钟」比值。
//
// 自检（不依赖设备/引擎）：node scripts/perf/count-compose.mjs --self-test
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
  const stats = { calls: 0, totalMs: 0, instances: new Set(), firstAt: null }
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
    log(`[perf] compose #${stats.calls} at=${(start - t0).toFixed(0)}ms dur=${dt.toFixed(0)}ms instances=${stats.instances.size} records=${this.table?.size ?? '?'}`)
    return result
  }
  const summary = () => `[perf] TOTAL calls=${stats.calls} totalMs=${stats.totalMs.toFixed(0)} instances=${stats.instances.size} firstAt=${stats.firstAt === null ? 'n/a' : stats.firstAt.toFixed(0) + 'ms'}`
  return { stats, summary }
}

const isSelfTest = process.argv.includes('--self-test')

if (isSelfTest) {
  const dir = mkdtempSync(join(tmpdir(), 'count-compose-'))
  try {
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
    const failures = []
    if (stats.calls !== 2) failures.push('calls=' + stats.calls)
    if (stats.instances.size !== 1) failures.push('instances=' + stats.instances.size)
    if (out1 <= 10 || out2 <= 20) failures.push('compose 返回值被破坏')
    if (!lines.some((l) => l.includes('records=2'))) failures.push('未输出 records')
    if (!summary().includes('TOTAL calls=2')) failures.push('summary 缺计数')
    console.log(failures.length === 0 ? 'COUNT-COMPOSE SELF-TEST PASSED\n  ' + summary() : 'COUNT-COMPOSE SELF-TEST FAILED: ' + failures.join('; '))
    process.exit(failures.length === 0 ? 0 : 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
