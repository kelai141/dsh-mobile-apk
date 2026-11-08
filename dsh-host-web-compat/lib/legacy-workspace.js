import { randomUUID } from 'node:crypto'
import { mkdir, open, opendir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

const MAX_FOLDERS = 500
const MAX_SCAN = 10000
const within = (path, root) => path === root || path.startsWith(root + sep)
const error = (code) => Object.assign(new Error(code), { code })

// The picker is scoped to the current Android user's public storage. Android
// app data is deliberately absent from both the listing and manual path entry.
export function createLegacyWorkspace(root, home) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === dirname(root)) return null

  async function publicPath(path = root) {
    if (typeof path !== 'string' || path.length > 4096 || !within(path, root) ||
      path.includes('\0') || path.split(sep).includes('..')) throw error('invalid-path')
    const target = resolve(path)
    if (!within(target, root) || within(target, join(root, 'Android'))) throw error('invalid-path')
    const physicalRoot = await realpath(root)
    const physical = await realpath(target)
    if (!within(physical, physicalRoot) || within(physical, join(physicalRoot, 'Android'))) throw error('invalid-path')
    return { target, physical }
  }

  async function list(path) {
    const { target, physical } = await publicPath(path)
    const entries = []
    let truncated = false
    let scanned = 0
    for await (const entry of await opendir(physical)) {
      if (++scanned > MAX_SCAN) { truncated = true; break }
      if (!entry.isDirectory() || entry.name.startsWith('.') ||
        (target === root && entry.name === 'Android')) continue
      if (entries.length === MAX_FOLDERS) { truncated = true; break }
      entries.push({ name: entry.name, path: join(target, entry.name) })
    }
    const priority = (entry) => target !== root ? 2 : entry.name === 'Documents' ? 0 : entry.name === 'Download' ? 1 : 2
    entries.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name))
    return { path: target, parent: target === root ? null : dirname(target), entries, truncated }
  }

  async function writable(path) {
    // Test a real open for reading and an exclusive write on the engine's UID.
    await (await opendir(path)).close()
    const probe = join(path, '.dsh-workspace-check-' + randomUUID())
    const handle = await open(probe, 'wx', 0o600)
    try { await handle.writeFile('dsh') } finally {
      try { await handle.close() } finally { await unlink(probe) }
    }
  }

  async function select(path, temporary = false) {
    if (temporary) {
      // A single reusable, app-private workspace; no permission prompt or SAF.
      const physicalHome = await realpath(home)
      let parent = physicalHome
      for (const name of ['.dsh', 'workspaces', 'Temporary Workspace']) {
        const child = join(parent, name)
        try { await mkdir(child, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
        parent = await realpath(child)
        if (parent !== child) throw error('invalid-path')
      }
      await writable(parent)
      return join(home, '.dsh', 'workspaces', basename(parent))
    }
    const { target, physical } = await publicPath(path)
    if (target === root || !(await stat(physical)).isDirectory()) throw error('invalid-path')
    await writable(physical)
    return target
  }

  return { list, select }
}

export function legacyWorkspaceError(cause) {
  switch (cause?.code) {
    case 'invalid-path': return 'invalid-path'
    case 'ENOENT': case 'ENOTDIR': return 'missing'
    case 'EACCES': case 'EPERM': return 'permission'
    case 'EROFS': return 'read-only'
    default: return 'unavailable'
  }
}
