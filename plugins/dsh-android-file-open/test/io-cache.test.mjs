// I/O 去重的隔离与自愈（mkdirSync / realpathSync 缓存的契约测试）。
//
// 两处缓存都只在本进程内活：队列目录「已建出」结论（按完整 .sessions 路径为键）与工作区
// realpath（按工作区词法路径为键）。缓存一旦脱离路径这个键就会串：单测在同一进程内反复改
// DSH_HOME（每个用例一个独立 HOME），无键单例会把上一个 HOME 的结论套到新路径上。本文件锁：
//  ① 同进程切 DSH_HOME：投递必须落在新 HOME，旧 HOME 的队列不得被复用（写面键隔离）；
//  ② 切换后越界判定仍以新工作区为准（realpath 缓存同样是键隔离的，且不得反向放行）；
//  ③ 队列目录被外部删除：写不失败、读不报错，目录自动重建（清键后重试的自愈语义）；
//  ④ resolveIncomingWorkspace 的结论与「逐条重复解析」等价（复用 / 自愈删除 / 新建三条路径）；
//  ⑤ 队列目录建不出来时 android_file_incoming_status 仍回 { ok: false, error }，不抛未捕获异常。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'cache-test-token-0123456789'
process.env.DSH_CONTROL_TOKEN_TEST = '1'
process.env.DSH_CONTROL_TOKEN = TOKEN
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-cache-boot-'))

const { apply } = await import('../lib/index.js')
const { loopbackAuthorities, CONTROL_TOKEN_HEADER } = await import('../lib/route-auth.js')
const HOST = loopbackAuthorities()[0]

const LIST = '/api/android/file-incoming'
const INCOMING_TITLE = '临时工作区'

/** 每个用例一个独立 HOME：tmpWorkspace() 每次调用实时读 DSH_HOME。 */
function newHome({ createWorkspace = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-file-open-cache-'))
  process.env.DSH_HOME = home
  const ws = join(home, 'workspaces', 'incoming')
  if (createWorkspace) mkdirSync(ws, { recursive: true })
  return { home, ws }
}

/** 队列目录里的记录文件（目录不存在时回空数组，断言里区分「目录没建」与「没有记录」）。 */
function queueRecords(queueDir) {
  if (!existsSync(queueDir)) return []
  return readdirSync(queueDir).filter((f) => f.endsWith('.json'))
}

/** 工作区登记面替身：list/create/delete 全部计数，供等价性断言。 */
function makeRegistry(entries) {
  const state = entries.slice()
  const calls = { list: 0, create: [], deleted: [] }
  return {
    calls,
    current: state,
    async create(path, title) {
      calls.create.push({ path, title })
      const created = { id: 'ws-created-' + String(calls.create.length), path, title, sessionIds: [] }
      state.push(created)
      return created
    },
    list() {
      calls.list += 1
      return state
    },
    async delete(id) {
      calls.deleted.push(id)
      const index = state.findIndex((w) => w.id === id)
      if (index >= 0) state.splice(index, 1)
      return index >= 0
    },
  }
}

/**
 * 最小 cordis ctx 替身：未声明 inject 的属性访问直接抛（与 ReflectService.handler.get 同形），
 * 服务一律经 ctx.get 读取。tools.register 收集注册面，供工具级断言使用。
 */
function makeCtx({ registry, connection } = {}) {
  const routes = new Map()
  const tools = []
  const services = { connection, sessionController: undefined, sessions: undefined, workspaceRegistry: registry }
  const target = {
    logger: () => ({ warn() {}, info() {} }),
    tools: { register(tool) { tools.push(tool) } },
    sessions: undefined,
    workspaceRegistry: registry,
    effect(cb) { return cb() },
    on() {},
    get(name) { return services[name] },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  }
  const ctx = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, recv)
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })
  return { ctx, routes, tools }
}

/** 装载插件并等一拍：启动期的工作区解析是异步的，断言取基线前先让它落定。 */
async function boot(ctx) {
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 40))
}

function fakeReq({ method = 'GET', headers = {}, body, url = LIST } = {}) {
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

async function call(routes, { method = 'GET', headers = legit(), body } = {}) {
  const route = routes.get(LIST)
  assert.ok(route, '队列路由必须已注册')
  const req = fakeReq({ method, headers, body })
  const chunks = []
  const res = {
    code: 0, headers: {},
    writeHead(code, h) { this.code = code; this.headers = h ?? {} },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true },
    end(b) { if (b !== undefined && b !== null) chunks.push(Buffer.from(b)); return this },
  }
  const done = route.handler(req, res)
  if (body !== undefined) req.emit()
  await done
  res.body = chunks.length === 0 ? '' : Buffer.concat(chunks).toString()
  return res
}

const legit = () => ({ host: HOST, [CONTROL_TOKEN_HEADER]: TOKEN })

// ---------------------------------------------------------------------------
// ① 同进程切 DSH_HOME：缓存必须以完整路径为键
// ---------------------------------------------------------------------------

test('同进程切换 DSH_HOME：投递落在新 HOME 的队列，旧 HOME 不得被复用（写面键隔离）', async () => {
  const first = newHome()
  const { ctx, routes } = makeCtx()
  await boot(ctx)
  const fileA = join(first.ws, 'a.png')
  writeFileSync(fileA, 'A')
  const deliveredA = await call(routes, { method: 'POST', body: { path: fileA } })
  assert.equal(deliveredA.code, 200)
  assert.equal(JSON.parse(deliveredA.body).ok, true)
  const queueA = join(first.ws, '.sessions')
  assert.equal(queueRecords(queueA).length, 1, '第一次投递必须落在首个 HOME 的队列')

  // 同一进程里换 HOME：无键的「已建出」单例会把这里的写入带回 A 的目录。
  const second = newHome()
  const fileB = join(second.ws, 'b.png')
  writeFileSync(fileB, 'B')
  const deliveredB = await call(routes, { method: 'POST', body: { path: fileB } })
  assert.equal(deliveredB.code, 200)
  assert.equal(JSON.parse(deliveredB.body).ok, true, '新 HOME 的来件不得因为缓存键缺失而被拒收')
  assert.equal(queueRecords(join(second.ws, '.sessions')).length, 1, '记录必须落在新 HOME 的队列里')
  assert.equal(queueRecords(queueA).length, 1, '旧 HOME 的队列不得被再次写入')

  // 读面同理：清单必须读新 HOME。
  const listed = await call(routes)
  assert.equal(listed.code, 200)
  const payload = JSON.parse(listed.body)
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].name, 'b.png', '清单必须从新 HOME 的队列读取')
})

test('切换 DSH_HOME 后越界判定以新工作区为准（realpath 缓存按 ws 路径隔离，且不反向放行）', async () => {
  const first = newHome()
  const { ctx, routes } = makeCtx()
  await boot(ctx)
  const fileA = join(first.ws, 'a.png')
  writeFileSync(fileA, 'A')
  assert.equal(JSON.parse((await call(routes, { method: 'POST', body: { path: fileA } })).body).ok, true)

  const second = newHome()
  const fileB = join(second.ws, 'b.png')
  writeFileSync(fileB, 'B')
  const deliveredB = await call(routes, { method: 'POST', body: { path: fileB } })
  assert.equal(JSON.parse(deliveredB.body).ok, true, '工作区 realpath 缓存必须按路径命新 HOME（无键单例会把 B 判成越界）')

  // 反向：A 的文件在 B 的 HOME 下仍是越界，缓存不得把任何路径都放行。
  const crossed = await call(routes, { method: 'POST', body: { path: fileA } })
  assert.equal(JSON.parse(crossed.body).ok, false, '旧 HOME 的文件在切换后必须仍被判为越界')
})

// ---------------------------------------------------------------------------
// ② 队列目录被外部删除：清键后重试（写面与读面各一条）
// ---------------------------------------------------------------------------

test('队列目录被外部删除后：下一次投递清键重建目录，记录照常落盘', async () => {
  const { ws } = newHome()
  const { ctx, routes } = makeCtx()
  await boot(ctx)
  const queue = join(ws, '.sessions')
  assert.equal(existsSync(queue), true, '装配期必须已建出队列目录（F5.1）')

  const first = join(ws, 'first.png')
  writeFileSync(first, '1')
  assert.equal(JSON.parse((await call(routes, { method: 'POST', body: { path: first } })).body).ok, true)
  assert.equal(queueRecords(queue).length, 1)

  // 外部把整条队列目录删掉（清理工具/壳侧）：缓存还认为它存在。
  rmSync(queue, { recursive: true, force: true })
  assert.equal(existsSync(queue), false)

  const second = join(ws, 'second.png')
  writeFileSync(second, '2')
  const delivered = await call(routes, { method: 'POST', body: { path: second } })
  assert.equal(delivered.code, 200)
  assert.equal(JSON.parse(delivered.body).ok, true, '目录被删后投递必须自愈（缓存不失效会让写入一直 ENOENT）')
  assert.equal(existsSync(queue), true, '队列目录必须被重新建出')
  assert.equal(queueRecords(queue).length, 1, '重建后的队列只应有新记录（旧记录随目录一起消失）')

  const listed = await call(routes)
  assert.equal(JSON.parse(listed.body).items[0].name, 'second.png')
})

test('队列目录被外部删除后：清单 GET 不报错，目录重新建出并回空队列', async () => {
  const { ws } = newHome({ createWorkspace: false })
  const { ctx, routes } = makeCtx()
  await boot(ctx)
  const queue = join(ws, '.sessions')
  assert.equal(existsSync(queue), true, '干净 HOME 下装配期仍然必须建出工作区与队列目录（F5.1 兜底）')

  rmSync(queue, { recursive: true, force: true })
  const listed = await call(routes)
  assert.equal(listed.code, 200, '目录被删不得把清单读成 500')
  const payload = JSON.parse(listed.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.items.length, 0)
  assert.equal(existsSync(queue), true, '读路径必须自愈重建队列目录')
})

// ---------------------------------------------------------------------------
// ③ 队列目录建不出来：状态工具回错误对象，不抛未捕获异常
// ---------------------------------------------------------------------------

test('队列目录被同名文件占位（建不出来）时 android_file_incoming_status 回 { ok: false, error }', async () => {
  const { ws } = newHome()
  // 用同名文件占住 .sessions：mkdirSync 必然失败（EEXIST/ENOTDIR），等价于设备上不可建的形态。
  writeFileSync(join(ws, '.sessions'), 'not a directory')
  const { ctx, tools } = makeCtx()
  await boot(ctx)
  const statusTool = tools.find((tool) => tool.name === 'android_file_incoming_status')
  assert.ok(statusTool, '状态工具必须已注册')
  const result = await statusTool.execute({})
  assert.equal(result.ok, false, '读不到队列必须回错误对象（抛异常会冒到模型侧调用栈）')
  assert.equal(result.pending, 0)
  assert.deepEqual(result.items, [])
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0, '错误对象必须带原因')

  // 对照：正常 HOME 下同一工具返回 ok: true（错误出口不得变成常态）。
  newHome()
  const healthy = makeCtx()
  await boot(healthy.ctx)
  const healthyTool = healthy.tools.find((tool) => tool.name === 'android_file_incoming_status')
  const healthyResult = await healthyTool.execute({})
  assert.equal(healthyResult.ok, true)
  assert.equal(healthyResult.pending, 0)
})

// ---------------------------------------------------------------------------
// ④ resolveIncomingWorkspace：每个条目的 canonical 形态只解析一次，结论与逐个解析等价
// ---------------------------------------------------------------------------

/** 设备形态的工作区：DSH_HOME 走 link 形态，canonical 形态是 realpath 形态（/data/user/0 vs /data/data）。 */
function linkedWorkspace() {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-cache-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-cache-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const lexWs = join(linkHome, 'workspaces', 'incoming')
  mkdirSync(lexWs, { recursive: true })
  const realWs = realpathSync(lexWs)
  assert.notEqual(lexWs, realWs, '设备形态：词法路径与 canonical 路径必须不同，否则本用例测不到差异')
  return { lexWs, realWs }
}

test('等价性：可用 canonical 条目被复用，同目录毒条目仍被自愈删除（零新建）', async () => {
  const { lexWs, realWs } = linkedWorkspace()
  const registry = makeRegistry([
    { id: 'ws-stale', path: lexWs, title: INCOMING_TITLE, sessionIds: [] },
    { id: 'ws-usable', path: realWs, title: INCOMING_TITLE, sessionIds: [] },
  ])
  const { ctx } = makeCtx({ registry })
  await boot(ctx)
  assert.equal(registry.calls.list, 1, '一轮解析只列一次工作区')
  assert.deepEqual(registry.calls.deleted, ['ws-stale'], '同目录非 canonical 毒条目必须删除')
  assert.deepEqual(registry.calls.create, [], '已有可用条目时不得新建')
  assert.equal(registry.current.length, 1)
  assert.equal(registry.current[0].id, 'ws-usable')
})

test('等价性：只有毒条目时先自愈删除、再以 canonical 形态新建', async () => {
  const { lexWs, realWs } = linkedWorkspace()
  const registry = makeRegistry([
    { id: 'ws-stale', path: lexWs, title: INCOMING_TITLE, sessionIds: [] },
  ])
  const { ctx } = makeCtx({ registry })
  await boot(ctx)
  assert.deepEqual(registry.calls.deleted, ['ws-stale'])
  assert.equal(registry.calls.create.length, 1)
  assert.equal(registry.calls.create[0].path, realWs, '新建条目必须是 canonical 形态（attach 按字符串比较）')
  assert.equal(registry.calls.create[0].title, INCOMING_TITLE)
})

test('等价性：标题不符或已有会话的条目不在自愈面内（判据不变）', async () => {
  const { lexWs, realWs } = linkedWorkspace()
  const registry = makeRegistry([
    { id: 'ws-other-title', path: lexWs, title: '别的工作区', sessionIds: [] },
    { id: 'ws-has-sessions', path: lexWs, title: INCOMING_TITLE, sessionIds: ['session-aaaaaaaa-1'] },
  ])
  const { ctx } = makeCtx({ registry })
  await boot(ctx)
  assert.deepEqual(registry.calls.deleted, [], '标题不符/已有会话的条目绝不能被自愈删除')
  assert.equal(registry.calls.create.length, 1, '没有可用条目时必须新建')
  assert.equal(registry.calls.create[0].path, realWs)
  assert.equal(registry.current.length, 3, '两条残留加一条新建都必须保留')
})
