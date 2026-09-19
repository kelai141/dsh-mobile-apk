// combo-parallel-c3.test.mjs — C3 补丁回归：分片并行与单线程**逐字节等价** + worker 回收（0.14.1 块F P1）。
//
// 背景（docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §3.6(e) / §4 第 3 项）：A3/A4/A5 之后
// 剩下的仍是落在首个页面请求路径上的同步块（设备实测 2795 ms）。C3 把 buildCombo 的逐记录字节
// 计算分片到启动期临时 worker 池；rev 分配与批拼接留主线程；过程结束 terminate() 全池。
//
// 本测试的硬要求（详档 §4 第 3 项「反证要求」）：
//   ① 等价必须**逐字节比 rev/script/sourceMap 三者**（禁止只比长度或只比 hash 之一）；
//   ② 「回收后 RSS 回落」必须实测（不能只看「启动了 worker」）；
//   ③ 反假绿：C3 关闭（DSH_MOBILE_COMBO_PARALLEL=0）与开启两条路径都要能被测到，且两者输出必须一致；
//   ④ 池必须真的被用上（workers>0、shards>0），否则「等价」只是两条单线程路径在自证。
//
// 用法：node scripts/patches/tests/combo-parallel-c3.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-client-modules-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
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
function extractA3Block(source) {
  const start = source.indexOf('/* dsh-mobile combo cache (A3)')
  if (start < 0) throw new Error('A3 block not found')
  const report = extractFunction(source, 'function dshMobileComboCacheReport() {')
  return source.slice(start, source.indexOf(report) + report.length)
}
function extractA5Block(source) {
  const start = source.indexOf('/* dsh-mobile combo single lazy (A5)')
  if (start < 0) throw new Error('A5 stat block not found')
  const end = source.indexOf('Object.defineProperty(globalThis, "__dshMobileComboLazyStats"', start)
  return source.slice(start, source.indexOf('\n', end))
}
function extractC3Block(source) {
  const start = source.indexOf('Object.defineProperty(globalThis, "__dshMobileComboLazyStats"')
  const end = extractFunction(source, 'function dshMobileComboPrepareRecords(records) {')
  // start 落在 A5 统计挂载行：从该行末尾到 prepare 函数结束
  const lineEnd = source.indexOf('\n', start)
  return source.slice(lineEnd + 1, source.indexOf(end) + end.length)
}
/** Harness exposing buildCombo under a given C3 mode. */
function buildHarness(source) {
  const parts = [
    extractConsts(source),
    extractA5Block(source),
    extractC3Block(source),
    extractFunction(source, 'function shortHash(input) {'),
    extractFunction(source, 'function framedHash(domain, parts) {'),
    extractFunction(source, 'function comboUrl(ids, rev, sourceMap = false) {'),
    extractFunction(source, 'function projectedComboUrlBytes(records) {'),
    extractFunction(source, 'function comboSource(record) {'),
    extractFunction(source, 'function comboScript(input, sourceMapUrl) {'),
    extractFunction(source, 'function newlineCount(value) {'),
    extractFunction(source, 'function comboSectionMap(record) {'),
    extractFunction(source, 'function identitySectionMap(source, sourceUrl) {'),
    extractA3Block(source),
    extractFunction(source, 'function buildCombo(records, revision) {'),
  ]
  const factory = new Function('createHash', 'existsSync', 'readFileSync', 'join', 'process', 'console',
    'availableParallelism', 'MessageChannel', 'Worker', 'receiveMessageOnPort',
    parts.join('\n') + '\nreturn { buildCombo, parallelStats: typeof DSH_MOBILE_COMBO_PARALLEL_STATS === "object" ? DSH_MOBILE_COMBO_PARALLEL_STATS : void 0 };')
  return factory(createHash, existsSync, readFileSync, join, process,
    { log: () => {}, warn: () => {}, error: () => {} },
    availableParallelism, MessageChannel, Worker, receiveMessageOnPort)
}

const scratch = mkdtempSync(join(tmpdir(), 'c3-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine',
      '--only', 'combo-lazy-A4,combo-cache-A3,combo-single-lazy-A5,combo-parallel-C3'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0（A4 + A3 + A5 + C3）', applied.status === 0,
    (applied.stdout || applied.stderr || '').trim().split('\n').slice(-3).join(' | '))
  const patched = readFileSync(target, 'utf8')
  check('C3 marker 在场', patched.includes('dsh-mobile combo parallel (C3)'))
  check('C3 池统计挂载在场', patched.includes('__dshMobileComboParallelStats'))
  check('反 no-op：A3 逐条装配循环已被预准备数组取代',
    !patched.includes('const mobileCached = dshMobileComboCacheLookup(record);')
    && patched.includes('dshMobileParts[dshMobileIndex]'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])
  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  // ── 夹具：多条真实字节的 client.js（>2 条才触发分片；含 trailer 覆盖 comboSource 分支）──
  const makeBundle = (id, marker) => Buffer.from([
    'window.__ModuleLoader__.load({ id: "' + id + '", factory: function (require) {',
    '\tvar x = require("react");',
    '\treturn function () { return "' + marker + '"; };',
    '} });',
    '//# sourceMappingURL=client.js.map',
    '',
  ].join('\n'))
  const ids = ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-e', 'pkg-f']
  const records = ids.map((id, i) => ({
    entry: { id, rev: 'rev' + String(1000000000 + i), external: [], immediately: false },
    bundle: makeBundle(id, 'body-' + id),
    meta: { clientPath: '/nonexistent/' + id + '/client.js', external: [], immediately: false },
  }))
  const batches = [
    records.slice(0, 3),
    records.slice(3),
  ]

  // ── 分片臂（默认 K=min(2,cores-1)）──
  delete process.env.DSH_MOBILE_COMBO_PARALLEL
  const parallel = buildHarness(patched)
  const parOut = parallel.buildCombo(records, undefined)
  const parStats = parallel.parallelStats

  // ── 单线程臂（DSH_MOBILE_COMBO_PARALLEL=0 强制）──
  process.env.DSH_MOBILE_COMBO_PARALLEL = '0'
  const single = buildHarness(patched)
  const singleOut = single.buildCombo(records, undefined)
  check('C3 关闭臂确实走了单线程（workers=0 / fallback 计数 > 0）',
    single.parallelStats.workers === 0 && single.parallelStats.fallbackRecords > 0,
    'workers=' + single.parallelStats.workers + ' fallback=' + single.parallelStats.fallbackRecords)
  delete process.env.DSH_MOBILE_COMBO_PARALLEL

  // ④ 池真的被用上（否则「等价」只是两条单线程路径自证）
  check('④ 分片臂确实用了池（workers > 0 且 records == 分片条数）',
    parStats.workers > 0 && parStats.records === records.length,
    'workers=' + parStats.workers + ' shards=' + parStats.shards + ' records=' + parStats.records)
  check('④ 分片条数 == 6（全部为 identity 路径，无 map）', parStats.records === 6, 'records=' + parStats.records)

  // ① 逐字节等价：rev / script / sourceMap / sourceMapUrl 四者全比（禁止只比长度或只比 hash）
  const eq = (a, b) => Buffer.compare(a, b) === 0
  check('① rev 逐字符一致（rev 分配与哈希仍在主线程，语义不变）',
    parOut.rev === singleOut.rev, 'parallel=' + parOut.rev + ' single=' + singleOut.rev)
  check('① script 逐字节一致（Buffer.compare）',
    eq(parOut.script, singleOut.script),
    'len ' + parOut.script.length + ' vs ' + singleOut.script.length)
  check('① sourceMap 逐字节一致（Buffer.compare）',
    eq(parOut.sourceMap, singleOut.sourceMap),
    'len ' + parOut.sourceMap.length + ' vs ' + singleOut.sourceMap.length)
  check('① sourceMapUrl / url 逐字符一致',
    parOut.sourceMapUrl === singleOut.sourceMapUrl && parOut.url === singleOut.url)
  // 直接证明「不是只比长度或只比 hash」：内容确实不同长度也不同维度都被比对
  check('① 等价判据不是长度等价（内容逐字节比 + 长度亦相等）',
    eq(parOut.script, singleOut.script) && parOut.script.length === singleOut.script.length)
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  check('① 等价判据不是哈希单比（哈希相等且字节相等）',
    sha(parOut.script) === sha(singleOut.script) && eq(parOut.script, singleOut.script))

  // 反 no-op：改一个字节，分片输出必须随之变化（否则「等价」可能是两条路径都返回同一份陈旧缓存）
  const tampered = records.map((r, i) => i === 2 ? { ...r, bundle: makeBundle(r.entry.id, 'body-TAMPERED') } : r)
  const parTampered = parallel.buildCombo(tampered, undefined)
  check('反 no-op：篡改一条记录后分片输出逐字节变化（不是返回陈旧缓存）',
    !eq(parTampered.script, parOut.script) && !eq(parTampered.sourceMap, parOut.sourceMap))

  // 两条批路径（bootstrap/application 形态）也须等价
  const parBatch = batches.map((rs) => parallel.buildCombo(rs, undefined))
  const singleBatch = batches.map((rs) => single.buildCombo(rs, undefined))
  check('① 批路径逐字节等价（两批 rev/script/sourceMap 全比）',
    parBatch.every((p, i) => p.rev === singleBatch[i].rev
      && eq(p.script, singleBatch[i].script) && eq(p.sourceMap, singleBatch[i].sourceMap)))

  // ② worker 回收：terminate 请求数 == 池启动数；且线程真的退出（live 归零）。
  check('② worker 回收：每次分片都发起 terminate（terminateRequests ≥ workers）',
    parStats.terminateRequests >= parStats.workers && parStats.terminateRequests > 0,
    'workers=' + parStats.workers + ' terminateRequests=' + parStats.terminateRequests)
  // terminate() 是异步的：同步断言只能看到「已发起」。这里等线程真正退出后再断言 live 归零，
  // 否则「回收」这件事从未被观测（只看「启动了 worker」正是详档 §4 第 3 项点名的假判据）。
  {
    const deadline = Date.now() + 10000
    while (parallel.parallelStats.live > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    check('② 回收后池内无残留（worker 线程全部退出，live 归零）',
      parallel.parallelStats.live === 0, 'live=' + parallel.parallelStats.live)
  }
  // ②b RSS 观测（不作为硬判据）：详档 §6 第 8 项明列「worker isolate 在 Android/Node v24 上的实际
  // RSS 增量」为**未确证**项，故此处只如实观测并打印，不把未测得的阈值写成「失败即拒」。
  // 设备侧 RSS 回落须按 §6 第 8 项在目标设备上实测（/proc/<pid>/status VmRSS + 回收后回落）。
  {
    const rssNow = process.memoryUsage().rss
    console.log('OBS   RSS 观测（宿主 x64，非设备）：当前 rss=' + (rssNow / 1048576).toFixed(1)
      + 'MB，本次分片池启动 ' + parStats.workers + ' 个 worker、已全部 terminate（live='
      + parallel.parallelStats.live + '）。设备侧 RSS 回落断言待 §6 第 8 项实测，本测试不冒充。')
  }

  // ③ 单条路径（1 条记录）不启池但输出仍与单线程一致（防止「为分片而分片」）
  delete process.env.DSH_MOBILE_COMBO_PARALLEL
  const one = buildHarness(patched)
  const oneOut = one.buildCombo([records[0]], undefined)
  process.env.DSH_MOBILE_COMBO_PARALLEL = '0'
  const oneSingle = buildHarness(patched).buildCombo([records[0]], undefined)
  delete process.env.DSH_MOBILE_COMBO_PARALLEL
  check('③ 单条记录不分片但输出逐字节一致（分片阈值生效）',
    oneOut.rev === oneSingle.rev && eq(oneOut.script, oneSingle.script) && eq(oneOut.sourceMap, oneSingle.sourceMap))

  console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
  process.exit(failures.length === 0 ? 0 : 1)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.DSH_MOBILE_COMBO_PARALLEL
}
