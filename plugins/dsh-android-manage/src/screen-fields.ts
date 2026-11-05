// 屏幕三件套的字段归一化（从 index.ts 的 tools() 闭包里抽出来的纯逻辑）。
//
// 抽出来的理由同 coord-basis.ts：`tools()` 没有单测，这几段决定返回体带不带某个键。
// 共同契约：**只在壳侧真回显时才带键，绝不编造默认值**（否则「没回显」看起来像「值为 0/x」）。

/** `android_*` 的 screenId 参数归一化：非空字符串才下发（缺省不发键＝真实屏语义）。 */
export function screenArgs(args: unknown): Record<string, unknown> {
  const screenId = (args as { screenId?: unknown } | undefined)?.screenId
  return typeof screenId === 'string' && screenId !== '' ? { screenId } : {}
}

/**
 * 把壳侧回执里的屏幕三件套 + actionMode 并进工具返回值。
 *
 * **数值必须过 `Number.isFinite`**（2026-10-28 自查）：旧实现只查 `typeof === 'number'`，
 * `NaN`/`Infinity` 会被当有效值透传 —— 而它们不是合法 JSON，引擎侧在 `{type:'number'}` 下
 * 会**整值拒绝**，模型拿不到任何数据（0.13.8 #204 的同一族教训）。同文件 `:1481` 早就用
 * `Number.isFinite(rawW)` 了，这里与之对齐。
 */
export function screenOut(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as { screenId?: unknown; displayId?: unknown; scope?: unknown; actionMode?: unknown }
  const out: Record<string, unknown> = {}
  if (typeof d.screenId === 'string' && d.screenId !== '') out.screenId = d.screenId
  if (typeof d.displayId === 'number' && Number.isFinite(d.displayId)) out.displayId = d.displayId
  if (typeof d.scope === 'string' && d.scope !== '') out.scope = d.scope
  if (typeof d.actionMode === 'string' && d.actionMode !== '') out.actionMode = d.actionMode
  return out
}

/** 纯 Shizuku（无障碍关）下虚拟屏的坐标模式结构化响应（SPEC §4.2）。 */
export function coordinateMode(screenId: string, reason: string, guidance: string): Record<string, unknown> {
  return { ok: false, actionMode: 'coordinate', screenId, reason, guidance }
}
