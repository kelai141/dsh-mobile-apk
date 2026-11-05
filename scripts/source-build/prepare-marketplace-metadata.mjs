#!/usr/bin/env node
// Restore only the contract-declared peer delta after extracting the verified published payload.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { readHarnessIdentity } from './harness-identity.mjs'

const [tarballArg, manifestArg, reportArg, mode = '--check'] = process.argv.slice(2)
if (!tarballArg || !manifestArg || !reportArg || !['--check', '--apply'].includes(mode) || process.argv.length > 6) {
  throw new Error('usage: node prepare-marketplace-metadata.mjs <published.tgz> <package.json> <report.json> [--check|--apply]')
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const { contract, commit, version } = readHarnessIdentity()
const deltas = (contract.runtimeCompat?.metadataDeltas ?? []).filter(delta => delta.pkg === 'dshmarketplace-plugin')
if (deltas.length !== 1) throw new Error('exactly one marketplace metadata delta is required')
const delta = deltas[0]
if (delta.targetSourceCommit !== commit || !String(delta.reason ?? '').trim()
  || delta.packageVersion !== '0.1.7'
  || delta.publishedTarball !== 'https://registry.npmjs.org/dshmarketplace-plugin/-/dshmarketplace-plugin-0.1.7.tgz'
  || delta.publishedTarballSha256 !== '881c21ec33a4a91ad65c61676540faab4122440e3f9685f69939533a6dbbc0c1') {
  throw new Error('marketplace metadata delta is not bound to the pinned published input and official target')
}
const tarball = readFileSync(resolve(tarballArg))
if (sha256(tarball) !== delta.publishedTarballSha256) throw new Error('marketplace published tarball SHA-256 mismatch')
const archive = gunzipSync(tarball)
let publishedBytes
for (let offset = 0; offset + 512 <= archive.length;) {
  const name = archive.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '')
  if (!name) break
  const prefix = archive.subarray(offset + 345, offset + 500).toString('utf8').replace(/\0.*$/, '')
  const full = prefix ? prefix + '/' + name : name
  const size = parseInt(archive.subarray(offset + 124, offset + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error('invalid published tar member size')
  if (full === 'package/package.json') {
    const type = archive[offset + 156]
    if (publishedBytes || (type !== 0 && type !== 48)) throw new Error('duplicate or non-file published package manifest')
    publishedBytes = archive.subarray(offset + 512, offset + 512 + size)
  }
  offset += 512 + Math.ceil(size / 512) * 512
}
if (!publishedBytes) throw new Error('published package manifest is missing')
const published = JSON.parse(publishedBytes.toString('utf8'))
if (published.name !== delta.pkg || published.version !== delta.packageVersion) throw new Error('published marketplace identity changed')
const fields = delta.fields ?? []
const expectedPeers = ['@deepseek-ai/dsh-native-command', '@deepseek-ai/dsh-tools']
if (fields.length !== expectedPeers.length || new Set(fields.map(field => field.name)).size !== fields.length
  || fields.some(field => field.section !== 'peerDependencies' || !expectedPeers.includes(field.name)
    || field.from !== '^0.1.0-rc.6' || field.to !== version)) {
  throw new Error('marketplace delta must change exactly the two registered DSH peers')
}
const expected = structuredClone(published)
for (const field of fields) {
  if (published[field.section]?.[field.name] !== field.from) throw new Error('published peer does not match delta.from: ' + field.name)
  expected[field.section][field.name] = field.to
}
const manifestPath = resolve(manifestArg)
const currentBytes = readFileSync(manifestPath)
const current = JSON.parse(currentBytes.toString('utf8'))
if (mode === '--check' ? !isDeepStrictEqual(current, expected)
  : !isDeepStrictEqual(current, published) && !isDeepStrictEqual(current, expected)) {
  throw new Error('marketplace manifest differs from the verified published manifest outside the exact declared peer delta')
}
if (mode === '--apply' && !isDeepStrictEqual(current, expected)) writeFileSync(manifestPath, JSON.stringify(expected, null, 2) + '\n')
const reportPath = resolve(reportArg)
const prior = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {}
const report = {
  package: delta.pkg, packageVersion: delta.packageVersion,
  targetSourceCommit: delta.targetSourceCommit,
  publishedTarball: delta.publishedTarball, publishedTarballSha256: sha256(tarball),
  publishedManifestSha256: sha256(publishedBytes), fields, reason: delta.reason,
  payloadChangedByMetadataGuard: false,
  ...(mode === '--check' ? {} : { mirrorBeforeExtractionSha256: prior.mirrorBeforeExtractionSha256 }),
  [mode === '--check' ? 'mirrorBeforeExtractionSha256' : 'adaptedManifestSha256']: sha256(readFileSync(manifestPath)),
  mode,
}
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log('marketplace metadata: verified published input; exact two-peer delta ' + mode)
