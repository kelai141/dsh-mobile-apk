/** Additive controller operation for the mobile bubble navigation; upstream stays read-only. */
export const SIDEBAR_REORDER_MARKER = 'dsh-mobile sidebar bubble reorder (B1)'
export const SIDEBAR_REORDER_METHOD = `// dsh-mobile sidebar bubble reorder (B1)
reorderIn(sessionId, tabId, beforeId) {
	if (this.mounted.getSnapshot() !== sessionId) return false;
	const store = this.adopted.get(sessionId)?.store;
	const layout = store?.getSnapshot().bySession[sessionId]?.layout;
	if (!layout?.expanded || layout.tabs[tabId] === void 0) return false;
	const pane = Object.values(layout.nodes).find(node => node.kind === "pane" && node.tabs.includes(tabId));
	if (!pane || pane.host !== "dock" || (beforeId !== void 0 && !pane.tabs.includes(beforeId))) return false;
	const index = beforeId === void 0 ? pane.tabs.length : pane.tabs.indexOf(beforeId);
	const at = pane.tabs.indexOf(tabId);
	if (index === at || index === at + 1) return false;
	const active = layout.nodes[layout.activePaneId]?.activeTabId;
	store.actions.placeTab(sessionId, tabId, pane.id, index);
	if (active !== void 0 && active !== tabId) store.actions.focusTab(sessionId, active);
	return true;
}`

/* 锚点：SidebarRight 控制器的 focus(tabId) 方法（全树只允许命中一种形态、合计恰好 1 处）。
 *
 * 为什么这里同时留三份形态（2026-11 追版 0.2.2-rc.3 重锚）：0.2.2-rc.2 起上游把客户端 bundle 压成
 * 「紧凑单行」——换行与缩进被整段抹掉，标识符一个都没改名。所以判据没失效，失效的是按行书写的锚点。
 * 生产基线（contract.baseline）是 rc.3，紧凑形态是主路径；另外两份是格式化多行形态，其中 MOBILE_FOCUS
 * 对应 Android 源码构建捕获的移动形态夹具（tabId2 + _a2，该类夹具缺席时对应用例自动 skip）。
 * 三份形态互斥（同一份产物最多命中一种），因此「合计恰好 1 处」的判据与重锚前完全等价：
 * 0 处 = 上游改了这个方法（必须失败），多份命中 = 半补丁/重复拷贝（更必须失败）。 */
const COMPACT_FOCUS = /focus\(tabId\)\{const\{sessionId,actions\}=this\.require\(\);if\(this\.mountedSurface\(\)\?\.layout\.tabs\[tabId\]===void 0\)return;actions\.focusTab\(sessionId,tabId\)\}/g
const FOCUS = /^([ \t]*)focus\(tabId\) \{\r?\n\1\tconst \{ sessionId, actions \} = this\.require\(\);\r?\n\1\tif \(this\.mountedSurface\(\)\?\.layout\.tabs\[tabId\] === void 0\) return;\r?\n\1\tactions\.focusTab\(sessionId, tabId\);\r?\n\1\}/gm
const MOBILE_FOCUS = /^(      )focus\(tabId2\) \{\r?\n\1  var _a2;\r?\n\1  const \{ sessionId, actions \} = this\.require\(\);\r?\n\1  if \(\(\(_a2 = this\.mountedSurface\(\)\) == null \? void 0 : _a2\.layout\.tabs\[tabId2\]\) === void 0\) return;\r?\n\1  actions\.focusTab\(sessionId, tabId2\);\r?\n\1\}/gm
const indented = indent => SIDEBAR_REORDER_METHOD.split('\n').map(line => indent + line).join('\n')

/** 三份形态各自的命中位置与缩进；紧凑形态没有行首缩进，故 indent 取空串。 */
function focusAnchors(source) {
  const found = []
  for (const match of source.matchAll(COMPACT_FOCUS)) found.push({ end: match.index + match[0].length, indent: '' })
  for (const match of source.matchAll(FOCUS)) found.push({ end: match.index + match[0].length, indent: match[1] })
  for (const match of source.matchAll(MOBILE_FOCUS)) found.push({ end: match.index + match[0].length, indent: match[1] })
  return found
}

export function hasSidebarReorder(source) {
  const marker = /^([ \t]*)\/\/ dsh-mobile sidebar bubble reorder \(B1\)$/m.exec(source)
  return marker !== null && source.includes(indented(marker[1]))
}

/** Reject unknown or partially changed artifacts before any write. */
export function patchSidebarReorder(source) {
  if (hasSidebarReorder(source)) return source
  if (source.includes(SIDEBAR_REORDER_MARKER) || source.includes('reorderIn(sessionId')) throw new Error('B1: incompatible existing reorder operation')
  const matches = focusAnchors(source)
  if (matches.length !== 1) throw new Error('B1: expected one released SidebarRight focus operation, found ' + matches.length)
  const match = matches[0]
  return source.slice(0, match.end) + '\n' + indented(match.indent) + source.slice(match.end)
}
