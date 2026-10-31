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
import { TAR } from './lib/shell.mjs'
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

/* ── 归档判据（0.15.x 补）────────────────────────────────────────────────────
 *
 * 为什么默认对象从 stage 树改成归档：快照构建收尾后 .deploy-tmp/snapshot-013/<abi>/stage
 * 已被清掉，只剩 snapshot.tar.xz。于是本门禁在链里**永远找不到 stage 树** → --require 判红，
 * 与「判据不成立」混在一起。（同族：判据的输入物变了，判据没跟着变。）
 *
 * 口径（先看真实数据再定，不先选）：
 *   实测归档里 home/.dsh/profiles/node_modules/undici 是 **l 型、一跳、绝对目标**
 *   -> /root/.dsh-stage/<abi>/root/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici
 *   即**宿主 stage 路径**（构建设备上不存在）。对照 undici-types 指向设备前缀
 *   /data/data/com.dsharnessmobile.shell/files/usr/... —— 那条是基座建的，正确。
 * 所以判据不能只「比字面前缀」，必须区分三种目标：
 *   · 相对目标：posix.normalize(linkDir + '/' + target) 必须等于 ENGINE_UNDICI；
 *   · 绝对目标：只接受设备前缀（/data/data/<pkg>/files/usr 或 /data/user/0/<pkg>/files/usr），
 *     剥掉前缀后必须等于 ENGINE_UNDICI；
 *   · 其它绝对路径（典型 /root/.dsh-stage/*）= **宿主路径泄漏** → 判红并点名。
 * 多跳：跟到底，上限 MAX_HOPS=8，报跳数；超限判红。
 */
const MAX_HOPS = 8
const DEVICE_PREFIXES = [
  '/data/data/com.dsharnessmobile.shell/files/usr',
  '/data/user/0/com.dsharnessmobile.shell/files/usr',
]

/** posix 风格规范化拼接（不碰真实文件系统）。 */
export function posixJoin(base, rel) {
  const parts = (base + '/' + rel).split('/')
  const out = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return '/' + out.join('/')
}

/**
 * 把链接目标规范成「快照内相对路径」（usr/... 形式）；无法归属则返回 original + kind。
 * @param linkDir - 链接所在目录（快照内相对，如 home/.dsh/profiles/node_modules）
 * @param target - 链接目标字面值
 * @returns {{ form: 'relative'|'device'|'host-leak'|'other', path: string, raw: string }}
 */
export function classifyTarget(linkDir, target) {
  const raw = String(target)
  if (raw.startsWith('/')) {
    for (const pre of DEVICE_PREFIXES) {
      if (raw === pre || raw.startsWith(pre + '/')) {
        return { form: 'device', path: raw.slice(pre.length).replace(/^\//, ''), raw }
      }
    }
    if (raw.includes('/.dsh-stage/') || raw.includes('.dsh-stage')) {
      return { form: 'host-leak', path: raw, raw }
    }
    return { form: 'other', path: raw, raw }
  }
  const abs = posixJoin('/' + linkDir, raw)
  return { form: 'relative', path: abs.replace(/^\//, ''), raw }
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

/**
 * 归档判据：一次 `tar -tvf` 拿成员表，之后不在归档上做逐成员 `-xOf` 全量扫描
 * （除引擎 undici 的 package.json 单独取一次——那是唯一需要读内容的成员，见 #1256 教训）。
 * @param tarPath - snapshot.tar.xz
 * @returns {{ pass: boolean, reasons: string[], detail: object }}
 */
export function checkArchive(tarPath) {
  const reasons = []
  const detail = { tar: tarPath, link: null, hops: [], form: null, resolved: null, version: null }
  const ls = spawnSync(TAR, ['-tvf', tarPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (ls.error || ls.status !== 0) {
    return { pass: false, reasons: ['归档不可读（tar -tvf 失败）：' + String(ls.error ?? ls.status)], detail }
  }
  const linkMap = new Map()
  const lines = String(ls.stdout).split('\n').filter(Boolean)
  for (const line of lines) {
    const arrow = line.indexOf(' -> ')
    if (arrow < 0) continue
    const head = line.slice(0, arrow)
    const name = head.split(/\s+/).slice(-1)[0]
    linkMap.set(name.replace(/^(\.\/)+/, ''), line.slice(arrow + 4).trim())
  }
  const FARM_UNDICI = FARM + '/' + PKG
  if (!linkMap.has(FARM_UNDICI)) reasons.push('共享农场缺 ' + PKG + ' 链：归档内无 ' + FARM_UNDICI)
  else {
    // 多跳跟随（上限 MAX_HOPS）
    let cur = FARM_UNDICI
    let hops = 0
    let lastForm = null
    while (linkMap.has(cur)) {
      if (hops >= MAX_HOPS) { reasons.push('链接跳数超过上限 ' + MAX_HOPS + '（疑似环）'); break }
      const target = linkMap.get(cur)
      const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : ''
      const c = classifyTarget(dir, target)
      detail.hops.push({ from: cur, target, form: c.form })
      lastForm = c.form
      hops++
      if (c.form === 'host-leak') { reasons.push('宿主路径泄漏: ' + target + '（设备上不存在，插件 import 必失败）'); break }
      if (c.form === 'other') { reasons.push('链接目标不是快照内路径也不是设备前缀: ' + target); break }
      const next = c.path
      if (linkMap.has(next)) { cur = next; continue }
      detail.form = c.form
      detail.resolved = next
      cur = next
      break
    }
    detail.link = FARM_UNDICI
    if (!reasons.length) {
      if (detail.resolved !== ENGINE_UNDICI) reasons.push('解析结果不在引擎树：' + String(detail.resolved))
      if (hops !== 1) detail.hopCount = hops
    }
  }
  if (!lines.some((l) => l.endsWith(' ' + ENGINE_UNDICI + '/package.json') || l.includes(ENGINE_UNDICI + '/package.json'))) {
    reasons.push('引擎树缺 ' + PKG + '/package.json')
  } else if (!reasons.length) {
    const one = spawnSync(TAR, ['-xOf', tarPath, ENGINE_UNDICI + '/package.json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    try { detail.version = JSON.parse(String(one.stdout)).version } catch { reasons.push('引擎 ' + PKG + ' 的 package.json 不可解析') }
    if (detail.version && compareVersion(detail.version, MIN_VERSION) < 0) {
      reasons.push('引擎 ' + PKG + ' 版本 ' + detail.version + ' < 下界 ' + MIN_VERSION)
    }
  }
  // 反证：不得解析到本仓 node_modules（devDependency 那份）
  if (lines.some((l) => /(^|\s)node_modules\/undici\/package\.json$/.test(l) && !l.includes(ENGINE_UNDICI))) {
    reasons.push('归档里出现非引擎树的 undici/package.json（疑似 devDependency 那份）')
  }
  return { pass: reasons.length === 0, reasons, detail }
}

/** 默认归档：.deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz */
function autoSnapshot() {
  for (const abi of ['x86_64', 'arm64']) {
    const cand = join(ROOT, '.deploy-tmp', 'snapshot-013', abi, 'snapshot.tar.xz')
    if (existsSync(cand)) return cand
  }
  return undefined
}

const targetArg = target ?? autoStageRoot()
// 归档模式：显式给 .tar.xz，或没给 stage 树时回落到默认归档
const tarArg = targetArg && /\.tar\.xz$/.test(targetArg) ? targetArg : (targetArg === undefined ? autoSnapshot() : undefined)
if (tarArg !== undefined) {
  if (!existsSync(tarArg)) {
    console.error('归档不存在: ' + tarArg + '（环境缺口，不是判据不成立）')
    process.exit(2)
  }
  const ar = checkArchive(tarArg)
  console.log('归档       : ' + tarArg)
  console.log('农场链     : ' + (ar.detail.link ?? '(none)') + (ar.detail.hopCount ? '（跳数 ' + ar.detail.hopCount + '）' : ''))
  console.log('目标形态   : ' + (ar.detail.form ?? '(none)'))
  console.log('解析结果   : ' + (ar.detail.resolved ?? '(none)'))
  console.log('引擎版本   : ' + (ar.detail.version ?? '(none)') + '（下界 ' + MIN_VERSION + '）')
  for (const r of ar.reasons) console.error('FAIL  ' + r)
  console.log(ar.pass ? 'PASS  profile 层 ' + PKG + ' 解析到引擎自带 ' + ar.detail.version : 'UNDICI-RESOLUTION FAILED')
  process.exit(ar.pass ? 0 : 1)
}
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