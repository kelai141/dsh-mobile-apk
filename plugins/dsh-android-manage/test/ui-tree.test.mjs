// UI 树祖先回退回归（2026-09-08 修复）：模型引用的是重编号公开 id（n0/n1…），
// 而 byOrig 以原始 XML 路径 id 为键——旧实现用公开 id 查 byOrig 永远落空，
// 不可点击目标的「可点击祖先」回退静默失效。本测试锁死该边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUiTreeXml, pruneNodes, resolveRef, findActionableAncestor, checkUiTreeParse } from '../lib/ui-tree.js'

const ATTRS = 'checkable="false" checked="false" enabled="true" focusable="false" focused="false" ' +
  'long-clickable="false" password="false" selected="false" package="com.android.settings"'

function hierarchy(inner) {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0">${inner}</hierarchy>`
}

test('resolves the clickable ancestor of a non-clickable labelled node', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="1" text="" resource-id="com.android.settings:id/row" class="android.widget.LinearLayout" ${ATTRS} ` +
        `clickable="true" scrollable="false" bounds="[0,100][1080,200]">` +
        `<node index="0" text="设置" resource-id="com.android.settings:id/title" class="android.widget.TextView" ${ATTRS} ` +
          `clickable="false" scrollable="false" bounds="[20,120][200,180]" />` +
      `</node>` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId, byOrig, parentByOrig } = pruneNodes(raw)

  const hit = resolveRef(byId, nodes, 'text:设置')
  assert.equal(hit.ok, true)
  assert.equal(hit.node.clickable, false)
  assert.match(hit.node.id, /^n\d+$/)

  const ancestor = findActionableAncestor(byId, byOrig, parentByOrig, hit.node)
  assert.ok(ancestor, 'clickable ancestor must be found through the public id index')
  assert.equal(ancestor.clickable, true)
  assert.equal(ancestor.rid, 'com.android.settings:id/row')
})

test('returns null when no ancestor survived pruning', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="仅文本" resource-id="com.android.settings:id/title" class="android.widget.TextView" ${ATTRS} ` +
        `clickable="false" scrollable="false" bounds="[20,120][200,180]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId, byOrig, parentByOrig } = pruneNodes(raw)

  const hit = resolveRef(byId, nodes, 'text:仅文本')
  assert.equal(hit.ok, true)
  assert.equal(findActionableAncestor(byId, byOrig, parentByOrig, hit.node), null)
})

test('walks up through an intermediate pruned node via the original path chain', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="" resource-id="com.android.settings:id/list" class="android.widget.ListView" ${ATTRS} ` +
        `clickable="false" scrollable="true" bounds="[0,0][1080,1920]">` +
        `<node index="0" text="" resource-id="com.android.settings:id/wrapper" class="android.widget.FrameLayout" ${ATTRS} ` +
          `clickable="false" scrollable="false" bounds="[0,100][1080,200]">` +
          `<node index="0" text="无线网络" resource-id="com.android.settings:id/title" class="android.widget.TextView" ${ATTRS} ` +
            `clickable="false" scrollable="false" bounds="[20,120][200,180]" />` +
        `</node>` +
      `</node>` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId, byOrig, parentByOrig } = pruneNodes(raw)

  const hit = resolveRef(byId, nodes, 'text:无线网络')
  assert.equal(hit.ok, true)
  const ancestor = findActionableAncestor(byId, byOrig, parentByOrig, hit.node)
  assert.ok(ancestor)
  assert.equal(ancestor.scrollable, true)
  assert.equal(ancestor.rid, 'com.android.settings:id/list')
})

// ── 0.13.5：同名节点消歧（用户指出的误判风险）───────────────────────────────
test('同名节点保留且歧义时拒绝静默挑选，列出候选', () => {
  const xml = hierarchy(
    `<node index="0" text="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="新建会话" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[0,100][400,200]" />` +
      `<node index="1" text="新建会话" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[500,100][900,200]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId } = pruneNodes(raw)
  const dup = nodes.filter((n) => n.text === '新建会话')
  assert.equal(dup.length, 2, '同名节点必须都保留')

  const ambiguous = resolveRef(byId, nodes, 'text:新建会话')
  assert.equal(ambiguous.ok, false, '多候选不得静默挑一个')
  assert.match(ambiguous.error, /匹配 2 个节点/)
  assert.match(ambiguous.error, /id:nN/)
  assert.equal(ambiguous.matches.length, 2)

  const byOccurrence = resolveRef(byId, nodes, 'text:新建会话#2')
  assert.equal(byOccurrence.ok, true)
  assert.equal(byOccurrence.node.id, dup[1].id)

  const outOfRange = resolveRef(byId, nodes, 'text:新建会话#3')
  assert.equal(outOfRange.ok, false)

  const byIdRef = resolveRef(byId, nodes, 'id:' + dup[0].id)
  assert.equal(byIdRef.ok, true)
  assert.equal(byIdRef.node.id, dup[0].id)
})

test('作用域引用 @nX 只在子树内匹配，避免侧边栏/主区同名互相污染', () => {
  const xml = hierarchy(
    `<node index="0" text="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="" class="android.widget.LinearLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][300,1920]">` +
        `<node index="0" text="确定" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[10,10][290,90]" />` +
      `</node>` +
      `<node index="1" text="" class="android.widget.LinearLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[300,0][1080,1920]">` +
        `<node index="0" text="确定" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[320,10][600,90]" />` +
      `</node>` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId } = pruneNodes(raw)
  const scopes = nodes.filter((n) => n.type === 'LinearLayout')
  assert.equal(scopes.length, 2)
  const right = resolveRef(byId, nodes, `text:确定@${scopes[1].id}`)
  assert.equal(right.ok, true)
  assert.equal(right.node.cx > 300, true, '应命中右半区那个「确定」')
})

// ── 0.13.8 P0-2/P0-3 回归：栈机归位 + 结构自检 + DFS 真树序 ──

test('栈机正确归位：兄弟节点不再被压成子节点（depth/父链可信）', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="A" resource-id="id/a" class="android.widget.TextView" ${ATTRS} clickable="true" scrollable="false" bounds="[0,0][100,100]" />` +
      `<node index="1" text="B" resource-id="id/b" class="android.widget.TextView" ${ATTRS} clickable="true" scrollable="false" bounds="[0,200][100,300]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  // 修复前：B 的 id 是 0.0.1（A 的"子节点"）；修复后：B 与 A 同层，id=0.1
  const a = raw.find((r) => r.attrs['resource-id'] === 'id/a')
  const b = raw.find((r) => r.attrs['resource-id'] === 'id/b')
  assert.equal(a.id, '0.0')
  assert.equal(b.id, '0.1')
  assert.equal(b.parentId, '0')

  const { nodes } = pruneNodes(raw)
  // depth 跳变 ≤ 1（DFS 真树序的铁律）
  for (let i = 1; i < nodes.length; i++) {
    const jump = Math.abs(nodes[i].depth - nodes[i - 1].depth)
    assert.ok(jump <= 1, `相邻行深度跳变 ${jump} > 1（n${i - 1}→n${i}）——不是真树序`)
  }
})

test('结构自检 checkUiTreeParse：节点数不一致响亮拒绝', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]" />`,
  )
  // 模拟坏解析：把同一节点解析出两条
  const { raw } = parseUiTreeXml(xml)
  const doubled = [...raw, { ...raw[0], id: '0.0.0', parentId: raw[0].id }]
  const check = checkUiTreeParse(xml, doubled)
  assert.equal(check.ok, false)
  assert.match(check.reason, /节点数不一致/)
})

test('结构自检 checkUiTreeParse：正常 XML 通过', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="A" resource-id="id/a" class="android.widget.TextView" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][100,100]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const check = checkUiTreeParse(xml, raw)
  assert.equal(check.ok, true)
})

test('DFS 真树序：prune 后节点按原始路径前序排列（不再分档打乱）', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="ZZZ-last-by-tier" resource-id="id/z" class="android.widget.TextView" ${ATTRS} clickable="false" scrollable="false" bounds="[0,900][100,1000]" />` +
      `<node index="1" text="AAA-clickable" resource-id="id/a" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[0,0][100,100]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes } = pruneNodes(raw)
  // 分档排序曾把可点击的 AAA 排到最前；真树序下容器在前、兄弟按 XML 顺序
  const zIdx = nodes.findIndex((n) => n.rid === 'id/z')
  const aIdx = nodes.findIndex((n) => n.rid === 'id/a')
  assert.ok(zIdx < aIdx, `DFS 序应容器(z, idx=${zIdx})在兄弟(a, idx=${aIdx})之前`)
})

test('解析等价性门禁：父子关系与独立递归实现一致（抽样结构断言）', () => {
  // 三层嵌套：独立实现按「<node 配对计数」推导父子，与栈机输出比对
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="" resource-id="id/left" class="android.widget.LinearLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][540,1920]">` +
        `<node index="0" text="L1" resource-id="id/l1" class="android.widget.TextView" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][100,100]" />` +
        `<node index="1" text="L2" resource-id="id/l2" class="android.widget.TextView" ${ATTRS} clickable="false" scrollable="false" bounds="[0,100][100,200]" />` +
      `</node>` +
      `<node index="1" text="R" resource-id="id/right" class="android.widget.TextView" ${ATTRS} clickable="false" scrollable="false" bounds="[540,0][100,100]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  // 独立推导（按嵌套层级手工标注的期望值）：
  const expected = {
    '0': { parent: '', depth: 0 },
    '0.0': { parent: '0', depth: 1 },
    '0.0.0': { parent: '0.0', depth: 2 },
    '0.0.1': { parent: '0.0', depth: 2 },
    '0.1': { parent: '0', depth: 1 },
  }
  for (const r of raw) {
    const e = expected[r.id]
    assert.ok(e, `意外 id ${r.id}`)
    assert.equal(r.parentId, e.parent, `id=${r.id} 父链不符`)
  }
  assert.equal(raw.length, Object.keys(expected).length)
})
