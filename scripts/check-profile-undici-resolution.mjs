#!/usr/bin/env node
// check-profile-undici-resolution.mjs — profile 层 undici 解析门禁（0.15.x，订阅 provider 引入）
//
// 为什么需要它（本门禁守的缺陷形态）：
//   vendored 的 dsh-plugin-subscriptions 把 undici 声明为 **peer**（由引擎提供，见
//   vendor/dsh-plugin-subscriptions/PROVENANCE.md），插件本体注入在 profiles/web|headless/node_modules/。
//   Node 从插件文件位置沿**祖先目录**向上找 node_modules —— 能到达的只有 <profile>/node_modules 与
//   profiles/node_modules（共享农场），**到不了引擎树** usr/lib/node_modules/@deepseek-ai/dsh/node_modules/。
//   基座 bootstrap 的农场只为基座自己的依赖建链，undici 不在其中 ⇒ 设备上 import 'undici' 直接
//   ERR_MODULE_NOT_FOUND，插件整条不激活（实测：未补链 IMPORT FAIL；补链后 IMPORT OK）。
//   补链步骤见 build-snapshot-013.mjs 的「8a3b. profile 共享农场补齐」。
//
// 判据（三条全成立才 PASS）：
//   A. 从 profile 锚点 <root>/home/.dsh/profiles/web/package.json 真的能 require.resolve('undici')；
//   B. 解析到的包 version >= 8.11.2（插件 peer 声明 >=8.11.2 的下界）；
//   C. 解析结果落在**本快照树内**且不在本仓 node_modules（= 不是 devDependency 那份）。
//   附加 D：真实路径必须是引擎树里的那份（换引擎目录时唯一会失效的假设，故显式断言）。
//
// 负控（--negative-control）：移走共享农场的 undici 链 → 门禁必须判红，再复原。
//   它证明判据真在守这条链，而不是被残留洗绿（历史教训：只判「文件在不在」会被残留放过）。
//
// 用法：
//   node scripts/check-profile-undici-resolution.mjs <stageRoot> [--require] [--negative-control]
//   node scripts/check-profile-undici-resolution.mjs --self-test
// 退出码：0=通过；1=判红；2=用法错误。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const MIN_VERSION = '8.11.2'
const PKG = 'undici'
const PROFILE_ANCHOR = 'home/.dsh/profiles/web/package.json'
const FARM = 'home/.dsh/profiles/node_modules'
const ENGINE_UNDICI = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/' + PKG

const argv = process.argv.slice(2)
const flag = (n) => argv.includes('--' + n)
const target = argv.find((a) => !a.startsWith('--'))

/**
 * 版本比较（只处理数字段，忽略预发布后缀）。
 * @param a - 左版本
 * @param b - 右版本
 * @returns a<b 负数、相等 0、a>b 正数
 */
export function compareVersion(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((x) => Number(x) || 0)
  const [pa, pb] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * 判据核心（纯函数，供自检与真检共用）。
 * @param root - 快照根（含 usr/ 与 home/）
 * @returns 判定、原因清单与证据明细
 */
export function checkResolution(root) {
  const reasons = []
  const anchor = join(root, PROFILE_ANCHOR)
  const detail = { anchor, resolved: null, realPath: null, version: null, engineDir: join(root, ...ENGINE_UNDICI.split('/')) }
  if (!existsSync(anchor)) return { pass: false, reasons: ['profile 锚点缺席: ' + anchor], detail }
  let resolved
  try {
    resolved = createRequire(anchor).resolve(PKG)
  } catch (e) {
    return {
      pass: false,
      reasons: ['从 profile 锚点解析 ' + PKG + ' 失败（' + (e.code ?? e.message) + '）'
        + '—— 共享农场缺链或链指向不存在：' + join(root, ...(FARM + '/' + PKG).split('/'))],
      detail,
    }
  }
  detail.resolved = resolved
  let real = resolved
  try { statSync(resolved); real = resolve(resolved) } catch { /* 用原值继续判 */ }
  detail.realPath = real

  let version = null
  try { version = JSON.parse(readFileSync(join(dirname(resolved), 'package.json'), 'utf8')).version } catch { /* 下面判红 */ }
  detail.version = version
  if (version === null) reasons.push('解析到的 ' + PKG + ' 无 package.json：' + resolved)
  else if (compareVersion(version, MIN_VERSION) < 0) reasons.push(PKG + ' 版本 ' + version + ' < ' + MIN_VERSION)

  const rootAbs = resolve(root)
  const inRoot = real === rootAbs || real.startsWith(rootAbs + sep)
  if (!inRoot) reasons.push('解析结果落在快照树外（' + real + '）—— 疑似来自本仓 devDependency')
  const repoNm = join(ROOT, 'node_modules') + sep
  if (real.startsWith(repoNm)) reasons.push('解析结果来自仓库根 node_modules（devDependency）：' + real)

  const wantEngine = detail.engineDir
  if (inRoot && !(real === wantEngine || real.startsWith(wantEngine + sep))) {
    reasons.push('解析结果不在引擎树 → 不是「引擎自带那份」：期望 ' + wantEngine + '，实得 ' + real)
  }
  return { pass: reasons.length === 0, reasons, detail }
}

if (flag('self-test')) {
  // 纯离线自检：版本比较器 + 「锚点缺席必判红」。真实树的端到端由 --negative-control 在构建链里证。
  let fails = 0
  const ck = (label, pass) => { console.log((pass ? 'PASS  ' : 'FAIL  ') + label); if (!pass) fails++ }
  ck('版本 8.11.2 >= 8.11.2', compareVersion('8.11.2', MIN_VERSION) === 0)
  ck('版本 8.11.1 < 8.11.2', compareVersion('8.11.1', MIN_VERSION) < 0)
  ck('版本 7.30.1 < 8.11.2（上游声明的 7.x 不放行）', compareVersion('7.30.1', MIN_VERSION) < 0)
  ck('版本 10.0.0 > 9.9.9（数字段而非字典序）', compareVersion('10.0.0', '9.9.9') > 0)
  const miss = checkResolution(join(process.env.TEMP || '/tmp', 'no-such-root-' + process.pid))
  ck('锚点缺席判红', miss.pass === false && miss.reasons.length > 0)
  const fake = join(process.env.TEMP || '/tmp', 'undici-selftest-' + process.pid)
  try {
    mkdirSync(join(fake, 'home/.dsh/profiles/web'), { recursive: true })
    writeFileSync(join(fake, 'home/.dsh/profiles/web/package.json'), '{"name":"probe","private":true}\n')
    const noPkg = checkResolution(fake)
    ck('锚点在场但农场无链 ⇒ 判红（判据不空转）', noPkg.pass === false)
    ck('  判红原因点明解析失败', /解析 undici 失败/.test(noPkg.reasons[0] ?? ''))
  } finally {
    try { rmSync(fake, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log(fails === 0 ? 'UNDICI-RESOLUTION SELF-TEST PASSED（' + 7 + ' 项）' : 'UNDICI-RESOLUTION SELF-TEST FAILED')
  process.exit(fails === 0 ? 0 : 1)
}

/* 默认根：构建链的 stage 树（两条链都在 `.deploy-tmp/snapshot-013/<abi>/stage/root`）。
 * 没有显式参数时按此自动发现——与 check-third-party / check-perf-instrumentation 的 autoTar 同口径：
 * 找不到就记一条计数 SKIP（--require 时改判红），不假绿（假绿的判据比判红更危险）。 */
function autoStageRoot() {
  for (const abi of ['x86_64', 'arm64']) {
    const cand = join(ROOT, '.deploy-tmp', 'snapshot-013', abi, 'stage', 'root')
    if (existsSync(join(cand, ...PROFILE_ANCHOR.split('/')))) return cand
  }
  return undefined
}
const targetArg = target ?? autoStageRoot()
if (targetArg === undefined) {
  if (flag('require')) {
    console.error('FAIL  --require：找不到 stage 树（.deploy-tmp/snapshot-013/<abi>/stage/root）—— 解析判据未执行')
    process.exit(1)
  }
  console.log('SKIP(#1)  无 stage 树可对账（--snapshot/stageRoot 未给且 .deploy-tmp 下无 stage）—— 解析判据未执行')
  console.log('SKIP=1（本门禁本次未作解析判定；两条构建链以 --require 调用，缺失即判红）')
  // 判据行（机器可读）：与 SKIP 区分开——这条明确写 SKIPPED 而非 PASSED，不冒充通过。
  console.log('CHECK-PROFILE-UNDICI-RESOLUTION SKIPPED（未作解析判定）')
  process.exit(0)
}
const root = resolve(targetArg)
if (!existsSync(root)) {
  console.error('stage/快照树不存在: ' + root)
  process.exit(2)
}

const res = checkResolution(root)
console.log('profile 锚点: ' + res.detail.anchor)
console.log('解析结果   : ' + (res.detail.resolved ?? '(none)'))
console.log('真实路径   : ' + (res.detail.realPath ?? '(none)'))
console.log('版本       : ' + (res.detail.version ?? '(none)') + '（下界 ' + MIN_VERSION + '）')
for (const r of res.reasons) console.error('FAIL  ' + r)
console.log(res.pass ? 'PASS  profile 层 ' + PKG + ' 解析到引擎自带 ' + res.detail.version : 'UNDICI-RESOLUTION FAILED')

let negativeOk = true
if (res.pass && flag('negative-control')) {
  const link = join(root, ...(FARM + '/' + PKG).split('/'))
  const aside = link + '.negctl'
  let moved = false
  try { renameSync(link, aside); moved = true } catch (e) {
    console.error('负控：无法移走 ' + link + '（' + (e.code ?? e.message) + '）—— 负控未执行，按失败处理')
    negativeOk = false
  }
  if (moved) {
    /* 必须跑在**子进程**里：Node 的 Module._pathCache 按 (request, paths) 缓存解析结果，
     * 同进程内二次 require.resolve 会直接命中缓存、即便链接已被移走也照样 PASS ——
     * 那会让本负控变成「永远绿」的假证据（本轮实测踩到，见下）。 */
    const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), root], { encoding: 'utf8' })
    const red = probe.status !== 0
    console.log('负控（移走农场链，子进程复检）→ ' + (red ? 'FAIL（符合预期）' : '仍 PASS（假绿，判红）'))
    const why = String(probe.stderr || probe.stdout).split('\n').find((l) => l.startsWith('FAIL  '))
    console.log('  负控命中原因: ' + (why ? why.trim() : '(none)'))
    if (!red) negativeOk = false
    try { renameSync(aside, link) } catch { /* 下面判红 */ }
    if (!existsSync(link)) { console.error('负控：复原农场链失败'); negativeOk = false }
    else console.log('负控：农场链已复原')
  }
}

if (!res.pass || !negativeOk) {
  console.error('UNDICI-RESOLUTION FAILED' + (negativeOk ? '' : '（负控失败）'))
  process.exit(1)
}
console.log('UNDICI-RESOLUTION OK' + (flag('negative-control') ? '（含负控）' : ''))