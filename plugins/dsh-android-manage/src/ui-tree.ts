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
  /** 原始边界 left/top（0.13.5：协作轮反馈「精确滑动锚点要自己换算」→ 直接给边界）。 */
  x: number
  y: number
  cx: number
  cy: number
  w: number
  h: number
  /** 层级深度（原始路径段数，根=0；用于渲染缩进树）。 */
  depth: number
  clickable: boolean
  scrollable: boolean
  editable: boolean
  checked: boolean
  /** 节点是否对用户可见（`visible-to-user != false`；用于判断遮挡/滚动容器外）。 */
  visible: boolean
  /** 所属应用包名（多窗口/浮窗归属；XML 路径为空）。 */
  pkg: string
  /** 所属窗口 id（多窗口归属；XML 路径为空）。 */
  windowId: string
  /** 内部字段：原始 XML 路径 id（仅用于子树作用域匹配 `@nX`，不对外渲染）。 */
  origPath?: string
}

export interface UiTree {
  screen: { w: number; h: number }
  rotation: number
  nodes: UiNode[]
  rawCount: number
}

/**
 * 剪枝上限（0.13.5 W4 起**取消截断**——用户拍板：语义树应尽可能结构化且完整地暴露信息，
 * 「复杂多控件环境下截断等于没有用」）。0 = 不限制；保留常量是为了将来按需收紧。
 */
export const PRUNE_LIMITS = { maxNodes: 0, maxText: 0, maxDesc: 0, maxRid: 0, maxType: 0 } as const

const clip = (value: string, limit: number): string => (limit > 0 ? value.slice(0, limit) : value)

/** 内部节点索引条目：公开节点 + 原始路径父链信息（祖先回退 / 无障碍动作回指用）。 */
export interface NodeEntry {
  n: UiNode
  parentOrig: string
  /** 该节点自身的原始路径 id（"0.2.1"）——无障碍通道按路径回指壳侧节点。 */
  origPath: string
}

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
 *
 * 0.13.8 P0-2（产线 bug 修复）：原实现只匹配 `<node ...>` 开标签、从不处理
 * `</node>` 出栈——兄弟节点被错误地压成子节点，depth/父链/`@nX` 区域限定/
 * findActionableAncestor 全部失真（实测最大深度 91 vs 正确 19）。现显式匹配
 * `</node>` 归位；畸形 XML（多余闭标签）按容错弹栈处理。
 */
export function parseUiTreeXml(xml: string): { raw: RawNode[]; rotation: number } {
  let rotation = 0
  const rot = /rotation="(\d+)"/.exec(xml)
  if (rot) rotation = Number(rot[1])

  const raw: RawNode[] = []
  // 栈帧：index = 本节点在同父下的序号；next = 下一个子节点槽位。
  // 虚拟根永远在栈底，其 index 不参与路径。
  const stack: Array<{ index: number; next: number }> = [{ index: -1, next: 0 }]
  const re = /<node\s([^>]*?)(\/?)>|<\/node>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === '</node>') {
      // 闭标签归位（畸形 XML 的多余闭标签按容错忽略——不弹虚拟根）
      if (stack.length > 1) stack.pop()
      continue
    }
    const attrsText = m[1] ?? ''
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

/**
 * 解析结果结构自检（0.13.8 P0-2）：解析结果与源 XML 自相矛盾时**响亮拒绝**，
 * 绝不静默产出错树（错误树比没有树更危险）。
 * 检查：① 节点标签计数与解析产出一一对应；② 根节点必为 "0"；
 * ③ 栈未完全归位（未闭合的开标签）视为畸形——按容错放行但由调用方标记。
 */
export function checkUiTreeParse(xml: string, raw: RawNode[]): { ok: true } | { ok: false; reason: string } {
  const tagCount = (xml.match(/<node[\s>]/g) ?? []).length
  if (raw.length !== tagCount) {
    return { ok: false, reason: `节点数不一致：XML 含 ${tagCount} 个 <node> 标签，解析产出 ${raw.length} 条（源 XML 畸形或版本不兼容）` }
  }
  if (raw.length > 0 && raw[0].id !== '0') {
    return { ok: false, reason: `根节点 id 应为 "0"，实得 "${raw[0].id}"（栈机归位错误）` }
  }
  const maxDepth = raw.reduce((acc, r) => Math.max(acc, r.id === '' ? 0 : r.id.split('.').length), 0)
  if (maxDepth > 128) {
    return { ok: false, reason: `最大深度 ${maxDepth} 超出合理上界（128）——栈机未归位，解析结果不可信` }
  }
  return { ok: true }
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
  byId: Map<string, NodeEntry>
  byOrig: Map<string, NodeEntry>
  /** 原始 XML 路径 id → 父路径 id（**含被剪掉的中间层**，祖先回退用）。 */
  parentByOrig: Map<string, string>
} {
  const seen = new Set<string>()
  const nodes: UiNode[] = []
  // 全量父链（含剪掉的节点）：祖先回退要能跳过被剪的中间层。
  const parentByOrig = new Map<string, string>()
  let rawCount = 0
  for (const r of raw) {
    rawCount++
    parentByOrig.set(r.id, r.parentId)
    const at = r.attrs
    const bounds = parseBounds(at.bounds)
    if (!bounds) continue
    const text = decodeEntities(at.text ?? '').trim()
    const desc = decodeEntities(at['content-desc'] ?? '').trim()
    const clickable = at.clickable === 'true'
    const scrollable = at.scrollable === 'true'
    const editable = at.editable === 'true'
    // 0.13.5：不再按「可交互或带标签」剪枝——完整暴露（容器/无标签节点同样给模型，
    // 复杂界面靠结构定位；去重仍保留，避免同一位置同内容的重复行）。
    const dedupeKey = [text, desc, at.class ?? '', bounds.cx, bounds.cy].join('|')
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    nodes.push({
      id: r.id,
      parentId: r.parentId,
      text: clip(text, limits.maxText),
      desc: clip(desc, limits.maxDesc),
      rid: clip(decodeEntities(at['resource-id'] ?? ''), limits.maxRid),
      type: clip((at.class ?? '').split('.').pop() ?? '', limits.maxType),
      x: bounds.cx - Math.floor(bounds.w / 2),
      y: bounds.cy - Math.floor(bounds.h / 2),
      cx: bounds.cx,
      cy: bounds.cy,
      w: bounds.w,
      h: bounds.h,
      depth: r.id === '' ? 0 : r.id.split('.').length,
      clickable,
      scrollable,
      editable,
      checked: at.checked === 'true',
      visible: at['visible-to-user'] !== 'false',
      pkg: at.package ?? '',
      windowId: at['window-id'] ?? '',
    })
  }
  // 0.13.8 P0-3：DFS 真树序（原始路径字典序 = 前序遍历）——0.13.5 的「分档排序」把兄弟
  // 节点按档位/坐标打乱，模型看到的相邻行出现 21.8% 的深度跳变（真树遍历不可能），
  // 层级感知完全失效。真树序下 depth 严格递变 ≤1，配合 parentId（最近幸存祖先）层级唯一。
  // 阅读序信息不丢失：同层节点保持 XML 顺序（uiautomator 已按 top-left 序输出）。
  nodes.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
  // 0.13.5：maxNodes=0 表示不截断（用户拍板：完整暴露，复杂界面才可用）
  const kept = limits.maxNodes > 0 ? nodes.slice(0, limits.maxNodes) : nodes
  // 重编号：n0..nN-1；父引用按原始路径映射到**最近的幸存祖先**（被剪掉的中间层自动上溯）。
  const byId = new Map<string, NodeEntry>()
  const byOrig = new Map<string, NodeEntry>()
  const origToIdx = new Map<string, number>()
  kept.forEach((n, i) => origToIdx.set(n.id, i))
  const publicParentOf = (origParent: string): string => {
    let cur = origParent
    for (let i = 0; i < 64 && cur !== ''; i++) {
      const idx = origToIdx.get(cur)
      if (idx !== undefined) return 'n' + idx
      cur = parentByOrig.get(cur) ?? ''
    }
    return ''
  }
  const publicNodes = kept.map((n, i) => ({ ...n, id: 'n' + i, parentId: publicParentOf(n.parentId), origPath: n.id }))
  publicNodes.forEach((n, i) => {
    const entry: NodeEntry = { n, parentOrig: kept[i].parentId, origPath: kept[i].id }
    byId.set('n' + i, entry)
    byOrig.set(kept[i].id, entry)
  })
  return { nodes: publicNodes, rawCount, byId, byOrig, parentByOrig }
}

/** 解析语义引用（"id:n3" / "text:设置" / "desc:搜索" / "rid:..."；裸数字按 id）。
 *
 *  0.13.5（用户指出的误判风险）：同名节点**必须保留**，但解析到多个候选时**绝不静默挑一个**——
 *  返回 ok:false 并列出全部候选（id/类型/坐标），让模型改用 `id:nN` 精确引用。
 *  两种消歧后缀：
 *    - `text:新建会话#2`  —— 取 dump 顺序里的第 2 个匹配（1 基）
 *    - `text:新建会话@n5` —— 只在 n5 的子树内匹配（区域限定，避免侧边栏/主区同名互相污染）
 */
export function resolveRef(
  byId: Map<string, NodeEntry>,
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
  // 消歧后缀：#N（第 N 个匹配）/ @nX（限定在 nX 子树内）
  let occurrence = 0
  let scopeId = ''
  const occMatch = /#(\d+)\s*$/.exec(value)
  if (occMatch) {
    occurrence = Number(occMatch[1])
    value = value.slice(0, occMatch.index)
  }
  const scopeMatch = /@(n\d+)\s*$/.exec(value)
  if (scopeMatch) {
    scopeId = scopeMatch[1]
    value = value.slice(0, scopeMatch.index)
  }
  const t = value.trim()
  let pool = nodes
  if (scopeId !== '') {
    const scope = byId.get(scopeId)
    if (!scope) return { ok: false, error: `作用域 ${scopeId} 不在最近一次 dump 中——请重新 android_ui_dump` }
    const scopePath = scope.origPath
    pool = nodes.filter((n) => {
      const p = n.origPath ?? ''
      return p === scopePath || p.startsWith(scopePath + '.')
    })
    if (pool.length === 0) pool = [scope.n]
  }
  const cands = pool.filter((n) => (kind === 'text' ? n.text === t : kind === 'desc' ? n.desc === t : n.rid === t))
  if (cands.length === 0) {
    return { ok: false, error: `没有 ${kind} 为 "${t.slice(0, 30)}" 的节点${scopeId ? `（作用域 ${scopeId}）` : ''}——请重新 android_ui_dump 确认当前页面` }
  }
  if (occurrence > 0) {
    if (occurrence > cands.length) {
      return { ok: false, error: `${kind} "${t.slice(0, 30)}" 只有 ${cands.length} 个匹配，请求的是第 ${occurrence} 个`, matches: cands.slice(0, 8) }
    }
    return { ok: true, node: cands[occurrence - 1], matches: cands.length > 1 ? cands : undefined }
  }
  if (cands.length === 1) return { ok: true, node: cands[0] }
  // 多个候选：不猜。列出候选（含类型/坐标），让模型用 id 或 #N / @nX 消歧。
  const list = cands.slice(0, 8).map((n, i) => `${n.id}(${n.type || 'View'} @${n.cx},${n.cy})`).join('、')
  return {
    ok: false,
    error: `${kind} "${t.slice(0, 30)}" 匹配 ${cands.length} 个节点（${list}${cands.length > 8 ? ' …' : ''}）——`
      + `请改用 id:nN 精确引用，或用 ${kind}:${t.slice(0, 20)}#N 指定第 N 个，或用 @nX 限定区域`,
    matches: cands.slice(0, 8),
  }
}

/** 沿父链（原始 XML 路径）找第一个可点击/可编辑祖先——目标节点不可点时的回退。
 *
 *  注意两套 id 的边界：模型看到/引用的是重编号后的公开 id（n0/n1…），而 byOrig 以
 *  **原始 XML 路径 id**（"0.2.1"）为键。旧实现用 `byOrig.get(node.id)` 查公开 id，
 *  永远查不到 → 祖先回退静默失效（2026-09-08 修复）。入口必须走 byId（公开 id → 条目），
 *  再沿 parentByOrig 的全量父链上溯，跳过被剪枝的中间层。 */
export function findActionableAncestor(
  byId: Map<string, NodeEntry>,
  byOrig: Map<string, NodeEntry>,
  parentByOrig: Map<string, string>,
  node: UiNode,
): UiNode | null {
  const entry = byId.get(node.id) ?? byOrig.get(node.id)
  if (!entry) return null
  let cur = entry.parentOrig
  for (let i = 0; i < 32 && cur !== ''; i++) {
    const hit = byOrig.get(cur)
    if (hit && (hit.n.clickable || hit.n.editable || hit.n.scrollable)) return hit.n
    cur = parentByOrig.get(cur) ?? ''
  }
  return null
}