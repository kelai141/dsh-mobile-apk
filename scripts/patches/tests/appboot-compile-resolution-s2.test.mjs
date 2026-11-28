import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { hasAppbootCompileResolution, patchAppbootCompileResolution } from '../data/appboot-compile-resolution-S2.mjs'
import { patchProfileLinkSkip } from '../data/profile-link-skip-PL1.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const source = readFileSync(versionedFixture('dsh-app-boot', 'lib', 'index.js'), 'utf8')
const patched = patchAppbootCompileResolution(source)

test('S2 rejects missing and duplicate anchors and partially applied edits', () => {
  const anchors = ['const canonical = canonicalPath(path) + sep;', 'realDir: canonicalPath(entry.packageDir)']
  assert.equal(hasAppbootCompileResolution(source), false)
  assert.equal(hasAppbootCompileResolution(patched), true)
  assert.equal(patchAppbootCompileResolution(patched), patched)
  for (const anchor of anchors) {
    assert.ok(source.includes(anchor), anchor)
    assert.throws(() => patchAppbootCompileResolution(source.replace(anchor, '')), /anchor mismatch/)
  }
  assert.throws(() => patchAppbootCompileResolution(source + '\nfunction compileResolution(resolution) {}'), /one prefixes and one compileResolution/)
  assert.throws(() => patchAppbootCompileResolution(source + '\nfunction prefixes(path) {}'), /one prefixes and one compileResolution/)
  assert.throws(() => patchAppbootCompileResolution(patched.replace('canonicalPaths.set(path, canonical);', '')), /partial marker/)
})

test('S2 composes with PL1 in either order', () => {
  assert.equal(patchAppbootCompileResolution(patchProfileLinkSkip(source)), patchProfileLinkSkip(patched))
})

function loadCompile(text) {
  const start = text.indexOf('function canonicalPath(path) {')
  const compile = text.indexOf('function compileResolution(resolution) {', start)
  const end = text.indexOf('\n}\n/**', compile)
  assert.ok(start >= 0 && compile > start && end > compile)
  const load = new Function('realpathSync', 'resolve', 'sep', text.slice(start, end + 2) + '\nreturn { compileResolution, prefixes }')
  let count = 0
  const api = load((path) => {
    count += 1
    return realpathSync(path)
  }, resolve, sep)
  return { ...api, count: () => count }
}

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'appboot-compile-resolution-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('S2 preserves the full result and eliminates 760 repeated realpathSync calls', (t) => {
  const upstream = loadCompile(source)
  const optimized = loadCompile(patched)
  const profilesDir = directory(t)
  const entries = Array.from({ length: 760 }, (_, index) => {
    const name = 'package-' + index
    const packageDir = join(profilesDir, name)
    mkdirSync(packageDir)
    return { name, packageDir, scope: 'installation' }
  })
  const resolution = { entries, profilesDir, linkedRoots: [], localPackageNames: ['local'] }
  assert.deepEqual(optimized.compileResolution(resolution), upstream.compileResolution(resolution))
  assert.equal(upstream.count(), 1521)
  assert.equal(optimized.count(), 761)
  t.diagnostic('realpathSync: ' + upstream.count() + ' -> ' + optimized.count() + ' (760 fewer)')
})

test('S2 preserves configured and canonical prefix order and observes filesystem changes on the next call', (t) => {
  const upstream = loadCompile(source)
  const optimized = loadCompile(patched)
  const profilesDir = directory(t)
  const target = join(profilesDir, 'target')
  const alias = join(profilesDir, 'alias')
  mkdirSync(target)
  symlinkSync(target, alias, 'junction')
  const missing = join(profilesDir, 'missing')
  const resolution = {
    entries: [
      { name: 'linked-installation', packageDir: alias, scope: 'installation' },
      { name: 'local', packageDir: alias, scope: 'profile' },
      { name: 'missing', packageDir: missing, scope: 'installation' },
    ],
    profilesDir,
    profileDir: alias,
    linkedRoots: [{ realPath: alias }, { realPath: missing }, { realPath: alias }],
    localPackageNames: ['local'],
  }
  const first = optimized.compileResolution(resolution)
  assert.deepEqual(first, upstream.compileResolution(resolution))
  assert.equal(optimized.count(), 3, 'one lookup per input path, including the missing path')
  assert.deepEqual(first.profile, [resolve(alias) + sep, realpathSync(target) + sep])
  assert.deepEqual(optimized.prefixes(alias), upstream.prefixes(alias), 'prefixes also accepts its original one-argument form')
  const secondTarget = join(profilesDir, 'target-2')
  mkdirSync(secondTarget)
  rmSync(alias)
  symlinkSync(secondTarget, alias, 'junction')
  const second = optimized.compileResolution(resolution)
  assert.deepEqual(second, upstream.compileResolution(resolution))
  assert.equal(optimized.count(), 7, 'the next compile performs its own three lookups')
  assert.equal(second.entries.get('linked-installation').realDir, realpathSync(secondTarget))
})
