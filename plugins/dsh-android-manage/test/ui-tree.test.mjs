// UI 树祖先回退回归（2026-09-08 修复）：模型引用的是重编号公开 id（n0/n1…），
// 而 byOrig 以原始 XML 路径 id 为键——旧实现用公开 id 查 byOrig 永远落空，
// 不可点击目标的「可点击祖先」回退静默失效。本测试锁死该边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUiTreeXml, pruneNodes, treeFingerprint, resolveRef, findActionableAncestor, checkUiTreeParse, decodeEntities, parseBoundsToBox } from '../lib/ui-tree.js'

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
      // bounds 原来写成 [540,0][100,100]（右边界小于左边界）⇒ parseBounds 判 w<0 直接丢节点，
      // 于是这份「5 节点」夹具实际只有 4 个幸存者，期望表里 '0.1' 那条从来没被验证过。
      `<node index="1" text="R" resource-id="id/right" class="android.widget.TextView" ${ATTRS} clickable="false" scrollable="false" bounds="[540,0][640,100]" />` +
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
  // 期望表里的 `depth` 此前是**死字段**——只比了 parentId，没人比 depth，于是实现把根算成 1
  // （`id.split('.').length` 漏 `-1`）也一直绿。现在真断言：按 DFS 顺序必须是 0 起始的层级序列，
  // 且根必须是 0（2026-10-29 自查：V2 编码侧 rowsFromRaw 一直是 0 起始，两条路径差 1）。
  const pruned = pruneNodes(raw)
  assert.deepEqual(pruned.nodes.map((n) => n.depth), Object.keys(expected).map((k) => expected[k].depth),
    'depth 序列必须 0 起始（与期望表一致，旧实现整体 +1）')
})

test('FX-212.4：根下 11 个顺序兄弟按屏幕顺序输出 btn0..btn10（数字段比较，不是整串字典序）', () => {
  // 旧实现 nodes.sort 用整串字典序："0.10" < "0.2" → 兄弟顺序被读成 btn0,btn1,btn10,btn2…，
  // text:X#k 的 #k 计数也跟着错（模型据此点错控件）。
  const children = Array.from({ length: 11 }, (_, i) =>
    `<node index="${i}" text="btn${i}" resource-id="" class="android.widget.Button" ${ATTRS} ` +
    `clickable="true" scrollable="false" bounds="[0,${100 + i * 60}][200,${150 + i * 60}]" />`).join('')
  const xml = hierarchy(
    `<node index="0" text="root" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
    `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">${children}</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes } = pruneNodes(raw)
  assert.deepEqual(
    nodes.map((n) => n.text).filter((t) => t.startsWith('btn')),
    ['btn0', 'btn1', 'btn2', 'btn3', 'btn4', 'btn5', 'btn6', 'btn7', 'btn8', 'btn9', 'btn10'],
    '兄弟顺序必须等于 XML/屏幕顺序',
  )
  // 真树序遍历性：深度逐行递变最大跳 1（排序被改坏时这里也会红）
  let maxJump = 0
  for (let i = 1; i < nodes.length; i++) maxJump = Math.max(maxJump, nodes[i].depth - nodes[i - 1].depth)
  assert.equal(maxJump, 1)
})

// decodeEntities 在 protocol-v2 的 text/desc/rid 解码路径上（控件文本上屏），此前零覆盖。
// 2026-10-28 自查：旧实现把 `&#(\d+);` 排在 `&amp;` 之后 ⇒ `&amp;#60;` 被解成 `<`
// （应显示字面量 `&#60;`），而 `&amp;lt;` 反而是对的 —— 同一个函数两种口径。
test('decodeEntities：&amp; 只解一次，数字实体不得二次解码', () => {
  // 修的形态：转义过的数字实体保持字面量
  assert.equal(decodeEntities('&amp;#60;'), '&#60;')
  assert.equal(decodeEntities('&amp;amp;'), '&amp;')
  // 不能被带走的形态：真正的数字实体照样解、命名实体依旧正确、普通 & 解一次
  assert.equal(decodeEntities('&#60;'), '<')
  assert.equal(decodeEntities('&#20320;&#22909;'), '你好')
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
  assert.equal(decodeEntities('a &amp; b'), 'a & b')
  assert.equal(decodeEntities('&lt;b&gt;'), '<b>')
})

// pruneNodes 的去重键旧实现用 '|' 当分隔符，而 UI 文本里 '|' 很常见（「标题 | 副标题」），
// 于是 text="a|b"+desc="c" 与 text="a"+desc="b|c" 拼出同一个 key ⇒ 两个真实节点被误去重、
// 丢掉一个（模型看到的清单少一项、目标点不到）。2026-10-28 改为 '\u0000'，与 protocol-v2 统一。
test('pruneNodes：去重键不得因文本含分隔符而碰撞，真重复仍去重', () => {
  const mk = (t, d, i) => ({ attrs: { bounds: '[0,0][10,10]', text: t, 'content-desc': d, class: 'V' }, id: i, parentId: '' })
  // 修的形态：不同节点（同坐标）必须都保留
  const distinct = pruneNodes([mk('a|b', 'c', '0.0'), mk('a', 'b|c', '0.1')])
  assert.equal(distinct.nodes.length, 2, '两个不同节点被误判成重复：' + JSON.stringify(distinct.nodes.map((n) => [n.text, n.desc])))
  // 不能被带走的形态：真正重复的节点仍要去重
  const dup = pruneNodes([mk('x', 'y', '0.0'), mk('x', 'y', '0.1')])
  assert.equal(dup.nodes.length, 1, '真重复没有被去重')
})

// treeFingerprint 是「界面未变」快路径的判据：同一节点（同 id / 同几何）的文本若恰好从
// ("a|b","c") 变成 ("a","b|c")，旧实现用 '|' 拼接时两串逐字节相同 ⇒ 指纹不翻转 ⇒ 回「未变」
// 摘要、模型复用旧引用 ⇒ 点错目标。2026-10-28 统一改用 '\u0000' 分隔。
test('treeFingerprint：文本含分隔符不得让「界面未变」误判', () => {
  const mk = (t, d) => ({
    id: 'n0', parentId: '', text: t, desc: d, rid: '', type: 'V',
    x: 0, y: 0, cx: 5, cy: 5, w: 10, h: 10,
    clickable: false, editable: false, scrollable: false, checked: false, visible: true,
  })
  assert.notEqual(
    treeFingerprint([mk('a|b', 'c')]),
    treeFingerprint([mk('a', 'b|c')]),
    '两个不同节点得到同一指纹 ⇒ 「界面未变」会被误判',
  )
  // 不能被带走的形态：同样的树必须得到同样的指纹（否则每次都判「变了」、快路径失效）
  assert.equal(treeFingerprint([mk('x', 'y')]), treeFingerprint([mk('x', 'y')]))
  // 文本变化必须翻转
  assert.notEqual(treeFingerprint([mk('x', 'y')]), treeFingerprint([mk('x', 'z')]))
})

// XML 规范只强制转义 &、< 与定界引号，**字面 `>` 在属性值里合法**（text="a>b"）。旧解析器用
// `[^>]*?` 收属性区，会在那个 `>` 处截断 ⇒ 该节点属性全丢 ⇒ 下游 parseBounds 失败 ⇒ 节点被整个
// 丢弃，而 checkUiTreeParse 只比节点数、照样报 OK（「绝不静默产出错树」的承诺在这一路失效）。
// 现状实测：uiautomator dump 走 XmlSerializer 会把 > 转成 &gt;，故当前不可达 —— 属纵深防御。
test('parseUiTreeXml：属性值里的字面 > 不得让属性区提前闭合；属性丢光时自检必须拒绝', () => {
  const xml = '<hierarchy rotation="0"><node text="a>b" bounds="[0,0][1,1]" class="V"></node></hierarchy>'
  const r = parseUiTreeXml(xml)
  assert.equal(r.raw[0].attrs.text, 'a>b', '字面 > 被当成属性区结束：' + JSON.stringify(r.raw[0].attrs))
  assert.equal(r.raw[0].attrs.bounds, '[0,0][1,1]')
  assert.equal(checkUiTreeParse(xml, r.raw).ok, true)
  // 不能被带走的形态：转义 &gt; 仍按原样保留（由 decodeEntities 负责解码，解析器不参与）
  const esc = parseUiTreeXml('<hierarchy><node text="a&gt;b" bounds="[0,0][1,1]"></node></hierarchy>')
  assert.equal(esc.raw[0].attrs.text, 'a&gt;b')
  // 自检必须抓住「属性丢光」：只有文本没有 bounds 的节点 → REJECT
  const broken = '<hierarchy><node text="x" class="V"></node></hierarchy>'
  const b = checkUiTreeParse(broken, parseUiTreeXml(broken).raw)
  assert.equal(b.ok, false, '缺 bounds 的节点没有被自检抓住')
})

// resolveRef 的序号后缀是 **1 基**。旧实现用 `occurrence = 0` 当「未指定」哨兵，于是 `text:foo#0`
// 被静默当成「没写序号」—— 单候选时直接返回第 1 个、多候选时报「匹配 N 个」，用户看到的都不是
// 「#0 非法」，与本函数「绝不静默挑一个」的契约矛盾。2026-10-28 改为 null 哨兵 + #0 报错。
test('resolveRef：#0 必须报错（1 基），#N 正常，#00 也算非法', () => {
  const raw = [
    { attrs: { bounds: '[0,0][10,10]', text: '设置', class: 'V' }, id: '0', parentId: '' },
    { attrs: { bounds: '[5,5][15,15]', text: '设置', class: 'V' }, id: '0.0', parentId: '0' },
  ]
  const p = pruneNodes(raw)
  for (const bad of ['text:设置#0', 'text:设置#00']) {
    const r = resolveRef(p.byId, p.nodes, bad)
    assert.equal(r.ok, false, bad + ' 被静默接受了：' + JSON.stringify(r.ok ? r.node.id : ''))
    assert.match(r.error, /序号从 1 开始/, '错误信息没说明 1 基：' + r.error)
  }
  // 不能被带走的形态：合法序号仍工作
  assert.equal(resolveRef(p.byId, p.nodes, 'text:设置#1').node.id, 'n0')
  assert.equal(resolveRef(p.byId, p.nodes, 'text:设置#2').node.id, 'n1')
  // 多候选仍「不猜」
  const multi = resolveRef(p.byId, p.nodes, 'text:设置')
  assert.equal(multi.ok, false, '多候选被静默挑了一个')
  assert.ok(Array.isArray(multi.matches) && multi.matches.length === 2)
})

// **覆盖缺口**（2026-10-28 变异扫描发现）：把 `if (cands.length === 0)` 这个分支变异成永不成立后，
// 整个测试文件仍然 16/16 全绿 —— 说明没有任何用例断言「引用一个不存在的节点时必须明确报错」。
// 这个分支很重要：模型引用已被销毁的节点时，必须收到「没有 text 为 X 的节点——请重新取树」，
// 而不是拿到空 matches / 静默失败。补上反向用例。
test('resolveRef：找不到节点时必须明确报错，不得静默返回', () => {
  const raw = [{ attrs: { bounds: '[0,0][10,10]', text: '设置', class: 'V' }, id: '0', parentId: '' }]
  const p = pruneNodes(raw)
  for (const ref of ['text:不存在的文本', 'desc:不存在的描述', 'rid:no.such.id']) {
    const r = resolveRef(p.byId, p.nodes, ref)
    assert.equal(r.ok, false, ref + ' 找不到却返回了节点：' + (r.ok ? r.node.id : ''))
    assert.match(r.error, /没有 (text|desc|rid) 为/, '错误信息没说清「没有该文本的节点」：' + r.error)
    assert.match(r.error, /重新取树/, '错误信息没引导重新取树：' + r.error)
  }
  // 不能被带走的形态：存在时必须命中（同一个函数两种结果都测）
  assert.equal(resolveRef(p.byId, p.nodes, 'text:设置').node.id, 'n0')
  // id 不存在同样要报错
  const byId = resolveRef(p.byId, p.nodes, 'id:n999')
  assert.equal(byId.ok, false)
  assert.match(byId.error, /不在最近一次取树结果中/)
})

// ── issue #1210 + #1286：完整性闸的 bounds 判据必须与解析器接受同一个集合 ────────────
test('checkUiTreeParse rejects unparseable bounds while keeping zero-size nodes', () => {
  // #1210：闸原来只校验「bounds 是非空字符串」，不校验它能被解析 ⇒ 闸报 OK 时可以 100% 丢节点。
  // #1286：闸最初写成**锚定**的 ^…$，而两个解析器不锚定，于是尾随空格这类「旧解析器能吃」的
  //        形状让整棵树判红。收敛到「与解析器共用同一个正则」（不锚定），失败模式从
  //        「整树拒绝」退回「该节点按既有行为处理」。
  // 判据只判**形状**、不判尺寸：零尺寸 [0,0][0,0] 是合法骨架节点。
  const raw = (list) => list.map((b, i) => ({ id: i === 0 ? '0' : '0.' + i, attrs: { bounds: b } }))
  const xml = (k) => '<hierarchy>' + '<node >'.repeat(k) + '</hierarchy>'

  // ① 能解析的形状一律放行 —— 包含 #1286 点名的 5 例（尾随/前导空白、尾随字符、前缀、尾随换行）
  const accepted = [
    '[0,0][100,100]',
    '[0,0][0,0]',
    '[0,0][1080,2400] ',
    ' [0,0][1080,2400]',
    '[0,0][1080,2400]x',
    'bounds=[0,0][1080,2400]',
    '[0,0][1080,2400]\n',
  ]
  for (const b of accepted) {
    assert.equal(checkUiTreeParse(xml(2), raw([b, '[0,0][10,10]'])).ok, true,
      'bounds=' + JSON.stringify(b) + ' 必须放行：解析器能取到坐标，闸不得比它更严（#1286）')
  }

  // ② 取不到坐标的形状仍然判红（与 #1210 之前一致）
  for (const b of ['[0,0][100]', '[0, 0][100, 100]', '[x1,y1][x2,y2]']) {
    const r = checkUiTreeParse(xml(2), raw([b, '[0,0][10,10]']))
    assert.equal(r.ok, false, 'bounds=' + JSON.stringify(b) + ' 必须判红（旧实现只判非空字符串）')
    assert.match(r.reason, /bounds 形状非法/, '形状类畸形必须点名形状：' + r.reason)
  }
  // 空串走的是更早的「没有 bounds 属性」判据（既有判据，不动它），这里只要求仍然判红
  assert.equal(checkUiTreeParse(xml(2), raw(['', '[0,0][10,10]'])).ok, false)
})

test('#1286 闸与解析器必须是同一个集合：凡闸放行的 bounds，parseBoundsToBox 都能取到坐标', () => {
  // 这条是 #1286 的**结构**判据，不是举例判据：它直接比对两侧对同一批输入的反应。
  // 一旦有人把闸再写回锚定（或给解析器加锚定而不同步），这条立刻红。
  const raw = (b) => [{ id: '0', attrs: { bounds: b } }]
  const xml = '<hierarchy><node ></hierarchy>'
  const samples = [
    '[0,0][100,100]', '[0,0][0,0]', '[0,0][1080,2400] ', ' [0,0][1080,2400]',
    '[0,0][1080,2400]x', 'bounds=[0,0][1080,2400]', '[0,0][1080,2400]\n', '[0,0][1080,2400]\r\n',
    '[1,2][3,4]', '  [0,0][10,10]  ',
  ]
  for (const b of samples) {
    const gateOk = checkUiTreeParse(xml, raw(b)).ok
    // 解析器「取到了坐标」= 四个数字里至少有一个非零，或原串本就全是零。
    // 分成这两种是因为全零也是合法取数（零尺寸骨架节点），不能用「非零」当唯一标志。
    const box = parseBoundsToBox(b)
    const digits = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b)
    const parserGotNumbers = digits !== null
    assert.equal(gateOk, parserGotNumbers,
      'bounds=' + JSON.stringify(b) + '：闸与解析器对同一输入给出了不同结论'
        + '（闸=' + gateOk + '，解析器取到数字=' + parserGotNumbers + '，盒子=' + JSON.stringify(box) + '）')
  }

  // 反向：取不到坐标的必然判红（这一侧不能松）
  for (const b of ['[0,0][100]', '[0, 0][100, 100]', '[x1,y1][x2,y2]', '[0,0]']) {
    assert.equal(checkUiTreeParse(xml, raw(b)).ok, false, 'bounds=' + JSON.stringify(b) + ' 必须判红')
  }
})
