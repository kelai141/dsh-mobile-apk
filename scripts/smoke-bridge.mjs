#!/usr/bin/env node
/**
 * smoke-bridge.mjs — 新控制链的宿主端冒烟（桌面，无需设备）。
 *
 * 覆盖对象已随 native 控制切流改写（2026-11）：
 *   - **bridge**（dsh-android-bridge）：只剩共享浏览器面 + 会话通知。它提供 `androidPrivilege`
 *     与 `nativeSharedBridge` 两个同名服务，但 controlExec **只**接受浏览器 op；手机操作一律拒绝。
 *   - **phone-control**（dsh-android-phone-control）：手机工具的唯一注册者，薄桥只做
 *     「可信会话 + 完全权限 + 读原生 capabilities + 发一次 execute」，可用性由原生能力事实决定。
 *
 * 旧版冒烟导入 plugins/dsh-android-manage 并断言 privilege 端点/通道档位——那个插件已从
 * 装配集退役、目录也已不在，脚本本身成了失效引用。现在改为对**当前**装配面真跑 apply()：
 * 任何一侧把手机操作塞回 bridge、或用旧执行器顶替原生 execute，下面的断言都会判红。
 *
 * 运行：node scripts/smoke-bridge.mjs
 *   需要先构建：cd plugins/dsh-android-bridge && npm run build
 *               cd plugins/dsh-android-phone-control && npm run build
 * 退出码：0 全绿 / 1 判红 / 2 依赖缺失（不得当通过）。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const work = join(root, '.deploy-tmp', 'smoke-bridge')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
process.env.DSH_HOME = work

const failures = []
const assert = (cond, msg) => {
  if (!cond) { failures.push(msg); console.error('FAIL:', msg) } else console.log('ok:', msg)
}

let bridgeMod
let phoneMod
let phoneBridgeMod
try {
  bridgeMod = await import(pathToFileURL(join(root, 'plugins', 'dsh-android-bridge', 'lib', 'index.js')).href)
  phoneMod = await import(pathToFileURL(join(root, 'plugins', 'dsh-android-phone-control', 'lib', 'index.js')).href)
  // 薄桥工厂不在插件入口的导出面上（入口只给 apply/registerPhoneControlTools）；
  // 冒烟按模块路径取同一个已编译实现，避免为了测试扩大生产导出面。
  phoneBridgeMod = await import(pathToFileURL(join(root, 'plugins', 'dsh-android-phone-control', 'lib', 'native-bridge.js')).href)
} catch (error) {
  console.error('SMOKE-BRIDGE INCONCLUSIVE：插件产物或其依赖不可用。')
  console.error('  ' + String(error?.message ?? error).split('\n')[0])
  console.error('  先构建：cd plugins/dsh-android-bridge && npm install && npm run build')
  console.error('          cd plugins/dsh-android-phone-control && npm install && npm run build')
  process.exit(2)
}

// ── 假原生客户端：只实现 NativeClient 四个方法，记录每次调用 ────────────────────
const calls = []
function fakeClient(options = {}) {
  const facts = {
    protocolVersion: 1,
    ok: true,
    executed: 'no',
    screenId: null,
    epoch: '7',
    scope: 'virtual-only',
    screens: [{ screenId: 'virtual-1', displayId: 3, generation: '42', width: 600, height: 1000 }],
    channels: { a11y: { enabled: 'no', online: 'no' }, shizuku: { functionalReady: 'yes', granted: 'yes' } },
    operations: ['snapshot', 'click', 'setText', 'shExec', 'vdInfo'],
    ...options.facts,
  }
  return {
    async capabilities() {
      calls.push(['capabilities'])
      if (options.capabilitiesFails === true) return { ok: false, error: { code: 'connect-failed', message: 'down' } }
      return { ok: true, response: facts }
    },
    async execute(request) {
      calls.push(['execute', request])
      return { ok: true, executed: 'yes', response: { ...facts, ok: true, executed: 'yes', screenId: request.screenId ?? null, data: { echoed: request.operation } } }
    },
    async cancel(callId) {
      calls.push(['cancel', callId])
      return { ok: true, executed: 'no', response: facts }
    },
    async status(callId) {
      calls.push(['status', callId])
      return { ok: true, executed: 'no', response: facts }
    },
  }
}

const session = { id: 'sess-danger' }
const readOnlySession = { id: 'sess-ro' }
const sessions = {
  get(id) {
    if (id === session.id) return session
    if (id === readOnlySession.id) return readOnlySession
    return undefined
  },
}
const sandboxPolicy = {
  resolve({ session: target } = {}) {
    if (target === readOnlySession) return { mode: 'read-only' }
    return { mode: 'danger-full-access' }
  },
}

// ── P1 bridge：apply() 只提供共享服务，不再注册任何工具 ──────────────────────────
{
  const provided = new Map()
  const effects = []
  const events = new Map()
  const ctx = {
    provide(name, service) { provided.set(name, service) },
    effect(callback) { effects.push(callback); return () => {} },
    on(name, handler) { events.set(name, handler); return () => events.delete(name) },
    get() { return undefined },
    logger: () => ({ debug: () => {}, warn: () => {} }),
  }
  bridgeMod.apply(ctx, {})
  assert(provided.has('androidPrivilege'), 'P1 bridge 仍提供 androidPrivilege（浏览器/来件路由的消费面）')
  assert(provided.has('nativeSharedBridge'), 'P1 bridge 提供 nativeSharedBridge')
  assert(provided.get('androidPrivilege') === provided.get('nativeSharedBridge'), 'P1 两个名字指向同一共享桥实例')
  assert(effects.length > 0, 'P1 bridge 注册了通知清理 effect')
  assert(typeof bridgeMod.apply === 'function' && bridgeMod.name === 'dsh-android-bridge', 'P1 bridge 入口名未变')
  assert(!/DEVICE_TOOL_GROUPS/.test(String(bridgeMod.DEVICE_TOOL_GROUPS)), 'P1 bridge 不再导出 capability gate 掩蔽组')
}

// ── P2 bridge.controlExec：只接共享浏览器 op，其它一律拒绝 ────────────────────────
{
  const bridge = bridgeMod.createNativeSharedBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {}, warn: () => {} }) },
    { client: fakeClient(), sessions, sandboxPolicy },
  )
  calls.length = 0
  for (const op of ['snapshot', 'setText', 'shExec', 'rootExec', 'vdInfo']) {
    const result = await bridge.controlExec(op, {}, undefined, { session })
    assert(result.ok === false && result.code === 'operation-not-browser',
      'P2 bridge 拒绝非浏览器 op（' + op + '）——手机操作只走 phone-control')
  }
  assert(calls.length === 0, 'P2 被拒绝的手机 op 不得触达原生客户端')

  const denied = await bridge.controlExec('browserState', {}, undefined, { session: readOnlySession })
  assert(denied.ok === false && denied.code === 'session-permission-denied', 'P2 只读会话被拒（浏览器面要求完全权限）')

  const allowed = await bridge.controlExec('browserState', { session: 'forged', generation: '1', epoch: '9' }, undefined,
    { session })
  assert(allowed.ok === true, 'P2 可信会话的浏览器 op 放行')
  const request = calls.find((c) => c[0] === 'execute')?.[1]
  assert(request?.operation === 'browserState', 'P2 转发的是浏览器 op')
  assert(request?.epoch === '7', 'P2 epoch 来自原生 capabilities，不采信调用方')
  assert(request?.args?.session === 'sess-danger', 'P2 会话身份被替换为可信会话 id')
  assert(request?.args?.generation === undefined && request?.args?.epoch === undefined,
    'P2 浏览器链路不得携带 generation/epoch')
}

// ── P3 phone-control：唯一手机工具面；条件注册由原生能力事实决定 ──────────────────
{
  const client = fakeClient()
  const bridge = phoneBridgeMod.createPhoneControlBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {} }) },
    { client, sessions, sandboxPolicy },
  )
  const registrations = []
  const conditions = new Map()
  const tools = { register(tool, options) { registrations.push(tool); conditions.set(tool.name, options?.when) } }
  phoneMod.registerPhoneControlTools({ tools, get() { return undefined } }, bridge)

  const names = registrations.map((t) => t.name)
  assert(names.length === new Set(names).size, 'P3 工具名唯一')
  // 产物新鲜度前置：apk 树的 lib 由构建链产出，主构建换清单时这里可能是上一代。
  // 缺 swipe/device_info 这类「本轮新增」的工具时，先判成**产物过期**（exit 2，不当通过也不判红），
  // 让调用方去重建；这样判据不会把「源码已改、产物没重建」误报成「功能被删」。
  const FRESH_PROBE = ['android_ui_swipe', 'android_device_info']
  const missingProbe = FRESH_PROBE.filter((n) => !names.includes(n))
  if (missingProbe.length > 0) {
    console.error('SMOKE-BRIDGE INCONCLUSIVE：phone-control 产物过期（缺 ' + missingProbe.join('、') + '）')
    console.error('  这是构建产物落后于源码，不是判据失败。先重建：cd plugins/dsh-android-phone-control && npm run build')
    process.exit(2)
  }
  // 清单以**构建产物**为准：预算基线里的 phoneTools 就是从真实 lib 跑出来的逐名记录。
  // 这里再核一次，等于把「预算基线写的那一套」与「smoke 实跑的这一套」钉在一起——
  // 任一侧单边漂移（例如只改了 lib 没重出基线）都会当场判红，而不是等模型面悄悄变。
  const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'tool-surface-budget.json'), 'utf8'))
  const baselinePhone = Array.isArray(baseline.phoneTools) ? baseline.phoneTools : []
  const nowPhone = [...names].sort()
  const drifted = nowPhone.filter((n) => !baselinePhone.includes(n))
    .concat(baselinePhone.filter((n) => !nowPhone.includes(n)))
  assert(drifted.length === 0,
    'P3 实跑工具清单必须与预算基线一致（漂移：' + drifted.join('、') + '；先跑 --update 并评审）')
  for (const expected of ['android_ui_input', 'android_ui_swipe', 'android_screenshot',
    'android_device_info', 'android_privilege_status', 'android_env_prepare']) {
    assert(names.includes(expected), 'P3 新手机工具面在场（' + expected + '）')
  }
  // 旧执行器的工具名不得回魂。android_env_prepare 是**新**工具（只切系统动画、不碰 IME），
  // 与旧 manage 那个靠 ADBKeyboard 的 env_prepare 不是同一条链路——它由原生 prepareEnvironment
  // 条件注册，P4 会验证它不产生任何输入执行。
  for (const legacy of ['android_act_input', 'android_ui_tree', 'android_click', 'android_ime_switch']) {
    assert(!names.includes(legacy), 'P3 旧执行器工具名不得复活（' + legacy + '）')
  }
  // 按键不是独立工具：android_ui_input 带 key 参数，走原生 keyEvent，不再切输入法。
  const inputTool = registrations.find((t) => t.name === 'android_ui_input')
  // defineTool 的 parameters 是 JSON Schema 形态：字段在 parameters.properties 下。
  const inputKeys = Object.keys(inputTool?.parameters?.properties ?? {})
  assert(inputKeys.includes('key'),
    'P3 Input.key 由 android_ui_input 承载（参数里必须有 key，而不是另开一个 IME 工具）')
  const keyEnum = inputTool?.parameters?.properties?.key?.enum
  assert(Array.isArray(keyEnum) && keyEnum.includes('enter') && keyEnum.includes('back'),
    'P3 key 必须是受控枚举（已声明 enter/back 等），不接受任意键码字符串')
  assert(!/ime|input_method|adbkeyboard/i.test(JSON.stringify(registrations.map((t) => [t.name, t.description]))),
    'P3 手机工具面不得再出现 IME / AdbKeyboard 字样')
  const conditional = [...conditions.entries()].filter(([, when]) => when !== undefined).map(([name]) => name).sort()
  assert(conditional.length > 0, 'P3 特权/虚拟屏工具是条件注册')
  assert(!conditions.get('android_ui_input'), 'P3 文本输入是常驻工具（原生链路不靠解锁）')

  const activation = { agent: { session }, signal: new AbortController().signal }
  assert(await conditions.get('android_shell_exec')(activation) === true,
    'P3 原生声明支持 shExec ⇒ android_shell_exec 这一步可用')
  const readOnlyActivation = { agent: { session: readOnlySession }, signal: new AbortController().signal }
  assert(await conditions.get('android_shell_exec')(readOnlyActivation) === false,
    'P3 只读会话 ⇒ 条件注册不可用（权限仍由原生与会话档位共同判定）')
}

// ── P4 P4 phone-control：setText 只发一次原生 execute，不回落任何旧执行器 ──────────
{
  const client = fakeClient()
  const bridge = phoneBridgeMod.createPhoneControlBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {} }) },
    { client, sessions, sandboxPolicy },
  )
  const registrations = []
  phoneMod.registerPhoneControlTools({ tools: { register(tool) { registrations.push(tool) } }, get() {} }, bridge)
  const input = registrations.find((t) => t.name === 'android_ui_input')
  calls.length = 0
  const reply = await input.execute({ screenId: 'virtual-1', ref: 'n7', text: '中文🙂' },
    { agent: { session }, signal: new AbortController().signal })
  const executed = calls.filter((c) => c[0] === 'execute')
  assert(executed.length === 1, 'P4 setText 只派发一次原生 execute（实际 ' + executed.length + '）')
  assert(executed[0][1].operation === 'setText', 'P4 派发的是原生 setText op')
  assert(executed[0][1].screenId === 'virtual-1' && executed[0][1].generation === '42',
    'P4 目标屏与代次取自原生 capabilities')
  assert(executed[0][1].args.text === '中文🙂', 'P4 文本原样转发（不转义、不拆分）')
  assert(reply.ok === true && reply.executed === 'yes', 'P4 回执带 executed=yes')
  assert(!('diagnostic' in JSON.parse(JSON.stringify(reply))), 'P4 原生诊断字段不外泄给模型')
}

// ── P4b Input.key 与 swipe：各自只派发一次原生 execute，仍然不碰输入法 ────────────
{
  const client = fakeClient({ facts: { operations: ['setText', 'keyEvent', 'swipe'] } })
  const bridge = phoneBridgeMod.createPhoneControlBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {} }) },
    { client, sessions, sandboxPolicy },
  )
  const registrations = []
  phoneMod.registerPhoneControlTools({ tools: { register(tool) { registrations.push(tool) } }, get() {} }, bridge)
  const exec = { agent: { session }, signal: new AbortController().signal }

  calls.length = 0
  const keyReply = await registrations.find((t) => t.name === 'android_ui_input')
    .execute({ screenId: 'virtual-1', key: 'enter', text: '' }, exec)
  let executed = calls.filter((c) => c[0] === 'execute')
  assert(executed.length === 1 && executed[0][1].operation === 'keyEvent',
    'P4b Input.key 派发原生 keyEvent（不切输入法、不回落 ADB 广播）')
  assert(keyReply.ok === true, 'P4b keyEvent 回执 ok')

  calls.length = 0
  await registrations.find((t) => t.name === 'android_ui_swipe')
    .execute({ screenId: 'virtual-1', x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 }, exec)
  executed = calls.filter((c) => c[0] === 'execute')
  assert(executed.length === 1 && executed[0][1].operation === 'swipe', 'P4b swipe 只派发一次原生 execute')
  assert(executed[0][1].args.x2 === 30 && executed[0][1].args.durationMs === 250,
    'P4b swipe 坐标与时长原样转发')

  // 只切系统动画：env_prepare 的任何参数组合都不得派发出输入类 operation。
  calls.length = 0
  await registrations.find((t) => t.name === 'android_env_prepare').execute({}, exec)
  executed = calls.filter((c) => c[0] === 'execute')
  assert(executed.every((c) => c[1].operation === 'prepareEnvironment'),
    'P4b env_prepare 只发 prepareEnvironment（动画开关），不产生任何输入执行')
}

// ── P5 失败面：原生不可达 / 会话档位不足必须如实拒绝，不得静默回落到旧通道 ────────
{
  const down = phoneBridgeMod.createPhoneControlBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {} }) },
    { client: fakeClient({ capabilitiesFails: true }), sessions, sandboxPolicy },
  )
  const facts = await down.nativeControlCapabilities(session)
  assert(facts.ok === false && facts.code === 'connect-failed', 'P5 原生不可达时如实回传失败码')

  const bridge = phoneBridgeMod.createPhoneControlBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {} }) },
    { client: fakeClient(), sessions, sandboxPolicy },
  )
  const denied = await bridge.nativeControlExecute('setText', 'virtual-1', { text: 'x' }, readOnlySession)
  assert(denied.ok === false && denied.code === 'session-permission-denied', 'P5 只读会话发不出手机操作')

  const noClient = phoneBridgeMod.createPhoneControlBridge(
    { get() { return undefined }, logger: () => ({ debug: () => {} }) },
    { sessions, sandboxPolicy, filesDir: '' },
  )
  const missing = await noClient.nativeControlCapabilities(session)
  assert(missing.ok === false && missing.code === 'files-dir-unavailable', 'P5 缺原生端点时 fail-closed')
}

rmSync(work, { recursive: true, force: true })
if (failures.length > 0) {
  console.error('=== SMOKE FAIL（' + failures.length + ' 项）===')
  process.exit(1)
}
console.log('=== SMOKE PASS ===')
