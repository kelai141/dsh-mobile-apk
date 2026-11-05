#!/usr/bin/env node
// check-bounded-io.mjs — 子进程无界读门禁（0.13.8 #173；0.13.8-b 批 B2 FX-208.3 / FX-208.E1 扩容）
//
// 缺陷：先 readText 后 waitFor 使超时失效；redirectErrorStream 下先 waitFor 后读会死锁；
// 锁内挂起升级为全局冻结。铁律：子进程输出一律走 ProcIo.readBounded。
//
// 两处历史缺陷（本脚本同时修掉，锚点见 0.13.8 迭代文档 §3.4）：
//   1) 正则只覆盖 proc.inputStream.bufferedReader().use { it.readText() } 一种形态，
//      漏掉无 .use 的裸读（LogCollector.kt:123）——46 个 Kotlin 文件零命中 exit 0 = 假绿；
//   2) ROOT 固定为「本脚本上两级」，在协调仓根跑时指向协调仓（无 Kotlin 源）→ SKIP exit 0，
//      即「本地默认入口空转」（E-17）。现改为探测「含 app/src/main 的树」，找不到即失败。
//
// ── 逐行匹配的第三处缺陷（2026-10-30，issue #1018）────────────────────────────
// 判据此前是**逐行**匹配：每个正则只拿到一行，于是「先取 bufferedReader()、下一行再 readText()」
// 的两行写法零命中——只要把一次调用拆成两行就绕过了整条铁律。第二条正则虽然写了跨行通配，
// 传进去的也是单行字符串，跨行永远匹配不到。
// 修法：把「去掉注释与字符串之后的全文」当判据输入，正则跨行匹配，**行号按命中起点换算**；
// 同时把注释与字符串里提到的写法排除在外（真实树 LogCollector.kt:990-993 的注释就点名了
// 这个缺陷，旧实现靠逐行 + 从未命中躲过去，跨行匹配后不剥注释会立刻假红）。
//
// 用法：node scripts/check-bounded-io.mjs [--root <apk 仓根或协调仓根>] [--self-test]
//   --root  仅用于反向验证（合成夹具树）；缺省自动探测。也可用环境变量 DSH_APK_ROOT。
// 退出码：0 = 通过；1 = 命中拒绝（构建链/CI 以此拒打包/拒合并）或树定位失败。
//
// 豁免通道只有一个且必须写明理由：在命中行或上一行加注释 bounded-io-exempt: <理由>。
// 放宽正则而漏报比误报更危险——任何新增豁免都要在 PR 里给出理由。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/**
 * 把 Kotlin 源码里的注释与字符串字面量抹成空格，**保留换行与字符偏移**。
 *
 * 为什么必须抹（issue #1018 的防误报面）：
 *   - 注释里可以完整写出缺陷形态。真实树 LogCollector.kt:990-993 的注释就写着
 *     「原先裸 bufferedReader() 后直接 readText()（无 .use）」，逐行版本因为从未跨行命中而侥幸
 *     没假红；改成跨行匹配后，不剥注释就会把这段**说明**判成违规。
 *   - 字符串字面量里提到同样写法（错误提示文案、文档串）同理。
 *
 * 保留偏移是硬约束：命中位置要换算回行号（L.kt:NN），掩码不能改变文本长度。
 * 状态机覆盖：行注释、嵌套块注释（Kotlin 允许嵌套）、单/双引号串、三引号原始串、
 * 以及字符串模板 ${...}（模板内部按代码处理，里面还能再出现字符串）。
 */
export function maskKotlin(text) {
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
        // Kotlin 块注释可嵌套：用深度计数，否则内层收尾符会提前结束、把后面代码当注释抹掉。
        let j = i
        let depth = 1
        blank(j); blank(j + 1); j += 2
        while (j < n && depth > 0) {
          if (text[j] === '/' && text[j + 1] === '*') { blank(j); blank(j + 1); j += 2; depth++; continue }
          if (text[j] === '*' && text[j + 1] === '/') { blank(j); blank(j + 1); j += 2; depth--; continue }
          blank(j); j++
        }
        i = j
        continue
      }
      if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
        blank(i); blank(i + 1); blank(i + 2); i += 3
        while (i < n) {
          if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') { blank(i); blank(i + 1); blank(i + 2); i += 3; break }
          blank(i); i++
        }
        continue
      }
      if (c === "'" || c === '"') {
        blank(i); i++
        stack.push({ kind: 'string', quote: c })
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
    // 字符串内容
    if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
    if (c === top.quote) { blank(i); i++; stack.pop(); continue }
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
 * 判据表（跨行必需，故全部对**全文**跑；命中后用起点偏移换算行号）。
 *
 * 正则里允许空白跨行（bufferedReader() 与 readText() 分两行写），但要求两者在
 * **同一接收者调用链**上：中间只放行空白与点号。跨语句的两行写法由下面
 * scanSplitReaderCalls 单独捕（见 --self-test 的「两行 / 三行」用例）。
 */
const PATTERNS = [
  [/\.bufferedReader\(\)\s*\.\s*readText\(\)/, '裸 readText（无界，超时失效；未走 ProcIo.readBounded）'],
  [/BufferedReader\s*\(\s*InputStreamReader\s*\([\s\S]*?\)\s*\)\s*\.\s*readText\(\)/, 'BufferedReader(InputStreamReader(..)).readText()（无界）'],
  [/\b(proc|process|p)\.inputStream\.bufferedReader\(\)[\s\S]{0,80}?\.use\s*\{[\s\S]{0,80}?it\.readText\(\)/, '裸 readText（无界，超时失效）'],
  [/\b(proc|process|p)\.inputStream\.readBytes\(\)/, '裸 readBytes（无界）'],
  [/\b(proc|process|p)\.errorStream\.bufferedReader\(\)[\s\S]{0,80}?\.use\s*\{[\s\S]{0,80}?it\.readText\(\)/, '裸 stderr readText（无界）'],
]

/**
 * 「取 reader」与「用 reader 读」被拆到不同语句的形态（issue #1018 的主形态）。
 *
 * 一次调用被拆成「先 val reader = ....bufferedReader()、再 reader.readText()」，
 * 上面那张表的正则（要求同一调用链）看不到它——旧实现逐行匹配时更是零命中。
 * 判据分两段，都建立在同一份掩码文本上：
 *   ① 收集 bufferedReader() 的赋值目标（val/var x = <...>.bufferedReader()）；
 *   ② 找这些目标名上的 .readText() 调用；
 * 行号取 ② 的行（它才是「真的去读了」的那一行），描述里带上 ① 的行。
 */
export function scanSplitReaderCalls(masked, lineOf) {
  const hits = []
  const assign = /\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][A-Za-z0-9_.<>,? ]*)?=\s*[^\n=]*?\.bufferedReader\(\s*\)/g
  const readers = []
  let m
  while ((m = assign.exec(masked)) !== null) readers.push({ name: m[1], line: lineOf(m.index) })
  if (readers.length === 0) return hits
  for (const r of readers) {
    const useRe = new RegExp('\\b' + r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\.\\s*readText\\s*\\(', 'g')
    let u
    while ((u = useRe.exec(masked)) !== null) {
      hits.push({ line: lineOf(u.index), from: r.line, why: '裸 readText（无界，超时失效；未走 ProcIo.readBounded）' })
    }
  }
  return hits
}

const EXEMPT_MARKER = /bounded-io-exempt:\s*\S/

/** 行号换算器：给定偏移返回 1 基行号（偏移来自掩码文本，与原文等长）。 */
export function lineIndexFactory(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * 单文件扫描（纯函数，供 --self-test 直接喂源码串）。
 *
 * @param {string} raw 源码原文
 * @returns {{line: number, from?: number, why: string}[]} 命中（空 = 合规）
 */
export function scanSource(raw) {
  const masked = maskKotlin(raw)
  const lineOf = lineIndexFactory(raw)
  const rawLines = raw.split(/\r?\n/)
  const hits = []
  const seen = new Set()
  const exemptAt = (line) => EXEMPT_MARKER.test(rawLines[line - 1] ?? '') || EXEMPT_MARKER.test(rawLines[line - 2] ?? '')
  for (const [re, why] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m
    while ((m = g.exec(masked)) !== null) {
      if (m[0].length === 0) { g.lastIndex += 1; continue }
      const line = lineOf(m.index)
      const key = line + '|' + why
      if (seen.has(key)) continue
      seen.add(key)
      if (exemptAt(line)) continue
      hits.push({ line, why })
    }
  }
  for (const h of scanSplitReaderCalls(masked, lineOf)) {
    const key = h.line + '|' + h.why
    if (seen.has(key)) continue
    seen.add(key)
    if (exemptAt(h.line)) continue
    hits.push(h)
  }
  return hits.sort((a, b) => a.line - b.line)
}

// ── --self-test：判别力自证 ───────────────────────────────────────────────────
//
// 这条门禁的三处历史缺陷都值得钉住：
//   ① 旧正则漏掉「无 .use 的裸读」=> Kotlin 文件零命中 exit 0 的假绿；
//   ② ROOT 固定导致在协调仓根跑时 SKIP exit 0 的空转；
//   ③ 逐行匹配 => 两行写法零命中（issue #1018）。
// 自证造合成树（--root）把每条形态与每个历史分支都打一遍。
if (process.argv.includes('--self-test')) {
  const { tmpdir } = await import('node:os')

  const selfPath = fileURLToPath(import.meta.url)
  const runGate = (treeArgs) => {
    try {
      const out = execFileSync(process.execPath, [selfPath, ...treeArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }
  const buildTree = (tag, sources) => {
    const dir = mkdtempSync(join(tmpdir(), 'boundedio-' + tag + '-'))
    const pkg = join(dir, 'app', 'src', 'main', 'java', 'com', 'x')
    mkdirSync(pkg, { recursive: true })
    for (const [name, body] of Object.entries(sources)) writeFileSync(join(pkg, name), body)
    return dir
  }

  const OK = buildTree('ok', { 'Fine.kt': 'class Fine { fun f() = ProcIo.readBounded(p) }\n' })
  const bare = buildTree('bare', { 'Bad.kt': 'val s = stream.bufferedReader().readText()\n' })
  const use = buildTree('use', { 'Bad.kt': 'val s = proc.inputStream.bufferedReader().use { it.readText() }\n' })
  const exempt = buildTree('exempt', { 'Ok.kt': '// bounded-io-exempt: 合成夹具，自证豁免通道\nval s = stream.bufferedReader().readText()\n' })
  const procio = buildTree('procio', { 'ProcIo.kt': 'val s = stream.bufferedReader().readText()\n' })
  const noTree = mkdtempSync(join(tmpdir(), 'boundedio-empty-'))
  const twoLine = buildTree('twoline', { 'L.kt': 'fun f(p: Process) {\n  val reader = p.inputStream.bufferedReader()\n  val out = reader.readText()\n  println(out)\n}\n' })
  const threeLine = buildTree('threeline', { 'L.kt': 'fun f(p: Process) {\n  val reader = p.inputStream.bufferedReader()\n  check(reader.ready())\n  val out = reader.readText()\n}\n' })
  const threeLineComment = buildTree('threeline-comment', { 'L.kt': 'fun f(p: Process) {\n  val reader = p.inputStream.bufferedReader()\n  // 这里是说明文字，不是代码\n  val out = reader.readText()\n}\n' })
  const commentOnly = buildTree('comment', { 'LogCollector.kt': 'fun f(p: Process) {\n  // FX-211.3：原先裸 bufferedReader() 后直接 readText()（无 .use）无上限，统一经 ProcIo.readBounded\n  /* 历史写法：\n     val reader = p.inputStream.bufferedReader()\n     val out = reader.readText()\n  */\n  val out = ProcIo.readBounded(p, 10).text\n}\n' })
  const stringOnly = buildTree('string', { 'S.kt': 'val msg = "不要写 proc.inputStream.bufferedReader().readText()"\nval raw = """\nval reader = p.inputStream.bufferedReader()\nreader.readText()\n"""\n' })
  const lineReport = buildTree('lineno', { 'L.kt': 'val reader = p.inputStream.bufferedReader()\nval out = reader.readText()\n' })

  const checks = [
    ['合规树（无裸读）→ PASSED 且 exit 0', runGate(['--root', OK]), (r) => r.code === 0 && r.out.includes('BOUNDED-IO CHECK PASSED')],
    ['裸 readText（无 .use，历史缺陷形态 1）→ FAILED', runGate(['--root', bare]), (r) => r.code === 1 && r.out.includes('裸 readText')],
    ['proc.inputStream.bufferedReader().use { it.readText() } → FAILED', runGate(['--root', use]), (r) => r.code === 1 && r.out.includes('BOUNDED-IO CHECK FAILED')],
    ['命中行带 bounded-io-exempt 注释 → PASSED（豁免通道有效）', runGate(['--root', exempt]), (r) => r.code === 0 && r.out.includes('BOUNDED-IO CHECK PASSED')],
    ['ProcIo.kt 本体豁免（并发排水是它的职责）→ PASSED', runGate(['--root', procio]), (r) => r.code === 0 && r.out.includes('BOUNDED-IO CHECK PASSED')],
    ['无 app/src/main/java 的树 → 树定位失败 exit 1', runGate(['--root', noTree]), (r) => r.code === 1 && r.out.includes('找不到含 app/src/main/java 的树')],
    ['两行写法（先取 reader 再 readText）→ FAILED（issue #1018 主形态）', runGate(['--root', twoLine]), (r) => r.code === 1 && r.out.includes('BOUNDED-IO CHECK FAILED')],
    ['三行写法（中间夹一行代码）→ FAILED', runGate(['--root', threeLine]), (r) => r.code === 1 && r.out.includes('BOUNDED-IO CHECK FAILED')],
    ['三行写法（中间夹一行注释）→ FAILED（注释不得让判据失明）', runGate(['--root', threeLineComment]), (r) => r.code === 1 && r.out.includes('BOUNDED-IO CHECK FAILED')],
    ['同一形态只写在注释里 → PASSED（防误报）', runGate(['--root', commentOnly]), (r) => r.code === 0 && r.out.includes('BOUNDED-IO CHECK PASSED')],
    ['同一形态只写在字符串/三引号串里 → PASSED（防误报）', runGate(['--root', stringOnly]), (r) => r.code === 0 && r.out.includes('BOUNDED-IO CHECK PASSED')],
    ['两行写法的命中行号报在「真的去读」的那一行（L.kt:2）', runGate(['--root', lineReport]), (r) => r.code === 1 && /L\.kt:2:/.test(r.out)],
  ]
  let bad = 0
  for (const [label, result, verify] of checks) {
    const ok = verify(result)
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  -> exit=' + result.code + ' out=' + result.out.trim().slice(0, 220)))
    if (!ok) bad += 1
  }
  // 纯函数面：掩码不改变长度与换行（行号换算的前提）
  const sample = 'val a = 1 // 注释\nval b = "字符串"\nval c = """原始串"""\n/* 块 /* 嵌套 */ 注释 */\nval d = 2\n'
  const masked = maskKotlin(sample)
  const sameLength = masked.length === sample.length
  const sameLines = masked.split('\n').length === sample.split('\n').length
  console.log((sameLength && sameLines ? 'PASS  ' : 'FAIL  ') + '掩码保持字符数与行数不变（行号换算前提）')
  if (!(sameLength && sameLines)) bad += 1
  const nested = maskKotlin('val a = 1\n/* 外层 /* 内层 */ 仍在注释里 */\nval b = stream.bufferedReader().readText()')
  const nestedHit = /\.bufferedReader\(\)/.test(nested)
  console.log((nestedHit ? 'PASS  ' : 'FAIL  ') + '嵌套块注释正确收尾（内层收尾符不得提前结束注释）')
  if (!nestedHit) bad += 1

  for (const dir of [OK, bare, use, exempt, procio, noTree, twoLine, threeLine, threeLineComment, commentOnly, stringOnly, lineReport]) rmSync(dir, { recursive: true, force: true })
  console.log(bad === 0
    ? 'BOUNDED_IO_SELF_TEST_PASSED（' + (checks.length + 2) + ' 项）'
    : 'BOUNDED_IO_SELF_TEST_FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const OVERRIDE = rootIdx >= 0 ? argv[rootIdx + 1] : process.env.DSH_APK_ROOT

const hasKotlinTree = (dir) => existsSync(join(dir, 'app', 'src', 'main', 'java'))
const CANDIDATES = OVERRIDE
  ? [resolve(OVERRIDE)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]
const APK_ROOT = CANDIDATES.find(hasKotlinTree)
if (!APK_ROOT) {
  console.error('BOUNDED-IO CHECK FAILED：找不到含 app/src/main/java 的树（协调仓布局应为 <根>/dsh-mobile-apk，'
    + 'apk 仓自包含布局应为 <根> 本身）')
  console.error('  候选：' + CANDIDATES.join('、'))
  console.error('  正确入口：在协调仓根或 dsh-mobile-apk 仓根执行本门禁（勿在别的目录跑）')
  process.exit(1)
}
const SRC = join(APK_ROOT, 'app', 'src', 'main', 'java')
console.log('APK 树: ' + (relative(ROOT, APK_ROOT) || APK_ROOT))

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.kt')) files.push(full)
  }
}
walk(SRC)

const bad = []
for (const f of files) {
  if (f.endsWith('ProcIo.kt')) continue
  const text = readFileSync(f, 'utf8')
  for (const hit of scanSource(text)) {
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    bad.push(rel + ':' + hit.line + ': ' + hit.why + (hit.from === undefined ? '' : '（reader 取自第 ' + hit.from + ' 行）'))
  }
}
if (bad.length > 0) {
  console.error('BOUNDED-IO CHECK FAILED（子进程/连接流输出必须走 ProcIo.readBounded）:')
  for (const b of bad) console.error('  ' + b)
  process.exit(1)
}
console.log('BOUNDED-IO CHECK PASSED（' + files.length + ' 个 Kotlin 文件零命中，树=' + APK_ROOT + '）')
