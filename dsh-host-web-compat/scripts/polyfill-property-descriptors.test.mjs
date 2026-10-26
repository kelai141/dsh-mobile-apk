// polyfill-property-descriptors.test.mjs — 注入层补的内建必须是**不可枚举**属性（issue #621）。
//
// 为什么需要它（2026-10-26）：#619 用 `Array.prototype.toSorted = function ...` 这种赋值式安装补上
// 六个 ES2022/ES2023 数组方法。赋值在原型上创建的是**可枚举**属性，于是任何普通数组的 `for...in`
// 遍历都会多返回六个方法名（原生内建全部不可枚举）：
//
//   期望：0,1
//   实际：0,1,toSorted,toReversed,toSpliced,with,findLast,findLastIndex
//
// 这类污染只出现在**装过补丁的旧内核**上：桌面 Chrome 原生在场、跳过补丁，永远复现不了。判据必须在
// 「删掉原生方法的 realm」里跑页面实际收到的脚本字节，才能同时证明「补上了」与「补的形态对」。
//
// 同一条缺口在本批顺手补齐：`Array.prototype.at` 与 `String.prototype.replaceAll` 也是赋值式安装，
// 同样会成为可枚举属性（字符串的 for...in 也会多出 replaceAll）。后两个不属 #619 的新增方法，
// 但属同一个缺陷类别，故一并收口并纳入判据。
//
// 判据分三层，缺一层都抓不住：
//   ① 描述符：每个补上的内建都必须是 {writable:true, configurable:true, enumerable:false}，
//      与同代原生内建的属性形态一致（用例拿**原生读数**当参照系，不写死字符串）；
//   ② 可观测后果：普通数组的 `for...in` 只见到下标，`Object.keys(Array.prototype)` 为空；
//   ③ 源码契约：POLYFILLS 里不得再出现赋值式安装 —— 防止后续新增内建时把同一缺陷带回来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 取 lib/index.js 里 POLYFILLS 的真实条目并按注入口径拼成页面实际收到的那一段。
 *  装配本身（join 分隔符、每段一个 script 元素、可解析）由 scripts/smoke-injections.mjs 判。
 */
function polyfillBody() {
  const start = SRC.indexOf('const POLYFILLS = [')
  assert.ok(start > 0, 'lib/index.js 必须定义 POLYFILLS')
  const end = SRC.indexOf('\n];', start)
  assert.ok(end > start, 'POLYFILLS 必须能被完整截取')
  const snippets = new Function(SRC.slice(start, end + 3) + '\nreturn POLYFILLS')()
  assert.ok(Array.isArray(snippets) && snippets.length > 0, 'POLYFILLS 必须是非空数组')
  return snippets
}

const SNIPPETS = polyfillBody()
const BODY = SNIPPETS
  .map((snippet) => snippet.trim())
  .map((snippet) => (snippet.endsWith(';') ? snippet : snippet + ';'))
  .join('\n')

/** 老内核缺、且由注入层补上的数组内建（#619 的六个 + 更早缺失的 at）。 */
const ARRAY_METHODS = ['toSorted', 'toReversed', 'toSpliced', 'with', 'findLast', 'findLastIndex', 'at']
/** 老内核缺、且由注入层补上的 String 内建。 */
const STRING_METHODS = ['replaceAll']

/** 造一个老内核形态的 realm：把这些内建删掉，返回删除后的形态读数（反证要用）。 */
function oldKernelRealm() {
  const context = createContext({ console })
  const before = JSON.parse(runInContext('(function(){'
    + ARRAY_METHODS.map((name) => 'delete Array.prototype[' + JSON.stringify(name) + '];').join('')
    + STRING_METHODS.map((name) => 'delete String.prototype[' + JSON.stringify(name) + '];').join('')
    + 'return JSON.stringify({'
    + 'array: ' + JSON.stringify(ARRAY_METHODS) + '.map(function(n){return typeof Array.prototype[n]}),'
    + 'string: ' + JSON.stringify(STRING_METHODS) + '.map(function(n){return typeof String.prototype[n]})'
    + '})'
    + '})()', context))
  return { context, before }
}

/** 在 realm 内读描述符与枚举形态（跨 realm 的对象不可直接比较，读数一律在 realm 内归一化）。 */
function reads(context) {
  return JSON.parse(runInContext(`(function(){
    var arrayNames = ${JSON.stringify(ARRAY_METHODS)};
    var stringNames = ${JSON.stringify(STRING_METHODS)};
    var shape = function (proto, name) {
      var d = Object.getOwnPropertyDescriptor(proto, name);
      return d === undefined ? 'absent'
        : (d.enumerable ? 'E' : 'n') + (d.writable ? 'W' : '-') + (d.configurable ? 'C' : '-');
    };
    var forIn = [];
    for (var key in [3, 1]) forIn.push(key);
    var stringForIn = [];
    for (var k in 'ab') stringForIn.push(k);
    var descriptors = {};
    arrayNames.forEach(function (n) { descriptors[n] = shape(Array.prototype, n); });
    stringNames.forEach(function (n) { descriptors[n] = shape(String.prototype, n); });
    return JSON.stringify({
      forIn: forIn.join(','),
      stringForIn: stringForIn.join(','),
      protoKeys: Object.keys(Array.prototype).join(','),
      stringProtoKeys: Object.keys(String.prototype).join(','),
      descriptors: descriptors,
    });
  })()`, context))
}

/** 同一批内建在**原生在场**的 realm 里的形态 —— 判据的参照系（不是写死的字符串）。 */
const NATIVE = reads(createContext({ console }))

test('反证：老内核形态的 realm 真的没有这些内建（否则下面的对照是空转）', () => {
  const { before } = oldKernelRealm()
  assert.deepEqual(before.array, ARRAY_METHODS.map(() => 'undefined'))
  assert.deepEqual(before.string, STRING_METHODS.map(() => 'undefined'))
  // 参照系本身必须是「不可枚举」，否则后面的对齐是空对空（例如宿主 Node 版本太老）。
  assert.equal(NATIVE.descriptors.toSorted, 'nWC')
  assert.equal(NATIVE.descriptors.replaceAll, 'nWC')
})

test('正证：补丁装上后，全部内建与原生一样不可枚举（for...in 只见到下标）', () => {
  const { context } = oldKernelRealm()
  runInContext(BODY, context)
  const patched = reads(context)

  // ① 描述符：逐个与原生形态对齐（'nWC' = 不可枚举 / 可写 / 可配置）。
  assert.deepEqual(patched.descriptors, NATIVE.descriptors,
    '补上的内建必须与原生同形：不可枚举、可写、可配置')

  // ② 可观测后果：#621 报的就是这两行。
  assert.equal(patched.forIn, '0,1', 'for...in 遍历普通数组不得混入方法名')
  assert.equal(patched.protoKeys, '', 'Array.prototype 不得出现可枚举的自有键')
  assert.equal(patched.stringForIn, '0,1', 'for...in 遍历字符串不得混入方法名')
  assert.equal(patched.stringProtoKeys, '', 'String.prototype 不得出现可枚举的自有键')
})

test('正证：不可枚举不影响可用性（取值与调用照常）', () => {
  const { context } = oldKernelRealm()
  runInContext(BODY, context)
  assert.equal(runInContext('[3,1].toSorted().join(",")', context), '1,3')
  assert.equal(runInContext('[1,2].findLast(function(v){return v<2})', context), 1)
  assert.equal(runInContext('[1,2,3].at(-1)', context), 3)
  assert.equal(runInContext('"a-b".replaceAll("-","+")', context), 'a+b')
})

test('正证：原生在场时一个字节都不改（跳过的分支不得动属性形态）', () => {
  const context = createContext({ console })
  const beforeArray = runInContext('Array.prototype.toSorted', context)
  const beforeString = runInContext('String.prototype.replaceAll', context)
  runInContext(BODY, context)
  assert.equal(runInContext('Array.prototype.toSorted', context), beforeArray, '原生实现不得被替换')
  assert.equal(runInContext('String.prototype.replaceAll', context), beforeString, '原生实现不得被替换')
  assert.deepEqual(reads(context).descriptors, NATIVE.descriptors)
})

// ── 负控：证明本判据在**修好之前**确实会红 ──────────────────────────────────────────────
//
// 复刻 #619 的修法（赋值式安装）再跑同一套读数：描述符必须变成可枚举、for...in 必须被污染。
// 这条用例恒绿——它锁的是「判据的判别力」，防止有人把上面几条正证改成恒真。
// 端到端负控（把 lib/index.js 换回修前版本，本文件整体变红）的命令与输出记在 PR 描述里。
test('负控：赋值式安装（修法前的形态）必然污染遍历与描述符', () => {
  const { context } = oldKernelRealm()
  runInContext('(function(){'
    + ARRAY_METHODS.map((n) => 'Array.prototype[' + JSON.stringify(n) + ']=function(){return undefined};').join('')
    + STRING_METHODS.map((n) => 'String.prototype[' + JSON.stringify(n) + ']=function(){return ""};').join('')
    + '})()', context)
  const polluted = reads(context)
  assert.equal(polluted.forIn, '0,1,' + ARRAY_METHODS.join(','), '赋值式安装必然把方法名带进 for...in')
  assert.equal(polluted.protoKeys, ARRAY_METHODS.join(','), '赋值式安装必然让原型上出现可枚举键')
  assert.equal(polluted.stringForIn, '0,1,' + STRING_METHODS.join(','))
  assert.equal(polluted.stringProtoKeys, STRING_METHODS.join(','))
  for (const name of ARRAY_METHODS.concat(STRING_METHODS)) {
    assert.equal(polluted.descriptors[name], 'EWC', name + ' 在赋值式安装下必须是可枚举的')
  }
})

// ── 源码契约：不许再出现赋值式安装 ────────────────────────────────────────────────────
//
// #619 的六个方法、以及同批顺手补的 at / replaceAll 都是同一个写法缺口；只测行为不锁源码，
// 下一个人照抄「AP.x = function」就会把缺陷带回来。
test('源码契约：POLYFILLS 内的内建一律不得用赋值式安装', () => {
  const offenders = []
  const pattern = /\b((?:Array|String|Set|Map|Object|Promise|Iterator|Number)\.prototype|AP)\.([A-Za-z$][\w$]*)\s*=(?!=)/g
  for (const snippet of SNIPPETS) {
    for (const match of snippet.matchAll(pattern)) offenders.push(match[1] + '.' + match[2])
  }
  assert.deepEqual(offenders, [], '这些内建仍用赋值安装（会成为可枚举属性）：' + offenders.join(', '))
})
