/**
 * Shared authorization facade for file-incoming exact routes.
 *
 * The bridge owns the canonical connection-first/token-fallback decision so non-default trusted
 * authorities retain upstream semantics. This module keeps the file-open package's local test and
 * import surface stable without copying the security logic.
 */
import {
  authorizeMobileRoute,
  sendMobileRouteRejection,
  CONTROL_TOKEN_HEADER,
  enginePortFromEnv,
  loopbackAuthorities,
  type ConnectionRouteAuth,
  type MobileRouteAuthOptions,
  type MobileRouteRejection,
  type MobileRouteRequest,
  type MobileRouteResponse,
} from '@dsh-android/dsh-android-bridge'

/** Loopback fallback authorities for the engine port selected for this request. */
export { enginePortFromEnv, loopbackAuthorities }

/** Shared Android control-token header. */
export { CONTROL_TOKEN_HEADER }

/** Node request view accepted by the canonical Android route authorizer. */
export type RouteRequestLike = MobileRouteRequest

/** Node response view used by the file-incoming route rejection writer. */
export type IncomingRes = MobileRouteResponse

/** Connection service trust/authentication view. */
export type ConnectionFace = ConnectionRouteAuth

/** Dynamic token/connection sources used for one incoming-route authorization. */
export type AuthOptions = MobileRouteAuthOptions

/** Rejection returned before a route reads its body or changes queue state. */
export type AuthResult = MobileRouteRejection

/**
 * Authorize an incoming-file route before queue inspection, body reading, or mutation.
 * @param request - Incoming HTTP request.
 * @param options - Live shell control token and optional browser connection service.
 * @returns `undefined` when authorized, otherwise the rejection to send.
 */
export const authorizeIncomingRoute = authorizeMobileRoute

/** Write the canonical no-store 401/403 rejection form. */
export const sendIncomingRouteRejection = sendMobileRouteRejection
