// combo-single-lazy-a5.test.mjs — A5 补丁回归：单条 combo 延迟到首次被请求（0.14.1 块F P0-1）。
//
// 背景（docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §3.3(4) / §4 第 1 项，A 档设备实测）：
// 上游 compose() 无条件为全表每条记录 buildCombo([record], rev)，产出 56 条「单条 combo」；
// 而 boot 期浏览器只请求 2 个 /plugins/ 资源（两个批 combo），单条 URL 的唯一生产者是 HMR
// invalidate()。A5 把单条产物的构建推迟到首次被请求。
//
// 本测试（逐字节，禁止只比长度或只比 hash 之一）：
//   ① 补丁幂等 + node --check + marker + 「compose 里逐条 buildCombo 调用已消失」；
//   ② boot 期单条 buildCombo 调用数 == 0（反 no-op：不是「看起来更快」）；
//   ③ 请求任一单条 URL 返回与非延迟路径逐字节相同（script / sourceMap / rev / contentType / status）；
//   ④ 正向对照：请求单条 URL 后 singleBuilds 由 0 变 1（否则「计数恒 0」无法区分已延迟与探针没接上）；
//   ⑤ 防陈旧缓存：篡改记录（换 bundle 字节 / 换 rev）后请求其单条 URL，旧 URL 必须 404
//      且新 rev 的 URL 返回的是新字节（绝不交付上一代字节）；
//   ⑥ 批 combo 与 HMR rebuilt() 语义不变。
//
// 用法：node scripts/patches/tests/combo-single-lazy-a5.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-client-modules-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
function extractClass(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('class not found: ' + signature)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 2)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}
/** Extract the module-level A5 stat block + helpers other than the class. */
function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('function not found: ' + signature)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}
function extractConsts(source) {
  const wanted = ['SOURCE_MAP_TRAILER', 'SOURCE_URL_TRAILER', 'HASH_REVISION_LENGTH', 'COMBO_REVISION_PLACEHOLDER', 'MAX_COMBO_URL_BYTES', 'IMMUTABLE_CACHE', 'CLIENT_MODULES_ID']
  const out = []
  for (const name of wanted) {
    const m = source.match(new RegExp('const ' + name + ' = [^\\n]+'))
    if (!m) throw new Error('const not found: ' + name)
    out.push(m[0])
  }
  return out.join('\n')
}
function extractA5Block(source) {
  const start = source.indexOf('/* dsh-mobile combo single lazy (A5)')
  if (start < 0) throw new Error('A5 stat block not found')
  const end = source.indexOf('Object.defineProperty(globalThis, "__dshMobileComboLazyStats"', start)
  const lineEnd = source.indexOf('\n', end)
  return source.slice(start, lineEnd)
}
/** A3 rewrites buildCombo, so its helper block must travel with the harness (same as the A3 test). */
function extractA3Block(source) {
  const start = source.indexOf('/* dsh-mobile combo cache (A3)')
  if (start < 0) return ''
  const report = extractFunction(source, 'function dshMobileComboCacheReport() {')
  return source.slice(start, source.indexOf(report) + report.length)
}
/**
 * Build a harness exposing buildCombo + the ClientModuleRegistry class. The class needs a
 * Service base and the graph helpers; the A5 lazy resolver needs buildCombo/comboUrl.
 */
function buildHarness(source) {
  const parts = [
    extractConsts(source),
    extractA5Block(source),
    extractFunction(source, 'function shortHash(input) {'),
    extractFunction(source, 'function framedHash(domain, parts) {'),
    extractFunction(source, 'function comboUrl(ids, rev, sourceMap = false) {'),
    extractFunction(source, 'function projectedComboUrlBytes(records) {'),
    extractFunction(source, 'function partitionComboRecords(records) {'),
    extractFunction(source, 'function comboSource(record) {'),
    extractFunction(source, 'function comboScript(input, sourceMapUrl) {'),
    extractFunction(source, 'function newlineCount(value) {'),
    extractFunction(source, 'function comboSectionMap(record) {'),
    extractFunction(source, 'function identitySectionMap(source, sourceUrl) {'),
    extractA3Block(source),
    extractFunction(source, 'function buildCombo(records, revision) {'),
    extractFunction(source, 'function buildBatch(phase, records) {'),
    extractFunction(source, 'function graphRow(id, rev, fields) {'),
    extractClass(source, 'var ClientModuleRegistry = class extends Service {'),
  ]
  const factory = new Function('Service', 'randomBytes', 'orderByModuleGraph', 'PARSER_PRELOAD_IDS',
    'createHash', 'existsSync', 'readFileSync', 'join', 'process', 'console',
    parts.join('\n') + '\nreturn { ClientModuleRegistry, buildCombo: typeof buildCombo === "function" ? buildCombo : void 0, stats: typeof DSH_MOBILE_COMBO_LAZY_STATS === "object" ? DSH_MOBILE_COMBO_LAZY_STATS : void 0 };')
  const Service = class { constructor(ctx, name) { this.ctx = ctx; this.name = name } }
  return factory(Service, () => ({ toString: () => 'dshmobile' }), (entries) => entries, [],
    createHash, existsSync, readFileSync, join, process,
    { log: () => {}, warn: () => {}, error: () => {} })
}

const scratch = mkdtempSync(join(tmpdir(), 'a5-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine',
      '--only', 'combo-lazy-A4,combo-cache-A3,combo-single-lazy-A5'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0（A4 + A3 + A5）', applied.status === 0,
    (applied.stdout || applied.stderr || '').trim().split('\n').slice(-3).join(' | '))
  const patched = readFileSync(target, 'utf8')
  check('A5 marker 在场', patched.includes('dsh-mobile combo single lazy (A5)'))
  check('A5 探针挂载在场', patched.includes('__dshMobileComboLazyStats'))
  check('compose 内逐条 buildCombo 调用已消失（反 no-op）',
    !patched.includes('const artifact = buildCombo([record], record.entry.rev);'))
  check('惰性解析器在场', patched.includes('dshMobileSingleComboResponse(resourceUrl) {'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])
  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  // ── 夹具：两条真实字节的 client.js（覆盖 comboSource 的 trailer 剥离与 fallbackSource）──
  const makeBundle = (id, marker) => Buffer.from([
    'window.__ModuleLoader__.load({ id: "' + id + '", factory: function (require) {',
    '\treturn function () { return "' + marker + '"; };',
    '} });',
    '//# sourceMappingURL=client.js.map',
    '',
  ].join('\n'))
  const records = ['alpha-pkg', 'beta-pkg'].map((id, i) => ({
    entry: { id, rev: 'rev' + String(i + 1000000000), external: [], immediately: false },
    bundle: makeBundle(id, 'body-' + id),
    meta: { clientPath: '/nonexistent/' + id + '/client.js', external: [], immediately: false },
  }))

  const fresh = () => buildHarness(patched)
  const mkRegistry = () => {
    const h = fresh()
    const ctx = {
      on: () => {}, loader: { entries: () => [] }, effect: (cb) => cb(),
      webServer: { register: () => () => {} },
      get: () => void 0, inject: () => {}, logger: { warn: () => {}, error: () => {} },
    }
    const registry = new h.ClientModuleRegistry(ctx)
    for (const record of records) registry.table.set(record.entry.id, record)
    return { registry, h }
  }

  // ── ② boot 期单条构建数 == 0；批 combo 仍即时构建 ──
  const boot = mkRegistry()
  const stats = globalThis.__dshMobileComboLazyStats
  check('A5 探针挂在 globalThis（壳侧可读）', stats !== void 0)
  const graph = (boot.registry.composeDirty = true, boot.registry.graph())
  check('② boot 期单条 buildCombo 调用数 == 0（延迟生效）', stats.singleBuilds === 0, 'singleBuilds=' + stats.singleBuilds)
  check('boot 期单条 URL 已登记（2 条记录 x client.js/.map = 4 个键）', stats.urls === 4, 'urls=' + stats.urls)
  check('批 combo 仍即时构建（bootstrap/application descriptor 在场，entries 覆盖 2 条）',
    graph.batches.length >= 1 && graph.entries.length === 2,
    'batches=' + graph.batches.length + ' entries=' + graph.entries.length)

  // ── ③ 请求单条 URL：与非延迟路径逐字节一致 ──
  const singleUrl = records[0].entry.rev === undefined ? null : null
  const liveCombo = boot.h.buildCombo([records[0]], records[0].entry.rev)
  const listedUrl = liveCombo.url
  const mapUrl = liveCombo.sourceMapUrl
  // ── ⑥ 批 combo 仍可取用（在任何表变更之前取，批响应只保留一代——与上游同口径）──
  const batchRes = boot.registry.bundleResource('GET', graph.batches[0].url)
  check('⑥ 批 combo 响应在场（惰性路径未影响批响应）', batchRes.status === 200 && batchRes.body !== void 0,
    'status=' + batchRes.status)

  const beforeBuilds = stats.singleBuilds
  const got = boot.registry.bundleResource('GET', listedUrl)
  check('②b 单条 script 首次请求触发构建（正向对照：计数 +1）',
    stats.singleBuilds === beforeBuilds + 1, 'before=' + beforeBuilds + ' after=' + stats.singleBuilds)
  const gotMap = boot.registry.bundleResource('GET', mapUrl)
  check('②c 单条 .map 首次请求触发构建（计数再 +1）',
    stats.singleBuilds === beforeBuilds + 2, 'singleBuilds=' + stats.singleBuilds)
  check('③ 单条 script 逐字节一致',
    got.status === 200 && Buffer.compare(Buffer.from(got.body), liveCombo.script) === 0,
    'status=' + got.status + ' len=' + (got.body ? got.body.length : 'n/a') + ' vs ' + liveCombo.script.length)
  check('③ 单条 sourceMap 逐字节一致',
    gotMap.status === 200 && Buffer.compare(Buffer.from(gotMap.body), liveCombo.sourceMap) === 0,
    'status=' + gotMap.status)
  check('③ contentType/cache-control 与非延迟路径一致',
    got.headers['content-type'] === 'text/javascript; charset=utf-8'
    && gotMap.headers['content-type'] === 'application/json; charset=utf-8'
    && String(got.headers['cache-control']).includes('immutable'),
    got.headers['content-type'] + ' / ' + gotMap.headers['content-type'])
  const rebuiltSameUrl = liveCombo.rev
  check('③ rev 由记录自身 rev 决定（与延迟前同口径）', rebuiltSameUrl === records[0].entry.rev, 'rev=' + rebuiltSameUrl)

  // 第二次请求走缓存：计数不再增长，字节仍一致
  const second = boot.registry.bundleResource('GET', listedUrl)
  check('③b 二次请求走缓存（计数不增）且字节一致',
    stats.singleBuilds === beforeBuilds + 2 && Buffer.compare(Buffer.from(second.body), liveCombo.script) === 0,
    'singleBuilds=' + stats.singleBuilds)

  // ── ⑥ 批 combo：惰性路径不得把批响应挤掉（同代内仍可取用）──
  const batchAfter = boot.registry.bundleResource('GET', graph.batches[0].url)
  check('⑥ 惰性路径之后批 combo 仍可取用（同代）', batchAfter.status === 200 && batchAfter.body !== void 0,
    'status=' + batchAfter.status)

  // ── ④ 防陈旧缓存：篡改记录的 bundle 字节后，旧 rev 的旧 URL 必须 404；新 rev 必须给新字节 ──
  const staleUrl = listedUrl
  const oldScript = Buffer.from(liveCombo.script)
  const tamperedBundle = makeBundle('alpha-pkg', 'body-alpha-TAMPERED')
  const newRev = 'rev' + String(9999999999)
  const tamperedRecord = { ...records[0], bundle: tamperedBundle, entry: { ...records[0].entry, rev: newRev } }
  boot.registry.table.set('alpha-pkg', tamperedRecord)
  boot.registry.composeDirty = true
  boot.registry.graph()
  const stale = boot.registry.bundleResource('GET', staleUrl)
  check('④ 记录换 rev 后：旧 URL 必须 404（不得交付陈旧字节）', stale.status === 404, 'status=' + stale.status)
  const newCombo = boot.h.buildCombo([tamperedRecord], newRev)
  const freshRes = boot.registry.bundleResource('GET', newCombo.url)
  check('④ 记录换 rev 后：新 URL 返回新字节（且与现场生成逐字节一致）',
    freshRes.status === 200 && Buffer.compare(Buffer.from(freshRes.body), newCombo.script) === 0
    && Buffer.compare(Buffer.from(freshRes.body), oldScript) !== 0,
    'status=' + freshRes.status)

  // 同一 rev 但字节被换（HMR rebuilt 会同时换 rev；这里直接换 bundle 而 rev 不变）：
  // 必须仍然返回「按当前记录重算」的字节，而不是上一代缓存的旧字节。
  const bytesOnlySwap = { ...records[1], bundle: makeBundle('beta-pkg', 'body-beta-SWAPPED') }
  const sameRevUrl = boot.h.buildCombo([records[1]], records[1].entry.rev).url
  boot.registry.bundleResource('GET', sameRevUrl) // 先让旧字节进缓存
  boot.registry.table.set('beta-pkg', bytesOnlySwap)
  boot.registry.composeDirty = true
  boot.registry.graph()
  const swapped = boot.registry.bundleResource('GET', sameRevUrl)
  const expectedSwap = boot.h.buildCombo([bytesOnlySwap], records[1].entry.rev)
  check('④b 同 rev 换字节：compose 世代换手后返回重算字节，不是上一代缓存',
    swapped.status === 200 && Buffer.compare(Buffer.from(swapped.body), expectedSwap.script) === 0,
    'status=' + swapped.status)

  // ── ⑤ 未知 URL / 方法语义不变 ──
  const unknown = boot.registry.bundleResource('GET', '/plugins/??nope/client.js&rev=deadbeefdead')
  check('⑤ 未知单条 URL 仍 404（不因惰性路径变成 200/500）', unknown.status === 404, 'status=' + unknown.status)
  const post = boot.registry.bundleResource('POST', listedUrl)
  check('⑤ 非 GET/HEAD 仍 405（早退语义未被惰性解析改变）', post.status === 405, 'status=' + post.status)

  // ── ⑥ 批 combo：世代换手后新代批 URL 仍可服务（旧代 URL 退役与上游同口径）──
  const finalGraph = boot.registry.graph()
  const batchAfterSwap = boot.registry.bundleResource('GET', finalGraph.batches[0].url)
  check('⑥ 世代换手后新代批 combo 仍可服务', batchAfterSwap.status === 200,
    'status=' + batchAfterSwap.status)
  check('⑥b 旧代批 URL 已退役（上一代不残留，防交付陈旧批产物）',
    boot.registry.bundleResource('GET', graph.batches[0].url).status === 404)

  console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
  process.exit(failures.length === 0 ? 0 : 1)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
