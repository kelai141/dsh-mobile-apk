#!/usr/bin/env node
// Local-only APK repack for shell/UI iteration. This intentionally skips every
// release gate and requires an existing snapshot asset in the APK project.
// Never publish this artifact: it is unsigned-release, ungated and unverified.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apkDir = existsSync(join(root, 'dsh-mobile-apk')) ? join(root, 'dsh-mobile-apk') : root
const snapshot = join(apkDir, 'app/src/main/assets/snapshot.tar.xz')
const output = join(root, '.deploy-tmp', 'dev-fast', 'dsh-mobile-apk-dev-fast.apk')
const localSdk = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
  : null
if (!process.env.ANDROID_HOME && localSdk && existsSync(localSdk)) {
  process.env.ANDROID_HOME = localSdk
}

if (!existsSync(snapshot)) {
  throw new Error('missing ' + snapshot + ': obtain a verified snapshot asset first; dev repack must not invent one')
}

// ABI guard (issue #668). Everything above can only prove that snapshot.sha256 *describes*
// snapshot.tar.xz. None of it can prove the archive was built for the device we are about to
// install on, and dev repack is exactly where a foreign-ABI archive slips through: it reuses
// whatever asset is lying in the tree and recomputes the fingerprint from it, so the fingerprint
// gate必过 by construction. The resulting package installs, starts its Activity and reports
// "Status: ok" from `am start -W`, then never starts the engine:
//   CANNOT LINK EXECUTABLE "/system/bin/houdini64": ".../libtermux-exec-ld-preload.so"
//     is for EM_AARCH64 (183) instead of EM_X86_64 (62)
// boot-start stays 0 and engine.log never appears. Any measurement taken on such a package
// (startup budget, a11y channel, bridge) is worthless, so refuse to build it instead.
const abiFlag = process.argv.indexOf('--abi')
const abiOnly = process.argv.includes('--abi-only')
if (abiFlag !== -1 && !process.argv[abiFlag + 1]) {
  throw new Error('--abi needs a value (x86_64 or aarch64)')
}
const wantedAbi = abiFlag !== -1 ? process.argv[abiFlag + 1] : (process.env.DSH_DEV_ABI || null)
// Python's bundled tarfile streams the xz archive; do not read 200 MB into memory, and do not
// extract anything. Same helper style as build-hard-manifest.mjs, which already requires Python.
const probeAbi = String.raw`import sys,tarfile
MACH={62:'x86_64',183:'aarch64'}
try:
  tf=tarfile.open(sys.argv[1],'r:xz')
except Exception as exc:
  print('UNREADABLE: %s' % exc); sys.exit(5)
with tf:
  for m in tf:
    if m.name.endswith('usr/bin/node') and m.isfile():
      hdr=tf.extractfile(m).read(20)
      if len(hdr)<20 or hdr[:4]!=b'\x7fELF':
        print('NOT_ELF'); sys.exit(3)
      m2=int.from_bytes(hdr[18:20],'little')
      print(MACH.get(m2,'unknown-0x%x' % m2)); sys.exit(0)
print('MISSING'); sys.exit(4)`
const python = process.platform === 'win32' ? 'python' : 'python3'
const probe = spawnSync(python, ['-c', probeAbi, snapshot], { encoding: 'utf8' })
const snapshotAbi = (probe.stdout || '').trim()
if (probe.status !== 0 || !snapshotAbi) {
  throw new Error('cannot read the ABI out of ' + snapshot + ': '
    + (probe.stderr || probe.stdout || 'probe exited ' + probe.status).trim())
}
if (snapshotAbi !== 'x86_64' && snapshotAbi !== 'aarch64') {
  throw new Error('snapshot runtime is neither x86_64 nor aarch64 (probe said "' + snapshotAbi
    + '"); this asset cannot run on any supported device')
}
console.log('DEV-FAST snapshot ABI = ' + snapshotAbi)
// When the caller did not say which ABI they are targeting, ask the device they are about to
// install on instead of quietly skipping the check. Inferring here is what turns the guard from
// advisory into a real requirement on the common path: the whole failure mode is "I did not think
// about ABI", so a guard that only fires when you remember to pass --abi guards nothing.
//
// Inference must never break a build: no adb, no device or several devices all mean "cannot tell",
// which falls back to the advisory message rather than throwing.
function abiFromConnectedDevice() {
  const serial = process.env.ANDROID_SERIAL || process.env.ADB_SERIAL || null
  const list = spawnSync('adb', ['devices'], { encoding: 'utf8', timeout: 5000 })
  if (list.status !== 0 || !list.stdout) return { abi: null, why: 'adb unavailable' }
  const ready = list.stdout.split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[1] === 'device')
    .map((cols) => cols[0])
  if (ready.length === 0) return { abi: null, why: 'no device' }
  // abilist[0] is the preferred ABI. Some x86_64 emulators also advertise arm64-v8a through houdini
  // translation, but translated binaries still cannot exec when their own machine type is wrong
  // (that is the houdini64 CANNOT LINK failure), so only the primary ABI counts.
  const primary = (devices) => devices.map((device) => {
    const prop = spawnSync('adb', ['-s', device, 'shell', 'getprop', 'ro.product.cpu.abilist'],
      { encoding: 'utf8', timeout: 5000 })
    const first = (prop.stdout || '').trim().split(',')[0].trim()
    if (prop.status !== 0 || !first) return null
    if (first === 'x86_64') return 'x86_64'
    if (first === 'arm64-v8a' || first === 'arm64') return 'aarch64'
    return null
  })
  if (serial) {
    const [abi] = primary([serial])
    return abi
      ? { abi, why: serial }
      : { abi: null, why: 'cannot read a supported primary ABI from ' + serial }
  }
  // Several devices are normal here (a dev box with a few emulators). They almost always share one
  // ABI, and refusing to infer in that case would silently disable the guard on exactly the machines
  // that need it. Only a genuine mix is ambiguous.
  const abis = primary(ready)
  if (abis.some((abi) => !abi)) return { abi: null, why: 'cannot read a supported primary ABI from ' + ready.join(', ') }
  const distinct = [...new Set(abis)]
  if (distinct.length > 1) return { abi: null, why: ready.length + ' devices disagree (' + distinct.join(' vs ') + '), set ANDROID_SERIAL' }
  return { abi: distinct[0], why: ready.join(', ') }
}
let effectiveAbi = wantedAbi
if (!effectiveAbi) {
  const inferred = abiFromConnectedDevice()
  if (inferred.abi) {
    effectiveAbi = inferred.abi
    console.log('DEV-FAST: no --abi given; inferred ' + inferred.abi + ' from connected device ' + inferred.why)
  } else {
    console.log('DEV-FAST: no --abi given and no target inferred (' + inferred.why + '), so the ABI above is NOT checked; pass --abi <x86_64|aarch64> to make it a hard requirement')
  }
}
if (effectiveAbi && effectiveAbi !== snapshotAbi) {
  throw new Error('snapshot ABI is ' + snapshotAbi + ' but the target is ' + effectiveAbi
    + (wantedAbi ? ' (from --abi)' : ' (inferred from the connected device)')
    + ': installing a ' + snapshotAbi + ' snapshot on a ' + effectiveAbi
    + ' device dies at exec with "CANNOT LINK EXECUTABLE houdini64", and the package still looks fine to "am start -W". Rebuild or fetch a ' + effectiveAbi + ' snapshot, or pass the matching --abi if you really mean it')
}
if (abiOnly) {
  console.log('DEV-FAST: --abi-only, stopping before Gradle')
  process.exit(0)
}
// The bundle fingerprint is the OTHER half of the same gate, and it was missing here.
//
// EngineManager.snapshotFingerprintProblem() runs BEFORE the Hard manifest check, so a package
// without snapshot.sha256 is refused at the earlier gate (stage=snapshot-bundled-sha-missing) and
// never even reaches ensureHard. Symptom is nasty: am start -W still reports Status: ok with a
// plausible TotalTime, because it measures the Activity, not the engine — while boot-start stays 0
// and engine.log never appears. Anyone measuring a startup budget on such a package concludes
// "startup is fine", which is the opposite of the truth.
//
// build-apk-engine.mjs already writes this file for the release/Fast paths; dev repack simply
// forgot the step. Derive it from the same archive we are about to embed, never invent a value.
const fingerprint = join(apkDir, 'app/src/main/assets/snapshot.sha256')
const digest = createHash('sha256').update(readFileSync(snapshot)).digest('hex')
// A declared fingerprint that disagrees with the archive sitting next to it is the ONLY cheap
// evidence that somebody swapped the archive without regenerating the declaration (issue #668).
// The write below erases that evidence, so report it first instead of silently adopting the value.
if (existsSync(fingerprint)) {
  const declared = readFileSync(fingerprint, 'ascii').trim()
  if (declared && declared !== digest) {
    console.warn('WARN: snapshot.sha256 declares ' + declared)
    console.warn('WARN: the archive actually hashes to ' + digest)
    console.warn('WARN: declaration and archive disagree, so this asset was swapped without regenerating it; confirm the ABI reported above matches your device before trusting any measurement taken on this package')
  }
}
writeFileSync(fingerprint, digest, 'ascii')
console.log('snapshot.sha256 = ' + digest)
// Fail loudly if either gate asset is absent or inconsistent. Without this, a regression in the
// two generation steps above would silently produce a package whose engine never starts.
execFileSync(process.execPath, [join(root, 'scripts', 'check-snapshot-fingerprint.mjs'), '--require'],
  { cwd: root, stdio: 'inherit' })

mkdirSync(dirname(output), { recursive: true })
// EngineManager refuses to launch when its product ownership manifest is absent.
// Generate it from the exact embedded archive before Gradle packages assets.
execFileSync(process.execPath, [join(root, 'scripts', 'build-hard-manifest.mjs'),
  '--snapshot', snapshot, '--out', join(apkDir, 'app/src/main/assets/plugin-hard-manifest.json')],
  { cwd: root, stdio: 'inherit' })
const hardManifest = join(apkDir, 'app/src/main/assets/plugin-hard-manifest.json')
if (!existsSync(hardManifest) || readFileSync(hardManifest).length === 0) {
  throw new Error('missing or empty ' + hardManifest + ': engine would refuse to start')
}
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
const args = [':app:assembleDebug', '--no-daemon', '--console=plain', '-PversionNameSuffix=-DEV-FAST']
console.log('DEV-FAST: all release gates skipped; artifact is for local verification only')
execFileSync(gradle, args, { cwd: apkDir, stdio: 'inherit', shell: process.platform === 'win32' })
const built = join(apkDir, 'app/build/outputs/apk/debug/app-debug.apk')
if (!existsSync(built)) throw new Error('gradle finished without ' + built)
copyFileSync(built, output)
console.log('DEV-FAST artifact: ' + output)
console.log('Install with adb install -r -t; do not attach this package to a release.')