// 复合前缀（`text:` / `desc:` / `rid:`）的空值必须在匹配前拒掉（2026-10-28 自查）。
//
// 这三条是**线性字段比对**：`pool.filter(n => n.text === t)`。当目录里恰好只剩一个
// 「该字段为空」的节点（很常见：说明性 TextView、占位 View），`text:` 就会静默命中它并
// 返回 ok —— 模型漏写值的手误于是变成一次**看似成功的点击**，落到完全无关的节点上。
// `id:` 因为 byId 没有 "" 键天然被拒，四条前缀行为不一致；这里统一 fail-closed。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUiTreeXml, pruneNodes, resolveRef } from '../lib/ui-tree.js'

const ATTRS = 'checkable="false" checked="false" enabled="true" focusable="false" focused="false" ' +
  'long-clickable="false" password="false" selected="false" package="com.x"'

/** 根容器 text 非空，子树里只有**一个** text 为空的节点（恰好构成「单匹配」陷阱）。 */
function tree() {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0">` +
    `<node index="0" text="容器" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="确定" resource-id="x:id/a" class="android.widget.Button" ${ATTRS} ` +
        `clickable="true" scrollable="false" bounds="[0,0][100,100]" />` +
      `<node index="1" text="" resource-id="" class="android.widget.TextView" ${ATTRS} ` +
        `clickable="false" scrollable="false" bounds="[0,100][100,200]" />` +
    `</node>` +
  `</hierarchy>`
  const { raw } = parseUiTreeXml(xml)
  return pruneNodes(raw)
}

test('`text:` 空值被拒（不得静默命中唯一的空文本节点）', () => {
  const { nodes, byId } = tree()
  // 前提：确实存在且只存在一个空文本节点 —— 否则本用例测不到「单匹配」陷阱。
  assert.equal(nodes.filter((n) => n.text === '').length, 1)
  const hit = resolveRef(byId, nodes, 'text:')
  assert.equal(hit.ok, false)
  assert.match(hit.error, /值不能为空/)
  assert.match(hit.error, /text:<具体值>/)
})

test('`desc:` / `rid:` 空值同样被拒（四条前缀行为一致）', () => {
  const { nodes, byId } = tree()
  for (const ref of ['desc:', 'rid:']) {
    const hit = resolveRef(byId, nodes, ref)
    assert.equal(hit.ok, false, ref + ' 应被拒')
    assert.match(hit.error, /值不能为空/, ref + ' 的文案')
  }
})

test('带作用域后缀的空值也拒（后缀剥离后仍为空）', () => {
  const { nodes, byId } = tree()
  const hit = resolveRef(byId, nodes, 'text:@n0')
  assert.equal(hit.ok, false)
  assert.match(hit.error, /值不能为空/)
})

test('回归护栏：正常值与消歧后缀行为一字未变', () => {
  const { nodes, byId } = tree()
  const ok = resolveRef(byId, nodes, 'text:确定')
  assert.equal(ok.ok, true)
  assert.equal(ok.node.text, '确定')
  // 只剥后缀不会误伤：`text:容器#1` 仍应命中根容器
  const first = resolveRef(byId, nodes, 'text:容器#1')
  assert.equal(first.ok, true)
  // 全空串 ref 走的是另一条更早的守卫，文案不同（`ref 为空`）
  const empty = resolveRef(byId, nodes, '')
  assert.equal(empty.ok, false)
  assert.match(empty.error, /ref 为空/)
})
