// 来件**来源**（origin）判据（缺陷 1：拍照后附件被投进新会话）。
//
// 缺陷链：壳侧拍照 → POST /api/android/file-incoming {path}（**不带来源**）→ enqueueSession
// 落一条「没有目标会话」的记录 → 页面 incoming-draft 见 sessionId 缺失就 createSession +
// openSession ⇒ 拍照结果进了新会话。
//
// 修复：记录带 origin。external（缺省）= 外部分享 = 强制新会话（PRD F5.2 不得削弱）；
// camera = 壳侧自产拍照 = 并入页面当前会话。
//
// 本文件锁四条：
//  ① 缺省来源必须是 external（漏传不得升级成「并入既有会话」）；
//  ② camera 显式声明时落盘记录 origin === 'camera'；
//  ③ GET 清单必须把 origin 暴露给页面（页面没有别的判据）；
//  ④ **向后兼容**：本次改动之前落盘的老记录（无 origin 字段）必须按 external 处理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'origin-test-token-0123456789'
process.env.DSH_CONTROL_TOKEN_TEST = '1'
process.env.DSH_CONTROL_TOKEN = TOKEN
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-origin-boot-'))

const { apply, normalizeOrigin, INCOMING_ORIGINS, DEFAULT_ORIGIN } = await import('../lib/index.js')
const { loopbackAuthorities, CONTROL_TOKEN_HEADER } = await import('../lib/route-auth.js')
const HOST = loopbackAuthorities()[0]
const LIST = '/api/android/file-incoming'

/** 每个用例一个独立 HOME（tmpWorkspace() 每次实时读 DSH_HOME）。 */
function freshWorkspace() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-file-open-origin-'))
  process.env.DSH_HOME = home
  const ws = join(home, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  return ws
}

function makeCtx() {
  const routes = new Map()
  const target = {
    logger: () => ({ warn() {}, info() {} }),
    tools: { register() {} },
    sessions: { create() { return { id: 'session-00000000-stub' } } },
    workspaceRegistry: { async create(path, title) { return { id: 'ws-1', path, title, sessionIds: [] } }, list: () => [] },
    effect(cb) { const d = cb(); return d },
    on() {},
    get(name) { return name === 'connection' ? undefined : undefined },
    webServer: {
      register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } },
    },
  }
  target.routes = routes
  const ctx = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, recv)
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })
  return { ctx, routes }
}

function fakeReq({ method = 'POST', headers = {}, body, url = '' } = {}) {
  const handlers = {}
  return {
    method, headers, url,
    on(event, cb) { (handlers[event] ??= []).push(cb) },
    emit() {
      const payload = Buffer.from(JSON.stringify(body ?? {}))
      for (const cb of handlers.data ?? []) cb(payload)
      for (const cb of handlers.end ?? []) cb()
    },
    destroy() {},
  }
}

async function call(ctx, path, { method = 'POST', headers = {}, body, url = path } = {}) {
  const route = ctx.routes.get(path)
  assert.ok(route, 'route must be registered: ' + path)
  const req = fakeReq({ method, headers, body, url })
  const chunks = []
  const res = {
    code: 0, headers: {},
    writeHead(code, h) { this.code = code; this.headers = h ?? {} },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true },
    end(b) { if (b !== undefined && b !== null) chunks.push(Buffer.from(b)); return this },
    on() {}, once() {}, emit() {}, destroy() {}, removeListener() {},
  }
  const done = route.handler(req, res)
  if (body !== undefined) req.emit()
  await done
  res.body = chunks.length === 0 ? '' : Buffer.concat(chunks)
  return res
}

const legit = () => ({ host: HOST, [CONTROL_TOKEN_HEADER]: TOKEN })

test('overlay queue preserves target and request identity, rejects cross-session claims, reports actual completion', async () => {
  const ws = freshWorkspace(), { ctx } = makeCtx()
  apply(ctx)
  const path = join(ws, 'picked.png'); writeFileSync(path, 'bytes')
  const targetSessionId = 'session-aaaaaaaa-1111', requestId = 'overlay-request-1234'
  const posted = await call(ctx, LIST, { headers: legit(), body: { path, origin: 'camera', targetSessionId, requestId, mediaType: 'image/png' } })
  assert.equal(JSON.parse(posted.body).ok, true)
  const listing = JSON.parse((await call(ctx, LIST, { method: 'GET', headers: legit() })).body)
  assert.equal(listing.items[0].targetSessionId, targetSessionId)
  assert.equal(listing.items[0].requestId, requestId)
  const entryId = listing.items[0].entryId
  const wrong = await call(ctx, LIST + '/claim', { headers: legit(), body: { entryId, sessionId: 'session-bbbbbbbb-2222' } })
  assert.equal(wrong.code, 409)
  assert.equal(JSON.parse(wrong.body).ok, false)
  const statusBefore = JSON.parse((await call(ctx, LIST, { method: 'GET', headers: legit(), url: LIST + '?requestId=' + requestId })).body)
  assert.equal(statusBefore.state, 'pending')
  const claim = JSON.parse((await call(ctx, LIST + '/claim', { headers: legit(), body: { entryId, sessionId: targetSessionId } })).body)
  assert.equal(claim.ok, true)
  await call(ctx, LIST + '/complete', { headers: legit(), body: { ticket: claim.ticket, outcome: 'draft-ready' } })
  const repeated = await call(ctx, LIST + '/complete', { headers: legit(), body: { ticket: claim.ticket, outcome: 'draft-ready' } })
  assert.equal(repeated.code, 200)
  assert.equal(JSON.parse(repeated.body).state, 'draft-ready')
  const statusAfter = JSON.parse((await call(ctx, LIST, { method: 'GET', headers: legit(), url: LIST + '?requestId=' + requestId })).body)
  assert.equal(statusAfter.state, 'draft-ready')
  assert.equal(statusAfter.targetSessionId, targetSessionId)
})

test('partial target metadata fails closed; retry cannot rebind a request to another session', async () => {
  const ws = freshWorkspace(), { ctx } = makeCtx(); apply(ctx)
  const path = join(ws, 'file.txt'); writeFileSync(path, 'bytes')
  const partial = await call(ctx, LIST, { headers: legit(), body: { path, targetSessionId: 'session-aaaaaaaa-1' } })
  assert.equal(partial.code, 400)
  const body = { path, origin: 'camera', targetSessionId: 'session-aaaaaaaa-1', requestId: 'overlay-request-5678' }
  assert.equal(JSON.parse((await call(ctx, LIST, { headers: legit(), body })).body).ok, true)
  assert.equal(JSON.parse((await call(ctx, LIST, { headers: legit(), body })).body).ok, true)
  assert.equal(JSON.parse((await call(ctx, LIST, { headers: legit(), body: { ...body, targetSessionId: 'session-bbbbbbbb-2' } })).body).ok, false)
  const list = JSON.parse((await call(ctx, LIST, { method: 'GET', headers: legit() })).body)
  assert.equal(list.items.length, 1)
})
