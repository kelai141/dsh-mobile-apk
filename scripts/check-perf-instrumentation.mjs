#!/usr/bin/env node
// check-perf-instrumentation.mjs — 启动性能度量入口与 A1 出厂声明值门禁（0.13.8-b §7.2 / P-AC-01/03/04/22/23/24）。
//
// 断言四层：
//   1. 度量入口在场且可自检：scripts/perf/count-compose.mjs（--self-test）+ scripts/perf/measure-steady.ps1
//      （-DryRun；且不得用 adb forward 判定——P-AC-04 明确禁用该假阳性口径）；
//   2. A1 seed 机制自检（不依赖快照）：scripts/lib/profile-seed.mjs 在临时 stage 上把出厂清单写成
//      patchReload=startup、幂等、且 dev 档 DSH_PROFILE_PATCH_RELOAD=live 可覆写（P-AC-22）；
//   3. A1 声明值对账（P-AC-01）：--require <tar> 时解包快照断言 profiles/{web,headless}/package.json
//      的 patchReload == 出厂值；无快照非严格档计数 SKIP，严格档失败（不得以 SKIP 结案）；
//   4. 壳侧声明缺口台账（scripts/perf-instrumentation-gaps.json）：逐条核对「仍然缺席」，实现后即 stale 失败。
//
// 用法：node scripts/check-perf-instrumentation.mjs [--require] [--snapshot <tar>] [--abi <arm64|x86_64>]
// 退出码：0 = 通过（SKIP 有计数）；1 = 失败。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
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
const EXPECTED_RELOAD = process.env.DSH_PROFILE_PATCH_RELOAD || 'startup'

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

// ── 2. A1 seed 机制自检 ─────────────────────────────────────────────────────
const builderPath = join(ROOT, 'scripts', 'build-snapshot-013.mjs')
const builder = existsSync(builderPath) ? readFileSync(builderPath, 'utf8') : ''
check('build-snapshot 接线 seedProfilePatchReload', builder.includes('seedProfilePatchReload'))
check('build-snapshot 默认出厂值为 startup', builder.includes("process.env.DSH_PROFILE_PATCH_RELOAD || 'startup'"))
const { seedProfilePatchReload } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'profile-seed.mjs')).href)

const stage = mkdtempSync(join(tmpdir(), 'perf-seed-'))
try {
  mkdirSync(join(stage, 'home', '.dsh', 'profiles', 'web'), { recursive: true })
  mkdirSync(join(stage, 'home', '.dsh', 'profiles', 'headless'), { recursive: true })
  writeFileSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  writeFileSync(join(stage, 'home', '.dsh', 'profiles', 'headless', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-headless', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'live' } } }))
  const first = seedProfilePatchReload(stage)
  const webManifest = JSON.parse(readFileSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json'), 'utf8'))
  const headlessManifest = JSON.parse(readFileSync(join(stage, 'home', '.dsh', 'profiles', 'headless', 'package.json'), 'utf8'))
  check('seed：键缺失的 web 写出 startup', webManifest.dsh.profile.patchReload === 'startup')
  check('seed：存量 live 的 headless 归一化为 startup', headlessManifest.dsh.profile.patchReload === 'startup')
  const mtime1 = statSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json')).mtimeMs
  const second = seedProfilePatchReload(stage)
  const mtime2 = statSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json')).mtimeMs
  check('seed 幂等：二次运行零改写', second.every((r) => r.changed === false) && mtime1 === mtime2)
  check('seed 报告 web/headless 两条', first.length === 2 && first.every((r) => !r.missing))
  seedProfilePatchReload(stage, { reload: 'live' })
  check('dev 档 DSH_PROFILE_PATCH_RELOAD=live 可覆写（P-AC-22）',
    JSON.parse(readFileSync(join(stage, 'home', '.dsh', 'profiles', 'web', 'package.json'), 'utf8')).dsh.profile.patchReload === 'live')
} finally {
  rmSync(stage, { recursive: true, force: true })
}

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
const n1 = registry.patches.find((p) => p.id === 'perf-patch-reload-N1')
check('存量升级归一化补丁 perf-patch-reload-N1 在 registry（P-AC-24 / Q-20b 默认 N1）',
  Boolean(n1 && n1.scope === 'engine' && String(n1.marker || '').includes('patchReload normalization')))

// ── 3. A1 出厂声明值对账（P-AC-01）─────────────────────────────────────────
const autoTar = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')
const tarPath = argOf('snapshot') || (existsSync(autoTar) ? autoTar : null)
const readFromTar = (tar, member) => {
  try { return execFileSync('tar', ['-xO', '-f', tar, member], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) } catch { return null }
}
if (!tarPath) {
  skip('无快照可对账（--snapshot <tar> 或 ' + autoTar + '）——A1 出厂值未在真实产物上核对')
} else {
  for (const profile of ['web', 'headless']) {
    const member = 'home/.dsh/profiles/' + profile + '/package.json'
    const text = readFromTar(tarPath, member)
    if (text === null) { skip('快照内缺 ' + member + '（' + tarPath + '）'); continue }
    let value = null
    try { value = JSON.parse(text).dsh?.profile?.patchReload ?? null } catch { value = '<解析失败>' }
    if (value === EXPECTED_RELOAD) {
      check('A1 出厂声明值：' + profile + ' patchReload == ' + EXPECTED_RELOAD + '（P-AC-01）', true)
    } else if (REQUIRE) {
      check('A1 出厂声明值：' + profile + ' patchReload == ' + EXPECTED_RELOAD + '（P-AC-01，--require）', false,
        'actual=' + JSON.stringify(value) + '（快照未含出厂 seed：重出快照即转绿）')
    } else {
      skip('A1 出厂声明值未核对：' + profile + ' patchReload=' + JSON.stringify(value)
        + '（当前快照是 A1 前的产物；重出快照后本断言自动转 PASS，构建/发布链以 --require 强制）')
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
