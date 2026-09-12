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
// 资产过期即拒打包（并在错误里给出重新生成的命令）。快照缺席（CI 未构建快照）时 SKIP。
//
// 用法：node scripts/check-runtime-assets.mjs [abi]（默认 x86_64）
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const APK_DIR = existsSync(join(ROOT, 'dsh-mobile-apk'))
  ? join(ROOT, 'dsh-mobile-apk')
  : ROOT
const ABI = process.argv[2] ?? 'x86_64'
const SNAP = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')
const SNAPSHOT_NAME = 'snapshot.tar.xz'
const ASSETS = join(APK_DIR, 'app', 'src', 'main', 'assets', 'patched')

const fail = (msg) => {
  console.error('CHECK-RUNTIME-ASSETS FAILED：' + msg)
  process.exit(1)
}
const skip = (msg) => {
  console.log('SKIP  ' + msg)
  process.exit(0)
}

if (!existsSync(ASSETS)) skip(`无运行时资产目录（${ASSETS}）——协调仓或未注入的树`)
if (!existsSync(SNAP)) skip(`快照不在场（${SNAP}）——先构建快照再跑本门禁`)
if (!existsSync(join(ROOT, 'scripts', 'patches', 'registry.json'))) {
  skip('registry.json 不在场（apk 仓自包含树请用协调仓跑本门禁）')
}

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
const patches = (registry.patches ?? []).filter((p) => p.scope === 'engine' && p.marker)
const assets = readdirSync(ASSETS).filter((f) => f.endsWith('.js'))
if (assets.length === 0) skip('assets/patched 下没有 .js 资产')

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
for (const asset of assets) {
  const src = sourcesFor(asset)
  if (src.length === 0) {
    console.log(`SKIP  资产 ${asset}：registry 里没有同源补丁条目`)
    continue
  }
  const text = readFileSync(join(ASSETS, asset), 'utf8')
  for (const p of src) {
    const inSnapshot = readFromSnapshot(p.target)
    if (inSnapshot === null) {
      console.log(`SKIP  资产 ${asset} ↔ ${p.id}：快照里读不到 ${p.target}`)
      continue
    }
    if (!inSnapshot.includes(p.marker)) {
      console.log(`SKIP  资产 ${asset} ↔ ${p.id}：补丁未打进该快照（marker 缺席）`)
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
if (checked === 0) skip('没有任何「快照含补丁 + 资产同源」的组合可核对')
console.log('CHECK-RUNTIME-ASSETS PASSED')
