#!/usr/bin/env node
// Cross-compile native/phone-control-core for Android with the pinned NDK.
//
// native/phone-control-core/build-config.json is the only source for the compiler,
// NDK, API level, page size and the ABI -> Rust target / ELF machine table. Gradle can
// consume the deterministic output layout:
//   app/build/generated/phone-control-jni/<abi>/libdsh_phone_control_core.so
// A small JSON manifest sits next to each .so and records input hashes, tool versions,
// byte count and SHA-256. It contains no credentials or absolute host paths.
//
// The script never downloads a compiler and never deletes a directory. Cargo's cache is
// native/phone-control-core/target-android so it is isolated from the host target dir.
// Child processes are spawned with argument arrays and shell:false.
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_APK_DIR = resolve(SCRIPT_DIR, '..')
const CONFIG_RELATIVE = join('native', 'phone-control-core', 'build-config.json')
const ELF_HEADER_BYTES = 64
const DEFAULT_OUT_RELATIVE = join('app', 'build', 'generated', 'phone-control-jni')

export const SUPPORTED_ABIS = Object.freeze(['arm64-v8a', 'x86_64'])
export const ELF_MACHINES = Object.freeze({ 'arm64-v8a': 183, x86_64: 62 })

export function expectedLibraryName(config) {
  return `lib${config.library}.so`
}

export function abiOutputDir(outDir, abi) {
  return join(outDir, abi)
}

export function abiLibraryPath(outDir, abi, config) {
  return join(abiOutputDir(outDir, abi), expectedLibraryName(config))
}

export function abiManifestPath(outDir, abi, config) {
  return join(abiOutputDir(outDir, abi), `${config.library}.json`)
}

/** Read and validate the module's single config source. */
export function loadBuildConfig(apkDir = DEFAULT_APK_DIR) {
  const path = join(apkDir, CONFIG_RELATIVE)
  if (!existsSync(path)) throw new Error(`missing build config: ${path}`)
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`invalid build config ${path}: ${error.message}`)
  }
  return validateBuildConfig(config, path)
}

export function validateBuildConfig(config, source = CONFIG_RELATIVE) {
  const fail = (message) => { throw new Error(`invalid build config ${source}: ${message}`) }
  if (!config || typeof config !== 'object') fail('expected an object')
  if (config.schema !== 1) fail('schema must be 1')
  if (typeof config.crate !== 'string' || config.crate.trim() === '') fail('crate must be a relative path')
  if (isAbsolute(config.crate)) fail('crate must stay inside the APK checkout')
  const crateParts = config.crate.split(/[\\/]+/)
  if (crateParts.includes('..')) fail('crate must stay inside the APK checkout')
  if (typeof config.library !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.library)) {
    fail('library must be a Rust identifier')
  }
  const compiler = typeof config.compiler?.rustc === 'string' ? config.compiler.rustc.trim() : ''
  const rustcVersion = compiler.replace(/^rustc\s+/, '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(rustcVersion)) {
    fail('compiler.rustc must pin an exact version such as 1.99.0')
  }
  const ndkVersion = typeof config.ndk?.version === 'string' ? config.ndk.version.trim() : ''
  if (!/^\d+\.\d+\.\d+$/.test(ndkVersion)) fail('ndk.version must pin an exact NDK version')
  const apiLevel = config.ndk?.apiLevel
  if (!Number.isInteger(apiLevel) || apiLevel < 21 || apiLevel > 35) {
    fail('ndk.apiLevel must be an integer in 21..35')
  }
  if (config.pageSize !== 16384) fail('pageSize must be 16384 (16 KiB Android pages)')
  if (!config.abis || typeof config.abis !== 'object' || Array.isArray(config.abis)) fail('abis must be an object')
  const abiNames = Object.keys(config.abis).sort()
  if (abiNames.length !== SUPPORTED_ABIS.length || abiNames.some((abi) => !SUPPORTED_ABIS.includes(abi))) {
    fail(`abis must contain exactly ${SUPPORTED_ABIS.join(', ')}`)
  }
  for (const abi of SUPPORTED_ABIS) {
    const entry = config.abis[abi]
    if (!entry) fail(`ABI "${abi}" is missing`)
    if (typeof entry.rustTarget !== 'string' || !/^[a-z0-9_]+-linux-android$/.test(entry.rustTarget)) {
      fail(`${abi}.rustTarget must be an Android Rust target`)
    }
    if (typeof entry.linkerTriple !== 'string' || !/^[a-z0-9_]+-linux-android(eabi)?$/.test(entry.linkerTriple)) {
      fail(`${abi}.linkerTriple is invalid`)
    }
    if (entry.elfMachine !== ELF_MACHINES[abi]) fail(`${abi}.elfMachine must be ${ELF_MACHINES[abi]}`)
  }
  const rustTargets = SUPPORTED_ABIS.map((abi) => config.abis[abi].rustTarget)
  if (new Set(rustTargets).size !== rustTargets.length) fail('abis must map to distinct rustTarget values')
  return {
    schema: 1,
    crate: config.crate.replace(/[\\/]+/g, '/'),
    library: config.library,
    rustcVersion,
    ndkVersion,
    apiLevel,
    pageSize: config.pageSize,
    abis: config.abis,
  }
}

/** Parse CLI arguments. Unknown flags and unknown ABIs are errors. */
export function parseArgs(argv) {
  const options = {
    abis: null,
    out: null,
    ndk: null,
    jniOut: null,
    hostToolchain: null,
    verify: false,
    selfTest: false,
    installTargets: false,
    help: false,
    apkDir: DEFAULT_APK_DIR,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      i += 1
      return next
    }
    switch (arg) {
      case '--abis': {
        const raw = value().trim()
        const abis = raw.split(',').map((item) => item.trim()).filter(Boolean)
        if (abis.length === 0) throw new Error('--abis must list at least one ABI')
        const unknown = abis.filter((abi) => !SUPPORTED_ABIS.includes(abi))
        if (unknown.length > 0) {
          throw new Error(`unknown ABI "${unknown.join(', ')}" (expected ${SUPPORTED_ABIS.join(', ')})`)
        }
        if (new Set(abis).size !== abis.length) throw new Error('--abis contains duplicates')
        options.abis = SUPPORTED_ABIS.filter((abi) => abis.includes(abi))
        break
      }
      case '--out':
        options.out = value()
        break
      case '--ndk':
        options.ndk = value()
        break
      case '--jni-out':
        options.jniOut = value()
        break
      case '--host-toolchain':
        options.hostToolchain = value()
        break
      case '--apk-dir':
        options.apkDir = resolve(value())
        break
      case '--verify':
        options.verify = true
        break
      case '--self-test':
        options.selfTest = true
        break
      case '--install-targets':
        options.installTargets = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument "${arg}"`)
    }
  }
  if (options.jniOut && !options.verify) throw new Error('--jni-out requires --verify')
  return options
}

function comparablePath(path) {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function findHostTag(prebuiltDir) {
  const preferred = process.platform === 'win32' ? 'windows-x86_64'
    : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64'
  if (existsSync(join(prebuiltDir, preferred))) return preferred
  const found = readdirSync(prebuiltDir)
    .filter((name) => existsSync(join(prebuiltDir, name, 'bin')))
    .sort()
  return found[0] ?? null
}

function readNdkVersion(path) {
  const match = /^Pkg\.Revision\s*=\s*(\S+)\s*$/m.exec(readFileSync(path, 'utf8'))
  return match ? match[1] : null
}

/**
 * Resolve the pinned NDK. An explicit --ndk wins. Otherwise ANDROID_NDK_HOME is used,
 * then the SDK root. ANDROID_HOME and ANDROID_SDK_ROOT must agree whenever the SDK is
 * used; the historical AGP mismatch is reported once instead of being retried.
 */
export function resolveNdk({ explicit, env = process.env, config }) {
  const version = config.ndkVersion
  const sdkHome = env.ANDROID_HOME ? resolve(env.ANDROID_HOME) : null
  const sdkRoot = env.ANDROID_SDK_ROOT ? resolve(env.ANDROID_SDK_ROOT) : null
  const sdkMismatch = sdkHome !== null && sdkRoot !== null && comparablePath(sdkHome) !== comparablePath(sdkRoot)
  const candidates = []
  if (explicit) {
    const path = resolve(explicit)
    candidates.push(path)
    // A bare SDK-level path is accepted as well as the versioned NDK directory.
    if (path.split(/[\\/]/).pop() !== version) candidates.push(join(path, version))
  } else {
    if (env.ANDROID_NDK_HOME) {
      candidates.push(resolve(env.ANDROID_NDK_HOME))
    } else {
      if (sdkMismatch) {
        throw new Error('ANDROID_HOME and ANDROID_SDK_ROOT point at different SDK roots '
          + `(${sdkHome} vs ${sdkRoot}); align them or pass --ndk explicitly`)
      }
      const sdk = sdkHome ?? sdkRoot
      if (sdk) candidates.push(join(sdk, 'ndk', version))
    }
  }
  for (const candidate of candidates) {
    const prebuilt = join(candidate, 'toolchains', 'llvm', 'prebuilt')
    if (!existsSync(prebuilt) || !statSync(prebuilt).isDirectory()) continue
    const hostTag = findHostTag(prebuilt)
    if (!hostTag) continue
    const sourceProperties = join(candidate, 'source.properties')
    if (!existsSync(sourceProperties)) {
      throw new Error(`NDK at ${candidate} has no source.properties; expected ${version}`)
    }
    const declared = readNdkVersion(sourceProperties)
    if (declared !== version) {
      throw new Error(`NDK at ${candidate} reports version ${declared ?? 'unknown'}, expected ${version}`)
    }
    return { root: candidate, bin: join(prebuilt, hostTag, 'bin'), hostTag, version }
  }
  throw new Error(`NDK ${version} not found (checked: ${candidates.join(', ') || 'no --ndk, ANDROID_NDK_HOME or SDK root'}); `
    + 'install that exact NDK or pass --ndk <path>')
}

function hostExe(base) {
  return process.platform === 'win32' ? `${base}.exe` : base
}

/** Resolve NDK tools for one ABI and fail on any missing executable. */
export function ndkTools(ndk, config, abi) {
  const entry = config.abis[abi]
  if (!entry) throw new Error(`unknown ABI "${abi}"`)
  const tools = {
    linker: join(ndk.bin, hostExe('clang')),
    ar: join(ndk.bin, hostExe('llvm-ar')),
    readelf: join(ndk.bin, hostExe('llvm-readelf')),
  }
  for (const [name, path] of Object.entries(tools)) {
    if (!existsSync(path)) throw new Error(`${abi}: missing NDK ${name} at ${path}`)
  }
  return {
    ...tools,
    hostTag: ndk.hostTag,
    linkerTarget: `${entry.linkerTriple}${config.apiLevel}`,
  }
}

function findOnPath(names, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = join(dir, `${name}${extension}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

/**
 * Pick an installed toolchain whose rustc exactly matches the config pin. On Windows
 * prefer GNU (proc macros need a host linker; the default MSVC install often lacks
 * link.exe). No toolchain is installed here.
 */
export async function selectToolchain({ config, run, explicit, platform = process.platform, env = process.env }) {
  const listed = await run('rustup', ['toolchain', 'list'], { env })
  const installed = String(listed.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && !name.startsWith('no'))
  if (installed.length === 0) throw new Error('rustup reports no installed toolchains; install rustc ' + config.rustcVersion)
  if (explicit && !installed.includes(explicit)) {
    throw new Error(`requested Rust toolchain "${explicit}" is not installed`)
  }
  if (explicit && platform === 'win32' && explicit.endsWith('windows-msvc') && findOnPath(['link'], env) === null) {
    throw new Error(`requested toolchain "${explicit}" is MSVC but link.exe is not in PATH`)
  }
  const ordered = explicit ? [explicit] : platform === 'win32'
    ? [...installed].sort((a, b) => Number(b.endsWith('windows-gnu')) - Number(a.endsWith('windows-gnu')))
    : installed
  const matches = []
  for (const name of ordered) {
    const version = await run('rustup', ['run', name, 'rustc', '--version'], { env })
    const match = /^rustc\s+(\S+)/.exec(String(version.stdout ?? ''))
    if (match?.[1] === config.rustcVersion) matches.push(name)
  }
  if (matches.length === 0) {
    throw new Error(`no installed Rust toolchain reports rustc ${config.rustcVersion}; `
      + `install that exact toolchain (found: ${installed.join(', ')})`)
  }
  if (platform !== 'win32') return matches[0]
  const gnu = matches.find((name) => name.endsWith('windows-gnu'))
  if (gnu) return gnu
  const hasLinker = findOnPath(['link'], env) !== null
  if (!hasLinker) {
    throw new Error(`the matching Windows toolchain (${matches.join(', ')}) has no link.exe in PATH; `
      + 'install a GNU host toolchain or run from a Visual Studio developer shell')
  }
  return matches[0]
}

async function installedTargets(run, toolchain, env) {
  const result = await run('rustup', ['target', 'list', '--installed', '--toolchain', toolchain], { env })
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Ensure Android std targets exist. --install-targets is an explicit opt-in. */
export async function ensureTargets({ targets, toolchain, run, env = process.env, installTargets = false, installed }) {
  let present = installed ?? await installedTargets(run, toolchain, env)
  const missing = targets.filter((target) => !present.includes(target))
  if (missing.length === 0) return
  if (installTargets) {
    await run('rustup', ['target', 'add', '--toolchain', toolchain, ...missing], { env })
    present = await installedTargets(run, toolchain, env)
    const stillMissing = targets.filter((target) => !present.includes(target))
    if (stillMissing.length > 0) throw new Error(`Rust Android std still missing after install: ${stillMissing.join(', ')}`)
    return
  }
  throw new Error(`missing Android Rust std target(s): ${missing.join(', ')}; run: `
    + `rustup target add --toolchain ${toolchain} ${missing.join(' ')} (or pass --install-targets)`)
}

/** Spawn without a shell. Returns stdout/stderr or throws with the exit code. */
export function runCommand(command, args, { cwd, env, log = () => {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    log(`> ${command} ${args.join(' ')}`)
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => reject(new Error(`${command} could not start: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${(stderr || stdout).trim()}`))
        return
      }
      resolvePromise({ status: 0, stdout, stderr })
    })
  })
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256File(path) {
  return sha256(readFileSync(path))
}

/**
 * Validate the ELF header and program headers. This is the copy gate: wrong class,
 * endianness, file type, machine, or page alignment throws before any copy.
 */
export function verifyElf(buffer, { abi, pageSize = 16384, label = 'ELF' } = {}) {
  if (!SUPPORTED_ABIS.includes(abi)) throw new Error(`${label}: unknown ABI "${String(abi)}"`)
  if (!Buffer.isBuffer(buffer)) throw new Error(`${label}: expected a Buffer`)
  if (buffer.length < ELF_HEADER_BYTES) throw new Error(`${label}: truncated ELF header (${buffer.length} bytes)`)
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw new Error(`${label}: not an ELF file (missing 7f 45 4c 46 magic)`)
  }
  if (buffer[4] !== 2) throw new Error(`${label}: not a 64-bit ELF (ELFCLASS=${buffer[4]})`)
  if (buffer[5] !== 1) throw new Error(`${label}: not little-endian (ELFDATA=${buffer[5]})`)
  if (buffer[6] !== 1) throw new Error(`${label}: unsupported ELF ident version ${buffer[6]}`)
  const type = buffer.readUInt16LE(16)
  if (type !== 3) throw new Error(`${label}: expected ET_DYN shared object (e_type=${type})`)
  const machine = buffer.readUInt16LE(18)
  if (machine !== ELF_MACHINES[abi]) {
    throw new Error(`${label}: ELF machine ${machine} does not match ${abi} (expected ${ELF_MACHINES[abi]})`)
  }
  if (buffer.readUInt32LE(20) !== 1) throw new Error(`${label}: unsupported ELF version`)
  const flags = buffer.readUInt32LE(48)
  const headerSize = buffer.readUInt16LE(52)
  if (headerSize < ELF_HEADER_BYTES) throw new Error(`${label}: implausible ELF header size ${headerSize}`)
  const phoff = Number(buffer.readBigUInt64LE(32))
  const phentsize = buffer.readUInt16LE(54)
  const phnum = buffer.readUInt16LE(56)
  if (phnum === 0) throw new Error(`${label}: no program headers`)
  if (phentsize < 56) throw new Error(`${label}: implausible program header size ${phentsize}`)
  if (phoff + phnum * phentsize > buffer.length) throw new Error(`${label}: program headers exceed file size`)
  let loadSegments = 0
  let dynamicSegments = 0
  let maxAlign = 0
  for (let index = 0; index < phnum; index += 1) {
    const base = phoff + index * phentsize
    const segmentType = buffer.readUInt32LE(base)
    if (segmentType === 1) {
      loadSegments += 1
      const align = Number(buffer.readBigUInt64LE(base + 48))
      if (!Number.isSafeInteger(align) || align < pageSize || (BigInt(align) & (BigInt(align) - 1n)) !== 0n) {
        throw new Error(`${label}: PT_LOAD alignment ${align} is below required ${pageSize} or invalid`)
      }
      maxAlign = Math.max(maxAlign, align)
    }
    if (segmentType === 2) dynamicSegments += 1
  }
  if (loadSegments === 0) throw new Error(`${label}: no PT_LOAD segments`)
  if (dynamicSegments === 0) throw new Error(`${label}: no PT_DYNAMIC segment; not a shared object`)
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error(`${label}: invalid pageSize ${pageSize}`)
  if (maxAlign < pageSize) {
    throw new Error(`${label}: PT_LOAD alignment ${maxAlign} is below required ${pageSize} (16 KiB pages)`)
  }
  return { abi, machine, type, bits: 64, littleEndian: true, flags, pageSize, maxAlign, loadSegments }
}

export function verifyElfFile(path, options = {}) {
  const label = options.label ?? path
  if (!existsSync(path)) throw new Error(`${label}: file not found`)
  const size = statSync(path).size
  if (size === 0) throw new Error(`${label}: empty file`)
  return { ...verifyElf(readFileSync(path), { ...options, label }), size }
}

/**
 * Hash declared crate inputs, never cache or temporary harness directories. Source
 * subdirectories include all regular input files; paths stay relative to the checkout.
 */
export function hashCrateInputs(crateDir, apkDir = dirname(crateDir)) {
  if (!existsSync(crateDir)) throw new Error(`missing crate directory: ${crateDir}`)
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`symlink in native build inputs: ${path}`)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build-config.json', 'build.rs']) {
    const path = join(crateDir, name)
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`invalid native input: ${path}`)
      files.push(path)
    }
  }
  for (const name of ['src', 'tests']) {
    const path = join(crateDir, name)
    if (existsSync(path)) {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error(`invalid native source directory: ${path}`)
      walk(path)
    }
  }
  if (files.length === 0) throw new Error(`crate has no inputs: ${crateDir}`)
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const entries = files.map((path) => {
    const repoPath = relative(apkDir, path).split(sep).join('/')
    if (repoPath.startsWith('../') || isAbsolute(repoPath)) throw new Error(`input outside APK checkout: ${path}`)
    return { path: repoPath, sha256: sha256File(path) }
  })
  const aggregate = createHash('sha256')
  for (const entry of entries) aggregate.update(`${entry.sha256}  ${entry.path}\n`)
  return { sha256: aggregate.digest('hex'), files: entries }
}

/** Same build inputs as Gradle, including the builder itself, never Cargo caches. */
export function hashBuildInputs(crateDir, apkDir) {
  const inputs = hashCrateInputs(crateDir, apkDir)
  const script = join(apkDir, 'scripts', 'build-phone-control-native.mjs')
  if (!existsSync(script)) throw new Error(`missing native build script: ${script}`)
  const files = [...inputs.files, {
    path: 'scripts/build-phone-control-native.mjs', sha256: sha256File(script),
  }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const aggregate = createHash('sha256')
  for (const entry of files) aggregate.update(`${entry.sha256}  ${entry.path}\n`)
  return { sha256: aggregate.digest('hex'), files }
}

/** Cargo arguments for one Android target. Exported for tests and handoff. */
export function cargoBuildArgs({ crateDir, target }) {
  return [
    'build',
    '--locked',
    '--release',
    '--manifest-path', join(crateDir, 'Cargo.toml'),
    '--target', target,
    '--target-dir', join(crateDir, 'target-android'),
  ]
}

export function linkerFlags({ config, tools }) {
  return [
    `-C link-arg=--target=${tools.linkerTarget}`,
    `-C link-arg=-Wl,-z,max-page-size=${config.pageSize}`,
    `-C link-arg=-Wl,-z,common-page-size=${config.pageSize}`,
  ].join(' ')
}

function targetEnv({ config, tools, abi, rustflags, env }) {
  const key = config.abis[abi].rustTarget.replace(/-/g, '_').toUpperCase()
  const lowerKey = config.abis[abi].rustTarget.replace(/-/g, '_')
  return {
    ...env,
    // Target-scoped flags keep host proc macros free of Android link arguments.
    [`CARGO_TARGET_${key}_RUSTFLAGS`]: rustflags,
    [`CARGO_TARGET_${key}_LINKER`]: tools.linker,
    [`CARGO_TARGET_${key}_AR`]: tools.ar,
    [`CC_${lowerKey}`]: tools.linker,
    [`AR_${lowerKey}`]: tools.ar,
  }
}

function copyVerified(source, destination, { abi, config, expectedSha256 }) {
  const facts = verifyElfFile(source, { abi, pageSize: config.pageSize, label: `${abi} cargo output` })
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${expectedLibraryName(config)}.tmp-${process.pid}`)
  try {
    copyFileSync(source, temporary)
    const copied = verifyElfFile(temporary, { abi, pageSize: config.pageSize, label: `${abi} copied output` })
    if (copied.size !== facts.size) throw new Error(`${abi}: copied .so size changed`)
    const digest = sha256File(temporary)
    if (expectedSha256 && digest !== expectedSha256) throw new Error(`${abi}: staged .so sha256 differs from manifest`)
    renameSync(temporary, destination)
    return { ...copied, sha256: digest }
  } catch (error) {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* leave the failed temp for inspection */ }
    }
    throw error
  }
}

function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temporary, path)
}

export function validateOutputManifest(manifest, { abi, config, size, sha256: digest }) {
  const fail = (message) => { throw new Error(`${abi}: invalid output manifest: ${message}`) }
  if (!manifest || typeof manifest !== 'object') fail('expected an object')
  if (manifest.schema !== 1) fail('schema must be 1')
  if (manifest.abi !== abi) fail(`abi is "${manifest.abi}", expected "${abi}"`)
  if (manifest.library !== config.library) fail('library drift')
  if (manifest.rustTarget !== config.abis[abi].rustTarget) fail('rustTarget drift')
  if (manifest.rustc !== config.rustcVersion) fail(`rustc is "${manifest.rustc}", expected "${config.rustcVersion}"`)
  if (manifest.ndk !== config.ndkVersion) fail(`ndk is "${manifest.ndk}", expected "${config.ndkVersion}"`)
  if (manifest.apiLevel !== config.apiLevel) fail('apiLevel drift')
  if (manifest.pageSize !== config.pageSize) fail('pageSize drift')
  if (manifest.bytes !== size) fail(`bytes is ${manifest.bytes}, actual ${size}`)
  if (manifest.sha256 !== digest) fail('sha256 does not match the copied .so')
  if (!manifest.inputs || !/^[0-9a-f]{64}$/.test(manifest.inputs.sha256 ?? '')) {
    fail('inputs.sha256 must be a lowercase hex SHA-256')
  }
  if (!Array.isArray(manifest.inputs.files) || manifest.inputs.files.length === 0) {
    fail('inputs.files must be non-empty')
  }
  for (const entry of manifest.inputs.files) {
    if (typeof entry?.path !== 'string' || typeof entry?.sha256 !== 'string') {
      fail('inputs.files entries need path and sha256')
    }
    if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) {
      fail(`input path "${entry.path}" is not checkout-relative`)
    }
  }
  return manifest
}

/** Verify existing outputs without invoking cargo or needing the NDK. */
export function verifyExistingOutputs({ outDir, abis = SUPPORTED_ABIS, config, inputs, log = () => {} }) {
  const results = []
  for (const abi of abis) {
    const libraryPath = abiLibraryPath(outDir, abi, config)
    const facts = verifyElfFile(libraryPath, { abi, pageSize: config.pageSize, label: `${abi} output` })
    const manifestPath = abiManifestPath(outDir, abi, config)
    if (!existsSync(manifestPath)) throw new Error(`${abi}: missing output manifest ${manifestPath}`)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`${abi}: unreadable output manifest: ${error.message}`)
    }
    validateOutputManifest(manifest, { abi, config, size: facts.size, sha256: sha256File(libraryPath) })
    if (inputs && (manifest.inputs.sha256 !== inputs.sha256 || JSON.stringify(manifest.inputs.files) !== JSON.stringify(inputs.files))) {
      throw new Error(`${abi}: source inputs changed; rebuild the native library`)
    }
    log(`${abi}: ok (${facts.size} bytes, sha256 ${manifest.sha256.slice(0, 12)})`)
    results.push({ abi, path: libraryPath, manifestPath, sha256: manifest.sha256, ...facts })
  }
  return results
}

/** Copy only selected, verified libraries. Manifests never enter AGP's JNI source tree. */
export function stageVerifiedOutputs({ outDir, jniOut, abis, config, inputs, log }) {
  const source = resolve(outDir)
  const destination = resolve(jniOut)
  const inside = (parent, child) => {
    const path = relative(parent, child)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }
  if (inside(source, destination) || inside(destination, source)) {
    throw new Error('--jni-out must be separate from --out (neither may contain the other)')
  }
  const results = verifyExistingOutputs({ outDir: source, abis, config, inputs, log })
  // Reject unexpected files instead of recursively deleting anything. ABI-scoped Gradle
  // directories isolate previous selections; manual --jni-out callers get the same guard.
  if (existsSync(destination)) {
    for (const entry of readdirSync(destination, { withFileTypes: true })) {
      if (!entry.isDirectory() || !abis.includes(entry.name)) throw new Error(`unexpected JNI entry: ${entry.name}`)
      for (const file of readdirSync(join(destination, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || file.name !== expectedLibraryName(config)) {
          throw new Error(`unexpected JNI entry: ${entry.name}/${file.name}`)
        }
      }
    }
  }
  for (const result of results) {
    const path = abiLibraryPath(destination, result.abi, config)
    copyVerified(result.path, path, { abi: result.abi, config, expectedSha256: result.sha256 })
  }
  return results
}

/**
 * Build selected ABIs. Dependencies are injectable so unit tests exercise the real
 * copy/manifest path with synthetic ELF files and never run cargo.
 */
export async function buildPhoneControlNative(options = {}, deps = {}) {
  const apkDir = resolve(options.apkDir ?? DEFAULT_APK_DIR)
  const config = deps.config ?? loadBuildConfig(apkDir)
  const abis = options.abis ?? SUPPORTED_ABIS
  const outDir = resolve(options.out ?? join(apkDir, DEFAULT_OUT_RELATIVE))
  const log = options.log ?? (() => {})
  const crateDir = join(apkDir, config.crate)
  if (options.verify) {
    const inputs = deps.inputs ?? hashBuildInputs(crateDir, apkDir)
    return options.jniOut
      ? stageVerifiedOutputs({ outDir, jniOut: options.jniOut, abis, config, inputs, log })
      : verifyExistingOutputs({ outDir, abis, config, inputs, log })
  }
  const env = deps.env ?? process.env
  const run = deps.run ?? ((command, args, runOptions) => runCommand(command, args, { ...runOptions, log }))
  if (!existsSync(join(crateDir, 'Cargo.toml'))) throw new Error(`missing crate manifest: ${join(crateDir, 'Cargo.toml')}`)
  if (!existsSync(join(crateDir, 'Cargo.lock'))) throw new Error(`missing Cargo.lock: ${join(crateDir, 'Cargo.lock')}`)
  const ndk = deps.ndk ?? resolveNdk({ explicit: options.ndk, env, config })
  const toolchain = deps.toolchain ?? await selectToolchain({ config, run, explicit: options.hostToolchain, env })
  await ensureTargets({
    targets: abis.map((abi) => config.abis[abi].rustTarget),
    toolchain,
    run,
    env,
    installTargets: options.installTargets,
    installed: deps.installedTargets,
  })
  const inputs = deps.inputs ?? hashBuildInputs(crateDir, apkDir)
  const built = []
  // Cargo already parallelizes codegen inside one ABI. The two ABI builds stay serial
  // because they share native/phone-control-core/target-android and would otherwise
  // contend on the same Cargo cache lock.
  for (const abi of abis) {
    const tools = ndkTools(ndk, config, abi)
    const target = config.abis[abi].rustTarget
    const rustflags = linkerFlags({ config, tools })
    const buildEnv = targetEnv({ config, tools, abi, rustflags, env })
    await run('rustup', ['run', toolchain, 'cargo', ...cargoBuildArgs({ crateDir, target })], {
      cwd: apkDir,
      env: buildEnv,
    })
    const source = join(crateDir, 'target-android', target, 'release', expectedLibraryName(config))
    const destination = abiLibraryPath(outDir, abi, config)
    const facts = copyVerified(source, destination, { abi, config })
    const manifest = {
      schema: 1,
      abi,
      library: config.library,
      rustTarget: target,
      rustc: config.rustcVersion,
      ndk: config.ndkVersion,
      apiLevel: config.apiLevel,
      pageSize: config.pageSize,
      bytes: facts.size,
      sha256: facts.sha256,
      inputs,
    }
    writeManifest(abiManifestPath(outDir, abi, config), manifest)
    log(`${abi}: wrote ${destination} (${facts.size} bytes)`)
    built.push({ abi, path: destination, manifest, ...facts })
  }
  return { outDir, abis, config, ndk, toolchain, crateDir, inputs, built }
}

export function usage() {
  return [
    'Usage: node scripts/build-phone-control-native.mjs [options]',
    '',
    '  --abis <a,b>          ABIs to build (arm64-v8a, x86_64); default: both',
    '  --out <dir>           Output root; default app/build/generated/phone-control-jni',
    '  --ndk <path>          NDK root or SDK ndk directory; default: pinned config version',
    '  --host-toolchain <t>  Installed rustup toolchain for proc macros',
    '  --install-targets     Install missing Android std targets for the pinned toolchain',
    '  --verify              Verify existing .so files and manifests; no cargo',
    '  --jni-out <dir>       With --verify: stage only selected .so files for AGP',
    '  --self-test           Run offline config, argument and ELF checks',
  ].join('\n')
}

function selfTestElf(abi, align = 16384) {
  const buffer = Buffer.alloc(256)
  buffer.write('\x7fELF', 0, 'binary')
  buffer[4] = 2
  buffer[5] = 1
  buffer[6] = 1
  buffer.writeUInt16LE(3, 16)
  buffer.writeUInt16LE(ELF_MACHINES[abi], 18)
  buffer.writeUInt32LE(1, 20)
  buffer.writeBigUInt64LE(64n, 32)
  buffer.writeUInt16LE(64, 52)
  buffer.writeUInt16LE(56, 54)
  buffer.writeUInt16LE(2, 56)
  buffer.writeUInt32LE(1, 64)
  buffer.writeBigUInt64LE(BigInt(align), 64 + 48)
  buffer.writeUInt32LE(2, 64 + 56)
  return buffer
}

export async function runSelfTest() {
  const config = loadBuildConfig()
  if (config.rustcVersion !== '1.99.0' || config.ndkVersion !== '27.0.12077973' || config.apiLevel !== 26) {
    throw new Error('self-test: config pins drifted')
  }
  parseArgs(['--abis', 'arm64-v8a,x86_64'])
  let rejected = 0
  for (const argv of [['--bogus'], ['--abis', 'mips'], ['--abis', ''], ['--out']]) {
    try { parseArgs(argv) } catch { rejected += 1 }
  }
  if (rejected !== 4) throw new Error(`self-test: expected 4 argument rejections, got ${rejected}`)
  verifyElf(selfTestElf('arm64-v8a'), { abi: 'arm64-v8a' })
  let wrongMachines = 0
  try { verifyElf(selfTestElf('x86_64'), { abi: 'arm64-v8a' }) } catch { wrongMachines += 1 }
  if (wrongMachines !== 1) throw new Error('self-test: wrong ELF machine was accepted')
  let smallPages = 0
  try { verifyElf(selfTestElf('x86_64', 4096), { abi: 'x86_64' }) } catch { smallPages += 1 }
  if (smallPages !== 1) throw new Error('self-test: 4 KiB-aligned ELF was accepted')
  let notElf = 0
  try { verifyElf(Buffer.alloc(128), { abi: 'x86_64' }) } catch { notElf += 1 }
  if (notElf !== 1) throw new Error('self-test: non-ELF bytes were accepted')
  process.stdout.write('phone-control native: self-test ok\n')
}

/** Run the CLI and return an exit code; used by tests to check non-zero paths. */
export async function runCli(argv, deps = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    if (options.selfTest) {
      await runSelfTest()
      return 0
    }
    const config = deps.config ?? loadBuildConfig(options.apkDir)
    const abis = options.abis ?? SUPPORTED_ABIS
    const result = await buildPhoneControlNative({ ...options, abis, config, log: (line) => process.stdout.write(`${line}\n`) }, deps)
    if (options.verify) process.stdout.write('phone-control native: verify ok\n')
    else process.stdout.write(`phone-control native: built ${result.built.length} ABI(s) into ${result.outDir}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`phone-control native: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
