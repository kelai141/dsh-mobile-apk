// issue #1391：市场安装的执行目标必须**按 fullName 回查目录**得到，不得采信请求体。
//
// 缺陷形态：路由 handler 里 `S(s.plugin)` 直接读 `body.plugin.install` 当安装目标，只做字符集
// 正则；服务端从不回查目录、也不校验 fullName 是否存在。于是确认框可以展示 A、实际安装 B。
//
// 判据是**行为**：桩掉 native-command runner（记录真实会被执行的参数），然后打真路由，
// 断言执行的 target 来自目录项而不是请求体。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import test from 'node:test'

const STUB_DIR = mkdtempSync(join(tmpdir(), 'mkt-1391-'))
const STUB = join(STUB_DIR, 'native-command-stub.mjs')
writeFileSync(STUB, [
  'export const calls = []',
  'export function runNativeCommand(...args) {',
  "  calls.push(args)",
  "  return Promise.resolve({ stdout: 'stubbed' })",
  '}',
  '',
].join('\n'))
// dsh-tools 只提供 defineTool（本插件用它声明两个工具）；桩掉即可，不必装真包。
const TOOLS_STUB = join(STUB_DIR, 'dsh-tools-stub.mjs')
writeFileSync(TOOLS_STUB, 'export function defineTool(def) { return def }\n')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-native-command') {
      return { url: pathToFileURL(STUB).href, shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: pathToFileURL(TOOLS_STUB).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

const stub = await import(pathToFileURL(STUB).href)
const mod = await import(new URL('../vendor/dshmarketplace-plugin/lib/index.js', import.meta.url).href)

const CATALOGUE = {
  total: 2,
  results: [
    { fullName: 'acme/good', name: 'good', install: 'dsh plugin add @acme/good', installCheck: 'passed', riskFlags: [], stars: 1, url: 'https://example.invalid/good' },
    { fullName: 'acme/other', name: 'other', install: 'dsh plugin add @acme/other', installCheck: 'passed', riskFlags: [], stars: 2, url: 'https://example.invalid/other' },
  ],
}

/** 桩住目录接口：真模块通过 fetch 打 DSHM_API。 */
const seenUrls = []
globalThis.fetch = async (url) => {
  const target = String(url)
  seenUrls.push(target)
  const q = (() => { try { return new URL(target).searchParams.get('q') ?? '' } catch { return '' } })()
  const hits = CATALOGUE.results.filter((r) => q === '' || r.fullName.includes(q))
  return { ok: true, status: 200, json: async () => ({ total: hits.length, results: hits }), headers: new Map() }
}

/** 走 apply() 捕获 install 路由的 handler（与运行时同一个闭包）。 */
function captureInstallHandler() {
  let installHandler = null
  const ctx = {
    commands: { register() {} },
    tools: { register() {} },
    skills: { register() {} },
    on() {},
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
    webServer: {
      register(route) {
        if (String(route?.path ?? '').endsWith('/install')) installHandler = route.handler
      },
    },
  }
  mod.apply(ctx)
  assert.ok(installHandler, '必须注册 install 路由')
  return installHandler
}

function makeReq(body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  req.url = '/api/dshmarketplace/install'
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b ?? '' } }
  return res
}

const handler = captureInstallHandler()

test('#1391 请求体里的 install 被忽略，执行的是目录里该 fullName 的 install', async () => {
  stub.calls.length = 0
  const res = makeRes()
  await handler(makeReq({
    confirmed: true,
    // 攻击形态：确认框展示的是 acme/good，请求体却塞另一个包
    plugin: { fullName: 'acme/good', install: 'dsh plugin add evil/evil' },
  }), res)

  assert.equal(res.status, 200, '合法 fullName 应当放行：' + res.status + ' ' + res.body)
  const flat = JSON.stringify(stub.calls)
  assert.ok(flat.includes('@acme/good'), '必须执行目录项的目标 @acme/good：' + flat)
  assert.equal(flat.includes('evil/evil'), false, '请求体里的目标**绝不能**被执行：' + flat)
})

test('#1391 目录里没有这个 fullName 时必须拒绝，且一次都不执行', async () => {
  stub.calls.length = 0
  const res = makeRes()
  await handler(makeReq({
    confirmed: true,
    plugin: { fullName: 'attacker/unknown', install: 'dsh plugin add evil/evil' },
  }), res)

  assert.equal(res.status, 400, '未知 fullName 必须 400：' + res.status + ' ' + res.body)
  assert.match(res.body, /LISTING_NOT_FOUND/, '必须给出可诊断的 code：' + res.body)
  assert.equal(stub.calls.length, 0, '拒绝路径不得执行任何安装命令：' + JSON.stringify(stub.calls))
})

test('#1391 已确认但 fullName 缺失时同样拒绝（不得回退去用请求体的 install）', async () => {
  stub.calls.length = 0
  const res = makeRes()
  await handler(makeReq({ confirmed: true, plugin: { install: 'dsh plugin add evil/evil' } }), res)

  assert.equal(res.status, 400, '缺 fullName 必须 400：' + res.status + ' ' + res.body)
  assert.equal(stub.calls.length, 0, '不得执行任何安装命令：' + JSON.stringify(stub.calls))
})

test('#1391 未确认的请求仍先被挡掉（不得因为新判据放宽既有闸）', async () => {
  stub.calls.length = 0
  const res = makeRes()
  await handler(makeReq({ confirmed: false, plugin: { fullName: 'acme/good', install: 'dsh plugin add @acme/good' } }), res)
  assert.equal(res.status, 400)
  assert.match(res.body, /not confirmed/)
  assert.equal(stub.calls.length, 0)
})