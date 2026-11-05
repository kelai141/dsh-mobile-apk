import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { OFFICIAL_PI_PATCH_SHA256 } from './patches/pi-upstream-streaming-020.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const patch = 'scripts/patches/upstream/pi-ai-1.1.0.patch'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('the official streaming patch retains its registered bytes', () => {
  assert.equal(sha256(readFileSync(join(root, patch))), OFFICIAL_PI_PATCH_SHA256)
})

test('checkout filtering with autocrlf enabled preserves the official patch digest', () => {
  const bytes = execFileSync('git', ['-c', 'core.autocrlf=true', 'cat-file', '--filters', 'HEAD:' + patch],
    { cwd: root })
  assert.equal(sha256(bytes), OFFICIAL_PI_PATCH_SHA256)
})

const filtered = path => execFileSync('git', ['-c', 'core.autocrlf=true', 'cat-file', '--filters', 'HEAD:' + path],
  { cwd: root, maxBuffer: 32 * 1024 * 1024 })
const captured = JSON.parse(readFileSync(join(root, 'scripts/patches/tests/fixtures/manifest.json'), 'utf8'))

test('registered Android SDK license texts retain their digests through checkout filtering', () => {
  const matrix = JSON.parse(readFileSync(join(root, 'scripts/third-party-licenses.json'), 'utf8'))
  for (const component of matrix.androidComponents) {
    const path = 'LICENSES/' + component.licenseText
    assert.equal(sha256(readFileSync(join(root, path))), component.licenseSha256, path)
    assert.equal(sha256(filtered(path)), component.licenseSha256, 'autocrlf checkout: ' + path)
  }
})

test('the verbatim browser stylesheet retains its upstream identity through checkout filtering', () => {
  const directory = 'dsh-client-ui-responsive/src/client/mobile/upstream-browser/'
  const source = JSON.parse(readFileSync(join(root, directory, 'SOURCE.json'), 'utf8'))
  const expected = source.files.find(file => file.source.endsWith('/view/Browser.module.css')).sha256
  const path = directory + 'view/Browser.module.css'
  assert.equal(sha256(readFileSync(join(root, path))), expected, path)
  assert.equal(sha256(filtered(path)), expected, 'autocrlf checkout: ' + path)
})

test('screen-scope fixture copies retain canonical bytes through checkout filtering', () => {
  const source = readFileSync(join(root, 'plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json'), 'utf8')
  const canonical = Buffer.from(JSON.stringify(JSON.parse(source), null, 2) + '\n')
  for (const path of [
    'plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json',
    'app/src/test/resources/screen-scope/screen-scope-cases.json',
  ]) {
    const expected = sha256(path.startsWith('app/') ? canonical :
      execFileSync('git', ['show', 'HEAD:' + path], { cwd: root }))
    assert.equal(sha256(readFileSync(join(root, path))), expected, path)
    assert.equal(sha256(filtered(path)), expected, 'autocrlf checkout: ' + path)
  }
})

test('captured build input manifests retain their declared identities', () => {
  for (const [path, expected] of [
    ['scripts/patches/registry.json', captured.capture.registrySha256],
    ['scripts/snapshot-config/engine-overlay.json', captured.capture.overlaySha256],
  ]) {
    assert.equal(sha256(readFileSync(join(root, path))), expected, path)
    assert.equal(sha256(filtered(path)), expected, 'autocrlf checkout: ' + path)
  }
})

test('captured fixture files retain their digests through checkout filtering', () => {
  for (const [directory, fixture] of Object.entries(captured.fixtures)) {
    for (const [file, expected] of Object.entries(fixture.fileSha256 ?? {})) {
      const path = 'scripts/patches/tests/fixtures/' + directory + '/' + file
      assert.equal(sha256(readFileSync(join(root, path))), expected, path)
      assert.equal(sha256(filtered(path)), expected, 'autocrlf checkout: ' + path)
    }
  }
})

test('build profiles and exact-context patch inputs retain canonical newline bytes', () => {
  for (const path of [
    'scripts/build-snapshot-013.mjs',
    'scripts/profile-web.cordis.patch.yml',
    'scripts/patches/tests/safe-mode-policy.test.mjs',
    'vendor/dsh-undo-savepoint/lib/core.mjs',
    'dsh-host-web-compat/lib/index.js',
  ]) {
    const canonical = execFileSync('git', ['show', 'HEAD:' + path], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
    assert.equal(sha256(readFileSync(join(root, path))), sha256(canonical), path)
    assert.equal(sha256(filtered(path)), sha256(canonical), 'autocrlf checkout: ' + path)
  }
})
