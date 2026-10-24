#!/usr/bin/env node
// check-i18n-parity.mjs — 中英文案一致性门禁（0.15.0）。
//
// 背景：AGENTS.md 要求「新增或改写自定义界面必须中英双语文案」，但此前**没有任何机器校验**：
//  - app/src/main/res/values/strings.xml 与 values-en/strings.xml 的键集合是否一致，只靠人工比对；
//    漏一条英文，英文界面就退回中文（Android 的资源回退是静默的，构建、单测、CI 全绿）；
//  - dsh-client-ui-responsive 里的 tr('中文', 'English') 若漏写第二个参数或写成空串，
//    英文界面会直接显示中文，同样静默。
//
// 本门禁把这两件事变成可判红的静态检查，不依赖 Android 构建（纯文本解析）：
//  A. 资源层：values/ 与 values-en/ 的 string 键集合必须一致（按 translatable 过滤）；
//  B. 代码层：dsh-client-ui-responsive/src 下每个 tr(...) 必须带两个非空字符串参数。
//
// 用法：node scripts/check-i18n-parity.mjs [--root <仓库根>] [--self-test]
// 退出码：0 = 通过；1 = 命中不一致；2 = 根定位失败。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const SELF_TEST = argv.includes('--self-test')

/** 解析 Android strings XML，返回 name -> 文本（跳过 translatable="false"）。 */
export function parseStringsXml(text) {
  const out = new Map()
  const re = /<string\b([^>]*)>([\s\S]*?)<\/string>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1]
    if (/\btranslatable\s*=\s*"false"/.test(attrs)) continue
    const name = /\bname\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
    if (name !== undefined) out.set(name, m[2])
  }
  return out
}

/** 比较两个键集合，返回 {missing, extra}。 */
export function compareKeys(zh, en) {
  const zhKeys = new Set(zh.keys())
  const enKeys = new Set(en.keys())
  return {
    missing: [...zhKeys].filter((k) => !enKeys.has(k)).sort(),
    extra: [...enKeys].filter((k) => !zhKeys.has(k)).sort(),
  }
}

/**
 * 把源码里的「字符串内容」与「注释」抹成空格（保留换行，长度不变）。
 *
 * 为什么需要它：直接在原文上找 `tr(` 会被两类东西骗——
 *  1. 注释里的示例 `// tr('中文')` 会被当成真实调用（review 指出的第 1 条）；
 *  2. 字符串/模板串里的逗号会被当成参数分隔符。
 * 抹平后长度与行号都不变，结构扫描（括号、逗号）可以放心在掩码文本上做，
 * 取值时再回原文按同一偏移切片。
 *
 * 状态机覆盖模板串的 `${...}` 插值：进入插值后按代码处理，插值里还能再出现
 * 字符串与模板串（review 指出的第 2 条：嵌套模板串必须按栈处理，不能在内层反引号处
 * 提前闭合外层）。
 */
export function maskSource(text) {
  const out = text.split('')
  const n = text.length
  const blank = (j) => { if (j < n && text[j] !== '\n' && text[j] !== '\r') out[j] = ' ' }
  const stack = [{ kind: 'code', depth: 0 }]
  let i = 0
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = text[i]
    if (top.kind === 'code' || top.kind === 'expression') {
      if (c === '/' && text[i + 1] === '/') {
        let j = i
        while (j < n && text[j] !== '\n') { blank(j); j++ }
        i = j
        continue
      }
      if (c === '/' && text[i + 1] === '*') {
        let j = i
        blank(j); blank(j + 1); j += 2
        while (j < n && !(text[j] === '*' && text[j + 1] === '/')) { blank(j); j++ }
        if (j < n) { blank(j); blank(j + 1); j += 2 }
        i = j
        continue
      }
      if (c === "'" || c === '"') {
        const quote = c
        blank(i); i++
        while (i < n) {
          const d = text[i]
          if (d === '\\') { blank(i); blank(i + 1); i += 2; continue }
          if (d === quote) { blank(i); i++; break }
          blank(i); i++
        }
        continue
      }
      if (c === '`') {
        blank(i); i++
        stack.push({ kind: 'template' })
        continue
      }
      if (top.kind === 'expression') {
        if (c === '{') top.depth++
        else if (c === '}') {
          if (top.depth === 0) { stack.pop(); i++; continue }
          top.depth--
        }
      }
      i++
      continue
    }
    // 模板串内容：整体抹平，只有 ${ 会切回代码态
    if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
    if (c === '`') { blank(i); i++; stack.pop(); continue }
    if (c === '$' && text[i + 1] === '{') {
      blank(i); blank(i + 1); i += 2
      stack.push({ kind: 'expression', depth: 0 })
      continue
    }
    blank(i); i++
  }
  return out.join('')
}

/**
 * 扫描一段 TS/TSX，返回「tr 调用缺英文」的位置。
 *
 * 不能用正则直接匹配 `tr('中文')`：真实调用经常跨行、参数里还有拼接与嵌套调用
 * （例如 tr('检查 ' + count('checked') + ' 项', count('checked') + ' checked')），
 * 惰性正则会从第一个引号一路吃到后面的引号，把合法双语文案误判成单参数。
 * 这里先抹掉字符串与注释，再在掩码文本上做括号配对 + 顶层逗号切分。
 */
export function scanTrCalls(text) {
  const masked = maskSource(text)
  const hits = []
  for (let i = 0; i < masked.length; i++) {
    if (masked.slice(i, i + 3) !== 'tr(') continue
    const prev = i === 0 ? '' : masked[i - 1]
    if (/[A-Za-z0-9_$.]/.test(prev)) continue
    const open = i + 2
    let depth = 0
    let end = -1
    const commas = []
    for (let j = open + 1; j < masked.length; j++) {
      const c = masked[j]
      if (c === '(' || c === '[' || c === '{') { depth++; continue }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) { end = j; break }
        depth--
        continue
      }
      if (c === ',' && depth === 0) commas.push(j)
    }
    if (end < 0) continue
    const line = text.slice(0, i).split('\n').length
    const zhText = text.slice(open + 1, commas.length > 0 ? commas[0] : end).trim().slice(0, 24)
    if (commas.length === 0) hits.push({ line, zhText, reason: 'single-arg' })
    else {
      const second = text.slice(commas[0] + 1, end).trim()
      if (/^(['"])\s*\1$/.test(second) || second === '') hits.push({ line, zhText, reason: 'empty-en' })
    }
  }
  return hits
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function selfTest() {
  const failures = []
  const zh = parseStringsXml('<resources><string name="a">甲</string><string name="b" translatable="false">B</string></resources>')
  const en = parseStringsXml('<resources><string name="a">A</string></resources>')
  const diff = compareKeys(zh, en)
  if (diff.missing.length !== 0) failures.push('可翻译键应视为成对（translatable=false 必须被忽略）')
  if (zh.size !== 1) failures.push('translatable=false 的键不应进入集合')
  const gap = compareKeys(new Map([['x', '甲'], ['y', '乙']]), new Map([['x', 'X']]))
  if (gap.missing.join(',') !== 'y') failures.push('缺英文的键必须被检出')
  const extra = compareKeys(new Map([['x', '甲']]), new Map([['x', 'X'], ['z', 'Z']]))
  if (extra.extra.join(',') !== 'z') failures.push('多出的英文键必须被检出')
  const single = scanTrCalls("tr('中文')\ntr('中文', 'English')")
  if (single.length !== 1 || single[0].reason !== 'single-arg') failures.push('单参数 tr 必须被检出')
  const empty = scanTrCalls("tr('中文', '')")
  if (empty.length !== 1 || empty[0].reason !== 'empty-en') failures.push('空英文 tr 必须被检出')
  const clean = scanTrCalls("tr('中文', 'English')")
  if (clean.length !== 0) failures.push('双语文案不得误报')
  // review 第 1 条：注释里的示例不得被当成真实调用
  if (scanTrCalls("// tr('中文')\nconst a = 1").length !== 0) failures.push('行注释里的 tr 示例不得误报')
  if (scanTrCalls("/* tr('中文') */ const a = 1").length !== 0) failures.push('块注释里的 tr 示例不得误报')
  // review 第 2 条：嵌套模板串的第二参数不得被切错
  const nested = scanTrCalls('tr("中文", `a ${cond ? "x" : "y"} c`)')
  if (nested.length !== 0) failures.push('嵌套模板串的合法双语文案不得误报')
  // 抹平后仍要能抓到真实缺英文
  if (scanTrCalls("const s = 'tr(\'假\')'; tr('真缺英文')").length !== 1) failures.push('字符串里的伪调用不得干扰真实检出')
  if (failures.length > 0) {
    for (const f of failures) console.error('  FAIL ' + f)
    console.error('CHECK-I18N-PARITY SELF-TEST FAILED（' + failures.length + ' 项）')
    return 1
  }
  console.log('CHECK-I18N-PARITY SELF-TEST PASSED（10 条判据：可翻译成对 / 忽略不可翻译 / 缺键检出 / 多键检出 / 单参检出 / 空英文检出 / 双语文案无误报 / 行注释不误报 / 块注释不误报 / 嵌套模板串不误报 / 字符串伪调用不干扰）')
  return 0
}

function main() {
  if (SELF_TEST) return selfTest()

  const rootArg = argOf('root', null)
  const root = rootArg !== null ? rootArg : ROOT
  const resDir = join(root, 'app/src/main/res')
  if (!existsSync(resDir)) {
    console.error('CHECK-I18N-PARITY FAILED：找不到 ' + resDir + '（用 --root 指定仓库根）')
    return 2
  }

  const problems = []

  // A. 资源层：values/ 与 values-en/ 键集合一致
  const zhDir = join(resDir, 'values')
  const enDir = join(resDir, 'values-en')
  const zhFiles = existsSync(zhDir) ? readdirSync(zhDir).filter((f) => f.endsWith('.xml')) : []
  for (const file of zhFiles) {
    const zhPath = join(zhDir, file)
    const enPath = join(enDir, file)
    const zh = parseStringsXml(readFileSync(zhPath, 'utf8'))
    if (zh.size === 0) continue
    if (!existsSync(enPath)) {
      problems.push('资源缺英文文件：values/' + file + '（含 ' + zh.size + ' 条可翻译文案）')
      continue
    }
    const diff = compareKeys(zh, parseStringsXml(readFileSync(enPath, 'utf8')))
    for (const k of diff.missing) problems.push('资源缺英文：values-en/' + file + ' 缺 ' + k)
    for (const k of diff.extra) problems.push('资源多英文：values-en/' + file + ' 有 ' + k + '，values/ 没有')
  }

  // B. 代码层：tr() 必须带两个非空参数
  const uiDir = join(root, 'dsh-client-ui-responsive/src')
  for (const file of walk(uiDir)) {
    const text = readFileSync(file, 'utf8')
    for (const hit of scanTrCalls(text)) {
      const rel = file.slice(root.length + 1)
      problems.push('文案缺英文：' + rel + ':' + hit.line + '（' + hit.reason + '：' + hit.zhText.slice(0, 24) + '）')
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.log('  - ' + p)
    console.error('CHECK-I18N-PARITY FAILED（' + problems.length + ' 项）')
    return 1
  }
  console.log('CHECK-I18N-PARITY PASSED（资源键集合成对；tr 调用均为双语文案）')
  return 0
}

process.exit(main())
