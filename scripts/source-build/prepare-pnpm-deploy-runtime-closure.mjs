#!/usr/bin/env node
// Temporarily add every source-built first-party overlay package to the actual
// pnpm deploy target's production graph, updating its frozen importer directly.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'

const [sourceArg, overlayArg, backupArg, reportArg] = process.argv.slice(2)
if (!sourceArg || !overlayArg || !backupArg || !reportArg) {
  console.error('usage: node prepare-pnpm-deploy-runtime-closure.mjs <harness-source-root> <engine-overlay.json> <backup-dir> <report.json>')
  process.exit(2)
}

const sourceRoot = resolve(sourceArg)
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
// 身份一律从合同读（0.14.8）：写死的提交/版本号会随每次引擎追版漂移。
const contract = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'contract.json'), 'utf8'))
if (sourceCommit !== contract.upstream.commit || sourceManifest.version !== contract.baseline
  || sourceManifest.packageManager !== contract.upstream.packageManager) {
  throw new Error('production deployment requires official ' + contract.baseline + ' source and ' + contract.upstream.packageManager)
}
const cliDir = join(sourceRoot, 'apps', 'cli')
const packageFile = join(cliDir, 'package.json')
const lockFile = join(sourceRoot, 'pnpm-lock.yaml')
const workspaceFile = join(sourceRoot, 'pnpm-workspace.yaml')
const backupDir = resolve(backupArg)
const reportFile = resolve(reportArg)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const originalPackage = readFileSync(packageFile)
const originalLock = readFileSync(lockFile)
const originalWorkspace = readFileSync(workspaceFile)
const manifest = JSON.parse(originalPackage.toString('utf8'))
const overlay = JSON.parse(readFileSync(resolve(overlayArg), 'utf8'))
if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.0-rc.2'
  || overlay.engineVersion !== '0.2.0-rc.2' || overlay.rootPackage?.version !== '0.2.0-rc.2') {
  throw new Error('production deployment manifest/overlay must target 0.2.0-rc.2')
}
const packages = Object.entries(overlay.packages ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/'))
  .sort(([a], [b]) => a.localeCompare(b))
if (packages.length < 200) throw new Error(`expected the pinned first-party package set, found ${packages.length}`)

const requireFromCli = createRequire(packageFile)
const yaml = requireFromCli('js-yaml')
const lock = yaml.load(originalLock.toString('utf8'))
const workspaceConfig = yaml.load(originalWorkspace.toString('utf8'))
const importer = lock.importers?.['apps/cli']
if (!importer) throw new Error('pnpm-lock.yaml is missing the apps/cli importer')

// The source audit targets Android ARM64, while pnpm deploy runs on Linux x64.
// Include the upstream Koffi Android binding and Sharp's official WASM backend
// explicitly in the production closure so those platform-specific runtime
// fallbacks survive the cross-platform deployment step.
const androidRuntimeDependencies = {
  '@img/sharp-wasm32': '0.35.3',
}
const dependencies = { ...(manifest.dependencies ?? {}) }
const importerDependencies = { ...(importer.dependencies ?? {}) }
for (const [name, version] of Object.entries(androidRuntimeDependencies)) {
  dependencies[name] = version
  importerDependencies[name] = { specifier: version, version }
}
workspaceConfig.overrides = { ...(workspaceConfig.overrides ?? {}), koffi: '3.2.1' }
const supported = workspaceConfig.supportedArchitectures ?? {}
workspaceConfig.supportedArchitectures = {
  ...supported,
  os: [...new Set([...(supported.os ?? ['current']), 'android'])],
  cpu: [...new Set([...(supported.cpu ?? ['current']), 'arm64'])],
}

const packageDirs = new Map()
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.name === 'package.json') {
      let candidate
      try { candidate = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (typeof candidate.name === 'string') packageDirs.set(candidate.name, dirname(file))
    }
  }
}
walk(sourceRoot)

mkdirSync(backupDir, { recursive: true })
copyFileSync(packageFile, join(backupDir, 'apps-cli-package.json.original'))
copyFileSync(lockFile, join(backupDir, 'pnpm-lock.yaml.original'))

const sections = ['devDependencies', 'optionalDependencies', 'peerDependencies']
const removedFrom = Object.fromEntries(sections.map((section) => [section, []]))
const removedFromImporter = Object.fromEntries(['devDependencies', 'optionalDependencies', 'peerDependencies'].map((section) => [section, []]))
const forcedWorkspacePackages = []
for (const [name] of packages) {
  const packageDir = packageDirs.get(name)
  if (!packageDir) throw new Error(`no pinned workspace source package found for ${name}`)
  const linkPath = relative(cliDir, packageDir).replaceAll('\\', '/')
  if (!linkPath.startsWith('../')) throw new Error(`${name} resolves inside apps/cli instead of a sibling workspace package: ${linkPath}`)
  dependencies[name] = 'workspace:*'
  importerDependencies[name] = { specifier: 'workspace:*', version: `link:${linkPath}` }
  for (const section of sections) {
    if (manifest[section] && Object.hasOwn(manifest[section], name)) {
      delete manifest[section][name]
      removedFrom[section].push(name)
    }
  }
  for (const section of Object.keys(removedFromImporter)) {
    if (importer[section] && Object.hasOwn(importer[section], name)) {
      delete importer[section][name]
      removedFromImporter[section].push(name)
    }
  }
  forcedWorkspacePackages.push({ name, path: linkPath })
}

manifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
for (const section of sections) {
  if (manifest[section] && !Object.keys(manifest[section]).length) delete manifest[section]
}
importer.dependencies = Object.fromEntries(Object.entries(importerDependencies).sort(([a], [b]) => a.localeCompare(b)))
for (const section of Object.keys(removedFromImporter)) {
  if (importer[section] && !Object.keys(importer[section]).length) delete importer[section]
}

const temporaryPackage = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
const temporaryLock = Buffer.from(yaml.dump(lock, { lineWidth: -1, noRefs: true, quotingType: "'" }))
writeFileSync(packageFile, temporaryPackage)
writeFileSync(lockFile, temporaryLock)
const temporaryWorkspace = Buffer.from(yaml.dump(workspaceConfig, { lineWidth: -1, noRefs: true, quotingType: "'" }))
writeFileSync(workspaceFile, temporaryWorkspace)
writeFileSync(reportFile, JSON.stringify({
  sourceCommit,
  deployTarget: 'apps/cli (@deepseek-ai/dsh)',
  originalPackageJsonSha256: sha256(originalPackage),
  temporaryPackageJsonSha256: sha256(temporaryPackage),
  originalLockfileSha256: sha256(originalLock),
  temporaryLockfileSha256: sha256(temporaryLock),
  originalWorkspaceConfigSha256: sha256(originalWorkspace),
  temporaryWorkspaceConfigSha256: sha256(temporaryWorkspace),
  packageCount: forcedWorkspacePackages.length,
  productionWorkspacePackages: forcedWorkspacePackages,
  androidRuntimeDependencies: {
    ...androidRuntimeDependencies,
    koffiOverride: '3.2.1',
    supportedArchitectures: workspaceConfig.supportedArchitectures,
    rationale: 'Koffi 3.1.1 has no Android ARM64 binding; upstream Koffi 3.2.1 publishes @koromix/koffi-android-arm64. sharp 0.35.3 uses @img/sharp-wasm32 as its Android-compatible fallback. Both exact upstream packages are included in the pnpm lock and deployment closure.',
  },
  removedFromManifestSections: removedFrom,
  removedFromImporterSections: removedFromImporter,
  purpose: 'Temporarily add pinned first-party overlay workspace packages and required Android runtime fallback packages to the apps/cli production deploy graph, pin Koffi to its official Android-capable version, and enable Android ARM64 optional dependencies. Original apps/cli/package.json, pnpm-lock.yaml, and pnpm-workspace.yaml are restored after deployment.',
}, null, 2) + '\n')
console.log(`prepared apps/cli production dependency closure for ${forcedWorkspacePackages.length} first-party packages`)
