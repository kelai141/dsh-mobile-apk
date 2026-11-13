import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AndroidPrivilegeService } from '../lib/index.js'

function setup({ mode = 'danger-full-access', afterFacts, afterExecute } = {}) {
  const session = { id: 'native-vision-session' }
  const epoch = '18446744073709551615'
  const generation = '9007199254740993'
  const calls = []
  const client = {
    async capabilities() {
      calls.push('capabilities')
      if (afterFacts) mode = afterFacts
      return { ok: true, response: { ok: true, epoch, screens: [{ screenId: 'virtual-1', generation }] } }
    },
    async execute(request) {
      calls.push(request)
      if (afterExecute) mode = afterExecute
      return { ok: true, executed: 'yes', response: { ok: true, executed: 'yes', screenId: 'virtual-1', image: {} } }
    },
  }
  const ctx = { get: (key) => key === 'sessions' ? { get: (id) => id === session.id ? session : undefined } : undefined }
  const svc = new AndroidPrivilegeService(ctx, undefined, { resolve: () => ({ mode }) }, undefined, undefined, client)
  return { svc, session, calls, epoch, generation }
}

test('原生视觉仅接受可信完全权限会话，失效时没有截图请求', async () => {
  const h = setup({ afterFacts: 'workspace-write' })
  assert.equal((await h.svc.nativeVisionExecute('screenshot', 'virtual-1', {}, { ...h.session })).code, 'session-permission-denied')
  assert.deepEqual(h.calls, [])
  assert.equal((await h.svc.nativeVisionExecute('screenshot', 'virtual-1', {}, h.session)).code, 'session-permission-denied')
  assert.deepEqual(h.calls, ['capabilities'])
})

test('原生视觉将目标与 u64 字符串原样交给宿主，回执撤权不交图', async () => {
  const h = setup({ afterExecute: 'workspace-write' })
  const args = { x1: 1, y1: 2, x2: 3, y2: 4 }
  const result = await h.svc.nativeVisionExecute('readRegion', 'virtual-1', args, h.session)
  assert.equal(h.calls.length, 2)
  const { callId, ...sent } = h.calls[1]
  assert.match(callId, /^[0-9a-f-]+$/)
  assert.deepEqual(sent, { operation: 'readRegion', screenId: 'virtual-1', epoch: h.epoch, generation: h.generation, args })
  assert.deepEqual(result, { ok: false, code: 'session-permission-revoked', executed: 'yes', screenId: 'virtual-1' })
})
