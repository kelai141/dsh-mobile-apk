// 控件清单的渲染（从 index.ts 的 tools() 闭包里抽出来的纯逻辑）。
//
// 抽出来的理由：它含**跨节点状态机**（同名节点重复计数 + 已见计数 + prevPkg/prevWin 归属消除重复），
// 这类逻辑最容易在"改一处"时漏掉另一处。
//
// issue #1405 #1406（2026-11-03）：编号口径统一为**按单一字段**。
//   旧实现按 (text, desc) 成组计数，却只把 #k 拼在 text 上：
//     - desc-only 的重复节点（两个同 desc 的图标按钮）计数有、渲染没有 ⇒ 模型收到「匹配 2 个」
//       却没有任何序号可消歧（#1405）；
//     - 解析侧只按 text 过滤，与渲染的 (text, desc) 分组不是同一套 ⇒ 模型照清单写 text:X#2
//       会点到另一个节点，且回 true（#1406）。
//   现在 text 与 desc **各自**计数、各自标注，解析侧也按同一个单字段过滤 ⇒ 两边编号恒等。

/**
 * 统计某个字段的重复次数（空值不参与）。
 *
 * @param nodes 参与渲染的节点（**就是**模型看到的那一批）。
 * @param pick 取字段的函数。
 * @returns 字段值 -> 出现次数。
 */
function countBy(
  nodes: Array<Record<string, unknown>>,
  pick: (n: Record<string, unknown>) => string,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of nodes) {
    const value = pick(n)
    if (value === '') continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

/**
 * 渲染控件清单（每行一个节点）。
 *
 * 同名节点**保留但标注序号**（`#k`，1 基，按 dump 顺序）——模型可用 `text:X#k` / `desc:Y#k`
 * 精确引用；解析层对歧义一律拒绝而非静默挑选（见 `ui-tree.resolveRef`）。
 *
 * 编号只给**会进入模型上下文的节点**（本函数拿到的 nodes 就是全部）：这里不做额外过滤，
 * 所以既不会给看不见的节点留空号，也不会让渲染与解析的序号错位。
 */
export function nodeListLines(v: Record<string, unknown>): string {
  const nodes = Array.isArray(v.nodes) ? (v.nodes as Array<Record<string, unknown>>) : []
  const textOf = (n: Record<string, unknown>) => String(n.text || '').trim()
  const descOf = (n: Record<string, unknown>) => String(n.desc || '').trim()
  const textCount = countBy(nodes, textOf)
  const descCount = countBy(nodes, descOf)
  const textSeen = new Map<string, number>()
  const descSeen = new Map<string, number>()
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
    const text = textOf(n)
    const desc = descOf(n)
    const box = String(n.x ?? 0) + ',' + String(n.y ?? 0) + ' ' + String(n.w) + 'x' + String(n.h)
    const depth = typeof n.depth === 'number' ? n.depth : 0
    // text 与 desc 各自独立编号：解析侧的 text:X#k 只看 text、desc:Y#k 只看 desc，
    // 所以两边必须是同一套口径（而不是把两个字段拼成一个组键）。
    let occText = ''
    if (text !== '' && (textCount.get(text) ?? 0) > 1) {
      const k = (textSeen.get(text) ?? 0) + 1
      textSeen.set(text, k)
      occText = '#' + k
    }
    let occDesc = ''
    if (desc !== '' && (descCount.get(desc) ?? 0) > 1) {
      const k = (descSeen.get(desc) ?? 0) + 1
      descSeen.set(desc, k)
      occDesc = '#' + k
    }
    const pkg = String(n.pkg || '')
    const win = String(n.windowId || '')
    const owner: string[] = []
    if (pkg !== '' && pkg !== prevPkg) { owner.push('pkg=' + pkg); prevPkg = pkg }
    if (win !== '' && win !== prevWin) { owner.push('win=' + win); prevWin = win }
    const parts = [
      '  '.repeat(Math.min(depth, 12)) + String(n.id),
      parent ? '^' + parent : '',
      type + (rid ? '#' + rid : ''),
      '[' + (flags || '静态') + ']',
      owner.join(' '),
      text ? 'text="' + text + '"' + occText : '',
      desc ? 'desc="' + desc + '"' + occDesc : '',
      !text && !desc ? '(无文本)' : '',
      'bounds=' + box,
    ].filter(Boolean)
    return parts.join(' ')
  })
  return String(v.text ?? '') + (lines.length > 0 ? '\n' + lines.join('\n') : '')
}
