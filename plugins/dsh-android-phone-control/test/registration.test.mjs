import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerPhoneControlTools } from '../lib/index.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

function harness(nativeControlExecute) {
  const registrations = []
  const conditions = new Map()
  const calls = []
  const session = { id: 'test-session' }
  const signal = new AbortController().signal
  const ctx = {
    androidPrivilege: {
      async nativeControlCapabilities(...args) {
        calls.push(['capabilities', ...args])
        return { ok: true, code: 'capabilities', scope: 'virtual-only',
          screens: [{ screenId: 'virtual-1', width: 600 }], diagnostic: 'private' }
      },
      async nativeControlExecute(...args) {
        calls.push(args)
        return nativeControlExecute(...args)
      },
      execAdbShell() { assert.fail('legacy shell executed') },
      controlExec() { assert.fail('legacy control queue executed') },
    },
    tools: { register(tool, options) { registrations.push(tool); conditions.set(tool.name, options?.when) } },
  }
  registerPhoneControlTools(ctx, ctx.androidPrivilege)
  const exec = { agent: { session }, signal }
  const execute = async (name, args) => {
    const tool = registrations.find(tool => tool.name === name)
    const result = await tool.execute(args, exec)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value') ?? [], [])
    assert.ok((validateJsonSchemaValue(tool.output.schema, {...result, undeclaredLegacyRoute: 'adb'}, 'value') ?? []).length > 0)
    return result
  }
  return { registrations, conditions, calls, session, signal, execute, bridge: ctx.androidPrivilege }
}

test('DSH 注册一套手机工具，输入只转发一次原生 setText 并回传失败事实', async () => {
  const h = harness(async (_op, screenId) => ({
    ok: false, code: 'stale-snapshot', executed: 'no', screenId, diagnostic: 'not for the model',
  }))
  const names = h.registrations.map(tool => tool.name)
  assert.equal(names.length, new Set(names).size)
  assert.deepEqual(names.filter(name => name.includes('input')), ['android_ui_input'])
  assert.ok(!names.includes('android_act_input'))
  const environment = h.registrations.find(tool => tool.name === 'android_env_prepare')
  assert.ok(environment)
  assert.deepEqual(Object.keys(environment.parameters.properties), ['restore'])
  assert.equal(typeof h.conditions.get('android_env_prepare'), 'function')
  const input = { ref: 'native-ref', text: '中文和表情🙂', clear: false }
  const result = await h.execute('android_ui_input', { screenId: 'virtual-1', ...input })
  assert.deepEqual(h.calls, [['setText', 'virtual-1', input, h.session, h.signal]])
  assert.deepEqual(result, { ok: false, code: 'stale-snapshot', executed: 'no', screenId: 'virtual-1' })
})

test('屏幕与节点观察使用宿主回执，不推断权限或改写节点引用', async () => {
  const tree = { nodes: [{ ref: 'native-ref', editable: true }] }
  const h = harness(async (_op, screenId) => ({ ok: true, code: 'snapshot', executed: 'yes', screenId, tree }))
  assert.deepEqual(await h.execute('android_screen_list', {}), {
    ok: true, code: 'capabilities', scope: 'virtual-only', screens: [{ screenId: 'virtual-1', width: 600 }],
  })
  assert.deepEqual(await h.execute('android_ui_dump', { screenId: 'virtual-1' }), {
    ok: true, code: 'snapshot', executed: 'yes', screenId: 'virtual-1', tree,
  })
  assert.deepEqual(h.calls, [
    ['capabilities', h.session, h.signal], ['snapshot', 'virtual-1', {}, h.session, h.signal],
  ])
})

test('缺少原生桥时不会注册任何工具', () => {
  assert.throws(() => registerPhoneControlTools({ tools: { register() { assert.fail('tool registered without native bridge') } } }, undefined), /native shell bridge/)
})

test('自有页面引用复用唯一输入工具，失败命令仍保留已执行的 stderr', async () => {
  const h = harness(async () => ({ok: false, code: 'shell-completed', executed: 'yes',
    data: {stdout: '', stderr: 'missing file', exitCode: 1}}))
  const result = await h.execute('android_ui_input', {screenId: 'app', ref: 'wabc123_7', text: '中文', clear: true})
  assert.deepEqual(h.calls, [['webAction', '', {action: 'setText', ref: 'wabc123_7', text: '中文', clear: true}, h.session, h.signal]])
  assert.equal(result.data.stderr, 'missing file')
  assert.equal(result.executed, 'yes')
})

test('按键复用唯一输入工具，反向滑动原样交给原生目标', async () => {
  const h = harness(async (_op, screenId) => ({ok: true, code: 'accepted', executed: 'yes', screenId}))
  await h.execute('android_ui_input', {screenId: 'virtual-1', key: 'enter'})
  await h.execute('android_ui_swipe', {screenId: 'real', x1: 900, y1: 600, x2: 100, y2: 90, durationMs: 500})
  assert.deepEqual(h.calls, [
    ['keyEvent', 'virtual-1', {key: 'enter'}, h.session, h.signal],
    ['swipe', 'real', {x1: 900, y1: 600, x2: 100, y2: 90, durationMs: 500}, h.session, h.signal],
  ])
  assert.deepEqual(h.registrations.filter(tool => tool.name.includes('input')).map(tool => tool.name), ['android_ui_input'])
})

test('Root、Shizuku 与应用 shell 各自依赖原生公布的能力', async () => {
  const h = harness(async () => ({ok: true, code: 'shell-completed', executed: 'yes'}))
  let operations = ['shExec']
  h.bridge.nativeControlCapabilities = async () => ({ok: true, operations})
  const available = async () => {
    const step = {agent: {session: h.session}, signal: h.signal}
    return Promise.all(['android_shell_exec', 'android_root_exec', 'android_termux_channel_exec']
      .map(name => h.conditions.get(name)(step)))
  }
  assert.deepEqual(await available(), [true, false, false])
  operations = ['rootExec', 'termuxExec']
  assert.deepEqual(await available(), [false, true, true])
  await h.execute('android_root_exec', {command: 'id'})
  assert.deepEqual(h.calls[0], ['rootExec', '', {command: 'id'}, h.session, h.signal])
  assert.deepEqual(h.registrations.filter(tool => tool.name.includes('input')).map(tool => tool.name), ['android_ui_input'])
})

test('专属工具按每轮原生能力动态进入模型列表，撤权后下一轮消失', async () => {
  const h = harness(async () => assert.fail('visibility must not execute'))
  let operations = ['vdCreate', 'vdDestroy', 'vdInfo', 'vdLaunchApp']
  let queries = 0
  h.bridge.nativeControlCapabilities = async () => {
    queries++
    return { ok: true, operations }
  }
  const visible = async () => {
    const step = { agent: { session: h.session }, signal: h.signal }
    const result = []
    for (const tool of h.registrations) {
      const condition = h.conditions.get(tool.name)
      if (!condition || await condition(step)) result.push(tool.name)
    }
    return result
  }
  assert.ok((await visible()).includes('android_vdisplay_create'))
  assert.equal(queries, 1)
  operations = []
  const after = await visible()
  assert.equal(queries, 2)
  assert.ok(!after.includes('android_vdisplay_create') && !after.includes('android_app_launch'))
  assert.deepEqual(after.filter(name => name.includes('input')), ['android_ui_input'])
  assert.deepEqual(h.calls, [])
})
