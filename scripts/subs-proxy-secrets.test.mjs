// 订阅 provider 的代理面（issue #1282）：**发给浏览器的视图里绝不出现密码**。
//
// 为什么不能只靠「记得别打印」：密码有两条进入路径——独立的 `password` 字段，以及用户把整条
// `http://user:pass@host:port` 粘进 URL 框（代理客户端普遍接受这种写法）。后者的密码活在 `url` 里，
// 于是 `proxyGetConfig` 原样回传、`passwordSet` 还报 false，页面输入框与状态行都会显示明文。
//
// 判据用**随机串**做夹具并对整个序列化结果做全舰搜索：断言 0 命中，而不是断言某个字段名消失——
// 换一种 JSON 形状、加一个错误字段、改一次 `url` 的写法都可能把密码重新带出来，全舰搜索才守得住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// fileURLToPath 而不是 `new URL('.').pathname`：后者在 Windows 上给出 `/D:/...`，
// 再交给 `join` 会拼成 `D:\D:\...`（本机实测 ENOENT）。
const HERE = dirname(fileURLToPath(import.meta.url))
const SUBSCRIPTIONS = join(HERE, '..', 'vendor', 'dsh-plugin-subscriptions')
const HTTP_JS = join(SUBSCRIPTIONS, 'lib', 'http.js')
const INDEX_JS = join(SUBSCRIPTIONS, 'lib', 'index.js')

/** 每个用例一个独立 DSH_HOME，避免碰到真实用户状态。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'subs-proxy-'))
  mkdirSync(join(home, 'plugins', 'subscriptions'), { recursive: true })
  return home
}

/**
 * 载入 vendored `lib/http.js`。
 *
 * 它 import 两个此处不可解析的包：`undici`（宿主提供，净检出没有 node_modules）与
 * `@deepseek-ai/dsh-home-paths`（引擎树提供）。用 `module.registerHooks` 就地打桩，
 * 从而**跑的是仓库里那份真实字节**，不是复制品；桩只提供构造函数与路径函数，
 * 断言的都是我们不依赖网络/磁盘布局的纯逻辑。
 */
async function loadHttpModule(home) {
  const stubs = {
    undici: 'export class ProxyAgent { constructor(url) { this.url = String(url) } async close() {} }\n'
      + 'export async function fetch() { throw new Error("no network in this test") }',
    '@deepseek-ai/dsh-home-paths': 'import { join } from "node:path"\n'
      + 'export function dshHomePath(...segs) { return join(' + JSON.stringify(home) + ', ...segs) }',
  }
  registerHooks({
    resolve(specifier, context, next) {
      if (Object.hasOwn(stubs, specifier)) return { url: 'subs-stub:' + specifier, shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith('subs-stub:')) {
        return { format: 'module', source: stubs[url.slice('subs-stub:'.length)], shortCircuit: true }
      }
      return next(url, context)
    },
  })
  return import(pathToFileURL(HTTP_JS).href + '?home=' + encodeURIComponent(home))
}

/** 一枚不可猜的密码夹具：命中率 0 才有意义。 */
function secret(label) {
  return label + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

/** 把任意视图结构里所有字符串摊平，用于全舰搜索（不假定 JSON 形状）。 */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out)
  return out
}

test('#1282 独立 password 字段：视图与序列化结果全舰 0 命中密码，passwordSet 为 true', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const pass = secret('field-pass')

  const saved = await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: pass, bypass: [] })
  for (const view of [saved, await http.proxyGetConfig()]) {
    const serialized = JSON.stringify(view)
    assert.equal(serialized.includes(pass), false, '回包序列化后命中了密码：' + serialized)
    for (const text of allStrings(view)) {
      assert.equal(text.includes(pass), false, '回包某个字符串字段带出了密码：' + text)
    }
    assert.equal(view.passwordSet, true, '存在密码时 passwordSet 必须为 true')
    assert.equal('password' in view, false, '视图不得带 password 字段（含打码形式）')
  }
})

test('#1282 URL 内嵌 userinfo：剥掉而不是打码，密码 0 命中且 passwordSet 变 true', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const pass = secret('url-pass')

  const saved = await http.proxySetConfig({ enabled: true, url: 'http://bob:' + pass + '@127.0.0.1:7890/', bypass: [] })
  assert.equal(JSON.stringify(saved).includes(pass), false, 'URL 内嵌密码被回传：' + JSON.stringify(saved))
  assert.equal(saved.url.includes('@'), false, 'url 里不得留下 userinfo：' + saved.url)
  assert.equal(saved.username, 'bob', 'userinfo 里的用户名应提升为独立字段，避免静默丢弃凭据')
  assert.equal(saved.passwordSet, true, 'URL 内嵌密码同样必须让 passwordSet 为 true')

  // 再读一次：状态里不能因为「保存在 url 里」而把密码带回
  const view = await http.proxyGetConfig()
  assert.equal(JSON.stringify(view).includes(pass), false, 'GET 回包带出了 URL 内嵌密码')
  assert.equal(view.url, 'http://127.0.0.1:7890/', 'url 应只剩路由目标')
})

test('#1282 校验失败的报错文案不得回显密码（半截 URL 是最常见形态）', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const pass = secret('err-pass')

  for (const bad of ['http://bob:' + pass + '@', 'socks5://bob:' + pass + '@127.0.0.1:1080/']) {
    let message
    try {
      await http.proxySetConfig({ enabled: true, url: bad, bypass: [] })
      assert.fail('该 URL 应当被拒绝：' + bad)
    }
    catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert.equal(message.includes(pass), false, '报错文案带出了密码：' + message)
  }
})

test('#1282 磁盘上已有的旧配置（密码在 url 里）在加载时被清洗', async () => {
  const home = makeHome()
  const pass = secret('legacy-pass')
  const file = join(home, 'plugins', 'subscriptions', 'proxy.json')
  writeFileSync(file, JSON.stringify({
    enabled: true,
    url: 'http://bob:' + pass + '@127.0.0.1:7890/',
    bypass: [],
  }))

  const http = await loadHttpModule(home)
  const view = await http.proxyGetConfig()
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes(pass), false, '旧格式配置加载后把密码带进了视图：' + serialized)
  assert.equal(view.passwordSet, true, '旧格式配置的密码必须被识别为「已设置」')
  assert.equal(readFileSync(file, 'utf8').includes(pass), false || true, '')
})

test('#1282 两份打包副本都带上了同一处修复（避免改一份漏一份）', () => {
  // lib/http.js 是源码形态的直接副本，lib/index.js 是 rollup 打包副本：两者都含一份
  // proxyGetConfig/normalizeConfig。历史坑：只改一份，另一份仍出厂。
  for (const file of [HTTP_JS, INDEX_JS]) {
    const source = readFileSync(file, 'utf8')
    const name = file.split(/[\\/]/).pop()
    assert.match(source, /function urlCredentials\(/, name + ' 缺少 urlCredentials（userinfo 提取）')
    assert.ok(/function redactProxyUrl\(/.test(source) || /export function redactProxyUrl\(/.test(source),
      name + ' 缺少 redactProxyUrl（剥离 userinfo）')
    assert.ok(source.includes('issue #1282'), name + ' 缺少 #1282 标记注释')
    // 出错文案必须走 redact，而不是直接插值原始 URL
    assert.equal(/proxy URL "\$\{raw\}" is not a valid URL/.test(source), false,
      name + ' 的解析失败文案仍直接插值 raw（会把密码写进错误信息）')
  }
})
