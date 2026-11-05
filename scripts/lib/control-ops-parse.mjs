// 控制面登记链门禁的解析原语（2026-10-28 从 check-control-ops.mjs 抽出并补自测）。
//
// 抽出来的理由：这三个函数决定「六处登记面各自解析出什么」，它们一错，门禁就假绿或假红 —
// 而它们原本嵌在顶层直跑的脚本里，**无法被单测触达**（脚本 import 即执行）。
// 抽成模块后 `node scripts/check-control-ops.mjs --self-test` 可直接钉住行为。

/** 提取源码片段里所有单/双引号字符串（按出现顺序）。 */
export function quoted(s) {
  return [...s.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
}

/**
 * 取 `mark` 之后第一个 `open` … 与之配对的 `close` 之间的内容（单层、不配平嵌套）。
 * @returns 片段字符串；定位失败返回 null（调用方据此 failParse）。
 */
export function arrayBlock(src, mark, open, close) {
  const i = src.indexOf(mark)
  if (i < 0) return null
  const o = src.indexOf(open, i)
  if (o < 0) return null
  const c = src.indexOf(close, o + open.length)
  return c < 0 ? null : src.slice(o + open.length, c)
}

/**
 * 类型联合块：从 `mark` 起逐行累积，直到某行「不以引号或竖线结尾」。
 *
 * **空行与注释行必须跳过**（2026-10-28 自查）：旧实现只跳过空行，于是
 * ```ts
 * export type ControlOp =
 *   | 'a'
 *   // 说明
 *   | 'b'
 * ```
 * 在 `// 说明` 那行就 `break`，`'b'` 被静默丢掉 ⇒ 门禁少比一个 op（假绿）。
 * 当前 `ControlOp` 里恰好没有注释行，所以旧实现「看起来是对的」。
 * @returns 累积文本；`mark` 不存在返回 null。
 */
export function unionBlock(src, mark) {
  const i = src.indexOf(mark)
  if (i < 0) return null
  const lines = src.slice(i).split('\n')
  const out = []
  for (const line of lines) {
    out.push(line)
    const t = line.trim()
    if (t.length === 0) continue
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue
    // 注释行不构成联合的终止条件：`//` 行内注释、`/*` / `*` / `*/` 块注释。
    if (!/['|]$/.test(t)) break
  }
  return out.join('\n')
}
