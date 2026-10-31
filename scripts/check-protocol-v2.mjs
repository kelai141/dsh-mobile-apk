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
import { fileURLToPath, pathToFileURL } from 'node:url'
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

  // ── 值域套件判据（issue #1025）：用合成解码器喂结果矩阵，逐条钉住 ──────────────
  // 合成解码器按「载荷里有没有 knownGap 标记」返回结果，与真实解码器解耦。
  const fake = (rejectIds) => (payload) => ({ ok: !rejectIds.includes(payload.id) })
  const S = (...parts) => parts.join('')
  const gapCase = { id: 'g', payload: { id: 'g' }, expect: 'known-gap', reason: '因', since: '2026-10', issue: '#1' }
  const rejCase = { id: 'r', payload: { id: 'r' }, expect: 'reject' }

  const okMatrix = runDomainSuite([rejCase, gapCase], fake(['r']))
  t('值域表：reject 被拒 + known-gap 被接受 ⇒ 无 problem，缺口清单列出 1 条',
    okMatrix.problems.length === 0 && okMatrix.knownGaps.length === 1 && okMatrix.accepted.length === 1,
    JSON.stringify(okMatrix))

  const domAcc = runDomainSuite([rejCase], fake([]))
  t('值域表：expect=reject 而实际 ACCEPT ⇒ domain-accepted',
    domAcc.problems.some((p) => p.startsWith('值域负控被接受（domain-accepted）')), JSON.stringify(domAcc.problems))

  const stale = runDomainSuite([gapCase], fake(['g']))
  t('值域表：known-gap 而实际 REJECT ⇒ known-gap-stale（修好了没销账必须红）',
    stale.problems.some((p) => p.startsWith('已知缺口已不再复现（known-gap-stale）')), JSON.stringify(stale.problems))

  const noField = runDomainSuite([{ id: 'g', payload: {}, expect: 'known-gap', reason: '因' }], fake([]))
  t('值域表：known-gap 缺 since/issue ⇒ 红',
    noField.problems.some((p) => p.includes('known-gap 登记缺字段')), JSON.stringify(noField.problems))

  const badExpect = runDomainSuite([{ id: 'x', payload: {}, expect: 'rejects' }], fake([]))
  t('值域表：未知 expect 值 ⇒ 红',
    badExpect.problems.some((p) => p.includes('未知的 expect 值')), JSON.stringify(badExpect.problems))

  const empty = runDomainSuite([], fake([]))
  t('值域表：表为空 ⇒ 红（判据等于没写）',
    empty.problems.some((p) => p.includes('值域负控表为空')), JSON.stringify(empty.problems))

  t('值域表：expect 值域恰为 reject / known-gap 两种（口径不走样）',
    S(...DOMAIN_CASES.map((c) => c.expect)).replace(/reject|known-gap/g, '') === '',
    [...new Set(DOMAIN_CASES.map((c) => c.expect))].join(','))

  return fails
}

// ── 值域半边（2026-10-30，issue #1025）────────────────────────────────────────
//
// 门禁此前只守住「列长度 / 列顺序 / b 与 o 的边界」，解码器**输入侧的值域**半边没实现：
// 标量 null、符号索引、depth 上界、祖先索引顺序都不校验，坏载荷仍然解出 ok:true。
// 其中 n:null 会退化成 n=0 的**空树**，正是测试自己那条「坏载荷一律失败关闭（不静默产出空树）」
// 所禁止的形态。
//
// 本轮实测（针对构建产物 lib/protocol-v2.js，仓库 main=b2551951）：
//   已拒：P4b d:[-5,1] -> REJECT「d[0]=-5 非法：深度必须是非负整数」
//   已拒：P5  p:[0,5]  -> REJECT「p[1]=5 越界…」
//   （这两条是解码器后来补上的校验，issue 正文写的时候还没有——所以它们在这里是**真判据**：
//    谁把这两条输入侧校验改回去，门禁立刻红。）
//   仍放行：n:null / 符号索引越界或负数 / d 上界越域 / d 跳变 / p 向前引用与自引用
//
// 处置（BRIEF 硬规矩「不碰产品代码」优先）：值域判据在门禁侧**真正实现出来**（表格驱动 +
// 双向比对），但把「解码器输入侧尚未校验」的那几条登记为 known-gap（shrink-only），
// 而不是继续假装守住、也不是让真实树当场变红。
//
// 销账方式：修 plugins/dsh-android-manage/src/protocol-v2.ts 的输入侧校验，然后把对应条目
// 从 expect:'known-gap' 改成 expect:'reject'（改回 known-gap 会立刻 known-gap-stale 判红）。

/** 2 行合法裸载荷基线（值域负控都在这上面打补丁，只改一条判据）。 */
export const DOMAIN_BASE = {
  v: 2, gen: 1, rot: 0, scr: [100, 200], str: ['Abc', 'Btn'], n: 2,
  o: [0, 1], d: [0, 1], p: [-1, 0], f: [0, 0], c: [0, 1], k: [0, 0],
  r: [0, 0], w: [0, 0], t: [0, 1], s: [-1, -1],
  b: [0, 0, 100, 20, 0, 20, 100, 20],
}
/** 补丁式载荷构造：只覆盖给定的列。 */
export const domainPayload = (patch = {}) => ({ ...DOMAIN_BASE, ...patch })

/**
 * 值域负控表。每条形如 { id, payload, expect, reason?, since?, issue? }。
 *
 * expect 只有两个合法值：
 *   'reject'    解码器必须 REJECT。实际 ACCEPT = 红（domain-accepted）。
 *   'known-gap' 已知缺口：解码器目前 ACCEPT。实际 REJECT = 红（known-gap-stale）——
 *               解码器修好了却没销账，必须把它改成 'reject'（跟 check-script-tests 的
 *               KNOWN_FAIL「多了少了都红」同一口径）。known-gap 每条必须带 reason/since/issue。
 */
export const DOMAIN_CASES = [
  // ── 真判据（解码器输入侧已校验；谁改回去谁红）──────────────────────────────
  {
    id: 'P4b d:-5（负深度）',
    payload: domainPayload({ d: [-5, 1] }),
    expect: 'reject',
  },
  {
    id: 'P5 p:5（祖先行下标越界，n=2）',
    payload: domainPayload({ p: [0, 5] }),
    expect: 'reject',
  },
  // ── issue #1208 已销账：n 的类型判据改落在 typeof 上，null / "" / false / [] / "0" 不再折算成 0。
  //    本用例从 known-gap 改成 reject —— 谁把判据改回 Number(d.n)，这里立刻红（known-gap-stale 的反面）。
  {
    id: 'P3b n:null（曾退化成 n=0 空树，issue #1208 已修）',
    payload: domainPayload({
      n: null, d: [], p: [], f: [], c: [], k: [], r: [], w: [], t: [], s: [], b: [], o: [],
    }),
    expect: 'reject',
  },
  // ── 已登记缺口（shrink-only；销账 = 修 src/protocol-v2.ts 的输入侧校验后改成 'reject'）──
  {
    id: 'P2 t:999（符号索引越界，str 只有 2 项）',
    payload: domainPayload({ t: [999, 1] }),
    expect: 'known-gap',
    reason: 'sym() 对越界下标回落成空串（S[k] ?? ""），标签静默变空而不是失败关闭',
    since: '2026-10',
    issue: '#1025',
  },
  {
    id: 'P2b t:-2（符号索引负数）',
    payload: domainPayload({ t: [-2, 1] }),
    expect: 'known-gap',
    reason: 'sym() 对负数下标直接返回空串，标签静默变空而不是失败关闭',
    since: '2026-10',
    issue: '#1025',
  },
  {
    id: 'P4 d:999（深度上界越域）',
    payload: domainPayload({ d: [0, 999] }),
    expect: 'known-gap',
    reason: 'd 只校验了「非负整数」，上界没有域——编码器产出的深度由 id 点号层数决定（远小于 n），越域值会直接喂进 parentId/subtreeEnd 重建',
    since: '2026-10',
    issue: '#1025',
  },
  {
    id: 'P4c d:[0,5] 跳变（预序深度跳层）',
    payload: domainPayload({ d: [0, 5] }),
    expect: 'known-gap',
    reason: '预序相邻行的深度跳变超过 1 时父子链与子树区间都会错，但输入侧没有跳变校验',
    since: '2026-10',
    issue: '#1025',
  },
  {
    id: 'P5b p:[1,0]（祖先向前引用/倒序）',
    payload: domainPayload({ p: [1, 0] }),
    expect: 'known-gap',
    reason: 'p 只校验了范围 [-1, n)，没有校验「祖先必须在本行之前」（预序顺序）',
    since: '2026-10',
    issue: '#1025',
  },
  {
    id: 'P5c p:[1,1]（祖先自引用）',
    payload: domainPayload({ p: [1, 1] }),
    expect: 'known-gap',
    reason: 'p[i]=i 指向自身，同样落在 [-1, n) 范围内被放行，下游会拼出指向自己的 ref',
    since: '2026-10',
    issue: '#1025',
  },
]

/**
 * 值域套件判据（纯函数，供 --self-test 直接钉）。
 *
 * @param {{id: string, expect: string, reason?: string, since?: string, issue?: string}[]} cases 负控表
 * @param {(c: any) => {ok: boolean}} decode 解码器（注入便于自证）
 * @returns {{problems: string[], knownGaps: string[], accepted: string[]}}
 */
export const runDomainSuite = (cases, decode) => {
  const problems = []
  const knownGaps = []
  const accepted = []
  for (const c of cases) {
    const id = c.id === undefined ? '<无 id>' : c.id
    if (c.expect === 'reject' || c.expect === 'known-gap') {
      if (c.expect === 'known-gap') {
        const lacks = ['reason', 'since', 'issue'].filter((k) => !c[k])
        if (lacks.length > 0) {
          problems.push('known-gap 登记缺字段（' + lacks.join('/') + ' 必填）：' + id)
          continue
        }
      }
    } else {
      problems.push('未知的 expect 值「' + String(c.expect) + '」：' + id + '（只认 reject / known-gap）')
      continue
    }
    const r = decode(c.payload)
    if (c.expect === 'reject') {
      if (r.ok) problems.push('值域负控被接受（domain-accepted）：' + id)
      else accepted.push(id)
    } else if (r.ok) {
      knownGaps.push(id + '（' + c.reason + '；since ' + c.since + '，' + c.issue + '）')
    } else {
      problems.push('已知缺口已不再复现（known-gap-stale）：' + id + ' —— 解码器现在会拒绝它，'
        + '请把该条 expect 改成 \'reject\' 销账（保持 known-gap 会让缺口清单失真）')
    }
  }
  if (cases.length === 0) problems.push('值域负控表为空 —— 判据等于没写')
  return { problems, knownGaps, accepted }
}

if (process.argv.includes('--self-test')) {
  const stFails = selfTest(false)
  if (stFails.length > 0) {
    console.error('CHECK-PROTOCOL-V2 SELF-TEST FAILED（' + stFails.length + ' 项）：' + stFails.join('；'))
    process.exit(1)
  }
  console.log('CHECK-PROTOCOL-V2 SELF-TEST PASSED（12 项判别力断言：5 条产物时效配对 + 7 条值域负控表判据）')
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

// ── 值域负控（issue #1025）：直接驱动构建产物的 decodeV2，逐条双向比对 ─────────────
const v2 = await import(pathToFileURL(LIB).href)
const domain = runDomainSuite(DOMAIN_CASES, (payload) => v2.decodeV2(payload))
if (domain.problems.length > 0) {
  for (const p of domain.problems) console.error('  - ' + p)
  fail(`值域负控未通过（${domain.problems.length} 项）`)
}
console.log('PASS  值域负控（' + domain.accepted.length + ' 条真判据 REJECT；'
  + domain.knownGaps.length + ' 条已知缺口登记在案）')
if (domain.knownGaps.length > 0) {
  // 已知缺口必须**打印**：登记表不是静默通道（shrink-only：只许减少，销账方式见上）。
  console.log('KNOWN-GAP  值域半边尚未在解码器输入侧实现（共 ' + domain.knownGaps.length + ' 条，shrink-only）：')
  for (const g of domain.knownGaps) console.log('  KNOWN-GAP  ' + g)
  console.log('KNOWN-GAP  销账方式：修 plugins/dsh-android-manage/src/protocol-v2.ts 的输入侧校验，'
    + '再把 scripts/check-protocol-v2.mjs 里对应条目从 expect:\'known-gap\' 改成 expect:\'reject\''
    + '（留在 known-gap 会以 known-gap-stale 判红）')
}
console.log('CHECK-PROTOCOL-V2 PASSED')
