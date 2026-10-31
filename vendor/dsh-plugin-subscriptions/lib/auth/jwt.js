/** Minimal JWT payload decoding for claims extraction (no signature verification). */
/**
 * Decode a JWT payload without verifying the signature. Used only to read
 * account claims from `id_token`s issued over the provider's own TLS channel
 * during a code exchange we initiated — never to authorize anything.
 * @param token - the compact JWT string.
 * @returns the parsed payload object, or `undefined` when the token is not a
 *   well-formed JWT with a JSON object payload.
 */
export function decodeJwtPayload(token) {
    const parts = token.split('.');
    if (parts.length < 2)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    }
    catch {
        // Malformed base64url or non-JSON payload: the token is unusable for claims.
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return undefined;
    return parsed;
}
