/**
 * Transport for the Linux environment settings section.
 *
 * The page cannot receive the engine's `linuxBootstrap` service (it lives on
 * the engine Cordis context), so state and actions go through the authenticated
 * same-origin host routes:
 *
 *   GET  /api/android/linux-environment/status
 *   GET  /api/android/linux-environment/manifest   {"manifest": {...}}
 *   POST /api/android/linux-environment/check
 *   POST /api/android/linux-environment/install | reinstall | uninstall
 *   POST /api/android/linux-environment/auto-update-on | auto-update-off
 *
 * Assets are different: the engine cannot decode `.tar.xz` and must not use
 * the device-control queue, so the page stages each manifest asset through the
 * shell bridge (window.androidBridge.linuxAssetPrepare / linuxAssetPrepareStatus)
 * *before* it posts install. Every asset matters — the runtime plugin bundle,
 * then the selected runtime's backend, rootfs and shared Node. The bootstrap
 * re-verifies each staged bundle before activation.
 */

const BASE = '/api/android/linux-environment'

/** Route table; kept in one place so the UI and tests cannot drift. */
export const LINUX_ROUTES = {
  status: BASE + '/status',
  manifest: BASE + '/manifest',
  check: BASE + '/check',
  install: BASE + '/install',
  reinstall: BASE + '/reinstall',
  uninstall: BASE + '/uninstall',
  autoUpdateOn: BASE + '/auto-update-on',
  autoUpdateOff: BASE + '/auto-update-off',
} as const

/** Status payload as normalized by the host adapter (fields we read). */
export interface LinuxStatus {
  installed?: boolean
  version?: string
  mobileVersion?: string
  installedSystemMobileVersion?: string
  autoUpdate?: boolean
  availableVersion?: string
  updateAvailable?: boolean
  updateBlocked?: boolean
  busy?: boolean
  operation?: string
  runtimeId?: string
  runtime?: { id?: string; runtimeId?: string } | null
  runtimes?: Array<{ id: string; label?: string; architecture?: string }>
  defaultRuntimeId?: string
  architecture?: string
  injectionActivated?: boolean
  pluginReleaseUrls?: { bootstrap?: string; runtime?: string }
  error?: string
}

/** One asset record as it appears in the release manifest. */
export interface ManifestAsset {
  url: string
  sha256: string
  size: number
}

/** Runtime entry of the release manifest. */
export interface ManifestRuntime {
  id: string
  label?: string
  architecture?: string
  backendAsset?: ManifestAsset
  rootfsAsset?: ManifestAsset
  nodeAsset?: ManifestAsset
}

/** Verified release manifest (only the fields this section consumes). */
export interface ReleaseManifest {
  version?: string
  minMobileVersion?: string
  plugins?: { bootstrap?: ManifestAsset; runtime?: ManifestAsset }
  runtimes?: ManifestRuntime[]
}

/** Failure from a route call, carrying the host HTTP status. */
export class RouteError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'RouteError'
    this.status = status
  }
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (cause) {
    throw new RouteError(cause instanceof Error ? cause.message : String(cause))
  }
  const payload = await json(response)
  if (!response.ok) {
    const error = typeof payload?.error === 'string' ? payload.error : ''
    throw new RouteError(error !== '' ? error : 'HTTP ' + response.status, response.status)
  }
  if (payload === null) throw new RouteError('The host returned a non-JSON response', response.status)
  return payload as T
}

/** Current persisted state. */
export function fetchStatus(): Promise<LinuxStatus> {
  return request<LinuxStatus>('GET', LINUX_ROUTES.status)
}

/**
 * The release manifest.
 *
 * Hosts publish it at `/manifest`. A host that only returns it from a manual
 * check answers 404/405 there, so exactly that status falls back to `check`
 * once; every other failure surfaces unchanged.
 */
export async function fetchManifest(): Promise<ReleaseManifest> {
  try {
    const payload = await request<{ manifest?: ReleaseManifest }>('GET', LINUX_ROUTES.manifest)
    if (payload.manifest && typeof payload.manifest === 'object') return payload.manifest
    if (payload.manifest !== null) throw new RouteError('The host returned no manifest', 200)
  } catch (cause) {
    if (!(cause instanceof RouteError) || (cause.status !== 404 && cause.status !== 405)) throw cause
    const legacy = await request<{ manifest?: ReleaseManifest }>('POST', LINUX_ROUTES.check)
    if (legacy.manifest && typeof legacy.manifest === 'object') return legacy.manifest
    throw new RouteError('The host does not expose the release manifest', cause.status)
  }
  await request<LinuxStatus>('POST', LINUX_ROUTES.check)
  const checked = await request<{ manifest?: ReleaseManifest }>('GET', LINUX_ROUTES.manifest)
  if (checked.manifest && typeof checked.manifest === 'object') return checked.manifest
  throw new RouteError('The host does not expose the release manifest')
}

/** Manual check: reports whether a newer release exists; never installs. */
export function checkForUpdates(): Promise<LinuxStatus> {
  return request<LinuxStatus>('POST', LINUX_ROUTES.check)
}

/** Download, verify, stage and activate. Explicit user action only. */
export function installEnvironment(runtimeId?: string): Promise<LinuxStatus> {
  return request<LinuxStatus>('POST', LINUX_ROUTES.install, {
    confirmed: true,
    activate: true,
    ...(runtimeId ? { runtimeId } : {}),
  })
}

/** Re-stage the pinned release with the same guarantees. */
export function reinstallEnvironment(): Promise<LinuxStatus> {
  return request<LinuxStatus>('POST', LINUX_ROUTES.reinstall, { confirmed: true, activate: true })
}

/** Remove the runtime and its plugin scope. */
export function uninstallEnvironment(): Promise<LinuxStatus> {
  return request<LinuxStatus>('POST', LINUX_ROUTES.uninstall, { confirmed: true })
}

/** Persist the automatic-update preference. */
export function setAutoUpdate(enabled: boolean): Promise<LinuxStatus> {
  return request<LinuxStatus>('POST', enabled ? LINUX_ROUTES.autoUpdateOn : LINUX_ROUTES.autoUpdateOff, { confirmed: true })
}

const SHA256 = /^[a-f0-9]{64}$/

function isAsset(value: unknown): value is ManifestAsset {
  const asset = value as ManifestAsset | undefined
  return Boolean(
    asset
    && typeof asset === 'object'
    && typeof asset.url === 'string'
    && asset.url.startsWith('https://')
    && typeof asset.sha256 === 'string'
    && SHA256.test(asset.sha256)
    && Number.isSafeInteger(asset.size)
    && (asset.size ?? -1) >= 0,
  )
}

/**
 * Runtime asset fields, in the order they are staged.
 *
 * The field also decides the shell's unpack rule, so each one maps to an
 * explicit `kind` below: a rootfs tarball legitimately contains symlinks and
 * must not be unpacked with the plugin rule.
 */
export const ASSET_FIELDS = ['backendAsset', 'rootfsAsset', 'nodeAsset'] as const

/** Asset kind understood by the shell's prepare bridge. */
export type AssetKind = 'plugin' | 'backend' | 'rootfs' | 'node'

/** Manifest field → shell kind (the bridge rejects an unknown kind). */
export const ASSET_KIND: Record<string, AssetKind> = {
  'runtime-plugin': 'plugin',
  backendAsset: 'backend',
  rootfsAsset: 'rootfs',
  nodeAsset: 'node',
}

/** One asset to stage, with the id and kind used for progress and unpacking. */
export interface AssetSpec extends ManifestAsset {
  id: string
  /** `runtime-plugin` or one of {@link ASSET_FIELDS}. */
  field: string
  /** Unpack rule for the shell: plugin / backend / rootfs / node. */
  kind: AssetKind
}

/** Pick the runtime for this device: explicit id, else first matching architecture. */
export function pickRuntime(
  manifest: ReleaseManifest,
  options: { runtimeId?: string; architecture?: string } = {},
): ManifestRuntime | null {
  const runtimes = Array.isArray(manifest.runtimes) ? manifest.runtimes : []
  const matching = options.architecture
    ? runtimes.filter((runtime) => runtime.architecture === options.architecture)
    : runtimes
  if (options.runtimeId) return matching.find((runtime) => runtime.id === options.runtimeId) ?? null
  return matching[0] ?? null
}

/**
 * Everything this install must stage: the runtime plugin bundle and the
 * selected runtime's backend, rootfs and shared Node.
 */
export function assetsFor(
  manifest: ReleaseManifest,
  options: { runtimeId?: string; architecture?: string } = {},
): { runtime: ManifestRuntime | null; specs: AssetSpec[] } {
  const specs: AssetSpec[] = []
  const plugin = manifest.plugins?.runtime
  if (isAsset(plugin)) {
    specs.push({ ...plugin, id: 'runtime-plugin', field: 'runtime-plugin', kind: ASSET_KIND['runtime-plugin'] })
  }
  const runtime = pickRuntime(manifest, options)
  if (runtime !== null) {
    for (const field of ASSET_FIELDS) {
      const asset = runtime[field]
      if (isAsset(asset)) {
        specs.push({ ...asset, id: runtime.id + ':' + field, field, kind: ASSET_KIND[field] })
      }
    }
  }
  return { runtime, specs }
}

/** Sum of asset sizes, for the download hint. */
export function totalBytes(specs: readonly AssetSpec[]): number {
  return specs.reduce((sum, spec) => sum + (Number.isSafeInteger(spec.size) ? spec.size : 0), 0)
}

/** Failure while staging an asset, carrying the bridge's stable code. */
export class AssetError extends Error {
  readonly code: string
  readonly detail: string
  readonly assetId: string
  constructor(message: string, options: { code?: string; detail?: string; assetId?: string } = {}) {
    super(message)
    this.name = 'AssetError'
    this.code = options.code ?? ''
    this.detail = options.detail ?? ''
    this.assetId = options.assetId ?? ''
  }
}

/** Bridge answer shapes (window.androidBridge). */
export interface AssetPrepareAnswer {
  ok?: boolean
  phase?: string
  code?: string
  detail?: string
}
export interface AssetPrepareSnapshot {
  phase?: string
  sha256?: string | null
  stagedPath?: string | null
  code?: string | null
  detail?: string | null
}

/** Progress callback for one asset. */
export interface AssetProgress {
  index: number
  total: number
  field: string
  phase: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

function parse(value: string | null): Record<string, unknown> | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Stage every asset through the shell bridge, one at a time.
 *
 * The bridge keeps a single running snapshot, so assets are sequential. The
 * engine install starts only after the last asset reports `ok`.
 *
 * @param bridge - `window.androidBridge`.
 * @param specs - Assets from {@link assetsFor}.
 * @param onProgress - Called on each phase change.
 * @param pollMs - Status poll interval.
 * @param timeoutMs - Per-asset deadline.
 * @returns Resolves once every asset is staged.
 */
export async function prepareAssets(
  bridge: Window['androidBridge'] | undefined,
  specs: readonly AssetSpec[],
  onProgress: (progress: AssetProgress) => void,
  pollMs = 600,
  timeoutMs = 20 * 60 * 1000,
): Promise<void> {
  if (bridge === undefined || typeof bridge.linuxAssetPrepare !== 'function' || typeof bridge.linuxAssetPrepareStatus !== 'function') {
    throw new AssetError('The Android asset bridge is unavailable', { code: 'linux-asset-bridge-missing' })
  }
  if (specs.length === 0) {
    throw new AssetError('The release manifest lists no installable assets', { code: 'linux-asset-spec-invalid' })
  }

  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]
    const total = specs.length
    const report = (phase: string): void => onProgress({ index: index + 1, total, field: spec.field, phase })
    report('starting')

    let started = false
    for (let attempt = 0; attempt < 20 && !started; attempt += 1) {
      // `kind` is part of the contract: the shell picks the unpack rule from it
      // (a rootfs legitimately contains symlinks, a plugin tarball must not).
      const answer = parse(bridge.linuxAssetPrepare(JSON.stringify({
        url: spec.url,
        sha256: spec.sha256,
        size: spec.size,
        kind: spec.kind,
      }))) as AssetPrepareAnswer | null
      if (answer === null) {
        throw new AssetError('The Android asset bridge returned no answer', { code: 'linux-asset-bridge-invalid', assetId: spec.id })
      }
      if (answer.ok === true) {
        started = true
        break
      }
      if (answer.code === 'linux-asset-busy') {
        await sleep(pollMs)
        continue
      }
      throw new AssetError(answer.detail ?? answer.code ?? 'Asset preparation was rejected', {
        code: answer.code ?? '',
        detail: answer.detail ?? '',
        assetId: spec.id,
      })
    }
    if (!started) {
      throw new AssetError('Another asset preparation never finished', { code: 'linux-asset-busy', assetId: spec.id })
    }

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const snapshot = parse(bridge.linuxAssetPrepareStatus()) as AssetPrepareSnapshot | null
      const phase = snapshot?.phase ?? ''
      if (phase === 'ok') {
        if (snapshot?.sha256 !== spec.sha256) {
          throw new AssetError('The staged asset does not match the requested digest', {
            code: 'linux-asset-digest-mismatch',
            detail: String(snapshot?.sha256 ?? ''),
            assetId: spec.id,
          })
        }
        break
      }
      if (phase === 'failed') {
        throw new AssetError(snapshot?.detail ?? snapshot?.code ?? 'Asset preparation failed', {
          code: snapshot?.code ?? '',
          detail: snapshot?.detail ?? '',
          assetId: spec.id,
        })
      }
      if (phase === 'idle') {
        throw new AssetError('The Android asset bridge lost track of this asset', { code: 'linux-asset-lost', assetId: spec.id })
      }
      if (Date.now() > deadline) {
        throw new AssetError('Asset preparation timed out', { code: 'linux-asset-timeout', assetId: spec.id })
      }
      report(phase === 'running' ? 'preparing' : phase)
      await sleep(pollMs)
    }
    report('staged')
  }
}
