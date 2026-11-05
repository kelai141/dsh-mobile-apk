#!/usr/bin/env node
// Check all known Android native loaders and inventory packaged native modules.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const within = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const acknowledgedFamilies = [
  /^@img\+sharp-linux-(?:x64|arm64)@0\.35\.5\//,
  /^@img\+sharp-wasm32@0\.35\.5\//,
  /^@koromix\+koffi-(?:android|linux)-(?:arm64|x64)@3\.2\.1\//,
  /^node-pty@1\.2\.0-beta\.15_.*\//,
  /^node-addon-require-builtin-linux-(arm64|x64)-gnu@0\.1\.(?:4|6)\/node_modules\/node-addon-require-builtin-linux-\1-gnu\/prebuilt\/linux-\1-gnu-napi-v9\.node$/,
  /^@deepseek-ai\+node-addon-system-linux-(?:arm64|x64)@.*\//,
  /^@trycua\+cua-driver-linux-(arm64|x64)-gnu@0\.28\.0\/node_modules\/@trycua\/cua-driver-linux-\1-gnu\/cua_driver_node_runtime\.node$/,
  /^@ubjs\+node-linux-(arm64|x64)-gnu@0\.31\.0-3\/node_modules\/@ubjs\/node-linux-\1-gnu\/uniffi-runtime-napi\.linux-\1-gnu\.node$/,
  /^sherpa-onnx-linux-(arm64|x64)@1\.13\.8\/node_modules\/sherpa-onnx-linux-\1\/sherpa-onnx\.node$/,
]
export const isReviewedNativePath = (path) => acknowledgedFamilies.some((pattern) => pattern.test(path))

function packageAt(engineRootPath, fromDir, name) {
  const parts = name.startsWith('@') ? name.split('/').slice(0, 2) : [name.split('/')[0]]
  let current = fromDir
  while (within(engineRootPath, current)) {
    const candidate = join(current, 'node_modules', ...parts)
    if (existsSync(join(candidate, 'package.json'))) {
      const physical = realpathSync(candidate)
      if (!within(engineRootPath, physical)) throw new Error(`${name} escapes the deployed engine tree`)
      return physical
    }
    const parent = dirname(current)
    if (parent === current || !within(engineRootPath, parent)) break
    current = parent
  }
  throw new Error(`${name} is not reachable from ${relative(engineRootPath, fromDir)}`)
}

function readPackage(dir, expectedName, expectedVersion) {
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(`${expectedName} package identity mismatch: ${manifest.name}@${manifest.version}`)
  }
  return { manifest, manifestSha256: sha256(readFileSync(manifestPath)) }
}

function filesUnder(dir, include = () => true) {
  const files = []
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && include(relative(dir, path).replaceAll(sep, '/'))) {
        files.push({
          path: relative(dir, path).replaceAll(sep, '/'),
          size: lstatSync(path).size,
          sha256: sha256(readFileSync(path)),
        })
      }
    }
  }
  walk(dir)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function checkAndroidNativeRuntimePackages(engineArg, reportArg) {
const engineRoot = realpathSync(resolve(engineArg))
const scopeRoot = join(engineRoot, 'node_modules', '@deepseek-ai')
const subprocessRoot = realpathSync(join(scopeRoot, 'dsh-subprocess-local'))
const win32ProcessRoot = realpathSync(join(scopeRoot, 'dsh-win32-process'))
const attachmentRoot = realpathSync(join(scopeRoot, 'dsh-attachment-local'))

const koffiConsumers = [
  ['@deepseek-ai/dsh-subprocess-local', subprocessRoot],
  ['@deepseek-ai/dsh-win32-process', win32ProcessRoot],
]
const koffiCopies = new Map()
for (const [consumer, consumerRoot] of koffiConsumers) {
  const koffiRoot = packageAt(engineRoot, consumerRoot, 'koffi')
  const { manifest } = readPackage(koffiRoot, 'koffi', '3.2.1')
  if (manifest.optionalDependencies?.['@koromix/koffi-android-arm64'] !== '3.2.1') {
    throw new Error('Koffi 3.2.1 does not declare its matching Android ARM64 package')
  }
  const platformRoot = resolve(koffiRoot, '..', '@koromix', 'koffi-android-arm64')
  const platformPackage = readPackage(platformRoot, '@koromix/koffi-android-arm64', '3.2.1')
  if (!koffiCopies.has(koffiRoot)) {
    const nativeFiles = filesUnder(platformRoot).filter((file) => file.path.endsWith('.node'))
    if (nativeFiles.length !== 1) throw new Error(`expected one Koffi Android native module, found ${nativeFiles.length}`)
    const nativePath = join(platformRoot, nativeFiles[0].path)
    const header = readFileSync(nativePath).subarray(0, 20)
    if (header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46
      || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183) {
      throw new Error('Koffi Android native module is not a little-endian AArch64 ELF file')
    }
    koffiCopies.set(koffiRoot, {
      package: { name: 'koffi', version: '3.2.1', manifestSha256: sha256(readFileSync(join(koffiRoot, 'package.json'))) },
      androidBinding: {
        name: '@koromix/koffi-android-arm64',
        version: platformPackage.manifest.version,
        manifestSha256: platformPackage.manifestSha256,
        files: filesUnder(platformRoot),
        nativeModule: nativeFiles[0],
        elfMachine: 'AArch64',
      },
    })
  }
  koffiCopies.get(koffiRoot).consumers ??= []
  koffiCopies.get(koffiRoot).consumers.push(consumer)
}

const sharpRoot = packageAt(engineRoot, attachmentRoot, 'sharp')
const sharpPackage = readPackage(sharpRoot, 'sharp', '0.35.5')
const sharpRequire = createRequire(join(sharpRoot, 'dist', 'sharp.mjs'))
const sharpWasmEntry = sharpRequire.resolve('@img/sharp-wasm32/sharp.node')
const sharpWasmRoot = realpathSync(dirname(sharpWasmEntry))
const sharpWasm = readPackage(sharpWasmRoot, '@img/sharp-wasm32', '0.35.5')
const emnapiRoot = packageAt(engineRoot, sharpWasmRoot, '@emnapi/runtime')
const emnapiPackage = JSON.parse(readFileSync(join(emnapiRoot, 'package.json'), 'utf8'))
const sharpLoader = readFileSync(join(sharpRoot, 'dist', 'sharp.mjs'), 'utf8')
if (!sharpLoader.includes('require("@img/sharp-wasm32/sharp.node")')) {
  throw new Error('Sharp loader no longer exposes the expected WASM fallback')
}

const ptyRoot = packageAt(engineRoot, subprocessRoot, 'node-pty')
const ptyPackage = readPackage(ptyRoot, 'node-pty', '1.2.0-beta.15')
const ptyRelative = 'prebuilds/android-arm64/pty.node'
const ptyPath = join(ptyRoot, ptyRelative)
if (!existsSync(ptyPath)) throw new Error(`node-pty is missing ${ptyRelative}`)
for (const shadow of ['build/Release/pty.node', 'build/Debug/pty.node']) {
  if (existsSync(join(ptyRoot, shadow))) throw new Error(`node-pty ${shadow} would shadow the Android module`)
}
const ptyBytes = readFileSync(ptyPath)
if (ptyBytes.length < 20 || ptyBytes[0] !== 0x7f || ptyBytes[1] !== 0x45 || ptyBytes[2] !== 0x4c
  || ptyBytes[3] !== 0x46 || ptyBytes[4] !== 2 || ptyBytes[5] !== 1 || ptyBytes.readUInt16LE(18) !== 183) {
  throw new Error('node-pty Android module is not a little-endian AArch64 ELF file')
}
const ptyLoader = readFileSync(join(ptyRoot, 'lib/utils.js'), 'utf8')
if (!ptyLoader.includes('process.platform') || !ptyLoader.includes('process.arch') || !ptyLoader.includes('prebuilds/')) {
  throw new Error('node-pty native loader no longer selects prebuilds/android-arm64')
}
const nativeInventory = filesUnder(join(engineRoot, 'node_modules', '.pnpm'),
  (path) => path.endsWith('.node') || path.endsWith('.node.wasm'))
// 空过守卫：清单为空时 `unreviewed.length === 0` 恒真，本判据会「因为什么都没找到」而判绿——
// 而采集面全空恰恰说明它失准了。采集根只有 `node_modules/.pnpm` 一处，且 filesUnder 显式跳过
// 符号链接，布局一变（物化后第一方载荷挪到顶层）就会收不到东西。node-pty / koffi / sharp 那三条
// 硬断言不受影响，被空过的是「未审阅家族不得入包」这条**完备性**声明。地板取 1 是保守的：
// 只要采集面还在工作，就必然远大于 1（实测 27）。
if (nativeInventory.length === 0) {
  throw new Error('native module inventory is empty: nothing collected under node_modules/.pnpm'
    + '（采集面失准 ⇒「未审阅家族不得入包」会空过；检查布局是否变化、或载荷是否已不在符号链接之外）')
}
const unreviewed = nativeInventory.filter((file) => !isReviewedNativePath(file.path))
if (unreviewed.length) throw new Error(`unreviewed native module families: ${unreviewed.map((file) => file.path).join(', ')}`)

const report = {
  target: 'android-arm64',
  nodePty: {
    package: { name: 'node-pty', version: ptyPackage.manifest.version, manifestSha256: ptyPackage.manifestSha256 },
    androidBinding: { path: ptyRelative, size: ptyBytes.length, sha256: sha256(ptyBytes), elfMachine: 'AArch64' },
    loader: 'lib/utils.js selects prebuilds/android-arm64 from process.platform and process.arch',
  },
  koffi: [...koffiCopies.values()],
  sharp: {
    package: { name: 'sharp', version: sharpPackage.manifest.version, manifestSha256: sharpPackage.manifestSha256 },
    wasmFallback: {
      name: sharpWasm.manifest.name,
      version: sharpWasm.manifest.version,
      manifestSha256: sharpWasm.manifestSha256,
      resolvedEntry: relative(engineRoot, sharpWasmEntry).replaceAll(sep, '/'),
      files: filesUnder(sharpWasmRoot),
    },
    emnapiRuntime: { name: emnapiPackage.name, version: emnapiPackage.version },
  },
  nativeInventory,
  platformExceptions: [
    { package: 'node-addon-require-builtin', reason: 'EngineManager starts Node with --expose-internals; Harness loader first uses that JavaScript path and catches absent optional native bindings.' },
    { package: '@deepseek-ai/node-addon-system', reason: 'The registered flock-android-F3 patch supplies Android single-process fallback; Linux system.node is not loaded.' },
    { package: '@trycua/cua-driver-linux-*-gnu', reason: 'Pinned Linux GNU binary packages are included by the cross-platform pnpm deployment; these files are inventoried but are not Android bindings.' },
    { package: '@ubjs/node-linux-*-gnu', reason: 'Pinned Linux GNU binary packages are included by the cross-platform pnpm deployment; these files are inventoried but are not Android bindings.' },
    { package: 'sherpa-onnx-linux-*', reason: 'Pinned Linux binary packages are included by the cross-platform pnpm deployment; these files are inventoried but are not Android bindings.' },
  ],
}
if (reportArg) writeFileSync(resolve(reportArg), JSON.stringify(report, null, 2) + '\n')
return report
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const [engineArg, reportArg] = process.argv.slice(2)
  if (!engineArg || !reportArg) {
    console.error('usage: node check-android-native-runtime-packages.mjs <deployed-engine-root> <report.json>')
    process.exit(2)
  }
  const report = checkAndroidNativeRuntimePackages(engineArg, reportArg)
  console.log(`Android native runtime audit passed: node-pty ${report.nodePty.package.version}, Koffi ${report.koffi.map((item) => item.androidBinding.version).join(', ')}, Sharp WASM ${report.sharp.wasmFallback.version}, ${report.nativeInventory.length} reviewed native payloads`)
}
