import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchLatestManifest } from './github.js'
import {
  defaultRuntimeIdForArch,
  resolveHostArchitecture,
  RUNTIME_ENTRY,
  RUNTIME_PACKAGE_NAME,
  selectRuntimeForArch,
  validateManifestShape,
} from './manifest.js'
import { installVerifiedPluginBundle } from './asset-bundle.js'
import { compareVersions, parseVersion } from './version.js'

export const name = 'dsh-linux-bootstrap'
export const inject = ['linuxPluginHost']
/** @deprecated Historical ARM64 ID; use defaultRuntimeIdForArch for host selection. */
export const DEFAULT_RUNTIME_ID = 'debian-minimal'
export const BOOTSTRAP_VERSION = '0.5.0'
export const STATE_FILE_NAME = 'linux-bootstrap-state.json'
const isManager = (value) => value && typeof value.install === 'function' && typeof value.uninstall === 'function'
const safeError = (error) => error instanceof Error ? error.message : String(error)
const optionalVersion = (value) => typeof value === 'string' && parseVersion(value) ? value.replace(/^v/, '') : null

function appVersionReader(provider) {
  return async () => {
    let value
    if (typeof provider === 'function') value = await provider()
    else if (provider && typeof provider.getVersion === 'function') value = await provider.getVersion()
    else if (provider && typeof provider.getCurrentVersion === 'function') value = await provider.getCurrentVersion()
    else value = provider
    if (value == null || value === '') return null
    const version = String(value).trim()
    if (!parseVersion(version)) throw new TypeError('Current DSH Mobile version must be semantic version')
    return version.replace(/^v/, '')
  }
}

function initialState(autoUpdate) {
  return {
    schemaVersion: 1,
    autoUpdateEnabled: autoUpdate === true,
    installedSystemMobileVersion: null,
    lastAutomaticCheckMobileVersion: null,
    installedLinuxVersion: null,
    enabled: false,
    injectionActivated: false,
    runtimeId: null,
    pluginDirectory: null,
    pinnedManifest: null,
    availableManifest: null,
    latestReleaseVersion: null,
    updateAvailable: false,
    updateBlocked: false,
    lastCheckAt: null,
    lastError: null,
    runtime: null,
  }
}

/**
 * Runtime choices offered by the newest manifest this service has seen.
 *
 * The list is data-driven, but only runtimes for this host's architecture are
 * offered: selecting an x64 runtime on an arm64 device is never a valid install.
 *
 * @param {object} state - Persisted bootstrap state.
 * @param {'arm64'|'x64'} arch - Architecture of this host.
 * @returns {Array<{id: string, label: string, architecture: string, installed: boolean}>} Choices.
 */
function availableRuntimes(state, arch) {
  const manifest = state.availableManifest ?? state.pinnedManifest
  if (!Array.isArray(manifest?.runtimes)) return []
  return manifest.runtimes.filter((runtime) => runtime.architecture === arch).map((runtime) => ({
    id: runtime.id,
    label: runtime.label,
    architecture: runtime.architecture,
    installed: state.runtimeId === runtime.id && Boolean(state.installedLinuxVersion),
  }))
}

function statusShape(state, mobileVersion, operation, packageVersion, arch) {
  return Object.freeze({
    experimental: true,
    enabledByDefault: false,
    sandboxed: false,
    installed: Boolean(state.installedLinuxVersion),
    enabled: Boolean(state.enabled),
    injectionActivated: Boolean(state.injectionActivated),
    version: state.installedLinuxVersion,
    mobileVersion: mobileVersion ?? null,
    installedSystemMobileVersion: state.installedSystemMobileVersion,
    autoUpdate: state.autoUpdateEnabled,
    autoUpdateEnabled: state.autoUpdateEnabled,
    availableVersion: state.latestReleaseVersion,
    latestReleaseVersion: state.latestReleaseVersion,
    updateAvailable: state.updateAvailable,
    updateBlocked: state.updateBlocked,
    busy: operation !== 'idle',
    operation,
    runtimeId: state.runtimeId,
    runtime: state.runtime ?? (state.runtimeId ? { id: state.runtimeId } : null),
    runtimes: availableRuntimes(state, arch),
    defaultRuntimeId: defaultRuntimeIdForArch(arch),
    architecture: arch,
    plugins: {
      bootstrap: { version: packageVersion, builtIn: true },
      runtime: state.installedLinuxVersion ? { version: state.installedLinuxVersion, package: RUNTIME_PACKAGE_NAME, directory: state.pluginDirectory } : null,
    },
    pluginReleaseUrls: {
      bootstrap: state.availableManifest?.plugins?.bootstrap?.pluginReleaseUrl ?? state.pinnedManifest?.plugins?.bootstrap?.pluginReleaseUrl ?? null,
      runtime: state.availableManifest?.plugins?.runtime?.pluginReleaseUrl ?? state.pinnedManifest?.plugins?.runtime?.pluginReleaseUrl ?? null,
    },
    error: state.lastError,
    lastError: state.lastError,
    lastCheckAt: state.lastCheckAt,
    lastAutomaticCheckMobileVersion: state.lastAutomaticCheckMobileVersion,
  })
}

async function persistState(statePath, state) {
  const temp = `${statePath}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  try {
    await rename(temp, statePath)
  } catch (error) {
    // Android/Linux replaces atomically. Windows refuses to rename over an
    // existing file, so host-side runs use the narrow replace fallback.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error
    await rm(statePath, { force: true })
    await rename(temp, statePath)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

function validateStoredState(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.autoUpdateEnabled !== 'boolean') throw new Error('Linux bootstrap state is invalid or unsupported')
  for (const key of ['installedSystemMobileVersion', 'lastAutomaticCheckMobileVersion', 'installedLinuxVersion', 'latestReleaseVersion']) {
    value[key] = optionalVersion(value[key])
  }
  value.enabled = value.enabled === true
  value.injectionActivated = value.injectionActivated === true
  return value
}

function publicManifest(manifest) {
  if (!manifest) return null
  const { _release, releaseVersion, ...payload } = manifest
  return payload
}

export function createMobileBootstrap(options = {}) {
  const {
    dataDir,
    releaseUrl,
    pluginHost,
    downloadAsset = options.linuxAssetIO?.downloadAsset,
    extractArchive = options.linuxAssetIO?.extractArchive,
    appVersionProvider,
    installedMobileVersion,
    manager: initialManager,
    managerProvider,
    getManager,
    fetchImpl = globalThis.fetch,
    cacheDir = dataDir ? path.join(dataDir, 'cache') : undefined,
    stagingDirectory = options.stagingDirectory ?? options.pluginDirectory ?? (dataDir ? path.join(dataDir, 'staging', 'runtime-plugin') : undefined),
    // Where the host stages a bundle it fetched itself (D-015): `<root>/<sha256>/`.
    // A directory that exists but does not match the manifest is an error, never a
    // cache miss; `requireStagedBundle` additionally forbids falling back to a
    // download when a host owns byte fetching. Only `undefined` selects the
    // default: an explicit `null` (or `false`) disables the path, so a host can
    // make its own IO the single owner of "what is staged".
    hostStagingRoot = options.hostStagingRoot === undefined
      ? (dataDir ? path.join(dataDir, 'staging') : undefined)
      : options.hostStagingRoot,
    requireStagedBundle = options.requireStagedBundle === true,
    runtimePluginConfig = {},
    autoUpdateEnabled,
    onChange,
    verifyManifest,
    arch,
  } = options

  const hostArch = resolveHostArchitecture(arch)
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required')
  if (typeof releaseUrl !== 'string' || !releaseUrl) throw new TypeError('releaseUrl is required')
  if (!pluginHost || typeof pluginHost.install !== 'function' || typeof pluginHost.uninstall !== 'function') throw new TypeError('linuxPluginHost.install and uninstall are required')
  if (typeof downloadAsset !== 'function' || typeof extractArchive !== 'function') throw new TypeError('linuxAssetIO.downloadAsset and extractArchive are required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be fetch-compatible')
  if (typeof appVersionProvider !== 'function' && !(appVersionProvider && (typeof appVersionProvider.getVersion === 'function' || typeof appVersionProvider.getCurrentVersion === 'function')) && installedMobileVersion == null) throw new TypeError('appVersionProvider is required')
  if (initialManager !== undefined && !isManager(initialManager)) throw new TypeError('manager must expose install() and uninstall()')
  if (managerProvider !== undefined && typeof managerProvider !== 'function') throw new TypeError('managerProvider must be a function')
  if (getManager !== undefined && typeof getManager !== 'function') throw new TypeError('getManager must be a function')

  const root = path.resolve(dataDir)
  const cacheRoot = path.resolve(cacheDir ?? path.join(root, 'cache'))
  const pluginRoot = path.resolve(stagingDirectory ?? path.join(root, 'plugins', 'runtime'))
  const statePath = path.join(root, STATE_FILE_NAME)
  const readAppVersion = appVersionReader(appVersionProvider ?? installedMobileVersion)
  const state = initialState(autoUpdateEnabled)
  let mobileVersion = null
  let operation = 'idle'
  let manager = initialManager ?? null
  let installedPlugin = false
  // Set when this load re-activated a persisted installation. A host that still
  // reports `active: false` right after a successful install is lagging, not a
  // user removal, so the opt-in must not be cleared on that basis.
  let restoredThisLoad = false
  let lastStatus
  let ready
  let tail = Promise.resolve()
  const listeners = new Set()

  const statusValue = () => statusShape(state, mobileVersion, operation, options.version ?? BOOTSTRAP_VERSION, hostArch)
  const emit = () => {
    lastStatus = statusValue()
    for (const listener of listeners) {
      try { listener(lastStatus) } catch { /* Listener errors do not affect bootstrap operations. */ }
    }
    try { onChange?.(lastStatus) } catch { /* UI errors do not affect bootstrap operations. */ }
    return lastStatus
  }
  const save = () => persistState(statePath, state)
  const serial = (fn) => {
    const current = tail.then(fn, fn)
    tail = current.catch(() => {})
    return current
  }
  const updateMobileVersion = async () => {
    mobileVersion = await readAppVersion()
    return mobileVersion
  }
  const fetchManifest = async () => {
    const { manifest, releaseTag } = await fetchLatestManifest(releaseUrl, fetchImpl)
    let checked = validateManifestShape(manifest, releaseTag)
    if (typeof verifyManifest === 'function' && await verifyManifest(checked) !== true) throw new Error('Release manifest verification failed')
    return checked
  }
  const ensureMobileCompatible = (manifest, current) => {
    if (!current) throw new Error('Current DSH Mobile version is unavailable')
    if (compareVersions(current, manifest.minMobileVersion) < 0) throw new Error(`Linux release requires DSH Mobile ${manifest.minMobileVersion} or newer`)
  }
  const resolveManager = async ({ hostResult, directory, config }) => {
    const candidate = hostResult?.manager ?? hostResult?.service?.manager ?? hostResult?.service ?? manager
    if (isManager(candidate)) {
      manager = candidate
      return manager
    }
    const provider = managerProvider ?? getManager
    if (provider) {
      const provided = await provider({ pluginHost, directory, entry: RUNTIME_ENTRY, config })
      const providedManager = provided?.manager ?? provided?.service?.manager ?? provided?.service ?? provided
      if (isManager(providedManager)) {
        manager = providedManager
        return manager
      }
    }
    throw new Error('The installed runtime plugin did not provide a runtime manager')
  }
  /**
   * Ask the host whether the runtime plugin is still explicitly injected.
   *
   * The injection directory is the user's, not ours: the host adapter
   * (`linuxPluginHost`) is the only source of truth, and it is asked with
   * read-only queries. A plugin the user removed by hand therefore reports
   * `injected: false` and is never silently restored.
   *
   * @returns {Promise<{injected: boolean, active: boolean}|null>} Host view, or null when unsupported.
   */
  async function hostInjection() {
    const request = { name: RUNTIME_PACKAGE_NAME, runtimeId: state.runtimeId, directory: state.pluginDirectory }
    if (typeof pluginHost.isInjected === 'function') {
      const result = await pluginHost.isInjected(request)
      if (typeof result === 'boolean') return { injected: result, active: result }
      const injected = result?.injected === true
      return { injected, active: typeof result?.active === 'boolean' ? result.active : injected }
    }
    if (typeof pluginHost.status === 'function') {
      const result = await pluginHost.status(request)
      const enabled = typeof result === 'boolean' ? result : result?.enabled === true
      const activated = typeof result === 'object' && typeof result.injectionActivated === 'boolean' ? result.injectionActivated : enabled
      return { injected: enabled && activated, active: enabled && activated }
    }
    if (typeof pluginHost.isEnabled === 'function') {
      const enabled = (await pluginHost.isEnabled(request)) === true
      return { injected: enabled, active: enabled }
    }
    return null
  }

  /**
   * Reconcile the persisted activation flags with the host's injection view.
   *
   * A user who removes the runtime plugin from the injection directory gets
   * `enabled/injectionActivated = false` persisted, so neither a new Linux
   * release nor a DSH Mobile version change can resurrect it.
   */
  async function synchronizeInjectionState() {
    if (!state.installedLinuxVersion) return
    const host = await hostInjection()
    if (!host) return
    if (restoredThisLoad && host.injected && !host.active) return
    state.enabled = host.injected && host.active
    state.injectionActivated = state.enabled
    await save()
  }

  const pluginConfig = (manifest, runtimeId) => ({
    ...runtimePluginConfig,
    dataDir: path.join(root, 'runtime'),
    cacheDir: cacheRoot,
    arch: hostArch,
    manifest: publicManifest(manifest),
    runtimeId,
  })

  /** A persisted activation is only restorable from a directory the host still owns. */
  const isInsidePluginRoot = (directory) => {
    if (typeof directory !== 'string' || directory === '') return false
    const relative = path.relative(pluginRoot, path.resolve(directory))
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }

  const entryIsPresent = async (directory) => {
    try {
      return (await stat(path.join(directory, RUNTIME_ENTRY))).isFile()
    } catch {
      return false
    }
  }

  /**
   * Re-activate an installation the user already confirmed.
   *
   * This runs **before** `synchronizeInjectionState()`: that function derives
   * `enabled/injectionActivated` from `host.isInjected(...).active`, and a host
   * that has just started has not loaded the runtime plugin yet, so it reports
   * `active: false` and the persisted opt-in would be cleared on every cold
   * start (tools then never come back).
   *
   * Three rules keep the restore honest:
   *   1. only when the user had persisted `enabled && injectionActivated`;
   *   2. only when the host still reports the plugin as injected (a manual
   *      removal is never resurrected, and nothing is downloaded here);
   *   3. only from a directory inside our plugin root with its entry present;
   *      a missing file disables the record instead of re-fetching it.
   */
  async function restoreActivation() {
    if (!state.installedLinuxVersion || !state.enabled || !state.injectionActivated) return
    if (!state.pluginDirectory) return
    const host = await hostInjection()
    if (!host || !host.injected) return
    if (!isInsidePluginRoot(state.pluginDirectory) || !(await entryIsPresent(state.pluginDirectory))) {
      // The user's own removal or an incomplete tree: fail closed, never re-download.
      state.enabled = false
      state.injectionActivated = false
      state.lastError = 'The installed Linux runtime plugin files are missing; an explicit install is required'
      await save()
      return
    }
    const config = pluginConfig(state.pinnedManifest, state.runtimeId)
    try {
      const hostResult = await pluginHost.install({
        directory: state.pluginDirectory,
        entry: RUNTIME_ENTRY,
        config,
        enable: true,
      })
      installedPlugin = true
      const restored = await resolveManager({ hostResult, directory: state.pluginDirectory, config })
      state.runtime = typeof restored.status === 'function' ? await restored.status() : state.runtime
      restoredThisLoad = true
      // `status()` reads active.json; the runtime plugin registers its tools during
      // activation only while that record is healthy, so surface an unhealthy
      // restore instead of reporting a working environment.
      if (state.runtime && state.runtime.healthy === false) {
        state.lastError = 'Restored Linux runtime is unhealthy: ' + (state.runtime.reason ?? 'unknown reason')
      } else {
        state.lastError = null
      }
      await save()
    } catch (error) {
      // Activation failure leaves the record installed but inactive: no download,
      // no silent revival, and the reason stays visible in status().
      // An engine shutdown is cancellation, not a broken persisted install.
      // Keep the user's activation choice so the next engine can restore it.
      if (error?.code === 'LINUX_ENGINE_STOPPING') throw error
      state.enabled = false
      state.injectionActivated = false
      state.lastError = safeError(error)
      await save()
    }
  }

  async function installRuntime({ manifest, runtimeId, reinstall = false, automatic = false, activate = false }) {
    const runtime = selectRuntimeForArch(manifest, runtimeId, hostArch)
    runtimeId = runtime.id
    await updateMobileVersion()
    ensureMobileCompatible(manifest, mobileVersion)
    if (state.installedLinuxVersion) {
      const comparison = compareVersions(manifest.version, state.installedLinuxVersion)
      if (comparison < 0) throw new Error(`Refusing to downgrade Linux runtime ${state.installedLinuxVersion} to ${manifest.version}`)
      if (comparison === 0 && !reinstall) throw new Error(`Linux runtime ${manifest.version} is already installed; use reinstall()`)
    }
    operation = reinstall ? 'reinstalling' : 'installing'
    state.lastError = null
    emit()

    let result
    let hostResult
    let hostInstalled = false
    let resolvedManager = manager
    let managerBeforeActivation = manager
    let stateBeforeActivation = null
    const config = pluginConfig(manifest, runtimeId)
    try {
      result = await installVerifiedPluginBundle({
        asset: manifest.plugins.runtime,
        destinationRoot: pluginRoot,
        hostStagingRoot,
        requireStagedBundle,
        downloadAsset,
        extractArchive,
        fetchImpl,
        kind: 'plugin',
        packageName: RUNTIME_PACKAGE_NAME,
        entry: RUNTIME_ENTRY,
      })
      const enable = automatic ? state.enabled && state.injectionActivated : activate === true
      if (automatic) {
        // An automatic update may only replace the assets of a plugin the user
        // still has in the injection directory; it must never re-add one.
        const host = await hostInjection()
        if (host && (!host.injected || !host.active)) {
          state.enabled = false
          state.injectionActivated = false
          await save()
          throw new Error('The Linux runtime plugin is no longer present in the plugin injection directory; an explicit install is required')
        }
      }
      if (!enable) throw new Error('Runtime plugin activation requires explicit confirmation')
      // Once the host has loaded the plugin, a later failure (manager
      // provisioning, health status, or persistence) rolls the host back.
      // Keep the in-memory view at the pre-activation value as well, so a
      // rolled-back install is not reported as installed until the next load.
      stateBeforeActivation = { ...state }
      managerBeforeActivation = manager
      hostResult = await pluginHost.install({ directory: result.path, entry: RUNTIME_ENTRY, config, enable })
      hostInstalled = true
      installedPlugin = true
      resolvedManager = await resolveManager({ hostResult, directory: result.path, config })
      if (reinstall && typeof resolvedManager.reinstall === 'function') await resolvedManager.reinstall(publicManifest(manifest), runtimeId)
      else await resolvedManager.install(publicManifest(manifest), runtimeId)
      state.installedLinuxVersion = manifest.version
      state.runtimeId = runtimeId
      state.pluginDirectory = result.path
      state.enabled = true
      state.injectionActivated = true
      state.lastError = null
      state.installedSystemMobileVersion = mobileVersion
      state.lastAutomaticCheckMobileVersion = automatic ? mobileVersion : state.lastAutomaticCheckMobileVersion
      state.pinnedManifest = publicManifest(manifest)
      state.availableManifest = publicManifest(manifest)
      state.latestReleaseVersion = manifest.version
      state.updateAvailable = false
      state.updateBlocked = false
      state.lastError = null
      state.runtime = typeof resolvedManager.status === 'function' ? await resolvedManager.status() : { id: runtime.id, label: runtime.label, architecture: runtime.architecture, backend: runtime.backend }
      await save()
      return emit()
    } catch (error) {
      if (hostInstalled) {
        try {
          if (typeof hostResult?.rollback === 'function') await hostResult.rollback()
          else await pluginHost.uninstall({ runtimeId, directory: result?.path, rollback: true })
        } catch (rollbackError) {
          error.rollbackError = safeError(rollbackError)
        }
      }
      if (stateBeforeActivation) {
        Object.assign(state, stateBeforeActivation)
        manager = managerBeforeActivation
      }
      state.lastError = safeError(error)
      emit()
      throw error
    } finally {
      operation = 'idle'
      emit()
    }
  }

  async function checkForUpdatesInternal({ automatic = false } = {}) {
    await updateMobileVersion()
    if (automatic && (!state.autoUpdateEnabled || !state.enabled || !state.injectionActivated || !state.installedLinuxVersion || !state.installedSystemMobileVersion || !mobileVersion || state.installedSystemMobileVersion === mobileVersion || state.lastAutomaticCheckMobileVersion === mobileVersion)) return emit()
    operation = automatic ? 'automatic-check' : 'checking'
    state.lastError = null
    state.updateBlocked = false
    emit()
    try {
      const manifest = await fetchManifest()
      ensureMobileCompatible(manifest, mobileVersion)
      state.availableManifest = publicManifest(manifest)
      state.latestReleaseVersion = manifest.version
      state.lastCheckAt = new Date().toISOString()
      const comparison = state.installedLinuxVersion ? compareVersions(manifest.version, state.installedLinuxVersion) : 1
      state.updateBlocked = comparison < 0
      state.updateAvailable = comparison > 0 || !state.installedLinuxVersion
      if (automatic) {
        state.lastAutomaticCheckMobileVersion = mobileVersion
        await save()
        if (state.updateAvailable && state.enabled && state.injectionActivated) await installRuntime({ manifest, runtimeId: state.runtimeId ?? defaultRuntimeIdForArch(hostArch), automatic: true })
      } else {
        await save()
      }
      return emit()
    } catch (error) {
      state.lastError = safeError(error)
      state.lastCheckAt = new Date().toISOString()
      if (automatic) {
        state.lastAutomaticCheckMobileVersion = mobileVersion
        await save()
      } else {
        await save()
        throw error
      }
      return emit()
    } finally {
      operation = 'idle'
      emit()
    }
  }

  async function load() {
    await mkdir(root, { recursive: true })
    await mkdir(cacheRoot, { recursive: true })
    await mkdir(pluginRoot, { recursive: true })
    try {
      Object.assign(state, validateStoredState(JSON.parse(await readFile(statePath, 'utf8'))))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await save()
    }
    await updateMobileVersion()
    // Restore before the host view is reconciled (see restoreActivation).
    await restoreActivation()
    await synchronizeInjectionState()
  }

  ready = load().then(() => serial(async () => {
    if (state.installedLinuxVersion && state.enabled && state.injectionActivated && state.autoUpdateEnabled && state.installedSystemMobileVersion && mobileVersion && state.installedSystemMobileVersion !== mobileVersion && state.lastAutomaticCheckMobileVersion !== mobileVersion) {
      return checkForUpdatesInternal({ automatic: true })
    }
    return emit()
  })).catch((error) => {
    state.lastError = safeError(error)
    emit()
  })

  const service = {
    name,
    experimental: true,
    enabledByDefault: false,
    ready,
    status: async () => { await ready; await updateMobileVersion().catch(() => {}); return emit() },
    /**
     * Check the release channel for a newer Linux version.
     *
     * `manual` is the user's explicit action and always hits the network.
     * `mobile-version-change` is the host-triggered automatic path: it is
     * deduplicated per DSH Mobile version inside this service and only proceeds
     * for an already installed and still injected system with the user's
     * auto-update preference on.
     */
    checkForUpdates: ({ source = 'manual' } = {}) => {
      if (source !== 'manual' && source !== 'mobile-version-change') {
        return Promise.reject(new TypeError('source must be manual or mobile-version-change'))
      }
      return ready.then(() => serial(() => checkForUpdatesInternal({ automatic: source === 'mobile-version-change' })))
    },
    /** Re-read the host's injection view (used after the user changes the injection directory). */
    syncInjectionState: () => ready.then(() => serial(async () => { await synchronizeInjectionState(); return emit() })),
    install: ({ runtimeId, confirmed = false, activate = false } = {}) => ready.then(() => serial(async () => {
      if (confirmed !== true || activate !== true) throw new Error('install requires confirmed:true and activate:true')
      const manifest = await fetchManifest()
      return installRuntime({ manifest, runtimeId, activate: true })
    })),
    reinstall: ({ confirmed = false, activate = false } = {}) => ready.then(() => serial(async () => {
      if (confirmed !== true || activate !== true) throw new Error('reinstall requires confirmed:true and activate:true')
      if (!state.pinnedManifest || !state.installedLinuxVersion) throw new Error('There is no installed Linux runtime to reinstall')
      const manifest = validateManifestShape(state.pinnedManifest)
      return installRuntime({ manifest, runtimeId: state.runtimeId ?? defaultRuntimeIdForArch(hostArch), reinstall: true, activate: true })
    })),
    uninstall: ({ confirmed = false } = {}) => ready.then(() => serial(async () => {
      if (confirmed !== true) throw new Error('uninstall requires confirmed:true')
      if (!state.installedLinuxVersion) return emit()
      operation = 'uninstalling'
      emit()
      try {
        if (!manager) {
          const hostResult = { service: pluginHost.service }
          manager = await resolveManager({ hostResult, directory: state.pluginDirectory, config: pluginConfig(state.pinnedManifest, state.runtimeId) })
        }
        await manager.uninstall()
        await pluginHost.uninstall({ runtimeId: state.runtimeId, directory: state.pluginDirectory })
        installedPlugin = false
        state.installedLinuxVersion = null
        state.runtimeId = null
        state.pluginDirectory = null
        state.enabled = false
        state.injectionActivated = false
        state.installedSystemMobileVersion = null
        state.lastAutomaticCheckMobileVersion = null
        state.pinnedManifest = null
        state.runtime = null
        state.updateAvailable = Boolean(state.availableManifest)
        state.updateBlocked = false
        await save()
        return emit()
      } catch (error) {
        state.lastError = safeError(error)
        emit()
        throw error
      } finally {
        operation = 'idle'
        emit()
      }
    })),
    setAutoUpdateEnabled: (enabled) => {
      if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('enabled must be a boolean'))
      return ready.then(() => serial(async () => {
        state.autoUpdateEnabled = enabled
        await save()
        return emit()
      }))
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function')
      listeners.add(listener)
      if (lastStatus) listener(lastStatus)
      else ready.then(() => listener(statusValue())).catch(() => {})
      return () => listeners.delete(listener)
    },
  }
  return service
}

export const createBootstrap = createMobileBootstrap

export function apply(ctx, config = {}) {
  const pluginHost = config.pluginHost ?? ctx.linuxPluginHost
  const filesDir = config.filesDir ?? (typeof ctx.get === 'function' ? ctx.get('filesDir') : ctx.filesDir)
  const dataDir = config.dataDir ?? (filesDir ? path.join(filesDir, 'linux-environment') : null)
  if (!dataDir) throw new TypeError('dataDir or ctx.filesDir is required')
  const service = createMobileBootstrap({ ...config, dataDir, pluginHost })
  if (typeof ctx.provide !== 'function') throw new TypeError('Cordis context must provide provide(name, service)')
  ctx.provide('linuxBootstrap', service)
  return service
}

export { installVerifiedPluginBundle } from './asset-bundle.js'
export { compareVersions, parseVersion } from './version.js'
export {
  validateManifestShape,
  findRuntime,
  selectRuntimeForArch,
  defaultRuntimeIdForArch,
  resolveHostArchitecture,
  DEFAULT_RUNTIME_IDS,
  SUPPORTED_ARCHITECTURES,
  RUNTIME_ENTRY,
  RUNTIME_PACKAGE_NAME,
} from './manifest.js'
export { LINUX_ENVIRONMENT_ROUTES, createRouteHandlers } from './routes.js'
