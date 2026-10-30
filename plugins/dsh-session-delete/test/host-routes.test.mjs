// 直接驱动 host 的三条路由：鉴权、方法、请求体上限、错误码映射。
// 这些分支此前只靠 curl 手工验证，回归没有覆盖。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, removeSession } from '../src/index.js'
import { quarantineStoredSession } from '../src/session-delete.js'

// apply() 注册路由前会对 DSH_HOME 跑一次 graveyard 清扫（best-effort）。
// 测试进程必须把它钉在临时目录上：否则开发机上真实 ~/.dsh/sessions 里若有
// .deleting-* 残留，跑一遍测试就会动真实数据——测试不拥有那个目录。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-session-delete-test-home-'))

/** 收集注册的路由并提供一个可注入依赖的 ctx。 */
function makeHost(overrides = {}) {
  const routes = new Map()
  const ctx = {
    webServer: { register: (route) => { routes.set(route.path, route) } },
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'connection') return { requestRejection: overrides.requestRejection ?? (() => undefined) }
      if (name === 'sessions') return overrides.sessions
      if (name === 'workspaceRegistry') return overrides.registry
      return undefined
    },
    waterfall: overrides.waterfall,
  }
  apply(ctx)
  return { routes, ctx }
}

/** 假请求：body 为 Buffer 或超长串。 */
function request(method, body) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    url: '/api/session-delete',
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
}

/** 假响应：记录状态与 JSON。 */
function response() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers ?? {} },
    end(chunk) { out.body = chunk ?? '' },
  }
}

async function call(routes, path, req) {
  const res = response()
  await routes.get(path).handler(req, res)
  return { status: res.out.status, json: res.out.body === '' ? null : JSON.parse(res.out.body), headers: res.out.headers }
}

test('rejects unauthenticated requests with 401 before doing anything', async () => {
  const { routes } = makeHost({ requestRejection: () => 401 })
  const res = await call(routes, '/api/session-delete', request('POST', { sessionId: 'session-11111111-1111-4111-8111-111111111111' }))
  assert.equal(res.status, 401)
  assert.equal(res.json.error, 'unauthorized')
})

test('answers 405 for non-POST methods', async () => {
  const { routes } = makeHost()
  const res = await call(routes, '/api/session-delete', request('GET'))
  assert.equal(res.status, 405)
  assert.equal(res.json.error, 'method-not-allowed')
})

test('rejects a malformed id with 400', async () => {
  const { routes } = makeHost()
  const res = await call(routes, '/api/session-delete', request('POST', { sessionId: '../etc/passwd' }))
  assert.equal(res.status, 400)
  assert.equal(res.json.error, 'invalid-id')
})

test('rejects an oversized body with 400 invalid-body', async () => {
  const { routes } = makeHost()
  const res = await call(routes, '/api/session-delete', request('POST', 'x'.repeat(9000)))
  assert.equal(res.status, 400)
  assert.equal(res.json.error, 'invalid-body')
})

test('maps an unknown activity probe to 409 activity-unknown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { routes } = makeHost({ sessions: { get: () => undefined } }) // 无 waterfall ⇒ 未知
    const res = await call(routes, '/api/session-delete', request('POST', { sessionId: 'session-22222222-2222-4222-8222-222222222222' }))
    assert.equal(res.status, 409)
    assert.equal(res.json.error, 'activity-unknown')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('maps a missing session to 404 not-found', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { routes } = makeHost({ sessions: { get: () => undefined }, waterfall: async () => [] })
    const res = await call(routes, '/api/session-delete', request('POST', { sessionId: 'session-33333333-3333-4333-8333-333333333333' }))
    assert.equal(res.status, 404)
    assert.equal(res.json.error, 'not-found')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the version route answers the build stamp without auth bypass', async () => {
  const { routes } = makeHost({ requestRejection: () => 403 })
  const res = await call(routes, '/api/session-delete-version', request('GET'))
  assert.equal(res.status, 403)
})

test('removeSession is exported for direct use and validates the id', async () => {
  await assert.rejects(removeSession({ get: () => undefined }, 'nope'), (e) => e.code === 'invalid-id')
})

/** 造一个 live 会话目录（含 session.lock / 日志文件）。 */
async function makeSession(home, id) {
  const dir = join(home, 'sessions', '--workspace--', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.lock'), '')
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  return dir
}

/** 可卸载的假 sessions 服务。 */
function liveSessions(id) {
  const state = { live: true }
  return {
    state,
    get: () => (state.live ? { id, header: { id } } : undefined),
    liveEntryFor: () => ({ detach: () => { state.live = false } }),
  }
}

test('a successful route call unloads the session and removes the directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-routes-ok-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const id = 'session-55555555-5555-4555-8555-555555555555'
  try {
    const dir = await makeSession(home, id)
    const sessions = liveSessions(id)
    const { routes } = makeHost({ sessions, waterfall: async () => [], registry: {} })
    const res = await call(routes, '/api/session-delete', request('POST', { sessionId: id }))
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(sessions.state.live, false, 'the session must be unloaded')
    assert.deepEqual(await readdir(join(home, 'sessions', '--workspace--')), [], 'the directory must be gone')
    assert.equal(dir.includes(id), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the trace route accepts POST and rejects other methods', async () => {
  const { routes } = makeHost()
  const ok = await call(routes, '/api/session-delete-trace', request('POST', { event: 'x' }))
  assert.equal(ok.status, 200)
  const bad = await call(routes, '/api/session-delete-trace', request('GET'))
  assert.equal(bad.status, 405)
})

test('the version route returns a stamp', async () => {
  const { routes } = makeHost()
  const res = await call(routes, '/api/session-delete-version', request('GET'))
  assert.equal(res.status, 200)
  assert.equal(typeof res.json.stamp, 'string')
  assert.notEqual(res.json.stamp, '')
})

// issue #983：已隔离的会话再点一次「隔离」，宿主必须把隔离件路径**带回客户端**——
// 它是「文件仍在、可恢复」的唯一证据。修复前 failureOf() 只返回 { status, code, message }，
// 细节落在 error.details.paths 上从不外带，于是回包里没有 paths，客户端只能渲染空路径横幅。
test('already-quarantined 的回包带 paths（issue #983）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-routes-quarantined-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const id = 'session-99999999-9999-4999-8999-999999999999'
  try {
    const dir = await makeSession(home, id)
    const first = await quarantineStoredSession({ home, sessionId: id })
    assert.equal(first.quarantinedTo.startsWith(dir), false, '隔离件必须在 .corrupt 下，不在原位')
    const { routes } = makeHost({ sessions: { get: () => undefined }, waterfall: async () => [], registry: {} })
    const res = await call(routes, '/api/session-delete', request('POST', { sessionId: id, action: 'quarantine' }))
    assert.equal(res.status, 409)
    assert.equal(res.json.error, 'already-quarantined')
    assert.equal(Array.isArray(res.json.paths), true, '回包必须带 paths 数组')
    assert.deepEqual(res.json.paths, [first.quarantinedTo], 'paths 必须就是隔离件路径')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// issue #983：paths 只给 already-quarantined。别的错误码乱塞字段会把内部细节漏给前端，
// 也会让客户端误以为「有路径 = 已隔离」。
test('其他错误码的回包不带 paths 字段（issue #983）', async () => {
  const { routes } = makeHost({ sessions: { get: () => undefined }, waterfall: async () => [] })
  const res = await call(routes, '/api/session-delete', request('POST', { sessionId: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc' }))
  assert.equal(res.status, 404)
  assert.equal(res.json.error, 'not-found')
  assert.equal(Object.prototype.hasOwnProperty.call(res.json, 'paths'), false, 'not-found 不得携带 paths')
})
