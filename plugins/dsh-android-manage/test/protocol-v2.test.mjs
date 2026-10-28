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

// ── 输入数值类型：整数列不得被浮点静默穿透（2026-10-28 自查） ─────────────────────
//
// 缺口形态：`isIntArray` 名字承诺整数，实现只查 `Number.isFinite`。于是一个含小数的列会整列"合法"通过，
// 而下游每一处都按整数语义消费，浮点不会报错、只会**变成另一个值**：
//   · 符号表下标（t/s/c/k/r/w）⇒ `S[0.5]` 取不到 ⇒ `?? ''` ⇒ 文本/包名静默变空串；
//   · p（可操作祖先）⇒ 写进 Int32Array 被 ToInt32 截断 ⇒ 0.5 变 0（指向别的行）；
//   · f（位标志）⇒ 位运算前 ToInt32 ⇒ 1.9 被读成 clickable；
//   · d（深度）⇒ 预序父链按浮点比较 ⇒ 父子关系错乱；
//   · b / scr ⇒ 坐标与屏幕基准带小数 ⇒ 点击落点偏移。
// 修法：判据提到唯一入口（isIntArray 用 Number.isInteger），让"某列忘记复查"结构上不可能发生
// （o 列此前单独复查过 Number.isInteger，正说明缺口已知但没推广）。
// 反证方向：把 isIntArray 改回 Number.isFinite，下列 12 个用例逐列变红。

/** 2 行全整数裸载荷（各列都是合法整数；0 与 -1 哨兵也在其中）。 */
const INT_BASE = {
  v: 2, gen: 1, rot: 0, scr: [100, 200], str: ['Abc', 'Btn'], n: 2,
  o: [0, 1], d: [0, 1], p: [-1, 0], f: [0, 1], c: [-1, -1], k: [-1, -1],
  r: [-1, -1], w: [-1, -1], t: [0, 1], s: [-1, -1],
  b: [0, 0, 100, 20, 0, 20, 100, 20],
}

test('整数列含浮点一律失败关闭（不得静默截断成另一个值）', () => {
  assert.equal(decodeV2(INT_BASE).ok, true, '对照：全整数载荷必须接受')

  const cases = [
    ['scr', { scr: [100.5, 200] }],
    ['b', { b: [0.5, 0, 100, 20, 0, 20, 100, 20] }],
    ['o', { o: [0, 1.5] }],
    ['d', { d: [0, 1.5] }],
    ['p', { p: [-1, 0.5] }],
    ['f', { f: [0, 1.5] }],
    ['c', { c: [-1, 0.5] }],
    ['k', { k: [-1, 0.5] }],
    ['r', { r: [-1, 0.5] }],
    ['w', { w: [-1, 0.5] }],
    ['t', { t: [0, 0.5] }],
    ['s', { s: [-1, 0.5] }],
  ]
  for (const [key, patch] of cases) {
    const r = decodeV2({ ...INT_BASE, ...patch })
    assert.equal(r.ok, false, `${key} 列含浮点必须失败关闭（放行等于让下游读到另一个值）`)
    assert.match(r.error, new RegExp(`${key} 必须是整数`), `${key} 的错误必须指向"非整数"这一真因`)
  }
})

test('错误文案必须指向真因：长度是对的就不能报成长度不对', () => {
  // 判据合并成 `!isIntArray(b) || b.length !== n*4` 时，浮点会报成「长度必须为 4n=8（收到 8）」，
  // 模型照着这条去改长度，永远修不到浮点。类型与长度必须各自成条。
  const bFloat = decodeV2({ ...INT_BASE, b: [0.5, 0, 100, 20, 0, 20, 100, 20] })
  assert.equal(bFloat.ok, false)
  assert.doesNotMatch(bFloat.error, /长度/, 'b 长度是对的（8 = 4n），文案不得指向长度')

  const scrFloat = decodeV2({ ...INT_BASE, scr: [100.5, 200] })
  assert.equal(scrFloat.ok, false)
  assert.match(scrFloat.error, /整数数组/, 'scr 浮点必须报成数值类型问题')

  const bShort = decodeV2({ ...INT_BASE, b: [0, 0, 100, 20] })
  assert.equal(bShort.ok, false)
  assert.match(bShort.error, /长度/, '真的长度不对就必须报长度')
})

test('gen / rot 必须是整数：NaN 不得透传成 JSON null（#204 同族）', () => {
  assert.equal(decodeV2({ ...INT_BASE, gen: 1.5 }).ok, false, 'gen 浮点必须拒绝')
  assert.match(decodeV2({ ...INT_BASE, gen: 1.5 }).error, /gen/)

  for (const bad of ['abc', NaN, {}, 1.5, Infinity, -Infinity]) {
    const r = decodeV2({ ...INT_BASE, rot: bad })
    assert.equal(r.ok, false, `rot=${String(bad)} 必须失败关闭`)
    assert.match(r.error, /rot 必须是整数/, '错误必须点名 rot')
  }
})

test('合法整数必须原样保留：0 与负哨兵不得为了拒浮点一起被拒', () => {
  const r = decodeV2(INT_BASE)
  assert.equal(r.ok, true)
  assert.deepEqual([...r.value.actionableAncestor], [-1, 0], 'p 列的 -1（无祖先）与 0 都是合法值')
  assert.deepEqual(r.value.screen, { w: 100, h: 200 })
  assert.equal(r.value.rows[0].text, 'Abc', '符号表下标 0 必须仍取到文本')
  assert.equal(r.value.rows[1].text, 'Btn')
  assert.equal(r.value.rows[0].clickable, false)
  assert.equal(r.value.rows[1].clickable, true, 'f 列 1 = clickable 必须保留')

  // rot 的合法取值与缺省口径（null 当缺省 → 0），且必须序列化成数字 0 而不是 null
  for (const [label, patch, want] of [
    ['缺省', {}, 0], ['null', { rot: null }, 0], ['undefined', { rot: undefined }, 0],
    ['0', { rot: 0 }, 0], ['90', { rot: 90 }, 90], ['180', { rot: 180 }, 180], ['270', { rot: 270 }, 270],
  ]) {
    const d = decodeV2({ ...INT_BASE, ...patch })
    assert.equal(d.ok, true, `rot ${label} 必须接受`)
    assert.equal(d.value.rotation, want, `rot ${label} 必须原样保留`)
    assert.equal(JSON.stringify(d.value.rotation), String(want), `rot ${label} 不得变成 JSON null`)
  }
})

// ── 输入契约不变量：任何畸形载荷都不得抛异常（2026-10-28 自查，固定种子 240 例） ──────────
//
// 契约来自 protocol-v2.ts 文件头：「任何结构问题都返回 ok:false（失败关闭；绝不静默产出空节点表）」。
// 这条契约此前**零测试**——全仓没有一处 `assert.throws` / `rejects` 覆盖 `decodeV2`，于是
// 「某个畸形载荷把整个工具调用炸掉、而不是返回一条可读错误」这类回归没有任何东西拦得住。
//
// 用固定种子而不是真随机：CI 上可复现，失败能按同一种子重放。断言与实现契约对齐（不得 throw、
// 被接受时数值干净），不是凭"畸形载荷应该长什么样"的直觉。
//
// 反证方向（实测，证明它不是与既有用例重叠）：把 `str` 的类型守卫从 `return {ok:false}` 改成
// `throw new Error(...)` ⇒ **只有本用例变红，既有用例全绿**——因为它们都喂合法的 `str: []`，
// 从没验证过这条守卫的「失败关闭」语义。本用例守的是既有用例够不到的那些组合。
// 相反方向的诚实说明：把 `isIntArray` 改回 `Number.isFinite`、或把 `o` 守卫改成 throw，
// 变红的是既有定向用例而不是本用例（这两条已被更精确的断言先接住）——那种重叠是好事，不必为
// "让 fuzz 也红"去削弱定向用例。
test('输入契约：畸形载荷一律不得抛异常，被接受者必须数值干净（固定种子 240 例）', () => {
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rnd = mulberry32(0x20261028)
  const pickOne = (list) => list[Math.floor(rnd() * list.length)]
  const NASTY = [0, -1, 1, 0.5, -0.5, 1.5, 1e9, -1e9, NaN, Infinity, -Infinity, '', 'x', '12',
    null, undefined, true, false, {}, [], [[1]], { a: 1 }]
  const maybeArray = () => {
    const len = Math.floor(rnd() * 4)
    return Array.from({ length: len }, () => pickOne(NASTY))
  }
  const fields = ['v', 'gen', 'rot', 'scr', 'str', 'n', 'raw', 'd', 'p', 'f', 'c', 'k', 'r', 'w',
    't', 's', 'b', 'o', 'view', 'truncated']
  const junkValue = (depth) => {
    if (depth > 2) return pickOne(NASTY)
    const kind = Math.floor(rnd() * 6)
    if (kind === 0) return maybeArray()
    if (kind === 1) return pickOne(NASTY)
    if (kind === 2) {
      const o = {}
      for (const key of fields) if (rnd() < 0.5) o[key] = junkValue(depth + 1)
      return o
    }
    return pickOne(NASTY)
  }
  const junkPayload = () => {
    const base = {
      v: 2, gen: 1, rot: 0, scr: [100, 200], str: [], n: 0,
      o: [], d: [], p: [], f: [], c: [], k: [], r: [], w: [], t: [], s: [], b: [],
    }
    for (const key of Object.keys(base)) if (rnd() < 0.35) base[key] = junkValue(0)
    return base
  }

  let accepted = 0
  for (let i = 0; i < 240; i++) {
    const payload = rnd() < 0.5 ? junkPayload() : junkValue(0)
    let r
    assert.doesNotThrow(() => { r = decodeV2(payload) }, '第 ' + i + ' 例：畸形载荷不得抛异常（契约是失败关闭，不是崩溃）')
    assert.equal(typeof r?.ok, 'boolean', '第 ' + i + ' 例：必须返回 {ok:boolean}')
    if (!r.ok) {
      assert.equal(typeof r.error, 'string', '第 ' + i + ' 例：拒绝时必须带可读原因')
      assert.notEqual(r.error, '', '第 ' + i + ' 例：拒绝原因不得为空串')
      continue
    }
    accepted += 1
    const v = r.value
    // 被接受 ⇒ 对外数值必须干净整数（NaN/小数会让引擎整值拒绝或让下游静默变值）
    for (const [label, val] of [['gen', v.gen], ['rotation', v.rotation],
      ['screen.w', v.screen.w], ['screen.h', v.screen.h], ['rawCount', v.rawCount]]) {
      assert.ok(Number.isInteger(val), '第 ' + i + ' 例：' + label + ' 必须是整数（收到 ' + String(val) + '）')
    }
    assert.ok(Array.isArray(v.rows), '第 ' + i + ' 例：rows 必须是数组')
    assert.equal(v.rows.length, v.origRow.length, '第 ' + i + ' 例：rows 与 origRow 长度必须一致')
    assert.equal(v.rows.length, v.actionableAncestor.length, '第 ' + i + ' 例：rows 与 actionableAncestor 长度必须一致')
    for (const row of v.rows) {
      for (const key of ['x', 'y', 'w', 'h', 'cx', 'cy', 'depth']) {
        assert.ok(Number.isInteger(row[key]), '第 ' + i + ' 例：row.' + key + ' 必须是整数（收到 ' + String(row[key]) + '）')
      }
      for (const key of ['text', 'desc', 'cls', 'pkg', 'rid', 'windowId']) {
        assert.equal(typeof row[key], 'string', '第 ' + i + ' 例：row.' + key + ' 必须是字符串')
      }
    }
  }
  // 防御：随机集必须真的既有拒绝也有接受，否则「全拒绝」会让上面的接受分支永远不跑（假绿）
  assert.ok(accepted > 0, '240 例里必须至少有一例被接受，否则断言只覆盖了拒绝路径')
})
