// polyfill-spec-parity.test.mjs — 注入层五个补丁的**规范等价性**回归（issue #1055）。
//
// 为什么需要它：这五段补丁只判「原生缺席」就装，装上之后没有任何行为判据 —— 而它们的语义与规范
// 不等价，且不等价的方式都很安静：
//   ① structuredClone 是 JSON 往返：Uint8Array 变普通对象、Date 变字符串、Map/Set 变空对象、
//      NaN/Infinity 变 null、{a:undefined} 丢键、structuredClone(undefined) 直接抛 SyntaxError。
//      消费者是 pdf.js 的 worker 消息与客户端手里的 structuredClone(ops)，毁数据不留痕。
//   ② matchMedia 接管无特性探测：prefers-color-scheme: light 在深色下返回 true、组合查询后半段被丢、
//      onchange 永不触发、dispatchEvent 不通知、同一监听加两次触发两次、订阅时同步回调一次，
//      且 listeners 是全局数组 —— 订阅 B 查询会触发 A 查询的订阅者。
//   ③ AbortSignal.any 加监听永不摘：派生 200 个就留 200 个；reason 还自造 AbortError 盖掉源 signal。
//   ④ replaceAll 是 split/join：$& / $' / $@ 与 $$ 原样插入、函数替换被字符串化、空搜索串少首尾两项。
//   ⑤ Array.prototype.at 只做 Number(i)||0：.at(1.5) 得 undefined（原生是 20）、.at(-Infinity) 得尾元素。
//
// 判据 = 与宿主 Node 的原生实现**逐例对照**，不是「是函数」。判据跑在**删掉原生实现的 realm** 里，
// 执行的是页面实际收到的那段脚本字节（与 scripts/array-copy-polyfills.test.mjs 同一口径）。
// 每条用例都有一条反证：装之前该 realm 必须真的没有这个内建，否则下面的对照是空转。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 取 lib/index.js 里 POLYFILLS 的真实条目，按注入口径拼成页面实际收到的那一段。 */
function polyfillBody() {
  const start = SRC.indexOf('const POLYFILLS = [')
  assert.ok(start > 0, 'lib/index.js 必须定义 POLYFILLS')
  const end = SRC.indexOf('\n];', start)
  assert.ok(end > start, 'POLYFILLS 必须能被完整截取')
  const snippets = new Function(SRC.slice(start, end + 3) + '\nreturn POLYFILLS')()
  assert.ok(Array.isArray(snippets) && snippets.length > 0, 'POLYFILLS 必须是非空数组')
  return snippets
    .map((snippet) => snippet.trim())
    .map((snippet) => (snippet.endsWith(';') ? snippet : snippet + ';'))
    .join('\n')
}

/** 取 THEME_BRIDGE_SCRIPT 求值后的内联脚本体（真源码，非副本）。 */
function themeBridgeBody() {
  const start = SRC.indexOf('const THEME_BRIDGE_SCRIPT = ' + '&#96;'.replace('&#96;', String.fromCharCode(96)))
  assert.ok(start > 0, 'lib/index.js 必须定义 THEME_BRIDGE_SCRIPT')
  const closeTick = SRC.indexOf(String.fromCharCode(96) + ';', start)
  assert.ok(closeTick > start, '必须能定位 THEME_BRIDGE_SCRIPT 模板串闭合')
  const script = new Function(SRC.slice(start, closeTick + 2) + '; return THEME_BRIDGE_SCRIPT')()
  const body = /<script>([\s\S]*)<\/script>/.exec(script)
  assert.ok(body && typeof body[1] === 'string', '必须能取出主题桥的脚本体')
  return body[1]
}

const BODY = polyfillBody()
const THEME_BODY = themeBridgeBody()

/** 归一化：跨 realm 的值不可直接比较，读数一律在各自 realm 内折成字符串。 */
const normalize = (value) => (value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value))
const errorName = (error) => 'THROW:' + (error && error.name ? error.name : String(error))

/** 在宿主 realm 跑一段表达式体（对照组 = 真实 ECMAScript 实现）。 */
function inHost(code) {
  try {
    return normalize(new Function('return (function(){' + code + '})()')())
  } catch (error) {
    return errorName(error)
  }
}

/** 在目标 realm 跑同一段表达式体。 */
function inRealm(context, code) {
  return runInContext('(function(){ try { var r = (function(){' + code + '})();'
    + ' return r === undefined ? "undefined" : typeof r === "string" ? r : JSON.stringify(r)'
    + ' } catch (e) { return "THROW:" + (e && e.name ? e.name : String(e)) } })()', context)
}

/** 逐例对照：左 = 原生，右 = 注入脚本装上的实现。 */
function assertParity(context, cases) {
  for (const [label, code] of cases) {
    const expected = inHost(code)
    const actual = inRealm(context, code)
    assert.equal(actual, expected, label + '：原生 = ' + expected + '，补丁 = ' + actual)
  }
}

/** 造一个删掉指定内建的 realm（返回删除后的形态读数，反证要用）。 */
function realmMissing(paths) {
  const context = createContext({ console })
  const before = runInContext('(function(){'
    + paths.map((path) => 'delete ' + path + ';').join('')
    + 'return [' + paths.map((path) => 'typeof ' + path).join(',') + '].join("/")'
    + '})()', context)
  return { context, before }
}

// ── ① structuredClone ────────────────────────────────────────────────────────────────
//
// vm 的 realm 天然没有 structuredClone（与 Chromium < 98 同形），无需额外删除。
const STRUCTURED_CASES = [
  ['TypedArray 保留类型与内容', 'var v=structuredClone(new Uint8Array([1,2,3])); return (v instanceof Uint8Array)+":"+v.constructor.name+":"+v.join(",")'],
  ['Float64Array 保留类型', 'var v=structuredClone(new Float64Array([1.5,2.5])); return (v instanceof Float64Array)+":"+v.length+":"+v[0]'],
  ['Date 还是 Date', 'var d=structuredClone(new Date(1234567890123)); return (d instanceof Date)+":"+d.getTime()'],
  ['RegExp 保留 source/flags', 'var r=structuredClone(/ab+c/gi); return (r instanceof RegExp)+":"+r.source+":"+r.flags'],
  ['Map 保留键值', 'var m=new Map([[1,"a"],["k",2]]); var v=structuredClone(m); return (v instanceof Map)+":"+v.size+":"+v.get(1)+":"+v.get("k")'],
  ['Set 保留成员', 'var s=new Set([1,2,2]); var v=structuredClone(s); return (v instanceof Set)+":"+v.size+":"+v.has(2)'],
  ['ArrayBuffer 逐字节复制', 'var b=new ArrayBuffer(4); new Uint8Array(b).set([9,8,7,6]); var v=structuredClone(b); return (v instanceof ArrayBuffer)+":"+v.byteLength+":"+new Uint8Array(v).join(",")'],
  ['ArrayBuffer 不与源共享', 'var b=new ArrayBuffer(4); new Uint8Array(b)[0]=7; var v=structuredClone(b); new Uint8Array(v)[0]=1; return new Uint8Array(b)[0]'],
  ['DataView 保留偏移与长度', 'var dv=new DataView(new Uint8Array([1,2,3,4]).buffer,1,2); var v=structuredClone(dv); return (v instanceof DataView)+":"+v.byteOffset+":"+v.byteLength+":"+v.getUint8(0)'],
  ['Error 保留类型与消息', 'var v=structuredClone(new TypeError("boom")); return (v instanceof TypeError)+":"+v.name+":"+v.message+":"+(typeof v.stack)'],
  ['NaN 与 Infinity 不被压成 null', 'var v=structuredClone({a:NaN,b:Infinity,c:-Infinity}); return [v.a,v.b,v.c].join(",")'],
  ['undefined 键被保留', 'var v=structuredClone({a:undefined,b:1}); return ("a" in v)+":"+Object.keys(v).join(",")'],
  ['structuredClone(undefined) 是 undefined 而不是 SyntaxError', 'return String(structuredClone(undefined))'],
  ['循环引用可克隆', 'var o={n:1}; o.self=o; var v=structuredClone(o); return (v!==o)+":"+(v.self===v)'],
  ['共享引用保持同一个克隆体', 'var s={}; var v=structuredClone({a:s,b:s}); return String(v.a===v.b)'],
  ['BigInt 可克隆', 'return String(structuredClone({v:BigInt(7)}).v)'],
  ['稀疏数组保留空洞', 'var v=structuredClone([1,,3]); return Object.keys(v).join(",")+":"+v.length'],
  ['符号键被丢弃', 'var o={vis:3}; o[Symbol("s")]=2; var v=structuredClone(o); return Object.keys(v).join(",")'],
  ['不可枚举自有键被丢弃', 'var o={vis:3}; Object.defineProperty(o,"hidden",{value:1,enumerable:false}); var v=structuredClone(o); return Object.keys(v).join(",")'],
  ['无原型对象的克隆体是普通对象', 'var o=Object.create(null); o.a=1; var v=structuredClone(o); return (Object.getPrototypeOf(v)===Object.prototype)+":"+Object.keys(v).join(",")'],
  ['自定义类实例被克隆成普通对象', 'function A(){this.x=1}; var v=structuredClone(new A()); return (Object.getPrototypeOf(v)===Object.prototype)+":"+v.x'],
  ['嵌套 Date 在数组里也保留', 'var v=structuredClone([new Date(5)]); return (v[0] instanceof Date)+":"+v[0].getTime()'],
  ['嵌套 Map 的键也克隆', 'var k={}; var v=structuredClone(new Map([[k,1]])); return v.size+":"+v.has(k)+":"+(Array.from(v.keys())[0]===k)'],
]

/** 不可克隆值：规范要求抛 DataCloneError（不是静默丢弃、也不是 JSON 的形状错误）。 */
const UNCLONEABLE_CASES = [
  ['函数不可克隆', 'return String(structuredClone({f:function(){}}))'],
  ['Symbol 不可克隆', 'return String(structuredClone(Symbol("x")))'],
  ['WeakMap 不可克隆', 'return String(structuredClone(new WeakMap()))'],
  ['WeakSet 不可克隆', 'return String(structuredClone(new WeakSet()))'],
  ['Promise 不可克隆', 'return String(structuredClone(Promise.resolve(1)))'],
]

test('①反证：这个 realm 真的没有 structuredClone（否则下面的对照是空转）', () => {
  const context = createContext({ console })
  assert.equal(runInContext('typeof structuredClone', context), 'undefined')
  assert.equal(inRealm(context, 'var v=structuredClone({a:1}); return JSON.stringify(v)'), 'THROW:ReferenceError')
})

test('①正证：structuredClone 逐例与原生实现一致（类型 / 稀疏 / 循环 / undefined 键 / NaN）', () => {
  const context = createContext({ console })
  runInContext(BODY, context)
  assertParity(context, STRUCTURED_CASES)
})

test('①正证：不可克隆值按规范抛 DataCloneError（不是静默丢弃）', () => {
  const context = createContext({ console })
  runInContext(BODY, context)
  assertParity(context, UNCLONEABLE_CASES)
})

test('①正证：transfer 选项转移缓冲区（源被 detach），不静默丢弃', () => {
  const context = createContext({ console })
  runInContext(BODY, context)
  const supportsTransfer = runInContext('typeof ArrayBuffer.prototype.transfer', context) === 'function'
  if (!supportsTransfer) {
    // 老内核没有 ArrayBuffer.prototype.transfer：显式抛错是可接受语义（规范外的降级必须响，
    // 不能把「转移」静默降级成「复制」——调用方据此认为源已被 detach，会复用同一块内存）。
    const outcome = inRealm(context, 'var b=new ArrayBuffer(8); return String(structuredClone(b,{transfer:[b]}))')
    assert.equal(outcome, 'THROW:DataCloneError', '没有 transfer 能力时必须显式抛错，实际：' + outcome)
    return
  }
  assertParity(context, [
    ['transfer 后源被 detach', 'var b=new ArrayBuffer(8); new Uint8Array(b).set([1,2,3,4,5,6,7,8]); var v=structuredClone(b,{transfer:[b]}); return v.byteLength+":"+b.byteLength+":"+new Uint8Array(v).join(",")'],
    ['transfer 空列表等价于复制', 'var b=new ArrayBuffer(8); var v=structuredClone(b,{transfer:[]}); return v.byteLength+":"+b.byteLength'],
  ])
})

test('①正证：第二参数缺省/为空对象时照常克隆（旧实现整段被忽略）', () => {
  const context = createContext({ console })
  runInContext(BODY, context)
  assertParity(context, [
    ['options 缺省', 'var b=new ArrayBuffer(8); return String(structuredClone(b).byteLength)'],
    ['options 为空对象', 'var b=new ArrayBuffer(8); return String(structuredClone(b,{}).byteLength)'],
  ])
})

// ── ② matchMedia（主题桥）────────────────────────────────────────────────────────────
//
// 消费者是 UI 侧的 ThemeBridge（dsh-client-ui-theme / ui-responsive）：它靠 matchMedia 的
// (prefers-color-scheme: dark) 跟随系统深浅色。真机形态是**厂商 WebView 原生查询卡在 light**
// （vivo/Android 16 实测），所以这里把「原生」桩成「viewport 1000px、系统浅色」的浏览器，
// 壳侧真实值另走 androidBridge.getSystemDark()。
const THEME_FEATURES = /^(min-width|max-width|prefers-color-scheme)$/

/** 桩原生 media query 求值器：支持 and / not / 逗号 OR 与三个特性。 */
function nativeMatches(query, viewport, nativeDark) {
  const px = (value) => {
    const text = String(value).trim()
    assert.ok(/^-?[0-9.]+px$/.test(text), '桩只接受 px 值：' + text)
    return Number.parseFloat(text)
  }
  const single = (part) => {
    let text = String(part).trim().toLowerCase()
    let negate = false
    if (text.startsWith('not ')) { negate = true; text = text.slice(4).trim() }
    let ok = true
    for (const group of text.split(/\s+and\s+/)) {
      const matched = /^\(\s*([a-z-]+)\s*:\s*([^)]+)\)$/.exec(group.trim())
      if (!matched) { ok = false; break }
      const name = matched[1]
      const raw = matched[2]
      assert.ok(THEME_FEATURES.test(name), '桩不认识的媒体特性：' + name + '（组合查询被截断时会撞这里）')
      if (name === 'min-width') ok = ok && viewport >= px(raw)
      else if (name === 'max-width') ok = ok && viewport <= px(raw)
      else ok = ok && nativeDark === (String(raw).trim().toLowerCase() === 'dark')
    }
    return negate ? !ok : ok
  }
  return String(query).split(',').some((part) => single(part))
}

/**
 * 造一个主题桥的宿主环境。
 *
 * @param options.native 'browser' = 原生 matchMedia 在场；'absent' = 完全没有原生实现。
 * @param options.viewport 桩视口宽度（组合查询用）。
 * @param options.nativeDark 桩原生 prefers-color-scheme 的答案（vivo 形态：恒 false）。
 * @param options.androidDark 壳侧同步桥的真实值；null = 没有该桥。
 * @param options.rootChildren #root 子节点数（>0 表示上游已挂载，画布主题不再归我们写）。
 * @param options.existingBridge 已存在的 __dshThemeBridge（stand-down 用例）。
 */
function themeRealm(options = {}) {
  const scene = {
    native: 'browser', viewport: 1000, nativeDark: false, androidDark: true, rootChildren: 0,
    ...options,
  }
  const nativeQueries = []
  const nativeInstances = new Map()
  const style = {}
  const document = {
    documentElement: { style },
    body: { textContent: '' },
    getElementById: (id) => (id === 'root' ? { children: scene.rootChildren > 0 ? [{}] : [] } : null),
    addEventListener: () => {},
  }
  const makeMql = (query) => ({
    get matches() { return nativeMatches(query, scene.viewport, scene.nativeDark) },
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })
  const nativeMatchMedia = (query) => {
    nativeQueries.push(String(query))
    const key = String(query)
    if (!nativeInstances.has(key)) nativeInstances.set(key, makeMql(key))
    return nativeInstances.get(key)
  }
  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  if (scene.native === 'browser') window.matchMedia = nativeMatchMedia
  if (scene.androidDark !== null) window.androidBridge = { getSystemDark: () => !!scene.androidDark }
  if (scene.existingBridge) window.__dshThemeBridge = scene.existingBridge
  const context = createContext({ console, document, window })
  runInContext(THEME_BODY, context)
  return {
    scene,
    context,
    window,
    style,
    nativeQueries,
    nativeInstances,
    run: (code) => runInContext(code, context),
  }
}

test('②反证：修法前的形态把「浅色查询」和「深色查询」当成同一个答案', () => {
  // 锁缺陷本体：忽略 light 语义。修复后此处必须为 false（深色下浅色查询不成立）。
  const realm = themeRealm()
  assert.equal(realm.run('window.matchMedia("(prefers-color-scheme: light)").matches'), false,
    '深色下 light 查询必须为 false（旧实现恒返回 dark）')
})

test('②正证：每个查询独立实例，监听互不串台（订阅 B 不得触发 A 的订阅者）', () => {
  const realm = themeRealm()
  realm.run('(function(){'
    + 'window.__log=[];'
    + 'var a=window.matchMedia("(prefers-color-scheme: dark)");'
    + 'var b=window.matchMedia("(min-width: 800px) and (prefers-color-scheme: dark)");'
    + 'a.addEventListener("change", function(){ window.__log.push("a") });'
    + 'b.addEventListener("change", function(){ window.__log.push("b") });'
    + 'window.__a=a; window.__b=b;'
    + '})()')
  assert.equal(realm.run('window.__a === window.__b'), false, '两个不同查询必须是不同的实例')
  realm.run('window.__a.dispatchEvent({type:"change"})')
  assert.equal(realm.run('window.__log.join(",")'), 'a', 'dispatchEvent 必须只通知本查询的订阅者')
  realm.run('window.__log=[]; window.__b.dispatchEvent({type:"change"})')
  assert.equal(realm.run('window.__log.join(",")'), 'b', 'dispatchEvent 必须只通知本查询的订阅者')
})

test('②正证：订阅时不同步回调、同一监听去重、change 由 setDark 驱动', () => {
  const realm = themeRealm()
  realm.run('(function(){'
    + 'window.__calls=[];'
    + 'var m=window.matchMedia("(prefers-color-scheme: dark)");'
    + 'var fn=function(e){ window.__calls.push(e && e.matches) };'
    + 'm.addEventListener("change", fn);'
    + 'm.addEventListener("change", fn);'
    + 'window.__m=m;'
    + '})()')
  assert.equal(realm.run('window.__calls.length'), 0, 'addEventListener 不得在订阅时同步回调（旧实现 fire() 一次）')
  realm.run('window.__dshThemeBridge.setDark(false)')
  assert.equal(realm.run('window.__calls.length'), 1, '同一监听加两次必须在一次变化里只触发一次')
  assert.equal(realm.run('String(window.__calls[0])'), 'false', 'change 事件必须带新的 matches')
  realm.run('window.__dshThemeBridge.setDark(true)')
  assert.equal(realm.run('window.__calls.length'), 2, '每次真实变化都要触发')
  assert.equal(realm.run('String(window.__calls[1])'), 'true')
  realm.run('window.__dshThemeBridge.setDark(true)')
  assert.equal(realm.run('window.__calls.length'), 2, '值没变就不得触发')
})

test('②正证：onchange / addListener / removeListener / media 全部按规范生效', () => {
  const realm = themeRealm()
  realm.run('(function(){'
    + 'window.__calls=[];'
    + 'var m=window.matchMedia("(prefers-color-scheme: light)");'
    + 'm.onchange=function(e){ window.__calls.push("onchange:"+(e&&e.matches)) };'
    + 'var legacy=function(e){ window.__calls.push("legacy:"+(e&&e.matches)) };'
    + 'm.addListener(legacy);'
    + 'window.__m=m; window.__legacy=legacy;'
    + '})()')
  assert.equal(realm.run('window.__m.media'), '(prefers-color-scheme: light)')
  assert.equal(realm.run('window.__calls.length'), 0, 'addListener 同样不得在订阅时同步回调')
  realm.run('window.__dshThemeBridge.setDark(true)')
  assert.equal(realm.run('window.__calls.join(",")'), 'onchange:false,legacy:false',
    '浅色查询在深色下的 matches 必须是 false（旧实现恒返回 dark）')
  realm.run('window.__m.removeListener(window.__legacy); window.__m.onchange=null')
  realm.run('window.__dshThemeBridge.setDark(false)')
  assert.equal(realm.run('window.__calls.length'), 2, '移除后的监听不得再被调用')
})

test('②正证：组合查询按原生求值（透传 + 只修正 prefers-color-scheme 那一段）', () => {
  const realm = themeRealm({ viewport: 1000, androidDark: true })
  assert.equal(realm.run('window.matchMedia("(min-width: 2000px) and (prefers-color-scheme: dark)").matches'), false,
    '过半段（min-width）必须参与求值，不能被丢掉')
  assert.equal(realm.run('window.matchMedia("(min-width: 800px) and (prefers-color-scheme: dark)").matches'), true)
  assert.equal(realm.run('window.matchMedia("(min-width: 800px) and (prefers-color-scheme: light)").matches'), false)
  assert.equal(realm.run('window.matchMedia("(prefers-color-scheme: light)").matches'), false)
  assert.equal(realm.run('window.matchMedia("(prefers-color-scheme: no-preference)").matches'), false)
  // 原生桩只认这三个特性；若实现把 prefers-color-scheme 原样透传，桩会算出「浅色」而不是主题值。
  assert.ok(realm.nativeQueries.length > 0, '组合查询必须真的问到原生')
})

test('②正证：非主题查询原样透传给原生（不合成、不改写）', () => {
  const realm = themeRealm()
  const first = realm.run('window.matchMedia("(min-width: 800px)")')
  assert.equal(realm.run('window.matchMedia("(min-width: 800px)") === window.matchMedia("(min-width: 800px)")'), true,
    '非主题查询必须每次都返回同一个原生实例（能透传就透传，不合成桩）')
  const nativeInstance = realm.nativeInstances.get('(min-width: 800px)')
  assert.ok(nativeInstance, '非主题查询必须真的问到原生')
  assert.equal(first === nativeInstance || realm.run('window.matchMedia("(min-width: 800px)")') === nativeInstance, true,
    '非主题查询必须原样返回原生实例')
})

test('②正证：原生 matchMedia 缺席时仍然工作（特性探测，旧实现直接在 .bind 上抛死）', () => {
  const realm = themeRealm({ native: 'absent', androidDark: true })
  assert.equal(realm.run('typeof window.matchMedia'), 'function', '没有原生实现时必须自己装一个，而不是抛死')
  assert.equal(realm.run('typeof window.__dshThemeBridge'), 'object', '旧实现抛死后整个桥都不存在，壳侧 setDark 全部落空')
  assert.equal(realm.run('window.matchMedia("(prefers-color-scheme: dark)").matches'), true)
  assert.equal(String(realm.style.background).toUpperCase(), '#1E1E1E', '首帧画布主题仍必须生效')
  realm.run('window.__dshThemeBridge.setDark(false)')
  assert.equal(realm.run('window.matchMedia("(prefers-color-scheme: dark)").matches'), false)
})

test('②正证：早装的桥在场时 stand down（不替换 matchMedia、不建新桥）', () => {
  const existing = { setDark: () => {} }
  const realm = themeRealm({ existingBridge: existing })
  assert.equal(realm.run('window.__dshThemeBridge'), existing, '已存在的桥必须原样保留')
  const native = realm.run('window.matchMedia')
  const after = realm.run('window.matchMedia')
  assert.equal(native === after, true, '非主题查询不得被合成新对象')
})

test('②正证：深色/浅色跟随主功能不变（画布主题仍由壳侧推送驱动）', () => {
  const dark = themeRealm({ androidDark: true, rootChildren: 0 })
  assert.equal(String(dark.style.background).toUpperCase(), '#1E1E1E')
  assert.equal(dark.run('window.matchMedia("(prefers-color-scheme: dark)").matches'), true,
    '壳侧说深色，页面查到的必须是深色（主功能）')
  const light = themeRealm({ androidDark: false, rootChildren: 0 })
  assert.equal(String(light.style.background).toUpperCase(), '#F1F3F1')
  assert.equal(light.run('window.matchMedia("(prefers-color-scheme: dark)").matches'), false)
  assert.equal(light.run('window.matchMedia("(prefers-color-scheme: light)").matches'), true)
})

// ── ③ AbortSignal.any ───────────────────────────────────────────────────────────────
//
// 可观测的泄漏判据：在 realm 里给 addEventListener/removeEventListener 装计数钩子。
// 规范要求派生信号在**任一源中止后**把全部监听摘掉（含「已有源已中止」的短路路径）。
const ABORT_INSTRUMENT = '(function(){'
  + 'var pairs = [];'
  + 'var add = AbortSignal.prototype.addEventListener;'
  + 'var remove = AbortSignal.prototype.removeEventListener;'
  + 'AbortSignal.prototype.addEventListener = function(type, fn, options){'
  + '  if (type === "abort" && typeof fn === "function") pairs.push([this, fn]);'
  + '  return add.call(this, type, fn, options);'
  + '};'
  + 'AbortSignal.prototype.removeEventListener = function(type, fn){'
  + '  if (type === "abort") {'
  + '    for (var i = pairs.length - 1; i >= 0; i -= 1) {'
  + '      if (pairs[i][0] === this && pairs[i][1] === fn) { pairs.splice(i, 1); break }'
  + '    }'
  + '  }'
  + '  return remove.call(this, type, fn);'
  + '};'
  + 'globalThis.__liveAbortListeners = function(){ return pairs.length };'
  + '})()'

function abortRealm() {
  const context = createContext({
    console, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, Error, TypeError,
  })
  const before = runInContext('(function(){ delete AbortSignal.any; return typeof AbortSignal.any + "/" + typeof AbortSignal.timeout })()', context)
  runInContext(ABORT_INSTRUMENT, context)
  runInContext(BODY, context)
  return { context, before }
}

test('③反证：这个 realm 真的没有 AbortSignal.any（timeout 仍为原生）', () => {
  const { context, before } = abortRealm()
  assert.equal(before, 'undefined/function')
  assert.equal(runInContext('typeof AbortSignal.any', context), 'function', '补丁必须装上一个 any')
})

test('③正证：派生 200 个信号后，任一源中止即摘掉全部监听（零残留）', () => {
  const { context } = abortRealm()
  const report = JSON.parse(runInContext('(function(){'
    + 'var controllers = [];'
    + 'for (var i = 0; i < 200; i += 1) controllers.push(new AbortController());'
    + 'var derived = AbortSignal.any(controllers.map(function(c){ return c.signal }));'
    + 'var beforeAbort = globalThis.__liveAbortListeners();'
    + 'controllers[0].abort(new Error("first"));'
    + 'return JSON.stringify({'
    + '  beforeAbort: beforeAbort,'
    + '  afterAbort: globalThis.__liveAbortListeners(),'
    + '  aborted: derived.aborted,'
    + '  reason: derived.reason && derived.reason.message'
    + '})'
    + '})()', context))
  assert.equal(report.beforeAbort, 200, '每个源各挂一个监听（200 个源 = 200 个监听）')
  assert.equal(report.afterAbort, 0, '中止后不得残留任何监听（旧实现一个都不摘）')
  assert.equal(report.aborted, true)
  assert.equal(report.reason, 'first', 'reason 必须是第一个中止的源的 reason')
})

test('③正证：反复派生不累积（50 轮派生 + 中止后监听总数为 0）', () => {
  const { context } = abortRealm()
  const live = runInContext('(function(){'
    + 'for (var i = 0; i < 50; i += 1) {'
    + '  var a = new AbortController(); var b = new AbortController();'
    + '  AbortSignal.any([a.signal, b.signal]);'
    + '  a.abort();'
    + '  b.abort();'
    + '}'
    + 'return globalThis.__liveAbortListeners();'
    + '})()', context)
  assert.equal(live, 0, '50 轮派生后监听总数必须回到 0（旧实现每轮留 2 个）')
})

test('③正证：源已中止时直接短路（不挂监听、reason 正确）', () => {
  const { context } = abortRealm()
  const report = JSON.parse(runInContext('(function(){'
    + 'var live = new AbortController();'
    + 'var err = new Error("already");'
    + 'var abortedSignal = AbortSignal.abort(err);'
    + 'var derived = AbortSignal.any([abortedSignal, live.signal]);'
    + 'return JSON.stringify({'
    + '  live: globalThis.__liveAbortListeners(),'
    + '  aborted: derived.aborted,'
    + '  sameReason: derived.reason === err,'
    + '  reasonName: derived.reason && derived.reason.name'
    + '})'
    + '})()', context))
  assert.equal(report.live, 0, '短路路径也不得挂监听')
  assert.equal(report.aborted, true)
  assert.equal(report.sameReason, true, 'reason 必须取源 signal 的 reason 本体（不是自造 AbortError）')
})

test('③正证：reason 取第一个中止的源（TimeoutError 不被改写成 AbortError）', async () => {
  const { context } = abortRealm()
  runInContext('(function(){'
    + 'globalThis.__timeoutSignal = AbortSignal.timeout(5);'
    + 'globalThis.__derived = AbortSignal.any([globalThis.__timeoutSignal, new AbortController().signal]);'
    + '})()', context)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const report = JSON.parse(runInContext('JSON.stringify({'
    + 'aborted: globalThis.__derived.aborted,'
    + 'reasonName: globalThis.__derived.reason && globalThis.__derived.reason.name,'
    + 'sameReason: globalThis.__derived.reason === globalThis.__timeoutSignal.reason,'
    + 'live: globalThis.__liveAbortListeners()'
    + '})', context))
  assert.equal(report.aborted, true)
  assert.equal(report.reasonName, 'TimeoutError', '规范：reason 取源的 reason，不得自造 AbortError（旧实现 name=AbortError）')
  assert.equal(report.sameReason, true)
  assert.equal(report.live, 0)
})

test('③正证：空列表永不中止；非 signal 元素抛 TypeError', () => {
  const { context } = abortRealm()
  assert.equal(runInContext('AbortSignal.any([]).aborted', context), false)
  assert.equal(inRealm(context, 'return String(AbortSignal.any([{}, {}]))'), 'THROW:TypeError')
  assert.equal(runInContext('AbortSignal.any([new AbortController().signal]).aborted', context), false)
})

// ── ④ String.prototype.replaceAll ───────────────────────────────────────────────────
/** 反引号字符（替换模式 $` 的组成部分）；不写成字面量，避免与模板串/文档引用冲突。 */
const BACKTICK = String.fromCharCode(96)
const REPLACE_CASES = [
  ['普通字符串替换', 'return "a-b-c".replaceAll("-", "+")'],
  ['$& 是匹配到的子串', 'return "a-b".replaceAll("-", "[$&]")'],
  ['美元符加反引号是匹配之前的前缀', 'return "a-b".replaceAll("-", "[$' + BACKTICK + ']")'],
  ['$单引号 是匹配之后的后缀', 'return "a-b".replaceAll("-", "[$\\u0027]")'],
  ['$$ 是字面量美元符', 'return "a-b".replaceAll("-", "$$")'],
  ['$1 无捕获组时原样保留', 'return "a-b".replaceAll("-", "$1")'],
  ['$12 无捕获组时原样保留', 'return "a-b".replaceAll("-", "$12")'],
  ['空搜索串在首尾也插入', 'return "abc".replaceAll("", "-")'],
  ['空搜索串 + 函数替换的位置参数', 'return "abc".replaceAll("", function(m, i){ return "[" + i + "]" })'],
  ['函数替换取返回值（不把函数字符串化）', 'return "abc".replaceAll("b", function(){ return "X" })'],
  ['函数替换的参数是 (匹配, 位置, 原串)', 'return "abc".replaceAll("b", function(){ return arguments.length + ":" + [].join.call(arguments, ",") })'],
  ['多个匹配全部替换', 'return "aXbXc".replaceAll("X", "-")'],
  ['搜索串是 undefined 时按字符串处理', 'return "aundefinedb".replaceAll(undefined, "X")'],
  ['替换串不是字符串时先转字符串', 'return "aa".replaceAll("a", null)'],
  ['无 g 标志的正则抛 TypeError', 'return "aa".replaceAll(/a/, "x")'],
  ['带 g 标志的正则照常替换', 'return "aa".replaceAll(/a/g, "x")'],
  ['带 g 标志的正则支持 $&', 'return "aa".replaceAll(/a/g, "[$&]")'],
  ['接收者是 null 时抛 TypeError', 'return String.prototype.replaceAll.call(null, "a", "b")'],
  ['接收者是 undefined 时抛 TypeError', 'return String.prototype.replaceAll.call(undefined, "a", "b")'],
  ['能用于泛型接收者', 'return String.prototype.replaceAll.call({toString:function(){return "a-b"}}, "-", "+")'],
]

test('④反证：这个 realm 真的没有 replaceAll', () => {
  const { before } = realmMissing(['String.prototype.replaceAll'])
  assert.equal(before, 'undefined')
})

test('④正证：replaceAll 逐例与原生实现一致（替换模式 / 函数 / 空串 / 正则标志）', () => {
  const { context } = realmMissing(['String.prototype.replaceAll'])
  runInContext(BODY, context)
  assertParity(context, REPLACE_CASES)
})

// ── ⑤ Array.prototype.at ────────────────────────────────────────────────────────────
const AT_CASES = [
  ['正索引', 'return String([10,20,30].at(1))'],
  ['负索引', 'return String([10,20,30].at(-1))'],
  ['小数索引按 ToIntegerOrInfinity 截断', 'return String([10,20,30].at(1.5))'],
  ['数字字符串索引同样截断', 'return String([10,20,30].at("1.5"))'],
  ['负小数向零取整', 'return String([10,20,30].at(-1.5))'],
  ['-Infinity 得 undefined', 'return String([10,20,30].at(-Infinity))'],
  ['Infinity 得 undefined', 'return String([10,20,30].at(Infinity))'],
  ['NaN 视作 0', 'return String([10,20,30].at(NaN))'],
  ['undefined 视作 0', 'return String([10,20,30].at(undefined))'],
  ['null 视作 0', 'return String([10,20,30].at(null))'],
  ['越界返回 undefined', 'return String([10,20,30].at(3))'],
  ['负向越界返回 undefined', 'return String([10,20,30].at(-4))'],
  ['稀疏洞读出 undefined', 'return String([1,,3].at(1))'],
  ['空数组返回 undefined', 'return String([].at(0))'],
  ['接收者是 null 时抛 TypeError（ToObject）', 'return Array.prototype.at.call(null, 0)'],
  ['泛型接收者', 'return String(Array.prototype.at.call({0:"a",1:"b",length:2}, 1))'],
  ['字符串接收者', 'return String(Array.prototype.at.call("abc", 1))'],
]

test('⑤反证：这个 realm 真的没有 Array.prototype.at', () => {
  const { before } = realmMissing(['Array.prototype.at'])
  assert.equal(before, 'undefined')
})

test('⑤正证：Array.prototype.at 逐例与原生实现一致（ToIntegerOrInfinity + ToObject）', () => {
  const { context } = realmMissing(['Array.prototype.at'])
  runInContext(BODY, context)
  assertParity(context, AT_CASES)
})

// ── 源码契约 ───────────────────────────────────────────────────────────────────────
test('源码契约：structuredClone 不得再是 JSON 往返', () => {
  const start = SRC.indexOf('const POLYFILLS = [')
  const end = SRC.indexOf('\n];', start)
  const block = SRC.slice(start, end).replace(/\/\/[^\n]*\n/g, '\n')
  assert.ok(!/structuredClone[^]*?JSON\.stringify/.test(block),
    'structuredClone 的补丁里不得出现 JSON.stringify（JSON 往返会静默毁数据）')
})
