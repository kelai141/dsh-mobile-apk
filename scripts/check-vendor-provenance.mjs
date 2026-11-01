#!/usr/bin/env node
// check-vendor-provenance.mjs —— vendored 目录的字节绑定门禁（issue #1285）。
//
// 为什么需要：
//   `vendor/dsh-plugin-subscriptions` 是第三方插件的 vendored 副本，本仓的立论是
//   「除 PROVENANCE.md『与上游的差异』表所列之外，其余文件与上游逐字节一致」。
//   但在本门禁之前**没有任何机制绑定字节**：目录里没有 lockfile，PROVENANCE 记的
//   tarball `shasum` / `sha512` / `gitHead` 全部指向**上游 tarball**——本仓无法离线验证
//   （没有网络、也没有那份 tarball），`grep -rn PROVENANCE scripts/` 只有散文注释。
//   于是手改一个 `lib/*.js` 照样构建出厂，供应链面只剩「版本字符串对」这一层。
//
// 本门禁绑的是什么：
//   `scripts/vendor-provenance.json` 逐文件记录**我们仓库里这一份**的 sha256 与字节数，
//   由 `--write` 从真实文件生成，由默认模式校验。它不试图验证上游 tarball（做不到），
//   而是把「我们出厂的字节」钉死：**改动 vendor 的任何一个字节都会让它红**，
//   而更新它必须显式跑 `--write`，那次改动因此在 diff 里可见、可审。
//
// 为什么不去校验 PROVENANCE 里的 sha512：
//   那条 sha512 是 npm tarball 的完整性摘要，与本目录的逐文件内容**没有可推导关系**
//   （解包 → 裁掉 .map/.d.ts → 删 5 个 Antigravity 模块 → 再有第 5、6 条的面部修改）。
//   拿它当判据只能二选一：要么联网取 tarball 重算（本仓 CI 不联网、也没有那份 tarball），
//   要么手抄一份摘要当常量——那是仪式，不是验证。所以本门禁只认「我们的字节」。
//
// 判据（输入全部是仓库真实文件，不读网络）：
//   ① 清单里的每个文件必须存在，且 sha256 + bytes 与清单逐字节相符；
//   ② 该目录下每个真实文件都必须在清单里（新增文件不能"没登记就出厂"）；
//   ③ 清单不得含已不存在的文件（删文件必须同步登记）；
//   ④ PROVENANCE.md 那行「**M B / N 文件**」自述必须与实测一致——它是人读的那一侧，
//      曾经漂移过（写 74 文件 / 1,467,750 B，实测 69 文件 / 1,388,498 B，因为 74 是
//      "143 − 1 − 68" 算出来的，漏减了文档自己删掉的 5 个 Antigravity 模块）。
//
// 不判什么（避免把注释当契约）：
//   PROVENANCE 的散文与注释不参与 ④ 之外的任何判断；改说明文字、加注解都不会让本门禁红。
//   只有那行**声称了仓库事实**的自述数字会被比对——因为它可核对，而解释不可核对。
//
// 用法：
//   node scripts/check-vendor-provenance.mjs             # 校验（默认；CI/发布链用）
//   node scripts/check-vendor-provenance.mjs --write     # 从真实文件重建清单（唯一更新途径）
//   node scripts/check-vendor-provenance.mjs --self-test # 判别力自证（1 正控 + 5 负控）
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const VENDOR = 'vendor/dsh-plugin-subscriptions'
const MANIFEST = 'scripts/vendor-provenance.json'
const PROVENANCE = VENDOR + '/PROVENANCE.md'

/**
 * 不参与字节绑定的文件（**只有我们自己写的这一份文档**）。
 *
 * PROVENANCE.md 是本仓自己的说明文档，不是上游分发的字节：它天天被改（每次追版/每次差异登记）。
 * 把它算进哈希，等于说「改一个字的说明也要重建清单」——那就把**注释当成了契约**，
 * 正是 issue #1285 要避免的另一半错误（手改哈希让 CI 绿 = 仪式）。
 *
 * 它的**数字**仍然受判据 ④ 约束（那行自述声称的是可核对的仓库事实），散文则不受约束。
 */
const NOT_BYTE_BOUND = new Set([PROVENANCE])

/**
 * 递归列出目录下的普通文件。
 * 符号链接与其他特殊文件**直接抛错**：不跟随（会绕过哈希）、不忽略（忽略就是留后门）。
 * @param {string} absDir 绝对目录。
 * @param {string} [relBase] 相对前缀。
 * @returns {string[]} 相对路径列表。
 */
export function listFiles(absDir, relBase = '') {
  const out = []
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = relBase === '' ? entry.name : relBase + '/' + entry.name
    const abs = join(absDir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(abs, rel))
    else if (entry.isFile()) out.push(rel)
    else throw new Error('vendor 目录里出现非普通文件（符号链接/设备）：' + rel + ' —— 不跟随、不忽略，必须人工确认')
  }
  return out
}

/**
 * 一个文件的 sha256（十六进制）。
 * @param {string} absPath 绝对路径。
 * @returns {string} 十六进制摘要。
 */
export function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

/**
 * 从真实目录生成清单对象。
 * @param {string} root 仓库根。
 * @returns {{vendorDir: string, files: Record<string, {sha256: string, bytes: number}>}} 清单
 */
export function buildManifest(root) {
  const absVendor = join(root, VENDOR)
  const files = {}
  for (const rel of listFiles(absVendor).sort()) {
    if (NOT_BYTE_BOUND.has(VENDOR + '/' + rel)) continue
    const abs = join(absVendor, rel)
    files[rel] = { sha256: sha256(abs), bytes: statSync(abs).size }
  }
  return { vendorDir: VENDOR, byteBound: 'PROVENANCE.md 除外（本仓自有文档，只有其自述数字受判据 ④ 约束）', files }
}

/**
 * 校验清单与真实树是否一致。
 * @param {string} root 仓库根。
 * @param {object} manifest 清单对象。
 * @returns {string[]} 问题列表；空数组表示通过。
 */
export function verifyManifest(root, manifest) {
  const problems = []
  const absVendor = join(root, VENDOR)
  if (!existsSync(absVendor)) return ['vendor 目录不存在：' + VENDOR]
  const actual = new Set(listFiles(absVendor).filter((rel) => !NOT_BYTE_BOUND.has(VENDOR + '/' + rel)))
  const recorded = new Set(Object.keys(manifest.files ?? {}))
  for (const rel of [...actual].sort()) {
    if (!recorded.has(rel)) problems.push('未登记的文件（新增文件必须跑 --write 登记）：' + VENDOR + '/' + rel)
  }
  for (const rel of [...recorded].sort()) {
    if (!actual.has(rel)) problems.push('清单登记了但文件已不存在（删除必须跑 --write 同步）：' + VENDOR + '/' + rel)
  }
  for (const rel of [...actual].sort()) {
    if (!recorded.has(rel)) continue
    const abs = join(absVendor, rel)
    const want = manifest.files[rel]
    const gotBytes = statSync(abs).size
    if (gotBytes !== want.bytes) {
      problems.push('字节数不符：' + VENDOR + '/' + rel + ' 清单 ' + String(want.bytes) + ' B，实测 ' + String(gotBytes) + ' B')
    }
    const gotSha = sha256(abs)
    if (gotSha !== want.sha256) {
      problems.push('sha256 不符：' + VENDOR + '/' + rel + ' 清单 ' + String(want.sha256).slice(0, 16) + '…，实测 ' + gotSha.slice(0, 16) + '…')
    }
  }
  return problems
}

/**
 * 读出 PROVENANCE.md 里「M B / N 文件」那句自述，与实测比对（判据 ④）。
 * 只在**显式标记的那一行**上比对：文档声称的是仓库事实，就必须能核对；散文不参与判断。
 * @param {string} root 仓库根。
 * @returns {string[]} 问题列表。
 */
export function verifySelfDescription(root) {
  const abs = join(root, PROVENANCE)
  if (!existsSync(abs)) return ['PROVENANCE 缺失：' + PROVENANCE]
  const text = readFileSync(abs, 'utf8')
  const m = /\*\*([\d,]+) B \/ (\d+) 文件\*\*/.exec(text)
  if (m === null) {
    return ['PROVENANCE 缺「**<字节> B / <N> 文件**」这句自述——门禁要靠它核对目录自述；'
      + '若确实要移除该句，请同步删除本判据并说明理由']
  }
  const claimedBytes = Number(m[1].replace(/,/g, ''))
  const claimedCount = Number(m[2])
  const absVendor = join(root, VENDOR)
  const files = listFiles(absVendor)
  const actualBytes = files.reduce((a, rel) => a + statSync(join(absVendor, rel)).size, 0)
  const problems = []
  // 自述口径与清单口径**必须一致**：都排除 NOT_BYTE_BOUND（自述说的是"目录里有几个文件"，
  // 而 PROVENANCE.md 自己就在这个目录里，所以两边都按同一口径数）。
  const counted = files.filter((rel) => !NOT_BYTE_BOUND.has(VENDOR + '/' + rel))
  const countedBytes = counted.reduce((a, rel) => a + statSync(join(absVendor, rel)).size, 0)
  if (claimedCount !== counted.length) {
    problems.push('PROVENANCE 自述文件数与实测不符：写着 ' + String(claimedCount) + ' 文件，实测 ' + String(counted.length)
      + ' 文件（自述是给人和门禁共用的仓库事实，改目录就要同步改这句）')
  }
  if (claimedBytes !== countedBytes) {
    problems.push('PROVENANCE 自述字节数与实测不符：写着 ' + String(claimedBytes) + ' B，实测 ' + String(countedBytes) + ' B')
  }
  return problems
}

/**
 * 把清单与自述同步到真实树（唯一的更新途径）。
 * @param {string} root 仓库根。
 * @returns {{count: number, bytes: number}} 统计
 */
export function writeManifest(root) {
  const manifest = buildManifest(root)
  writeFileSync(join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  const count = Object.keys(manifest.files).length
  const bytes = Object.values(manifest.files).reduce((a, f) => a + f.bytes, 0)
  const absProv = join(root, PROVENANCE)
  const text = readFileSync(absProv, 'utf8')
  const next = text.replace(/\*\*([\d,]+) B \/ (\d+) 文件\*\*/, '**' + bytes.toLocaleString('en-US') + ' B / ' + String(count) + ' 文件**')
  if (next !== text) writeFileSync(absProv, next)
  return { count, bytes }
}

/** 默认模式：校验真实树。 @returns {number} 退出码 */
function runVerify() {
  const absManifest = join(ROOT, MANIFEST)
  if (!existsSync(absManifest)) {
    console.error('VENDOR-PROVENANCE FAILED：清单缺失 ' + MANIFEST + '——先跑 --write 生成')
    return 1
  }
  const manifest = JSON.parse(readFileSync(absManifest, 'utf8'))
  const problems = [...verifyManifest(ROOT, manifest), ...verifySelfDescription(ROOT)]
  if (problems.length > 0) {
    console.error('FAIL  vendored 目录与清单不符（' + String(problems.length) + ' 项）')
    console.error('CHECK-VENDOR-PROVENANCE FAILED（' + String(problems.length) + ' 项）：')
    for (const p of problems) console.error('  - ' + p)
    console.error('  修法：确认改动是有意的之后跑 `node scripts/check-vendor-provenance.mjs --write`，')
    console.error('        并在 PROVENANCE.md「与上游的差异」表登记这次改动。')
    return 1
  }
  const count = Object.keys(manifest.files ?? {}).length
  const bytes = Object.values(manifest.files ?? {}).reduce((a, f) => a + f.bytes, 0)
  // 判据行形态按 check-gate-skips 的 VERDICT_RE：行首 PASS/FAIL，或 CHECK-<NAME> PASSED/FAILED。
  // 只写一个自由文案（如 "VENDOR-PROVENANCE PASSED…"）不被认作机器判据行，会被判「零判据结案」。
  console.log('PASS  vendored 目录 ' + String(count) + ' 文件 / ' + String(bytes) + ' B 逐文件 sha256 与自述均相符')
  console.log('CHECK-VENDOR-PROVENANCE PASSED')
  return 0
}

/** --self-test：在临时目录造一棵假 vendor 树，**不碰真实树**。 @returns {number} 退出码 */
function runSelfTest() {
  const cases = []
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-'))
    mkdirSync(join(dir, VENDOR), { recursive: true })
    writeFileSync(join(dir, VENDOR, 'a.js'), 'x')
    mkdirSync(join(dir, VENDOR, 'lib'), { recursive: true })
    writeFileSync(join(dir, VENDOR, 'lib', 'b.js'), 'yy')
    writeFileSync(join(dir, PROVENANCE), '# t\n\n| 体积 | **3 B / 2 文件** |\n')
    return dir
  }
  const check = (fn, dir) => { try { return { problems: fn(dir) } } catch (e) { return { error: String(e.message) } } }

  let d = mk()
  let m = buildManifest(d)
  cases.push({ name: '正控：未改动 → 通过', got: check((r) => [...verifyManifest(r, m), ...verifySelfDescription(r)], d), want: 'pass' })
  rmSync(d, { recursive: true, force: true })

  d = mk(); m = buildManifest(d)
  writeFileSync(join(d, VENDOR, 'lib', 'b.js'), 'yz')
  cases.push({ name: '负控①：改 vendor 一个字节 → 必须红', got: check((r) => verifyManifest(r, m), d), want: 'fail' })
  rmSync(d, { recursive: true, force: true })

  d = mk(); m = buildManifest(d)
  writeFileSync(join(d, PROVENANCE), '# t\n\n补充一句说明文字，不涉及数字。\n\n| 体积 | **3 B / 2 文件** |\n')
  cases.push({ name: '负控②：只改 PROVENANCE 散文、不动数字 → 不得红', got: check((r) => [...verifyManifest(r, m), ...verifySelfDescription(r)], d), want: 'pass' })
  rmSync(d, { recursive: true, force: true })

  d = mk(); m = buildManifest(d)
  writeFileSync(join(d, VENDOR, 'new.js'), 'z')
  cases.push({ name: '负控③：新增文件未登记 → 必须红', got: check((r) => verifyManifest(r, m), d), want: 'fail' })
  rmSync(d, { recursive: true, force: true })

  d = mk(); m = buildManifest(d)
  rmSync(join(d, VENDOR, 'a.js'))
  cases.push({ name: '负控④：删了文件清单没同步 → 必须红', got: check((r) => verifyManifest(r, m), d), want: 'fail' })
  rmSync(d, { recursive: true, force: true })

  d = mk(); m = buildManifest(d)
  writeFileSync(join(d, PROVENANCE), '# t\n\n| 体积 | **999 B / 2 文件** |\n')
  cases.push({ name: '负控⑤：只改自述数字、与实测不符 → 必须红', got: check((r) => verifySelfDescription(r), d), want: 'fail' })
  rmSync(d, { recursive: true, force: true })

  d = mk()
  try {
    writeFileSync(join(d, VENDOR, 'real.js'), 'r')
    symlinkSync('real.js', join(d, VENDOR, 'link.js'))
    cases.push({ name: '负控⑥：符号链接 → 必须抛（不跟随、不忽略）', got: check((r) => listFiles(join(r, VENDOR)), d), want: 'fail' })
  } catch (e) {
    console.log('SKIP  负控⑥：本机不允许建符号链接（' + String(e.message).slice(0, 40) + '）——Windows 需开发者模式或管理员权限')
  }
  rmSync(d, { recursive: true, force: true })

  let failed = 0
  for (const c of cases) {
    const ok = c.want === 'pass'
      ? (c.got.problems !== undefined && c.got.problems.length === 0)
      : (c.got.error !== undefined || (c.got.problems !== undefined && c.got.problems.length > 0))
    console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name)
    if (!ok) { failed += 1; console.log('      实得：' + JSON.stringify(c.got).slice(0, 300)) }
  }
  if (failed > 0) { console.error('VENDOR-PROVENANCE SELF-TEST FAILED（' + String(failed) + ' 项与预期不符）'); return 1 }
  console.log('VENDOR-PROVENANCE SELF-TEST PASSED（' + String(cases.length) + ' 项）')
  return 0
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) process.exit(runSelfTest())
else if (argv.includes('--write')) {
  const r = writeManifest(ROOT)
  console.log('VENDOR-PROVENANCE 清单已重建：' + MANIFEST + '（' + String(r.count) + ' 文件 / ' + String(r.bytes) + ' B），PROVENANCE 自述已同步')
  process.exit(0)
} else process.exit(runVerify())
