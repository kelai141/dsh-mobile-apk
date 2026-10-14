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
// 用法：node scripts/check-runtime-assets.mjs [abi] [--snapshot <tar>] [--require]
//   abi         arm64 | x86_64（缺省 x86_64，仅兼容手工调用）
//   --snapshot  显式快照 tar（发布链用 dsh-mobile-apk/snapshot/snapshot-<abi>.tar.xz）
//   --require   严格模式：任何 SKIP 分支转失败（构建链/发布链必须用）
//   --write     追版收尾用：把快照里的同源文件字节直接写回 assets/patched/<asset>
//               （引擎换代后资产必然不同源——本门禁会拒打包，但没有生成器就得手工 tar -xO，
//               于是「怎么修」变部落知识；这里把它变成一条命令，写完仍按逐字节复核）
// 退出码：0 = 通过（或非严格模式下明确计数并打印的 SKIP）；1 = 资产与快照不同源 / 严格模式下缺件。
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TAR } from './lib/shell.mjs'
import { createHash } from 'node:crypto'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const args = process.argv.slice(2)
let ABI = 'x86_64'
let SNAP_OVERRIDE = null
let REQUIRE = process.env.DSH_REQUIRE_SNAPSHOT_ASSETS === '1'
let WRITE = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--snapshot') { SNAP_OVERRIDE = args[i + 1]; i += 1; continue }
  if (args[i] === '--require') { REQUIRE = true; continue }
  if (args[i] === '--write') { WRITE = true; continue }
  if (!args[i].startsWith('--')) ABI = args[i]
}

// CI/local source chains provide the exact APK root; prefer it over layout guessing.
// Without this override, a self-contained checkout can be misread as a coordination
// root when a same-named directory exists, sending the strict gate to a phantom path.
const APK_DIR = process.env.DSH_APK_DIR
  ? resolve(process.env.DSH_APK_DIR)
  : existsSync(join(ROOT, 'dsh-mobile-apk'))
    ? join(ROOT, 'dsh-mobile-apk')
    : ROOT
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

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
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
  console.log('PASS  资产覆盖同源补丁全部 marker（' + assets.length + ' 个资产，快照无关判据）')
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
  const assetText = assetBuf.toString('utf8')
  const snapText = snapBuf.toString('utf8')
  const markers = src.map((x) => x.marker).filter((m) => typeof m === 'string' && m.length > 0)
  const snapMissing = markers.filter((m) => !snapText.includes(m))
  const assetMissing = markers.filter((m) => !assetText.includes(m))
  if (!snapBuf.equals(assetBuf)) {
    if (snapMissing.length > 0 && assetMissing.length === 0) {
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
}
if (checked === 0) {
  skip('没有任何「快照含补丁 + 资产同源」的组合可核对（abi=' + ABI + '）')
  process.exit(0)
}

// 行为回归：字节同源只证「两条路一致」，不证「资产在设备上能正常工作」——坏形态若在快照里也已分叉
// （构建期补丁自己带缺陷）字节比对会绿；行为断言是第二道锁（review C1 判据）。
for (const { asset, test } of BEHAVIOR_TESTS) {
  if (!assets.includes(asset)) continue
  const testPath = join(ROOT, 'scripts', 'patches', 'tests', test)
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
