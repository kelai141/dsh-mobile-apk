#!/usr/bin/env node
// check-inject-completeness.mjs — 注入面成员完整性门禁（0.0.13 → 0.13.8-b P0 修复；坑 63 的活体复现防线）。
//
// 背景（dev-incoming 实测 2026-09-12）：inject-all.py 原先只替换「基座里已存在」的成员，包内**新增文件**
// 被静默丢弃（包名已见即不触发整包追加），而 tar 里的 lib/index.js 仍 import 那些文件 → 设备侧
// ERR_MODULE_NOT_FOUND → 引擎启动即死。修法在注入链（补缺循环），本门禁是**产物级**对账：
//
// 断言（逐装配 profile × 逐注入包）：
//   A. 成员集合：tar 内 <profile>/node_modules/[<scope>/]<pkg> 的成员必须与源包**注入面**逐字一致
//      （缺一个即 FAIL；多出源包没有的文件也 FAIL——那是残留/幽灵面）。
//      「注入面」的口径由 scripts/inject-all.py 决定（@dsh-android 包 = package.json + lib/**（.map 除外）；
//      根级外部包 = lib/** + skills/** + 在场的清单文件），不是由本门禁自造的第二份清单。
//   B. 相对导入可解析：tar 内该包每个 lib/**.js 里的 './x.js' / '../y.js' import 都必须能在同一包内找到
//      （直击 ERR_MODULE_NOT_FOUND 类缺陷）。**lib → lib/ 之外**的悬空导入无条件判红（注入器不携带该面，
//      设备上永远缺那个文件）；lib → lib 的悬空导入按「源包有没有」区分判红 / 具名 WARN。
//   C. 装配 profile（inject-all 的 PROFILES：web + headless）都要满足 A/B——单 profile 通过即拒。
//
// issue #1035（覆盖面不再硬编码）——旧实现三处只看得见「清单里登记过的包」：
//   ① 循环只遍历 manifest.dirs/externals，于是 tar 里**多出的未登记 @dsh-android 包**从不参与比较
//      （实测：造 plugins/dsh-android-ghost 塞进两个 profile 的 tar，门禁一字不差 PASSED）。
//      现改为**双向枚举**：登记集 → tar 必须都在；tar 里每个 @dsh-android 包 → 必须已登记（未登记判红）。
//      权威源是 **tar 实际内容**（磁盘上未登记的源码目录不构成注入缺陷——linux-bootstrap 就是
//      按设计留在装配集之外的 vendored 包，见 scripts/check-vendored-linux-bootstrap.mjs 头注释）。
//   ② 源包成员集合只走 lib/，而多个包的 package.json files 字段发布 src/、test/、SOURCE.json；
//      tar 侧成员集合又硬编码成 package.json + lib/**。现改为：源侧 = 注入面（见 A），并把
//      「files 字段声明、但注入器不携带」的面逐包登记（DECLARED_NOT_INJECTED，必须带理由）——
//      未登记的发散判红，登记了却不再发散同样判红（stale）。tar 侧不再按前缀过滤，任何多出的文件都判红。
//   ③ lib → 非 lib 的相对导入被无条件降级成 WARN，措辞还是「源码侧现象」——源包明明有那个文件。
//      现改为判红（见 B），WARN 只保留「源包自身也不含」这一种真实源码侧形态。
//
// 用法：node scripts/check-inject-completeness.mjs <injected.tar.xz> [--profiles web,headless]
// 退出码：0 = 通过；1 = 成员缺失/导入悬空/残留/未登记包；2 = 用法或 tar 不可读。
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { TAR } from './lib/shell.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
if (argv.includes('--self-test')) {
  const result = spawnSync(process.execPath, ['--test', join(HERE, 'check-inject-completeness.test.mjs'), join(HERE, 'build-injection-staging.test.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
const tar = argv[0]
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const PROFILES = argOf('profiles', 'web,headless').split(',').map((s) => s.trim()).filter(Boolean)
if (!tar || !existsSync(tar)) { console.error('用法: node scripts/check-inject-completeness.mjs <injected.tar.xz> [--profiles web,headless]'); process.exit(2) }

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'plugin-dirs.json'), 'utf8'))
const dshDirs = (manifest.dirs ?? []).map((d) => join(ROOT, d))
const extDirs = (manifest.externals ?? []).map((d) => join(ROOT, d))

// ── 注入器口径（与 scripts/inject-all.py 同源；B 段的判据必须用同一份规则）─────────────
// inject-all.py: build_dsh_replacements 只走 lib/**（.map 除外）+ package.json（按**目录名**放置）；
// build_ext_replacements 走 lib/** + skills/** + EXT_INCLUDE_FILES 中实际在场的清单文件（按 package.json name 放置）。
const EXT_INCLUDE_FILES = ['package.json', 'cordis.patch.yml', 'spec.json', 'README.md', 'README.zh-CN.md', 'LICENSE']

/** 目录下所有文件（相对路径，正斜杠；node_modules/.git/.map 排除）。 */
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

/** glob 转正则（只覆盖 files 字段实际出现的形态：纯目录、纯文件、单星号、双星号多段）。 */
const globToRegExp = (spec) => {
  let out = ''
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i]
    if (ch === '*') {
      if (spec[i + 1] === '*') {
        i += 1
        if (spec[i + 1] === '/') { i += 1; out += '(?:.*/)?' } else out += '.*'
      } else out += '[^/]*'
    } else if ('.+^${}()|[]\\'.includes(ch)) out += '\\' + ch
    else out += ch
  }
  return new RegExp('^' + out + '$')
}

/** package.json files 字段声明的发布面（glob 展开；无该字段 = 空集）。 */
const declaredMembers = (dir, files) => {
  if (!Array.isArray(files) || files.length === 0) return new Set()
  const all = walkFiles(dir)
  const out = new Set()
  for (const raw of files) {
    if (typeof raw !== 'string') continue
    const spec = raw.replace(/\\/g, '/').replace(/\/+$/, '')
    if (spec === '') continue
    if (!/[*?]/.test(spec)) {
      const full = join(dir, spec)
      if (!existsSync(full)) continue
      if (statSync(full).isDirectory()) {
        for (const rel of all) if (rel === spec || rel.startsWith(spec + '/')) out.add(rel)
      } else out.add(spec)
      continue
    }
    const re = globToRegExp(spec)
    for (const rel of all) if (re.test(rel)) out.add(rel)
  }
  return out
}

/** 注入器会携带的成员集合（相对包根）。 */
const injectedMembers = (dir, kind) => {
  const out = new Set(['package.json'])
  const lib = join(dir, 'lib')
  if (existsSync(lib)) for (const rel of walkFiles(lib)) out.add('lib/' + rel)
  if (kind === 'external') {
    const skills = join(dir, 'skills')
    if (existsSync(skills)) for (const rel of walkFiles(skills)) out.add('skills/' + rel)
    for (const f of EXT_INCLUDE_FILES) if (existsSync(join(dir, f))) out.add(f)
  }
  return out
}

/** 读一个源包：包名 + 注入面 + files 声明面。 */
const packageMeta = (dir, kind) => {
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return { name: null } }
  if (pkg === null || typeof pkg.name !== 'string') return { name: null }
  return { name: pkg.name, dir, kind, injected: injectedMembers(dir, kind), declared: declaredMembers(dir, pkg.files) }
}

/**
 * issue #1035 ②：「package.json files 字段声明、但注入器不携带」的面——**逐包登记，必须带理由**。
 *
 * 这些不是注入缺陷（注入器只携带运行期面），而是「npm 发布字段 ≠ 注入面」这一**已知发散**。
 * 登记的作用是把它从「静默接受」变成「显式接受」：新增一个声明面而注入器不带、也没登记 → 判红；
 * 登记了却不再发散（files 字段被改/删）→ 也判红（stale），强制这行跟着事实走。
 */
const DECLARED_NOT_INJECTED = new Map([
  ['@dsh-android/dsh-session-delete', {
    paths: ['src', 'test', 'README.md'],
    reason: 'npm 发布面含源码/测试/说明；注入器只携带 package.json + lib/**（运行期面）。'
      + 'src/ 与 test/ 属源码面、README.md 属发布说明，都不进快照（体积与源码面不外泄）。',
  }],
  ['@dsh-android/dsh-client-ui-responsive', {
    paths: ['src/client/mobile/upstream-browser/LICENSE', 'src/client/mobile/upstream-browser/SOURCE.json', 'src/client/mobile/upstream-browser/README.md'],
    reason: '上游浏览器的归属/来源元数据随 npm 发布，但注入面只有 lib/**；'
      + '这些文件的合规面由 check-third-party.mjs 的许可台账与 THIRD_PARTY_NOTICES 覆盖，不经快照注入。',
  }],
])

/** 登记路径是否覆盖某个发散成员（按目录前缀）。 */
const coveredBy = (paths, member) => paths.some((p) => member === p || member.startsWith(p + '/'))

let listing = ''
try { listing = execFileSync(TAR, ['-tf', tar], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }) } catch (e) {
  console.error('CHECK-INJECT-COMPLETENESS FAILED：tar 不可读（' + e.message + '）')
  process.exit(2)
}
const entries = new Set(listing.split('\n').map((l) => l.trim()).filter(Boolean))
console.log('tar 条目: ' + entries.size + '；装配 profile: ' + PROFILES.join(', '))

// ── issue #1035 ① 双向枚举：tar 里每个 @dsh-android 包都必须已登记 ─────────────────────
// 登记集（@dsh-android 命名空间）= manifest.dirs 的**目录名**——inject-all.py 按 basename 放置。
const registeredDshNames = new Set(dshDirs.map((d) => basename(d)))
for (const profile of PROFILES) {
  const prefix = 'home/.dsh/profiles/' + profile + '/node_modules/@dsh-android/'
  const seen = new Map()   // pkg -> 至少一个成员
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const rest = entry.slice(prefix.length)
    const pkg = rest.split('/')[0]
    if (!pkg) continue
    seen.set(pkg, true)
  }
  const unregistered = [...seen.keys()].filter((p) => !registeredDshNames.has(p)).sort()
  check(profile + ' tar 内 @dsh-android 包全部已登记（' + seen.size + ' 个）', unregistered.length === 0,
    '未登记: [' + unregistered.join(', ') + ']——未登记的包不会被任何成员/导入判据覆盖；'
    + '要注入就在 scripts/plugin-dirs.json 的 dirs 登记，不注入就不该出现在快照里')
}

// ── issue #1035 ② 声明面 vs 注入面（tar 无关，逐包一次）──────────────────────────────
{
  const allPkgs = []
  for (const dir of dshDirs) allPkgs.push(packageMeta(dir, 'dsh'))
  for (const dir of extDirs) allPkgs.push(packageMeta(dir, 'external'))
  const seenNames = new Set()
  for (const meta of allPkgs) {
    if (meta.name === null || seenNames.has(meta.name)) continue
    seenNames.add(meta.name)
    const divergent = [...meta.declared].filter((m) => !meta.injected.has(m)).sort()
    const registered = DECLARED_NOT_INJECTED.get(meta.name)
    const unregistered = divergent.filter((m) => registered === undefined || !coveredBy(registered.paths, m))
    check('声明面/注入面发散已登记: ' + meta.name, unregistered.length === 0,
      'files 字段声明了注入器不携带的面且未登记: [' + unregistered.join(', ') + ']'
      + (registered === undefined ? '（该包在 DECLARED_NOT_INJECTED 里没有条目）' : '（已登记路径: [' + registered.paths.join(', ') + ']）')
      + '——要么把它纳入注入面，要么在 DECLARED_NOT_INJECTED 登记理由')
    if (registered !== undefined && divergent.length === 0) {
      check('登记的声明面发散仍在场: ' + meta.name, false,
        'DECLARED_NOT_INJECTED 登记了 [' + registered.paths.join(', ') + '] 但 files 字段已不再声明它们（stale，删除该条目）')
    }
  }
}

// 单次解压（重要：逐成员 tar -xO 会对 170MB xz 重解压 N 次，实测 >10min 超时）——
// 只抽出需要的包成员 + package.json，一次 -xf 完成，后续分析在本地文件上做。
const scratch = mkdtempSync(join(tmpdir(), 'inj-complete-'))
const extractArgs = []
for (const profile of PROFILES) {
  for (const dir of [...dshDirs, ...extDirs]) {
    const meta = packageMeta(dir, dshDirs.includes(dir) ? 'dsh' : 'external')
    if (meta.name === null) continue
    const base = 'home/.dsh/profiles/' + profile + '/node_modules/' + meta.name
    extractArgs.push(base + '/package.json', base + '/lib')
  }
}
try {
  execFileSync(TAR, ['-xf', tar, '-C', scratch, '--', ...extractArgs], { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
} catch { /* 缺席成员按缺失处理（后续断言会报），不在此处中断 */ }

let checkedPkgs = 0
for (const profile of PROFILES) {
  for (const [dir, kind] of [...dshDirs.map((d) => [d, 'dsh']), ...extDirs.map((d) => [d, 'external'])]) {
    const meta = packageMeta(dir, kind)
    if (meta.name === null) { check('源包可读: ' + dir, false); continue }
    const pkgBase = 'home/.dsh/profiles/' + profile + '/node_modules/' + meta.name
    const present = new Set()
    for (const e of entries) {
      if (!e.startsWith(pkgBase + '/')) continue
      const rel = e.slice(pkgBase.length + 1)
      if (rel === '' || rel.endsWith('.map') || rel.endsWith('/')) continue   // 包目录自身与目录条目不是成员
      if (entries.has(e + '/')) continue                                      // 无尾斜杠的目录条目（bsdtar）也不算成员
      // issue #1035：不再按 package.json / lib/ 前缀过滤——tar 里多出的任何文件都是幽灵面。
      present.add(rel)
    }
    if (present.size === 0) { check(profile + ' 注入包在场: ' + meta.name, false, 'tar 内无该包成员'); continue }
    checkedPkgs += 1
    const missing = [...meta.injected].filter((m) => !present.has(m)).sort()
    const extra = [...present].filter((m) => !meta.injected.has(m)).sort()
    check(profile + ' 成员集合一致: ' + meta.name + '（' + meta.injected.size + ' 项）', missing.length === 0 && extra.length === 0,
      (missing.length ? '缺 ' + missing.length + ' 项: [' + missing.slice(0, 5).join(', ') + ']' : '')
      + (extra.length ? (missing.length ? '；' : '') + '多 ' + extra.length + ' 项: [' + extra.slice(0, 5).join(', ') + ']'
        + '（注入器只携带 package.json + lib/**（外部包另有 skills/** 与清单文件）——多出即幽灵面/未登记面）' : ''))
    // B. 相对导入可解析（直击 ERR_MODULE_NOT_FOUND）
    // issue #1035 ③：lib → lib/ 之外的悬空导入**无条件判红**（注入器不携带该面，设备上必然缺文件）；
    // lib → lib 的悬空导入按「源包有没有」区分：源包有 = 注入丢件（红），源包也没有 = 源码侧缺陷（具名 WARN，措辞纠正）。
    const danglingImports = []
    const sourceMissing = new Set()
    for (const member of present) {
      if (!member.startsWith('lib/') || !member.endsWith('.js')) continue
      let text = ''
      try { text = readFileSync(join(scratch, pkgBase, member), 'utf8') } catch { continue }
      for (const m of text.matchAll(/(?:from|import|require)\(?\s*['"](\.[^'"]+)['"]/g)) {
        const spec = m[1]
        const resolved = posix.normalize(posix.join(posix.dirname(member), spec))
        if (present.has(resolved) || entries.has(pkgBase + '/' + resolved)) continue
        if (!resolved.startsWith('lib/')) danglingImports.push(member + ' -> ' + spec + '（目标在 lib/ 之外，注入器不携带）')
        else if (meta.injected.has(resolved)) danglingImports.push(member + ' -> ' + spec)
        else sourceMissing.add(member + ' -> ' + spec)
      }
    }
    check(profile + ' 相对导入可解析: ' + meta.name, danglingImports.length === 0,
      '悬空 ' + danglingImports.length + ' 条: [' + danglingImports.slice(0, 3).join('; ') + ']')
    if (sourceMissing.size > 0) {
      console.log('WARN  ' + profile + ' ' + meta.name + '：' + sourceMissing.size
        + ' 条导入目标源包自身也不含（源码侧缺陷：打包产物引用了不存在的文件，运行期同样 ERR_MODULE_NOT_FOUND；'
        + '非注入缺陷，但不该长期共存）: ' + [...sourceMissing].slice(0, 2).join('; '))
    }
  }
}
rmSync(scratch, { recursive: true, force: true })
check('至少核对到一个注入包', checkedPkgs > 0, 'checked=' + checkedPkgs)

if (failures.length > 0) {
  console.error('CHECK-INJECT-COMPLETENESS FAILED（' + failures.length + ' 项）：' + failures.slice(0, 6).join('；'))
  process.exit(1)
}
console.log('CHECK-INJECT-COMPLETENESS PASSED（' + checkedPkgs + ' 包 × ' + PROFILES.length + ' profile：'
  + '登记全集双向一致 + 成员集合一致 + 相对导入无悬空 + 声明面发散已登记）')
