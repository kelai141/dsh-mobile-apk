// slot-guard.test.mjs — 上游槽位 entry undefined 组件守卫的行为回归（2026-10-25 小米 14 实锤）。
//
// 为什么需要它：真机上 `slot entry crashed in 'conversation.input.left'` + React #130
// （createElement/jsx 收到 undefined 元素类型）会让整棵 React 树卸载、pageSideRuntime=unavailable、
// 启动流两次重试耗尽落修复门——四组对照证明崩点在上游槽位系统（详见 lib/index.js
// SLOT_GUARD_SCRIPT 头注释）。守卫在外围把 undefined 元素降级为 render null。
//
// 本测试从**真实 lib/index.js 源码**里抽出注入页面的脚本体（真源码，非副本），在 vm 里复现
// 上游 dsh-client-modules 的 queue → load(...) → create(...) 三段时序，对照「有守卫 / 无守卫」
// 的行为：无守卫 jsx(undefined) 抛 #130 形态错误；有守卫返回 null 且 warn 一次、正常元素路径
// 透传、幂等不重复包裹、注入位置/哨兵正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 抽 SLOT_GUARD_SCRIPT 模板串并按模板字面量语义求值（与页面收到的字节一致；无 ${} 插值）。 */
function slotGuardBody() {
  const start = SRC.indexOf('const SLOT_GUARD_SCRIPT = `<script>')
  assert.ok(start > 0, 'lib/index.js 必须定义 SLOT_GUARD_SCRIPT')
  const end = SRC.indexOf('})()</script>`', start)
  assert.ok(end > start, 'SLOT_GUARD_SCRIPT 必须能被完整取出')
  const evaluated = new Function(
    SRC.slice(start, end + '})()'.length) + '`; return SLOT_GUARD_SCRIPT',
  )()
  return evaluated.replace(/^<script>/, '').replace(/<\/script>$/, '')
}

/** 截取从 from 到 to 的源码段（朴素配对花括号不适用于模板串，这里按标记点切）。 */
function sliceBetween(fromMark, toMark) {
  const i = SRC.indexOf(fromMark)
  assert.ok(i >= 0, '源码必须包含 ' + fromMark)
  const j = SRC.indexOf(toMark, i)
  assert.ok(j > i, '源码必须包含 ' + toMark)
  return SRC.slice(i, j)
}

/** 注入页面前的守卫脚本（真实求值产物）——供各用例在 vm 里执行。 */
const GUARD = slotGuardBody()

/** 最小 react / jsx-runtime 命名空间：jsx(undefined) 复现 React #130 的抛错形态。 */
function fakeReactModules() {
  const jsxRuntime = {
    jsx(type) {
      if (type === undefined) throw new Error('Minified React error #130')
      return { type, ok: true }
    },
    jsxs(type) {
      if (type === undefined) throw new Error('Minified React error #130')
      return { type, ok: true }
    },
  }
  const react = {
    createElement(type) {
      if (type === undefined) throw new Error('Minified React error #130')
      return { type, ok: true }
    },
  }
  const cache = { react, 'react/jsx-runtime': jsxRuntime }
  const requireFromCache = (spec) => {
    if (!(spec in cache)) throw new Error('module not found: ' + spec)
    return cache[spec]
  }
  return { cache, jsxRuntime, react, requireFromCache }
}

/** 上游 dsh-client-modules 的 queue 形态装载器（bootInjections 里那段的等价缩小版）。 */
function queueLoader() {
  const pendingQueue = []
  return {
    mode: 'queue',
    pendingQueue,
    load(registration) {
      pendingQueue.push(registration)
    },
    create(options) {
      // 真实现在此处换成模块系统并执行 factory；测试里直接以 requireFromCache 当系统 require。
      return {
        require: options.requireFromCache,
        run(factory) {
          return factory(options.requireFromCache)
        },
      }
    },
  }
}

/** 新建 vm 沙箱（含 window/console/warns 收集）；guardFirst 决定是否先执行守卫脚本。 */
function freshPage(guardFirst) {
  const warns = []
  const sandbox = { console: { warn: (...a) => warns.push(a.join(' ')) }, window: {} }
  const context = createContext(sandbox)
  if (guardFirst) runInContext(GUARD, context)
  return { context, sandbox, warns }
}

/** 在 vm 内完成「上游 queue 脚本」的 __ModuleLoader__ 赋值（set trap 只在 vm 内触发）。 */
function assignLoaderInPage(context, loader) {
  context.__loaderFromHost = loader
  runInContext('window.__ModuleLoader__ = __loaderFromHost', context)
}

test('反证：无守卫时 jsx(undefined) 抛 #130 形态错误（真机现象）', () => {
  const { jsxRuntime } = fakeReactModules()
  assert.throws(() => jsxRuntime.jsx(undefined), /#130/)
})

test('守卫生效：queue 赋值被拦、factory 的 require 被包、jsx(undefined) 降级为 null', () => {
  const { context, warns } = freshPage(true)
  const mods = fakeReactModules()
  const loader = queueLoader()
  assignLoaderInPage(context, loader)

  // 模拟一个 bundle 注册：factory 里 require jsx-runtime / react，渲染 undefined 元素 + 正常元素
  const registered = []
  loader.load({
    id: 'test-entry',
    factory(req) {
      const jsxrt = req('react/jsx-runtime')
      const react = req('react')
      registered.push(jsxrt.jsx(undefined))
      registered.push(jsxrt.jsxs(undefined))
      registered.push(jsxrt.jsx('div'))
      registered.push(react.createElement('span'))
      return {}
    },
  })

  // create 换真系统并执行 factory（factory 由系统调用，require 是系统内部函数）
  const sys = loader.create({ requireFromCache: mods.requireFromCache })
  sys.run(loader.pendingQueue[0].factory)

  assert.equal(registered[0], null, 'jsx(undefined) 应降级为 null')
  assert.equal(registered[1], null, 'jsxs(undefined) 应降级为 null')
  assert.deepEqual(
    { type: registered[2].type, ok: registered[2].ok },
    { type: 'div', ok: true },
    '正常元素路径必须透传原实现',
  )
  assert.deepEqual(
    { type: registered[3].type, ok: registered[3].ok },
    { type: 'span', ok: true },
    'react.createElement 正常路径透传',
  )
  assert.ok(warns.length >= 1 && warns[0].includes('slot-guard'), '应 console.warn 一次: ' + warns[0])
})

test('幂等：守卫脚本重复执行短路；同一命名空间不重复包裹', () => {
  const { context } = freshPage(true)
  runInContext(GUARD, context) // 第二次执行：window 哨兵应短路
  const mods = fakeReactModules()
  const loader = queueLoader()
  assignLoaderInPage(context, loader)
  let calls = 0
  loader.load({
    id: 'probe',
    factory(req) {
      const j = req('react/jsx-runtime')
      const before = j.jsx
      const j2 = req('react/jsx-runtime') // 二次 require：同一缓存对象，不得再包一层
      assert.equal(j2.jsx, before, '二次 require 不得再包一层')
      j.jsx('div')
      calls++
      return {}
    },
  })
  const sys = loader.create({ requireFromCache: mods.requireFromCache })
  sys.run(loader.pendingQueue[0].factory)
  assert.equal(calls, 1)
})

test('create 返回的系统 require 也被包裹（双保险路径）', () => {
  const { context } = freshPage(true)
  const mods = fakeReactModules()
  const loader = queueLoader()
  assignLoaderInPage(context, loader)
  const sys = loader.create({ requireFromCache: mods.requireFromCache })
  const j = sys.require('react/jsx-runtime')
  assert.equal(j.jsx(undefined), null, '经 sys.require 拿到的命名空间同样有守卫')
  assert.ok(j.jsx('div').ok)
})

test('注入单元：<head> 开标签后注入、先于上游脚本、哨兵幂等、无 head 原样返回', () => {
  // 常量 + 函数一起求值（injectSlotGuard 引用模块层常量 SLOT_GUARD_SCRIPT）
  const inject = new Function(
    sliceBetween('const SLOT_GUARD_SCRIPT', '\n// Theme bridge') +
      '\n' +
      sliceBetween('function injectSlotGuard(html)', '\n/**') +
      '\nreturn injectSlotGuard',
  )()
  const html =
    '<html><head><meta charset="utf-8"><script>window.__ModuleLoader__={}</script></head><body></body></html>'
  const out = inject(html)
  const guardPos = out.indexOf('__dshSlotGuard')
  const upstreamPos = out.indexOf('window.__ModuleLoader__')
  assert.ok(guardPos > 0 && upstreamPos > guardPos, '守卫必须先于上游 queue 脚本求值')
  assert.ok(out.startsWith('<html><head><script'), '注入点紧跟 <head> 开标签之后')
  // 带属性的 head 标签
  const out2 = inject('<head profile="x"></head>')
  assert.ok(out2.includes('__dshSlotGuard') && out2.startsWith('<head profile="x"><script'))
  // 哨兵幂等
  assert.equal(inject(out), out)
  // 无 head / 非字符串：原样返回
  const plain = '<html><body>ok</body></html>'
  assert.equal(inject(plain), plain)
  assert.equal(inject(null), null)
})

test('源码结构：assertInjectionsParse 与 apply 均登记 slot-guard', () => {
  assert.ok(SRC.includes("['slot-guard', SLOT_GUARD_SCRIPT]"), 'assertInjectionsParse 必须登记')
  assert.ok(SRC.includes('injectSlotGuard(html)'), 'apply 必须 tapIndex 注册 injectSlotGuard')
})
