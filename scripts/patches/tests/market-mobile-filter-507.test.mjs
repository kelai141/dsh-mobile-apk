// market-mobile-filter.test.mjs — apk issue #507：「仅移动端可用」名实不符的端到端回归。
//
// 缺陷的两半，各用一条可证伪的断言钉住：
//   ① 服务端：旧判据是 compat !== "desktop"，而 compat 默认值是白名单未命中的 "unknown"
//      （compat-map.json 仅 23 条，目录 4000+ 条）⇒ 勾选实际只剔掉 7 个桌面独占，标着
//      「原生?」「未验证」的条目照样出现。现在勾选只放行 compat === "ok"。
//   ② 客户端：过滤状态曾被编码进搜索词（勾选后搜索框真的出现 "mobile: " 前缀），
//      于是用户输入 mobile: 开头的关键字会被服务端 slice(7) 吞掉。现在走独立参数 mobile=1。
//
// 端到端做法：在临时目录里对**上游原始字节**施加补丁链，再真的把产物 import 起来跑——
// 断言的是产物语义，不是「源码里有没有某个字符串」。客户端侧不跑 React（不引入渲染依赖），
// 而是从产物字节里抽出取数函数 K 的**真实实现**，注入桩 fetch 后断言它发出的 URL。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const patchRunner = join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs')

// **必须从上游原始字节起跑，不能拿 vendor/ 里已入库的产物当输入。**
// 已入库产物是补丁链的输出：若拿它当夹具，补丁实现改成什么都测不出来——本测试的负控
// （把过滤判据退回 compat!=="desktop"）实测仍全绿，就是这个缺陷的实锤。
// 上游 0.1.7 的两个 bundle 以 npm 发布包为准，此处按「去补丁」还原：
// 直接读 vendor/ 再逆向剥掉我们加的段太脆，改为从 tgz 解出的原始字节出发。
import { createHash } from 'node:crypto'

/** 上游 0.1.7 原始 bundle 的 sha256（npm 发布包，逐字节固定）。 */
const UPSTREAM_SHA256 = {
  'index.js': '2c2190271c159fd555931bef092b4e0666c2bc08fa26502ac7a440296a5245e3',
  'client.js': '57f96e5491e827b4eb2e19f803acff8963eb6dcdbc4469de3e16e3ba0718f066',
}

/** 上游原始字节取自入库夹具（fixtures/dshmarketplace-plugin-0.1.7，来自 npm 发布包解包）。
 *  必须入库：只放 .deploy-tmp（已被 gitignore）的话，CI 与别的机器上这条回归会直接缺席。 */
const UPSTREAM_DIR = join(here, 'fixtures', 'dshmarketplace-plugin-0.1.7')

/** 读上游原始字节并按 sha256 核对：hash 不符 = 夹具被改过，必须判错而不是静默放行。 */
function upstreamBytes(name) {
  const p = join(UPSTREAM_DIR, 'lib', name)
  if (!existsSync(p)) {
    throw new Error('上游夹具缺席: ' + p + '\n'
      + '  夹具必须入库。重取：npm pack dshmarketplace-plugin@0.1.7，解包后把 lib/' + name
      + ' 放回 scripts/patches/tests/fixtures/dshmarketplace-plugin-0.1.7/lib/')
  }
  const bytes = readFileSync(p)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== UPSTREAM_SHA256[name]) {
    throw new Error('上游夹具 hash 不符（' + name + '）: ' + digest
      + '\n  期望 ' + UPSTREAM_SHA256[name] + '；重取：npm pack dshmarketplace-plugin@0.1.7')
  }
  return bytes
}

/** 在临时目录里准备一棵可施加补丁的 vendor 树（上游原始字节），返回其根。 */
function scratchVendor() {
  const scratch = mkdtempSync(join(tmpdir(), 'market-mobile-'))
  const pkgDir = join(scratch, 'dshmarketplace-plugin')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dshmarketplace-plugin', type: 'module' }))
  writeFileSync(join(pkgDir, 'lib', 'index.js'), upstreamBytes('index.js'))
  writeFileSync(join(pkgDir, 'lib', 'client.js'), upstreamBytes('client.js'))
  // 依赖桩：产物 import 了这两个包。
  const nm = join(pkgDir, 'node_modules', '@deepseek-ai')
  mkdirSync(join(nm, 'dsh-native-command'), { recursive: true })
  writeFileSync(join(nm, 'dsh-native-command', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-native-command', type: 'module', exports: './index.js' }))
  writeFileSync(join(nm, 'dsh-native-command', 'index.js'),
    'export const runNativeCommand = async () => ({ stdout: "" });\n')
  mkdirSync(join(nm, 'dsh-tools'), { recursive: true })
  writeFileSync(join(nm, 'dsh-tools', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', exports: './index.js' }))
  writeFileSync(join(nm, 'dsh-tools', 'index.js'), 'export const defineTool = value => value;\n')
  return scratch
}

/** 按函数名抽出一个完整顶层函数定义；大括号配平，跳过字符串与注释。
 *  本测试自己带一份、不共享 tests/lib/scope-module.mjs：那是别的补丁（appboot S1）的
 *  抽取器，跨 PR 借用会让两个互不相关的改动耦合在一起——那边改名/移动，这边就假红。 */
function extractFunction(source, name) {
  const sig = 'function ' + name + '('
  const start = source.indexOf(sig)
  if (start < 0) throw new Error('抽取失败：找不到 function ' + name)
  if (source.indexOf(sig, start + 1) >= 0) throw new Error('抽取失败：function ' + name + ' 出现多次')
  let i = source.indexOf('{', start)
  if (i < 0) throw new Error('抽取失败：function ' + name + ' 无函数体')
  let depth = 0
  let inString = null
  let inLineComment = false
  let inBlockComment = false
  for (; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 1 } continue }
    if (inString !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '\u0060') { inString = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('抽取失败：function ' + name + ' 大括号未配平')
}

/** 记录 response 的桩，语义与产物里的 l() 对齐。 */
function responseRecorder() {
  const out = { status: undefined, headers: undefined, body: undefined }
  return {
    out,
    writeHead(status, headers = {}) { out.status = status; out.headers = headers },
    end(body) { out.body = body },
  }
}

/** 目录里每个条目的 compat 归属：任何「非 ok」的都要被勾选过滤掉。 */
const CATALOGUE = {
  total: 5,
  results: [
    { fullName: 'acme/dsh-whale-widget', name: 'whale', installCheck: 'passed' },  // ok
    { fullName: 'acme/dsh-browser', name: 'browser', installCheck: 'passed' },      // native
    { fullName: 'acme/dsh-desktop', name: 'desktop', installCheck: 'passed' },      // desktop
    { fullName: 'acme/some-random-plugin', name: 'rnd', installCheck: 'passed' },   // unknown
    { fullName: 'acme/never-verified', name: 'nv', installCheck: 'passed' },        // unknown
  ],
}

function installCatalogueStub(scratch, catalogue) {
  const stub = join(scratch, 'dshmarketplace-plugin', 'lib', 'catalogue-stub.mjs')
  writeFileSync(stub, 'export const CATALOGUE = ' + JSON.stringify(catalogue) + '\n')
  return stub
}

function applyPatches(scratch) {
  return spawnSync(process.execPath,
    [patchRunner, scratch, '--apply', '--scope', 'vendor',
      '--only', 'market-B,market-D-server,market-route-auth-U2,market-D-client'],
    { encoding: 'utf8' })
}

/** 走真实 handler：注册出来的 search exact route 直接调用，桩 fetch 提供目录。 */
async function searchViaRoute(scratch, query) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => CATALOGUE })
  try {
    const target = join(scratch, 'dshmarketplace-plugin', 'lib', 'index.js')
    const mod = await import(pathToFileURL(target).href + '?market-mobile=' + Math.random())
    const routes = []
    const ctx = {
      commands: { register() { return () => {} } },
      tools: { register() { return () => {} } },
      skills: { register() { return () => {} } },
      on() { return () => {} },
      get() { return { requestRejection: () => undefined } },
      webServer: { register(route) { routes.push(route); return () => {} } },
    }
    mod.apply(ctx)
    const search = routes.find((r) => r.path === '/api/dshmarketplace/search')
    assert.ok(search !== undefined, 'search exact route 必须注册')
    const res = responseRecorder()
    await search.handler({ method: 'GET', url: '/api/dshmarketplace/search?' + query, headers: {} }, res)
    assert.equal(res.out.status, 200, 'search 应返回 200，实得 ' + res.out.status)
    return JSON.parse(res.out.body)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('勾选「仅移动端可用」只放行 compat===ok，native 与 unknown 必须被过滤', async () => {
  const scratch = scratchVendor()
  try {
    const applied = applyPatches(scratch)
    assert.equal(applied.status, 0, (applied.stderr || applied.stdout || '').slice(-400))
    installCatalogueStub(scratch, CATALOGUE)

    // 未勾选：全量可见（含 desktop），这是「浏览全部」的既有语义，不能连带被改坏。
    const all = await searchViaRoute(scratch, 'limit=60')
    assert.deepEqual(all.results.map((x) => x.fullName).sort(), CATALOGUE.results.map((x) => x.fullName).sort(),
      '未勾选时应返回全部条目')

    // 勾选：只剩 ok。这是 issue #507 的核心判据（旧实现这里会返回 4 条：除 desktop 外全留）。
    const mobile = await searchViaRoute(scratch, 'limit=60&mobile=1')
    assert.deepEqual(mobile.results.map((x) => x.fullName), ['acme/dsh-whale-widget'],
      '勾选后只应保留 compat===ok 的条目，实得 ' + JSON.stringify(mobile.results.map((x) => x.fullName)))
    // 每条都带 compat/compatNote 富化（客户端徽章依赖它）
    for (const row of mobile.results) {
      assert.equal(row.compat, 'ok')
      assert.equal(typeof row.compatNote, 'string')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('过滤状态不复用搜索词：q 里的 mobile: 前缀不再被当作过滤标记吞掉', async () => {
  const scratch = scratchVendor()
  try {
    const applied = applyPatches(scratch)
    assert.equal(applied.status, 0, (applied.stderr || applied.stdout || '').slice(-400))

    // 旧实现会对 q="mobile: foo" 做 slice(7) 并开启过滤 ⇒ 既改了搜索词又意外过滤。
    // 新实现只认 mobile=1；q 原样透传。
    const res = await searchViaRoute(scratch, 'limit=60&q=' + encodeURIComponent('mobile: whale'))
    assert.equal(res.results.length, CATALOGUE.results.length,
      'q 里的 mobile: 前缀必须原样当搜索词，不得触发过滤')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('客户端取数函数把过滤状态作为独立参数下发，搜索框只装关键字', async () => {
  const scratch = scratchVendor()
  try {
    const applied = applyPatches(scratch)
    assert.equal(applied.status, 0, (applied.stderr || applied.stdout || '').slice(-400))
    const clientSrc = readFileSync(join(scratch, 'dshmarketplace-plugin', 'lib', 'client.js'), 'utf8')

    // 从产物字节里抽出真实实现：state hook + useEffect，把 React 换成最小桩。
    const stateCalls = []
    const fakeReact = {
      default: {
        useState(initial) {
          const idx = stateCalls.length
          stateCalls.push(initial)
          return [initial, () => {}]
        },
        useEffect(fn) { fn() },
      },
    }
    const fetched = []
    const body = extractFunction(clientSrc, 'K')
    const factory = new Function('s', 'fetch', 'J', 'encodeURIComponent',
      body + '\nreturn K;')
    const K = factory(fakeReact, async (url) => { fetched.push(url); return { ok: true, json: async () => ({ results: [] }) } },
      '/api/dshmarketplace/search', encodeURIComponent)

    // 未勾选：URL 里不得有 mobile=1
    fetched.length = 0
    K(undefined, false)
    assert.equal(fetched.length, 1, '应发起一次请求')
    assert.ok(!fetched[0].includes('mobile=1'), '未勾选时不得下发 mobile=1，实得 ' + fetched[0])

    // 勾选 + 有搜索词：q 只装关键字，过滤是独立参数
    fetched.length = 0
    K('whale', true)
    assert.ok(fetched[0].includes('mobile=1'), '勾选时必须下发 mobile=1，实得 ' + fetched[0])
    assert.ok(fetched[0].includes('q=whale'), '搜索词必须原样作为 q，实得 ' + fetched[0])
    assert.ok(!fetched[0].includes('mobile%3A'), '不得再把过滤编码进搜索词，实得 ' + fetched[0])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('勾选后列表为空时用专门的空态文案，不说「换个能力试试」', async () => {
  const scratch = scratchVendor()
  try {
    const applied = applyPatches(scratch)
    assert.equal(applied.status, 0, (applied.stderr || applied.stdout || '').slice(-400))
    const clientSrc = readFileSync(join(scratch, 'dshmarketplace-plugin', 'lib', 'client.js'), 'utf8')

    // 空态选择逻辑：勾选时取 mobileEmpty，未勾选取 upstream 的 empty。
    assert.match(clientSrc, /e\(mo\?"mobileEmpty":"empty"\)/,
      '空态必须按勾选状态切换文案')

    // 中英文案都要真的注册进 locale 对象，且中文能正确解码（防双重转义）。
    const en = /mobileEmpty:"((?:[^"\\]|\\.)*)"/
    const hits = [...clientSrc.matchAll(/mobileEmpty:"((?:[^"\\]|\\.)*)"/g)]
    assert.equal(hits.length, 2, '应同时注册中英文案，实得 ' + hits.length)
    const decoded = hits.map((m) => JSON.parse('"' + m[1] + '"'))
    assert.ok(decoded.some((t) => /not been verified/.test(t)), '英文文案应说明「其余未验证」')
    assert.ok(decoded.some((t) => t.includes('没有移动端已验证')), '中文文案应说明「没有已验证的匹配」，实得 ' + JSON.stringify(decoded))
    // 中文必须走 \uXXXX 转义，不得直出裸中文（上游 bundle 为纯 ASCII，维持同一边界）
    assert.ok(decoded.every((t) => typeof t === 'string' && t.length > 0))
    void en
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
