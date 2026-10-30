/**
 * 刷新锚点基线的**完整性判据**（独立模块，纯函数 + 自带自检）。
 *
 * #868 现场：符号锚点解析退化后，`--refresh-anchor-baseline` 的输出从
 * 「1035 legacy references, 127 symbol anchors」变成只有「1035 legacy references」，
 * `symbols` / `symbolHashes` 两段被写成空对象，**且不报错**。
 * 下一次校验就以 `symbol-unbaselined` 红，把排查方向引到「基线没登记」；
 * 照提示再 refresh 只会再丢一次 —— 基线静默降级，属假绿家族。
 *
 * issue #1003（判据失效模式：vacuous pass / 判据在真实调用里是死代码）：
 *   本模块原有三条判据，实际只有**第一条**在工作：
 *   - 「文档一条符号锚点都不剩」只覆盖**全丢**。`132 → 60` 这种**部分丢**直接放行，
 *     而它是解析器退化最常见的形态（换个 shape 一批锚点解析不出来，剩下的照样写盘）；
 *   - 后两条（symbols / symbolHashes 缺条目）在真实调用里**不可能命中**：
 *     `check-code-map.mjs` 先用**旧基线** seed `symbols` / `symbolHashes`，再加本轮锚点，
 *     当前每个 key 必然 `hasOwn === true`。于是那两条是死代码，判据面比看上去窄一半。
 *   修法 = 补与同族 `sourceLinesDropProblem` 同口径的**下降守卫**：本轮解析出的符号锚点数
 *   比旧基线**少**即拒绝写盘，只有显式 `allowSymbolDrop` 才放行（并列出丢掉的键供审阅）。
 *   全丢是「下降 100%」的特例，由同一段逻辑覆盖；缺条目那条仍然是真判据（首次建基线、
 *   或调用方不再 seed 时会命中），保留。
 *
 * 用法：
 *   import { refreshCompletenessProblem } from './lib/refresh-guard.mjs'
 *   node scripts/lib/refresh-guard.mjs --self-test
 */

/**
 * 符号锚点段的**下降守卫**（issue #1003）。口径与同一个模块里的 `sourceLinesDropProblem` 一致：
 * 形状相同的两种含义（合法清理 vs 解析退化）不可区分，所以**不无条件拦、也不无条件放**，
 * 默认拒绝并列出被丢掉的键，显式声明才放行。
 *
 * @param {string[]} prevKeys 旧基线里的符号锚点键
 * @param {string[]} nextKeys 本轮解析出的符号锚点键
 * @param {boolean} allow 是否已显式声明允许下降
 * @returns {string|null} null = 可以写盘；字符串 = 拒绝原因
 */
export function symbolDropProblem(prevKeys, nextKeys, allow) {
  if (allow) return null
  const next = new Set(nextKeys)
  const dropped = prevKeys.filter((k) => !next.has(k))
  if (dropped.length === 0) return null
  // 必须同时给出**比例**，不能只给条数：132→60 与 132→131 的事故等级差一个数量级，
  // 只报「drop 72 key(s)」看不出前者是解析退化、后者是正常清理。
  const pct = prevKeys.length === 0 ? 0 : Math.round((dropped.length / prevKeys.length) * 1000) / 10
  return 'symbol anchors would drop ' + dropped.length + '/' + prevKeys.length + ' (' + pct + '%): '
    + dropped.slice(0, 12).join(', ') + (dropped.length > 12 ? ' …' : '')
    + '；若确认是合法的锚点清理，先从 scripts/check-code-map-anchor-baseline.json 的 symbols/symbolHashes'
    + ' 段删掉这些键（删改会进 git diff，可复核）再重跑刷新'
}

/**
 * @param symbolKeys 文档里解析出的符号锚点（每项含 path / symbol / 可选 symbolHash）
 * @param symbols 即将写入的 symbols 段
 * @param symbolHashes 即将写入的 symbolHashes 段
 * @param prevSymbols 旧基线里 symbols 的键
 * @param prevHashes 旧基线里 symbolHashes 的键
 * @param allowDrop 显式声明「允许符号锚点下降」（issue #1003；默认 false = 拒绝部分丢）
 * @returns null = 可以写盘；字符串 = 拒绝原因
 */
export function refreshCompletenessProblem(symbolKeys, symbols, symbolHashes, prevSymbols, prevHashes, allowDrop = false) {
  if (symbolKeys.length === 0 && (prevSymbols.length > 0 || prevHashes.length > 0)) {
    return 'the document no longer yields ANY symbol anchor, but the previous baseline had '
      + prevSymbols.length + ' symbols / ' + prevHashes.length + ' hashes'
  }
  // issue #1003：部分丢（132 → 60）与全丢同属「基线静默降级」，必须同一口径拒绝。
  // 全丢那条判据保留在外层：它的文案更具体（点名「一条都不剩」），且自检按文案钉住。
  const drop = symbolDropProblem(prevSymbols, symbolKeys.map((a) => a.path + '#' + a.symbol), allowDrop)
  if (drop !== null) return drop
  const dropHash = symbolDropProblem(
    prevHashes,
    symbolKeys.filter((a) => a.symbolHash !== undefined).map((a) => a.path + '#' + a.symbol + '@' + a.symbolHash),
    allowDrop,
  )
  if (dropHash !== null) return dropHash
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
  /** 造 n 个互不相同的符号锚点键（#1003 的比例用例要用真实规模）。 */
  const keys = (n, prefix = 'a.kt') => Array.from({ length: n }, (_, i) => prefix + '#' + 'f' + i)
  const asAnchors = (list) => list.map((key) => {
    const [path, symbol] = key.split('#')
    return { path, symbol }
  })
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
    // ⑦ issue #1003：部分丢（132 → 60）必须拒绝 —— 旧实现这里返回 null
    ['REFUSE_PARTIAL_DROP_132_TO_60', 'drop',
      asAnchors(keys(60)), Object.fromEntries(keys(60).map((key) => [key, 'body'])), {},
      keys(132), []],
    // ⑧ 少量丢（131 → 130）同样要拒绝：门槛不是「丢多少」，而是「有没有声明」
    ['REFUSE_PARTIAL_DROP_131_TO_130', 'drop',
      asAnchors(keys(130)), Object.fromEntries(keys(130).map((key) => [key, 'body'])), {},
      keys(131), []],
    // ⑨ 显式声明后部分丢放行（合法陈旧键清理的口子）
    ['OK_PARTIAL_DROP_ALLOWED', null,
      asAnchors(keys(60)), Object.fromEntries(keys(60).map((key) => [key, 'body'])), {},
      keys(132), [], true],
    // ⑩ 数量增加不判红（新增锚点是正常演进）
    ['OK_GROWTH', null,
      asAnchors(keys(140)), Object.fromEntries(keys(140).map((key) => [key, 'body'])), {},
      keys(132), []],
  ]
  let failed = 0
  for (const [name, want, sk, sy, sh, ps, ph, allow] of cases) {
    const got = refreshCompletenessProblem(sk, sy, sh, ps, ph, allow ?? false)
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
  // #1003：下降守卫自身必须报出比例（只报条数看不出事故等级）
  const dropMsg = symbolDropProblem(keys(132), keys(60), false) ?? ''
  const ratio = /\((\d+(?:\.\d+)?)%\)/.exec(dropMsg)
  const ratioOk = ratio !== null && Math.abs(Number(ratio[1]) - 54.5) < 0.2
  if (!ratioOk) failed2 += 1
  console.log((ratioOk ? '  ok   ' : '  FAIL ') + 'SYMBOL_DROP_REPORTS_RATIO: ' + (dropMsg === '' ? 'null' : dropMsg.slice(0, 60)))
  failed += failed2
  console.log((failed === 0 ? 'REFRESH-GUARD SELF-TEST PASSED' : 'REFRESH-GUARD SELF-TEST FAILED')
    + '（' + (cases.length + cases2.length + 1 - failed) + '/' + (cases.length + cases2.length + 1) + '）')
  process.exit(failed === 0 ? 0 : 1)
}
