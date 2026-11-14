/**
 * dsh-android-bridge: shared browser adapter and session event bridge.
 *
 * The old phone-control authority is retired from this entry point. This module
 * provides only the native shared browser face and the existing notification,
 * task-done, and live-event channels. Device operations live in the separate
 * phone-control plugin and reach the native host through NativeClient.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createNativeClient } from './native-client.js'
import { createNativeSharedBridge, type NativeSharedBridge } from './native-shared-bridge.js'
import { installSharedNotifications, shellControlToken } from './shared-notifications.js'

export const name = 'dsh-android-bridge'
export const inject = ['sandboxPolicy', 'sessions'] as const

export {
  createNativeSharedBridge,
  NATIVE_SHARED_BROWSER_OPS,
} from './native-shared-bridge.js'
export type {
  NativeSharedAuth,
  NativeSharedBridge,
  NativeSharedBridgeOptions,
  NativeSharedBridgeStatus,
  NativeSharedControlResult,
  NativeSharedBrowserOp,
} from './native-shared-bridge.js'
export {
  APPEND_BATCH_WINDOW_MS,
  createAppendBatcher,
  createFileAppendix,
  flushPendingAppends,
  installSharedNotifications,
  parseAdbPrefsXml,
  shellControlToken,
} from './shared-notifications.js'
export type { AppendBatcher, ShellAdbPrefs, SharedNotificationBridge } from './shared-notifications.js'
export {
  CONTROL_TOKEN_HEADER,
  FALLBACK_LOOPBACK_HOSTS,
  authorizeMobileRoute,
  authorizePublicReadOnlyRoute,
  controlTokenFrom,
  enginePortFromEnv,
  loopbackAuthorities,
  sendMobileRouteRejection,
  tokenMatches,
} from './route-auth.js'
export type {
  ConnectionRouteAuth,
  MobileRouteAuthOptions,
  MobileRouteRejection,
  MobileRouteRequest,
  MobileRouteResponse,
} from './route-auth.js'
export { toLosslessJson, findUndefinedPaths } from './lossless-json.js'
export type { LosslessJson } from './lossless-json.js'
export {
  SessionNotifyState,
  TURN_END_KINDS,
  boundReportBody,
  formatDuration,
  reportOutcomeLabel,
  sessionTag,
  shouldPopupReport,
  summarize,
  todoProgress,
  turnEndKind,
  turnEndOk,
  visibleText,
} from './notify-projection.js'
export type { ReportEntry, TodoProgress, TurnEndKind, TurnEndKindOrUnknown } from './notify-projection.js'

/** Path expected by the Kotlin host for the private native socket. */
export const NATIVE_CONTROL_SOCKET = '.native-control/control-v1.sock'

/**
 * Resolve the application-private native endpoint from DSH_FILES_DIR.
 * @param filesDir - The shell's files directory.
 * @returns Absolute socket path, or undefined when the directory is unavailable.
 */
export function nativeControlEndpoint(filesDir: unknown): string | undefined {
  if (typeof filesDir !== 'string' || filesDir.length === 0 || filesDir.includes('\\')) return undefined
  if (!filesDir.startsWith('/') || filesDir.trim() !== filesDir) return undefined
  return filesDir.replace(/\/+$/u, '') + '/' + NATIVE_CONTROL_SOCKET
}

export function apply(ctx: Context, _config: Record<string, unknown> = {}): void {
  const endpoint = nativeControlEndpoint(process.env.DSH_FILES_DIR)
  const shared = createNativeSharedBridge(ctx, endpoint === undefined
    ? {}
    : { client: createNativeClient({ endpoint }) })
  const bridged: NativeSharedBridge = shared
  try {
    ctx.provide('androidPrivilege', bridged)
  } catch {
    ctx.logger?.('dsh-android-bridge')?.debug?.('androidPrivilege already provided')
  }
  try {
    ctx.provide('nativeSharedBridge', bridged)
  } catch {
    ctx.logger?.('dsh-android-bridge')?.debug?.('nativeSharedBridge already provided')
  }
  const notifications = installSharedNotifications(ctx, {
    logger: ctx.logger?.('dsh-android-bridge'),
  })
  ctx.effect?.(() => () => notifications.dispose())
  // The token reader remains on the shared route-auth surface for file-open.
  void shellControlToken
}
