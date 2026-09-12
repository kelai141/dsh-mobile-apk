// 控制协议 V2 往返与体积门禁（§S6.2 T1 / §S6.3）
//
// 输入：test/fixtures/ui-probe.xml（真机实测探针，393 节点 / 147,588 B，已入库）。
// 断言三层：
//   ① 结构与自洽：行数/深度连续性（0% 跳变）/祖先引用（预序 + 可操作）/子树区间；
//   ② 等价：encode→decode 逐字段等价，且与 V1 剪枝路径的节点集合语义一致（同一份 XML）；
//   ③ 体积：V2 报文相对 V1 的回填报文必须小 7 倍以上，且落在冻结基线 ±10% 内。
//
// 用法：node test/protocol-v2.test.mjs（需先 npm run build —— 走 lib/*.js）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseUiTreeXml, pruneNodes, parseBoundsToBox } from '../lib/ui-tree.js'
import { decodeV2, encodeV2, encodeV2FromRaw, rowsFromRaw, cacheFromV2, isV2Payload } from '../lib/protocol-v2.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'ui-probe.xml')
const SCREEN = { w: 1080, h: 2400 }
const GEN = 42
/** 冻结基线（§S6.3）：改动编码规则必须手改 fixtures/ui-probe.expect.json——这个动作本身就是评审点。 */
const EXPECT = JSON.parse(readFileSync(join(HERE, 'fixtures', 'ui-probe.expect.json'), 'utf8'))

const xml = readFileSync(FIXTURE, 'utf8')
const parsed = parseUiTreeXml(xml)

/** V1 回填报文（现状口径：壳侧 16 个 attrs 逐字发；节点集 = 有尺寸节点）。 */
function v1EnvelopeBytes() {
  const ATTRS = ['bounds', 'class', 'text', 'content-desc', 'resource-id', 'clickable', 'scrollable',
    'editable', 'checked', 'visible-to-user', 'focused', 'selected', 'enabled', 'depth', 'package', 'window-id']
  const nodes = parsed.raw
    .filter((r) => { const b = parseBoundsToBox(r.attrs.bounds); return b.w > 0 && b.h > 0 })
    .map((r) => ({
      id: r.id,
      parentId: r.parentId,
      attrs: Object.fromEntries(ATTRS.map((k) => [k, r.attrs[k] ?? ''])),
    }))
  const body = JSON.stringify({
    token: 'x'.repeat(32),
    reqId: 'req-00000000-0000-0000-0000-000000000000',
    ok: true,
    data: { gen: GEN, rotation: parsed.rotation, screen: SCREEN, nodes },
  })
  return { bytes: Buffer.byteLength(body), nodeCount: nodes.length }
}

function v2EnvelopeBytes() {
  const data = encodeV2FromRaw(parsed.raw, parsed.rotation, SCREEN, GEN, 'all')
  const body = JSON.stringify({
    token: 'x'.repeat(32),
    reqId: 'req-00000000-0000-0000-0000-000000000000',
    ok: true,
    pv: 2,
    data,
  })
  return { bytes: Buffer.byteLength(body), data }
}

test('V2 载荷结构自洽（行数/深度连续性/祖先引用/子树区间）', () => {
  const { data } = v2EnvelopeBytes()
  const dec = decodeV2(data)
  assert.equal(dec.ok, true)
  const v = dec.value

  assert.equal(v.rawCount, EXPECT.rawNodes, `rawCount 应等于探针节点数 ${EXPECT.rawNodes}`)
  assert.equal(v.rows.length, EXPECT.v2Rows, `V2 行数应冻结在 ${EXPECT.v2Rows}`)

  // 深度连续：最大跳 1（DD-5 骨架闭包的核心断言）
  let maxJump = 0
  for (let i = 1; i < v.rows.length; i++) maxJump = Math.max(maxJump, v.rows[i].depth - v.rows[i - 1].depth)
  assert.equal(maxJump, 1, `深度必须逐层 +1（实得最大跳 ${maxJump}）`)

  // 坐标与中心一致
  for (const n of v.rows) {
    assert.equal(n.cx, n.x + Math.floor(n.w / 2))
    assert.equal(n.cy, n.y + Math.floor(n.h / 2))
    assert.ok(n.depth >= 0 && n.depth <= 63)
  }

  // 祖先引用：本行之前（预序）+ 覆盖本行 + 自身可操作
  for (let i = 0; i < v.rows.length; i++) {
    const p = v.actionableAncestor[i]
    if (p < 0) continue
    assert.ok(p < i, `祖先行必须在本行之前（行 ${i} 的 p=${p}）`)
    assert.ok(v.subtreeEnd[p] > i, `祖先行必须覆盖本行（行 ${i} 的 p=${p}）`)
    const a = v.rows[p]
    assert.ok(a.clickable || a.editable || a.scrollable, `祖先必须是可操作节点（行 ${p}）`)
  }

  // 子树区间：区间内每行更深；区间外首个不更深
  for (let i = 0; i < v.rows.length; i++) {
    const e = v.subtreeEnd[i]
    for (let j = i + 1; j < e; j++) {
      assert.ok(v.rows[j].depth > v.rows[i].depth, `区间内行 ${j} 深度必须 > 行 ${i}`)
    }
    if (e < v.rows.length) assert.ok(v.rows[e].depth <= v.rows[i].depth)
  }
})

test('encode → decode 逐字段等价（TS 自往返）', () => {
  const data = encodeV2FromRaw(parsed.raw, parsed.rotation, SCREEN, GEN, 'all')
  const dec = decodeV2(data)
  assert.equal(dec.ok, true)
  const v = dec.value
  assert.ok(isV2Payload(data))
  assert.equal(v.gen, GEN)
  assert.equal(v.screen.w, SCREEN.w)
  assert.equal(v.view, 'all')

  // 与 V1 剪枝路径对照：同一份 XML，V2 的行集是 V1 节点集的超集（V1 会丢零尺寸骨架外的节点）
  const pruned = pruneNodes(parsed.raw)
  assert.ok(v.rows.length >= pruned.nodes.length, 'V2 行集不应少于 V1 节点集')
  assert.ok(v.rows.length - pruned.nodes.length <= 20, `V2 行集比 V1 多 ${v.rows.length - pruned.nodes.length} 行（超出预期）`)

  // 行句柄协议（FX-206.1）：cacheFromV2 后 byId/byOrig 的键分别是 nN 与**原始行号**句柄
  const cache = cacheFromV2(v)
  assert.equal(cache.nodes.length, v.rows.length)
  const last = v.rows.length - 1
  assert.equal(cache.byId.get('n' + last)?.origPath, String(v.origRow[last]))
  assert.equal(cache.byOrig.get(String(v.origRow[last]))?.n.id, 'n' + last)
  assert.ok(v.origRow[last] > last, '末行句柄必须大于载荷下标（证明不是恒等映射）')
})

test('目标口径（view=target）收窄后仍结构自洽', () => {
  const data = encodeV2FromRaw(parsed.raw, parsed.rotation, SCREEN, GEN, 'target')
  const dec = decodeV2(data)
  assert.equal(dec.ok, true)
  const v = dec.value
  assert.equal(v.view, 'target')
  assert.ok(v.rows.length <= EXPECT.v2Rows, 'target 口径不应多于 all 口径')
  // target 口径下每行要么自身可操作/有标签，要么是它们的骨架祖先
  for (const n of v.rows) {
    const self = n.clickable || n.editable || n.scrollable || n.text !== '' || n.desc !== ''
    assert.ok(self || v.rows.some((m) => m.id !== n.id && m.depth > n.depth && m.x + m.y >= 0),
      `行 ${n.id} 既非目标也非骨架`)
  }
})

/**
 * FX-206.1 的**独立判据**：不复用编码器内部输出，按文档规则（骨架闭包 + 仅叶子去重）重算原始行号表，
 * 再断言「载荷第 fi 行的句柄 = out[fi]」。夹具含零尺寸节点与重复叶子——这两类正是壳侧过滤的成因。
 */
function expectedOrigRows(rows, view = 'all') {
  const n = rows.length
  const actionable = (r) => (r.flag & (1 | 2 | 4)) !== 0   // clickable | scrollable | editable
  const keep = new Array(n).fill(false)
  const ancStack = []
  for (let i = 0; i < n; i++) {
    while (ancStack.length > 0 && rows[ancStack[ancStack.length - 1]].depth >= rows[i].depth) ancStack.pop()
    const hasArea = rows[i].w > 0 && rows[i].h > 0
    const inSet = view === 'target' ? hasArea && (actionable(rows[i]) || rows[i].text !== '' || rows[i].desc !== '') : hasArea
    if (inSet) {
      keep[i] = true
      for (const a of ancStack) keep[a] = true
    }
    ancStack.push(i)
  }
  const subtreeEnd = new Array(n).fill(n)
  const st = []
  for (let i = 0; i < n; i++) {
    while (st.length > 0 && rows[st[st.length - 1]].depth >= rows[i].depth) subtreeEnd[st.pop()] = i
    st.push(i)
  }
  const nextKept = new Array(n).fill(n)
  let nxt = n
  for (let i = n - 1; i >= 0; i--) {
    nextKept[i] = nxt
    if (keep[i]) nxt = i
  }
  const out = []
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue
    if (nextKept[i] >= subtreeEnd[i]) {
      const r = rows[i]
      const key = [r.text, r.desc, r.cls, r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(i)
  }
  return out
}

/** 合成行表：0 根 / 1 零尺寸且无后代 / 2 有面积 / 3 叶子 / 4 与 3 完全同内容的重复叶子 / 5 有面积。 */
const MAPPING_ROWS = (() => {
  const base = { text: '', desc: '', cls: 'a.A', pkg: '', rid: '', windowId: '', depth: 0, x: 0, y: 0, w: 10, h: 10, flag: 0 }
  return [
    { ...base, w: 100, h: 100 },
    { ...base, depth: 1, y: 10, w: 0, h: 0, text: '零尺寸非祖先' },
    { ...base, depth: 1, y: 20, text: 'A' },
    { ...base, depth: 2, y: 30, cls: 'a.C', text: 'dup' },
    { ...base, depth: 2, y: 30, cls: 'a.C', text: 'dup' },
    { ...base, depth: 1, y: 40, cls: 'a.D', text: 'B' },
  ]
})()

test('FX-206.1：载荷第 fi 行的句柄指回原始行号（夹具含零尺寸与重复叶子，错位数 = 0）', () => {
  const expected = expectedOrigRows(MAPPING_ROWS, 'all')
  assert.deepEqual(expected, [0, 2, 3, 5], '夹具必须真的触发过滤（0 尺寸行 1 与重复叶子 4 被剔），否则本用例证明不了任何事')

  const payload = encodeV2(MAPPING_ROWS, 'all', 1, 0, 100, 100)
  assert.deepEqual(payload.o, expected, 'o 列必须逐项等于原始行号')
  const dec = decodeV2(payload)
  assert.equal(dec.ok, true)
  const v = dec.value
  assert.equal(v.rows.length, expected.length)
  assert.deepEqual([...v.origRow], expected)

  const cache = cacheFromV2(v)
  let wrong = 0
  for (let fi = 0; fi < v.rows.length; fi++) {
    if (cache.nodes[fi].origPath !== String(expected[fi])) wrong++
  }
  assert.equal(wrong, 0, '错位数必须 = 0')

  // 反向自证（内嵌）：旧实现 handle = String(fi) 在这个夹具上 3/4 行错位。
  let identityWrong = 0
  for (let fi = 0; fi < v.rows.length; fi++) {
    if (String(fi) !== String(expected[fi])) identityWrong++
  }
  assert.equal(identityWrong, 3, '夹具必须对旧实现敏感（4 行里 3 行错位）')

  // 真实探针夹具同款断言：末行句柄必须 > 载荷下标。
  const probe = encodeV2FromRaw(parsed.raw, parsed.rotation, SCREEN, GEN, 'all')
  const pv = decodeV2(probe).value
  const probeExpected = expectedOrigRows(rowsFromRaw(parsed.raw), 'all')
  assert.deepEqual([...pv.origRow], probeExpected, '真机探针上 o 列也必须等于原始行号表')
  assert.ok(pv.origRow[pv.rows.length - 1] > pv.rows.length - 1)
})

test('FX-206.1：o 列缺失/越界/非递增一律失败关闭（宁可不给清单，也不给会点错的句柄）', () => {
  const payload = encodeV2(MAPPING_ROWS, 'all', 1, 0, 100, 100)
  const noO = { ...payload }
  delete noO.o
  const dec = decodeV2(noO)
  assert.equal(dec.ok, false)
  assert.match(dec.error, /o 必须是整数数组/)
  assert.equal(decodeV2({ ...payload, o: [0, 99] }).ok, false, 'o 长度既非 1 也非 n 必须拒绝')
  assert.equal(decodeV2({ ...payload, o: [0, 2, 2, 5] }).ok, false, 'o 非严格递增必须拒绝')
  assert.equal(decodeV2({ ...payload, o: [0, 2, 3, 9] }).ok, false, '原始行号越界必须拒绝')
  assert.equal(decodeV2({ ...payload, o: [0, 2, 3, 5] }).ok, true)
})

test('FX-206.4：truncated 真值透出（缺列 = false，不再静默丢弃）', () => {
  const payload = encodeV2(MAPPING_ROWS, 'all', 1, 0, 100, 100)
  assert.equal(decodeV2(payload).value.truncated, false)
  assert.equal(decodeV2({ ...payload, truncated: true }).value.truncated, true)
})

test('FX-212.5：V2 行带真实 parentId（预序 + 深度重建），且 p 列口径不变', () => {
  const payload = encodeV2FromRaw(parsed.raw, parsed.rotation, SCREEN, GEN, 'all')
  const v = decodeV2(payload).value
  assert.equal(v.rows[0].parentId, '', '根行无父')
  let checked = 0
  for (let i = 1; i < v.rows.length; i++) {
    const d = v.rows[i].depth
    if (d === 0) { assert.equal(v.rows[i].parentId, ''); continue }
    const parent = v.rows[i].parentId
    assert.match(parent, /^n\d+$/, `行 ${i} 必须带父 id`)
    const pi = Number(parent.slice(1))
    assert.ok(pi < i, '父行必须在本行之前（预序）')
    assert.ok(v.rows[pi].depth < d, '父行深度必须更浅')
    checked++
  }
  assert.ok(checked > 0, '夹具必须真有非根行')
  // p 列口径未动：actionableAncestor 仍是载荷行下标（广播列还原后逐项相等）
  const pCol = payload.p.length === 1 ? new Array(v.rows.length).fill(payload.p[0]) : payload.p
  assert.deepEqual([...v.actionableAncestor], pCol, 'p 列口径绝不能改（FX-206.1 硬约束）')
})

test('坏载荷一律失败关闭（不静默产出空树）', () => {
  assert.equal(decodeV2({ v: 3 }).ok, false)
  assert.equal(decodeV2(null).ok, false)
  assert.equal(decodeV2({ v: 2, gen: 1, scr: [1, 2], str: [], n: 2, d: [0], p: [1], f: [0], c: [-1], k: [-1], r: [-1], w: [-1], t: [-1], s: [-1], b: [0, 0, 1, 1] }).ok, false, '列长度既非 1 也非 n 必须拒绝')
  assert.equal(decodeV2({ v: 2, gen: 1, scr: [1, 2], str: [], n: 1, d: [0], p: [-1], f: [0], c: [-1], k: [-1], r: [-1], w: [-1], t: [-1], s: [-1], b: [0, 0] }).ok, false, 'b 长度必须 4n')
  const okEmpty = decodeV2({ v: 2, gen: 1, scr: [1, 2], str: [], n: 0, d: [], p: [], f: [], c: [], k: [], r: [], w: [], t: [], s: [], b: [] })
  assert.equal(okEmpty.ok, true, 'n=0 是合法的空快照（不是坏载荷）')
})

test('体积门禁：V2 必须比 V1 小 7 倍以上，且落在冻结基线 ±10%', () => {
  const v1 = v1EnvelopeBytes()
  const { bytes: v2Bytes } = v2EnvelopeBytes()
  assert.equal(v1.nodeCount, EXPECT.positiveNodes, `V1 节点集应等于有尺寸节点数 ${EXPECT.positiveNodes}`)
  assert.equal(v1.bytes, EXPECT.v1Bytes, `V1 基线漂移：${v1.bytes} vs ${EXPECT.v1Bytes}（V1 形状不应再变）`)
  const ratio = v1.bytes / v2Bytes
  assert.ok(ratio > EXPECT.v2CompressionRatioMin, `压缩比 ${ratio.toFixed(2)}x 必须 > ${EXPECT.v2CompressionRatioMin}x`)
  assert.ok(v2Bytes <= EXPECT.v2MaxBytes, `V2 报文 ${v2Bytes} B 超出硬上限 ${EXPECT.v2MaxBytes} B`)
  const drift = Math.abs(v2Bytes - EXPECT.v2Bytes) / EXPECT.v2Bytes
  assert.ok(drift <= 0.1, `V2 报文 ${v2Bytes} B 偏离基线 ${EXPECT.v2Bytes} B 超过 10%（编码规则变化必须同步更新基线）`)
})

test('容量断言：1 MiB 上限下壳侧 4000 节点结构性不可达', () => {
  const { bytes } = v2EnvelopeBytes()
  const perRow = bytes / EXPECT.v2Rows
  const cap = Math.floor(1048576 / perRow)
  assert.ok(cap > 4000, `1 MiB 可容 ${cap} 行，必须超过壳侧 MAX_NODES=4000`)
})
