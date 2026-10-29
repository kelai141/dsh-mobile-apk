// #690 的可离线反证：键条的 self-heal 必须绑**实例自己的根**。
//
// 为什么单开一个文件：`keybar-mount.test.mjs` 里的多根用例需要 jsdom（本仓不装依赖，缺 jsdom 时
// 整个文件 skip），于是"把修法改回 `roots[roots.length - 1]`"在没有 jsdom 的机器上会静默通过。
// 这条测试只读源码文本，任何环境都跑，专门钉住这个反向改动。
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../src/keybar/mount.ts', import.meta.url), 'utf8')
const start = source.indexOf('const reconcile = (): void => {')
const end = source.indexOf('syncInset(current)', start)

test('能在 mount.ts 里定位 reconcile 段（定位失效时本测试必须红，不能静默放过）', () => {
  assert.notEqual(start, -1, 'mount.ts 里找不到 reconcile 定义')
  assert.notEqual(end, -1, 'reconcile 段里找不到 syncInset(current)')
  assert.ok(end > start)
})

test('#690 reconcile 不得再抢「全页最后一个终端根」', () => {
  const reconcile = source.slice(start, end)
  assert.equal(reconcile.includes('roots[roots.length - 1]'), false,
    'reconcile 又在取全页最后一根 —— 分栏时两条键条会叠在同一个根下')
  assert.equal(reconcile.includes('querySelectorAll'), false,
    'reconcile 不该再自己查根集合：每个实例只负责自己那个根')
})

test('#690 reconcile 绑实例自己的 host.root，且根离开文档时能收摊', () => {
  const reconcile = source.slice(start, end)
  assert.ok(reconcile.includes('host.root'), 'reconcile 必须用实例自己的 host.root')
  assert.ok(reconcile.includes('isConnected'), '根已不在文档里时必须收摊，而不是继续往别处挂')
})

test('#690 按根挂载那一轮仍然按页面上的根集合铺实例（修法不得把多实例能力一起削掉）', () => {
  const watch = source.indexOf('const reconcile = (): void => {', end)
  assert.notEqual(watch, -1, '找不到按根挂载的 reconcile')
  const segment = source.slice(watch, watch + 800)
  assert.ok(segment.includes('TERMINAL_ROOT_SELECTOR'), '按根挂载必须继续用根选择器枚举页面上的根')
  assert.ok(segment.includes('mountKeybar('), '按根挂载必须继续为每个新根建实例')
})
