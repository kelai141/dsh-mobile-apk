// 控件清单的渲染（从 index.ts 的 tools() 闭包里抽出来的纯逻辑）。
//
// 抽出来的理由：它含**跨节点状态机**（同名节点重复计数 `dupCount` + 已见计数 `seenSoFar`
// + `prevPkg/prevWin` 归属消除重复），这类逻辑最容易在"改一处"时漏掉另一处。

/** 同名/同描述节点的去重键。分隔符必须是文本里不可能出现的字符（`\u0000`）。 */
export function dupKeyOf(text: string, desc: string): string {
  return `${text}\u0000${desc}`
}

/**
 * 渲染控件清单（每行一个节点）。
 *
 * 同名/同描述节点**保留但标注序号**（`#k`，1 基，按 dump 顺序）——模型可用 `text:X#k` 精确引用；
 * 解析层对歧义一律拒绝而非静默挑选（见 `ui-tree.resolveRef`）。
 *
 * **2026-10-28 回归修复**：这里原本有**两份 key**：`dupCount` 的构建用 `'|'` 拼接、
 * 单行渲染用 `'\u0000'` 拼接 ⇒ 两边永远查不到对方 ⇒ `dupCount.get(key)` 恒 `undefined` ⇒
 * **重复序号完全不显示**（模型只能收到「匹配 N 个」的拒绝，无法用 `#k` 精确引用）。
 * 现在两处统一走 [dupKeyOf]。
 */
export function nodeListLines(v: Record<string, unknown>): string {
  const nodes = Array.isArray(v.nodes) ? (v.nodes as Array<Record<string, unknown>>) : []
  const dupCount = new Map<string, number>()
  for (const n of nodes) {
    const text = String(n.text || '').trim()
    const desc = String(n.desc || '').trim()
    // text 与 desc 都空 ⇒ 不参与重复计数（它们本来就无法被 text:/desc: 引用）。
    if (text === '' && desc === '') continue
    const key = dupKeyOf(text, desc)
    dupCount.set(key, (dupCount.get(key) ?? 0) + 1)
  }
  const seenSoFar = new Map<string, number>()
  let prevPkg = ''
  let prevWin = ''
  const lines = nodes.map((n) => {
    const flags = [
      n.clickable ? '可点' : '',
      n.editable ? '可编辑' : '',
      n.scrollable ? '可滚动' : '',
      n.checked ? '已选中' : '',
      n.visible === false ? '不可见' : '',
    ].filter(Boolean).join('/')
    const type = String(n.type || '') || 'View'
    const rid = String(n.rid || '')
    const parent = String(n.parentId || '')
    const text = String(n.text || '').trim()
    const desc = String(n.desc || '').trim()
    const box = `${String(n.x ?? 0)},${String(n.y ?? 0)} ${String(n.w)}x${String(n.h)}`
    const depth = typeof n.depth === 'number' ? n.depth : 0
    const key = dupKeyOf(text, desc)
    let occ = ''
    if ((text !== '' || desc !== '') && (dupCount.get(key) ?? 0) > 1) {
      const k = (seenSoFar.get(key) ?? 0) + 1
      seenSoFar.set(key, k)
      occ = `#${k}`
    }
    const pkg = String(n.pkg || '')
    const win = String(n.windowId || '')
    const owner: string[] = []
    if (pkg !== '' && pkg !== prevPkg) { owner.push(`pkg=${pkg}`); prevPkg = pkg }
    if (win !== '' && win !== prevWin) { owner.push(`win=${win}`); prevWin = win }
    const parts = [
      '  '.repeat(Math.min(depth, 12)) + `${String(n.id)}`,
      parent ? `^${parent}` : '',
      `${type}${rid ? '#' + rid : ''}`,
      `[${flags || '静态'}]`,
      owner.join(' '),
      text ? `text="${text}"${occ}` : '',
      desc ? `desc="${desc}"` : '',
      !text && !desc ? '(无文本)' : '',
      `bounds=${box}`,
    ].filter(Boolean)
    return parts.join(' ')
  })
  return String(v.text ?? '') + (lines.length > 0 ? '\n' + lines.join('\n') : '')
}
