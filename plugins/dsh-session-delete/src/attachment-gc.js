/**
 * Global attachment CAS reference census and conservative orphan GC.
 *
 * Scans live, archived, quarantined (`.corrupt`), graveyard, workspace, draft,
 * storage/projection, spill, and incoming ledgers before marking any attachment
 * SHA-256 unreferenced. Fails closed (deletes nothing) whenever any reference
 * source is unreadable or corrupt.
 */
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SHA_URI_RE = /sha256:([a-f0-9]{64})/gi
const PREFIX_DIR_RE = /^[a-f0-9]{2}$/
const SHA_HEX_RE = /^[a-f0-9]{64}$/
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000

const isMissingError = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

function isPathInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

function addShaMatches(text, refs) {
  if (typeof text !== 'string' || !text) return
  SHA_URI_RE.lastIndex = 0
  let match
  while ((match = SHA_URI_RE.exec(text)) !== null) {
    refs.add(match[1].toLowerCase())
  }
}

async function readTextSource(filePath, { decompressZstd = false } = {}) {
  const raw = await readFile(filePath)
  if (decompressZstd || filePath.endsWith('.zstd') || filePath.endsWith('.zst')) {
    return zstdDecompressSync(raw).toString('utf8')
  }
  return raw.toString('utf8')
}

async function scanDirectoryTree({ rootDir, refs, incompleteReasons, shouldScanFile, readSource }) {
  const rootStat = await lstat(rootDir).catch((error) => {
    if (!isMissingError(error)) incompleteReasons.push(`${rootDir}: ${error.code ?? error.message}`)
    return null
  })
  if (!rootStat) return
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return

  const visit = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      incompleteReasons.push(`${dir}: ${error?.code ?? error?.message ?? String(error)}`)
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(dir, entry.name)
      if (!isPathInside(rootDir, fullPath)) continue
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (shouldScanFile && !shouldScanFile(fullPath, entry.name)) continue
      try {
        const text = await readSource(fullPath, { decompressZstd: entry.name.endsWith('.zstd') || entry.name.endsWith('.zst') })
        addShaMatches(text, refs)
      } catch (error) {
        incompleteReasons.push(`${fullPath}: ${error?.code ?? error?.message ?? String(error)}`)
      }
    }
  }

  await visit(rootDir)
}

/**
 * Collect referenced attachment SHA-256 digests across sessions (live, archived,
 * graveyard, quarantine), storages, drafts, exports/workspaces, spills, and incoming ledgers.
 */
export async function collectGlobalAttachmentReferences(home, options = {}) {
  if (typeof home !== 'string' || !home) {
    throw new TypeError('collectGlobalAttachmentReferences requires a non-empty home path')
  }
  const dshHome = path.resolve(home)
  const readSource = options.readSource ?? readTextSource
  const refs = new Set()
  const incompleteReasons = []

  const roots = [
    { dir: path.join(dshHome, 'sessions'), filter: (_p, name) => !name.endsWith('.lock') },
    { dir: path.join(dshHome, 'storages'), filter: (_p, name) => /\.(json|jsonl|ndjson|yml|yaml|txt)$/i.test(name) },
    { dir: path.join(dshHome, 'drafts') },
    { dir: path.join(dshHome, 'spills') },
    { dir: path.join(dshHome, 'exports') },
    { dir: path.join(dshHome, 'workspaces'), filter: (_p, name) => /^\.?(sessions|pending-notify|meta)|attachment|export/i.test(name) || /\.(json|jsonl|ndjson|meta)$/i.test(name) },
  ]
  for (const extraDir of options.extraReferenceDirs ?? []) {
    roots.push({ dir: path.resolve(extraDir) })
  }
  for (const spec of roots) {
    await scanDirectoryTree({
      rootDir: spec.dir,
      refs,
      incompleteReasons,
      shouldScanFile: spec.filter,
      readSource,
    })
  }

  for (const ledger of [
    path.join(dshHome, 'workspaces', 'incoming', '.pending-notify.ndjson'),
    path.join(dshHome, 'workspaces', 'incoming', '.meta.ndjson'),
    path.join(dshHome, 'workspaces', 'incoming', '.sessions'),
  ]) {
    const info = await lstat(ledger).catch((error) => {
      if (!isMissingError(error)) incompleteReasons.push(`${ledger}: ${error.code ?? error.message}`)
      return null
    })
    if (!info || info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await scanDirectoryTree({ rootDir: ledger, refs, incompleteReasons, readSource })
    } else if (info.isFile()) {
      try {
        addShaMatches(await readSource(ledger, { decompressZstd: false }), refs)
      } catch (error) {
        incompleteReasons.push(`${ledger}: ${error?.code ?? error?.message ?? String(error)}`)
      }
    }
  }

  return {
    home: dshHome,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    refs,
  }
}

async function listAttachmentCandidates(attachmentsV1Dir, refs, now, minAgeMs) {
  const candidates = []
  const kept = []

  const scanHashedBuckets = async (bucketRoot, category, isLeafDir = false) => {
    const bucketStat = await lstat(bucketRoot).catch(() => null)
    if (!bucketStat || bucketStat.isSymbolicLink() || !bucketStat.isDirectory()) return
    const prefixes = await readdir(bucketRoot, { withFileTypes: true }).catch(() => [])
    for (const prefix of prefixes) {
      if (prefix.isSymbolicLink() || !prefix.isDirectory() || !PREFIX_DIR_RE.test(prefix.name)) continue
      const prefixDir = path.join(bucketRoot, prefix.name)
      const items = await readdir(prefixDir, { withFileTypes: true }).catch(() => [])
      for (const item of items) {
        if (item.isSymbolicLink() || !SHA_HEX_RE.test(item.name)) continue
        const target = path.join(prefixDir, item.name)
        if (!isPathInside(bucketRoot, target)) continue
        const sha = item.name.toLowerCase()
        if (refs.has(sha)) {
          kept.push({ sha, category, reason: 'referenced' })
          continue
        }
        let mtimeMs = 0
        let bytes = 0
        if (isLeafDir && item.isDirectory()) {
          const st = await stat(target).catch(() => null)
          mtimeMs = st?.mtimeMs ?? 0
          const children = await readdir(target, { withFileTypes: true }).catch(() => [])
          for (const child of children) {
            if (child.isSymbolicLink() || !child.isFile()) continue
            const childStat = await stat(path.join(target, child.name)).catch(() => null)
            if (childStat) {
              bytes += childStat.size
              if (childStat.mtimeMs > mtimeMs) mtimeMs = childStat.mtimeMs
            }
          }
        } else if (!isLeafDir && item.isFile()) {
          const st = await stat(target).catch(() => null)
          mtimeMs = st?.mtimeMs ?? 0
          bytes = st?.size ?? 0
        } else {
          continue
        }
        if (mtimeMs > 0 && now - mtimeMs < minAgeMs) {
          kept.push({ sha, category, reason: 'cooling-window' })
          continue
        }
        candidates.push({ sha, category, target, bytes, expectedMtimeMs: mtimeMs })
      }
    }
  }

  await scanHashedBuckets(path.join(attachmentsV1Dir, 'objects'), 'image-object', false)
  await scanHashedBuckets(path.join(attachmentsV1Dir, 'file-objects'), 'file-object', false)
  await scanHashedBuckets(path.join(attachmentsV1Dir, 'files'), 'file-alias', true)
  return { candidates, kept }
}

/**
 * Dry-run by default (`apply: false`). Performs two-pass verification + cooling window,
 * and aborts without deleting anything whenever global reference discovery is incomplete.
 */
export async function sweepOrphanAttachments({
  home,
  apply = false,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  now = Date.now(),
  extraReferenceDirs = [],
  readSource,
} = {}) {
  const dshHome = path.resolve(home)
  const attachmentsV1 = path.join(dshHome, 'attachments', 'v1')
  const firstPass = await collectGlobalAttachmentReferences(dshHome, { extraReferenceDirs, readSource })
  if (!firstPass.complete) {
    return {
      ok: false,
      aborted: 'incomplete-reference-scan',
      incompleteReasons: firstPass.incompleteReasons,
      referencedCount: firstPass.refs.size,
      candidates: [],
      deleted: [],
      freedBytes: 0,
    }
  }

  const { candidates, kept } = await listAttachmentCandidates(attachmentsV1, firstPass.refs, now, minAgeMs)
  if (!apply || candidates.length === 0) {
    return {
      ok: true,
      dryRun: !apply,
      referencedCount: firstPass.refs.size,
      keptCount: kept.length,
      candidates: candidates.map(({ sha, category, bytes }) => ({ sha, category, bytes })),
      deleted: [],
      freedBytes: 0,
    }
  }

  // Two-pass re-check: verify references again before mutating anything on disk.
  const secondPass = await collectGlobalAttachmentReferences(dshHome, { extraReferenceDirs, readSource })
  if (!secondPass.complete) {
    return {
      ok: false,
      aborted: 'incomplete-reference-scan',
      incompleteReasons: secondPass.incompleteReasons,
      referencedCount: secondPass.refs.size,
      candidates: [],
      deleted: [],
      freedBytes: 0,
    }
  }

  const deleted = []
  let freedBytes = 0
  for (const item of candidates) {
    if (secondPass.refs.has(item.sha)) continue
    try {
      await rm(item.target, { recursive: true, force: true })
      deleted.push({ sha: item.sha, category: item.category, bytes: item.bytes })
      freedBytes += item.bytes
    } catch { /* Best-effort per entry; failures simply remain un-deleted. */ }
  }
  return {
    ok: true,
    dryRun: false,
    referencedCount: secondPass.refs.size,
    keptCount: kept.length,
    candidates: candidates.map(({ sha, category, bytes }) => ({ sha, category, bytes })),
    deleted,
    freedBytes,
  }
}
