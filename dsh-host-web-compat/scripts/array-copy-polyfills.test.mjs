// array-copy-polyfills.test.mjs — 老内核缺失数组内建（ES2023 change-array-by-copy + ES2022 findLast 对）
// 注入补丁的行为回归。本批报障只由 toSorted 那一组引起；findLast 对是同批审计发现的支持范围缺口，
// 与本批归因无关，两组的判据各自独立（见文件末两段）。
//
// 为什么需要它（2026-10-26 用户报障「模型选择不可用」）：toSorted / toReversed / toSpliced /
// Array.prototype.with 随 V8 11.0（Chrome/WebView 110）才有，旧内核上是 undefined。上游客户端包
// **在 render 里直接调** toSorted（ui-model-selection 模型分组排序、ui-settings-models 设置→模型行
// 排序、ui-schedule 定时任务排序），render 抛错被 slot 错误边界吞成空渲染 —— 用户看到的是「输入框
// 控件行的模型胶囊不显示、/model 只有搜索框 + 红字 groups.toSorted is not a function」。
//
// 判据必须是行为对照，不是文本在场：只断言「装上了、是函数」抓不到三类语义错，而每一类都会在页面上
// 换一种方式崩 ——
//   ① 稀疏洞没物化 / 物化错：hasOwn 与遍历结果和原生不同；
//   ② 原数组被改写：sort()/splice() 直接改接收者，UI 层拿到被就地打乱的 store 快照；
//   ③ 参数没校验：toSorted(5) 不抛 TypeError，而是把非函数比较器喂给 sort。
// 因此本文件在**删掉四个原生方法的 realm**里跑页面实际收到的脚本字节，逐例与宿主 Node 的原生实现
// 对照（对照的就是同一份 ECMAScript 语义），并保留一条反证：补丁装上之前该 realm 必须真的没有这些
// 方法，否则下面的对照是空转。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 取 lib/index.js 里 POLYFILLS 的**真实条目**（真源码，不是副本）。
 *
 * 装配本身（join 分隔符、每段一个 script 元素、可解析）由 scripts/smoke-injections.mjs 判；
 * 这里只按同一份 map/join 口径拼出页面上那一段，用于语义对照。口径若漂移，smoke 的
 * 「script #1 parses」与四条 marker 会先红。
 */
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

const BODY = polyfillBody()
const METHODS = ['toSorted', 'toReversed', 'toSpliced', 'with']

/** 造一个缺指定内建的 realm，返回删后形态（反证读数用）。
 * @param names - 要删的方法名（按给定次序读数）。
 */
function realmMissing(names) {
  const context = createContext({ console })
  const before = runInContext('(() => {' + names.map((name) => 'delete Array.prototype.' + name + ';').join('')
    + 'return [' + names.map((name) => "typeof [][" + JSON.stringify(name) + "]").join(',') + '].join("/")'
    + '})()', context)
  return { context, before }
}

/** 造一个「Chromium < 110」形态的 realm：四个内建按老内核删掉，返回删后形态（反证用）。
 * @param which - 要删的方法名；默认全删。用于「只缺其一」的用例。
 */
function oldKernelRealm(which = METHODS) {
  const context = createContext({ console })
  const before = runInContext('(() => {' + which.map((name) => 'delete Array.prototype.' + name + ';').join('')
    + 'return [' + METHODS.map((name) => "typeof [][" + JSON.stringify(name) + "]").join(',') + '].join("/")'
    + '})()', context)
  return { context, before }
}

const show = (value) => (value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value))

/** 在宿主 realm 跑一段表达式体，返回归一化结果（抛错归一化成 THROW:<ErrorName>）。 */
function inHost(code) {
  try {
    return show(new Function(code)())
  } catch (error) {
    return 'THROW:' + error.constructor.name
  }
}

/** 在目标 realm 跑同一段表达式体，返回归一化结果（归一化在 realm 内做，跨 realm 的值不可比）。 */
function inRealm(context, code) {
  return runInContext('(function(){ try { var r = (function(){' + code + '})();'
    + ' return r === undefined ? "undefined" : typeof r === "string" ? r : JSON.stringify(r)'
    + ' } catch (e) { return "THROW:" + e.constructor.name } })()', context)
}

// 逐例对照：左 = 原生（宿主 Node 的真实 ECMAScript 实现），右 = 注入脚本装上的实现。
// 稀疏洞用例把 own keys 一并纳入结果：物化与否只看值会漏（null 与 undefined 在 JSON 里都是 null）。
const CASES = [
  ['toSorted 默认排序', 'return [3,1,2].toSorted()'],
  ['toSorted 默认排序按字符串序（10 在 9 前）', 'return [10,9,1].toSorted()'],
  ['toSorted 比较器', 'return [3,1,2].toSorted(function(a,b){return b-a})'],
  ['toSorted 稀疏洞物化', 'var r=[1,,3].toSorted(); return JSON.stringify(r)+"|own="+Object.keys(r).join(",")'],
  ['toSorted 比较器非法抛 TypeError', 'return [2,1].toSorted(5)'],
  ['toSorted 不改写原数组', 'var a=[3,1,2]; a.toSorted(); return a.join(",")'],
  ['toReversed', 'return [1,2,3].toReversed()'],
  ['toReversed 稀疏洞物化', 'var r=[1,,3].toReversed(); return JSON.stringify(r)+"|own="+Object.keys(r).join(",")'],
  ['toReversed 不改写原数组', 'var a=[1,2,3]; a.toReversed(); return a.join(",")'],
  ['toSpliced 删一项', 'return [1,2,3].toSpliced(1,1)'],
  ['toSpliced 插入多项', 'return [1,2,3].toSpliced(1,0,9,9)'],
  ['toSpliced 负起点', 'return [1,2,3].toSpliced(-2,1)'],
  ['toSpliced 无参', 'return [1,2,3].toSpliced()'],
  ['toSpliced 不改写原数组', 'var a=[1,2,3]; a.toSpliced(0,3); return a.join(",")'],
  ['with 正索引', 'return [1,2,3].with(1,9)'],
  ['with 负索引', 'return [1,2,3].with(-1,9)'],
  ['with 末位后越界抛 RangeError', 'return [1,2,3].with(3,9)'],
  ['with 负向越界抛 RangeError', 'return [1,2,3].with(-4,9)'],
  ['with 空数组抛 RangeError', 'return [].with(0,1)'],
  ['with 不改写原数组', 'var a=[1,2,3]; a.with(0,9); return a.join(",")'],
]

test('反证：补丁装上之前，老内核形态的 realm 真的没有这四个方法', () => {
  const { context, before } = oldKernelRealm()
  assert.equal(before, 'undefined/undefined/undefined/undefined')
  // 缺方法就是 render 期抛错（用户看到的那条红字就是这个形状），不是静默降级。
  assert.equal(inRealm(context, 'return [3,1,2].toSorted()'), 'THROW:TypeError')
})

test('正证：页面拿到的注入脚本让四个方法可用，且逐例与原生实现一致', () => {
  const { context } = oldKernelRealm()
  runInContext(BODY, context)
  for (const [label, code] of CASES) {
    const expected = inHost(code)
    const actual = inRealm(context, code)
    assert.equal(actual, expected, label + '：原生 = ' + expected + '，补丁 = ' + actual)
  }
})

test('补丁幂等：重复求值不得覆盖已装上的方法（不换引用、不叠包装）', () => {
  const { context } = oldKernelRealm()
  runInContext(BODY, context)
  const first = runInContext('Array.prototype.toSorted', context)
  runInContext(BODY, context)
  const second = runInContext('Array.prototype.toSorted', context)
  assert.equal(second, first, '第二次求值必须被 typeof 守卫挡住，方法引用不得变化')
})

test('只缺其一：只补缺的那个方法，其余原生实现不被替换', () => {
  const { context, before } = oldKernelRealm(['toSorted'])
  assert.equal(before, 'undefined/function/function/function')
  const nativeWith = runInContext('Array.prototype.with', context)
  runInContext(BODY, context)
  assert.equal(runInContext('typeof [].toSorted', context), 'function')
  assert.equal(runInContext('Array.prototype.with', context), nativeWith, '已存在的原生 with 不得被覆盖')
})

test('泛型接收者：按规范走 ToObject + LengthOfArrayLike，不只认真数组', () => {
  const { context } = oldKernelRealm()
  runInContext(BODY, context)
  const code = 'return Array.prototype.toSorted.call({0:"b",1:"a",length:2})'
  assert.equal(inRealm(context, code), inHost(code))
})

// ── 同批审计补的 ES2022 对（findLast / findLastIndex，Chrome 97+）──────────────────────
//
// 与本批报障的 toSorted **无关**：补它是因为产品语法下限是 chrome87，而 Chromium 87-96 在支持
// 范围内却没有这两个方法；在售快照（0.2.1-rc.2 树，93 个 client.js）实测命中 findLast
// ui-chat 6 / ui-conversation 3 / ui-trajectory 1 / inspector 1 处，findLastIndex ui-chat 与
// ui-trajectory 各 1 处，全在 render 路径。判据同样取「与原生逐例一致」，不是「是函数」。
const FIND_CASES = [
  ['findLast 命中最后一个偶数', 'return [1,2,3,4].findLast(function(v){return v%2===0})'],
  ['findLast 无命中返回 undefined', 'return String([1,3].findLast(function(v){return v>9}))'],
  ['findLast thisArg 生效', 'return [1,2,3].findLast(function(v){return v<=this.n},{n:2})'],
  ['findLast 回调收到 (值, 索引, 接收者)', 'var seen=[]; [7,8].findLast(function(v,i,arr){seen.push(i+":"+arr.length)}); return seen.join(",")'],
  ['findLast 稀疏洞按 undefined 参与', 'return String([1,,3].findLast(function(v){return v===undefined}))'],
  ['findLast 断言非函数抛 TypeError', 'return [1].findLast(5)'],
  ['findLast 不改写原数组', 'var a=[3,1,2]; a.findLast(function(v){return v>1}); return a.join(",")'],
  ['findLast 泛型接收者', 'return Array.prototype.findLast.call({0:"a",1:"b",length:2},function(v){return v==="a"})'],
  ['findLastIndex 命中下标', 'return [1,2,3,4].findLastIndex(function(v){return v%2===0})'],
  ['findLastIndex 稀疏洞下标', 'return [1,,3].findLastIndex(function(v){return v===undefined})'],
  ['findLastIndex 无命中返回 -1', 'return [1,3].findLastIndex(function(v){return v>9})'],
]

test('反证：补丁装上之前，老内核形态的 realm 真的没有 findLast/findLastIndex', () => {
  const { context, before } = realmMissing(['findLast', 'findLastIndex'])
  assert.equal(before, 'undefined/undefined')
  assert.equal(inRealm(context, 'return [1,2].findLast(function(){return true})'), 'THROW:TypeError')
})

test('正证：findLast/findLastIndex 逐例与原生实现一致', () => {
  const { context } = realmMissing(['findLast', 'findLastIndex'])
  runInContext(BODY, context)
  for (const [label, code] of FIND_CASES) {
    const expected = inHost(code)
    const actual = inRealm(context, code)
    assert.equal(actual, expected, label + '：原生 = ' + expected + '，补丁 = ' + actual)
  }
})
