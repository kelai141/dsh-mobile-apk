// issue #1790：安装链路的两处盲区。
//
// 1) install() 每次硬拉 GitHub API，未认证配额（60 次/小时/IP，共享 NAT 极易打满）
//    一旦 403，就在 installRuntime() 之前抛错 —— 而资产早已由宿主下载、校验、解包
//    完毕，本地完全具备安装条件。
// 2) installRuntime 的失败分支只写内存里的 state.lastError，不落盘；设置页随即从磁盘
//    重新读取，于是真因在下一拍轮询里消失，用户与开发者都只剩一句兜底文案。
//
// 判据都是行为：让 fetchManifest 抛 403，看 install 是否仍然成功；让 manager.install
// 抛错，看 state 文件里是否留下原因。
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'

import { createMobileBootstrap } from '../src/index.js'


// The fake downloader writes the same bytes the manifest declares, so the real
// SHA-256 check in installVerifiedPluginBundle passes without a fixture .tar.xz.
const PLUGIN_BYTES = 'x'.repeat(10)
const PACKAGE_JSON = JSON.stringify({ name: '@dsh-android/linux-runtime', version: '0.10.0', main: 'index.js' })
// Unpacked tree = package.json + index.js. Pick a total comfortably above the
// metadata so the padding is always non-negative, and derive it from the real
// JSON length so the assertion cannot drift.
const PLUGIN_UNPACKED = Buffer.byteLength(PACKAGE_JSON, 'utf8') + 64
const PLUGIN_SHA = createHash('sha256').update(PLUGIN_BYTES).digest('hex')

const MANIFEST = {
  schemaVersion: 1,
  version: '0.10.0',
  minMobileVersion: '0.14.0',
  plugins: {
    bootstrap: { url: 'https://github.com/o/r/releases/download/v0.10.0/linux-bootstrap-plugin.tar.xz', sha256: PLUGIN_SHA, size: 10, unpackedSize: PLUGIN_UNPACKED },
    runtime: { url: 'https://github.com/o/r/releases/download/v0.10.0/linux-runtime-plugin.tar.xz', sha256: PLUGIN_SHA, size: 10, unpackedSize: PLUGIN_UNPACKED },
  },
  runtimes: [{
    id: 'debian-minimal',
    label: 'Debian',
    architecture: 'arm64',
    backend: 'bionilux',
    backendAsset: { url: 'https://github.com/o/r/releases/download/v0.10.0/bionilux-backend-aarch64.tar.xz', sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', size: 10, unpackedSize: 10 },
    rootfsAsset: { url: 'https://github.com/o/r/releases/download/v0.10.0/debian-minimal-aarch64.tar.xz', sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', size: 10, unpackedSize: 10 },
    nodeAsset: { url: 'https://github.com/o/r/releases/download/v0.10.0/node-glibc-linux-arm64.tar.xz', sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', size: 10, unpackedSize: 10 },
  }],
}

/** A bootstrap whose manifest fetch fails the way a rate-limited GitHub does. */
async function fixture({ managerInstallThrows = false } = {}) {
  // Mutable on purpose: the real sequence is "check succeeds (rate limit still
  // available), then the limit is exhausted and install hits 403".
  const net = { fails: false }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-1790-'))
  const saved = []
  const manager = {
    install: async () => {
      if (managerInstallThrows) throw new Error('prepare-rootfs.sh failed: find: Permission denied')
    },
    uninstall: async () => {},
    status: () => ({ healthy: false }),
  }
  const pluginHost = {
    install: async () => ({ manager }),
    uninstall: async () => {},
    status: async () => ({ injectionActivated: true }),
  }
  const bootstrap = createMobileBootstrap({
    dataDir,
    releaseUrl: 'https://api.github.com/repos/o/r/releases/latest',
    pluginHost,
    linuxAssetIO: {
      // Produce a regular file whose digest matches the manifest entry, then a
      // package tree of exactly the declared unpackedSize. This keeps the real
      // installVerifiedPluginBundle() in the path: the fix under test is the
      // manifest source, not the verification.
      downloadAsset: async (asset, { destination }) => {
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, PLUGIN_BYTES)
        return { path: destination, size: asset.size }
      },
      extractArchive: async (_archive, destination) => {
        // The unpacked tree must measure exactly unpackedSize, so the trailing
        // padding is computed from the real metadata files this writes.
        await mkdir(destination, { recursive: true })
        await writeFile(path.join(destination, 'package.json'), PACKAGE_JSON)
        const pad = PLUGIN_UNPACKED - Buffer.byteLength(PACKAGE_JSON, 'utf8')
        // The runtime package keeps its entry at lib/index.js, so mirror that.
        await mkdir(path.join(destination, 'lib'), { recursive: true })
        await writeFile(path.join(destination, 'lib', 'index.js'), 'x'.repeat(Math.max(0, pad)))
      },
    },
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input)
      if (net.fails) {
        const error = new Error('GitHub request failed (403)')
        error.status = 403
        throw error
      }
      // fetchLatestManifest does two hops: the latest-release document, then the
      // version-pinned manifest asset. Model both so the success path is real.
      const manifestBody = JSON.stringify(MANIFEST)
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify({
          tag_name: 'v0.10.0',
          assets: [{
            name: 'linux-release.json',
            browser_download_url: 'https://github.com/o/r/releases/download/v0.10.0/linux-release.json',
            // Must match the body byte-for-byte: readManifest cross-checks size.
            size: Buffer.byteLength(manifestBody, 'utf8'),
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(manifestBody, { status: 200, headers: { 'content-type': 'application/json' } })
    },
    appVersionProvider: { getVersion: () => '0.15.0' },
    arch: 'arm64',
    statePath: path.join(dataDir, 'linux-bootstrap-state.json'),
  })
  return { dataDir, bootstrap, net }
}

test('安装不再强依赖实时 manifest：403 时用上次 check 落下的 availableManifest 完成安装', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.dataDir, { recursive: true, force: true }))
  // 一次成功的 check 把 availableManifest 落到 state（这正是真实序列：设置页先 check）。
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  // 之后 GitHub 开始限流（60 次/小时/IP 被打满）。install 必须仍然可用。
  f.net.fails = true
  const before = JSON.parse(await readFile(path.join(f.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(before.availableManifest?.version, '0.10.0', '前置：check 必须落下 availableManifest')

  const status = await f.bootstrap.install({ confirmed: true, activate: true })
  assert.equal(status.installed, true, '离线安装必须成功，而不是 500')
  assert.equal(status.version, '0.10.0')
  assert.equal(status.injectionActivated, true)
})

test('install 失败必须把真因落盘，重启后仍能读到', async (t) => {
  const f = await fixture({ managerInstallThrows: true })
  t.after(() => rm(f.dataDir, { recursive: true, force: true }))
  await f.bootstrap.checkForUpdates({ source: 'manual' })
  await assert.rejects(f.bootstrap.install({ confirmed: true, activate: true }), /prepare-rootfs\.sh failed/)
  // 关键判据：内存里那句不算数，磁盘上必须有。设置页下一次读的就是磁盘。
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.match(
    String(persisted.lastError),
    /prepare-rootfs\.sh failed/,
    'lastError 必须落盘；只写内存会让真因在下一拍轮询里消失（issue #1790）',
  )
})