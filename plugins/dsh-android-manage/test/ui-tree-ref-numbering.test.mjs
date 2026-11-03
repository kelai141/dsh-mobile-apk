// issue #1405 #1406：清单渲染的 #k 与解析的 #N 必须是**同一套编号**。
//
// 判据取**往返**：把清单里每一个 text=/desc= 标签（含它的 #k）反解回 resolveRef，
// 结果必须就是那一行对应的节点。这比分别断言两边更硬——它锁的是「两边一致」这件事本身。
//
// 旧实现的两处偏差：
//   #1405 只把 #k 拼在 text 上 ⇒ desc-only 的重复节点有计数、无序号；
//   #1406 渲染按 (text, desc) 分组计数，解析只按 text 过滤 ⇒ 同一行写出的 #k 反向解析会命中别的节点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUiTreeXml, pruneNodes, resolveRef } from '../lib/ui-tree.js'
import { nodeListLines } from '../lib/node-list.js'

const ATTRS = 'checkable="false" checked="false" enabled="true" focusable="false" focused="false" ' +
  'long-clickable="false" password="false" selected="false" package="com.example"'

function hierarchy(inner) {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0">${inner}</hierarchy>`
}

function nodeXml(index, extra) {
  // bounds 必须有**非零高度**：退化盒子会被 pruneNodes 当作不可见裁掉（第一版夹具就这么空过）。
  const top = index * 100
  return `<node index="${index}" ${ATTRS} clickable="true" scrollable="false" bounds="[0,${top}][400,${top + 90}]" ${extra} />`
}

/** 造一份同时含「同 text 不同 desc」「同 desc」「desc-only 重复」「唯一」的树。 */
function fixture() {
  const inner =
    nodeXml(1, 'text="确定" content-desc="a" class="android.widget.Button"') +
    nodeXml(2, 'text="中间" content-desc="z" class="android.widget.Button"') +
    nodeXml(3, 'text="确定" content-desc="b" class="android.widget.Button"') +
    nodeXml(4, 'text="确定" content-desc="a" class="android.widget.Button"') +
    nodeXml(5, 'text="" content-desc="搜索" class="android.widget.ImageButton"') +
    nodeXml(6, 'text="" content-desc="搜索" class="android.widget.ImageButton"') +
    nodeXml(7, 'text="唯一" content-desc="" class="android.widget.Button"')
  const xml = hierarchy(inner)
  const { raw } = parseUiTreeXml(xml)
  return pruneNodes(raw)
}

/** 从一行清单里解出 [字段, 值, 序号] 三元组（序号缺省为 null）。 */
function refsOf(line) {
  const out = []
  for (const field of ['text', 'desc']) {
    const m = line.match(new RegExp(field + '="([^"]*)"(#(\\d+))?'))
    if (m && m[1] !== '') out.push([field, m[1], m[3] ? Number(m[3]) : null])
  }
  return out
}

test('#1405/#1406 清单里每个 #k 反向解析回来必须命中同一节点（往返）', () => {
  const { nodes, byId } = fixture()
  const rendered = nodeListLines({ text: '', nodes })
  const lines = rendered.split('\n').slice(1).filter((l) => l.trim() !== '')
  assert.ok(lines.length >= 7, '夹具必须渲染出全部节点：' + rendered)

  let checked = 0
  for (const line of lines) {
    const id = line.trim().split(/\s+/)[0]
    for (const [field, value, occurrence] of refsOf(line)) {
      const kind = field === 'text' ? 'text' : 'desc'
      const ref = kind + ':' + value + (occurrence === null ? '' : '#' + occurrence)
      const hit = resolveRef(byId, nodes, ref)
      assert.equal(hit.ok, true, `清单第 ${id} 行的引用 ${ref} 解析失败：` + (hit.error ?? '') + '\n清单：' + rendered)
      assert.equal(hit.node.id, id, `清单写 ${ref} 指 ${id}，解析却命中 ${hit.node.id}\n清单：` + rendered)
      checked += 1
    }
  }
  assert.ok(checked >= 9, '往返检查的点太少（夹具失效）：' + checked)
})

test('#1405 desc-only 的重复节点在清单里有 #k（旧实现根本没有）', () => {
  const { nodes } = fixture()
  const rendered = nodeListLines({ text: '', nodes })
  assert.match(rendered, /desc="搜索"#1/, '第一个同 desc 节点缺 #1：' + rendered)
  assert.match(rendered, /desc="搜索"#2/, '第二个同 desc 节点缺 #2：' + rendered)
})

test('#1406 同 text 不同 desc 时，text 序号按 text 连续（旧实现按 (text,desc) 分组，序号会跳）', () => {
  const { nodes } = fixture()
  const rendered = nodeListLines({ text: '', nodes })
  const ding = rendered.split('\n').filter((l) => l.includes('text="确定"'))
  assert.equal(ding.length, 3, '三个 text=确定 的节点都要在：' + rendered)
  assert.match(ding[0], /text="确定"#1/)
  assert.match(ding[1], /text="确定"#2/, '中间那条 desc 不同也必须继续编号：' + ding[1])
  assert.match(ding[2], /text="确定"#3/, '第三条必须是 #3：' + ding[2])
})

test('#1406 越界序号仍拒绝（不得因为口径改动放宽）', () => {
  const { nodes, byId } = fixture()
  assert.equal(resolveRef(byId, nodes, 'text:确定#4').ok, false)
  assert.equal(resolveRef(byId, nodes, 'desc:搜索#3').ok, false)
})