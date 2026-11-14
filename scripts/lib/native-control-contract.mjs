// 原生控制链的解析与对比原语（2026-11-14 迁移；Rust / Kotlin / TypeScript 三面共用）。
//
// 设计约束：
// - 只读取真实源码文本，锚点缺失一律返回 null → 调用方 fail-closed；
// - 不缓存仓库状态，命令行门禁与测试可以使用同一组函数；
// - Rust 的 OPERATIONS 是 op 目录的单一权威，Kotlin/TS 的清单必须被它覆盖，而不是反过来。

/** 提取单/双引号字符串（按出现顺序）。 */
export function quoted(text) {
  return [...text.matchAll(/'([^']+)'|"([^"]+)"/g)].map((match) => match[1] ?? match[2])
}

/**
 * 取 `mark` 之后第一个 `open` 与 `close` 之间的片段（单层，不配平嵌套）。
 * 注释/字符串中出现同名标记仍可能命中；调用方必须同时验证解析结果的形态。
 */
export function blockAfter(text, mark, open, close) {
  const start = text.indexOf(mark)
  if (start < 0) return null
  const from = text.indexOf(open, start)
  if (from < 0) return null
  const to = text.indexOf(close, from + open.length)
  return to < 0 ? null : text.slice(from + open.length, to)
}

/** 类型联合块：跳过空行/注释，直到某行不以引号或竖线结尾。 */
export function unionAfter(text, mark) {
  const start = text.indexOf(mark)
  if (start < 0) return null
  const lines = []
  for (const line of text.slice(start).split('\n')) {
    lines.push(line)
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
    if (!/['|]$/.test(trimmed)) break
  }
  return lines.join('\n')
}

/**
 * Rust `pub static OPERATIONS: &[OperationSpec] = &[ spec(...), ... ]`。
 * 返回 `{ name, targetDomain, backend, scope, readsDisplay }`，失败返回 null。
 */
export function parseRustOperations(text, mark = 'pub static OPERATIONS') {
  // 形态是 `pub static OPERATIONS: &[OperationSpec] = &[ ... ]`：必须从赋值符后的 `&[` 起取，
  // 否则会命中类型注解里的 `&[OperationSpec]`，解析结果为空 → 真实门禁永久假红。
  const anchor = text.indexOf(mark)
  if (anchor < 0) return null
  const equals = text.indexOf('= &[', anchor)
  if (equals < 0) return null
  const start = equals + '= &['.length
  const end = text.indexOf(']', start)
  if (end < 0) return null
  const body = text.slice(start, end)
  const rows = []
  // 枚举名里有数字（`A11yPreferred`）：字符类必须含 0-9，否则 `A11yPreferred` 会截成 `A`，
  // 整条 spec 匹配失败且**不报错**——这是迁移过程中最容易出现的静默假绿。
  const pattern = /spec\(\s*"([A-Za-z][A-Za-z0-9]*)"\s*,\s*TargetDomain::([A-Za-z0-9]+)\s*,\s*BackendRequirement::([A-Za-z0-9]+)\s*,\s*ScopePolicy::([A-Za-z0-9]+)\s*,\s*(true|false)\s*,?\s*\)/g
  for (const match of body.matchAll(pattern)) {
    rows.push({ name: match[1], targetDomain: match[2], backend: match[3], scope: match[4], readsDisplay: match[5] === 'true' })
  }
  return rows.length === 0 ? null : rows
}

/** TypeScript `export const NAME = [ 'a', ... ] as const`。 */
export function parseTsArray(text, symbol) {
  const body = blockAfter(text, 'export const ' + symbol, '= [', ']')
  if (body === null) return null
  const values = quoted(body)
  return values.length === 0 ? null : values
}

/** TypeScript `export type Name = 'a' | 'b'`。 */
export function parseTsUnion(text, symbol = 'ControlOp') {
  const body = unionAfter(text, 'export type ' + symbol + ' =')
  if (body === null) return null
  const values = quoted(body)
  return values.length === 0 ? null : values
}

/** Kotlin `val NAME = setOf("a", "b")` 或 `private val NAME = setOf(...)`。 */
export function parseKotlinSet(text, symbol) {
  const body = blockAfter(text, symbol, 'setOf(', ')')
  if (body === null) return null
  const values = [...body.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1])
  return values.length === 0 ? null : values
}

/** 有序去重；用于稳定输出。 */
export function unique(values) {
  return [...new Set(values)]
}

export function sorted(values) {
  return [...values].sort()
}

export function missingFrom(left, right) {
  const rightSet = new Set(right)
  return unique(left).filter((value) => !rightSet.has(value)).sort()
}

export function sameSet(left, right) {
  const a = unique(left).sort()
  const b = unique(right).sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** 两仓相对路径归一化（Windows 工作树用反斜杠）。 */
export function toPosix(relativePath) {
  return relativePath.replace(/\\/g, '/')
}
