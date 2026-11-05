// issue #1620 反证回归：browser_scroll 的 direction 必须**先校验**再拼表达式。
//
// 缺陷形态（静态审查）：dx/dy 只认四个字面量，其余一律 0 ⇒ 拼出 window.scrollBy(0,0) ⇒ 回
// ok:true + 原 scrollY。表达式由本层自己拼，壳侧不会再校验方向，所以**没有任何一层会报错**：
// 模型传 direction:"upward" 会收到成功、页面没动，然后反复重试或据此下错误结论。
//
// 判据设计（本仓纪律：禁源码文本切片）：
//   - 用真实 execute() 驱动真实工具，夹具记录**到达壳侧的 expr**；
//   - 非法方向必须既不回 ok:true、也**不得向壳侧发出任何 JS**（发出去就已经改了页面/白跑一趟）；
//   - 合法方向必须照旧发出带正确位移的表达式（防止「一刀切拒绝所有方向」也能通过）。
// 负控：把校验分支删掉 → 第一组用例立刻变红（会拿到 ok:true 且 calls 非空）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BROWSER_OPS, BROWSER_TOOLS } from '../lib/contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
const EXEC = { agent: { session: 'scroll-direction-test' } }

/** 夹具：按 op 返回桩数据，并记录每次调用（证明 execute 真跑了、以及它发出了什么）。 */
function makeFace() {
  const calls = []
  const face = {
    gateFor: () => ({ ok: true, via: 'a11y' }),
    audit: () => {},
    controlExec: async (op, args) => {
      calls.push({ op, args })
      if (op === BROWSER_OPS.js) {
        return { ok: true, data: { value: JSON.stringify({ scrollY: 1234, atEnd: false }) } }
      }
      return { ok: true, data: {} }
    },
  }
  return { face, calls }
}

function applyBrowser(face) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: (name) => (name === 'androidPrivilege' ? face : undefined),
    effect: (fn) => { try { return fn?.() } catch { return undefined } },
    on: () => {},
  })
  return { byName: (n) => tools.find((t) => t.name === n) }
}

/** 驱动 browser_scroll，返回 { value, jsCalls }（jsCalls = 真正发给壳侧的 expr 列表）。 */
async function scroll(direction, extra = {}) {
  const { face, calls } = makeFace()
  const { byName } = applyBrowser(face)
  const tool = byName(BROWSER_TOOLS.scroll)
  assert.ok(tool, 'browser_scroll 必须注册')
  const value = await tool.execute({ direction, ...extra }, EXEC)
  const jsCalls = calls.filter((c) => c.op === BROWSER_OPS.js)
  return { value, jsCalls }
}

test('非法方向：必须报 unknown-direction，且不得向壳侧发出任何 JS', async () => {
  for (const bad of ['upward', 'Down', '', 'north', 'up down']) {
    const { value, jsCalls } = await scroll(bad)
    assert.notEqual(value.ok, true, '非法方向 ' + JSON.stringify(bad) + ' 不得回 ok:true（旧实现会静默 scrollBy(0,0)）')
    assert.equal(value.error, 'unknown-direction', '非法方向必须给专用错误码，实际：' + JSON.stringify(value.error))
    assert.match(String(value.guidance ?? ''), /up, down, left, right/, '回执必须列出可用取值（否则模型只能靠猜）')
    assert.equal(jsCalls.length, 0, '非法方向不得发出 JS（发出去就已经白跑一趟/可能改动页面）')
  }
})

test('合法方向：照旧发出带正确位移的表达式（防止「一刀切拒绝」也能过）', async () => {
  const cases = [
    ['down', 600, 0, 600],
    ['up', 600, 0, -600],
    ['right', 600, 600, 0],
    ['left', 600, -600, 0],
    ['down', 250, 0, 250],
  ]
  for (const [dir, amount, dx, dy] of cases) {
    const { value, jsCalls } = await scroll(dir, { amount })
    assert.equal(value.ok, true, dir + ' 必须成功')
    assert.equal(jsCalls.length, 1, dir + ' 必须恰好发出一条 JS')
    const expr = String(jsCalls[0].args.expr)
    assert.ok(expr.includes('window.scrollBy(' + dx + ',' + dy + ')'),
      dir + ' 的位移必须是 (' + dx + ',' + dy + ')，实际表达式：' + expr)
  }
})

test('回执字段：scrollY 取页面真实值，不因方向校验而丢', async () => {
  const { value } = await scroll('down')
  assert.equal(value.scrollY, 1234)
  assert.equal(value.atEnd, false)
})
