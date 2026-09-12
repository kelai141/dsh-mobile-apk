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
const base = argOf('root', null) ?? resolve('dsh-mobile-apk/app/src')
if (!base || !existsSync(base)) { console.error('CHECK-KOTLIN-COMMENTS FAILED：根目录不存在（用 --root 指定）'); process.exit(2) }

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
  console.log((pass ? 'KOTLIN-COMMENTS SELF-TEST PASSED' : 'KOTLIN-COMMENTS SELF-TEST FAILED')
    + '（真嵌套命中 ' + hits + ' / 期望 1；误报 ' + falsePositives + ' / 期望 0）')
  process.exit(pass ? 0 : 1)
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
walk(base)
console.log('扫描 .kt 文件: ' + files + '（根: ' + relative(ROOT, base).replace(/\\/g, '/') + '）')
if (failures.length > 0) {
  console.error('CHECK-KOTLIN-COMMENTS FAILED（' + failures.length + ' 处嵌套块注释）：')
  for (const f of failures.slice(0, 10)) console.error('  - ' + f)
  process.exit(1)
}
console.log('CHECK-KOTLIN-COMMENTS PASSED（无嵌套块注释）')
