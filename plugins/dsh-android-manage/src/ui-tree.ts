/**
 * UI 树解析与剪枝（ADB 2.0 Phase A，PRD-0.13.2 §3.2）。
 *
 * 输入：uiautomator dump 的 hierarchy XML（厂商 ROM 噪音容忍——调用方以
 * 「UI hierchary dumped to:」为成功信号，segfault/非零退出码属噪音）。
 * 输出：紧凑语义节点表（可交互 + 关键文本节点，去重、剪裁、封顶），供模型
 * 以语义目标（id/text/desc 引用）驱动 android_ui_click / android_ui_scroll。
 *
 * token 策略：只保留可交互 + 有文本/描述节点、剪属性、截断长文本、封顶
 * 节点数——树清单远便宜于截图，大页面宁可截断也不反超（调研 §4）。
 */

export interface UiNode {
  /** 深度路径 id（如 "0.1.2"），同一次 dump 内稳定，作语义点击引用。 */
  id: string
  /** 父节点 id（可点击祖先回退用）；根节点为空串。 */
  parentId: string
  text: string
  desc: string
  /** resource-id（截 60）。 */
  rid: string
  /** class 短名（截 24）。 */
  type: string
  cx: number
  cy: number
  w: number
  h: number
  clickable: boolean
  scrollable: boolean
  editable: boolean
  checked: boolean
}

export interface UiTree {
  screen: { w: number; h: number }
  rotation: number
  nodes: UiNode[]
  rawCount: number
}

export const PRUNE_LIMITS = { maxNodes: 60, maxText: 50, maxDesc: 50, maxRid: 60, maxType: 24 } as const

const ATTR_RE = /([a-zA-Z-]+)="([^"]*)"/g

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
}

/** 解析 bounds="[x1,y1][x2,y2]"；畸形/零尺寸返回 null（该节点丢弃）。 */
function parseBounds(b: string | undefined): { cx: number; cy: number; w: number; h: number } | null {
  if (!b) return null
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b)
  if (!m) return null
  const x1 = Number(m[1]); const y1 = Number(m[2]); const x2 = Number(m[3]); const y2 = Number(m[4])
  const w = x2 - x1; const h = y2 - y1
  if (w <= 0 || h <= 0) return null
  return { cx: x1 + Math.floor(w / 2), cy: y1 + Math.floor(h / 2), w, h }
}

interface RawNode { attrs: Record<string, string>; id: string; parentId: string }

/**
 * 解析 hierarchy XML → 原始节点表（含深度路径 id 与父 id）。
 * 单一栈机：开标签下钻、自闭合同层计数、闭标签归位；对厂商畸形输出
 * （属性缺省/坏 bounds）按节点丢弃，不中断整体解析。
 */
export function parseUiTreeXml(xml: string): { raw: RawNode[]; rotation: number } {
  let rotation = 0
  const rot = /rotation="(\d+)"/.exec(xml)
  if (rot) rotation = Number(rot[1])

  const raw: RawNode[] = []
  // 栈帧：index = 本节点在同父下的序号；next = 下一个子节点槽位。
  // 虚拟根永远在栈底，其 index 不参与路径。
  const stack: Array<{ index: number; next: number }> = [{ index: -1, next: 0 }]
  const re = /<node\s([^>]*?)(\/?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const attrsText = m[1]
    const selfClosing = m[2] === '/'
    const attrs: Record<string, string> = {}
    ATTR_RE.lastIndex = 0
    let a: RegExpExecArray | null
    while ((a = ATTR_RE.exec(attrsText)) !== null) attrs[a[1]] = a[2]
    const parent = stack[stack.length - 1]
    const index = parent.next
    parent.next++
    const path = stack.slice(1).map((f) => f.index).concat(index)
    const id = path.join('.')
    const parentId = path.length > 1 ? path.slice(0, -1).join('.') : ''
    raw.push({ attrs, id, parentId })
    if (!selfClosing) stack.push({ index, next: 0 })
  }
  return { raw, rotation }
}

/** 剪枝：只保留可交互或带标签的节点；去重 → 分档排序 → 封顶截断。
 *  输出节点重编号为 n0/n1/…（深层 XML 路径 id 过长费 token；编号在同一次 dump
 *  内稳定）。byId/byOrig 为内部解析索引（工具侧缓存持有，不序列化给模型）。 */
export function pruneNodes(
  raw: RawNode[],
  limits: typeof PRUNE_LIMITS = PRUNE_LIMITS,
): {
  nodes: UiNode[]
  rawCount: number
  byId: Map<string, { n: UiNode; parentOrig: string }>
  byOrig: Map<string, { n: UiNode; parentOrig: string }>
} {
  const seen = new Set<string>()
  const nodes: UiNode[] = []
  let rawCount = 0
  for (const r of raw) {
    rawCount++
    const at = r.attrs
    const bounds = parseBounds(at.bounds)
    if (!bounds) continue
    const text = decodeEntities(at.text ?? '').trim()
    const desc = decodeEntities(at['content-desc'] ?? '').trim()
    const clickable = at.clickable === 'true'
    const scrollable = at.scrollable === 'true'
    const editable = at.editable === 'true'
    const actionable = clickable || scrollable || editable
    const labelled = text !== '' || desc !== ''
    if (!actionable && !labelled) continue
    const dedupeKey = [text, desc, at.class ?? '', bounds.cx, bounds.cy].join('|')
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    nodes.push({
      id: r.id,
      parentId: r.parentId,
      text: text.slice(0, limits.maxText),
      desc: desc.slice(0, limits.maxDesc),
      rid: decodeEntities(at['resource-id'] ?? '').slice(0, limits.maxRid),
      type: (at.class ?? '').split('.').pop()?.slice(0, limits.maxType) ?? '',
      cx: bounds.cx,
      cy: bounds.cy,
      w: bounds.w,
      h: bounds.h,
      clickable,
      scrollable,
      editable,
      checked: at.checked === 'true',
    })
  }
  // 分档排序：可交互带标签 > 可交互 > 带标签；同档按 y 再 x（阅读序）。
  const tier = (n: UiNode): number => (n.clickable || n.editable || n.scrollable) && (n.text || n.desc) ? 0 : (n.clickable || n.editable || n.scrollable) ? 1 : 2
  nodes.sort((p, q) => tier(p) - tier(q) || p.cy - q.cy || p.cx - q.cx)
  const kept = nodes.slice(0, limits.maxNodes)
  // 重编号：n0..nN-1；父引用按原始路径映射（父被剪掉时置空串，祖先回退走 byOrig 原路径）。
  const byId = new Map<string, { n: UiNode; parentOrig: string }>()
  const byOrig = new Map<string, { n: UiNode; parentOrig: string }>()
  const origToIdx = new Map<string, number>()
  kept.forEach((n, i) => origToIdx.set(n.id, i))
  kept.forEach((n, i) => {
    const entry = { n: { ...n, id: 'n' + i, parentId: '' }, parentOrig: n.parentId }
    byId.set('n' + i, entry)
    byOrig.set(n.id, entry)
  })
  return { nodes: kept.map((n, i) => ({ ...n, id: 'n' + i, parentId: '' })), rawCount, byId, byOrig }
}

/** 解析语义引用（"id:n3" / "text:设置" / "desc:搜索" / "rid:..."；裸数字按 id）。
 *  id 引用走 byId 内部索引；文本/描述匹配返回首个可交互项。 */
export function resolveRef(
  byId: Map<string, { n: UiNode; parentOrig: string }>,
  nodes: UiNode[],
  ref: string,
): { ok: true; node: UiNode; matches?: UiNode[] } | { ok: false; error: string; matches?: UiNode[] } {
  const r = ref.trim()
  if (r === '') return { ok: false, error: 'ref 为空' }
  let kind: 'id' | 'text' | 'desc' | 'rid' = 'id'
  let value = r
  const colon = r.indexOf(':')
  if (colon > 0) {
    const k = r.slice(0, colon)
    if (k === 'id' || k === 'text' || k === 'desc' || k === 'rid' || k === 'num') {
      kind = k === 'num' ? 'id' : (k as 'id' | 'text' | 'desc' | 'rid')
      value = r.slice(colon + 1)
    }
  }
  if (kind === 'id') {
    const hit = byId.get(value)
    if (!hit) return { ok: false, error: `id "${value}" 不在最近一次 dump 中（页面可能已变化）——请重新 android_ui_dump` }
    return { ok: true, node: hit.n }
  }
  const t = value.trim()
  const cands = nodes.filter((n) => (kind === 'text' ? n.text === t : kind === 'desc' ? n.desc === t : n.rid === t))
  if (cands.length === 0) {
    return { ok: false, error: `没有 ${kind} 为 "${t.slice(0, 30)}" 的节点——请重新 android_ui_dump 确认当前页面` }
  }
  const clickable = cands.filter((n) => n.clickable || n.editable)
  const pick = clickable[0] ?? cands[0]
  return cands.length === 1 || clickable.length === 1
    ? { ok: true, node: pick }
    : { ok: true, node: pick, matches: cands.slice(0, 5) }
}

/** 沿父链（原始 XML 路径）找第一个可点击/可编辑祖先——目标节点不可点时的回退。 */
export function findActionableAncestor(
  byOrig: Map<string, { n: UiNode; parentOrig: string }>,
  node: UiNode,
): UiNode | null {
  const entry = byOrig.get(node.id)
  if (!entry) return null
  let cur = entry.parentOrig
  for (let i = 0; i < 16 && cur !== ''; i++) {
    const hit = byOrig.get(cur)
    if (!hit) break
    if (hit.n.clickable || hit.n.editable || hit.n.scrollable) return hit.n
    cur = hit.parentOrig
  }
  return null
}