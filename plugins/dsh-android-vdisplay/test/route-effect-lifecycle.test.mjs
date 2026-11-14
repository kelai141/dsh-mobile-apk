// issue #1595（vdisplay 部分）：状态路由未走 ctx.effect —— 热重载后 duplicate exact route。
//
// 与 bridge 的同名测试同一形态：`webServer.register()` 返回 disposer、同名 (kind,path) 重复注册即抛。
// 本插件此前 `wsvc.register({...})` 裸调、丢弃 disposer ⇒ HMR 后新实例 apply() 抛
// `webserver: duplicate exact route "/api/android/vdisplay/status"` ⇒ 整插件装载失败；
// 旧 handler 仍留在 exact 表里，用已 dispose 的 ctx 继续回 200。
//
// issue 点名的 session-delete 两条路由归 plugins 侧另一条 PR，本文件不覆盖。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

/** 与上游 webserver 同契约的假服务：返回 disposer，重复注册即抛。 */
function fakeWebServer() {
  const table = new Map()
  return {
    table,
    register(route) {
      const key = route.kind + ' ' + route.path
      if (table.has(key)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
      table.set(key, route)
      return () => {
        if (table.get(key) === route) table.delete(key)
      }
    },
  }
}

/** 跑一次 apply()；ctx.effect 必须真的记住回调返回的 disposer（缺陷的观测点）。 */
function runApply(webServer) {
  const effectDisposers = []
  const registered = []
  const ctx = {
    logger: () => ({ warn() {}, debug() {}, info() {}, error() {} }),
    tools: { register: (t) => registered.push(t) },
    // apply() 用 ctx.get('webServer') 取可选服务（坑 82：属性访问会被 cordis 拒绝）。
    get: (name) => (name === 'webServer' ? webServer : undefined),
    on: () => {},
    effect(cb) {
      const dispose = cb?.()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    slots: { inject: () => () => {}, register: () => () => {} },
    webServer,
  }
  apply(ctx)
  return { effectDisposers, registered }
}

test('判据 1：状态路由必须挂进 effect 表，跑完 disposer 后 exact 表清空', () => {
  const ws = fakeWebServer()
  const { effectDisposers } = runApply(ws)
  assert.ok(ws.table.has('exact /api/android/vdisplay/status'),
    '状态路由必须已注册：' + [...ws.table.keys()].join(', '))
  assert.ok(effectDisposers.length > 0, 'apply() 必须通过 ctx.effect 登记可回收项')
  for (const dispose of effectDisposers) dispose()
  assert.equal(ws.table.size, 0,
    '跑完 effect disposer 后不得残留路由（残留即裸注册，热重载会撞 duplicate exact route）')
})

test('判据 2：模拟 HMR —— 旧 fiber 回收后新实例 apply() 必须装载成功', () => {
  const ws = fakeWebServer()
  const first = runApply(ws)
  for (const dispose of first.effectDisposers) dispose()
  assert.doesNotThrow(() => runApply(ws),
    '热重载后新实例 apply() 不得抛 duplicate exact route')
  assert.ok(ws.table.has('exact /api/android/vdisplay/status'), '新实例必须重新登记状态路由')
})

test('判据 3：未回收时重复注册确实会抛（证明判据 2 的假服务忠实于上游契约）', () => {
  const ws = fakeWebServer()
  runApply(ws)
  assert.throws(() => runApply(ws), /duplicate exact route/)
})

test('判据 4：状态路由处理器不驱动控制队列（#1604 的 vdisplay 侧判据）', async () => {
  const ws = fakeWebServer()
  const ctxCalls = []
  const effectDisposers = []
  const ctx = {
    logger: () => ({ warn() {}, debug() {}, info() {}, error() {} }),
    tools: { register() {} },
    // androidPrivilege 面：记录 controlExec 调用；公开路由**一次都不许调它**。
    get(name) {
      if (name === 'webServer') return ws
      if (name !== 'androidPrivilege') return undefined
      return {
        controlExec: async (...args) => {
          ctxCalls.push(args)
          return { ok: false, error: 'must not be called from the public route' }
        },
        cachedVdStatus: () => ({ ok: true, enabled: true, state: 'ready', screens: [] }),
      }
    },
    on: () => {},
    effect(cb) {
      const dispose = cb?.()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    slots: { inject: () => () => {}, register: () => () => {} },
    webServer: ws,
  }
  process.env.DSH_ENGINE_PORT = '4145'
  apply(ctx)
  const route = ws.table.get('exact /api/android/vdisplay/status')
  assert.ok(route, '状态路由必须已注册')

  let settled
  const done = new Promise((resolve) => { settled = resolve })
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:4145' },
    on() {},
  }
  const res = {
    statusCode: 200,
    setHeader() {},
    end(body) { settled({ code: this.statusCode, body: body ?? '' }) },
  }
  const handlerDone = Promise.resolve().then(() => route.handler(req, res)).then(() => null)
  const reply = await Promise.race([done, handlerDone]) ?? { code: 0, body: 'no reply' }
  assert.equal(reply.code, 200, '公开只读路由必须回 200：' + reply.body)
  assert.deepEqual(ctxCalls, [],
    '公开只读路由绝不得调用 controlExec（单槽队列，无令牌调用方不得获得拒绝权）：'
      + JSON.stringify(ctxCalls))
  const payload = JSON.parse(reply.body)
  assert.equal(payload.state, 'ready', '必须用缓存里的真实状态，而不是「未探过」占位')
})
