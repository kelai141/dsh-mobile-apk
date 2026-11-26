/** Manual cleanup eligibility follows explicit access; history replay never renews it. */
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CleanupSkip, CleanupTarget } from './runtime-cache.js'

export const IMAGE_IDLE_TTL_MS = 120 * 60 * 1000
export const DEFAULT_REQUEST_IMAGE_CACHE_BYTES = 128 * 1024 * 1024
const TEMP_IDLE_TTL_MS = IMAGE_IDLE_TTL_MS
const HASH = /^[0-9a-f]{64}$/
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TEMP_NAME = new RegExp(`^(?:dsh-shot-(?:[0-9]+|${UUID})|shot-(?:[0-9]+|(?:original|annotated|redacted|preview)-${UUID})|browser-shot-[a-zA-Z0-9_-]+)\\.(?:png|jpe?g|webp)$`)

export interface ImageCachePolicy {
  /** Only the coordinated missing-image fallback authorizes deleting durable image objects. */
  imageExpirySupported?: boolean
  now?: number
}

type ImageLocation = { base: string; relative: string; kind: 'image-object' | 'image-preview' | 'image-temporary'; ttl: number }

function under(path: string, base: string): string | undefined {
  const part = relative(resolve(base), resolve(path))
  if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) return undefined
  return part.replace(/\\/g, '/')
}

function imageLocation(path: string, home: string, files: string, env: Record<string, string | undefined>): ImageLocation | undefined {
  for (const [base, kind] of [[join(home, 'attachments/v1/objects'), 'image-object'], [join(home, 'cache/attachments/request-images'), 'image-preview']] as const) {
    const part = under(path, base)
    const segments = part?.split('/') ?? []
    if (segments.length === 2 && HASH.test(segments[1]!) && segments[0] === segments[1]!.slice(0, 2)) return { base, relative: part!, kind, ttl: IMAGE_IDLE_TTL_MS }
  }
  const tempRoots = new Set<string>()
  if (env.TMPDIR?.trim()) tempRoots.add(join(env.TMPDIR, 'dsh-tmp'))
  if (files) tempRoots.add(join(files, 'home/tmp/dsh-tmp'))
  for (const base of tempRoots) {
    const part = under(path, base)
    if (part && !part.includes('/') && TEMP_NAME.test(part)) return { base, relative: part, kind: 'image-temporary', ttl: TEMP_IDLE_TTL_MS }
  }
  if (files) {
    const base = join(files, 'screen-frames'), part = under(path, base)
    if (part && new RegExp(`^${UUID}\\.png$`).test(part)) return { base, relative: part, kind: 'image-temporary', ttl: TEMP_IDLE_TTL_MS }
  }
  return undefined
}

/** Every path component beneath the configured root must be real, not a symbolic link. */
function unlinkedPath(path: string, root: string): boolean {
  const part = under(path, root)
  if (part === undefined || !existsSync(root) || lstatSync(root).isSymbolicLink()) return false
  let candidate = resolve(root)
  for (const name of part.split('/')) {
    candidate = join(candidate, name)
    if (lstatSync(candidate).isSymbolicLink()) return false
  }
  return true
}

export function imageCacheEligible(path: string, home: string, files: string, policy: ImageCachePolicy = {}, env: Record<string, string | undefined> = process.env): boolean {
  const location = imageLocation(path, home, files, env)
  if (!location || (location.kind === 'image-object' && policy.imageExpirySupported !== true)) return false
  try {
    const root = location.kind === 'image-object' || location.kind === 'image-preview' ? home : (files && under(path, files) ? files : env.TMPDIR!)
    if (!unlinkedPath(path, root)) return false
    const stat = lstatSync(path), now = policy.now ?? Date.now()
    return stat.isFile() && Number.isFinite(stat.mtimeMs) && now - stat.mtimeMs >= location.ttl
  } catch { return false }
}

/** Enumerate leaf files only. Never delete attachment metadata, file attachments, .tmp files or whole directories. */
export function scanImageCache(home: string, files: string, policy: ImageCachePolicy = {}, env: Record<string, string | undefined> = process.env): { targets: CleanupTarget[]; skipped: CleanupSkip[] } {
  const targets: CleanupTarget[] = [], skipped: CleanupSkip[] = []
  const roots: Array<[string, number]> = [[join(home, 'attachments/v1/objects'), 2], [join(home, 'cache/attachments/request-images'), 2]]
  if (files) roots.push([join(files, 'home/tmp/dsh-tmp'), 1], [join(files, 'screen-frames'), 1])
  if (env.TMPDIR?.trim()) roots.push([join(env.TMPDIR, 'dsh-tmp'), 1])
  const seen = new Set<string>()
  function scan(directory: string, depth: number) {
    try {
      if (lstatSync(directory).isSymbolicLink()) return
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name), stat = lstatSync(path)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory() && depth > 1 && /^[0-9a-f]{2}$/.test(name)) { scan(path, depth - 1); continue }
        const location = imageLocation(path, home, files, env)
        if (!location || !stat.isFile() || seen.has(resolve(path))) continue
        seen.add(resolve(path))
        if (!imageCacheEligible(path, home, files, policy, env)) continue
        targets.push({ id: `${location.kind}-${targets.length}`, kind: location.kind, path, bytes: stat.size, files: 1 })
      }
    } catch { /* Missing/unreadable roots do not authorize guessed paths. */ }
  }
  for (const [root, depth] of roots) scan(root, depth)
  return { targets, skipped }
}

/** Evict oldest rebuildable request-image preview files when cache exceeds maxBytes. */
export function enforceRequestImageBudget(
  home: string,
  options: { maxBytes?: number; apply?: boolean } = {},
): { totalBytesBefore: number; totalBytesAfter: number; removed: string[]; evictedBytes: number } {
  const maxBytes = options.maxBytes ?? DEFAULT_REQUEST_IMAGE_CACHE_BYTES
  const apply = options.apply !== false
  const root = join(home, 'cache', 'attachments', 'request-images')
  if (!existsSync(root)) return { totalBytesBefore: 0, totalBytesAfter: 0, removed: [], evictedBytes: 0 }
  try {
    if (lstatSync(home).isSymbolicLink() || lstatSync(join(home, 'cache')).isSymbolicLink() || lstatSync(root).isSymbolicLink()) {
      return { totalBytesBefore: 0, totalBytesAfter: 0, removed: [], evictedBytes: 0 }
    }
  } catch {
    return { totalBytesBefore: 0, totalBytesAfter: 0, removed: [], evictedBytes: 0 }
  }
  const items: Array<{ path: string; size: number; mtimeMs: number }> = []
  try {
    for (const bucket of readdirSync(root).sort()) {
      if (!/^[0-9a-f]{2}$/.test(bucket)) continue
      const bucketDir = join(root, bucket)
      const bStat = lstatSync(bucketDir)
      if (bStat.isSymbolicLink() || !bStat.isDirectory()) continue
      for (const name of readdirSync(bucketDir).sort()) {
        if (!HASH.test(name)) continue
        const filePath = join(bucketDir, name)
        const fStat = lstatSync(filePath)
        if (fStat.isSymbolicLink() || !fStat.isFile()) continue
        items.push({ path: filePath, size: fStat.size, mtimeMs: Number.isFinite(fStat.mtimeMs) ? fStat.mtimeMs : 0 })
      }
    }
  } catch {
    return { totalBytesBefore: 0, totalBytesAfter: 0, removed: [], evictedBytes: 0 }
  }
  const totalBytesBefore = items.reduce((sum, item) => sum + item.size, 0)
  if (totalBytesBefore <= maxBytes) {
    return { totalBytesBefore, totalBytesAfter: totalBytesBefore, removed: [], evictedBytes: 0 }
  }
  items.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.path.localeCompare(b.path))
  let currentBytes = totalBytesBefore
  const removed: string[] = []
  let evictedBytes = 0
  for (const item of items) {
    if (currentBytes <= maxBytes) break
    if (apply) {
      try {
        unlinkSync(item.path)
      } catch {
        continue
      }
    }
    currentBytes -= item.size
    evictedBytes += item.size
    removed.push(item.path)
  }
  return { totalBytesBefore, totalBytesAfter: currentBytes, removed, evictedBytes }
}
