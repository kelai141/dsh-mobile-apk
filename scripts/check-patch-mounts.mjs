#!/usr/bin/env node
/**
 * check-patch-mounts.mjs — 权威 patch 挂载集 vs 注入集校验（防 P1-F2 类回归）。
 *
 * 背景（2026-08-23 审校 C4）：profile-web.cordis.patch.yml 曾缺 android-linux-env——
 * inject-snapshot.py 把它注进快照但 patch 未挂载 → 功能静默不装载，且 update-snapshot-patch.py
 * 不校验该方向，门禁拦不住。本脚本补上：patch 中 `name:` 包名集合必须 ⊇ 注入包集合。
 *
 * 用法：node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...（pkg_dir 含 package.json）
 * 退出码：0 = 挂载集覆盖注入集；1 = 有缺失（打印缺失清单）。
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

const missing = [...injected].filter((n) => !mounted.has(n))
if (missing.length === 0) {
  console.log(`patch mounts ok: ${injected.size} 个注入包全部挂载（${[...injected].sort().join(', ')}）`)
  process.exit(0)
}
console.error(`[FAIL] patch 挂载集缺少注入包: ${missing.join(', ')}`)
console.error('（注入进快照却未挂载 = 功能静默不装载；请补 profile-web.cordis.patch.yml 条目）')
process.exit(1)
