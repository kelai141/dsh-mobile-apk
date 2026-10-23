import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { createLinuxPluginHost, registerLinuxEnvironmentRoutes, checkLinuxEnvironmentAfterMobileChange, normalizeLinuxStatus, cordisScope } from '../lib/linux-environment.js'

const TOKEN = 'a'.repeat(32)
function makeBootstrap(overrides = {}) {
  const calls = []
  const state = { autoUpdateEnabled: false, currentMobileVersion: '0.14.9', installedLinuxVersion: null, operation: 'idle', ...overrides }
  return {
    calls, state,
    status: async () => ({ ...state }),
    checkForUpdates: async options => { calls.push(['check', options]); state.latestReleaseVersion = '1.2.0'; state.updateAvailable = true },
    install: async options => { calls.push(['install', options]); state.installedLinuxVersion = '1.2.0' },
    reinstall: async () => { calls.push(['reinstall']) },
    uninstall: async () => { calls.push(['uninstall']); state.installedLinuxVersion = null },
    setAutoUpdateEnabled: async enabled => { calls.push(['autoUpdate', enabled]); state.autoUpdateEnabled = enabled },
  }
}
/**
 * The bootstrap aborts an install with "The installed runtime plugin did not provide a runtime
 * manager" unless `hostResult.manager` (or `.service`) satisfies its own `install`/`uninstall`
 * check, so every activation in these tests has to hand one back.
 */
const makeManager = () => ({ install: async () => {}, uninstall: async () => {} })

function harness(bootstrap = makeBootstrap()) {  const routes = new Map()
  const disposers = []
  registerLinuxEnvironmentRoutes({
    webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect: register => { disposers.push(register()) },
    auth: () => ({ token: () => TOKEN }), bootstrap: () => bootstrap,
  })
  return {
    bootstrap, routes,
    dispose: () => disposers.forEach(fn => fn()),
    async call(action, { method = action === 'status' ? 'GET' : 'POST', body = { confirmed: true }, token = TOKEN, host = '127.0.0.1:4145' } = {}) {
      const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
      req.method = method
      req.headers = { host, 'x-dsh-control-token': token }
      const res = { code: 0, headers: {}, body: '', writeHead(code, headers) { this.code = code; this.headers = headers }, end(body = '') { this.body = body } }
      await routes.get('/api/android/linux-environment/' + action).handler(req, res)
      return { ...res, payload: res.body ? JSON.parse(res.body) : undefined }
    },
  }
}

test('all seven routes authenticate before any bootstrap action and enforce HTTP methods', async () => {
  const h = harness()
  assert.equal(h.routes.size, 7)
  for (const path of h.routes.keys()) {
    const action = path.split('/').at(-1)
    assert.equal((await h.call(action, { token: '' })).code, 401)
    assert.equal((await h.call(action, { host: 'evil.example' })).code, 403)
    const response = await h.call(action, { method: action === 'status' ? 'POST' : 'GET' })
    assert.equal(response.code, 405)
    assert.equal(response.headers.allow, action === 'status' ? 'GET' : 'POST')
  }
  assert.deepEqual(h.bootstrap.calls, [])
  h.dispose()
  assert.equal(h.routes.size, 0)
})

test('mutations require bounded explicit confirmation; manual check never installs', async () => {
  const h = harness()
  for (const action of ['install', 'reinstall', 'uninstall', 'auto-update-on', 'auto-update-off']) {
    for (const body of [{}, { confirmed: 'true' }, '{', 'x'.repeat(1025)]) assert.equal((await h.call(action, { body })).code, 400)
  }
  assert.deepEqual(h.bootstrap.calls, [])
  const response = await h.call('check', { body: {} })
  assert.equal(response.code, 200)
  assert.equal(response.payload.availableVersion, '1.2.0')
  assert.deepEqual(h.bootstrap.calls, [['check', { source: 'manual' }]])
  assert.equal(response.payload.installed, false)
  await h.call('auto-update-on')
  assert.equal(h.bootstrap.state.autoUpdateEnabled, true)
  assert.equal(h.bootstrap.calls.length, 2, 'enabling auto update must not check or install')
  await h.call('install')
  assert.deepEqual(h.bootstrap.calls.at(-1), ['install', { runtimeId: 'debian-minimal' }])
})

test('missing bootstrap is explicit 503, blocked compatibility is visible, status is read-only', async () => {
  assert.equal((await harness(undefined).call('status')).code, 200)
  const absent = harness(null)
  assert.equal((await absent.call('status')).code, 503)
  assert.equal((await absent.call('install')).code, 503)
  const h = harness(makeBootstrap({ updateBlocked: true, updateAvailable: true, latestReleaseVersion: '2.0.0' }))
  const response = await h.call('status')
  assert.equal(response.payload.availableVersion, undefined)
  assert.match(response.payload.error, /不兼容/)
  assert.deepEqual(h.bootstrap.calls, [])
})

test('operations serialize and expose busy status without concurrent mutation', async () => {
  const bootstrap = makeBootstrap()
  let finish
  bootstrap.install = () => new Promise(resolve => { finish = resolve })
  const h = harness(bootstrap)
  const first = h.call('install')
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await h.call('uninstall')).code, 409)
  assert.equal((await h.call('status')).payload.busy, true)
  finish()
  assert.equal((await first).code, 200)
})

test('automatic checks require installed baseline mismatch and respect persisted attempt deduplication', async () => {
  for (const state of [
    {},
    { installedLinuxVersion: '1', installedSystemMobileVersion: '0.14.8' },
    { autoUpdateEnabled: true, installedLinuxVersion: '1', installedSystemMobileVersion: '0.14.9' },
    { autoUpdateEnabled: true, installedLinuxVersion: '1' },
    { autoUpdateEnabled: true, installedLinuxVersion: '1', installedSystemMobileVersion: '0.14.8', lastAutomaticCheckMobileVersion: '0.14.9' },
  ]) {
    const bootstrap = makeBootstrap(state)
    await checkLinuxEnvironmentAfterMobileChange(bootstrap)
    assert.deepEqual(bootstrap.calls, [])
  }
  const bootstrap = makeBootstrap({ autoUpdateEnabled: true, installedLinuxVersion: '1', installedSystemMobileVersion: '0.14.8' })
  await checkLinuxEnvironmentAfterMobileChange(bootstrap)
  assert.deepEqual(bootstrap.calls, [['check', { source: 'mobile-version-change' }]])
})

test('pluginHost uses real Cordis activation, awaits initialization and disposes on uninstall', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-'))
  const ctx = new Context()
  try {
    const directory = join(dir, 'plugins', 'runtime', '1.0.0')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'package.json'), '{"type":"module"}')
    await writeFile(join(directory, 'lib', 'index.js'), 'export async function apply(ctx) { await Promise.resolve(); ctx.provide("testLinuxRuntime", {active:true}); ctx.provide("linuxRuntimeManager", { install: async () => {}, uninstall: async () => {} }) }')
    const host = createLinuxPluginHost({ root: join(dir, 'plugins'), activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)) })
    await host.install({ directory })
    assert.equal(ctx.get('testLinuxRuntime').active, true)
    await host.install({ directory })
    await host.uninstall()
    assert.equal(ctx.get('testLinuxRuntime'), undefined)
    await host.uninstall()
    await assert.rejects(host.install({ directory: dir }), /not present in the injection directory/)
    await assert.rejects(host.install({ directory, entry: '../../../outside.js' }))
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('pluginHost rejects pending or failed Cordis activation and cleans partial services', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-failed-'))
  const ctx = new Context()
  try {
    const directory = join(dir, 'runtime')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), '')
    let fail = true
    const host = createLinuxPluginHost({
      root: dir, activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)),
      importModule: async () => fail ? {
        async apply(scope) { scope.provide('partialLinuxRuntime', true); throw new Error('startup failure') },
      } : { inject: ['absentLinuxDependency'], apply() { throw new Error('must not run') } },
    })
    await assert.rejects(host.install({ directory }), /startup failure/)
    assert.equal(ctx.get('partialLinuxRuntime'), undefined)
    fail = false
    await assert.rejects(host.install({ directory }), /did not become active/)
    await host.uninstall()
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('isInjected reads injection membership without creating or repairing anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-inject-'))
  const root = join(dir, 'plugins')
  try {
    const host = args => createLinuxPluginHost({ root, activate: () => ({ dispose() {} }), importModule: async () => ({ apply() {} }), ...args })
    assert.deepEqual(await createLinuxPluginHost({ root: undefined, activate: () => ({ dispose() {} }) }).isInjected({ name: 'runtime' }), { injected: false, active: false })
    assert.deepEqual(await host().isInjected({ name: 'runtime' }), { injected: false, active: false })
    assert.equal(existsSync(root), false, 'probing must not create the injection root')
    const flat = join(root, 'runtime')
    await mkdir(join(flat, 'lib'), { recursive: true })
    await writeFile(join(flat, 'lib', 'index.js'), 'export function apply() {}')
    assert.deepEqual(await host().isInjected({ name: 'runtime' }), { injected: true, active: false, directory: flat })
    // Versioned layout prefers the newest verified directory.
    const versioned = join(root, 'linux-runtime', '1.0.0')
    await mkdir(join(versioned, 'lib'), { recursive: true })
    await writeFile(join(versioned, 'lib', 'index.js'), 'export function apply() {}')
    assert.deepEqual(await host().isInjected({ runtimeId: 'linux-runtime' }), { injected: true, active: false, directory: versioned })
    for (const name of ['../escape', 'a/b', '', '.']) {
      assert.equal((await host().isInjected({ name })).injected, false, name)
    }
    await rm(flat, { recursive: true, force: true })
    assert.deepEqual(await host().isInjected({ name: 'runtime' }), { injected: false, active: false })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('manual removal is never resurrected: activation and reinstall both fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-removed-'))
  const root = join(dir, 'plugins')
  try {
    const directory = join(root, 'linux-runtime', '2.0.0')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), 'export function apply(ctx) { ctx.provide("runtimeInjectedMarker", true); ctx.provide("linuxRuntimeManager", { install: async () => {}, uninstall: async () => {} }) }')
    const ctx = new Context()
    const host = createLinuxPluginHost({ root, activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)) })
    await host.install({ directory })
    assert.deepEqual(await host.isInjected({ runtimeId: 'linux-runtime' }), { injected: true, active: true, directory })
    await rm(join(root, 'linux-runtime'), { recursive: true, force: true })
    assert.deepEqual(await host.isInjected({ runtimeId: 'linux-runtime' }), { injected: false, active: false })
    await assert.rejects(host.install({ directory }), /not present in the injection directory/)
    assert.deepEqual(await host.isInjected({ runtimeId: 'linux-runtime' }), { injected: false, active: false })
    assert.equal(ctx.get('runtimeInjectedMarker'), true, 'the running scope is untouched by failed reinstalls')
    await host.uninstall()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('normalizer accepts the finalized Bionilux status shape and the earlier proposal', () => {
  const finalized = normalizeLinuxStatus({
    installed: true, version: '1.2.0', mobileVersion: '0.14.9', autoUpdate: true, availableVersion: '1.3.0',
    updateAvailable: true, busy: false, operation: 'idle', runtime: 'debian-minimal', injectionActivated: true,
    enabled: true, pluginReleaseUrls: { bootstrap: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1', runtime: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1' },
    lastCheckAt: '2026-10-16T10:00:00Z',
  })
  assert.deepEqual(finalized, {
    installed: true, version: '1.2.0', mobileVersion: '0.14.9', installedSystemMobileVersion: undefined,
    autoUpdate: true, availableVersion: '1.3.0', busy: false,
    runtime: { id: 'debian-minimal', label: 'Debian minimal' },
    plugins: { bootstrap: { releaseUrl: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1' }, runtime: { releaseUrl: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1' } },
    injectionActivated: true, enabled: true, lastCheckAt: '2026-10-16T10:00:00Z', error: undefined,
  })
  // Earlier proposed names still normalize; a blocked update hides the candidate but stays visible as an error.
  const legacy = normalizeLinuxStatus({
    installedLinuxVersion: '0.9.0', currentMobileVersion: '0.14.8', autoUpdateEnabled: true,
    updateAvailable: true, updateBlocked: true, latestReleaseVersion: '2.0.0', runtimeId: 'debian-minimal',
    plugins: { bootstrap: { releaseUrl: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1' } },
  })
  assert.equal(legacy.installed, true)
  assert.equal(legacy.availableVersion, undefined)
  assert.match(legacy.error, /不兼容/)
  assert.equal(legacy.mobileVersion, '0.14.8')
  assert.equal(legacy.autoUpdate, true)
  assert.deepEqual(normalizeLinuxStatus({}).mobileVersion, 'unknown', 'an absent version must not render blank')
})

test('install returns the manager the bootstrap requires, and fails closed without one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-result-'))
  const root = join(dir, 'plugins')
  try {
    const directory = join(root, 'runtime')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), 'export function apply() {}')
    const manager = makeManager()
    // The host may see the manager either as the scope's own value or through the service the
    // runtime plugin publishes; `resolveManager` accepts hostResult.manager first.
    const host = createLinuxPluginHost({ root, activate: () => ({ state: 2, dispose() {}, manager }) })
    const first = await host.install({ directory, enable: true, config: {} })
    assert.equal(first.directory, directory)
    assert.equal(first.active, true)
    assert.equal(first.manager, manager, 'hostResult.manager must carry the runtime manager')
    assert.equal(typeof first.rollback, 'function', 'rollback is optional but we always offer it')
    const again = await host.install({ directory })
    assert.equal(again.manager, manager, 'repeat activation is idempotent')
    assert.deepEqual(await host.isInjected({ directory }), { injected: true, active: true, directory })
    const outside = join(dir, 'elsewhere')
    assert.deepEqual(await host.isInjected({ directory: outside }), { injected: false, active: false })
    await assert.rejects(host.install({ directory: outside, enable: true }), /not present in the injection directory/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('activation without a runtime manager is refused instead of reported as installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-nomanager-'))
  const root = join(dir, 'plugins')
  try {
    const directory = join(root, 'runtime')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), 'export function apply() {}')
    // A service that is not a manager (no install/uninstall) must not pass either.
    const host = createLinuxPluginHost({ root, activate: () => ({ state: 2, dispose() {}, get: () => ({ install: async () => {} }) }) })
    await assert.rejects(
      host.install({ directory, enable: true }),
      /The installed runtime plugin did not provide a runtime manager/,
    )
    assert.deepEqual(await host.isInjected({ directory }), { injected: true, active: false, directory })
    // The published service shape wins when it carries the manager inside it.
    const manager = makeManager()
    const published = createLinuxPluginHost({ root, activate: () => ({ state: 2, dispose() {}, get: () => ({ service: { manager } }) }) })
    assert.equal((await published.install({ directory, enable: true })).manager, manager)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('rollback releases the scope so a failed install leaves nothing active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-rollback-'))
  const root = join(dir, 'plugins')
  try {
    const directory = join(root, 'runtime')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), 'export function apply() {}')
    let disposed = 0
    const host = createLinuxPluginHost({
      root, activate: () => ({ state: 2, dispose: () => { disposed += 1 }, manager: makeManager() }),
    })
    const result = await host.install({ directory, enable: true })
    assert.deepEqual(await host.isInjected({ directory }), { injected: true, active: true, directory })
    await result.rollback()
    assert.equal(disposed, 1)
    assert.deepEqual(await host.isInjected({ directory }), { injected: true, active: false, directory })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('automatic checks stay off when the runtime injection was removed or the system disabled', async () => {
  for (const state of [
    { installed: true, autoUpdate: true, mobileVersion: '0.14.9', installedSystemMobileVersion: '0.14.8', injectionActivated: false },
    { installed: true, autoUpdate: true, mobileVersion: '0.14.9', installedSystemMobileVersion: '0.14.8', enabled: false },
  ]) {
    const bootstrap = makeBootstrap(state)
    await checkLinuxEnvironmentAfterMobileChange(bootstrap)
    assert.deepEqual(bootstrap.calls, [], JSON.stringify(state))
  }
  const allowed = makeBootstrap({ installed: true, autoUpdate: true, mobileVersion: '0.14.9', installedSystemMobileVersion: '0.14.8', injectionActivated: true })
  await checkLinuxEnvironmentAfterMobileChange(allowed)
  assert.deepEqual(allowed.calls, [['check', { source: 'mobile-version-change' }]])
})

test('uninstall accepts the documented argument object and still releases the scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-uninstall-'))
  const root = join(dir, 'plugins')
  const ctx = new Context()
  try {
    const directory = join(root, 'runtime')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), 'export function apply(ctx) { ctx.provide("uninstallProbe", true); ctx.provide("linuxRuntimeManager", { install: async () => {}, uninstall: async () => {} }) }')
    const host = createLinuxPluginHost({ root, activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)) })
    await host.install({ directory })
    // The bootstrap calls uninstall({runtimeId, directory, rollback}); extra fields are not the host's to own.
    await host.uninstall({ runtimeId: 'debian-minimal', directory, rollback: () => {} })
    assert.equal(ctx.get('uninstallProbe'), undefined)
    assert.deepEqual(await host.isInjected({ runtimeId: 'debian-minimal' }), { injected: false, active: false })
    await host.uninstall()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('pluginHost rejects activation with no Android filesDir and a non-Cordis bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-host-invalid-'))
  try {
    const directory = join(dir, 'runtime')
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), '')
    const activate = () => { throw new Error('must not activate') }
    await assert.rejects(createLinuxPluginHost({ root: undefined, activate }).install({ directory }), /DSH_FILES_DIR/)
    await assert.rejects(createLinuxPluginHost({ root: dir, activate, importModule: async () => ({}) }).install({ directory }), /Cordis apply/)  } finally { await rm(dir, { recursive: true, force: true }) }
})
