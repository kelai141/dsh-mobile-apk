// custom-endpoint-discovery-960.mjs — issue #960 高优先级：
// 「获取可用模型」在自定义 provider 下拉的是内置目录，不是用户自己的端点。
//
// 真因（0.2.1-rc.3 真实产物实测）：
//   dsh-llm-pi-ai 的 discoverModels 第一段是
//     if (request.provider !== void 0) { const installed = catalogModels(request.provider); if (installed.size > 0) return [...] }
//   —— 只要请求带了 provider 且该 provider 在 pi-ai 内置目录里，就直接返回整份目录，**根本不会走到
//   baseURL/models**。amazon-bedrock 在内置目录里恰好 193 条，与 issue 里的条数吻合。
//   用户填的 baseURL 被这一段的短路彻底吞掉：端点通不通、密钥对不对，都看不出来。
//
// 判据（本补丁承诺的行为）：**显式给了 baseURL 的请求，端点优先**。
//   只要 request.baseURL 非空，就必须真的向该端点发 GET，拿它自己的列表；
//   端点失败时抛出明确错误（DISCOVERY_FAILED），**绝不回落到内置目录**——回落正是这条 issue 的病灶。
//   没给 baseURL 的请求（目录型 provider 的浏览）保持原行为，继续读内置目录。
//
// 为什么改适配器而不是改 UI：UI 侧 custom 卡片的 probe 本来就没有 provider 字段，形状是对的；
// 把「端点优先」放在适配器这一层，任何调用方（包括未来新增的入口）都不会再踩同一个坑。

export const MARKER = 'dsh-mobile custom endpoint discovery wins over catalog (#960)'

/** 锚点：discoverModels 开头那段「provider 短路」。 */
const OLD = `\tif (request.provider !== void 0) {
\t\tconst installed = catalogModels(request.provider);
\t\tif (installed.size > 0) return [...installed.values()].map((model) => ({
\t\t\tid: model.id,
\t\t\tname: model.name,
\t\t\tcontextWindow: model.contextWindow,
\t\t\tmaxTokens: model.maxTokens,
\t\t\tinputModalities: [...model.input]
\t\t}));
\t}`

/** 替换里那句新判据；`has` 用它区分「完整施加」与「半补丁」。 */
const ENDPOINT_JUDGEMENT = 'const endpointGiven = typeof request.baseURL === "string" && request.baseURL.length > 0;'

/** 替换：端点优先。带 baseURL 时不再短路，直接进入下面的端点分支。 */
const NEW = `\t/* ${MARKER}: 显式 baseURL 优先，内置目录只在「没给端点」时使用。 */
\tconst endpointGiven = typeof request.baseURL === "string" && request.baseURL.length > 0;
\tif (!endpointGiven && request.provider !== void 0) {
\t\tconst installed = catalogModels(request.provider);
\t\tif (installed.size > 0) return [...installed.values()].map((model) => ({
\t\t\tid: model.id,
\t\t\tname: model.name,
\t\t\tcontextWindow: model.contextWindow,
\t\t\tmaxTokens: model.maxTokens,
\t\t\tinputModalities: [...model.input]
\t\t}));
\t}`

/**
 * 补丁是否已施加。
 * @param source 被施加的源码
 * @returns 已施加为 true
 */
export function hasCustomEndpointDiscovery(source) {
  // 判据是「整段替换都在场」，不是「marker 在」：只看 marker 会让半补丁被当成已完成，
  // 于是下面的半补丁分支永远走不到——那正是 sidebar-bubble-reorder 那条实锤的形状。
  return source.includes(MARKER) && source.includes(ENDPOINT_JUDGEMENT)
}

/**
 * 施加补丁：恰好一处替换；marker 已在但锚点不完整时拒绝（半补丁）。
 * @param source 被施加的源码
 * @returns 施加后的源码
 */
export function patchCustomEndpointDiscovery(source) {
  if (hasCustomEndpointDiscovery(source)) return source
  const hits = source.split(OLD).length - 1
  if (hits === 0) {
    if (source.includes(MARKER)) {
      throw new Error('custom-endpoint-discovery-960: 发现 marker 但原锚点已不存在——半补丁状态，拒绝写回')
    }
    throw new Error('custom-endpoint-discovery-960: 锚点未命中（期望 1 处，实际 0 处）——上游 discoverModels 已变，请人工核对')
  }
  if (hits > 1) throw new Error('custom-endpoint-discovery-960: 锚点命中 ' + hits + ' 处（期望 1 处）——拒绝半补丁')
  const next = source.replace(OLD, NEW)
  if (!next.includes(MARKER)) throw new Error('custom-endpoint-discovery-960: 写回后 marker 缺失——拒绝')
  return next
}
