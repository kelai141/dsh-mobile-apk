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
