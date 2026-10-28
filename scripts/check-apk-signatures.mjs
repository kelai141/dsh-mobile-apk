#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { X509Certificate } from 'node:crypto'

const REQUIRED = ['v1', 'v2', 'v3']
// The produced APKs use SHA-256 for JAR/v1 signatures. apksigner defaults
// verification's minimum SDK from the APK manifest (26), where it omits v1
// from its compatibility report. API 18 supports this v1 digest, so verify
// against that floor to assert the actual signature block consistently.
const VERIFY_MIN_SDK = 18

function javaTool(name) {
  const executable = process.platform === 'win32' ? name + '.exe' : name
  const configured = process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', executable)
  return configured && fs.existsSync(configured) ? configured : executable
}

export function buildApksignerCommand(apksigner, args, platform = process.platform) {
  if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(apksigner)) {
    // Invoke the SDK's actual jar without cmd.exe; APK paths remain separate arguments, including spaces/metacharacters.
    return { executable: javaTool('java'), args: ['-jar', path.join(path.dirname(apksigner), 'lib', 'apksigner.jar'), ...args] }
  }
  return { executable: apksigner, args }
}

export function buildVerifyArgs(apk) {
  return ['verify', '--verbose', '--print-certs', '--min-sdk-version', String(VERIFY_MIN_SDK), apk]
}

export function readSchemes(output) {
  const schemes = {}
  for (const scheme of REQUIRED) {
    const match = output.match(new RegExp(`^[ \\t]*Verified using ${scheme} scheme \\([^\\r\\n]*?\\):[ \\t]*(true|false)[ \\t]*$`, 'im'))
    schemes[scheme] = match ? match[1].toLowerCase() === 'true' : false
  }
  return schemes
}

export function readCertificateDigests(output) {
  return [...output.matchAll(/^[^\r\n]*certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/gim)]
    .map(match => match[1].replaceAll(':', '').toLowerCase())
    .filter(digest => /^[0-9a-f]{64}$/.test(digest))
}

export function evaluateVerification({ exitCode, output, expectedCertificateSha256 }) {
  const schemes = readSchemes(output)
  const missing = REQUIRED.filter((scheme) => !schemes[scheme])
  const certificates = readCertificateDigests(output)
  const expected = expectedCertificateSha256?.replaceAll(':', '').toLowerCase()
  const certificateMatches = /^[0-9a-f]{64}$/.test(expected ?? '') &&
    certificates.length > 0 && certificates.every(digest => digest === expected)
  return { ok: exitCode === 0 && missing.length === 0 && certificateMatches, exitCode, schemes, missing, certificates, certificateMatches }
}

export function readKeystoreCertificate(keystore) {
  const keytool = javaTool('keytool')
  const result = spawnSync(keytool, ['-exportcert', '-rfc', '-keystore', path.resolve(keystore),
    '-alias', 'androiddebugkey', '-storepass', 'android'], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('cannot export the repository signing certificate from ' + keystore)
  const pem = result.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0]
  if (!pem) throw new Error('keytool did not return a certificate')
  return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase()
}

function fail(message) {
  console.error(`APK signature gate: FAIL: ${message}`)
  process.exitCode = 1
}

function resolveApksigner(explicit) {
  if (explicit) return explicit
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'))
    roots.push(path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Android', 'Sdk'))
  } else {
    roots.push(path.join(process.env.HOME ?? '', 'Android', 'Sdk'), '/usr/local/lib/android/sdk')
  }
  const candidates = []
  for (const root of roots.filter(Boolean)) {
    const buildTools = path.join(root, 'build-tools')
    if (!fs.existsSync(buildTools)) continue
    for (const version of fs.readdirSync(buildTools).sort()) {
      const candidate = path.join(buildTools, version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
      if (fs.existsSync(candidate)) candidates.push(candidate)
      const extensionless = path.join(buildTools, version, 'apksigner')
      if (process.platform === 'win32' && fs.existsSync(extensionless)) candidates.push(extensionless)
    }
  }
  return candidates.at(-1)
}

function parseArgs(args) {
  const parsed = { apks: [], dirs: [], apksigner: undefined }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (['--apk', '--dir', '--apksigner', '--keystore'].includes(arg) && (!args[i + 1] || args[i + 1].startsWith('--'))) {
      throw new Error('missing value for ' + arg)
    }
    if (arg === '--apk') parsed.apks.push(args[++i])
    else if (arg === '--dir') parsed.dirs.push(args[++i])
    else if (arg === '--apksigner') parsed.apksigner = args[++i]
    else if (arg === '--keystore') parsed.keystore = args[++i]
    else if (arg === '--self-test') parsed.selfTest = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return parsed
}

function runSelfTest() {
  const expectedCertificate = 'ab'.repeat(32)
  const certificateOutput = '\nSigner #1 certificate SHA-256 digest: ' + expectedCertificate
  const full = [
    'Verifies',
    'Verified using v1 scheme (JAR signing): true',
    'Verified using v2 scheme (APK Signature Scheme v2): true',
    'Verified using v3 scheme (APK Signature Scheme v3): true',
  ].join('\n') + certificateOutput
  const cases = [
    ['all schemes present', 0, full, true],
    ['v1 absent', 0, full.replace(/^Verified using v1 scheme.*(?:\r?\n|$)/im, ''), false],
    ['v2 absent', 0, full.replace(/^Verified using v2 scheme.*(?:\r?\n|$)/im, ''), false],
    ['v3 absent', 0, full.replace(/^Verified using v3 scheme.*(?:\r?\n|$)/im, ''), false],
    ['nonzero apksigner exit', 1, full, false],
    ['matching signing identity', 0, full, true, expectedCertificate],
    ['absent signing identity', 0, full.replace(certificateOutput, ''), false, expectedCertificate],
    ['wrong signing identity', 0, full.replace(expectedCertificate, 'cd'.repeat(32)), false, expectedCertificate],
  ]
  let failures = 0
  for (const [name, exitCode, output, expected, expectedCertificateSha256] of cases) {
    const actual = evaluateVerification({ exitCode, output, expectedCertificateSha256: expectedCertificateSha256 ?? expectedCertificate }).ok
    const ok = actual === expected
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test ${name}: expected=${expected} actual=${actual}`)
    if (!ok) failures += 1
  }
  if (failures) process.exitCode = 1
  else console.log(`PASS ${cases.length}/${cases.length} signature gate self-tests`)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    return fail(error.message)
  }
  if (options.help) {
    console.log('Usage: node scripts/check-apk-signatures.mjs (--apk FILE | --dir DIR)+ --keystore FILE [--apksigner PATH] [--self-test]')
    return
  }
  if (options.selfTest) return runSelfTest()
  if (!options.apks.length && !options.dirs.length) return fail('provide at least one --apk or --dir')
  if (!options.keystore) return fail('--keystore is required for APK verification')
  const apksigner = resolveApksigner(options.apksigner)
  if (!apksigner || !fs.existsSync(apksigner)) return fail('apksigner not found; pass --apksigner or set ANDROID_HOME/ANDROID_SDK_ROOT')
  let expectedCertificateSha256
  if (options.keystore) {
    try { expectedCertificateSha256 = readKeystoreCertificate(options.keystore) }
    catch (error) { return fail(error.message) }
  }
  const files = [...options.apks]
  for (const dir of options.dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return fail(`not a directory: ${dir}`)
    const pending = [path.resolve(dir)]
    while (pending.length) {
      const current = pending.pop()
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const candidate = path.join(current, entry.name)
        if (entry.isDirectory()) pending.push(candidate)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.apk')) files.push(candidate)
      }
    }
  }
  const unique = [...new Set(files.map((file) => path.resolve(file)))].sort()
  if (!unique.length) return fail('no APK files found in the supplied paths')
  let failures = 0
  console.log(`APK signature gate: apksigner=${apksigner}`)
  console.log('Required APK signature schemes: v1=true, v2=true, v3=true')
  if (expectedCertificateSha256) console.log('Required signing certificate SHA-256: ' + expectedCertificateSha256)
  for (const apk of unique) {
    if (!fs.existsSync(apk) || !fs.statSync(apk).isFile()) {
      console.error(`FAIL ${apk}: file does not exist`)
      failures += 1
      continue
    }
    const args = buildVerifyArgs(apk)
    const command = buildApksignerCommand(apksigner, args)
    console.log(`\n$ ${command.executable} ${command.args.join(' ')}`)
    const result = spawnSync(command.executable, command.args, { encoding: 'utf8', windowsHide: true })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    console.log(output.trimEnd())
    const status = evaluateVerification({ exitCode: result.status, output, expectedCertificateSha256 })
    console.log(`apksigner exit-code=${result.status ?? 'null'}; schemes v1=${status.schemes.v1} v2=${status.schemes.v2} v3=${status.schemes.v3}`)
    if (result.error || !status.ok) {
      if (result.error) console.error(`spawn error: ${result.error.message}`)
      console.error(`FAIL ${apk}: required schemes missing/false: ${status.missing.join(', ') || 'none'}; exit=${result.status ?? 'null'}`)
      if (!status.certificateMatches) console.error(`FAIL ${apk}: signing certificate differs from the repository keystore or is absent`)
      failures += 1
    } else console.log(`PASS ${apk}`)
  }
  if (failures) return fail(`${failures}/${unique.length} APK(s) failed verification`)
  console.log(`PASS all ${unique.length} final APK(s) have v1, v2, and v3 signatures`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
