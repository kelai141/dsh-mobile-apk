/**
 * C4 退役契约测试：上游 0.2.2-rc.1 是否已自行把「flush 每次重扫 Loader」改成「一次建表」。
 *
 * C4 原本修的是性能缺陷：client-modules 的 flush 里对 dirty 里每个 entryName 都调一次
 * processOne，而 processOne 内部又走一遍 this.ctx.loader.entries() ⇒ N 个变更 = N 次全表扫描。
 * C4 的做法是引入 batchEntries() 表（同一批只扫一次）。
 *
 * 0.2.2-rc.1 的上游实现自己就是「一次建表」：
 *   flush(onError) {
 *     if (this.dirty.size === 0) return;
 *     const entriesByName = new Map();
 *     for (const entry of this.ctx.loader.entries()) { ... entriesByName.set(name, [entry]) }
 *     ...
 *     if (this.processOne(entryName, entriesByName.get(entryName) ?? [], onError)) changed = true;
 * 即 processOne 直接收 entries，不再自己扫表。
 *
 * 退役契约：若上游回退成「processOne 自己扫 loader.entries()」，这份测试立刻红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { versionedFixture } from './lib/fixture.mjs'

const source = readFileSync(versionedFixture('dsh-client-modules', 'lib', 'index.js'), 'utf8')

test('flush 在循环外只建一次 entriesByName 表（C4 的目标态）', () => {
  assert.equal(source.split('const entriesByName = /* @__PURE__ */ new Map();').length - 1, 1,
    '上游 flush 不再一次性建表——C4 的批扫描前提消失，需重新评估扫描次数')
})

test('processOne 直接接收 entries，不再自己遍历 loader', () => {
  assert.equal(source.split('processOne(entryName, entries, onError) {').length - 1, 1,
    'processOne 签名变了（不再收 entries）——上游可能回退成逐项扫表')
})

test('flush 的 dispatch 走表查找而不是重新扫 loader', () => {
  const dispatch = 'if (this.processOne(entryName, entriesByName.get(entryName) ?? [], onError)) changed = true;'
  assert.equal(source.split(dispatch).length - 1, 1,
    'flush dispatch 不再是表查找——C4 的「一批一次」性质失去保证')
})

test('全文件只有一处 loader.entries() 位于 flush 内（无按项重扫）', () => {
  const occurrences = source.split('this.ctx.loader.entries()').length - 1
  assert.equal(occurrences, 1,
    'flush 之外还在扫 loader：若新增的是按 entryName 的重复扫描，C4 缺陷复活')
})
