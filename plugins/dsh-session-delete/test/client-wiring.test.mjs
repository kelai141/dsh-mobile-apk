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
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    setTimeout, clearTimeout, console,
    Symbol, JSON, Number, Date, String, Object, Array, Promise, RegExp, Error,
  }
  context.window.document = context.document
  context.globalThis = context
  const sandbox = vm.createContext(context)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(typeof factory, 'function', 'client bundle did not call __ModuleLoader__.load')
  const module = factory((id) => (id === 'react' ? react : primitives))
  return { module, react, sent, FakeXHR, sandbox, reloads, storage, toasts }
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
