import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleApk, parseArgs, verifyApks } from './build-apk-engine.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-engine-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const apkDir = join(root, 'apk')
  const outputDir = join(root, 'out')
  const snapshot = join(root, 'snapshot.tar.xz')
  mkdirSync(apkDir, { recursive: true })
  writeFileSync(snapshot, Buffer.from('test-snapshot-bytes'))
  return { root, apkDir, outputDir, snapshot }
}

test('shared terminal engine installs snapshot and fingerprint, builds, then copies the caller-named artifact', (t) => {
  const f = fixture(t)
  const oldIntermediates = join(f.apkDir, 'app', 'build', 'intermediates', 'assets', 'stale')
  const oldOutput = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'stale.apk')
  mkdirSync(join(oldIntermediates, '..'), { recursive: true })
  mkdirSync(join(oldOutput, '..'), { recursive: true })
  writeFileSync(oldIntermediates, 'stale')
  writeFileSync(oldOutput, 'stale')
  const calls = []
  const runner = (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) {
      const out = args[args.indexOf('--out') + 1]
      writeFileSync(out, JSON.stringify({ schema: 1, complete: true, fingerprint: 'fixture', entries: [{ id: 'factory', name: 'factory-plugin' }] }))
      return { status: 0 }
    }
    assert.equal(command, process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
    assert.deepEqual(args, [':app:assembleDebug', '--no-daemon', '-PversionNameSuffix=-preview'])
    const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    mkdirSync(join(built, '..'), { recursive: true })
    writeFileSync(built, Buffer.from('signed-test-apk'))
    return { status: 0 }
  }

  const result = assembleApk({
    snapshot: f.snapshot,
    apkDir: f.apkDir,
    outputDir: f.outputDir,
    artifactName: 'custom-name-x86_64.apk',
    suffix: '-preview',
    clean: true,
    fingerprintGate: '/tools/check-snapshot-fingerprint.mjs',
    log() {},
  }, runner)

  assert.equal(result, join(f.outputDir, 'custom-name-x86_64.apk'))
  assert.equal(readFileSync(join(f.apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz')).toString(), 'test-snapshot-bytes')
  assert.equal(readFileSync(join(f.apkDir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), 'utf8'),
    createHash('sha256').update(readFileSync(f.snapshot)).digest('hex'))
  assert.equal(readFileSync(result).toString(), 'signed-test-apk')
  assert.ok(existsSync(join(f.apkDir, 'app', 'src', 'main', 'assets', 'plugin-hard-manifest.json')))
  assert.equal(existsSync(oldIntermediates), false)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].args[0].endsWith('build-hard-manifest.mjs'), true)
  assert.equal(calls[0].args[calls[0].args.indexOf('--snapshot') + 1], resolve(f.snapshot))
  assert.equal(calls[0].args[calls[0].args.indexOf('--out') + 1], join(f.apkDir, 'app', 'src', 'main', 'assets', 'plugin-hard-manifest.json'))
  assert.equal(calls[0].options.cwd, resolve(fileURLToPath(new URL('.', import.meta.url))))
  assert.equal(calls[0].options.shell, false, 'Node build hooks execute directly on Windows')
  assert.deepEqual(calls[1].args.slice(-1), ['--require'])
  assert.equal(calls[1].options.cwd, resolve(fileURLToPath(new URL('.', import.meta.url))))
  assert.equal(calls[1].options.shell, false)
  assert.equal(calls[2].options.cwd, resolve(f.apkDir))
  assert.equal(calls[2].options.shell, process.platform === 'win32')
})

test('fingerprint rejection stops before Gradle and a Gradle failure does not copy an artifact', (t) => {
  const f = fixture(t)
  let gradleCalls = 0
  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'failed.apk', fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => {
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 1 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
    gradleCalls += 1
    return { status: 0 }
  }), /failed \(1\)/)
  assert.equal(gradleCalls, 0)

  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'failed.apk', fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => args[0]?.endsWith('check-snapshot-fingerprint.mjs') ? { status: 0 }
    : args[0]?.endsWith('build-hard-manifest.mjs') ? { status: 0 } : { status: 7 }), /failed \(7\)/)
  assert.equal(existsSync(join(f.outputDir, 'failed.apk')), false)
})

test('release mode preserves existing intermediates when clean is not requested', (t) => {
  const f = fixture(t)
  const marker = join(f.apkDir, 'app', 'build', 'intermediates', 'assets', 'preserve-me')
  mkdirSync(join(marker, '..'), { recursive: true })
  writeFileSync(marker, 'existing')
  assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'release-arm64-v8a.apk', suffix: '', gradleCommand: 'custom-gradle', log() {},
  }, (command, args) => {
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
    assert.equal(command, 'custom-gradle')
    const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    mkdirSync(join(built, '..'), { recursive: true })
    writeFileSync(built, 'release-apk')
    return { status: 0 }
  })
  assert.equal(readFileSync(marker, 'utf8'), 'existing')
})

test('every assemble removes stale APK output before Gradle so a zero-work success cannot deliver it', (t) => {
  const f = fixture(t)
  const debugOutput = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'debug')
  mkdirSync(debugOutput, { recursive: true })
  writeFileSync(join(debugOutput, 'app-debug.apk'), 'stale-apk')
  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'fresh.apk', fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => args[0]?.endsWith('check-snapshot-fingerprint.mjs')
    ? { status: 0 }
    : { status: 0 }), /APK is missing/)
  assert.equal(existsSync(join(f.outputDir, 'fresh.apk')), false)
})

test('shared signature stage self-tests and verifies the caller-selected artifact scope', () => {
  const calls = []
  verifyApks({ directories: ['/release/apk'], signatureGate: '/tools/check-apk-signatures.mjs', keystore: '/release/debug.keystore', log() {} },
    (command, args, options) => { calls.push({ command, args, options }); return { status: 0 } })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, ['/tools/check-apk-signatures.mjs', '--self-test'])
  assert.deepEqual(calls[1].args, ['/tools/check-apk-signatures.mjs', '--dir', resolve('/release/apk'), '--keystore', resolve('/release/debug.keystore')])
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].options.shell, false, 'signature gate must use Node directly on Windows')
  assert.equal(calls[1].options.shell, false, 'signature gate must use Node directly on Windows')
})

test('verify --skip-self-test is parsed as a boolean and skips the second self-test', () => {
  const options = parseArgs(['verify', '--dir', '/release/apk', '--skip-self-test'])
  assert.equal(options.skipSelfTest, true)
  const calls = []
  verifyApks({ directories: [options.dir], selfTest: !options.skipSelfTest, log() {} },
    (command, args) => { calls.push(args); return { status: 0 } })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
    '--dir', resolve('/release/apk'), '--keystore',
    fileURLToPath(new URL('../keystore/debug.keystore', import.meta.url)),
  ])
  assert.equal(calls[0].includes('--self-test'), false)
})

test('local, portable, and release entry points all route their terminal stage through the shared engine', () => {
  const local = readFileSync(new URL('./build-apk-013.ps1', import.meta.url), 'utf8')
  const portable = readFileSync(new URL('./build-apk.mjs', import.meta.url), 'utf8')
  const release = readFileSync(new URL('./build-release.ps1', import.meta.url), 'utf8')
  const localArgsBlock = local.match(/\$engineArgs = @\([\s\S]*?\n\s*\)/)?.[0] ?? ''
  const releaseArgsBlock = release.match(/\$engineArgs = @\([\s\S]*?\n\s*\)/)?.[0] ?? ''
  assert.match(local, /build-apk-engine\.mjs[\s\S]*?"assemble"/)
  assert.match(local, /if \(-not \[string\]::IsNullOrEmpty\(\$Suffix\)\) \{ \$engineArgs \+= @\("--suffix", \$Suffix\) \}/)
  assert.doesNotMatch(localArgsBlock, /"--suffix", \$Suffix/)
  assert.match(local, /Get-ChildItem \$Out -Filter '\*\.apk' -File -Recurse \| Remove-Item -Force/)
  assert.match(local, /build-apk-engine\.mjs"\) verify --dir \$Out/)
  assert.match(portable, /import \{ assembleApk, verifyApks \} from '\.\/build-apk-engine\.mjs'/)
  assert.match(portable, /const finalApk = assembleApk\(/)
  assert.match(release, /build-apk-engine\.mjs[\s\S]*?"assemble"/)
  assert.match(release, /if \(-not \[string\]::IsNullOrEmpty\(\$VersionSuffix\)\) \{ \$engineArgs \+= @\("--suffix", \$VersionSuffix\) \}/)
  assert.doesNotMatch(releaseArgsBlock, /"--suffix", \$VersionSuffix/)
  assert.match(release, /Get-ChildItem \$apkDir -Filter '\*\.apk' -File -Recurse \| Remove-Item -Force/)
  assert.match(release, /build-apk-engine\.mjs"\) verify --dir \$apkDir/)
  assert.match(release, /--artifact-name[\s\S]*?dsh-mobile-apk-v[\s\S]*?\$abi\.n/)
  assert.doesNotMatch(release, /Copy-Item\s+\$abi\.f\s+\$assets/)
  assert.match(release, /"--snapshot", \$abi\.f/)
})

test('portable inject-all uses the host Python command just like the snapshot builder', () => {
  const portable = readFileSync(new URL('./build-apk.mjs', import.meta.url), 'utf8')
  assert.match(portable, /const PYTHON = process\.platform === 'win32' \? 'python' : 'python3'/)
  assert.match(portable, /run\(PYTHON,\s*\[\s*join\(ROOT, 'scripts', 'inject-all\.py'/)
  assert.doesNotMatch(portable, /run\('python',\s*\[\s*join\(ROOT, 'scripts', 'inject-all\.py'/)
})
