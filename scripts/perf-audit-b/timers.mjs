#!/usr/bin/env node
/**
 * B5 辅助：静态盘点「周期性唤醒源」，分别统计「定义上就周期性」与「需人工判定是否递归」两类。
 *
 * 为什么分两类：setTimeout / Handler.postDelayed 本身是一次性的；它变成周期源的前提是
 * **回调里重新注册自己**。静态扫不出来的递归不能算进周期总和，否则数字是编的。
 * 所以本脚本只把「API 语义上就是周期」的算进合计，其余单列并给出 file:line 供人工判定。
 *
 * 另一条纪律：测试文件里的 setTimeout 是等异步收敛的夹具，不是产品唤醒源，必须排除，
 * 否则一条 3ms 的测试 sleep 就能把「次/分钟」算到十万量级（第一次跑就是这么翻车的）。
 *
 * 用法：node scripts/perf-audit-b/timers.mjs <仓库根目录>
 * 输出：stdout JSON；stderr 人类可读摘要。
 */
import { execFileSync } from 'node:child_process'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/timers.mjs <仓库根目录>')
  process.exit(2)
}

function gitGrepFixed(literal, pathspecs) {
  const args = ['grep', '-n', '-I', '-F', literal, '--', ...pathspecs]
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return out.trim() === '' ? [] : out.trim().split(/\r?\n/)
  } catch (e) {
    if (e.status === 1 || e.status === 128) return []
    throw e
  }
}

const KOTLIN_PATHS = ['app/src/main/java', 'plugins', 'vendor']
const JS_PATHS = ['dsh-client-ui-responsive/src', 'dsh-host-web-compat', 'plugins', 'vendor', 'app/src/main/assets']

/** 测试/夹具/构建脚本：不是产品运行时唤醒源。 */
const NON_PRODUCTION = /(^|\/)(test|tests|__tests__|fixtures?|scripts)\//

const RULES = [
  // ---- 定义上周期 ----
  { lang: 'kotlin', api: 'scheduleAtFixedRate', literal: 'scheduleAtFixedRate', paths: KOTLIN_PATHS, periodic: true,
    re: /scheduleAtFixedRate\s*\([^,]*,\s*[^,]*,\s*([0-9_]+)\s*L?/, group: 1 },
  { lang: 'kotlin', api: 'scheduleWithFixedDelay', literal: 'scheduleWithFixedDelay', paths: KOTLIN_PATHS, periodic: true,
    re: /scheduleWithFixedDelay\s*\([^,]*,\s*[^,]*,\s*([0-9_]+)\s*L?/, group: 1 },
  { lang: 'kotlin', api: 'CountDownTimer', literal: 'CountDownTimer(', paths: KOTLIN_PATHS, periodic: true,
    re: /CountDownTimer\s*\(\s*([0-9_]+)\s*L?\s*,\s*([0-9_]+)/, group: 2 },
  { lang: 'kotlin', api: 'Timer.schedule(period)', literal: '.schedule(', paths: KOTLIN_PATHS, periodic: true,
    re: /\.schedule\s*\([^,]*,\s*([0-9_]+)\s*L?\s*,\s*([0-9_]+)\s*L?/, group: 2 },
  { lang: 'js', api: 'setInterval', literal: 'setInterval', paths: JS_PATHS, periodic: true,
    re: /setInterval\s*\([^,]*,\s*([0-9_]+)\s*[,)]/, group: 1 },
  // ---- 一次性，需人工判定递归 ----
  { lang: 'kotlin', api: 'Handler.postDelayed', literal: 'postDelayed', paths: KOTLIN_PATHS, periodic: false,
    re: /postDelayed\s*\([^,]*,\s*([0-9_]+)\s*L?\s*\)/, group: 1 },
  { lang: 'kotlin', api: 'sendEmptyMessageDelayed', literal: 'sendEmptyMessageDelayed', paths: KOTLIN_PATHS, periodic: false,
    re: /sendEmptyMessageDelayed\s*\([^,]*,\s*([0-9_]+)\s*L?\s*\)/, group: 1 },
  { lang: 'js', api: 'setTimeout', literal: 'setTimeout', paths: JS_PATHS, periodic: false,
    re: /setTimeout\s*\([^,]*,\s*([0-9_]+)\s*[,)]/, group: 1 },
]

const hits = []
const unparsed = []

for (const rule of RULES) {
  for (const line of gitGrepFixed(rule.literal, rule.paths)) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line)
    if (m === null) continue
    const [, file, lineNo, code] = m
    // 负控：注释里写的 setInterval(...) 不是调用点。首版没这条过滤，把一句
    // 「审计之前是裸的 setInterval(tick, 1000)」的注释算成了 60 次/分钟的唤醒源。
    const codeBody = code.trimStart()
    if (codeBody.startsWith('//') || codeBody.startsWith('*') || codeBody.startsWith('/*')) { unparsed.push({ lang: rule.lang, api: rule.api, file, line: Number(lineNo), code: code.trim().slice(0, 200), reason: 'comment-line' }); continue }
    const sm = rule.re.exec(code)
    if (sm === null) { unparsed.push({ lang: rule.lang, api: rule.api, file, line: Number(lineNo), code: code.trim().slice(0, 200) }); continue }
    const raw = sm[rule.group] ?? sm[1]
    const n = Number(String(raw).replace(/_/g, ''))
    if (!Number.isFinite(n) || n <= 0) { unparsed.push({ lang: rule.lang, api: rule.api, file, line: Number(lineNo), code: code.trim().slice(0, 200) }); continue }
    hits.push({ lang: rule.lang, api: rule.api, periodic: rule.periodic, file, line: Number(lineNo), intervalMs: n, code: code.trim().slice(0, 200) })
  }
}

const seen = new Set()
const unique = hits.filter((h) => {
  const k = h.file + ':' + h.line + ':' + h.api
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
for (const h of unique) h.production = !NON_PRODUCTION.test(h.file) && !/\.(test|spec)\./.test(h.file)

unique.sort((a, b) => a.intervalMs - b.intervalMs)

const perMinute = (ms) => 60000 / ms
const sumPerMin = (arr) => arr.reduce((a, h) => a + perMinute(h.intervalMs), 0)

const periodicProd = unique.filter((h) => h.periodic && h.production)
const periodicTest = unique.filter((h) => h.periodic && !h.production)
const oneShotProd = unique.filter((h) => !h.periodic && h.production)
const oneShotTest = unique.filter((h) => !h.periodic && !h.production)

const report = {
  root,
  counts: {
    totalUnique: unique.length,
    periodicProduction: periodicProd.length,
    periodicTest: periodicTest.length,
    oneShotProduction: oneShotProd.length,
    oneShotTest: oneShotTest.length,
    unparsed: unparsed.length,
  },
  // 只有「定义上周期 且 是产品代码」才进合计——其余不猜
  periodicProductionWakesPerMinute: Number(sumPerMin(periodicProd).toFixed(2)),
  periodicProductionWakesPerHour: Number((sumPerMin(periodicProd) * 60).toFixed(1)),
  periodicProduction: periodicProd,
  oneShotProduction: oneShotProd,
  periodicTest,
  oneShotTest,
  unparsed,
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n')

process.stderr.write([
  '去重命中 ' + unique.length + ' 条；未解析间隔 ' + unparsed.length + ' 条',
  '定义上周期 · 产品代码 ' + periodicProd.length + ' 条 → ' + report.periodicProductionWakesPerMinute + ' 次/分钟（' + report.periodicProductionWakesPerHour + ' 次/小时）',
  '定义上周期 · 测试夹具 ' + periodicTest.length + ' 条（不计入）',
  '一次性 · 产品代码 ' + oneShotProd.length + ' 条（递归与否需人工判定，不计入合计）',
].join('\n') + '\n')
