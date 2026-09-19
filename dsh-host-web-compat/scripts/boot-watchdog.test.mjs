// boot-watchdog.test.mjs — 页面看门狗判据的行为回归（0.14.1 块C §2.3 / G-6）。
//
// 为什么需要它：原判据是「Loading plugins 文案在场」，而该文案由上游 boot 页创建、与失败原因**同在
// 入口 chunk 里** —— 入口模块因语法错误（老内核 / WebView < 94 无类静态块）整体不执行时，文案永不存在，
// 循环每轮提前 return，诊断浮层永不出现（自我参照死角，详见 docs/0.14.1-preview-LEGACY-AND-PERF.md §1.6）。
// 现改为**结果性判据**（#root / [data-dsh-frame] 有子节点、或已渲染文本超阈值），并保留原文案为次要信号。
//
// 本测试从**真实 lib/index.js 源码**里抽出 rendered()/pendingBoot() 与旧实现对照，在 vm 里跑 4 个场景：
//   改前（文本唯一门控）白屏场景漏报 → 改后命中；正常渲染场景两者一致（不误报）。
// 判据必须是行为对照，不是文本在场——这是本文件存在的前提。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 截取 BOOT_WATCHDOG_SCRIPT 里注入页面的脚本体（真源码，非副本）。
 *
 * 模板串里 `\\s` / `\\r\\n` 在**模块求值时**会被解成 `\s` / `\r\n`（这正是 lib/index.js:105-108 记录的
 * 坑：单个反斜杠会变成真换行，把字符串字面量劈成两行、注入脚本整块 SyntaxError）。
 * 因此测试必须复现「求值后」的字节：用 `String.raw` 取原文，再按 JS 模板串语义解一层转义。
 * 若不解这一层，测的是源码文本而不是页面实际收到的脚本 —— 假绿。
 */
function watchdogBody() {
  const start = SRC.indexOf('const BOOT_WATCHDOG_SCRIPT = `<script>(function(){')
  assert.ok(start > 0, 'lib/index.js 必须定义 BOOT_WATCHDOG_SCRIPT')
  const end = SRC.indexOf('})()</script>`', start)
  assert.ok(end > start, 'BOOT_WATCHDOG_SCRIPT 必须能被完整取出')
  const raw = SRC.slice(start + 'const BOOT_WATCHDOG_SCRIPT = `<script>'.length, end + '})()'.length)
  // 单趟解转义（与 JS 模板串语义一致；该模板内无 ${} 插值，由 grep 语义约束保证）。
  // 不能分多次 replace：`\\r` 会被后面的规则二次命中，解出错误字节（首版实测踩到）。
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue }
    const next = raw[i + 1]
    if (next === '\\') { out += '\\'; i++ } else if (next === 'r') { out += '\r'; i++ } else if (next === 'n') { out += '\n'; i++ } else if (next === 't') { out += '\t'; i++ } else { out += raw[i] }
  }
  return out
}

/** 朴素配对花括号截取一个函数定义。 */
function grabFunction(body, name) {
  const i = body.indexOf('function ' + name + '(')
  assert.ok(i >= 0, 'BOOT_WATCHDOG_SCRIPT 必须定义 ' + name)
  let depth = 0
  for (let k = body.indexOf('{', i); k < body.length; k++) {
    if (body[k] === '{') depth++
    else if (body[k] === '}') { depth--; if (depth === 0) return body.slice(i, k + 1) }
  }
  throw new Error(name + ' 截取失败')
}

const BODY = watchdogBody()
const FLOOR = /var RENDER_TEXT_FLOOR=\d+;/.exec(BODY)?.[0]
assert.ok(FLOOR, 'BOOT_WATCHDOG_SCRIPT 必须声明 RENDER_TEXT_FLOOR')
const PREFIX_DECL = /var BOOT_STALL_PREFIX='[^']+';/.exec(BODY)?.[0]
assert.ok(PREFIX_DECL, 'BOOT_WATCHDOG_SCRIPT 必须声明 BOOT_STALL_PREFIX（块L 契约：壳侧按该前缀抓行）')
// 新实现：结果性判据 + 次要文本信号
const NEW_PENDING = [FLOOR, grabFunction(BODY, 'textLen'), grabFunction(BODY, 'rendered'), grabFunction(BODY, 'pendingBoot')].join('\n')
// 块L 发布点（页面侧唯一赋值语句，壳侧只读）。
// 必须带上 lastProgressAt 声明——waitingForMs 由它计算；缺了它 collectRuntime 会走
// fail-closed 分支返回 unavailable，测到的就不是「能取到时的值」（首版实测踩到）。
const PROGRESS_DECL = /var lastProgressAt=Date\.now\(\);/.exec(BODY)?.[0]
assert.ok(PROGRESS_DECL, 'BOOT_WATCHDOG_SCRIPT 必须声明 lastProgressAt（waitingForMs 的真源）')
const PUBLISH = [PREFIX_DECL, PROGRESS_DECL, grabFunction(BODY, 'fold'), grabFunction(BODY, 'collectRuntime'), grabFunction(BODY, 'publish')].join('\n')
// 旧实现（改动前的判据，硬写在测试里作反向对照）——仅文本在场
const OLD_PENDING = "function pendingBoot(){ try{return /Loading plugins/i.test(document.body.textContent||'')}catch(e){return false} }"

/** 依场景描述搭出最小 document/window，然后求 pendingBoot()。 */
function pending(code, scene) {
  const root = scene.rootChildren === undefined ? null : { children: new Array(scene.rootChildren).fill({}) }
  const bodyText = 'x'.repeat(scene.bodyText ?? 0) + (scene.bootText ? scene.bootText : '')
  const document = {
    body: { textContent: bodyText, children: root ? [root] : [] },
    getElementById: (id) => (id === 'root' ? root : null),
    querySelector: () => null,
  }
  const ctx = createContext({ document, window: scene.bootMarker ? { __DSH_BOOT__: { rev: 'r', entries: [] } } : {}, sessionStorage: { getItem: () => null }, RegExp })
  return runInContext('(function(){' + code + '\nreturn pendingBoot})()', ctx)()
}

test('A 白屏（入口模块整体未执行：#root 空、body 无文本）——旧判据漏报，新判据命中', () => {
  const scene = { rootChildren: 0, bodyText: 0 }
  assert.equal(pending(OLD_PENDING, scene), false, '旧判据在此场景必须漏报（这正是死角）')
  assert.equal(pending(NEW_PENDING, scene), true, '新判据必须把纯白判为 pending，否则诊断浮层仍不出现')
})

test('B boot 页在场（Loading plugins 文案）——两侧一致命中（旧信号作为次要信号保留）', () => {
  const scene = { rootChildren: 0, bodyText: 0, bootText: 'Loading plugins\u2026' }
  assert.equal(pending(OLD_PENDING, scene), true)
  assert.equal(pending(NEW_PENDING, scene), true, '次要信号必须保留：文案在场仍判 pending')
})

test('C 正常渲染（#root 有子节点）——两侧一致不 pending（不得误报）', () => {
  const scene = { rootChildren: 3, bodyText: 40 }
  assert.equal(pending(OLD_PENDING, scene), false)
  assert.equal(pending(NEW_PENDING, scene), false)
})

test('D 仅文本超阈值（无 #root 子节点）——不误报', () => {
  const scene = { rootChildren: 0, bodyText: 200 }
  assert.equal(pending(NEW_PENDING, scene), false)
})

test('结果性判据只看渲染结果，不把「boot 文案不在场」当唯一依据', () => {
  // 源码级契约：新判据必须查 #root / [data-dsh-frame] / 文本阈值，且保留原文案判断
  assert.ok(BODY.includes("getElementById('root')"), '必须按 #root 是否有子节点判渲染结果')
  assert.ok(BODY.includes("querySelector('[data-dsh-frame]')"), '必须支持 [data-dsh-frame] 根标记')
  assert.ok(BODY.includes('RENDER_TEXT_FLOOR'), '必须有渲染内容长度阈值判据')
  assert.ok(/Loading plugins/.test(BODY), '原文案判据必须保留为次要信号（不是删掉换个死角）')
  // 块L 契约：页面侧诊断发布点存在，且「不可得」显式标注而不是空数组
  assert.ok(BODY.includes('window.__dshBootStallReport'), '必须把页面侧诊断发布到单一全局（壳侧只读）')
  assert.ok(BODY.includes('pageSideRuntime=unavailable'), 'pageSideRuntime 必须显式 unavailable，绝不留空数组')
  assert.ok(BODY.includes('dsh-boot-diag'), '必须带壳侧 grep 标记 dsh-boot-diag')
  assert.ok(BODY.includes('source=page-stall'), '必须带 source=page-stall')
})

test('块L 发布行与壳侧 LogCollector 的读取口径一致（跨仓字段级契约）', () => {
  // 壳侧 LogCollector.writeBootDiag 的行格式（dsh-mobile-apk/app/.../LogCollector.kt:457-460）：
  //   dsh-boot-diag source=<source> <dsh-boot-segments …> pageSideRuntime=… detail=<折叠换行>
  // 页面侧只负责给 source=page-stall + detail；分段快照与 pageSideRuntime 由壳侧组装。
  // 本测试锁「页面侧这一行的字段名/前缀」——两侧各自演进会让用户拿到的诊断行对不上。
  const scene = { rootChildren: 0, bodyText: 0 }
  void scene   // 发布面无 DOM 依赖；场景变量保留示意
  const ctx = createContext({
    document: {
      body: { textContent: '', children: [] },
      getElementById: () => null,
      querySelector: () => null,
    },
    window: {},
    sessionStorage: { getItem: () => null },
    RegExp,
  })
  const report = { tookMs: 40001, ua: 'Mozilla/5.0\r\nEVIL', manifest: null, bundleCount: 3, pendingBundles: [1, 2], badBundles: [], engineHttp: 200, rendered: false, pendingBoot: true }
  runInContext('(function(){' + PUBLISH + '\nwindow.__report=' + JSON.stringify(report) + ';publish(window.__report)})()', ctx)
  const payload = ctx.window.__dshBootStallReport
  assert.ok(payload, 'publish() 必须给 window.__dshBootStallReport 赋值（唯一发布点）')
  assert.equal(payload.marker, 'dsh-boot-diag')
  assert.equal(payload.source, 'page-stall')
  assert.match(payload.line, /^\[dsh-boot-stall\] dsh-boot-diag source=page-stall pageSideRuntime=/)
  assert.ok(payload.line.includes(' detail='), '必须带 detail=')
  // 折叠换行：detail 必须是单行（壳侧按 k=v 解析，未折叠的换行会截断整条诊断）
  assert.equal(payload.line.includes('\n'), false, 'detail 必须已折叠换行（单行）')
  assert.equal(payload.line.includes('\r'), false, 'CR 也必须折叠')
  // detail 字段名必须与壳侧列出的可读面一致
  for (const key of ['tookMs=', 'ua=', 'manifestCount=', 'bundleCount=', 'pendingBundles=', 'badBundles=', 'engineHttp=', 'rendered=', 'pendingBoot=']) {
    assert.ok(payload.line.includes(key), 'detail 必须带字段 ' + key)
  }
})

test('§6.2 四字段：能给真值的给真值，给不了的显式 unavailable（绝不空数组充数）', () => {
  // 块L L-2 的核心验收：pendingEntries / failedEntries / graphLoaded / waitingForMs。
  // 硬约束（详档 §6.2）：①不依赖「页面已跑起来」；②不用静态文本作判据；③取不到显式标注。
  // 本用例同时锁**诚实性**：pendingEntries 因上游 loader 私有 ctx 不可达而必须写 unavailable，
  // 不得用近似值（manifest 的 inject 声明）充数——那是编造诊断。
  const mkCtx = (extra) => createContext(Object.assign({
    document: { body: { textContent: '', children: [] }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    sessionStorage: { getItem: () => null },
    RegExp,
    Date,
  }, extra))

  // 场景一：注入面能拿到的真值都拿到 → 三个真值字段给值，pendingEntries 仍如实 unavailable
  const ctxA = mkCtx({
    window: {
      __DSH_BOOT__: { rev: 'r', entries: [{ id: 'solo', inject: { onlyService: {} } }] },
      __ModuleLoader__: { __dshCreateCalled: true, pendingQueue: [1, 2, 3] },
    },
  })
  runInContext('(function(){' + PUBLISH + '\nwindow.__r=publish({tookMs:1,ua:"ua",manifest:{count:1},bundleCount:0,pendingBundles:[],badBundles:[],engineHttp:200,rendered:false,pendingBoot:true})})()', ctxA)
  const rtA = ctxA.window.__dshBootStallReport.runtime
  assert.equal(rtA.graphLoaded, true, 'graphLoaded 必须反映 create() 的真实调用')
  assert.equal(rtA.pendingModuleQueue, 3, 'pendingModuleQueue 必须是模块系统队列的真实长度')
  assert.equal(rtA.failedEntries.length, 0, '无失败投影时 failedEntries 为真值空数组（与 unavailable 可区分）')
  assert.equal(typeof rtA.waitingForMs, 'number', 'waitingForMs 必须是运行时的毫秒数')
  assert.equal(rtA.pendingEntries, 'unavailable',
    'pendingEntries 必须显式 unavailable（上游 loader ctx 注入面不可达），不得用近似值充数')
  assert.equal(rtA.pendingEntriesReason, 'requires-upstream-loader-context-export', '必须给出不可得的原因')
  assert.ok(Array.isArray(rtA.declaredInjectEntries) && rtA.declaredInjectEntries.length === 1, 'inject 声明必须逐条披露为独立字段')
  assert.equal(rtA.declaredInjectEntries[0].id, 'solo')
  assert.equal(JSON.stringify(rtA.pendingEntries).includes('onlyService'), false,
    '不得把 manifest 声明冒充 pendingEntries（编造诊断）')

  // 场景二：什么都没有 → 一律显式 unavailable
  const ctxB = mkCtx({ window: {} })
  runInContext('(function(){' + PUBLISH + '\nwindow.__r=publish({tookMs:1,ua:"ua",manifest:null,bundleCount:0,pendingBundles:[],badBundles:[],engineHttp:null,rendered:false,pendingBoot:true})})()', ctxB)
  const rtB = ctxB.window.__dshBootStallReport.runtime
  assert.equal(rtB.graphLoaded, 'unavailable', '取不到时必须写 unavailable')
  assert.equal(rtB.pendingEntries, 'unavailable', '取不到时必须写 unavailable，不是 []')
  assert.equal(rtB.declaredInjectEntries, 'unavailable', '取不到时必须写 unavailable，不是 []')
  const line = ctxB.window.__dshBootStallReport.line
  assert.ok(line.includes('"pendingEntries":"unavailable"'), '发布行必须携带 runtime 四字段（壳侧可读）')
})

test('页面把已折叠的单行（而非原始对象）交给壳侧 console 通路', () => {
  // 壳侧 onConsoleMessage 抓前缀后按 k=v 解析 detail。若页面打印的是原始对象，console 序列化会多行、
  // 字段名也不是 k=v 口径 —— 两侧对不上（首版正是这样，已改为打印 payload.line）。
  assert.ok(BODY.includes('console.error(pub?pub.line'), '必须打印 publish() 返回的已折叠单行')
  assert.equal(/console\.error\(BOOT_STALL_PREFIX,report\)/.test(BODY), false, '不得再打印原始 report 对象')
  // 发布失败时也必须给出可解析的兜底行（不得静默）
  assert.ok(BODY.includes('pageSideRuntime=unavailable detail=unavailable'), 'publish 失败须有可解析兜底行，不得静默')
})

test('注入脚本本体必须语法有效（注释里的反引号会提前截断模板串）', () => {
  // 实测踩过（0.14.1 块L）：在 BOOT_WATCHDOG_SCRIPT 的**注释**里写了反引号包住标识符
  // （形如 `entry.fiber.inject`），模板串在那对反引号处提前闭合 → 注入脚本变成半截、求值即
  // SyntaxError。设备侧的后果是**引擎整个起不来**：
  //   Error: dsh: plugin tree failed to load: failed to import loader entry host-web-compat:
  //   Unexpected identifier 'entry'
  // 文件头注释早已警告「不得出现反引号」，但没有判据守着；本用例就是那个判据。
  //
  // 判据必须取**求值后**的字符串：源码文本切片测不出这个问题（首版校验脚本正因此漏报，
  // 把「模板串被截断」误判成语法 OK）。
  const tplStart = SRC.indexOf('const BOOT_WATCHDOG_SCRIPT = `')
  assert.ok(tplStart > 0, '必须能定位 BOOT_WATCHDOG_SCRIPT')
  const closeTick = SRC.indexOf('`;', tplStart)
  assert.ok(closeTick > tplStart, '必须能定位模板串闭合')
  const evaluated = new Function(SRC.slice(tplStart, closeTick + 2) + '; return BOOT_WATCHDOG_SCRIPT')()
  assert.ok(evaluated.startsWith('<script>'), '求值后必须以 <script> 开头（截断会让它变形）')
  assert.ok(evaluated.endsWith('</script>'), '求值后必须以 </script> 结尾（截断会让它变形）')
  const inner = evaluated.replace(/^<script>/, '').replace(/<\/script>$/, '')
  assert.doesNotThrow(() => new Function(inner), '注入脚本体必须语法有效，否则引擎会因插件加载失败而起不来')
  // 最小判据：两个定界反引号之间不得再出现反引号（报错信息最直白）
  const between = SRC.slice(tplStart + 'const BOOT_WATCHDOG_SCRIPT = `'.length, closeTick)
  assert.equal((between.match(/`/g) ?? []).length, 0,
    'BOOT_WATCHDOG_SCRIPT 模板串内部不得出现反引号（会提前闭合模板、注入脚本变半截）')
})

test('注入脚本体内不得含字面量 </head> 或 </script>（会误导 tapIndex 的 replace 或提前闭合标签）', () => {
  // 【0.14.1 装机实测 P0】真因链（与上面的「反引号截断」是**同一族的第二个陷阱**，且更难发现）：
  //   1. `apply()` 有**两次** tapIndex，各自做 `html.replace('</head>', <注入块> + '</head>')`；
  //   2. `BOOT_WATCHDOG_SCRIPT` 的**注释**里写了一句「本脚本在 </head> 前求值」——它就含字面量
  //      `</head>`。第一次注入把该脚本体插进 head 之后，第二次 tapIndex 的 `String.replace` 找
  //      **第一个** `</head>`，命中的是**注入脚本体注释里的那个**，而不是真的文档 `</head>`；
  //   3. 于是第二次注入的内容落进了 `<script>` 标签**内部**——浏览器在第一个 `</script>` 处结束
  //      脚本，其后的脚本文本被当**文本节点**渲染到页面上（实测：整屏显示注入脚本源码）。
  // 设备后果：页面**看起来像坏了**（满屏 JS 源码），而 `#root` 有 1 个子节点、CDP title 仍是
  // 「DeepSeek Harness」，很容易被误判成「页面正常」。
  // 判据：任何将被 `tapIndex` 注入的脚本体，其**求值后文本**不得含裸 `</head>`（会被 replace 抢先
  // 命中）或裸 `</script>`（会提前闭合）。必须用注释规避（写成「文档 head 末尾」）。
  const bodies = [
    ['BOOT_WATCHDOG_SCRIPT', 'const BOOT_WATCHDOG_SCRIPT = `'],
    ['THEME_BRIDGE_SCRIPT', 'const THEME_BRIDGE_SCRIPT = `'],
    ['PICKER_SCRIPT', 'const PICKER_SCRIPT = `'],
    ['STATIC_FALLBACK_SCRIPT', 'const STATIC_FALLBACK_SCRIPT = `'],
  ]
  for (const [name, marker] of bodies) {
    const s = SRC.indexOf(marker)
    if (s < 0) continue
    const c = SRC.indexOf('`;', s)
    const evaluated = new Function(SRC.slice(s, c + 2) + '; return ' + name)()
    const inner = evaluated.replace(/^<script>/, '').replace(/<\/script>$/, '')
    assert.ok(!inner.includes('</head>'),
      name + ' 体内含字面量 </head> —— tapIndex 的 replace 会命中它而不是真文档 </head>，把注入内容塞进 <script> 内部并渲染成文本')
    assert.ok(!inner.includes('</script>'),
      name + ' 体内含裸 </script> —— 会提前闭合 script 标签，其余内容被当文本渲染')
  }
})

// ── §2.3（0.14.1 块C）静态失败占位 + window.onerror 兜底 ──────────────────────
// 背景：入口 chunk 因解析期语法错误（老内核无 `static{}`）整体不执行时，上游 boot 页创建不出来、
// 上面的 BOOT_WATCHDOG_SCRIPT 也跑不到「诊断浮层」——用户只看到**纯白无字**。
// 故新增一个**不依赖任何上游产物**的静态占位块（纯内联 HTML + 内联脚本，`</head>` 前最先求值）。
//
// 判据取函数体而非整文件正则：实测算过——整文件范围的正则会跨进相邻的 tapIndex（那里确实有
// `x-dsh-pick-token`），把「实现正确」误报成「共用判据」（假红）。故这里按签名取函数体。

/** 取一个函数的源文本：从签名起，深度归零处结束。 */
function grabFn(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start >= 0, '必须能定位 ' + signature)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}

test('§2.3 静态占位块在场（F1）', () => {
  assert.ok(SRC.includes('id="dsh-static-fallback"'), '静态占位容器必须在场')
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  assert.ok(tplStart > 0, '必须能定位 STATIC_FALLBACK_SCRIPT')
})

test('§2.3 占位是纯内联、不依赖任何上游产物（F1b）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  assert.ok(closeTick > tplStart, '必须能定位模板串闭合')
  const block = SRC.slice(tplStart, closeTick)
  // 「不依赖上游产物」的实质：不得有外链 script（src=）或外链样式。
  assert.equal(/<script[^>]*\bsrc=/.test(block), false, '占位块不得依赖外链脚本')
  assert.equal(/<link[^>]*\bhref=/.test(block), false, '占位块不得依赖外链样式')
})

test('§2.3 占位模板求值后仍完整（模板未被截断）（F1c）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  const evaluated = new Function(SRC.slice(tplStart, closeTick + 2) + '; return STATIC_FALLBACK_SCRIPT')()
  assert.ok(evaluated.includes('id="dsh-static-fallback"'), '求值后必须仍含占位容器')
})

test('§2.3 静态占位注入已接进 tapIndex（能力有入口，非「定义了不用」）（F2）', () => {
  assert.ok(/tapIndex\(\(html\) => injectStaticFallback\(html\)\)/.test(SRC),
    'injectStaticFallback 必须被 tapIndex 接线，否则占位永不注入')
})

test('§2.3 占位注入幂等：已注入则原样返回（F3）', () => {
  const body = grabFn(SRC, 'function injectStaticFallback(')
  assert.ok(/if \(html\.includes\(STATIC_FALLBACK_MARK\)\) return html/.test(body), '已注入必须原样返回（幂等）')
})

test('§2.3 占位自带独立哨兵，不共用 pick-token 判据（F3b）', () => {
  const body = grabFn(SRC, 'function injectStaticFallback(')
  assert.ok(body.includes('STATIC_FALLBACK_MARK'), '必须用自带哨兵判幂等')
  assert.equal(body.includes('x-dsh-pick-token'), false,
    '不得共用 pick-token 判据：页面一旦有 pick-token 形状文本，占位会被一起跳过（而它是入口全灭时唯一反馈）')
})

test('§2.3 占位在页面成功渲染后必须移除（否则把白屏换成另一种坏）（F4）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  const block = SRC.slice(tplStart, closeTick)
  assert.ok(block.includes('removeChild('), '成功后必须移除占位节点')
})

test('§2.3 移除判据必须是结果性判据（#root 有子节点 或 body 文本超阈值）（F4b）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  const block = SRC.slice(tplStart, closeTick)
  assert.ok(/getElementById\('root'\)/.test(block) && /children\.length>0/.test(block),
    '渲染判据必须看 #root 是否有子节点（结果性判据，不依赖上游文案）')
})

test('§2.3 渲染错误监听在场（F5）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  const block = SRC.slice(tplStart, closeTick)
  assert.ok(/addEventListener\('error'/.test(block), '必须有 error 监听（捕获渲染期/解析期错误）')
})

test('§2.3 渲染错误用壳侧 [dsh-boot-stall] 前缀（跨层契约，F5b）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  const block = SRC.slice(tplStart, closeTick)
  assert.ok(block.includes('[dsh-boot-stall] dsh-boot-diag source=page-error'),
    '前缀必须与壳侧 onConsoleMessage 的 stall 契约一致，否则落不进 boot-diag.log')
})

test('§2.3 渲染错误只记录、不吞异常（F5c）', () => {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  const closeTick = SRC.indexOf('`;', tplStart)
  const block = SRC.slice(tplStart, closeTick)
  assert.equal(/addEventListener\('error'[\s\S]{0,600}?preventDefault/.test(block), false,
    '不得吞异常（只记录，不改控制流）')
})

test('§2.3 占位哨兵常量与容器标记逐字一致（F6）', () => {
  assert.ok(SRC.includes("const STATIC_FALLBACK_MARK = 'id=\"dsh-static-fallback\"'"), '哨兵常量必须逐字对应容器标记')
  assert.ok(SRC.includes('id="dsh-static-fallback"'), '容器标记必须在场')
})
