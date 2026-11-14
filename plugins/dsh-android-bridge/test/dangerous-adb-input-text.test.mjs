// issue #1596：ADB 通道危险命令黑名单把 `input text` 里的普通文本判成危险命令。
//
// 缺陷形态（修前正则 `/\binput\s+(keyevent|text)\s+.*(power|home|menu)/`）：
//   android_ui_input {action:"text", text:"go home"} → 命令 `input text go%shome` → 命中 →
//   回执「命令被特权 shell 通道危险检查拦截（系统配置/权限写面一律拒绝）」。
// 于是**普通文本输入不可用**，而失败文案把原因归到权限面，排障方向完全错。
//
// 同一条正则的另一半问题是它**拦不住真正想拦的东西**：`input keyevent 3`（HOME）、`26`（POWER）、
// `82`（MENU）是纯数字键码，词面 power|home|menu 根本不命中。
//
// 判据取向：黑名单只认 `keyevent` 子命令的载荷（词形与数字键码两种拼写），`text` 的载荷是
// 用户要输入的文字，那里出现的任何词都不构成命令身份。
//
// 行为测试而非 grep：真的走服务面 execAdbShell / controlExec('shExec')，断言队列里有没有投递。
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AndroidPrivilegeService } from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

const SAVED = { prefs: process.env.DSH_ADB_PREFS_PATH, scopeTest: process.env.DSH_SCREEN_SCOPE_TEST, scope: process.env.DSH_SCREEN_SCOPE }
after(() => {
  for (const [key, value] of Object.entries({
    DSH_ADB_PREFS_PATH: SAVED.prefs, DSH_SCREEN_SCOPE_TEST: SAVED.scopeTest, DSH_SCREEN_SCOPE: SAVED.scope,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 壳侧 prefs 写成「无障碍在线」+ 范围 all（本文件的判据是危险命令，不是屏幕范围）。 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-1596-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, '<map>\n<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n</map>\n')
  process.env.DSH_ADB_PREFS_PATH = file
  process.env.DSH_SCREEN_SCOPE_TEST = '1'
  process.env.DSH_SCREEN_SCOPE = 'all'
}

const TEST_SESSION = { id: 'test-1596' }

function service(queue) {
  const sessions = new Map([[TEST_SESSION.id, TEST_SESSION]])
  const ctx = { get(name) { return name === 'sessions' ? { get: id => sessions.get(id) } : undefined } }
  return new AndroidPrivilegeService(ctx, () => 'danger-full-access', { resolve: () => ({ mode: 'danger-full-access' }) }, undefined, queue)
}

/** 轮询取活（被拦的命令不得投递任何请求）。 */
async function takeNext(queue, ms = 120) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const req = queue.take()
    if (req !== null) return req
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return null
}

/**
 * 跑一条命令并回报「有没有被危险命令黑名单拦下」。
 *
 * 关键点：**被放行的命令会真的入队并等壳侧回填**（25s 超时）——测试夹具没有壳侧，
 * 所以先起 promise、再用 takeNext 把请求取出来 settle，最后才 await。直接 await 会挂 25 秒/条。
 */
async function deniedByDangerList(command) {
  setup()
  const queue = new ControlQueue()
  const svc = service(queue)
  const pending = svc.execAdbShell(command, { session: TEST_SESSION })
  const delivered = await takeNext(queue)
  if (delivered !== null) queue.settle(delivered.reqId, { ok: true, data: { ok: true, stdout: '' } })
  const r = await pending
  return { ok: r.ok, guidance: String(r.guidance ?? ''), delivered: delivered !== null }
}

test('判据 1：input text 里的 home/power/menu 只是普通文本，必须放行（#1596 的原样复现）', async () => {
  for (const command of [
    'input text go%shome',
    'input text menu',
    'input text POWER',
    'input text home sweet home',
    // manage 的 text 分支把空格换成 %s，构造出的就是这一类；这里连未替换形态一起钉住。
    'input text go home',
    'input text home; input keyevent 4',
  ]) {
    const r = await deniedByDangerList(command)
    assert.doesNotMatch(r.guidance, /危险检查拦截/, command + ' 被判成危险命令（这正是 #1596 的误拦）：' + r.guidance)
  }
})

test('判据 2：input keyevent 的词形与数字键码都必须拦（旧正则既误拦又漏拦）', async () => {
  for (const command of [
    'input keyevent HOME',
    'input keyevent POWER',
    'input keyevent MENU',
    'input keyevent KEYCODE_HOME',
    // 数字键码是旧正则完全看不见的形态（issue 明确指出「它想拦的目标其实拦不住」）。
    'input keyevent 3',
    'input keyevent 26',
    'input keyevent 82',
    // 带选项的正常拼写同样要拦（否则换个写法即可逃逸）。
    'input -d 7 keyevent 3',
  ]) {
    const r = await deniedByDangerList(command)
    assert.match(r.guidance, /危险检查拦截/, command + ' 必须被危险命令黑名单拦下：' + r.guidance)
    assert.equal(r.delivered, false, command + ' 被拦下时不得向控制队列投递任何请求')
  }
})

test('判据 3：对照 —— 非导航键与普通 shell 命令不受这条判据影响（不得修成「全拒」）', async () => {
  for (const command of [
    'input keyevent 4',
    'input keyevent 13',
    'input keyevent 263',
    'getprop ro.product.model',
    'settings get global window_animation_scale',
  ]) {
    const r = await deniedByDangerList(command)
    assert.doesNotMatch(r.guidance, /危险检查拦截/, command + ' 不得被这条判据误拦：' + r.guidance)
  }
})

test('判据 4：服务面直连（controlExec shExec）与工具面同一条判据，误拦不得只在工具壳修掉', async () => {
  // S-5 的纪律：黑名单在**服务面**复查。只在工具壳改 = 插件直连仍然误拦（或仍然漏拦）。
  setup()
  const queue = new ControlQueue()
  const svc = service(queue)
  const textPending = svc.controlExec('shExec', { command: 'input text go%shome' }, 100, { session: TEST_SESSION })
  const delivered = await takeNext(queue)
  if (delivered !== null) queue.settle(delivered.reqId, { ok: true, data: { ok: true, stdout: '' } })
  const text = await textPending
  assert.notEqual(text.ok, false, 'input text 里有 home 的普通文本在服务面也不得被判危险命令')
  assert.doesNotMatch(String(text.error ?? ''), /危险检查拦截/)

  const key = await svc.controlExec('shExec', { command: 'input keyevent 3' }, 100, { session: TEST_SESSION })
  assert.equal(key.ok, false, 'input keyevent 3 在服务面必须被拒')
  // 服务面文案与工具壳不同（「危险检查拦截（服务面拒绝）」），判据只认这条通道自己的措辞。
  assert.match(String(key.error ?? ''), /危险检查拦截/)
})
