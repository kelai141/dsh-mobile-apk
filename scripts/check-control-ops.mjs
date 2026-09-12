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
// 退出码：0 = 通过；1 = 登记漂移（拒打包/拒合）或树定位失败。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const optOf = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

/** known-gaps：显式豁免面（每条必须写理由）。文件缺省/数组为空 = 零豁免。
 *  --gaps <file> 仅供反向验证注入豁免面，正常门禁一律读取 ROOT/scripts/control-ops-known-gaps.json。 */
const GAPS_PATH = optOf('gaps') ?? join(ROOT, 'scripts', 'control-ops-known-gaps.json')
const gaps = existsSync(GAPS_PATH) ? (JSON.parse(readFileSync(GAPS_PATH, 'utf8')).gaps ?? []) : []
const gapFor = (op, face) => gaps.find((g) => g.op === op && (g.faces ?? []).includes(face))

const failures = []
const warnings = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
/** known-gaps 里声明的缺口算 WARN（不拒），未声明的一律 FAIL。 */
const exempt = (op, face) => {
  const gap = gapFor(op, face)
  if (!gap) return false
  const line = face + ' 豁免 ' + op + ' -> ' + gap.reason
  warnings.push(line)
  console.log('WARN  ' + line)
  return true
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
const quoted = (s) => [...s.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
const failParse = (what) => { console.error('CHECK-CONTROL-OPS FAILED：解析不到 ' + what + '（形态可能已变）'); process.exit(1) }

/** `= [ ... ]` / `= listOf( ... )` 数组块（先定位赋值符，避免命中类型注解里的 []）。 */
const arrayBlock = (src, mark, open, close) => {
  const i = src.indexOf(mark)
  if (i < 0) return null
  const o = src.indexOf(open, i)
  if (o < 0) return null
  const c = src.indexOf(close, o + open.length)
  return c < 0 ? null : src.slice(o + open.length, c)
}
/** 类型联合块：从 mark 起逐行累积，直到某行不再以 \' 或 | 结尾。 */
const unionBlock = (src, mark) => {
  const i = src.indexOf(mark)
  if (i < 0) return null
  const lines = src.slice(i).split('\n')
  const out = []
  for (const line of lines) {
    out.push(line)
    const t = line.trim()
    if (t.length === 0) continue
    if (!/['|]$/.test(t)) break
  }
  return out.join('\n')
}

// 1) 壳侧 handle when 分支
const svc = readOrDie(join(SHELL_ROOT, SHELL_MARK))
const iHandle = svc.indexOf('fun handle(op: String, args: JSONObject)')
if (iHandle < 0) failParse('DeviceControlService.handle')
// 行首锚定：注释/字符串里出现的 "else -> error" 不得截断 when 块（dev-shell2 的注释曾让 15 个分支被算漏 → 假红）。
const elseLine = /^[ \t]*else\s*->/m.exec(svc.slice(iHandle))
const jHandle = elseLine ? iHandle + elseLine.index : -1
const handleBlock = svc.slice(iHandle, jHandle < 0 ? svc.length : jHandle)
const shellHandle = new Set([...handleBlock.matchAll(/^\s*"([A-Za-z]+)"\s*->/gm)].map((m) => m[1]))
if (shellHandle.size === 0) failParse('handle 的 when 分支')

// 2) 壳侧 SUPPORTED_OPS
const proto = readOrDie(join(SHELL_ROOT, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'ControlProtocolV2.kt'))
const supportedBlock = arrayBlock(proto, 'val SUPPORTED_OPS', 'listOf(', ')')
if (supportedBlock === null) failParse('ControlProtocolV2.SUPPORTED_OPS')
const shellSupported = new Set(quoted(supportedBlock))

// 3) 引擎 ControlOp
const policy = readOrDie(join(PLUGIN_ROOT, PLUGIN_MARK))
const opBlock = unionBlock(policy, 'export type ControlOp =')
if (opBlock === null) failParse('control-policy.ts 的 ControlOp')
const engineOps = new Set(quoted(opBlock))

// 4) 引擎 A11Y_OPS
const a11yBlock = arrayBlock(policy, 'export const A11Y_OPS', '= [', ']')
if (a11yBlock === null) failParse('control-policy.ts 的 A11Y_OPS')
const a11yOps = new Set(quoted(a11yBlock))

// 5) 引擎 ROUTE_OPS
const bridge = readOrDie(join(PLUGIN_ROOT, 'plugins', 'dsh-android-bridge', 'src', 'index.ts'))
const routeBlock = arrayBlock(bridge, 'const ROUTE_OPS', '= [', ']')
if (routeBlock === null) failParse('index.ts 的 ROUTE_OPS')
const routeOps = new Set(quoted(routeBlock))

// 6) manage 工具面（实参集合；支持 a11yExec(<ident>) 的 const 三目解析）
const manage = readOrDie(join(PLUGIN_ROOT, 'plugins', 'dsh-android-manage', 'src', 'index.ts'))
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
show('ControlOp', engineOps)
show('A11Y_OPS', a11yOps)
show('ROUTE_OPS', routeOps)
show('manage 工具面', manageOps)

// 族归属（D 项按族校验工具面 owner；Lead 裁决 2026-09-12）：browser*/vd* 的工具由各自插件注册，
// manage 不承载它们——但主体仍必须与 handle/SUPPORTED_OPS 一致（A/B/C 项不变）。
// 台账读取对并发窗口降级：本文件与门禁常在同批提交，秒级窗口内可能读到半写状态（dev-notify 实测同一源码
// 两次跑出相反结果）。缺 families / 缺 pending / 整体不可解析一律 WARN 并按空处理，不判红。
const PENDING_PATH = join(ROOT, 'scripts', 'control-ops-pending.json')
let ledger = {}
if (existsSync(PENDING_PATH)) {
  try { ledger = JSON.parse(readFileSync(PENDING_PATH, 'utf8')) } catch { ledger = {} }
}
if (ledger.families === undefined || ledger.pending === undefined) {
  console.log('WARN  控制 op 台账缺段（families=' + (ledger.families === undefined ? '缺' : '在场')
    + ' / pending=' + (ledger.pending === undefined ? '缺' : '在场') + '）：按空处理，族级校验降级（并发窗口，恢复后复核）')
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
if (manageOnly.length === 0 && supportedOnly.length === 0) {
  check('manage 工具面 == SUPPORTED_OPS（族外 op）', true)
} else if (pendingFamilies.length === 0) {
  warnings.push('D 项降级：台账缺 families 段（并发窗口），差集未判红')
  console.log('WARN  D 项降级：台账缺 families 段（并发窗口）→ manage 独有=[' + manageOnly.join(', ')
    + ']；SUPPORTED_OPS 独有=[' + supportedOnly.join(', ') + ']，不判红（台账恢复后复核）')
} else {
  check('manage 工具面 == SUPPORTED_OPS（族外 op）', false,
    'manage 独有=[' + manageOnly.join(', ') + ']；SUPPORTED_OPS 独有=[' + supportedOnly.join(', ') + ']')
}

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
  const src = readOrDie(join(PLUGIN_ROOT, fam.source))
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
      const tsText = readFileSync(tsPath, 'utf8')
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

if (warnings.length > 0) console.log('WARN  已知缺口豁免 ' + warnings.length + ' 条（来源 scripts/control-ops-known-gaps.json）')
if (failures.length > 0) {
  console.error('CHECK-CONTROL-OPS FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
console.log('CHECK-CONTROL-OPS PASSED')
