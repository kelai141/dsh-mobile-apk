// custom-first-model-row-960.mjs — issue #960 中优先级：
// 自定义 provider 卡片在「添加模型」未点时，模型目录区一行都没有（visibleInputs = 0），
// 却已经显示提示「自定义模型 API 至少需要一个模型。」
//
// 真因（0.2.1-rc.3 真实产物实测）：
//   CustomProviderCard 的 models 初值是空数组 []，行只在点「添加模型」时
//   onChange([...models, { id: "" }]) 才出现。而提示语 hint 的判据是
//     ready === false && 其余字段都合法 ⇒ t("customNeedsModels")
//   ——「没有行」和「字段没填」被当成同一件事，于是提示先于任何输入出现。
//   更糟的是表单里存在一个恒为零高的隐藏模板节点，按 aria-label 填模型 ID 会落进去，
//   DOM 里读得回值、React state 里没有，用户以为填了。
//
// 判据（本补丁承诺的行为）：**初态就渲染出第一行模型输入框**。
//   这样 visibleInputs 从第一帧起就是 1，提示语与输入行为不再互相矛盾；
//   按 aria-label 定位到的也是真实可用的行，而不是隐藏模板。
//   （issue 给的是二选一：渲染第一行，或初态不显示提示。选前者——
//   只藏提示会把「填了却不生效」留在原地，而那条才是用户真正会踩的坑。）
//
// 为什么在 models 初值上做：行数与 models 长度一一对应，初值即行数；改初值不需要碰渲染树。
//
// 连带面（同一逻辑改动，不可拆）：初态那一行是**占位**，用户若直接点「获取可用模型」→「添加所选」，
//   adoptPicked 会把 models 全部收进 byId 再 onChange，占位空行会被一起带过去 ⇒ 模型 1 报
//   「模型 ID 不能为空」，提交按钮永远 disabled。所以采纳时按 id 非空过滤，占位行不进结果。

export const MARKER = 'dsh-mobile custom first model row (#960)'

/** 锚点：CustomProviderCard 的 models 初值。 */
const OLD = '\t\t\tconst [models, setModels] = (0, react.useState)([]);'

/** 替换：初态给一行空模型，渲染出第一行输入框。 */
const NEW = '\t\t\t/* ' + MARKER + ': 初态就有一行，输入框与「至少需要一个模型」不再互相矛盾。 */\n'
  + '\t\t\tconst [models, setModels] = (0, react.useState)([{ id: "" }]);'

/** 替换里那两段；`has` 用它们区分「完整施加」与「半补丁」。 */
const ROW_INIT = 'const [models, setModels] = (0, react.useState)([{ id: "" }]);'
const ADOPT_FILTER = 'models.filter((model) => textOf(model, "id").trim().length > 0)'

/** 锚点二：CustomProviderCard 提交时把 models 写进 profile 的那一处。
 * 0.2.2-rc.1 重锚：旧锚点 `const byId = new Map(models.map(...))` 在 0.2.2 里属于**另一个组件**
 * （ModelListEditor 的候选采纳），而 CustomProviderCard 自己的 models 只在这里被写回 profile。
 * 旧锚点在 0.2.1 能命中纯属两个组件当年长得像；指错组件等于补了个不生效的地方。
 * 语义不变：占位空行不得进入写回的 profile。 */
const ADOPT_OLD = '\t\t\t\t\t\tmodels: models.map((model) => ({ ...model }))'

/** 替换二：占位空行不进写回的 profile，否则模型 1 恒报「模型 ID 不能为空」。 */
const ADOPT_NEW = '\t\t\t\t\t\t/* ' + MARKER + ': 占位空行不进写回的 profile。 */\n'
  + '\t\t\t\t\t\tmodels: models.filter((model) => textOf(model, "id").trim().length > 0).map((model) => ({ ...model }))'

/**
 * 补丁是否已施加。
 * @param source 被施加的源码
 * @returns 已施加为 true
 */
export function hasCustomFirstModelRow(source) {
  // 两处替换都必须在场：只看 marker 会让半补丁被当成已完成。
  return source.includes(MARKER) && source.includes(ROW_INIT) && source.includes(ADOPT_FILTER)
}

/**
 * 施加补丁：恰好一处替换；marker 已在但锚点不完整时拒绝（半补丁）。
 * @param source 被施加的源码
 * @returns 施加后的源码
 */
export function patchCustomFirstModelRow(source) {
  if (hasCustomFirstModelRow(source)) return source
  const hits = source.split(OLD).length - 1
  if (hits === 0) {
    if (source.includes(MARKER)) {
      throw new Error('custom-first-model-row-960: 发现 marker 但原锚点已不存在——半补丁状态，拒绝写回')
    }
    throw new Error('custom-first-model-row-960: 锚点未命中（期望 1 处，实际 0 处）——上游 CustomProviderCard 已变，请人工核对')
  }
  if (hits > 1) throw new Error('custom-first-model-row-960: 锚点命中 ' + hits + ' 处（期望 1 处）——拒绝半补丁')
  const adoptHits = source.split(ADOPT_OLD).length - 1
  if (adoptHits !== 1) throw new Error('custom-first-model-row-960: 采纳锚点命中 ' + adoptHits + ' 处（期望 1 处）——拒绝半补丁')
  const next = source.replace(OLD, NEW).replace(ADOPT_OLD, ADOPT_NEW)
  if (!next.includes(MARKER)) throw new Error('custom-first-model-row-960: 写回后 marker 缺失——拒绝')
  if (!next.includes('textOf(model, "id").trim().length > 0')) throw new Error('custom-first-model-row-960: 采纳过滤缺失——拒绝写回')
  return next
}
