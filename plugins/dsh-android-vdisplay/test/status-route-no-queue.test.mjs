// issue #1604（vdisplay 侧）：公开只读状态路由在无令牌情况下驱动单槽控制队列。
//
// 缺陷形态：`GET /api/android/vdisplay/status` 按设计不要求令牌（只有 `authorizePublicReadOnlyRoute`
// 的 403 栅栏），但它此前在**请求路径上** `await readVdToolSnapshot()`，后者会 `controlExec('vdInfo')`。
// 控制队列是**单槽**的 ⇒ 本机任意应用一条裸 socket GET（带 Host、不带 Origin、不带令牌）就能把
// 队列占住最长 8 秒，期间任何 AI 工具调用都回「已有在途的设备控制请求——壳侧单线程，请串行调用」，
// 而失败文案把原因归到「模型并发调用」——排障方向完全错。
//
// 判据（行为）：真的跑 apply()、拿到 webServer 上注册的 status 路由、发一个回环 GET，
// 断言 **controlExec 一次都没被调用**，且响应体来自缓存而不是「未探过」占位。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

/** 与上游 webserver 同契约的假服务（register 返回 disposer）。 */
function fakeWebServer() {
  const table = new Map()
  return {
    table,
    register(route) {
      table.set(route.kind + ' ' + route.path, route)
      return () => { table.delete(route.kind + ' ' + route.path) }
    },
  }
}

/** 记录 androidPrivilege 面的每一次 controlExec 调用——公开路由一次都不许调它。 */
function harness(cacheValue) {
  const ws = fakeWebServer()
  const controlCalls = []
  const ctx = {
    logger: () => ({ warn() {}, debug() {}, info() {}, error() {} }),
    tools: { register() {} },
    get(name) {
      if (name === 'webServer') return ws
      if (name !== 'androidPrivilege') return undefined
      return {
        controlExec: async (...args) => {
          controlCalls.push(args)
          return { ok: false, error: '公开只读路由不得调用 controlExec' }
        },
        cachedVdStatus: () => cacheValue,
      }
    },
    on: () => {},
    effect(cb) { cb?.(); return () => {} },
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  process.env.DSH_ENGINE_PORT = '4145'
  apply(ctx)
  return { ws, controlCalls }
}

/** 发一次「带 Host、不带 Origin、不带令牌」的回环 GET。 */
async function callStatusRoute(ws) {
  const route = ws.table.get('exact /api/android/vdisplay/status')
  assert.ok(route, '状态路由必须已注册')
  let settled
  const done = new Promise((resolve) => { settled = resolve })
  const req = { method: 'GET', headers: { host: '127.0.0.1:4145' }, on() {} }
  const res = {
    statusCode: 200,
    setHeader() {},
    end(body) { settled({ code: this.statusCode, body: body ?? '' }) },
  }
  const handlerDone = Promise.resolve().then(() => route.handler(req, res)).then(() => null)
  const reply = await Promise.race([done, handlerDone]) ?? { code: 0, body: 'no reply' }
  return reply
}

test('判据 1：状态路由在无令牌请求下绝不调用 controlExec（单槽队列不得被公开路由占用）', async () => {
  const { ws, controlCalls } = harness({ ok: true, enabled: true, state: 'ready', screens: [] })
  const reply = await callStatusRoute(ws)
  assert.equal(reply.code, 200, '公开只读路由必须回 200：' + reply.body)
  assert.deepEqual(controlCalls, [],
    '无令牌请求绝不得驱动控制队列（否则本机任意应用都能让真实工具调用失败）：'
      + JSON.stringify(controlCalls))
})

test('判据 2：有缓存时响应必须来自缓存（不是「未探过」占位）', async () => {
  const { ws } = harness({
    ok: true, enabled: true, state: 'active', displayId: 42,
    screens: [{ alias: 'virtual-1', displayId: 42, kind: 'virtual', label: 'vd', state: 'on', width: 360, height: 640, densityDpi: 160, selectable: true, reason: '' }],
  })
  const reply = await callStatusRoute(ws)
  const payload = JSON.parse(reply.body)
  assert.equal(payload.state, 'active', '必须用缓存里的真实状态：' + reply.body)
  assert.equal(payload.displayId, 42)
})

test('判据 3：无缓存时回稳定 code，且仍然不驱动队列（fail-closed 而不是排队等）', async () => {
  const { ws, controlCalls } = harness(undefined)
  const reply = await callStatusRoute(ws)
  assert.equal(reply.code, 200)
  const payload = JSON.parse(reply.body)
  assert.equal(payload.state, 'blocked', '无缓存时必须 fail-closed：' + reply.body)
  assert.equal(payload.code, 'vdisplay-status-not-probed',
    '必须给出「尚未探过」这个稳定 code，而不是假装 ready 或假装能力不可用：' + reply.body)
  assert.deepEqual(controlCalls, [], '无缓存也不得为了补缓存去动队列')
})

test('判据 4：连发 5 次无令牌请求仍不碰队列（反复轮询不得累积占用）', async () => {
  const { ws, controlCalls } = harness({ ok: true, enabled: true, state: 'ready', screens: [{ alias: 'real', displayId: 0, kind: 'real', label: 'real', state: 'on', width: 1080, height: 2400, densityDpi: 440, selectable: true, reason: '' }] })
  for (let i = 0; i < 5; i += 1) {
    const reply = await callStatusRoute(ws)
    assert.equal(reply.code, 200, '第 ' + (i + 1) + ' 次请求：' + reply.body)
  }
  assert.deepEqual(controlCalls, [], '反复轮询同样不得驱动队列')
})
