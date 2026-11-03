import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import {
  authorizeMobileRoute, sendMobileRouteRejection,
  type MobileRouteRequest, type MobileRouteResponse, type MobileRouteAuthOptions,
} from '@dsh-android/dsh-android-bridge'

export interface BootstrapStatus {
  /** Finalized Bionilux shape. */
  installed?: boolean
  version?: string | null
  mobileVersion?: string
  installedSystemMobileVersion?: string | null
  autoUpdate?: boolean
  availableVersion?: string | null
  updateAvailable?: boolean
  updateBlocked?: boolean
  busy?: boolean
  operation?: string | null
  runtime?: { id?: string; label?: string; state?: string } | string | null
  injectionActivated?: boolean
  enabled?: boolean
  pluginReleaseUrls?: { bootstrap?: string; runtime?: string }
  lastCheckAt?: string | null
  error?: string | null
  /** Earlier proposal; kept accepted so an older bootstrap still normalizes. */
  autoUpdateEnabled?: boolean
  currentMobileVersion?: string
  installedLinuxVersion?: string | null
  runtimeId?: string | null
  latestReleaseVersion?: string | null
  lastAutomaticCheckMobileVersion?: string | null
  lastError?: string | null
  plugins?: { bootstrap?: { releaseUrl?: string }; runtime?: { releaseUrl?: string } }
}

export interface LinuxBootstrap {
  status(): BootstrapStatus | Promise<BootstrapStatus>
  checkForUpdates(options: { source: 'manual' | 'mobile-version-change' }): unknown | Promise<unknown>
  install(options: { runtimeId: string }): unknown | Promise<unknown>
  reinstall(): unknown | Promise<unknown>
  uninstall(): unknown | Promise<unknown>
  setAutoUpdateEnabled(enabled: boolean): unknown | Promise<unknown>
}

export interface PluginScope {
  dispose(): unknown | Promise<unknown>
  state?: FiberState
  /** Resolves once the activation is settled, mirroring what awaiting a Cordis fiber does. */
  ready?: unknown
  /** The value the plugin returned from `apply()`, when the host can surface it. */
  manager?: unknown
  /** Reads a service the activated plugin published through `ctx.provide(name, service)`. */
  get?(name: string): unknown
}
/**
 * Adapts a Cordis fiber into the activation scope this host hands back.
 *
 * Why it is exported: the host (`src/index.ts`) and its tests must adapt fibers identically, or the
 * service the runtime plugin publishes (`linuxRuntimeManager`) is readable in one place and invisible
 * in the other.
 *
 * Two details the plain wrapper must keep from the raw fiber: `state` is a live getter (fibers
 * activate asynchronously, so capturing it at call time reads PENDING), and `ready` carries the
 * fiber's own thenable settlement — a Cordis fiber is awaitable, and dropping that would make the
 * ACTIVE check race an async `apply()`.
 */
export function cordisScope(fiber: { state?: FiberState; dispose(): unknown | Promise<unknown>; ctx: unknown }): PluginScope {
  return {
    get state() { return fiber.state },
    ready: Promise.resolve(fiber as never),
    dispose: () => fiber.dispose(),
    get: name => (fiber.ctx as Record<string, unknown>)[name],
  }
}
/** The runtime side's handle: exactly the shape the bootstrap's own `isManager` check accepts. */
export interface RuntimeManager {
  install(...args: unknown[]): unknown
  uninstall(...args: unknown[]): unknown
  reinstall?(...args: unknown[]): unknown
}
export interface PluginInstall { directory: string; entry?: string; config?: Record<string, unknown>; enable?: boolean }
export interface PluginUninstall { runtimeId?: string; directory?: string; rollback?: unknown }
/** Membership knowledge is limited to what is actually present under the built-in plugin root. */
export interface PluginInjectionQuery { name?: string; runtimeId?: string; directory?: string }
export interface PluginInjectionState { injected: boolean; active: boolean; directory?: string }
/**
 * `manager` is mandatory: the bootstrap resolves it as
 * `hostResult.manager ?? hostResult.service.manager ?? hostResult.service` and aborts the install
 * with "The installed runtime plugin did not provide a runtime manager" when it finds none.
 * `rollback` is optional and ours to own; the bootstrap calls it after a failed install.
 */
export interface PluginInstallResult {
  directory: string
  active: boolean
  manager: RuntimeManager
  rollback: () => Promise<void>
}
export interface LinuxPluginHost {
  install(options: PluginInstall): Promise<PluginInstallResult>
  uninstall(options?: PluginUninstall): Promise<void>
  isInjected(query: PluginInjectionQuery): Promise<PluginInjectionState>
}
const isManager = (value: unknown): value is RuntimeManager => {
  const candidate = value as RuntimeManager | null | undefined
  return candidate !== null && typeof candidate === 'object' &&
    typeof candidate.install === 'function' && typeof candidate.uninstall === 'function'
}

/** The experimental internal bootstrap ships an integrity-verified, versioned directory; only Cordis activation lives here. */
export function createLinuxPluginHost(options: {
  root: string | undefined
  activate(plugin: unknown, config: Record<string, unknown>): PluginScope | PromiseLike<PluginScope>
  importModule?: (url: string) => Promise<unknown>
}): LinuxPluginHost {
  let scope: PluginScope | undefined
  let activeDirectory: string | undefined
  let manager: RuntimeManager | undefined
  let operation: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = operation.then(fn)
    operation = next.catch(() => {})
    return next
  }
  const inside = (root: string, target: string) => {
    const path = relative(root, target)
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  }
  /** A name is a single directory segment: separators would escape the bootstrap-owned root. */
  const SAFE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/
  const defaultEntry = (input?: string) => input ?? 'lib/index.js'
  const isFile = async (path: string) => {
    try { return (await stat(path)).isFile() } catch { return false }
  }
  const rootReal = async () => {
    if (!options.root) return undefined
    try { return await realpath(options.root) } catch { return undefined }
  }
  /**
   * Presence is read straight from the built-in plugin directory. Nothing is created, repaired or
   * re-downloaded here, so a plugin the user removed stays removed and cannot be resurrected by a
   * new release or app version. Presence is not enablement: being present never turns it on.
   */
  const findInjected = async (root: string, query: PluginInjectionQuery, entry: string) => {
    if (typeof query.directory === 'string' && query.directory !== '') {
      const explicit = await realpath(query.directory).catch(() => undefined)
      if (explicit !== undefined && inside(root, explicit) && await isFile(join(explicit, entry))) return explicit
    }
    for (const name of [query.name, query.runtimeId]) {
      if (typeof name !== 'string' || !SAFE_NAME.test(name)) continue
      let base: string
      try { base = await realpath(join(root, name)) } catch { continue }
      if (!inside(root, base)) continue
      if (await isFile(join(base, entry))) return base
      const versions = (await readdir(base, { withFileTypes: true }).catch(() => []))
        .filter(dirent => dirent.isDirectory()).map(dirent => dirent.name).sort().reverse()
      for (const version of versions) {
        const candidate = join(base, version)
        if (await isFile(join(candidate, entry))) return candidate
      }
    }
    return undefined
  }
  const isActive = () => scope !== undefined && (scope.state === undefined || scope.state === FiberState.ACTIVE)
  /** Forgets cached activation even when disposal fails; the caller still receives that failure. */
  const release = async () => {
    try {
      if (scope) await scope.dispose()
    } finally {
      scope = undefined
      manager = undefined
      activeDirectory = undefined
    }
  }
  /**
   * The runtime plugin exposes its manager two equivalent ways: `apply()` returns it, and it
   * publishes the same object through `ctx.provide('linuxRuntimeManager', manager)`. Take whichever
   * the host can see, in the bootstrap's own precedence, so the returned `hostResult` always carries
   * a manager that satisfies `isManager`.
   */
  const runtimeManager = (activated: PluginScope) => {
    const source = activated.manager ?? activated.get?.('linuxRuntimeManager')
    if (source === null || typeof source !== 'object') return undefined
    const record = source as { manager?: unknown; service?: unknown }
    const service = record.service as { manager?: unknown } | undefined
    for (const candidate of [record.manager, service?.manager, record.service, source]) {
      if (isManager(candidate)) return candidate as RuntimeManager
    }
    return undefined
  }
  return {
    install: input => serialize(async () => {
      const root = await rootReal()
      if (root === undefined) throw new Error('DSH_FILES_DIR is required to activate the Linux runtime plugin')
      const directory = await realpath(input.directory).catch(() => undefined)
      if (directory === undefined || !inside(root, directory)) {
        throw new Error('Runtime plugin is not present in the injection directory; add it explicitly before installing')
      }
      const entry = await realpath(resolve(directory, defaultEntry(input.entry)))
      if (!inside(directory, entry)) throw new Error('Runtime plugin entry must be inside its verified directory')
      if (isActive() && activeDirectory === directory && manager !== undefined) {
        return { directory, active: true, manager, rollback: release }
      }
      const plugin = await (options.importModule ?? (url => import(url)))(pathToFileURL(entry).href)
      if (typeof plugin !== 'object' || plugin === null || typeof (plugin as { apply?: unknown }).apply !== 'function') {
        throw new Error('Runtime bundle must export a Cordis apply function')
      }
      await release()
      const activation = options.activate(plugin, input.config ?? {})
      let activated: PluginScope | undefined
      try {
        activated = await activation
        if (activated.ready !== undefined) await activated.ready
        if (activated.state !== undefined && activated.state !== FiberState.ACTIVE) {
          throw new Error('Runtime Cordis plugin did not become active')
        }
        const resolved = runtimeManager(activated)
        if (resolved === undefined) throw new Error('The installed runtime plugin did not provide a runtime manager')
        scope = activated
        manager = resolved
        activeDirectory = directory
        return { directory, active: true, manager: resolved, rollback: release }
      } catch (error) {
        const failed = activated ?? ('dispose' in activation ? activation : undefined)
        await failed?.dispose()
        throw error
      }
    }),
    // `rollback` belongs to the bootstrap's transaction; the host only releases the scope.
    uninstall: (_options?: PluginUninstall) => serialize(release),
    isInjected: async query => {
      const root = await rootReal()
      if (root === undefined) return { injected: false, active: false }
      const asked = (typeof query.directory === 'string' && query.directory !== '') ||
        [query.name, query.runtimeId].some(name => typeof name === 'string' && name !== '')
      const directory = await findInjected(root, query, defaultEntry())
      if (directory !== undefined) {
        return { injected: true, active: isActive() && activeDirectory === directory, directory }
      }      // A specific query that matched nothing is a real "not present" answer. Only an empty query
      // may fall back to the activated directory, and only while that directory still exists on disk,
      // so a manual deletion stays visible instead of being masked by stale in-memory state.
      if (asked) return { injected: false, active: false }
      if (activeDirectory !== undefined && inside(root, activeDirectory) && await isFile(join(activeDirectory, defaultEntry()))) {
        return { injected: true, active: isActive(), directory: activeDirectory }
      }
      return { injected: false, active: false }
    },
  }
}

/** Normalizes both the finalized Bionilux status shape and the earlier proposed one. */
export function normalizeLinuxStatus(status: BootstrapStatus) {
  const updateBlocked = status.updateBlocked === true
  const runtime = status.runtime ?? status.runtimeId ?? undefined
  const runtimeFace = typeof runtime === 'string'
    ? { id: runtime, label: runtime === 'debian-minimal' ? 'Debian minimal' : runtime }
    : runtime ?? undefined
  const plugins = status.plugins ?? (status.pluginReleaseUrls === undefined ? undefined : {
    bootstrap: { releaseUrl: status.pluginReleaseUrls.bootstrap },
    runtime: { releaseUrl: status.pluginReleaseUrls.runtime },
  })
  return {
    installed: status.installed ?? Boolean(status.installedLinuxVersion),
    version: status.version ?? status.installedLinuxVersion ?? undefined,
    mobileVersion: status.mobileVersion ?? status.currentMobileVersion ?? 'unknown',
    installedSystemMobileVersion: status.installedSystemMobileVersion ?? undefined,
    autoUpdate: status.autoUpdate ?? status.autoUpdateEnabled ?? false,
    availableVersion: status.availableVersion ??
      (status.updateAvailable === true && !updateBlocked ? status.latestReleaseVersion ?? undefined : undefined),
    busy: status.busy ?? Boolean(status.operation && status.operation !== 'idle'),
    runtime: runtimeFace,
    plugins,
    // A removed injection means automatic updates are off: surface it instead of a silent stop.
    injectionActivated: status.injectionActivated,
    enabled: status.enabled,
    lastCheckAt: status.lastCheckAt ?? undefined,
    error: status.error ?? status.lastError ??
      (updateBlocked ? '此系统版本与当前应用不兼容，暂不能安装更新。' : undefined),
  }
}

/**
 * One attempt per app version, only when the system is still installed and still present.
 * The bootstrap owns persistence and dedupe; this gate only decides whether to ask at all.
 */
export async function checkLinuxEnvironmentAfterMobileChange(bootstrap: LinuxBootstrap): Promise<void> {
  const status = await bootstrap.status()
  const installed = status.installed ?? Boolean(status.installedLinuxVersion)
  const mobileVersion = status.mobileVersion ?? status.currentMobileVersion
  if ((status.autoUpdate ?? status.autoUpdateEnabled) !== true || !installed) return
  if (status.injectionActivated === false || status.enabled === false) return
  if (!status.installedSystemMobileVersion || !mobileVersion) return
  if (status.installedSystemMobileVersion === mobileVersion) return
  if (status.lastAutomaticCheckMobileVersion === mobileVersion) return
  if (status.operation && status.operation !== 'idle') return
  await bootstrap.checkForUpdates({ source: 'mobile-version-change' })
}

const ROUTES = [
  ['status', '/api/android/linux-environment/status'],
  ['check', '/api/android/linux-environment/check'],
  ['install', '/api/android/linux-environment/install'],
  ['reinstall', '/api/android/linux-environment/reinstall'],
  ['uninstall', '/api/android/linux-environment/uninstall'],
  ['auto-update-on', '/api/android/linux-environment/auto-update-on'],
  ['auto-update-off', '/api/android/linux-environment/auto-update-off'],
] as const
interface Request extends MobileRouteRequest { [Symbol.asyncIterator](): AsyncIterator<Buffer | string> }
interface WebServer { register(route: { kind: 'exact'; path: string; handler(req: Request, res: MobileRouteResponse): Promise<void> }): () => void }

async function readConfirmation(req: Request): Promise<boolean> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1024) throw new Error('Request body is too large')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof value === 'object' && value !== null && (value as { confirmed?: unknown }).confirmed === true
}

export function registerLinuxEnvironmentRoutes(options: {
  webServer: WebServer
  effect(register: () => () => void): unknown
  auth(): MobileRouteAuthOptions
  bootstrap(): LinuxBootstrap | undefined
}) {
  let busy = false
  const send = (res: MobileRouteResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  for (const [action, path] of ROUTES) {
    options.effect(() => options.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const rejection = authorizeMobileRoute(req, options.auth())
        if (rejection !== undefined) { sendMobileRouteRejection(res, rejection); return }
        const method = action === 'status' ? 'GET' : 'POST'
        if (req.method !== method) {
          res.writeHead(405, { allow: method, 'cache-control': 'no-store' })
          res.end()
          return
        }
        const bootstrap = options.bootstrap()
        if (!bootstrap) { send(res, 503, { error: 'Linux bootstrap 内部插件尚未启用。它随应用放在内置（hard）插件目录里，需要你显式启用后重载引擎；存在不等于启用。' }); return }
        if (action === 'status') {
          try {
            const status = normalizeLinuxStatus(await bootstrap.status())
            send(res, 200, { ...status, busy: busy || status.busy })
          }
          catch { send(res, 500, { error: '无法读取 Linux 环境状态。' }) }
          return
        }
        if (busy) { send(res, 409, { error: '另一项 Linux 环境操作正在进行，请稍后重试。' }); return }
        busy = true
        try {
          if (action !== 'check') {
            let confirmed = false
            try { confirmed = await readConfirmation(req) } catch { send(res, 400, { error: '请求确认信息无效。' }); return }
            if (!confirmed) { send(res, 400, { error: '操作需要用户明确确认。' }); return }
          }
          switch (action) {
            case 'check': await bootstrap.checkForUpdates({ source: 'manual' }); break
            case 'install': await bootstrap.install({ runtimeId: 'debian-minimal' }); break
            case 'reinstall': await bootstrap.reinstall(); break
            case 'uninstall': await bootstrap.uninstall(); break
            case 'auto-update-on': await bootstrap.setAutoUpdateEnabled(true); break
            case 'auto-update-off': await bootstrap.setAutoUpdateEnabled(false); break
          }
          send(res, 200, normalizeLinuxStatus(await bootstrap.status()))
        } catch { send(res, 500, { error: 'Linux 环境操作失败，请检查环境状态与日志后重试。' }) }
        finally { busy = false }
      },
    }))
  }
}
