/**
 * 刷新锚点基线的**完整性判据**（独立模块，纯函数 + 自带自检）。
 *
 * #868 现场：符号锚点解析退化后，`--refresh-anchor-baseline` 的输出从
 * 「1035 legacy references, 127 symbol anchors」变成只有「1035 legacy references」，
 * `symbols` / `symbolHashes` 两段被写成空对象，**且不报错**。
 * 下一次校验就以 `symbol-unbaselined` 红，把排查方向引到「基线没登记」；
 * 照提示再 refresh 只会再丢一次 —— 基线静默降级，属假绿家族。
 *
 * 用法：
 *   import { refreshCompletenessProblem } from './lib/refresh-guard.mjs'
 *   node scripts/lib/refresh-guard.mjs --self-test
 */

/**
 * @param symbolKeys 文档里解析出的符号锚点（每项含 path / symbol / 可选 symbolHash）
 * @param symbols 即将写入的 symbols 段
 * @param symbolHashes 即将写入的 symbolHashes 段
 * @param prevSymbols 旧基线里 symbols 的键
 * @param prevHashes 旧基线里 symbolHashes 的键
 * @returns null = 可以写盘；字符串 = 拒绝原因
 */
export function refreshCompletenessProblem(symbolKeys, symbols, symbolHashes, prevSymbols, prevHashes) {
  if (symbolKeys.length === 0 && (prevSymbols.length > 0 || prevHashes.length > 0)) {
    return 'the document no longer yields ANY symbol anchor, but the previous baseline had '
      + prevSymbols.length + ' symbols / ' + prevHashes.length + ' hashes'
  }
  const missSym = symbolKeys
    .filter((a) => !Object.hasOwn(symbols, a.path + '#' + a.symbol))
    .map((a) => a.path + '#' + a.symbol)
  if (missSym.length > 0) {
    return 'symbol anchors missing from the new baseline: ' + missSym.slice(0, 10).join(', ')
  }
  const missHash = symbolKeys
    .filter((a) => a.symbolHash !== undefined
      && !Object.hasOwn(symbolHashes, a.path + '#' + a.symbol + '@' + a.symbolHash))
    .map((a) => a.path + '#' + a.symbol + '@' + a.symbolHash)
  if (missHash.length > 0) {
    return 'symbol-hash anchors missing from the new baseline: ' + missHash.slice(0, 10).join(', ')
  }
  return null
}

// 仅**直接执行**时跑自检；被 check-code-map.mjs import 时不得劫持它的 --self-test
// （实测：不加这层判断，门禁的 --self-test 会跑到这里就 process.exit，把门禁自检整个吞掉）。
/**
 * `sourceLines` 段的**下降守卫**（#868 的补齐面）。
 *
 * 背景：`planLegacySourceLines` 只按**当前** references 重建 `sourceLines` —— 引用消失的 key
 * 会被静默丢掉。这件事有两种完全相反的含义：
 *
 *   · **合法的陈旧键清理**：分支落后于 main、或某条 legacy 引用已从文档移除；
 *   · **静默降级**：解析退化导致 references 变少，基线被洗小，下一轮就以「未登记」红。
 *
 * 两者在形状上不可区分，所以**不无条件拦，也不无条件放**：要求显式声明。
 * 默认拒绝并列出被丢弃的键；加 `--allow-source-lines-drop` 才放行（并仍打印清单供审阅）。
 *
 * @param prevKeys 旧基线里的 sourceLines 键
 * @param nextKeys 即将写入的 sourceLines 键
 * @param allow 是否已显式声明允许下降
 * @returns null = 可以写盘；字符串 = 拒绝原因
 */
export function sourceLinesDropProblem(prevKeys, nextKeys, allow) {
  if (allow) return null
  const next = new Set(nextKeys)
  const dropped = prevKeys.filter((k) => !next.has(k))
  if (dropped.length === 0) return null
  return 'sourceLines would drop ' + dropped.length + ' key(s): ' + dropped.slice(0, 12).join(', ')
    + (dropped.length > 12 ? ' …' : '')
}
const SELF_TEST = process.argv.includes('--self-test')
  && String(process.argv[1] || '').includes('refresh-guard')
if (SELF_TEST) {
  // 每条都必须能在判据失效时变红 —— 否则自检本身是假的。
  const k = (path, symbol, hash) => (hash === undefined
    ? { path, symbol }
    : { path, symbol, symbolHash: hash })
  const cases = [
    // ① 正常：文档有符号锚点且基线齐全 -> 允许写盘
    ['OK_ALL_PRESENT', null, [k('a.kt', 'f', 'h1')], { 'a.kt#f': 'body' }, { 'a.kt#f@h1': true }, [], []],
    // ② 无 @hash 的符号锚点：只需 symbols
    ['OK_NO_HASH', null, [k('a.kt', 'f')], { 'a.kt#f': 'body' }, {}, [], []],
    // ③ 文档一个符号锚点都没有、旧基线却有 -> 拒绝（基线静默降级的主形态）
    ['REFUSE_EMPTY_DOC_PREV_SYMBOLS', 'prev', [], {}, {}, ['a.kt#f'], []],
    ['REFUSE_EMPTY_DOC_PREV_HASHES', 'prev', [], {}, {}, [], ['a.kt#f@h1']],
    // ④ 文档有锚点但 symbols 缺条目 -> 拒绝
    ['REFUSE_MISSING_SYMBOL', 'miss', [k('a.kt', 'f')], {}, {}, [], []],
    // ⑤ 文档有 @hash 但 symbolHashes 缺条目 -> 拒绝
    ['REFUSE_MISSING_HASH', 'miss', [k('a.kt', 'f', 'h1')], { 'a.kt#f': 'body' }, {}, [], []],
    // ⑥ 旧基线为空、文档也为空 -> 允许（首次建基线）
    ['OK_FIRST_TIME_EMPTY', null, [], {}, {}, [], []],
  ]
  let failed = 0
  for (const [name, want, sk, sy, sh, ps, ph] of cases) {
    const got = refreshCompletenessProblem(sk, sy, sh, ps, ph)
    const ok = want === null ? got === null : (got !== null && got.length > 0)
    if (!ok) failed += 1
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ': ' + (got === null ? 'null' : 'refused'))
  }
  // #868 补齐面：sourceLines 下降必须显式声明
  const cases2 = [
    ['SLOK_NO_DROP', null, ['a.kt:1'], ['a.kt:1'], false],
    ['SLREFUSE_DROP', 'drop', ['a.kt:1', 'b.kt:2'], ['a.kt:1'], false],
    ['SLALLOW_DROP', null, ['a.kt:1', 'b.kt:2'], ['a.kt:1'], true],
    ['SLREFUSE_ALL_DROPPED', 'drop', ['a.kt:1'], [], false],
  ]
  let failed2 = 0
  for (const [name, want, prev, next, allow] of cases2) {
    const got = sourceLinesDropProblem(prev, next, allow)
    const ok = want === null ? got === null : (got !== null && got.length > 0)
    if (!ok) failed2 += 1
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ': ' + (got === null ? 'null' : 'refused'))
  }
  failed += failed2
  console.log((failed === 0 ? 'REFRESH-GUARD SELF-TEST PASSED' : 'REFRESH-GUARD SELF-TEST FAILED')
    + '（' + (cases.length + cases2.length - failed) + '/' + (cases.length + cases2.length) + '）')
  process.exit(failed === 0 ? 0 : 1)
}