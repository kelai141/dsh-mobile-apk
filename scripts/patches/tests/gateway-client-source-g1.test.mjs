import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { versionedFixture } from './lib/fixture.mjs'
import { planClientRegistryScan, planGatewayClientSource, GATEWAY_CLIENT_MARKER } from '../data/registry-scan-c4.mjs'

const gateway = '@deepseek-ai/dsh-api-gateway'
const providers = ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-client-connection']
const controllers = ['job', 'terminal', 'workspace', 'session'].map(n => '@deepseek-ai/dsh-api-' + n + '-controller')

test('enabled gateway browser exports do not race host fiber; controllers remain usable', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gateway-g1-'))
  try {
    const cordis = join(scratch, 'node_modules/@deepseek-ai/cordis')
    mkdirSync(cordis, { recursive: true })
    writeFileSync(join(cordis, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
    writeFileSync(join(cordis, 'index.js'), 'export class Service { constructor(ctx) { this.ctx = ctx } }')
    const pristine = readFileSync(versionedFixture('dsh-client-modules', 'lib', 'index.js'), 'utf8')
    // 0.2.1-rc.2 起引擎在构造器里用 createRequire(import.meta.url)('../package.json') 读自身发布身份，
    // baseline/candidate 变体必须落在「lib/index.js + package.json」的真实包根下；只写一个 .mjs 会 MODULE_NOT_FOUND。
    const fixturePackage = readFileSync(versionedFixture('dsh-client-modules', 'package.json'), 'utf8')
    const candidate = planClientRegistryScan(pristine)
    assert.equal(planClientRegistryScan(candidate), candidate)
    assert.equal(planGatewayClientSource(candidate), candidate)
    assert.throws(() => planGatewayClientSource(pristine.replace('entry.fiber === void 0 || entry.disabled', 'false')), /anchor mismatch/)
    // Applying G1 to an already-C4-patched snapshot must also update its bytes.
    const oldC4 = candidate.replace(/\/\* dsh-mobile gateway client source G1[^\n]+\*\/\n\s*if \(entry.options.name[^\n]+/, 'if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;')
    assert.ok(planClientRegistryScan(oldC4).includes(GATEWAY_CLIENT_MARKER))
    const pkgs = new Map()
    const rows = []
    const hooks = new Map()
    const baseUrl = pathToFileURL(join(scratch, 'tree.mjs')).href
    for (const [i, name] of [...controllers, gateway, ...providers, 'pending-unrelated'].entries()) {
      const dir = join(scratch, 'pkg-' + i); mkdirSync(dir); pkgs.set(name, dir)
      const isGateway = name === gateway
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, exports: { './client': './client.js' }, dsh: { client: { platform: 'web', ...(isGateway ? { immediately: true, inject: providers } : providers.includes(name) ? { immediately: true, inject: [] } : { external: [gateway + '/client'] }) } } }))
      const body = providers.includes(name) ? 'exports.token = "dependency-ready";' : isGateway ? 'exports.token = "gateway-ready";' : 'exports.token = require(' + JSON.stringify(gateway + '/client') + ').token;'
      writeFileSync(join(dir, 'client.js'), 'window.__ModuleLoader__.load({id:' + JSON.stringify(name) + ',factory:function(require,module,exports){' + body + '}});')
      writeFileSync(join(dir, 'host.js'), '')
      rows.push({ options: { name }, fiber: isGateway || providers.includes(name) || name === 'pending-unrelated' ? undefined : {}, disabled: false, parent: { tree: { ctx: { baseUrl } } } })
    }
    const ctx = { loader: { entries: () => rows, internal: { version: 'v2', resolveSync(base, { specifier }) { return { url: pathToFileURL(join(pkgs.get(specifier), 'host.js')).href } } } }, logger: { warn() {}, error() {} }, on(event, cb) { hooks.set(event, cb) }, inject() {} }
    for (const [name, source] of [['baseline', pristine], ['candidate', candidate]]) {
      const moduleRoot = join(scratch, 'modules', name)
      mkdirSync(join(moduleRoot, 'lib'), { recursive: true })
      writeFileSync(join(moduleRoot, 'package.json'), fixturePackage)
      const file = join(moduleRoot, 'lib', 'index.js'); writeFileSync(file, source)
      const { ClientModuleRegistry } = await import(pathToFileURL(file))
      const registry = new ClientModuleRegistry(ctx)
      const graph = registry.graph()
      const ids = graph.entries.map(e => e.id)
      const factories = new Map(), modules = new Map()
      const window = { __ModuleLoader__: { load({ id, factory }) { factories.set(id, factory) } } }
      for (const batch of graph.batches) {
        const response = await registry.fetchBundle({ method: 'GET', url: 'http://local/' + batch.url })
        runInNewContext(await response.text(), { window })
      }
      const require = spec => {
        const id = spec.replace(/\/client$/, '')
        if (modules.has(id)) return modules.get(id)
        const factory = factories.get(id)
        if (!factory) throw new Error('missing gateway factory: ' + id)
        const row = graph.entries.find(e => e.id === id)
        for (const dependency of row.inject ?? []) require(dependency)
        const module = { exports: {} }; modules.set(id, module.exports)
        factory(require, module, module.exports); return module.exports
      }
      if (name === 'baseline') {
        assert.ok(!ids.includes(gateway))
        assert.throws(() => require(controllers[0]), /missing gateway factory/)
        continue
      }
      assert.equal(ids[0], gateway)
      for (const provider of providers) assert.ok(ids.includes(provider))
      assert.deepEqual(graph.entries.find(e => e.id === gateway).inject, providers)
      assert.ok(!ids.includes('pending-unrelated'))
      for (const controller of controllers) assert.equal(require(controller).token, 'gateway-ready')
      for (const provider of [gateway, ...providers]) {
        const providerRow = rows.find(r => r.options.name === provider)
        providerRow.fiber = {}; hooks.get('internal/plugin')({ entry: providerRow }); await new Promise(r => setTimeout(r, 0))
        assert.equal(registry.graph().entries.filter(e => e.id === provider).length, 1)
        providerRow.disabled = true; hooks.get('internal/plugin')({ entry: providerRow }); await new Promise(r => setTimeout(r, 0))
        assert.ok(!registry.graph().entries.some(e => e.id === provider))
        providerRow.disabled = false; hooks.get('internal/plugin')({ entry: providerRow }); await new Promise(r => setTimeout(r, 0))
        assert.ok(registry.graph().entries.some(e => e.id === provider))
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
