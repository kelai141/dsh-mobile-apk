// #688：控件清单必须按「会话 + 目标屏」隔离，跨会话/跨屏的 ref 绝不能被复用。
//
// 为什么用源码契约而不是行为单测：这份缓存活在 manage 的工具闭包里（要真实控制队列 + 壳侧快照才能
// 产生），行为路径在 JVM 侧由 `ShellOps`/壳单测覆盖；这一层能离线钉住的是**判据的存在与形状**——
// 只要有人把「只看 TTL」改回来、或把作用域包装摘掉，本文件立刻红。
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

test('清单条目带归属标记：session 与 screenId 都必须写进缓存', () => {
  assert.ok(/interface UiCache\b/.test(source), '找不到 UiCache 接口')
  const iface = source.slice(source.indexOf('interface UiCache'), source.indexOf('/** 最近一次 dump'))
  assert.ok(iface.includes('session: string'), 'UiCache 必须记录产出它的会话')
  assert.ok(iface.includes('screenId: string'), 'UiCache 必须记录目标屏')
})

test('复用判据必须同时校验 TTL、会话、目标屏（少一条就能跨屏/跨会话点到别处）', () => {
  const start = source.indexOf('const usableUiCache = (')
  assert.notEqual(start, -1, '找不到 usableUiCache')
  const body = source.slice(start, source.indexOf('/** 给工具执行套上清单作用域'))
  assert.ok(body.includes('UI_CACHE_TTL'), '缺少 TTL 判据')
  assert.ok(body.includes('candidate.session !== sessionOf(exec)'), '缺少会话判据（跨会话复用会命中同名的另一个 n3）')
  assert.ok(body.includes('candidate.screenId !== screenIdOf(args)'), '缺少目标屏判据（跨屏复用会点到另一块屏）')
})

test('每个工具的执行都跑在清单作用域里（否则 uiCacheNow() 读到的是别人的缓存）', () => {
  assert.ok(source.includes('withUiCacheScope'), '找不到作用域包装器')
  const ret = source.slice(source.indexOf('return [screenList, screenshot, uiTree'), source.indexOf('return [screenList, screenshot, uiTree') + 400)
  assert.ok(ret.includes('.map((tool) => withUiCacheScope(tool))'), '工具数组没有过 withUiCacheScope')
  assert.ok(source.includes('uiScope.run('), '作用域必须用 AsyncLocalStorage.run 建立（不能靠模块变量）')
})

test('反证：不得再出现模块级的单槽 uiCache（它就是跨会话串味的来源）', () => {
  assert.equal(/^\s*let uiCache:/m.test(source), false, '又出现模块级 let uiCache —— 并发会话会互相覆盖')
  assert.equal(/^\s*uiCache\s*=/m.test(source), false, '还有直接给单槽赋值的写法')
})

test('两处 dump（无障碍 / uiautomator）都要打归属标记，不能只改一处', () => {
  const marks = source.match(/session: sessionOf\(exec\)/g) ?? []
  assert.ok(marks.length >= 2, '只给一处 dump 打了归属标记；另一处写进去的清单会被当成"任何会话都可用"')
  const screenMarks = source.match(/screenId: screenIdOf\(args\)/g) ?? []
  assert.ok(screenMarks.length >= 2, '两处 dump 都要记目标屏')
})

// ── 2026-10-28 自查：归属键归一化 + 续作提示必须可执行 ──────────────────────

import { normalizeScreenId, continueRefHintOf } from '../lib/index.js'

test('real 与「未指定」折叠成同一个归属键（否则 dump 带 real、动作不带就误拒）', () => {
  assert.equal(normalizeScreenId('real'), '')
  assert.equal(normalizeScreenId('REAL'), '')
  assert.equal(normalizeScreenId(' real '), '')
  assert.equal(normalizeScreenId(undefined), '')
  assert.equal(normalizeScreenId(''), '')
  assert.equal(normalizeScreenId(123), '')
  // 反向：真正的目标屏必须原样保留 —— 折叠 real 不能顺手把 virtual-N 也折叠掉，
  // 否则「按屏绑定」这条安全判据会整体失效（两块虚拟屏会互相串用清单）。
  assert.equal(normalizeScreenId('virtual-1'), 'virtual-1')
  assert.equal(normalizeScreenId('Virtual-1'), 'virtual-1')
  assert.notEqual(normalizeScreenId('virtual-1'), normalizeScreenId('virtual-2'))
})

test('续作提示在有目标屏时必须把 screenId 写出来（否则照做必被拒）', () => {
  assert.equal(continueRefHintOf(''), 'android_ui_click/id:nN 等引用')
  const hinted = continueRefHintOf('virtual-1')
  assert.match(hinted, /screenId:"virtual-1"/, '提示里必须出现可执行的目标屏：' + hinted)
  // 反向：无屏时不要凭空加一句「要带上 screenId:""」
  assert.equal(/screenId:""/.test(continueRefHintOf('')), false)
})
