import { MANIFEST_NAME, parseGithubUrl } from './manifest.js'
import { createHash } from 'node:crypto'

const REDIRECT_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

function assertResponse(response, requestedUrl) {
  if (!response || typeof response.ok !== 'boolean' || !response.ok) throw new Error(`GitHub request failed${response?.status ? ` (${response.status})` : ''}`)
  const finalUrl = new URL(response.url || requestedUrl)
  if (finalUrl.protocol !== 'https:' || !['github.com', 'api.github.com', ...REDIRECT_HOSTS].includes(finalUrl.hostname)) {
    throw new Error('GitHub request redirected outside HTTPS GitHub release hosts')
  }
}

async function readManifest(response, assetMetadata, requestedUrl) {
  assertResponse(response, requestedUrl)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (assetMetadata?.size !== undefined && bytes.length !== assetMetadata.size) throw new Error('Release manifest size does not match GitHub release metadata')
  if (typeof assetMetadata?.digest === 'string' && assetMetadata.digest.startsWith('sha256:')) {
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== assetMetadata.digest.slice('sha256:'.length)) throw new Error('Release manifest SHA-256 does not match GitHub release metadata')
  }
  return JSON.parse(bytes.toString('utf8'))
}

export async function fetchLatestManifest(releaseUrl, fetchImpl) {
  const parsed = parseGithubUrl(releaseUrl, { allowApi: true })
  if (parsed.search || parsed.hash) throw new TypeError('Release URL must not contain a query or fragment')
  let apiUrl
  if (parsed.hostname === 'api.github.com') {
    if (!/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(parsed.pathname)) throw new TypeError('Expected /repos/{owner}/{repo}/releases/latest')
    apiUrl = parsed.href
  } else {
    const match = /^\/([^/]+)\/([^/]+)\/(?:releases\/latest)?$/.exec(parsed.pathname.replace(/\/$/, ''))
    if (!match) throw new TypeError('releaseUrl must identify a GitHub repository or its latest-release page')
    apiUrl = `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`
  }
  const releaseResponse = await fetchImpl(apiUrl, {
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
  })
  assertResponse(releaseResponse, apiUrl)
  const release = await releaseResponse.json()
  if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) throw new TypeError('Invalid GitHub latest-release response')
  const metadata = release.assets.find((asset) => asset?.name === MANIFEST_NAME)
  if (!metadata || typeof metadata.browser_download_url !== 'string') throw new Error('Latest release does not contain linux-release.json')
  const assetUrl = parseGithubUrl(metadata.browser_download_url)
  const expectedPath = `/releases/download/${encodeURIComponent(release.tag_name)}/${MANIFEST_NAME}`
  if (!assetUrl.pathname.endsWith(expectedPath) || assetUrl.search || assetUrl.hash) throw new TypeError('Latest release manifest URL is not version-pinned')
  const manifestResponse = await fetchImpl(assetUrl.href, { redirect: 'follow', headers: { Accept: 'application/octet-stream' } })
  const manifest = await readManifest(manifestResponse, metadata, assetUrl.href)
  return { manifest, releaseTag: release.tag_name }
}
