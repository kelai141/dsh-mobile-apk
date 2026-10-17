#!/usr/bin/env node
/**
 * Android PTC native launch adaptation for @deepseek-ai/dsh-ptc-runtime-node 0.2.1-rc.2.
 * Usage: node scripts/patches/ptc-android-native-A1.mjs <runtime-package-root> [--apply|--check] [--source]
 * Default: check lib/index.js + lib/process.js. --source targets a disposable source copy.
 * No policy defaults, approval paths, sandbox providers, or public configuration are changed.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
export const PATCH_ID = 'ptc-android-native-A1'
export const ENV_MARKER = 'dsh-mobile PTC Android native environment (A1)'
export const LAUNCH_MARKER = 'dsh-mobile PTC Android linker prefix (A1)'
const PACKAGE_NAME = '@deepseek-ai/dsh-ptc-runtime-node'
const PACKAGE_VERSION = '0.2.1-rc.2'
const BASE_ENV_NAMES = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
/** Exact host-owned native settings; no TERMUX_* wildcard, credentials, HOME, or DSH_* inheritance. */
export const ANDROID_ENV_NAMES = Object.freeze([
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE', 'TERMUX_EXEC__EXECVE_CALL__INTERCEPT',
  'TERMUX__ROOTFS', 'TERMUX__PREFIX', 'TERMUX_APP__DATA_DIR', 'TERMUX_APP__LEGACY_DATA_DIR',
  'TMPDIR', 'OPENSSL_CONF', 'SSL_CERT_FILE',
])
/** Shared JS implementation; source mode adds only the TypeScript signature. */
export const LAUNCH_HELPER_JS = String.raw`// dsh-mobile PTC Android linker prefix (A1)
function dshMobilePtcLaunchPrefix(executable) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw new Error('ptc-runtime-node: resolved Node executable must be absolute');
  }
  const isLinker = /^(?:ld\.so(?:\.[0-9]+)*|linker(?:64)?)$/.test(executable.slice(executable.lastIndexOf('/') + 1));
  if (process.platform !== 'android') {
    if (isLinker) throw new Error('ptc-runtime-node: a dynamic linker is not a Node executable on this platform');
    return [executable];
  }
  const linkers = ['/system/bin/linker64', '/apex/com.android.runtime/bin/linker64'];
  if (isLinker && !linkers.includes(executable)) {
    throw new Error('ptc-runtime-node: Android Node launcher must use a trusted system linker64 path');
  }
  const prefix = process.env.TERMUX__PREFIX;
  if (typeof prefix !== 'string' || !isAbsolute(prefix) || prefix.includes('\0') || prefix.split('/').includes('..')) {
    throw new Error('ptc-runtime-node: Android requires the host TERMUX__PREFIX absolute snapshot path');
  }
  const node = prefix.replace(/\/+$/, '') + '/bin/node';
  const wrapper = prefix.replace(/\/+$/, '') + '/libexec/dsh-node';
  // The shipped C1 wrapper is exactly linker64 + this node binary, not a separate runtime.
  // Custom wrappers retain their launch semantics; never pass a shell script to the linker.
  if (!isLinker && executable !== node && executable !== wrapper) return [executable];
  const linker = isLinker ? executable : linkers.includes(process.execPath) ? process.execPath : linkers[0];
  return [linker, node];
}
`
function fail(message) { throw new Error(PATCH_ID + ': ' + message) }
function oneMatch(text, pattern, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))]
  if (matches.length !== 1) fail(label + ': expected exactly one anchor, got ' + matches.length)
  return matches[0]
}
function replaceMatch(text, match, replacement) {
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length)
}
function environmentDeclaration(source) {
  return '// ' + ENV_MARKER + '\n'
    + (source ? 'export ' : '') + 'const STARTUP_ENVIRONMENT_NAMES' + (source ? ': ReadonlySet<string>' : '') + ' = new Set([\n'
    + BASE_ENV_NAMES.map(name => '  ' + JSON.stringify(name) + ',').join('\n') + '\n'
    + '  ...(process.platform === "android" ? [\n'
    + ANDROID_ENV_NAMES.map(name => '    ' + JSON.stringify(name) + ',').join('\n') + '\n'
    + '  ] : []),\n]);'
}
/** Expand only the Android OS startup allowlist shared by host and child bootstrap. */
export function patchEnvironment(text, source = false) {
  const expected = environmentDeclaration(source)
  if (text.includes(ENV_MARKER)) {
    if (!text.includes(expected) || text.split(ENV_MARKER).length !== 2) fail('incomplete or modified native environment patch')
    return text
  }
  const match = oneMatch(text, /(?:export )?const STARTUP_ENVIRONMENT_NAMES(?:\s*:\s*ReadonlySet<string>)?\s*=\s*new Set\((\[[\s\S]*?\])\);?/, 'startup environment')
  const names = [...match[1].matchAll(/['"]([A-Z_]+)['"]/g)].map(m => m[1])
  if (JSON.stringify(names) !== JSON.stringify(BASE_ENV_NAMES)) fail('startup environment differs from reviewed upstream')
  return replaceMatch(text, match, expected)
}
/** Reject policy drift: only the existing resolved full-access mode skips confinement. */
export function assertPolicyGate(text) {
  // 0.14.8（0.2.1-rc.2）：index 里现在有两条 spawn 路径（一次执行 + 持久 PTC），两处都必须
  // 仍是「只有 resolved full-access 才跳过 confine」。判据改为自校准计数：已审阅判据的出现次数
  // 必须等于 this.ctx.sandbox.confine(argv, 的出现次数（两者都 > 0）——单点弱化或上游新增
  // 未审阅 spawn 路径都会判红，要求人工复核，而不是被「至少一处」悄悄放行。
  const gates = [...text.matchAll(/confined = policy\.mode === (['"])danger-full-access\1 \? (?:undefined|void 0) : await this\.ctx\.sandbox\.confine\(argv,/g)]
  const spawnPaths = [...text.matchAll(/this\.ctx\.sandbox\.confine\(argv,/g)]
  if (gates.length === 0 || spawnPaths.length === 0) fail('resolved-policy confinement gate: expected reviewed anchors, got gates=' + gates.length + ', spawn paths=' + spawnPaths.length)
  if (gates.length !== spawnPaths.length) fail('resolved-policy confinement gate: every sandbox spawn path must share the reviewed gate (gates=' + gates.length + ', spawn paths=' + spawnPaths.length + ')')
  if (!/error instanceof SandboxUnavailableError \? (['"])sandbox-unavailable\1/.test(text)) fail('sandbox-unavailable classification absent')
  if (!/argv:\s*confined\?\.argv \?\? argv/.test(text)) fail('spawn no longer consumes enforcing argv')
}
/** The OS allowlist must not expose host environment values to model-authored JS. */
export function assertChildClearing(text, source = false) {
  // 0.14.8（0.2.1-rc.2）：上游把清环境体拆到 environment.ts 的 clearProgramEnvironment(state)，
  // 源码面只剩一次调用；产物面（tsdown 内联）仍是 state.env 的 deleteProperty + 空原型替换。
  if (source) {
    if (!/clearProgramEnvironment\(processState\)/.test(text)) fail('reviewed child environment clearing is absent')
    return
  }
  if (!/!STARTUP_ENVIRONMENT_NAMES\.has\(key\.toUpperCase\(\)\)/.test(text)
    || !/Reflect\.deleteProperty\(state\.env, key\)/.test(text)
    || !/state\.env = Object\.create\(null\)/.test(text)) fail('reviewed child environment clearing is absent')
}
function helper(source) {
  return source ? LAUNCH_HELPER_JS.replace('function dshMobilePtcLaunchPrefix(executable)', 'function dshMobilePtcLaunchPrefix(executable: string): string[]') : LAUNCH_HELPER_JS
}
function launchBlock(indent, source) {
  const absent = source ? 'undefined' : 'void 0'
  const tick = String.fromCharCode(96)
  return [
    'const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, ' + absent + ', signal);',
    'if (settled) return await result.promise;',
    'const launchPrefix = dshMobilePtcLaunchPrefix(executable);',
    'if (launchPrefix.length === 2) {',
    '  launchPrefix[1] = await this.ctx.subprocess.resolveExecutable(launchPrefix[1], ' + absent + ', signal);',
    '  if (settled) return await result.promise;',
    '}',
    "const packaged = this.config.launch.kind === " + (source ? "'embedded'" : '"embedded"') + ';',
    'const heapFlag = ' + tick + '--max-old-space-size=$' + '{this.config.maxOldGenerationSizeMb}' + tick + ';',
    '// Heap options belong to Node, never between linker64 and its absolute program path.',
    'const argv = [...launchPrefix, ...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)];',
  ].map(line => indent + line).join('\n')
}
/** Replace the reviewed launch block, including the old L1 guard if it was applied first. */
export function patchRuntimeIndex(text, source = false) {
  assertPolicyGate(text)
  if (text.includes(LAUNCH_MARKER)) {
    if (!text.includes(helper(source)) || text.split(LAUNCH_MARKER).length !== 2) fail('incomplete or modified launch helper')
    const launch = oneMatch(text, /^([\t ]*)const executable = await this\.ctx\.subprocess\.resolveExecutable\(this\.config\.launch\.executable,[\s\S]*?\n\1const argv = \[\.\.\.launchPrefix,[^\n]*\];/m, 'patched launch block')
    if (launch[0] !== launchBlock(launch[1], source)) fail('modified native launch block')
    oneMatch(text, /env\.NODE_OPTIONS = heapFlag;/, 'owned heap flag')
    if (/if \(packaged\) \{[^}]*env\.NODE_OPTIONS = heapFlag/.test(text)) fail('heap flag is still packaged-only')
    return text
  }
  const launch = oneMatch(text, /^([\t ]*)const executable = await this\.ctx\.subprocess\.resolveExecutable\(this\.config\.launch\.executable, (?:undefined|void 0), signal\);?[\s\S]*?\n\1const argv = \[[\s\S]*?\];?\n/m, 'upstream Node launch block')
  if (!/if \(settled\) return await result\.promise/.test(launch[0])
    || !/const packaged = this\.config\.launch\.kind === (['"])embedded\1/.test(launch[0])
    || !/const heapFlag = \u0060--max-old-space-size=\$\{this\.config\.maxOldGenerationSizeMb\}\u0060/.test(launch[0])
    || !/bootstrapArgs\(this\.ctx\.fs, this\.config\.launch, this\.config\.maxMessageBytes\)/.test(launch[0])) fail('launch block differs from reviewed upstream')
  const noComments = launch[0].replace(/^[\t ]*\/\/[^\n]*\n/gm, '')
  if (/\b(?:spawn|confine|catch|policy|env)\b/.test(noComments)) fail('unexpected statements in launch block')
  const oldLinkerGuard = launch[0].includes('resolved node executable is the system dynamic linker')
  if (launch[0].includes('__dshMobileExecBase') !== oldLinkerGuard) fail('unrecognized legacy executable guard')
  text = replaceMatch(text, launch, launchBlock(launch[1], source) + '\n')
  const nested = /^([\t ]*)if \(packaged\) \{\n\1[\t ]+env\.DSH_PTC_RUNTIME_NODE = (['"])1\2;?\n\1[\t ]+env\.NODE_OPTIONS = heapFlag;?\n\1\};?/m.exec(text)
  if (nested) text = replaceMatch(text, nested, nested[1] + 'env.NODE_OPTIONS = heapFlag;\n' + nested[1] + 'if (packaged) {\n' + nested[1] + '  env.DSH_PTC_RUNTIME_NODE = "1";\n' + nested[1] + '}')
  else if (!/env\.NODE_OPTIONS = heapFlag;/.test(text)) fail('owned heap flag anchor absent')
  const insertion = oneMatch(text, /^const STRIP_PREFIX\s*=/m, 'module helper insertion')
  text = text.slice(0, insertion.index) + helper(source) + '\n' + text.slice(insertion.index)
  assertPolicyGate(text)
  return patchRuntimeIndex(text, source)
}
function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
function rejectReadonlyCheckout(root) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  for (const base of [repository, resolve(repository, '..')]) {
    for (const name of ['dsh', '.deploy-tmp/upstream-020rc2']) {
      const checkout = resolve(base, name)
      if (existsSync(checkout) && isWithin(realpathSync(checkout), root)) fail('refusing to modify read-only upstream checkout: ' + checkout)
    }
  }
}
/** Preflight all files before writes; anchor/version failures leave the target untouched. */
export function planPatch(packageRoot, source = false, read = name => readFileSync(resolve(packageRoot, name), 'utf8')) {
  const manifest = JSON.parse(read('package.json'))
  if (manifest.name !== PACKAGE_NAME || manifest.version !== PACKAGE_VERSION) fail('requires ' + PACKAGE_NAME + '@' + PACKAGE_VERSION)
  const names = source ? ['src/environment.ts', 'src/index.ts', 'src/process.ts'] : ['lib/index.js', 'lib/process.js']
  const originals = new Map(names.map(name => [name, read(name)]))
  const outputs = new Map(originals)
  if (source) {
    assertChildClearing(originals.get('src/process.ts'), true)
    outputs.set('src/environment.ts', patchEnvironment(originals.get('src/environment.ts'), true))
    outputs.set('src/index.ts', patchRuntimeIndex(originals.get('src/index.ts'), true))
  } else {
    assertChildClearing(originals.get('lib/process.js'))
    outputs.set('lib/index.js', patchRuntimeIndex(patchEnvironment(originals.get('lib/index.js'))))
    outputs.set('lib/process.js', patchEnvironment(originals.get('lib/process.js')))
  }
  return [...outputs].map(([name, after]) => ({ name, before: originals.get(name), after }))
}
function main(argv) {
  const source = argv.includes('--source')
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  const roots = argv.filter(arg => !arg.startsWith('--'))
  if (roots.length !== 1 || (apply && check) || argv.some(arg => arg.startsWith('--') && !['--source', '--apply', '--check'].includes(arg))) {
    console.error('Usage: node ptc-android-native-A1.mjs <runtime-package-root> [--apply|--check] [--source]')
    return 2
  }
  const root = realpathSync(resolve(roots[0]))
  if (apply) rejectReadonlyCheckout(root)
  const plan = planPatch(root, source)
  const missing = plan.filter(file => file.before !== file.after)
  if (!apply && missing.length > 0) {
    console.error(PATCH_ID + ': absent/incomplete: ' + missing.map(file => file.name).join(', '))
    return 1
  }
  if (apply) {
    for (const file of missing) {
      const target = resolve(root, file.name)
      const info = lstatSync(target)
      if (!info.isFile() || info.nlink !== 1 || !isWithin(root, realpathSync(target))) fail('target is linked or escapes runtime package: ' + file.name)
    }
    for (const file of missing) writeFileSync(resolve(root, file.name), file.after, 'utf8')
    if (planPatch(root, source).some(file => file.before !== file.after)) fail('post-write check failed; discard this build stage')
  }
  console.log(PATCH_ID + ': ' + (apply ? 'applied/verified' : 'verified') + ' (' + (source ? 'source copy' : 'built host + child') + ')')
  return 0
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
