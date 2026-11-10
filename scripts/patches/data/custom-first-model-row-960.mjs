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

/** 三段必须同时生效；`has` 区分完整补丁与半补丁。 */
const ROW_INIT = 'const [models, setModels] = (0, react.useState)([{ id: "" }]);'
const ADOPT_FILTER = 'models.filter((model) => textOf(model, "id").trim().length > 0)'
const PICKER_OLD = '\t\t\t\tif (listed.has(id) && !isPicked(id)) removedRows.add(at);'
const PICKER_DROP = 'if (id.trim().length === 0 || listed.has(id) && !isPicked(id)) removedRows.add(at);'
const PICKER_NEW = '\t\t\t\t/* ' + MARKER + ': 采纳时删除空占位，并同步清理该行编辑状态。 */\n'
  + '\t\t\t\t' + PICKER_DROP

/** 锚点二：CustomProviderCard 提交时把 models 写进 profile 的那一处。
 * 提交过滤只作防御：ready 会先校验整份 models，空行尚在时根本到不了提交。
 * 真正的候选采纳发生在 ModelListEditor，必须先将空行加入 removedRows；这也让
 * rowState.forget 同步清掉索引对应的编辑状态，避免空行状态错配到新模型。 */
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
  // 初值、候选采纳与提交防御必须同时在场，只看 marker 会接受半补丁。
  return source.includes(MARKER) && source.includes(ROW_INIT) && source.includes(ADOPT_FILTER) && source.includes(PICKER_DROP)
}

/**
 * 施加补丁：精确替换三处，或升级已知完整两段补丁；其他半补丁拒绝。
 * @param source 被施加的源码
 * @returns 施加后的源码
 */
export function patchCustomFirstModelRow(source) {
  if (hasCustomFirstModelRow(source)) return source
  // Explicit upgrade of the previously complete two-part patch; other partial states still fail closed.
  const legacyComplete = source.includes(MARKER) && source.includes(ROW_INIT) && source.includes(ADOPT_FILTER)
  const hits = source.split(OLD).length - 1
  if (hits === 0 && !legacyComplete) {
    if (source.includes(MARKER)) {
      throw new Error('custom-first-model-row-960: 发现 marker 但原锚点已不存在——半补丁状态，拒绝写回')
    }
    throw new Error('custom-first-model-row-960: 锚点未命中（期望 1 处，实际 0 处）——上游 CustomProviderCard 已变，请人工核对')
  }
  if (hits > 1) throw new Error('custom-first-model-row-960: 锚点命中 ' + hits + ' 处（期望 1 处）——拒绝半补丁')
  const adoptHits = source.split(ADOPT_OLD).length - 1
  if (adoptHits !== (legacyComplete ? 0 : 1)) throw new Error('custom-first-model-row-960: 提交锚点数量异常——拒绝半补丁')
  const pickerHits = source.split(PICKER_OLD).length - 1
  if (pickerHits !== 1) throw new Error('custom-first-model-row-960: 候选采纳锚点命中 ' + pickerHits + ' 处（期望 1 处）——拒绝半补丁')
  const base = legacyComplete ? source : source.replace(OLD, NEW).replace(ADOPT_OLD, ADOPT_NEW)
  const next = base.replace(PICKER_OLD, PICKER_NEW)
  if (!next.includes(MARKER)) throw new Error('custom-first-model-row-960: 写回后 marker 缺失——拒绝')
  if (!hasCustomFirstModelRow(next)) throw new Error('custom-first-model-row-960: 采纳或提交过滤缺失——拒绝写回')
  return next
}
