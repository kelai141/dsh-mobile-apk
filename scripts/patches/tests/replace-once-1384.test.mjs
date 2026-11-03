// replace-once-1384.test.mjs — issue #1384 回归：补丁锚点必须「恰好一处」。
//
// 缺陷形态：`String.prototype.replace(字符串, …)` 只换第一处且不校验出现次数。上游 bundle 里同一
// 锚点出现两份时（chunk 合并、同函数两份拷贝），补丁只改一份，而 marker 已插入 → `check()` 恒真
// → 之后每轮 `[skip] 已应用`，第二处的旧行为永远暴露不出来。
//
// 两条判据：
//   ① 判据本身（纯函数）：0 次、1 次、2 次的行为；
//   ② 接线：apply-patches.mjs 里**不得再留下**「字符串字面量锚点的裸 replace」——漏一处就等于
//      留了一条静默半补丁的路（正则锚点不在此列：`replace(/re/, …)` 的语义是模式匹配，不是锚点）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replaceOnce } from '../lib/replace-once.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

test('出现一次：正常替换', () => {
  assert.equal(replaceOnce('aXb', 'X', 'Y'), 'aYb')
})

test('出现零次：抛（锚点已变，不得静默空转）', () => {
  assert.throws(() => replaceOnce('abc', 'X', 'Y'), /found 0/)
})

test('出现两次：抛（否则就是静默半补丁）', () => {
  assert.throws(() => replaceOnce('aXbXc', 'X', 'Y'), /found 2/)
})

test('空锚点：抛（空串会被 split 拆成每字符一处）', () => {
  assert.throws(() => replaceOnce('abc', '', 'Y'), /non-empty/)
})

test('非字符串锚点：抛（正则不是锚点，走它自己的 replace）', () => {
  assert.throws(() => replaceOnce('abc', /b/, 'Y'), /non-empty/)
})

test('错误信息带标签，便于定位是哪条补丁', () => {
  assert.throws(() => replaceOnce('aXbXc', 'X', 'Y', 'market-K anchor'), /market-K anchor/)
})

test('apply-patches.mjs 里不得留下字符串字面量锚点的裸 replace', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), 'utf8')
  const offenders = []
  const re = /\.replace\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/g
  let m
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length
    offenders.push(`line ${line}: ${m[1].slice(0, 40)}`)
  }
  assert.deepEqual(offenders, [], '这些位置仍在用裸 replace 施加字符串锚点（issue #1384）')
})
