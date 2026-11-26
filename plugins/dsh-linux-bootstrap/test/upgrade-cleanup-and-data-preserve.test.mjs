import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectManifestAssetDigests,
  createMobileBootstrap,
  pruneOldHostStaging,
  pruneOldPluginSlots,
} from '../src/index.js'

const shaOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const exists = async (target) => {
  try { await access(target); return true } catch { return false }
}

function makePluginPayload(version) {
  const pkgJson = JSON.stringify({ name: '@dsh-android/linux-runtime', version, main: 'lib/index.js' })
  const entryJs = `// runtime ${version}\nexport function apply() {}\n`
  const archiveBytes = `archive-${version}`
  return {
    pkgJson,
    entryJs,
    archiveBytes,
    sha256: shaOf(archiveBytes),
    size: Buffer.byteLength(archiveBytes, 'utf8'),
    unpackedSize: Buffer.byteLength(pkgJson, 'utf8') + Buffer.byteLength(entryJs, 'utf8'),
  }
}

function makeManifest(version, plugin, assetDigests) {
  return {
    schemaVersion: 1,
    version,
    minMobileVersion: '0.14.0',
    plugins: {
      bootstrap: {
        url: `https://github.com/o/r/releases/download/v${version}/linux-bootstrap-plugin.tar.xz`,
        sha256: plugin.sha256,
        size: plugin.size,
        unpackedSize: plugin.unpackedSize,
      },
      runtime: {
        url: `https://github.com/o/r/releases/download/v${version}/linux-runtime-plugin.tar.xz`,
        sha256: plugin.sha256,
        size: plugin.size,
        unpackedSize: plugin.unpackedSize,
      },
    },
    runtimes: [{
      id: 'debian-minimal',
      label: 'Debian minimal',
      architecture: 'arm64',
      backend: 'bionilux',
      backendAsset: {
        url: `https://github.com/o/r/releases/download/v${version}/bionilux-backend-aarch64.tar.xz`,
        sha256: assetDigests.backend,
        size: 10,
        unpackedSize: 10,
      },
      rootfsAsset: {
        url: `https://github.com/o/r/releases/download/v${version}/debian-minimal-aarch64.tar.xz`,
        sha256: assetDigests.rootfs,
        size: 10,
        unpackedSize: 10,
      },
      nodeAsset: {
        url: `https://github.com/o/r/releases/download/v${version}/node-glibc-linux-arm64.tar.xz`,
        sha256: assetDigests.node,
        size: 10,
        unpackedSize: 10,
      },
    }],
  }
}

async function stagePluginInHostStaging(stagingRoot, plugin) {
  const dir = path.join(stagingRoot, plugin.sha256)
  await mkdir(path.join(dir, 'unpacked', 'package', 'lib'), { recursive: true })
  await writeFile(path.join(dir, 'asset.tar.xz'), plugin.archiveBytes)
  await writeFile(path.join(dir, 'unpacked', 'package', 'package.json'), plugin.pkgJson)
  await writeFile(path.join(dir, 'unpacked', 'package', 'lib', 'index.js'), plugin.entryJs)
  return dir
}

async function stageDummyAsset(stagingRoot, sha256) {
  const dir = path.join(stagingRoot, sha256)
  await mkdir(path.join(dir, 'unpacked'), { recursive: true })
  await writeFile(path.join(dir, 'asset.tar.xz'), '0123456789')
  await writeFile(path.join(dir, 'unpacked', 'payload.txt'), '0123456789')
  return dir
}

async function createUpgradeFixture({ managerInstallShouldFail = false, appVersion = '0.15.1' } = {}) {
  const filesRoot = await mkdtemp(path.join(tmpdir(), 'dsh-upgrade-cleanup-'))
  const dataDir = path.join(filesRoot, 'linux-environment')
  const stagingRoot = path.join(dataDir, 'staging')
  const pluginRoot = path.join(dataDir, 'plugins', 'runtime')
  const dshHome = path.join(filesRoot, 'home', '.dsh')

  // Host user data outside linux-environment that must survive upgrades and uninstalls.
  await mkdir(path.join(dshHome, 'workspaces', 'ws-1'), { recursive: true })
  await mkdir(path.join(dshHome, 'sessions'), { recursive: true })
  await writeFile(path.join(dshHome, 'workspaces', 'ws-1', 'notes.md'), 'important-user-data')
  await writeFile(path.join(dshHome, 'sessions', 's1.json'), '{"id":"s1"}')
  await writeFile(path.join(dshHome, '.credentials.yaml'), 'secret: keep-me\n')

  const pluginV1 = makePluginPayload('0.10.7')
  const pluginV2 = makePluginPayload('0.10.8')
  const sharedNodeSha = shaOf('shared-node-v1-v2')
  const digestsV1 = { backend: shaOf('backend-0.10.7'), rootfs: shaOf('rootfs-0.10.7'), node: sharedNodeSha }
  const digestsV2 = { backend: shaOf('backend-0.10.8'), rootfs: shaOf('rootfs-0.10.8'), node: sharedNodeSha }
  const manifestV1 = makeManifest('0.10.7', pluginV1, digestsV1)
  const manifestV2 = makeManifest('0.10.8', pluginV2, digestsV2)

  let activeManifest = manifestV1
  const latestRequests = []
  let failNetwork = false
  let failManagerInstall = managerInstallShouldFail
  let activeDirectory = null

  const manager = {
    install: async (manifest) => {
      if (failManagerInstall && manifest.version === '0.10.8') {
        throw new Error('simulated manager upgrade failure')
      }
    },
    reinstall: async () => {},
    uninstall: async () => {},
    status: () => ({ healthy: true, version: activeManifest.version }),
  }

  const pluginHost = {
    install: async ({ directory }) => {
      activeDirectory = directory
      return {
        directory,
        active: true,
        manager,
        rollback: async () => { activeDirectory = null },
      }
    },
    uninstall: async () => { activeDirectory = null },
    isInjected: async ({ directory }) => {
      const target = directory ?? activeDirectory
      const present = Boolean(target && await exists(path.join(target, 'lib', 'index.js')))
      return { injected: present, active: present && activeDirectory === target }
    },
  }

  const bootstrap = createMobileBootstrap({
    dataDir,
    stagingDirectory: pluginRoot,
    hostStagingRoot: stagingRoot,
    requireStagedBundle: true,
    releaseUrl: 'https://api.github.com/repos/o/r/releases/latest',
    pluginHost,
    linuxAssetIO: {
      downloadAsset: async () => { throw new Error('must use hostStagingRoot') },
      extractArchive: async () => { throw new Error('must use hostStagingRoot') },
    },
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input)
      if (failNetwork) {
        const error = new Error('GitHub request failed (403)')
        error.status = 403
        throw error
      }
      const body = JSON.stringify(activeManifest)
      const tag = `v${activeManifest.version}`
      if (url.includes('/releases/latest')) {
        latestRequests.push(init)
        return new Response(JSON.stringify({
          tag_name: tag,
          assets: [{
            name: 'linux-release.json',
            browser_download_url: `https://github.com/o/r/releases/download/${tag}/linux-release.json`,
            size: Buffer.byteLength(body, 'utf8'),
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    },
    appVersionProvider: { getVersion: () => appVersion },
    arch: 'arm64',
  })

  return {
    filesRoot,
    dataDir,
    stagingRoot,
    pluginRoot,
    dshHome,
    pluginV1,
    pluginV2,
    digestsV1,
    digestsV2,
    sharedNodeSha,
    bootstrap,
    latestRequests,
    setManifestV2: () => { activeManifest = manifestV2 },
    setFailNetwork: (value) => { failNetwork = value },
    setFailManagerInstall: (value) => { failManagerInstall = value },
  }
}

test('release discovery and staged downloads are independent of Mobile version', async (t) => {
  const f = await createUpgradeFixture({ appVersion: '0.1.0' })
  t.after(() => rm(f.filesRoot, { recursive: true, force: true }))
  const initial = await f.bootstrap.checkForUpdates({ source: 'manual' })
  assert.equal(initial.installed, false)
  assert.equal(initial.latestReleaseVersion, '0.10.7')
  assert.equal(f.latestRequests[0].cache, 'no-store')
  assert.equal(f.latestRequests[0].headers['Cache-Control'], 'no-cache')

  await stagePluginInHostStaging(f.stagingRoot, f.pluginV1)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.rootfs)
  await stageDummyAsset(f.stagingRoot, f.sharedNodeSha)
  await f.bootstrap.install({ confirmed: true, activate: true })
  await f.bootstrap.setAutoUpdateEnabled(true)
  f.setManifestV2()

  const startup = await f.bootstrap.checkForUpdates({ source: 'automatic' })
  assert.equal(startup.latestReleaseVersion, '0.10.8')
  assert.equal(startup.version, '0.10.7')
  await f.bootstrap.checkForUpdates({ source: 'automatic' })
  assert.equal(f.latestRequests.length, 2)
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  assert.equal(f.latestRequests.length, 3)
})

test('overwrite upgrade prunes old runtime slots, old staging dirs, and .part leftovers while preserving user data and shared assets', async (t) => {
  const f = await createUpgradeFixture()
  t.after(() => rm(f.filesRoot, { recursive: true, force: true }))

  // Install 0.10.7 first.
  await stagePluginInHostStaging(f.stagingRoot, f.pluginV1)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.rootfs)
  await stageDummyAsset(f.stagingRoot, f.sharedNodeSha)
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  const v1Status = await f.bootstrap.install({ confirmed: true, activate: true })
  assert.equal(v1Status.version, '0.10.7')

  // Simulate interrupted download .part leftovers + unrelated non-slot directory in dataDir.
  const stalePartRoot = path.join(f.dataDir, `staging-${'1'.repeat(64)}.part`)
  const stalePartNested = path.join(f.stagingRoot, `staging-${'2'.repeat(64)}.part`)
  const nonSlotNoteDir = path.join(f.dataDir, 'custom-user-note')
  await mkdir(stalePartRoot, { recursive: true })
  await writeFile(path.join(stalePartRoot, 'asset.tar.xz'), 'partial')
  await mkdir(stalePartNested, { recursive: true })
  await mkdir(nonSlotNoteDir, { recursive: true })
  await writeFile(path.join(nonSlotNoteDir, 'keep.txt'), 'keep')

  // Upstream publishes 0.10.8; auto-check detects update, host stages 0.10.8 assets, user upgrades.
  f.setManifestV2()
  const checked = await f.bootstrap.checkForUpdates({ source: 'manual' })
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.availableVersion, '0.10.8')

  await stagePluginInHostStaging(f.stagingRoot, f.pluginV2)
  await stageDummyAsset(f.stagingRoot, f.digestsV2.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV2.rootfs)
  await stageDummyAsset(f.stagingRoot, f.sharedNodeSha)

  const v2Status = await f.bootstrap.install({ confirmed: true, activate: true })
  assert.equal(v2Status.installed, true)
  assert.equal(v2Status.version, '0.10.8')
  assert.equal(v2Status.updateAvailable, false)

  // Active v2 plugin slot & v2 staging archives (including shared node) MUST survive,
  // while derived staging/<sha>/unpacked trees are reclaimed after commit.
  assert.equal(await exists(path.join(f.pluginRoot, f.pluginV2.sha256, 'lib', 'index.js')), true)
  assert.equal(await exists(path.join(f.stagingRoot, f.pluginV2.sha256, 'asset.tar.xz')), true)
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV2.backend, 'asset.tar.xz')), true)
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV2.rootfs, 'asset.tar.xz')), true)
  assert.equal(await exists(path.join(f.stagingRoot, f.sharedNodeSha, 'asset.tar.xz')), true)
  assert.equal(await exists(path.join(f.stagingRoot, f.pluginV2.sha256, 'unpacked')), false)
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV2.backend, 'unpacked')), false)
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV2.rootfs, 'unpacked')), false)
  assert.equal(await exists(path.join(f.stagingRoot, f.sharedNodeSha, 'unpacked')), false)

  // Retired v1 plugin slot, retired v1 staging dirs, and .part leftovers MUST be cleaned.
  assert.equal(await exists(path.join(f.pluginRoot, f.pluginV1.sha256)), false, 'old runtime plugin slot must be pruned')
  assert.equal(await exists(path.join(f.stagingRoot, f.pluginV1.sha256)), false, 'old plugin staging must be pruned')
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV1.backend)), false, 'old backend staging must be pruned')
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV1.rootfs)), false, 'old rootfs staging must be pruned')
  assert.equal(await exists(stalePartRoot), false, 'stale .part in dataDir must be pruned')
  assert.equal(await exists(stalePartNested), false, 'stale .part in stagingRoot must be pruned')

  // Host user data & state file MUST stay intact.
  assert.equal(await readFile(path.join(f.dshHome, 'workspaces', 'ws-1', 'notes.md'), 'utf8'), 'important-user-data')
  assert.equal(await readFile(path.join(f.dshHome, 'sessions', 's1.json'), 'utf8'), '{"id":"s1"}')
  assert.equal(await readFile(path.join(f.dshHome, '.credentials.yaml'), 'utf8'), 'secret: keep-me\n')
  assert.equal(await readFile(path.join(nonSlotNoteDir, 'keep.txt'), 'utf8'), 'keep')
  const state = JSON.parse(await readFile(path.join(f.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(state.installedLinuxVersion, '0.10.8')
})

test('failed upgrade rolls back and never prunes the active previous version or staging', async (t) => {
  const f = await createUpgradeFixture({ managerInstallShouldFail: true })
  t.after(() => rm(f.filesRoot, { recursive: true, force: true }))

  await stagePluginInHostStaging(f.stagingRoot, f.pluginV1)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.rootfs)
  await stageDummyAsset(f.stagingRoot, f.sharedNodeSha)
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  await f.bootstrap.install({ confirmed: true, activate: true })

  f.setManifestV2()
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  await stagePluginInHostStaging(f.stagingRoot, f.pluginV2)
  await stageDummyAsset(f.stagingRoot, f.digestsV2.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV2.rootfs)

  await assert.rejects(f.bootstrap.install({ confirmed: true, activate: true }), /simulated manager upgrade failure/)

  // Negative assertion: active v1 files and staging must remain intact when upgrade fails.
  assert.equal(await exists(path.join(f.pluginRoot, f.pluginV1.sha256, 'lib', 'index.js')), true)
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV1.backend, 'asset.tar.xz')), true)
  const state = JSON.parse(await readFile(path.join(f.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(state.installedLinuxVersion, '0.10.7')
  assert.match(String(state.lastError), /simulated manager upgrade failure/)
})

test('uninstall cleans all runtime slots, staging dirs, and .part leftovers while preserving host user data', async (t) => {
  const f = await createUpgradeFixture()
  t.after(() => rm(f.filesRoot, { recursive: true, force: true }))

  await stagePluginInHostStaging(f.stagingRoot, f.pluginV1)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.rootfs)
  await stageDummyAsset(f.stagingRoot, f.sharedNodeSha)
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  await f.bootstrap.install({ confirmed: true, activate: true })

  const stalePart = path.join(f.dataDir, `staging-${'9'.repeat(64)}.part`)
  await mkdir(stalePart, { recursive: true })

  const afterUninstall = await f.bootstrap.uninstall({ confirmed: true })
  assert.equal(afterUninstall.installed, false)
  assert.equal(await exists(path.join(f.pluginRoot, f.pluginV1.sha256)), false)
  assert.equal(await exists(path.join(f.stagingRoot, f.digestsV1.backend)), false)
  assert.equal(await exists(path.join(f.stagingRoot, f.sharedNodeSha)), false)
  assert.equal(await exists(stalePart), false)
  assert.equal(await exists(path.join(f.dataDir, 'linux-bootstrap-state.json')), true)
  assert.equal(await readFile(path.join(f.dshHome, 'workspaces', 'ws-1', 'notes.md'), 'utf8'), 'important-user-data')
})

test('offline or rate-limited check failure keeps installed runtime error-free and reinstallable', async (t) => {
  const f = await createUpgradeFixture()
  t.after(() => rm(f.filesRoot, { recursive: true, force: true }))

  await stagePluginInHostStaging(f.stagingRoot, f.pluginV1)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.backend)
  await stageDummyAsset(f.stagingRoot, f.digestsV1.rootfs)
  await stageDummyAsset(f.stagingRoot, f.sharedNodeSha)
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  await f.bootstrap.install({ confirmed: true, activate: true })

  f.setFailNetwork(true)
  await assert.rejects(f.bootstrap.checkForUpdates({ source: 'manual' }), /403/)

  const status = await f.bootstrap.status()
  assert.equal(status.installed, true)
  assert.equal(status.error, null, 'check failure must not mark healthy runtime as failed')
  assert.match(String(status.checkError), /403/)

  // Reinstall from pinnedManifest still works offline.
  const reinstalled = await f.bootstrap.reinstall({ confirmed: true, activate: true })
  assert.equal(reinstalled.installed, true)
  assert.equal(reinstalled.version, '0.10.7')
})

test('cleanup helpers refuse symlinks and non-matching directories', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cleanup-guards-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pluginRoot = path.join(dir, 'plugins', 'runtime')
  const stagingRoot = path.join(dir, 'staging')
  const outside = path.join(dir, 'outside-user-data')
  await mkdir(pluginRoot, { recursive: true })
  await mkdir(stagingRoot, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'secret.txt'), 'keep')

  const keepSha = 'a'.repeat(64)
  const oldSha = 'b'.repeat(64)
  await mkdir(path.join(pluginRoot, keepSha), { recursive: true })
  await mkdir(path.join(pluginRoot, oldSha), { recursive: true })
  await mkdir(path.join(pluginRoot, 'not-a-sha-dir'), { recursive: true })
  await mkdir(path.join(stagingRoot, keepSha), { recursive: true })
  await mkdir(path.join(stagingRoot, oldSha), { recursive: true })
  await mkdir(path.join(dir, 'staging-notsha.part'), { recursive: true })

  // Symlink named like a 64-hex sha slot must not be followed or removed.
  const symlinkName = 'c'.repeat(64)
  try {
    await symlink(outside, path.join(stagingRoot, symlinkName))
  } catch { /* ignore on platforms without symlink permission */ }

  await pruneOldPluginSlots(pluginRoot, { keepDirectory: path.join(pluginRoot, keepSha) })
  await pruneOldHostStaging(stagingRoot, { keepShas: new Set([keepSha]) })

  assert.equal(await exists(path.join(pluginRoot, keepSha)), true)
  assert.equal(await exists(path.join(pluginRoot, oldSha)), false)
  assert.equal(await exists(path.join(pluginRoot, 'not-a-sha-dir')), true)
  assert.equal(await exists(path.join(stagingRoot, keepSha)), true)
  assert.equal(await exists(path.join(stagingRoot, oldSha)), false)
  assert.equal(await exists(path.join(dir, 'staging-notsha.part')), true)
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'keep')
  assert.equal(collectManifestAssetDigests(null).size, 0)
  // Verify symlink target still exists if symlink was created.
  const linkStat = await lstat(path.join(stagingRoot, symlinkName)).catch(() => null)
  if (linkStat) assert.equal(linkStat.isSymbolicLink(), true)
})

test('pruneOldHostStaging reclaims unpacked only when asset.tar.xz exists and no active part dir matches', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-unpacked-prune-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const stagingRoot = path.join(dir, 'staging')
  const shaReady = '1'.repeat(64)
  const shaActivePart = '2'.repeat(64)
  const shaNoArchive = '3'.repeat(64)

  await stageDummyAsset(stagingRoot, shaReady)
  await stageDummyAsset(stagingRoot, shaActivePart)
  await mkdir(path.join(dir, `staging-${shaActivePart}.part`), { recursive: true })
  await mkdir(path.join(stagingRoot, shaNoArchive, 'unpacked'), { recursive: true })
  await writeFile(path.join(stagingRoot, shaNoArchive, 'unpacked', 'payload.txt'), 'keep')

  await pruneOldHostStaging(stagingRoot, {
    keepShas: new Set([shaReady, shaActivePart, shaNoArchive]),
    pruneUnpackedForKeepShas: true,
    keepPartShas: true,
  })

  assert.equal(await exists(path.join(stagingRoot, shaReady, 'asset.tar.xz')), true)
  assert.equal(await exists(path.join(stagingRoot, shaReady, 'unpacked')), false)
  assert.equal(await exists(path.join(stagingRoot, shaActivePart, 'unpacked')), true)
  assert.equal(await exists(path.join(stagingRoot, shaNoArchive, 'unpacked', 'payload.txt')), true)
})
