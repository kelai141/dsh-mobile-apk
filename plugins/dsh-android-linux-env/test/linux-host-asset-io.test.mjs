/**
 * 引擎侧 `linuxAssetIO` 接线的负控与正控（0.15.0）。
 *
 * 判据集中在一件事：**「宿主没准备好」或「复验不通过」必须拒绝，且绝不回退成自行下载**。
 * 这些用例驱动的是**真实 vendored bootstrap**（`plugins/dsh-linux-bootstrap/src/index.js`），
 * 不是替身——否则「bootstrap 会复验」就只是我们的声明而非被测事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CODE_ASSET_NOT_PREPARED,
  CODE_ASSET_SPEC_INVALID,
  LINUX_ENV_DIR,
  STAGING_DIR,
  RETAINED_ARCHIVE,
  UNPACKED_DIR,
  createHostAssetIO,
  createLinuxBootstrapConfig,
  linuxEnvironmentRoot,
  retainedArchiveFor,
  stagedDirectoryFor,
  unpackedTreeFor,
} from '../lib/linux-host-asset-io.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 定位 vendored bootstrap。**不允许静默 skip**：两种布局都找不到就立刻判红，并打印试过的绝对路径。
 *
 * 真因（2026-10-17 实测）：本文件此前写静态 `import '../../dsh-linux-bootstrap/src/index.js'`，而
 * `dsh-linux-bootstrap` 只存在于**壳仓自包含副本**（`dsh-mobile-apk/plugins/dsh-linux-bootstrap`）；
 * 协调仓的 `plugins/` 只放注入集插件。于是同一份用例在壳仓全绿、在协调仓根必红
 * `ERR_MODULE_NOT_FOUND`。判据本身没问题，是**定位逻辑对仓布局的假设太窄**。
 */
const BOOTSTRAP_ENTRY_CANDIDATES = [
  // 壳仓自包含布局：<repo>/plugins/dsh-linux-bootstrap
  resolve(HERE, '..', '..', 'dsh-linux-bootstrap', 'src', 'index.js'),
  // 协调仓布局：bootstrap 只在本仓内的壳仓副本里
  resolve(HERE, '..', '..', '..', 'dsh-mobile-apk', 'plugins', 'dsh-linux-bootstrap', 'src', 'index.js'),
]
const bootstrapEntry = BOOTSTRAP_ENTRY_CANDIDATES.find((candidate) => existsSync(candidate))
if (!bootstrapEntry) {
  throw new Error(
    '找不到 vendored bootstrap 入口（dsh-linux-bootstrap/src/index.js），本用例集拒绝空跑。已尝试：\n  '
    + BOOTSTRAP_ENTRY_CANDIDATES.join('\n  '),
  )
}
// 动态 import 是唯一能「两布局皆可」的手段：静态 import 的说明符由模块解析器写死，无法回落。
const { createBootstrap } = await import(pathToFileURL(bootstrapEntry).href)

const RUNTIME_PACKAGE_NAME = '@dsh-android/linux-runtime'
const MANIFEST_NAME = 'linux-release.json'
const REPO = 'https://github.com/kelai141/dsh-bionilux'
const TAG = 'v1.2.0'
/** 宿主已解包树里的入口内容；正控与「篡改不得存活」都对着它断言。 */
const GENUINE_ENTRY = 'export const apply = () => {}\n'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function tempFilesDir() {
  return mkdtemp(join(tmpdir(), 'linux-host-asset-io-'))
}

/**
 * 造一份**宿主已准备**的暂存内容，形状与 Kotlin `LinuxAssetPrepare.prepareInto` 的发布结果一致：
 * `<filesDir>/linux-environment/staging/<sha256>/{asset.tar.xz, unpacked/package/...}`。
 */
async function stageBundle(filesDir, { archiveBytes, declaredDigest, packageName = RUNTIME_PACKAGE_NAME, entryBody = GENUINE_ENTRY } = {}) {
  const bytes = archiveBytes ?? Buffer.from('host staged runtime archive bytes')
  // `declaredDigest` 允许把内容放在**另一个**摘要名下：这正是「暂存内容与 manifest 摘要不符」的造法。
  const digest = declaredDigest ?? sha256(bytes)
  const staged = stagedDirectoryFor(filesDir, digest)
  const tree = unpackedTreeFor(filesDir, digest)
  await mkdir(join(tree, 'package', 'lib'), { recursive: true })
  await writeFile(join(staged, RETAINED_ARCHIVE), bytes)
  await writeFile(join(tree, 'package', 'package.json'), `${JSON.stringify({ name: packageName, version: '1.0.0' })}\n`)
  await writeFile(join(tree, 'package', 'lib', 'index.js'), entryBody)
  const packageJson = await readFile(join(tree, 'package', 'package.json'))
  const entry = await readFile(join(tree, 'package', 'lib', 'index.js'))
  return { sha256: digest, size: bytes.length, unpackedSize: packageJson.length + entry.length }
}

function makeManifest({ asset, minMobileVersion = '0.14.0', version = '1.2.0' } = {}) {
  const assetUrl = (name) => `${REPO}/releases/download/${TAG}/${name}`
  const bootstrapAsset = { url: assetUrl('linux-bootstrap-plugin.tar.xz'), sha256: 'b'.repeat(64), size: 1, unpackedSize: 1 }
  return {
    schemaVersion: 1,
    version,
    minMobileVersion,
    plugins: { bootstrap: bootstrapAsset, runtime: { url: assetUrl('linux-runtime-plugin.tar.xz'), ...asset } },
    runtimes: [{ id: 'debian-minimal', label: 'Debian minimal', architecture: 'arm64', backend: 'bionilux' }],
  }
}

/** 只服务 manifest 的 fetch：任何对**资产**的下载请求都会被记为一次（用来证明没有自行下载）。 */
function makeFetch(manifest) {
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    if (url === `https://api.github.com/repos/kelai141/dsh-bionilux/releases/latest`) {
      return {
        ok: true, status: 200, url,
        json: async () => ({
          tag_name: TAG,
          assets: [{ name: MANIFEST_NAME, browser_download_url: `${REPO}/releases/download/${TAG}/${MANIFEST_NAME}` }],
        }),
      }
    }
    if (url.endsWith(`/${MANIFEST_NAME}`)) {
      return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)) }
    }
    throw new Error(`测试里不该有人去取字节：${url}`)
  }
  return { fetchImpl, fetched }
}

/** 宿主激活适配器：只要 bootstrap 走到激活，就必须拿回一个满足它自己 install/uninstall 检查的 manager。 */
function makePluginHost() {
  const activations = []
  return {
    activations,
    install: async (options) => {
      activations.push(options)
      return { manager: { install: async () => {}, uninstall: async () => {} } }
    },
    uninstall: async () => {},
    isInjected: async () => ({ injected: true, active: true }),
  }
}

function makeBootstrap({ filesDir, manifest, pluginHost = makePluginHost() }) {
  const { fetchImpl, fetched } = makeFetch(manifest)
  const service = createBootstrap({
    ...createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' }),
    pluginHost,
    fetchImpl,
  })
  return { service, pluginHost, fetched }
}

const installConfirmed = (service) => service.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true })

// ── 正控：真正准备好的暂存包可以激活 ────────────────────────────────────────

test('a genuine host-staged bundle activates', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    const status = await installConfirmed(service)
    assert.equal(status.installed, true, '真实暂存的包必须能装上')
    assert.equal(status.version, '1.2.0')
    assert.equal(pluginHost.activations.length, 1, '必须恰好激活一次')
    assert.equal(status.enabled, true)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 1：宿主没准备 → 拒绝，且不得自行下载 ───────────────────────────────

test('refuses when nothing is staged and never falls back to downloading', async () => {
  const filesDir = await tempFilesDir()
  try {
    const bytes = Buffer.from('not staged anywhere')
    const asset = { sha256: sha256(bytes), size: bytes.length, unpackedSize: 1 }
    const { service, pluginHost, fetched } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), (error) => {
      assert.equal(error.code, CODE_ASSET_NOT_PREPARED)
      return true
    })
    assert.equal(pluginHost.activations.length, 0, '没准备好就不许激活')
    assert.equal((await service.status()).installed, false)
    // 只找过 manifest，没有任何一次资产下载 —— 「不自行下载」的证据。
    assert.ok(fetched.every(url => !url.endsWith('.tar.xz')), `不该去取资产字节：${fetched.join(', ')}`)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 2：暂存内容与 manifest 摘要不符 → 拒绝 ─────────────────────────────

test('refuses when the staged archive does not match the manifest digest', async () => {
  const filesDir = await tempFilesDir()
  try {
    const bytes = Buffer.from('bytes that do NOT hash to what the manifest claims')
    // 归档**放在 manifest 声明的摘要名下**，但内容是另一份 —— 这样 bootstrap 才能走到「自算摘要再比」。
    const declaredDigest = sha256(Buffer.from('the digest the manifest claims'))
    const staged = await stageBundle(filesDir, { archiveBytes: bytes, declaredDigest })
    const asset = { sha256: declaredDigest, size: staged.size, unpackedSize: staged.unpackedSize }
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), /SHA-256|size verification failed/)
    assert.equal(pluginHost.activations.length, 0, '摘要不符不许激活')
    assert.equal((await service.status()).installed, false)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 3：解包树包名不对 → 拒绝 ───────────────────────────────────────────

test('refuses when the unpacked tree has the wrong package name', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir, { packageName: '@dsh-android/linux-something-else' })
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), /Expected plugin package/)
    assert.equal(pluginHost.activations.length, 0, '包名不对不许激活')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 4：unpackedSize 不符 → 拒绝 ────────────────────────────────────────

test('refuses when unpackedSize does not match the staged tree', async () => {
  const filesDir = await tempFilesDir()
  try {
    const staged = await stageBundle(filesDir)
    const asset = { sha256: staged.sha256, size: staged.size, unpackedSize: staged.unpackedSize + 1 }
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), /unpacked size mismatch/i)
    assert.equal(pluginHost.activations.length, 0, '体量不符不许激活')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 5：清单摘要不合规 → 拒绝推导，且环境根之外的哨兵不得被动过 ──────────

test('refuses a malicious digest and touches nothing outside the environment root', async () => {
  const filesDir = await tempFilesDir()
  try {
    const sentinel = join(filesDir, 'sentinel')
    await mkdir(sentinel, { recursive: true })
    await writeFile(join(sentinel, 'keep.txt'), 'keep')

    const envRoot = linuxEnvironmentRoot(filesDir)
    await mkdir(envRoot, { recursive: true })

    for (const digest of ['../../sentinel', '../../../app_state', '..', '/abs/path', 'a'.repeat(63), 'A'.repeat(64), '']) {
      assert.equal(stagedDirectoryFor(filesDir, digest), null, `摘要 ${digest} 必须被拒`)
      assert.equal(retainedArchiveFor(filesDir, digest), null)
      assert.equal(unpackedTreeFor(filesDir, digest), null)
    }
    // 自证前提：该摘要确实会解析到哨兵（否则这条负控是空判）。
    assert.equal(join(envRoot, STAGING_DIR, '..', '..', 'sentinel'), sentinel)

    const io = createHostAssetIO({ filesDir })
    await assert.rejects(io.downloadAsset({ sha256: '../../sentinel' }), (error) => {
      assert.equal(error.code, CODE_ASSET_SPEC_INVALID)
      return true
    })
    assert.ok(existsSync(join(sentinel, 'keep.txt')), '环境根之外的哨兵必须还在')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 复用面：不再信任何宿主/标记内容（上游 3f86a85 复验后的行为） ──────────────

/**
 * 复用分支必须**复验**，而不是信任槽位里已有的内容或它自己写下的标记。
 *
 * 上游把这条缺口补上后（`dsh-bionilux@3f86a85`），篡改过的槽位不会被复用：它按 manifest 的
 * `unpackedSize` 重新丈量已发布树，不匹配就从**已复验的宿主暂存**重建。
 *
 * 判据落在**内容事实**上：安装后再读槽位入口，必须是宿主暂存里的真品，篡改内容不得存活。
 */
test('re-verifies on reuse: a tampered published slot is rebuilt, not trusted', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready
    await installConfirmed(service)

    const slotRoot = String(createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' }).stagingDirectory)
    const slotEntry = join(slotRoot, asset.sha256, 'lib', 'index.js')
    assert.equal(await readFile(slotEntry, 'utf8'), GENUINE_ENTRY, '前提：首装后槽位是真品')

    // 只篡改**已发布槽位**；宿主暂存的归档与树保持真品（即"重建源"仍在且已复验）。
    const tampered = 'export const apply = () => { /* TAMPERED */ }\n'
    await writeFile(slotEntry, tampered)
    await service.reinstall({ confirmed: true, activate: true })

    assert.notEqual(await readFile(slotEntry, 'utf8'), tampered, '篡改内容不得存活（必须被重建覆盖）')
    assert.equal(await readFile(slotEntry, 'utf8'), GENUINE_ENTRY, '重建后必须是已复验的宿主暂存内容')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

/**
 * 重建源一旦与 manifest 不符必须**拒绝**。
 *
 * 注意判据的边界（实测得出，别写成"改归档就必拒"）：槽位完好时上游直接**复用**（按 manifest 的
 * `unpackedSize` 重新丈量树即可，根本不需要读归档），所以只改归档不会失败。归档是**重建源** ——
 * 只有「需要重建」（槽位被篡改）+「重建源不可信」同时成立，才必须失败关闭。
 *
 * 报错来自上游宿主暂存直取路径（`Host-staged archive does not match the release manifest
 * (SHA-256 or size)`），不是本模块的 `linux-asset-spec-invalid`，故这里断言**行为**
 * （拒绝 + 不新增激活），不锁死错误码归属。
 */
test('refuses when a rebuild is needed and the retained archive no longer matches the manifest', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready
    await installConfirmed(service)
    assert.equal(pluginHost.activations.length, 1)

    const slotRoot = String(createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' }).stagingDirectory)
    const slotEntry = join(slotRoot, asset.sha256, 'lib', 'index.js')
    assert.equal(await readFile(slotEntry, 'utf8'), GENUINE_ENTRY, '前提：首装后槽位是真品')

    // 同时破坏两样：槽位（迫使重建）与保留归档（让重建源不可信）。
    await writeFile(slotEntry, 'export const apply = () => { /* TAMPERED */ }\n')
    await writeFile(join(stagedDirectoryFor(filesDir, asset.sha256), RETAINED_ARCHIVE), Buffer.from('different bytes'))

    await assert.rejects(
      service.reinstall({ confirmed: true, activate: true }),
      /release manifest \(SHA-256 or size\)/,
    )
    assert.equal(pluginHost.activations.length, 1, '重建源复验不过就不许再激活')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 不变量：JS 推导与 Kotlin 发布口径必须逐字一致 ──────────────────────────

test('the JS staging derivation agrees with the Kotlin publisher verbatim', async () => {
  // 从**本文件位置**解析壳侧源码目录：测试的 cwd 由 runner 决定，不能用相对 cwd 的路径。
  // 两种仓布局：壳仓自包含（<repo>/app）与协调仓（壳侧 Kotlin 只在 <repo>/dsh-mobile-apk/app）。
  const repoRoot = resolve(HERE, '..', '..', '..')
  const shellCandidates = [
    join(repoRoot, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell'),
    join(repoRoot, 'dsh-mobile-apk', 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell'),
  ]
  const shell = shellCandidates.find((candidate) => existsSync(join(candidate, 'LinuxAssetIO.kt')))
  if (!shell) {
    throw new Error(
      '找不到壳侧 Kotlin 源码目录（LinuxAssetIO.kt），本用例拒绝空跑。已尝试：\n  '
      + shellCandidates.map((candidate) => join(candidate, 'LinuxAssetIO.kt')).join('\n  '),
    )
  }
  const kotlinIo = await readFile(join(shell, 'LinuxAssetIO.kt'), 'utf8')
  const kotlinPrepare = await readFile(join(shell, 'LinuxAssetPrepare.kt'), 'utf8')

  const envDir = /const val ENV_DIR = "([^"]+)"/.exec(kotlinIo)?.[1]
  const stagingDir = /const val DIR_STAGING = "([^"]+)"/.exec(kotlinPrepare)?.[1]
  assert.equal(envDir, LINUX_ENV_DIR, `ENV_DIR 与 Kotlin 不一致（Kotlin=${envDir}）`)
  assert.equal(stagingDir, STAGING_DIR, `DIR_STAGING 与 Kotlin 不一致（Kotlin=${stagingDir}）`)

  // 同一 root、同一 staging 段、同一摘要 —— 三件都必须是同一条路径（用同一 join 口径比较，跨平台成立）。
  const digest = 'c'.repeat(64)
  const root = linuxEnvironmentRoot('/data/files')
  assert.equal(stagedDirectoryFor('/data/files', digest), join(root, STAGING_DIR, digest))
  assert.equal(retainedArchiveFor('/data/files', digest), join(root, STAGING_DIR, digest, RETAINED_ARCHIVE))
  assert.equal(unpackedTreeFor('/data/files', digest), join(root, STAGING_DIR, digest, UNPACKED_DIR))
})

// ── 默认不启用：本模块不制造任何启用 ────────────────────────────────────────

test('the config neither enables nor installs anything on its own', async () => {
  const filesDir = await tempFilesDir()
  try {
    const config = createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' })
    assert.equal(config.dataDir, linuxEnvironmentRoot(filesDir))
    assert.equal(String(config.stagingDirectory), join(linuxEnvironmentRoot(filesDir), STAGING_DIR, 'runtime-plugin'))
    // bootstrap 的包槽位**不得**是宿主暂存目录，否则它会删掉宿主保留的归档与解包树。
    assert.notEqual(String(config.stagingDirectory), linuxEnvironmentRoot(filesDir) + '/' + STAGING_DIR)
    assert.equal(Object.keys(config).includes('enable'), false)

    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready
    const status = await service.status()
    assert.equal(status.installed, false, '造配置本身不得装任何东西')
    assert.equal(status.enabled, false, '造配置本身不得启用任何东西')
    assert.equal(status.autoUpdate, false, '自动更新默认关闭')
    assert.equal(pluginHost.activations.length, 0)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})
