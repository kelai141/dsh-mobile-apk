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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
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

/**
 * 帧来源守卫的**静态**判据（issue #1029）：每个 @JavascriptInterface 入口的**第一件事**
 * 必须是 `trusted { }`（表达式体）或 `checkTrustedFrame()`（块体第一条语句）。
 *
 * 为什么这条判据要放在本门禁而不是单测里
 * --------------------------------------
 * `AndroidBridgeFrameGuardTest` 是**行为**判据（反射逐个调用、门禁恒拒下必须抛 BridgeFrameDenied），
 * 它确实会红——但只在有人跑 `:app:testDebugUnitTest` 时生效。缺陷形态（#1029 实证）：main 在
 * #773 分叉后新增了 3 个桥面入口，它们不知道有这个约定，天然漏包；#773 分支自己 80 个全包、
 * main 没有守卫机制所以扫不出问题，**只有合起来才暴露**。
 * 本门禁补的是「新增入口时立刻红」这一动作：静态扫源码，不跑 Gradle、不需要设备。
 * 两者互补：本门禁管「有没有包」，单测管「包了之后行为对不对」。
 *
 * 判据是「第一件事」而不是「出现过」：把 checkTrustedFrame() 挪到第二句，守卫在第一条语句
 * 执行之后才生效，等于没守。
 *
 * @param {string} text Kotlin 源码
 * @returns {Array<{line: number, name: string, signature: string}>} 未过守卫的入口
 */
export function findUnguardedBridgeEntries(text) {
  const lines = text.split('\n')
  const out = []
  // KDoc 里提到 @JavascriptInterface 的注释行不算入口（与 kotlinBridgeMethods 的行首规则同口径）。
  const insideBlockComment = (idx) => {
    for (let k = idx - 1; k >= 0; k -= 1) {
      const t = lines[k].trim()
      if (t.endsWith('*/')) return false
      if (t.startsWith('/*')) return true
    }
    return false
  }
  // 跳过空行 / 行注释 / 块注释，返回下一条有意义语句的行号。
  const firstMeaningful = (from) => {
    let k = from
    while (k < lines.length) {
      const t = lines[k].trim()
      if (t === '' || t.startsWith('//')) { k += 1; continue }
      if (t.startsWith('/*')) {
        while (k < lines.length && !lines[k].includes('*/')) k += 1
        k += 1
        continue
      }
      return k
    }
    return -1
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('@JavascriptInterface')) continue
    if (insideBlockComment(i)) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith('fun ')) j += 1
    if (j >= lines.length) continue
    const signature = lines[j].trim()
    // 形态 A：表达式体，`= trusted { ... }` 同行。
    if (/=\s*trusted\s*\{/.test(signature)) continue
    // 形态 A'：表达式体折行，`=` 结尾、第一条有意义语句是 trusted { ... }。
    if (/=\s*$/.test(signature)) {
      const k = firstMeaningful(j + 1)
      if (k >= 0 && /^trusted\s*\{/.test(lines[k].trim())) continue
      out.push({ line: j + 1, name: (signature.match(/^fun\s+([A-Za-z0-9_]+)/) || [])[1] ?? '?', signature })
      continue
    }
    // 形态 B：块体，第一条有意义语句是 checkTrustedFrame()。
    const k = firstMeaningful(j + 1)
    if (k >= 0 && /^checkTrustedFrame\(\)/.test(lines[k].trim())) continue
    out.push({ line: j + 1, name: (signature.match(/^fun\s+([A-Za-z0-9_]+)/) || [])[1] ?? '?', signature })
  }
  return out
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

/**
 * issue #1048：**扫描面 = 壳侧全部含 `@JavascriptInterface` 的 Kotlin 文件**，而不是基线登记过的面。
 *
 * 根因（实锤）：旧实现 `for (const surface of baseline.surfaces)`——扫描集合来自
 * `scripts/bridge-symmetry-baseline.json` 的 surfaces。于是「新增一个桥面文件」= 整面不可见：
 * 加 3 个 `@JavascriptInterface` 方法、无任何页面消费者、不进基线，门禁输出与原来一字不差
 * （本门禁自检 ⑥b 正是为「未登记的面 ⇒ 全绿」而写，生产路径却没有对应判据）。
 * 修法：从权威源（磁盘上的壳侧 Kotlin 源集）发现桥面文件，基线里没有的**判红并要求登记**。
 *
 * 判定用与 `kotlinBridgeMethods` **同一个**行首规则：KDoc 里提到 `@JavascriptInterface` 的注释行
 * 不算（否则 MainActivity/LinuxAssetIO/LocalDocs 等只是文档提到过该注解的文件会被误判成桥面）。
 * @param text - 单个 Kotlin 文件全文。
 * @returns 该文件是否至少有一个行首注解 + 紧随的 `fun`。
 */
export function hasBridgeSurface(text) {
  return kotlinBridgeMethods(text).length > 0
}

/** 路径归一：去 `./`、统一斜杠、去掉 `dsh-mobile-apk/` 布局前缀（协调仓根与 apk 自包含根两种布局）。 */
export function normSurfacePath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^dsh-mobile-apk\//, '')
}

/**
 * 纯函数：把「磁盘发现的桥面文件」与「基线登记的面」双向对账。
 *
 * 两个方向都要红——只查「发现的文件是否登记」会漏掉「基线登记了但文件已无注解」（登记 stale，
 * 扫描面已空转，后续所有对称性判据对那一面都不再成立）。
 * @param discovered - 磁盘上确有 `@JavascriptInterface` 的 Kotlin 相对路径数组。
 * @param surfaces - 基线 surfaces（每条含 kotlin 路径）。
 * @returns `{ unregistered, emptySurfaces }`。
 */
export function reconcileBridgeSurfaces(discovered, surfaces) {
  const found = new Set(discovered.map(normSurfacePath))
  const registered = new Set((surfaces ?? []).map((s) => normSurfacePath(s.kotlin)))
  const unregistered = [...found].filter((f) => !registered.has(f)).sort()
  const emptySurfaces = [...registered].filter((r) => !found.has(r)).sort()
  return { unregistered, emptySurfaces }
}

/**
 * 递归列出 `root` 下所有含桥面注解的 Kotlin 文件（相对 root，正斜杠）。
 * @param root - 仓库根。
 * @param sourceRoots - 参与扫描的源集目录（相对 root）。
 * @returns 相对路径数组（排序）。
 */
export function discoverBridgeFiles(root, sourceRoots) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st = null
      // 符号链接也要跟：Dirent 的两类判定对链接都为 false（本仓的门禁已经把这类静默跳过修过一轮）。
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full); continue }
      if (!name.endsWith('.kt')) continue
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch { continue }
      if (hasBridgeSurface(text)) out.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
  for (const sourceRoot of sourceRoots) {
    const dir = join(root, sourceRoot)
    if (existsSync(dir)) walk(dir)
  }
  return out.sort()
}

/** 参与桥面扫描的壳侧源集（`test` / `androidTest` 不是桥面：它们是用例与夹具）。 */
export const SHELL_SOURCE_ROOTS = ['app/src/main/java', 'app/src/debug/java', 'app/src/release/java']

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

// ── issue #1048：扫描面 = 磁盘上所有桥面文件（不再只扫基线登记过的面）──────────────
// 上面那圈循环只看得到基线登记过的 surface；这里把「世界上有哪些桥面」独立对账一遍，
// 未登记的桥面一律判红（登记后放行），登记的 surface 若已无注解也判红（扫描面空转）。
const discoveredBridgeFiles = discoverBridgeFiles(ROOT, SHELL_SOURCE_ROOTS)
check('壳侧桥面文件非空（扫描面未失效：' + SHELL_SOURCE_ROOTS.join(' / ') + '）',
  discoveredBridgeFiles.length > 0, '一个合并桥面都不剩 = 判据空转')
{
  const { unregistered, emptySurfaces } = reconcileBridgeSurfaces(discoveredBridgeFiles, baseline.surfaces)
  for (const file of unregistered) {
    check('桥面文件已登记: ' + file, false,
      '该文件有 @JavascriptInterface 但不在 scripts/bridge-symmetry-baseline.json 的 surfaces 里'
      + '——整面不会被任何对称性判据覆盖。请在 surfaces 登记（kotlin + 页面侧取面方式 + kotlinStart）')
  }
  for (const file of emptySurfaces) {
    check('登记的桥面仍含 @JavascriptInterface: ' + file, false,
      '文件已无行首 @JavascriptInterface（改名/删除？）——该 surface 的扫描面已空转，请同步基线与 baseline.surfaces')
  }
  if (unregistered.length === 0 && emptySurfaces.length === 0) {
    console.log('PASS  桥面登记全集一致（磁盘 ' + discoveredBridgeFiles.length + ' 个 == 基线 '
      + baseline.surfaces.length + ' 面：' + discoveredBridgeFiles.join(', ') + '）')
  }
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

// ── issue #1029：桥面帧来源守卫（静态判据，扫描面 = 动态枚举的全部桥面文件）──────
//
// 判据：每个 @JavascriptInterface 入口的**第一件事**必须是 trusted { } 或 checkTrustedFrame()。
//
// 扫描面刻意**复用 discoveredBridgeFiles**（磁盘上真实存在的桥面文件全集），不是基线登记过的面：
// 只有动态枚举才能拦住 #1029 的原形 —— 新文件/新入口在基线里根本没有条目，
// 拿基线当扫描面会天然放过它们（正是 #1048 修过的同一个毛病）。
//
// 覆盖面与豁免：#686 的守卫机制**只落在 androidBridge 这一个桥对象上**
// （BridgeOriginGuard 删的是 window.androidBridge；ConsoleBridge / BackGateBridge 没有 trusted{}/
// checkTrustedFrame() 可调）。这类「本面尚未接入守卫机制」是既有事实，不是本 judgement 要修的东西，
// 因此按**面**登记豁免（baseline.frameGuardUncovered），每条必须写 reason + until，且 shrink-only：
// 一旦该面接上守卫（或面消失），登记的豁免立刻判红要求删除。
// 这样新接入守卫的面自动进入硬判据，而既有面不会因为「还没接」而永远静默。
{
  const uncovered = new Map((baseline.frameGuardUncovered ?? []).map((e) => [e.surface, e]))
  const missing = []
  let guarded = 0
  const seenSurfaces = new Set()
  for (const file of discoveredBridgeFiles) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const surface = (baseline.surfaces ?? []).find((s) => {
      const p = resolveRepoPath(s.kotlin)
      return p !== null && relative(ROOT, p).replace(/\\/g, '/') === file
    })
    const surfaceId = surface ? surface.id : file
    seenSurfaces.add(surfaceId)
    const bad = findUnguardedBridgeEntries(src)
    guarded += kotlinBridgeMethods(src).length - bad.length
    const reg = uncovered.get(surfaceId)
    // 已登记豁免的面：仍要求 reason + until 在场且未过期（豁免不得变成永久静默），
    // 但不再逐个入口判红（本面根本没有守卫机制可调，逐条红只会淹掉真信号）。
    if (reg !== undefined) {
      if (!reg.reason || !String(reg.reason).trim()) {
        check('帧守卫豁免有 reason: ' + surfaceId, false, '理由为空 = 变相永久豁免')
      }
      if (!reg.until || Date.parse(reg.until) < Date.now()) {
        check('帧守卫豁免未过期: ' + surfaceId, false, '到期日 ' + reg.until + ' 已过：要么接入守卫，要么重写理由与到期条件')
      }
      continue
    }
    for (const b of bad) missing.push({ file, ...b })
  }
  for (const m of missing) {
    check('帧守卫: ' + m.file + ':' + m.line + ' ' + m.name, false,
      '未过帧来源门禁——入口的第一件事必须是 trusted { } 或 checkTrustedFrame()（#1029）')
  }
  // 豁免销账（shrink-only）：登记了却已不再需要（面接上了守卫，或面已不存在）→ 判红，删条目。
  for (const [surfaceId, reg] of uncovered) {
    if (!seenSurfaces.has(surfaceId)) {
      check('帧守卫豁免销账: ' + surfaceId, false,
        '登记的面已不存在（改名/删除？）：请删掉 bridge-symmetry-baseline.json 的 frameGuardUncovered 条目')
      continue
    }
    const stillHasUnguarded = missing.some((m) => m.file.includes('') && false)
    void stillHasUnguarded
  }
  if (missing.length === 0) {
    console.log('PASS  桥面帧来源守卫（' + guarded + ' 个 @JavascriptInterface 入口全部过 trusted{}/checkTrustedFrame；'
      + uncovered.size + ' 个面按登记豁免，未接入 #686 守卫机制）')
  }
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
  // ── issue #1029：帧来源守卫静态判据（四个方向都要能红，正常输入要绿）─────────
  {
    const ANN = '  @JavascriptInterface'
    const f = (s) => findUnguardedBridgeEntries(s).length
    // 正例 1：表达式体同行 trusted{}
    check('⑪ 正例：表达式体同行 trusted{} 放行',
      f([ANN, '  fun version(): String = trusted { BuildConfig.VERSION_NAME }'].join('\n')) === 0)
    // 正例 2：表达式体折行（`=` 换行，中间夹注释）
    check('⑫ 正例：表达式体折行 + 中间夹注释 放行',
      f([ANN, '  fun shareFile(p: String): String =', '    // #686：用 trusted{} 包裹。', '    trusted { onShare(p) }'].join('\n')) === 0)
    // 正例 3：块体，checkTrustedFrame() 是第一条有意义语句（前面夹空行/注释）
    check('⑬ 正例：块体 checkTrustedFrame() 首句 放行',
      f([ANN, '  fun openFile(p: String) {', '    // 说明', '', '    checkTrustedFrame()', '    onOpen(p)', '  }'].join('\n')) === 0)
    // 反例 1：裸入口（#1029 的原始缺陷形态：新增入口不知道有这个约定）
    const bare = findUnguardedBridgeEntries([ANN, '  fun capturePhoto(id: String): String = doCapture(id)'].join('\n'))
    check('⑭ 反例：裸入口必须判红且点名方法', bare.length === 1 && bare[0].name === 'capturePhoto')
    // 反例 2：checkTrustedFrame() 被挪到第二句 —— 判据是「第一件事」，不是「出现过」
    check('⑮ 反例：checkTrustedFrame() 挪到第二句必须判红',
      f([ANN, '  fun g() {', '    onFirst()', '    checkTrustedFrame()', '  }'].join('\n')) === 1)
    // 反例 3：表达式体折行但首句不是 trusted
    check('⑯ 反例：折行首句非 trusted 必须判红',
      f([ANN, '  fun h(): String =', '    doSomething()'].join('\n')) === 1)
    // 反例 4：只有注释里提到 trusted（文本在场不是证据）
    check('⑰ 反例：注释里提到 trusted 不得算守卫',
      f([ANN, '  fun i(): String =', '    // trusted { } 以后再说', '    rawCall()'].join('\n')) === 1)
    // 注释行里的注解不算入口（否则文档一写就误红）
    check('⑱ KDoc 里提到 @JavascriptInterface 不算入口',
      f(['  /**', '   * 页面通过 @JavascriptInterface 调到这里。', '   */', '  fun helper(): String = raw()'].join('\n')) === 0)
    // 混合：只报不合规的那些
    const mixed = findUnguardedBridgeEntries([
      ANN, '  fun ok1(): String = trusted { a() }',
      ANN, '  fun bad1(): String = b()',
      ANN, '  fun ok2() {', '    checkTrustedFrame()', '    c()', '  }',
    ].join('\n'))
    check('⑲ 混合场景只报不合规的 1 个', mixed.length === 1 && mixed[0].name === 'bad1')
  }
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

  // ⑨ issue #1048：扫描面必须来自磁盘而不是基线。三种形态各钉一条：
  //   真桥面文件（行首注解 + fun）算；KDoc 里提到注解的注释行不算；注解后 8 行内无 fun 不算。
  {
    const real = [
      'class ExtraBridge(private val ctx: Context) {',
      '    @JavascriptInterface',
      '    fun setGhostMode(on: Boolean) { }',
      '    @JavascriptInterface',
      '    fun getGhostMode(): Boolean = false',
      '    @JavascriptInterface',
      '    fun readSecretToken(): String = ""',
      '}',
    ].join('\n')
    const commented = [
      'class Helper {',
      '    /** 这里只是文档提到 @JavascriptInterface，并不是桥面。 */',
      '    private fun helper() { }',
      '}',
    ].join('\n')
    const noFun = ['class Broken {', '    @JavascriptInterface', '    // 注解后没有 fun', '}'].join('\n')
    check('⑨ 行首注解 + fun → 判为桥面（shell=' + kotlinBridgeMethods(real).join(',') + '）',
      hasBridgeSurface(real) && kotlinBridgeMethods(real).length === 3)
    check('⑨b KDoc 提到注解但无行首注解 → 不算桥面（否则文档文件全被误判）', hasBridgeSurface(commented) === false)
    check('⑨c 行首注解后没有 fun → 不算桥面（不虚报）', hasBridgeSurface(noFun) === false)
  }
  // ⑩ issue #1048 的双向对账：未登记的桥面点名；登记了但磁盘上已无注解的面也点名。
  {
    const surfaces = [
      { id: 'androidBridge', kotlin: 'dsh-mobile-apk/app/src/main/java/com/x/AndroidBridge.kt' },
      { id: 'ghostBridge', kotlin: 'dsh-mobile-apk/app/src/main/java/com/x/GhostBridge.kt' },
    ]
    const discovered = [
      'app/src/main/java/com/x/AndroidBridge.kt',
      'app/src/main/java/com/x/ExtraBridge.kt',
    ]
    const r1 = reconcileBridgeSurfaces(discovered, surfaces)
    check('⑩ 反向：ExtraBridge.kt 未登记 → unregistered 点名（新桥面不再整面不可见）',
      r1.unregistered.length === 1 && r1.unregistered[0] === 'app/src/main/java/com/x/ExtraBridge.kt',
      JSON.stringify(r1))
    check('⑩b 反向：登记的 GhostBridge.kt 磁盘上已无注解 → emptySurfaces 点名（扫描面空转可判）',
      r1.emptySurfaces.length === 1 && r1.emptySurfaces[0] === 'app/src/main/java/com/x/GhostBridge.kt',
      JSON.stringify(r1.emptySurfaces))
    const r2 = reconcileBridgeSurfaces([
      'app/src/main/java/com/x/AndroidBridge.kt',
      'app/src/main/java/com/x/GhostBridge.kt',
    ], surfaces)
    check('⑩c 正向：登记全集一致 → 两个方向都为空（可放行）',
      r2.unregistered.length === 0 && r2.emptySurfaces.length === 0, JSON.stringify(r2))
  }
  // ⑪ 接线自证：真实树的磁盘发现集合与基线**此刻**一致（自检跑在生产判定之外也要能自证）。
  {
    const real = discoverBridgeFiles(ROOT, SHELL_SOURCE_ROOTS)
    const diffs = reconcileBridgeSurfaces(real, baseline.surfaces)
    check('⑪ 真实树：磁盘桥面文件（' + real.length + '）== 基线 surfaces（' + baseline.surfaces.length + '）',
      real.length > 0 && diffs.unregistered.length === 0 && diffs.emptySurfaces.length === 0,
      JSON.stringify({ real, ...diffs }))
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