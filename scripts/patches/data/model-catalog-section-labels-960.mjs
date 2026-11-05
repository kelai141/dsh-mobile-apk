// model-catalog-section-labels-960.mjs — issue #960 中优先级：
// 同屏出现三个 section[aria-label="模型目录"]，读屏与自动化都分不清在编辑哪一个。
//
// 真因（0.2.1-rc.3 真实产物实测）：
//   ModelListEditor 的 section 一律 "aria-label": t("models")（=「模型目录」）。
//   而「添加提供商」卡片里 catalog 面板与 custom 面板**同时挂载**（隐藏的那个只是 hidden 属性，
//   节点仍在 DOM 与无障碍树里），加上已配置 provider 的行，同屏就有 3 个同名 section。
//   隐藏面板里的「API 地址」「API 密钥」「模型 ID 1」与当前面板完全重名 ⇒ 按 label 定位必错。
//
// 判据（本补丁承诺的行为）：**每个 section 的 aria-label 互不相同，且带上归属标识**。
//   做法：保留原「模型目录」作为前缀（读屏语义不变），追加该 section 所属的 provider 标识；
//   再给隐藏面板补 aria-hidden，把它移出无障碍树——issue 里两条期望都落实。
//
// 为什么不改 t("models")：那是全页共用的词条，改了会连带影响标题与其它引用。

export const MARKER = 'dsh-mobile model catalog section labels (#960)'

/** 锚点：ModelListEditor 的 section 头（含唯一的 aria-label: t("models")）。 */
const OLD = '\t\t\treturn (0, react_jsx_runtime.jsxs)("section", {\n'
  + '\t\t\t\tclassName: ModelsSection_module_css_default["modelCatalog"],\n'
  + '\t\t\t\t"aria-label": t("models"),'

/**
 * 替换：label 追加归属标识。
 *
 * 归属标识取「有 provider 用 provider，没有（自定义卡片）用 custom」：custom 卡片的 probe 本来
 * 就没有 provider 字段，这正是它和目录型 provider 的天然区别。
 */
const NEW = '\t\t\treturn (0, react_jsx_runtime.jsxs)("section", {\n'
  + '\t\t\t\tclassName: ModelsSection_module_css_default["modelCatalog"],\n'
  + '\t\t\t\t/* ' + MARKER + ': 每个目录区带上归属，读屏与按 label 定位都不再撞名。 */\n'
  + '\t\t\t\t"data-dsh-model-catalog": probe.provider === void 0 ? "custom" : probe.provider,\n'
  + '\t\t\t\t"aria-label": t("models") + " · " + (probe.provider === void 0 ? t("customTag") : probe.provider),'

/** 替换里那两段；`has` 用它们区分「完整施加」与「半补丁」。 */
const LABEL_MARK = '"data-dsh-model-catalog": probe.provider === void 0 ? "custom" : probe.provider,'
const ARIA_HIDDEN = '"aria-hidden": mode !== "catalog",'

/** 锚点二：catalog 面板的 hidden 属性（面板内是官方 ProviderEditor 的目录区）。 */
const HIDE_OLD = '\t\t\t\t\t\t\t\t\thidden: mode !== "catalog",'

/** 替换二：隐藏面板同时移出无障碍树。 */
const HIDE_NEW = '\t\t\t\t\t\t\t\t\t/* ' + MARKER + ': 隐藏面板不进无障碍树。 */\n'
  + '\t\t\t\t\t\t\t\t\thidden: mode !== "catalog",\n'
  + '\t\t\t\t\t\t\t\t\t"aria-hidden": mode !== "catalog",'

/**
 * 补丁是否已施加。
 * @param source 被施加的源码
 * @returns 已施加为 true
 */
export function hasModelCatalogSectionLabels(source) {
  // 两处替换都必须在场：只看 marker 会让半补丁被当成已完成。
  return source.includes(MARKER) && source.includes(LABEL_MARK) && source.includes(ARIA_HIDDEN)
}

/**
 * 施加补丁：两处锚点各恰好一处；marker 已在但锚点不完整时拒绝（半补丁）。
 * @param source 被施加的源码
 * @returns 施加后的源码
 */
export function patchModelCatalogSectionLabels(source) {
  if (hasModelCatalogSectionLabels(source)) return source
  const hits = source.split(OLD).length - 1
  if (hits === 0) {
    if (source.includes(MARKER)) {
      throw new Error('model-catalog-section-labels-960: 发现 marker 但原锚点已不存在——半补丁状态，拒绝写回')
    }
    throw new Error('model-catalog-section-labels-960: 目录区锚点未命中（期望 1 处，实际 0 处）——上游 ModelListEditor 已变，请人工核对')
  }
  if (hits > 1) throw new Error('model-catalog-section-labels-960: 目录区锚点命中 ' + hits + ' 处（期望 1 处）——拒绝半补丁')
  const hideHits = source.split(HIDE_OLD).length - 1
  if (hideHits !== 1) throw new Error('model-catalog-section-labels-960: catalog 面板锚点命中 ' + hideHits + ' 处（期望 1 处）——拒绝半补丁')
  const next = source.replace(OLD, NEW).replace(HIDE_OLD, HIDE_NEW)
  if (!next.includes(MARKER)) throw new Error('model-catalog-section-labels-960: 写回后 marker 缺失——拒绝')
  return next
}
