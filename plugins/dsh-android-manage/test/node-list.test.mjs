// 控件清单渲染（含跨节点状态机）。这段此前零测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeListLines, dupKeyOf } from '../lib/node-list.js'

const n = (o) => ({ id: 'n0', parentId: '', type: 'V', rid: '', text: '', desc: '', x: 0, y: 0, w: 1, h: 1, depth: 0, ...o })

test('重复序号：#1/#2 必须真的出现（回归点——曾因两处 key 不同源而完全失效）', () => {
  const out = nodeListLines({ text: '', nodes: [n({ id: 'n0', text: '确定' }), n({ id: 'n1', text: '确定' })] })
  assert.match(out, /n0 .*text="确定"#1/, '第一个重复项没标 #1：' + out)
  assert.match(out, /n1 .*text="确定"#2/, '第二个重复项没标 #2：' + out)
})

test('唯一文本不标序号', () => {
  const out = nodeListLines({ text: '', nodes: [n({ text: '唯一' }), n({ id: 'n1', text: '另一个' })] })
  assert.doesNotMatch(out, /#1/, '唯一文本不该标序号：' + out)
})

test('text 与 desc 都空的节点不参与重复计数（也无 #k）', () => {
  const out = nodeListLines({ text: '', nodes: [n({ id: 'n0' }), n({ id: 'n1' })] })
  assert.doesNotMatch(out, /#1/, '空文本节点不该标序号：' + out)
  assert.equal((out.match(/\(无文本\)/g) ?? []).length, 2)
})

test('分隔符不再是 | ：text="a|b"+desc="c" 与 text="a"+desc="b|c" 不得撞成同一组', () => {
  const out = nodeListLines({
    text: '',
    nodes: [n({ id: 'n0', text: 'a|b', desc: 'c' }), n({ id: 'n1', text: 'a', desc: 'b|c' })],
  })
  assert.doesNotMatch(out, /#1/, '两个不同节点被当成重复了：' + out)
  assert.notEqual(dupKeyOf('a|b', 'c'), dupKeyOf('a', 'b|c'))
})

test('归属前缀只在变化时出现（pkg=/win= 去重）', () => {
  const out = nodeListLines({
    text: '',
    nodes: [
      n({ id: 'n0', pkg: 'p', windowId: 'w' }),
      n({ id: 'n1', pkg: 'p', windowId: 'w' }),
      n({ id: 'n2', pkg: 'q', windowId: 'w' }),
    ],
  })
  assert.equal((out.match(/pkg=p/g) ?? []).length, 1, '同一 pkg 应只出现一次：' + out)
  assert.equal((out.match(/win=w/g) ?? []).length, 1, '同一 win 应只出现一次：' + out)
  assert.match(out, /pkg=q/, 'pkg 变化时必须重新出现')
})

test('flags / depth 缩进 / 无 flags 的静态标记', () => {
  assert.match(nodeListLines({ text: '', nodes: [n({ clickable: true })] }), /\[可点\]/)
  assert.match(nodeListLines({ text: '', nodes: [n({ editable: true, clickable: true })] }), /\[可点\/可编辑\]/)
  assert.match(nodeListLines({ text: '', nodes: [n({})] }), /\[静态\]/)
  // depth=2 ⇒ 4 个空格缩进（'  '.repeat(2)）
  assert.match(nodeListLines({ text: '', nodes: [n({ depth: 2 })] }), / {4}n0/, 'depth 缩进')
  assert.match(nodeListLines({ text: '', nodes: [n({ depth: 99 })] }), / {24}n0/, 'depth 上限 12（24 空格）')
})
