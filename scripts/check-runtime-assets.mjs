#!/usr/bin/env node
// check-runtime-assets.mjs — 运行时补丁资产一致性门禁（0.13.8 收尾；apk #170 复盘暴露）
//
// 背景（真机实测的假绿）：引擎树补丁有**两条**落地路径——
//   ① 构建期：补丁打进快照 tar（apply-patches --apply --scope engine）；
//   ② 运行期：APK 的 `app/src/main/assets/patched/*` 是预打补丁副本，引擎启动时覆盖运行树。
// 两条路必须同源。实测踩到：F7（发布独占语义）进了快照，但 `assets/patched/` 那份是 9-11 的旧文件，
// 启动时把 F7 静默**改了回去**——构建期 marker 检查全绿，设备上却没有该修复。
//
// 判据（review C1 升级，2026-09-14）：**资产 ↔ 快照同路径文件逐字节一致**。
// 旧判据只比 registry marker——0.14.0-preview 的双占位坏资产（F7 v1：内联 open("wx") 后又调
// helper 占位 → 恒 EEXIST 恒 false，旧会话迁移永久失败）同时含两个 marker，被整条门禁放行；
// 逐字节比对没有这种回旋空间（marker 趋同但字节分叉 = 必红）。
// 另对在册资产跑行为回归（F7 → publish-exclusive-reclaim.test.mjs --asset；F8 同名法），锁「改完还能跑」。
//
// FX-208.1（0.13.8-b 批 B2）：旧实现「快照缺席即 SKIP exit 0」把构建机状态变成了门禁结果。
// 现支持 `--require`：构建链/发布链调用时，快照/资产/registry 任一缺席即**失败**（不得 SKIP）。
// 并且 ABI 由调用方传入（build-apk-013.ps1 按当前 ABI 传参），不再固定 x86_64。
//
//   --root <dir>  只给测试用：把 registry / 资产目录 / 行为回归脚本换成临时树（不碰真实仓库）
// 用法：node scripts/check-runtime-assets.mjs [abi] [--snapshot <tar>] [--require]
//   abi         arm64 | x86_64（缺省 x86_64，仅兼容手工调用）
//   --snapshot  显式快照 tar（发布链用 dsh-mobile-apk/snapshot/snapshot-<abi>.tar.xz）
//   --require   严格模式：任何 SKIP 分支转失败（构建链/发布链必须用）
//   --write     追版收尾用：把快照里的同源文件字节直接写回 assets/patched/<asset>
//               （引擎换代后资产必然不同源——本门禁会拒打包，但没有生成器就得手工 tar -xO，
//               于是「怎么修」变部落知识；这里把它变成一条命令，写完仍按逐字节复核）
// 退出码：0 = 通过（或非严格模式下明确计数并打印的 SKIP）；1 = 资产与快照不同源 / 严格模式下缺件。
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TAR } from './lib/shell.mjs'
import { createHash } from 'node:crypto'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const args = process.argv.slice(2)
/** `--root <dir>` 只给测试用：把 registry / 资产目录 / 行为回归脚本全换成临时树；正常门禁不变。 */
const rootArgIdx = args.indexOf('--root')
const TEST_ROOT = rootArgIdx >= 0 ? args[rootArgIdx + 1] : null
let ABI = 'x86_64'
let SNAP_OVERRIDE = null
let REQUIRE = process.env.DSH_REQUIRE_SNAPSHOT_ASSETS === '1'
let WRITE = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--snapshot') { SNAP_OVERRIDE = args[i + 1]; i += 1; continue }
  if (args[i] === '--require') { REQUIRE = true; continue }
  if (args[i] === '--write') { WRITE = true; continue } if (args[i] === '--self-test') selfTest() // 自证入口：函数提升，定义在文件后段
  if (!args[i].startsWith('--')) ABI = args[i]
}

// CI/local source chains provide the exact APK root; prefer it over layout guessing.
// Without this override, a self-contained checkout can be misread as a coordination
// root when a same-named directory exists, sending the strict gate to a phantom path.
const APK_DIR = TEST_ROOT ?? (process.env.DSH_APK_DIR
  ? resolve(process.env.DSH_APK_DIR)
  : existsSync(join(ROOT, 'dsh-mobile-apk'))
    ? join(ROOT, 'dsh-mobile-apk')
    : ROOT)
const SNAP = SNAP_OVERRIDE ? SNAP_OVERRIDE : join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')
const SNAPSHOT_NAME = basename(SNAP)
const ASSETS = join(APK_DIR, 'app', 'src', 'main', 'assets', 'patched')
let skipped = 0

const fail = (msg) => {
  console.error('CHECK-RUNTIME-ASSETS FAILED：' + msg)
  process.exit(1)
}
const skip = (msg) => {
  if (REQUIRE) fail(msg + '\n  严格模式（--require）：构建链/发布链不得以 SKIP 结案（快照/资产必须在场）')
  skipped += 1
  console.log('SKIP(#' + skipped + ')  ' + msg)
  return false
}

if (!existsSync(ASSETS)) { skip(`无运行时资产目录（${ASSETS}）——协调仓或未注入的树`); process.exit(0) }
if (!existsSync(SNAP)) { skip(`快照不在场（${SNAP}，abi=${ABI}）——先构建快照再跑本门禁`); process.exit(0) }
if (!existsSync(join(ROOT, 'scripts', 'patches', 'registry.json'))) {
  skip('registry.json 不在场（apk 仓自包含树请用协调仓跑本门禁）')
  process.exit(0)
}

const registry = JSON.parse(readFileSync(join(TEST_ROOT ?? ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
const patches = (registry.patches ?? []).filter((p) => p.scope === 'engine' && p.marker)
const assets = readdirSync(ASSETS).filter((f) => f.endsWith('.js'))
if (assets.length === 0) { skip('assets/patched 下没有 .js 资产'); process.exit(0) }

/** 资产名 `<pkg>-<basename>`（例 session-persistence-jsonl-index.js）→ registry 的 target 路径。 */
const sourcesFor = (asset) => {
  const base = asset.slice(asset.lastIndexOf('-') + 1)              // index.js
  const pkg = asset.slice(0, asset.lastIndexOf('-'))                // session-persistence-jsonl
  return patches.filter((p) => (p.target ?? '').endsWith('/' + base) && (p.target ?? '').includes('/dsh-' + pkg + '/'))
}

// ── P3（0.14.8 门禁优化）：一次解压取全部目标，不再「每资产一次 tar -xO」。────────────
//
// 旧实现：下面的 `for (const asset of assets)` 循环里逐个调 `readFromSnapshot(target)`，
// 而它是 `tar -xO -f <160MB tar> <单个成员>`。**xz 不可随机寻址——取一个成员 = 全量解码一遍。**
// 实测（本机 2026-10-14）：单次 `tar -xO` 取一个成员 **10.8 s**；assets/patched 有 3 个资产
// ⇒ 3 次全量解码，门禁实测总耗时 **32.3 s**（32.3 ÷ 3 ≈ 10.8，与探针吻合）。
//
// 本项目对此已有两次成文教训，本处是同一形态的漏网：
//   · check-mcp-client-deps.mjs:90-91 「为什么不用『每包一次 tar -xOf』…闭包十几个包就要几分钟」
//   · check-inject-completeness.mjs:68-69 「逐成员 tar -xO 会对 170MB xz 重解压 N 次，实测 >10min 超时」
//
// 处方与那两处一致：**一次 `tar -xf` 把需要的成员解到临时目录**，后续在本地文件上比对。
// 判据强度不变——比对的仍是同一批字节，只是不再重复解码。
const snapshotDirCache = { dir: null, dispose: null }
/** 惰性建一次临时解压目录；调用方负责在退出前 dispose。 */
const snapshotExtractDir = () => {
  if (snapshotDirCache.dir !== null) return snapshotDirCache.dir
  const dir = mkdtempSync(join(tmpdir(), 'runtime-assets-'))
  snapshotDirCache.dir = dir
  snapshotDirCache.dispose = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判据 */ } }
  return dir
}
/** 退出前清理临时目录（含异常路径）。 */
const disposeSnapshotDir = () => { if (snapshotDirCache.dispose) snapshotDirCache.dispose() }
process.on('exit', disposeSnapshotDir)

/**
 * 把 `wanted`（tar 成员路径数组）一次性解到临时目录，返回 { member -> Buffer }。
 * 解不出来的成员在返回的 Map 里**缺席**（调用方按「读不到」处理，与旧行为一致）。
 */
const readManyFromSnapshot = (wanted) => {
  const out = new Map()
  if (wanted.length === 0) return out
  const dir = snapshotExtractDir()
  try {
    execFileSync(TAR, ['-xf', SNAP, '-C', dir, '--', ...wanted], {
      stdio: ['ignore', 'ignore', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch { /* 缺席成员按缺失处理（后续断言会报），不在此处中断 */ }
  for (const m of wanted) {
    try { out.set(m, readFileSync(join(dir, m.split('/').join(sep)))) } catch { /* 缺席 */ }
  }
  return out
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 在册资产的行为回归（review C1）：直接对资产正文本体跑，不重新施加补丁。 */
const BEHAVIOR_TESTS = [
  { asset: 'session-persistence-jsonl-index.js', test: 'publish-exclusive-reclaim.test.mjs' },
  { asset: 'fs-local-index.js', test: 'fs-local-link-f8.test.mjs' },
]

// ── 判据 0b（issue #1072）：marker 不是证据，**补丁本体**才是 ────────────────────────
// 判据 0 的 marker 在本仓是**注释级约定**（实测 assets/patched/fs-local-index.js:587 是
// 「/* dsh-mobile link->rename fallback (F8): … */」、attachment-local-index.js:392 是
// 「// dsh-mobile durable-walk guard: …」）。因此「marker 在场」单独存在时，补丁本体可以完全
// 缺席——只要把 marker 以注释形式留在文件里（issue #1072 复现）。这里补一条不依赖 marker
// 词串的判据：把资产字节摆到 registry 的 target 路径上，让**补丁链自己的结构断言**
//（scripts/patches/apply-patches.mjs 的 IMPLS[*].check）判定这份字节里是否真的有该补丁。
// 三个在册补丁的 check 都断言 marker 之外的结构：
//   F2 → 2 处 dsh-mobile link->rename fallback + 「already consumed the staged file」消息；
//   F7 → ≥3 处 dshMobileClaimExclusive( + 双占位反例的拒绝条件；
//   B  → dshMobileDigestOf( + 2 处 this.dshMobileContentUnchanged(。
// 所以「删掉本体、只留注释 marker」在判据 0 会绿，在这里必红。
/** 剥注释（逐行；引号状态不跨行）：只用于把 marker 的**位置**判成代码 / 注释。 */
function stripComments(source) {
  let inBlock = false
  return source.split('\n').map((line) => {
    let out = ''
    let index = 0
    let quote = null
    while (index < line.length) {
      const c = line[index]
      const next = line[index + 1]
      if (inBlock) {
        if (c === '*' && next === '/') { inBlock = false; out += '  '; index += 2; continue }
        out += ' '
        index += 1
        continue
      }
      if (quote !== null) {
        if (c === '\\') { out += c + (next ?? ''); index += 2; continue }
        out += c
        if (c === quote) quote = null
        index += 1
        continue
      }
      if (c === '/' && next === '/') { out += ' '.repeat(line.length - index); index = line.length; continue }
      if (c === '/' && next === '*') { inBlock = true; out += '  '; index += 2; continue }
      if (c === '"' || c === "'" || c === '\u0060') { quote = c; out += c; index += 1; continue }
      out += c
      index += 1
    }
    return out
  }).join('\n')
}

/** marker 落在代码里还是只在注释里（'code' | 'comment-only' | 'absent'）。 */
function markerPlacement(text, marker) {
  if (typeof marker !== 'string' || marker === '') return 'absent'
  if (stripComments(text).includes(marker)) return 'code'
  return text.includes(marker) ? 'comment-only' : 'absent'
}

/**
 * 逐字节同源的方向判定（纯函数，--self-test 直接钉）。
 * 旧实现把「两侧同等陈旧」和「两侧同源且都对」都判成 PASS —— 前者靠判据 0b 抓。
 * @returns 'same' | 'snap-stale' | 'asset-stale' | 'unknown'
 */
function classifyParity(assetBuf, snapBuf, markers) {
  if (assetBuf.equals(snapBuf)) return 'same'
  const assetText = assetBuf.toString('utf8')
  const snapText = snapBuf.toString('utf8')
  const snapMissing = markers.filter((m) => !snapText.includes(m)).length
  const assetMissing = markers.filter((m) => !assetText.includes(m)).length
  if (snapMissing > 0 && assetMissing === 0) return 'snap-stale'
  if (assetMissing > 0 && snapMissing === 0) return 'asset-stale'
  return 'unknown'
}

/** IMPLS 的补丁 id 集合（拿不到返回 null）：判据 0b 要求目标上的补丁都能被结构断言复核。 */
function patchImplIds() {
  const file = join(TEST_ROOT ?? ROOT, 'scripts', 'patches', 'apply-patches.mjs')
  if (!existsSync(file)) return null
  const ids = new Set([...readFileSync(file, 'utf8').matchAll(/^  '([^']+)':\s*\{/gm)].map((m) => m[1]))
  return ids.size === 0 ? null : ids
}

/**
 * 让补丁链自己判定「该 target 上的补丁本体是否在场」。
 * @returns {{ok: true, checked: number}|{ok: false, detail: string}|{skipped: string}}
 */
function patchBodyVerdict(targetPatches, target, assetBuf) {
  const usable = targetPatches.filter((p) => p.targetDiscovery === undefined && typeof p.id === 'string')
  if (usable.length === 0) return { skipped: '该 target 的 registry 条目没有可复核的 id' }
  const ids = patchImplIds()
  if (ids === null) return { skipped: 'scripts/patches/apply-patches.mjs 不在场或 IMPLS 解析为空（补丁链缺席）' }
  const runnable = usable.filter((p) => ids.has(p.id))
  const unknown = usable.filter((p) => !ids.has(p.id)).map((p) => p.id)
  if (runnable.length === 0) return { skipped: '该 target 的补丁都不在 IMPLS 里（' + unknown.join(', ') + '）——registry/IMPLS 漂移由 check-patch-mirror 负责' }
  const dir = mkdtempSync(join(tmpdir(), 'runtime-assets-body-'))
  try {
    const staged = join(dir, target.split('/').join(sep))
    mkdirSync(dirname(staged), { recursive: true })
    writeFileSync(staged, assetBuf)
    const result = spawnSync(process.execPath,
      [join(TEST_ROOT ?? ROOT, 'scripts', 'patches', 'apply-patches.mjs'), dir, '--check', '--scope', 'engine', '--only', runnable.map((p) => p.id).join(',')],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim()
    if (result.status !== 0) {
      const lines = output.split('\n')
      const fails = lines.filter((line) => line.startsWith('[fail]'))
      // 补丁链自己崩了（import/锚点失配）时不能只报半截栈：优先报 [fail] 行，其次报错误首行。
      const errorLine = lines.find((line) => /^(?:Error|[A-Z][A-Za-z]*Error)\b/.test(line.trim())) ?? ''
      const detail = [...fails.slice(0, 4), ...(fails.length === 0 && errorLine !== '' ? [errorLine.trim()] : [])].join('；')
      return { ok: false, detail: detail !== '' ? detail : lines.slice(-4).join('；') }
    }
    return { ok: true, checked: runnable.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** --self-test：钉住 marker 位置判定、同源方向判定与「本体判据必须可执行」。 */
function selfTest() {
  const cases = []
  const probe = (label, cond) => { cases.push([label, cond]); console.log((cond ? 'PASS  ' : 'FAIL  ') + label) }

  // ① marker 位置判定：本仓的 marker 一律写在注释里（这是约定，不是缺陷）——
  //    但判据必须能把它判成 comment-only，好让「只有注释里那句 marker」的形态无法冒充代码证据。
  probe('marker 在 // 注释里 ⇒ comment-only',
    markerPlacement('代码\n// dsh-mobile durable-walk guard\n更多代码\n', 'dsh-mobile durable-walk guard') === 'comment-only')
  probe('marker 在 /* */ 块注释里 ⇒ comment-only',
    markerPlacement('/* dsh-mobile link->rename fallback (F8): x */\ncode()\n', 'dsh-mobile link->rename fallback (F8)') === 'comment-only')
  probe('marker 在代码位置 ⇒ code',
    markerPlacement('const s = "dsh-mobile durable-walk guard"\n', 'dsh-mobile durable-walk guard') === 'code')
  probe('marker 缺席 ⇒ absent', markerPlacement('code()\n', 'nope') === 'absent')

  // ② 逐字节同源的方向判定（旧实现只有「不同源」一种结论，两个方向修法相反）
  const mk = (s) => Buffer.from(s, 'utf8')
  probe('同字节 ⇒ same', classifyParity(mk('a\nM\n'), mk('a\nM\n'), ['M']) === 'same')
  probe('快照缺 marker、资产有 ⇒ snap-stale（禁止 --write 回写）',
    classifyParity(mk('a\nM\n'), mk('a\n'), ['M']) === 'snap-stale')
  probe('资产缺 marker、快照有 ⇒ asset-stale（--write 回写是正确修法）',
    classifyParity(mk('a\n'), mk('a\nM\n'), ['M']) === 'asset-stale')
  probe('两侧都缺 marker（同等陈旧）⇒ unknown（正是判据 0b 要抓的形态）',
    classifyParity(mk('a\n'), mk('b\n'), ['M']) === 'unknown')

  // ③ 本体判据必须可执行：三个在册资产的表情补丁 id 都要能在 IMPLS 里找到，
  //    否则真实跑会退化成 SKIP，而「marker 在场即绿」的洞会重新打开。
  const ids = patchImplIds()
  probe('IMPLS 可解析（apply-patches.mjs 在场）', ids !== null)
  if (ids !== null) {
    const wanted = ['attach-durable-F2', 'publish-exclusive-F7', 'fs-local-link-F8', 'fs-local-digest-guard-B', 'spj-migration-link-F5']
    const missing = wanted.filter((id) => !ids.has(id))
    probe('在册资产同源补丁均在 IMPLS 里（否则本体判据会 SKIP）：缺 ' + (missing.join(', ') || '无'), missing.length === 0)
  }
  const bad = cases.filter(([, ok]) => !ok)
  console.log(bad.length === 0
    ? '\nCHECK-RUNTIME-ASSETS SELF-TEST PASSED（' + cases.length + ' 项：marker 位置 / 同源方向 / 本体判据可执行）'
    : '\nCHECK-RUNTIME-ASSETS SELF-TEST FAILED: ' + bad.map(([label]) => label).join('; '))
  process.exit(bad.length === 0 ? 0 : 1)
}

// ── 判据 0（快照无关）：资产必须覆盖它对应文件在 registry 里的**全部** engine 补丁 marker ──────
// 为什么需要这条（0.14.2 实测）：下面的逐字节判据要**快照在场**才有意义，而快照可能是补丁加入
// 之前构建的旧产物 ⇒ 资产与旧快照「同源」（都缺新补丁）⇒ 逐字节判绿，而真机上该补丁等于没修。
// 实锤：B（fs-local-digest-guard-B）加入后，assets/patched/fs-local-index.js 仍是只有 F8 的 43405 B，
// 与当时快照逐字节一致 ⇒ 本门禁不响；引擎每次启动仍把 B 覆盖掉。
// 这条判据只看「资产文本里有没有该文件全部 engine 补丁的 marker」，与快照无关 ⇒ 任何往某个目标
// 文件新增补丁的人，只要忘了同步资产，这里立刻判红（不需要别人先重建快照来触发）。
{
  const missing = []
  for (const asset of assets) {
    const src = sourcesFor(asset)
    if (src.length === 0) continue
    const text = readFileSync(join(ASSETS, asset), 'utf8')
    for (const patch of src) {
      if (typeof patch.marker !== 'string' || patch.marker.length === 0) continue
      if (!text.includes(patch.marker)) missing.push({ asset, id: patch.id, marker: patch.marker })
    }
  }
  if (missing.length > 0) {
    fail('运行时资产缺少同源补丁 marker（该补丁在设备上会被本资产整份覆盖 ⇒ 等于没修）：\n'
      + missing.map((m) => '  ' + m.asset + '：缺 ' + m.id + ' 的 marker ' + JSON.stringify(m.marker)).join('\n')
      + '\n  修复：从出厂态 fixture 按 registry 顺序施加该文件的全部 engine 补丁，用产物覆盖 assets/patched/<asset>'
      + '\n  （资产须由补丁链生成，禁止手改；生成后不带参数复核）')
  }
  console.log('PASS  资产覆盖同源补丁全部 marker（' + assets.length + ' 个资产，快照无关判据；'
    + 'marker 在本仓写在注释里，故本体由判据 0b 的结构断言复核）')
  // marker 位置盘点：本仓约定是注释，所以这里只报数、不判红；它的用处是让「marker 只是注释」
  // 这件事在 CI 日志里可见，而不是被一句 PASS 盖住（issue #1072 的认知根因）。
  let atCode = 0
  let atCommentOnly = 0
  for (const asset of assets) {
    const text = readFileSync(join(ASSETS, asset), 'utf8')
    for (const patch of sourcesFor(asset)) {
      if (typeof patch.marker !== 'string' || patch.marker === '') continue
      if (markerPlacement(text, patch.marker) === 'code') atCode += 1
      else atCommentOnly += 1
    }
  }
  console.log('INFO  marker 位置：代码位置 ' + atCode + ' 条 / 仅注释 ' + atCommentOnly + ' 条（注释级证据）')
}

let checked = 0
// ST-31：资产级 SKIP 必须与缺件 SKIP 一起**计数**（历史上这三处静默 SKIP 让「快照/资产不同源」
// 在发布链上以 exit 0 结案——发布链要求 SKIP=0，靠 --require 把每一处 SKIP 变成失败）。
const skipAsset = (msg) => {
  if (REQUIRE) fail(msg + '\n  严格模式（--require）：发布链不得以 SKIP 结案')
  skipped += 1
  console.log('SKIP(#' + skipped + ')  ' + msg)
}
// P3：先把所有「单 target」资产的快照字节**一次性**取回（一次 tar -xf），再逐个比对。
// 只在主判据路径上批量；多 target / 无条目两类走 skipAsset 的分支不参与取字节（它们不比对内容）。
const singleTargets = []
for (const asset of assets) {
  const src = sourcesFor(asset)
  if (src.length === 0) continue
  const targets = [...new Set(src.map((p) => p.target))]
  if (targets.length !== 1) continue
  singleTargets.push({ asset, target: targets[0] })
}
const snapBytes = readManyFromSnapshot([...new Set(singleTargets.map((x) => x.target))])
if (singleTargets.length > 0) {
  console.log('PASS  快照字节一次性取回（一次 tar -xf，' + snapBytes.size + '/' + new Set(singleTargets.map((x) => x.target)).size + ' 个目标成员；'
    + '旧实现为每资产一次 tar -xO = 全量解码 N 次）')
}
for (const asset of assets) {
  const src = sourcesFor(asset)
  if (src.length === 0) {
    skipAsset(`资产 ${asset}：registry 里没有同源补丁条目`)
    continue
  }
  const targets = [...new Set(src.map((p) => p.target))]
  if (targets.length !== 1) {
    skipAsset(`资产 ${asset}：registry 同源条目指向多个 target（${targets.join(', ')}）——登记表需人工核对`)
    continue
  }
  const target = targets[0]
  const snapBuf = snapBytes.get(target) ?? null
  if (snapBuf === null) {
    skipAsset(`资产 ${asset} ↔ ${target}：快照里读不到该文件（快照缺该包？）`)
    continue
  }
  const assetBuf = readFileSync(join(ASSETS, asset))
  checked++
  // 方向感知（0.14.2）：资产与快照不同源有两种相反成因，修法相反，绝不能一律用 --write 回写。
  //   ① 快照缺补丁（快照是补丁加入**之前**构建的旧产物）：资产是对的，回写会把补丁从资产里抹掉
  //      → 必须**重建快照**；--write 在此**拒绝**执行。
  //   ② 资产缺补丁：快照是对的，--write 从快照回写资产是正确的修法。
  // 实锤：B 加入后快照仍旧（只有 F8），旧 --write 会静默把 B 从资产里删掉——比不修更坏。
  const markers = src.map((x) => x.marker).filter((m) => typeof m === 'string' && m.length > 0)
  const parity = classifyParity(assetBuf, snapBuf, markers)
  const snapMissing = markers.filter((m) => !snapBuf.toString('utf8').includes(m))
  const assetMissing = markers.filter((m) => !assetBuf.toString('utf8').includes(m))
  if (parity !== 'same') {
    if (parity === 'snap-stale') {
      fail('快照是**陈旧**产物：它缺少该文件已登记的 engine 补丁，而运行时资产已含补齐\n'
        + '  资产（正确，勿覆盖）= ' + asset + '（' + assetBuf.length + ' B，sha ' + sha256(assetBuf).slice(0, 12) + '…）\n'
        + '  快照（陈旧）      = ' + snapBuf.length + ' B，sha ' + sha256(snapBuf).slice(0, 12) + '…\n'
        + '  快照缺的 marker：' + snapMissing.map((m) => JSON.stringify(m)).join(', ') + '\n'
        + '  **禁止用 --write 回写**（那会把补丁从资产里抹掉，比不修更坏）。正确修法：重建快照\n'
        + '  （node scripts/build-snapshot-013.mjs <abi>），使快照与资产同源。')
    }
    if (WRITE) {
      writeFileSync(join(ASSETS, asset), snapBuf)
      console.log(`REGEN ${asset} ← ${target}（${assetBuf.length} B → ${snapBuf.length} B，sha ${sha256(snapBuf).slice(0, 12)}…）`)
      console.log(`PASS  资产与快照逐字节同源: ${asset}（--write 刚重写，已按快照字节复核）`)
      continue
    }
    fail(`运行时资产与快照不同源（逐字节）：${asset} ↔ ${target}\n`
      + `  资产 sha256   = ${sha256(assetBuf)}（${assetBuf.length} B）\n`
      + `  快照 sha256   = ${sha256(snapBuf)}（${snapBuf.length} B）\n`
      + '  引擎启动时会用该资产覆盖运行树 → 两条路径的补丁在设备上互相回退（这就是本门禁要防的假绿）\n'
      + `  修复：node scripts/check-runtime-assets.mjs ${ABI} --write`
      + '（从快照回写 assets/patched，然后不带 --write 复核一次）')
  }
  const covered = src.map((p) => p.id).join(', ')
  console.log(`PASS  资产与快照逐字节同源: ${asset}（覆盖 ${covered}）`)

  // 判据 0b（issue #1072）：逐字节同源只证「两条路一致」，不证「补丁本体在里面」——
  // 两侧同等陈旧（都缺补丁）时它恒真。让补丁链自己的结构断言复核这份字节。
  const body = patchBodyVerdict(src, target, assetBuf)
  if (body.skipped !== undefined) {
    // 生产树（不传 --root）不得以「判据不可执行」结案：那会把「marker 在场即绿」的洞重新打开。
    if (TEST_ROOT !== null) skipAsset('资产 ' + asset + ' 的补丁本体判据未执行（--root 测试档）：' + body.skipped)
    else fail('补丁本体判据不可执行（production 档不得跳过）：' + body.skipped + '\n'
      + '  这一条是 issue #1072 的正面防线：marker 只是注释，本体必须由补丁链的 check() 复核。')
  } else if (!body.ok) {
    fail('运行时资产的补丁本体不在场（marker 在场也不算修好）：' + asset + ' <- ' + target + '\n'
      + '  补丁链的结构断言失败：' + body.detail + '\n'
      + '  典型形态（issue #1072）：把补丁正文删掉、只把 marker 以注释形式留在文件里——' + '\n'
      + '  判据 0 与逐字节判据都会绿（两侧同等陈旧），而真机上该补丁等于没修。\n'
      + '  修复：按 registry 顺序重新施加该文件的全部 engine 补丁生成资产（scripts/patches/apply-patches.mjs），禁止手改。')
  } else {
    console.log('PASS  补丁本体在场: ' + asset + '（apply-patches --check 结构断言复核 ' + body.checked + ' 条：' + covered + '）')
  }
}
if (checked === 0) {
  skip('没有任何「快照含补丁 + 资产同源」的组合可核对（abi=' + ABI + '）')
  process.exit(0)
}

// 行为回归：字节同源只证「两条路一致」，不证「资产在设备上能正常工作」——坏形态若在快照里也已分叉
// （构建期补丁自己带缺陷）字节比对会绿；行为断言是第二道锁（review C1 判据）。
for (const { asset, test } of BEHAVIOR_TESTS) {
  if (!assets.includes(asset)) continue
  const testPath = join(TEST_ROOT ?? ROOT, 'scripts', 'patches', 'tests', test)
  if (!existsSync(testPath)) {
    skipAsset(`行为回归脚本缺席：scripts/patches/tests/${test}（镜像面不完整？）`)
    continue
  }
  const r = spawnSync(process.execPath, [testPath, '--asset', join(ASSETS, asset)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-1)[0]
  if (r.status !== 0) {
    fail(`资产行为回归失败：${asset} → ${test}（exit ${r.status}）\n  ${tail}\n`
      + '  该资产会在引擎启动时覆盖运行树——行为缺陷会直接落设备（见 0.14.0-preview 双占位资产事故）')
  }
  console.log(`PASS  资产行为回归: ${asset}（${test}）`)
}

console.log('CHECK-RUNTIME-ASSETS PASSED（abi=' + ABI + '，核对组合 ' + checked + '，SKIP=' + skipped + '）')
