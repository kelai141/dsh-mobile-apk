import assert from 'node:assert/strict'
import { test } from 'node:test'
// 与 registration.test.mjs 一致：测试先经 npm run build 生成 lib，再验证发布形态。
// 桥内部按 NodeNext 规则导入 './native-client.js'，因此这里不能直接加载 src/*.ts。
import { createPhoneControlBridge, nativeControlEndpoint, NATIVE_CONTROL_SOCKET } from '../lib/native-bridge.js'

const FILES = '/data/user/0/com.dsharnessmobile.shell/files'
const EPOCH = '18446744073709551615'
const GENERATION = '9007199254740993'

function harness({ mode = 'danger-full-access', client, caps = {}, execute = {}, afterFacts, afterExecute, options = {} } = {}) {
  const session = { id: 'phone-control-session' }
  const calls = []
  const fake = client ?? {
    async capabilities() {
      calls.push('capabilities')
      if (afterFacts) mode = afterFacts
      return {
        ok: true,
        response: {
          protocolVersion: 1, ok: true, executed: 'no', screenId: null,
          epoch: EPOCH, screens: [{ screenId: 'real', generation: GENERATION }],
          channels: { a11y: { enabled: 'yes', supportedOps: ['click'] } },
          ...caps,
        },
      }
    },
    async execute(request) {
      calls.push(request)
      if (afterExecute) mode = afterExecute
      return {
        ok: true, executed: 'yes',
        response: { protocolVersion: 1, ok: true, executed: 'yes', screenId: request.screenId, callId: request.callId },
        ...execute,
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => id === session.id ? session : undefined }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      if (name === 'androidPrivilege') throw new Error('legacy bridge must not be read')
      return undefined
    },
  }
  const bridge = createPhoneControlBridge(ctx, { client: fake, filesDir: FILES, ...options })
  return { bridge, session, calls, mode: () => mode }
}

test('私有端点由 DSH_FILES_DIR 拼出，拒绝相对路径和缺目录', () => {
  assert.equal(nativeControlEndpoint(FILES), FILES + '/' + NATIVE_CONTROL_SOCKET)
  assert.throws(() => nativeControlEndpoint(undefined), { code: 'files-dir-unavailable' })
  assert.throws(() => nativeControlEndpoint(''), { code: 'files-dir-unavailable' })
  assert.throws(() => nativeControlEndpoint('./files'), { code: 'files-dir-invalid' })
  assert.throws(() => nativeControlEndpoint(FILES + ' '), { code: 'files-dir-unavailable' })
})

test('建屏不猜不存在的代次，会话归属取可信对象而非模型参数', async () => {
  const h = harness({ caps: { screens: [] } })
  const reply = await h.bridge.nativeControlExecute('vdCreate', 'virtual-1',
    { width: 900, height: 1600, session: 'forged' }, h.session)
  assert.equal(reply.ok, true)
  const payload = h.calls.find(item => item && typeof item === 'object' && item.operation === 'vdCreate')
  assert.ok(payload)
  assert.equal(payload.args.session, h.session.id)
  assert.equal(payload.screenId, 'virtual-1')
  assert.equal(Object.hasOwn(payload, 'generation'), false)
})

test('缺 DSH_FILES_DIR 时失败关闭，且不尝试旧服务', async () => {
  const bridge = createPhoneControlBridge({ get: () => { throw new Error('must not read services') } })
  assert.deepEqual(await bridge.nativeControlCapabilities({ id: 'x' }), {
    ok: false, code: 'files-dir-unavailable', executed: 'no',
  })
  assert.deepEqual(await bridge.nativeControlExecute('click', 'real', {}, { id: 'x' }), {
    ok: false, code: 'files-dir-unavailable', executed: 'no', screenId: 'real',
  })
})

test('信任门要求 sessions 返回同一会话且档位为完全权限', async () => {
  const h = harness()
  const forged = { ...h.session }
  assert.equal((await h.bridge.nativeControlCapabilities(forged)).code, 'session-permission-denied')
  assert.equal((await h.bridge.nativeControlExecute('snapshot', 'real', {}, { id: 'unknown' })).code,
    'session-permission-denied')
  assert.deepEqual(h.calls, [])

  const limited = harness({ mode: 'workspace-write' })
  assert.equal((await limited.bridge.nativeControlExecute('click', 'real', {}, limited.session)).code,
    'session-permission-denied')
  assert.deepEqual(limited.calls, [])
})

test('能力原样交付，不推断通道或操作支持', async () => {
  const h = harness()
  const facts = await h.bridge.nativeControlCapabilities(h.session)
  assert.equal(facts.ok, true)
  assert.equal(facts.epoch, EPOCH)
  assert.deepEqual(facts.channels, { a11y: { enabled: 'yes', supportedOps: ['click'] } })
  assert.equal('supportedOps' in facts, false)
  assert.deepEqual(h.calls, ['capabilities'])
})

test('执行读取能力后只发一次请求，u64 保留原字符串', async () => {
  const h = harness()
  const result = await h.bridge.nativeControlExecute('setText', 'real', { text: '中文🙂' }, h.session)
  assert.equal(result.ok, true)
  assert.equal(h.calls.length, 2)
  const { callId, ...sent } = h.calls[1]
  assert.match(callId, /^[0-9a-f-]+$/)
  assert.deepEqual(sent, {
    operation: 'setText', screenId: 'real', epoch: EPOCH, generation: GENERATION, args: { text: '中文🙂' },
  })
})

test('未知操作、非法屏、非法参数与未登记屏都在发请求前拒绝', async () => {
  const h = harness()
  assert.equal((await h.bridge.nativeControlExecute('retiredControlExec', 'real', {}, h.session)).code, 'operation-unsupported')
  assert.equal((await h.bridge.nativeControlExecute('click', '', {}, h.session)).code, 'screen-id-invalid')
  assert.equal((await h.bridge.nativeControlExecute('click', 'real', null, h.session)).code, 'args-invalid')
  assert.equal((await h.bridge.nativeControlExecute('click', 'virtual-9', {}, h.session)).code, 'screen-not-ready')
  assert.deepEqual(h.calls, ['capabilities'])
})

test('能力缺 epoch、代次或使用非 u64 形态时拒绝，不猜目标', async () => {
  for (const caps of [
    { epoch: undefined },
    { epoch: 7 },
    { epoch: '7', screens: [{ screenId: 'real', generation: undefined }] },
    { epoch: '7', screens: [{ screenId: 'real', generation: 9007199254740993 }] },
    { epoch: '18446744073709551616' },
  ]) {
    const h = harness({ caps })
    assert.equal((await h.bridge.nativeControlExecute('click', 'real', {}, h.session)).code, 'screen-not-ready')
    assert.deepEqual(h.calls, ['capabilities'])
  }
})

test('读取后撤权不交付能力，执行后撤权不把副作用报成成功', async () => {
  const facts = harness({ afterFacts: 'workspace-write' })
  assert.equal((await facts.bridge.nativeControlCapabilities(facts.session)).code, 'session-permission-revoked')
  assert.deepEqual(facts.calls, ['capabilities'])

  const exec = harness({ afterExecute: 'workspace-write' })
  assert.deepEqual(await exec.bridge.nativeControlExecute('global', 'real', { action: 'back' }, exec.session), {
    ok: false, code: 'session-permission-revoked', executed: 'yes', screenId: 'real',
  })
  assert.equal(exec.calls.length, 2)
})

test('原生传输失败保留 executed 与错误码，不重试也不回落', async () => {
  const h = harness({
    execute: { ok: false, executed: 'unknown', response: undefined,
      error: { code: 'connection-lost' } },
  })
  assert.deepEqual(await h.bridge.nativeControlExecute('scroll', 'real', {}, h.session), {
    ok: false, code: 'connection-lost', executed: 'unknown', screenId: 'real',
  })
  assert.equal(h.calls.length, 2)
})

test('中止或能力错误在派发前拒绝，已派发的中止保留 unknown', async () => {
  const before = harness()
  const controller = new AbortController()
  controller.abort()
  assert.equal((await before.bridge.nativeControlExecute('click', 'real', {}, before.session, controller.signal)).code,
    'operation-aborted')
  assert.deepEqual(before.calls, ['capabilities'])

  const failed = harness({ caps: { ok: false, code: 'facts-unavailable' } })
  assert.equal((await failed.bridge.nativeControlExecute('click', 'real', {}, failed.session)).code, 'facts-unavailable')
  assert.deepEqual(failed.calls, ['capabilities'])
})

test('注入客户端与端点二选一，显式端点同样必须是私有绝对路径', async () => {
  const injected = harness()
  assert.equal((await injected.bridge.nativeControlCapabilities(injected.session)).ok, true)

  const invalid = createPhoneControlBridge(
    { get: (name) => name === 'sessions' ? { get: () => undefined } : undefined },
    { endpoint: 'http://127.0.0.1:1', filesDir: FILES },
  )
  assert.equal((await invalid.nativeControlCapabilities({ id: 'x' })).code, 'endpoint-invalid')
})
