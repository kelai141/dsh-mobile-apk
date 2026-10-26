// es2023-immutable-array.test.mjs — ES2023 非变异数组方法补丁的行为回归（2026-10-26 WebView 110 实锤）。
//
// 为什么需要它：旧内核（Chrome 110 以下）没有 Array.prototype.toSorted / toReversed / toSpliced /
// with。上游 ui-model-selection 的 orderModelProviders 在 render 里直接调 `groups.toSorted(...)`，
// 缺方法即 `groups.toSorted is not a function` → 模型胶囊整块不渲染、`/model` 只剩红字 + 重试
// （同族的 ui-settings-models / ui-schedule 排序同样崩）。补丁是本仓唯一允许的修法（上游只读）。
//
// 本测试从**真实 lib/index.js 源码**里取出该条 polyfill（真源码，非副本），在独立 vm realm 里
// 先复刻「方法缺席」的旧内核，再执行补丁，逐条核对语义：
//   ① 反证：不装补丁时，生产调用形状必须抛 `groups.toSorted is not a function`（否则下面的正证是假绿）；
//   ② 正证：装补丁后四个方法全部可用，且**不修改入参**（非变异语义）、排序/截断/越界与规范一致；
//   ③ 幂等：重复执行不重建方法、原生已在场时一个字节都不改（不覆盖原生实现）；
//   ④ 非枚举：方法挂在原型上但不可枚举（`for...in` 不得凭空多出键）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/**
 * 从 lib/index.js 取出 POLYFILLS 数组里的 ES2023 条目（真源码求值，与页面收到的字符串一致）。
 * 数组体是纯模板字面量、无 ${} 插值，故按 `const POLYFILLS = [` … `\n];` 切段后整体求值。
 */
function es2023Polyfill() {
  const start = SRC.indexOf('const POLYFILLS = [')
  assert.ok(start > 0, 'lib/index.js 必须定义 POLYFILLS')
  const end = SRC.indexOf('\n];', start)
  assert.ok(end > start, 'POLYFILLS 数组必须能被完整取出')
  const entries = new Function(`return [${SRC.slice(start + 'const POLYFILLS = ['.length, end)}]`)()
  const snippet = entries.find((entry) => entry.includes("def('toSorted'"))
  assert.ok(typeof snippet === 'string', 'POLYFILLS 必须含 ES2023 非变异数组方法条目')
  return snippet
}

const POLYFILL = es2023Polyfill()
const METHODS = ['toSorted', 'toReversed', 'toSpliced', 'with']

/** 造一个「旧内核」realm：四个方法全部删除（Chrome 110 以下的真实方法面）。 */
function legacyRealm() {
  const realm = createContext({})
  runInContext(`(() => {
    for (const name of ${JSON.stringify(METHODS)}) {
      try { delete Array.prototype[name] } catch { /* 不可配置则删不掉，反证会因此变红 */ }
    }
  })()`, realm)
  return realm
}

/** 在 realm 里求值一个表达式，并把跨 realm 的返回值收敛成普通 JSON（原型不同，deepEqual 会误判）。 */
function probe(realm, expression) {
  return JSON.parse(runInContext(`JSON.stringify(${expression})`, realm))
}

test('反证：旧内核下生产调用形状抛 groups.toSorted is not a function', () => {
  const realm = legacyRealm()
  const outcome = runInContext(`(() => {
    const groups = [{ id: 'deepseek-official' }, { id: 'deepseek-account' }]
    try {
      // 与 ui-model-selection/lib/client.js 的 orderModelProviders 同一调用形状。
      groups.toSorted((left, right) => (left.id === 'deepseek-account' ? 0 : 1) - (right.id === 'deepseek-account' ? 0 : 1))
      return 'no-throw'
    } catch (error) {
      return error.name + ': ' + error.message
    }
  })()`, realm)
  assert.equal(outcome, 'TypeError: groups.toSorted is not a function')
})

test('正证：补丁落地后四个方法可用且不改入参', () => {
  const realm = legacyRealm()
  runInContext(POLYFILL, realm)
  const report = probe(realm, `(() => {
    const src = [3, 1, 2]
    const ordered = src.toSorted((a, b) => a - b)
    const reversed = src.toReversed()
    return {
      present: ${JSON.stringify(METHODS)}.every((name) => typeof Array.prototype[name] === 'function'),
      ordered,
      reversed,
      srcAfterOrdered: [...src],
      srcAfterReversed: [...src],
    }
  })()`)
  assert.equal(report.present, true)
  assert.deepEqual(report.ordered, [1, 2, 3])
  assert.deepEqual(report.reversed, [2, 1, 3])
  assert.deepEqual(report.srcAfterOrdered, [3, 1, 2], 'toSorted 不得修改原数组')
  assert.deepEqual(report.srcAfterReversed, [3, 1, 2], 'toReversed 不得修改原数组')
})

test('正证：toSpliced 的插入 / 截断 / 无参复制与规范一致', () => {
  const realm = legacyRealm()
  runInContext(POLYFILL, realm)
  const report = probe(realm, `(() => {
    const src = ['a', 'b', 'c', 'd']
    return {
      insert: src.toSpliced(1, 2, 'x', 'y'),
      truncate: src.toSpliced(2),
      copy: src.toSpliced(),
      negativeStart: src.toSpliced(-2, 1, 'z'),
      srcAfter: [...src],
    }
  })()`)
  assert.deepEqual(report.insert, ['a', 'x', 'y', 'd'])
  assert.deepEqual(report.truncate, ['a', 'b'])
  assert.deepEqual(report.copy, ['a', 'b', 'c', 'd'])
  assert.deepEqual(report.negativeStart, ['a', 'b', 'z', 'd'])
  assert.deepEqual(report.srcAfter, ['a', 'b', 'c', 'd'], 'toSpliced 不得修改原数组')
})

test('正证：with 的负下标与越界判据（[-length, length-1]）', () => {
  const realm = legacyRealm()
  runInContext(POLYFILL, realm)
  const report = probe(realm, `(() => {
    const src = ['a', 'b', 'c']
    const attempt = (index) => { try { return { value: src.with(index, 'z') } } catch (error) { return { error: error.name } } }
    return {
      last: attempt(-1),
      zero: attempt(0),
      upperOut: attempt(3),
      lowerOut: attempt(-4),
      fractional: attempt(1.9),
      srcAfter: [...src],
    }
  })()`)
  assert.deepEqual(report.last, { value: ['a', 'b', 'z'] })
  assert.deepEqual(report.zero, { value: ['z', 'b', 'c'] })
  assert.deepEqual(report.upperOut, { error: 'RangeError' })
  assert.deepEqual(report.lowerOut, { error: 'RangeError' })
  assert.deepEqual(report.fractional, { value: ['a', 'z', 'c'] }, '下标按 ToIntegerOrInfinity 截断')
  assert.deepEqual(report.srcAfter, ['a', 'b', 'c'], 'with 不得修改原数组')
})

test('幂等：重复执行不重建方法', () => {
  const realm = legacyRealm()
  runInContext(POLYFILL, realm)
  const report = probe(realm, `(() => {
    const before = Array.prototype.toSorted
    ;
    ${POLYFILL}
    ;
    ${POLYFILL}
    const after = [Array.prototype.toSorted, Array.prototype.toReversed, Array.prototype.toSpliced, Array.prototype.with]
    return { sameRef: before === after[0], allAfterRepeat: after.every(Boolean) }
  })()`)
  assert.equal(report.sameRef, true)
  assert.equal(report.allAfterRepeat, true)
})

test('幂等：原生方法已在场时一个字节都不改（不覆盖原生实现）', () => {
  const realm = createContext({})
  const report = probe(realm, `(() => {
    const before = [Array.prototype.toSorted, Array.prototype.toReversed, Array.prototype.toSpliced, Array.prototype.with]
    const nativeBefore = before.filter((fn) => fn && /native code/.test(Function.prototype.toString.call(fn))).length
    ;
    ${POLYFILL}
    const same = before.every((fn, i) => fn === [Array.prototype.toSorted, Array.prototype.toReversed, Array.prototype.toSpliced, Array.prototype.with][i])
    return { same, nativeBefore }
  })()`)
  assert.equal(report.same, true, '原生在场时不得替换')
  assert.equal(report.nativeBefore, 4, 'node 侧四个方法应均为原生实现（否则本用例没有证明力）')
})

test('非枚举：补上的方法不出现在 Array.prototype 的可枚举键里', () => {
  const realm = legacyRealm()
  runInContext(POLYFILL, realm)
  const keys = probe(realm, `Object.keys(Array.prototype)`)
  for (const name of METHODS) assert.ok(!keys.includes(name), `${name} 不得可枚举`)
  const seen = probe(realm, `(() => { const out = []; for (const key in [1, 2, 3]) out.push(key); return out })()`)
  assert.deepEqual(seen.filter((key) => METHODS.includes(key)), [], 'for...in 不得因补丁多出键')
})
