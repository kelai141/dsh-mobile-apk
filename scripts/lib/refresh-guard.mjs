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
 * 比例阈值的**默认值**（issue #1003）。
 *
 * 为什么用「比例」而不是「条数」：符号锚点总数随仓演进，绝对值没有可比性。
 * 实测两种真实形态相差一个数量级以上——
 *   · 正常清理 / 锚点换形态：本仓实测 59 -> 58（1.7%）、93 -> 81（12.9%），必须放行；
 *   · 解析器退化（#868 形态）：132 -> 60（54.5%），必须判红。
 * 20% 把两者分在两侧，且留足余量：锚点迁移这类整批换形态通常一次到位到 0% 或只剩小幅残留，
 * 不会停在中间地带。
 */
export const DEFAULT_SYMBOL_DROP_RATIO = 0.2
/**
 * 绝对条数的**下限**，与比例阈值同时成立才判红。
 *
 * 为什么还要这一层：分母很小时比例会剧烈放大——基线只有 2 条时删 1 条就是 50%，
 * 直接判红会把「刚建基线、还在调整」的正常阶段钉死。加绝对下限后，
 * 小分母抖动走 allow 通道，大分母退化走阈值通道，两条路都留了出口。
 */
export const DEFAULT_SYMBOL_DROP_MIN_COUNT = 3

/**
 * 解析生效的比例阈值：显式实参 > 环境变量 > 默认值。
 *
 * 三个入口都要有，因为三种调用者的处境不同：
 *   · 门禁本体（check-code-map.mjs）用实参，便于 --symbol-drop-max-ratio 覆盖；
 *   · CI / 本地一次性排查用环境变量，不必拼命令行；
 *   · 自检用显式实参，断言不依赖外部环境（否则自检会随机器配置飘）。
 * 非法值一律回落默认：污染的环境变量不能变成「把门禁关掉」的开关。
 */
export function resolveSymbolDropRatio(explicit) {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0 && explicit <= 1) return explicit
  const raw = process.env.DSH_CODE_MAP_SYMBOL_DROP_RATIO
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed
  }
  return DEFAULT_SYMBOL_DROP_RATIO
}

/**
 * 符号锚点段的**下降守卫**（issue #1003）。
 *
 * 判据：本轮文档解析出的符号锚点比旧基线**少**，且**同时**满足
 *   ① 少掉的条数 >= minCount（默认 3）
 *   ② 少掉的占比 > maxRatio（默认 20%）
 *
 * 为什么不能照抄同模块 `sourceLinesDropProblem` 的「有下降就拒」：
 * `sourceLines` 是**按当前引用重建**的（引用消失 ⇒ 键真的从基线消失），那边「基线有、现在没有」
 * 就是字面意义上的「会丢」。`symbols` / `symbolHashes` 不是——`check-code-map.mjs` 写盘时
 * 先展开旧基线再叠加本轮锚点（`symbols = { ...anchorBaselineSymbols() }`），**从不删键**。
 * 所以这里比出来的「下降」并不等于「落盘会丢」，它真正的含义是**文档侧的符号锚点面变小了**，
 * 也就是解析退化的信号。判据按这个语义定阈值，而不是按「会不会丢」定零容忍。
 *
 * 零容忍版本的实测后果：基线里只要有一个文档已不再引用的陈旧键（任何一次锚点迁移都会留下），
 * refresh 就永久被拒，而落盘结果里那个键根本不会消失。本仓实测即
 * `ShellOps.kt#INTERPRETER_NAMES`（59 -> 58，1.7%）把 refresh 钉死，唯一出路是手改基线 JSON
 * ——而这恰是守卫消息自己建议的做法，等于判据在教人绕过判据。
 *
 * @param {string[]} prevKeys 旧基线里该段的键
 * @param {string[]} nextKeys 本轮文档解析出的键
 * @param {{allow?: boolean, maxRatio?: number, minCount?: number}} [options]
 * @returns {string|null} null = 可以写盘；字符串 = 拒绝原因（含真因与两条出路）
 */
export function symbolDropProblem(prevKeys, nextKeys, options = {}) {
  const opts = options ?? {}
  if (opts.allow === true) return null
  if (prevKeys.length === 0) return null
  const next = new Set(nextKeys)
  const dropped = prevKeys.filter((k) => !next.has(k))
  if (dropped.length === 0) return null
  const minCount = typeof opts.minCount === 'number' ? opts.minCount : DEFAULT_SYMBOL_DROP_MIN_COUNT
  const maxRatio = resolveSymbolDropRatio(opts.maxRatio)
  if (dropped.length < minCount) return null
  const ratio = dropped.length / prevKeys.length
  // 严格大于：恰好等于阈值仍放行。阈值是「超过即红」的分界线，
  // 把等号算进红会让「按阈值配的那个具体数字」变成不可用的配置（实际生效值永远比写的大一档）。
  if (ratio <= maxRatio) return null
  const pct = Math.round(ratio * 1000) / 10
  const limitPct = Math.round(maxRatio * 1000) / 10
  return 'symbol anchors would drop ' + dropped.length + '/' + prevKeys.length + ' (' + pct + '%)'
    + ', above the ' + limitPct + '% threshold: '
    + dropped.slice(0, 12).join(', ') + (dropped.length > 12 ? ' …' : '')
    + '。真因通常是**文档侧的符号锚点面变小了**（解析器退化、或一批锚点换了形态），'
    + '不是基线缺登记——先看这些键是否仍在 docs/AGENTS/EXECUTION-MAP.md 里被引用：'
    + '仍在 => 解析退化，修解析器；已删 => 合法清理，加 --allow-symbol-drop 后重跑。'
    + '阈值可用 --symbol-drop-max-ratio <0..1> 或环境变量 DSH_CODE_MAP_SYMBOL_DROP_RATIO 调整'
    + '（当前 ' + limitPct + '%，绝对下限 ' + minCount + ' 条）。'
}

/**
 * @param symbolKeys 文档里解析出的符号锚点（每项含 path / symbol / 可选 symbolHash）
 * @param symbols 即将写入的 symbols 段
 * @param symbolHashes 即将写入的 symbolHashes 段
 * @param prevSymbols 旧基线里 symbols 的键
 * @param prevHashes 旧基线里 symbolHashes 的键
 * @param allowDrop 显式声明「允许符号锚点下降」（issue #1003）
 * @param dropOptions {maxRatio?, minCount?} 阈值覆盖；缺省走 symbolDropProblem 的默认值与环境变量
 * @returns null = 可以写盘；字符串 = 拒绝原因
 */
export function refreshCompletenessProblem(
  symbolKeys, symbols, symbolHashes, prevSymbols, prevHashes, allowDrop = false, dropOptions = {},
) {
  if (symbolKeys.length === 0 && (prevSymbols.length > 0 || prevHashes.length > 0)) {
    return 'the document no longer yields ANY symbol anchor, but the previous baseline had '
      + prevSymbols.length + ' symbols / ' + prevHashes.length + ' hashes'
  }
  // issue #1003：部分丢与全丢同属「文档侧锚点面退化」，用同一口径（比例阈值见 symbolDropProblem）。
  // 全丢那条判据保留在外层：它的文案更具体（点名「一条都不剩」），且自检按文案钉住。
  const opts = { ...(dropOptions ?? {}), allow: allowDrop === true }
  const drop = symbolDropProblem(prevSymbols, symbolKeys.map((a) => a.path + '#' + a.symbol), opts)
  if (drop !== null) return drop
  // **只有 `symbols` 段能用「基线 vs 文档」的比例当退化信号**，`symbolHashes` 段不能 —— 两者的
  // 陈旧键产生率差一个量级，这是实测出来的，不是设计偏好：
  //
  //   · `symbols` 键 = `path#Symbol`。某个符号整条从文档消失才留一条陈旧键，很罕见。
  //     本仓实测 59 -> 58，只有 1 条（`ShellOps.kt#INTERPRETER_NAMES`）。
  //   · `symbolHashes` 键 = `path#Symbol@hash`。任何**被锚定的那一行内容**改动，旧 hash 就永久退休；
  //     而基线写盘是并集（`{ ...旧基线 }` 再叠加本轮），从不删键。于是该段陈旧键随仓龄**单调累积**，
  //     baseline-vs-doc 的比例只增不减。本仓实测 94 -> 75：丢的 19 条里 **18 条是同一符号换了 @hash**
  //     （symbols 段仍然在），只有 1 条是真的符号整条消失。
  //
  // 所以对 hash 段用比例阈值，等于给 refresh 装了一个**倒计时**：今天 20.2% 已经越线，
  // 明天只会更高。上一版（零容忍、且两段同判）因此在干净 main 上就已把 refresh 钉死。
  // hash 段该管的不是「条数变少」，而是「本轮解析出的 @hash 有没有真的进基线」——那是下面
  // missHash 的判据，它按本轮锚点逐个核对，与陈旧键多少无关。这里保留全丢兜底即可（外层已覆盖）。
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
 * 两者**看起来**形状相同，但 issue #1148 之后它们其实可分：只要问一句
 * 「这条锚点还在文档里吗？」
 *
 *   · 文档里**已经没有**这条锚点  ⇒ 基线留着它就是**陈旧键**，清理它是正确的；
 *   · 文档里**仍然有**这条锚点，却取不到内容 ⇒ **解析退化/静默降级**，必须判红。
 *
 * 所以本函数改成「按证据分类，而不是按旗标一刀切」：
 *   - 传入 `stillReferenced`（本次文档里确实还存在的 key 集合）时，只有
 *     `dropped ∩ stillReferenced` 才拒绝；纯陈旧键自动放行并打印；
 *   - 不传时退回旧行为（全部拒绝），保证任何外部调用方都不会因此悄悄放宽。
 *
 * `--allow-source-lines-drop` 保留为显式逃生口：传了就不再做任何拒绝（连降级也放行），
 * 用于人工确认过「我知道这次要丢什么」的场合。
 *
 * @param prevKeys 旧基线里的 sourceLines 键
 * @param nextKeys 即将写入的 sourceLines 键
 * @param allow 是否已显式声明允许下降
 * @param stillReferenced 本次文档里仍然存在的 key 集合（用于区分陈旧键与解析退化）
 * @returns null = 可以写盘；字符串 = 拒绝原因
 */
export function sourceLinesDropProblem(prevKeys, nextKeys, allow, stillReferenced) {
  if (allow) return null
  const next = new Set(nextKeys)
  const dropped = prevKeys.filter((k) => !next.has(k))
  if (dropped.length === 0) return null
  // 未提供分类证据时保持旧口径：一律拒绝（不给外部调用方静默放宽的机会）。
  if (!(stillReferenced instanceof Set)) {
    return 'sourceLines would drop ' + dropped.length + ' key(s): ' + dropped.slice(0, 12).join(', ')
      + (dropped.length > 12 ? ' …' : '')
  }
  // 关键判据：锚点还在文档里、却没能写进新基线 = 解析退化，这才是要拦的那种。
  const degenerate = dropped.filter((k) => stillReferenced.has(k))
  if (degenerate.length > 0) {
    return 'sourceLines references still exist in the document but produced no baseline entry: '
      + degenerate.length + ' key(s): ' + degenerate.slice(0, 12).join(', ')
      + (degenerate.length > 12 ? ' …' : '')
      + ' —— 这是解析退化（静默降级），不是陈旧键清理'
  }
  // 剩下的都是陈旧键：文档里已经没这条锚点了，清掉是正确的。
  return null
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
    // ⑦ issue #1003：大幅部分丢（132 -> 60 = 54.5%）必须拒绝 —— 解析退化的典型形态。
    ['REFUSE_PARTIAL_DROP_132_TO_60', 'drop',
      asAnchors(keys(60)), Object.fromEntries(keys(60).map((key) => [key, 'body'])), {},
      keys(132), []],
    // ⑧ issue #1003：**小幅**下降必须放行。零容忍版本在这里误报，真因是写盘为并集（从不删键），
    //    所以「文档少引用几条」并不等于「基线会丢」。本仓实测形态即 59 -> 58（1.7%，
    //    陈旧键 ShellOps.kt#INTERPRETER_NAMES）。
    ['OK_SMALL_DROP_59_TO_58', null,
      asAnchors(keys(58)), Object.fromEntries(keys(58).map((key) => [key, 'body'])), {},
      keys(59), []],
    // ⑨ 恰好落在阈值上放行；刚越过阈值判红 —— 钉住「超过才红」这个边界口径，
    //    否则配置的百分比会不可用（实际生效值永远比写的大一档）。
    ['OK_AT_THRESHOLD_100_TO_80', null,
      asAnchors(keys(80)), Object.fromEntries(keys(80).map((key) => [key, 'body'])), {},
      keys(100), []],
    ['REFUSE_JUST_OVER_THRESHOLD_100_TO_79', 'drop',
      asAnchors(keys(79)), Object.fromEntries(keys(79).map((key) => [key, 'body'])), {},
      keys(100), []],
    // ⑩ 小分母抖动放行：基线只有 2 条时删 1 条 = 50%，比例看着吓人但属正常调整。
    //    绝对下限（默认 3 条）挡的就是这一类，不能只看比例。
    ['OK_SMALL_DENOMINATOR_2_TO_1', null,
      asAnchors(keys(1)), Object.fromEntries(keys(1).map((key) => [key, 'body'])), {},
      keys(2), []],
    // ⑪ 显式声明后部分丢放行（合法陈旧键清理的口子）
    ['OK_PARTIAL_DROP_ALLOWED', null,
      asAnchors(keys(60)), Object.fromEntries(keys(60).map((key) => [key, 'body'])), {},
      keys(132), [], true],
    // ⑫ issue #1003 的**根因回归位**：`symbolHashes` 段的陈旧键随仓龄单调累积（hash 轮换），
    //    不能拿「基线 vs 文档」的比例当退化信号，否则 refresh 只是早晚被锁死。
    //    本仓实测形态：symbols 只丢 1 条，而 hashes 丢 19/94（20.2%，其中 18 条是同一符号换了 @hash）。
    //    这条断言钉死「hash 段下降不得单独判红」——把它改回参与比例判定，本用例即变红。
    ['OK_STALE_HASH_ROTATION_94_TO_75', null,
      [k('a.kt', 'f', 'h1')], { 'a.kt#f': 'body' }, { 'a.kt#f@h1': true },
      ['a.kt#f'], Array.from({ length: 94 }, (_, i) => 'a.kt#f@stale' + i)],
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
    // 不传第 4 参 = 退回旧口径（一律拒绝）：保证外部调用方拿不到静默放宽。
    const got = sourceLinesDropProblem(prev, next, allow)
    const ok = want === null ? got === null : (got !== null && got.length > 0)
    if (!ok) failed2 += 1
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ': ' + (got === null ? 'null' : 'refused'))
  }
  /* issue #1148：传入 stillReferenced 后必须按**证据**分类，而不是一刀切拒绝。
   * 这是本次改造的核心判据，两条方向都要钉住：
   *   · 文档里已经没有的 key ⇒ 陈旧键，放行（否则干净 main 上永远刷不了）；
   *   · 文档里仍然有的 key 却没进新基线 ⇒ 解析退化，必须拒（否则静默降级）。
   */
  const cases2b = [
    // [name, wantRefused, prev, next, stillReferenced]
    ['SL_STALE_ONLY_PASSES', false, ['gone.kt:1'], [], new Set()],
    ['SL_DEGENERATE_REFUSED', true, ['alive.kt:1'], [], new Set(['alive.kt:1'])],
    ['SL_MIXED_REFUSES_IF_ANY_DEGENERATE', true,
      ['gone.kt:1', 'alive.kt:2'], [], new Set(['alive.kt:2'])],
    ['SL_NO_DROP_WITH_EVIDENCE', false, ['a.kt:1'], ['a.kt:1'], new Set(['a.kt:1'])],
  ]
  for (const [name, wantRefused, prev, next, stillRef] of cases2b) {
    const got = sourceLinesDropProblem(prev, next, false, stillRef)
    const refused = got !== null
    const ok = refused === wantRefused
    if (!ok) failed2 += 1
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ': ' + (refused ? 'refused' : 'null'))
  }
  // #1003：下降守卫的报错必须给出**比例 + 阈值 + 真因 + 两条出路**。
  // 只报条数看不出事故等级；只报「拒绝」会让读日志的人去改基线而不是查解析器。
  const dropMsg = symbolDropProblem(keys(132), keys(60), {}) ?? ''
  const ratio = /\((\d+(?:\.\d+)?)%\)/.exec(dropMsg)
  const ratioOk = ratio !== null && Math.abs(Number(ratio[1]) - 54.5) < 0.2
  if (!ratioOk) failed2 += 1
  console.log((ratioOk ? '  ok   ' : '  FAIL ') + 'SYMBOL_DROP_REPORTS_RATIO: ' + (dropMsg === '' ? 'null' : dropMsg.slice(0, 60)))
  // 同一条消息必须点明真因（文档侧锚点面变小，不是基线缺登记）与两条出路。
  const causeOk = /解析器退化/.test(dropMsg) && /--allow-symbol-drop/.test(dropMsg) && /DSH_CODE_MAP_SYMBOL_DROP_RATIO/.test(dropMsg)
  if (!causeOk) failed2 += 1
  console.log((causeOk ? '  ok   ' : '  FAIL ') + 'SYMBOL_DROP_REPORTS_CAUSE_AND_ESCAPE')
  // 阈值可配置：显式实参 > 环境变量 > 默认值，且非法值一律回落默认（不能让坏配置把门禁关掉）。
  const thresholds = [
    ['默认值 0.2', resolveSymbolDropRatio(undefined), 0.2],
    ['显式实参优先', resolveSymbolDropRatio(0.5), 0.5],
    ['非法实参 2 -> 默认', resolveSymbolDropRatio(2), 0.2],
    ['非法实参 NaN -> 默认', resolveSymbolDropRatio(Number.NaN), 0.2],
  ]
  const prevEnv = process.env.DSH_CODE_MAP_SYMBOL_DROP_RATIO
  process.env.DSH_CODE_MAP_SYMBOL_DROP_RATIO = '0.4'
  thresholds.push(['环境变量生效', resolveSymbolDropRatio(undefined), 0.4])
  thresholds.push(['环境变量被实参覆盖', resolveSymbolDropRatio(0.1), 0.1])
  process.env.DSH_CODE_MAP_SYMBOL_DROP_RATIO = 'bogus'
  thresholds.push(['环境变量非法 -> 默认', resolveSymbolDropRatio(undefined), 0.2])
  if (prevEnv === undefined) delete process.env.DSH_CODE_MAP_SYMBOL_DROP_RATIO
  else process.env.DSH_CODE_MAP_SYMBOL_DROP_RATIO = prevEnv
  for (const [name, got, want] of thresholds) {
    const ok = got === want
    if (!ok) failed2 += 1
    console.log((ok ? '  ok   ' : '  FAIL ') + 'SYMBOL_DROP_RATIO_' + name + ': ' + got + ' / ' + want)
  }
  failed += failed2
  const total = cases.length + cases2.length + cases2b.length + 1 + 2 + thresholds.length
  console.log((failed === 0 ? 'REFRESH-GUARD SELF-TEST PASSED' : 'REFRESH-GUARD SELF-TEST FAILED')
    + '（' + (total - failed) + '/' + total + '）')
  process.exit(failed === 0 ? 0 : 1)
}
