// profile-seed.mjs — 出厂 profile 清单体检（纯函数，可单测；镜像面，改这里要同步 apk 侧副本）。
//
// 为什么是「体检」而不是「seed 旋钮」：0.13.8 性能 A1 曾往 dsh.profile.patchReload 写 startup
// 以关掉 live patch reload（实测冷启动 24.9s -> 16.6s），配套引擎树补丁 N1 归一化存量设备。
// 0.1.7-rc.1 起上游把这套机制整条拆了：全仓 `patchReload` 零命中，reload 链改成
// `dsh-client-hmr` 一行常驻、无 dev watcher 时**空转**（packages/bundle/web-app/cordis.patch.yml
// 自述）。⇒ 键已死，写它只会让出厂清单里躺一个没人读的字段，而门禁会去证明「我们写了一个死键」。
//
// 保留一条真实不变量：出厂清单只带上游真会读的东西（dsh.profile.bundles 非空、无死键）。
// 死键来源不是假设——0.14.1 及更早的构建把 patchReload 写进了快照，基座 home 会被后续快照继承。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 需要体检的出厂 profile（其余 profile 元组不属安装方）。 */
export const SHIPPED_PROFILES = ['web', 'headless']
/** 上游不再读取、留在清单里只会造成误读的键。 */
export const DEAD_PROFILE_KEYS = ['patchReload']

/**
 * Drop audited package trees inherited from the immutable base-dsh archive.
 * Run only in the build stage, before any factory packages are injected.
 */
export function pruneRetiredAttachmentSeed(stageRoot, baseArchive, seed) {
  if (createHash('sha256').update(readFileSync(baseArchive)).digest('hex') !== seed.sha256) return null

  const modules = join(stageRoot, 'home', '.dsh', 'profiles', 'web', 'node_modules')
  for (const name of seed.entries) {
    if (!/^(?:@[a-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Error(`Invalid retired attachment seed entry: ${name}`)
    }
    rmSync(join(modules, name), { recursive: true, force: true })
  }
  return seed.entries.length
}

/**
 * Deduplicate hoisted third-party packages from base-dsh host node_modules subdirectories
 * when the hoisted copy at `<engine>/node_modules/<pkg>` matches `expectedVersion`.
 */
export function pruneHoistedDuplicates(stageRoot, rules = []) {
  const engineNm = join(stageRoot, 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
  let removed = 0
  for (const rule of rules ?? []) {
    const pkg = rule?.package
    const expectedVersion = rule?.expectedVersion
    const hosts = rule?.hosts ?? []
    if (!pkg || !expectedVersion) continue
    const hoistedPkgJson = join(engineNm, ...pkg.split('/'), 'package.json')
    if (!existsSync(hoistedPkgJson)) continue
    let hoistedVersion
    try { hoistedVersion = JSON.parse(readFileSync(hoistedPkgJson, 'utf8')).version } catch { continue }
    if (hoistedVersion !== expectedVersion) continue
    for (const host of hosts) {
      if (!/^(?:@[a-z0-9_-]+\/)?[A-Za-z0-9_.-]+$/.test(host)) {
        throw new Error(`Invalid hoistedDedup host entry: ${host}`)
      }
      const nestedDir = join(engineNm, ...host.split('/'), 'node_modules', ...pkg.split('/'))
      const nestedPkgJson = join(nestedDir, 'package.json')
      if (!existsSync(nestedPkgJson)) continue
      try {
        const nestedVersion = JSON.parse(readFileSync(nestedPkgJson, 'utf8')).version
        if (nestedVersion !== expectedVersion) continue
      } catch {
        continue
      }
      rmSync(nestedDir, { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

/**
 * Strip dead keys from the staged profile manifests and assert the shipped shape.
 * @param stageRoot - snapshot stage root, holding home/.dsh/profiles/<name>/package.json.
 * @param options - profiles (default SHIPPED_PROFILES) and dead keys (default DEAD_PROFILE_KEYS).
 * @returns per-profile entries: profile, path, missing, changed, stripped, bundles.
 */
export function checkShippedProfileManifests(stageRoot, options = {}) {
  const profiles = options.profiles === undefined ? SHIPPED_PROFILES : options.profiles
  const deadKeys = options.deadKeys === undefined ? DEAD_PROFILE_KEYS : options.deadKeys
  const report = []
  for (const profile of profiles) {
    const manifestPath = join(stageRoot, 'home', '.dsh', 'profiles', profile, 'package.json')
    if (!existsSync(manifestPath)) {
      report.push({ profile, path: manifestPath, missing: true, changed: false, stripped: [], bundles: 0 })
      continue
    }
    const text = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(text)
    const profileSection = manifest.dsh?.profile
    const stripped = profileSection === undefined ? [] : deadKeys.filter((key) => profileSection[key] !== undefined)
    for (const key of stripped) delete profileSection[key]
    const bundles = profileSection?.bundles ?? []
    const next = JSON.stringify(manifest, null, 2) + '\n'
    const changed = next !== text
    if (changed) writeFileSync(manifestPath, next)
    report.push({ profile, path: manifestPath, missing: false, changed, stripped, bundles: bundles.length })
  }
  return report
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stageRoot = process.argv.slice(2)[0]
  if (!stageRoot) {
    console.error('用法: node scripts/lib/profile-seed.mjs <stageRoot>')
    process.exit(2)
  }
  const report = checkShippedProfileManifests(stageRoot)
  let bad = 0
  for (const r of report) {
    if (r.missing || r.bundles === 0) bad++
    console.log(`profile 体检: ${r.profile} missing=${r.missing} bundles=${String(r.bundles)}`
      + ` 死键剥除=[${r.stripped.join(', ')}]${r.changed ? ' (已改写)' : ''}`)
  }
  if (bad > 0) {
    console.error(`PROFILE-CHECK FAILED（${bad}/${report.length} 个出厂 profile 不合格）`)
    process.exit(1)
  }
  console.log(`PROFILE-CHECK OK（${report.length} 个出厂 profile：无死键、bundles 非空）`)
}
