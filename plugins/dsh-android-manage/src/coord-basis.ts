// 归一化坐标基准的回显（issue #258）——从 `index.ts` 的 `tools()` 闭包里抽出来的纯逻辑。
//
// 抽出来的理由：`tools()`（2477 行）**没有任何单测**（测试只覆盖 ui-tree / protocol-v2 /
// vd-shot / detail-store），而这两段是「这缺陷下次能不能自证」的关键 —— 它们决定返回体里带不带
// 基准字段、文案怎么标。抽成模块后可直接钉住行为。

/** 壳侧版本兼容标记：老壳侧不回显基准时文案里的这句即为唯一线索（wire 上有测试钉住）。 */
export const COMPAT_NOTE = '（基准未回显：壳侧版本较旧）'

/**
 * 把壳侧回显的基准渲染成文案（issue #258 自证面）。
 *
 * 缺陷形态：多窗口/自由窗口下壳侧曾用**当前窗口**尺寸（而非整屏）当分母，`nx=0.712` 被算成
 * `0.712*733=522`（屏幕左侧），DSH 自身浮窗整块点不到。修好后壳侧在返回值里带
 * `basis/basisWidth/basisHeight`，本函数把它渲染进文案 —— 这样同类缺陷下次**自证**。
 *
 * 老壳侧不回显基准时**如实标注**而不是假装知道：回显的全部意义就是自证，猜一个基准等于又制造
 * 一个看不见的错。
 */
export function coordBasisNote(data: unknown): string {
  const d = (data ?? {}) as { basis?: unknown; basisWidth?: unknown; basisHeight?: unknown }
  if (typeof d.basis !== 'string' || d.basis === '') return COMPAT_NOTE
  // 文案侧必须给出**具体数值**（它的全部意义就是让人看出这次按哪块尺寸换算），所以非有限数
  // 按 0 呈现；而返回值侧的 basisFields 是「不带键」（那边要过 schema，NaN 会让整值被拒）。
  // 两处策略不同是刻意的，别「统一」——但都不能把 NaN 原样吐给模型看。
  const w = typeof d.basisWidth === 'number' && Number.isFinite(d.basisWidth) ? d.basisWidth : 0
  const h = typeof d.basisHeight === 'number' && Number.isFinite(d.basisHeight) ? d.basisHeight : 0
  // window-current = 壳侧未拿到整屏尺寸（issue #258 的缺陷基准），必须显式告警。
  const warn = d.basis === 'window-current'
    ? '——本机未给出整屏尺寸，本次按**当前窗口**换算，多窗口下可能偏左'
    : ''
  return `（基准 ${d.basis} = ${w}x${h}${warn}）`
}

/**
 * 把壳侧回显的基准字段并进工具返回值（schema 已声明 basis/basisWidth/basisHeight）。
 *
 * 只在壳侧真的回显时才带键 —— 老壳侧不回显时**不编造** 0 值（那会让「没回显」看起来像
 * 「基准是 0x0」）；文案侧由 [coordBasisNote] 如实标注。
 */
export function basisFields(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as { basis?: unknown; basisWidth?: unknown; basisHeight?: unknown }
  if (typeof d.basis !== 'string' || d.basis === '') return {}
  return {
    basis: d.basis,
    // 同 `screenOut` 的自查结论：只查 `typeof === 'number'` 会让 NaN/Infinity 透传，
    // 而它们不是合法 JSON，引擎在 `{type:'number'}` 下整值拒绝（0.13.8 #204 同族）。
    ...(typeof d.basisWidth === 'number' && Number.isFinite(d.basisWidth) ? { basisWidth: d.basisWidth } : {}),
    ...(typeof d.basisHeight === 'number' && Number.isFinite(d.basisHeight) ? { basisHeight: d.basisHeight } : {}),
  }
}
