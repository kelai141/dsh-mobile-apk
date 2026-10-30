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
  // 解转义必须用**引擎自己的语义**（模板字面量求值），不得手写解码表。
  // 原因（真机实锤 2026-10-05：failedIds 恒为 "-"）：手写解码对**未知转义**的处理与 JS 不同——
  // 模板字面量里 `\s` 会丢掉反斜杠变成 `s`，而手写表当年把反斜杠留了下来。
  // 于是测试看到的是 `\s`（正确），页面拿到的是 `s`（退化），测试比引擎更宽容 —— 盲区就在这。
  // 用 new Function 求值即与页面收到的字节完全一致（该模板内无 ${} 插值，见下方反引号判据）。
  const evaluated = new Function(SRC.slice(start, end + '})()'.length) + '`; return BOOT_WATCHDOG_SCRIPT')()
  return evaluated.replace(/^<script>/, '').replace(/<\/script>$/, '')
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

test('S3-22 目录选择轮询：页面隐藏即停、可见即续（旧实现后台仍每 500ms 打一次）', async () => {
  // 缺陷现场（审查档 §3.3 第 22 行）：PICKER_SCRIPT 的 poll() 无条件 `setTimeout(poll,500)`——
  // 应用切到后台/锁屏后照样每 500ms 打一次 /api/android/dir-pick/poll，纯耗电与日志噪声。
  // 判据取**求值后**的脚本体（源码切片测不出模板串语义），并在 VM 里跑出真实行为：
  // 隐藏时不排下一拍、可见时立刻续上。
  const tplStart = SRC.indexOf('const PICKER_SCRIPT = `')
  assert.ok(tplStart > 0, '必须能定位 PICKER_SCRIPT')
  const closeTick = SRC.indexOf('</scr` + `ipt>`;', tplStart)
  assert.ok(closeTick > tplStart, '必须能定位 PICKER_SCRIPT 模板串闭合')
  const evaluated = new Function(SRC.slice(tplStart, closeTick) + '`; return PICKER_SCRIPT')()
  const inner = evaluated.replace(/^<script>/, '').replace(/<\/script>$/, '')

  const timers = []
  let visibilityListener = null
  let fetches = 0
  const doc = {
    hidden: true,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') visibilityListener = fn },
    documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
  }
  const win = { androidBridge: { getPickToken: () => 't', pickDirectory: () => {} } }
  const ctx = createContext({
    window: win, document: doc, fetch: () => { fetches++; return Promise.resolve({ json: () => Promise.resolve({}) }) },
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length }, Promise,
  })
  runInContext(inner, ctx)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(timers.length, 0, '页面隐藏时不得再排下一拍（隐藏即停）')
  assert.ok(fetches >= 1, '首拍仍会发一次请求（在途的一次不算违规）')

  // 可见：立即续上（不留空窗）
  doc.hidden = false
  assert.ok(visibilityListener, '必须挂了 visibilitychange 监听')
  visibilityListener()
  assert.equal(timers.length, 1, '恢复可见必须立刻续排一拍')
  assert.equal(timers[0], 500, '轮询间隔保持 500ms（行为不变，只加可见性门）')
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

// ── D4（0.14.1 白闪，issue #242）行为回归 ─────────────────────────────────────────────
//
// 上面 §2.3 那组用例是**静态文本在场**判据（assert SRC.includes(...)）：它们能证明「源码里有这一行」，
// 证不了「健康启动时占位不会现身」。这正是本缺陷漏网的机制——块C 的验收写的是「成功后占位被移除」
// （一个**终态**断言），而用户看到的是**过程**：录屏抽帧实测 0.37s 内，占位带（#1d1d1d）与整屏
// 纯白（255,255,255）**同帧**出现，随后页面自己渲染好、占位被移除 —— 终态断言全绿。
//
// 故这里补**行为对照**：把注入脚本放进 vm，用可控定时器分别跑「健康启动」「一直不渲染」两个场景，
// 并在最后给出旧形态的反向对照（没有它，无法区分新旧行为，用例等于没写）。

/** 取出 STATIC_FALLBACK_SCRIPT 求值后的**内联脚本体**（真源码，非副本）。 */
function staticFallbackEval() {
  const tplStart = SRC.indexOf('const STATIC_FALLBACK_SCRIPT = `')
  assert.ok(tplStart > 0, 'lib/index.js 必须定义 STATIC_FALLBACK_SCRIPT')
  const closeTick = SRC.indexOf('`;', tplStart)
  assert.ok(closeTick > tplStart, '必须能定位 STATIC_FALLBACK_SCRIPT 模板串闭合')
  return new Function(SRC.slice(tplStart, closeTick + 2) + '; return STATIC_FALLBACK_SCRIPT')()
}

/** 取出 THEME_BRIDGE_SCRIPT 求值后的**内联脚本体**。 */
function themeBridgeEval() {
  const tplStart = SRC.indexOf('const THEME_BRIDGE_SCRIPT = `')
  assert.ok(tplStart > 0, 'lib/index.js 必须定义 THEME_BRIDGE_SCRIPT')
  const closeTick = SRC.indexOf('`;', tplStart)
  assert.ok(closeTick > tplStart, '必须能定位 THEME_BRIDGE_SCRIPT 模板串闭合')
  return new Function(SRC.slice(tplStart, closeTick + 2) + '; return THEME_BRIDGE_SCRIPT')()
}

const FALLBACK_HTML = staticFallbackEval()
const FALLBACK_BODY = /<script>([\s\S]*)<\/script>/.exec(FALLBACK_HTML)?.[1]
assert.ok(typeof FALLBACK_BODY === 'string' && FALLBACK_BODY.includes('clearStaticFallback'),
  '必须能取出静态占位的脚本体')

/**
 * 在 vm 里跑一段注入脚本，返回可观测状态与可控定时器。
 *
 * @param body 脚本体（`(function(){...})()` 形态）。
 * @param scene.rendered 是否已渲染（#root 是否有子节点）。
 * @param scene.sysDark  `androidBridge.getSystemDark()` 的返回值；null = 该桥不可用。
 */
function runInjected(body, scene) {
  const el = { style: {} }
  const state = { removed: false, consoleLines: [] }
  const doc = {
    documentElement: { style: {} },
    body: { textContent: '' },
    getElementById: (id) => {
      if (id === 'root') return { children: scene.rendered ? [{}] : [] }
      if (id === 'dsh-static-fallback') return el
      return null
    },
    addEventListener: () => {},
  }
  el.parentNode = { removeChild: () => { state.removed = true; el.parentNode = null } }
  const timers = []
  const windowObj = {
    matchMedia: (q) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  if (scene.sysDark !== null) windowObj.androidBridge = { getSystemDark: () => !!scene.sysDark }
  const sandbox = {
    document: doc,
    window: windowObj,
    console: { error: (...a) => state.consoleLines.push(a.join(' ')) },
    Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  }
  const sandboxCtx = createContext(sandbox)
  runInContext(body, sandboxCtx)
  return {
    el,
    doc,
    window: sandbox.window,
    state,
    timers,
    /** 触发所有 ms <= at 的定时器各一次（按注册顺序；interval 按「跑一轮」语义）。 */
    fireTimers: (at) => { for (const t of timers.slice()) if (t.ms <= at) t.fn() },
  }
}

const isVisibleByDefault = (inlineStyle) => !/visibility\s*:\s*hidden/.test(inlineStyle)
const divStyleOf = (tpl) => /<div id="dsh-static-fallback" style="([^"]*)"/.exec(tpl)?.[1] ?? ''

test('D4/F1：深色系统下，脚本求值即设深色文档底色（不等入口 chunk 绘制）', () => {
  const r = runInjected(themeBridgeEval().replace(/^<script>/, '').replace(/<\/script>$/, ''), { sysDark: true, rendered: false })
  assert.equal(String(r.doc.documentElement.style.background).toUpperCase(), '#1E1E1E',
    '深色系统必须在 head 解析期就把文档画布写成深色，否则第一帧是 Chromium 默认白（白闪本体）')
  assert.equal(r.doc.documentElement.style.colorScheme, 'dark', '必须同时声明 color-scheme，供 UA 决定滚动条等默认外观')
})

test('D4/F1：浅色系统下写浅色底（不是无脑写深色）', () => {
  const r = runInjected(themeBridgeEval().replace(/^<script>/, '').replace(/<\/script>$/, ''), { sysDark: false, rendered: false })
  assert.equal(String(r.doc.documentElement.style.background).toUpperCase(), '#F1F3F1')
  assert.equal(r.doc.documentElement.style.colorScheme, 'light')
})

test('D4/F1：系统主题后续变化时画布底色跟随（不留 stale 内联底色）', () => {
  const r = runInjected(themeBridgeEval().replace(/^<script>/, '').replace(/<\/script>$/, ''), { sysDark: true, rendered: false })
  r.window.__dshThemeBridge.setDark(false)
  assert.equal(String(r.doc.documentElement.style.background).toUpperCase(), '#F1F3F1',
    '壳侧异步推送的主题变化必须同步画布底色，否则切到浅色主题后画布仍是深色')
})

/** 手动主题归 presenter 所有，OS 桥只报告环境，不能把 UA scheme 改回系统色。 */
function assertMountedThemeOwner(script, manualDark) {
  const scene = { sysDark: !manualDark, rendered: false }
  const r = runInjected(script.replace(/^<script>/, '').replace(/<\/script>$/, ''), scene)
  scene.rendered = true
  const scheme = manualDark ? 'dark' : 'light'
  const background = manualDark ? '#151517' : '#ffffff'
  r.doc.documentElement.style.colorScheme = scheme
  r.doc.documentElement.style.background = background
  const media = r.window.matchMedia('(prefers-color-scheme: dark)')
  let changes = 0
  media.addEventListener('change', () => { changes += 1 })
  const registered = changes
  for (const osDark of [manualDark, !manualDark]) {
    r.window.__dshThemeBridge.setDark(osDark)
    assert.equal(media.matches, osDark, '系统环境查询仍必须变化')
    assert.equal(r.doc.documentElement.style.colorScheme, scheme, '不得覆盖手动主题的 UA scheme')
    assert.equal(r.doc.documentElement.style.background, background, '不得覆盖 presenter 接管后的底色')
  }
  assert.equal(changes, registered + 2, 'system 偏好仍须收到两次 MQL 通知，由 presenter 解析')
}

test('主题所有权：挂载后手动浅色在系统来回切换时保持浅色', () => {
  assertMountedThemeOwner(themeBridgeEval(), false)
})

test('主题所有权：挂载后手动深色在系统来回切换时保持深色', () => {
  assertMountedThemeOwner(themeBridgeEval(), true)
})

test('主题所有权反证：移除挂载守卫时，原来的系统写回必须被判红', () => {
  const current = themeBridgeEval()
  const unguarded = current.replace('if(root&&root.children&&root.children.length>0)return;', '')
  assert.notEqual(unguarded, current, '负控必须实际移除守卫')
  assert.throws(() => assertMountedThemeOwner(unguarded, false), /不得覆盖/)
  assert.throws(() => assertMountedThemeOwner(unguarded, true), /不得覆盖/)
})

test('D4/F2：健康启动时占位**始终不可见**，渲染后移除（缺陷本体）', () => {
  const r = runInjected(FALLBACK_BODY, { rendered: true })
  // 注入后、任何定时器之前：可见性只能来自内联样式，不得是 visible
  assert.notEqual(r.el.style.visibility, 'visible',
    '注入即在屏上 = 把失败文案当启动画面（旧行为；设备录屏里它与纯白同帧出现 0.37s）')
  r.fireTimers(1000)
  assert.equal(r.state.removed, true, '渲染成功后必须移除占位节点（不变量 2 的后半句）')
  assert.notEqual(r.el.style.visibility, 'visible', '健康启动全程都不得现身')
})

test('D4/F2：一直不渲染时，阈值内不现身、超时后现身；不会误删', () => {
  const r = runInjected(FALLBACK_BODY, { rendered: false })
  r.fireTimers(1000)
  assert.notEqual(r.el.style.visibility, 'visible',
    '阈值内不得现身——「注入即可见」正是本次白闪/误报的成因（把健康启动渲染成失败）')
  assert.equal(r.state.removed, false, '未渲染不得移除占位')
  r.fireTimers(3000)
  assert.equal(r.el.style.visibility, 'visible',
    '确实卡住时必须现身，否则入口 chunk 全灭时用户得不到任何反馈（该块存在的理由）')
})

test('D4/F2：现身时必须落一条可诊断行（壳侧 boot-diag.log 按前缀抓）', () => {
  const r = runInjected(FALLBACK_BODY, { rendered: false })
  r.fireTimers(3000)
  const hit = r.state.consoleLines.find((l) => l.includes('[dsh-boot-stall]') && l.includes('source=page-static-fallback'))
  assert.ok(hit, '现身必须落可诊断行（否则「占位为何现身」现场无从判断）：' + JSON.stringify(r.state.consoleLines))
  assert.ok(hit.includes('no-render-after-'), '原因必须写清是「超时未渲染」，不得只写一句失败')
})

test('D4/F2：阈值必须显著大于健康启动的渲染窗口（实测 0.37s），否则误报', () => {
  const ms = Number(/var SHOW_DELAY_MS=(\d+);/.exec(FALLBACK_BODY)?.[1])
  assert.ok(Number.isFinite(ms), '脚本体必须声明 SHOW_DELAY_MS（阈值只允许有一处）')
  assert.ok(ms >= 2000, '阈值过小会把健康但稍慢的启动误报成失败：' + ms + 'ms')
})

test('D4/F2 反向对照：旧形态的容器默认可见，新形态默认隐藏（无此对照则新旧无法区分）', () => {
  // 改动前的内联样式（逐字形态：没有 visibility 声明）
  const OLD_STYLE = 'position:fixed;z-index:2147483646;left:0;right:0;top:0;padding:12px 14px;background:#1e1e1e;color:#e8e8e8;font:13px/1.5 sans-serif'
  assert.equal(isVisibleByDefault(OLD_STYLE), true,
    '旧形态：CSS 默认 visible，节点一进 DOM 就在屏上——这就是「健康启动也显示失败文案」的机制')
  assert.equal(isVisibleByDefault(divStyleOf(FALLBACK_HTML)), false,
    '新形态：容器必须默认隐藏，可见性只由脚本在「确实卡住」时打开')
})

// ── 客户端插件装配失败契约行（[dsh-boot-failed]）行为回归 ─────────────────────────────
//
// 缺陷现场：上游 assertEntriesActive 抛错 → BootPage.fail/failedItem 把失败集合渲染进**仍然在场的
// 启动页**，而该页同样满足 rendered()（#root 有子节点）。旧 publishReady() 因此约 500ms 就报一条
// [dsh-boot-ready]：壳侧据此把该 epoch 标为「已就绪」并停止 stall 计时，失败被静音；40s 浮层同样
// 永不出现（rendered() 早退）。本组用例锁四件事：
//   ① 失败页 → 发 [dsh-boot-failed] 契约行、**不发** ready；
//   ② 健康渲染 → 发 ready、不发 fail；
//   ③ 失败页不得被判 pending（不发 40s stall 浮层）;
//   ④ 触发点两处（MutationObserver 回调 2s 去抖 + readyWatch 每拍）且幂等。
//
// 判据取**求值后**的脚本体（与上面 §2.3 同法）：源码切片测不出模板串语义，且失败行的字段序是
// 壳侧按位置解析的契约，必须在真实执行下断字段顺序。
const FAILED_PREFIX_DECL = /var BOOT_FAILED_PREFIX='[^']+';/.exec(BODY)?.[0]
assert.ok(FAILED_PREFIX_DECL, 'BOOT_WATCHDOG_SCRIPT 必须声明 BOOT_FAILED_PREFIX（跨仓契约行前缀）')
const T0_DECL = /var t0=Date\.now\(\);/.exec(BODY)?.[0]
assert.ok(T0_DECL, 'BOOT_WATCHDOG_SCRIPT 必须声明脚本起点 t0（契约行 takenMs 的真源）')
const READY_PREFIX_DECL = /var BOOT_READY_PREFIX='[^']+';/.exec(BODY)?.[0]
assert.ok(READY_PREFIX_DECL, 'BOOT_WATCHDOG_SCRIPT 必须声明 BOOT_READY_PREFIX')
const FAILURE_RUNTIME = [
  FLOOR, PREFIX_DECL, READY_PREFIX_DECL, FAILED_PREFIX_DECL, T0_DECL, PROGRESS_DECL,
  grabFunction(BODY, 'fold'), grabFunction(BODY, 'textLen'), grabFunction(BODY, 'rendered'),
  grabFunction(BODY, 'pendingBoot'), grabFunction(BODY, 'collectRuntime'),
  grabFunction(BODY, 'installProgressWatch'),
  grabFunction(BODY, 'bootPagePresent'), grabFunction(BODY, 'bootFailed'), grabFunction(BODY, 'failedIds'),
  grabFunction(BODY, 'reasonText'),
  grabFunction(BODY, 'publishBootFailure'), grabFunction(BODY, 'publishReady'),
].join('\n')

/** 选择器匹配（只覆盖看门狗真正用到的四个选择器；其余一律不命中）。 */
function selMatch(n, sel) {
  if (sel === '[data-dsh-boot]') return n.boot === true
  if (sel === '[class*=failedItem]') return String(n.className).includes('failedItem')
  if (sel === '[data-dsh-frame]') return n.dshFrame === true
  if (sel === 'main,[role="main"]') return n.main === true
  return false
}
/** 深度优先收集（上游失败项挂在 report 之下，必须递归）。 */
function findAll(list, sel) {
  const out = []
  for (const n of list) {
    if (selMatch(n, sel)) out.push(n)
    out.push(...findAll(n.children ?? [], sel))
  }
  return out
}
/** 取第一个命中者（含自身子树）。 */
function findOne(list, sel) {
  for (const n of list) {
    if (selMatch(n, sel)) return n
    const deep = findOne(n.children ?? [], sel)
    if (deep) return deep
  }
  return null
}
/** 最小 DOM 节点：与上游 boot 页的失败投影结构同形。 */
function node(spec = {}) {
  const children = spec.children ?? []
  return {
    boot: !!spec.boot,
    dshFrame: !!spec.dshFrame,
    main: !!spec.main,
    className: spec.className ?? '',
    textContent: spec.text ?? '',
    children,
    // 用 this.children（而不是闭包里的初始数组）：用例会整体替换 children 来模拟 DOM 变更，
    // 闭包写法会继续查旧数组，从而把「变更后仍判未失败」误报成实现缺陷（首版实测踩到）。
    querySelector(sel) { return findOne(this.children, sel) },
    querySelectorAll(sel) { return findAll(this.children, sel) },
  }
}
/** 上游 BootPage.render 的失败页：boot 页 > card > report > div.failedItem*（逐条 id + 失败原文）。 */
function failurePage(ids, reason) {
  const items = ids.map((id) => node({ className: 'failedItem', text: id }))
  if (reason !== undefined) items.push(node({ className: 'failedItem', text: reason }))
  return node({ boot: true, children: [node({ className: 'card', children: [node({ className: 'report', children: items })] })] })
}

/**
 * 在 vm 里跑「判据 + 两个发布点」，返回可调用的发布面与控制面。
 * @param root #root 节点（可变 children，便于模拟 DOM 变更）。
 * @param scene.mutationObserver 是否提供 MutationObserver 桩（缺省不提供 = 观察器装不上）。
 */
function bootFailureRuntime(root, scene = {}) {
  const state = { timers: [], consoleLines: [], observerCallbacks: [] }
  const document = {
    body: { textContent: '', children: [] },
    documentElement: {},
    baseURI: 'http://localhost/',
    getElementById: (id) => (id === 'root' ? root : null),
    // 真实 document.querySelectorAll 会搜到 #root 的后代；桩里必须同样委托过去，
    // 否则 collectRuntime().failedEntries 恒为空，无法与 failedIds 做交叉核对（真机取证口径）。
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  }
  const sandbox = {
    document,
    window: {},
    console: { error: (...a) => state.consoleLines.push(a.join(' ')), warn: () => {} },
    Date,
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length },
    clearTimeout: () => {},
  }
  if (scene.mutationObserver) {
    sandbox.MutationObserver = function (cb) {
      state.observerCallbacks.push(cb)
      this.observe = () => {}
    }
  }
  const ctx = createContext(sandbox)
  // runInContext 返回该表达式的**完成值**（即本处的对象），不要再调用一次。
  const api = runInContext(
    '(function(){' + FAILURE_RUNTIME + '\nreturn {ready:publishReady,fail:publishBootFailure,pending:pendingBoot,'
      + 'bootFailed:bootFailed,bootPagePresent:bootPagePresent,failedIds:failedIds,install:installProgressWatch}})()',
    ctx,
  )
  return { api, state, window: sandbox.window, root }
}
const fireDebounce = (state) => { for (const t of state.timers.slice()) if (t.ms === 2000) t.fn() }
const linesStarting = (state, prefix) => state.consoleLines.filter((l) => l.startsWith(prefix))

test('失败页：bootFailed 命中、failedIds 按契约取值（形状过滤/≤8/去重/无引号）', () => {
  const root = node({ children: [failurePage(
    ['@dsh-android/dsh-host-web-compat', 'ui-sidebar-documentpreview', 'a'.repeat(121), 'dup', 'dup'],
    'Failed to import loader entry ui-bad: SyntaxError unexpected token',
  )] })
  const { api } = bootFailureRuntime(root)
  assert.equal(api.bootPagePresent(), true, '启动页仍在 #root 内（异常路径不得被当成已就绪）')
  assert.equal(api.bootFailed(), true, '启动页 + 失败投影 = 终局失败')
  // 跨 realm 数组的原型不同，deepStrictEqual 会误判；摊平回宿主 realm 再比。
  assert.deepEqual([...api.failedIds()], ['@dsh-android/dsh-host-web-compat', 'ui-sidebar-documentpreview', 'dup'],
    '只留像 loader entry id 的整项：失败原文（含空格/冒号）与超长项被滤掉，重复项只算一次')
})

test('失败页：发 [dsh-boot-failed] 契约行，且**不发** ready（字段序即契约）', () => {
  const root = node({ children: [failurePage(['entry-one', 'entry-two'])] })
  const { api, state, window } = bootFailureRuntime(root)
  assert.equal(api.pending(), false,
    '失败页不得被判 pending：它有自己的出口（契约行 → 壳侧回引导页），40s 浮层是刻意的另一条路')
  api.fail()
  api.ready()
  assert.equal(linesStarting(state, '[dsh-boot-ready]').length, 0, '失败页不得发 ready（本次双重静音的根源）')
  assert.equal(window.__dshBootReadyPublished, undefined, '失败页不得置 ready 标记')
  const fails = linesStarting(state, '[dsh-boot-failed] ')
  assert.equal(fails.length, 1, '失败行必须恰好发布一次')
  const line = fails[0]
  assert.match(line, /^\[dsh-boot-failed\] dsh-boot-diag source=page-plugin-fail detail=/,
    '行首前缀与 source 必须逐字符合契约（壳侧按行首前缀判定）')
  // 字段序：detail → failedIds → pageSideRuntime（收尾）
  const atDetail = line.indexOf(' detail=')
  const atIds = line.indexOf(' failedIds=')
  const atRuntime = line.indexOf(' pageSideRuntime=')
  assert.ok(atDetail > 0 && atIds > atDetail && atRuntime > atIds, '字段序必须为 detail → failedIds → pageSideRuntime')
  assert.equal(line.includes(' failedIds=', atIds + 1), false, 'failedIds 只允许出现一列（其后即 runtime）')
  assert.match(line.slice(atDetail, atIds), /reason=.+ takenMs=\d+ failedCount=2 rendered=true/, 'detail 必须带四个 k=v')
  assert.equal(line.slice(atIds + ' failedIds='.length, atRuntime), 'entry-one,entry-two',
    'failedIds 无引号无空格，逗号分隔')
  // pageSideRuntime 必须**收尾且可解析**：fold 的 2048 截断落在它身上即整条诊断报废
  const runtime = JSON.parse(line.slice(atRuntime + ' pageSideRuntime='.length))
  assert.equal(runtime.pendingEntries, 'unavailable', 'pageSideRuntime 必须保留 collectRuntime 的诚实口径')
  assert.equal(line.includes('\n'), false, '契约行必须单行')
  assert.equal(line.includes('\r'), false, 'CR 也必须折叠')
  // 幂等：同一文档再触发不发第二条，也不覆盖已发布的行
  api.fail()
  assert.equal(linesStarting(state, '[dsh-boot-failed] ').length, 1, 'publishBootFailure 必须幂等')
})

test('失败页 entry id 全不可辨时 failedIds 写 "-"（壳侧据此走整份回滚或如实拒绝）', () => {
  const root = node({ children: [failurePage([], 'TypeError: Cannot read properties of undefined')] })
  const { api, state } = bootFailureRuntime(root)
  api.fail()
  assert.deepEqual([...api.failedIds()], [], '失败原文不是 entry id，不得被当成 id 上报')
  assert.match(linesStarting(state, '[dsh-boot-failed] ')[0], / failedIds=- pageSideRuntime=/,
    '一项都没有时必须写 "-"（不是空串，也不是空数组）')
})

test('健康渲染：发 ready、不发 fail（新判据不得把正常启动判成失败）', () => {
  const root = node({ children: [node({ main: true, text: 'x'.repeat(200), className: 'app' })] })
  const { api, state, window } = bootFailureRuntime(root)
  assert.equal(api.bootPagePresent(), false, '健康渲染后启动页已被卸载')
  assert.equal(api.bootFailed(), false, '无失败投影')
  api.fail()
  api.ready()
  api.ready()
  assert.equal(linesStarting(state, '[dsh-boot-failed] ').length, 0, '健康渲染不得发失败行')
  assert.equal(linesStarting(state, '[dsh-boot-ready] ').length, 1, '健康渲染必须且只发一次 ready')
  assert.equal(window.__dshBootReadyPublished, true)
})

test('启动页仍在场但尚无失败投影：既不发 ready 也不发 fail（真就绪只认启动页已卸载）', () => {
  const root = node({ children: [node({ boot: true, children: [node({ text: 'Loading plugins…' })] })] })
  const { api, state } = bootFailureRuntime(root)
  assert.equal(api.bootPagePresent(), true)
  assert.equal(api.bootFailed(), false, '只有失败投影才算终局失败，单纯还在加载不算')
  api.ready()
  assert.equal(linesStarting(state, '[dsh-boot-ready] ').length, 0,
    '启动页未卸载就报 ready 会把「加载中」误标成已就绪，正是本次要修的老行为')
})

test('触发点①：MutationObserver 回调 2s 去抖发布，且期间只排一个定时器', () => {
  const root = node({ children: [node({ main: true, text: 'x'.repeat(200) })] })
  const { api, state } = bootFailureRuntime(root, { mutationObserver: true })
  api.install()
  assert.equal(state.observerCallbacks.length, 1, '必须装上进度观察器（失败触发点挂在同一回调里）')
  const tick = state.observerCallbacks[0]
  tick()
  assert.equal(state.timers.filter((t) => t.ms === 2000).length, 0, '健康树不得排失败去抖（零副作用）')
  // DOM 变为失败页后，回调应排一次 2s 去抖
  root.children = [failurePage(['entry-bad'])]
  tick()
  assert.equal(state.timers.filter((t) => t.ms === 2000).length, 1, '失败投影出现后必须排一次去抖')
  assert.equal(linesStarting(state, '[dsh-boot-failed] ').length, 0, '去抖窗口内不得提前发布')
  tick()
  assert.equal(state.timers.filter((t) => t.ms === 2000).length, 1, '去抖期内重复变更不得堆积定时器')
  fireDebounce(state)
  assert.equal(linesStarting(state, '[dsh-boot-failed] ').length, 1, '去抖到点必须发布失败行')
})

test('触发点②：readyWatch 每拍补发，覆盖「观察器装上之前已是失败终态」的竞态', () => {
  // 终态先于观察器存在：此时 MutationObserver 再也不会有回调，只有每拍补发能救。
  const root = node({ children: [failurePage(['entry-late'])] })
  const { api, state } = bootFailureRuntime(root, { mutationObserver: true })
  api.install()
  assert.equal(api.fail(), undefined)
  assert.equal(linesStarting(state, '[dsh-boot-failed] ').length, 1, '开始即终态也必须能发布（不依赖任何后续变更）')
  api.fail()
  api.fail()
  assert.equal(linesStarting(state, '[dsh-boot-failed] ').length, 1, '每拍补发必须幂等')
  assert.equal(linesStarting(state, '[dsh-boot-ready] ').length, 0, '失败终态下 readyWatch 不得改发 ready')
})

test('源码级契约：失败前缀常量与 publishReady 的新判据在场（缺一即返工）', () => {
  assert.ok(BODY.includes("var BOOT_FAILED_PREFIX='[dsh-boot-failed]';"),
    '页面侧常量必须与壳侧 PAGE_PLUGIN_FAIL_PREFIX 逐字一致')
  assert.ok(BODY.includes('if(bootPagePresent())return;'),
    'publishReady 必须排除启动页仍在场的分支（否则失败页照发 ready）')
  assert.ok(BODY.includes('try{publishBootFailure()}catch(e){}'),
    'readyWatch 每拍必须补发失败行（观察器装上前已是终态的竞态出口）')
})


// ── 模板串转义退化（真机实锤：failedIds 恒为 "-"，2026-10-05 MuMu 16416）────────────────
//
// 现场：契约行发布正确、reason 也取到终局原文，但 failedIds 恒为 "-"、failedCount=0，同一行里
// pageSideRuntime.failedEntries 却明明带着 {"id":"@dsh-android/dsh-client-bad-probe"}。
// 真因：BOOT_WATCHDOG_SCRIPT 是**模板字面量**，体内 `\s` 是未知转义 —— 反斜杠被吃掉，
// 页面实际收到的是 `/s+/g`。于是 `@dsh-android/dsh-client-bad-probe` 被 replace(/s+/g,' ') 改写成
// `@dh-android/dh-client-bad-probe`，不再匹配 ID_SHAPE，filter 全部 continue，返回空数组。
// 这正是本文件 105-108 行注释里写下的那条坑（「\n 必须写成 \\n」），这次踩的是 \s。
//
// 判据必须取**求值后**的字节：源码切片看不出退化（源里就是单反斜杠，正是缺陷形态本身）。
const TEMPLATE_NAMES = [
  ['BOOT_WATCHDOG_SCRIPT', 'const BOOT_WATCHDOG_SCRIPT = `'],
  ['THEME_BRIDGE_SCRIPT', 'const THEME_BRIDGE_SCRIPT = `'],
  ['PICKER_SCRIPT', 'const PICKER_SCRIPT = `'],
  ['STATIC_FALLBACK_SCRIPT', 'const STATIC_FALLBACK_SCRIPT = `'],
]
test('防回归 A（结构）：注入模板体内不得残留「单反斜杠+字母」的转义（真机踩过 \\s）', () => {
  // 扫描对象是**模板体源码**（不是求值后文本）：求值后已看不出原始层数，无法定位到行。
  // 判据：一个反斜杠 + 一个字母，且该反斜杠前面不是反斜杠。
  // 白名单只放**合法的**十六进制转义（\uXXXX / \xXX）——PICKER_SCRIPT 的 \u300c 是上游既有且
  // 工作正常的写法，一律判红会把「正确的代码」误报成缺陷（首版朴素正则正是这样误报的）。
  const hazardOf = /(^|[^\\])\\([a-zA-Z])/g
  const legalHex = /^(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/
  const found = []
  for (const [name, marker] of TEMPLATE_NAMES) {
    const s = SRC.indexOf(marker)
    assert.ok(s > 0, name + ' 模板必须能被定位')
    const c = SRC.indexOf('`;', s)
    assert.ok(c > s, name + ' 模板串必须能被完整取出')
    const body = SRC.slice(s + marker.length, c)
    hazardOf.lastIndex = 0
    let m
    while ((m = hazardOf.exec(body)) !== null) {
      if (legalHex.test(body.slice(m.index + m[0].length - m[2].length))) continue
      found.push({ name, esc: m[2], ctx: body.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\n/g, ' ') })
    }
  }
  assert.deepEqual(found, [], '模板体内出现单反斜杠字母转义：反斜杠会被吞掉，页面拿到的是退化正则')
    // 逐条打印上下文，便于直接定位（assert 消息里带不上多行）
  if (found.length > 0) for (const h of found) console.error(h.name + ' esc=' + JSON.stringify(h.esc) + ' | ' + h.ctx)

  // 求值后**必须**是页面真正要执行的正则（与上面源码判据互为表里：一个查层数，一个查结果）。
  const pageText = new Function(SRC.slice(SRC.indexOf('const BOOT_WATCHDOG_SCRIPT = `'), SRC.indexOf('`;', SRC.indexOf('const BOOT_WATCHDOG_SCRIPT = `')) + 2) + '; return BOOT_WATCHDOG_SCRIPT')()
  assert.equal(pageText.includes('.replace(/s+/g'), false, '页面不得收到退化后的 /s+/g')
  assert.equal(pageText.includes('split(/n/)'), false, '页面不得收到退化后的 /n/')
  assert.ok(pageText.includes('.replace(/\\s+/g'), '页面必须收到正确的空白折叠正则')
})

test('防回归 B（行为）：failedIds 必须从真实 DOM 读出 id 形状的失败项（真机 failedIds 恒为 "-" 的直接判据）', () => {
  // 这条是**行为断言**，不是字段在场断言：现有用例只查了行里有 "failedIds="，
  // 因此转义退化（值被 replace 改写成 @dh-android/... 后滤光）能一路全绿到真机。
  // DOM 取自上游 BootPage.render() 的真实投影：标题 → 逐条 entry id → 终局原文。
  const ID = '@dsh-android/dsh-client-bad-probe'
  const REASON = 'web boot: 1 entry did not activate'
  const root = node({ children: [failurePage([ID], REASON)] })
  const { api, state } = bootFailureRuntime(root)
  assert.deepEqual([...api.failedIds()], [ID],
    'failedIds 必须从 DOM 读出该 id —— 取到空数组即转义退化（replace 用 /s+/g 把包名改写了）')
  assert.equal(api.bootFailed(), true)
  api.fail()
  const line = linesStarting(state, '[dsh-boot-failed] ')[0]
  assert.ok(line, '必须发布契约行')
  assert.match(line, new RegExp(' failedIds=' + ID.replace(/[.\\/+*?^$()\\[\\]{}|]/g, '\\$&') + ' pageSideRuntime='),
    'failedIds 必须是能从 DOM 读出的真实 id（真机此处为 "-"，即本用例要拦住的红）')
  assert.ok(line.includes(' failedCount=1 '), 'failedCount 必须与 failedIds 一致（不得是 0）')
  // 与真机取证同款的交叉核对：行内 failedIds 必须与 pageSideRuntime.failedEntries 的 id 对得上。
  const runtime = JSON.parse(line.slice(line.indexOf(' pageSideRuntime=') + ' pageSideRuntime='.length))
  assert.equal(runtime.failedEntries[0].id, ID, 'pageSideRuntime.failedEntries 与 failedIds 必须指向同一条')
  // 反向：终局原文含空格，不得被当成 entry id 混进来
  assert.equal(line.includes('failedIds=' + ID + ','), false, '含空格的终局原文不得被当作 id 追加')
})

// ── issue #1056：诊断面板的移除路径（慢启动被全屏遮罩永久盖住）──────────────────────────
//
// 缺陷现场：41 秒才就绪的启动，40 秒处挂出全屏、最高层级的 #dsh-boot-diag「启动没有完成」面板；
// 页面随后渲染完成、UI 明明可用，面板却**没有任何移除路径**（全篇 removeChild 只有静态占位那一处），
// 用户只能点「重新加载」把它清掉 —— 一次「正常但慢」的启动被呈现成「永久失败」。
// 第二个口子：挂出前的判定早于那次最长 3 秒的 HEAD 请求（report 快照取在 HEAD 之前），页面恰好在这段
// 窗口里渲染完时，判定按过期快照走，已经可用的页面照挂。
//
// 判据必须取**求值后**的脚本体、并在 vm 里跑出真实行为（appendChild / removeChild 逐次记账）：
// 源码切片只能证明「写了 removeChild 这一行」，证不了「页面就绪时它真的会被调用」。
//
// 截取策略：show() 依赖 rendered()（复用 readyWatch 同一判据）与一组 DOM 桩，故用 grabFunction
// 取 rendered 与新增的四个面板函数 + show 本体，显式构造依赖，**不复制任何实现**。

/** 取一个函数定义并补上语句分隔，便于多个函数并列拼进同一个 function 体。 */
function grabFnStmt(body, name) {
  return grabFunction(body, name) + ';'
}

/** 面板运行面：脚本体全部截取自真实源码，DOM 与定时器用记账桩。 */
function panelRuntime(scene) {
  const state = { appended: [], removed: [], timers: [], cleared: [] }
  const makeEl = (tag) => {
    const el = { tagName: tag, style: {}, children: [], textContent: '', id: '' }
    el.appendChild = (child) => { el.children.push(child); return child }
    return el
  }
  const root = { children: scene.rendered ? [{}] : [] }
  const body = {
    textContent: '',
    children: [],
    appendChild: (child) => { body.children.push(child); state.appended.push(child.id); child.parentNode = body; return child },
    removeChild: (child) => {
      const i = body.children.indexOf(child)
      if (i >= 0) body.children.splice(i, 1)
      state.removed.push(child.id)
      child.parentNode = null
      return child
    },
  }
  const document = {
    body,
    createElement: makeEl,
    getElementById: (id) => {
      if (id === 'root') return root
      // 关键：真实页面上 getElementById 查的是**当前 DOM**，桩必须同样查 body.children；
      // 否则面板被摘掉之后按 id 仍「看得见」它，幂等与停表两条用例会假绿。
      return body.children.find((c) => c.id === id) ?? null
    },
    querySelector: () => null,
  }
  const sandbox = {
    document,
    window: {},
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms, kind: 'timeout' }); return state.timers.length },
    setInterval: (fn, ms) => { state.timers.push({ fn, ms, kind: 'interval' }); return state.timers.length },
    clearInterval: (id) => {
      state.cleared.push(id)
      const timer = state.timers[id - 1]
      if (timer) timer.dead = true
    },
    Date: { now: () => scene.now ?? 1000 },
    RegExp,
  }
  const ctx = createContext(sandbox)
  const consts = [
    FLOOR,
    /var DIAG_PANEL_ID='[^']+';/.exec(BODY)?.[0],
    /var DIAG_RECHECK_MS=\d+;/.exec(BODY)?.[0],
    /var DIAG_RECHECK_WINDOW_MS=\d+;/.exec(BODY)?.[0],
  ]
  for (const c of consts) assert.ok(c, '面板相关常量必须能从真实源码里截取到：' + c)
  const code = [
    ...consts,
    grabFnStmt(BODY, 'textLen'),
    grabFnStmt(BODY, 'rendered'),
    grabFnStmt(BODY, 'diagPanel'),
    grabFnStmt(BODY, 'stopDiagWatch'),
    grabFnStmt(BODY, 'dropDiagPanel'),
    grabFnStmt(BODY, 'watchDiagPanel'),
    grabFnStmt(BODY, 'show'),
    'return {show:show,panel:diagPanel,rendered:rendered}',
  ].join('\n')
  const api = runInContext('(function(){' + code + '})()', ctx)
  const report = { tookMs: 41000, ua: 'ua', manifest: null, bundleCount: 0, pendingBundles: [], badBundles: [], engineHttp: 200, rendered: false, pendingBoot: true }
  /** 跑一拍复看（interval 语义：只跑当前活着的那一个）。 */
  const tickWatch = () => {
    const timer = state.timers.find((x) => x.kind === 'interval' && !x.dead)
    if (timer) timer.fn()
  }
  return { api, state, body, root, report, tickWatch }
}

test('issue #1056 / A：面板挂出后页面就绪，复看必须把它从 DOM 里移除（缺陷本体）', () => {
  const r = panelRuntime({ rendered: false })
  r.api.show(r.report)
  assert.deepEqual(r.state.appended, ['dsh-boot-diag'], '前置：show() 必须真的把面板挂上（否则本用例无意义）')
  assert.notEqual(r.api.panel(), null)
  assert.equal(r.state.timers.filter((x) => x.kind === 'interval').length, 1,
    '挂出的同时必须启动复看：没有复看就没有移除路径——这正是 issue #1056 的机制')
  // 还没渲染的那一拍：不得误删（否则真卡住的页面反而失去唯一反馈）
  r.tickWatch()
  assert.deepEqual(r.state.removed, [], '页面仍未渲染时不得移除面板')
  // 页面渲染出来了：同一拍必须摘掉面板并停表
  r.root.children = [{}]
  r.tickWatch()
  assert.deepEqual(r.state.removed, ['dsh-boot-diag'], '页面就绪后面板必须被 removeChild 掉（修前此断言恒为空：没有移除代码）')
  assert.equal(r.api.panel(), null, '移除后按 id 必须查不到（是离开 DOM，不是隐藏）')
  assert.equal(r.body.children.length, 0)
  assert.equal(r.state.cleared.length, 1, '移除后必须停掉复看定时器（不得在健康页面上继续打点）')
  r.tickWatch()
  assert.deepEqual(r.state.removed, ['dsh-boot-diag'], '停表后不得重复移除')
})

test('issue #1056 / B：挂出前已就绪则不挂（HEAD 之后必须用同一判据重判）', () => {
  // 源码级：HEAD 请求之后必须还有一次 pendingBoot() 复判，且它发生在 show() 之前。
  const headAt = BODY.indexOf("method:'HEAD'")
  assert.ok(headAt > 0, '必须能定位 HEAD 请求')
  const afterHead = BODY.slice(headAt, headAt + 1200)
  const recheckAt = afterHead.indexOf('if(!pendingBoot())return;')
  assert.ok(recheckAt >= 0, 'HEAD 返回后必须重判 pendingBoot()（快照取在 HEAD 之前，过期判定会挂错面板）')
  assert.ok(afterHead.indexOf('show(report)') > recheckAt, '重判必须发生在 show() 之前，否则等于没判')
  // 行为级：页面已渲染（#root 有子节点）时判据为假，与 run() 同样的串联不得调用 show()。
  const r = panelRuntime({ rendered: true })
  const pending = runInContext(
    '(function(){' + [FLOOR, grabFnStmt(BODY, 'textLen'), grabFnStmt(BODY, 'rendered'), grabFnStmt(BODY, 'pendingBoot')].join('\n')
      + ';return pendingBoot})()',
    createContext({
      document: {
        body: { textContent: '', children: [] },
        getElementById: (id) => (id === 'root' ? r.root : null),
        querySelector: () => null,
      },
      window: {},
      RegExp,
    }),
  )
  assert.equal(pending(), false, '页面已渲染 ⇒ pendingBoot() 必须为假（两处判据同一份实现）')
  if (!pending()) { /* 复判命中：整段退出，不挂面板 */ } else { r.api.show(r.report) }
  assert.deepEqual(r.state.appended, [], '已就绪时不得挂面板（修前：判定取在 HEAD 之前，过期快照照样挂）')
})

test('issue #1056 / C：连续 show() 两次只留一个面板节点（幂等）', () => {
  const r = panelRuntime({ rendered: false })
  r.api.show(r.report)
  r.api.show(r.report)
  assert.deepEqual(r.state.appended, ['dsh-boot-diag'], '重复 show() 不得堆叠第二个面板（叠两层互相遮挡，且移除只摘得掉一层）')
  assert.equal(r.body.children.length, 1)
  assert.equal(r.state.timers.filter((x) => x.kind === 'interval').length, 1, '重复 show() 不得堆叠复看定时器')
  r.root.children = [{}]
  r.tickWatch()
  assert.deepEqual(r.state.removed, ['dsh-boot-diag'], '幂等路径下依然必须移除面板')
  assert.equal(r.body.children.length, 0)
})
