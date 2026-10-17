#!/usr/bin/env node
// Package the pinned DeepSeek Harness workspace after its source build. This
// creates the cache layout consumed by build-snapshot-013.mjs, without npm
// release tarballs for first-party @deepseek-ai packages.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
// 规范化实现与检查器**共用同一份**（见 normalize-snapshot.mjs 顶部）：构建期写进去的
// 规范形态与校验期算出来的必须是同一件事，否则摘要对不上。两处各写一份迟早漂移。
import { canonicalizePackedManifest } from './normalize-snapshot.mjs'

const repo = resolve(process.argv[2] ?? '')
const cache = resolve(process.argv[3] ?? '')
const expectedCommit = '639ed015397290b3745d163aafe02ffee4aa3f84'
const overlayPath = resolve('scripts/snapshot-config/engine-overlay.json')
if (!process.argv[2] || !process.argv[3]) {
  console.error('usage: node scripts/source-build/export-dsh-engine.mjs <dsh-source-root> <overlay-cache>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const commit = git('rev-parse', 'HEAD')
if (commit !== expectedCommit) throw new Error(`unexpected DeepSeek Harness commit: ${commit}`)

const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
const sourcePackage = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
// 身份一律从合同读（0.14.8）：上游 0.2.1 把 pnpm 由 11.7.0 抬到 11.28.5。
// 写死版本号的后果是每次引擎追版后这条断言静默失效或误判红。
const contract = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'contract.json'), 'utf8'))
if (sourcePackage.version !== contract.baseline || sourcePackage.packageManager !== contract.upstream.packageManager
  || overlay.engineVersion !== contract.baseline || overlay.rootPackage?.version !== contract.baseline) {
  throw new Error('source export requires official ' + contract.baseline + ' source/overlay and ' + contract.upstream.packageManager)
}
const lockfilePath = join(repo, 'pnpm-lock.yaml')
if (!existsSync(lockfilePath)) throw new Error('pinned Harness source is missing pnpm-lock.yaml')
const vendorOverridePath = resolve('.deploy-tmp/source-build/harness-vendor-overrides.json')
const vendorOverrideReport = JSON.parse(readFileSync(vendorOverridePath, 'utf8'))
if (vendorOverrideReport.harnessSourceCommit !== expectedCommit
  || vendorOverrideReport.mode !== 'pinned-target-source-evidence' || vendorOverrideReport.rewoundSourceCount !== 0) {
  throw new Error(`vendor source overrides target ${vendorOverrideReport.harnessSourceCommit}, expected ${expectedCommit}`)
}
const packageSourceCommits = new Map((vendorOverrideReport.overrides ?? []).map((item) => [item.package, item.sourceCommit]))
const wanted = new Map(Object.entries(overlay.packages).filter(([name]) => name.startsWith('@deepseek-ai/')))
wanted.set(overlay.rootPackage.name, overlay.rootPackage.version)
// 断言口径是「overlay 是否钉了这个包」，不是「本次导出是否打包了它」。两者必须分开：
// 生产侧 prepare-harness-vendor-overrides.py 解析每个受审包的 pin 时取 `packages`
// **或** `vendorTop`，而 @deepseek-ai/cosmokit 合法地只出现在 vendorTop（1.8.5）——
// 旧口径只查 packages，于是 0.2.0-rc.2 首次把 cosmokit 纳入审计即在此判红，而这条链
// 自那以后没人跑过。只有 `wanted`（packages + rootPackage）会被打包；vendorTop 成员由
// 运行时树自己的 vendor 路径装机，从不经本缓存。
const overlayPins = new Set([...wanted.keys(), ...Object.keys(overlay.vendorTop ?? {})])

const manifests = new Map()
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.name === 'package.json') {
      let manifest
      try { manifest = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (typeof manifest.name === 'string') manifests.set(manifest.name, { file, manifest })
    }
  }
}
walk(repo)

for (const [name, sourceCommit] of packageSourceCommits) {
  if (!overlayPins.has(name)) throw new Error(`source override is not present in the engine overlay: ${name}`)
  if (!sourceCommit || !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`invalid source commit for ${name}`)
}

rmSync(cache, { recursive: true, force: true })
mkdirSync(cache, { recursive: true })
const tmp = join(cache, '.pack')
mkdirSync(tmp, { recursive: true })
const packed = []
for (const [name, version] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
  const entry = manifests.get(name)
  if (!entry) throw new Error(`missing source package: ${name}`)
  // Every pin follows the official target manifest. Vendor evidence audits the
  // same target without rewinding sources; packed versions are never rewritten.
  if (entry.manifest.version !== version) {
    throw new Error(`${name} source version ${entry.manifest.version} does not match overlay pin ${version}`)
  }

  const dir = dirname(entry.file)
  for (const file of readdirSync(tmp)) rmSync(join(tmp, file), { recursive: true, force: true })
  execFileSync('pnpm', ['--dir', dir, 'pack', '--pack-destination', tmp], { cwd: repo, stdio: 'inherit' })
  const candidates = readdirSync(tmp).filter((file) => file.endsWith('.tgz'))
  if (candidates.length !== 1) throw new Error(`${name}: expected one pack output, got ${candidates.length}`)
  const outName = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
  const outPath = join(cache, outName)
  renameSync(join(tmp, candidates[0]), outPath)
  canonicalizePackedManifest(outPath, name)
  const digest = createHash('sha256').update(readFileSync(outPath)).digest('hex')
  packed.push({
    name,
    version,
    sourceCommit: packageSourceCommits.get(name) ?? commit,
    sourcePath: relative(repo, dir).replaceAll('\\', '/'),
    sha256: digest,
    file: outName,
  })
  console.log(`source-pack ${name}@${version} ${digest}`)
}
rmSync(tmp, { recursive: true, force: true })
writeFileSync(join(cache, 'source-build-manifest.json'), JSON.stringify({
  source: 'https://github.com/deepseek-ai/deepseek-harness',
  commit,
  packageManager: sourcePackage.packageManager,
  lockfileSha256: createHash('sha256').update(readFileSync(lockfilePath)).digest('hex'),
  vendorSourceOverrides: vendorOverrideReport.overrides.map(({ package: name, path, version, sourceCommit, sourceTree, sourceManifestSha256 }) => ({
    package: name,
    path,
    version,
    sourceCommit,
    sourceTree,
    sourceManifestSha256,
  })),
  packageCount: packed.length,
  packages: packed,
}, null, 2) + '\n')
