// compile-cache-flush-n2.test.mjs — N2 补丁回归：NODE_COMPILE_CACHE 主动落盘（2026-09-14 缓存审计）。
//
// 背景：Node 只在进程正常退出时写编译缓存（v24 文档），而壳侧停引擎是有界宽限的 SIGTERM→SIGKILL
// （EngineManager.killExistingEngine），Android 还会整进程回收——设备实测 09-12 23:07 之后编译缓存
// 零新增/零改写，09-14 三次快照刷新后换掉的模块每次冷启动都重新编译。修法：入口 bin.js 周期 flush
// （40 s 首刷 + 5 min）+ exit 兜底，不注册信号处理（不改变任何命令的退出语义）。
//
// 本测试：① 对只读 fixture 跑 apply-patches（幂等 + node --check + marker = 1）；
// ② 抽出注入块，注入桩断言：注册一次 exit、调度一次首刷与一个周期定时器，触发即调用 flush。
//
// 用法：node scripts/patches/tests/compile-cache-flush-n2.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const FIXTURE = versionedFixture('dsh-root', 'lib', 'bin.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const scratch = mkdtempSync(join(tmpdir(), 'n2-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'perf-compile-cache-flush-N2'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0', applied.status === 0, (applied.stderr || '').trim().split('\n').slice(-2).join(' '))
  const patched = readFileSync(target, 'utf8')
  check('marker 数 = 1', (patched.match(/dsh-mobile compile cache flush \(N2\)/g) || []).length === 1,
    'count=' + ((patched.match(/dsh-mobile compile cache flush \(N2\)/g) || []).length))
  // 位置判据取语义而非逐字符前缀：真正要保的是「flush 注册早于任何命令逻辑」——bin.js 的产物形态是
  // import 段 → //#region <模块> → …。逐字符钉住 shebang+首行 import 的写法在 rc.1 已经过期
  //（根包不再 import node:fs），而位置语义没变。
  const blockAt = patched.indexOf('dshMobileFlushCompileCache')
  const firstRegion = patched.indexOf('//#region')
  check('注入点在 import 段内、首个模块 region 之前（任何命令路径都会加载）',
    blockAt > 0 && (firstRegion < 0 || blockAt < firstRegion)
    && patched.indexOf('import { inspect } from "node:util";') < blockAt,
    `blockAt=${blockAt} firstRegion=${firstRegion}`)
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])
  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  // ── 行为：抽出注入块，注入桩驱动调度与 flush 调用 ──
  const start = patched.indexOf('const dshMobileFlushCompileCacheQuietly = () => {')
  const endMarker = 'process.on("exit", dshMobileFlushCompileCacheQuietly);'
  const end = patched.indexOf(endMarker)
  if (start < 0 || end < 0) throw new Error('注入块未找到')
  const block = patched.slice(start, end + endMarker.length)
  const timeouts = []
  const intervals = []
  const exitHandlers = []
  let flushes = 0
  const fakeSetTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return { unref: () => {} } }
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref: () => {} } }
  const fakeProcess = { on: (ev, fn) => { if (ev === 'exit') exitHandlers.push(fn) } }
  const factory = new Function('dshMobileFlushCompileCache', 'setTimeout', 'setInterval', 'process',
    block + '\nreturn { flush: dshMobileFlushCompileCacheQuietly };')
  const api = factory(() => { flushes += 1 }, fakeSetTimeout, fakeSetInterval, fakeProcess)

  check('首刷与复刷定时器已调度（15 s + 60 s）', timeouts.length === 2 && timeouts[0].ms === 15000 && timeouts[1].ms === 60000, JSON.stringify(timeouts.map((t) => t.ms)))
  check('周期定时器已调度（5 min）', intervals.length === 1 && intervals[0].ms === 300000, JSON.stringify(intervals.map((t) => t.ms)))
  check('exit 兜底已注册', exitHandlers.length === 1)
  timeouts[0].fn()
  timeouts[1].fn()
  intervals[0].fn()
  exitHandlers[0]()
  check('触发即调用 flush（首刷/复刷/周期/exit 各一次）', flushes === 4, 'flushes=' + flushes)

  // flush 抛错必须被吞（Node 契约：编译缓存是静默优化；引擎不得因此受影响）
  let quiet = 0
  const throwing = new Function('dshMobileFlushCompileCache', 'setTimeout', 'setInterval', 'process',
    block + '\nreturn { flush: dshMobileFlushCompileCacheQuietly };')
  const api2 = throwing(() => { quiet += 1; throw new Error('boom') }, fakeSetTimeout, fakeSetInterval, fakeProcess)
  let threw = false
  try { api2.flush() } catch { threw = true }
  check('flush 抛错被吞（不冒泡到引擎）', !threw && quiet === 1, 'threw=' + threw)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
