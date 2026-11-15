// issue #1595：exact 路由注册没有挂在 ctx.effect 上，插件卸载后路由仍存活。
//
// 缺陷形态：`wsvc.register({...})` 直接调用，丢弃了它返回的 disposer。于是应用 side 卸载
// （HMR 热重载 / 用户在设置里禁用插件）之后，旧 handler 仍留在 webServer 的路由表里：
//   · 卸载后路由照样应答 —— 用户以为插件已停，状态面却还在报旧数据（幽灵插件）；
//   · 再装载时同名 (kind, path) 二次注册 → webserver 抛 duplicate exact route，插件整条挂掉。
//
// 判据（行为，不是 grep ctx.effect）：照抄真 WebServer 的两条行为——① 同名 (kind, path)
// 重复注册即 throw；② register 返回 disposer。然后按 HMR 的真实时序跑
// apply → dispose → apply，断言路由在卸载后消失、重装不撞名。
//
// 为什么不 grep 源码：`ctx.effect?.(() => wsvc.register(...))` 与
// `const d = wsvc.register(...); ctx.effect(() => d)` 两种写法都对，grep 会误判；
// 而"卸载后路由还在"这件事只有真跑时序才能看见。
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as bridgeApply } from '../lib/index.js'

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

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-1595-'))
  process.env.DSH_HOME = dir
  process.env.DSH_ENGINE_PORT = '4145'
  process.env.DSH_ADB_PREFS_PATH = join(dir, 'dsh-adb.xml')
  writeFileSync(process.env.DSH_ADB_PREFS_PATH,
    '<map>\n<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n</map>\n')
  process.env.DSH_SCREEN_SCOPE_TEST = '1'
  process.env.DSH_SCREEN_SCOPE = 'all'
}

/**
 * 照抄真 WebServer 的两条关键行为：
 *   ① 同名 (kind, path) 重复注册即 throw（真实现抛 `webserver: duplicate exact route "<path>"`）；
 *   ② register 返回 disposer（真实现返回 unsubscribe）。
 * 这两条是本判据的全部事实来源——不读源码、不钉常量。
 */
function makeWebServer() {
  const routes = new Map()
  let duplicates = 0
  return {
    routes,
    get duplicates() { return duplicates },
    register(route) {
      const key = String(route.kind) + ' ' + String(route.path)
      if (routes.has(key)) {
        duplicates += 1
        throw new Error('webserver: duplicate exact route "' + String(route.path) + '"')
      }
      routes.set(key, route)
      return () => { routes.delete(key) }
    },
  }
}

/** 构造一个会真的跑 effect 收集器的 ctx（卸载时要按注册顺序逆序 dispose）。 */
function makeCtx(webServer) {
  const disposers = []
  const provided = new Map()
  provided.set('webServer', webServer)
  return {
    disposers,
    // bridge 用**属性访问** `ctx.webServer` 取 webServer（不是 ctx.get）——两者都要给到，
    // 否则 harness 与真 cordis 的取用路径不一致，判据测的就不是被测代码走的那条路。
    webServer,
    logger: () => ({ warn() {}, debug() {}, info() {}, error() {} }),
    tools: { register() {} },
    provide(name, value) { provided.set(name, value) },
    on() {},
    get(name) { return provided.get(name) },
    effect(cb) {
      const dispose = cb?.()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
}

/** 卸载：逆序执行所有 effect disposer（与 cordis 的卸载时序一致）。 */
function disposeAll(ctx) {
  for (let i = ctx.disposers.length - 1; i >= 0; i -= 1) ctx.disposers[i]()
  ctx.disposers.length = 0
}

const PRIVILEGE_ROUTE = '/api/android/privilege/status'

test('#1595 判据 1：卸载后 exact 路由必须消失（不得留幽灵 handler）', () => {
  setupEnv()
  const webServer = makeWebServer()
  const ctx = makeCtx(webServer)
  bridgeApply(ctx)
  assert.ok(webServer.routes.has('exact ' + PRIVILEGE_ROUTE), '装载后路由必须在场')
  const before = webServer.routes.size
  assert.ok(before > 0, 'apply 必须注册至少一条路由')

  disposeAll(ctx)
  assert.equal(webServer.routes.size, 0,
    '卸载后路由必须全部摘掉；实际仍剩 ' + webServer.routes.size + ' 条：'
    + [...webServer.routes.keys()].join(', '))
})

test('#1595 判据 2：卸载后重装不得撞 duplicate exact route', () => {
  setupEnv()
  const webServer = makeWebServer()
  const ctx1 = makeCtx(webServer)
  bridgeApply(ctx1)
  disposeAll(ctx1)

  const ctx2 = makeCtx(webServer)
  assert.doesNotThrow(() => bridgeApply(ctx2),
    '重装必须能成功；撞 duplicate exact route 说明旧注册没被摘掉')
  assert.equal(webServer.duplicates, 0, '重装不得产生任何重复注册')
  assert.ok(webServer.routes.has('exact ' + PRIVILEGE_ROUTE), '重装后路由必须在场')
})

test('#1595 判据 3：卸载后旧 handler 不得仍能应答（抽查 privilege/status）', async () => {
  setupEnv()
  const webServer = makeWebServer()
  const ctx = makeCtx(webServer)
  bridgeApply(ctx)
  const route = webServer.routes.get('exact ' + PRIVILEGE_ROUTE)
  assert.ok(route, '装载后路由必须在场')

  disposeAll(ctx)
  assert.equal(webServer.routes.get('exact ' + PRIVILEGE_ROUTE), undefined,
    '卸载后路由表里不得再有这条路径 —— 否则「插件已停」是假的')
})
