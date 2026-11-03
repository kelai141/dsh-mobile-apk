// 控件清单渲染（含跨节点状态机）。这段此前零测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeListLines } from '../lib/node-list.js'

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

test('不同 (text, desc) 组合永不共享序号（单字段编号后结构上不可能撞）', () => {
  const out = nodeListLines({
    text: '',
    nodes: [n({ id: 'n0', text: 'a|b', desc: 'c' }), n({ id: 'n1', text: 'a', desc: 'b|c' })],
  })
  assert.doesNotMatch(out, /#1/, '两个不同节点被当成重复了：' + out)
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
// ── issue #1405 #1406：渲染的 #k 与解析的 #N 必须是同一套编号 ─────────────────────────

test('#1405 desc-only 的重复节点也必须标序号（旧实现只拼在 text 上）', () => {
  const out = nodeListLines({
    text: '',
    nodes: [n({ id: 'n0', desc: '搜索' }), n({ id: 'n1', desc: '搜索' })],
  })
  assert.match(out, /n0 .*desc="搜索"#1/, '第一个同 desc 节点没标 #1：' + out)
  assert.match(out, /n1 .*desc="搜索"#2/, '第二个同 desc 节点没标 #2：' + out)
  // 没有 text 时不得凭空出现 text=""
  assert.doesNotMatch(out, /text=""/, 'desc-only 节点不该出现空 text：' + out)
})

test('#1405 唯一 desc 不标序号', () => {
  const out = nodeListLines({ text: '', nodes: [n({ id: 'n0', desc: '搜索' }), n({ id: 'n1', desc: '设置' })] })
  assert.doesNotMatch(out, /#1/, '唯一 desc 不该标序号：' + out)
})

test('#1406 text 与 desc 各自独立编号（同一节点在两个字段上各有一套序号）', () => {
  const out = nodeListLines({
    text: '',
    nodes: [
      n({ id: 'n0', text: '确定', desc: 'a' }),
      n({ id: 'n1', text: '确定', desc: 'a' }),
      n({ id: 'n2', text: '唯一', desc: 'a' }),
    ],
  })
  assert.match(out, /n0 .*text="确定"#1 .*desc="a"#1/, 'n0：text 第 1、desc 第 1：' + out)
  assert.match(out, /n1 .*text="确定"#2 .*desc="a"#2/, 'n1：text 第 2、desc 第 2：' + out)
  // '唯一' 只出现一次 ⇒ 不标 text 序号；但 desc='a' 出现三次 ⇒ 必须标 #3
  assert.match(out, /n2 .*text="唯一" .*desc="a"#3/, 'n2：text 唯一不标号、desc 第 3：' + out)
})

test('#1406 text 计数只看 text：不同 desc 不妨碍 text 序号连续', () => {
  const out = nodeListLines({
    text: '',
    nodes: [
      n({ id: 'n0', text: '确定', desc: 'a' }),
      n({ id: 'n1', text: '中间', desc: 'z' }),
      n({ id: 'n2', text: '确定', desc: 'b' }),
    ],
  })
  assert.match(out, /n0 .*text="确定"#1/)
  assert.match(out, /n2 .*text="确定"#2/, 'text 序号必须按 text 连续，不能被 desc 分组打断：' + out)
})
// ── issue #1405 #1406：渲染的 #k 与解析的 #N 必须是同一套编号 ─────────────────────────

test('#1405 desc-only 的重复节点也必须标序号（旧实现只拼在 text 上）', () => {
  const out = nodeListLines({
    text: '',
    nodes: [n({ id: 'n0', desc: '搜索' }), n({ id: 'n1', desc: '搜索' })],
  })
  assert.match(out, /n0 .*desc="搜索"#1/, '第一个同 desc 节点没标 #1：' + out)
  assert.match(out, /n1 .*desc="搜索"#2/, '第二个同 desc 节点没标 #2：' + out)
  assert.doesNotMatch(out, /text=""/, 'desc-only 节点不该出现空 text：' + out)
})

test('#1405 唯一 desc 不标序号', () => {
  const out = nodeListLines({ text: '', nodes: [n({ id: 'n0', desc: '搜索' }), n({ id: 'n1', desc: '设置' })] })
  assert.doesNotMatch(out, /#1/, '唯一 desc 不该标序号：' + out)
})

test('#1406 text 与 desc 各自独立编号（同一节点在两个字段上各有一套序号）', () => {
  const out = nodeListLines({
    text: '',
    nodes: [
      n({ id: 'n0', text: '确定', desc: 'a' }),
      n({ id: 'n1', text: '确定', desc: 'a' }),
      n({ id: 'n2', text: '唯一', desc: 'a' }),
    ],
  })
  assert.match(out, /n0 .*text="确定"#1 .*desc="a"#1/, 'n0：text 第 1、desc 第 1：' + out)
  assert.match(out, /n1 .*text="确定"#2 .*desc="a"#2/, 'n1：text 第 2、desc 第 2：' + out)
  assert.match(out, /n2 .*text="唯一" .*desc="a"#3/, 'n2：text 唯一不标号、desc 第 3：' + out)
})

test('#1406 text 计数只看 text：不同 desc 不妨碍 text 序号连续', () => {
  const out = nodeListLines({
    text: '',
    nodes: [
      n({ id: 'n0', text: '确定', desc: 'a' }),
      n({ id: 'n1', text: '中间', desc: 'z' }),
      n({ id: 'n2', text: '确定', desc: 'b' }),
    ],
  })
  assert.match(out, /n0 .*text="确定"#1/)
  assert.match(out, /n2 .*text="确定"#2/, 'text 序号必须按 text 连续，不能被 desc 分组打断：' + out)
})
