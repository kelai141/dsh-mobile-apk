// issue #1207：两条 env 路由必须走 ctx.effect（可回收），且处理器必须自带 try/catch。
//
// 缺陷形态：`wsvc.register(...)` 裸调用把 disposer 丢掉 → 插件卸载/热重载后路由仍存活并从已销毁的 ctx
// 提供服务；处理器无 try/catch → builder 抛错（工作区被删后 cwd ENOENT）时整个 handler reject，res 永不 end。
//
// 判据全部是行为：跑一遍收集到的 disposer 看路由还在不在；让 cwd 抛错看请求会不会挂住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

process.env.DSH_CONTROL_TOKEN_TEST = '1'
process.env.DSH_CONTROL_TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-control-token'

function harness(overrides = {}) {
  const disposers = []
  const routes = new Map()
  const ctx = {
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {} }),
    tools: { register: () => {} },
    // 授权走 connection 服务（requestRejection 返回 undefined = 放行）；否则回环 + 令牌那套在单测里
    // 会因为 loopbackAuthorities 依赖 env 而 403，测不到本 issue 的两条判据。
    get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    effect: (fn) => { const d = fn(); disposers.push(d); return d },
    webServer: {
      register: (route) => { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } },
    },
    androidPrivilege: { status: () => ({ tier: 'T1' }) },
    ...overrides,
  }
  mod.apply(ctx)
  return { disposers, routes }
}

function fakeRes() {
  const state = { status: null, body: null, ended: false }
  return {
    state,
    writeHead(status) { state.status = status },
    end(body) { state.body = body; state.ended = true },
  }
}

const req = { method: 'GET', headers: { host: '127.0.0.1:3080', [TOKEN_HEADER]: 'test-token' } }

test('判据 1：跑完 ctx.effect 的 disposer 后，两条 env 路由必须消失（不得从已销毁的 ctx 存活）', () => {
  const { disposers, routes } = harness()
  assert.ok(routes.has('/api/android/env/status'), '前置：status 路由必须已注册')
  assert.ok(routes.has('/api/android/env/recipe'), '前置：recipe 路由必须已注册')
  for (const dispose of disposers) dispose()
  assert.equal(routes.has('/api/android/env/status'), false, 'status 路由必须被回收')
  assert.equal(routes.has('/api/android/env/recipe'), false, 'recipe 路由必须被回收')
})

test('判据 2：process.cwd() 抛错时请求必须仍有响应（不得 reject 挂住）', async () => {
  const { routes } = harness()
  const original = process.cwd
  process.cwd = () => { throw new Error('ENOENT: no such file or directory') }
  try {
    for (const path of ['/api/android/env/status', '/api/android/env/recipe']) {
      const res = fakeRes()
      await routes.get(path)(req, res)
      assert.equal(res.state.ended, true, path + ' 必须 end（否则客户端挂住）')
      assert.ok(res.state.status === 200 || res.state.status === 500, path + ' 必须给出状态码，实际 ' + res.state.status)
    }
  } finally {
    process.cwd = original
  }
})

test('判据 3：builder 抛错时必须是 500 + 结构化 error，而不是 unhandled rejection', async () => {
  const { routes } = harness({ androidPrivilege: { status: () => { throw new Error('tier exploded') } } })
  const res = fakeRes()
  await routes.get('/api/android/env/status')(req, res)
  assert.equal(res.state.status, 500)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, false)
  assert.equal(body.error, 'env-route-failed')
  assert.match(String(body.detail), /tier exploded/)
})