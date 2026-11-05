// ADBKeyboard 借道 IME 的整段互斥（issue #1373）+ 排队超时与回执（issue #1516）。
//
// 判据必须验**真实现**：原方案把一条等价的 promise 链手抄进测试，测的是抄件——
// 真实现改成不互斥，测试照样绿。这里 import 构建产物 `../lib/ime-borrow.js`。
//
// #1516 的两条新判据都在**行为**上：
//   ① 排队有预算：前一路永不释放时，后一路按时以 ImeBorrowTimeout 拒绝（不是静默干等）；
//   ② 超时必须让位：那条永不 resolve 的队头不得把后面每一路都锁死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createImeBorrowLock, ImeBorrowTimeout } from '../lib/ime-borrow.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('互斥：B 的第一次 execShell 必须发生在 A 释放之后', async () => {
  const lock = createImeBorrowLock()
  const events = []
  const execShell = async (label) => {
    events.push(label)
    await sleep(3)
  }
  const worker = async (name, holdMs) => {
    const release = await lock.acquire()
    try {
      await execShell(name + ':settings-get')
      await execShell(name + ':ime-list')
      await sleep(holdMs)
    } finally {
      release()
    }
  }
  await Promise.all([worker('A', 20), worker('B', 0)])
  const firstB = events.indexOf('B:settings-get')
  const lastA = Math.max(events.indexOf('A:settings-get'), events.indexOf('A:ime-list'))
  assert.ok(firstB > lastA, 'B 在 A 释放前就开始了（互斥失效）：' + events.join(' , '))
})

test('异常路径仍会放行下一路（release 在 finally）', async () => {
  const lock = createImeBorrowLock()
  const order = []
  const bad = (async () => {
    const release = await lock.acquire()
    try {
      order.push('bad:in')
      throw new Error('boom')
    } finally {
      release()
    }
  })().catch(() => {})
  const good = (async () => {
    const release = await lock.acquire()
    try {
      order.push('good:in')
    } finally {
      release()
    }
  })()
  await Promise.all([bad, good])
  assert.deepEqual(order, ['bad:in', 'good:in'])
})

test('release 幂等：重复调用不会破坏队列', async () => {
  const lock = createImeBorrowLock()
  const release = await lock.acquire()
  release()
  release()
  const next = lock.acquire()
  const release2 = await Promise.race([next, sleep(50).then(() => 'timeout')])
  assert.notEqual(release2, 'timeout', '重复 release 之后下一路拿不到锁')
  release2()
})

test('#1516 排队预算：前一路永不释放时后一路按时被拒（不静默等待）', async () => {
  const lock = createImeBorrowLock()
  await lock.acquire()   // 故意不释放：模拟前一路的 finally 迟迟不执行
  const outcome = await lock.acquire({ timeoutMs: 60 }).then(
    () => 'acquired',
    (error) => error,
  )
  assert.ok(outcome instanceof ImeBorrowTimeout,
    '超过预算必须抛 ImeBorrowTimeout（旧实现在无超时的 await 上永久等待）：' + String(outcome))
  // 判据不用「>= 预算」这种固定值：60ms 的预算在慢机器上会落在 59ms（实测红过），
  // 而真正要证的语义是「带等待量 + 带预算 + 与预算同量级（不是秒级假等待）」。
  assert.equal(typeof outcome.waitedMs, 'number', '超时对象必须带等待量（回执要用）')
  assert.ok(outcome.waitedMs >= 0, '等待量不得为负：' + outcome.waitedMs)
  assert.ok(outcome.waitedMs <= 5_000, '等待量必须与预算同量级（不得是秒级假等待）：' + outcome.waitedMs)
  assert.equal(outcome.budgetMs, 60, '回执必须带预算，否则用户看不出被拒的原因：' + outcome.budgetMs)
  assert.match(String(outcome.message), /60ms/, '文案要带预算：' + outcome.message)
})

test('#1516 超时让位：永不释放的队头不得把后面每一路都锁死', async () => {
  const lock = createImeBorrowLock()
  const stuck = await lock.acquire() // 队头：永不释放
  void stuck
  // 第一路超时后让位；第二路必须能拿到锁。
  await lock.acquire({ timeoutMs: 40 }).catch((error) => {
    assert.ok(error instanceof ImeBorrowTimeout, String(error))
  })
  const outcome = await Promise.race([
    lock.acquire({ timeoutMs: 200 }).then(() => 'acquired'),
    sleep(1500).then(() => 'deadlock'),
  ])
  assert.equal(outcome, 'acquired', '超时的那一路没让位，后面的全部卡死（#1516 的真实现场）')
})

test('#1516 回执：队列空时 waitedMs/queued 为 0，排队时如实计数', async () => {
  const lock = createImeBorrowLock()
  const holder = await lock.acquire()
  assert.equal(holder.queued, 0, '队列空时 queued 必须是 0')
  // waitedMs 是墙钟量：队列空时也允许有 1-2ms 的调度抖动，但不得是「等过前一路」的量级。
  assert.ok(holder.waitedMs < 50, '队列空时不该等到可观的时间：' + holder.waitedMs)

  // 队列是串行的：第二路要等第一路 release 后才能拿到锁，所以先等第一路、再放行它。
  const onePending = lock.acquire()
  const twoPending = lock.acquire()
  await sleep(20)
  holder()
  const one = await onePending
  assert.ok(one.waitedMs > 0, '排过队的那一路必须带等待量：' + one.waitedMs)
  assert.ok(one.queued >= 1, '排过队的那一路必须带前面几路：' + one.queued)
  one()
  const two = await twoPending
  assert.ok(two.queued >= 1, '第二路同样要报前面有几路：' + two.queued)
  two()
})
