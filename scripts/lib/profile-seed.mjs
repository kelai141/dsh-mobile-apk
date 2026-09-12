// profile-seed.mjs — 出厂 profile 清单 seed（性能 A1 落点；纯函数，可单测）。
//
// 背景（docs/ANDROID-RUNTIME-PERF-2026-09-12.md §A1，实测 −33% 冷启动 24.9s -> 16.6s）：
// 出厂 home/.dsh/profiles/web/package.json 的 dsh.profile.patchReload 决定引擎是否在启动期挂
// live reload（cordis-plugin-timer + hmr，反复现场重算客户端 combo）。Android 上 live reload
// 本就不可用（坑 19：改 cordis.patch.yml 必须冷启动才生效），因此出厂 seed 直接写 startup。
//
// 两条路径的分工：
//   - 全新安装（本模块，快照构建期 seed）：显式把键写进出厂清单；
//   - 存量升级（引擎树补丁 perf-patch-reload-N1）：旧引擎已把 live 显式写进设备清单，
//     上游「只在键缺失时写回模板默认」的归一化永远够不到它，由 N1 补丁归一化。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 出厂需要 seed 的 profile（其余 profile 元组不属安装方，引擎侧模板各自决定）。 */
export const SEED_PROFILES = ['web', 'headless']
/** 出厂默认：Android 无 live reload 收益（坑 19）。dev 档可用 DSH_PROFILE_PATCH_RELOAD=live 覆写。 */
export const SEED_DEFAULT_RELOAD = 'startup'

/**
 * Seed dsh.profile.patchReload into the staged profile manifests.
 * @param stageRoot - snapshot stage root, holding home/.dsh/profiles/<name>/package.json.
 * @param options - reload (default SEED_DEFAULT_RELOAD) and profiles (default SEED_PROFILES).
 * @returns per-profile entries: profile, path, missing, changed, value, previous.
 */
export function seedProfilePatchReload(stageRoot, options = {}) {
  const reload = options.reload === undefined ? SEED_DEFAULT_RELOAD : options.reload
  const profiles = options.profiles === undefined ? SEED_PROFILES : options.profiles
  const report = []
  for (const profile of profiles) {
    const manifestPath = join(stageRoot, 'home', '.dsh', 'profiles', profile, 'package.json')
    if (!existsSync(manifestPath)) {
      report.push({ profile, path: manifestPath, missing: true, changed: false, value: null, previous: null })
      continue
    }
    const text = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(text)
    const previous = manifest.dsh && manifest.dsh.profile ? (manifest.dsh.profile.patchReload === undefined ? null : manifest.dsh.profile.patchReload) : null
    manifest.dsh = manifest.dsh || {}
    manifest.dsh.profile = manifest.dsh.profile || {}
    manifest.dsh.profile.patchReload = reload
    const next = JSON.stringify(manifest, null, 2) + '\n'
    const changed = previous !== reload || text !== next
    if (changed) writeFileSync(manifestPath, next)
    report.push({ profile, path: manifestPath, missing: false, changed, value: reload, previous })
  }
  return report
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const stageRoot = args[0]
  const reloadIdx = args.indexOf('--reload')
  const reload = reloadIdx >= 0 ? args[reloadIdx + 1] : (process.env.DSH_PROFILE_PATCH_RELOAD || SEED_DEFAULT_RELOAD)
  if (!stageRoot) {
    console.error('用法: node scripts/lib/profile-seed.mjs <stageRoot> [--reload startup|live]')
    process.exit(2)
  }
  const report = seedProfilePatchReload(stageRoot, { reload })
  for (const r of report) {
    console.log('profile seed: ' + r.profile + ' patchReload=' + (r.value === null ? '<profile 缺席>' : r.value)
      + (r.changed ? ' (updated)' : ' (unchanged)') + ' previous=' + (r.previous === null ? 'none' : r.previous))
  }
  console.log('PROFILE-SEED OK（' + report.filter((r) => !r.missing).length + '/' + report.length + ' 个 profile，reload=' + reload + '）')
}
