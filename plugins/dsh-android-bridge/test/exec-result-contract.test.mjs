// 「判据只看一层」这一族的回归（#1061 / #1065）。
//
// 两条的共同形态：传输层回了 ok:true，就当成业务成功；或者业务真的已经发生，却因为
// 引擎侧截止时间先到而被报成失败。前者把失败/截断报成成功，后者让模型重试一个**非幂等**动作。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AndroidPrivilegeService } from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

const Q = String.fromCharCode(34)
const A11Y_ONLINE_XML = '<map>\n<boolean name=' + Q + 'a11yEnabled' + Q + ' value=' + Q + 'true' + Q + ' />\n'
  + '<long name=' + Q + 'controlHeartbeat' + Q + ' value=' + Q + Date.now() + Q + ' />\n</map>\n'
function a11yOnlinePrefs() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exec-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, A11Y_ONLINE_XML)
  process.env.DSH_ADB_PREFS_PATH = file
}
function useScope(scope) {
  process.env.DSH_SCREEN_SCOPE_TEST = '1'
  process.env.DSH_SCREEN_SCOPE = scope
}
const TEST_SESSION = { id: 'exec-test-session' }
function service(queue, mode = 'danger-full-access') {
  const sessions = new Map([[TEST_SESSION.id, TEST_SESSION]])
  const ctx = { get(name) { return name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined } }
  return new AndroidPrivilegeService(ctx, () => mode, { resolve: () => ({ mode }) }, undefined, queue)
}
async function waitDispatch(queue, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const req = queue.take()
    if (req !== null) return req
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  return null
}

// ───────────────────────── #1061 ─────────────────────────
// execAdbLine 的 exec 步只看传输层 r.ok，不看壳侧回执 data.ok。壳侧在「非零退出」与
// 「输出被截断」两种情况下都置 data.ok=false（ShizukuUserService: ok = complete && !truncated && exit==0），
// 于是两种真实故障都被报成 ok:true，错误文本混在 stdout 里交给调用方。
// 同一函数的 pull/push 分支与 #execAdbShell 都写了 data.ok 检查 —— 只有 exec 步漏了。
test('#1061 反证：非零退出的 exec 步不得报成功', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  const pending = svc.execAdbLine('adb shell uiautomator dump /data/local/tmp/x.xml', { session: TEST_SESSION })
  const req = await waitDispatch(queue, 1500)
  assert.notEqual(req, null, '命令必须被投递')
  queue.settle(req.reqId, {
    ok: true,
    data: { ok: false, stdout: 'ERROR: could not get idle state.', exitCode: 1, error: 'exit=1', truncated: false },
  })
  const r = await pending
  assert.equal(r.ok, false, '壳侧 data.ok=false（退出码 1）必须让 execAdbLine 判失败，不得报 ok:true')
})

test('#1061 反证：输出被截断的 exec 步不得报成功（截断 != 完整）', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  const pending = svc.execAdbLine('adb shell dumpsys window', { session: TEST_SESSION })
  const req = await waitDispatch(queue, 1500)
  assert.notEqual(req, null)

  queue.settle(req.reqId, {
    ok: true,
    data: { ok: false, stdout: 'PREFIX '.repeat(10), exitCode: 0, error: 'output truncated', truncated: true },
  })
  const r = await pending
  assert.equal(r.ok, false, '截断的回执必须让 execAdbLine 判失败，不得把 16 KiB 前缀当完整输出')
})

test('#1061 正控：正常回执（data.ok=true）仍必须成功，且 stdout 原样带出', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  const pending = svc.execAdbLine('adb shell getprop ro.product.model', { session: TEST_SESSION })
  const req = await waitDispatch(queue, 1500)
  assert.notEqual(req, null)
  queue.settle(req.reqId, { ok: true, data: { ok: true, stdout: 'V2425A', exitCode: 0, truncated: false } })
  const r = await pending
  assert.equal(r.ok, true, '正常回执必须成功')
  assert.match(String(r.stdout ?? ''), /V2425A/, 'stdout 必须原样带出')
})

// ───────────────────────── #1065 ─────────────────────────
// S-6 的「壳侧时限 < 引擎侧时限」不变量只对 sh* 成立。input 类 op（click 等）引擎侧截止
// 固定 8000ms，壳侧无对应预算 ⇒ 迟到结果被丢弃 ⇒「点击其实已经发生」却报失败 ⇒
// 模型重试非幂等动作（发送/提交/删除），副作用被放大。
test('#1065 反证：input 类 op 的壳侧时限必须小于引擎侧入队时限（迟到结果不得被丢弃）', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  const pending = svc.controlExec('click', { ref: '0.0' }, 500, { session: TEST_SESSION })
  const req = await waitDispatch(queue, 400)
  assert.notEqual(req, null, '点击必须被投递')
  // 壳侧执行把 click 的 timeoutMs 带下去了吗？没有的话，壳侧只能按自己的默认值跑，
  // 与引擎侧 8s 无任何关系 —— 这就是缺口的可观测形态。
  const carried = typeof req.args.timeoutMs === 'number' ? req.args.timeoutMs : null
  assert.notEqual(carried, null, 'input 类 op 必须把壳侧执行时限下发给壳侧（args.timeoutMs），否则 S-6 不变量对它不成立')
  assert.ok(carried < 500, '壳侧时限必须小于引擎侧入队时限（留余量），实际 ' + carried)
  queue.settle(req.reqId, { ok: true, data: { ok: true } })
  await pending
})

test('#1065 正控：shExec 的既有双时限不变（壳侧 20s < 引擎侧 25s）', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  const pending = svc.execAdbShell('getprop ro.product.model', { session: TEST_SESSION })
  const req = await waitDispatch(queue, 1500)
  assert.notEqual(req, null)
  assert.equal(req.args.timeoutMs, 20000, 'shExec 的壳侧时限必须仍是 20s')
  queue.settle(req.reqId, { ok: true, data: { ok: true, stdout: 'x', exitCode: 0 } })
  await pending
})
