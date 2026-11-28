import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startCatalogRefresh } from '../lib/providers/catalog-refresh.js'

const STUB_DIR = mkdtempSync(join(tmpdir(), 'subs-defer-stub-'))
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'subs-defer-home-'))

const Z_STUB = join(STUB_DIR, 'schemastery.mjs')
writeFileSync(Z_STUB, [
  'const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });',
  'export default chain;',
  '',
].join('\n'))

const LLM_STUB = join(STUB_DIR, 'dsh-llm.mjs')
writeFileSync(LLM_STUB, [
  'export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";',
  'export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";',
  'export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED";',
  'export const isContextWindowExceededError = () => false;',
  'export const isQuotaExceededError = () => false;',
  'export const ReasoningEffortId = (x) => x;',
  'export const attributionHeaders = () => ({});',
  'export class LlmAdapter {}',
  'export class LlmError extends Error { constructor(m, code, opts) { super(m); this.code = code; this.cause = opts?.cause; } }',
  'export function errorChain(e) { return String(e); }',
  'export function resolveRetryPolicy(p) { return p; }',
  '',
].join('\n'))

const HOME_STUB = join(STUB_DIR, 'dsh-home.mjs')
writeFileSync(HOME_STUB, [
  `export function dshHome() { return ${JSON.stringify(HOME_ROOT)}; }`,
  `export function dshHomePath(...p) { return [${JSON.stringify(HOME_ROOT)}, ...p].join("/"); }`,
  '',
].join('\n'))

const ATTACHMENT_STUB = join(STUB_DIR, 'dsh-attachment.mjs')
writeFileSync(ATTACHMENT_STUB, 'export const AttachmentId = (x) => x;\n')

const WEB_STUB = join(STUB_DIR, 'dsh-web.mjs')
writeFileSync(WEB_STUB, 'export class WebError extends Error {}\n')

const TOOLS_STUB = join(STUB_DIR, 'dsh-tools.mjs')
writeFileSync(TOOLS_STUB, 'export function defineTool(def) { return def; }\n')

const UNDICI_STUB = join(STUB_DIR, 'undici.mjs')
writeFileSync(UNDICI_STUB, [
  'export class ProxyAgent { async close() {} }',
  'export async function fetch() {',
  '  throw new Error("unexpected undici.fetch without proxy");',
  '}',
  '',
].join('\n'))

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/schemastery') return { url: pathToFileURL(Z_STUB).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-llm') return { url: pathToFileURL(LLM_STUB).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-home-paths') return { url: pathToFileURL(HOME_STUB).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-attachment') return { url: pathToFileURL(ATTACHMENT_STUB).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-web') return { url: pathToFileURL(WEB_STUB).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-tools') return { url: pathToFileURL(TOOLS_STUB).href, shortCircuit: true }
    if (specifier === 'undici') return { url: pathToFileURL(UNDICI_STUB).href, shortCircuit: true }
    return next(specifier, context)
  },
})

const { apply } = await import('../lib/index.js')
const realSetTimeout = globalThis.setTimeout

const flushMicrotasks = async (ms = 20) => {
  await new Promise((resolve) => realSetTimeout(resolve, ms))
}

const seedCodexAccount = () => {
  const dir = join(HOME_ROOT, 'plugins', 'subscriptions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    codex: {
      default: 'acct-1',
      accounts: {
        'acct-1': {
          accessToken: 'tok-access',
          refreshToken: 'tok-refresh',
          expiresAt: Date.now() + 3600_000,
          accountId: 'acct-1',
          emailAddress: 'a@example.com',
        },
      },
    },
  }), { mode: 0o600 })
}

const createMockContext = () => {
  const effects = []
  const adapters = new Map()
  const routes = new Map()
  const warnings = []
  const mockConnection = {
    fetch: {
      register(def) {
        routes.set(def.path, def.fetch)
        return () => { routes.delete(def.path) }
      },
    },
  }
  const ctx = {
    logger: { warn(msg) { warnings.push(msg) }, info() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'connection') return mockConnection
      return undefined
    },
    effect(fn, label) {
      const dispose = fn()
      const entry = { label, dispose }
      effects.push(entry)
      return dispose
    },
    inject(deps, cb) {
      if (deps.includes('connection')) cb(ctx)
    },
    llm: {
      registerAdapter(providers, route) {
        for (const p of providers) adapters.set(p, route)
        return {
          replace() {},
          dispose() {
            for (const p of providers) adapters.delete(p)
          },
        }
      },
      async listProviders() {
        return [...adapters.keys()].map((id) => ({ id }))
      },
      async listModels(id) {
        return adapters.get(id)?.listModels(id) ?? []
      },
      async resolveModelInfo(id, model) {
        return adapters.get(id)?.resolveModel(id, model)
      },
    },
  }
  return {
    ctx,
    effects,
    adapters,
    routes,
    warnings,
    disposeAll() {
      for (const entry of effects) {
        if (typeof entry.dispose === 'function') entry.dispose()
      }
    },
  }
}

test('startCatalogRefresh: initialDelayMs > 0 delays first refresh until deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let lastSignal
  const stop = startCatalogRefresh(async (signal) => {
    calls += 1
    lastSignal = signal
  }, () => {}, { initialDelayMs: 15_000 })

  try {
    await flushMicrotasks()
    assert.equal(calls, 0, '启动瞬间不得触发 refresh')

    t.mock.timers.tick(14_999)
    await flushMicrotasks()
    assert.equal(calls, 0, '未到达延迟窗口前不得触发 refresh')

    t.mock.timers.tick(1)
    await flushMicrotasks()
    assert.equal(calls, 1, '到达 initialDelayMs 后应触发首拍 refresh')
    assert.equal(lastSignal?.aborted, false)
  } finally {
    stop()
  }
})

test('startCatalogRefresh: cancelling before initialDelayMs never triggers refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const stop = startCatalogRefresh(async () => {
    calls += 1
  }, () => {}, { initialDelayMs: 15_000 })

  stop()
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(calls, 0, '延迟到达前调用取消句柄后绝不得触发 refresh')
})

test('startCatalogRefresh: initialDelayMs = 0 or omitted runs immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let callsDefault = 0
  const stopDefault = startCatalogRefresh(async () => {
    callsDefault += 1
  })
  assert.equal(callsDefault, 1, '未传 initialDelayMs 时应立即触发首拍')
  stopDefault()

  let callsZero = 0
  const stopZero = startCatalogRefresh(async () => {
    callsZero += 1
  }, () => {}, { initialDelayMs: 0 })
  assert.equal(callsZero, 1, 'initialDelayMs = 0 时应立即触发首拍')
  stopZero()
})

test('apply(): defers startup catalog discovery by 15s while keeping routes and static catalog intact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  seedCodexAccount()
  const fetchCalls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    fetchCalls.push({ url: String(url), aborted: Boolean(init?.signal?.aborted) })
    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const host = createMockContext()
  apply(host.ctx, { providers: ['codex'], codexClientVersion: '0.153.4' })

  try {
    assert.equal(host.adapters.has('codex'), true, '应立即注册 codex 适配器')
    assert.equal(host.routes.has('/api/subscriptions-auth.providerSettings'), true, '应立即注册手动设置/刷新路由')
    assert.equal(host.routes.has('/api/subscriptions-auth.modelDefaults'), true, '应立即注册 modelDefaults 路由')

    await flushMicrotasks()
    assert.equal(fetchCalls.length, 0, 'apply() 启动瞬间不得触发后台目录刷新请求')

    t.mock.timers.tick(14_999)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, 0, '15 秒窗口内不得触发后台目录刷新请求')

    t.mock.timers.tick(1)
    for (let i = 0; i < 20 && fetchCalls.length === 0; i += 1) await flushMicrotasks(10)
    assert.ok(fetchCalls.length >= 1, '到达 15 秒后应正常触发目录刷新请求; warnings=' + JSON.stringify(host.warnings))
  } finally {
    host.disposeAll()
  }
})

test('apply(): disposing plugin effect before 15s prevents background catalog fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  seedCodexAccount()
  const fetchCalls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    fetchCalls.push({ url: String(url), aborted: Boolean(init?.signal?.aborted) })
    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const host = createMockContext()
  apply(host.ctx, { providers: ['codex'], codexClientVersion: '0.153.4' })
  host.disposeAll()

  t.mock.timers.tick(30_000)
  await flushMicrotasks()
  assert.equal(fetchCalls.length, 0, 'dispose 后绝不得残留触发后台目录刷新')
})

test.after(() => {
  rmSync(STUB_DIR, { recursive: true, force: true })
  rmSync(HOME_ROOT, { recursive: true, force: true })
})
