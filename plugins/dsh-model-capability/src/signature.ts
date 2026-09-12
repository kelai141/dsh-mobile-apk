/**
 * 能力补给触发签名（迭代 0.14.0-preview / ST-03，源缺陷 F-PLUG-02）。
 *
 * 缺陷：旧签名只记「字段有无」（把 reasoningEfforts/input/contextWindow/maxTokens 映射成 +/- 串），
 * 不含 baseURL/api，也不含字段值。于是「换网关 / 手改配置 / 端点能力变化」都不会触发重新评估，
 * 旧的思考方言永久留存并按错误方言发请求 —— 配置看起来「已配置」，实际请求被拒。
 *
 * 本模块把签名**值敏感化**：路由级键（含 baseURL/api）取规范化值，模型级能力字段取值，
 * 结构增删同样改变签名。规范化 = 递归按键排序的 JSON（与对象键插入顺序无关）。
 *
 * 自触发说明：写回会改变签名，调用方在写回后立即刷新一次基线（既有行为），因此最多多跑一轮，
 * 且那一轮因「字段已填」不再产生写入 → 签名稳定。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 递归按键排序的规范化字符串；undefined 与缺失同形（'-'）。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '-'
  if (value === null) return 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}'
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value))
  if (typeof value === 'function') return 'fn'
  return JSON.stringify(value) ?? String(value)
}

/** 模型级能力字段（值敏感）。 */
export const CAPABILITY_FIELDS = ['reasoningEfforts', 'input', 'contextWindow', 'maxTokens'] as const

/**
 * 计算 llm-pi-ai 命名空间的补给触发签名。
 * [sectionValue] 是 settings 描述符的命名空间值（含 providers）；[routes] 可选，限定参与计算的路由。
 */
export function capabilitySignature(sectionValue: unknown, routes?: readonly string[]): string {
  const providers = isRecord(sectionValue) && isRecord(sectionValue.providers) ? sectionValue.providers : {}
  const names = (routes && routes.length > 0 ? [...routes] : Object.keys(providers)).slice().sort()
  const parts: string[] = []
  for (const name of names) {
    const route = isRecord(providers[name]) ? providers[name] as Record<string, unknown> : {}
    const routeKeys = Object.keys(route).filter((key) => key !== 'models').sort()
    const routePart = routeKeys.map((key) => key + '=' + canonicalJson(route[key])).join(',')
    const models = Array.isArray(route.models) ? route.models : []
    const modelParts = models.map((model) => {
      if (typeof model === 'string') return model
      const record = isRecord(model) ? model : {}
      const id = String(record.id ?? '?')
      const caps = CAPABILITY_FIELDS.map((field) => field + '=' + canonicalJson(record[field])).join(',')
      const otherKeys = Object.keys(record).filter((key) => key !== 'id' && !(CAPABILITY_FIELDS as readonly string[]).includes(key)).sort()
      const others = otherKeys.map((key) => key + '=' + canonicalJson(record[key])).join(',')
      return id + '{' + caps + (others ? ';' + others : '') + '}'
    })
    parts.push(name + '[' + routePart + '](' + modelParts.join(';') + ')')
  }
  return parts.join('|')
}
