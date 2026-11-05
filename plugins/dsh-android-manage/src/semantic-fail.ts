// 无障碍动作失败的结构化回执（从 index.ts 的 tools() 闭包里抽出来的纯逻辑）。
//
// 三件套（actionMode / screenId / guidance）都是「壳侧真回显才带」的字段：它们的意义是让模型
// 在同一轮改用别的通道，所以**不该出现空串占位**（那看起来像"回显了但没内容"）。

export interface SemanticFailInput {
  error?: string
  actionMode?: unknown
  screenId?: unknown
  guidance?: unknown
}

export interface SemanticFailOutput {
  ok: boolean
  denied: boolean
  text: string
  actionMode?: string
  screenId?: string
  guidance?: string
}

/**
 * 把壳侧失败回执渲染成工具返回值。
 *
 * **2026-10-28 自查**：`actionMode` 原本只查 `typeof === 'string'`，而 `screenId`/`guidance` 都额外
 * 排除了空串 ⇒ 壳侧回 `""` 时只有 `actionMode` 会被带出去。空串没有任何诊断价值，且会让模型
 * 误以为"回显了通道模式但值缺失"。三处统一排除空串。
 */
export function semanticFail(r: SemanticFailInput, prefix: string): SemanticFailOutput {
  const out: Record<string, unknown> = { ok: false, denied: false, text: prefix + (r.error ?? '未知失败') }
  if (typeof r.actionMode === 'string' && r.actionMode !== '') out.actionMode = r.actionMode
  if (typeof r.screenId === 'string' && r.screenId !== '') out.screenId = r.screenId
  if (typeof r.guidance === 'string' && r.guidance !== '') out.guidance = r.guidance
  return out as unknown as SemanticFailOutput
}
