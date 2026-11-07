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
  // 反例版本必须与 Gradle 权威版本**恒不相同**：曾经硬编码 '0.14.6'，而当 Gradle base 抬到 0.14.6 后
  // 该字符串恰好等于 BASE，断言变成「期望抛错却相等通过」——门禁正确地拦下了这次失效。
  // 用 9.9.9（任何真实版本号都不可能等于它）保持判据不变且不随版本抬升而失效。
  assert.throws(() => resolveVersionSuffix(BASE, '9.9.9'), /must equal Gradle base/)
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
  const declared = gradle.match(/^\s*versionCode\s*=\s*(\d+)\s*$/m)?.[1]
    ?? gradle.match(/^\s*versionCode\s*=\s*providers\.gradleProperty\("versionCode"\)\.getOrElse\("(\d+)"\)\.toInt\(\)\s*$/m)?.[1]
  assert.ok(Number(declared) > 0, 'Gradle must declare a positive literal versionCode or positive fallback')
  assert.deepEqual(resolveVersionSuffix(BASE), { version: BASE, suffix: '' })
})
