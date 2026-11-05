// issue #1618：删除看门狗必须覆盖完整个重试阶梯，不能短于它。
//
// 缺陷现场：单次 2s x 3 次 = 6s，而看门狗 4s 就 reload。一次 2.5s 的正常删除（慢盘 / 首包冷启动）
// 会先超时、再在第 2 次重试途中被整页刷新 —— 用户丢掉滚动位置与输入框草稿，600ms 后由 resume
// 路径补发第三次。
//
// 判据全部是**行为**判据：在假时钟上跑真实客户端代码，看「重载发生在第几毫秒」与「那时重试阶梯
// 走到第几步」。不看源码切片。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 假时钟沙箱：接管 setTimeout / clearTimeout / Date.now。
 * 客户端里的看门狗、resume 延时、行清理复查都挂在这套时钟上。
 */
function createClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout(fn, delay) {
      const id = ++seq
      timers.set(id, { at: now + Number(delay || 0), fn })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    now: () => now,
    /** 推进到 target，按到期顺序逐个执行（执行中新排的定时器同样参与）。 */
    async advanceTo(target) {
      // 真实事件循环里微任务先于定时器：先把已排队的 Promise 回调放完，再推进时钟。
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      for (;;) {
        let next = null
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < next.t.at)) next = { id, t }
        }
        if (next === null) break
        timers.delete(next.id)
        now = next.t.at
        next.t.fn()
        // 让 Promise 微任务先跑完，再继续推进
        for (let i = 0; i < 12; i += 1) await Promise.resolve()
      }
      now = target
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    },
    get pending() { return timers.size },
  }
}

/** 最小 React 运行时（只实现这个插件用到的钩子）。 */
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
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    render(fn, props) { hooks = []; index = 0; return fn(props) },
    renderKeepingState(fn, props) { index = 0; return fn(props) },
  }
}

/** 载入客户端 bundle，返回可驱动的沙箱。 */
function loadClient(options = {}) {
  const clock = createClock()
  let factory = null
  const storage = new Map()
  const reloads = []
  const requests = []
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
    send(body) { this.body = body; requests.push({ at: clock.now(), body }) }
  }
  FakeXHR.instances = []
  const context = {
    window: {
      __ModuleLoader__: { load: ({ factory: f }) => { factory = f } },
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, v) },
        removeItem: (k) => { storage.delete(k) },
      },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: { href: 'http://127.0.0.1:3080/', reload: () => { reloads.push(clock.now()) } },
      addEventListener: () => {},
    },
    document: {
      documentElement: { getAttribute: () => null },
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ dataset: {}, remove: () => {}, setAttribute: () => {}, style: {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      visibilityState: 'visible',
    },
    navigator: { onLine: true },
    performance: { getEntriesByType: () => [] },
    XMLHttpRequest: FakeXHR,
    AbortSignal: { timeout: () => ({}) },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console,
    Symbol, JSON, Number, Date, String, Object, Array, Promise, RegExp, Error,
  }
  context.Date = { now: clock.now }
  context.window.document = context.document
  context.globalThis = context
  const sandbox = vm.createContext(context)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(typeof factory, 'function', 'client bundle did not call __ModuleLoader__.load')
  const module = factory((id) => (id === 'react' ? react : primitives))
  return { module, react, FakeXHR, clock, reloads, requests, storage }
}

const SESSION = 'session-16181618-1618-4161-8161-161816181618'

/** 打开确认框并点「删除」；返回已发出的第一次请求。 */
function startDelete(loaded) {
  const { module, react } = loaded
  const registrations = []
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, f) => { registrations.push(f()) }, register: (def, component) => ({ def, component }) },
  })
  const t = (k) => k
  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item' && r.def.id === 'delete')
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  assert.ok(menu && overlay, 'delete menu + overlay must be registered')
  react.render(menu.component, {
    sessionId: SESSION,
    displayTitle: 'x',
    useMenuOpenState: () => [true, () => {}],
    t,
  }).props.onSelect()
  const outer = react.render(overlay.component, { t })
  const inner = react.render(outer.type, outer.props)
  inner.props.footer.props.children[1].props.onClick()
}

// 保住的行为（旧实现也绿）：慢但成功的删除不得被看门狗打断、不得重发。
// 这条是下面两条的对照面 —— 修 #1618 不许把「真卡死也要有人管」一起改掉。
test('一次 2.5s 但成功的删除：不重发、不重载（保住的行为）', async () => {
  const loaded = loadClient()
  startDelete(loaded)
  const { FakeXHR, clock, reloads, requests } = loaded
  assert.equal(requests.length, 1, '确认后必须先发一次请求')

  // 单次请求耗时 2.5s（慢盘 / 首包冷启动）
  await clock.advanceTo(2500)
  const xhr = FakeXHR.instances.at(-1)
  xhr.status = 200
  xhr.responseText = JSON.stringify({ ok: true, sessionId: SESSION })
  xhr.onload()
  await clock.advanceTo(6000)

  assert.equal(requests.length, 1, '2.5s 内答完的删除不得重发（实得 ' + requests.length + ' 次）')
  assert.equal(reloads.length, 0, '看门狗不得在删除成功之前重载页面')
})

test('重试阶梯跑完（3 次 x 2s 超时）之前看门狗不得重载（issue #1618）', async () => {
  const loaded = loadClient()
  startDelete(loaded)
  const { FakeXHR, clock, reloads, requests } = loaded

  // 三次尝试依次超时：2s + 2s + 2s = 6s 的阶梯
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = requests.length
    assert.equal(before, attempt + 1, '第 ' + (attempt + 1) + ' 次尝试必须已经发出')
    // 走到本次请求超时（每次 2s）
    await clock.advanceTo(clock.now() + 2000)
    FakeXHR.instances.at(-1).ontimeout()
    for (let i = 0; i < 16; i += 1) await Promise.resolve()
    if (attempt < 2) {
      assert.equal(requests.length, attempt + 2, '超时必须触发下一次尝试')
      assert.equal(reloads.length, 0, '阶梯没跑完就重载 = 用户丢掉滚动位置与草稿（第 ' + (attempt + 1) + ' 次超时后）')
    }
  }

  assert.equal(reloads.length, 0, '阶梯跑完、且失败已经落到可见错误上时不得重载')
  // 失败可见（不是静默）：弹窗上必须出现 error 文案
  const trace = JSON.parse(loaded.storage.get('dsh.session-delete.trace') ?? '[]')
  assert.equal(trace.filter((row) => row.step === 'failed').length, 1, '阶梯耗尽必须落一次可见失败')
})

test('一次都没返回时才由看门狗重载，且不早于阶梯（issue #1618）', async () => {
  const loaded = loadClient()
  startDelete(loaded)
  const { clock, reloads, requests } = loaded

  // 全程无响应：三只 XHR 都挂着（不调用 ontimeout/onload/onerror）
  await clock.advanceTo(6000)
  assert.equal(reloads.length, 0, '阶梯自身的时间窗（6s）内不得重载')
  assert.equal(requests.length, 1, '挂起的请求不会被重发（XHR 自己的 timeout 才驱动重试）')

  // 越过阶梯 + 余量之后，看门狗必须接管（否则弹窗永远转）
  await clock.advanceTo(30000)
  assert.equal(reloads.length, 1, '彻底卡死时必须重载一次（且只一次），实得 ' + reloads.length + ' 次')
})
