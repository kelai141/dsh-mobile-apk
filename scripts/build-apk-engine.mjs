#!/usr/bin/env node
// Shared per-ABI APK terminal engine.
// The local PowerShell chain, portable Node chain, and release assembler keep
// their own gates and snapshot preparation, then converge here for the exact
// snapshot -> fingerprint -> Gradle -> artifact -> signature sequence.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function execute(command, args, options = {}, runner = spawnSync) {
  const result = runner(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    // Direct executables such as process.execPath must bypass cmd.exe on Windows;
    // shell:true splits paths like "C:\\Program Files\\nodejs\\node.exe".
    // Batch Gradle launchers opt into a shell at their call site below.
    shell: options.shell ?? false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'null'})`)
  }
  return result
}

/**
 * Run the common APK assembly terminal stage. Callers own ABI selection,
 * gates, injection and artifact naming; this function owns assets, Gradle,
 * copying and strict fingerprint verification.
 */
export function assembleApk(options, runner = spawnSync) {
  const {
    snapshot,
    apkDir,
    outputDir,
    artifactName,
    suffix = '',
    gradleCommand,
    clean = false,
    log = console.log,
    fingerprintGate = join(SCRIPT_DIR, 'check-snapshot-fingerprint.mjs'),
  } = options
  if (!snapshot || !apkDir || !outputDir || !artifactName) {
    throw new Error('assemble requires snapshot, apkDir, outputDir, and artifactName')
  }
  const sourceSnapshot = resolve(snapshot)
  const resolvedApkDir = resolve(apkDir)
  const resolvedOutputDir = resolve(outputDir)
  if (!existsSync(sourceSnapshot)) throw new Error(`snapshot not found: ${sourceSnapshot}`)

  const assetDir = join(resolvedApkDir, 'app', 'src', 'main', 'assets')
  const assetSnapshot = join(assetDir, 'snapshot.tar.xz')
  const fingerprint = join(assetDir, 'snapshot.sha256')
  const intermediates = join(resolvedApkDir, 'app', 'build', 'intermediates', 'assets')
  const debugOutput = join(resolvedApkDir, 'app', 'build', 'outputs', 'apk', 'debug')
  const builtApk = join(debugOutput, 'app-debug.apk')
  const deliveredApk = join(resolvedOutputDir, artifactName)

  mkdirSync(assetDir, { recursive: true })
  mkdirSync(resolvedOutputDir, { recursive: true })
  // Never let a successful no-op/incremental Gradle invocation reuse an older APK.
  // Release mode preserves unrelated intermediates, but the terminal APK output is always fresh.
  rmSync(debugOutput, { recursive: true, force: true })
  if (clean) {
    rmSync(intermediates, { recursive: true, force: true })
  }
  copyFileSync(sourceSnapshot, assetSnapshot)
  const sha = createHash('sha256').update(readFileSync(sourceSnapshot)).digest('hex')
  writeFileSync(fingerprint, sha, 'ascii')
  log(`snapshot.sha256 = ${sha}`)

  // Generate exact product ownership only from the final injected archive. The
  // separately packaged manifest binds itself to this tar hash, avoiding a hash cycle.
  const hardManifest = join(assetDir, 'plugin-hard-manifest.json')
  execute(process.execPath, [join(SCRIPT_DIR, 'build-hard-manifest.mjs'), '--snapshot', sourceSnapshot, '--out', hardManifest],
    { cwd: SCRIPT_DIR }, runner)

  execute(process.execPath, [fingerprintGate, '--require'], { cwd: SCRIPT_DIR }, runner)

  const gradle = gradleCommand ?? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
  const gradleArgs = [':app:assembleDebug', '--no-daemon', `-PversionNameSuffix=${suffix}`]
  log(`Gradle: ${gradle} ${gradleArgs.join(' ')}`)
  execute(gradle, gradleArgs, { cwd: resolvedApkDir, shell: process.platform === 'win32' }, runner)

  if (!existsSync(builtApk)) throw new Error(`Gradle succeeded but APK is missing: ${builtApk}`)
  copyFileSync(builtApk, deliveredApk)
  log(`产物: ${deliveredApk}`)
  return deliveredApk
}

/** Validate the exact output scope used by a caller (directory or files). */
export function verifyApks({ directories = [], files = [], signatureGate = join(SCRIPT_DIR, 'check-apk-signatures.mjs'), keystore = join(SCRIPT_DIR, '..', 'keystore', 'debug.keystore'), selfTest = true, log = console.log }, runner = spawnSync) {
  log('验证最终输出 APK 的 v1/v2/v3 签名…')
  if (selfTest) execute(process.execPath, [signatureGate, '--self-test'], { cwd: SCRIPT_DIR }, runner)
  const targets = [...directories.flatMap((directory) => ['--dir', resolve(directory)]),
    ...files.flatMap((file) => ['--apk', resolve(file)])]
  if (!targets.length) throw new Error('signature verification requires at least one directory or APK')
  execute(process.execPath, [signatureGate, ...targets, '--keystore', resolve(keystore)], { cwd: SCRIPT_DIR }, runner)
}

export function parseArgs(argv) {
  const [action, ...rest] = argv
  const options = { action, clean: false }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--clean') options.clean = true
    else if (arg === '--skip-self-test') options.skipSelfTest = true
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      options[key] = rest[++i] ?? ''
    } else throw new Error(`unexpected argument: ${arg}`)
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.action === 'assemble') {
    assembleApk({ ...options, gradleCommand: options.gradle })
    return
  }
  if (options.action === 'verify') {
    verifyApks({
      directories: options.dir ? [options.dir] : [],
      files: options.apk ? [options.apk] : [],
      keystore: options.keystore ? resolve(options.keystore) : undefined,
      selfTest: !options.skipSelfTest,
      signatureGate: options.signatureGate ? resolve(options.signatureGate) : undefined,
    })
    return
  }
  throw new Error('usage: node scripts/build-apk-engine.mjs assemble|verify [options]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`APK build engine failed: ${error.message}`)
    process.exitCode = 1
  }
}
