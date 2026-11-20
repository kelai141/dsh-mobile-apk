import { cp, lstat, readFile, realpath, mkdir } from 'node:fs/promises'
import { join, sep } from 'node:path'

interface Paths { rootfs: string; backend: string; node: string; launcher: string; preload: string; nativeLibDir?: string }
interface Runtime {
  dataDir: string
  nativeLibDir?: string
  status(): { paths?: Paths }
  _nodePath(key: string): string
  _prepareAndroidRootfs(instance: { backend: string; rootfs: string }, signal?: AbortSignal): Promise<void>
  _executionEnvironment(paths: Paths, options: { guestCwd: string; hostPaths: string[] }): Record<string, string>
  _sessionLaunch(paths: Paths): { file: string; args: string[] }
  _runManaged(spec: { file: string; args: string[]; cwd: string; env: Record<string, string>; timeout: number; signal?: AbortSignal }):
    Promise<{ exitCode?: number | null; stderr?: string | Buffer }>
}

async function packages(root: string): Promise<Set<string>> {
  const status = await readFile(await inside(root, 'var/lib/dpkg/status'), 'utf8')
  return new Set(status.split(/\r?\n\r?\n/).flatMap(record => {
    const name = /^Package: ([a-z0-9][a-z0-9+.-]{0,79})$/m.exec(record)?.[1]
    return name && /^Status: \S+ ok installed$/m.test(record) ? [name] : []
  }))
}

async function inside(root: string, relative: string): Promise<string> {
  const canonical = await realpath(root)
  const path = await realpath(join(root, relative))
  if (!path.startsWith(canonical + sep)) throw new Error('Linux preservation path escapes the root filesystem')
  return path
}

async function mergeTree(previous: string, next: string, relative: string) {
  const source = join(previous, relative)
  const info = await lstat(source).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!info?.isDirectory()) return
  const from = await inside(previous, relative)
  const to = join(next, relative)
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : undefined
  if (parent) await inside(next, parent)
  await mkdir(to, { recursive: true })
  await cp(from, await inside(next, relative), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
}

/** Replay guest additions into the staged instance before Bionilux probes or changes its active record. */
export function prepareRuntimeInstallation(value: unknown, manifest: { runtimes?: Array<{ id: string; nodeAsset?: { sha256: string } }> }, runtimeId: string) {
  const manager = value as Partial<Runtime>
  const previous = manager.status?.().paths?.rootfs
  if (!previous) return () => {}
  if (!manager._prepareAndroidRootfs || !manager._runManaged || !manager._nodePath || !manager._executionEnvironment ||
    !manager._sessionLaunch || !manager.dataDir) throw new Error('This Linux runtime cannot preserve its installed packages during upgrade')
  const digest = manifest.runtimes?.find(runtime => runtime.id === runtimeId)?.nodeAsset?.sha256
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('The replacement Linux runtime has no verified Node asset')
  const runtime = manager as Runtime
  const prepare = runtime._prepareAndroidRootfs
  runtime._prepareAndroidRootfs = async (instance, signal) => {
    const before = await packages(previous)
    for (const relative of ['home', 'root', 'opt', 'usr/local', 'etc/apt']) {
      await mergeTree(previous, instance.rootfs, relative)
    }
    await prepare.call(runtime, instance, signal)
    const after = await packages(instance.rootfs)
    const missing = [...before].filter(name => !after.has(name))
    if (missing.length === 0) return
    const paths = {
      ...instance,
      node: runtime._nodePath('sha256-' + digest),
      launcher: join(instance.backend, 'bin', 'bionilux'),
      preload: join(instance.backend, 'lib', 'libbionilux_preload.so'),
      nativeLibDir: runtime.nativeLibDir,
    }
    const launch = runtime._sessionLaunch(paths)
    if (launch.args.at(-1) !== '-s') throw new Error('Unsupported Bionilux launch contract')
    const command = 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove -- ' + missing.join(' ')
    const result = await runtime._runManaged({
      file: launch.file, args: [...launch.args.slice(0, -1), '-c', command],
      cwd: runtime.dataDir, env: runtime._executionEnvironment(paths, { guestCwd: '/', hostPaths: [] }),
      timeout: 20 * 60_000, signal,
    })
    if (result.exitCode !== 0) throw new Error('Could not restore installed Linux packages: ' + (result.stderr?.toString().trim().slice(-1500) ?? ''))
  }
  return () => { runtime._prepareAndroidRootfs = prepare }
}
