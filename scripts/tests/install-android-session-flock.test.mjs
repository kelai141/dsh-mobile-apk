import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { attachAndroidSessionFlock, installAndroidSessionFlock } from '../source-build/install-android-session-flock.mjs'

const scripts = resolve(import.meta.dirname, '..')

test('the snapshot loader resolves the package used by the installed session backend', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-android-flock-stage-'))
  try {
    const packages = join(root, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
    const backend = join(packages, 'dsh-session-persistence-jsonl/lib')
    mkdirSync(backend, { recursive: true })
    writeFileSync(join(backend, 'index.js'), '// importer\n')
    const addon = join(packages, 'node-addon-system')
    cpSync(join(scripts, 'patches/tests/fixtures/node-addon-system-0.2.2-rc.1'), addon, { recursive: true })
    const target = join(addon, 'lib/flock.js')
    const manifest = readFileSync(join(addon, 'package.json'))
    const original = readFileSync(target, 'utf8')
    assert.throws(() => installAndroidSessionFlock(root), /F3 anchor changed/)
    assert.equal(readFileSync(target, 'utf8'), original)
    execFileSync(process.execPath, [join(scripts, 'patches/apply-patches.mjs'), root,
      '--apply', '--scope', 'engine', '--only', 'flock-android-F3'])
    installAndroidSessionFlock(root)
    const withLoader = readFileSync(target, 'utf8')
    assert.match(withLoader, /process\.dlopen\(nativeModule, nativeFile\)/)
    assert.match(withLoader, /binding = \{ tryLock\(_fd, done\) \{ done\(0\); \} \}/)
    assert.ok(withLoader.indexOf('process.dlopen') < withLoader.indexOf('binding = { tryLock(_fd'))
    assert.equal(attachAndroidSessionFlock(withLoader), withLoader)
    assert.throws(() => attachAndroidSessionFlock(withLoader.replace('process.dlopen', 'void')), /patch is incomplete/)
    assert.deepEqual(readFileSync(join(addon, 'package.json')), manifest)
    installAndroidSessionFlock(root)
    assert.equal(readFileSync(target, 'utf8'), withLoader)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
