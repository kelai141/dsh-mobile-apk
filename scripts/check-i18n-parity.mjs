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
//  A. 资源层：values/ 与 values-en/ 的 string 键集合必须一致（按 translatable 过滤），**双向遍历**；
//  B. 代码层：dsh-client-ui-responsive/src 下每个 tr(...) 必须带两个非空字符串参数。
//
// 用法：node scripts/check-i18n-parity.mjs [--root <仓库根>] [--self-test] [--require]
// 退出码：0 = 通过；1 = 命中不一致；2 = 根定位失败（显式 --root 给了但目录不存在）。
//
// ── 双仓同源（2026-10-27，issue #156 / PR #157）──────────────────────────────
// **权威源在 apk 仓**（本文件的判据输入 app/src/main/res 与 dsh-client-ui-responsive
// 都在 apk 仓布局里）。协调仓没有 Android 树，但它的门禁聚合清单 check-release-gates.mjs
// 是双仓逐字节镜像的，因此也必须声明本门禁——两边要么都声明要么都不声明，不能单边演进。
//
// 于是本文件同时存在于两仓，并已登记进 scripts/check-patch-mirror.mjs 的 MIRROR_TOP：
// **两仓必须逐字节一致**，任一侧单边改判据都会被镜像门禁拦下。
//
// 在协调仓（无 app/src/main/res）下，本门禁走**具名 SKIP 并计入 SKIP 计数**（照
// check-engine-heap-floor.mjs 的范式），而不是静默跳过、也不是判红：
//   SKIP(#1)  本仓无 Android 树（app/src/main/res 缺席；本门禁由 apk 仓 CI 执行）
// 传 --require（构建/发布链严格档）时缺输入即判红，不得以 SKIP 结案。
// apk 仓布局下照常真跑判据，不因这个分支变成永远 SKIP——负控见 PR #157 描述。
//
// ── 解析器的六处可绕/误判（2026-10-30，issue #1024）──────────────────────────
// 两条判据都建立在手写解析上，此前实测有 6 处：4 处假绿（本该判红却是绿的）、2 处假红。
// 每处都在 --self-test 里有一条**钉死的夹具**，改回去就当场红：
//   A 假绿：XML 注释里的 <string> 被当成已交付翻译（parseStringsXml 不剥注释）
//   B 假绿：values-en/ 下没有同名孪生文件的 xml 从不被打开（只按 zh 侧枚举文件）
//   C 假红：<string-array> 吞掉它后面的每一个键（<string\b 命中 <string-array）
//   D 假红：自闭合 <string name="k"/> 被当成缺失（正则要求 >…</string>）
//   E 假绿：空模板串骗过非空判据（空值正则只认单双引号）
//   F 假绿：尾随注释让空串变「非空」（带 $ 锚的空值正则落空）
// 修法：A/C/D 换成真正的标签解析（先剥注释，再逐个 <string> 标签取值，自闭合与成对两种形态都认，
// <string-array>/<plurals> 整块不参与键集合）；B 换成 zh/en 两侧文件并集的遍历；
// E/F 把「空」的判据改成**剥掉行尾/块注释与空白之后**再判（含模板字符串）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const SELF_TEST = argv.includes('--self-test')
/** --require：输入缺席不得以 SKIP 结案（构建/发布链严格档，与 check-engine-heap-floor 同口径）。 */
const REQUIRE = argv.includes('--require')
/** SKIP 计数器：check-gate-skips.mjs 要求任何 SKIP 输出带 SKIP(#n) 计数，否则算静默跳过。 */
let skipped = 0
const skip = (msg) => { skipped += 1; console.log('SKIP(#' + skipped + ')  ' + msg) }

/**
 * 剥掉 XML 注释，字符数与换行位置不变（注释内容换成空格）。
 *
 * 为什么必须剥（issue #1024 A）：被注释掉的 <string> 在原文上会被标签正则命中，于是
 * **被注掉的翻译**成了「英文已交付」的证据——英文界面照样退回中文，而门禁判绿。
 * 本仓 values/strings.xml 有 70+ 行注释，只要有人临时注掉一条翻译就会中。
 */
export function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * 把不承载「可翻译 string 键」的整块元素抹成空白（保留换行）。
 *
 * issue #1024 C：<string-array> 里的内容此前会吞掉它后面的每一个键——旧正则的 <string\b
 * 命中 <string-array，随后惰性 [\s\S]*? 一路吃到**下一个** </string>，于是数组名被记成一个键、
 * 紧跟其后的真实键被吞掉：一个合法文件被报成「缺 arr + 多 k」两条假红。
 * <plurals> 同型（同属「键不在 values-en/values 里成对」的元素，但条目不按 string 计数），
 * 整块排除更稳。
 */
export function stripNonStringBlocks(text) {
  return text.replace(/<(string-array|plurals)\b[\s\S]*?<\/\1\s*>/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * 解析 Android strings XML，返回 name -> 文本（跳过 translatable="false"）。
 *
 * 形态覆盖（issue #1024 C/D）：
 *   <string name="k">文本</string>      成对
 *   <string name="k"/>                  自闭合（aapt2 接受；旧实现把它当成「缺失」= 假红）
 *   <string name="k" translatable="false">…</string>   不进键集合
 * <string-array>/<plurals> 整块先剥掉（C）。
 */
export function parseStringsXml(text) {
  const out = new Map()
  const clean = stripNonStringBlocks(stripXmlComments(text))
  const re = /<string\b([^>]*?)(\/?)>/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const attrs = m[1]
    const selfClosing = m[2] === '/'
    const name = /\bname\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
    if (selfClosing) {
      if (name !== undefined && !isUntranslatable(attrs)) out.set(name, '')
      continue
    }
    const bodyStart = re.lastIndex
    const closeRe = /<\/string\s*>/g
    closeRe.lastIndex = bodyStart
    const close = closeRe.exec(clean)
    const body = close === null ? clean.slice(bodyStart) : clean.slice(bodyStart, close.index)
    if (close !== null) re.lastIndex = close.index + close[0].length
    if (name !== undefined && !isUntranslatable(attrs)) out.set(name, body)
  }
  return out
}

/** translatable="false" 的元素不进键集合（它们本来就只有中文一份）。 */
const isUntranslatable = (attrs) => /\btranslatable\s*=\s*"false"/.test(attrs)

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
 * 资源层双向核对（纯函数，供 --self-test 直接喂合成文件表）。
 *
 * issue #1024 B：旧实现只遍历 values/ 一侧的文件，values-en/ 下**没有同名孪生文件**的 xml
 * 从不被打开——里面哪怕全是只存在于英文的键，门禁也判绿。改成两侧文件并集遍历：
 * 每个文件分别回答「zh 有 / en 有」，缺文件、多文件、缺键、多键四条判据都建立在并集上。
 *
 * @param {{file: string, zh: string|null, en: string|null}[]} entries
 *   zh/en 为该文件在两侧的原文（null = 该侧没有这个文件）。
 * @returns {string[]} problems（空 = 成对）。
 */
export function diffResources(entries) {
  const problems = []
  for (const { file, zh, en } of entries) {
    const zhMap = zh === null ? new Map() : parseStringsXml(zh)
    const enMap = en === null ? new Map() : parseStringsXml(en)
    if (zh === null) {
      if (enMap.size > 0) problems.push('资源多英文文件：values-en/' + file + '（values/ 无同名文件，含 ' + enMap.size + ' 条英文）')
      continue
    }
    if (zhMap.size === 0 && enMap.size === 0) continue
    if (en === null) {
      if (zhMap.size > 0) problems.push('资源缺英文文件：values/' + file + '（含 ' + zhMap.size + ' 条可翻译文案）')
      continue
    }
    const diff = compareKeys(zhMap, enMap)
    for (const k of diff.missing) problems.push('资源缺英文：values-en/' + file + ' 缺 ' + k)
    for (const k of diff.extra) problems.push('资源多英文：values-en/' + file + ' 有 ' + k + '，values/ 没有')
  }
  return problems
}

/**
 * 把源码里的「字符串内容」与「注释」抹成空格（保留换行，长度不变）。
 *
 * 为什么需要它：直接在原文上找 tr( 会被两类东西骗——
 *  1. 注释里的示例会被当成真实调用（review 指出的第 1 条）；
 *  2. 字符串/模板串里的逗号会被当成参数分隔符。
 * 抹平后长度与行号都不变，结构扫描（括号、逗号）可以放心在掩码文本上做，
 * 取值时再回原文按同一偏移切片。
 *
 * 状态机覆盖模板串的 ${...} 插值：进入插值后按代码处理，插值里还能再出现
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
 * 一个 tr() 参数「是不是空的」——判据只认**剥掉注释与空白之后**的内容。
 *
 * issue #1024 E/F 的两处假绿都出在这里：
 *   E 空模板串：旧正则只认单双引号，反引号直接落空；
 *   F 尾随注释：旧实现先 trim 再带 $ 锚判空，注释让整串不再是「引号包空」，
 *     于是空英文被当成「有英文」放行——正是「留个 TODO 就把中文发给英文用户」的形态。
 * 修法：先剥块注释与行注释，再判「空 / 只剩定界符的字符串或模板串（含内部纯空白）」。
 *
 * 已知静态边界（写在这里以免被当成新缺陷）：三元表达式的运行时空分支
 * （例如第二参数为 cond ? 'EN' : ''）静态不可达——参数源码非空即放行。
 */
export function isBlankArg(raw) {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
  const t = stripped.trim()
  if (t === '') return true
  // 只剩定界符：'' / "" / 空模板串（含内部纯空白）
  return /^(['"`])\s*\1$/.test(t)
}

/**
 * 扫描一段 TS/TSX，返回「tr 调用缺英文」的位置。
 *
 * 不能用正则直接匹配单参数调用：真实调用经常跨行、参数里还有拼接与嵌套调用
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
      const secondRaw = text.slice(commas[0] + 1, end)
      if (isBlankArg(secondRaw)) hits.push({ line, zhText, reason: 'empty-en' })
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

// ── --self-test：issue #1024 的 6 组夹具 + 4 组对照逐条钉住 ─────────────────────
//
// 资源面（A–D）用**合成树 + --root 跑真门禁**：文件枚举（B 的错处就在枚举里）不是纯函数，
// 只测 parseStringsXml 守不住它。代码面（E/F/对照）走真门禁的同一入口。
// false-green 组必须判红、false-red 组必须判绿、4 组对照维持现状。
async function selfTest() {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { execFileSync } = await import('node:child_process')
  const selfPath = fileURLToPath(import.meta.url)
  const trees = []
  const mkTree = (tag, spec) => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-' + tag + '-'))
    trees.push(dir)
    const zhDir = join(dir, 'app', 'src', 'main', 'res', 'values')
    const enDir = join(dir, 'app', 'src', 'main', 'res', 'values-en')
    mkdirSync(zhDir, { recursive: true })
    mkdirSync(enDir, { recursive: true })
    if (spec.zh !== null && spec.zh !== undefined) writeFileSync(join(zhDir, 'strings.xml'), spec.zh)
    if (spec.en !== null && spec.en !== undefined) writeFileSync(join(enDir, 'strings.xml'), spec.en)
    if (spec.extraEn) for (const [name, body] of Object.entries(spec.extraEn)) writeFileSync(join(enDir, name), body)
    if (spec.ts !== null && spec.ts !== undefined) {
      const uiDir = join(dir, 'dsh-client-ui-responsive', 'src')
      mkdirSync(uiDir, { recursive: true })
      writeFileSync(join(uiDir, 'a.ts'), spec.ts)
    }
    return dir
  }
  const runGate = (args) => {
    try {
      const out = execFileSync(process.execPath, [selfPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }

  const checks = []
  const t = (label, ok, detail) => { checks.push({ label, ok, detail }) }
  const ZH = '<resources><string name="k">中文</string></resources>'
  const EN = '<resources><string name="k">EN</string></resources>'
  const Q = String.fromCharCode(96)
  const lastLine = (out) => out.trim().split('\n').slice(-1)[0]

  // A（假绿）：注释里的 <string> 不算已交付翻译 => 必须判红
  const rA = runGate(['--root', mkTree('A', { zh: ZH, en: '<resources><!-- <string name="k">EN</string> --></resources>' })])
  t('A 注释里的 <string> 必须判红（false-green）', rA.code === 1 && rA.out.includes('资源缺英文'), 'exit=' + rA.code + ' | ' + rA.out.trim().split('\n')[0])

  // B（假绿）：values-en 独有文件必须被打开 => 必须判红
  const rB = runGate(['--root', mkTree('B', { zh: ZH, en: EN, extraEn: { 'extra.xml': '<resources><string name="b">B</string></resources>' } })])
  t('B values-en 独有文件必须判红（false-green）', rB.code === 1 && rB.out.includes('资源多英文文件'), 'exit=' + rB.code + ' | ' + rB.out.trim().split('\n')[0])

  // C（假红）：string-array 不得吞掉后面的键 => 必须判绿
  const rC = runGate(['--root', mkTree('C', {
    zh: '<resources>\n  <string-array name="arr"><item>a</item></string-array>\n  <string name="k">中文</string>\n</resources>',
    en: EN,
  })])
  t('C string-array 不得吞掉后面的键，必须判绿（false-red）', rC.code === 0 && rC.out.includes('CHECK-I18N-PARITY PASSED'), 'exit=' + rC.code + ' | ' + lastLine(rC.out))

  // D（假红）：自闭合 <string/> 是合法交付形态 => 必须判绿
  const rD = runGate(['--root', mkTree('D', { zh: ZH, en: '<resources><string name="k"/></resources>' })])
  t('D 自闭合 <string name="k"/> 必须判绿（false-red）', rD.code === 0 && rD.out.includes('CHECK-I18N-PARITY PASSED'), 'exit=' + rD.code + ' | ' + lastLine(rD.out))

  // E（假绿）：空模板串必须判红
  const rE = runGate(['--root', mkTree('E', { zh: ZH, en: EN, ts: 'export const x = tr(' + Q + '中文' + Q + ', ' + Q + Q + ')\n' })])
  t('E 空模板串作第二参数必须判红（false-green）', rE.code === 1 && rE.out.includes('empty-en'), 'exit=' + rE.code + ' | ' + rE.out.trim().split('\n')[0])

  // F（假绿）：尾随注释不得让空串变非空
  const rF = runGate(['--root', mkTree('F', { zh: ZH, en: EN, ts: "export const x = tr('中文', '' /* TODO: translate */)\n" })])
  t('F 尾随块注释的空串必须判红（false-green）', rF.code === 1 && rF.out.includes('empty-en'), 'exit=' + rF.code + ' | ' + rF.out.trim().split('\n')[0])

  // 对照 1–4：判据不是整体失效（issue #1024「对照组」四条维持现状）
  const ctrl1 = scanTrCalls("tr('中文','')")
  t('对照1 空英文串仍判红', ctrl1.length === 1 && ctrl1[0].reason === 'empty-en', JSON.stringify(ctrl1))
  const ctrl2 = scanTrCalls("tr('中文','   ')")
  t('对照2 纯空白英文仍判红', ctrl2.length === 1 && ctrl2[0].reason === 'empty-en', JSON.stringify(ctrl2))
  const ctrl3 = scanTrCalls('tr(' + Q + '中文 ' + '${n}' + Q + ')')
  t('对照3 单参数模板串仍判红（single-arg）', ctrl3.length === 1 && ctrl3[0].reason === 'single-arg', JSON.stringify(ctrl3))
  const ctrl4 = scanTrCalls("cond ? tr('中文','') : tr('中文','English')")
  t('对照4 三元分支里的缺英文仍判红（恰 1 处）', ctrl4.length === 1 && ctrl4[0].reason === 'empty-en', JSON.stringify(ctrl4))

  // 纯函数面：把 A/B/C/D/E/F 判据的边界也钉住（合成树之外的形态）
  t('parseStringsXml 认自闭合且忽略 translatable=false',
    parseStringsXml('<resources><string name="a"/><string name="b" translatable="false">B</string></resources>').size === 1)
  t('parseStringsXml 不把 <string-array> 记成键',
    !parseStringsXml('<resources><string-array name="arr"><item>a</item></string-array></resources>').has('arr'))
  t('parseStringsXml 剥注释后不认被注掉的键',
    parseStringsXml('<resources><!-- <string name="k">EN</string> --></resources>').size === 0)
  t('diffResources 双向：en 独有文件判红',
    diffResources([{ file: 'strings.xml', zh: ZH, en: EN }, { file: 'extra.xml', zh: null, en: '<resources><string name="b">B</string></resources>' }])
      .some((p) => p.includes('资源多英文文件')))
  t('diffResources 双向：zh 有、en 无该文件判红',
    diffResources([{ file: 'strings.xml', zh: ZH, en: null }]).some((p) => p.includes('资源缺英文文件')))
  t('diffResources 双向：两侧成对判绿', diffResources([{ file: 'strings.xml', zh: ZH, en: EN }]).length === 0)
  t('isBlankArg 认注释包裹的空串与空模板串',
    isBlankArg("'' /* TODO */") && isBlankArg(Q + Q) && isBlankArg("'' // TODO"))
  t('isBlankArg 不把有内容的英文判空',
    !isBlankArg("'English'") && !isBlankArg(Q + 'a ${x}' + Q))

  for (const dir of trees) rmSync(dir, { recursive: true, force: true })
  const failures = checks.filter((c) => !c.ok)
  for (const c of checks) if (!c.ok) console.error('  FAIL ' + c.label + (c.detail === undefined ? '' : '  -> ' + c.detail))
  if (failures.length > 0) {
    console.error('CHECK-I18N-PARITY SELF-TEST FAILED（' + failures.length + '/' + checks.length + ' 项）')
    return 1
  }
  console.log('CHECK-I18N-PARITY SELF-TEST PASSED（' + checks.length + ' 项：issue #1024 六组夹具 A–F 逐个双向 + 四组对照维持现状 + 解析器纯函数边界）')
  return 0
}

function main() {
  const rootArg = argOf('root', null)
  const root = rootArg !== null ? rootArg : ROOT
  const resDir = join(root, 'app/src/main/res')
  if (!existsSync(resDir)) {
    // 显式给了 --root 却找不到 => 调用方指错了路，必须判红（不得被下面的 SKIP 分支吞掉）。
    if (rootArg !== null) {
      console.error('CHECK-I18N-PARITY FAILED：找不到 ' + resDir + '（用 --root 指定仓库根）')
      return 2
    }
    // 没给 --root 且本仓无 Android 树 => 协调仓布局。具名 SKIP 并计数，不静默、不判红。
    if (REQUIRE) {
      console.error('CHECK-I18N-PARITY FAILED（--require 档不得 SKIP：本仓无 ' + resDir + '）')
      return 1
    }
    skip('本仓无 Android 树（' + 'app/src/main/res' + ' 缺席；本门禁由 apk 仓 CI 执行）')
    console.log('CHECK-I18N-PARITY PASSED（SKIP=' + skipped + '；协调仓布局，判据不在本仓输入面）')
    return 0
  }

  const problems = []

  // A. 资源层：values/ 与 values-en/ 键集合一致（**双向遍历**两侧文件并集）
  const zhDir = join(resDir, 'values')
  const enDir = join(resDir, 'values-en')
  const xmlOf = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.xml')).sort() : [])
  const files = [...new Set([...xmlOf(zhDir), ...xmlOf(enDir)])].sort()
  const entries = files.map((file) => {
    const zhPath = join(zhDir, file)
    const enPath = join(enDir, file)
    return {
      file,
      zh: existsSync(zhPath) ? readFileSync(zhPath, 'utf8') : null,
      en: existsSync(enPath) ? readFileSync(enPath, 'utf8') : null,
    }
  })
  for (const p of diffResources(entries)) problems.push(p)

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
  console.log('CHECK-I18N-PARITY PASSED（资源键集合成对（双向 ' + files.length + ' 个 xml）；tr 调用均为双语文案）')
  return 0
}

if (SELF_TEST) process.exit(await selfTest())
process.exit(main())
