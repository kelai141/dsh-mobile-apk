// FX-205.1-.7 / ST-07 回归（可离线跑：无设备、无引擎、无网络）：
//  - 三条 exact 路由的插件侧鉴权（Host 白名单 / Origin 同源 / 控制令牌 / 浏览器会话）；
//  - GET /clean → 405 且工作区零变化；POST /clean 只删本工具自有临时项；
//  - 路由注册即 effect：卸载回收、重载不产生重复 handler。
//
// 令牌来源走 ST-07 的显式测试开关（DSH_CONTROL_TOKEN_TEST=1 + DSH_CONTROL_TOKEN），
// 因此本文件同时验证「测试开关下 env 生效」这条路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'test-token-0123456789'
process.env.DSH_CONTROL_TOKEN_TEST = '1'
process.env.DSH_CONTROL_TOKEN = TOKEN
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-boot-'))

const { apply } = await import('../lib/index.js')
const { TRUSTED_HOSTS, CONTROL_TOKEN_HEADER, authorizeIncomingRoute } = await import('../lib/route-auth.js')

const ROUTES = {
  list: '/api/android/file-incoming',
  claim: '/api/android/file-incoming/claim',
  clean: '/api/android/file-incoming/clean',
}
const HOST = TRUSTED_HOSTS[0]

/** 每个用例一个独立 HOME：tmpWorkspace() 每次调用实时读 DSH_HOME。 */
function freshWorkspace() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
  process.env.DSH_HOME = home
  const ws = join(home, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  return ws
}

/** 工作区快照（相对路径 + 大小）：用于「零变化」断言。 */
function snapshot(dir) {
  const out = []
  const walk = (d, prefix) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix + name.name
      if (name.isDirectory()) {
        out.push(rel + '/')
        walk(join(d, name.name), rel + '/')
      } else {
        out.push(rel + ':' + String(readFileSync(join(d, name.name)).length))
      }
    }
  }
  walk(dir, '')
  return out.sort()
}

function makeCtx(connection, extras = {}) {
  const routes = new Map()
  const disposers = []
  const registerCalls = []
  const calls = { sessionCreate: [], prompt: [], append: 0, workspaceCreate: [], workspaceDelete: [] }
  const workspaces = extras.workspaces ?? []
  let seq = 0
  const appendStub = () => { calls.append += 1 }
  const sessions = extras.sessions ?? {
    // R1 降级路径才走存储层：命令面在场时不该被调用
    create() { seq += 1; return { id: 'session-' + '0'.repeat(8) + '-stub' + seq, append: appendStub } },
    get(id) { return { id, append: appendStub } },
  }
  const workspaceRegistry = extras.workspaceRegistry ?? {
    async create(path, title) {
      calls.workspaceCreate.push(path)
      const ws = { id: 'ws-' + (workspaces.length + 1), path, title, sessionIds: [] }
      workspaces.push(ws)
      return ws
    },
    list: () => workspaces,
    async delete(id) {
      calls.workspaceDelete.push(id)
      const i = workspaces.findIndex((w) => w.id === id)
      if (i >= 0) workspaces.splice(i, 1)
      return i >= 0
    },
  }
  const sessionController = extras.sessionController === undefined
    ? undefined
    : {
      async create(request) { calls.sessionCreate.push(request); return extras.sessionController.create(request) },
      async prompt(request, signal) { calls.prompt.push({ request, signal }); return extras.sessionController.prompt(request, signal) },
    }
  // cordis 服务面：属性（inject 声明）与 ctx.get 读的是同一批服务。
  const services = { connection, sessionController, sessions, workspaceRegistry }
  const target = {
    logger: () => ({ warn() {}, info() {} }),
    tools: { register() {} },
    sessions,
    workspaceRegistry,
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return d },
    on() {},
    /** cordis ctx.get：无 inject 要求，服务缺失返回 undefined。 */
    get(name) { return services[name] },
    webServer: {
      register(route) {
        registerCalls.push(route.path)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  }
  target.routes = routes
  // cordis ReflectService.handler.get 的保真替身：**未声明 inject 的属性访问直接抛**
  // 「cannot get property "<name>" without inject」。0.14.0-preview-SN-1-13 设备实测：
  // Reflect.get(ctx, 'connection') 抛出的异常被上游 webserver 的兜底 catch 成 400
  // （dsh/packages/host/webserver/src/index.ts:244-251），三条路由整组 400。
  // 该替身让这一缺陷类在离线单测里必红（服务只能经 ctx.get 读取）。
  const ctx = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, recv)
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })
  return { ctx, routes, disposers, registerCalls, calls, workspaces }
}

/** 装载插件并等一拍：启动期的工作区解析/补建是异步的——取基线前先让它落定。 */
async function boot(ctx) {
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 40))
}

function fakeReq({ method = 'POST', headers = {}, body } = {}) {
  const handlers = {}
  return {
    method,
    headers,
    on(event, cb) { (handlers[event] ??= []).push(cb) },
    emit() {
      const payload = Buffer.from(JSON.stringify(body ?? {}))
      for (const cb of handlers.data ?? []) cb(payload)
      for (const cb of handlers.end ?? []) cb()
    },
    destroy() {},
  }
}

async function call(ctx, path, { method = 'POST', headers = {}, body, connectionHeaders } = {}) {
  const route = ctx.routes.get(path)
  assert.ok(route, 'route must be registered: ' + path)
  const req = fakeReq({ method, headers, body })
  const res = {
    code: 0, body: undefined, headers: {},
    writeHead(code, h) { this.code = code; this.headers = h ?? {} },
    end(b) { this.body = b ?? '' },
  }
  const done = route.handler(req, res)
  if (body !== undefined) req.emit()
  await done
  return res
}

const legit = () => ({ host: HOST, [CONTROL_TOKEN_HEADER]: TOKEN })

test('FX-205.1 无 cookie 且无令牌 → 401，工作区零变化', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.list, { method: 'GET', headers: { host: HOST } })
  assert.equal(res.code, 401)
  assert.deepEqual(snapshot(ws), before, '被拒请求不得改动工作区')
})

test('FX-205.3 伪造 Origin → 403 且响应体为空', async () => {
  const ws = freshWorkspace()
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.list, {
    method: 'GET',
    headers: { host: HOST, origin: 'http://evil.example', [CONTROL_TOKEN_HEADER]: TOKEN },
  })
  assert.equal(res.code, 403)
  assert.equal(res.body, '', '403 不得回任何正文（防 rebound 页面读到清单）')
  assert.deepEqual(snapshot(ws), before)
})

test('FX-205.4 篡改 Host（DNS rebinding 形态）→ 403 / 空体 / 零变化', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'tool-owned.bin'), 'x')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  for (const host of ['evil.example', 'evil.example:3080', '127.0.0.1:3081']) {
    const res = await call(ctx, ROUTES.clean, {
      method: 'POST',
      headers: { host, [CONTROL_TOKEN_HEADER]: TOKEN },
    })
    assert.equal(res.code, 403, 'host=' + host + ' 必须被拒')
    assert.equal(res.body, '')
  }
  assert.deepEqual(snapshot(ws), before, 'Host 被拒时拒绝发生在 handler 副作用之前')
})

test('FX-205.1 合法令牌 → 三条路由放行（GET 清单 + POST 投递）', async () => {
  const ws = freshWorkspace()
  const incoming = join(ws, 'photo.jpg')
  writeFileSync(incoming, 'img')
  const { ctx } = makeCtx()
  await boot(ctx)
  const listed = await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })
  assert.equal(listed.code, 200)
  assert.equal(JSON.parse(listed.body).ok, true)
  const delivered = await call(ctx, ROUTES.list, {
    method: 'POST', headers: legit(), body: { path: incoming },
  })
  assert.equal(delivered.code, 200)
  assert.equal(JSON.parse(delivered.body).ok, true, '壳侧投递不得被 403 静默拒收')
  assert.equal(readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json')).length, 1)
})

test('FX-205.1 浏览器会话（上游 connection 栅栏放行）→ 200；被拒 → 401', async () => {
  const ws = freshWorkspace()
  const allowed = makeCtx({ requestRejection: () => undefined })
  await boot(allowed.ctx)
  const before = snapshot(ws)
  const ok = await call(allowed.ctx, ROUTES.list, { method: 'GET', headers: { host: HOST, cookie: 'dsh-auth=abc' } })
  assert.equal(ok.code, 200)

  const denied = makeCtx({ requestRejection: () => 401 })
  await boot(denied.ctx)
  const no = await call(denied.ctx, ROUTES.list, { method: 'GET', headers: { host: HOST } })
  assert.equal(no.code, 401)
  assert.deepEqual(snapshot(ws), before)
})

test('FX-205.2 GET /clean → 405 且工作区零变化', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'owned.tmp'), 'owned')
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.clean, { method: 'GET', headers: legit() })
  assert.equal(res.code, 405)
  assert.equal(res.headers.allow, 'POST')
  assert.deepEqual(snapshot(ws), before, 'GET 不得触发任何删除')
  assert.ok(existsSync(join(ws, 'owned.tmp')))
})

test('FX-205.5 POST /clean 只删自有临时项：.sessions 豁免项 + 用户文件零变化', async () => {
  const ws = freshWorkspace()
  const sessions = join(ws, '.sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 'keep.json'), '{"ts":"x"}')
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const toolTmp = join(ws, 'tool-temp.bin')
  writeFileSync(toolTmp, 'tool')
  writeFileSync(join(ws, '.tool-temp.ndjson'), toolTmp + '\n')
  const { ctx } = makeCtx()
  await boot(ctx)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(existsSync(toolTmp), false, '自有临时项必须被删')
  assert.equal(existsSync(join(ws, 'user-file.txt')), true, '用户文件零变化')
  assert.equal(existsSync(join(sessions, 'keep.json')), true, '.sessions 豁免项零变化')
})

test('FX-205.5 设备回归：清单记 canonical 形态、DSH_HOME 词法为另一形态时仍必须删除', async () => {
  // 用 Windows junction 复刻 Android 的 /data/user/0 <-> /data/data 双形态：
  // DSH_HOME 走 link 形态，而 enqueueSession 记账走 realpath 形态（设备实测组合）。
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const ws = join(linkHome, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const toolCanonical = join(realpathSync(linkHome), 'workspaces', 'incoming', 'tool-canonical.bin')
  writeFileSync(toolCanonical, 'tool')
  writeFileSync(join(ws, '.tool-temp.ndjson'), toolCanonical + '\n')
  const { ctx } = makeCtx()
  await boot(ctx)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).removed, 1, 'canonical 形态的自有项必须被删（旧实现恒 removed:0 且清单被清空）')
  assert.equal(existsSync(toolCanonical), false)
  assert.equal(existsSync(join(ws, 'user-file.txt')), true)
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('FX-205.5 越界项不得从清单静默消失（保留可重试，且绝不删工作区外文件）', async () => {
  const ws = freshWorkspace()
  const owned = join(ws, 'owned-good.bin')
  writeFileSync(owned, 'x')
  const outside = join(tmpdir(), 'dsh-outside-' + Date.now() + '.bin')
  writeFileSync(outside, 'y')
  writeFileSync(join(ws, '.tool-temp.ndjson'), owned + '\n' + outside + '\n')
  const { ctx } = makeCtx()
  await boot(ctx)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).removed, 1)
  assert.equal(existsSync(owned), false)
  assert.equal(existsSync(outside), true, '工作区外文件绝不能被删')
  const kept = readFileSync(join(ws, '.tool-temp.ndjson'), 'utf8')
  assert.ok(kept.includes(outside), '越界项必须留在清单里（不得静默丢所有权）')
  assert.ok(!kept.includes(owned), '已删除项必须从清单移除')
  rmSync(outside, { force: true })
})

test('FX-205.5 无记账清单时 /clean 不删任何东西（fail-safe）', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).removed, 0)
  assert.deepEqual(snapshot(ws), before)
})

test('FX-205.7 卸载回收三条路由；重新装载只有一份注册（无重复 handler）', async () => {
  const first = makeCtx()
  await boot(first.ctx)
  assert.deepEqual([...first.routes.keys()].sort(), Object.values(ROUTES).sort())
  assert.equal(first.disposers.length, 3, '三条注册必须各包一层 ctx.effect')
  for (const dispose of first.disposers) dispose()
  assert.equal(first.routes.size, 0, '卸载后路由必须不再应答')

  const second = makeCtx()
  await boot(second.ctx)
  const perPath = second.registerCalls.filter((p) => p === ROUTES.list).length
  assert.equal(perPath, 1, '同一 path 每次装载只注册一份')
  assert.equal(second.routes.size, 3)
})

test('设备回归：cordis 风格 Context 只能经 ctx.get 读服务（属性访问未 inject 会抛 → 上游兜底 400）', async () => {
  const ws = freshWorkspace()
  // 保真的浏览器会话替身：只有带 cookie 的请求才被判为已认证（等价上游 BrowserAuth）。
  const harness = makeCtx({ requestRejection: (req) => (req.headers?.cookie ? undefined : 401) })
  const { ctx } = harness
  // 替身自洽性：属性访问确实会抛（与 cordis ReflectService.handler.get 同形）。
  assert.throws(() => { void ctx.connection }, /without inject/)
  // 设备实测的失效形态：该异常在 handler 内抛出且响应未发送 → 上游 webserver 回 400。
  // 修复后 handler 全程不触发该陷阱：浏览器会话请求照常 200。
  await boot(ctx)
  const before = snapshot(ws)
  const ok = await call(ctx, ROUTES.list, { method: 'GET', headers: { host: HOST, cookie: 'dsh-auth=abc' } })
  assert.equal(ok.code, 200)
  const withToken = await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })
  assert.equal(withToken.code, 200)
  const denied = await call(ctx, ROUTES.list, { method: 'GET', headers: { host: HOST } })
  assert.equal(denied.code, 401)
  assert.deepEqual(snapshot(ws), before)
})

test('R1 命令面：建会话走 sessionController.create({workspaceId}) + prompt(mode queue, signal 必传)', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'r1-in.txt')
  writeFileSync(probe, 'x')
  const createdRequests = []
  const promptRequests = []
  const harness = makeCtx(undefined, {
    workspaces: [],
    sessionController: {
      async create(request) { createdRequests.push(request); return { sessionId: 'session-abcdef12-3456' } },
      async prompt(request, signal) { promptRequests.push({ request, aborted: signal.aborted }); return { accepted: true } },
    },
  })
  await boot(harness.ctx)
  const res = await call(harness.ctx, ROUTES.list, { method: 'POST', headers: legit(), body: { path: probe } })
  assert.equal(res.code, 200)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(createdRequests.length, 1, '命令面 create 必须被调用一次')
  assert.equal(createdRequests[0].workspaceId, harness.workspaces[0].id, 'create 必须带解析出的 workspaceId（工作区归属）')
  assert.equal(promptRequests.length, 1, '首轮必须经命令面 prompt 排队')
  assert.equal(promptRequests[0].request.mode, 'queue')
  assert.equal(promptRequests[0].request.sessionId, 'session-abcdef12-3456')
  assert.equal(promptRequests[0].aborted, false, 'signal 必传且未中止')
  const files = readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 1)
  const entry = JSON.parse(readFileSync(join(ws, '.sessions', files[0]), 'utf8'))
  assert.equal(entry.sessionId, 'session-abcdef12-3456', 'IX-TW-02：条目回写 durable id')
  assert.equal(harness.calls.append, 0, '命令面成功时不得回落存储层 append')
})

test('R1：prompt 失败（模型未配置等）回落存储层 append，不漏件也不静默', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'r1-fallback.txt')
  writeFileSync(probe, 'x')
  const harness = makeCtx(undefined, {
    workspaces: [],
    sessionController: {
      async create() { return { sessionId: 'session-abcdef12-7777' } },
      async prompt() { throw new Error('no adapter serves provider') },
    },
  })
  await boot(harness.ctx)
  const res = await call(harness.ctx, ROUTES.list, { method: 'POST', headers: legit(), body: { path: probe } })
  assert.equal(res.code, 200)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(harness.calls.prompt.length, 1)
  assert.equal(harness.calls.append, 1, 'prompt 失败必须回落存储层 append（不丢件）')
  const files = readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json'))
  const entry = JSON.parse(readFileSync(join(ws, '.sessions', files[0]), 'utf8'))
  assert.equal(entry.sessionId, 'session-abcdef12-7777')
})

test('R2：同目录非 canonical 毒条目自愈删除并重建为 canonical 条目（IX-TW-01）', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const ws = join(linkHome, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  const canonical = join(realpathSync(linkHome), 'workspaces', 'incoming')
  const workspaces = [
    { id: 'ws-poison', path: ws, title: '临时工作区', sessionIds: [] },
    { id: 'ws-other', path: join(realHome, 'other'), title: '别的工作区', sessionIds: [] },
  ]
  const harness = makeCtx(undefined, {
    workspaces,
    sessionController: {
      async create() { return { sessionId: 'session-abcdef12-9999' } },
      async prompt() { return { accepted: true } },
    },
  })
  await boot(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const incoming = harness.workspaces.filter((w) => w.title === '临时工作区')
  assert.equal(incoming.length, 1, 'IX-TW-01：该标题下只剩 1 条登记')
  assert.equal(incoming[0].path, canonical, 'path 必须落在 canonical 形态')
  assert.equal(incoming[0].path, realpathSync(incoming[0].path), 'IX-TW-01：path == realpath(path)')
  assert.deepEqual(harness.calls.workspaceDelete, ['ws-poison'], '只删非 canonical 的残留')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('R2：已有 canonical 可用条目时直接复用（零 create / 零 delete）', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const canonical = join(realpathSync(linkHome), 'workspaces', 'incoming')
  mkdirSync(canonical, { recursive: true })
  const workspaces = [{ id: 'ws-good', path: canonical, title: '临时工作区', sessionIds: ['session-1'] }]
  const createdRequests = []
  const harness = makeCtx(undefined, {
    workspaces,
    sessionController: {
      async create(request) { createdRequests.push(request); return { sessionId: 'session-abcdef12-2222' } },
      async prompt() { return { accepted: true } },
    },
  })
  await boot(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(harness.calls.workspaceCreate, [], '可复用条目存在时不得重复 create')
  assert.deepEqual(harness.calls.workspaceDelete, [], '可复用条目不得被删')
  assert.equal(createdRequests.length, 0, '未触发补建时不建会话（无待建条目）')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('R2 设备形态：可用(canonical)条目与毒条目并存时，毒条目仍被自愈删除（IX-TW-01 唯一性）', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const canonical = join(realpathSync(linkHome), 'workspaces', 'incoming')
  mkdirSync(canonical, { recursive: true })
  // 设备实测形态：canonical 条目（有 5 个 durable sessionIds）+ 非 canonical 毒条目（sessionIds 空）
  const workspaces = [
    { id: 'ws-good', path: canonical, title: '临时工作区', sessionIds: ['session-aaaaaaaa-1'] },
    { id: 'ws-poison', path: join(linkHome, 'workspaces', 'incoming'), title: '临时工作区', sessionIds: [] },
    { id: 'ws-other', path: join(realHome, 'other'), title: '别的工作区', sessionIds: [] },
  ]
  const harness = makeCtx(undefined, { workspaces })
  await boot(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const incoming = harness.workspaces.filter((w) => w.title === '临时工作区')
  assert.equal(incoming.length, 1, 'IX-TW-01：该标题下只剩 1 条')
  assert.equal(incoming[0].id, 'ws-good', '可用条目必须保留（有会话的条目不得丢）')
  assert.equal(incoming[0].path, realpathSync(incoming[0].path), 'IX-TW-01：path == realpath(path)')
  assert.deepEqual(harness.calls.workspaceDelete, ['ws-poison'])
  assert.deepEqual(harness.calls.workspaceCreate, [], '已有可用条目 → 不重复 create')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('IX-TW-09/R1：遗留 session-N 条目自愈重建；并发补建串行化（每条只建一次）', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'legacy.txt')
  writeFileSync(probe, 'x')
  const sessionsDir = join(ws, '.sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, 'legacy.json'), JSON.stringify({ ts: 't', path: probe, context: 'c', forcedNewSession: true, sessionId: 'session-1' }))
  writeFileSync(join(sessionsDir, 'fresh.json'), JSON.stringify({ ts: 't', path: probe, context: 'c', forcedNewSession: true }))
  let creates = 0
  const harness = makeCtx(undefined, {
    workspaces: [],
    sessionController: {
      async create() {
        creates += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { sessionId: 'session-' + String(creates).padStart(8, '0') + '-abc' }
      },
      async prompt() { return { accepted: true } },
    },
  })
  await boot(harness.ctx)
  await boot(harness.ctx) // 第二次装载并发触发补建（模拟启动补建 + POST 并发）
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(creates, 2, '两条待建条目各建一次会话（串行化，不重复建）')
  for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
    assert.ok(/^session-[0-9a-f]{8}-/.test(j.sessionId ?? ''), 'IX-TW-02：id 必须 durable 形态，实际 ' + String(j.sessionId))
  }
})

test('鉴权纯函数：trusted host 列表与令牌头常量与壳侧契约一致', () => {
  assert.deepEqual([...TRUSTED_HOSTS].sort(), ['127.0.0.1:3080', 'localhost:3080'].sort())
  assert.equal(CONTROL_TOKEN_HEADER, 'x-dsh-control-token')
  assert.equal(authorizeIncomingRoute({ headers: {} }, { token: () => TOKEN }).code, 403, '缺 Host 一律拒')
  assert.equal(
    authorizeIncomingRoute({ headers: { host: HOST, [CONTROL_TOKEN_HEADER]: TOKEN } }, { token: () => TOKEN }),
    undefined,
    '白名单 Host + 合法令牌必须放行',
  )
  assert.equal(authorizeIncomingRoute({ headers: { host: HOST } }, { token: () => undefined }).code, 401)
  assert.equal(authorizeIncomingRoute({ headers: { host: 'evil.example' } }, { token: () => TOKEN }).code, 403)
})
