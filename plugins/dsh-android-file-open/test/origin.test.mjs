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

/** 队列里唯一一条记录（原始 JSON）。 */
function onlyRecord(ws) {
  const files = readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 1, '队列里必须正好一条记录')
  return JSON.parse(readFileSync(join(ws, '.sessions', files[0]), 'utf8'))
}

test('来源闭集：缺省是 external，未知值塌回 external（fail-closed 到强制新会话）', () => {
  assert.equal(DEFAULT_ORIGIN, 'external')
  assert.deepEqual([...INCOMING_ORIGINS].sort(), ['camera', 'external'])
  assert.equal(normalizeOrigin(undefined), 'external')
  assert.equal(normalizeOrigin(''), 'external')
  assert.equal(normalizeOrigin('camer'), 'external', '拼错的来源不得被当成 camera')
  assert.equal(normalizeOrigin('EXTERNAL'), 'external')
  assert.equal(normalizeOrigin(42), 'external')
  assert.equal(normalizeOrigin('camera'), 'camera')
})

test('投递不带 origin → 记录 origin=external（外部分享仍然强制新会话，F5.2 守门）', async () => {
  const ws = freshWorkspace()
  const incoming = join(ws, 'share.pdf')
  writeFileSync(incoming, 'pdf')
  const { ctx } = makeCtx()
  apply(ctx)
  await new Promise((r) => setTimeout(r, 20))
  const res = await call(ctx, LIST, { method: 'POST', headers: legit(), body: { path: incoming } })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(onlyRecord(ws).origin, 'external')
})

test('投递带 origin=camera → 记录 origin=camera', async () => {
  const ws = freshWorkspace()
  const incoming = join(ws, 'photo-20260101-000000-000.jpg')
  writeFileSync(incoming, 'img')
  const { ctx } = makeCtx()
  apply(ctx)
  await new Promise((r) => setTimeout(r, 20))
  const res = await call(ctx, LIST, { method: 'POST', headers: legit(), body: { path: incoming, origin: 'camera' } })
  assert.equal(res.code, 200)
  const record = onlyRecord(ws)
  assert.equal(record.origin, 'camera', '拍照来件必须记住来源，页面据此并入当前会话')
  assert.equal(record.state, 'received', '仍然由页面侧 claim 收口')
})

test('投递带伪造 origin → 塌回 external，绝不并入既有会话', async () => {
  const ws = freshWorkspace()
  const incoming = join(ws, 'x.bin')
  writeFileSync(incoming, 'x')
  const { ctx } = makeCtx()
  apply(ctx)
  await new Promise((r) => setTimeout(r, 20))
  const res = await call(ctx, LIST, { method: 'POST', headers: legit(), body: { path: incoming, origin: 'attach-to-current' } })
  assert.equal(res.code, 200)
  assert.equal(onlyRecord(ws).origin, 'external')
})

test('GET 清单把 origin 暴露给页面（页面没有别的判据）', async () => {
  const ws = freshWorkspace()
  const external = join(ws, 'shared.pdf')
  const camera = join(ws, 'photo-1.jpg')
  writeFileSync(external, 'a')
  writeFileSync(camera, 'b')
  const { ctx } = makeCtx()
  apply(ctx)
  await new Promise((r) => setTimeout(r, 20))
  await call(ctx, LIST, { method: 'POST', headers: legit(), body: { path: external } })
  await call(ctx, LIST, { method: 'POST', headers: legit(), body: { path: camera, origin: 'camera' } })
  const listed = await call(ctx, LIST, { method: 'GET', headers: legit() })
  assert.equal(listed.code, 200)
  const items = JSON.parse(listed.body).items
  assert.equal(items.length, 2)
  const byName = Object.fromEntries(items.map((i) => [i.name, i.origin]))
  assert.equal(byName['shared.pdf'], 'external')
  assert.equal(byName['photo-1.jpg'], 'camera')
})

test('向后兼容：老记录（无 origin 字段）按 external 处理', async () => {
  const ws = freshWorkspace()
  const sessions = join(ws, '.sessions')
  mkdirSync(sessions, { recursive: true })
  const legacyPath = join(ws, 'legacy-share.pdf')
  writeFileSync(legacyPath, 'old')
  // 本次改动之前落盘的记录形态：没有 origin 字段。
  writeFileSync(join(sessions, 'legacy-entry.json'), JSON.stringify({
    id: 'legacy-entry',
    ts: new Date().toISOString(),
    path: legacyPath,
    forcedNewSession: true,
    state: 'received',
    name: 'legacy-share.pdf',
    bytes: 3,
  }))
  const { ctx } = makeCtx()
  apply(ctx)
  await new Promise((r) => setTimeout(r, 20))
  const listed = await call(ctx, LIST, { method: 'GET', headers: legit() })
  assert.equal(listed.code, 200)
  const items = JSON.parse(listed.body).items
  assert.equal(items.length, 1)
  assert.equal(items[0].origin, 'external', '缺字段的老记录必须按外部分享（强制新会话）处理')
})
