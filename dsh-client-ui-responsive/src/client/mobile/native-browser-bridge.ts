/** Trusted Android browser commands; no model execution or page-JavaScript surface. */
import type {} from '../android-bridge.ts'

/** The complete narrow command vocabulary implemented by the Android shell. */
export type NativeBrowserAction = 'open' | 'back' | 'forward' | 'reload' | 'select' | 'close' | 'status' | 'tabs'

/** One native tab; its id belongs to the named Session, not to global focus. */
export interface NativeBrowserTab {
  readonly tabId: string
  readonly uiTabId: string | undefined
  readonly url: string
  readonly title: string
  readonly pageGeneration: number
  readonly loadState: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly identityId: string
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly profileAvailable: boolean
  /** 隔离手段是否可用；与「浏览器能不能用」是两个独立事实。 */
  readonly isolationAvailable: boolean
  readonly profileReason: string
  readonly reason: string
}

/** Validated native authority; an unavailable result must never remove layout records. */
export interface NativeBrowserSnapshot {
  readonly ok: boolean
  readonly available: boolean
  readonly session: string
  readonly reason: string
  readonly profileAvailable: boolean
  /** 隔离手段是否可用；缺省时从 profileAvailable 兼容推导。 */
  readonly isolationAvailable: boolean
  readonly profileReason: string
  readonly tabs: readonly NativeBrowserTab[]
  readonly authoritativeTabs: boolean
  readonly tabId: string | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown, limit = 2048): string | undefined {
  return typeof value === 'string' && value.length <= limit ? value : undefined
}
function identity(value: unknown): string | undefined {
  const parsed = text(value, 256)
  return parsed !== undefined && parsed !== '' ? parsed : undefined
}
function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** @param session - requesting Session. @param reason - wire refusal. @returns explicit unavailable state. */
export function unavailableNativeBrowser(session: string, reason: string): NativeBrowserSnapshot {
  return { ok: false, available: false, session, reason, profileAvailable: false, isolationAvailable: false,
    profileReason: reason, tabs: [], authoritativeTabs: false, tabId: undefined }
}

/**
 * Decode shell JSON, rejecting malformed ids, duplicate tabs and foreign Sessions.
 * @param raw - synchronous shell reply.
 * @param session - Session captured by the caller before the operation.
 * @returns validated native state, or an explicit unavailable reason.
 */
export function parseNativeBrowserSnapshot(raw: string | undefined, session: string): NativeBrowserSnapshot {
  if (raw === undefined || raw === '') return unavailableNativeBrowser(session, 'browser-command-unavailable')
  if (raw.length > 4 * 1024 * 1024) return unavailableNativeBrowser(session, 'browser-reply-too-large')
  let decoded: unknown
  try { decoded = JSON.parse(raw) } catch (_invalidJson) { return unavailableNativeBrowser(session, 'browser-reply-invalid-json') }
  const value = record(decoded)
  if (value === undefined) return unavailableNativeBrowser(session, 'browser-reply-invalid')
  const owner = text(value.session) ?? text(value.ownerSessionId)
  if (owner !== session) return unavailableNativeBrowser(session, 'browser-reply-session-mismatch')
  const profile = record(value.profile)
  const explicitProfile = typeof value.profileAvailable === 'boolean' ? value.profileAvailable
    : typeof profile?.available === 'boolean' ? profile.available : undefined
  const profileAvailable = explicitProfile === true
  // 新壳显式上报；旧壳没有该字段时退回 profileAvailable（保持旧行为，不虚报隔离可用）。
  const isolationAvailable = typeof value.isolationAvailable === 'boolean' ? value.isolationAvailable : profileAvailable
  const profileReason = text(value.profileReason) ?? text(profile?.reason)
    ?? (profileAvailable ? '' : explicitProfile === false ? 'browser-profile-unavailable' : 'browser-profile-state-missing')
  const reason = text(value.reason) || (value.ok === true && value.available === true ? '' : 'browser-unavailable')
  const tabId = identity(value.tabId)
  const rawTabs = Array.isArray(value.tabs) ? value.tabs : tabId === undefined ? [] : [value]
  if (rawTabs.length > 256) return unavailableNativeBrowser(session, 'browser-reply-too-many-tabs')
  const tabs: NativeBrowserTab[] = []
  const ids = new Set<string>()
  const uiIds = new Set<string>()
  for (const item of rawTabs) {
    const tab = record(item)
    const id = identity(tab?.tabId)
    if (tab === undefined || id === undefined || ids.has(id)) return unavailableNativeBrowser(session, 'browser-reply-invalid-tab')
    const tabOwner = text(tab.session) ?? text(tab.ownerSessionId)
    if (tabOwner !== undefined && tabOwner !== session) return unavailableNativeBrowser(session, 'browser-reply-session-mismatch')
    const uiTabId = identity(tab.uiTabId)
    if (uiTabId !== undefined && uiIds.has(uiTabId)) return unavailableNativeBrowser(session, 'browser-reply-duplicate-ui-tab')
    if (tab.uiTabId !== undefined && tab.uiTabId !== null && uiTabId === undefined) return unavailableNativeBrowser(session, 'browser-reply-invalid-tab')
    const url = text(tab.url, 16 * 1024)
    const title = text(tab.title, 1024)
    if (url === undefined || title === undefined) return unavailableNativeBrowser(session, 'browser-reply-invalid-tab')
    const tabProfile = record(tab.profile)
    const explicitProfile = typeof tab.profileAvailable === 'boolean' ? tab.profileAvailable
      : typeof tabProfile?.available === 'boolean' ? tabProfile.available : profileAvailable
    const tabIsolation = typeof tab.isolationAvailable === 'boolean' ? tab.isolationAvailable : isolationAvailable
    tabs.push({ tabId: id, uiTabId, url, title, pageGeneration: nonnegative(tab.pageGeneration),
      loadState: text(tab.loadState, 128) ?? 'unknown', canGoBack: tab.canGoBack === true, canGoForward: tab.canGoForward === true,
      identityId: text(tab.identityId, 256) ?? '', viewportWidth: nonnegative(tab.viewportWidth),
      viewportHeight: nonnegative(tab.viewportHeight), profileAvailable: explicitProfile,
      isolationAvailable: tabIsolation,
      profileReason: text(tab.profileReason) ?? text(tabProfile?.reason) ?? profileReason, reason: text(tab.reason) ?? '' })
    ids.add(id)
    if (uiTabId !== undefined) uiIds.add(uiTabId)
  }
  return { ok: value.ok === true, available: value.available === true, session, reason,
    profileAvailable, isolationAvailable, profileReason, tabs, authoritativeTabs: Array.isArray(value.tabs), tabId }
}

/**
 * Execute only the declared trusted command with captured Session and occurrence ids.
 * @param session - owning Session.
 * @param action - narrow operation.
 * @param options - native/GUI ids and optional validated address.
 * @returns decoded reply; bridge failures are unavailable state, not optimistic UI success.
 */
export function nativeBrowserCommand(session: string, action: NativeBrowserAction,
  options: { readonly tabId?: string; readonly uiTabId?: string; readonly url?: string } = {}): NativeBrowserSnapshot {
  if (session === '') return unavailableNativeBrowser(session, 'browser-session-missing')
  try {
    const raw = window.androidBridge?.browserHostCommand?.(JSON.stringify({ action, session, ...options }))
    return parseNativeBrowserSnapshot(raw, session)
  } catch (_bridgeFailure) { return unavailableNativeBrowser(session, 'browser-command-failed') }
}
