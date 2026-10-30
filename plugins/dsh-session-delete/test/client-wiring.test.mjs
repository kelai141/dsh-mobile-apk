// 无头验证客户端点击链路：菜单项 onSelect → pending → overlay 渲染 → 确认按钮发请求。
// 现场问题：点「删除对话」后没有任何请求（engine.log 无 route hit，localStorage 无 confirm），
// 这里用最小 React 运行时把这条链跑一遍，定位是接线问题还是环境问题。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 最小 React 运行时：只实现这个插件用到的四个 API。 */
function createReact() {
  let hooks = []
  let index = 0
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      const slot = index++
      if (hooks[slot] === undefined) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [hooks[slot], (next) => { hooks[slot] = next }]
    },
    useRef(initial) {
      const slot = index++
      if (hooks[slot] === undefined) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    render(fn, props) {
      hooks = []
      index = 0
      return fn(props)
    },
    // issue #983/#1000：弹窗是「点确认 → setDone/setError → 再渲染」两段式。
    // 上面的 render() 会把 hooks 清空（重新挂载语义），读不到状态更新后的树；
    // 这里保留 hook 值、只把游标归零，等价于 React 的一次重渲染。
    renderKeepingState(fn, props) {
      index = 0
      return fn(props)
    },
  }
}

/** 载入客户端 bundle，返回 { apply }。 */
function loadClient(options = {}) {
  let factory = null
  const sent = []
  const reloads = []
  const storage = new Map()
  const react = createReact()
  const primitives = {
    MenuItemButton: function MenuItemButton() {},
    IconTrashOutlineRegular: function IconTrashOutlineRegular() {},
    Modal: function Modal() {},
  }
  class FakeXHR {
    constructor() { this.status = 0; this.responseText = '{}'; FakeXHR.instances.push(this) }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader() {}
    send(body) { this.body = body; sent.push({ method: this.method, url: this.url, body }) }
  }
  FakeXHR.instances = []
  if (options.pending !== undefined) {
    storage.set('dsh.session-delete.pending', JSON.stringify({ sessionId: options.pending, at: Date.now() }))
  }
  const toasts = []
  const fetches = []
  const context = {
    window: {
      __ModuleLoader__: { load: ({ factory: f }) => { factory = f } },
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, v) },
        removeItem: (k) => { storage.delete(k) },
      },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: { href: 'http://127.0.0.1:3080/', reload: () => { reloads.push(Date.now()) } },
      addEventListener: () => {},
    },
    document: {
      documentElement: { getAttribute: () => null },
      head: { appendChild: () => {} },
      // #510 的续做失败 toast 需要 body.appendChild；桩记录创建的元素供断言。
      body: { appendChild: (el) => { toasts.push(el) } },
      getElementById: () => null,
      createElement: () => ({ dataset: {}, remove: () => {}, setAttribute: () => {}, style: {} }),
      querySelector: (selector) => {
        if (selector === '[data-conversation-session]' && options.mountedId !== undefined) {
          return { getAttribute: () => options.mountedId }
        }
        if (selector.startsWith('[data-row-key=') && options.rowPresent === true) {
          return { getAttribute: () => selector }
        }
        return null
      },
      querySelectorAll: () => [],
      visibilityState: 'visible',
    },
    navigator: { onLine: true },
    performance: { getEntriesByType: () => [] },
    XMLHttpRequest: FakeXHR,
    AbortSignal: { timeout: () => ({}) },
    fetch: (url, init) => {
      fetches.push({ url, init })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    },
    setTimeout, clearTimeout, console,
    Symbol, JSON, Number, Date, String, Object, Array, Promise, RegExp, Error,
  }
  context.window.document = context.document
  context.globalThis = context
  const sandbox = vm.createContext(context)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(typeof factory, 'function', 'client bundle did not call __ModuleLoader__.load')
  const module = factory((id) => (id === 'react' ? react : primitives))
  return { module, react, sent, FakeXHR, sandbox, reloads, storage, toasts, fetches }
}

test('menu item click opens the overlay and the confirm button sends the request', async () => {
  const { module, react, sent, FakeXHR } = loadClient()
  const registrations = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return d },
    locale: { register: () => () => {} },
    slots: {
      inject: (_name, factory) => { registrations.push(factory()) },
      register: (def, component) => ({ def, component }),
    },
  }
  module.apply(ctx)
  // issue #912：注册数由 2 → 3（delete 菜单项 + **quarantine 菜单项** + overlay）。
  // 两个菜单入口并存是有意的：既要能「隔离保留」，也要能「彻底删除」。
  assert.equal(registrations.length, 3, 'expected two menu item registrations + overlay')

  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  assert.ok(menu && overlay, 'both slots must be registered')

  const t = (key) => key
  const menuTree = react.render(menu.component, {
    sessionId: 'session-11111111-1111-4111-8111-111111111111',
    displayTitle: 'hello',
    useMenuOpenState: () => [true, () => {}],
    t,
  })
  assert.equal(typeof menuTree.props.onSelect, 'function', 'menu item must expose onSelect')
  menuTree.props.onSelect()

  const overlayTree = react.render(overlay.component, { t })
  assert.ok(overlayTree !== null, 'overlay must render after selecting the menu item')
  const dialog = react.render(overlayTree.type, overlayTree.props)
  assert.equal(dialog.type, undefined === dialog.type ? undefined : dialog.type)
  assert.equal(dialog.props.open, true, 'modal must be open')

  const buttons = dialog.props.footer.props.children
  const confirm = buttons[1]
  assert.equal(typeof confirm.props.onClick, 'function', 'confirm button must be wired')
  confirm.props.onClick()

  assert.equal(sent.length >= 1, true, 'confirm must send the delete request')
  assert.equal(sent[0].url, '/api/session-delete')
  assert.equal(JSON.parse(sent[0].body).sessionId, 'session-11111111-1111-4111-8111-111111111111')
  assert.equal(FakeXHR.instances.length >= 1, true)
})

test('deleting the conversation on screen reloads the page (no private navigation)', async () => {
  const SESSION = 'session-22222222-2222-4222-8222-222222222222'
  const { module, react, FakeXHR, reloads } = loadClient({ mountedId: SESSION })
  const registrations = []
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, f) => { registrations.push(f()) }, register: (def, component) => ({ def, component }) },
  })
  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  const t = (k) => k
  const menuTree = react.render(menu.component, {
    sessionId: SESSION,
    displayTitle: 'x',
    useMenuOpenState: () => [true, () => {}],
    t,
  })
  menuTree.props.onSelect()
  const dialog = react.render(overlay.component, { t })
  const inner = react.render(dialog.type, dialog.props)
  inner.props.footer.props.children[1].props.onClick()

  const xhr = FakeXHR.instances.at(-1)
  xhr.status = 200
  xhr.responseText = '{"ok":true,"sessionId":"' + SESSION + '"}'
  xhr.onload()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()

  assert.equal(reloads.length, 1, 'deleting the mounted conversation must reload the page')
})

/** 打开确认框并点「删除」，返回当前 XHR 实例。 */
function clickConfirm(module, react) {
  const registrations = []
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, f) => { registrations.push(f()) }, register: (def, component) => ({ def, component }) },
  })
  const t = (k) => k
  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  const menuTree = react.render(menu.component, {
    sessionId: 'session-44444444-4444-4444-8444-444444444444',
    displayTitle: 'x',
    useMenuOpenState: () => [true, () => {}],
    t,
  })
  menuTree.props.onSelect()
  const dialog = react.render(overlay.component, { t })
  const inner = react.render(dialog.type, dialog.props)
  inner.props.footer.props.children[1].props.onClick()
}

test('a timeout is retried, and a final failure is recorded with its code', async () => {
  const { module, react, FakeXHR, storage } = loadClient()
  clickConfirm(module, react)
  assert.equal(FakeXHR.instances.length, 1)

  FakeXHR.instances.at(-1).ontimeout()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(FakeXHR.instances.length, 2, 'timeout must trigger a retry')

  FakeXHR.instances.at(-1).ontimeout()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(FakeXHR.instances.length, 3, 'second timeout must trigger the last attempt')

  const last = FakeXHR.instances.at(-1)
  last.status = 409
  last.responseText = JSON.stringify({ ok: false, error: 'session-active', message: 'running' })
  last.onload()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()

  const trace = JSON.parse(storage.get('dsh.session-delete.trace') ?? '[]')
  const failed = trace.filter((row) => row.step === 'failed')
  assert.equal(failed.length, 1, 'the failure must be recorded')
  assert.equal(failed[0].extra.code, 'session-active')
})

test('a 404 carrying not-found is treated as already deleted', async () => {
  const { module, react, FakeXHR, storage, reloads } = loadClient()
  clickConfirm(module, react)
  const xhr = FakeXHR.instances.at(-1)
  xhr.status = 404
  xhr.responseText = JSON.stringify({ ok: false, error: 'not-found', message: 'gone' })
  xhr.onload()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()

  const trace = JSON.parse(storage.get('dsh.session-delete.trace') ?? '[]')
  assert.equal(trace.some((row) => row.step === 'deleted'), true, '404 must count as deleted')
  assert.equal(trace.some((row) => row.step === 'failed'), false, '404 must not be reported as failure')
  assert.equal(reloads.length, 0, 'nothing mounted ⇒ no reload')
})

test('a pending delete from a previous page resumes automatically', async () => {
  const SESSION = 'session-66666666-6666-4666-8666-666666666666'
  const { module, FakeXHR, storage } = loadClient({ pending: SESSION })
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: () => {}, register: () => ({}) },
  })
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(FakeXHR.instances.length, 1, 'resume must fire the request without user input')
  assert.equal(JSON.parse(FakeXHR.instances[0].body).sessionId, SESSION)

  const xhr = FakeXHR.instances[0]
  xhr.status = 200
  xhr.responseText = '{"ok":true}'
  xhr.onload()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  assert.equal(storage.has('dsh.session-delete.pending'), false, 'resume success must clear the pending entry')
})

test('a failed resume surfaces a visible notice instead of failing silently (#510)', async () => {
  const SESSION = 'session-88888888-8888-4888-8888-888888888888'
  const { module, FakeXHR, storage, toasts } = loadClient({ pending: SESSION })
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: () => {}, register: () => ({}) },
  })
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(FakeXHR.instances.length, 1, 'resume must still fire the request')

  const xhr = FakeXHR.instances[0]
  xhr.status = 409
  xhr.responseText = JSON.stringify({ ok: false, error: 'session-active', message: 'running' })
  xhr.onload()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()

  assert.equal(storage.has('dsh.session-delete.pending'), false, 'failed resume must still drop the pending entry')
  assert.equal(toasts.length, 1, 'failed resume must append exactly one visible notice')
  assert.equal(
    toasts[0].textContent.includes('正在运行'), true,
    'notice text must come from the zh dictionary (sandbox navigator has no language ⇒ zh)',
  )
})

test('a deleted session whose sidebar row survives triggers one reload', async () => {
  const SESSION = 'session-77777777-7777-4777-8777-777777777777'
  const { module, react, FakeXHR, reloads } = loadClient({ rowPresent: true })
  const registrations = []
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, f) => { registrations.push(f()) }, register: (def, component) => ({ def, component }) },
  })
  const t = (k) => k
  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  const menuTree = react.render(menu.component, {
    sessionId: SESSION, displayTitle: 'x', useMenuOpenState: () => [true, () => {}], t,
  })
  menuTree.props.onSelect()
  const dialog = react.render(overlay.component, { t })
  const inner = react.render(dialog.type, dialog.props)
  inner.props.footer.props.children[1].props.onClick()
  const xhr = FakeXHR.instances.at(-1)
  xhr.status = 200
  xhr.responseText = '{"ok":true}'
  xhr.onload()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(reloads.length, 1, 'the surviving row must force one reload')
})
// issue #912：防「为腾位置把隔离入口删掉」。
//
// 这条断言刻意同时检查 **delete** 与 **quarantine** 两个菜单注册都在 ——
// 单独检查 quarantine 存在，无法发现「两个都被合并成一个」这种退化。
test('菜单里同时存在删除与隔离两个入口', () => {
  const { module, react } = loadClient()
  const registrations = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return d },
    locale: { register: () => () => {} },
    slots: {
      inject: (_name, factory) => { registrations.push(factory()) },
      register: (def, component) => ({ def, component }),
    },
  }
  module.apply(ctx)
  const menuItems = registrations.filter((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(menuItems.length, 2, '必须是两个独立菜单注册，不是合并成一个')
  const ids = menuItems.map((r) => r.def.id).sort()
  assert.deepEqual(ids, ['delete', 'quarantine'], '两个入口的 id 必须是 delete 与 quarantine')
  // 隔离入口必须能渲染出可见文案，且文案里出现「恢复」——它是「不是删除」的唯一提示。
  const quarantine = menuItems.find((r) => r.def.id === 'quarantine')
  const tree = quarantine.component({
    sessionId: 'session-12345678-1234-4abc-8def-1234567890ab',
    displayTitle: 'T',
    useMenuOpenState: () => [false, () => {}],
    t: (key) => (key === 'menu.quarantine' ? '隔离（不删除，可恢复）' : key),
  })
  assert.equal(typeof tree.props.onSelect, 'function', 'quarantine 菜单项必须暴露 onSelect')
  assert.match(String(tree.props.children[0]), /恢复/, '隔离入口文案必须说明可恢复')
})

// ───────────────────────── issue #983 / #1000 ─────────────────────────

/** 递归收集树上的字符串子节点（渲染文案断言用）。 */
function textNodes(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) textNodes(child, out); return out }
  if (typeof node === 'object' && node.props) {
    textNodes(node.props.children ?? null, out)
    if (node.props.title) textNodes(node.props.title, out)
    if (node.props.description) textNodes(node.props.description, out)
    if (node.props.value) textNodes(node.props.value, out)
  }
  return out
}

/** 找第一个带指定 role 的节点（role=alert ⇒ 非成功提示）。 */
function findByRole(node, role) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByRole(child, role)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.props && node.props.role === role) return node
  if (node.props) {
    const hit = findByRole(node.props.children ?? null, role)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 打开**隔离**确认框并点确认，把服务端回包灌进 XHR，返回状态更新后的弹窗树。
 *
 * 隔离弹窗只能由 quarantine 菜单项打开（pending.kind === 'quarantine'），所以走菜单。
 * 状态更新必须用 renderKeepingState：react.render 会清空 hook（重新挂载语义），
 * 读不到 setDone/setError 之后的样子。
 */
async function clickQuarantineThen(options, respond) {
  const sessionId = options.sessionId
  const loaded = loadClient({ ...options })
  const { module, react, FakeXHR } = loaded
  const registrations = []
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, f) => { registrations.push(f()) }, register: (def, component) => ({ def, component }) },
  })
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item' && r.def.id === 'quarantine')
  assert.ok(menu && overlay, 'quarantine menu + overlay must both be registered')
  const t = (key, params) => (params === undefined ? key : key + '(' + JSON.stringify(params) + ')')
  const menuTree = react.render(menu.component, { sessionId, displayTitle: 'x', useMenuOpenState: () => [true, () => {}], t })
  menuTree.props.onSelect()
  const outer = react.render(overlay.component, { t })
  assert.ok(outer !== null, 'the quarantine confirm must open')
  const inner = react.render(outer.type, outer.props)
  inner.props.footer.props.children[1].props.onClick()
  const xhr = FakeXHR.instances.at(-1)
  respond(xhr)
  xhr.onload()
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  const tree = react.renderKeepingState(outer.type, outer.props)
  /**
   * 关掉弹窗（等价于点「取消」/ Modal 的 onClose）。
   * issue #1000 的时序：隔离成功先显示可复制路径，**关窗之后**才做行清理
   * （否则重载会立刻把刚显示的路径冲掉）。所以行清理只能在 close() 之后断言。
   */
  const close = () => {
    const latest = react.renderKeepingState(outer.type, outer.props)
    const cancel = latest.props.footer.props.children[0]
    cancel.props.onClick()
    return react.renderKeepingState(outer.type, outer.props)
  }
  return { ...loaded, tree, close }
}

const QID = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEPT = '/home/.dsh/sessions/--w--/.corrupt/' + QID + '.1700000000000'

// issue #983：重复点「隔离」拿到 409 already-quarantined、服务端给了 paths 时，
// 客户端必须渲染**非成功**提示（error.alreadyQuarantined，带 path）。
// 修复前 reason.paths 读不到（宿主不外带）⇒ path 是空串 ⇒ done 被塞成 '' ⇒ 走成功横幅 quarantine.ok。
test('已隔离（服务端带 paths）不得渲染成功横幅，用 error.alreadyQuarantined（issue #983）', async () => {
  const { tree } = await clickQuarantineThen({ sessionId: QID, rowPresent: false }, (xhr) => {
    xhr.status = 409
    xhr.responseText = JSON.stringify({ ok: false, error: 'already-quarantined', message: 'already', paths: [KEPT] })
  })
  const joined = textNodes(tree).join(' | ')
  assert.equal(joined.includes('quarantine.ok'), false, '失败不得复用成功文案 quarantine.ok，实际：' + joined)
  const alert = findByRole(tree, 'alert')
  assert.ok(alert !== null, '必须渲染一个非成功的提示（role=alert），实际树：' + JSON.stringify(textNodes(tree)))
  const alertText = textNodes(alert).join(' ')
  assert.equal(alertText.startsWith('error.alreadyQuarantined'), true, '必须用已有文案 error.alreadyQuarantined，实际：' + alertText)
  assert.equal(alertText.includes(KEPT), true, '文案必须带出服务端给的路径，实际：' + alertText)
})

// issue #983：老宿主不回 paths（或回空数组）时不得渲染空路径文案。
// 「已隔离到：（文件仍在，可恢复）」这种空路径横幅正是本 issue 的现场。
test('已隔离但服务端没给 paths 时不得渲染空路径（issue #983）', async () => {
  for (const body of [
    { ok: false, error: 'already-quarantined', message: 'already' },
    { ok: false, error: 'already-quarantined', message: 'already', paths: [] },
  ]) {
    const { tree } = await clickQuarantineThen({ sessionId: QID, rowPresent: false }, (xhr) => {
      xhr.status = 409
      xhr.responseText = JSON.stringify(body)
    })
    const joined = textNodes(tree).join(' | ')
    assert.equal(joined.includes('quarantine.ok'), false, '不得走成功文案，实际：' + joined)
    assert.equal(joined.includes('""'), false, '不得渲染空路径参数，实际：' + joined)
    const alert = findByRole(tree, 'alert')
    assert.ok(alert !== null, '必须给出可见提示，实际：' + joined)
    assert.equal(textNodes(alert).join(' ').trim() === '', false, '提示文案不得为空')
  }
})

// issue #1000：隔离成功后必须走**与删除相同**的行清理机制（挂载中 reload / 未挂载延迟复查行）。
// 修复前隔离成功只 setDone(...)，界面什么都不做 ⇒ 侧栏行仍在原地、点开仍是坏会话。
//
// 时序（本 issue 明确要求想清楚）：**先显示可复制路径，关窗之后才做行清理**。
// 理由：清理一旦判定要重载，页面立刻刷新，刚显示的隔离件绝对路径就没了 ——
// 而那个路径正是用户要抄下来备份 / 贴进 issue 的东西。删除分支不显示路径，
// 所以在成功回调里直接清理；两条路径共用同一个清理实现，只是触发点不同。
test('隔离成功后侧栏行仍在 ⇒ 关窗后与删除一样触发一次 reload（issue #1000）', async () => {
  const { reloads, close, tree } = await clickQuarantineThen({ sessionId: QID, rowPresent: true }, (xhr) => {
    xhr.status = 200
    xhr.responseText = JSON.stringify({ ok: true, sessionId: QID, quarantinedTo: KEPT, restorable: true })
  })
  // 关闭之前：成功横幅 + 可复制路径必须还在（这是保留既有行为的判据）。
  const before = textNodes(tree).join(' | ')
  assert.equal(before.includes(KEPT), true, '关窗之前必须仍显示可复制路径，实际：' + before)
  assert.equal(reloads.length, 0, '路径还在显示时不得立刻重载（否则路径被冲掉）')
  close()
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(reloads.length, 1, '行仍在 ⇒ 关窗后必须重载（与删除分支同一机制），实际 ' + reloads.length + ' 次')
})

// issue #1000：隔离的是**当前挂载**的会话 ⇒ 关窗后立即 reload（与删除分支同一判定）。
test('隔离当前挂载的会话 ⇒ 关窗后立即 reload（issue #1000）', async () => {
  const { reloads, close } = await clickQuarantineThen({ sessionId: QID, mountedId: QID }, (xhr) => {
    xhr.status = 200
    xhr.responseText = JSON.stringify({ ok: true, sessionId: QID, quarantinedTo: KEPT, restorable: true })
  })
  assert.equal(reloads.length, 0, '关窗之前不得重载')
  close()
  assert.equal(reloads.length, 1, '挂载中的会话被隔离后必须重载')
})

// issue #1000 的时序细节：先失败（已隔离过）再成功，关窗必须仍然清理，
// 且不能把上一次的旧路径留在成功横幅里。
test('先失败后成功：关窗仍清理且不残留旧路径（issue #983/#1000）', async () => {
  const sessionId = QID
  const { module, react, FakeXHR, reloads } = loadClient({ sessionId, rowPresent: true })
  const registrations = []
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, f) => { registrations.push(f()) }, register: (def, component) => ({ def, component }) },
  })
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item' && r.def.id === 'quarantine')
  const t = (key, params) => (params === undefined ? key : key + '(' + JSON.stringify(params) + ')')
  react.render(menu.component, { sessionId, displayTitle: 'x', useMenuOpenState: () => [true, () => {}], t }).props.onSelect()
  const outer = react.render(overlay.component, { t })
  const inner = react.render(outer.type, outer.props)
  const confirm = () => inner.props.footer.props.children[1].props.onClick()

  // 第一次：已隔离过
  confirm()
  const first = FakeXHR.instances.at(-1)
  first.status = 409
  first.responseText = JSON.stringify({ ok: false, error: 'already-quarantined', message: 'already', paths: [KEPT] })
  first.onload()
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  assert.equal(textNodes(react.renderKeepingState(outer.type, outer.props)).join(' ').includes('quarantine.ok'), false, '失败不得显示成功横幅')

  // 第二次：这次真的搬走了（例如用户先恢复了文件再隔离）
  confirm()
  const second = FakeXHR.instances.at(-1)
  const NEW_PATH = '/home/.dsh/sessions/--w--/.corrupt/' + QID + '.1800000000000'
  second.status = 200
  second.responseText = JSON.stringify({ ok: true, sessionId, quarantinedTo: NEW_PATH, restorable: true })
  second.onload()
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  const okText = textNodes(react.renderKeepingState(outer.type, outer.props)).join(' | ')
  assert.equal(okText.includes(NEW_PATH), true, '成功横幅必须显示新路径，实际：' + okText)
  assert.equal(okText.includes(KEPT), false, '不得残留上一次失败的旧路径，实际：' + okText)
  assert.equal(okText.includes('alreadyQuarantined'), false, '成功之后不得还挂着失败提示，实际：' + okText)

  react.renderKeepingState(outer.type, outer.props).props.footer.props.children[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(reloads.length, 1, '成功过 ⇒ 关窗必须清理行，实际 ' + reloads.length + ' 次')
})

// issue #1000 的反向判据：**已隔离过**（非成功）不得触发行清理。
// 那条会话本来就已经不在列表里了，重载只会打断用户读「文件在哪」。
test('已隔离过不触发行清理（issue #1000 反向判据）', async () => {
  const { reloads, close } = await clickQuarantineThen({ sessionId: QID, mountedId: QID }, (xhr) => {
    xhr.status = 409
    xhr.responseText = JSON.stringify({ ok: false, error: 'already-quarantined', message: 'already', paths: [KEPT] })
  })
  close()
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(reloads.length, 0, '非成功结果不得触发重载，实际 ' + reloads.length + ' 次')
})

// issue #1000：共用机制的反证 —— 不复制第二份逻辑。
// 行探针（[data-row-key=session:<id>]）只允许有一处：复制一份清理逻辑必然让它变成两处。
test('删除与隔离共用同一个行清理实现，不是第二份复制（issue #1000）', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const probes = client.match(/data-row-key=/g) ?? []
  assert.equal(probes.length, 1, '行探针只能有一处（复制第二份清理逻辑会变成 2 处），实际 ' + probes.length)
  const shared = client.match(/function\s+\w*[Rr]ow\w*\s*\(/g) ?? []
  assert.equal(shared.length >= 1, true, '必须抽出可复用的行清理函数，实际：' + JSON.stringify(shared))
  assert.equal(/alreadyGone:\s*data\.alreadyGone/.test(client), true, '删除专有的 alreadyGone 标记必须留在删除侧')
})
