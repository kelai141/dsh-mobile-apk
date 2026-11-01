// check-degrade-source-of-truth.test.mjs — 注入源真源门禁的判别力自证（正控 + 两条负控 + 用法/环境档）。
//
// 为什么需要这些夹具：本门禁守的是**幽灵缺陷**——「降级成功了，但注入时仍用原始源」。
// 这种形态下链上其它门禁全绿（降级步骤跑过、注入后扫描也过），只有「产物字节 vs 两份源目录字节」
// 能把它挑出来。所以自证不能只看它对真实产物说 PASSED，必须证明它在**该红的时候红、该 SKIP 时 SKIP**：
//   · 正控：tar 里是降级副本的字节                     -> PASSED（exit 0）
//   · 负控 A：tar 里是**原始源**的字节（PR #1272 形态） -> FAILED（exit 1），且点名包 + 期望/实际 sha
//   · 负控 B：原始源与降级副本 sha256 相同（没被改写）  -> SKIP 并计数；非严格档 exit 0 且 SKIP=1，
//                                                         --require 档 exit 1（严格档不许 SKIP 结案）
// 另加：多 profile 全判（只判一个 profile 会让另一个假绿）、第二对被换成原始源时也必须红、
// 落点定位不到时非严格档 SKIP / 严格档红、配对错配判红、用法与环境错误 exit 2（不静默）。
//
// 夹具全部用**真 tar.xz**（bsdtar -cJf，与构建链同一种压缩），门禁读的是真实归档字节。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
// tar 走**单一真源**：Windows 上裸 'tar' 可能解析到 Git 的 GNU tar（它把 'C:' 当远端主机名）。
import { TAR } from './lib/shell.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, 'check-degrade-source-of-truth.mjs')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** 一份「原始源」的 lib/client.js：含 Chromium 87 之后的语法（类静态块 / 可选链）。 */
const ORIGINAL_CLIENT = 'export class Panel {\n'
  + '  static { this.ready = true }\n'
  + '  static mount(o) { return o?.shell?.root ?? null }\n'
  + '}\n'
/** 一份「降级副本」的 lib/client.js：语义等价、但只含 chrome87 能解析的形态（与原文**不同字节**）。 */
const DEGRADED_CLIENT = 'var Panel = class Panel {\n'
  + '  static mount(o) { return o == null ? null : (o.shell == null ? null : (o.shell.root == null ? null : o.shell.root)) }\n'
  + '}\n'
  + 'Panel.ready = true\n'
/** 与降级副本逐字节相同的「原始源」：该包没被改写（负控 B 的形态）。 */
const UNCHANGED_CLIENT = DEGRADED_CLIENT

/**
 * 造一份注入源目录。
 * @param root 根
 * @param rel 目录相对根
 * @param name 包名（package.json name，注入落点按它定位）
 * @param client lib/client.js 的内容
 * @param extra 其它成员（相对包根 -> 内容）
 */
function makeSource(root, rel, name, client, extra = {}) {
  const dir = join(root, rel)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module' }, null, 2) + '\n')
  writeFileSync(join(dir, 'lib', 'client.js'), client)
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const value = 1\n')
  for (const [member, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, member)), { recursive: true })
    writeFileSync(join(dir, member), content)
  }
  return dir
}

/**
 * 造一份「注入后快照」tar.xz。
 *
 * 关键：注入落点用 home/.dsh/profiles/<profile>/node_modules/<name>/<rel>——与 inject-all.py 一致。
 * 显式列顶层目录打包（不是 -C stage .），否则成员名会带 './' 前缀。
 */
function makeSnapshot(root, { profiles, packages, tag, extraProfiles = [], sharedFarm = false }) {
  const stage = join(root, 'stage-' + tag)
  for (const profile of profiles) {
    for (const { name, members } of packages) {
      for (const [rel, content] of Object.entries(members)) {
        const full = join(stage, 'home/.dsh/profiles', profile, 'node_modules', name, rel)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content)
      }
    }
  }
  // 只在场、但没有任何注入包成员的 profile（用于「某个 profile 没注入该包」的静默洞用例）
  for (const profile of extraProfiles) {
    const marker = join(stage, 'home/.dsh/profiles', profile, 'cordis.patch.yml')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '# profile marker\n')
  }
  // 真实归档里还有一个 home/.dsh/profiles/node_modules/：profile 级共享依赖农场的挂载点。
  // 它**不是**装配 profile（没有 cordis.patch.yml），用于钉住「不得按第一层目录名取 profile」。
  if (sharedFarm) {
    const farm = join(stage, 'home/.dsh/profiles/node_modules/undici')
    mkdirSync(farm, { recursive: true })
    writeFileSync(join(farm, 'package.json'), '{"name":"undici","version":"8.11.2"}\n')
  }
  // 骨架：非空成员表 + 至少一个 home/ 前缀（拒绝空集假绿的那两条前置）
  mkdirSync(join(stage, 'usr/bin'), { recursive: true })
  writeFileSync(join(stage, 'usr/bin/true'), 'x')
  const archive = join(root, 'snap-' + tag + '.tar.xz')
  execFileSync(TAR, ['-cJf', archive, '-C', stage, 'home', 'usr'], { stdio: ['ignore', 'pipe', 'pipe'] })
  return archive
}

/** 跑真门禁（独立进程；与 CI/构建链调用方式一致）。 */
function runGate(args, cwd) {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', cwd })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

/** 建夹具根目录，跑完必删。 */
function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'degrade-truth-test-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

// ── 正控：tar 里是降级副本的字节 -> PASSED exit 0 ────────────────────────────────
test('正控：注入的是降级副本字节 -> PASSED（exit 0），两个 profile 都判', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'positive',
    profiles: ['web', 'headless'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(deg, 'package.json'), 'utf8'),
      'lib/client.js': DEGRADED_CLIENT,
      'lib/index.js': 'export const value = 1\n',
    } }],
  })
  const r = runGate(['--snapshot', snap, '--pair', orig + '=' + deg, '--require'])
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /CHECK-DEGRADE-SOURCE PASSED/)
  // 两个 profile 都必须有判据行——只判一个 profile 就是假绿面
  assert.match(r.out, /PASS  dshmarketplace-plugin@web lib\/client\.js/)
  assert.match(r.out, /PASS  dshmarketplace-plugin@headless lib\/client\.js/)
  assert.match(r.out, /SKIP=0/)
  // 断言里的 sha 必须是「降级副本的 sha」，不是「随便算了一个」
  assert.ok(r.out.includes('sha256=' + sha256(DEGRADED_CLIENT)), r.out)
}))

// ── 负控 A：注入源被换成原始源 -> 必须判红（exit 1），点名包 + 期望/实际 sha ──────
test('负控 A：tar 里是原始源字节（降级副本被造出来却没用）-> FAILED（exit 1），点名包与期望/实际 sha', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  // 缺陷形态：注入器读的是**原始源**目录
  const snap = makeSnapshot(root, {
    tag: 'neg-a',
    profiles: ['web', 'headless'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(orig, 'package.json'), 'utf8'),
      'lib/client.js': ORIGINAL_CLIENT,
      'lib/index.js': 'export const value = 1\n',
    } }],
  })
  const r = runGate(['--snapshot', snap, '--pair', orig + '=' + deg])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.err, /CHECK-DEGRADE-SOURCE FAILED/)
  // 点名是哪个包 + 哪个落点
  assert.match(r.out, /FAIL  dshmarketplace-plugin@web lib\/client\.js/)
  // 必须报出「期望 sha（降级副本）」与「实际 sha（原始源）」
  const expectSha = sha256(DEGRADED_CLIENT)
  const actualSha = sha256(ORIGINAL_CLIENT)
  assert.ok(r.out.includes(expectSha), '未打印期望 sha（降级副本）: ' + r.out)
  assert.ok(r.out.includes(actualSha), '未打印实际 sha（原始源）: ' + r.out)
  // 判据行必须说清「注入源仍是原始源」，而不是含糊的「不匹配」
  assert.match(r.out, /注入源仍是原始源/)
}))

// ── 负控 B：降级副本未被使用且两者 sha 相同 -> SKIP 并计数 ───────────────────────
test('负控 B：原始源与降级副本 sha256 相同 -> SKIP=1；非严格档 exit 0，--require 档 exit 1', () => withFixture((root) => {
  // 该包这轮没有被降级改写：两份字节完全相同
  const orig = makeSource(root, 'src/orig', 'dsh-plugin-subscriptions', UNCHANGED_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dsh-plugin-subscriptions', UNCHANGED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'neg-b',
    profiles: ['web', 'headless'],
    packages: [{ name: 'dsh-plugin-subscriptions', members: {
      'package.json': readFileSync(join(orig, 'package.json'), 'utf8'),
      'lib/client.js': UNCHANGED_CLIENT,
      'lib/index.js': 'export const value = 1\n',
    } }],
  })
  const loose = runGate(['--snapshot', snap, '--pair', orig + '=' + deg])
  assert.equal(loose.code, 0, loose.out + loose.err)
  assert.match(loose.out, /SKIP\(#1\)/)
  assert.match(loose.out, /SKIP=1/)
  assert.match(loose.out, /CHECK-DEGRADE-SOURCE PASSED/)
  // SKIP 必须说清「为什么它不构成判据输入」，不能是一条无理由的静默
  assert.match(loose.out, /不构成判据输入/)

  const strict = runGate(['--snapshot', snap, '--pair', orig + '=' + deg, '--require'])
  assert.equal(strict.code, 1, strict.out + strict.err)
  assert.match(strict.err, /CHECK-DEGRADE-SOURCE FAILED/)
  assert.match(strict.out, /SKIP=1/)
}))

// ── 多包：一对真降级 + 一对没降级 -> 前者判 PASS，后者 SKIP，互不掩盖 ────────────
test('多对混装：降级对判 PASS，未改写对 SKIP，两条判据互不掩盖', () => withFixture((root) => {
  const origA = makeSource(root, 'src/a-orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const degA = makeSource(root, 'src/a-deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const origB = makeSource(root, 'src/b-orig', 'dsh-plugin-subscriptions', UNCHANGED_CLIENT)
  const degB = makeSource(root, 'src/b-deg', 'dsh-plugin-subscriptions', UNCHANGED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'multi',
    profiles: ['web'],
    packages: [
      { name: 'dshmarketplace-plugin', members: {
        'package.json': readFileSync(join(degA, 'package.json'), 'utf8'),
        'lib/client.js': DEGRADED_CLIENT,
        'lib/index.js': 'export const value = 1\n',
      } },
      { name: 'dsh-plugin-subscriptions', members: {
        'package.json': readFileSync(join(origB, 'package.json'), 'utf8'),
        'lib/client.js': UNCHANGED_CLIENT,
        'lib/index.js': 'export const value = 1\n',
      } },
    ],
  })
  const r = runGate(['--snapshot', snap, '--pair', origA + '=' + degA, '--pair', origB + '=' + degB])
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /PASS  dshmarketplace-plugin@web lib\/client\.js/)
  assert.match(r.out, /SKIP\(#1\)  dsh-plugin-subscriptions/)
  assert.match(r.out, /SKIP=1/)
  assert.match(r.out, /判定 1 个落点/)
}))

// ── 第二对被换成原始源：多包里任何一个用错源都必须判红（PR #1272 的原始形态）────
test('负控 A 扩展：多对里只有第二个包用了原始源 -> 仍必须判红（不能只守第一个包）', () => withFixture((root) => {
  const origA = makeSource(root, 'src/a-orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const degA = makeSource(root, 'src/a-deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const origB = makeSource(root, 'src/b-orig', 'dsh-plugin-subscriptions', ORIGINAL_CLIENT + '// subscriptions\n')
  const degB = makeSource(root, 'src/b-deg', 'dsh-plugin-subscriptions', DEGRADED_CLIENT + '// subscriptions\n')
  const snap = makeSnapshot(root, {
    tag: 'second-wrong',
    profiles: ['web'],
    packages: [
      { name: 'dshmarketplace-plugin', members: {
        'package.json': readFileSync(join(degA, 'package.json'), 'utf8'),
        'lib/client.js': DEGRADED_CLIENT,
        'lib/index.js': 'export const value = 1\n',
      } },
      { name: 'dsh-plugin-subscriptions', members: {
        'package.json': readFileSync(join(origB, 'package.json'), 'utf8'),
        'lib/client.js': ORIGINAL_CLIENT + '// subscriptions\n',
        'lib/index.js': 'export const value = 1\n',
      } },
    ],
  })
  const r = runGate(['--snapshot', snap, '--pair', origA + '=' + degA, '--pair', origB + '=' + degB])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /FAIL  dsh-plugin-subscriptions@web lib\/client\.js/)
  assert.match(r.err, /CHECK-DEGRADE-SOURCE FAILED/)
}))

// ── 定位不到落点：非严格档 SKIP，严格档判红（严格档不许「看不见」当通过）────────
test('落点定位不到：非严格档 SKIP=1 + exit 0；--require 档 exit 1', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  // tar 里只有别的包，没有 dshmarketplace-plugin 的落点
  const snap = makeSnapshot(root, {
    tag: 'missing',
    profiles: ['web'],
    packages: [{ name: 'other-plugin', members: {
      'package.json': JSON.stringify({ name: 'other-plugin' }),
      'lib/client.js': DEGRADED_CLIENT,
    } }],
  })
  const loose = runGate(['--snapshot', snap, '--pair', orig + '=' + deg])
  assert.equal(loose.code, 0, loose.out + loose.err)
  assert.match(loose.out, /SKIP=1/)
  assert.match(loose.out, /找不到该包的注入落点/)

  const strict = runGate(['--snapshot', snap, '--pair', orig + '=' + deg, '--require'])
  assert.equal(strict.code, 1, strict.out + strict.err)
}))

// ── 用法/环境错误：exit 2（不静默、不当作通过）──────────────────────────────────
test('用法/环境错误 exit 2：缺 --snapshot / 缺 --pair / 归档不可读 / 归档不是注入后快照', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const pair = orig + '=' + deg
  const good = makeSnapshot(root, {
    tag: 'usage',
    profiles: ['web'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(deg, 'package.json'), 'utf8'),
      'lib/client.js': DEGRADED_CLIENT,
    } }],
  })
  assert.equal(runGate(['--pair', pair]).code, 2, '缺 --snapshot 必须 exit 2')
  assert.equal(runGate(['--snapshot', good]).code, 2, '缺 --pair 必须 exit 2')
  assert.equal(runGate(['--snapshot', join(root, 'nope.tar.xz'), '--pair', pair]).code, 2, '归档不存在必须 exit 2')
  // 不是注入后快照（没有 home/.dsh/profiles/ 成员）-> 拒绝空集假绿
  const junk = join(root, 'junk.tar.xz')
  mkdirSync(join(root, 'junk-src/usr/bin'), { recursive: true })
  writeFileSync(join(root, 'junk-src/usr/bin/true'), 'x')
  execFileSync(TAR, ['-cJf', junk, '-C', join(root, 'junk-src'), 'usr'], { stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(runGate(['--snapshot', junk, '--pair', pair]).code, 2, '非注入后快照必须 exit 2')
}))

// ── 配对错配：左右不是同一个包 -> 判红（不带着错的输入去判）──────────────────────
test('配对错配：降级副本的包名与原始源不同 -> FAILED（exit 1），并说清是配错', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dsh-plugin-subscriptions', DEGRADED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'mismatch',
    profiles: ['web'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(orig, 'package.json'), 'utf8'),
      'lib/client.js': ORIGINAL_CLIENT,
    } }],
  })
  const r = runGate(['--snapshot', snap, '--pair', orig + '=' + deg])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /配错/)
}))

// ── 夹具自检：防夹具退化成「造了个空 tar」而判据恒绿 ─────────────────────────────
test('夹具自检：tar.xz 真的是 xz 压缩且成员表非空，两份源的 client.js 字节确实不同', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'selftest',
    profiles: ['web', 'headless'],
    packages: [{ name: 'dshmarketplace-plugin', members: { 'lib/client.js': DEGRADED_CLIENT } }],
  })
  // xz 魔数（fd 37 7a 58 5a 00）
  const head = readFileSync(snap).subarray(0, 6)
  assert.equal(head.toString('hex'), 'fd377a585a00', '夹具必须是真 xz 归档')
  assert.ok(statSync(snap).size > 0)
  // 注意：Windows 的 bsdtar 输出是 CRLF，成员名必须 trim（门禁侧同样按行 trim 后比对）
  const members = execFileSync(TAR, ['-tf', snap], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
  assert.ok(members.includes('home/.dsh/profiles/web/node_modules/dshmarketplace-plugin/lib/client.js'), members.join(','))
  assert.ok(members.includes('home/.dsh/profiles/headless/node_modules/dshmarketplace-plugin/lib/client.js'), members.join(','))
  // 两份源目录的 client.js 必须真的不同字节（否则负控 A 就没有判别力）
  assert.notEqual(sha256(readFileSync(join(orig, 'lib/client.js'))), sha256(readFileSync(join(deg, 'lib/client.js'))))
}))
// ── profile 级静默洞：某个 profile 整份没注入该包 -> 必须 SKIP 计数（严格档判红）──────
// 真因形态：注入器此前只落 web，会让 headless 缺包（ST-05 / F-ENV-02）。若门禁只遍历「定位到了的
// profile」，那个空 profile 会一个字都不说——判据在它的面上等于不存在。
test('profile 级静默洞：headless 没注入该包 -> 非严格档 SKIP=1 + exit 0；--require 档 exit 1', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'profile-hole',
    profiles: ['web'],
    extraProfiles: ['headless'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(deg, 'package.json'), 'utf8'),
      'lib/client.js': DEGRADED_CLIENT,
    } }],
  })
  const loose = runGate(['--snapshot', snap, '--pair', orig + '=' + deg])
  assert.equal(loose.code, 0, loose.out + loose.err)
  assert.match(loose.out, /PASS  dshmarketplace-plugin@web lib\/client\.js/)
  // 空 profile 必须显式说话，且带计数
  assert.match(loose.out, /SKIP\(#1\)  dshmarketplace-plugin@headless/)
  assert.match(loose.out, /SKIP=1/)

  const strict = runGate(['--snapshot', snap, '--pair', orig + '=' + deg, '--require'])
  assert.equal(strict.code, 1, strict.out + strict.err)
}))

// ── 共享农场 `profiles/node_modules` 不得被当成 profile（真实产物实测踩到）──────────────
// 真因形态：快照里有 home/.dsh/profiles/node_modules/（profile 级共享依赖农场的挂载点）。
// 若按「profiles/ 下第一层目录名」取 profile，会凭空多出一个名叫 node_modules 的「profile」；
// 它当然没有该包的注入落点，于是每个包都多一条无法判定的 SKIP，--require 档直接判红——
// 判据被自己的口径错误判死。装配 profile 的真正标记是 <profile>/cordis.patch.yml。
test('共享农场 profiles/node_modules 不得被当成 profile -> --require 档仍 PASSED、SKIP=0', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'farm',
    sharedFarm: true,
    profiles: ['web', 'headless'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(deg, 'package.json'), 'utf8'),
      'lib/client.js': DEGRADED_CLIENT,
    } }],
  })
  const r = runGate(['--snapshot', snap, '--pair', orig + '=' + deg, '--require'])
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /CHECK-DEGRADE-SOURCE PASSED/)
  assert.match(r.out, /SKIP=0/)
  // 逐字钉住：装配 profile 列表里不得出现 node_modules
  assert.match(r.out, /装配 profile: headless, web/)
  assert.doesNotMatch(r.out, /@node_modules/)
}))

// ── 负控夹具 profile 按设计不注入 -> 不得算 SKIP、不得判红 ─────────────────────────
// 真因形态：headless-bad 是仓内登记（ci-verify-snapshot.py / inject-all.py 的
// NEGATIVE_CONTROL_PROFILES）的负控夹具，只用一份写坏的 cordis.patch.yml 验证启动期拒绝路径，
// 注入器按设计不往里注入任何插件包。若把它算成「无法判定」，严格档会永远红——
// 那不是发现了缺陷，是门禁不认识自己的夹具。
test('负控夹具 profile headless-bad 不注入 -> 不算 SKIP、--require 档仍 PASSED', () => withFixture((root) => {
  const orig = makeSource(root, 'src/orig', 'dshmarketplace-plugin', ORIGINAL_CLIENT)
  const deg = makeSource(root, 'src/deg', 'dshmarketplace-plugin', DEGRADED_CLIENT)
  const snap = makeSnapshot(root, {
    tag: 'negctl',
    profiles: ['web', 'headless'],
    extraProfiles: ['headless-bad'],
    packages: [{ name: 'dshmarketplace-plugin', members: {
      'package.json': readFileSync(join(deg, 'package.json'), 'utf8'),
      'lib/client.js': DEGRADED_CLIENT,
    } }],
  })
  const r = runGate(['--snapshot', snap, '--pair', orig + '=' + deg, '--require'])
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /CHECK-DEGRADE-SOURCE PASSED/)
  assert.match(r.out, /SKIP=0/)
  // headless-bad 既不该出 SKIP、也不该出判据行（它出现在「装配 profile: ...」清单里是正常的——
  // 它确实是个 profile，只是按设计不注入任何包）。判据只看 SKIP 行与 PASS/FAIL 行。
  assert.doesNotMatch(r.out, /SKIP\(#\d+\)\s+dshmarketplace-plugin@headless-bad/)
  assert.doesNotMatch(r.out, /(PASS|FAIL)\s+dshmarketplace-plugin@headless-bad/)
}))