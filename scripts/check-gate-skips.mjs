#!/usr/bin/env node
// check-gate-skips.mjs — 门禁覆盖清单化 + SKIP 纪律门禁（0.13.8-b ST-31）。
//
// 断言：
//   1. 门禁清单 == 实际文件：check-release-gates.mjs 声明集合里的每个脚本都在 scripts/ 存在；
//      两条构建链（build-apk-013.ps1 / build-apk.mjs）调用的 check-*.mjs 都被声明集合覆盖
//      （覆盖清单化：不允许「有人加了一道门禁但没人接线」或反之）；
//   2. SKIP 必须计数且可见：任何**实际发射**的 SKIP 行必须带计数器（SKIP(#n)）或显式 SKIP=n，
//      且该脚本必须打印汇总；
//   3. 发布链 SKIP=0：build-release.ps1（两树）必须以 --run --require 调聚合入口，
//      且聚合入口对支持 --require 的门禁逐个传参；
//   4. 严格档：每个实际发射 SKIP 的门禁都要在 --require 下再跑一遍，断言「exit 0 且 SKIP=0」
//      或「显式声明豁免」——不允许静默；
//   5. 每个门禁必须至少打印一条机器判据行（PASS/FAIL/…），缺判据行要报出来。
//
// ── 为什么整条 SKIP 审计要重做（2026-10-30，issue #1026）──────────────────────
// 旧实现是**纯文本**审计：在源文件里找「console.log/error 后紧跟以 SKIP 开头的字面量」。
// 实测 8 个夹具逐个注入后本门禁仍 PASSED rc=0，其中 7 个隐形或误记：
//   小写 skip: / 字符串拼接 / process.stdout.write / console.warn  —— 隐形（换写法就看不见）
//   SKIP 行尾的 #issue-156 满足了「该行含 #」；注释里的 SKIP= 满足了「全文含 SKIP=」  —— 误记
//   从不打印任何 SKIP 却自动记 counted:true  —— 误记
//   发射 SKIP 但不认 --require  —— 无人验证
// 修法分三层：
//   (a) **运行期实证**：把每个门禁当子进程真跑一遍，用 --require 预载的探针 hook 包住
//       process.stdout.write / process.stderr.write（console.* 最终都走这里），抓**实际发射**的 SKIP 行。
//       静态文本只回答一个次要问题：「这个文件里到底有没有 SKIP 相关代码」——
//       用于区分「该文件确实不发 SKIP」与「审计没看出来」（issue #1026 第 3 点）。
//   (b) **计数判据改成运行期解析**：只有「运行时真的打印出来、且形如 SKIP(#n) 或 SKIP=n」才算已计数；
//       行里随便出现的 # 不再算（issue 编号满足不了它）。有发射无汇总也判红。
//   (c) **严格档实证**：对每个发射 SKIP 的门禁再跑一遍带 --require，断言 exit 0 且 SKIP=0，
//       或该门禁在 SKIP_LINE_EXEMPT 里显式声明豁免（带 reason + until + 到期检查）。
//
// 用法：node scripts/check-gate-skips.mjs [--list] [--self-test] [--no-runtime]
//   --no-runtime  只跑静态层（离线排障用；此时运行期层报「未执行」而不是判绿）
// 退出码：0 = 通过；1 = 失败；2 = 布局不可解析。
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SCRIPTS = join(ROOT, 'scripts')
const argv = process.argv.slice(2)
const NO_RUNTIME = argv.includes('--no-runtime')
/**
 * --only <scripts 下的相对路径>：只审计这一条门禁。
 *
 * 用途：① 排障——全量审计 70+ 个门禁要几分钟，红了一条时不该重跑全部；
 *      ② 受控负控——注入一个违规夹具后只跑它，几秒就能看到它被判红（issue #1026 的 8 组夹具就是这么验的）。
 * 声明集合/构建链那几段静态断言在 --only 模式下仍然执行（它们不依赖探针）。
 */
const onlyIdx = argv.indexOf('--only')
const ONLY_FILE = onlyIdx >= 0 ? argv[onlyIdx + 1] : null
if (onlyIdx >= 0 && (ONLY_FILE === undefined || ONLY_FILE.startsWith('--'))) {
  console.error('CHECK-GATE-SKIPS 用法错误：--only 需要 <scripts 下的相对路径>（例如 check-dead-tokens.mjs）')
  process.exit(2)
}

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const DECLARED_RE = /\{ script: '([a-z0-9-]+\.mjs)'/g
/** 从聚合入口源码提取声明集合（纯函数：自测可直接喂合成文本）。 */
const parseDeclared = (text) => [...text.matchAll(DECLARED_RE)].map((m) => m[1])

/**
 * 宽松「出现过这个名字」扫描。
 *
 * **只可用于正向断言**（声明集合 ⊆ 本链提到的），**绝不可用来判「是否真的执行」**：
 * 它会把 GATE_SCRIPTS 声明数组里的字符串字面量也算成"调用过"，于是反向断言自我满足。
 * 这条纪律由 --self-test 守住（见文件末）。
 */
const parseInvoked = (text) =>
  [...new Set([...text.matchAll(/["'\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/g)].map((m) => m[1]))]

/**
 * 执行点解析（纯函数）：只认「真的会 spawn 这个门禁」的写法。
 *   - node 链：gate('check-x.mjs')（数组字面量没有 gate(...) 包裹，天然排除）
 *   - pwsh 链：行首（可带 $var =）node ... scripts\check-x.mjs，注释行不命中
 */
const parseExecutionSites = (text, isNode) => {
  const out = new Set()
  if (isNode) {
    for (const m of text.matchAll(/gate\(\s*['"]([a-z0-9-]+\.mjs|elf-check\.mjs)['"]\s*\)/g)) out.add(m[1])
  } else {
    for (const m of text.matchAll(/^\s*(?:\$\w+\s*=\s*)?node\s+[^\n]*?scripts[\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/gm)) out.add(m[1])
  }
  return out
}

// ── SKIP 行判据（纯函数，供自测与运行期解析共用）────────────────────────────────
//
// issue #1026：判据必须是「**运行期打印出来的这一行**是不是一条 SKIP 行」，而不是
// 「源码里有没有以 SKIP 开头的字面量」。唯一口径：
//   一条 SKIP 行 = 去掉行首的 PASS/FAIL/OK/WARN 前缀与空白后以 SKIP 开头（大小写不敏感），
//   且下一个字符不是字母（避免 SKIPPED 被当成 SKIP 行）。
// 计数形态 = 行内含 SKIP(#数) 或 SKIP=数。
export const SKIP_LINE_RE = /^\s*(?:PASS|FAIL|OK|WARN)?\s*SKIP(?![A-Za-z])/i
export const SKIP_COUNTED_RE = /SKIP\s*(?:\(\s*#\s*\d+\s*\)|=\s*\d+)/i
/** 纯汇总行（只写 SKIP=n，没有别的文案）——它是**汇总**，不是一次发射。 */
export const SUMMARY_LINE_RE = /^\s*SKIP\s*=\s*\d+\s*$/
export const isSummaryLine = (line) => SUMMARY_LINE_RE.test(String(line))
/** 一行是不是 SKIP **发射**行（纯函数）。纯汇总行不算发射，否则「1 次发射 + 1 行 SKIP=1」会被数成 2 次。 */
export const isSkipLine = (line) => SKIP_LINE_RE.test(String(line)) && !isSummaryLine(line)
/** 一行是不是「已计数」的 SKIP 行（纯函数）。行里随便出现的 # 不算。 */
export const isCountedSkipLine = (line) => isSkipLine(line) && SKIP_COUNTED_RE.test(String(line))

/**
 * 运行期 SKIP 审计的判定（纯函数，--self-test 直接钉）。
 *
 * @param {{runtime: {skipLines: string[], summary: number|null, exit: number|null, ran: boolean, timedOut: boolean},
 *          staticSites: number}} input
 * @returns {{problems: string[], state: string}}
 */
export const auditRuntime = (input) => {
  const problems = []
  const warnings = []
  const rt = input.runtime
  if (rt.timedOut) return { problems: ['运行期探针超时：无法证明该门禁的 SKIP 面（不得按已计数处理）'], warnings, state: 'timeout' }
  if (!rt.ran) return { problems: ['运行期探针未执行：SKIP 面无从证明'], warnings, state: 'unprobed' }
  const skipLines = rt.skipLines.filter(isSkipLine)
  // 「一个发射点都没认出来」不得直接记 counted:true（issue #1026 第 3 点 + 夹具 7）：
  // 运行期**零输出且 exit 0** ⇒ 静默成功 = 假绿，必须判红。
  // 只有**探针真的跑了却没拿到任何输出**才算静默成功；自测里的合成 runtime 不传 lines 时按「有输出」处理。
  if (rt.exit === 0 && Array.isArray(rt.lines) && rt.lines.length === 0) {
    return { problems: ['运行期零输出且 exit 0：这道门禁什么都没打印，无法证明它执行过任何判据（静默成功 = 假绿）'], warnings, state: 'silent-success' }
  }
  if (skipLines.length === 0) {
    // issue #1026 第 3 点：不能把「一个发射点都没认出来」直接记 counted:true。
    // 源码里也没有任何 SKIP 相关写入点 ⇒ 该文件确实不发 SKIP（正常态）。
    // 源码里有、运行期却没有 ⇒ 条件未触发（可接受，但状态如实记成 no-emission-observed）。
    if (input.staticSites > 0) return { problems: [], warnings, state: 'no-emission-observed' }
    return { problems: [], warnings, state: 'no-skip-surface' }
  }
  const uncounted = skipLines.filter((line) => !isCountedSkipLine(line))
  if (uncounted.length > 0) {
    problems.push('未计数的 SKIP 行（须写成 SKIP(#n) 或 SKIP=n）：' + uncounted[0].trim().slice(0, 90))
  }
  // 汇总要求：发射了 SKIP 就必须能读出**合计**（SKIP=n）。合计可以出现在判据行里
  // （例如 PASSED（SKIP=1；…）），也可以是独立的一行 —— 但必须存在。
  if (rt.summary === null) {
    problems.push('打印了 SKIP 行但没有汇总（须在结尾打印 SKIP=n 或在判据行里带 SKIP=n）')
  } else if (rt.summary < skipLines.length) {
    // 计数漏记：不直接判红（有些门禁有多条**互斥**的终止型 SKIP 行，每条各自声明 SKIP=1，
    // 只有一条会真的走到；判红需要逐门禁语义知识，属该门禁自己的事），但必须**说出来**。
    warnings.push('汇总 SKIP=' + rt.summary + ' 小于本次实际发射的 SKIP 行数 ' + skipLines.length + '（可能计数漏记）')
  }
  return { problems, warnings, state: 'emits' }
}

/**
 * 严格档判据（纯函数）：发射 SKIP 的门禁在 --require 下必须「exit 0 且 SKIP=0」或显式豁免。
 *
 * issue #1026 第 4 点：旧实现从不验证这件事——它的两处 --require 断言只查发布链脚本文本
 * 与聚合入口的一个硬编码门禁名，于是「新门禁发射 SKIP 且在 --require 下仍 exit 0」是绿的。
 */
export const auditStrict = (input) => {
  if (!input.emitsSkip) return []
  if (input.exempt && input.exempt.reason && input.exempt.until) {
    if (input.exempt.stale) {
      return ['严格档豁免已过期（until ' + input.exempt.until + '）：要么修好该门禁，要么重写豁免理由与到期条件']
    }
    return []
  }
  if (!input.ran) return ['严格档未执行：无法证明该门禁在 --require 下不以 SKIP 结案']
  if (input.exit !== 0) return []   // 严格档判红是合法结案（不是静默 SKIP）
  if (input.strictSkip === null || input.strictSkip > 0) {
    return ['该门禁在 --require 下仍以 SKIP 结案（exit 0，SKIP='
      + (input.strictSkip === null ? '未打印' : input.strictSkip) + '）：要么在严格档判红，要么登记显式豁免']
  }
  return []
}

/**
 * 零判据标记（issue #1038 ①）：门禁自己声明「本次没有执行任何判据」。
 *
 * 这类结案**不是**通过：它意味着这道门禁这次什么都没校验。审计的做法是要求它登记
 * （ZERO_CRITERIA_REGISTER：reason + until），否则判红——「零判据」于是变成可审计的事实，
 * 而不是一条恒绿的静默。
 */
export const ZERO_CRITERIA_RE = /^\s*(?:NO-CRITERIA|CHECK-[A-Z0-9-]+\s+NO-CRITERIA)\b|\bCHECK\s+未作判定|\b未作判定\b/m
export const hasZeroCriteria = (text) => ZERO_CRITERIA_RE.test(String(text))

/**
 * 判据行判据（纯函数）：门禁必须打印至少一条机器可判的结论行。
 *
 * issue #1038 的形态是「默认档零判据却 exit 0」；在审计面上它对应的可观测事实是
 * **没有任何 PASS/FAIL 判据行**。这里只做最保守的形态识别，不猜具体门禁的文案。
 */
export const VERDICT_RE = /(^|\n)\s*(?:PASS|FAIL|OK|PASSED|FAILED)\b|CHECK-[A-Z0-9-]+\s+(?:PASSED|FAILED|SKIPPED|NO-CRITERIA|PASS|FAIL)|\bCHECK\s+(?:PASSED|FAILED|SKIPPED|NO-CRITERIA|PASS|FAIL)\b|^\s*NO-CRITERIA\b|\b未作判定\b/m
export const hasVerdict = (text) => VERDICT_RE.test(String(text))

const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
const readIf = (rel) => { const p = resolveRepoPath(rel); return p === null ? null : readFileSync(p, 'utf8') }

const invokedIn = (rel) => {
  const text = readIf(rel)
  return text === null ? null : parseInvoked(text)
}
/**
 * 执行点解析（0.14.2 实修）：只认「真的会 spawn 这个门禁」的写法，不认声明数组里的字符串字面量。
 *
 * 为什么必须与 invokedIn() 分开：宽松正则会把 GATE_SCRIPTS 声明数组里的 'check-x.mjs'
 * 也算成「调用过」，于是「调用声明集合的每一项」这条断言对 build-apk.mjs **自我满足**——
 * 声明了却没接线照样判绿。修法 = 反向断言必须建立在「执行点」之上。
 */
const executionSites = (rel, textOverride) => {
  const text = textOverride === undefined ? readIf(rel) : textOverride
  if (text === null) return null
  return parseExecutionSites(text, rel.endsWith('.mjs'))
}

// ── 运行期探针 ────────────────────────────────────────────────────────────────
//
// 探针是一个 --require 预载的 CJS hook：包住 process.stdout.write / process.stderr.write，
// 把写入内容按行切开并全量缓存，进程退出时落盘 JSON。console.log/warn/error/info
// 最终都走 process.stdout/stderr 的 write，所以换通道不再隐形（issue #1026 夹具 3/4）。
// 缓存**所有**行（不只 SKIP 行）：判据行检测需要看到完整 stdout。
const PROBE_HOOK = [
  "const fs = require('node:fs')",
  "const OUT = process.env.DSH_SKIP_PROBE_OUT",
  "const MAX_LINES = 4000",
  "const lines = []",
  'let carry = ""',
  "const feed = (chunk) => {",
  "  let text",
  "  if (typeof chunk === 'string') text = chunk",
  "  else if (chunk instanceof Uint8Array) text = Buffer.from(chunk).toString('utf8')",
  "  else text = String(chunk)",
  "  carry += text",
  "  const parts = carry.split('\\n')",
  "  carry = parts.pop()",
  "  for (const p of parts) if (lines.length < MAX_LINES) lines.push(p)",
  "}",
  "const wrap = (stream) => {",
  "  const orig = stream.write.bind(stream)",
  "  stream.write = function (chunk, enc, cb) {",
  "    try { feed(chunk) } catch (e) {}",
  "    return orig(chunk, enc, cb)",
  "  }",
  "}",
  "wrap(process.stdout)",
  "wrap(process.stderr)",
  "const flush = (code) => {",
  "  try {",
  "    if (carry && lines.length < MAX_LINES) lines.push(carry)",
  "    fs.writeFileSync(OUT, JSON.stringify({ code, lines }))",
  "  } catch (e) {}",
  "}",
  "process.on('exit', (code) => flush(code))",
].join('\n')

// 慢门禁实测：check-script-tests / check-patch-test-manifest / check-release-gates 单跑 150–160 s，
// 并发 8 路时更慢；给足预算，超时仍按「无法证明」判红（不按已计数处理）。
const PROBE_TIMEOUT_MS = 600 * 1000
/** 并发探针数：门禁是独立进程、互不共享状态，串行跑完 70 个要十几分钟（实测）。 */
const PROBE_CONCURRENCY = 8

/**
 * 真跑一个门禁并用探针抓它的实际输出（运行期实证）。异步 + 并发池：70 个门禁串行要十几分钟。
 *
 * @param {string} file scripts/ 下的相对路径（如 check-dead-tokens.mjs）
 * @param {string[]} extraArgs 追加参数（严格档传 ['--require']）
 * @returns {Promise<{ran: boolean, timedOut: boolean, exit: number|null, lines: string[], skipLines: string[], summary: number|null}>}
 */
async function probeGate(file, extraArgs = []) {
  const work = mkdtempSync(join(tmpdir(), 'gate-skip-probe-'))
  const out = join(work, 'out.json')
  const hookPath = join(work, 'probe.cjs')
  try {
    writeFileSync(hookPath, PROBE_HOOK)
    const { spawn } = await import('node:child_process')
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--require', hookPath, join(SCRIPTS, file), ...extraArgs], {
        cwd: ROOT,
        stdio: 'ignore',
        env: { ...process.env, DSH_SKIP_PROBE_OUT: out },
      })
      let timedOut = false
      const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, PROBE_TIMEOUT_MS)
      child.on('error', () => { clearTimeout(killer); resolve({ exit: null, timedOut }) })
      child.on('exit', (code) => { clearTimeout(killer); resolve({ exit: code, timedOut }) })
    })
    let lines = []
    if (existsSync(out)) {
      try { lines = JSON.parse(readFileSync(out, 'utf8')).lines ?? [] } catch { lines = [] }
    }
    const skipLines = lines.filter(isSkipLine)
    const summaryMatch = /\bSKIP=(\d+)/.exec(lines.join('\n'))
    return {
      ran: !result.timedOut,
      timedOut: result.timedOut,
      exit: result.exit,
      lines,
      skipLines,
      summary: summaryMatch === null ? null : Number(summaryMatch[1]),
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 并发跑一批探针任务（保持输入顺序返回）。 */
async function probeAll(tasks) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next
      next += 1
      results[index] = await probeGate(tasks[index].file, tasks[index].args)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 源码里「SKIP 相关写入点」的静态计数（只用于回答「该文件到底有没有 SKIP 代码」）。
 *
 * 注意它**不是**判据：数出来 0 也不代表运行期不会发射（拼字符串、动态键都能绕），
 * 数出来 >0 也不代表一定会发射（条件分支）。真正的判据是上面的运行期探针。
 */
export function countStaticSkipSites(text) {
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const WRITE_RE = /(?:console\s*\.\s*(?:log|error|warn|info|debug|trace)|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write)\s*\(/g
  let n = 0
  let m
  while ((m = WRITE_RE.exec(stripped)) !== null) {
    // 取这次写入调用的实参区间（配对括号），再看实参里有没有 SKIP 字样。
    let depth = 0
    let i = WRITE_RE.lastIndex
    const start = i
    for (; i < stripped.length; i += 1) {
      const c = stripped[i]
      if (c === '(') depth += 1
      else if (c === ')') {
        if (depth === 0) break
        depth -= 1
      }
    }
    if (/skip/i.test(stripped.slice(start, i))) n += 1
  }
  return n
}

/**
 * 严格档豁免登记表（默认空 —— 默认拒绝）。
 *
 * 每条必须写清 reason（为什么它能以 SKIP 结案）、until（到期日，ISO 日期）。
 * 到期后本门禁判红（auditStrict 的 stale 分支），避免豁免变成永久静默。
 */
const SKIP_LINE_EXEMPT = new Map([
  // check-combo-cache / check-patch-mirror：两条门禁的 SKIP 是**合法缺输入**（无快照 / 单仓 checkout），
  // 且它们的严格档语义由各自的专用开关承担（--require-peer / 显式 <snapshot.tar.xz> 参数），
  // 不是聚合器的 --require。这里登记为显式豁免，而不是让它们静默绿。
  ['check-combo-cache.mjs', {
    reason: '缺快照时以 SKIP 结案是设计内行为；发布链以显式 <snapshot.tar.xz> 参数强制真检（见脚本头注释）',
    until: '2026-12-31',
  }],
  ['check-patch-mirror.mjs', {
    reason: '单仓 checkout 下对端镜像面缺席是设计内行为；CI/发布链以 --require-peer 判红（见脚本头注释）',
    until: '2026-12-31',
  }],
  // check-tool-output-schema：SKIP 来自**插件构建产物（lib/）缺席**，而聚合器的 --require 不负责
  // 「先构建插件」。发布链在调本门禁之前已由「准备插件产物」段构建完毕，故严格档下它真会真检；
  // 在净 checkout 的门禁自审里以 SKIP 结案是设计内行为。
  //
  // 这条是**本轮新判据首次看见的既有缺口**：旧实现不审计严格档，它一直静默绿。按其设计登记为
  // 显式豁免而不是放宽判据 —— 到期 2026-12-31 前要把「净检出下先建产物」接进 CI 门禁自审，
  // 否则本条到期判红。
  ['check-tool-output-schema.mjs', {
    reason: 'SKIP 来自插件 lib/ 产物缺席；发布链调用前已构建全部插件产物，净 checkout 自审下缺席属设计内行为。到期前须把产物预构建接进 CI 门禁自审',
    until: '2026-12-31',
  }],
  // check-contract：口径冲突（issue #1153）。该门禁只读 docs/UPSTREAM-CONTRACT.md，而这份文档是
  // **协调仓独有**（dsh-mobile/apk 的镜像同步已按常设决定放弃维护，门禁以本仓为准）。
  // check-contract 自己在自包含树上打印 SKIP(#1) 后以 exit 0 + SKIP=1 结案，并声明「不计入 --require」；
  // 而本门禁的严格档要求「exit 0 且 SKIP=0」或显式豁免 —— 两条判据对同一情形给出相反结论。
  //
  // 登记为豁免而不是放宽判据：真要在自包含树上做文档同源性，得先决定「上游契约文档以哪份为准」，
  // 那是 #1153 要定的口径，不该由门禁单方面假设。到期前必须收口，否则本条到期判红。
  ['check-contract.mjs', {
    reason: 'docs/UPSTREAM-CONTRACT.md 是协调仓独有文档，自包含树（apk 仓）上必然缺席；check-contract 对此外显式打印「自包含树合法缺席，不计入 --require」并以 exit 0 结案（口径冲突见 issue #1153）。到期前须定「上游契约文档以哪份为准」或把该文档纳入 apk 仓',
    until: '2026-12-31',
  }],
])

/**
 * 零判据登记表（issue #1038 ①）。默认空 —— 默认拒绝。
 *
 * 某门禁打印 NO-CRITERIA（本次没有执行任何判据）时，必须在这里登记 reason + until；
 * 否则本门禁判红。到期后同样判红。这样「零判据」既不会被静默，也不会成为永久豁免。
 */
/**
 * 审计基线登记表（shrink-only，默认空）。
 *
 * 用途：本轮审计**首次**能看见的既有缺口，而对应的门禁不在本组写域内（改了会越界）。
 * 每条必须写清 reason（是什么缺口）与 until（到期日）；到期后判红。
 * 并且**缺口消失也要判红**（登记失效，必须删条目）——「多了少了都红」，
 * 否则基线会变成永久静默，正是 issue #1026 要消灭的东西。
 */
// ── 规范环境判定（issue #1154）─────────────────────────────────────────────
//
// 销账判据（下方「审计基线陈旧检查」）的语义是：**登记过的缺口本次没有复现 -> 可能已修好 -> 删条目**。
// 但「没复现」有两种截然不同的原因：
//   1. 缺口真的被修好了（判据执行了、通过了）—— 该销账；
//   2. 本次环境根本没跑到那条判据（缺快照/缺依赖/缺上游树）—— **不能销账**，那不是证据。
//
// 现状把两者都当 1，于是出现倒挂：**本地把环境装齐后反而判红**（缺口「没复现」了），
// 环境越残缺越容易绿。这会教人「别装齐依赖」，方向完全反了。
//
// 处置：给每条基线条目声明它依赖的环境前置（requires）。本次环境不满足该前置时，判定为
// 「本次未跑到」，打印 NOTE 提示以 CI 为准，**不判红、也不销账**。
// 环境满足时行为完全不变（没复现 = 真修好了 = 必须删条目）。
//
// 注：2026-10-31 的 #1176 已让 check-runtime-assets / check-mcp-client-deps 在 SKIP 分支
// 打印具名结论行，那两条登记随之删除（更根本的修法）。本判定管的是**剩余登记**的同类倒挂 ——
// 它们里多数仍以 SKIP 结案且无具名判据行。
const CANONICAL_ENV_PROBES = {
  // 快照 tar：CI 上由准备段生成；净检出被 .gitignore 忽略，必然缺席。
  snapshot: () => existsSync('app/src/main/assets/snapshot.tar.xz')
    || existsSync(join('.deploy-tmp', 'snapshot-013', 'x86_64', 'snapshot.tar.xz')),
  // 上游令牌定义面：仅协调仓有。
  upstreamTree: () => existsSync(join('.deploy-tmp', 'deepseek-harness')),
  // 根级依赖树：npm ci 之后才在。
  nodeModules: () => existsSync('node_modules'),
}

/**
 * 判定某条审计基线登记本次**是否具备判定环境**（纯函数，--self-test 直接钉）。
 *
 * 返回未满足的 requirement 名列表：空数组 = 环境齐备，销账判据生效；非空 = 本次没跑到。
 * 未声明的 requirement 名字一律视为「不满足」（fail-closed）：拼错一个键不能让判据静默通过。
 *
 * @param entry AUDIT_BASELINE 的条目（至少含 requires）
 * @param probes requirement 名 -> () => boolean 的探测表
 * @returns {string[]} 未满足的 requirement 名
 */
export function unmetRequirements(entry, probes) {
  const requires = entry?.requires ?? []
  return requires.filter((k) => {
    const probe = probes?.[k]
    return typeof probe !== 'function' || probe() !== true
  })
}

const AUDIT_BASELINE = new Map([
  ['check-boot-budget.mjs', {
    requires: ['snapshot', 'upstreamTree'],
    kinds: ['no-summary', 'no-verdict'],
    reason: '真数据分支打印 SKIP(#1)(real-data) 后不打印 SKIP= 汇总（汇总只在 PASSED/FAILED 分支），也不打印判据行',
    until: '2026-12-31',
  }],
  // 已销账（2026-10-31，#1154）：check-runtime-assets 与 check-mcp-client-deps 两条登记已删除。
  // 它们兜的都是「以 SKIP 结案时没有汇总行 / 没有判据行」。真修法不是删登记，而是让那两条门禁
  // 在 SKIP 分支**自己打印具名结论行**（CHECK-RUNTIME-ASSETS SKIPPED（…；SKIP=n） /
  // CHECK-MCP-CLIENT-DEPS SKIPPED（…；SKIP=n）），与 PASSED/FAILED 同形。
  // 这样有快照时真跑通过、无快照时是「明确结案」而不是「零判据」——登记表随之不再需要，
  // 销账倒挂也消失：删登记这个动作在双环境下原本不可能同时成立（本地有快照→缺口不复现，
  // CI 无快照→恒 SKIP），现在两侧都自洽。
  ['check-snapshot-fingerprint.mjs', {
    requires: ['snapshot'],
    kinds: ['no-verdict'],
    reason: '净检出无 tar 时以 SKIP 结案，不打印 PASS/FAIL 判据行',
    until: '2026-12-31',
  }],
])

const ZERO_CRITERIA_REGISTER = new Map([
  ['check-dead-tokens.mjs', {
    reason: '上游令牌定义面（.deploy-tmp/deepseek-harness）在净检出/CI 里缺席时本门禁零判据；'
      + '两条构建链的调用点尚未传 --allow-missing（见 issue #1038 ① 的待办）',
    until: '2026-12-31',
  }],
  // #1119 新增的产物形态门禁：无 --apk/--dir 或目录里没有 APK 时打印
  // 「APK-FORM CHECK 未作判定（SKIP=1）」并 exit 0。它自己声明了「未作判定」，
  // 但**没有机器判据行**——按本门禁的口径这就是零判据结案，必须登记而不是静默绿。
  // 调用点（发布链/CI）给出 APK 后它才真判；到期前要把「净检出下先产出 APK 再判」接进调用链。
  ['check-apk-form.mjs', {
    reason: '无 APK 入参时以「未作判定」+ SKIP=1 结案，无 PASS/FAIL 判据行；调用链须显式给 --apk/--dir（或 --require 让缺席判红）',
    until: '2026-12-31',
  }],
])

// ── --self-test：无仓库依赖的判别力自检 ────────────────────────────────────────
const NODE_CHAIN = 'scripts/build-apk.mjs'
const PWSH_CHAIN = 'scripts/build-apk-013.ps1'
const selfTest = (silent) => {
  const fails = []
  const t = (label, ok, detail) => {
    if (!ok) fails.push(label + (detail === undefined ? '' : ' -> ' + detail))
    else if (!silent) console.log('PASS  [self-test] ' + label)
  }
  // 自指陷阱：样本拆开拼接，避免本文件自己出现「console 点 log 左括号 引号 紧接 SKIP」的连续串。
  const S = (...parts) => parts.join('')

  // 1-2 声明提取
  t('声明提取认 { script: 单引号写法 }',
    parseDeclared("const G = [{ script: 'check-a.mjs', label: 'A' }, { script: 'check-b.mjs' }]").join(',') === 'check-a.mjs,check-b.mjs')
  t('声明提取不吃双引号/裸字符串（写错形态会立刻暴露）',
    parseDeclared('{ script: "check-a.mjs" }').length === 0)

  // 3-4 声明数组字面量：宽松扫描必须命中，执行点扫描必须不命中
  const declOnly = "const GATE_SCRIPTS = [\n  'check-a.mjs',\n  'check-b.mjs',\n]\n"
  t('宽松扫描认得出声明字面量（它本来就该命中）', parseInvoked(declOnly).length === 2)
  t('执行点扫描不把声明字面量当执行（防自满足）',
    executionSites(NODE_CHAIN, declOnly).size === 0, '命中=' + [...executionSites(NODE_CHAIN, declOnly)].join(','))

  // 5-8 node 链
  t("node 链 gate('x') 命中", [...executionSites(NODE_CHAIN, "gate('check-a.mjs')")].includes('check-a.mjs'))
  t('node 链 gate("x") 双引号同样命中', [...executionSites(NODE_CHAIN, 'gate("check-b.mjs")')].includes('check-b.mjs'))
  t('node 链 数组下标写法不算执行点', executionSites(NODE_CHAIN, 'GATE_SCRIPTS[0]').size === 0)
  t('node 链 gate(x) 无引号变量不算执行点', executionSites(NODE_CHAIN, 'gate(name)').size === 0)

  // 9-12 pwsh 链
  t('pwsh 链 node ... scripts\\check-x.mjs 命中',
    [...executionSites(PWSH_CHAIN, 'node "$PSScriptRoot\\scripts\\check-a.mjs"')].includes('check-a.mjs'))
  t('pwsh 链 带 $var = 前置同样命中',
    [...executionSites(PWSH_CHAIN, '$r = node scripts/check-b.mjs --x')].includes('check-b.mjs'))
  t('pwsh 链 注释行不算执行点', executionSites(PWSH_CHAIN, '# node scripts\\check-a.mjs').size === 0)
  t('pwsh 链 字符串里提到不算执行点',
    executionSites(PWSH_CHAIN, 'Write-Host "见 scripts\\check-a.mjs"').size === 0)

  // 13-20 SKIP 行与计数口径（issue #1026 六个夹具方向）
  t('SKIP 行：计数形态命中', isSkipLine('SKIP(#1)  本仓无 Android 树') && isCountedSkipLine('SKIP(#1)  x'))
  t('SKIP 行：未计数形态也认得（否则判不出未计数）', isSkipLine('SKIP 本仓无 Android 树') && !isCountedSkipLine('SKIP 本仓无 Android 树'))
  t('SKIP 行：小写 skip: 同样认得（夹具 1）', isSkipLine('skip: 本仓无 Android 树'))
  t('SKIP 行：FAIL 前缀同样认得', isSkipLine('FAIL  SKIP(#1) x') && isCountedSkipLine('FAIL  SKIP(#1) x'))
  t('SKIP 行：SKIPPED 不算 SKIP 行（不得误吞）', !isSkipLine('CHECK-X SKIPPED'))
  t('SKIP 行：普通文案提到 SKIP 不算发射', !isSkipLine('这里会打印 SKIP 行'))
  t('计数判据：行尾 issue 编号里的 # 不满足计数（夹具 5）',
    isSkipLine('SKIP 本仓无 Android 树 #issue-156') && !isCountedSkipLine('SKIP 本仓无 Android 树 #issue-156'))
  t('计数判据：SKIP=2 是纯汇总行（不算一次发射，也不冒充发射行）',
    isSummaryLine('SKIP=2') && !isSkipLine('SKIP=2'))
  t('计数判据：发射行自带 SKIP=n 也算已计数', isCountedSkipLine('SKIP=1（本门禁以 SKIP 结案）'))

  // 21-26 运行期审计
  const okRuntime = { skipLines: ['SKIP(#1)  x'], summary: 1, exit: 0, ran: true, timedOut: false }
  const r1 = auditRuntime({ runtime: okRuntime, staticSites: 1 })
  t('运行期：有计数 SKIP + 有汇总 -> 绿', r1.problems.length === 0 && r1.state === 'emits', JSON.stringify(r1))
  const r2 = auditRuntime({ runtime: { ...okRuntime, skipLines: ['SKIP 本仓无 Android 树 #issue-156'], summary: 1 }, staticSites: 1 })
  t('运行期：只有 issue 编号里的 # -> 判红（未计数）',
    r2.problems.some((p) => p.includes('未计数的 SKIP 行')), JSON.stringify(r2.problems))
  const r3 = auditRuntime({ runtime: { ...okRuntime, summary: null }, staticSites: 1 })
  t('运行期：有 SKIP 行但无汇总 -> 判红', r3.problems.some((p) => p.includes('没有汇总')), JSON.stringify(r3.problems))
  const r3b = auditRuntime({ runtime: { ...okRuntime, skipLines: ['SKIP(#1) a', 'SKIP(#2) b'], summary: 1 }, staticSites: 1 })
  t('运行期：汇总小于实际发射行数 -> 出 WARN（不判红：可能是互斥的终止型 SKIP 行）',
    r3b.problems.length === 0 && r3b.warnings.some((w) => w.includes('可能计数漏记')), JSON.stringify(r3b))
  const r4 = auditRuntime({ runtime: { skipLines: [], summary: null, exit: 0, ran: true, timedOut: false }, staticSites: 3 })
  t('运行期：源码有 SKIP 代码但本次没发射 -> no-emission-observed（不判红、也不谎称已计数）',
    r4.problems.length === 0 && r4.state === 'no-emission-observed', JSON.stringify(r4))
  const r5 = auditRuntime({ runtime: { skipLines: [], summary: null, exit: 0, ran: true, timedOut: false }, staticSites: 0 })
  t('运行期：源码也没有 SKIP 代码 -> no-skip-surface', r5.state === 'no-skip-surface', JSON.stringify(r5))
  const r5b = auditRuntime({ runtime: { skipLines: [], summary: null, exit: 0, ran: true, timedOut: false, lines: [] }, staticSites: 0 })
  t('运行期：零输出且 exit 0 -> 判红（静默成功 = 假绿，夹具 7）',
    r5b.problems.some((p) => p.includes('零输出且 exit 0')), JSON.stringify(r5b.problems))
  const r6 = auditRuntime({ runtime: { skipLines: [], summary: null, exit: null, ran: true, timedOut: true }, staticSites: 0 })
  t('运行期：探针超时 -> 判红（不得按已计数处理）', r6.problems.length === 1 && r6.state === 'timeout', JSON.stringify(r6))

  // 27-33 严格档
  t('严格档：不发 SKIP 的门禁 -> 无需豁免', auditStrict({ emitsSkip: false, ran: true, exit: 0, strictSkip: null }).length === 0)
  t('严格档：发射 SKIP 且严格档 exit 0 且 SKIP=0 -> 绿',
    auditStrict({ emitsSkip: true, ran: true, exit: 0, strictSkip: 0 }).length === 0)
  t('严格档：发射 SKIP、--require 下仍 exit 0 且 SKIP=1 -> 判红（夹具 8）',
    auditStrict({ emitsSkip: true, ran: true, exit: 0, strictSkip: 1 }).length === 1)
  t('严格档：--require 下判红（exit != 0）是合法结案',
    auditStrict({ emitsSkip: true, ran: true, exit: 1, strictSkip: 1 }).length === 0)
  t('严格档：显式豁免（带 reason + until）-> 绿',
    auditStrict({ emitsSkip: true, ran: true, exit: 0, strictSkip: 1, exempt: { reason: 'r', until: '2999-01-01', stale: false } }).length === 0)
  t('严格档：豁免缺 until -> 仍判红',
    auditStrict({ emitsSkip: true, ran: true, exit: 0, strictSkip: 1, exempt: { reason: 'r' } }).length === 1)
  t('严格档：豁免过期（到期检查）-> 判红',
    auditStrict({ emitsSkip: true, ran: true, exit: 0, strictSkip: 1, exempt: { reason: 'r', until: '2000-01-01', stale: true } }).length === 1)
  t('严格档：探针未执行 -> 判红（不得当作已证明）',
    auditStrict({ emitsSkip: true, ran: false, exit: null, strictSkip: null }).length === 1)

  // 34-35 判据行
  t('判据行：PASS/FAIL 命中', hasVerdict('PASS  x') && hasVerdict('FAIL  y'))
  t('判据行：只有 SKIP 行不算判据行', !hasVerdict('SKIP(#1) 无判据'))

  // 零判据标记（issue #1038 ①）
  t('零判据：NO-CRITERIA 行被识别', hasZeroCriteria('NO-CRITERIA  本次没有执行任何判据（上游缺席）'))
  t('零判据：CHECK-X NO-CRITERIA 形态同样识别', hasZeroCriteria('CHECK-DEAD-TOKENS NO-CRITERIA（零判据结案）'))
  t('零判据：普通 PASSED 不算零判据', !hasZeroCriteria('CHECK-DEAD-TOKENS PASSED（引用 3 处）'))

  // 36-38 静态写点计数
  t('静态写点：console.warn 里的 SKIP 计入', countStaticSkipSites(S('console.', 'warn(', "'SKIP(#1) x'", ')')) === 1)
  // 静态层**刻意**不做值推导：拼接出来的 SKIP 它数不出来 —— 这正是运行期探针存在的理由
  // （issue #1026 夹具 2 的形态）。运行期层认得它，因为那时字符串已经拼好了。
  t('静态写点：拼接出来的 SKIP 数不出来（静态层的已知边界，由运行期层兜住）',
    countStaticSkipSites(S('process.stdout', '.write(', "'SK' + 'IP(#1) x'", ')')) === 0)
  t('运行期层：拼接后真正打印出来的行照样认得（夹具 2）',
    isSkipLine(S('SK', 'IP(#1)  本仓无 Android 树')) && isCountedSkipLine(S('SK', 'IP(#1)  本仓无 Android 树')))
  t('静态写点：注释里的 SKIP 不计入', countStaticSkipSites(S('// 这里会打印 ', 'SKIP 行')) === 0)

  // 39-43 issue #1154：销账倒挂 —— 「没复现」必须区分「修好了」与「没跑到」
  const envAll = { snapshot: () => true, upstreamTree: () => true, nodeModules: () => true }
  const envNone = { snapshot: () => false, upstreamTree: () => false, nodeModules: () => false }
  t('#1154 环境齐备 -> 销账判据生效（未满足清单为空）',
    unmetRequirements({ requires: ['snapshot', 'upstreamTree'] }, envAll).length === 0)
  t('#1154 环境不满足 -> 判定为本次没跑到（不得销账、不得判红）',
    unmetRequirements({ requires: ['snapshot', 'upstreamTree'] }, envNone).length === 2)
  t('#1154 部分满足 -> 只报缺的那几个（不因一部分在场就整体放行）',
    String(unmetRequirements({ requires: ['snapshot', 'upstreamTree'] }, { ...envAll, snapshot: () => false })) === 'snapshot')
  t('#1154 未声明的 requirement 名字 fail-closed（拼错不能让判据静默通过）',
    unmetRequirements({ requires: ['snapshoT'] }, envAll).length === 1)
  t('#1154 无 requires 的条目行为不变（环境不参与判定，照旧销账）',
    unmetRequirements({ kinds: ['no-verdict'] }, envNone).length === 0)
  return fails
}

if (argv.includes('--self-test')) {
  const stFails = selfTest(false)
  if (stFails.length > 0) {
    console.error('CHECK-GATE-SKIPS SELF-TEST FAILED（' + stFails.length + ' 项）：' + stFails.join('；'))
    process.exit(1)
  }
  console.log('CHECK-GATE-SKIPS SELF-TEST PASSED（46 项判别力断言：声明提取 / 执行点扫描 / SKIP 行与计数口径 / 运行期审计六态 / 严格档八态 / 判据行 / 零判据标记 / 静态写点 / 销账环境前置）')
  process.exit(0)
}

// 判据自证：主体每次运行都先自证判别力（静默，仅失败时出声）。
{
  const stFails = selfTest(true)
  if (stFails.length > 0) {
    console.error('CHECK-GATE-SKIPS FAILED：判据自证不通过（' + stFails.length + ' 项）—— ' + stFails.join('；'))
    process.exit(1)
  }
}

// ── 1. 声明集合 vs 实际文件 vs 两条链 ───────────────────────────────────────
const aggText = readIf('scripts/check-release-gates.mjs')
if (aggText === null) { console.error('CHECK-GATE-SKIPS FAILED：缺 scripts/check-release-gates.mjs'); process.exit(2) }
const declared = parseDeclared(aggText)
check('声明集合非空', declared.length > 0, 'gates=' + declared.length)
const missingFiles = declared.filter((g) => !existsSync(join(SCRIPTS, g)))
check('声明集合里的门禁全部在场', missingFiles.length === 0, '缺: ' + missingFiles.join(', '))

const CHAINS = ['scripts/build-apk-013.ps1', 'dsh-mobile-apk/scripts/build-apk.mjs']
const declaredSet = new Set(declared)
for (const rel of CHAINS) {
  const invoked = invokedIn(rel)
  if (invoked === null) { check('构建链在场: ' + rel, false); continue }
  check('构建链在场: ' + rel, true)
  const extras = invoked.filter((g) => !declaredSet.has(g) && g !== 'check-release-gates.mjs')
  if (extras.length > 0) console.log('WARN  ' + rel + ' 另有声明集合外的长驻门禁（既有面）: ' + extras.join(', '))
  const notInvoked = declared.filter((g) => !invoked.includes(g))
  check(rel + ' 调用声明集合的每一项（' + declared.length + ' 项）', notInvoked.length === 0, '未接线: ' + notInvoked.join(', '))
  const exec = executionSites(rel)
  if (exec === null) { check('执行点可解析: ' + rel, false); continue }
  const declaredButNotExecuted = declared.filter((g) => !exec.has(g))
  check(rel + ' 声明集合每一项都有真实执行点（反向断言，' + declared.length + ' 项）',
    declaredButNotExecuted.length === 0,
    '只登记未接线: ' + declaredButNotExecuted.join(', '))
}

// ── 2/3. SKIP 纪律：运行期实证 + 计数口径 + 严格档 ────────────────────────────
// 递归覆盖 scripts/ 全树（来源审计链的 check-*.mjs 全在 scripts/source-build/）。
const collectGateFiles = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
  const rel = prefix ? prefix + '/' + entry.name : entry.name
  if (entry.isDirectory()) return collectGateFiles(join(dir, entry.name), rel)
  return entry.name.startsWith('check-') && entry.name.endsWith('.mjs') ? [rel] : []
})
const allGateFiles = collectGateFiles(SCRIPTS).sort().filter((f) => f !== 'check-gate-skips.mjs')
if (ONLY_FILE !== null && !allGateFiles.includes(ONLY_FILE) && ONLY_FILE !== 'check-gate-skips.mjs') {
  console.error('CHECK-GATE-SKIPS 用法错误：--only 指定的门禁不在审计面内：' + ONLY_FILE)
  process.exit(2)
}
const gateFiles = ONLY_FILE === null ? allGateFiles : allGateFiles.filter((f) => f === ONLY_FILE)
const emptyRuntime = { ran: false, timedOut: false, exit: null, lines: [], skipLines: [], summary: null }
// 第一轮：普通档探针（并发）。自指排除：本门禁自身的审计输出不是被判门禁的 SKIP 面。
const firstPass = NO_RUNTIME
  ? gateFiles.map(() => emptyRuntime)
  : await probeAll(gateFiles.map((file) => ({ file, args: [] })))
const staticSitesOf = new Map(gateFiles.map((file) => [file, countStaticSkipSites(readFileSync(join(SCRIPTS, file), 'utf8'))]))
// 第二轮：只对**实际发射 SKIP** 的门禁跑严格档（--require），并发。
const strictTargets = gateFiles.filter((file, i) => firstPass[i].ran && firstPass[i].skipLines.length > 0)
const strictPass = NO_RUNTIME
  ? new Map()
  : new Map(strictTargets.map((f) => [f, null]))
if (!NO_RUNTIME && strictTargets.length > 0) {
  const strictResults = await probeAll(strictTargets.map((file) => ({ file, args: ['--require'] })))
  strictTargets.forEach((file, i) => strictPass.set(file, strictResults[i]))
}
const skipAudit = [{ file: 'check-gate-skips.mjs', self: true }]
for (let i = 0; i < gateFiles.length; i += 1) {
  const file = gateFiles[i]
  const runtime = firstPass[i]
  const staticSites = staticSitesOf.get(file)
  const verdict = auditRuntime({ runtime, staticSites })
  const emitsSkip = runtime.ran && runtime.skipLines.length > 0
  const exempt = SKIP_LINE_EXEMPT.get(file)
  let strictProblems = []
  if (emitsSkip) {
    const strict = NO_RUNTIME ? emptyRuntime : strictPass.get(file)
    strictProblems = auditStrict({
      emitsSkip,
      ran: strict.ran,
      exit: strict.exit,
      strictSkip: strict.summary,
      exempt: exempt === undefined ? undefined : {
        reason: exempt.reason,
        until: exempt.until,
        stale: Date.parse(exempt.until) < Date.now(),
      },
    })
  }
  // 先把**全部**问题算出来，再统一套审计基线（顺序敏感：noVerdict 必须在基线过滤之前算）。
  const rawProblems = [...verdict.problems, ...strictProblems]
  // 判据行（issue #1038 的可观测形态）：只在**这条门禁有 SKIP 面**时要求。
  // 没有 SKIP 面的门禁（纯 node:test 单元测试、需要位置参数的工具、用法错误 exit 2）
  // 不属本门禁的判据面——它们不打印 SKIP，也不会「以 SKIP 结案」。
  const hasSkipSurface = staticSites > 0 || runtime.skipLines.length > 0
  // exit 2 = 用法/前置不满足（本仓惯例）：这种调用不是「零判据结案」，而是「没跑起来」。
  const usageExit = runtime.exit === 2
  const noVerdict = hasSkipSurface && !usageExit && runtime.ran && runtime.lines.length > 0
    && !hasVerdict(runtime.lines.join('\n'))
  // 「零判据结案」与「没有判据行」是**同一个事实的两种说法**：门禁自己声明了未作判定（且已登记）
  // 时，不再重复按「没有判据行」判红；未登记的零判据由下方 ZERO_CRITERIA_REGISTER 判红。
  const declaredNoCriteria = runtime.ran && hasZeroCriteria(runtime.lines.join('\n'))
  if (noVerdict && !declaredNoCriteria) rawProblems.push('有 SKIP 面却没有任何判据行（PASS/FAIL…）：本次可能零判据结案')
  // 审计基线（shrink-only）：登记过的既有缺口不重复判红，但**必须仍然存在**（消失即判红）。
  const baseline = AUDIT_BASELINE.get(file)
  const problems = []
  for (const p of rawProblems) {
    const kind = p.includes('没有任何判据行') ? 'no-verdict' : p.includes('没有汇总') ? 'no-summary' : null
    if (baseline !== undefined && kind !== null && (baseline.kinds ?? []).includes(kind)) {
      if (!baseline.reason || !baseline.until) problems.push('审计基线登记缺 reason/until：' + file)
      else if (Date.parse(baseline.until) < Date.now()) problems.push('审计基线已过期（until ' + baseline.until + '）：' + kind + ' 缺口必须修好或重写理由')
      else baseline.hit = true
      continue
    }
    problems.push(p)
  }
  // 零判据结案（issue #1038 ①）：必须登记，否则判红。
  const zeroCriteria = runtime.ran && hasZeroCriteria(runtime.lines.join('\n'))
  if (zeroCriteria) {
    const reg = ZERO_CRITERIA_REGISTER.get(file)
    if (reg === undefined) {
      problems.push('本次零判据结案（NO-CRITERIA）且未在 ZERO_CRITERIA_REGISTER 登记：零判据不得当作通过')
    } else if (!reg.reason || !reg.until) {
      problems.push('零判据登记缺 reason/until')
    } else if (Date.parse(reg.until) < Date.now()) {
      problems.push('零判据登记已过期（until ' + reg.until + '）：要么让判据面在场，要么重写理由与到期条件')
    }
  }
  skipAudit.push({
    file,
    staticSites,
    runtime: runtime.skipLines.length,
    summary: runtime.summary,
    exit: runtime.exit,
    strictSkip: emitsSkip && !NO_RUNTIME ? strictPass.get(file).summary : null,
    state: verdict.state,
    counted: problems.length === 0,
    problems,
  })
  if (runtime.skipLines.length > 0 || problems.length > 0) {
    check('SKIP 纪律: ' + file + '（运行期 SKIP 行 ' + runtime.skipLines.length + '，汇总 '
      + (runtime.summary === null ? '缺席' : 'SKIP=' + runtime.summary) + '）',
      problems.length === 0,
      problems[0] ?? '')
  }
}

// 审计基线陈旧检查（多了少了都红）：登记过的缺口如果这次没复现，说明它已被修好 —— 必须删条目。
//
// issue #1154：但「没复现」必须先排除「本次根本没跑到」。环境前置不满足时打 NOTE，
// 既不判红也不销账 —— 否则会出现「本地装齐依赖反而判红」的倒挂，等于惩罚正确的做法。
let auditNotRun = 0
for (const [file, entry] of AUDIT_BASELINE) {
  // --only 模式下只审了一条门禁：其余条目本次根本没跑，不能算「陈旧」。
  if (!gateFiles.includes(file)) continue
  if (entry.hit !== true) {
    const unmet = unmetRequirements(entry, CANONICAL_ENV_PROBES)
    if (unmet.length > 0) {
      // 环境不满足：本次那条判据根本没跑到，缺口的存续与否**无证据**。
      // 这里绝不能判红（否则环境越完整越红），也不能静默（否则这条销账纪律失效）。
      auditNotRun += 1
      console.log('NOTE  审计基线销账: ' + file + '（' + (entry.kinds ?? []).join('/') + '）本次未判定')
      console.log('      环境不满足规范集（缺 ' + unmet.join(' / ') + '）：该缺口本轮没有跑到，'
        + '既不判红也不销账。销账判据以 CI 为准。')
      continue
    }
    check('审计基线销账: ' + file + '（' + (entry.kinds ?? []).join('/') + '）', false,
      '登记过的缺口本次没有复现（可能已修好）：请删掉 AUDIT_BASELINE 里这一条，别让它变成永久静默')
  }
}
if (auditNotRun > 0) {
  console.log('NOTE  审计基线：' + auditNotRun + ' 条因环境不满足规范集未判定，销账结论以 CI 为准')
}

// ── 4. 发布链 SKIP=0 ───────────────────────────────────────────────────────
for (const rel of ['scripts/build-release.ps1', 'dsh-mobile-apk/scripts/build-release.ps1']) {
  const text = readIf(rel)
  if (text === null) { check('发布链在场: ' + rel, false); continue }
  check(rel + ' 以 --run --require 调聚合入口（发布链 SKIP=0）',
    /check-release-gates\.mjs/.test(text) && /--run\b[\s\S]{0,80}--require/.test(text),
    '缺 --require：发布链会以 SKIP 结案')
}
const strictPropagated = /argvFor\.push\('--require'\)/.test(aggText)
check('聚合入口对支持 --require 的门禁传严格档（存在 argvFor.push(--require) 机制）', strictPropagated)

if (argv.includes('--list')) {
  console.log('== 门禁清单（声明 ' + declared.length + ' 项）')
  for (const g of declared) console.log('   ' + g.padEnd(34) + (invokedIn(CHAINS[0]).includes(g) ? 'local' : '     ') + ' ' + (invokedIn(CHAINS[1]).includes(g) ? 'cloud' : ''))
  console.log('== SKIP 审计（运行期实证；static = 源码里的 SKIP 相关写入点）')
  for (const a of skipAudit) {
    if (a.self) { console.log('   ' + a.file.padEnd(34) + '(自身，不审计)'); continue }
    console.log('   ' + a.file.padEnd(34) + 'static=' + a.staticSites + ' runtime=' + a.runtime
      + ' state=' + a.state + (a.counted ? '' : '  ATTENTION'))
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

if (failures.length > 0) {
  console.error('CHECK-GATE-SKIPS FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
const emitterCount = skipAudit.filter((a) => !a.self && a.runtime > 0).length
console.log('CHECK-GATE-SKIPS PASSED（声明 ' + declared.length + ' 项门禁；'
  + (NO_RUNTIME ? 'SKIP 审计 ' + gateFiles.length + ' 个脚本（仅静态层，运行期未执行）' : 'SKIP 运行期审计 ' + gateFiles.length + ' 个脚本、真的发射 SKIP 的 ' + emitterCount + ' 个')
  + '；发布链 --require 在场）')