#!/usr/bin/env node
// check-perf-instrumentation.mjs — 启动性能度量入口与出厂 profile 清单门禁（0.13.8-b §7.2 / P-AC-01/03/04/22）。
// P-AC-23/24（patchReload 出厂默认 + 存量归一化）随 0.1.7-rc.1 撤销：上游删除了整个 patchReload 机制，
// live reload 的收益改由结构本身提供（dsh-client-hmr 常驻但无 dev watcher 时空转）——见 profile-seed.mjs 头注。
//
// 断言四层：
//   1. 度量入口在场且可自检：scripts/perf/count-compose.mjs（--self-test）+ scripts/perf/measure-steady.ps1
//      （-DryRun；且不得用 adb forward 判定——P-AC-04 明确禁用该假阳性口径）；
//   2. 出厂 profile 清单体检自检（不依赖快照）：scripts/lib/profile-seed.mjs 在临时 stage 上剥掉上游
//      已不读的死键、断言 bundles 非空、幂等（P-AC-22 由「写死键」改为「不写死键」）；
//   3. 出厂清单对账（P-AC-01）：--require <tar> 时解包快照断言 profiles/{web,headless}/package.json
//      bundles 非空且无死键；无快照非严格档计数 SKIP，严格档失败（不得以 SKIP 结案）；
//   4. 壳侧声明缺口台账（scripts/perf-instrumentation-gaps.json）：逐条核对「仍然缺席」，实现后即 stale 失败。
//
// 用法：node scripts/check-perf-instrumentation.mjs [--require] [--snapshot <tar>] [--abi <arm64|x86_64>]
// 退出码：0 = 通过（SKIP 有计数）；1 = 失败。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { TAR } from './lib/shell.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const REQUIRE = argv.includes('--require')
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const ABI = argOf('abi') ?? 'x86_64'

const failures = []
let skipped = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const skip = (msg) => {
  skipped += 1
  if (REQUIRE) { console.log('FAIL  SKIP(#' + skipped + ') ' + msg + '（--require：不得以 SKIP 结案）'); failures.push(msg) }
  else console.log('SKIP(#' + skipped + ')  ' + msg)
}

// ── 1. 度量入口 ─────────────────────────────────────────────────────────────
const countCompose = join(ROOT, 'scripts', 'perf', 'count-compose.mjs')
const measurePs1 = join(ROOT, 'scripts', 'perf', 'measure-steady.ps1')
check('度量入口 count-compose.mjs 在场', existsSync(countCompose))
check('度量入口 measure-steady.ps1 在场', existsSync(measurePs1))
if (existsSync(countCompose)) {
  const r = spawnSync(process.execPath, [countCompose, '--self-test'], { encoding: 'utf8' })
  check('count-compose --self-test 通过（计数不破坏 compose 返回值）', r.status === 0,
    (r.stdout + r.stderr).trim().split('\n').slice(-1)[0])
}
if (existsSync(measurePs1)) {
  const text = readFileSync(measurePs1, 'utf8')
  check('measure-steady 用设备侧 /proc/net/tcp LISTEN 判定（P-AC-04）', text.includes('/proc/net/tcp') && text.includes('0C08'))
  // 注释里解释「不用 forward」是合法的；只看可执行行（去掉 # 注释行后不得再出现 forward）。
  const executable = text.replace(/<#[\s\S]*?#>/g, '').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  check('measure-steady 不用 adb forward 判定（假阳性口径）', !/forward/.test(executable),
    executable.split('\n').filter((l) => /forward/.test(l)).slice(0, 2).join(' | '))
  check('measure-steady 支持 -DryRun（离线自检）', text.includes('-DryRun'))
}

// ── 2. 出厂 profile 清单体检自检 ────────────────────────────────────────────
const builderPath = join(ROOT, 'scripts', 'build-snapshot-013.mjs')
const builder = existsSync(builderPath) ? readFileSync(builderPath, 'utf8') : ''
check('build-snapshot 接线出厂 profile 清单体检 checkShippedProfileManifests', builder.includes('checkShippedProfileManifests'))
// 反向面：死键的**写入**必须整条消失，否则「体检」与「写键」两套事实并存（0.14.2 撤销 N1 的收尾）。
// 只判赋值/接线符号，不判字符串出现——本文件的解释性注释里就会提到 patchReload。
check('build-snapshot 不再写 patchReload（P-AC-23/24 已随上游撤销该机制）',
  !builder.includes('seedProfilePatchReload')
  && !/\.patchReload\s*=[^=]/.test(builder.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')))
const { checkShippedProfileManifests, DEAD_PROFILE_KEYS } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'profile-seed.mjs')).href)

const stage = mkdtempSync(join(tmpdir(), 'perf-seed-'))
try {
  mkdirSync(join(stage, 'home', '.dsh', 'profiles', 'web'), { recursive: true })
  mkdirSync(join(stage, 'home', '.dsh', 'profiles', 'headless'), { recursive: true })
  mkdirSync(join(stage, 'home', '.dsh', 'profiles', 'broken'), { recursive: true })
  writeFileSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  // 存量形态：更早的构建把 patchReload 写进了清单（基座 home 会被后续快照继承）
  writeFileSync(join(stage, 'home', '.dsh', 'profiles', 'headless', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-headless', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } } }))
  const probe = (profiles) => checkShippedProfileManifests(stage, { profiles })
  const first = probe(['web', 'headless'])
  const headless = JSON.parse(readFileSync(join(stage, 'home', '.dsh', 'profiles', 'headless', 'package.json'), 'utf8'))
  check('体检：存量死键被剥除', headless.dsh.profile.patchReload === undefined && first.find((r) => r.profile === 'headless')?.stripped.join() === 'patchReload')
  check('体检：bundles 保留', (headless.dsh.profile.bundles ?? []).length === 2)
  const mtime1 = statSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json')).mtimeMs
  const second = probe(['web', 'headless'])
  const mtime2 = statSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json')).mtimeMs
  check('体检幂等：二次运行零改写', second.every((r) => r.changed === false) && mtime1 === mtime2)
  check('体检逐 profile 报告', first.length === 2 && first.every((r) => !r.missing && r.bundles > 0))
  // 反证：bundles 为空的清单必须报 0（产物段以此判红），否则「形状合格」是空话
  writeFileSync(join(stage, 'home', '.dsh', 'profiles', 'broken', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-broken', dsh: { profile: { bundles: [] } } }))
  const broken = probe(['broken'])
  check('反证：空 bundles 被报成 0（不是静默通过）', broken.length === 1 && broken[0].bundles === 0)
  // 反证：剥键是外科手术而不是「清空 dsh.profile」——未登记键必须原样留着，
  // 否则体检会把上游将来真读的字段也一并抹掉还全绿。
  writeFileSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup', futureKnob: 7 } } }))
  probe(['web'])
  const webAfter = JSON.parse(readFileSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json'), 'utf8'))
  check('反证：未登记的键不被误删（只点死键）', webAfter.dsh.profile.futureKnob === 7 && webAfter.dsh.profile.patchReload === undefined)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))

// 产品内探针补丁 combo-probe-P1（0.14.1 块F P0-2）：设备上 t_compose_total 恒为 -1 的结构性真因是
// 「[perf] TOTAL 只有测量 preload 会产，而 scripts/perf/count-compose.mjs 没有任何发行路径」+「解析链
// 挂在默认关闭的调试采集器上」。故把产出时机放进产品内 compose() 返回处（P1）。
// 本断言锁两件事，缺一即同类潜伏无防线：
//   ① 补丁仍登记在 registry 且是 engine scope、marker 在场（被删 = 读数回到 -1，而 C6 会误以为「探针没装」）；
//   ② **marker/口径与壳侧解析正则同源**——壳侧 LogCollector.kt 按 `[perf] TOTAL calls=… totalMs=…` 解析，
//      若补丁的输出字段名与壳侧正则漂移，两侧各自「绿」而真机读数为空（这正是本轮要防的跨层假绿）。
const p1 = registry.patches.find((p) => p.id === 'combo-probe-P1')
const p1Ok = Boolean(p1 && p1.scope === 'engine' && String(p1.marker || '').trim())
check('产品内探针补丁 combo-probe-P1 在 registry（engine scope + marker 在场；缺失则 t_compose_total 回到 -1）', p1Ok)
if (p1Ok) {
  // 同源面：补丁实现里必须真的产出 TOTAL 行，且字段名与壳侧解析面对得上。
  const implText = readFileSync(join(ROOT, 'scripts', 'patches', 'apply-patches.mjs'), 'utf8')
  const p1Impl = implText.slice(implText.indexOf('combo-probe-P1'))
  const emitTotal = p1Impl.includes('[perf] TOTAL calls=') && p1Impl.includes('totalMs=')
  const shellParser = (() => {
    // 布局无关：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径。
    // 本文件下方的 resolveRepoPath 定义在更后面，故此处就地解析（避免 TDZ）。
    const rel = 'dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/LogCollector.kt'
    const cands = [rel, rel.slice('dsh-mobile-apk/'.length)]
    const hit = cands.find((c) => existsSync(join(ROOT, c)))
    return hit ? readFileSync(join(ROOT, hit), 'utf8') : null
  })()
  const shellOk = shellParser === null
    || (shellParser.includes('TOTAL calls=') && shellParser.includes('totalMs='))
  check('探针输出口径与壳侧解析同源（补丁产出 `[perf] TOTAL calls=… totalMs=…`，LogCollector 按同形解析）',
    emitTotal && shellOk,
    '补丁产出=' + emitTotal + ' 壳侧同形=' + (shellParser === null ? '（壳侧缺席，跳过）' : shellOk)
      + '——两侧漂移会让「补丁在跑」与「壳侧读到值」互相假装成立')
}

// phase instrumentation is part of the 0.14.5 C4 diagnostic contract. The old P1 probe already
// emitted TOTAL/C4 fields, so checking only the registry marker let a stale pre-phase snapshot
// pass the APK build while silently omitting the code needed to locate high loop p99 readings.
const PHASE_PROBE_MARKERS = [
  'dshMobileComboProbePhaseNames = new Set(',
  'dshMobileComboProbePhases = new Map()',
  'dshMobileComboProbePhaseWindowMs = 250',
  'function dshMobileComboProbeRecordPhase(',
  '[perf] phase name=${phase.name}',
  'durTotalMs=',
  'forwardedCallbacks=',
  // C4 采样器口径（2026-10-06）：自建、arming 时锚定墙钟基线的采样器。
  // 缺了这条，旧快照（用对外部 monitor）会一路通过构建并再次把整段卡顿报成健康。
  'function dshMobileComboProbeLoopHistogram(',
  'function dshMobileComboProbeArmLoopSampler(',
  'let last = performance.now();',
]
const missingPhaseProbeMarkers = (text) => PHASE_PROBE_MARKERS.filter((marker) => !text.includes(marker))
const staleP1Fixture = 'dsh-mobile combo probe (P1)\ndshMobileComboProbeEmit\n[perf] TOTAL calls=1 totalMs=5 loopP99Ms=-1 loopSamples=0'
const completePhaseFixture = [
  'dsh-mobile combo probe (P1)',
  'dshMobileComboProbeEmit',
  ...PHASE_PROBE_MARKERS,
].join('\n')
check('phase 探针判据反例：旧 P1/TOTAL 不能冒充完整 phase 插桩', missingPhaseProbeMarkers(staleP1Fixture).length === PHASE_PROBE_MARKERS.length)
check('phase 探针判据正例：完整签名可被识别', missingPhaseProbeMarkers(completePhaseFixture).length === 0)
const patchSource = readFileSync(join(ROOT, 'scripts', 'patches', 'apply-patches.mjs'), 'utf8')
const p1PatchStart = patchSource.indexOf("'combo-probe-P1':")
const p1PatchSource = p1PatchStart < 0 ? '' : patchSource.slice(p1PatchStart, patchSource.indexOf("\n  },", p1PatchStart))
const sourceMissingPhaseMarkers = missingPhaseProbeMarkers(p1PatchSource)
check('combo-probe-P1 源码包含完整 phase 诊断实现', sourceMissingPhaseMarkers.length === 0,
  sourceMissingPhaseMarkers.length ? '缺少 ' + sourceMissingPhaseMarkers.join(', ') : undefined)

// ── 3. A1 出厂声明值对账（P-AC-01）─────────────────────────────────────────
const autoTar = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')
const tarPath = argOf('snapshot') || (existsSync(autoTar) ? autoTar : null)
// ── P4（0.14.8 门禁优化）：一次解压取全部成员，不再「每成员一次 tar -xO」。──────────────
//
// 旧实现逐成员调 `tar -xO -f <tar> <member>`。**xz 不可随机寻址——取一个成员 = 全量解码一遍。**
// 实测（本机 2026-10-14）：单次取一个成员 **10.8 s**；本门禁取 1 个引擎成员 + 2 个 profile 成员
// = 3 次全量解码，门禁实测总耗时 **34.2 s**（34.2 ÷ 3 ≈ 11.4，与探针吻合）。
//
// 与 check-runtime-assets（P3）、check-mcp-client-deps、check-inject-completeness 同一处方：
// 一次 `tar -xf` 解到临时目录，后续读本地文件。判据强度不变（读的是同一批字节）。
const extractCache = { dir: null, tar: null, members: new Map() }
/** 一次解压 `members` 到临时目录，返回 { member -> utf8 string | null }。 */
const readManyFromTar = (tar, members) => {
  if (extractCache.tar !== tar) {
    if (extractCache.dir) { try { rmSync(extractCache.dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判据 */ } }
    extractCache.dir = mkdtempSync(join(tmpdir(), 'perf-probe-'))
    extractCache.tar = tar
    extractCache.members = new Map()
  }
  const missing = members.filter((m) => !extractCache.members.has(m))
  if (missing.length > 0) {
    try {
      execFileSync(TAR, ['-xf', tar, '-C', extractCache.dir, '--', ...missing], { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
    } catch { /* 缺席成员按缺失处理 */ }
    for (const m of missing) {
      try { extractCache.members.set(m, readFileSync(join(extractCache.dir, ...m.split('/'))).toString('utf8')) }
      catch { extractCache.members.set(m, null) }
    }
  }
  return extractCache.members
}
process.on('exit', () => { if (extractCache.dir) { try { rmSync(extractCache.dir, { recursive: true, force: true }) } catch { /* 同上 */ } } })
if (!tarPath) {
  skip('无快照可对账（--snapshot <tar> 或 ' + autoTar + '）——A1 出厂值未在真实产物上核对')
} else {
  const comboProbeMember = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
  // P4：一次性取回全部 3 个成员（旧实现逐个 tar -xO = 3 次全量解码）。
  const profileMembers = ['web', 'headless'].map((p) => 'home/.dsh/profiles/' + p + '/package.json')
  const bulk = readManyFromTar(tarPath, [comboProbeMember, ...profileMembers])
  console.log('PASS  快照成员一次性取回（一次 tar -xf，' + [comboProbeMember, ...profileMembers].filter((m) => bulk.get(m) !== undefined).length
    + '/3 个；旧实现为每成员一次 tar -xO = 全量解码 3 次）')
  const comboProbeText = bulk.get(comboProbeMember) ?? null
  const missingPhaseMarkers = comboProbeText === null ? PHASE_PROBE_MARKERS : missingPhaseProbeMarkers(comboProbeText)
  check('快照内产品 index.js 携带当前 phase 探针（阻止旧 P1 快照进入 APK）',
    comboProbeText !== null && missingPhaseMarkers.length === 0,
    comboProbeText === null
      ? '缺少 ' + comboProbeMember + '；请从当前代码重建 snapshot'
      : 'phase 签名缺失：' + missingPhaseMarkers.join(', ') + '；请从当前代码重建 snapshot')
  for (const profile of ['web', 'headless']) {
    const member = 'home/.dsh/profiles/' + profile + '/package.json'
    const text = bulk.get(member) ?? null
    if (text === null) { skip('快照内缺 ' + member + '（' + tarPath + '）'); continue }
    let manifest = null
    try { manifest = JSON.parse(text) } catch { /* 保留 null = 解析失败 */ }
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    const dead = DEAD_PROFILE_KEYS.filter((key) => manifest?.dsh?.profile?.[key] !== undefined)
    const ok = manifest !== null && bundles.length > 0 && dead.length === 0
    const detail = 'bundles=' + String(bundles.length) + ' 死键=[' + dead.join(', ') + ']'
      + (manifest === null ? '（package.json 解析失败）' : '')
    if (ok) check('出厂 profile 清单：' + profile + ' ' + detail + '（P-AC-01）', true)
    else if (REQUIRE) {
      check('出厂 profile 清单：' + profile + ' ' + detail + '（P-AC-01，--require）', false,
        'bundles 非空且无上游已不读的死键；重出快照即转绿')
    } else {
      skip('出厂 profile 清单未核对：' + profile + ' ' + detail + '（构建/发布链以 --require 强制）')
    }
  }
}

// ── 4. 壳侧声明缺口台账 ─────────────────────────────────────────────────────
const gapsPath = join(ROOT, 'scripts', 'perf-instrumentation-gaps.json')
const gaps = existsSync(gapsPath) ? (JSON.parse(readFileSync(gapsPath, 'utf8')).gaps ?? []) : []
check('壳侧缺口台账可解析', existsSync(gapsPath))
// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径。
const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
for (const gap of gaps) {
  const file = resolveRepoPath(gap.file)
  if (file === null) { check('缺口台账文件在场: ' + gap.file, false); continue }
  const text = readFileSync(file, 'utf8')
  const stillAbsent = !text.includes(gap.expectAbsent)
  check('壳侧缺口仍缺席（' + gap.id + '，' + gap.plan + '）', stillAbsent,
    stillAbsent ? undefined : gap.expectAbsent + ' 已在 ' + gap.file + ' 落地——请从 scripts/perf-instrumentation-gaps.json 删除该条并收口')
  console.log('WARN  未收口（' + gap.owner + '）: ' + gap.id + ' -> ' + gap.reason.slice(0, 80) + '…')
}

if (failures.length > 0) {
  console.error('CHECK-PERF-INSTRUMENTATION FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
console.log('CHECK-PERF-INSTRUMENTATION PASSED（SKIP=' + skipped + '，缺口台账 ' + gaps.length + ' 条）')
