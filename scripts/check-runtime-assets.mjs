#!/usr/bin/env node
// check-runtime-assets.mjs — 运行时补丁资产一致性门禁（0.13.8 收尾；apk #170 复盘暴露）
//
// 背景（真机实测的假绿）：引擎树补丁有**两条**落地路径——
//   ① 构建期：补丁打进快照 tar（apply-patches --apply --scope engine）；
//   ② 运行期：APK 的 `app/src/main/assets/patched/*` 是预打补丁副本，引擎启动时覆盖运行树。
// 两条路必须同源。实测踩到：F7（发布独占语义）进了快照，但 `assets/patched/` 那份是 9-11 的旧文件，
// 启动时把 F7 静默**改了回去**——构建期 marker 检查全绿，设备上却没有该修复。
//
// 断言：对每个运行时资产，用 registry 里同源补丁的 marker 逐个核对——**快照里有、资产里就必须有**。
//
// FX-208.1（0.13.8-b 批 B2）：旧实现「快照缺席即 SKIP exit 0」把构建机状态变成了门禁结果。
// 现支持 `--require`：构建链/发布链调用时，快照/资产/registry 任一缺席即**失败**（不得 SKIP）。
// 并且 ABI 由调用方传入（build-apk-013.ps1 按当前 ABI 传参），不再固定 x86_64。
//
// 用法：node scripts/check-runtime-assets.mjs [abi] [--snapshot <tar>] [--require]
//   abi         arm64 | x86_64（缺省 x86_64，仅兼容手工调用）
//   --snapshot  显式快照 tar（发布链用 dsh-mobile-apk/snapshot/snapshot-<abi>.tar.xz）
//   --require   严格模式：任何 SKIP 分支转失败（构建链/发布链必须用）
// 退出码：0 = 通过（或非严格模式下明确计数并打印的 SKIP）；1 = 资产过期 / 严格模式下缺件。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const args = process.argv.slice(2)
let ABI = 'x86_64'
let SNAP_OVERRIDE = null
let REQUIRE = process.env.DSH_REQUIRE_SNAPSHOT_ASSETS === '1'
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--snapshot') { SNAP_OVERRIDE = args[i + 1]; i += 1; continue }
  if (args[i] === '--require') { REQUIRE = true; continue }
  if (!args[i].startsWith('--')) ABI = args[i]
}

const APK_DIR = existsSync(join(ROOT, 'dsh-mobile-apk'))
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

/** 从快照里取源文件文本（tar -xO；工作目录切到快照目录，规避 Windows/MSYS 的绝对路径改写）。 */
const readFromSnapshot = (path) => {
  try {
    return execFileSync('tar', ['-xO', '-f', SNAPSHOT_NAME, path], {
      cwd: dirname(SNAP),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

let checked = 0
// ST-31：资产级 SKIP 必须与缺件 SKIP 一起**计数**（历史上这三处静默 SKIP 让「快照/资产不同源」
// 在发布链上以 exit 0 结案——发布链要求 SKIP=0，靠 --require 把每一处 SKIP 变成失败）。
const skipAsset = (msg) => {
  if (REQUIRE) fail(msg + '\n  严格模式（--require）：发布链不得以 SKIP 结案')
  skipped += 1
  console.log('SKIP(#' + skipped + ')  ' + msg)
}
for (const asset of assets) {
  const src = sourcesFor(asset)
  if (src.length === 0) {
    skipAsset(`资产 ${asset}：registry 里没有同源补丁条目`)
    continue
  }
  const text = readFileSync(join(ASSETS, asset), 'utf8')
  for (const p of src) {
    const inSnapshot = readFromSnapshot(p.target)
    if (inSnapshot === null) {
      skipAsset(`资产 ${asset} ↔ ${p.id}：快照里读不到 ${p.target}`)
      continue
    }
    if (!inSnapshot.includes(p.marker)) {
      skipAsset(`资产 ${asset} ↔ ${p.id}：补丁未打进该快照（marker 缺席）`)
      continue
    }
    checked++
    if (!text.includes(p.marker)) {
      fail(`运行时资产过期：补丁 ${p.id} 的 marker「${p.marker}」在快照里，但 ${asset} 里没有\n`
        + '  引擎启动时会用该资产覆盖运行树 → 补丁在设备上被静默回退（这就是本门禁要防的假绿）\n'
        + `  修复：从快照重新生成 ${join('app', 'src', 'main', 'assets', 'patched', asset)}`)
    }
    console.log(`PASS  资产与快照同源: ${asset}（${p.id}）`)
  }
}
if (checked === 0) {
  skip('没有任何「快照含补丁 + 资产同源」的组合可核对（abi=' + ABI + '）')
  process.exit(0)
}
console.log('CHECK-RUNTIME-ASSETS PASSED（abi=' + ABI + '，核对组合 ' + checked + '，SKIP=' + skipped + '）')
