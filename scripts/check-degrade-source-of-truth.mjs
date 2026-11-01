#!/usr/bin/env node
// check-degrade-source-of-truth.mjs — 注入源真源门禁：产物里的字节必须来自「降级副本」，不得来自「原始源」。
//
// 为什么需要这条判据（幽灵缺陷形态；PR #1272 的活体复现防线）：
//   构建链里有一段「浏览器语法下限：注入段降级」——把每个根级注入源（vendor/dshmarketplace-plugin、
//   vendor/dsh-plugin-subscriptions 等）复制到 .deploy-tmp/build-/13-<abi>/degrade-src/<name>-degraded/，
//   对副本里的 lib/client.js 做 chrome87 降级改写，**降级成功后把注入源换成这个降级副本**
//   （build-apk-013.ps1 的「注入段降级」段 / build-apk.mjs 的同名段）。
//   缺陷形态是**降级成功了，但注入时仍用原始源**。此时链上其它门禁全是绿的：
//     · 降级步骤本身绿——副本确实被改写了（脚本确实跑过）；
//     · check-browser-syntax-floor.mjs --scan <注入后 tar> 也绿——**当原始源恰好也合规时**（该包的
//       client.js 这一轮没引入新语法），两份字节都能过扫描，「注入源选错」在内容级看不出来；
//     · 于是全链绿，产物里带的却是未降级的 ES2022 bundle，只在设备老内核（Android 10 / WebView 87）
//       上解析期白屏——这正是历史上坏过的形态（PR #1272：只回写 marketplace、其它 external 仍用原源）。
//
// 为什么判据必须只用字节、不解析日志：日志只能证明「降级步骤跑过」，证明不了「注入器读的是哪个目录」；
// 而 .deploy-tmp 下的中间态在构建期间正被写入，读它做判断等于把门禁绑在别人的写时序上。故本门禁的输入
// 只有三样：**注入后快照 tar**、**原始注入源目录**、**降级副本目录**，结论完全由 sha256 决定。
//
// 判据（逐包 × 逐 profile × 逐被改写文件）：
//   ① 改写面 R = 注入面内「原始源与降级副本字节不同」的文件。注入面口径与 scripts/inject-all.py 同源
//      （package.json + lib/**（.map 除外）+ skills/** + 在场的清单文件），不另造第二份清单。
//      R 为空 ⇒ 该包没有被降级改写，**不构成判据输入**，必须显式 SKIP 并计数（不是静默通过）。
//   ② 对 R 里每个文件，在 tar 里定位 home/.dsh/profiles/<profile>/node_modules/<name>/<rel>，
//      **profile 有几个就判几个**（注入器默认覆盖 web + headless；只判一个会让另一个 profile 假绿）。
//   ③ 每个落点：sha256(tar 成员) == sha256(降级副本对应文件)，且 != sha256(原始源对应文件)。
//      前者证明「注入的是降级结果」，后者是「注入源仍是原始源」这一缺陷形态的直接判据。
//   ④ 落点缺席（该 profile 没注入这个包 / 成员不是普通文件）⇒ 该落点无法判定：非严格档计数 SKIP，
//      --require 档判红（严格档不允许把「看不见」当通过）。
//
// 用法：
//   node scripts/check-degrade-source-of-truth.mjs --snapshot <注入后.tar.xz> \
//        --pair <原始源目录>=<降级副本目录> [--pair ...] [--require]
//   node scripts/check-degrade-source-of-truth.mjs --self-test
//   退出码：0 = 通过（或无严格档下的 SKIP）；1 = 判据不通过；2 = 用法/环境错误（无法判定，绝不静默跳过）。
//
// 口径边界（如实标注，不得当成已满足）：本门禁证明的是**注入源目录的身份**（注入的是哪一份字节），
// 不证明「降级内容合规」——后者是 check-browser-syntax-floor.mjs --scan 的判据。两条正交：扫描绿 +
// 本门禁绿，才等于「注入的确实是降级结果，且该结果合规」。本门禁不解析构建日志、不读 .deploy-tmp
// 中间目录，故可在构建链运行期间安全执行。
import {
  existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, lstatSync, statSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// tar 的**显式定位**走单一真源（Windows 上裸 'tar' 可能解析到 Git 的 GNU tar，它把 'D:' 当远端主机名）。
import { TAR } from './lib/shell.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAG = 'CHECK-DEGRADE-SOURCE'
const USAGE = '用法: node scripts/check-degrade-source-of-truth.mjs --snapshot <注入后.tar.xz> '
  + '--pair <原始源目录>=<降级副本目录> [--pair ...] [--require] | --self-test'

/**
 * 注入面里的清单文件（与 scripts/inject-all.py 的 EXT_INCLUDE_FILES 同源）。
 *
 * 不在这里自造一份「该注入什么」的清单：注入面口径一旦与本门禁分家，判据就会守着一个
 * 注入器并不认的面（或者漏掉它真携带的面），那时绿的只是门禁自己。
 */
const INJECT_SURFACE_FILES = ['package.json', 'cordis.patch.yml', 'spec.json', 'README.md', 'README.zh-CN.md', 'LICENSE']

// ── --self-test：跑本门禁的单测（正控 + 两条负控），判别力由测试文件钉住 ─────────────
// 只做转发，不在自测里复制判据：判据的唯一实现是本文件，测试跑的是**真门禁进程**。
if (process.argv.includes('--self-test')) {
  const result = spawnSync(process.execPath, ['--test', join(HERE, 'check-degrade-source-of-truth.test.mjs')], { stdio: 'inherit' })
  if ((result.status ?? 1) === 0) {
    console.log(TAG + ' SELF-TEST PASSED（正控 + 负控 A「注入源是原始源」+ 负控 B「两份同 sha 必须 SKIP 并计数」+ 用法/环境错误档）')
    process.exit(0)
  }
  console.error(TAG + ' SELF-TEST FAILED（单测未全绿：' + (result.status ?? 'spawn 失败') + '）')
  process.exit(1)
}

/** 用法/环境错误：判据无法执行（exit 2），绝不静默当通过。 */
const die = (msg) => {
  console.error(TAG + ' 无法判定（exit 2）：' + msg)
  console.error(USAGE)
  process.exit(2)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 目录下所有文件（相对路径、正斜杠；node_modules/.git/.map 排除，与注入器口径一致）。 */
const walkFiles = (dir, prefix = '') => {
  const out = []
  let names
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const rel = prefix ? prefix + '/' + name : name
    let st = null
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) out.push(...walkFiles(full, rel))
    else if (!name.endsWith('.map')) out.push(rel)
  }
  return out
}

/** 一个源目录的注入面（相对包根）。与 inject-all.py 的两条携带规则取并集。 */
const injectSurface = (dir) => {
  const out = new Set()
  const lib = join(dir, 'lib')
  if (existsSync(lib)) for (const rel of walkFiles(lib)) out.add('lib/' + rel)
  const skills = join(dir, 'skills')
  if (existsSync(skills)) for (const rel of walkFiles(skills)) out.add('skills/' + rel)
  for (const f of INJECT_SURFACE_FILES) if (existsSync(join(dir, f))) out.add(f)
  return out
}

/** 包名（package.json 的 name）。读不出返回 null。 */
const packageName = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof pkg?.name === 'string' && pkg.name !== '' ? pkg.name : null
  } catch { return null }
}

/** 把相对路径拼到某个根下（统一用平台分隔符）。 */
const under = (root, rel) => join(root, rel.split('/').join(sep))

/** 读文件字节；不可读（缺席/目录/链接/权限）返回 null。 */
const readBytes = (full) => {
  try {
    const st = lstatSync(full)
    if (st.isSymbolicLink() || !st.isFile()) return null
    return readFileSync(full)
  } catch { return null }
}

/**
 * 改写面：注入面内「原始源与降级副本字节不同」的文件。
 *
 * 为什么用「字节不同」而不是「名字像 client.js」：降级原语
 * （check-browser-syntax-floor.mjs --degrade --stage）只改它判定为浏览器面的文件，改写面因此是
 * **可由字节算出来的事实**，不需要在这里再维护一份「哪些文件会被降级」的清单。
 */
const rewriteSurface = (origDir, degDir) => {
  const orig = injectSurface(origDir)
  const deg = injectSurface(degDir)
  const rewritten = [...orig]
    .filter((rel) => deg.has(rel))
    .filter((rel) => {
      const a = readBytes(under(origDir, rel))
      const b = readBytes(under(degDir, rel))
      if (a === null || b === null) return false
      return !a.equals(b)
    })
    .sort()
  return rewritten
}

/**
 * '--pair <原始源目录>=<降级副本目录>' 的切分。
 *
 * 路径里理论上可能含 '='，所以从右往左找「左侧确实是已存在目录」的分割点；都不成立时退回最左的 '='。
 * 这条规则的目的是让错配立刻可诊断，而不是让一个含 '=' 的路径把判据悄悄指向别的目录。
 */
const splitPair = (spec) => {
  const positions = []
  for (let i = 0; i < spec.length; i += 1) if (spec[i] === '=') positions.push(i)
  if (positions.length === 0) return null
  for (const i of [...positions].reverse()) {
    const left = spec.slice(0, i)
    const right = spec.slice(i + 1)
    if (left !== '' && right !== '' && existsSync(left)) return { left, right }
  }
  const i = positions[0]
  const left = spec.slice(0, i)
  const right = spec.slice(i + 1)
  return left !== '' && right !== '' ? { left, right } : null
}

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf('--' + flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const pairSpecs = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--pair') continue
  if (argv[i + 1] === undefined) die('--pair 缺少取值（形态：<原始源目录>=<降级副本目录>）')
  pairSpecs.push(argv[i + 1])
  i += 1
}
const REQUIRE = argv.includes('--require')

const snapshot = argOf('snapshot')
if (!snapshot) die('缺 --snapshot <注入后.tar.xz>')
if (!existsSync(snapshot)) die('--snapshot 指向的归档不存在: ' + snapshot)
if (pairSpecs.length === 0) die('至少需要一个 --pair <原始源目录>=<降级副本目录>')

// ── 配对校验（错配必须当场说清楚，不能带着错的输入去判）────────────────────────────
const pairs = []
for (const spec of pairSpecs) {
  const split = splitPair(spec)
  if (split === null) die('--pair 形态应为 <原始源目录>=<降级副本目录>：' + spec)
  for (const [side, dir] of [['左', split.left], ['右', split.right]]) {
    if (!existsSync(dir)) die('--pair ' + side + '侧目录不存在: ' + dir)
    let st = null
    try { st = statSync(dir) } catch { /* 由下面统一报 */ }
    if (st === null || !st.isDirectory()) die('--pair ' + side + '侧不是目录: ' + dir)
  }
  const name = packageName(split.left)
  if (name === null) die('--pair 左侧没有可读的 package.json name: ' + split.left)
  const degradedName = packageName(split.right)
  if (degradedName === null) die('--pair 右侧没有可读的 package.json name: ' + split.right)
  pairs.push({ origDir: split.left, degDir: split.right, name, degradedName })
}

// ── 归档成员表（只读成员路径；不解码内容）────────────────────────────────────────
let listing = ''
try {
  listing = execFileSync(TAR, ['-tf', snapshot], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
} catch (e) {
  die('归档不可读（tar -tf 失败）：' + String(e.message).split('\n')[0])
}
/** 成员名归一：去掉 './' 前缀（某些打包方式会带），去掉目录条目。 */
const entries = new Set()
for (const raw of listing.split('\n')) {
  const line = raw.trim().replace(/^\.\//, '')
  if (line === '' || line.endsWith('/')) continue
  entries.add(line)
}
if (entries.size === 0) die('归档成员列表为空（不是 tar.xz / 解压失败）——空集上判据必然恒绿')

/**
 * 归档里出现过的装配 profile（注入落点是 home/.dsh/profiles/<profile>/...）。
 *
 * **不能**把 `profiles/` 下第一层目录名一律当成 profile（2026-11-01 真实产物实测踩到）：
 * 快照里还有 `home/.dsh/profiles/node_modules/`——那是 profile 级共享依赖农场的挂载点
 * （undici farm 的共享面，见 check-profile-undici-resolution.mjs），**不是**装配 profile。
 * 按第一层目录名取，会凭空多出一个名叫 node_modules 的「profile」；它当然没有该包的注入落点，
 * 于是每个包都多出一条无法判定的 SKIP，--require 档直接判红——判据被自己的口径错误判死。
 *
 * 判据：profiles/ 下的第一层非 node_modules 目录。这里是**排除法**而不是「必须有 cordis.patch.yml」：
 * 装配 profile 的名称面由注入器与 ci-verify-snapshot.py 各自登记（负控夹具 headless-bad 也在其中），
 * 本门禁不该用「有没有某份文件」二次定义谁算 profile——那会在夹具/新 profile 上给出第二套答案。
 * 共享农场是唯一一个**按设计**不属于 profile、又确实叫得出名字的目录，故只把它排除。
 */
const SHARED_FARM_DIR = 'node_modules'
const profiles = [...new Set([...entries]
  .map((e) => /^home\/\.dsh\/profiles\/([^/]+)\//.exec(e)?.[1])
  .filter((p) => typeof p === 'string' && p !== '' && p !== SHARED_FARM_DIR))].sort()
if (profiles.length === 0) {
  die('归档里没有任何 home/.dsh/profiles/<profile>/ 成员——这不是注入后的快照（拒绝空集假绿）')
}

/**
 * 负控夹具 profile（与 scripts/ci-verify-snapshot.py 的 NEGATIVE_CONTROL_PROFILES、
 * scripts/inject-all.py 的 NEGATIVE_CONTROL_PROFILES 同源）：注入器**按设计**不往这些 profile 注入
 * 任何插件包（它们只用一份刻意写坏的 cordis.patch.yml 验证启动期「坏配置拒绝」路径）。
 *
 * 所以「该 profile 里没有我们的注入落点」对它们是**预期事实**，不是「无法判定」，不该计入 SKIP。
 * 这里按具名豁免而不是把所有空 profile 都放过：豁免名单必须与仓内真源逐字一致，
 * 名单一旦漂移，本门禁与注入器对「哪些 profile 该有注入」就会给出两套答案。
 */
const NEGATIVE_CONTROL_PROFILES = ['headless-bad']

const memberFor = (profile, name, rel) => 'home/.dsh/profiles/' + profile + '/node_modules/' + name + '/' + rel

// ── 一次性解出需要读字节的成员（逐成员 tar -xOf 会对整包 xz 重解压 N 次）──────────
const plan = pairs.map((pair) => ({ pair, rewritten: rewriteSurface(pair.origDir, pair.degDir) }))
const targets = new Set()
for (const { pair, rewritten } of plan) {
  for (const rel of rewritten) {
    for (const profile of profiles) {
      const member = memberFor(profile, pair.name, rel)
      if (entries.has(member)) targets.add(member)
    }
  }
}
const scratch = mkdtempSync(join(tmpdir(), 'degrade-truth-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ } })
if (targets.size > 0) {
  const listFile = join(scratch, '__members.txt')
  writeFileSync(listFile, [...targets].join('\n') + '\n')
  try {
    execFileSync(TAR, ['-xf', snapshot, '-C', scratch, '-T', listFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    die('归档解成员失败（tar -xf -T 失败）：' + String(e.message).split('\n')[0]
      + '——判据要读 tar 内的真实字节，读不出即无法判定')
  }
}

// ── 判据 ────────────────────────────────────────────────────────────────────────
const failures = []
let skipped = 0
let judged = 0
const fail = (label, detail) => {
  console.log('FAIL  ' + label + ' -> ' + detail)
  failures.push(label)
}
/** SKIP 必须带计数器（本仓门禁纪律：check-gate-skips 审计 SKIP(#n) / SKIP=n）。 */
const skip = (label, detail) => {
  skipped += 1
  console.log('SKIP(#' + skipped + ')  ' + label + '：' + detail)
}

console.log(TAG + ' 判据：tar 内注入字节 == 降级副本字节，且 != 原始源字节（只看字节，不解析构建日志）')
console.log('  归档: ' + snapshot)
console.log('  成员 ' + entries.size + ' 条；装配 profile: ' + profiles.join(', '))

for (const { pair, rewritten } of plan) {
  if (pair.degradedName !== pair.name) {
    fail(pair.name, '降级副本的包名是 ' + pair.degradedName + '，与原始源 ' + pair.name
      + ' 不一致——--pair 配错了，这对目录不是同一个包的两份拷贝')
    continue
  }
  if (rewritten.length === 0) {
    // 两份注入面逐字节相同 ⇒ 这个包没被降级改写。它**不构成判据输入**：此时 tar 里是原始源还是
    // 降级副本，字节上一模一样，任何「等于/不等于」的断言都恒真。必须显式 SKIP 并计数。
    const client = readBytes(under(pair.origDir, 'lib/client.js'))
    skip(pair.name, '原始源与降级副本的注入面逐字节相同（lib/client.js sha256='
      + (client === null ? '（无该文件）' : sha256(client))
      + '）——该包没有被降级改写，不构成判据输入')
    continue
  }
  // 逐 profile 定位：只判「tar 里真的有的落点」；一个都没有 = 无法定位（非严格档 SKIP，严格档判红）。
  const located = profiles.filter((profile) => rewritten.some((rel) => entries.has(memberFor(profile, pair.name, rel))))
  if (located.length === 0) {
    skip(pair.name, 'tar 内找不到该包的注入落点（' + profiles.length + ' 个 profile 里都没有 home/.dsh/profiles/<profile>/node_modules/'
      + pair.name + '/' + rewritten[0] + '）——无法定位落点，判据不成立')
    continue
  }
  // profile 级静默洞：只遍历「定位到了的 profile」会让**整个没注入该包的 profile** 完全不说话。
  // 注入器默认覆盖全部装配 profile（web + headless），某 profile 里一份改写面成员都没有是可诊断的事实，
  // 必须逐 profile 说出来（非严格档 SKIP 计数，--require 档判红）。
  for (const profile of profiles) {
    if (located.includes(profile)) continue
    // 负控夹具 profile 按设计不注入：缺席是预期事实，不是「无法判定」。
    if (NEGATIVE_CONTROL_PROFILES.includes(profile)) continue
    skip(pair.name + '@' + profile, '该 profile 内一份被改写成员都没有（' + rewritten.length
      + ' 个改写文件全部缺席）——那个 profile 的注入源无法判定，不能算通过')
  }
  for (const profile of located) {
    for (const rel of rewritten) {
      const label = pair.name + '@' + profile + ' ' + rel
      const member = memberFor(profile, pair.name, rel)
      if (!entries.has(member)) {
        skip(label, 'tar 内没有这个落点（该 profile 未注入该成员，或成员是链接/非普通文件）——无法判定')
        continue
      }
      const actual = readBytes(under(scratch, member))
      if (actual === null) {
        skip(label, 'tar 内该成员读不出字节（链接/非普通文件/解包失败）——无法判定')
        continue
      }
      const expectedBytes = readBytes(under(pair.degDir, rel))
      const originalBytes = readBytes(under(pair.origDir, rel))
      if (expectedBytes === null || originalBytes === null) {
        fail(label, '源目录侧读不出该文件（原始源=' + (originalBytes === null ? '不可读' : '可读')
          + '，降级副本=' + (expectedBytes === null ? '不可读' : '可读') + '）——注入面不完整')
        continue
      }
      const actualSha = sha256(actual)
      const expectedSha = sha256(expectedBytes)
      const originalSha = sha256(originalBytes)
      if (actualSha === originalSha) {
        // 缺陷形态本体：降级副本被造出来了，注入的却还是原始源。
        fail(label, 'tar 内 sha256=' + actualSha + ' 等于**原始源** sha256=' + originalSha
          + '（期望降级副本 sha256=' + expectedSha + '）——注入源仍是原始源，降级副本被造出来却没用')
        continue
      }
      if (actualSha !== expectedSha) {
        fail(label, 'tar 内 sha256=' + actualSha + ' 既不等于降级副本 sha256=' + expectedSha
          + '，也不等于原始源 sha256=' + originalSha + '——注入的是第三份字节')
        continue
      }
      judged += 1
      console.log('PASS  ' + label + ' sha256=' + actualSha + '（= 降级副本，!= 原始源 ' + originalSha + '）')
    }
  }
}

// 严格档：SKIP / 无法定位落点即判红（不允许把「看不见」当通过）。
if (REQUIRE && skipped > 0) failures.push('严格档：' + skipped + ' 个落点无法判定（SKIP 不得结案）')

console.log('SKIP=' + skipped)
if (failures.length > 0) {
  console.error(TAG + ' FAILED（' + failures.length + ' 项）：' + failures.slice(0, 4).join('；')
    + (failures.length > 4 ? ' 等' : '') + '；SKIP=' + skipped)
  process.exit(1)
}
// 结论行措辞必须与读数一致：judged=0 且 skipped>0 时不能说「N 个落点全部等于降级副本」——
// 那会读成「判过且过了」，而实际是「这个包没被降级改写，不构成判据输入」。
console.log(TAG + ' PASSED（' + pairs.length + ' 对 × ' + profiles.length + ' profile：'
  + (judged > 0
    ? '判定 ' + judged + ' 个落点全部等于降级副本字节且不等于原始源字节'
    : '本次没有可判落点（全部 SKIP，见上）')
  + '；SKIP=' + skipped + '；判据=tar 字节 sha256 vs 两份源目录字节，不解析日志）')