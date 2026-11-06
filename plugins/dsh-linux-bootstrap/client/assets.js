/**
 * Host-side asset preparation for one install attempt.
 *
 * The engine cannot fetch Linux release assets itself: `.tar.xz` decoding and
 * the hardened extractor live in the Android shell, and the device-control
 * queue is not a download channel. The page therefore asks the shell to stage
 * each manifest asset through `window.androidBridge`:
 *
 *   linuxAssetPrepare(JSON.stringify({ url, sha256, size })) -> { ok, phase }
 *   linuxAssetPrepareStatus()                                -> { phase, code, detail, sha256, stagedPath }
 *
 * Assets are prepared one at a time (the bridge keeps a single running
 * snapshot) and the engine install only starts after all report `ok`. The
 * bootstrap still re-verifies what it finds; staging is not proof of usability.
 */

/** Runtime asset fields in manifest order: launcher backend, rootfs, shared Node. */
export const RUNTIME_ASSET_FIELDS = Object.freeze(['backendAsset', 'rootfsAsset', 'nodeAsset'])

/**
 * Manifest field -> shell unpack kind.
 *
 * The shell needs the kind to choose its unpack rule: a rootfs legitimately
 * contains symlinks and must not be unpacked with the plugin rule.
 */
export const ASSET_KINDS = Object.freeze({
  'runtime-plugin': 'plugin',
  backendAsset: 'backend',
  rootfsAsset: 'rootfs',
  nodeAsset: 'node',
})

const SHA256 = /^[a-f0-9]{64}$/

/** True for a well-formed asset record the bridge can accept. */
export function isValidAsset(asset) {
  return Boolean(
    asset
    && typeof asset === 'object'
    && typeof asset.url === 'string'
    && asset.url.startsWith('https://')
    && typeof asset.sha256 === 'string'
    && SHA256.test(asset.sha256)
    && Number.isSafeInteger(asset.size)
    && asset.size >= 0,
  )
}

/** Pick the runtime the install will use: explicit id, else the first match for the host architecture. */
export function selectRuntime(manifest, { runtimeId, architecture } = {}) {
  const runtimes = Array.isArray(manifest?.runtimes) ? manifest.runtimes : []
  const matching = architecture
    ? runtimes.filter((runtime) => runtime?.architecture === architecture)
    : runtimes
  if (runtimeId) return matching.find((runtime) => runtime?.id === runtimeId) ?? null
  return matching[0] ?? null
}

/**
 * Ordered assets for one install: the runtime plugin bundle first, then the
 * selected runtime's backend, rootfs and shared Node.
 *
 * @param {object} manifest - Verified release manifest.
 * @param {{runtimeId?: string, architecture?: string}} selection - Runtime choice.
 * @returns {{runtime: object|null, specs: Array<{id: string, field: string, url: string, sha256: string, size: number}>}}
 */
export function assetSpecsFor(manifest, selection = {}) {
  const specs = []
  const plugin = manifest?.plugins?.runtime
  if (isValidAsset(plugin)) {
    specs.push({
      id: 'runtime-plugin',
      field: 'runtime-plugin',
      kind: ASSET_KINDS['runtime-plugin'],
      url: plugin.url,
      sha256: plugin.sha256,
      size: plugin.size,
    })
  }
  const runtime = selectRuntime(manifest, selection)
  if (runtime) {
    for (const field of RUNTIME_ASSET_FIELDS) {
      const asset = runtime[field]
      if (isValidAsset(asset)) {
        specs.push({
          id: `${runtime.id}:${field}`,
          field,
          kind: ASSET_KINDS[field],
          url: asset.url,
          sha256: asset.sha256,
          size: asset.size,
        })
      }
    }
  }
  return { runtime, specs }
}

/**
 * Total download size of a prepared set, for the size hint.
 *
 * @param {Array<{size: number}>} specs - Asset specs.
 * @returns {number} Sum in bytes.
 */
export function totalBytes(specs) {
  return (Array.isArray(specs) ? specs : [])
    .reduce((sum, spec) => sum + (Number.isSafeInteger(spec.size) ? spec.size : 0), 0)
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Failure raised while preparing host assets, carrying the bridge's stable code. */
export class AssetError extends Error {
  constructor(message, { code = '', detail = '', assetId = '' } = {}) {
    super(message)
    this.name = 'AssetError'
    this.code = code
    this.detail = detail
    this.assetId = assetId
  }
}

const parse = (value) => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? value : null
}

/**
 * Stage every asset through the Android bridge, one at a time.
 *
 * @param {object} options
 * @param {{linuxAssetPrepare?: Function, linuxAssetPrepareStatus?: Function}} options.bridge - `window.androidBridge`.
 * @param {Array<object>} options.specs - Assets from {@link assetSpecsFor}.
 * @param {(progress: {index: number, total: number, id: string, field: string, phase: string}) => void} [options.onProgress]
 * @param {number} [options.pollMs] - Status poll interval.
 * @param {number} [options.timeoutMs] - Per-asset deadline.
 * @param {typeof setTimeout} [options.sleepImpl] - Timer (tests inject a fast one).
 * @returns {Promise<void>} Resolves once every asset reports `ok`.
 */
export async function prepareAssets({
  bridge,
  specs,
  onProgress = () => {},
  pollMs = 600,
  timeoutMs = 20 * 60 * 1000,
  sleepImpl = wait,
  now = () => Date.now(),
} = {}) {
  if (!bridge || typeof bridge.linuxAssetPrepare !== 'function' || typeof bridge.linuxAssetPrepareStatus !== 'function') {
    throw new AssetError('The Android asset bridge is unavailable', { code: 'linux-asset-bridge-missing' })
  }
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new AssetError('The release manifest lists no installable assets', { code: 'linux-asset-spec-invalid' })
  }

  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]
    const total = specs.length
    const report = (phase) => onProgress({ index: index + 1, total, id: spec.id, field: spec.field, phase })
    report('starting')

    let started = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // `kind` is part of the contract: the shell picks the unpack rule from it.
      const answer = parse(bridge.linuxAssetPrepare(JSON.stringify({
        url: spec.url,
        sha256: spec.sha256,
        size: spec.size,
        kind: spec.kind,
      })))
      if (answer === null) {
        throw new AssetError('The Android asset bridge returned no answer', { code: 'linux-asset-bridge-invalid', assetId: spec.id })
      }
      if (answer.ok === true) {
        started = answer
        break
      }
      if (answer.code === 'linux-asset-busy') {
        await sleepImpl(pollMs)
        continue
      }
      throw new AssetError(answer.detail || answer.code || 'Asset preparation was rejected', {
        code: answer.code || '',
        detail: answer.detail || '',
        assetId: spec.id,
      })
    }
    if (started === null) {
      throw new AssetError('Another asset preparation never finished', { code: 'linux-asset-busy', assetId: spec.id })
    }

    const deadline = now() + timeoutMs
    for (;;) {
      const snapshot = parse(bridge.linuxAssetPrepareStatus())
      const phase = snapshot?.phase ?? ''
      if (phase === 'ok') {
        if (snapshot.sha256 !== spec.sha256) {
          throw new AssetError('The staged asset does not match the requested digest', {
            code: 'linux-asset-digest-mismatch',
            detail: String(snapshot.sha256 ?? ''),
            assetId: spec.id,
          })
        }
        break
      }
      if (phase === 'failed') {
        throw new AssetError(snapshot.detail || snapshot.code || 'Asset preparation failed', {
          code: snapshot.code || '',
          detail: snapshot.detail || '',
          assetId: spec.id,
        })
      }
      if (phase === 'idle') {
        throw new AssetError('The Android asset bridge lost track of this asset', { code: 'linux-asset-lost', assetId: spec.id })
      }
      if (now() > deadline) {
        throw new AssetError('Asset preparation timed out', { code: 'linux-asset-timeout', assetId: spec.id })
      }
      report(phase === 'running' ? 'preparing' : phase)
      await sleepImpl(pollMs)
    }
    report('staged')
  }
}

