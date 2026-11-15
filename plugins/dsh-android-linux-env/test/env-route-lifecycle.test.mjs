// issue #1207：两条 env 路由必须走 ctx.effect（可回收），且处理器必须自带 try/catch。
//
// 缺陷形态：`wsvc.register(...)` 裸调用把 disposer 丢掉 → 插件卸载/热重载后路由仍存活并从已销毁的 ctx
// 提供服务；处理器无 try/catch → builder 抛错（工作区被删后 cwd ENOENT）时整个 handler reject，res 永不 end。
//
// 判据全部是行为：跑一遍收集到的 disposer 看路由还在不在；让 cwd 抛错看请求会不会挂住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  // 原生链路重构（#1730）之后本插件不再注入 androidPrivilege，档位改由
  // nativeSharedBridge 的 statusAsync 异步读，且 readTier 自己会 catch（读不到就是
  // unknown，不抛）。旧用例靠 androidPrivilege.status 抛错来制造 builder 失败，
  // 在这之后永远不触发 —— 实测返回 200 而判据要 500，就成了「判据还在、但它已经
  // 测不到东西」的假绿。
  //
  // 换一个仍在场的失败源：toolchainStatus 里 dpkg status 的 readFileSync 没有 try/catch
  // （文件存在但不可读 = EISDIR）。这里把 prefix 指到一棵 status 是目录的假树，
  // 走的就是生产代码里那条真实的抛错路径，不是给测试开的后门。
  const dir = await mkdtemp(join(tmpdir(), 'env-route-boom-'))
  const previous = process.env.TERMUX__PREFIX
  process.env.TERMUX__PREFIX = dir
  await mkdir(join(dir, 'var', 'lib', 'dpkg', 'status'), { recursive: true })
  try {
    const { routes } = harness()
    const res = fakeRes()
    await routes.get('/api/android/env/status')(req, res)
    assert.equal(res.state.status, 500)
    const body = JSON.parse(res.state.body)
    assert.equal(body.ok, false)
    assert.equal(body.error, 'env-route-failed')
    assert.match(String(body.detail), /EISDIR|EACCES|EPERM|illegal operation/i)
  } finally {
    if (previous === undefined) delete process.env.TERMUX__PREFIX
    else process.env.TERMUX__PREFIX = previous
    await rm(dir, { recursive: true, force: true })
  }
})