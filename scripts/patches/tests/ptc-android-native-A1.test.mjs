/** Regressions against the published 0.2.1-rc.2 runtime library. No child processes, devices, network, or runtime probes. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import {
  ANDROID_ENV_NAMES, LAUNCH_HELPER_JS, assertChildClearing, assertPolicyGate,
  patchEnvironment, patchRuntimeIndex, planPatch,
} from '../ptc-android-native-A1.mjs'

const fixture = new URL('./fixtures/dsh-ptc-runtime-node-0.2.1-rc.2/', import.meta.url)
const read = name => readFileSync(new URL(name, fixture), 'utf8')
const rawIndex = read('lib/index.js')
const rawChild = read('lib/process.js')
const environment = patchEnvironment(rawIndex)
const index = patchRuntimeIndex(environment)
const child = patchEnvironment(rawChild)
const prefix = '/data/data/com.dsharnessmobile.shell/files/usr'
const node = prefix + '/bin/node'
const wrapper = prefix + '/libexec/dsh-node'
const native = {
  TERMUX__PREFIX: prefix, TERMUX__ROOTFS: prefix.slice(0, -4),
  LD_PRELOAD: prefix + '/lib/libtermux-exec-ld-preload.so', LD_LIBRARY_PATH: prefix + '/lib',
  TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE: 'force', TERMUX_EXEC__EXECVE_CALL__INTERCEPT: '1',
  TERMUX_APP__DATA_DIR: '/data/user/0/com.dsharnessmobile.shell',
  TERMUX_APP__LEGACY_DATA_DIR: '/data/data/com.dsharnessmobile.shell',
  TMPDIR: '/data/data/com.dsharnessmobile.shell/files/home/tmp',
  OPENSSL_CONF: prefix + '/etc/tls/openssl.cnf', SSL_CERT_FILE: prefix + '/etc/tls/cert.pem',
}
function environmentSet(platform) {
  const declaration = environment.match(/const STARTUP_ENVIRONMENT_NAMES = new Set\([\s\S]*?\);/)
  assert.ok(declaration, 'published runtime startup environment declaration exists')
  return runInNewContext(declaration[0] + '\nSTARTUP_ENVIRONMENT_NAMES;', { process: { platform } })
}
function choose(executable, options = {}) {
  return Array.from(runInNewContext(LAUNCH_HELPER_JS + '\ndshMobilePtcLaunchPrefix(executable);', {
    executable, isAbsolute: posix.isAbsolute,
    process: { platform: options.platform ?? 'android', execPath: options.execPath ?? '/system/bin/linker64', env: options.env ?? native },
  }))
}
// 0.2.1 上游 index 里有两条 spawn 路径（一次执行 + 持久 PTC）。A1 只替换「一次执行」的 launch 段；
// 该段的 signal 是形参 signal，持久路径写的是 this.controller.signal。按这条精确锚点取段，避免整段误取。
const PER_CALL_LAUNCH = /^[\t ]*const executable = await this\.ctx\.subprocess\.resolveExecutable\(this\.config\.launch\.executable, void 0, signal\);[\s\S]*?^[\t ]*const launched = handle;$/m
function perCallLaunch() {
  const matches = [...index.matchAll(new RegExp(PER_CALL_LAUNCH.source, PER_CALL_LAUNCH.flags + 'g'))]
  assert.equal(matches.length, 1, 'per-call launch segment: expected exactly one anchor, got ' + matches.length)
  return matches[0][0]
}
/** 只执行补丁后的「一次执行」launch 段，用假的 subprocess/sandbox 服务观察行为。 */
async function launch(mode, options = {}) {
  const segment = perCallLaunch()
  assert.ok(segment.includes('this.ctx.subprocess.spawn'))
  assert.ok(segment.includes('dshMobilePtcLaunchPrefix(executable)'), 'launch must go through the A1 linker prefix helper')
  const launchConfig = options.launch ?? { kind: 'node-script', executable: options.executable ?? wrapper }
  const calls = { spawn: [], confine: [], resolved: [], bootstrap: [] }
  const policy = { mode, workspaceRoot: '/workspace' }
  const context = {
    ctx: {
      fs: {},
      subprocess: {
        async resolveExecutable(executable) { calls.resolved.push(executable); return executable },
        spawn(spec) { calls.spawn.push(spec); return { fake: true } },
      },
      sandbox: {
        async confine(argv, suppliedPolicy) {
          calls.confine.push({ argv: Array.from(argv), policy: suppliedPolicy })
          if (options.unavailable) throw options.unavailable
          return { argv: ['enforcing-runner', '--', ...argv], enforcement: 'full' }
        },
      },
    },
    config: {
      launch: launchConfig,
      maxOldGenerationSizeMb: 512,
      maxMessageBytes: 1234,
      graceMs: 3000,
    },
    // 上游 0.2.1 的 bootstrapArgs(fs, launch, maxMessageBytes)：第三段参数已经是 resolved launch。
    bootstrapArgs(fs, launch, maxMessageBytes) {
      calls.bootstrap.push({ fs, launch, maxMessageBytes })
      return launch.kind === 'embedded' ? [String(maxMessageBytes)] : ['/runtime/process.js', String(maxMessageBytes)]
    },
  }
  const js = '(async function () {\n' + segment + '\nreturn { handle, sandbox };\n})'
  const fn = runInNewContext(LAUNCH_HELPER_JS + '\n' + js, {
    isAbsolute: posix.isAbsolute,
    process: { platform: 'android', execPath: '/system/bin/linker64', env: { PATH: prefix + '/bin:/system/bin', ...native, DEEPSEEK_API_KEY: 'fixture-secret', DSH_PICK_TOKEN: 'fixture-token', NODE_OPTIONS: '--inspect=0' } },
    STARTUP_ENVIRONMENT_NAMES: environmentSet('android'),
    bootstrapArgs: context.bootstrapArgs,
    policy, signal: undefined, settled: false, result: {}, confined: undefined, handle: undefined,
    spec: { cwd: '/workspace' }, sandbox: { mode, denied: false },
  })
  try { return { calls, result: await fn.call(context) } }
  catch (error) { return { calls, error } }
}

test('published 0.2.1-rc.2 library patch is idempotent and preflights the unchanged child', () => {
  assert.equal(patchRuntimeIndex(index), index)
  assert.equal(patchEnvironment(environment), environment)
  assertChildClearing(child)
  const plan = planPatch(fileURLToPath(fixture))
  assert.deepEqual(plan.filter(file => file.before !== file.after).map(file => file.name), ['lib/index.js', 'lib/process.js'])
  assert.equal(read('lib/index.js'), rawIndex)
})
test('Android retains exactly the native settings; other platforms retain the original six names', () => {
  const android = environmentSet('android')
  for (const key of ANDROID_ENV_NAMES) assert.equal(android.has(key), true, key)
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(Array.from(environmentSet(platform)), ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])
  }
  for (const key of ['HOME', 'DEEPSEEK_API_KEY', 'DSH_PICK_TOKEN', 'NODE_OPTIONS', 'TERMUX_UNKNOWN_SECRET']) assert.equal(android.has(key), false, key)
})
test('both real linker64 locations, direct node, and shipped C1 wrapper preserve linker-before-node ordering', () => {
  for (const linker of ['/system/bin/linker64', '/apex/com.android.runtime/bin/linker64']) {
    assert.deepEqual(choose(linker), [linker, node])
    assert.deepEqual(choose(node, { execPath: linker }), [linker, node])
    assert.deepEqual(choose(wrapper, { execPath: linker }), [linker, node])
  }
  assert.deepEqual(choose('/custom/node-wrapper'), ['/custom/node-wrapper'])
  assert.deepEqual(choose(node, { execPath: node }), ['/system/bin/linker64', node])
})
test('unknown linkers and invalid/missing prefixes fail loudly without guessing a target', () => {
  for (const executable of ['/tmp/linker64', '/system/bin/linker', '/tmp/ld.so.1', 'node']) assert.throws(() => choose(executable))
  for (const env of [{}, { TERMUX__PREFIX: 'relative' }, { TERMUX__PREFIX: '/snapshot/../usr' }, { TERMUX__PREFIX: '/snapshot\0/usr' }]) assert.throws(() => choose(node, { env }))
  assert.throws(() => choose('/system/bin/linker64', { platform: 'linux' }))
  assert.deepEqual(choose('/usr/bin/node', { platform: 'linux' }), ['/usr/bin/node'])
})
test('resolved full-access policy alone permits native spawn and does not inherit loader/inspector secrets', async () => {
  for (const executable of [node, wrapper]) {
    const run = await launch('danger-full-access', { executable })
    assert.equal(run.error, undefined)
    assert.equal(run.calls.confine.length, 0)
    assert.equal(run.calls.spawn.length, 1)
    // 0.2.1：wrapper 与直连 node 都解析成「linker64 + node」两段，再逐段解析可执行文件。
    assert.deepEqual(run.calls.resolved, [executable, node])
    const spec = run.calls.spawn[0]
    assert.deepEqual(Array.from(spec.argv), ['/system/bin/linker64', node, '/runtime/process.js', '1234'])
    assert.equal(spec.env.NODE_OPTIONS, '--max-old-space-size=512')
    assert.equal(Object.hasOwn(spec.env, 'DSH_PTC_RUNTIME_NODE'), false, 'node-script launch must not claim the embedded marker')
    for (const key of ANDROID_ENV_NAMES) assert.equal(Object.hasOwn(spec.env, key), false, key + ' must not be tombstoned')
    assert.equal(spec.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(spec.env.DSH_PICK_TOKEN, undefined)
    assert.equal(spec.stdio.control, 'pipe')
    assert.equal(spec.cwd, '/workspace')
    // 上游 0.2.1 的 bootstrapArgs 第三段参数是 resolved launch，不再是旧版 this.config。
    assert.equal(run.calls.bootstrap.length, 1)
    assert.deepEqual(run.calls.bootstrap[0].launch, { kind: 'node-script', executable })
    assert.equal(run.calls.bootstrap[0].maxMessageBytes, 1234)
  }
})
test('embedded launch keeps its shipped marker while the heap flag moves into the child environment', async () => {
  const embedded = '/opt/dsh/embedded-node'
  const run = await launch('danger-full-access', { launch: { kind: 'embedded', executable: embedded } })
  assert.equal(run.error, undefined)
  assert.deepEqual(run.calls.resolved, [embedded])
  const spec = run.calls.spawn[0]
  assert.deepEqual(Array.from(spec.argv), [embedded, '1234'])
  assert.equal(spec.env.NODE_OPTIONS, '--max-old-space-size=512')
  assert.equal(spec.env.DSH_PTC_RUNTIME_NODE, '1')
  // 0.2.1 的 packaged 判据改为 launch.kind === "embedded"（旧判据 'pkg' in process 已不存在）。
  assert.deepEqual(run.calls.bootstrap[0].launch, { kind: 'embedded', executable: embedded })
})
test('restricted policies never spawn when the sandbox is unavailable; no unconfined retry', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const unavailable = new Error('SANDBOX_UNAVAILABLE fixture')
    const run = await launch(mode, { unavailable })
    assert.equal(run.error, unavailable)
    assert.equal(run.calls.confine.length, 1)
    assert.equal(run.calls.confine[0].policy.mode, mode)
    assert.deepEqual(run.calls.confine[0].argv, ['/system/bin/linker64', node, '/runtime/process.js', '1234'])
    assert.equal(run.calls.spawn.length, 0)
  }
  assertPolicyGate(index)
})
test('an enforcing provider keeps its complete argv and honest enforcement metadata', async () => {
  const run = await launch('workspace-write')
  assert.equal(run.error, undefined)
  assert.deepEqual(Array.from(run.calls.spawn[0].argv), ['enforcing-runner', '--', '/system/bin/linker64', node, '/runtime/process.js', '1234'])
  assert.equal(run.result.sandbox.enforcement, 'full')
  assert.equal(run.result.sandbox.mode, 'workspace-write')
})
test('published child retains only native OS values while the model-facing process.env stays empty', () => {
  const osEnv = { ...native, PATH: prefix + '/bin', DEEPSEEK_API_KEY: 'fixture-secret', DSH_PICK_TOKEN: 'fixture-token', NODE_OPTIONS: '--max-old-space-size=512' }
  const processState = { env: osEnv }
  // 0.2.1 把清环境体收进 environment.ts 的 clearProgramEnvironment(state)，产物面仍内联在 process.js。
  const clearing = /^function clearProgramEnvironment\(state\) \{\n[\s\S]*?\n\}/m.exec(child)?.[0]
  assert.ok(clearing, 'published child contains its startup environment clearing boundary')
  assert.match(child, /clearProgramEnvironment\(processState\);/, 'startup clears the child program environment before evaluating code')
  runInNewContext(clearing + '\nclearProgramEnvironment(processState);', { processState, STARTUP_ENVIRONMENT_NAMES: environmentSet('android') })
  assert.deepEqual(Object.keys(processState.env), [])
  assert.equal(Object.getPrototypeOf(processState.env), null)
  for (const key of ANDROID_ENV_NAMES) assert.equal(osEnv[key], native[key])
  for (const key of ['DEEPSEEK_API_KEY', 'DSH_PICK_TOKEN', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(osEnv, key), false)
})
test('both reviewed spawn paths keep the resolved-policy confinement gate in the same shape', () => {
  const gate = /confined = policy\.mode === "danger-full-access" \? void 0 : await this\.ctx\.sandbox\.confine\(argv,/g
  // 0.2.1 有两条 spawn 路径（一次执行 + 持久 PTC）；两处都必须保留「只有 resolved full-access 才跳过 confine」。
  assert.equal([...index.matchAll(gate)].length, 2, 'both reviewed spawn paths keep the confinement gate')
  assert.equal([...index.matchAll(/this\.ctx\.sandbox\.confine\(/g)].length, 2, 'every sandbox.confine call site is a reviewed spawn path')
  assertPolicyGate(index)
})
test('anchor, marker, heap placement, and sandbox-policy drift are rejected', () => {
  assert.throws(() => patchEnvironment(rawIndex.replace('"TMP"', '"TMPDIR"')))
  assert.throws(() => patchEnvironment(environment.replace('"LD_PRELOAD"', '"EVIL_PRELOAD"')))
  assert.throws(() => patchRuntimeIndex(rawIndex.replaceAll('policy.mode === "danger-full-access"', 'policy.mode === "workspace-write"')), /resolved-policy confinement gate/)
  // 自校准计数（assertPolicyGate）：单点弱化（另一处仍命中）与新增未审阅 spawn 路径都必须判红。
  assert.throws(() => assertPolicyGate(rawIndex.replace('policy.mode === "danger-full-access"', 'policy.mode === "workspace-write"')), /every sandbox spawn path/)
  assert.throws(() => assertPolicyGate(index + '\nconst unrevisedSpawn = () => this.ctx.sandbox.confine(argv, {});\n'), /every sandbox spawn path/)
  assert.throws(() => patchRuntimeIndex(rawIndex.replace('const packaged = this.config.launch.kind === "embedded";', 'const packaged = "pkg" in process && this.config.launch.bootstrapPath === void 0;')), /launch block differs from reviewed upstream/)
  assert.throws(() => patchRuntimeIndex(rawIndex.replace('bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)', 'bootstrapArgs(this.ctx.fs, this.config, this.config.maxMessageBytes)')), /launch block differs from reviewed upstream/)
  assert.throws(() => patchRuntimeIndex(index.replace('...launchPrefix,', '...launchPrefix, heapFlag,')))
  assert.throws(() => assertChildClearing(child.replace('state.env = Object.create(null)', 'state.env = {}')))
})
test('old published artifact is rejected by the version preflight; both compiled void 0/undefined spellings are accepted', () => {
  const oldFixture = new URL('./fixtures/dsh-ptc-runtime-node-0.2.0-rc.2/', import.meta.url)
  // 旧夹具只读参考：0.2.0 产物还写着 nodeExecutable，版本预检必须先判红，不能拿旧产物冒充新引擎。
  const oldIndex = readFileSync(new URL('lib/index.js', oldFixture), 'utf8')
  assert.equal(JSON.parse(readFileSync(new URL('package.json', oldFixture), 'utf8')).version, '0.2.0-rc.2')
  assert.match(oldIndex, /this\.config\.nodeExecutable/)
  assert.throws(() => planPatch(fileURLToPath(oldFixture)), /requires @deepseek-ai\/dsh-ptc-runtime-node@0\.2\.1-rc\.2/)
  // 编译产物里同一条 launch 段有 void 0 与 undefined 两种写法；A1 必须归一成同一份补丁产物。
  const reworded = rawIndex.replace(
    'resolveExecutable(this.config.launch.executable, void 0, signal);',
    'resolveExecutable(this.config.launch.executable, undefined, signal);')
  assert.notEqual(reworded, rawIndex, '替换必须真的发生，否则下面的判据是空转')
  const rebuilt = patchRuntimeIndex(patchEnvironment(reworded))
  assert.equal(rebuilt, index)
  assertPolicyGate(rebuilt)
})
