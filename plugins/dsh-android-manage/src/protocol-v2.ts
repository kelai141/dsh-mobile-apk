/**
 * 控制协议 V2（列式载荷）——解码器（引擎侧）+ 编码器（ADB 路径）。
 *
 * 规范：docs/review/20260910-a11y/DESIGN-PROTOCOL-V2.md §S2（字段）、§S5.2（解码）、§S5.3（XML 编码）。
 * 壳侧 Kotlin 编码器与之逐字同规则（`ControlProtocolV2.kt`）；两路的等价性由跨语言往返门禁锁定
 * （§S6.2 T2：Kotlin 编码 → TS 解码 vs TS 编码 → TS 解码，逐字段相同）。
 *
 * 体积动机（实测冻结口径）：V1 426 B/节点 → V2 54.7 B/行；探针 86 行 = 4,705 B（V1 同场景 37,052 B）。
 * 压缩来自四件事：列式（不重复字段名）、符号表（字符串只发一次）、常数广播（整列同值只发 1 个）、
 * 整数句柄（句柄 = 行下标，不单独发 id）。
 */
import type { UiNode, NodeEntry } from './ui-tree.js'
import { decodeEntities, parseBoundsToBox } from './ui-tree.js'

export const FLAG = {
  clickable: 1,
  scrollable: 2,
  editable: 4,
  checked: 8,
  visible: 16,
  focused: 32,
  selected: 64,
  enabled: 128,
} as const

export type V2View = 'all' | 'target'

export interface V2Decoded {
  gen: number
  rotation: number
  screen: { w: number; h: number }
  rawCount: number
  view: V2View
  /** 与 V1 公开节点同形（resolveRef / render / 工具面零改动）。 */
  rows: UiNode[]
  /** 行下标 → 最近可操作祖先行下标（-1 = 无）。C2 祖先回退的直接答案。 */
  actionableAncestor: Int32Array
  /** 行下标 → 子树结束下标（开区间）。C1 的 @nX 区域限定用它。 */
  subtreeEnd: Int32Array
}

export type DecodeResult = { ok: true; value: V2Decoded } | { ok: false; error: string }

/** 列式载荷的最小形状判定（引擎据此在 V1 兼容路径与 V2 之间分流）。 */
export function isV2Payload(data: unknown): boolean {
  return data !== null && typeof data === 'object' && !Array.isArray(data) &&
    (data as Record<string, unknown>).v === 2
}

const isIntArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/** 常数广播取值（§S2.3）：长度 1 且 n>1 ⇒ 整列同值。 */
const pick = (arr: number[], i: number, n: number): number => (arr.length === 1 && n > 1 ? arr[0] : arr[i])

const sym = (S: string[], k: number): string => (k < 0 ? '' : (S[k] ?? ''))

/** V2 解码。任何结构问题都返回 ok:false（失败关闭；绝不静默产出空节点表）。 */
export function decodeV2(data: unknown): DecodeResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'data 不是对象' }
  const d = data as Record<string, unknown>
  if (d.v !== 2) return { ok: false, error: `不支持的协议版本 v=${String(d.v)}（本引擎支持 v=2）` }

  const gen = Number(d.gen)
  const rot = Number(d.rot ?? 0)
  const scr = d.scr
  if (!Number.isFinite(gen)) return { ok: false, error: 'gen 缺失或非数字' }
  if (!isIntArray(scr) || scr.length !== 2) return { ok: false, error: 'scr 必须是 [宽, 高]' }

  const str = d.str
  if (!Array.isArray(str) || !str.every((s) => typeof s === 'string')) return { ok: false, error: 'str 必须是字符串数组' }
  const S = str as string[]

  const n = Number(d.n)
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'n 必须是非负整数' }
  const view: V2View = d.view === 'target' ? 'target' : 'all'
  const rawCount = Number(d.raw ?? n)
  if (n === 0) {
    return {
      ok: true,
      value: {
        gen, rotation: rot, screen: { w: scr[0], h: scr[1] }, rawCount, view,
        rows: [], actionableAncestor: new Int32Array(0), subtreeEnd: new Int32Array(0),
      },
    }
  }

  const cols: Record<string, number[]> = {}
  for (const key of ['d', 'p', 'f', 'c', 'k', 'r', 'w', 't', 's'] as const) {
    const col = d[key]
    if (!isIntArray(col)) return { ok: false, error: `${key} 必须是整数数组` }
    if (col.length !== 1 && col.length !== n) {
      return { ok: false, error: `${key} 长度 ${col.length} 既不是 1（广播）也不是 n=${n}` }
    }
    cols[key] = col
  }
  const b = d.b
  if (!isIntArray(b) || b.length !== n * 4) {
    return { ok: false, error: `b 长度必须为 4n=${n * 4}（收到 ${Array.isArray(b) ? b.length : '非数组'}）` }
  }

  const rows: UiNode[] = new Array(n)
  const actionableAncestor = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const flag = pick(cols.f, i, n)
    const x = b[i * 4]; const y = b[i * 4 + 1]; const w = b[i * 4 + 2]; const h = b[i * 4 + 3]
    rows[i] = {
      id: 'n' + i,
      parentId: '',                                    // V2 不发父链；祖先回退走 actionableAncestor
      text: sym(S, pick(cols.t, i, n)),
      desc: sym(S, pick(cols.s, i, n)),
      rid: sym(S, pick(cols.r, i, n)),
      type: sym(S, pick(cols.c, i, n)),
      x, y, w, h,
      cx: x + Math.floor(w / 2),
      cy: y + Math.floor(h / 2),
      depth: pick(cols.d, i, n),
      clickable: (flag & FLAG.clickable) !== 0,
      scrollable: (flag & FLAG.scrollable) !== 0,
      editable: (flag & FLAG.editable) !== 0,
      checked: (flag & FLAG.checked) !== 0,
      visible: (flag & FLAG.visible) !== 0,
      pkg: sym(S, pick(cols.k, i, n)),
      windowId: sym(S, pick(cols.w, i, n)),
    }
    actionableAncestor[i] = pick(cols.p, i, n)
  }

  // 子树区间：预序 + 深度 ⇒ 首个更浅或同深的后续行（单调栈，O(n)）
  const subtreeEnd = new Int32Array(n).fill(n)
  const stk: number[] = []
  for (let i = 0; i < n; i++) {
    const di = rows[i].depth
    while (stk.length > 0 && rows[stk[stk.length - 1]].depth >= di) subtreeEnd[stk.pop() as number] = i
    stk.push(i)
  }

  return {
    ok: true,
    value: { gen, rotation: rot, screen: { w: scr[0], h: scr[1] }, rawCount, view, rows, actionableAncestor, subtreeEnd },
  }
}

/**
 * V2 解码结果 → 工具层缓存形状。
 *
 * `origPath` 槽位在 V2 下承载**行句柄**（十进制字符串）：无障碍动作回指不再发原始路径，
 * 改发 `row`（§S5.1 DD-10）。`byOrig` 以行句柄为键，`parentByOrig` 留空（不再用于 V2）。
 */
export function cacheFromV2(v: V2Decoded): {
  nodes: UiNode[]
  byId: Map<string, NodeEntry>
  byOrig: Map<string, NodeEntry>
  parentByOrig: Map<string, string>
} {
  const byId = new Map<string, NodeEntry>()
  const byOrig = new Map<string, NodeEntry>()
  v.rows.forEach((n, i) => {
    const handle = String(i)
    const withOrig: UiNode = { ...n, origPath: handle }
    v.rows[i] = withOrig
    const entry: NodeEntry = { n: withOrig, parentOrig: '', origPath: handle }
    byId.set(withOrig.id, entry)
    byOrig.set(handle, entry)
  })
  return { nodes: v.rows, byId, byOrig, parentByOrig: new Map() }
}

// ── TS 编码器（ADB 路径；与壳侧 Kotlin 编码器逐字同规则） ──────────────────────

interface EncRawNode { attrs: Record<string, string>; id: string; parentId: string }

interface EncRow {
  text: string; desc: string; cls: string; pkg: string; rid: string; windowId: string
  depth: number; x: number; y: number; w: number; h: number; flag: number
}

const attrFlag = (at: Record<string, string>, key: string): boolean =>
  key === 'visible-to-user' || key === 'enabled' ? at[key] !== 'false' : at[key] === 'true'

/**
 * 从**正确解析**的 XML 节点表编码为 V2（ADB 路径用）。
 * 与 Kotlin 编码器同规则：骨架闭包（view=all：正尺寸 ∪ 全部祖先）→ 仅叶子去重 → 符号表 + 广播。
 */
export function encodeV2FromRaw(
  raw: EncRawNode[],
  rotation: number,
  screen: { w: number; h: number },
  gen: number,
  view: V2View = 'all',
): Record<string, unknown> {
  // 1. 全量行（含零尺寸节点——骨架连续性与深度连续性的前提）
  const rows: EncRow[] = raw.map((r) => {
    const at = r.attrs
    const box = parseBoundsToBox(at.bounds)
    const depth = r.id === '' ? 0 : r.id.split('.').length - 1
    let flag = 0
    if (attrFlag(at, 'clickable')) flag |= FLAG.clickable
    if (attrFlag(at, 'scrollable')) flag |= FLAG.scrollable
    if (attrFlag(at, 'editable')) flag |= FLAG.editable
    if (attrFlag(at, 'checked')) flag |= FLAG.checked
    if (attrFlag(at, 'visible-to-user')) flag |= FLAG.visible
    if (attrFlag(at, 'focused')) flag |= FLAG.focused
    if (attrFlag(at, 'selected')) flag |= FLAG.selected
    if (attrFlag(at, 'enabled')) flag |= FLAG.enabled
    return {
      text: decodeEntities(at.text ?? '').trim(),
      desc: decodeEntities(at['content-desc'] ?? '').trim(),
      cls: at.class ?? '',
      pkg: at.package ?? '',
      rid: decodeEntities(at['resource-id'] ?? ''),
      windowId: at['window-id'] ?? '',
      depth,
      x: box.x, y: box.y, w: box.w, h: box.h, flag,
    }
  })
  const n = rows.length
  const actionable = (r: EncRow): boolean =>
    (r.flag & (FLAG.clickable | FLAG.editable | FLAG.scrollable)) !== 0

  // 2. 行集：骨架闭包
  const keep = new Array<boolean>(n).fill(false)
  const ancStack: number[] = []
  for (let i = 0; i < n; i++) {
    while (ancStack.length > 0 && rows[ancStack[ancStack.length - 1]].depth >= rows[i].depth) ancStack.pop()
    const hasArea = rows[i].w > 0 && rows[i].h > 0
    const inSet = view === 'target'
      ? hasArea && (actionable(rows[i]) || rows[i].text !== '' || rows[i].desc !== '')
      : hasArea
    if (inSet) {
      keep[i] = true
      for (const a of ancStack) keep[a] = true
    }
    ancStack.push(i)
  }

  // 3. 子树区间 + 下一个保留行（判「行集内是否为叶子」）
  const subtreeEnd = new Array<number>(n).fill(n)
  const st: number[] = []
  for (let i = 0; i < n; i++) {
    while (st.length > 0 && rows[st[st.length - 1]].depth >= rows[i].depth) subtreeEnd[st.pop() as number] = i
    st.push(i)
  }
  const nextKept = new Array<number>(n).fill(n)
  let nxt = n
  for (let i = n - 1; i >= 0; i--) {
    nextKept[i] = nxt
    if (keep[i]) nxt = i
  }

  // 4. 行集 + 仅叶子去重（DD-5：骨架连接点永不参与去重 ⇒ 深度跳变 0%）
  const out: number[] = []
  const seen = new Set<string>()
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue
    const leafInSet = nextKept[i] >= subtreeEnd[i]
    if (leafInSet) {
      const r = rows[i]
      const key = [r.text, r.desc, r.cls, r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(i)
  }

  // 5. 符号表 + 各列
  const symIndex = new Map<string, number>()
  const str: string[] = []
  const symOf = (s: string): number => {
    if (s === '') return -1
    const hit = symIndex.get(s)
    if (hit !== undefined) return hit
    const i = str.length
    symIndex.set(s, i)
    str.push(s)
    return i
  }
  const d: number[] = []; const p: number[] = []; const b: number[] = []
  const f: number[] = []; const c: number[] = []; const k: number[] = []
  const r: number[] = []; const w: number[] = []; const t: number[] = []; const s: number[] = []
  const stk: number[] = []   // 行集内的祖先（out 下标）
  for (let fi = 0; fi < out.length; fi++) {
    const row = rows[out[fi]]
    while (stk.length > 0 && rows[out[stk[stk.length - 1]]].depth >= row.depth) stk.pop()
    let anc = -1
    for (let j = stk.length - 1; j >= 0; j--) {
      if (actionable(rows[out[stk[j]]])) { anc = stk[j]; break }
    }
    d.push(row.depth); p.push(anc)
    b.push(row.x, row.y, row.w, row.h)
    f.push(row.flag)
    c.push(symOf(row.cls.split('.').pop() ?? '')); k.push(symOf(row.pkg))
    r.push(symOf(row.rid)); w.push(symOf(row.windowId))
    t.push(symOf(row.text)); s.push(symOf(row.desc))
    stk.push(fi)
  }

  return {
    v: 2,
    gen,
    rot: rotation,
    scr: [screen.w, screen.h],
    raw: n,
    view,
    n: out.length,
    str,
    d: broadcast(d), p: broadcast(p), b, f: broadcast(f),
    c: broadcast(c), k: broadcast(k), r: broadcast(r), w: broadcast(w),
    t: broadcast(t), s: broadcast(s),
  }
}

/** 常数广播（§S2.3 D3）：整列同值且 n>1 时只发 1 个元素。`b` 不参与（长度固定 4n）。 */
function broadcast(col: number[]): number[] {
  if (col.length > 1 && col.every((v) => v === col[0])) return [col[0]]
  return col
}
