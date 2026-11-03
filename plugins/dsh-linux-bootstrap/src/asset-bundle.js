import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { parseGithubUrl } from './manifest.js'

const bytesValue = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array

async function digestFile(filePath) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), size }
}

const INTEGRITY_MARKER = '.dsh-asset-integrity.json'

async function unpackedBytes(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    const info = await lstat(child)
    if (info.isSymbolicLink()) throw new Error('Extracted plugin bundles may not contain symlinks')
    if (info.isDirectory()) total += await unpackedBytes(child)
    // Our own bookkeeping is not payload: the manifest's unpackedSize is measured
    // over the archive's contents, before this marker is written.
    else if (info.isFile() && entry.name !== INTEGRITY_MARKER) total += info.size
    else if (!info.isFile()) throw new Error('Unsupported filesystem entry in extracted plugin bundle')
  }
  return total
}

function assertAsset(asset) {
  if (!asset || typeof asset.url !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
      !Number.isSafeInteger(asset.size) || asset.size < 0 || !Number.isSafeInteger(asset.unpackedSize) || asset.unpackedSize < 0) {
    throw new TypeError('Asset requires url, SHA-256, size, and unpackedSize')
  }
  const url = parseGithubUrl(asset.url)
  const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (!match || url.search || url.hash) throw new TypeError('Asset must use a versioned HTTPS GitHub release URL')
  return url.href
}

export async function installVerifiedPluginBundle({
  asset,
  destinationRoot,
  hostStagingRoot,
  requireStagedBundle = false,
  downloadAsset,
  extractArchive,
  fetchImpl = globalThis.fetch,
  kind = 'plugin',
  packageName,
  entry = 'lib/index.js',
}) {
  const url = assertAsset(asset)
  if (typeof destinationRoot !== 'string' || !destinationRoot) throw new TypeError('destinationRoot is required')
  if (typeof downloadAsset !== 'function' || typeof extractArchive !== 'function') throw new TypeError('downloadAsset and safe extractArchive adapters are required')
  const root = path.resolve(destinationRoot)
  await mkdir(root, { recursive: true })
  // issue #1375：回收上次中断留下的 .backup-*（原先**无人清理**，磁盘只增不减）。
  // 保守：只清 10 分钟前的条目，避免删掉正在进行的发布所用的回滚源。清扫失败不影响安装。
  try { await sweepStaleBundleDirs(root) } catch { /* 清扫是尽力而为 */ }
  const finalDirectory = path.join(root, asset.sha256)
  const markerPath = path.join(finalDirectory, '.dsh-asset-integrity.json')
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    const rootInfo = await lstat(finalDirectory)
    if (rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && marker.sha256 === asset.sha256 && marker.size === asset.size && marker.unpackedSize === asset.unpackedSize) {
      // Our own marker is bookkeeping, not evidence. Re-measure the tree (which
      // also refuses symbolic links) and re-validate the package before calling
      // this reusable, so an altered or truncated slot is rebuilt rather than
      // activated. `reused: true` is a verification outcome, never an assumption.
      const measured = await unpackedBytes(finalDirectory)
      if (measured === asset.unpackedSize) {
        if (packageName) await validatePackage(finalDirectory, packageName, entry)
        return { path: finalDirectory, sha256: asset.sha256, size: asset.size, unpackedSize: asset.unpackedSize, reused: true }
      }
    }
  } catch { /* Rebuild missing or untrusted cached staging content. */ }

  // The host may already have fetched and safely unpacked the bundle (see
  // docs/DECISIONS.md D-015). Its staging is never trusted as such: the archive
  // is re-hashed against this manifest and the unpacked tree is re-measured
  // here, and only then is it published into our own content-addressed root.
  // A staged bundle that is present but wrong is an error, not a cache miss —
  // silently falling back to a download would hide tampering or corruption.
  if (hostStagingRoot) {
    const staged = await publishHostStagedBundle({
      hostStagingRoot, asset, root, finalDirectory, packageName, entry,
    })
    if (staged) return staged
    if (requireStagedBundle) {
      throw new Error('No host-staged bundle is available: the host must prepare this asset before it can be installed')
    }
  }

  const token = randomUUID()
  const archivePath = path.join(root, `.asset-${token}`)
  const staging = path.join(root, `.stage-${token}`)
  const resultDirectory = path.join(staging, 'package')
  await mkdir(staging, { recursive: true })
  try {
    const downloaded = await downloadAsset({ ...asset, url }, { destination: archivePath, fetchImpl })
    if (bytesValue(downloaded)) await writeFile(archivePath, downloaded)
    else if (typeof downloaded === 'string' && path.resolve(downloaded) !== archivePath) await copyFile(downloaded, archivePath)
    else if (bytesValue(downloaded?.data)) await writeFile(archivePath, downloaded.data)
    else if (downloaded?.path && path.resolve(downloaded.path) !== archivePath) await copyFile(downloaded.path, archivePath)
    const archiveInfo = await lstat(archivePath)
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error('Asset downloader must produce a regular file')
    const digest = await digestFile(archivePath)
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256) throw new Error('Plugin asset SHA-256 or size verification failed')
    await mkdir(resultDirectory, { recursive: true })
    await extractArchive(archivePath, resultDirectory, { kind, safe: true, stripComponents: 0 })
    const packageDirectory = await pickPackageDirectory(resultDirectory)
    const unpackedSize = await unpackedBytes(packageDirectory)
    if (unpackedSize !== asset.unpackedSize) throw new Error(`Unpacked size mismatch: expected ${asset.unpackedSize}, got ${unpackedSize}`)
    if (packageName) await validatePackage(packageDirectory, packageName, entry)
    await publishBundle({ root, finalDirectory, packageDirectory, asset, unpackedSize, token })
    return { path: finalDirectory, sha256: asset.sha256, size: asset.size, unpackedSize, reused: false }
  } catch (error) {
    throw error
  } finally {
    await rm(archivePath, { force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Locate the package directory inside an unpacked bundle: some archives root the
 * package at `package/`, others are already rooted at it.
 */
async function pickPackageDirectory(rootDirectory) {
  const nested = path.join(rootDirectory, 'package')
  try {
    if ((await stat(path.join(nested, 'package.json'))).isFile()) return nested
  } catch { /* Archive is already rooted at the package directory. */ }
  return rootDirectory
}

/**
 * Publish a verified package directory as `<root>/<sha256>`, replacing any
 * previous copy atomically and rolling back if the swap fails.
 */
export async function publishBundle({ root, finalDirectory, packageDirectory, asset, unpackedSize, token }) {
  await writeFile(path.join(packageDirectory, '.dsh-asset-integrity.json'), `${JSON.stringify({ sha256: asset.sha256, size: asset.size, unpackedSize })}`)
  const backupDirectory = path.join(root, `.backup-${token}`)
  let hadPrevious = false
  try {
    await rename(finalDirectory, backupDirectory)
    hadPrevious = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await rename(packageDirectory, finalDirectory)
  } catch (error) {
    // issue #1375：回滚失败**不得**被吞掉。旧实现是 rename(...).catch(() => {}) ——
    // 恢复失败既没有日志也没有上报，旧包永久留在 .backup-<uuid>，用户只看到「安装失败」
    // 而现场无从查起。这里把两个错误一起抛出，并在消息里点明旧包还在哪。
    if (hadPrevious) {
      try {
        await rename(backupDirectory, finalDirectory)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Bundle publish failed and rollback failed; previous copy remains at ${backupDirectory}`,
        )
      }
    }
    throw error
  }
  // issue #1375（反向）：清理备份必须在**发布成功之后、且在 try 之外**。
  // 旧实现把它放在 try 里：rm 一抛（备份目录被占用等）就落进 catch，去把**刚刚发布成功**的
  // 目录再 rename 回备份（必然失败并被吞），然后 throw —— 安装其实成功却报失败。
  // 清理失败只告警：新包已就位，不影响可用性，但必须留痕。
  if (hadPrevious) {
    try {
      await rm(backupDirectory, { recursive: true, force: true })
    } catch (error) {
      console.warn('[dsh-linux-bootstrap] backup cleanup deferred: ' + backupDirectory + ' (' + String(error && error.message ? error.message : error) + ')')
    }
  }
}

/**
 * Re-verify a bundle the host staged at `<hostStagingRoot>/<sha256>/` and
 * publish it locally.
 *
 * Returns `null` when nothing is staged at all, so the caller can decide whether
 * that is a fallback or a failure. Anything staged but wrong throws: the host's
 * own marker is never a usability credential, and a mismatch is a corruption or
 * tampering signal that must not be papered over by a silent re-download.
 */
async function publishHostStagedBundle({ hostStagingRoot, asset, root, finalDirectory, packageName, entry }) {
  const stagedRoot = path.join(path.resolve(hostStagingRoot), asset.sha256)
  const archivePath = path.join(stagedRoot, 'asset.tar.xz')
  let archiveInfo
  try {
    archiveInfo = await lstat(archivePath)
  } catch {
    return null
  }
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    throw new Error('Host-staged archive must be a regular file')
  }
  const digest = await digestFile(archivePath)
  if (digest.size !== asset.size || digest.sha256 !== asset.sha256) {
    throw new Error('Host-staged archive does not match the release manifest (SHA-256 or size)')
  }
  const unpackedRoot = path.join(stagedRoot, 'unpacked')
  const unpackedInfo = await lstat(unpackedRoot)
  if (!unpackedInfo.isDirectory() || unpackedInfo.isSymbolicLink()) {
    throw new Error('Host-staged bundle is missing its unpacked tree')
  }
  const packageDirectory = await pickPackageDirectory(unpackedRoot)
  const unpackedSize = await unpackedBytes(packageDirectory)
  if (unpackedSize !== asset.unpackedSize) {
    throw new Error(`Host-staged bundle unpacked size mismatch: expected ${asset.unpackedSize}, got ${unpackedSize}`)
  }
  if (packageName) await validatePackage(packageDirectory, packageName, entry)
  const token = randomUUID()
  const staging = path.join(root, `.stage-${token}`)
  const copied = path.join(staging, 'package')
  await mkdir(staging, { recursive: true })
  try {
    // Copy rather than move: the host's staging area stays intact and
    // re-verifiable, and our own copy is what gets published and re-used.
    await cp(packageDirectory, copied, { recursive: true })
    await publishBundle({ root, finalDirectory, packageDirectory: copied, asset, unpackedSize, token })
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  return { path: finalDirectory, sha256: asset.sha256, size: asset.size, unpackedSize, reused: false, hostStaged: true }
}

/**
 * 清扫上次中断留下的 `.backup-*` / `.stage-*`（issue #1375：`.backup-*` 原先**无人回收**）。
 *
 * 保守点：只删 mtime 超过 minAgeMs 的条目。发布过程中备份目录会短暂存在，
 * 直接全删会把正在进行的回滚源删掉。
 *
 * @param {string} root 插件包根目录。
 * @param {{ minAgeMs?: number, now?: number }} [options]
 * @returns {Promise<string[]>} 被删掉的目录名（便于调用方记日志与测试断言）。
 */
export async function sweepStaleBundleDirs(root, options = {}) {
  const minAgeMs = Number.isFinite(options.minAgeMs) ? options.minAgeMs : 10 * 60 * 1000
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const removed = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return removed }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('.backup-') && !entry.name.startsWith('.stage-')) continue
    const target = path.join(root, entry.name)
    try {
      const info = await stat(target)
      if (now - info.mtimeMs < minAgeMs) continue
      await rm(target, { recursive: true, force: true })
      removed.push(entry.name)
    } catch (error) {
      console.warn('[dsh-linux-bootstrap] stale bundle dir cleanup skipped: ' + target + ' (' + String(error && error.message ? error.message : error) + ')')
    }
  }
  return removed
}

async function validatePackage(directory, packageName, entry) {
  const metadataPath = path.join(directory, 'package.json')
  const metadataStat = await lstat(metadataPath)
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('Verified plugin archive is missing a regular package.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (metadata.name !== packageName) throw new Error(`Expected plugin package ${packageName}`)
  const entryPath = path.resolve(directory, entry)
  const relative = path.relative(directory, entryPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plugin entry escapes package directory')
  const entryStat = await lstat(entryPath)
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`Plugin entry ${entry} is missing or unsafe`)
}
