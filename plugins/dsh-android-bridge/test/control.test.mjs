// 无障碍控制通道回归（0.13.5 W4）：
// 策略 fail-closed（会话档位 + 双后端可用性）、队列串行/超时/令牌校验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideControl } from '../lib/control-policy.js'
import { ControlQueue, controlTokenFrom, registerControlRoutes, tokenMatches } from '../lib/control-queue.js'
import { parseAdbPrefsXml } from '../lib/index.js'

const base = { op: 'click', a11yEnabled: false, adbReady: false, sessionMode: 'danger-full-access' }

test('会话档位不是完全访问时两个后端都拒绝', () => {
  for (const a11yEnabled of [true, false]) {
    const d = decideControl({ ...base, a11yEnabled, adbReady: true, sessionMode: 'workspace-write' })
    assert.equal(d.backend, 'deny')
    assert.match(d.reason, /完全访问|danger-full-access/)
  }
})

test('无障碍已开启时优先走 a11y（即使 ADB 门也齐）', () => {
  const d = decideControl({ ...base, a11yEnabled: true, adbReady: true })
  assert.equal(d.backend, 'a11y')
})

test('无障碍未开启但 ADB 门齐 → 回落 ADB', () => {
  const d = decideControl({ ...base, a11yEnabled: false, adbReady: true })
  assert.equal(d.backend, 'adb')
})

test('两条通道都不可用 → 拒绝并给出两种开启方式的引导', () => {
  const d = decideControl({ ...base, a11yEnabled: false, adbReady: false })
  assert.equal(d.backend, 'deny')
  assert.match(d.guidance ?? '', /无障碍/)
  assert.match(d.guidance ?? '', /ADB/)
})

test('显式指定 a11y 但服务未开启 → 拒绝（不静默回落）', () => {
  const d = decideControl({ ...base, a11yEnabled: false, adbReady: true, forceBackend: 'a11y' })
  assert.equal(d.backend, 'deny')
  assert.match(d.reason, /无障碍服务未开启/)
})

test('显式指定 adb 且门未齐 → 拒绝', () => {
  const d = decideControl({ ...base, a11yEnabled: true, adbReady: false, forceBackend: 'adb' })
  assert.equal(d.backend, 'deny')
})

test('队列串行：一次只允许一个在途请求', async () => {
  const queue = new ControlQueue()
  const first = queue.enqueue('click', { path: '0.1' })
  assert.equal(queue.waiting, true)
  const second = await queue.enqueue('snapshot', {})
  assert.equal(second.ok, false)
  assert.match(second.error, /串行|在途/)
  const req = queue.take()
  assert.equal(req?.op, 'click')
  assert.equal(queue.settle(req.reqId, { ok: true, data: { clicked: true } }), true)
  assert.deepEqual(await first, { ok: true, data: { clicked: true } })
  assert.equal(queue.waiting, false)
})

test('过期 reqId 不覆盖在途请求', async () => {
  const queue = new ControlQueue()
  const pending = queue.enqueue('snapshot', {})
  const first = queue.take()
  assert.equal(queue.settle('c-nonexistent', { ok: true, data: {} }), false)
  assert.equal(queue.waiting, true)
  // 0.13.8 #181：在途（已取走未回填）时二次取活必须被拒——原实现会把同一 req
  // 再次交给轮询者，同一请求被执行两次（apk issue #181 实锤）。
  const second = queue.take()
  assert.equal(second, null, '在途时二次 take 必须返回 null（防双执行）')
  queue.settle(first.reqId, { ok: true, data: { gen: 1 } })
  assert.deepEqual(await pending, { ok: true, data: { gen: 1 } })
  // 回填后队列清空：take 再次返回 null（waiting=false）
  assert.equal(queue.take(), null)
})

test('#181 重复 settle 只接受第一次，二次为 409 语义', async () => {
  const queue = new ControlQueue()
  const pending = queue.enqueue('click', {})
  const req = queue.take()
  assert.equal(queue.settle(req.reqId, { ok: true, data: { n: 1 } }), true)
  assert.equal(queue.settle(req.reqId, { ok: true, data: { n: 2 } }), false, '重复 settle 必须拒绝')
  assert.deepEqual(await pending, { ok: true, data: { n: 1 } })
})

test('#181 超时清在途位：超时后新请求可以入队', async () => {
  const queue = new ControlQueue()
  const first = queue.enqueue('click', {}, 300)
  const req = queue.take()
  assert.ok(req, '取活成功且置在途位')
  const result = await first
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  // 超时清 pending + inFlight：新请求不再被「已有在途」拒绝
  const second = queue.enqueue('click', {})
  assert.equal(second instanceof Promise, true)
  const req2 = queue.take()
  assert.ok(req2, '超时清位后新请求可正常取活')
  queue.settle(req2.reqId, { ok: true, data: {} })
})

test('超时返回失败而不是模糊结果', async () => {
  const queue = new ControlQueue()
  const result = await queue.enqueue('click', {}, 500)
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  assert.equal(queue.waiting, false)
})

test('令牌校验：未配置/过短/不匹配一律拒绝', () => {
  assert.equal(tokenMatches(undefined, 'x'.repeat(20)), false)
  assert.equal(tokenMatches('short', 'short'), false)
  assert.equal(tokenMatches('a'.repeat(20), 'b'.repeat(20)), false)
  assert.equal(tokenMatches('a'.repeat(20), 'a'.repeat(20)), true)
  assert.equal(tokenMatches('a'.repeat(20), undefined), false)
})

test('令牌来源：环境变量优先，其次壳侧 prefs', () => {
  assert.equal(controlTokenFrom({ DSH_CONTROL_TOKEN: 'env-token-123456' }, { controlToken: 'prefs-token-123' }), 'env-token-123456')
  assert.equal(controlTokenFrom({}, { controlToken: 'prefs-token-123' }), 'prefs-token-123')
  assert.equal(controlTokenFrom({}, { controlToken: 'short' }), undefined)
  assert.equal(controlTokenFrom({}, undefined), undefined)
})

function fakeReq(body) {
  const handlers = {}
  return {
    method: 'POST',
    on(event, cb) { (handlers[event] ??= []).push(cb) },
    emit() {
      const payload = Buffer.from(JSON.stringify(body))
      for (const cb of handlers.data ?? []) cb(payload)
      for (const cb of handlers.end ?? []) cb()
    },
  }
}

function fakeRes() {
  return {
    code: 0,
    body: '',
    writeHead(code) { this.code = code },
    end(body) { this.body = body ?? '' },
  }
}

async function callRoute(routes, path, body) {
  const route = routes.find((r) => r.path === path)
  const req = fakeReq(body)
  const res = fakeRes()
  const done = route.handler(req, res)
  req.emit()
  await done
  return { code: res.code, json: res.body ? JSON.parse(res.body) : undefined }
}

test('路由：令牌不匹配 403；令牌正确可取活并回填', async () => {
  const routes = []
  const queue = new ControlQueue()
  registerControlRoutes({ register: (r) => routes.push(r) }, { queue, token: () => 't'.repeat(20) })
  assert.deepEqual(routes.map((r) => r.path).sort(), ['/api/android/ui/pending', '/api/android/ui/result'])

  const denied = await callRoute(routes, '/api/android/ui/pending', { token: 'wrong' })
  assert.equal(denied.code, 403)

  const pending = queue.enqueue('click', { path: '0.1' }, 4000)
  const poll = await callRoute(routes, '/api/android/ui/pending', { token: 't'.repeat(20) })
  assert.equal(poll.code, 200)
  assert.equal(poll.json.req.op, 'click')

  const settled = await callRoute(routes, '/api/android/ui/result', {
    token: 't'.repeat(20), reqId: poll.json.req.reqId, ok: true, data: { done: true },
  })
  assert.equal(settled.code, 200)
  assert.equal(settled.json.ok, true)
  assert.deepEqual(await pending, { ok: true, data: { done: true } })

  const stale = await callRoute(routes, '/api/android/ui/result', { token: 't'.repeat(20), reqId: 'nope', ok: true })
  assert.equal(stale.code, 409)
})

test('路由：未配置令牌时一律 403（fail-closed）', async () => {
  const routes = []
  registerControlRoutes({ register: (r) => routes.push(r) }, { queue: new ControlQueue(), token: () => undefined })
  const res = await callRoute(routes, '/api/android/ui/pending', { token: 'anything' })
  assert.equal(res.code, 403)
})

test('prefs 只含无障碍键时也要解析（0.13.5 实测踩坑：未开 ADB 时 a11y 事实被整体忽略）', () => {
  const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <boolean name="a11yEnabled" value="true" />
    <string name="controlToken">mqENICaCl5_BUV8yUaSn5QaS</string>
</map>`
  const parsed = parseAdbPrefsXml(xml)
  assert.ok(parsed, 'prefs 只含无障碍键时必须仍返回解析结果')
  assert.equal(parsed.a11yEnabled, true)
  assert.equal(parsed.controlToken, 'mqENICaCl5_BUV8yUaSn5QaS')
  assert.equal(parsed.allowSwitch, false)
  assert.equal(parsed.paired, false)
  assert.equal(parseAdbPrefsXml('<map></map>'), null)
})
