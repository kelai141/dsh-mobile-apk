// issue #1595：三条 exact 路由未走 ctx.effect —— 热重载后桥插件整体装载失败（#224 的回归）。
//
// 缺陷形态：`webServer.register()` 运行期**返回 disposer**，且同名 (kind,path) 重复注册会 throw；
// webserver 服务本身不按 fiber 自动回收路由。下列站点裸调 register、丢弃 disposer：
//   - plugins/dsh-android-bridge/src/index.ts:2405（/api/android/privilege/status）
//   - plugins/dsh-android-bridge/src/index.ts:2423（registerControlRoutes 的两条 ui/* 路由）
//   - plugins/dsh-android-vdisplay/src/index.ts:428（/api/android/vdisplay/status）
// 触发一次 HMR 重载或设置页「禁用→启用」：旧 fiber 的 effect 表里没有这条路由 ⇒ 新实例 apply()
// 走到末尾 register 抛 `webserver: duplicate exact route "/api/android/privilege/status"` ⇒
// **整个桥插件装载失败**（注册在 apply 最末尾，前面已装的工具会被回滚），而旧 handler 仍留在
// exact 表里、继续用已 dispose 的 svc/ctx 回 200。
//
// 判据（行为，不是 grep）：用**会 throw 的假 webServer**（真实契约：duplicate exact route 即抛）
// 跑两次 apply()，中间只跑第一次注册的 effect disposer —— 修前第二次必然抛，修后必须正常装载，
// 且旧路由已从表里消失。
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
 * 与上游 webserver 同契约的假服务：
 *   - `register(route)` 返回 disposer；
 *   - 同名 (kind,path) **重复注册即 throw**（这正是 #1595 的触发点，不能省）。
 */
function fakeWebServer() {
  const table = new Map()
  const routeKey = (route) => route.kind + ' ' + route.path
  return {
    table,
    register(route) {
      const key = routeKey(route)
      if (table.has(key)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
      table.set(key, route)
      return () => {
        if (table.get(key) === route) table.delete(key)
      }
    },
  }
}

/**
 * 跑一次 apply()，返回本次注册的 effect disposer。
 * ctx.effect 必须**真的记住**回调返回的 disposer —— 这正是缺陷的观测点。
 */
function runApply(webServer) {
  setupEnv()
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
    webServer,
  }
  bridgeApply(ctx)
  return { effectDisposers, provided }
}

test('判据 1：apply() 注册的每条 exact 路由都必须挂进 effect 表（可回收）', () => {
  const ws = fakeWebServer()
  const { effectDisposers } = runApply(ws)
  assert.ok(ws.table.size >= 3,
    '本插件至少要注册 privilege/status 与 control 的两条 ui/* 路由，实际 ' + ws.table.size)
  assert.ok(effectDisposers.length > 0, 'apply() 必须通过 ctx.effect 登记可回收项')
  // 跑掉全部 disposer ⇒ exact 表必须清空（= 路由确实挂在 effect 上，而不是裸注册）。
  for (const dispose of effectDisposers) dispose()
  assert.equal(ws.table.size, 0,
    '跑完 effect disposer 后不得残留任何 exact 路由（残留即裸注册，热重载会撞 duplicate exact route）：'
      + [...ws.table.keys()].join(', '))
})

test('判据 2：模拟 HMR —— 旧 fiber 回收后新实例的 apply() 必须能装载成功（#1595 的核心判据）', () => {
  const ws = fakeWebServer()
  // 第一个实例（旧 fiber）
  const first = runApply(ws)
  assert.ok(ws.table.size > 0)
  // HMR：旧 fiber 的 effect 表被跑掉
  for (const dispose of first.effectDisposers) dispose()
  // 新实例装载 —— 修前这里必抛 webserver: duplicate exact route
  assert.doesNotThrow(() => runApply(ws),
    '热重载后新实例的 apply() 不得抛 duplicate exact route（否则整个桥插件装载失败、工具被回滚）')
  assert.ok(ws.table.size > 0, '新实例必须重新登记路由')
})

test('判据 3：未回收时重复注册**确实**会抛 —— 证明判据 2 的假服务忠实于上游契约', () => {
  const ws = fakeWebServer()
  runApply(ws) // 旧实例，故意不回收
  // 没有这条例证，「判据 2 绿」可能只是因为假服务根本不检查重复。
  assert.throws(() => runApply(ws), /duplicate exact route/,
    '假 webServer 必须与上游同契约：同名 exact 路由重复注册即抛')
})

test('判据 4：privilege/status 路由自身必须是 effect 登记项（issue 点名的第一条）', () => {
  const ws = fakeWebServer()
  const { effectDisposers } = runApply(ws)
  const keys = [...ws.table.keys()]
  assert.ok(keys.some((k) => k.includes('/api/android/privilege/status')),
    'privilege/status 路由必须已注册：' + keys.join(', '))
  // 只跑**一条** disposer 之后，这条路由必须消失或整体仍在——关键是它必须由 effect 表控制。
  // 这里逐条跑并断言「最终能清空」，比按数组下标猜更稳（effect 顺序不是契约）。
  for (const dispose of effectDisposers) dispose()
  assert.equal(ws.table.size, 0, 'privilege/status 必须随 effect 回收而消失')
})
