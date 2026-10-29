// 九键条：**接线层**（DOM 挂载 + 通路选择 + 自愈 + visualViewport）的回归（离线，node:test + jsdom）。
//
// 这一层是全任务唯一「会碰真实 DOM」的地方，因此必须用**真 DOM** 测，而不是纯函数替身。
// 断言的是**用户可观察行为 / 硬约束**，不是内部实现：
//   1. 落点：键条是 [data-sidebar-terminal] 的**最后一个**子元素（= 终端底边不超过键条顶边的布局前提）；
//   2. 通路：优先合成 keydown 到 .xterm-helper-textarea（让 xterm 自己按 DECCKM 映射）；
//   3. 通路兜底：没有 textarea 时才直写，且**按 acck 动态选** CSI/SS3；
//   4. 提示：不支持组合 / 唤起失败都必须可见（用户口径：不许静默）；
//   5. 自愈：React 重建子列表把键条摘掉后，观察者必须把它挂回末尾；
//   6. visualViewport：resize **与** scroll 都要触发复算。
//
// jsdom 不在本插件依赖里（禁 npm install），从同仓的响应式子仓按需解析；缺失时本文件**跳过**并
// 在报告里记为未确证，绝不静默当成通过。
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEYBAR_ATTR, KEYBAR_INSET_VAR, KEYBAR_NOTICE_ATTR, KEYBAR_STYLE_ID } from '../src/keybar/layout.ts'
import { KEYBAR_TEXT, defineLegacyKeyFields, mountKeybar } from '../src/keybar/mount.ts'
import { resolveCtrlChar } from '../src/keybar/keymap.ts'

/** 按候选路径解析 jsdom（不新增依赖）。 */
const JSDOM_CANDIDATES = [
  '../../../dsh-client-ui-responsive/node_modules/jsdom/lib/api.js',
  '../../../dsh-mobile-apk/node_modules/jsdom/lib/api.js',
  '../../../node_modules/jsdom/lib/api.js',
]
let jsdomModule
for (const candidate of JSDOM_CANDIDATES) {
  const url = new URL(candidate, import.meta.url)
  if (existsSync(url)) { jsdomModule = await import(pathToFileURL(url.pathname.slice(win32Trim(url.pathname))).href); break }
}
function win32Trim(pathname) { return /^\/[A-Za-z]:/u.test(pathname) ? 1 : 0 }
const JSDOM = jsdomModule?.JSDOM
const SKIP = JSDOM === undefined

/** 搭一个最小但真实的宿主：上游 .root + .xterm-helper-textarea + 记录写入。 */
function setup(options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><section data-sidebar-terminal><div class="screen"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div></section></body></html>',
    { pretendToBeVisual: true })
  const doc = dom.window.document
  const root = doc.querySelector('[data-sidebar-terminal]')
  const writes = []
  const host = {
    root,
    write: (data) => { writes.push(data); return true },
    applicationCursorKeys: () => options.acck,
    bridge: options.bridge,
    now: () => options.now ?? 1_000,
  }
  const handle = mountKeybar(host)
  return { dom, doc, root, writes, handle }
}

const repr = (value) => JSON.stringify(value)

/** 点击某个键（真实 click 事件，与用户操作同路径）。 */
function press(doc, key) {
  const button = doc.querySelector('[' + KEYBAR_ATTR + '] button[data-key="' + key + '"]')
  assert.ok(button, '找不到键: ' + key)
  button.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }))
  return button
}

// ---------------------------------------------------------------------------
// 落点与自愈
// ---------------------------------------------------------------------------

test('落点：键条是终端根的**最后一个**子元素（终端底边不超过键条顶边的布局前提）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, root, handle } = setup()
  const bar = doc.querySelector('[' + KEYBAR_ATTR + ']')
  assert.ok(bar, '键条未挂载')
  assert.equal(bar.parentElement, root, '键条必须挂在终端根上')
  assert.equal(root.lastElementChild, doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']'),
    '提示面必须在最后（它在键条之后，不参与终端收缩）')
  assert.equal(bar.nextElementSibling, doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']'))
  handle.dispose()
})

/** 多根宿主：每个根各一个 .xterm-helper-textarea 与独立写通道（分栏与 keep-mounted 都是这个形状）。 */
function multiRootSetup(rootCount = 2) {
  const section = '<section data-sidebar-terminal><div class="screen"><div class="xterm">'
    + '<textarea class="xterm-helper-textarea"></textarea></div></div></section>'
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + section.repeat(rootCount) + '</body></html>',
    { pretendToBeVisual: true })
  const doc = dom.window.document
  const roots = [...doc.querySelectorAll('[data-sidebar-terminal]')]
  const writes = roots.map(() => [])
  const handles = roots.map((root, index) => mountKeybar({
    root,
    write: (data) => { writes[index].push(data); return true },
    applicationCursorKeys: () => false,
  }))
  return { dom, doc, roots, handles, writes }
}

test('#690 分栏：两个终端根各有一条键条，不存在「两条都叠在最后一根」', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { roots, handles } = multiRootSetup(2)
  for (const [index, root] of roots.entries()) {
    const bars = root.querySelectorAll('[' + KEYBAR_ATTR + ']')
    assert.equal(bars.length, 1, '根 #' + index + ' 必须恰有一条键条（旧实现会把两条都搬到最后一根）')
    assert.equal(root.lastElementChild, root.querySelector('[' + KEYBAR_NOTICE_ATTR + ']'),
      '根 #' + index + ' 的提示面必须是最后一个子元素')
  }
  handles.forEach((handle) => handle.dispose())
})
test('#690 分栏：按 B 的键只打到 B 的终端，不回响到 A', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { roots, handles } = multiRootSetup(2)
  // 有 textarea 时通路 (c) 优先：合成 keydown 交给 xterm 自己映射，**不**调直写通道。
  // 所以断言「事件进了哪个终端的 textarea」，而不是 write 收到了什么字节。
  const seen = roots.map(() => [])
  roots.forEach((root, index) => {
    root.querySelector('.xterm-helper-textarea')
      .addEventListener('keydown', (event) => { seen[index].push(event.key) })
  })
  const button = roots[1].querySelector('[' + KEYBAR_ATTR + '] button[data-key="tab"]')
  assert.ok(button, '第二个根缺 tab 键')
  button.dispatchEvent(new roots[1].ownerDocument.defaultView.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(seen[0], [], '第一个终端的 textarea 不该收到按键')
  assert.equal(seen[1].length, 1, '按键必须进它自己那个终端的 textarea')
  handles.forEach((handle) => handle.dispose())
})
test('#690 keep-mounted：后加入的终端根不得把已有根的键条搬走', { skip: SKIP && 'jsdom 不可用' }, async () => {
  const { doc, root, handle } = setup()
  const firstBar = root.querySelector('[' + KEYBAR_ATTR + ']')
  assert.ok(firstBar, '初始根缺键条')
  // 页面上再出现一个终端根（开分栏，或历史 tab 被 keep-mounted 留在 DOM 里）。
  const second = doc.createElement('section')
  second.setAttribute('data-sidebar-terminal', '')
  second.innerHTML = '<div class="screen"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>'
  doc.body.append(second)
  // MutationObserver 是微任务回调。
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(root.querySelector('[' + KEYBAR_ATTR + ']'), firstBar,
    '已有根的键条必须留在原地（旧实现会把它 append 到新根）')
  assert.equal(second.querySelector('[' + KEYBAR_ATTR + ']'), null,
    '没有实例的根不得凭空出现键条')
  handle.dispose()
})
test('键条九键齐备，顺序与语义层一致，且每个键有 aria-label', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const keys = [...doc.querySelectorAll('[' + KEYBAR_ATTR + '] button')].map((b) => b.dataset.key)
  assert.deepEqual(keys, ['keyboard', 'tab', 'ctrl', 'esc', 'left', 'right', 'up', 'down', 'enter'])
  for (const button of doc.querySelectorAll('[' + KEYBAR_ATTR + '] button')) {
    assert.ok(button.getAttribute('aria-label'), button.dataset.key + ' 缺 aria-label')
    assert.equal(button.getAttribute('type'), 'button')
  }
  handle.dispose()
})

test('样式只注入一次（重复挂载不叠加 style 元素）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const second = mountKeybar({
    root: doc.querySelector('[data-sidebar-terminal]'),
    write: () => true,
    applicationCursorKeys: () => false,
  })
  assert.equal(doc.querySelectorAll('#' + KEYBAR_STYLE_ID).length, 1)
  second.dispose()
  assert.equal(doc.querySelectorAll('#' + KEYBAR_STYLE_ID).length, 1, '另一个句柄还在，样式不该被删')
  handle.dispose()
  assert.equal(doc.querySelectorAll('#' + KEYBAR_STYLE_ID).length, 0, '最后一个句柄卸载后样式应清掉')
})

test('反证：React 重建子列表摘掉键条后，观察者必须把它挂回末尾（自愈）', { skip: SKIP && 'jsdom 不可用' }, async () => {
  const { doc, root, handle } = setup()
  const bar = doc.querySelector('[' + KEYBAR_ATTR + ']')
  // 模拟 React 重写子列表：清空后放回一个 status 节点（键条被摘掉）。
  root.replaceChildren()
  assert.equal(doc.querySelector('[' + KEYBAR_ATTR + ']'), null)
  // MutationObserver 是微任务回调。
  await new Promise((resolve) => setTimeout(resolve, 0))
  const restored = doc.querySelector('[' + KEYBAR_ATTR + ']')
  assert.ok(restored, '键条必须被挂回（否则用户在状态切换后就没有键条了）')
  assert.equal(restored.parentElement, root)
  assert.equal(restored, bar, '应复用同一个节点，不是每次新建')
  handle.dispose()
})

test('反证：上游根节点消失时键条必须一并移除（不得悬空）', { skip: SKIP && 'jsdom 不可用' }, async () => {
  const { doc, handle } = setup()
  assert.ok(doc.querySelector('[' + KEYBAR_ATTR + ']'))
  doc.querySelector('[data-sidebar-terminal]').remove()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(doc.querySelector('[' + KEYBAR_ATTR + ']'), null, '根没了键条必须跟着走')
  handle.dispose()
})

test('dispose 幂等：移除 DOM 与样式，重复调用不抛', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  handle.dispose()
  handle.dispose()
  assert.equal(doc.querySelector('[' + KEYBAR_ATTR + ']'), null)
  assert.equal(doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']'), null)
})

// ---------------------------------------------------------------------------
// 通路选择
// ---------------------------------------------------------------------------

test('通路优先 (c)：合成 keydown 到 .xterm-helper-textarea，**不**直写（让 xterm 自己映射）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, writes, handle } = setup()
  const textarea = doc.querySelector('.xterm-helper-textarea')
  const seen = []
  textarea.addEventListener('keydown', (event) => { seen.push({ key: event.key, code: event.code }) })

  press(doc, 'up')
  assert.deepEqual(seen, [{ key: 'ArrowUp', code: 'ArrowUp' }])
  assert.deepEqual(writes, [], '优先通路命中时不得直写（避免绕过 DECCKM）')

  press(doc, 'enter')
  press(doc, 'esc')
  press(doc, 'tab')
  assert.deepEqual(seen.map((e) => e.key), ['ArrowUp', 'Enter', 'Escape', 'Tab'])
  assert.deepEqual(writes, [])
  handle.dispose()
})

test('通路优先 (c) 会先把焦点还给 textarea（合成事件依赖焦点，实测结论）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const textarea = doc.querySelector('.xterm-helper-textarea')
  const other = doc.createElement('button')
  doc.body.append(other)
  other.focus()
  assert.equal(doc.activeElement, other)
  press(doc, 'left')
  assert.equal(doc.activeElement, textarea, '按键盘条后焦点必须在 textarea 上')
  handle.dispose()
})

test('键条自身不得抢焦点：mousedown 必须被 preventDefault', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const button = doc.querySelector('[' + KEYBAR_ATTR + '] button')
  const event = new doc.defaultView.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  button.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true, '不 preventDefault 会把焦点从终端抢走，通路 (c) 失效')
  handle.dispose()
})

test('兜底通路 (a)：没有 textarea 时直写，且 DECCKM=false 用 CSI', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, writes, handle } = setup({ acck: false })
  doc.querySelector('.xterm-helper-textarea').remove()
  press(doc, 'up')
  press(doc, 'left')
  assert.deepEqual(writes, ['\u001b[A', '\u001b[D'], '普通模式必须是 CSI')
  handle.dispose()
})

test('反证：DECCKM=true 时兜底必须改用 SS3（绝不写死 CSI）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, writes, handle } = setup({ acck: true })
  doc.querySelector('.xterm-helper-textarea').remove()
  press(doc, 'up')
  press(doc, 'left')
  press(doc, 'right')
  press(doc, 'down')
  assert.deepEqual(writes, ['\u001bOA', '\u001bOD', '\u001bOC', '\u001bOB'], '应用模式必须是 SS3')
  assert.equal(writes.includes('\u001b[A'), false, '应用模式下绝不能发 CSI')
  handle.dispose()
})

test('兜底：Tab/Esc/回车 在两种模式下同值（与方向键不同）', { skip: SKIP && 'jsdom 不可用' }, () => {
  for (const acck of [false, true]) {
    const { doc, writes, handle } = setup({ acck })
    doc.querySelector('.xterm-helper-textarea').remove()
    press(doc, 'tab')
    press(doc, 'esc')
    press(doc, 'enter')
    assert.deepEqual(writes, ['\t', '\u001b', '\r'], 'acck=' + String(acck))
    handle.dispose()
  }
})

test('反证：两条通路都不可用时必须提示「按键未发送」，绝不静默丢键', { skip: SKIP && 'jsdom 不可用' }, () => {
  const dom = new JSDOM('<!doctype html><html><body><section data-sidebar-terminal><div class="screen"></div></section></body></html>',
    { pretendToBeVisual: true })
  const doc = dom.window.document
  // 没有 .xterm-helper-textarea，且兜底写回调明确返回 false（watchTerminalKeybars 的默认形态）。
  const handle = mountKeybar({
    root: doc.querySelector('[data-sidebar-terminal]'),
    write: () => false,
    applicationCursorKeys: () => undefined,
  })
  press(doc, 'up')
  const notice = doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']')
  assert.equal(notice.hidden, false, '两条通路都不可用时必须提示')
  assert.equal(notice.textContent, KEYBAR_TEXT.noticeNoPath)
  handle.dispose()
})

// ---------------------------------------------------------------------------
// 旧式 keyCode：0.14.2 ADB 用户层阻塞级缺陷的反证（键条按了没反应）
// ---------------------------------------------------------------------------

test('反证①：键条合成的事件必须带**非 0** 旧式 keyCode/which（缺陷形态 = 0，必须判红）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const textarea = doc.querySelector('.xterm-helper-textarea')
  const seen = []
  textarea.addEventListener('keydown', (event) => {
    seen.push({ key: event.key, code: event.code, keyCode: event.keyCode, which: event.which, trusted: event.isTrusted })
  })
  press(doc, 'left')
  assert.equal(seen.length, 1)
  // 这就是缺陷的断言面：keyCode=0 会让 xterm 丢弃该键（实测零 write）。
  assert.notEqual(seen[0].keyCode, 0, 'keyCode 为 0 => xterm 丢弃该键，键条按了没反应（本缺陷）')
  assert.notEqual(seen[0].which, 0, 'which 也必须非 0（同上）')
  assert.equal(seen[0].keyCode, 37, 'ArrowLeft 必须是 37')
  assert.equal(seen[0].which, 37, 'which 必须与 keyCode 同值')
  // jsdom 的合成事件 isTrusted 是 undefined（不是 false）；只要不是 true 就说明是合成的。
  assert.notEqual(seen[0].isTrusted, true, '这是合成事件，不是真按键')
  handle.dispose()
})

test('逐键实测值：Tab=9 Esc=27 左=37 上=38 右=39 下=40 回车=13', { skip: SKIP && 'jsdom 不可用' }, () => {
  const expected = { tab: 9, esc: 27, left: 37, up: 38, right: 39, down: 40, enter: 13 }
  const { doc, handle } = setup()
  const textarea = doc.querySelector('.xterm-helper-textarea')
  const seen = []
  textarea.addEventListener('keydown', (event) => { seen.push([event.key, event.keyCode, event.which]) })
  for (const key of Object.keys(expected)) press(doc, key)

  for (const [key, keyCode] of Object.entries(expected)) {
    const hit = seen.find((row) => row[1] === keyCode)
    assert.ok(hit, key + ' 未产生 keyCode=' + keyCode + ' 的事件；实际 ' + repr(seen))
    assert.equal(hit[2], keyCode, key + ' 的 which 必须与 keyCode 同值')
  }
  assert.equal(new Set(seen.map((r) => r[1])).size, 7, '七个键的 keyCode 必须互不相同')
  handle.dispose()
})

test('反证②：helper 必须让 keyCode/which 生效，且能覆盖构造参数（记录 WebView 差异）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc } = setup()
  const view = doc.defaultView

  // 缺陷形态：不补字段时 keyCode 是 0，xterm 会丢弃该键。
  const bare = new view.KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' })
  assert.equal(bare.keyCode, 0, '未补字段时 keyCode 必须是 0（缺陷形态）')
  assert.equal(bare.which, 0)

  // helper 必须让它变成登记值，且 which 同值。
  defineLegacyKeyFields(bare, 37)
  assert.equal(bare.keyCode, 37)
  assert.equal(bare.which, 37)

  // 复写必须幂等（defineProperty 必须 configurable，否则第二次会抛 TypeError）。
  defineLegacyKeyFields(bare, 39)
  assert.equal(bare.keyCode, 39, 'configurable 让复写生效，不得抛 Cannot redefine property')

  // 环境差异（诚实记录，不假装复现 WebView）：
  //   [A] WebView 实测：把 keyCode 写进 KeyboardEventInit **无效**，必须 defineProperty；
  //   jsdom 却**会**认这个非标准字段。因此「构造参数无效」这一事实无法在 jsdom 里复现，
  //   本测试只固化两条与本环境无关的契约：① 不补就是 0；② helper 一定生效并能覆盖。
  const viaInit = new view.KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
  assert.ok(viaInit.keyCode === 37 || viaInit.keyCode === 0,
    'jsdom 可能认或不认 init 里的 keyCode；两种都接受，因为我们的修法**不依赖**它')
  defineLegacyKeyFields(viaInit, 37)
  assert.equal(viaInit.keyCode, 37, '无论 init 认不认，helper 之后必须是登记值')
})

test('反证③：xterm 侧的丢弃形态可复现 —— 读事件却取不到 keyCode 的键不得再出现', { skip: SKIP && 'jsdom 不可用' }, () => {
  // 模拟 xterm 的判定：keyCode 为 0 的合成 keydown 会被忽略（不产生写入）。
  // 这里用一个最小替身把「缺陷形态 -> 零写入」与「修复形态 -> 有写入」并列钉死。
  const xtermLike = (event) => (event.keyCode === 0 ? null : 'byte:' + String(event.keyCode))
  const { doc, handle } = setup()
  const textarea = doc.querySelector('.xterm-helper-textarea')
  const outcomes = []
  textarea.addEventListener('keydown', (event) => { outcomes.push(xtermLike(event)) })
  press(doc, 'up')
  assert.deepEqual(outcomes, ['byte:38'], '修复后 xterm 必须能认到键码并继续处理')
  assert.equal(outcomes.includes(null), false, '绝不能出现 keyCode=0 被丢弃的形态')
  handle.dispose()
})

test('Ctrl 闩锁组合：合成事件同样必须带非 0 keyCode（字母 = 大写 ASCII）', { skip: SKIP && 'jsdom 不可用' }, () => {
  // 说明：九键里 Tab/Esc/方向/回车 的组合会被拒绝（不支持），因此 Ctrl 组合只会经
  // resolveCtrlChar 走软键盘路径；这里直接验证那条路径产出的键身份。
  const result = resolveCtrlChar('c')
  assert.equal(result.ok, true)
  assert.equal(result.data, '\u0003')
  assert.equal(result.xterm.keyCode, 67, 'Ctrl+C 的 keyCode 是 C 键 67，不是控制字节 3')
  assert.notEqual(result.xterm.keyCode, 0)
  assert.equal(result.xterm.code, 'KeyC')
})

// ---------------------------------------------------------------------------
// 提示（不许静默）
// ---------------------------------------------------------------------------

test('不支持组合必须**可见提示**，且绝不发送任何字节', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, writes, handle } = setup()
  const textarea = doc.querySelector('.xterm-helper-textarea')
  const seen = []
  textarea.addEventListener('keydown', (event) => { seen.push(event.key) })

  for (const key of ['up', 'left', 'esc', 'tab', 'enter']) {
    // 每次都重新闩锁：拒绝会**自动解除**闩锁（这正是被测行为之一），不复位就会在第二轮变成发送。
    press(doc, 'ctrl')
    press(doc, key)
    const notice = doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']')
    assert.equal(notice.hidden, false, 'Ctrl+' + key + ' 必须给出提示')
    assert.equal(notice.textContent, KEYBAR_TEXT.noticeUnsupported)
    // 拒绝必须同时解除闩锁（用户不会卡在 Ctrl 态）。
    assert.equal(doc.querySelector('[' + KEYBAR_ATTR + '] button[data-key="ctrl"]').dataset.latched, 'false')
  }
  assert.deepEqual(writes, [], '拒绝时不得直写')
  assert.deepEqual(seen, [], '拒绝时不得合成 keydown')
  handle.dispose()
})

test('Ctrl 闩锁：按下后可见高亮，再按一次即取消并清除高亮', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const ctrl = doc.querySelector('[' + KEYBAR_ATTR + '] button[data-key="ctrl"]')
  assert.equal(ctrl.dataset.latched, 'false')
  press(doc, 'ctrl')
  assert.equal(ctrl.dataset.latched, 'true', '待命态必须有可见指示（用户口径）')
  press(doc, 'ctrl')
  assert.equal(ctrl.dataset.latched, 'false')
  handle.dispose()
})

test('Ctrl 闩锁 + 发送键后自动解除高亮（不会卡在 Ctrl 态）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  const ctrl = doc.querySelector('[' + KEYBAR_ATTR + '] button[data-key="ctrl"]')
  press(doc, 'ctrl')
  assert.equal(ctrl.dataset.latched, 'true')
  press(doc, 'up')
  assert.equal(ctrl.dataset.latched, 'false')
  handle.dispose()
})

test('键条点击后提示被清除（提示不得长期挂着）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  press(doc, 'ctrl')
  press(doc, 'up')
  assert.equal(doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']').hidden, false)
  press(doc, 'enter')
  assert.equal(doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']').hidden, true)
  handle.dispose()
})

test('键盘键：聚焦 textarea；壳侧桥返回 false 时必须给替代路径提示', { skip: SKIP && 'jsdom 不可用' }, () => {
  const okCase = setup({ bridge: { showSoftInput: () => true } })
  press(okCase.doc, 'keyboard')
  assert.equal(okCase.doc.activeElement, okCase.doc.querySelector('.xterm-helper-textarea'))
  assert.equal(okCase.doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']').hidden, true, '成功时不提示')
  okCase.handle.dispose()

  const failCase = setup({ bridge: { showSoftInput: () => false } })
  press(failCase.doc, 'keyboard')
  const notice = failCase.doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']')
  assert.equal(notice.hidden, false, '唤起失败必须给替代路径')
  assert.equal(notice.textContent, KEYBAR_TEXT.noticeKeyboardFailed)
  failCase.handle.dispose()
})

test('键盘键：必须**先 focus 再调壳侧桥**（同一次用户手势内，顺序反了就白丢手势）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const order = []
  const { doc, handle } = setup({
    bridge: { showSoftInput: () => { order.push('bridge@' + String(doc.activeElement?.className ?? 'none')); return true } },
  })
  const textarea = doc.querySelector('.xterm-helper-textarea')
  textarea.addEventListener('focus', () => { order.push('focus') })
  press(doc, 'keyboard')
  assert.deepEqual(order, ['focus', 'bridge@xterm-helper-textarea'],
    '必须先在同一次手势内 focus（才有 IME 弹出资格），再走壳侧桥兜底')
  handle.dispose()
})

test('反证：没有输入面时也要试着走桥，并给可见提示（不得静默）', { skip: SKIP && 'jsdom 不可用' }, () => {
  let called = 0
  const { doc, handle } = setup({ bridge: { showSoftInput: () => { called++; return true } } })
  doc.querySelector('.xterm-helper-textarea').remove()
  press(doc, 'keyboard')
  assert.equal(called, 1, '输入面缺失时仍应尝试壳侧桥')
  const notice = doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']')
  assert.equal(notice.hidden, false, '无论如何都要给替代路径提示')
  assert.equal(notice.textContent, KEYBAR_TEXT.noticeKeyboardFailed)
  handle.dispose()
})

test('反证：壳侧桥抛异常也必须提示（不得静默崩溃）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup({ bridge: { showSoftInput: () => { throw new Error('bridge down') } } })
  press(doc, 'keyboard')
  const notice = doc.querySelector('[' + KEYBAR_NOTICE_ATTR + ']')
  assert.equal(notice.hidden, false)
  assert.equal(notice.textContent, KEYBAR_TEXT.noticeKeyboardFailed)
  handle.dispose()
})

// ---------------------------------------------------------------------------
// visualViewport 兜底
// ---------------------------------------------------------------------------

test('底边留白由 CSS 变量驱动，且壳侧 IME 为 0 时靠 visualViewport 收缩救回（防形态 A/C）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, root, handle } = setup()
  // jsdom 无 visualViewport：注入一个可控替身，模拟键盘弹出（高度 800 -> 500）。
  const win = doc.defaultView
  let vvHeight = 800
  const listeners = new Map()
  Object.defineProperty(win, 'visualViewport', {
    configurable: true,
    value: {
      get height() { return vvHeight },
      offsetTop: 0,
      addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
      removeEventListener: () => {},
    },
  })
  Object.defineProperty(win, 'innerHeight', { configurable: true, value: 800 })
  // 壳侧 IME 恒 0（本模拟器实测）。
  const style = doc.createElement('style')
  style.textContent = ':root{--dsh-android-ime-bottom:0px;--dsh-android-system-bottom:0px}'
  doc.head.append(style)

  // 先卸掉 setup 的那条，再重挂 —— 让监听器绑到新的 visualViewport 替身上。
  handle.dispose()
  const fresh = mountKeybar({ root, write: () => true, applicationCursorKeys: () => false })
  const freshBar = doc.querySelector('[' + KEYBAR_ATTR + ']')
  assert.notEqual(freshBar, null, '键条必须在场')
  // 承载者必须是根节点（留白 = 根节点的 padding，在盒内且根节点无背景 -> 露页面底色）。
  // 自定义属性只向**后代**继承：写在键条上祖先读不到，于是
  // [data-sidebar-terminal]{padding-bottom:var(...)} 恒为 0。
  assert.equal(root.style.getPropertyValue(KEYBAR_INSET_VAR), '0px', '无键盘时留白 0（写在根节点上）')
  assert.equal(freshBar.style.getPropertyValue(KEYBAR_INSET_VAR), '',
    '反证：键条自己不得携带留白变量（那会把自己的底色涂满让开区 = 真机灰板形态）')

  vvHeight = 500
  for (const fn of listeners.get('resize') ?? []) fn()
  assert.equal(root.style.getPropertyValue(KEYBAR_INSET_VAR), '300px',
    'visualViewport 收缩 300px 必须变成底部留白（壳侧推送为 0 时唯一的救回通道）')

  // scroll 监听也必须生效（只监听 resize 会漏掉 offsetTop 变化）。
  vvHeight = 400
  for (const fn of listeners.get('scroll') ?? []) fn()
  assert.equal(root.style.getPropertyValue(KEYBAR_INSET_VAR), '400px', 'scroll 监听必须同样触发复算')
  fresh.dispose()
  // 卸载必须清掉根节点上的留白变量，否则下一个键条继承一个陈旧的非零留白。
  assert.equal(root.style.getPropertyValue(KEYBAR_INSET_VAR), '',
    'dispose 必须清掉根节点上的留白变量（防陈旧留白残留）')
})

test('反证：visualViewport 缺失时不得崩溃（旧内核/桌面）', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { doc, handle } = setup()
  assert.equal(doc.defaultView.visualViewport, undefined, 'jsdom 默认没有 visualViewport')
  press(doc, 'up')
  press(doc, 'ctrl')
  press(doc, 'down')
  assert.ok(doc.querySelector('[' + KEYBAR_ATTR + ']'))
  handle.dispose()
})
