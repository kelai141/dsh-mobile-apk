import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolveVersionSuffix } from './resolve-version-suffix.mjs'

const candidates = [new URL('../app/build.gradle.kts', import.meta.url), new URL('../dsh-mobile-apk/app/build.gradle.kts', import.meta.url)]
const gradlePath = candidates.find((candidate) => existsSync(candidate))
assert.ok(gradlePath, 'app/build.gradle.kts must exist in the APK tree')
const gradle = readFileSync(gradlePath, 'utf8')
const BASE = gradle.match(/versionName\s*=\s*"([^"]+)"\s*\+\s*snapshotSuffix/)?.[1]
assert.ok(BASE, 'Gradle must declare a base version plus snapshotSuffix')

test('defaults to the Gradle version with no suffix', () => {
  assert.deepEqual(resolveVersionSuffix(BASE), { version: BASE, suffix: '' })
  assert.deepEqual(resolveVersionSuffix(BASE, BASE), { version: BASE, suffix: '' })
})

test('derives a suffix from an explicit full version label', () => {
  assert.deepEqual(resolveVersionSuffix(BASE, `${BASE}-preview`), { version: `${BASE}-preview`, suffix: '-preview' })
})

test('applies an explicit suffix without duplicating the base version', () => {
  assert.deepEqual(resolveVersionSuffix(BASE, '', '-source'), { version: `${BASE}-source`, suffix: '-source' })
  assert.deepEqual(resolveVersionSuffix(BASE, BASE, '-source'), { version: `${BASE}-source`, suffix: '-source' })
  assert.deepEqual(resolveVersionSuffix(BASE, `${BASE}-source`, '-source'), { version: `${BASE}-source`, suffix: '-source' })
})

test('rejects a requested version that disagrees with the Gradle authority', () => {
  assert.throws(() => resolveVersionSuffix(BASE, '0.14.6'), /must equal Gradle base/)
  assert.throws(() => resolveVersionSuffix(BASE, '0.14.5-other', '-source'), /does not equal base/)
})

test('rejects malformed suffixes and malformed Gradle versions', () => {
  assert.throws(() => resolveVersionSuffix(BASE, '', 'source'), /must start with/)
  assert.throws(() => resolveVersionSuffix(BASE, '', '-bad/path'), /must start with/)
  assert.throws(() => resolveVersionSuffix('0.14'), /invalid Gradle base/)
})

test('release script treats Version as the final name and passes only its derived suffix to the shared build engine', () => {
  const script = readFileSync(new URL('./build-release.ps1', import.meta.url), 'utf8')
  const engine = readFileSync(new URL('./build-apk-engine.mjs', import.meta.url), 'utf8')
  assert.match(script, /resolve-version-suffix\.mjs/)
  assert.match(script, /"--suffix",\s*\$VersionSuffix/)
  assert.doesNotMatch(script, /-PversionNameSuffix=/)
  assert.match(engine, /`-PversionNameSuffix=\$\{suffix\}`/)
})

test('the app Gradle file owns a valid base version and positive versionCode', () => {
  assert.ok(Number(gradle.match(/versionCode\s*=\s*(\d+)/)?.[1]) > 0)
  assert.deepEqual(resolveVersionSuffix(BASE), { version: BASE, suffix: '' })
})
