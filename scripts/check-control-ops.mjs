#!/usr/bin/env node
// check-control-ops.mjs — 控制 op 六处登记链一致性门禁（0.13.8-b 批 B2，跨专项）
//
// 坑 52 的教训：新增 op 必须同时进引擎侧 ControlOp 与 A11Y_OPS，漏一处 = 工具在 a11y 通道下
// 「暂不支持」deny（fail-closed 反而变成静默不可达）。0.13.8 批实测为**六处**（源文档称五处）：
//   1) 壳侧执行分支   dsh-mobile-apk/.../DeviceControlService.kt 的 fun handle(op, args) when 分支
//   2) 壳侧 op 白名单 dsh-mobile-apk/.../ControlProtocolV2.kt 的 SUPPORTED_OPS（handle 的 when 与 caps.ops 共用）
//   3) 引擎侧类型联合 plugins/dsh-android-bridge/src/control-policy.ts 的 ControlOp
//   4) 引擎侧 a11y 策略集 同文件的 A11Y_OPS（decideControl 据此判「支持/拒绝」）
//   5) 引擎侧路由登记 plugins/dsh-android-bridge/src/index.ts 的 ROUTE_OPS（诊断面展示，**声明为子集**）
//   6) manage 工具面  plugins/dsh-android-manage/src/index.ts 的 a11yExec/controlExec 实参集合
//
// 断言：
//   A. handle 分支集合 == SUPPORTED_OPS（壳侧两处必须逐字一致）
//   B. ControlOp == SUPPORTED_OPS（差集 = 0，仅允许 known-gaps 显式豁免）
//   C. A11Y_OPS == ControlOp（差集 = 0，同上）
//   D. manage 工具面 == SUPPORTED_OPS（工具面不得用到未登记的 op，也不得漏掉已登记的 op）
//   E. ROUTE_OPS ⊂ ControlOp（诊断面刻意只列常用 op；子集 + 非空 + 无越界项）
//   F. longClick 存量漂移专项：壳侧在场而引擎 ControlOp/A11Y_OPS 缺席 → 必须收口（或进 known-gaps）
//
// 用法：node scripts/check-control-ops.mjs [--shell-root <含 app/src/main 的树>] [--plugin-root <含 plugins/ 的树>]
//        [--gaps <known-gaps json>] [--ledger <控制 op 台账 json>]（后两个主要供测试隔离）
// 退出码：0 = 通过；1 = 登记漂移（拒打包/拒合）或树定位失败。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quoted, arrayBlock, unionBlock } from './lib/control-ops-parse.mjs'

// ── 纯函数：文本在场 != 行为在场（#1046）────────────────────────────────────
/**
 * 剥掉行注释与块注释：注释字符替换成空格（行号与偏移不变），字符串内容原样保留。
 * **逐行剥**（引号状态不跨行）：正则/转义里的引号若跨行保持「在字符串里」，文件尾部
 * 的真实注释就会被当成字符串内容放过——那正是本判据要防的假绿。
 * 白名单（SUPPORTED_OPS / ControlOp / A11Y_OPS / ROUTE_OPS / 契约族）一律在剥注释后的
 * 文本上取，注释里写一句 "screenshot" 不得冒充登记（issue #1046 复现①）。
 */
function stripComments(source) {
  let inBlock = false
  return source.split('\n').map((line) => {
    let out = ''
    let index = 0
    let quote = null
    while (index < line.length) {
      const c = line[index]
      const next = line[index + 1]
      if (inBlock) {
        if (c === '*' && next === '/') { inBlock = false; out += '  '; index += 2; continue }
        out += ' '
        index += 1
        continue
      }
      if (quote !== null) {
        if (c === '\\') { out += c + (next ?? ''); index += 2; continue }
        out += c
        if (c === quote) quote = null
        index += 1
        continue
      }
      if (c === '/' && next === '/') { out += ' '.repeat(line.length - index); index = line.length; continue }
      if (c === '/' && next === '*') { inBlock = true; out += '  '; index += 2; continue }
      if (c === '"' || c === "'" || c === BACKTICK) { quote = c; out += c; index += 1; continue }
      out += c
      index += 1
    }
    return out
  }).join('\n')
}

const BACKTICK = '\u0060'

/** 六处登记面的合法面名（豁免条目只允许声明这些面）。 */
const FACE_NAMES = ['handle', 'SUPPORTED_OPS', 'ControlOp', 'A11Y_OPS', 'ROUTE_OPS', 'manage']
/**
 * reason 的下限：豁免是本门禁唯一的宽容面，理由必须存在且不是占位符。
 * 取 8 字而不是 20 字：既有用例夹具（scripts/check-control-ops.test.mjs 的 9 字 reason）
 * 本身就代表「有理由」的最小合规形态；判据要挡的是 undefined / 空串 / 单字符占位，
 * 不是替维护者审阅理由质量（那需要人）。
 */
const MIN_REASON_CHARS = 8
/**
 * 「无显式到期条件」的存量条目上限（冻结，只许减不许增）。
 *
 * 为什么是冻结而不是一刀切：scripts/control-ops-known-gaps.json 的 note 要求每条写
 * 到期条件，但存量 25 条只有 reason。判据改成「存量冻结 + 新增必须显式声明」——
 * 新加一条不带 expires / permanent 的豁免会立刻撞线（红），存量不动则以
 * 「该面补齐即到期」的机械条件兜底（见 staleGapEntries）。
 */
const NO_HORIZON_BASELINE = 25

/** 到期条件是否合法：expires（ISO 日期，且未过期）或 permanent: true，二选一。 */
function gapHorizonProblems(entry, today) {
  const issues = []
  const hasExpires = entry.expires !== undefined
  const hasPermanent = entry.permanent !== undefined
  if (hasExpires && hasPermanent) issues.push('expires 与 permanent 不得同时声明（二选一）')
  if (hasExpires) {
    const text = typeof entry.expires === 'string' ? entry.expires.trim() : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) issues.push('expires 必须是 YYYY-MM-DD，实为 ' + JSON.stringify(entry.expires))
    else {
      const at = new Date(text + 'T00:00:00Z')
      if (Number.isNaN(at.getTime())) issues.push('expires 不是合法日期：' + text)
      else if (at.getTime() < today.getTime()) issues.push('expires 已过期（' + text + '）：要么续期，要么删掉豁免')
    }
  }
  if (hasPermanent && entry.permanent !== true) issues.push('permanent 只能是 true（要撤销就删掉该条目）')
  return issues
}

/**
 * 豁免条目的合规问题（空数组 = 合规）。
 * @param entry 一条 gaps 元素
 * @param index 在数组里的下标（报错定位用）
 * @param today 当前日期（测试注入）
 */
function gapEntryProblems(entry, index, today = new Date()) {
  const issues = []
  const label = 'gaps[' + index + ']'
  const op = typeof entry.op === 'string' ? entry.op.trim() : ''
  if (op === '') issues.push(label + ' 缺 op')
  else if (!/^[A-Za-z][A-Za-z0-9]*$/.test(op)) issues.push(label + '（' + op + '）op 形态不合法（应为驼峰标识符）')
  const faces = Array.isArray(entry.faces) ? entry.faces : []
  if (faces.length === 0) issues.push(label + '（' + op + '）缺 faces（豁免必须点名它豁免的是哪个面）')
  for (const face of faces) {
    if (!FACE_NAMES.includes(face)) {
      issues.push(label + '（' + op + '）未知 face: ' + JSON.stringify(face) + '（合法值：' + FACE_NAMES.join('/') + '）')
    }
  }
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : ''
  if (reason.length < MIN_REASON_CHARS) {
    issues.push(label + '（' + op + '）reason 缺或过短（<' + MIN_REASON_CHARS + ' 字）：豁免必须写清为什么，'
      + '否则「为什么可以不一」变成部落知识（issue #1046 复现②）')
  }
  issues.push(...gapHorizonProblems(entry, today))
  return issues
}

/** 没有显式到期条件的条目（存量冻结口径）。 */
function gapsWithoutHorizon(gaps) {
  return gaps.filter((entry) => entry.expires === undefined && entry.permanent === undefined)
}

/** 陈旧豁免：本轮六面比对里从未被用到的 (op, face) —— 豁免已不再需要。 */
function staleGapEntries(gaps, usedPairs) {
  const stale = []
  for (const entry of gaps) {
    const op = typeof entry.op === 'string' ? entry.op : ''
    const faces = Array.isArray(entry.faces) ? entry.faces : []
    for (const face of faces) {
      if (!usedPairs.has(op + '::' + face)) stale.push(op + '::' + face)
    }
  }
  return stale
}

/** 重复条目：同一 (op, face) 声明两次会让豁免面看起来比实际宽。 */
function duplicateGapPairs(gaps) {
  const seen = new Set()
  const dup = []
  for (const entry of gaps) {
    const op = typeof entry.op === 'string' ? entry.op : ''
    for (const face of Array.isArray(entry.faces) ? entry.faces : []) {
      const key = op + '::' + face
      if (seen.has(key)) dup.push(key)
      seen.add(key)
    }
  }
  return dup
}

// ── 内建自测（--self-test）：钉住解析原语与豁免判据的行为 ──────────────────────
// 放在**树读取之前**：否则真实树一判红 process.exit(1) 就先发生，自检永远跑不到
// （门禁的自证不能依赖「当前树恰好是绿的」）。
function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.error('SELF-TEST FAILED：' + what + '\n  实得 ' + JSON.stringify(a) + '\n  期望 ' + JSON.stringify(b))
      process.exit(1)
    }
  }
  const truthy = (cond, what) => {
    if (!cond) {
      console.error('SELF-TEST FAILED：' + what)
      process.exit(1)
    }
  }
  eq(quoted(`'a', "b", 'c'`), ['a', 'b', 'c'], 'quoted 收单双引号并按序')
  eq(quoted('nothing here'), [], 'quoted 无引号返回空')
  eq(arrayBlock('val X = setOf("a", "b")', 'val X', 'setOf(', ')'), '"a", "b"', 'arrayBlock 正常定位')
  eq(arrayBlock('nothing', 'val X', 'setOf(', ')'), null, 'arrayBlock 缺 mark 返回 null')
  eq(arrayBlock('val X = setOf("a"', 'val X', 'setOf(', ')'), null, 'arrayBlock 缺 close 返回 null')
  eq(quoted(unionBlock("export type C = 'a'\n  // 说明\n  | 'b'\n\nexport interface N {", 'export type C =')), ['a', 'b'], 'unionBlock 跳过 // 注释行（旧实现会漏 b）')
  eq(quoted(unionBlock("export type C = 'a'\n  /* 说明\n   * 续行\n   */\n  | 'b'\n\nexport interface N {", 'export type C =')), ['a', 'b'], 'unionBlock 跳过 /* */ 块注释')
  eq(quoted(unionBlock("export type C = 'a'\n\nexport interface N {\n  op: 'zzz'\n}", 'export type C =')), ['a'], 'unionBlock 遇非联合行即停')
  eq(unionBlock('nothing', 'export type C ='), null, 'unionBlock 缺 mark 返回 null')

  // #1046 复现①：注释里的 op 不得冒充登记
  const commentedList = 'internal val SUPPORTED_OPS: List<String> = listOf(\n  "screenshot",\n  // "tempDown"\n  /* "ghostOp" */\n)'
  eq(quoted(arrayBlock(stripComments(commentedList), 'val SUPPORTED_OPS', 'listOf(', ')')), ['screenshot'],
    '剥注释后白名单只认真实登记（行注释与块注释里的 op 不得冒充）')
  truthy(quoted(arrayBlock(commentedList, 'val SUPPORTED_OPS', 'listOf(', ')')).length === 3,
    '未剥注释时注释里的 op 会被算进白名单（这条证明反例确实能红）')
  eq(quoted(arrayBlock(stripComments('val X = listOf("a", // b\n  "c")'), 'val X', 'listOf(', ')')), ['a', 'c'], '行注释只影响本行')
  eq(quoted(stripComments('val U = listOf("https://a/b")')), ['https://a/b'], '字符串里的 // 不算注释')

  // #1046 复现②：豁免条目必须写理由，且到期条件必须可核验
  const today = new Date('2026-10-30T00:00:00Z')
  truthy(gapEntryProblems({ op: 'ghostOp', faces: ['SUPPORTED_OPS'], reason: undefined }, 0, today).length > 0,
    '无 reason 的豁免必须判出（旧实现把 undefined 拼进 WARN 也算通过）')
  eq(gapEntryProblems({ op: 'ghostOp', faces: ['SUPPORTED_OPS'], reason: '因为 X 面的语义与 Y 无关，永久豁免，非临时缺口。' }, 0, today), [],
    '有理由、有合法面的豁免条目应当合规')
  truthy(gapEntryProblems({ op: 'ghostOp', faces: ['NOPE'], reason: 'x'.repeat(30) }, 0, today).length > 0, '未知 face 必须判出')
  truthy(gapEntryProblems({ op: 'ghostOp', faces: [], reason: 'x'.repeat(30) }, 0, today).length > 0, '缺 faces 必须判出')
  truthy(gapEntryProblems({ op: 'ghostOp', faces: ['SUPPORTED_OPS'], reason: 'x'.repeat(30), expires: '2020-01-01' }, 0, today).length > 0,
    '已过期的豁免必须判出（到期条件不得只是装饰）')
  eq(gapEntryProblems({ op: 'ghostOp', faces: ['SUPPORTED_OPS'], reason: 'x'.repeat(30), expires: '2027-01-01' }, 0, today), [],
    '未过期的显式到期条件应当放行')
  truthy(gapEntryProblems({ op: 'ghostOp', faces: ['SUPPORTED_OPS'], reason: 'x'.repeat(30), expires: '2027-01-01', permanent: true }, 0, today).length > 0,
    'expires 与 permanent 同时声明必须判出')
  truthy(gapEntryProblems({ op: 'ghostOp', faces: ['SUPPORTED_OPS'], reason: 'x'.repeat(30), permanent: false }, 0, today).length > 0,
    'permanent:false 必须判出（要撤销就删条目）')

  // 陈旧检查：从未被用到的豁免 = 已不再需要
  eq(staleGapEntries([{ op: 'a', faces: ['SUPPORTED_OPS'] }, { op: 'b', faces: ['A11Y_OPS'] }], new Set(['a::SUPPORTED_OPS'])),
    ['b::A11Y_OPS'], '未被六面比对用到的豁免必须判为陈旧')
  eq(duplicateGapPairs([{ op: 'a', faces: ['SUPPORTED_OPS'] }, { op: 'a', faces: ['SUPPORTED_OPS'] }]), ['a::SUPPORTED_OPS'], '重复豁免条目必须判出')
  console.log('SELF-TEST PASSED（31 断言：解析原语 + 豁免理由/到期/陈旧 + 注释剥离）')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()


const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const optOf = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

/** known-gaps：显式豁免面（每条必须写理由 + 到期条件）。文件缺省/数组为空 = 零豁免。
 *  --gaps <file> 仅供反向验证注入豁免面，正常门禁一律读取 ROOT/scripts/control-ops-known-gaps.json。 */
const GAPS_PATH = optOf('gaps') ?? join(ROOT, 'scripts', 'control-ops-known-gaps.json')
const gaps = existsSync(GAPS_PATH) ? (JSON.parse(readFileSync(GAPS_PATH, 'utf8')).gaps ?? []) : []
const gapFor = (op, face) => gaps.find((g) => g.op === op && (g.faces ?? []).includes(face))

const failures = []
const warnings = []
/** 本轮六面比对真正用到的豁免 (op::face) —— 没被用到 = 豁免已不再需要（陈旧）。 */
const usedExemptions = new Set()
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
/** known-gaps 里声明的缺口算 WARN（不拒），未声明的一律 FAIL。 */
const exempt = (op, face) => {
  const gap = gapFor(op, face)
  if (!gap) return false
  const line = face + ' 豁免 ' + op + ' -> ' + gap.reason
  usedExemptions.add(op + '::' + face)
  if (!warnings.includes(line)) {
    warnings.push(line)
    console.log('WARN  ' + line)
  }
  return true
}

// ── 豁免面自身的判据（issue #1046 复现②）──────────────────────────────────────
// 旧实现只把 gap.reason 拼进 WARN：没有理由（打印 undefined）、面名写错、条目早就
// 不再需要，三种情况都照样 PASSED。下面三条把它们变成可判红的判据。
{
  const problems = gaps.flatMap((entry, index) => gapEntryProblems(entry, index))
  check('已知缺口豁免条目合规（op / faces / reason / 到期条件）', problems.length === 0,
    problems.slice(0, 4).join('；') + (problems.length > 4 ? ' 等 ' + problems.length + ' 项' : ''))
  const noHorizon = gapsWithoutHorizon(gaps)
  check('新增豁免必须声明到期条件（expires / permanent；存量冻结 <= ' + NO_HORIZON_BASELINE + ' 条）',
    noHorizon.length <= NO_HORIZON_BASELINE,
    '无到期条件 ' + noHorizon.length + ' 条 > 冻结上限 ' + NO_HORIZON_BASELINE + '：' + noHorizon.map((e) => e.op).slice(0, 6).join(', '))
  const dup = duplicateGapPairs(gaps)
  check('已知缺口豁免条目无重复 (op, face)', dup.length === 0, '重复: ' + dup.join(', '))
}

// ── 树定位 ──────────────────────────────────────────────────────────────────
const SHELL_MARK = join('app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'DeviceControlService.kt')
const PLUGIN_MARK = join('plugins', 'dsh-android-bridge', 'src', 'control-policy.ts')
const treeFor = (override, mark, label) => {
  const candidates = override ? [override] : [ROOT, join(ROOT, 'dsh-mobile-apk')]
  const hit = candidates.find((c) => existsSync(join(c, mark)))
  if (!hit) {
    console.error('CHECK-CONTROL-OPS FAILED：找不到' + label + '（标记 ' + mark + '）\n  候选：' + candidates.join('、'))
    process.exit(1)
  }
  return hit
}
const SHELL_ROOT = treeFor(optOf('shell-root'), SHELL_MARK, '壳侧树')
const PLUGIN_ROOT = treeFor(optOf('plugin-root'), PLUGIN_MARK, '插件树')
console.log('壳侧树: ' + (rel(SHELL_ROOT) || SHELL_ROOT) + '  插件树: ' + (rel(PLUGIN_ROOT) || PLUGIN_ROOT))

const readOrDie = (p) => {
  if (!existsSync(p)) { console.error('CHECK-CONTROL-OPS FAILED：源文件缺席 ' + rel(p)); process.exit(1) }
  return readFileSync(p, 'utf8')
}
/** 读源码并**剥注释**：六面登记面一律从这个文本里取（注释里的 op 不构成登记）。 */
const readCode = (p) => stripComments(readOrDie(p))
const failParse = (what) => { console.error('CHECK-CONTROL-OPS FAILED：解析不到 ' + what + '（形态可能已变）'); process.exit(1) }


// 1) 壳侧 handle when 分支
const svc = readCode(join(SHELL_ROOT, SHELL_MARK))
const iHandle = svc.indexOf('fun handle(op: String, args: JSONObject)')
if (iHandle < 0) failParse('DeviceControlService.handle')
// 行首锚定：注释/字符串里出现的 "else -> error" 不得截断 when 块（dev-shell2 的注释曾让 15 个分支被算漏 → 假红）。
const elseLine = /^[ \t]*else\s*->/m.exec(svc.slice(iHandle))
const jHandle = elseLine ? iHandle + elseLine.index : -1
const handleBlock = svc.slice(iHandle, jHandle < 0 ? svc.length : jHandle)
const shellHandle = new Set([...handleBlock.matchAll(/^\s*"([A-Za-z]+)"\s*->/gm)].map((m) => m[1]))
if (shellHandle.size === 0) failParse('handle 的 when 分支')

// 2) 壳侧 SUPPORTED_OPS
const proto = readCode(join(SHELL_ROOT, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'ControlProtocolV2.kt'))
const supportedBlock = arrayBlock(proto, 'val SUPPORTED_OPS', 'listOf(', ')')
if (supportedBlock === null) failParse('ControlProtocolV2.SUPPORTED_OPS')
const shellSupported = new Set(quoted(supportedBlock))

// 3) 引擎 ControlOp
const policy = readCode(join(PLUGIN_ROOT, PLUGIN_MARK))
const opBlock = unionBlock(policy, 'export type ControlOp =')
if (opBlock === null) failParse('control-policy.ts 的 ControlOp')
const engineOps = new Set(quoted(opBlock))

// 4) 引擎 A11Y_OPS
const a11yBlock = arrayBlock(policy, 'export const A11Y_OPS', '= [', ']')
if (a11yBlock === null) failParse('control-policy.ts 的 A11Y_OPS')
const a11yOps = new Set(quoted(a11yBlock))

// 5) 引擎 ROUTE_OPS
const bridge = readCode(join(PLUGIN_ROOT, 'plugins', 'dsh-android-bridge', 'src', 'index.ts'))
const routeBlock = arrayBlock(bridge, 'const ROUTE_OPS', '= [', ']')
if (routeBlock === null) failParse('index.ts 的 ROUTE_OPS')
const routeOps = new Set(quoted(routeBlock))

// 6b) 壳侧 ControlCarrier 的 neverA11y 直连路由集合（0.14.0 设备实锤补线）
// 这一面此前**完全没被门禁覆盖**，后果不是「拒绝服务」而是**误导性错误**：
// browserTabs（= browser_list_tabs）漏登记时，op 落进 a11y 分支，模型收到「需要无障碍服务支持」
// ——它与无障碍毫无关系，于是模型去开无障碍。同类漏登记必须由门禁挡住。
const carrier = readCode(join(SHELL_ROOT, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'ControlCarrier.kt'))
const carrierOps = new Set()
for (const symbol of ['BROWSER_OPS', 'VD_OPS', 'SHELL_OPS']) {
  const block = arrayBlock(carrier, 'val ' + symbol, 'setOf(', ')')
  if (block === null) failParse('ControlCarrier.' + symbol)
  for (const op of quoted(block)) carrierOps.add(op)
}
if (carrierOps.size === 0) failParse('ControlCarrier 的 neverA11y 路由集合')

// 6) manage 工具面（实参集合；支持 a11yExec(<ident>) 的 const 三目解析）
const manage = readCode(join(PLUGIN_ROOT, 'plugins', 'dsh-android-manage', 'src', 'index.ts'))
const manageOps = new Set([...manage.matchAll(/(?:a11yExec|controlExec)\(\s*'([A-Za-z]+)'/g)].map((m) => m[1]))
for (const m of manage.matchAll(/(?:a11yExec|controlExec)\(\s*([A-Za-z_$][\w$]*)/g)) {
  const decl = manage.match(new RegExp('const\\s+' + m[1] + '\\s*=[^\\n]*'))
  if (decl) for (const op of quoted(decl[0])) manageOps.add(op)
}
if (manageOps.size === 0) failParse('manage 的 a11yExec/controlExec 实参')

const show = (n, s) => console.log('  ' + n.padEnd(16) + ' [' + [...s].sort().join(', ') + ']')
console.log('六处登记面：')
show('handle', shellHandle)
show('SUPPORTED_OPS', shellSupported)
show('ControlCarrier', carrierOps)
show('ControlOp', engineOps)
show('A11Y_OPS', a11yOps)
show('ROUTE_OPS', routeOps)
show('manage 工具面', manageOps)

// 族归属（D 项按族校验工具面 owner；Lead 裁决 2026-09-12）：browser*/vd* 的工具由各自插件注册，
// manage 不承载它们——但主体仍必须与 handle/SUPPORTED_OPS 一致（A/B/C 项不变）。
// review §2.3（2026-09-14）：旧实现把「台账缺失」降级 WARN 不判红——一次并批提交的秒级并发窗口
// 就足以让 D 项整段失效，属假绿。现改为：短重试（3 × 150ms）消化并发窗口；仍缺段/不可解析即 FAIL。
/** 台账路径。`--ledger <file>` 只给测试用（`scripts/check-control-ops.test.mjs` 要拿临时台账把
 *  六面判据完全隔离出来）；正常门禁一律读仓库台账。 */
const PENDING_PATH = optOf('ledger') ?? join(ROOT, 'scripts', 'control-ops-pending.json')
let ledger = null
let ledgerError = null
for (let attempt = 0; attempt < 3 && ledger === null; attempt += 1) {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_PATH, 'utf8'))
    if (parsed.families !== undefined && parsed.pending !== undefined) ledger = parsed
    else ledgerError = '缺段（families=' + (parsed.families === undefined ? '缺' : '在场')
      + ' / pending=' + (parsed.pending === undefined ? '缺' : '在场') + '）'
  } catch (e) {
    ledgerError = String(e).slice(0, 160)
  }
  if (ledger === null && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150))
}
if (ledger === null) {
  check('控制 op 台账可解析且含 families/pending 段（' + rel(PENDING_PATH) + '）', false, ledgerError ?? '不可解析')
  ledger = {}
}
const pendingFamilies = ledger.families ?? []
const familyOps = new Set(pendingFamilies.flatMap((fam) => fam.ops ?? []))
const withoutFamily = (set) => new Set([...set].filter((op) => !familyOps.has(op)))

const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort()
const setEq = (label, a, b, aName, bName, face) => {
  const onlyA = diff(a, b).filter((op) => !exempt(op, face))
  const onlyB = diff(b, a).filter((op) => !exempt(op, face))
  check(label, onlyA.length === 0 && onlyB.length === 0,
    aName + ' 独有=[' + onlyA.join(', ') + ']；' + bName + ' 独有=[' + onlyB.join(', ') + ']')
}

setEq('handle 分支 == SUPPORTED_OPS', shellHandle, shellSupported, 'handle', 'SUPPORTED_OPS', 'SUPPORTED_OPS')
setEq('ControlOp == SUPPORTED_OPS', engineOps, shellSupported, 'ControlOp', 'SUPPORTED_OPS', 'ControlOp')
setEq('A11Y_OPS == ControlOp', a11yOps, engineOps, 'A11Y_OPS', 'ControlOp', 'A11Y_OPS')
const manageOnly = diff(withoutFamily(manageOps), withoutFamily(shellSupported)).filter((op) => !exempt(op, 'manage'))
const supportedOnly = diff(withoutFamily(shellSupported), withoutFamily(manageOps)).filter((op) => !exempt(op, 'manage'))
// review §2.3：台账在场（哪怕 families=[]）差集非空一律判红；不再有「缺段降级 WARN」分支。
check('manage 工具面 == SUPPORTED_OPS（族外 op）', manageOnly.length === 0 && supportedOnly.length === 0,
  'manage 独有=[' + manageOnly.join(', ') + ']；SUPPORTED_OPS 独有=[' + supportedOnly.join(', ') + ']')

// D2. ControlCarrier 的 neverA11y 路由集合 ⊇ 契约全部 neverA11y op（0.14.0 补线）
// 缺一条 = 该 op 落进 a11y 分支报**误导性错误**（实测 browserTabs 让模型去开无障碍）。
// 只查「契约里的 neverA11y op 是否都被路由」，不要求反向相等：集合里多写的 op 无害（仍进同一分支）。
const carrierMissing = [...familyOps].filter((op) => !carrierOps.has(op) && !exempt(op, 'handle')).sort()
check('ControlCarrier 路由 ⊇ 契约 neverA11y op（漏登记即报误导性错误）', carrierMissing.length === 0,
  '未登记: [' + carrierMissing.join(', ') + ']（会落进 a11y 分支并返回「需要无障碍」）')

// E. ROUTE_OPS 声明为子集（诊断面只列常用 op）
const routeOut = diff(routeOps, engineOps).filter((op) => !exempt(op, 'ROUTE_OPS'))
check('ROUTE_OPS ⊂ ControlOp（诊断面子集，非空）', routeOps.size > 0 && routeOut.length === 0,
  '越界=[' + routeOut.join(', ') + ']')

// F. longClick 存量漂移专项（壳侧在场 → 引擎两处必须同批登记）
const longClickOk = !shellSupported.has('longClick') || (engineOps.has('longClick') && a11yOps.has('longClick'))
const longClickExempt = exempt('longClick', 'ControlOp') || exempt('longClick', 'A11Y_OPS')
check('longClick 已收口（壳侧 handle 与引擎 ControlOp/A11Y_OPS 同批登记）', longClickOk || longClickExempt,
  '壳侧 handle ' + (shellSupported.has('longClick') ? '在场' : '缺席')
  + '，ControlOp ' + (engineOps.has('longClick') ? '在场' : '缺席')
  + '，A11Y_OPS ' + (a11yOps.has('longClick') ? '在场' : '缺席')
  + '；修法见 0.13.8 验收计划 B-AC-07（ControlOp 补成员 + 纳入 A11Y_OPS）')


// ── G. 新插件 op 族：所有权（families）+ 待落地面（pending）核对 ────────────────
// 契约先冻结、六处按族落地。本段：① ops 必须与契约逐字一致；② neverA11y 的 op 进 A11Y_OPS 即 FAIL；
// ③ 落在 neverFaces（A11Y_OPS / ROUTE_OPS / manage）即 FAIL；④ 落在 neither faces 也非 neverFaces
// 的面即 FAIL（未声明面）；⑤ faces 里未落地的面：有 pending 条目声明则 WARN，无声明则 FAIL；
// ⑥ pending 条目声明的面**全部落地**即 stale FAIL（删除该条，强制收口）。ROUTE_OPS 本批不落
// （诊断面列 neverA11y op 会播错误指引），故写入 neverFaces。
const FACES = {
  handle: shellHandle, SUPPORTED_OPS: shellSupported, ControlOp: engineOps,
  A11Y_OPS: a11yOps, ROUTE_OPS: routeOps, manage: manageOps,
}
const pendingEntries = ledger.pending ?? []
for (const fam of pendingFamilies) {
  const src = readCode(join(PLUGIN_ROOT, fam.source))
  // 契约可能是对象字面量（BROWSER_OPS = { k: 'browserX' }）或数组（VD_OPS = ['vdX']）：
  // 取符号之后**先出现**的那种形态，避免括号搜索越过边界抓到后面的常量（本轮实测抓到 VIEWPORT_PRESETS）。
  const symAt = src.indexOf(fam.symbol)
  const objAt = src.indexOf('= {', symAt)
  const arrAt = src.indexOf('= [', symAt)
  const useObj = objAt >= 0 && (arrAt < 0 || objAt < arrAt)
  const ops = new Set(quoted(arrayBlock(src, fam.symbol, useObj ? '= {' : '= [', useObj ? '}' : ']') ?? ''))
  if (ops.size === 0) failParse('pending 族 ' + fam.id + ' 的 ' + fam.symbol + '（契约形态已变）')
  const declared = new Set(fam.ops ?? [])
  const mismatch = [...ops].filter((o) => !declared.has(o)).concat([...declared].filter((o) => !ops.has(o)))
  check('pending 族 ' + fam.id + ' 的 ops 与契约一致（' + ops.size + ' 条）', mismatch.length === 0,
    '不一致: [' + mismatch.join(', ') + ']（请同步 scripts/control-ops-pending.json）')
  // 工具面 owner（D 项的族内半边）：owner 文件必须在场且引用该族的契约符号——防「手抄 op 清单」式漂移。
  let toolSurfaceOk = false
  if (fam.toolSurface) {
    const tsPath = join(PLUGIN_ROOT, fam.toolSurface.file)
    if (!existsSync(tsPath)) {
      check('族 ' + fam.id + ' 的 toolSurface owner 在场: ' + fam.toolSurface.file, false, '文件缺席')
    } else {
      const tsText = stripComments(readFileSync(tsPath, 'utf8'))
      const refs = (tsText.match(new RegExp('\\b' + fam.toolSurface.symbol + '\\b', 'g')) || []).length
      const literals = [...ops].filter((op) => tsText.includes("'" + op + "'")).length
      toolSurfaceOk = refs > 0
      check('族 ' + fam.id + ' 的 toolSurface 引用契约符号 ' + fam.toolSurface.symbol + '（' + fam.toolSurface.file + '）',
        toolSurfaceOk, '引用次数 = 0（工具面与 op 契约脱钩？）')
      console.log('       toolSurface：符号引用 ' + refs + ' 次，op 字面量 ' + literals + '/' + ops.size + ' 条'
        + (fam.toolSurface.note ? '；' + fam.toolSurface.note : ''))
    }
  }
  const requiredFaces = new Set(fam.faces ?? [])
  const neverFaces = new Set(fam.neverFaces ?? [])
  const pend = pendingEntries.find((e) => e.family === fam.id)
  const pendingFaces = new Set(pend?.faces ?? [])
  let missingRequired = 0
  for (const op of [...ops].sort()) {
    const inFaces = Object.keys(FACES).filter((name) => FACES[name].has(op))
    if (fam.neverA11y && inFaces.includes('A11Y_OPS')) {
      check(op + ' 不得进 A11Y_OPS（契约 neverA11y）', false,
        '出现在 A11Y_OPS —— browser*/vd* 是壳桥 op，不经无障碍通道（方案 §4.5）')
    }
    for (const face of inFaces) {
      if (neverFaces.has(face) && face !== 'A11Y_OPS') {
        check(op + ' 不得进 ' + face + '（' + fam.id + ' 的 neverFaces：按设计不落该面）', false,
          '出现在 ' + face + ' —— 见 scripts/control-ops-pending.json 的 reason')
      }
    }
    const undeclaredFaces = inFaces.filter((name) => !requiredFaces.has(name) && !neverFaces.has(name))
    if (undeclaredFaces.length > 0) {
      check(op + ' 的落地只在 faces 声明内（' + fam.id + '）', false, '出现在未声明的面: [' + undeclaredFaces.join(', ') + ']')
    }
    // toolSurface 是「工具面 owner」而非 op 集合：其落地状态 = owner 文件在场且引用契约符号。
    const lack = [...requiredFaces].filter((name) => (name === 'toolSurface' ? !toolSurfaceOk : !inFaces.includes(name)))
    if (lack.length > 0) missingRequired += 1
  }
  if (missingRequired > 0) {
    const declaredMissing = [...requiredFaces].filter((face) => !pendingFaces.has(face))
    if (pendingFaces.size === 0 || declaredMissing.length > 0) {
      check('族 ' + fam.id + ' 的待落地面已声明 pending', false,
        '未落地且未在 pending 里声明的面: [' + declaredMissing.join(', ') + ']（请补 pending 条目或落地）')
    } else {
      console.log('WARN  族 ' + fam.id + ' 仍有待落地面 [' + [...pendingFaces].join(', ') + ']（pending 条目在场，stale 判定只按这些面）')
    }
  }
  if (pend) {
    const landedDeclared = [...pendingFaces].every((face) => face === 'toolSurface'
      ? toolSurfaceOk
      : (!FACES[face] || [...ops].every((op) => FACES[face].has(op))))
    if (landedDeclared && missingRequired === 0) {
      check('族 ' + fam.id + ' 的 pending 条目已 stale（声明的面全部落地）', false,
        '请从 scripts/control-ops-pending.json 删除该 pending 条目（所有权条目 families 保留）')
    }
  }
}
if (pendingFamilies.length > 0) {
  console.log('INFO  op 族所有权 ' + pendingFamilies.length + ' 族/'
    + pendingFamilies.reduce((n, f) => n + (f.ops ?? []).length, 0) + ' op；待落地面条目 '
    + pendingEntries.length + ' 条（来源 scripts/control-ops-pending.json）')
}

// ── 陈旧豁免（issue #1046 后半）：豁免已不再需要 ─────────────────────────────
// exempt() 只在「差集里真的出现了该 op」时被调用；某个 (op, face) 一轮下来从未被用到，
// 说明六面已经一致 —— 这条豁免不再豁免任何东西，留着只会让后来的真漂移被一起放行。
{
  const stale = staleGapEntries(gaps, usedExemptions)
  check('已知缺口豁免无陈旧条目（六面已一致 ⇒ 该豁免已不再需要，请删除）', stale.length === 0,
    '陈旧: ' + stale.slice(0, 6).join(', ') + (stale.length > 6 ? ' 等 ' + stale.length + ' 条' : '')
      + '（判据口径：本轮六面比对从未触发该豁免 = 该面已补齐）')
}

if (warnings.length > 0) console.log('WARN  已知缺口豁免 ' + warnings.length + ' 条（来源 scripts/control-ops-known-gaps.json）')
if (failures.length > 0) {
  console.error('CHECK-CONTROL-OPS FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
console.log('CHECK-CONTROL-OPS PASSED')
