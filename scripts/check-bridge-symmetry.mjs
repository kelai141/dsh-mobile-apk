#!/usr/bin/env node
// check-bridge-symmetry.mjs — 桥面对称性门禁（0.13.8-b ST-26）。
//
// 断言：扫描壳侧 @JavascriptInterface（AndroidBridge.kt 34 个 + BackGate.kt 的独立 BackGateBridge 对象）
// 与引擎侧类型声明（dsh-client-ui-responsive 的 android-bridge.ts / back-stack.ts），输出三类清单：
//   ① kotlinOnly：壳侧有实现、页面类型面未声明（页面直读却无类型=漂移温床）；
//   ② tsOnly：类型面声明了但壳侧无实现（悬空声明=调用必失败）；
//   ③ setterWithoutGetter：只写不读的 setter（设备侧状态必须有只读 getter，且 getter 返事实值）；
//   ④ preferenceGetters：getter 返回偏好而非事实的登记清单（评审面，逐条 reason）。
//
// 基线 scripts/bridge-symmetry-baseline.json：条目只许减少不许增加——新增不对称即 FAIL（反向验证：
// 加一个纯写方法必须红）；已修好的条目若仍留在基线也 FAIL（stale，强制删除）。
//
// 用法：node scripts/check-bridge-symmetry.mjs [--list]
// 退出码：0 = 与基线一致（无新增不对称、无 stale）；1 = 失败；2 = 基线/布局不可解析。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts', 'bridge-symmetry-baseline.json'), 'utf8'))

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/** 壳侧 @JavascriptInterface 方法名（可选 startMarker 限定对象/类区域）。 */
export function kotlinBridgeMethods(text, startMarker) {
  const region = startMarker ? text.slice(text.indexOf(startMarker)) : text
  const lines = region.split('\n')
  const names = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('@JavascriptInterface')) continue
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const m = /fun\s+([A-Za-z0-9_]+)\s*\(/.exec(lines[j])
      if (m) { names.push(m[1]); break }
    }
  }
  return names
}

/** 页面侧类型面成员名：block 形态（interface X { ... }）或 inline 形态（key?: { ... }）。 */
export function tsDeclaredMembers(text, blockMarker, inlineMarker) {
  if (blockMarker) {
    const start = text.indexOf(blockMarker)
    if (start < 0) return null
    const rest = text.slice(start + blockMarker.length)
    const end = rest.indexOf('\n}')
    const body = end < 0 ? rest : rest.slice(0, end)
    return [...body.matchAll(/^\s{2}([A-Za-z0-9_]+)\??\s*[:(]/gm)].map((m) => m[1])
  }
  if (inlineMarker) {
    const m = new RegExp(inlineMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(text)
    if (!m) return null
    // 逐成员切分后再取名：直接全局匹配会把参数名（available: boolean）当成成员名。
    return m[1].split(',').map((part) => (/^\s*([A-Za-z0-9_]+)\??\s*[:(]/.exec(part) ?? [])[1]).filter(Boolean)
  }
  return null
}

/** setter token（setXxx -> xxx；enableXxx -> xxx）。 */
// 前缀后必须紧跟大写字母：否则 `settingsPath` 会被误判成 setter（set + tingsPath）。
function setterToken(name) {
  const m = /^(?:set|enable)([A-Z][A-Za-z0-9_]*)$/.exec(name)
  return m ? m[1].toLowerCase() : null
}
function getterToken(name) {
  const m = /^(?:get|is|has|read)([A-Z][A-Za-z0-9_]*)$/.exec(name)
  return m ? m[1].toLowerCase() : null
}

const report = { kotlinOnly: [], tsOnly: [], setterWithoutGetter: [], preferenceGetters: [] }
const keyOf = (surface, name) => surface + '/' + name

// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径（壳侧 Kotlin 在本仓根）。
const resolveRepoPath = (rel) => {
  const cands = rel.startsWith('dsh-mobile-apk/') ? [rel, rel.slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
for (const surface of baseline.surfaces) {
  const kotlinPath = resolveRepoPath(surface.kotlin)
  const tsPath = resolveRepoPath(surface.ts)
  if (kotlinPath === null || tsPath === null) {
    check('surface ' + surface.id + ' 两文件在场', false,
      (kotlinPath ?? surface.kotlin) + ' | ' + (tsPath ?? surface.ts) + '（两仓布局均未命中）')
    continue
  }
  const kotlinMethods = kotlinBridgeMethods(readFileSync(kotlinPath, 'utf8'), surface.kotlinStart)
  const tsText = readFileSync(tsPath, 'utf8')
  const tsMembers = tsDeclaredMembers(tsText, surface.tsBlock, surface.tsInlineBlock)
  if (tsMembers === null) { check('surface ' + surface.id + ' 类型面可解析', false); continue }
  check('surface ' + surface.id + '：壳侧 ' + kotlinMethods.length + ' 个 @JavascriptInterface / 类型面 ' + tsMembers.length + ' 个成员',
    kotlinMethods.length > 0 && tsMembers.length > 0)
  const tsSet = new Set(tsMembers)
  const kotlinSet = new Set(kotlinMethods)
  for (const m of kotlinMethods) if (!tsSet.has(m)) report.kotlinOnly.push(keyOf(surface.id, m))
  for (const m of tsMembers) if (!kotlinSet.has(m)) report.tsOnly.push(keyOf(surface.id, m))
  const declaredPairs = baseline.pairs.filter((p) => p.surface === surface.id)
  for (const m of kotlinMethods) {
    const token = setterToken(m)
    if (token === null) continue
    const pair = declaredPairs.find((p) => p.setter === m)
    if (pair) {
      check('声明对在场：' + keyOf(surface.id, pair.setter) + ' ↔ ' + pair.getter,
        kotlinSet.has(pair.setter) && kotlinSet.has(pair.getter), '一侧缺席')
      continue
    }
    const hasGetter = kotlinMethods.some((g) => getterToken(g) === token)
    if (!hasGetter) report.setterWithoutGetter.push(keyOf(surface.id, m))
  }
}

const sortAll = (arr) => [...new Set(arr)].sort()
report.kotlinOnly = sortAll(report.kotlinOnly)
report.tsOnly = sortAll(report.tsOnly)
report.setterWithoutGetter = sortAll(report.setterWithoutGetter)
report.preferenceGetters = baseline.preferenceGetters.map((p) => keyOf(p.surface, p.method)).sort()

if (process.argv.includes('--list')) {
  for (const [k, v] of Object.entries(report)) {
    console.log('== ' + k + ' (' + v.length + ')')
    for (const x of v) console.log('   ' + x)
  }
  process.exit(0)
}

// ── 与基线比对：只许减少 ────────────────────────────────────────────────────
const baselineKeys = (kind) => new Set((baseline[kind] ?? []).map((e) => keyOf(e.surface, e.method ?? e.setter)))
const compare = (kind, actual) => {
  const base = baselineKeys(kind)
  const actualSet = new Set(actual)
  const added = actual.filter((k) => !base.has(k))
  const stale = [...base].filter((k) => !actualSet.has(k))
  check(kind + ' 无新增不对称（' + actual.length + ' 项）', added.length === 0, '新增: [' + added.join(', ') + ']')
  check(kind + ' 基线无 stale 条目（' + base.size + ' 项）', stale.length === 0, '已修好却仍声明: [' + stale.join(', ') + ']')
}
compare('kotlinOnly', report.kotlinOnly)
compare('tsOnly', report.tsOnly)
compare('setterWithoutGetter', report.setterWithoutGetter)
compare('preferenceGetters', report.preferenceGetters)

for (const p of baseline.preferenceGetters) {
  if (!p.reason || !String(p.reason).trim()) check('preferenceGetters 条目有 reason: ' + p.method, false)
}

if (failures.length > 0) {
  console.error('CHECK-BRIDGE-SYMMETRY FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  console.error('（基线只许减少：新增不对称先修，或评审批准后在 scripts/bridge-symmetry-baseline.json 登记 reason）')
  process.exit(1)
}
console.log('CHECK-BRIDGE-SYMMETRY PASSED（kotlinOnly=' + report.kotlinOnly.length + ' tsOnly=' + report.tsOnly.length
  + ' setterWithoutGetter=' + report.setterWithoutGetter.length + ' preferenceGetters=' + report.preferenceGetters.length + '）')
