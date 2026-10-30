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
    // 只认**行首**（去缩进后）就是注解的行：注释里提到 `@JavascriptInterface` 的行也含这个词，
    // 用 includes 会把紧随其后的任意 `fun`（含私有辅助函数）收进桥面清单
    // （实测：`/** … @JavascriptInterface … */` 之后紧跟 `private fun helper()` 时，
    // helper 会被当成桥方法 ⇒ 页面侧没有它就误报红，或者把它登记进 kotlinOnly 稀释真实面）。
    if (!lines[i].trim().startsWith('@JavascriptInterface')) continue
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

/**
 * 页面侧 **JS 调用点**成员名（G-6，2026-09-25）：`marker` 之后出现的 `.<method>` 调用名去重。
 *
 * 为什么需要第三种取面：前两种（tsBlock / tsInlineBlock）都假定页面侧有一份 TS 类型声明。
 * ConsoleActivity 的 ConsoleBridge 没有——它的消费者是 `assets/console.html` 里的**普通 JS**，
 * 直接调 `window.consoleBridge.<m>()`。这类桥面此前**不在任何门禁扫描面**（本门禁只扫
 * androidBridge / backGateBridge），于是删掉一个方法没有任何门禁会红。
 * 取调用点而不是发明一份 TS 声明：调用点就是真实消费者，「页面在调而壳侧没有」正是要抓的悬空面。
 * @param text - 页面资产全文（HTML/JS 均可）。
 * @param marker - 桥对象在页面里的引用前缀，如 `window.consoleBridge`。
 * @returns 去重后的方法名数组（保持首次出现顺序）。
 */
export function jsCallSites(text, marker) {
  // 用 indexOf 逐次推进做**字面量**前缀匹配：marker 是固定串（含点号），本来就不需要正则转义，
  // 也就避开了在字符串里嵌正则转义序列的坑（本文件此前在这上面翻过车）。
  const out = []
  let rest = String(text ?? '')
  const prefix = marker + '.'
  for (;;) {
    const at = rest.indexOf(prefix)
    if (at < 0) break
    const after = rest.slice(at + prefix.length)
    const m = /^([A-Za-z0-9_]+)/.exec(after)
    if (m && !out.includes(m[1])) out.push(m[1])
    rest = after
  }
  return out
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
/** 各 surface 的壳侧方法名集合（preferenceGetters 登记核对用）。 */
const surfaceMethods = new Map()

// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径（壳侧 Kotlin 在本仓根）。
const resolveRepoPath = (rel) => {
  const cands = rel.startsWith('dsh-mobile-apk/') ? [rel, rel.slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
/**
 * 纯函数：一面桥的对称性差异（G-6 抽出，便于 --self-test 用合成输入做反向断言）。
 * @param surface - baseline 的一条 surface 描述（只需 id；pairs 从外传入）。
 * @param kotlinMethods - 壳侧 @JavascriptInterface 方法名。
 * @param pageMembers - 页面侧成员名（TS 类型面成员，或普通 JS 调用点）。
 * @param declaredPairs - 该面的显式 setter/getter 声明对。
 * @returns {{kotlinOnly: string[], tsOnly: string[], setterWithoutGetter: string[], pairMisses: string[]}}
 */
export function diffSurface(surface, kotlinMethods, pageMembers, declaredPairs = []) {
  const tsSet = new Set(pageMembers)
  const kotlinSet = new Set(kotlinMethods)
  const out = { kotlinOnly: [], tsOnly: [], setterWithoutGetter: [], pairMisses: [] }
  for (const m of kotlinMethods) if (!tsSet.has(m)) out.kotlinOnly.push(keyOf(surface.id, m))
  for (const m of pageMembers) if (!kotlinSet.has(m)) out.tsOnly.push(keyOf(surface.id, m))
  for (const m of kotlinMethods) {
    const token = setterToken(m)
    if (token === null) continue
    const pair = declaredPairs.find((p) => p.setter === m)
    if (pair) {
      if (!(kotlinSet.has(pair.setter) && kotlinSet.has(pair.getter))) out.pairMisses.push(keyOf(surface.id, pair.setter))
      continue
    }
    const hasGetter = kotlinMethods.some((g) => getterToken(g) === token)
    if (!hasGetter) out.setterWithoutGetter.push(keyOf(surface.id, m))
  }
  return out
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
  surfaceMethods.set(surface.id, new Set(kotlinMethods))
  const tsText = readFileSync(tsPath, 'utf8')
  // G-6（2026-09-25）：第三种取面 —— 页面侧是**普通 JS 调用点**而非 TS 类型声明时（ConsoleBridge
  // 的消费者是 assets/console.html），用 jsCallSites 从真实调用点取成员名。此前这类桥面不在任何
  // 门禁扫描面，删一个方法没有任何门禁会红。
  const tsMembers = surface.jsCallMarker
    ? jsCallSites(tsText, surface.jsCallMarker)
    : tsDeclaredMembers(tsText, surface.tsBlock, surface.tsInlineBlock)
  if (tsMembers === null) { check('surface ' + surface.id + ' 类型面可解析', false); continue }
  // 面尺寸断言：壳侧方法与页面成员都必须非空。空集会让「三张差异表」全空 => 假绿，
  // 所以这条不是装饰：它是「取面失效（改动选择器/文件改名）时判红」的那道闸。
  check('surface ' + surface.id + '：壳侧 ' + kotlinMethods.length + ' 个 @JavascriptInterface / '
    + (surface.jsCallMarker ? '页面调用点 ' : '类型面 ') + tsMembers.length + ' 个成员',
    kotlinMethods.length > 0 && tsMembers.length > 0)
  const declaredPairs = baseline.pairs.filter((p) => p.surface === surface.id)
  const d = diffSurface(surface, kotlinMethods, tsMembers, declaredPairs)
  for (const m of d.pairMisses) check('声明对在场：' + m + ' ↔ ' + '（基线声明）', false, '一侧缺席')
  report.kotlinOnly.push(...d.kotlinOnly)
  report.tsOnly.push(...d.tsOnly)
  report.setterWithoutGetter.push(...d.setterWithoutGetter)
}

const sortAll = (arr) => [...new Set(arr)].sort()
report.kotlinOnly = sortAll(report.kotlinOnly)
report.tsOnly = sortAll(report.tsOnly)
report.setterWithoutGetter = sortAll(report.setterWithoutGetter)
// review §2.3（2026-09-14）：preferenceGetters 是**登记清单**（「返回值是偏好不是事实」的语义无法自动
// 推导）——旧实现把基线条目抄进 report 再与基线 compare（同义反复，永远绿）。现改为逐条核对
// 「壳侧方法真实存在」+「reason 在场」；新增不对称仍由 kotlinOnly/tsOnly/setterWithoutGetter 拦截。

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

// preferenceGetters：登记核对（存在 + reason），而非与基线自我比对。
for (const p of baseline.preferenceGetters) {
  const methods = surfaceMethods.get(p.surface)
  if (methods === undefined) {
    check('preferenceGetters surface 在场: ' + p.surface, false, '基线 surface 未解析到壳侧文件')
    continue
  }
  check('preferenceGetters 壳侧方法存在: ' + keyOf(p.surface, p.method), methods.has(p.method),
    '壳侧无该方法（登记 stale 或方法名写错）')
  if (!p.reason || !String(p.reason).trim()) check('preferenceGetters 条目有 reason: ' + p.method, false)
}


// ── --self-test：反向对照（G-6，2026-09-25）──────────────────────────────────
//
// 为什么必须有：G-6 的交付物是「把 ConsoleBridge 纳入扫描面」。若只把 surface 加进 baseline
// 而不证明「删一个方法真的会红」，那条接线等于没接（门禁照样全绿，防线照样消失）。
// 本自检用**合成输入**驱动与生产完全相同的 diffSurface，证明四个方向都能红、正常输入能绿。
function selfTest() {
  const st = []
  const check = (label, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
    if (!ok) st.push(label)
  }
  const surface = { id: 'consoleBridge' }
  const shell = ['submit', 'engineStatus', 'close', 'restart', 'copyText', 'ready', 'resize', 'writeKeys', 'writeRaw', 'hasPty']
  const page = ['engineStatus', 'submit', 'close', 'copyText', 'restart', 'resize', 'writeKeys', 'hasPty']

  // ① 正向：真实现状（壳侧 10 / 页面调用点 8）→ ready 与 writeRaw 是 kotlinOnly，无 tsOnly。
  //    writeRaw 只由 submit 在壳内调用，页面走 writeKeys（控制字符必须编码过桥）。
  {
    const d = diffSurface(surface, shell, page)
    check('① 现状：kotlinOnly 恰为 [consoleBridge/ready, consoleBridge/writeRaw]，tsOnly 为空',
      JSON.stringify(d.kotlinOnly) === JSON.stringify(['consoleBridge/ready', 'consoleBridge/writeRaw']) && d.tsOnly.length === 0,
      JSON.stringify(d))
  }

  // ② 反向：删掉壳侧 copyText（页面在调）→ 必须出现在 tsOnly（悬空声明=调用必失败）。
  {
    const d = diffSurface(surface, shell.filter((m) => m !== 'copyText'), page)
    check('② 反向：删壳侧 copyText（页面在调）→ tsOnly 点名 consoleBridge/copyText',
      d.tsOnly.includes('consoleBridge/copyText'), JSON.stringify(d.tsOnly))
  }

  // ③ 反向：仅把壳侧留 1 个 → 其余页面调用点全部悬空（成批删也抓得住）。
  {
    const d = diffSurface(surface, ['submit'], page)
    check('③ 反向：壳侧只剩 submit → 其余 7 个页面调用点全部 tsOnly',
      d.tsOnly.length === 7 && !d.tsOnly.includes('consoleBridge/submit'), JSON.stringify(d.tsOnly))
  }

  // ④ 反向：页面调用点解析失效（jsCallMarker 改名 → 空集）→ 全部壳侧方法报 kotlinOnly
  //    （这就是「取面失效」的形态：不是静默全绿，而是整面漂移可判）。
  {
    const d = diffSurface(surface, shell, [])
    check('④ 反向：页面取面空集 → 10 个壳侧方法全 kotlinOnly（取面失效不静默）',
      d.kotlinOnly.length === 10, JSON.stringify(d.kotlinOnly))
  }

  // ⑤ 反向：只写不读的 setter 必须进 setterWithoutGetter。
  {
    const d = diffSurface(surface, ['setFoo'], ['setFoo'])
    check('⑤ 反向：只有 setFoo 无 getter → setterWithoutGetter 点名',
      d.setterWithoutGetter.includes('consoleBridge/setFoo'), JSON.stringify(d.setterWithoutGetter))
  }

  // ⑥ 反向：基线声明对只有单侧在场 → pairMisses 点名。
  {
    const d = diffSurface(surface, ['setAvailable'], ['setAvailable'], [{ setter: 'setAvailable', getter: 'getBackAvailable' }])
    check('⑥ 反向：声明对只在一侧 → pairMisses 点名',
      d.pairMisses.includes('consoleBridge/setAvailable'), JSON.stringify(d.pairMisses))
  }

  // ⑥b 接线自证：baseline 里必须真的登记了 consoleBridge surface。
  //     若有人把 surface 条目删掉，生产循环就不会再扫这一面，而**所有断言仍会绿**——
  //     这正是 G-6 要防的「等于没接线」。故这条把「登记事实」本身钉成断言。
  {
    const s = baseline.surfaces.find((x) => x.id === 'consoleBridge')
    check('⑥b baseline 登记了 consoleBridge surface（删条目即判红，防「等于没接线」）',
      Boolean(s) && s.jsCallMarker === 'window.consoleBridge'
      && String(s.kotlin).includes('ConsoleActivity.kt') && String(s.ts).includes('console.html'),
      JSON.stringify(s ?? null))
  }

  // ⑦ jsCallSites 取面本身：真实 console.html 的调用点必须被取到（证明取面不是空转）。
  {
    const htmlPath = resolveRepoPath('dsh-mobile-apk/app/src/main/assets/console.html')
    const found = htmlPath === null ? [] : jsCallSites(readFileSync(htmlPath, 'utf8'), 'window.consoleBridge')
    check('⑦ jsCallSites 从真 console.html 取到 8 个调用点',
      found.length === 8 && found.includes('submit') && found.includes('engineStatus'), JSON.stringify(found))
    check('⑦b 页面用的是编码通道 writeKeys（控制字符必须编码过桥）',
      found.includes('writeKeys'), JSON.stringify(found))
  }

  // ⑧ 反向：坏输入（marker 不在文本里）→ 空集，不抛错。
  {
    const d = diffSurface(surface, ['a'], jsCallSites('no marker here', 'window.consoleBridge'))
    check('⑧ 反向：marker 不在文本 → jsCallSites 返回空集且不抛错（该面全部成员记为 kotlinOnly，不静默）',
      jsCallSites('no marker here', 'window.consoleBridge').length === 0 && d.kotlinOnly.length === 1 && d.tsOnly.length === 0,
      JSON.stringify(d))
  }

  console.log(st.length === 0 ? '\nBRIDGE-SYMMETRY SELF-TEST PASSED' : '\nBRIDGE-SYMMETRY SELF-TEST FAILED: ' + st.join('; '))
  process.exit(st.length === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) selfTest()

if (failures.length > 0) {
  console.error('CHECK-BRIDGE-SYMMETRY FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  console.error('（基线只许减少：新增不对称先修，或评审批准后在 scripts/bridge-symmetry-baseline.json 登记 reason）')
  process.exit(1)
}
console.log('CHECK-BRIDGE-SYMMETRY PASSED（kotlinOnly=' + report.kotlinOnly.length + ' tsOnly=' + report.tsOnly.length
  + ' setterWithoutGetter=' + report.setterWithoutGetter.length + ' preferenceGetters=' + report.preferenceGetters.length + '）')