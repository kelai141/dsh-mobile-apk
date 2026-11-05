// 执行面安全门的「判据是否真的在执行路径上」回归（#1062 / #1063 / #1064）。
//
// 这一族的共同缺陷形态：判据写得对，但**不在** #controlExec 的执行路径上——
// 于是服务面（同驻插件、以及未来任何新增调用点）可以绕过工具壳的检查。
//
// 判据一律选「有没有真的投递到控制队列」这个可观测事实，而不是错误文案措辞：
// 投递了就说明执行面被穿透了，这正是缺陷本身。
//
// **必须并发观测**：ControlQueue 在请求超时后会把在途项清掉，所以「先 await 完成再取活」
// 永远读到空队列——那是假绿（本文件第一版就踩了这个坑：shRemove 的危险路径实测确实被投递，
// 却因为超时清场被读成「没投递」）。下面一律在调用**在途时**轮询。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AndroidPrivilegeService } from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

// 壳侧 prefs 是 XML，属性必须用双引号（单引号会让解析器读成 false——本文件第一版就踩了这个坑：
// a11y 被读成关闭，于是所有 A11Y_OPS 都走坐标模式提前返回，探针读到的「没投递」是假绿）。
const Q = String.fromCharCode(34)
const A11Y_ONLINE_XML = '<map>\n<boolean name=' + Q + 'a11yEnabled' + Q + ' value=' + Q + 'true' + Q + ' />\n'
  + '<long name=' + Q + 'controlHeartbeat' + Q + ' value=' + Q + Date.now() + Q + ' />\n</map>\n'
function a11yOnlinePrefs() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, A11Y_ONLINE_XML)
  process.env.DSH_ADB_PREFS_PATH = file
}
function useScope(scope) {
  process.env.DSH_SCREEN_SCOPE_TEST = '1'
  process.env.DSH_SCREEN_SCOPE = scope
}
const TEST_SESSION = { id: 'gate-test-session' }
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
async function probeDispatch(svc, queue, op, args, timeoutMs, auth) {
  const pending = svc.controlExec(op, args, timeoutMs, auth)
  const dispatched = await waitDispatch(queue, Math.max(300, timeoutMs - 20))
  const out = await pending
  if (dispatched !== null) queue.settle(dispatched.reqId, { ok: true, data: { ok: true } })
  return { dispatched, out }
}

test('#1062 反证：workspace-write 会话不得读整屏', async () => {
  a11yOnlinePrefs()
  useScope('all')
  for (const op of ['snapshot', 'screenshot', 'nodeText']) {
    const queue = new ControlQueue()
    const svc = service(queue, 'workspace-write')
    const { dispatched, out } = await probeDispatch(svc, queue, op, { ref: '0.0' }, 500, { session: TEST_SESSION })
    assert.equal(dispatched, null, op + ' 在 workspace-write 档位下不得投递到控制队列（执行面被穿透）')
    assert.equal(out.ok, false, op + ' 必须被拒')
    assert.match(String(out.error), /danger-full-access/, op + ' 的拒绝文案必须点明档位要求')
  }
})

test('#1062 正控：完全权限档位下这三个 op 仍可投递', async () => {
  a11yOnlinePrefs()
  useScope('all')
  for (const op of ['snapshot', 'screenshot', 'nodeText']) {
    const queue = new ControlQueue()
    const svc = service(queue, 'danger-full-access')
    const { dispatched } = await probeDispatch(svc, queue, op, { ref: '0.0' }, 500, { session: TEST_SESSION })
    assert.notEqual(dispatched, null, op + ' 在完全权限档位下必须能投递到控制队列')
  }
})

test('#1063 反证：shRemove 的危险路径必须被拦在执行面之外', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const dangerous = ['/', '/data', '/system', '/sdcard', '/storage/emulated/0', '',
    '/data/data', '/data/data/com.dsharnessmobile.shell', '/data/local/tmp/../..']
  for (const remote of dangerous) {
    const queue = new ControlQueue()
    const svc = service(queue)
    const { dispatched, out } = await probeDispatch(svc, queue, 'shRemove', { remote }, 500, { session: TEST_SESSION })
    assert.equal(dispatched, null, 'shRemove 的 ' + JSON.stringify(remote) + ' 不得投递到控制队列')
    assert.equal(out.ok, false, 'shRemove 的 ' + JSON.stringify(remote) + ' 必须被拒')
  }
})

test('#1063 正控：明确的临时目录仍可删除', async () => {
  a11yOnlinePrefs()
  useScope('all')
  for (const remote of ['/data/local/tmp/dsh-x', '/sdcard/Android/data/com.dsharnessmobile.shell/cache/tmp/abc']) {
    const queue = new ControlQueue()
    const svc = service(queue)
    const { dispatched } = await probeDispatch(svc, queue, 'shRemove', { remote }, 500, { session: TEST_SESSION })
    assert.notEqual(dispatched, null, '普通临时路径 ' + remote + ' 必须仍能投递')
  }
})

test('#1064 反证：无会话时 sf-token-lookup 不得跑 uid-2000 的 dumpsys', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const pendingDeny = svc.shellCommandScopeDenied('screencap -d 999 /sdcard/x.png')
  // 范围判定本身仍要读注册表（vdInfo 是**无内容**的元数据面，不受档位闸约束），
  // 但不能因此放过 SF 反查：**只盯 shExec**，把它当成判据。
  const ops = []
  const deadline = Date.now() + 400
  while (Date.now() < deadline) {
    const req = queue.take()
    if (req !== null) {
      ops.push(req.op)
      queue.settle(req.reqId, { ok: true, data: { ok: true, stdout: '', screens: [] } })
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  const verdict = await pendingDeny
  assert.equal(ops.includes('shExec'), false,
    '无会话不得经内部键跑 uid-2000 的 dumpsys SurfaceFlinger（实际投递：' + ops.join(',') + '）')
  assert.notEqual(verdict, null, '反查被拒时必须 fail-closed（判定为拒），不得放行')
})

test('#1064 正控：已绑定的完全权限会话仍能完成 SF token 反查', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  svc.bindSession(TEST_SESSION)
  const pendingDeny = svc.shellCommandScopeDenied('screencap -d 999 /sdcard/x.png')
  const dispatched = await waitDispatch(queue, 400)
  if (dispatched !== null) queue.settle(dispatched.reqId, { ok: true, data: { ok: true, stdout: '' } })
  await pendingDeny
  assert.notEqual(dispatched, null, '有会话且档位够时必须能跑 SF 反查')
})