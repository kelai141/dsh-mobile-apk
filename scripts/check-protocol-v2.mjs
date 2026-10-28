#!/usr/bin/env node
// check-protocol-v2.mjs — 控制协议 V2 往返与体积门禁（0.13.8 批 F / DESIGN-PROTOCOL-V2.md §S6）
//
// 为什么单独一个门禁：协议 V2 的收益全在**体积**与**结构自洽**上，两者都是"编译通过 + 人工看
// 一眼"发现不了的——列式化多带一个字段、广播规则失效、去重口径变宽，代码照样绿，只是回填报文
// 悄悄回到 30 KB（回到「约 150 节点即熔断」的旧世界）。这里把设计文档里的实测基线钉成断言。
//
// 断言来源：plugins/dsh-android-manage/test/protocol-v2.test.mjs（+ test/fixtures/ui-probe.*）。
// 该测试跑的是**构建产物**（lib/*.js），因此本门禁先做「lib 是否比 src 新」的时效检查，
// 过期就明确叫人重建，绝不拿旧产物判绿（假绿防线，与 0.13.7 polyfill 事件同一教训）。
// 【0.14.1 W1】mtime 只是**触发**：真伪由重建哈希裁决（scripts/lib/product-freshness.mjs）——
// 纯 mtime 会把 robocopy/检出/编辑器触碰误判成过期，而本门禁原来的处置是**硬判红**，
// 一个假阳性就能让整条聚合链停在这里（这正是「防线被结构性绕过」的另一种形态）。
//
// 退出码：0 = 通过；1 = 失败（构建链与 CI 以此拒打包/拒合并）。
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { arbitrateFreshness } from './lib/product-freshness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN = join('plugins', 'dsh-android-manage')
const LIB = join(ROOT, PLUGIN, 'lib', 'protocol-v2.js')
const TEST = join(ROOT, PLUGIN, 'test', 'protocol-v2.test.mjs')
const FIXTURES = join(ROOT, PLUGIN, 'test', 'fixtures')

const srcDir = join(ROOT, PLUGIN, 'src')
const libDir = join(ROOT, PLUGIN, 'lib')

const fail = (msg) => {
  console.error('CHECK-PROTOCOL-V2 FAILED：' + msg)
  process.exit(1)
}

/**
 * lib 时效：**逐文件配对**比较 src/x.ts ↔ lib/x.js。
 *
 * 旧实现是「最新的 src」比「最新的 lib」（各取 mtime 最大值），于是 lib/ 里的**孤儿产物**
 * （src 已删、js 残留：coord-basis / node-list / screen-fields / semantic-fail）会把 lib 侧
 * 最大值抬到最新 ⇒ stale 恒为 false ⇒ **整段陈旧检查被跳过**。
 * 2026-10-28 实测（改 src/protocol-v2.ts 内容但不重建，再 touch 一个孤儿 js）：
 *   不 touch 孤儿 → FAILED（构建产物陈旧：重建后 1 个产物内容不同：protocol-v2.js）
 *   touch 孤儿   → PASSED（rc=0，假绿）
 * 这与本门禁的自我定位（「绝不拿旧产物判绿」）直接冲突，所以改配对比较：孤儿产物不参与。
 */
const mtimeOf = (dir, name) => {
  try {
    const st = statSync(join(dir, name))
    return st.isFile() ? st.mtimeMs : 0
  } catch {
    return 0
  }
}

/** 纯函数（供自证用）：给定 src→js 配对与 mtime，判是否陈旧。jsMs === null 表示产物缺席。 */
const decideStaleness = (pairs) => {
  let sNewest = { ms: 0, file: '' }
  let lNewest = { ms: 0, file: '' }
  for (const p of pairs) {
    if (p.tsMs > sNewest.ms) sNewest = { ms: p.tsMs, file: p.ts }
    if (p.jsMs !== null && p.jsMs > lNewest.ms) lNewest = { ms: p.jsMs, file: p.js }
    // 产物缺席：mtime 无从比较，按陈旧处理（本门禁姿态是不放过）
    if (p.jsMs === null) {
      return { s: { ms: p.tsMs, file: p.ts }, l: { ms: 0, file: p.js }, stale: true, reason: 'missing' }
    }
    // 配对比较：只有「这个 .ts 比它自己的 .js 新」才算陈旧；别的文件（含孤儿）一概不参与
    if (p.tsMs > p.jsMs) {
      return { s: { ms: p.tsMs, file: p.ts }, l: { ms: p.jsMs, file: p.js }, stale: true, reason: 'paired' }
    }
  }
  return { s: sNewest, l: lNewest, stale: false, reason: 'fresh' }
}

const pair = (ts, tsMs, js, jsMs) => ({ ts, tsMs, js, jsMs })

/**
 * 判据自证（无仓库依赖）。
 * 第 ② 条是「孤儿产物掩盖假绿」那个口子的独家守门人：旧实现「最新 ts(300) vs 最新 js(400)」
 * 会判新鲜从而漏判，配对比较必须判陈旧。
 * 自证内建在主体里（读取仓库状态之前静默跑一遍）——`--self-test` 在这套门禁体系里没有统一的
 * 调用机制，单加一个开关守不住东西。
 */
const selfTest = (silent) => {
  const fails = []
  const t = (label, ok, detail) => {
    if (!ok) fails.push(label + (detail === undefined ? '' : ' -> ' + detail))
    else if (!silent) console.log('PASS  [self-test] ' + label)
  }

  t('全配对新鲜 ⇒ stale=false',
    decideStaleness([pair('a.ts', 100, 'a.js', 100), pair('b.ts', 100, 'b.js', 100)]).stale === false)

  // 独家守护：配对的 a 陈旧，但 b 的 js 比所有 ts 都新（孤儿产物的等价形态）
  const shadowed = decideStaleness([pair('a.ts', 300, 'a.js', 250), pair('b.ts', 100, 'b.js', 400)])
  t('配对陈旧不被「更新的别的产物」掩盖（孤儿假绿守门人）', shadowed.stale === true, 'stale=' + shadowed.stale)
  t('被掩盖时如实报出是哪一对陈旧', shadowed.s?.file === 'a.ts' && shadowed.l?.file === 'a.js',
    's=' + (shadowed.s && shadowed.s.file) + ' l=' + (shadowed.l && shadowed.l.file))

  const missing = decideStaleness([pair('a.ts', 100, 'a.js', null)])
  t('配对产物缺席 ⇒ stale=true 且 reason=missing',
    missing.stale === true && missing.reason === 'missing', missing.reason)

  t('空配对集合 ⇒ stale=false', decideStaleness([]).stale === false)

  return fails
}

if (process.argv.includes('--self-test')) {
  const stFails = selfTest(false)
  if (stFails.length > 0) {
    console.error('CHECK-PROTOCOL-V2 SELF-TEST FAILED（' + stFails.length + ' 项）：' + stFails.join('；'))
    process.exit(1)
  }
  console.log('CHECK-PROTOCOL-V2 SELF-TEST PASSED（5 项判别力断言）')
  process.exit(0)
}

// 判据自证：主体每次运行都先静默自证（变异会被这里当场抓到）
{
  const stFails = selfTest(true)
  if (stFails.length > 0) {
    console.error('CHECK-PROTOCOL-V2 FAILED：判据自证不通过（' + stFails.length + ' 项）—— ' + stFails.join('；'))
    process.exit(1)
  }
}

if (!existsSync(TEST)) fail(`测试文件缺席：${TEST}`)
if (!existsSync(join(FIXTURES, 'ui-probe.xml'))) fail(`探针 fixture 缺席：${join(FIXTURES, 'ui-probe.xml')}`)
if (!existsSync(join(FIXTURES, 'ui-probe.expect.json'))) fail(`冻结基线缺席：${join(FIXTURES, 'ui-probe.expect.json')}`)
if (!existsSync(LIB)) {
  fail(`构建产物缺席：${LIB}\n  先构建：cd ${PLUGIN} && npm run build（注入链会自动构建，纯门禁场景需手动）`)
}

const staleness = () => {
  const pairs = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => {
      const js = name.replace(/\.ts$/, '.js')
      const jsMs = existsSync(join(libDir, js)) ? mtimeOf(libDir, js) : null
      return { ts: name, tsMs: mtimeOf(srcDir, name), js, jsMs }
    })
  return decideStaleness(pairs)
}

const cur = staleness()
if (cur.stale) {
  const arb = arbitrateFreshness(join(ROOT, PLUGIN), { root: ROOT })
  if (arb.verdict === 'fresh') {
    console.log('NOTE  src/' + cur.s.file + ' 比 lib/' + cur.l.file + ' 新，但重建逐字节一致（mtime 假阳性，按新鲜继续）')
  } else if (arb.verdict === 'stale') {
    fail(`构建产物陈旧：${arb.detail}
  先构建：cd ${PLUGIN} && npm run build（构建链不代建插件，免得注入中途被重写）`)
  } else {
    // 重建不可裁决（无 typescript / 编译失败 / 产物在 lib 缺席）：本门禁的既有姿态是**不放过**——
    // 它判的正是「跑在 lib 产物上的往返」，产物可信度无从确认时不得判绿。
    fail(`构建产物过期：src/${cur.s.file} 比 lib/${cur.l.file} 新，且重建不可裁决：${arb.detail}
  先构建：cd ${PLUGIN} && npm install && npm run build（构建链不代建插件，免得注入中途被重写）`)
  }
}

// 跨语言 fixture 必须与 TS 编码器同源（壳侧 Kotlin 单测就是拿它比对的）
const gen = spawnSync(process.execPath, ['scripts/gen-protocol-v2-fixture.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' })
if (gen.status !== 0) {
  console.error((gen.stdout ?? '') + (gen.stderr ?? ''))
  fail('跨语言 fixture 与生成器不一致：重跑 node scripts/gen-protocol-v2-fixture.mjs 并提交产物')
}
console.log('PASS  跨语言 fixture 与生成器同源')

const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', TEST], { cwd: ROOT, encoding: 'utf8' })
const out = (run.stdout ?? '') + (run.stderr ?? '')
const summary = out.split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join('  ')
if (run.status !== 0) {
  console.error(out.slice(-4000))
  fail(`协议 V2 测试未通过（${summary || 'no summary'}）`)
}
// review §2.3：node --test 全 .skip 时 exit 0——必须要求有效通过数 > 0（全 skip = 假绿）。
// 报告器无关：Node 21+ 默认 spec（"ℹ pass N"），Node 20 默认 TAP（"# pass N"）。
// 上面的 spawn 已显式钉 spec，这里再兼容 TAP 形态——任一默认变更都不会把通过数静默读成 0（假红）。
const passN = Number((/^ℹ pass (\d+)/m.exec(out) ?? /^# pass (\d+)/m.exec(out))?.[1] ?? '0')
if (passN <= 0) fail(`协议 V2 测试未产生有效通过数（全 skip = 假绿，pass=${passN}）`)
console.log('PASS  协议 V2 往返 + 体积门禁' + (summary ? `（${summary}）` : ''))
console.log('CHECK-PROTOCOL-V2 PASSED')
