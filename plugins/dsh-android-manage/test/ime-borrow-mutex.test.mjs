// ADBKeyboard 借道 IME 的整段互斥（issue #1373）。
//
// 缺陷形态：两次并发的 android_ui_input 各自读 prev、各自 `ime set`；先结束者在 finally 里把
// 输入法还原，另一路的广播就落到错误 IME 上（result=2/5，220ms 重试仍失败）。
//
// 判据：① 源码里借道段必须经 acquireImeBorrow 串行、并在 finally 放行；② 互斥本身是「一条
// promise 链」——这里直接对等价实现做行为断言（src 的运行时由插件构建后的单测覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

test('借道段必须取锁并在 finally 放行', () => {
  assert.ok(src.includes('export async function acquireImeBorrow()'), '必须有 acquireImeBorrow')
  assert.ok(src.includes('const releaseImeBorrow = await acquireImeBorrow()'), '借道前必须取锁')
  assert.ok(src.includes('releaseImeBorrow()'), 'finally 里必须放行')
  // 放行必须在 finally 内（异常路径也要放行，否则后续输入永久卡死）
  const tail = src.slice(src.indexOf('const releaseImeBorrow = await acquireImeBorrow()'))
  const finallyIdx = tail.indexOf('} finally {')
  const releaseIdx = tail.indexOf('releaseImeBorrow()')
  assert.ok(finallyIdx >= 0 && releaseIdx > finallyIdx, '放行必须落在 finally 里')
})

test('互斥实现等价性：串行、异常也放行', async () => {
  // 与 acquireImeBorrow 同构的最小实现（源码里是 TS，这里验算法）
  let tail = Promise.resolve()
  const acquire = async () => {
    const previous = tail
    let release
    tail = new Promise((resolve) => { release = resolve })
    await previous
    let released = false
    return () => { if (released) return; released = true; release() }
  }
  const order = []
  const run = async (id, fail = false) => {
    const release = await acquire()
    try {
      order.push('start' + id)
      await new Promise((r) => setTimeout(r, 10))
      if (fail) throw new Error('boom')
      order.push('end' + id)
    } finally { release() }
  }
  // 失败那一路必须被吞掉再断言，否则 Promise.all 会先 reject、run(3) 还没跑完
  await Promise.all([run(1), run(2, true).catch(() => undefined), run(3)])
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'start3', 'end3'])
})
