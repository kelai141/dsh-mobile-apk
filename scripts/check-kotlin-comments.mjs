#!/usr/bin/env node
// check-kotlin-comments.mjs — Kotlin 块注释嵌套静态检查（0.13.8-b，dev-shell 建议）。
//
// 背景：Kotlin 的块注释**可嵌套**（`/* /* */ */`）——在块注释里再写 `/*`（典型：KDoc 里写 glob
// `node_modules/**`、或正文里写 `image/*`）会开启一层嵌套注释，注释边界被推进 → 吞掉后续代码/编译报错。
// 本门禁按 Kotlin 词法扫描：跳过字符串（含 `"""` 原始串）与字符字面量，只对真实注释位置计数，
// 块注释内再遇 `/*` 即 FAIL（带行号与片段）。
//
// 用法：node scripts/check-kotlin-comments.mjs [--root <含 .kt 的目录>]
// 退出码：0 = 通过；1 = 命中嵌套块注释；2 = 根定位失败。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const resolve = (rel) => {
  const cands = rel.startsWith('dsh-mobile-apk/') ? [rel, rel.slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
// issue #1199：默认根**不止** app/src。头注释承诺的两条检查（嵌套块注释、备份副本扫描）
// 此前在 plugins/ 下完全失效 —— 扫描器本身是好的（--root plugins 能报出嵌套命中），
// 坏的是默认作用域：plugins/*/src 下的 Kotlin 注释纪律无人守。
//
// 现在默认扫**全部**含 Kotlin 源码的根：壳侧 app/src + 各插件 plugins/<name>/src。
// 显式传 --root 时仍只扫那一个（保持既有用法，测试与临时排查依赖它）。
const DEFAULT_ROOTS = (() => {
  const roots = ['app/src']
  try {
    for (const name of readdirSync(resolve('plugins')).sort()) {
      const src = join('plugins', name, 'src')
      if (existsSync(resolve(src))) roots.push(src.replace(/\\/g, '/'))
    }
  } catch { /* 没有 plugins 目录就只扫 app/src */ }
  return roots
})()
const explicitRoot = argOf('root', null)
const bases = explicitRoot ? [explicitRoot] : DEFAULT_ROOTS.map((r) => resolve(r))
for (const b of bases) {
  if (!b || !existsSync(b)) { console.error('CHECK-KOTLIN-COMMENTS FAILED：根目录不存在（' + b + '，用 --root 指定）'); process.exit(2) }
}

/** 扫描一段 Kotlin 源码，返回嵌套块注释命中（文件内 0-based 行号 + 片段）。 */
export function scanNested(text) {
  const hits = []
  let i = 0
  let depth = 0
  let line = 1
  const lineOf = (pos) => text.slice(0, pos).split('\n').length
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    const three = text.slice(i, i + 3)
    if (depth === 0) {
      if (two === '//') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue }
      if (three === '"""') {
        const end = text.indexOf('"""', i + 3)
        i = end < 0 ? text.length : end + 3
        continue
      }
      if (text[i] === '"') {
        i += 1
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1 }
        i += 1
        continue
      }
      if (text[i] === "'") {
        i += 1
        while (i < text.length && text[i] !== "'") { if (text[i] === '\\') i += 1; i += 1 }
        i += 1
        continue
      }
      if (two === '/*') { depth = 1; i += 2; continue }
      if (two === '*/') { i += 2; continue }
      i += 1
      continue
    }
    // 注释内：\n*/` 降一层；再遇 /* 记一条嵌套并加深
    if (two === '*/') { depth -= 1; i += 2; continue }
    if (two === '/*') {
      hits.push({ line: lineOf(i), text: text.slice(i, i + 90).split('\n')[0].trim() })
      depth += 1
      i += 2
      continue
    }
    i += 1
  }
  return hits
}

/**
 * 审查 DOC-3：源文件备份副本扫描（`.bak` / `.orig` / 尾部 `~`）。
 *
 * `SnapshotTransaction.kt.bak` 曾与在用文件**逐字节相同**地躺在仓里（621 行）：既不参与编译、
 * 也不被任何 `*.kt` 扫描覆盖 —— 任何人工 grep 或 `*.kt*` 通配扫描都会命中这份旧实现。
 * 备份只该存在于 git 历史里。
 */
export const BACKUP_RE = /(\.bak|\.orig|~)$/
export function findBackups(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) findBackups(full, out)
    else if (BACKUP_RE.test(name)) out.push(relative(ROOT, full).replace(/\\/g, '/'))
  }
  return out
}

if (argv.includes('--self-test')) {
  // 两向自检：真嵌套必须命中；字符串里的 image/*、行注释里的 glob、普通 KDoc 不得误报。
  const NL = String.fromCharCode(10)
  const TQ = String.fromCharCode(34, 34, 34)
  const bad = '/**' + NL + ' * glob: node_modules/** 会被 Kotlin 当成嵌套块注释' + NL + ' */' + NL + 'val x = 1' + NL
  const okString = 'val accept = "image/*"' + NL + 'val m = MimeTypeMap.get("application/*")' + NL
  const okLine = '// 说明：image/* 与 node_modules/** 只是注释文本（行注释不嵌套）' + NL + 'val y = 2' + NL
  const okRaw = 'val q = ' + TQ + NL + '/* not a comment inside raw string */' + NL + TQ + NL
  const hits = scanNested(bad).length
  const falsePositives = scanNested(okString).length + scanNested(okLine).length + scanNested(okRaw).length
  const pass = hits === 1 && falsePositives === 0
  // 备份扫描的判别力自证（DOC-3）：必须命中 .bak/.orig/尾部 ~，且不得误伤正常文件名。
  const backupHits = ['SnapshotTransaction.kt.bak', 'X.orig', 'Y.kt~'].filter((n) => BACKUP_RE.test(n)).length
  const backupMisses = ['SnapshotTransaction.kt', 'README.md', 'a.bak.kt'].filter((n) => BACKUP_RE.test(n)).length
  // issue #1199：默认作用域必须覆盖多个根（不能只有 app/src）。
  // 断言的是**机制**：DEFAULT_ROOTS 里既要有壳侧根，也要覆盖到每个含 src/ 的插件。
  // 不写死个数（插件增删会漂），而是与磁盘上的实际目录对账。
  const pluginsWithSrc = (() => {
    try {
      return readdirSync(resolve('plugins')).filter((n) => existsSync(resolve('plugins', n, 'src'))).length
    } catch { return 0 }
  })()
  const scopeOk = DEFAULT_ROOTS.includes('app/src') && DEFAULT_ROOTS.length === 1 + pluginsWithSrc
  const allPass = pass && backupHits === 3 && backupMisses === 0 && scopeOk
  console.log((allPass ? 'KOTLIN-COMMENTS SELF-TEST PASSED' : 'KOTLIN-COMMENTS SELF-TEST FAILED')
    + '（真嵌套命中 ' + hits + ' / 期望 1；误报 ' + falsePositives + ' / 期望 0；'
    + '备份命中 ' + backupHits + ' / 期望 3；备份误报 ' + backupMisses + ' / 期望 0；'
    + '默认根 ' + DEFAULT_ROOTS.length + ' / 期望 ' + (1 + pluginsWithSrc) + '）')
  process.exit(allPass ? 0 : 1)
}

let files = 0
const failures = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.kt')) {
      files += 1
      for (const hit of scanNested(readFileSync(full, 'utf8'))) {
        failures.push(relative(ROOT, full).replace(/\\/g, '/') + ':' + hit.line + ': 块注释内嵌套 /* -> ' + hit.text)
      }
    }
  }
}
for (const b of bases) walk(b)
const backups = bases.flatMap((b) => findBackups(b))

// issue #1199：**零个 .kt 文件不得判 PASSED**。
//
// 计数此前只打印不断言：目录被清空 / 移动 / 拼错时，门禁以「扫描 .kt 文件: 0」结案并报 PASSED。
// 与 #1024 同族 —— 空集合让「没有嵌套块注释」恒真。
// 判据取「> 0」而非某个大数：文件数随重构变化，写死会变成新的漂移源。
if (files === 0) {
  console.error('CHECK-KOTLIN-COMMENTS FAILED：扫描到 0 个 .kt 文件（根: '
    + bases.map((b) => relative(ROOT, b).replace(/\\/g, '/')).join(', ') + '）')
  console.error('  空集合不得判绿：「没有嵌套块注释」在零文件时恒真，这不是通过。')
  console.error('  常见原因：根目录拼错 / 目录被移动或清空 / --root 指到了非 Kotlin 树。')
  process.exit(1)
}
if (backups.length > 0) {
  console.error('CHECK-KOTLIN-COMMENTS FAILED（发现 ' + backups.length + ' 个源文件备份副本，请在 git 历史里留档后删除）：')
  for (const b of backups.slice(0, 10)) console.error('  - ' + b)
  process.exit(1)
}
console.log('扫描 .kt 文件: ' + files + '（根: ' + bases.map((b) => relative(ROOT, b).replace(/\\/g, '/')).join(' + ') + '；备份副本 0）')
if (failures.length > 0) {
  console.error('CHECK-KOTLIN-COMMENTS FAILED（' + failures.length + ' 处嵌套块注释）：')
  for (const f of failures.slice(0, 10)) console.error('  - ' + f)
  process.exit(1)
}
console.log('CHECK-KOTLIN-COMMENTS PASSED（无嵌套块注释）')