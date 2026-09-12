// 协议版本协商（0.13.8 P2-15）：把「新壳 + 老引擎」变成一次带指引的失败
import assert from 'node:assert/strict'
import test from 'node:test'

import { negotiateProtocol, ENGINE_PROTOCOL_VERSION } from '../lib/control-queue.js'

test('老壳（未声明 pv）走 V1 兼容路径', () => {
  const n = negotiateProtocol(undefined)
  assert.equal(n.ok, true)
  assert.equal(n.shell, 1)
  assert.equal(n.engine, ENGINE_PROTOCOL_VERSION)
  assert.match(n.reason, /V1 兼容/)
  assert.equal(negotiateProtocol(null).ok, true, 'null 同样视为未声明')
})

test('同版本通过', () => {
  const same = negotiateProtocol(ENGINE_PROTOCOL_VERSION)
  assert.equal(same.ok, true)
  assert.equal(same.shell, ENGINE_PROTOCOL_VERSION)
  assert.match(same.reason, /一致/)
})

test('壳比引擎新：明确失败并给升级指引（不静默产出空树）', () => {
  const newer = negotiateProtocol(ENGINE_PROTOCOL_VERSION + 1)
  assert.equal(newer.ok, false)
  assert.match(newer.reason, /比引擎支持的|更新引擎快照/)
})

test('非法版本号失败关闭', () => {
  assert.equal(negotiateProtocol('abc').ok, false)
  assert.equal(negotiateProtocol(0).ok, false)
  assert.equal(negotiateProtocol(-1).ok, false)
  assert.equal(negotiateProtocol({}).ok, false, '对象不是版本号')
})
