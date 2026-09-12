/**
 * 无损 JSON 投影（0.14.0-preview：android_privilege_status 返回体被工具面判
 * "invalid output: value is not lossless JSON" 的修复，与 #204/D 系列同型）。
 *
 * 缺陷形态：接口里的**可选键**被显式赋成 undefined（message: undefined、
 * caps: undefined），运行时序列化时这些键要么消失、要么让「无损 JSON」判定失败——
 * 声明面（schema 的可选键）与返回面（在场但 undefined）就此脱钩。
 *
 * 处置（§2.5 的 fail-closed/fail-open 裁决）：**可选键缺省就整键不发**，绝不发 undefined。
 * 这是 fail-open 的一侧：字段缺失是可判定的（消费方按缺省处理），而「在场但 undefined」
 * 会让整个返回体被运行时拒收——比缺字段更坏。
 *
 * 用法：所有面向工具返回面 / HTTP 响应体的聚合对象在出口处过一遍 toLosslessJson。
 */

/** JSON 可无损往返的值域。 */
export type LosslessJson = null | boolean | number | string | LosslessJson[] | { [key: string]: LosslessJson }

/**
 * 递归投影为无损 JSON：
 *  - 对象成员为 undefined → **整键删除**（可选键缺省不发）；
 *  - 函数 / symbol / bigint 成员 → 删除（不可序列化）；
 *  - 数组元素为 undefined → 保留位置，写成 null（删元素会移动下标，反而丢信息）；
 *  - 非有限数（NaN/Infinity）→ null（JSON.stringify 同样会写成 null，这里显式化）；
 *  - Date → ISO 字符串（Object.entries 会把它投影成 {}，那是真丢信息）。
 *
 * @param value 任意运行期值（通常由若干 service 调用拼接而成）
 * @returns 可无损 JSON 往返的值（JSON.parse(JSON.stringify(x)) 与 x 深相等）
 */
export function toLosslessJson(value: unknown): LosslessJson {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toLosslessJson(item))
  if (typeof value === 'object') {
    const out: Record<string, LosslessJson> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      const kind = typeof item
      if (kind === 'function' || kind === 'symbol' || kind === 'bigint') continue
      out[key] = toLosslessJson(item)
    }
    return out
  }
  // function / symbol / bigint（顶层）：不可序列化，退化为 null 并由调用方自行解释
  return null
}

/** 递归断言：值里不含任何 undefined 成员（离线用例与门禁共用）。 */
export function findUndefinedPaths(value: unknown, path = '$'): string[] {
  const found: string[] = []
  if (value === undefined) {
    found.push(path)
    return found
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) found.push(...findUndefinedPaths(value[i], path + '[' + i + ']'))
    return found
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return found
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      found.push(...findUndefinedPaths(item, path + '.' + key))
    }
  }
  return found
}
