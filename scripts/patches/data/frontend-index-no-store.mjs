export const FRONTEND_INDEX_NO_STORE_MARKER = 'dsh-mobile frontend index no-store (C1)'

const HEADERS_ANCHOR = '\t\t\theaders = { "content-type": HTML_MIME };'
const HEADERS_REPLACEMENT = [
  '\t\t\theaders = {',
  '\t\t\t\t"content-type": HTML_MIME,',
  '\t\t\t\t/* ' + FRONTEND_INDEX_NO_STORE_MARKER + ' */',
  '\t\t\t\t"cache-control": "no-store, no-cache, must-revalidate",',
  '\t\t\t\tpragma: "no-cache"',
  '\t\t\t};',
].join('\n')

export function hasFrontendIndexNoStore(source) {
  return source.includes(FRONTEND_INDEX_NO_STORE_MARKER)
    && source.includes('"cache-control": "no-store, no-cache, must-revalidate"')
    && source.includes('pragma: "no-cache"')
}

/**
 * Ensures `dsh-host-frontend-static` serves index.html with explicit `no-store` headers
 * so enabling layered HTTP/V8 bytecode caching on modern WebViews never serves a stale HTML shell.
 */
export function patchFrontendIndexNoStore(source) {
  if (hasFrontendIndexNoStore(source)) return source
  if (source.includes(FRONTEND_INDEX_NO_STORE_MARKER)) {
    throw new Error('frontend-index-no-store: marker present but replacement incomplete')
  }
  const hits = source.split(HEADERS_ANCHOR).length - 1
  if (hits !== 1) {
    throw new Error('frontend-index-no-store: expected exactly 1 headers anchor, found ' + hits)
  }
  return source.replace(HEADERS_ANCHOR, HEADERS_REPLACEMENT)
}
