/**
 * Same-origin transport for the experimental Linux environment settings section.
 *
 * The section runs inside the DSH Mobile WebView, next to the engine that owns
 * the bootstrap service. A client plugin cannot receive that service as an
 * injection (it lives on the engine's Cordis context, not in the page), so
 * every call goes through the authenticated host routes instead:
 *
 *   GET  /api/android/linux-environment/status
 *   GET  /api/android/linux-environment/manifest   {"manifest": {...}}
 *   POST /api/android/linux-environment/check
 *   POST /api/android/linux-environment/install | reinstall | uninstall
 *   POST /api/android/linux-environment/auto-update-on | auto-update-off
 *
 * Mutating routes require {"confirmed": true}. A failure body carries a
 * user-readable `error` string from the host; the section shows it as-is.
 */

export const BASE_PATH = '/api/android/linux-environment'

/** Route table, kept in one place so the client and its tests cannot drift. */
export const PATHS = Object.freeze({
  status: `${BASE_PATH}/status`,
  manifest: `${BASE_PATH}/manifest`,
  check: `${BASE_PATH}/check`,
  install: `${BASE_PATH}/install`,
  reinstall: `${BASE_PATH}/reinstall`,
  uninstall: `${BASE_PATH}/uninstall`,
  autoUpdateOn: `${BASE_PATH}/auto-update-on`,
  autoUpdateOff: `${BASE_PATH}/auto-update-off`,
})

/** Failure raised by a route call, carrying the host HTTP status. */
export class RouteError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.body = body
  }
}

const readJson = async (response) => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Build the route client.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - Fetch implementation (tests inject one).
 * @returns Route client used by the settings section.
 */
export function createApi({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')

  const request = async (method, path, body) => {
    const init = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    let response
    try {
      response = await fetchImpl(path, init)
    } catch (cause) {
      throw new RouteError(cause instanceof Error ? cause.message : String(cause), { status: 0 })
    }
    const payload = await readJson(response)
    if (!response.ok) {
      const message = typeof payload?.error === 'string' && payload.error ? payload.error : `HTTP ${response.status}`
      throw new RouteError(message, { status: response.status, body: payload })
    }
    if (payload === null || typeof payload !== 'object') {
      throw new RouteError('The host returned a non-JSON response', { status: response.status })
    }
    return payload
  }

  const confirmed = (path, extra = {}) => request('POST', path, { confirmed: true, ...extra })

  return {
    /** Current persisted state (normalized by the host adapter). */
    status: () => request('GET', PATHS.status),
    /**
     * The verified release manifest.
     *
     * The host exposes it at `/manifest`. A host that only returns it from a
     * manual check answers 404/405 there, so that one status falls back to a
     * single `check`; every other failure surfaces unchanged.
     */
    manifest: async () => {
      try {
        const payload = await request('GET', PATHS.manifest)
        if (payload.manifest && typeof payload.manifest === 'object') return payload.manifest
        if (payload.manifest !== null) throw new RouteError('The host returned no manifest', { status: 200, body: payload })
      } catch (cause) {
        if (!(cause instanceof RouteError) || (cause.status !== 404 && cause.status !== 405)) throw cause
        const checked = await request('POST', PATHS.check)
        if (checked.manifest && typeof checked.manifest === 'object') return checked.manifest
        throw new RouteError('The host does not expose the release manifest', { status: cause.status, body: checked })
      }
      await request('POST', PATHS.check)
      const refreshed = await request('GET', PATHS.manifest)
      if (refreshed.manifest && typeof refreshed.manifest === 'object') return refreshed.manifest
      throw new RouteError('The host returned no manifest after checking', { status: 200, body: refreshed })
    },
    /** Manual check: reports an available version; it never installs. */
    check: () => request('POST', PATHS.check),
    /** Download, verify, stage and activate. Requires explicit confirmation. */
    install: ({ runtimeId } = {}) => confirmed(PATHS.install, runtimeId ? { runtimeId } : {}),
    reinstall: () => confirmed(PATHS.reinstall),
    uninstall: () => confirmed(PATHS.uninstall),
    setAutoUpdate: (enabled) => confirmed(enabled ? PATHS.autoUpdateOn : PATHS.autoUpdateOff),
  }
}
