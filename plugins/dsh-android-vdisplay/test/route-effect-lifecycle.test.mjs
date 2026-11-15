// issue #1595（vdisplay 侧）：exact 状态路由注册没有挂在 ctx.effect 上，插件卸载后路由仍存活。
//
// 缺陷形态：`wsvc.register({...})` 直接调用，丢弃返回的 disposer。卸载（HMR / 禁用）之后
// 旧 handler 仍在 webServer 路由表里 —— 面板继续读一个「已停的插件」的状态，再装载时同名
// 二次注册抛 duplicate exact route。
//
// 判据（行为，不是 grep ctx.effect）：照抄真 WebServer 的「重名即 throw」「register 返回
// disposer」两条行为，按 HMR 真实时序跑 apply -> dispose -> apply。
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const SAVED = { home: process.env.DSH_HOME, port: process.env.DSH_ENGINE_PORT }
after(() => {
  for (const [key, value] of Object.entries({ DSH_HOME: SAVED.home, DSH_ENGINE_PORT: SAVED.port })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function setupEnv() {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-1595-vd-'))
  process.env.DSH_ENGINE_PORT = '4145'
}

/** 照抄真 WebServer：重名 throw + register 返回 disposer。 */
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

function makeCtx(webServer) {
  const disposers = []
  const provided = new Map([['webServer', webServer]])
  return {
    disposers,
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

function disposeAll(ctx) {
  for (let i = ctx.disposers.length - 1; i >= 0; i -= 1) ctx.disposers[i]()
  ctx.disposers.length = 0
}

test('#1595 vdisplay 判据 1：卸载后状态路由必须消失', () => {
  setupEnv()
  const webServer = makeWebServer()
  const ctx = makeCtx(webServer)
  apply(ctx)
  assert.ok(webServer.routes.size > 0, 'apply 必须注册至少一条路由')

  disposeAll(ctx)
  assert.equal(webServer.routes.size, 0,
    '卸载后路由必须全部摘掉；实际仍剩 ' + webServer.routes.size + ' 条：'
    + [...webServer.routes.keys()].join(', '))
})

test('#1595 vdisplay 判据 2：卸载后重装不得撞 duplicate exact route', () => {
  setupEnv()
  const webServer = makeWebServer()
  const ctx1 = makeCtx(webServer)
  apply(ctx1)
  disposeAll(ctx1)

  const ctx2 = makeCtx(webServer)
  assert.doesNotThrow(() => apply(ctx2),
    '重装必须能成功；撞 duplicate exact route 说明旧注册没被摘掉')
  assert.equal(webServer.duplicates, 0, '重装不得产生任何重复注册')
  assert.ok(webServer.routes.size > 0, '重装后路由必须在场')
})
