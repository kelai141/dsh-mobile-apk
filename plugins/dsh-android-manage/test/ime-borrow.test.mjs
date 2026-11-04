// ADBKeyboard 借道 IME 的整段互斥（issue #1373）。
//
// 判据必须验**真实现**：原方案把一条等价的 promise 链手抄进测试，测的是抄件——
// 真实现改成不互斥，测试照样绿。这里 import 构建产物 `../lib/ime-borrow.js`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createImeBorrowLock } from '../lib/ime-borrow.js'

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

test('接线：锁必须在 try 内取得，且包住 resolveImeRestoreTarget 的两次 execShell', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const acquireAt = src.indexOf('releaseImeBorrow = await imeBorrowLock.acquire()')
  const settingsAt = src.indexOf('settings get secure default_input_method', acquireAt)
  const listAt = src.indexOf('ime list -s', acquireAt)
  const restoreAt = src.indexOf('sleep 0.4; ime set', acquireAt)
  assert.ok(acquireAt >= 0, '必须用 imeBorrowLock.acquire()')
  assert.ok(settingsAt > acquireAt, '锁必须包住 settings get（prep 阶段不能穿插）')
  assert.ok(listAt > acquireAt, '锁必须包住 ime list -s（prep 阶段不能穿插）')
  assert.ok(restoreAt > acquireAt, '还原也必须在锁内')
  const tryAt = src.lastIndexOf('try {', acquireAt)
  assert.ok(tryAt >= 0 && tryAt < acquireAt, 'acquire 必须在 try 之内（否则早退会永久泄漏锁）')
  const finallyAt = src.indexOf('releaseImeBorrow?.()', acquireAt)
  assert.ok(finallyAt > acquireAt, 'finally 必须释放锁')
})