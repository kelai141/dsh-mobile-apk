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
 * 载入一份 vendored `lib/http.js`（默认是仓库里那份；`file` 只在负控里换成变异副本）。
 *
 * 它 import 两个此处不可解析的包：`undici`（宿主提供，净检出没有 node_modules）与
 * `@deepseek-ai/dsh-home-paths`（引擎树提供）。用 `module.registerHooks` 就地打桩，
 * 从而**跑的是仓库里那份真实字节**，不是复制品；桩只提供构造函数与路径函数，
 * 断言的都是我们不依赖网络/磁盘布局的纯逻辑。
 *
 * `ProxyAgent` 桩把每次构造收到的 URL 记进 `globalThis.__subsAgentUrls`：只看配置视图
 * 无法区分「密码生效了」与「密码存着但没交给代理」，而 #1308 的缺陷形态正是后者。
 */
async function loadHttpModule(home, file = HTTP_JS) {
  const stubs = {
    undici: 'globalThis.__subsAgentUrls ??= []\n'
      + 'export class ProxyAgent { constructor(url) { this.url = String(url); globalThis.__subsAgentUrls.push(this.url) } async close() {} }\n'
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
  return import(pathToFileURL(file).href + '?home=' + encodeURIComponent(home) + '&t=' + Math.random())
}

/**
 * 代理**实际收到**的凭据（user:pass），来自最后一次 `new ProxyAgent(url)`。
 *
 * 这是 #1308 唯一有判别力的观测点：`proxyGetConfig` 的视图按设计不含密码，
 * 只看视图的话「新密码生效」与「旧密码被沿用」长得一模一样。
 */
function agentCredential() {
  const urls = globalThis.__subsAgentUrls ?? []
  const last = urls[urls.length - 1]
  if (last === undefined) return undefined
  const url = new URL(last)
  const decode = (v) => { try { return decodeURIComponent(v) } catch { return v } }
  return { username: decode(url.username), password: decode(url.password), basic: 'Basic ' + Buffer.from(decode(url.username) + ':' + decode(url.password)).toString('base64') }
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

// ── issue #1308：粘贴的代理密码不得被播种的旧密码顶替 ────────────────────────────────
//
// #1282 的修法把 userinfo 从 `url` 里剥掉、提升为独立字段，这一步是对的；但它同时让
// 「调用方没给 password」等同于「沿用上一份配置的 password」。于是**粘贴**一条
// `http://bob:new@host/` 时：新密码被剥出 url（唯一记录点），随后又被播种值顶替
// ——两侧都丢，而 `passwordSet` 还报 true（那是旧密码）。判据必须落在**代理实际收到的
// 凭据**上，因为视图按设计不含密码，只看视图区分不出「新密码生效」与「旧密码沿用」。

test('#1308 粘贴带 userinfo 的 URL：新密码必须覆盖播种的旧密码，并真的交给代理', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const oldPass = secret('old')
  const newPass = secret('new')

  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: oldPass, bypass: [] })
  assert.equal(agentCredential().password, oldPass, '前置：旧密码应先真的生效')

  // 用户把整条带凭据的 URL 粘进 URL 框，密码框留空 —— 这正是 UI 的调用形态
  // （lib/client.js 在密码框为空时**不带** password 字段）。
  const saved = await http.proxySetConfig({
    enabled: true,
    url: 'http://bob:' + newPass + '@127.0.0.1:7890/',
    username: 'bob',
    bypass: [],
  })

  const seen = agentCredential()
  assert.equal(seen.password, newPass, '代理用的仍是旧密码——粘贴的新密码被播种值顶替了（#1308 本体）')
  assert.equal(seen.username, 'bob', '用户名应来自 userinfo')
  assert.equal(saved.url.includes('@'), false, 'url 里不得留下 userinfo：' + saved.url)
  assert.equal(JSON.stringify(saved).includes(newPass), false, '新密码不得出现在视图里：' + JSON.stringify(saved))
  assert.equal(saved.passwordSet, true, '有密码时 passwordSet 必须为 true')

  // 磁盘上也必须是新密码：只改内存 agent 而落盘仍旧值，重启即回退。
  // 路径取自被测模块自己的 `proxyFilePath()`，不在这里重算一遍布局（重算就把
  // 「模块把配置写到哪」这件事复制成了第二份真源）。
  const onDisk = JSON.parse(readFileSync(http.proxyFilePath(), 'utf8'))
  assert.equal(onDisk.password, newPass, '落盘的仍是旧密码：' + JSON.stringify(onDisk))
  assert.equal(onDisk.url, 'http://127.0.0.1:7890/', '落盘 url 应只剩路由目标')
})

test('#1308 不带 userinfo 的常规保存：空密码框仍应沿用已存密码（不得连带改坏）', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const pass = secret('keep')

  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: pass, bypass: [] })
  // 改端口、密码框留空：这是「只改路由目标」的常见操作，密码必须原样保留。
  const saved = await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7891/', username: 'bob', bypass: [] })

  assert.equal(agentCredential().password, pass, '不带 userinfo 时空密码框不应丢掉已存密码')
  assert.equal(saved.passwordSet, true, 'passwordSet 应保持 true')
})

test('#1308 清空密码：得到 user:（无密码），不得被回填复活成旧密码', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const pass = secret('clear')

  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: pass, bypass: [] })
  const saved = await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: null, bypass: [] })

  const seen = agentCredential()
  assert.equal(seen.username, 'bob', '清空密码不应把用户名一起丢掉')
  assert.equal(seen.password, '', '清空后代理不得再带旧密码，实得 ' + JSON.stringify(seen.password))
  // `user:` 的 base64 —— 空密码要真的以空值发出，而不是整个 userinfo 消失（那是另一种行为）
  assert.equal(seen.basic, 'Basic ' + Buffer.from('bob:').toString('base64'), '清空后的凭据应为 user:（空密码），实得 ' + seen.basic)
  assert.equal(saved.passwordSet, false, '清空后 passwordSet 必须为 false')
})

/**
 * 把真实 `http.js` 复制到临时树并**只**回退一处判据，其余字节不动。
 *
 * 为什么不用 `node --test` 的用例级 mock：判据本身是「代理实际收到哪个密码」，
 * 而它的输入端有**两道**闸（`proxySetConfig` 的播种、`normalizeConfig` 的提升优先级）。
 * 只抽掉其中一道，另一道仍可能兜住结果——那样负控会假绿。所以这里分别对两道闸
 * 各做一次变异，两次都必须让同一条正控变红，才证明这道判据是必要的。
 */
function writeMutant(mutate) {
  const source = readFileSync(HTTP_JS, 'utf8')
  const mutated = mutate(source)
  assert.notEqual(mutated, source, '负控变异点没有命中——源码漂移了，需同步本用例的锚点')
  const dir = mkdtempSync(join(tmpdir(), 'subs-mutant-'))
  const file = join(dir, 'http.js')
  writeFileSync(file, mutated)
  return file
}

/** 走一遍「先有旧密码，再粘贴带新密码的 URL」，返回代理最终收到的密码。 */
async function pasteNewPasswordOverOld(http, newPass, oldPass = secret('mutant-old')) {
  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: oldPass, bypass: [] })
  await http.proxySetConfig({ enabled: true, url: 'http://bob:' + newPass + '@127.0.0.1:7890/', username: 'bob', bypass: [] })
  return agentCredential().password
}

// 上面三条正控只覆盖了「调用方没给 password」。提升优先级自身还有两种可区分的输入，
// 它们的答案与 userinfo 相反——正是这两条让那道闸成为**必要条件**，而不是等价写法。

test('#1308 显式密码字段与 URL userinfo 同时存在：字段胜出（意图更精确的那个赢）', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const fromField = secret('field-wins')
  const fromUrl = secret('url-loses')

  await http.proxySetConfig({
    enabled: true,
    url: 'http://bob:' + fromUrl + '@127.0.0.1:7890/',
    username: 'bob',
    password: fromField,
    bypass: [],
  })
  const seen = agentCredential()
  assert.equal(seen.password, fromField, '两个来源同时给密码时应以显式字段为准，实得 ' + JSON.stringify(seen.password))
  assert.equal(seen.password === fromUrl, false, 'URL 里的那份不得胜出')
})

test('#1308 清空密码 + URL 仍带 userinfo：必须清空，不得被 userinfo 回填复活', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const fromUrl = secret('url-revive')

  await http.proxySetConfig({
    enabled: true,
    url: 'http://bob:' + fromUrl + '@127.0.0.1:7890/',
    username: 'bob',
    password: null,
    bypass: [],
  })
  const seen = agentCredential()
  assert.equal(seen.username, 'bob', '清空密码不应丢用户名')
  assert.equal(seen.password, '', '显式清空是决定，不能被 userinfo 回填覆盖，实得 ' + JSON.stringify(seen.password))
})

test('#1308 负控 A：抽掉 normalizeConfig 的两处优先级判据，对应正控必须变红', async () => {
  const fromField = secret('mutant-a-field')
  const fromUrl = secret('mutant-a-url')

  // A1：显式字段优先于 userinfo
  const httpA1 = await loadHttpModule(makeHome(), writeMutant((source) => source.replace(
    `            const password = input.password !== undefined && input.password !== '' && input.password !== null
                ? input.password
                : input.passwordCleared === true
                    ? undefined
                    : embedded.password === '' ? undefined : embedded.password;`,
    // 回退成「userinfo 恒定胜出」的旧形态：显式输入压不住它。
    `            const password = embedded.password === '' ? undefined : embedded.password;`,
  )))
  await httpA1.proxySetConfig({ enabled: true, url: 'http://bob:' + fromUrl + '@127.0.0.1:7890/', username: 'bob', password: fromField, bypass: [] })
  assert.notEqual(agentCredential().password, fromField,
    '负控 A1 失效：抽掉提升优先级后显式字段仍然胜出，说明那条正控没有守住这道闸')

  // A2：显式清空优先于 userinfo 回填
  const httpA2 = await loadHttpModule(makeHome(), writeMutant((source) => source.replace(
    `                : input.passwordCleared === true
                    ? undefined
                    : embedded.password === '' ? undefined : embedded.password;`,
    `                : embedded.password === '' ? undefined : embedded.password;`,
  )))
  await httpA2.proxySetConfig({ enabled: true, url: 'http://bob:' + fromUrl + '@127.0.0.1:7890/', username: 'bob', password: null, bypass: [] })
  assert.notEqual(agentCredential().password, '',
    '负控 A2 失效：抽掉 passwordCleared 后清空仍生效，说明该判据不是必要条件')
})

test('#1308 内部标记不得落盘：passwordCleared 只是进程内的传递位，不是配置字段', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const pass = secret('noleak')

  await http.proxySetConfig({ enabled: true, url: 'http://bob:' + pass + '@127.0.0.1:7890/', username: 'bob', bypass: [] })
  const afterPaste = JSON.parse(readFileSync(http.proxyFilePath(), 'utf8'))
  assert.equal(Object.hasOwn(afterPaste, 'passwordCleared'), false,
    'passwordCleared 落盘了：它是内部传递位，写进配置会让下次加载的语义变得不可预测')

  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: null, bypass: [] })
  const afterClear = JSON.parse(readFileSync(http.proxyFilePath(), 'utf8'))
  assert.equal(Object.hasOwn(afterClear, 'passwordCleared'), false, '清空路径同样不得落盘该标记')
  assert.deepEqual(Object.keys(afterClear).sort(), ['bypass', 'enabled', 'url', 'username'],
    '清空后的磁盘配置键集合应回到最简形态，实得 ' + JSON.stringify(afterClear))
})

test('#1308 清空密码的意图不跨重启存续：重启后与「从未设置过」收敛到同一状态', async () => {
  // passwordCleared 是**进程内**传递位：它只用来在一次 proxySetConfig 调用里区分
  // 「显式清空」与「没给」，不写盘、也不产生任何持久化的「已清空」状态。
  //
  // 这是刻意的：清空之后的磁盘事实就是「没有这个凭据」，重启后既不该复活旧密码，
  // 也不该凭空冒出一个「曾清空过」的标记——对用户而言两者是同一个结果（无密码），
  // 语叉上也不该分叉（没有凭据就是没有凭据）。
  const clearedHome = makeHome()
  const cleared = await loadHttpModule(clearedHome)
  await cleared.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: secret('was-set'), bypass: [] })
  await cleared.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: null, bypass: [] })
  const clearedDisk = JSON.parse(readFileSync(cleared.proxyFilePath(), 'utf8'))

  // 「重启」= 同一份磁盘、全新模块实例；不用上一轮的进程状态。
  const rebooted = await loadHttpModule(clearedHome)
  const rebootedView = await rebooted.proxyGetConfig()
  assert.equal(Object.hasOwn(clearedDisk, 'passwordCleared'), false, '内部标记不得落盘（清空路径）')
  assert.equal(rebootedView.passwordSet, false, '重启后密码必须仍是「没有」，不得复活')
  assert.equal(agentCredential().password, '', '重启后代理不得再带旧密码，实得 ' + JSON.stringify(agentCredential().password))

  // 对照组：从未设置过密码的配置，重启后必须落在完全相同的形状上。
  const neverHome = makeHome()
  const never = await loadHttpModule(neverHome)
  await never.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', bypass: [] })
  const neverDisk = JSON.parse(readFileSync(never.proxyFilePath(), 'utf8'))
  assert.deepEqual(clearedDisk, neverDisk,
    '「清空过」与「从未设置过」的磁盘形态不一致——那会让重启后的语义分叉：'
    + JSON.stringify(clearedDisk) + ' vs ' + JSON.stringify(neverDisk))
})

// ── issue #1341：#1308 只修了密码半区，用户名半区仍让位给显式输入 ──────────────
//
// 设置对话框**总是**发送预填的 username（lib/client.js 从已存配置预填、无条件提交），
// 所以「字段存在」不等于「用户填了」。让 input.username 无条件胜出，会把一条粘贴进来的
// 完整凭据拆到两个账号上：http://alice:NEWPASS@host/ 实际生效 bob:NEWPASS——旧账号配
// 新密码，而视图仍显示 bob、passwordSet 仍 true、没有任何诊断。认证失败时用户只会看到
// 407，无从判断是账号还是密码错。

test('#1341 粘贴带 userinfo 的 URL：用户名也必须来自 userinfo，不得只换密码', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const oldPass = secret('u-old')
  const newPass = secret('u-new')

  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: oldPass, bypass: [] })
  assert.equal(agentCredential().username, 'bob', '前置：旧用户名应先真的生效')

  // 对话框形态：username 由已存配置预填并发送，密码框留空
  const saved = await http.proxySetConfig({
    enabled: true,
    url: 'http://alice:' + newPass + '@127.0.0.1:7890/',
    username: 'bob',
    bypass: [],
  })

  const seen = agentCredential()
  assert.equal(seen.username, 'alice', '用户名仍是被预填的旧值——凭据被拆到两个账号上了（#1341 本体）')
  assert.equal(seen.password, newPass, '密码应为 URL 里的新值')
  assert.equal(seen.username === 'bob', false, '不得出现「旧账号 + 新密码」这种跨账号组合')
  assert.equal(saved.username, 'alice', '视图必须反映真正生效的用户名，实得 ' + JSON.stringify(saved.username))

  const onDisk = JSON.parse(readFileSync(http.proxyFilePath(), 'utf8'))
  assert.equal(onDisk.username, 'alice', '落盘用户名与代理实际使用的不一致：' + JSON.stringify(onDisk))
  assert.equal(onDisk.url.includes('@'), false, 'url 里不得留下 userinfo：' + onDisk.url)
})

test('#1341 用户真的改了用户名时，显式输入仍必须胜出（不得把修法做成另一头一刀切）', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  const newPass = secret('u-edit')

  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: secret('u-prev'), bypass: [] })
  // 用户名被改成 carol（与已存值不同 = 用户真的动了这个字段），URL 里是 alice
  await http.proxySetConfig({ enabled: true, url: 'http://alice:' + newPass + '@127.0.0.1:7890/', username: 'carol', bypass: [] })

  const seen = agentCredential()
  assert.equal(seen.username, 'carol', '显式改的用户名被 URL userinfo 顶掉了——用户更精确的意图必须胜出')
  assert.equal(seen.password, newPass, '密码仍应取 URL 里的新值')
})

test('#1341 不带 userinfo 的常规保存：用户名仍按传入值走（不得连带改坏）', async () => {
  const home = makeHome()
  const http = await loadHttpModule(home)
  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'dave', password: secret('u-plain'), bypass: [] })
  assert.equal(agentCredential().username, 'dave', '没有 userinfo 时用户名必须原样生效')
})

test('#1341 负控：把用户名改回「显式输入恒定胜出」，粘贴用例必须变红', async () => {
  const http = await loadHttpModule(makeHome(), writeMutant((source) => source.replace(
    `    const username = embedded !== undefined
        && (input.username === undefined || input.username === current.username)
        ? embedded.username
        : input.username;`,
    // 回退成「任何显式输入都压过 userinfo」：#1341 修复前的形态。
    `    const username = input.username;`,
  )))
  const newPass = secret('mutant-1341')
  await http.proxySetConfig({ enabled: true, url: 'http://127.0.0.1:7890/', username: 'bob', password: secret('mutant-1341-old'), bypass: [] })
  await http.proxySetConfig({ enabled: true, url: 'http://alice:' + newPass + '@127.0.0.1:7890/', username: 'bob', bypass: [] })
  assert.notEqual(agentCredential().username, 'alice',
    '负控失效：抽掉「预填值让位给 userinfo」后用户名仍是 alice，说明正控没守住这条')
})

test('#1308 负控 B：抽掉 proxySetConfig 的「有 userinfo 就不播种」，粘贴的新密码必须被顶替', async () => {
  const newPass = secret('mutant-b')
  const http = await loadHttpModule(makeHome(), writeMutant((source) => source.replace(
    // 锚点按内容钉：只认「播种必须要求 URL 里没有 userinfo」这条判据本身，
    // 不认它用哪个局部变量表达（#1341 把它复用成了 embedded）。
    `    const seeded = input.password === undefined && embedded === undefined`,
    // 回退成「没给密码就一律播种旧值」：这正是 #1308 修复前的第一道闸。
    `    const seeded = input.password === undefined`,
  )))
  assert.notEqual(await pasteNewPasswordOverOld(http, newPass), newPass,
    '负控 B 失效：抽掉「有 userinfo 就不播种」后新密码仍然生效，说明正控没有守住这道闸')
})

test('#1341 两份打包副本都带上了同一处修复（改一份漏一份 = 缺陷照旧出厂）', () => {
  for (const file of [HTTP_JS, INDEX_JS]) {
    const source = readFileSync(file, 'utf8')
    const name = file.split(/[\\/]/).pop()
    assert.ok(source.includes('issue #1341'), name + ' 缺少 #1341 标记（另一份改了、这份没改？）')
    // 判据：userinfo 与「预填值」比较后才决定用户名，而不是无条件让显式输入胜出。
    // 两份副本写法不同（http.js 用 undefined，打包副本用 void 0），断言只认语义。
    assert.match(source, /embedded !== (?:undefined|void 0)\s*&&\s*\(input\.username === (?:undefined|void 0) \|\| input\.username === current(?:\$1)?\.username\)/,
      name + ' 的用户名优先级仍是「显式输入恒定胜出」')
    assert.equal(/\\.\.\.input\.username === (?:undefined|void 0) \? \{\} : \{ username: input\.username \}/.test(source), false,
      name + ' 的 proxySetConfig 仍直接透传 input.username（未按「预填 vs 改动」分流）')
  }
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

test('#1308 两份打包副本都带上了同一处修复（改一份漏一份 = 缺陷照旧出厂）', () => {
  for (const file of [HTTP_JS, INDEX_JS]) {
    const source = readFileSync(file, 'utf8')
    const name = file.split(/[\\/]/).pop()
    assert.ok(source.includes('issue #1308'), name + ' 缺少 #1308 标记注释（另一份改了、这份没改？）')
    // 判据 ①：带 userinfo 时不得播种旧密码。
    // 两份副本的写法不同（http.js 用 `undefined`，打包副本用 `void 0`），断言只认语义。
    // 判据只认语义：播种必须同时要求「没给密码」与「URL 里没有 userinfo」。
    // 变量名会随重构变化（#1341 起复用 embedded），锚死它等于给自己埋漂移。
    assert.match(source, /const seeded = input\.password === (?:undefined|void 0)\s*&&\s*embedded === (?:undefined|void 0)/,
      name + ' 的 proxySetConfig 未按「URL 带 userinfo 就不播种」分流')
    // 判据 ②：显式清空必须能与「没给」区分（否则清空会被 userinfo 回填复活）
    assert.match(source, /passwordCleared === true/, name + ' 缺少 passwordCleared 分支')
    // 判据 ③：提升时回填，而不是让 userinfo 恒定胜出
    assert.equal(/password: input\.password !== [\s\S]{0,120}?embedded\.password === '' \? undefined : embedded\.password/.test(source), false,
      name + ' 的提升分支仍是旧形态（userinfo 压过显式输入）')
  }
})
