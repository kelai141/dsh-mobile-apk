#!/usr/bin/env node
/**
 * check-patch-mounts.mjs — 权威 patch 挂载集 vs 注入集**双向**校验（防 P1-F2 类回归 + ST-06 反向缺席）。
 *
 * 背景（2026-08-23 审校 C4）：profile-web.cordis.patch.yml 曾缺 android-linux-env——
 * inject-snapshot.py 把它注进快照但 patch 未挂载 → 功能静默不装载，且 update-snapshot-patch.py
 * 不校验该方向，门禁拦不住。本脚本补上：patch 中 `name:` 包名集合必须 ⊇ 注入包集合。
 *
 * 反向差集（0.13.8-b ST-06 / F-ENV-05）：只做单向 `注入 ⊆ 挂载` 抓不到相反方向——
 * 从注入清单（scripts/plugin-dirs.json）删掉一个包而权威 patch 仍挂载它时，快照里那个包
 * 就不再被注入（或注入旧版），上游只报「模块找不到」，而单向门禁**全绿**。
 * 判定：挂载集里的**本仓注入面**必须都在注入集内。`@deepseek-ai/*` 由引擎树自带（不在注入集
 * 内，属合法差异）；其余挂载项（`@dsh-android/*` 与 vendor 固化包）都是本仓注入面。
 *
 * 用法：node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...（pkg_dir 含 package.json）
 * 退出码：0 = 双向一致；1 = 任一方向有缺失（打印缺失清单）；2 = 用法错误。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [patchPath, ...dirs] = process.argv.slice(2)
if (!patchPath || dirs.length === 0) {
  console.error('用法: node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...')
  process.exit(2)
}

const patch = readFileSync(patchPath, 'utf8')
// patch 挂载集：`name: xxx` 行的包名（含 @scope/ 形式；- id: 行忽略）
const mounted = new Set(
  [...patch.matchAll(/^\s+name:\s*'?([^'\n]+)'?$/gm)].map((m) => m[1].trim()),
)

const injected = new Set()
for (const d of dirs) {
  try {
    const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    injected.add(pkg.name)
  } catch {
    injected.add(d.split(/[\\/]/).pop())
  }
}

// 正向：注入集 ⊆ 挂载集（注入进快照却未挂载 = 功能静默不装载）
const missing = [...injected].filter((n) => !mounted.has(n))
// 反向：挂载集 ∩ 本仓注入面 ⊆ 注入集（挂载了但清单/调用方没注入 = 装配失败或旧版残留）
const ENGINE_SCOPE = '@deepseek-ai/'
const unmounted = [...mounted].filter((n) => !injected.has(n) && !n.startsWith(ENGINE_SCOPE))

if (missing.length === 0 && unmounted.length === 0) {
  console.log(`patch mounts ok (双向): ${injected.size} 个注入包全部挂载（${[...injected].sort().join(', ')}）`)
  process.exit(0)
}
if (missing.length > 0) {
  console.error(`❌ patch 挂载集缺少注入包: ${missing.join(', ')}`)
  console.error('（注入进快照却未挂载 = 功能静默不装载；请补 profile-web.cordis.patch.yml 条目）')
}
if (unmounted.length > 0) {
  console.error(`❌ 权威 patch 挂载了注入面之外的包（反向差集）: ${unmounted.join(', ')}`)
  console.error('（清理单里删了包/patch 多挂了条目 = 快照缺该包或版本停留旧值；'
    + '请把包补回 scripts/plugin-dirs.json 对应链，或从 profile-web.cordis.patch.yml 删条目）')
}
process.exit(1)
