// replace-once.mjs — 补丁锚点的「恰好一处」替换（issue #1384）。
//
// 为什么需要它：`String.prototype.replace(字符串, …)` 只换**第一处**且不校验出现次数。上游
// bundle 里同一锚点出现两份时（chunk 合并、同函数两份拷贝），补丁只改一份，而 marker 已插入
// → `check()` 恒真 → 之后每轮都 `[skip] 已应用`，第二处的旧行为永远暴露不出来。
//
// 判据取「出现次数必须恰好是 1」：0 次 = 锚点已变（该失败，不是静默空转）；≥2 次 = 半补丁
// （更该失败，因为它看起来成功了）。两件事都只能靠异常暴露，日志拦不住。
//
// 这是 `scripts/patches/data/registry-scan-c4.mjs` 里那份私有实现的提取版：同一判据只写一处。

/**
 * @param {string} source 被施加的源码
 * @param {string} before 锚点（字面量，不是正则）
 * @param {string} after  替换文本
 * @param {string} [label] 诊断标签（缺省用锚点前 60 字符）
 * @returns {string} 替换后的源码
 * @throws 锚点出现次数不等于 1 时抛出（附出现次数与标签）
 */
export function replaceOnce(source, before, after, label) {
  if (typeof before !== 'string' || before === '') {
    throw new Error('replaceOnce: anchor must be a non-empty string')
  }
  const hits = source.split(before).length - 1
  if (hits !== 1) {
    const what = label ?? before.slice(0, 60).replace(/\s+/g, ' ')
    throw new Error(`anchor mismatch (expected exactly one occurrence, found ${hits}): ${what}`)
  }
  return source.replace(before, after)
}

/**
 * 「最多一处」变体（issue #1384 复审）：给**升级型**锚点用——0 次是合法状态（文件已经是新形态），
 * 1 次正常替换，**≥2 次仍然抛**（那才是半补丁）。
 *
 * 为什么不能一律用 [replaceOnce]：S2 的遗留升级路径要在「旧形态」与「已升级形态」之间辨认，
 * 它的 import 锚点在新形态文件里根本不存在。旧写法 `String.replace` 对 0 次静默不动，于是这条
 * 路径以前是「碰巧能用」；`replaceOnce` 会把这种合法的「不需要替换」判成锚点漂移。
 *
 * 判据边界写死在这里：**只有 0 次被容忍**。1 次以上一律按半补丁处理，不给自己留「多改一处也没事」的口子。
 */
export function replaceAtMostOnce(source, before, after, label) {
  if (typeof before !== 'string' || before === '') {
    throw new Error('replaceAtMostOnce: anchor must be a non-empty string')
  }
  const hits = source.split(before).length - 1
  if (hits === 0) return source
  if (hits > 1) {
    const what = label ?? before.slice(0, 60).replace(/\s+/g, ' ')
    throw new Error(`anchor mismatch (expected at most one occurrence, found ${hits}): ${what}`)
  }
  return source.replace(before, after)
}

/** 数「模式能匹配到几处」。全局计数必须带 `g`；零宽匹配手动推进 lastIndex，否则死循环。 */
const countMatches = (source, pattern) => {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const probe = new RegExp(pattern.source, flags)
  let hits = 0
  let m
  while ((m = probe.exec(source)) !== null) {
    hits += 1
    if (m[0] === '') probe.lastIndex += 1
  }
  return hits
}

/** 诊断标签：把模式原样印出来（正则的 source 往往比字面量更短、更不好认）。 */
const describePattern = (pattern) => ('/' + pattern.source + '/' + pattern.flags).slice(0, 80)

/**
 * 正则锚点的「恰好一处」替换（issue #1531）。
 *
 * 为什么不能直接把正则喂给 [replaceOnce]：它的判据是 `source.split(before).length - 1`，对正则来说
 * 那是把 `re.source` **当成字面量**去数——`\r?\n`、`[\s\S]*?`、`[ \t]*` 这些能被模式匹配到的
 * 文本一处也数不出来（实测：apply-patches.mjs 里 8 处正则锚点的 source 串在被测文件里出现 0 次）。
 * 于是「锚点出现几次」只能问模式本身，也就是 `String.match` 的全局匹配。
 *
 * 计数与替换各用一份独立的正则对象：计数必须带 `g`；替换要去掉 `g`（恰好一处时两者等价，但去掉后
 * 不会误替换第二处），并且不污染调用方正则的 `lastIndex`。
 *
 * @param {string} source 被施加的源码
 * @param {RegExp} pattern 锚点模式
 * @param {string|Function} after 替换文本（支持 $1 分组）或回调
 * @param {string} [label] 诊断标签（缺省用模式原文）
 * @returns {string} 替换后的源码
 * @throws 模式匹配次数不等于 1 时抛出（附出现次数与标签）
 */
export function replaceOnceRe(source, pattern, after, label) {
  if (!(pattern instanceof RegExp)) {
    throw new Error('replaceOnceRe: anchor must be a RegExp')
  }
  const hits = countMatches(source, pattern)
  if (hits !== 1) {
    const what = label ?? describePattern(pattern)
    throw new Error(`anchor mismatch (expected exactly one occurrence, found ${hits}): ${what}`)
  }
  return source.replace(new RegExp(pattern.source, pattern.flags.replace(/g/g, '')), after)
}

/**
 * 正则锚点的「最多一处」变体（issue #1531）：给**升级型**正则锚点用——0 处是合法状态
 * （文件已经是目标形态），1 处正常替换，**≥2 处仍然抛**（那才是半补丁）。
 *
 * 判据边界与 [replaceAtMostOnce] 一致：**只有 0 次被容忍**。
 */
export function replaceAtMostOnceRe(source, pattern, after, label) {
  if (!(pattern instanceof RegExp)) {
    throw new Error('replaceAtMostOnceRe: anchor must be a RegExp')
  }
  const hits = countMatches(source, pattern)
  if (hits === 0) return source
  if (hits > 1) {
    const what = label ?? describePattern(pattern)
    throw new Error(`anchor mismatch (expected at most one occurrence, found ${hits}): ${what}`)
  }
  return source.replace(new RegExp(pattern.source, pattern.flags.replace(/g/g, '')), after)
}
