#!/usr/bin/env node
// check-inject-completeness.mjs — 注入面成员完整性门禁（0.0.13 → 0.13.8-b P0 修复；坑 63 的活体复现防线）。
//
// 背景（dev-incoming 实测 2026-09-12）：inject-all.py 原先只替换「基座里已存在」的成员，包内**新增文件**
// 被静默丢弃（包名已见即不触发整包追加），而 tar 里的 lib/index.js 仍 import 那些文件 → 设备侧
// ERR_MODULE_NOT_FOUND → 引擎启动即死。修法在注入链（补缺循环），本门禁是**产物级**对账：
//
// 断言（逐装配 profile × 逐注入包）：
//   A. 成员集合：tar 内 <profile>/node_modules/[@dsh-android/]<pkg> 的 package.json + lib/**（.map 除外）
//      必须与源包逐字一致（缺一个即 FAIL；多出源包没有的 lib 文件也 FAIL——那是残留/幽灵面）。
//   B. 相对导入可解析：tar 内该包每个 lib/**.js 里的 './x.js' / '../y.js' import 都必须能在同一包内找到
//      （直击 ERR_MODULE_NOT_FOUND 类缺陷）。
//   C. 装配 profile（inject-all 的 PROFILES：web + headless）都要满足 A/B——单 profile 通过即拒。
//
// 用法：node scripts/check-inject-completeness.mjs <injected.tar.xz> [--profiles web,headless]
// 退出码：0 = 通过；1 = 成员缺失/导入悬空/残留；2 = 用法或 tar 不可读。
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
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
const dirs = manifest.dirs.concat(manifest.externals).map((d) => join(ROOT, d))

/** 源包成员（相对包根）：package.json + lib/**（.map 除外）。 */
const sourceMembers = (dir) => {
  const out = { name: null, members: new Set() }
  try { out.name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name } catch { return out }
  out.members.add('package.json')
  const lib = join(dir, 'lib')
  if (!existsSync(lib)) return out
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      const rel = prefix ? prefix + '/' + name : name
      if (statSync(full).isDirectory()) walk(full, rel)
      else if (!name.endsWith('.map')) out.members.add('lib/' + rel)
    }
  }
  walk(lib, '')
  return out
}

let listing = ''
try { listing = execFileSync('tar', ['-tf', tar], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }) } catch (e) {
  console.error('CHECK-INJECT-COMPLETENESS FAILED：tar 不可读（' + e.message + '）')
  process.exit(2)
}
const entries = new Set(listing.split('\n').map((l) => l.trim()).filter(Boolean))
console.log('tar 条目: ' + entries.size + '；装配 profile: ' + PROFILES.join(', '))

// 单次解压（重要：逐成员 tar -xO 会对 170MB xz 重解压 N 次，实测 >10min 超时）——
// 只抽出需要的包 lib 树 + package.json，一次 -xf 完成，后续分析在本地文件上做。
const scratch = mkdtempSync(join(tmpdir(), 'inj-complete-'))
const extractArgs = []
for (const profile of PROFILES) {
  for (const dir of dirs) {
    const src = sourceMembers(dir)
    if (!src.name) continue
    const base = 'home/.dsh/profiles/' + profile + '/node_modules/' + src.name
    extractArgs.push(base + '/package.json', base + '/lib')
  }
}
try {
  execFileSync('tar', ['-xf', tar, '-C', scratch, '--', ...extractArgs], { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
} catch { /* 缺席成员按缺失处理（后续断言会报），不在此处中断 */ }

let checkedPkgs = 0
for (const profile of PROFILES) {
  for (const dir of dirs) {
    const src = sourceMembers(dir)
    if (!src.name) { check('源包可读: ' + dir, false); continue }
    const pkgBase = 'home/.dsh/profiles/' + profile + '/node_modules/' + src.name
    const present = new Set()
    for (const e of entries) {
      if (!e.startsWith(pkgBase + '/')) continue
      const rel = e.slice(pkgBase.length + 1)
      if (rel.endsWith('.map') || rel.endsWith('/')) continue   // 目录条目（lib/、lib/types/）不是成员
      if (rel === 'package.json' || rel.startsWith('lib/')) present.add(rel)
    }
    if (present.size === 0) { check(profile + ' 注入包在场: ' + src.name, false, 'tar 内无该包成员'); continue }
    checkedPkgs += 1
    const missing = [...src.members].filter((m) => !present.has(m)).sort()
    const extra = [...present].filter((m) => !src.members.has(m)).sort()
    check(profile + ' 成员集合一致: ' + src.name + '（' + src.members.size + ' 项）', missing.length === 0 && extra.length === 0,
      (missing.length ? '缺 ' + missing.length + ' 项: [' + missing.slice(0, 5).join(', ') + ']' : '')
      + (extra.length ? (missing.length ? '；' : '') + '多 ' + extra.length + ' 项: [' + extra.slice(0, 5).join(', ') + ']' : ''))
    // B. 相对导入可解析（直击 ERR_MODULE_NOT_FOUND）
    // 只对「源包确实有、但 tar 里没有」的导入目标判红（那才是注入丢件）；源包自身就不带的
    // 目标（如 ExportResultDialog.js -> ./ExportResultDialog.module.css，源码无该 css）记为 WARN。
    const danglingImports = []
    const sourceMissing = new Set()
    for (const member of present) {
      if (!member.startsWith('lib/') || !member.endsWith('.js')) continue
      let text = ''
      try { text = readFileSync(join(scratch, pkgBase, member), 'utf8') } catch { continue }
      for (const m of text.matchAll(/(?:from|import|require)\(?\s*['\"](\.[^'\"]+)['\"]/g)) {
        const spec = m[1]
        const resolved = posix.normalize(posix.join(posix.dirname(member), spec))
        if (present.has(resolved) || entries.has(pkgBase + '/' + resolved)) continue
        if (src.members.has(resolved)) danglingImports.push(member + ' -> ' + spec)
        else sourceMissing.add(member + ' -> ' + spec)
      }
    }
    check(profile + ' 相对导入可解析: ' + src.name, danglingImports.length === 0,
      '悬空 ' + danglingImports.length + ' 条（源包有、tar 缺）: [' + danglingImports.slice(0, 3).join(', ') + ']')
    if (sourceMissing.size > 0) {
      console.log('WARN  ' + profile + ' ' + src.name + '：' + sourceMissing.size
        + ' 条导入目标源包自身也不含（源码侧现象，非注入缺陷）: ' + [...sourceMissing].slice(0, 2).join('; '))
    }
  }
}
rmSync(scratch, { recursive: true, force: true })
check('至少核对到一个注入包', checkedPkgs > 0, 'checked=' + checkedPkgs)

if (failures.length > 0) {
  console.error('CHECK-INJECT-COMPLETENESS FAILED（' + failures.length + ' 项）：' + failures.slice(0, 6).join('；'))
  process.exit(1)
}
console.log('CHECK-INJECT-COMPLETENESS PASSED（' + checkedPkgs + ' 包 × ' + PROFILES.length + ' profile：成员集合一致 + 相对导入无悬空）')
