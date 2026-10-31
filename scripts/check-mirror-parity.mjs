#!/usr/bin/env node
// check-mirror-parity.mjs —— 镜像前缀表双真源一致性门禁。
//
// 为什么需要（本轮调查发现）：
//   同一份「GitHub 资产的镜像前缀表」存在**两份互不相干的副本**——
//     · 壳侧 `app/src/main/java/com/dsharnessmobile/shell/UpdateChecker.kt` 的 `MIRROR_PREFIXES`
//       （APK 下载与版本号确认链逐级回退用）；
//     · 下载站 `webpages/src/assets/release.js` 的 `MIRROR_TEMPLATES`（浏览器侧选线路用）。
//   两份不一致时**没有任何一层为不一致负责**：壳侧曾只有 3 条（缺 ghproxy.net），站点有 4 条。
//   后果是同一台设备在"应用内下载"与"浏览器下载"上走不同的线路集合，而新增/下线一条镜像
//   需要人记得同时改两处——正是「能力在、路径不同」这类幽灵缺陷的温床。
//
// 判据：两侧的前缀集合必须**逐条相同**（顺序也相同：顺序即回退优先级，顺序错就是行为错）。
//
// 用法：
//   node scripts/check-mirror-parity.mjs             # 两仓布局自适应（apk 仓 / 协调仓根）
//   node scripts/check-mirror-parity.mjs --self-test # 判别力自证（正例 / 反例 / 锚点缺失）
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APK_ROOT = resolve(HERE, '..')

/**
 * 剥掉注释（行注释 + 块注释），保留换行与字符偏移。
 *
 * issue #1054 ①：两个解析器都在**原始文本**上跑正则，于是被注释掉的前缀条目仍会被算进
 * 集合——把壳侧第 4 条前缀注释掉，门禁照样打印「共 4 条」通过，而运行期的活清单只剩 3 条。
 * 这正是本门禁立项要拦的「壳侧 3 / 站点 4」形态。
 *
 * 为什么不用正则一把梭：// 会出现在字符串里（"https://github.com/" 就含 //），
 * 必须先按引号状态走一遍状态机，只在「代码态」里认注释起始。
 *
 * @param {string} text 源码
 * @returns {string} 与原文**等长**的掩码文本（注释内容抹成空格，换行保留）
 */
export function stripComments(text) {
  // 引号字符用常量表示：源码里直接写裸引号会让本文件自身难以维护（踩过）。
  const DQ = String.fromCharCode(34)
  const SQ = String.fromCharCode(39)
  const out = text.split('')
  const n = text.length
  const blank = (j) => { if (j < n && text[j] !== '\n' && text[j] !== '\r') out[j] = ' ' }
  let i = 0
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      let j = i
      while (j < n && text[j] !== '\n') { blank(j); j += 1 }
      i = j
      continue
    }
    if (c === '/' && next === '*') {
      let j = i
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) { blank(j); j += 1 }
      blank(j)
      blank(j + 1)
      i = j + 2
      continue
    }
    // 字符串/字符字面量整体跳过（内部可能含 // 或 /*）
    if (c === DQ || c === SQ || c.charCodeAt(0) === 96) {
      let j = i + 1
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j += 1
        j += 1
      }
      i = j + 1
      continue
    }
    i += 1
  }
  return out.join('')
}
/** 两个布局下的相对坐标（apk 仓自包含 / 协调仓带子目录）。 */
function locate(rel) {
  const candidates = [join(APK_ROOT, rel), join(APK_ROOT, 'dsh-mobile-apk', rel)]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('找不到镜像表源文件：' + candidates.join(' | '))
}

/** 壳侧面：`internal val MIRROR_PREFIXES: List<String> = listOf( "https://github.com/", ... )` */
export function parseShellMirrors(text) {
  // issue #1054 ①：先剥注释，否则被注释掉的条目仍被算进集合（假绿）。
  const m = /MIRROR_PREFIXES[^=]*=\s*listOf\(([\s\S]*?)\)/.exec(stripComments(text))
  if (m === null) return null
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

/** 站点面：`MIRROR_TEMPLATES = [ { id: 'github', ..., prefix: 'https://github.com/', ... }, ... ]` */
export function parseSiteMirrors(text) {
  // issue #1054 ①：站点侧同理（注释掉的 prefix 不算在册）。
  const m = /MIRROR_TEMPLATES\s*=\s*\[([\s\S]*?)\n\]/.exec(stripComments(text))
  if (m === null) return null
  return [...m[1].matchAll(/prefix:\s*'([^']+)'/g)].map((x) => x[1])
}

export function compare(shell, site) {
  // 顺序即回退优先级，所以这里**不排序**：位置对调算差异。
// issue #1054：两侧同时解析为空时 `0 === 0 && [].every(...)` 为 true ⇒ vacuous 通过。
// 空集合不表示「一致」，表示解析器失配（前缀表被改名/改形）。任一侧为空必须判红。
if (shell.length === 0 || site.length === 0) {
  console.error('MIRROR-PARITY FAILED：前缀表解析为空（壳侧 ' + shell.length + ' 条，站点 ' + site.length + ' 条）——')
  console.error('  空集合不等于「一致」：多半是锚点被改名或正则失配。')
  process.exit(1)
}
  const ok = shell.length === site.length && shell.every((p, i) => p === site[i])
  const missingInShell = site.filter((p) => !shell.includes(p))
  const extraInShell = shell.filter((p) => !site.includes(p))
  const orderDiffers = ok === false && missingInShell.length === 0 && extraInShell.length === 0
  return { ok, missingInShell, extraInShell, orderDiffers }
}

function selfTest() {
  const NL = String.fromCharCode(10)
  let failed = 0
  const cases = [
    ['正例：两侧同 4 条同序', ['a/', 'b/', 'c/', 'd/'], ['a/', 'b/', 'c/', 'd/'], true],
    ['反例：壳侧少一条（本轮缺陷原形：3 条 vs 4 条）', ['a/', 'b/', 'c/'], ['a/', 'b/', 'c/', 'd/'], false],
    ['反例：壳侧多一条', ['a/', 'b/', 'c/', 'd/'], ['a/', 'b/', 'c/'], false],
    ['反例：条数相同但顺序不同（回退优先级错）', ['b/', 'a/'], ['a/', 'b/'], false],
  ]
  for (const [name, shell, site, expect] of cases) {
    const r = compare(shell, site)
    if (r.ok !== expect) {
      failed += 1
      console.error('SELF-TEST FAIL：' + name + ' 期望 ' + expect + ' 实得 ' + r.ok)
    }
  }
  // 顺序不同必须被单独识别出来（否则报错信息会把「顺序错」说成「缺条」）。
  const orderCase = compare(['b/', 'a/'], ['a/', 'b/'])
  if (!orderCase.orderDiffers) {
    failed += 1
    console.error('SELF-TEST FAIL：顺序差异未被单独识别')
  }
  // issue #1054 ①：被注释掉的前缀条目**不得**算在册（两侧各一条负控）。
  const shellCommented = [
    'internal val MIRROR_PREFIXES: List<String> = listOf(',
    '  "https://github.com/",',
    '  // "https://ghproxy.net/https://github.com/",',
    '  "https://ghfast.top/https://github.com/",',
    ')',
  ].join(NL)
  const shellCommentedParsed = parseShellMirrors(shellCommented)
  if (shellCommentedParsed === null || shellCommentedParsed.length !== 2) {
    failed += 1
    console.error('SELF-TEST FAIL：#1054 壳侧被注释掉的前缀必须被剥掉（期望 2 条，实得 ' + (shellCommentedParsed === null ? 'null' : shellCommentedParsed.length) + '）')
  }
  const siteCommented = [
    "export const MIRROR_TEMPLATES = [",
    "  { id: 'github', prefix: 'https://github.com/' },",
    "  // { id: 'ghproxy.net', prefix: 'https://ghproxy.net/https://github.com/' },",
    "]",
  ].join(NL)
  const siteCommentedParsed = parseSiteMirrors(siteCommented)
  if (siteCommentedParsed === null || siteCommentedParsed.length !== 1) {
    failed += 1
    console.error('SELF-TEST FAIL：#1054 站点侧被注释掉的前缀必须被剥掉（期望 1 条，实得 ' + (siteCommentedParsed === null ? 'null' : siteCommentedParsed.length) + '）')
  }
  // 放行例：字符串里的 // 不得被当成注释起点（URL 自带 //，剥错会把整条前缀吃掉）。
  const urlSample = 'internal val MIRROR_PREFIXES: List<String> = listOf(' + NL + '  "https://github.com/",' + NL + ')'
  const urlParsed = parseShellMirrors(urlSample)
  if (urlParsed === null || urlParsed.length !== 1 || urlParsed[0] !== 'https://github.com/') {
    failed += 1
    console.error('SELF-TEST FAIL：#1054 字符串内的 // 不得被当成注释（URL 被吃掉了）')
  }
  // 解析器判别力
  const shellSample = 'internal val MIRROR_PREFIXES: List<String> = listOf(\n  "https://github.com/",\n  "https://gh-proxy.com/https://github.com/",\n)'
  const siteSample = "export const MIRROR_TEMPLATES = [\n  { id: 'github', prefix: 'https://github.com/' },\n  { id: 'gh-proxy', prefix: 'https://gh-proxy.com/https://github.com/' },\n]"
  const s = parseShellMirrors(shellSample)
  const w = parseSiteMirrors(siteSample)
  if (s === null || s.length !== 2) { failed += 1; console.error('SELF-TEST FAIL：壳侧解析器') }
  if (w === null || w.length !== 2) { failed += 1; console.error('SELF-TEST FAIL：站点解析器') }
  // fail-closed：锚点被改名必须返回 null 而不是空数组（空数组会被当成"两边都空"而误判通过）。
  if (parseShellMirrors('val X = listOf("a")') !== null) { failed += 1; console.error('SELF-TEST FAIL：壳侧锚点缺失未 fail-closed') }
  if (parseSiteMirrors('export const X = []') !== null) { failed += 1; console.error('SELF-TEST FAIL：站点锚点缺失未 fail-closed') }
  if (failed > 0) {
    console.error('CHECK-MIRROR-PARITY SELF-TEST FAILED（' + failed + ' 例）')
    process.exit(1)
  }
  console.log('CHECK-MIRROR-PARITY SELF-TEST PASSED（' + (cases.length + 9) + ' 例：正/反/顺序/锚点缺失）')
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const shellPath = locate(join('app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'UpdateChecker.kt'))
  const sitePath = locate(join('webpages', 'src', 'assets', 'release.js'))
  const shell = parseShellMirrors(readFileSync(shellPath, 'utf8'))
  const site = parseSiteMirrors(readFileSync(sitePath, 'utf8'))
  if (shell === null) {
    console.error('CHECK-MIRROR-PARITY FAILED：壳侧 MIRROR_PREFIXES 未解析到（锚点被改名/改形？）\n  ' + shellPath)
    process.exit(1)
  }
  if (site === null) {
    console.error('CHECK-MIRROR-PARITY FAILED：站点 MIRROR_TEMPLATES 未解析到（锚点被改名/改形？）\n  ' + sitePath)
    process.exit(1)
  }
  const r = compare(shell, site)
  if (!r.ok) {
    console.error('CHECK-MIRROR-PARITY FAILED：镜像前缀表两侧不一致——')
    console.error('  壳侧 ' + shellPath)
    console.error('  站点 ' + sitePath)
    if (r.missingInShell.length > 0) console.error('  壳侧缺少（站点有、壳侧无）：' + r.missingInShell.join(', '))
    if (r.extraInShell.length > 0) console.error('  壳侧多出（站点无、壳侧有）：' + r.extraInShell.join(', '))
    if (r.orderDiffers) {
      console.error('  条数相同但顺序不同：顺序即回退优先级，必须逐位相同。')
      console.error('    壳侧顺序：' + shell.join(' -> '))
      console.error('    站点顺序：' + site.join(' -> '))
    }
    console.error('  修法：两侧同批改。壳侧是 App 内下载与版本号确认的权威顺序，站点是浏览器侧选路顺序，')
    console.error('  任一侧单独演进都会让「应用内下载」和「浏览器下载」走不同线路集合。')
    process.exit(1)
  }
  console.log('CHECK-MIRROR-PARITY PASSED（两侧镜像前缀逐条同序，共 ' + shell.length + ' 条）')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}