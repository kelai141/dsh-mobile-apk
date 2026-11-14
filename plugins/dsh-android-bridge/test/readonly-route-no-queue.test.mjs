// issue #1604：公开只读路由在**无令牌**情况下驱动单槽控制队列。
//
// 缺陷形态：`/api/android/privilege/status` 与 `/api/android/vdisplay/status` 按设计不要求令牌
// （`authorizePublicReadOnlyRoute` 只拦 403），但两个 handler 都在**请求路径上** `await` 一次
// 补探 / `vdInfo`。控制队列是**单槽**的（ControlQueue.enqueue 的第二条请求直接返回
// 「已有在途的设备控制请求——壳侧单线程，请串行调用」）⇒ 本机任意应用一条裸 socket GET
// （带 Host、不带 Origin、不带令牌）就能把队列占住最长 8 秒，期间所有 AI 工具调用都失败，
// 而失败文案把原因归到「模型并发调用」，排障方向完全错。
//
// 判据（行为，不是 grep）：真的跑 apply()、拿到 webServer 上注册的 handler、发一个
// 「带 Host、不带 Origin、不带令牌」的回环 GET，然后看**这个请求有没有消耗控制队列**。
// 队列消耗的观测面：`buildPrivilegeStatusPayload` 会把 `control.queue` 的 served/failed/waiting
// 一起回出来——修前那一次 await 会撞超时 ⇒ failed 至少 +1、waiting 为 true。
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as bridgeApply } from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

const SAVED = {
  home: process.env.DSH_HOME,
  prefs: process.env.DSH_ADB_PREFS_PATH,
  scopeTest: process.env.DSH_SCREEN_SCOPE_TEST,
  scope: process.env.DSH_SCREEN_SCOPE,
  port: process.env.DSH_ENGINE_PORT,
}
after(() => {
  for (const [key, value] of Object.entries({
    DSH_HOME: SAVED.home,
    DSH_ADB_PREFS_PATH: SAVED.prefs,
    DSH_SCREEN_SCOPE_TEST: SAVED.scopeTest,
    DSH_SCREEN_SCOPE: SAVED.scope,
    DSH_ENGINE_PORT: SAVED.port,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 固定端口 + 临时 DSH_HOME：让回环栅栏与文件写入都落在可预测的位置。 */
function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-1604-'))
  process.env.DSH_HOME = dir
  process.env.DSH_ENGINE_PORT = '4145'
  process.env.DSH_ADB_PREFS_PATH = join(dir, 'dsh-adb.xml')
  writeFileSync(process.env.DSH_ADB_PREFS_PATH,
    '<map>\n<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n</map>\n')
  process.env.DSH_SCREEN_SCOPE_TEST = '1'
  process.env.DSH_SCREEN_SCOPE = 'all'
  return dir
}

/** 收集 apply() 注册的路由，并**真的记住**每个 effect 返回的 disposer（#1595 的回收判据也用它）。 */
function harness() {
  setupEnv()
  const routes = []
  const effectDisposers = []
  const provided = new Map()
  const ctx = {
    logger: () => ({ warn() {}, debug() {}, info() {}, error() {} }),
    tools: { register() {} },
    provide(name, value) { provided.set(name, value) },
    on() {},
    get(name) { return provided.get(name) },
    effect(cb) {
      const dispose = cb?.()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  }
  bridgeApply(ctx)
  return { routes, effectDisposers, ctx, provided }
}

/**
 * 发一次「带 Host、不带 Origin、不带令牌」的回环 GET（issue 的触发条件）。
 * @returns 状态码、响应体、耗时。耗时本身是判据之一：修前会等满 4s 的控制 op 超时。
 */
async function callRoute(route) {
  const started = Date.now()
  let settled
  const done = new Promise((resolve) => { settled = resolve })
  const req = {
    method: 'GET',
    url: route.path,
    headers: { host: '127.0.0.1:4145' },
    on(event, cb) { if (event === 'end') cb() },
  }
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {} },
    end(body) { settled({ code: this.statusCode, body: body ?? '' }) },
  }
  const handlerDone = Promise.resolve()
    .then(() => route.handler(req, res))
    .then(() => null)
    .catch((e) => ({ code: 0, body: 'handler threw: ' + String(e?.message ?? e) }))
  const reply = await Promise.race([done, handlerDone]) ?? { code: 0, body: 'no reply' }
  return { ...reply, elapsedMs: Date.now() - started }
}

const PRIVILEGE_ROUTE = '/api/android/privilege/status'

test('判据 1：privilege/status 在无令牌请求下不得消耗控制队列（#1604）', async () => {
  const { routes } = harness()
  const route = routes.find((r) => r.path === PRIVILEGE_ROUTE)
  assert.ok(route, 'privilege/status 路由必须注册')
  const reply = await callRoute(route)
  assert.equal(reply.code, 200, '公开只读路由仍必须回 200（栅栏只拦 403）：' + reply.body)
  const payload = JSON.parse(reply.body)
  // 回执里的队列计数就是「这个请求有没有动用单槽队列」的直接证据。
  assert.equal(payload.control.queue.served, 0, '无令牌 GET 不得产生任何成功的控制 op')
  assert.equal(payload.control.queue.failed, 0,
    '无令牌 GET 不得产生任何失败的控制 op（修前那次 vdInfo 补探会撞超时，failed 至少 +1）')
  assert.equal(payload.control.queue.waiting, false,
    '队列不得进入「有待取活」状态（哪怕只占一瞬间，真实工具调用就会撞「已有在途」）')
})

test('判据 2：路由响应不得等待控制 op 超时（修前等满 4s）', async () => {
  const { routes } = harness()
  const route = routes.find((r) => r.path === PRIVILEGE_ROUTE)
  const reply = await callRoute(route)
  assert.equal(reply.code, 200)
  assert.ok(reply.elapsedMs < 1500,
    '路由必须同步回缓存（修前 await 补探会等满 4s 超时）：实际 ' + reply.elapsedMs + 'ms')
})

test('判据 3：连发 5 次无令牌请求后队列统计仍为零（反复轮询不得累积占用）', async () => {
  const { routes } = harness()
  const route = routes.find((r) => r.path === PRIVILEGE_ROUTE)
  for (let i = 0; i < 5; i += 1) {
    const reply = await callRoute(route)
    assert.equal(reply.code, 200)
    const q = JSON.parse(reply.body).control.queue
    assert.equal(q.served, 0, '第 ' + (i + 1) + ' 次请求产生了成功的控制 op')
    assert.equal(q.failed, 0, '第 ' + (i + 1) + ' 次请求产生了失败的控制 op')
  }
})

test('判据 4：补探能力仍在，但只经模型面工具入口（带会话）触发，不在公开路由上', async () => {
  const { provided } = harness()
  const svc = provided.get('androidPrivilege')
  assert.ok(svc, 'apply() 必须 provide androidPrivilege 服务')
  // A1 的补探必须保留（否则冷启动恒「未知」无法自愈），但入口是**模型面**的那一个。
  assert.equal(typeof svc.shizukuChannelProbed, 'function', 'A1 的补探入口必须仍然存在')
  // 反面：公开路由路径上不得再有「刷新」一类不阻塞但仍占槽的入口。
  assert.equal(typeof svc.shizukuChannelRefreshInBackground, 'undefined',
    '不得保留任何在公开路由上触发、仍会占掉单槽队列的补探入口')
  // cachedVdStatus 是公开路由唯一允许的读法：纯读，不入队。
  assert.equal(typeof svc.cachedVdStatus, 'function')
  const value = svc.cachedVdStatus()
  assert.ok(value === undefined || typeof value === 'object')
})

test('判据 5：ControlQueue 只读缓存由 vdInfo 回执填充（路由据此拿到真实注册表）', async () => {
  const queue = new ControlQueue()
  assert.equal(queue.lastVdInfoSnapshot(), undefined, '未收到回执前不得有缓存（fail-closed 方向）')
  const pending = queue.enqueue('vdInfo', {}, 2000)
  const taken = queue.take()
  assert.ok(taken !== null)
  queue.settle(taken.reqId, { ok: true, data: { ok: true, enabled: true, screens: [] } })
  await pending
  const cached = queue.lastVdInfoSnapshot()
  assert.ok(cached, '成功的 vdInfo 回执必须进缓存')
  assert.deepEqual(cached.data.screens, [])
})

test('判据 6：失败的 vdInfo 回执不得覆盖已有缓存（不得用失败态冲掉真实注册表）', async () => {
  const queue = new ControlQueue()
  const first = queue.enqueue('vdInfo', {}, 2000)
  const t1 = queue.take()
  queue.settle(t1.reqId, { ok: true, data: { ok: true, enabled: true, screens: [{ alias: 'virtual-1', displayId: 42 }] } })
  await first
  const before = queue.lastVdInfoSnapshot()
  assert.ok(before)
  const second = queue.enqueue('vdInfo', {}, 2000)
  const t2 = queue.take()
  queue.settle(t2.reqId, { ok: false, error: '设备控制超时' })
  await second
  assert.deepEqual(queue.lastVdInfoSnapshot(), before, '失败回执不得冲掉上一份成功缓存')
})
