import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ELF_MACHINES,
  abiLibraryPath,
  abiManifestPath,
  buildPhoneControlNative,
  cargoBuildArgs,
  ensureTargets,
  hashCrateInputs,
  hashBuildInputs,
  loadBuildConfig,
  parseArgs,
  resolveNdk,
  runCli,
  selectToolchain,
  verifyElf,
  verifyExistingOutputs,
} from './build-phone-control-native.mjs'

/** Synthetic ELF64 shared object with the requested machine and PT_LOAD alignment. */
function elf({ machine = 183, align = 16384, type = 3, bits = 2, data = 1, dynamic = true } = {}) {
  const buffer = Buffer.alloc(512)
  buffer.write('\x7fELF', 0, 'binary')
  buffer[4] = bits
  buffer[5] = data
  buffer[6] = 1
  buffer.writeUInt16LE(type, 16)
  buffer.writeUInt16LE(machine, 18)
  buffer.writeUInt32LE(1, 20)
  buffer.writeBigUInt64LE(64n, 32)
  buffer.writeUInt16LE(64, 52)
  buffer.writeUInt16LE(56, 54)
  buffer.writeUInt16LE(dynamic ? 2 : 1, 56)
  buffer.writeUInt32LE(1, 64)
  buffer.writeBigUInt64LE(BigInt(align), 64 + 48)
  if (dynamic) buffer.writeUInt32LE(2, 64 + 56)
  return buffer
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-phone-control-native-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const apkDir = join(root, 'apk')
  const crateDir = join(apkDir, 'native', 'phone-control-core')
  mkdirSync(join(apkDir, 'scripts'), { recursive: true })
  writeFileSync(join(apkDir, 'scripts', 'build-phone-control-native.mjs'), readFileSync(new URL('./build-phone-control-native.mjs', import.meta.url)))
  mkdirSync(join(crateDir, 'src'), { recursive: true })
  mkdirSync(join(crateDir, 'tests'), { recursive: true })
  writeFileSync(join(crateDir, 'Cargo.toml'), '[package]\nname = "dsh-phone-control-core"\nversion = "0.1.0"\n')
  writeFileSync(join(crateDir, 'Cargo.lock'), 'version = 4\n')
  writeFileSync(join(crateDir, 'src', 'lib.rs'), 'pub fn ping() {}\n')
  writeFileSync(join(crateDir, 'tests', 'smoke.rs'), '#[test] fn smoke() {}\n')
  const config = loadBuildConfig()
  writeFileSync(join(crateDir, 'build-config.json'), `${JSON.stringify({
    schema: 1,
    crate: 'native/phone-control-core',
    library: config.library,
    compiler: { rustc: config.rustcVersion },
    ndk: { version: config.ndkVersion, apiLevel: config.apiLevel },
    pageSize: config.pageSize,
    abis: config.abis,
  }, null, 2)}\n`)
  const ndkBin = join(root, 'ndk', 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin')
  mkdirSync(ndkBin, { recursive: true })
  for (const name of ['clang.exe', 'llvm-ar.exe', 'llvm-readelf.exe']) writeFileSync(join(ndkBin, name), '')
  return { root, apkDir, crateDir, config, ndk: { root: join(root, 'ndk'), bin: ndkBin, hostTag: 'windows-x86_64', version: config.ndkVersion } }
}

function fakeRunner(f, { output = () => elf(), calls = [] } = {}) {
  return async (command, args, options = {}) => {
    calls.push({ command, args, options })
    if (command === 'rustup' && args[0] === 'toolchain') {
      return { stdout: 'stable-x86_64-pc-windows-gnu\nstable-x86_64-pc-windows-msvc (active, default)\n', stderr: '' }
    }
    if (command === 'rustup' && args[0] === 'run' && args[2] === 'rustc') {
      return { stdout: `rustc ${f.config.rustcVersion} (fixture)\n`, stderr: '' }
    }
    if (command === 'rustup' && args[0] === 'run' && args.includes('cargo')) {
      const target = args[args.indexOf('--target') + 1]
      const path = join(f.crateDir, 'target-android', target, 'release', 'libdsh_phone_control_core.so')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, output(target))
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
}

test('builds selected ABIs through rustup, verifies ELF, and records a safe manifest', async (t) => {
  const f = fixture(t)
  const calls = []
  const outDir = join(f.root, 'out')
  const result = await buildPhoneControlNative({
    apkDir: f.apkDir,
    abis: ['arm64-v8a', 'x86_64'],
    out: outDir,
    config: f.config,
    log: () => {},
  }, {
    env: {},
    ndk: f.ndk,
    installedTargets: ['aarch64-linux-android', 'x86_64-linux-android'],
    // The fixture must produce the .so for the ABI being built, exactly as cargo would.
    run: fakeRunner(f, { calls, output: (target) => elf({ machine: target.includes('aarch64') ? 183 : 62 }) }),
  })

  assert.equal(result.toolchain, 'stable-x86_64-pc-windows-gnu')
  assert.equal(result.built.length, 2)
  for (const abi of ['arm64-v8a', 'x86_64']) {
    const library = abiLibraryPath(outDir, abi, f.config)
    const manifest = JSON.parse(readFileSync(abiManifestPath(outDir, abi, f.config), 'utf8'))
    assert.deepEqual(verifyElf(readFileSync(library), { abi }).machine, ELF_MACHINES[abi])
    assert.equal(manifest.abi, abi)
    assert.equal(manifest.sha256.length, 64)
    assert.ok(manifest.inputs.files.some((entry) => entry.path === 'native/phone-control-core/src/lib.rs'))
    assert.ok(!manifest.inputs.files.some((entry) => entry.path.includes('target')))
    assert.ok(!JSON.stringify(manifest).includes(f.root), 'manifest must not leak host directories')
  }
  const cargoCall = calls.find((call) => call.args.includes('cargo'))
  assert.ok(cargoCall.args.includes('--locked'))
  assert.ok(cargoCall.args.includes('--release'))
  assert.ok(cargoCall.args.includes('aarch64-linux-android'))
  assert.ok(cargoCall.options.env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER.endsWith('clang.exe'))
  const rustflags = cargoCall.options.env.CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS
  assert.match(rustflags, /max-page-size=16384/)
  assert.match(rustflags, /common-page-size=16384/)
  assert.match(rustflags, /--target=aarch64-linux-android26/)
  assert.equal(cargoCall.options.env.RUSTFLAGS, undefined)

  const verified = verifyExistingOutputs({ outDir, abis: ['arm64-v8a', 'x86_64'], config: f.config })
  assert.equal(verified.length, 2)
})

test('rejects a wrong-architecture cargo output before copying it', async (t) => {
  const f = fixture(t)
  const outDir = join(f.root, 'out')
  await assert.rejects(buildPhoneControlNative({
    apkDir: f.apkDir,
    abis: ['arm64-v8a'],
    out: outDir,
    config: f.config,
    log: () => {},
  }, {
    env: {},
    ndk: f.ndk,
    installedTargets: ['aarch64-linux-android'],
    // A host build (x86-64 machine 62) must not be accepted as arm64-v8a.
    run: fakeRunner(f, { output: () => elf({ machine: 62 }) }),
  }), /ELF machine 62 does not match arm64-v8a/)
  assert.equal(existsSync(abiLibraryPath(outDir, 'arm64-v8a', f.config)), false)
})

test('ELF gate rejects truncated, host-hosted, wrong-type, big-endian and 4 KiB outputs', () => {
  assert.throws(() => verifyElf(Buffer.alloc(16), { abi: 'arm64-v8a' }), /truncated/)
  const notElf = Buffer.concat([Buffer.alloc(64), Buffer.from('not an elf')])
  notElf.fill(0x41, 0, 64)
  assert.throws(() => verifyElf(notElf, { abi: 'arm64-v8a' }), /not an ELF/)
  assert.throws(() => verifyElf(elf({ type: 2 }), { abi: 'x86_64' }), /ET_DYN/)
  assert.throws(() => verifyElf(elf({ data: 2, machine: 62 }), { abi: 'x86_64' }), /little-endian/)
  assert.throws(() => verifyElf(elf({ align: 4096, machine: 62 }), { abi: 'x86_64' }), /alignment 4096/)
  assert.throws(() => verifyElf(elf({ dynamic: false, machine: 62 }), { abi: 'x86_64' }), /PT_DYNAMIC/)
  assert.equal(verifyElf(elf({ machine: 62 }), { abi: 'x86_64' }).machine, 62)
})

test('--verify fails on mismatch and succeeds on a valid manifest', async (t) => {
  const f = fixture(t)
  const outDir = join(f.root, 'out')
  await buildPhoneControlNative({
    apkDir: f.apkDir,
    abis: ['x86_64'],
    out: outDir,
    config: f.config,
    log: () => {},
  }, {
    env: {},
    ndk: f.ndk,
    installedTargets: ['x86_64-linux-android'],
    run: fakeRunner(f, { output: () => elf({ machine: 62 }) }),
  })
  const manifestPath = abiManifestPath(outDir, 'x86_64', f.config)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.bytes += 1
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.throws(() => verifyExistingOutputs({ outDir, abis: ['x86_64'], config: f.config }), /bytes/)
  assert.equal(await runCli(['--verify', '--abis', 'x86_64', '--out', outDir, '--apk-dir', f.apkDir]), 1)
})

test('unknown flags and unknown ABIs exit non-zero', async () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/)
  assert.throws(() => parseArgs(['--abis', 'armeabi-v7a']), /unknown ABI/)
  assert.throws(() => parseArgs(['--abis', '']), /at least one/)
  assert.equal(await runCli(['--abis', 'mips']), 1)
  assert.equal(await runCli(['--out']), 1)
})

test('NDK resolution rejects disagreeing SDK roots and version drift', (t) => {
  const f = fixture(t)
  const sdkA = join(f.root, 'sdk-a')
  const sdkB = join(f.root, 'sdk-b')
  assert.throws(() => resolveNdk({ env: { ANDROID_HOME: sdkA, ANDROID_SDK_ROOT: sdkB }, config: f.config }), /different SDK roots/)
  assert.throws(() => resolveNdk({ env: {}, config: f.config }), /NDK 27\.0\.12077973 not found/)
  const ndkRoot = join(f.root, 'ndk-versioned')
  const bin = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'llvm-readelf.exe'), '')
  writeFileSync(join(ndkRoot, 'source.properties'), 'Pkg.Revision = 26.3.11579264\n')
  assert.throws(() => resolveNdk({ explicit: ndkRoot, env: {}, config: f.config }), /reports version 26\.3\.11579264/)
  writeFileSync(join(ndkRoot, 'source.properties'), `Pkg.Revision = ${f.config.ndkVersion}\n`)
  assert.equal(resolveNdk({ explicit: ndkRoot, env: {}, config: f.config }).root, ndkRoot)
})

test('Windows host toolchain prefers matching GNU and reports missing Android std', async () => {
  const calls = []
  const run = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'toolchain') return { stdout: 'stable-x86_64-pc-windows-gnu\n' }
    return { stdout: `rustc 1.99.0 (fixture)\n` }
  }
  const toolchain = await selectToolchain({ config: loadBuildConfig(), run, platform: 'win32', env: { PATH: '' } })
  assert.equal(toolchain, 'stable-x86_64-pc-windows-gnu')
  const install = async () => assert.fail('must not install without --install-targets')
  await assert.rejects(ensureTargets({
    targets: ['aarch64-linux-android', 'x86_64-linux-android'],
    toolchain,
    run: install,
    installed: ['aarch64-linux-android'],
  }), /rustup target add --toolchain stable-x86_64-pc-windows-gnu x86_64-linux-android/)
})

test('crate hash follows real source bytes and ignores cargo target caches', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.crateDir, 'target', 'debug'), { recursive: true })
  writeFileSync(join(f.crateDir, 'target', 'debug', 'junk.so'), 'junk')
  mkdirSync(join(f.crateDir, 'target-android', 'x86_64-linux-android', 'release'), { recursive: true })
  writeFileSync(join(f.crateDir, 'target-android', 'x86_64-linux-android', 'release', 'junk.so'), 'junk')
  mkdirSync(join(f.crateDir, 'target-ui-tree-final', 'debug'), { recursive: true })
  writeFileSync(join(f.crateDir, 'target-ui-tree-final', 'debug', 'junk.so'), 'temporary harness cache')
  const before = hashCrateInputs(f.crateDir, f.apkDir)
  assert.ok(before.files.every((entry) => entry.path.startsWith('native/phone-control-core/')))
  assert.ok(!before.files.some((entry) => entry.path.includes('target')))
  writeFileSync(join(f.crateDir, 'target-ui-tree-final', 'debug', 'junk.so'), 'changed cache')
  assert.equal(before.sha256, hashCrateInputs(f.crateDir, f.apkDir).sha256)
  writeFileSync(join(f.crateDir, 'src', 'lib.rs'), 'pub fn changed() {}\n')
  const after = hashCrateInputs(f.crateDir, f.apkDir)
  assert.notEqual(before.sha256, after.sha256)
  assert.deepEqual(cargoBuildArgs({ crateDir: f.crateDir, target: 'x86_64-linux-android' }), [
    'build', '--locked', '--release', '--manifest-path', join(f.crateDir, 'Cargo.toml'),
    '--target', 'x86_64-linux-android', '--target-dir', join(f.crateDir, 'target-android'),
  ])
})

async function buildFixture(f, abis = ['arm64-v8a', 'x86_64']) {
  const outDir = join(f.root, 'out')
  await buildPhoneControlNative({ apkDir: f.apkDir, abis, out: outDir }, {
    ndk: f.ndk, env: {}, installedTargets: ['aarch64-linux-android', 'x86_64-linux-android'],
    run: fakeRunner(f, { output: (target) => elf({ machine: target.includes('aarch64') ? 183 : 62 }) }),
  })
  return outDir
}

test('merge gate stages only selected .so files, keeping JSON and old ABIs outside JNI', async (t) => {
  const f = fixture(t)
  const outDir = await buildFixture(f)
  const dual = join(f.root, 'jni-dual')
  const single = join(f.root, 'jni-single')
  const noBuild = { run: async () => assert.fail('verify must not run Rust or NDK commands') }
  const verify = (abis, jniOut) => buildPhoneControlNative({ apkDir: f.apkDir, verify: true, abis, out: outDir, jniOut }, noBuild)
  await verify(['arm64-v8a', 'x86_64'], dual)
  await verify(['x86_64'], single)
  assert.equal(await runCli(['--verify', '--abis', 'x86_64', '--out', outDir,
    '--jni-out', single, '--apk-dir', f.apkDir], noBuild), 0)
  assert.deepEqual(readdirSync(single), ['x86_64'])
  assert.deepEqual(readdirSync(join(single, 'x86_64')), ['libdsh_phone_control_core.so'])
  for (const abi of ['arm64-v8a', 'x86_64']) {
    assert.deepEqual(readdirSync(join(dual, abi)), ['libdsh_phone_control_core.so'])
    assert.ok(existsSync(abiManifestPath(outDir, abi, f.config)))
  }
  // Simulate a restored build result: even on a repeated gate invocation, a corrupted
  // staged library is replaced from the verified source and checked again.
  writeFileSync(abiLibraryPath(single, 'x86_64', f.config), 'broken cache')
  await verify(['x86_64'], single)
  assert.deepEqual(readFileSync(abiLibraryPath(single, 'x86_64', f.config)), elf({ machine: 62 }))
  // Damage the raw cache next. Verification runs again and refuses to stage it.
  writeFileSync(abiLibraryPath(outDir, 'x86_64', f.config), elf({ machine: 183 }))
  await assert.rejects(verify(['x86_64'], single), /ELF machine 183/)
})

test('merge gate rejects extra JNI entries and overlapping output roots without deleting files', async (t) => {
  const f = fixture(t)
  const outDir = await buildFixture(f, ['x86_64'])
  const jniOut = join(f.root, 'jni')
  const options = { apkDir: f.apkDir, verify: true, abis: ['x86_64'], out: outDir, jniOut }
  await buildPhoneControlNative(options)
  const extra = join(jniOut, 'x86_64', 'manifest.json')
  writeFileSync(extra, '{}')
  await assert.rejects(buildPhoneControlNative(options), /unexpected JNI entry: x86_64\/manifest.json/)
  assert.ok(existsSync(extra))
  await assert.rejects(buildPhoneControlNative({ ...options, jniOut: outDir }), /must be separate/)
  await assert.rejects(buildPhoneControlNative({ ...options, jniOut: join(outDir, 'jni') }), /must be separate/)
  assert.throws(() => parseArgs(['--jni-out', jniOut]), /requires --verify/)
})

test('cache gate rejects stale Rust, lockfile, config or builder inputs without recompiling', async (t) => {
  const f = fixture(t)
  const outDir = await buildFixture(f, ['x86_64'])
  const verify = () => buildPhoneControlNative({ apkDir: f.apkDir, verify: true, abis: ['x86_64'], out: outDir }, {
    run: async () => assert.fail('gate cannot compile to hide a stale cache'),
  })
  const paths = [join(f.crateDir, 'src', 'lib.rs'), join(f.crateDir, 'Cargo.lock'),
    join(f.crateDir, 'build-config.json'), join(f.apkDir, 'scripts', 'build-phone-control-native.mjs')]
  for (const path of paths) {
    const original = readFileSync(path)
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]))
    await assert.rejects(verify(), /source inputs changed/)
    writeFileSync(path, original)
    await verify()
  }
  const before = hashBuildInputs(f.crateDir, f.apkDir)
  mkdirSync(join(f.crateDir, 'target-android'), { recursive: true })
  writeFileSync(join(f.crateDir, 'target-android', 'anything'), 'cache')
  assert.deepEqual(hashBuildInputs(f.crateDir, f.apkDir), before)
  unlinkSync(join(f.crateDir, 'Cargo.lock'))
  await assert.rejects(verify(), /source inputs changed/)
  await assert.rejects(buildPhoneControlNative({ apkDir: f.apkDir, abis: ['x86_64'], out: outDir }, {
    run: async () => assert.fail('missing lockfile must fail before tool detection'),
  }), /missing Cargo.lock/)
})

test('ELF gate checks every PT_LOAD alignment rather than accepting the largest', () => {
  const buffer = elf({ machine: 62 })
  buffer.writeUInt16LE(3, 56)
  buffer.writeUInt32LE(1, 64 + 112)
  buffer.writeBigUInt64LE(4096n, 64 + 112 + 48)
  assert.throws(() => verifyElf(buffer, { abi: 'x86_64' }), /PT_LOAD alignment 4096/)
})
