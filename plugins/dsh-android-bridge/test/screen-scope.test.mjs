import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  currentScreenScope,
  controlOpNeedsRealScreen,
  decideScreenAccess,
  normalizeScreenScope,
  parseScreenScopePrefsXml,
  realScreenAdbCommandDenied,
  screenCommandVerdict,
  adbCommandDisplayIds,
  adbCommandDisplayTokens,
  screenTokensFromSfDump,
} from '../lib/screen-scope.js'
import { AndroidPrivilegeService, SHELL_EXEC_TIMEOUT_MS, SHELL_QUEUE_TIMEOUT_MS } from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

// ── 0.14.1 块G（T3）：执行点范围门禁按**目标屏**判定 ──────────────────────────────
// 夹具：范围走测试开关（DSH_SCREEN_SCOPE_TEST），无障碍在线走壳侧 prefs 的新鲜心跳。
const SAVED_ENV = {
  prefs: process.env.DSH_ADB_PREFS_PATH,
  scopeTest: process.env.DSH_SCREEN_SCOPE_TEST,
  scope: process.env.DSH_SCREEN_SCOPE,
}
after(() => {
  for (const [key, value] of Object.entries({
    DSH_ADB_PREFS_PATH: SAVED_ENV.prefs,
    DSH_SCREEN_SCOPE_TEST: SAVED_ENV.scopeTest,
    DSH_SCREEN_SCOPE: SAVED_ENV.scope,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 把壳侧 prefs 写成「无障碍在线」：a11yEnabled=true + 新鲜心跳（ST-23 两口径任一即可）。 */
function a11yOnlinePrefs() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-t3-scope-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, '<map>\n'
    + '<boolean name="a11yEnabled" value="true" />\n'
    + '<long name="controlHeartbeat" value="' + Date.now() + '" />\n'
    + '</map>\n')
  process.env.DSH_ADB_PREFS_PATH = file
}

function useScope(scope) {
  process.env.DSH_SCREEN_SCOPE_TEST = '1'
  process.env.DSH_SCREEN_SCOPE = scope
}

/** 特权面调用的会话夹具（S-5 起服务面要求显式会话或 bindSession）。 */
const TEST_SESSION = 'test-session'

function service(queue, mode = 'danger-full-access') {
  return new AndroidPrivilegeService({}, () => mode, { resolve: () => ({ mode }) }, undefined, queue)
}

/** 轮询取活（队列在途/空窗期都返回 null，等待即可）。 */
async function takeNext(queue, ms = 800) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const req = queue.take()
    if (req !== null) return req
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return null
}

test('screen scope normalizes native preference values fail-closed', () => {
  assert.equal(normalizeScreenScope('virtual-only'), 'virtual-only')
  assert.equal(normalizeScreenScope('real-only'), 'real-only')
  assert.equal(normalizeScreenScope('all'), 'all')
  assert.equal(normalizeScreenScope('everything'), 'virtual-only')
  assert.equal(parseScreenScopePrefsXml('<map><string name="scope">real-only</string></map>'), 'real-only')
  assert.equal(parseScreenScopePrefsXml('<map/>'), 'virtual-only')
})

test('screen target decision never maps virtual-1 to display 0', () => {
  assert.deepEqual(decideScreenAccess('real-only', 'real'), {
    ok: true, screenId: 'real', displayId: 0, scope: 'real-only',
  })
  const virtual = decideScreenAccess('virtual-only', 'virtual-1')
  assert.equal(virtual.ok, false)
  if (!virtual.ok) assert.equal(virtual.reason, 'screen-not-ready')
  const blockedReal = decideScreenAccess('virtual-only', 'real')
  assert.equal(blockedReal.ok, false)
  if (!blockedReal.ok) assert.equal(blockedReal.reason, 'screen-out-of-scope')
})

// review C11 alias 契约：原生注册表解析出动态 displayId 后，virtual-1 才是可执行目标
// （绝不假设 displayId==1、绝不回退 0；非正数/非整数一律退回 not-ready）。
test('virtual-1 becomes executable only with a resolved native display id', () => {
  assert.deepEqual(decideScreenAccess('virtual-only', 'virtual-1', { virtualDisplayId: 7 }), {
    ok: true, screenId: 'virtual-1', displayId: 7, scope: 'virtual-only',
  })
  assert.deepEqual(decideScreenAccess('all', 'virtual-1', { virtualDisplayId: 3 }), {
    ok: true, screenId: 'virtual-1', displayId: 3, scope: 'all',
  })
  for (const bad of [0, -1, null, undefined, 1.5]) {
    const d = decideScreenAccess('virtual-only', 'virtual-1', { virtualDisplayId: bad })
    assert.equal(d.ok, false, 'displayId=' + String(bad))
    if (!d.ok) assert.equal(d.reason, 'screen-not-ready')
  }
  // 范围不含 virtual 时，即便解析出 displayId 也必须拒绝（范围优先）。
  const blocked = decideScreenAccess('real-only', 'virtual-1', { virtualDisplayId: 7 })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.reason, 'screen-out-of-scope')
})

// review C11 执行点分类：设备屏内容/输入 op 必须被识别；元数据、WebView 通道与 browser/vd op 不在列。
test('real-screen control ops are classified for execution-point scope checks', () => {
  for (const op of ['snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'nodeText']) {
    assert.equal(controlOpNeedsRealScreen(op), true, op)
  }
  // webSnapshot/webAction 的读目标是**壳自有 WebView**（DeviceControlService.handleWebSnapshot →
  // MainActivity.webViewRef），与设备屏无关，也不带/不认 screenId。把它们归为「设备屏内容 op」
  // 会让 android_web_dump 在 virtual-only 下被误拒（块G F4b 的同一论断，两层门禁都须更正）。
  for (const op of ['state', 'vdInfo', 'vdCreate', 'browserShot', 'browserState', 'browserOpen', 'webSnapshot', 'webAction']) {
    assert.equal(controlOpNeedsRealScreen(op), false, op)
  }
})

// 块G F2：命令里的目标 display id 必须能被解析出来（放行判据的唯一输入）。
test('adb display target ids are extracted only from explicit -d/--display flags', () => {
  assert.deepEqual(adbCommandDisplayIds('screencap -p -d 47 /sdcard/a.png'), [47])
  assert.deepEqual(adbCommandDisplayIds('screencap -p --display 25 /sdcard/a.png'), [25])
  assert.deepEqual(adbCommandDisplayIds('input -d 47 tap 100 200'), [47])
  assert.deepEqual(adbCommandDisplayIds('screencap -p /sdcard/a.png'), [], '无 -d 时不得凭空得到目标屏')
  assert.deepEqual(adbCommandDisplayIds('dumpsys display'), [], 'display 是子命令词，不是目标屏')
})

// review C11 raw shell 面：virtual-only 下 screencap/input/uiautomator 等命令在执行点拒绝，
// 只读元数据命令放行；real-only/all 不拦（真实屏本就在范围内）。
test('raw adb real-screen commands are denied outside the real-screen scope', () => {
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p /sdcard/a.png'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'input tap 100 200'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'uiautomator dump /sdcard/x.xml'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'dumpsys window'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'am start -n com.example/.Main'))
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'getprop ro.product.model'), null)
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'pm list packages'), null)
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'ls /sdcard/Download'), null)
  assert.equal(realScreenAdbCommandDenied('real-only', 'screencap -p /sdcard/a.png'), null)
  assert.equal(realScreenAdbCommandDenied('all', 'input tap 1 1'), null)
})

test('test-only scope source cannot be overridden by an ordinary environment value', () => {
  assert.equal(currentScreenScope({ DSH_SCREEN_SCOPE: 'all' }), 'virtual-only')
  assert.equal(currentScreenScope({ DSH_SCREEN_SCOPE_TEST: '1', DSH_SCREEN_SCOPE: 'all' }), 'all')
})

// ── F1（0.14.1 块G）：执行点范围门禁必须按**目标屏**判定，而不是按 op 名一刀切 ──────────────
//
// 缺陷形态（用户实报，报文逐字吻合 index.ts:714）：范围 virtual-only、屏幕上确实建好了
// virtual-1（displayId=47），`android_ui_dump {screenId:"virtual-1"}` 却回
// 「不允许读取或操作真实屏幕」。真因不是 screenId 丢了——它在 args 里全程都在；
// 是执行点这条判据只看 `controlOpNeedsRealScreen(op)` 与用户范围，**从不读 args.screenId**，
// 命中后文案还硬编码「真实屏幕」。是文案在撒谎，不是参数在漂移。

test('F1：virtual-only 下 snapshot 目标为 virtual-1 必须放行（按目标屏判定，不再按 op 名一刀切）', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const out = svc.controlExec('snapshot', { screenId: 'virtual-1' })
  // 虚拟屏别名 → 动态 displayId 必须问壳侧注册表（vdInfo），绝不假设恒为 1、绝不回退 0。
  const vd = await takeNext(queue)
  assert.equal(vd?.op, 'vdInfo', '虚拟屏目标必须先经 vdInfo 解析动态 displayId')
  queue.settle(vd.reqId, { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 47 }] } })
  const snap = await takeNext(queue)
  assert.ok(snap, '范围门不得再按 op 名拒绝一个目标确为虚拟屏的请求')
  assert.equal(snap.op, 'snapshot')
  assert.equal(snap.args.screenId, 'virtual-1', '投递载荷必须保留目标屏别名')
  queue.settle(snap.reqId, { ok: true, data: {} })
  const r = await out
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('F1：virtual-only 下 screenshot 目标为 virtual-1 同样放行（同类 op 无差异）', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const out = svc.controlExec('screenshot', { screenId: 'virtual-1' })
  const vd = await takeNext(queue)
  assert.equal(vd?.op, 'vdInfo')
  queue.settle(vd.reqId, { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 25 }] } })
  const shot = await takeNext(queue)
  assert.ok(shot, 'screenshot 对虚拟屏目标也必须放行')
  assert.equal(shot.op, 'screenshot')
  queue.settle(shot.reqId, { ok: true, data: { path: '/tmp/x.png', width: 360, height: 640 } })
  const r = await out
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('F1：virtual-only 下目标缺省（= real）仍然拒绝，且文案指向真实目标屏', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const r = await svc.controlExec('snapshot', {})
  assert.equal(r.ok, false, '真实屏目标在 virtual-only 下必须 fail-closed 拒绝')
  assert.match(String(r.error), /screen-out-of-scope/, '稳定错误码必须保留')
  assert.match(String(r.error), /real/, '文案必须写出实际目标屏（real），不再硬编码「真实屏幕」这个与目标无关的名词')
  assert.equal(String(r.error).includes('真实屏幕'), false, '旧硬编码文案必须消失')
  assert.equal(await takeNext(queue, 80), null, '拒绝时不得向壳侧投递任何请求')
})

test('F1：virtual-only 下未注册/未就绪的虚拟别名仍然拒绝（放宽不等于放行一切）', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const out = svc.controlExec('snapshot', { screenId: 'virtual-1' })
  const vd = await takeNext(queue)
  assert.equal(vd?.op, 'vdInfo')
  queue.settle(vd.reqId, { ok: true, data: { screens: [{ alias: 'real', kind: 'physical', displayId: 0 }] } })
  const r = await out
  assert.equal(r.ok, false, '注册表里没有该虚拟屏时必须拒绝')
  assert.match(String(r.error), /screen-not-ready/)
  assert.equal(await takeNext(queue, 80), null, '未就绪时不得投递到壳侧')
})

test('F1：real-only 下虚拟屏目标必须拒绝（范围优先于目标解析）', async () => {
  a11yOnlinePrefs()
  useScope('real-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const r = await svc.controlExec('snapshot', { screenId: 'virtual-1' })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /screen-out-of-scope/)
  assert.equal(await takeNext(queue, 80), null, '范围不含 virtual 时不得投递')
})

test('F1：范围 all 下真实屏目标照旧放行（放宽只针对目标屏判定，不动 in-scope 路径）', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  const out = svc.controlExec('snapshot', {})
  const snap = await takeNext(queue)
  assert.equal(snap?.op, 'snapshot', 'all 范围下真实屏请求必须直达壳侧（不得多打一次 vdInfo）')
  queue.settle(snap.reqId, { ok: true, data: {} })
  const r = await out
  assert.equal(r.ok, true, JSON.stringify(r))
})

// ── F2（0.14.1 块G）：raw shell 面的范围复查同样必须看目标屏 ─────────────────────────
//
// 缺陷形态（同族第二条 screen-blind 门禁）：`screencap -d 47`（读虚拟屏）被
// REAL_SCREEN_ADB_COMMAND 的**纯命令词**匹配拦下——它只看命令里有没有 screencap，
// 不看 `-d <displayId>` 指向哪块屏。于是「读虚拟屏」与「读真实屏」同罪。

test('F2：virtual-only 下 screencap -d <虚拟屏 id> 必须放行（目标屏在注册表里）', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const out = svc.execAdbShell('adb shell screencap -p -d 47 /data/local/tmp/a.png', { session: TEST_SESSION })
  const vd = await takeNext(queue)
  assert.equal(vd?.op, 'vdInfo', '带 -d 的命令必须先经 vdInfo 核对目标屏归属')
  queue.settle(vd.reqId, { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 47 }] } })
  const sh = await takeNext(queue)
  assert.ok(sh, '目标屏确为虚拟屏时 screencap -d 必须放行到 shExec')
  assert.equal(sh.op, 'shExec')
  queue.settle(sh.reqId, { ok: true, data: { ok: true, stdout: '' } })
  const r = await out
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('F2：virtual-only 下 -d 指向未注册 id / display 0 时仍然拒绝', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  for (const command of [
    'adb shell screencap -p -d 99 /data/local/tmp/a.png',
    'adb shell screencap -p -d 0 /data/local/tmp/a.png',
  ]) {
    // 每轮重写 a11y 心跳：在线判据有 20s 保鲜窗，而本轮每步都要等 8s 级的壳侧往返，
    // 两轮之间心跳会过期 → 门变成「设备控制未授权」，测的就不是屏幕范围而是授权（假失败）。
    a11yOnlinePrefs()
    const queue = new ControlQueue()
    const svc = service(queue)
    const out = svc.execAdbShell(command, { session: TEST_SESSION })
    const vd = await takeNext(queue)
    if (vd !== null) {
      assert.equal(vd.op, 'vdInfo')
      queue.settle(vd.reqId, { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 47 }] } })
    }
    const r = await out
    assert.equal(r.ok, false, command)
    // 文案随块G F6 更新：旧文案「不允许经 ADB 读取或操作真实屏幕」是**假门禁表述**——
    // 被判拒的真实理由是「目标屏未能与注册表核对上」，不是「不允许访问 real」
    // （范围 virtual-only 恰恰**允许**访问已注册虚拟屏）。此处断言新文案如实说明拒因，
    // 并显式禁止假表述回归（T3 修过同族缺陷：文案撒谎比拒绝本身更难排查）。
    assert.match(String(r.guidance), /未能与壳侧注册表核对上/, command)
    assert.doesNotMatch(String(r.guidance), /不允许访问 real|不允许经 ADB 读取或操作真实屏幕/, command)
    assert.equal(await takeNext(queue, 80), null, command + ' 不得投递 shExec')
  }
})

test('F2：无 -d 的 screencap 与真实屏命令照旧拒绝（放宽面收敛在显式目标屏）', () => {
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p /sdcard/a.png'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p -d 47 /sdcard/a.png'),
    '未提供注册表时 fail-closed：不得凭 -d 数字就放行')
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p -d 47 /sdcard/a.png', { virtualDisplayIds: [] }))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p -d 99 /sdcard/a.png', { virtualDisplayIds: [47] }),
    '目标 id 不在注册表 → 拒绝')
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p -d 0 /sdcard/a.png', { virtualDisplayIds: [0] }),
    'display 0 = 真实屏，永远不放行')
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'adb shell screencap -p -d 47 /data/local/tmp/a.png', { virtualDisplayIds: [47] }), null)
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'screencap -p --display 47 /sdcard/a.png', { virtualDisplayIds: new Set([47]) }), null)
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'input -d 47 tap 100 200', { virtualDisplayIds: [47] }), null)
})

test('F2：范围含 real 时不打注册表往返（放宽不得引入新的固定开销）', async () => {
  a11yOnlinePrefs()
  useScope('real-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const out = svc.execAdbShell('adb shell screencap -p -d 47 /data/local/tmp/a.png', { session: TEST_SESSION })
  const sh = await takeNext(queue)
  assert.equal(sh?.op, 'shExec', 'real-only 下真实屏命令本就放行，不得先问 vdInfo')
  queue.settle(sh.reqId, { ok: true, data: { ok: true, stdout: '' } })
  const r = await out
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(await takeNext(queue, 80), null, '不得留下第二个在途请求')
})

// ── F4b 执行点半边（0.14.1 块G）：WebView 通道 op 不得被设备屏范围门拦 ─────────────────// 两层门禁必须同改：manage 的 SCREEN_ACTIONS 已按 device_info 判例移出 web_dump，
// 但执行点的 REAL_SCREEN_CONTROL_OPS 若仍含 webSnapshot/webAction，同一个工具换条路径仍会被拒。
test('F4b：virtual-only 下 webSnapshot/webAction 必须直达壳侧（读的是壳自有 WebView）', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  for (const op of ['webSnapshot', 'webAction']) {
    const queue = new ControlQueue()
    const svc = service(queue)
    const out = svc.controlExec(op, { root: 'body' })
    const req = await takeNext(queue)
    assert.ok(req, op + ' 不读设备屏，不得被设备屏范围门拒绝')
    assert.equal(req.op, op, op + ' 必须原样投递（不得多打 vdInfo 往返）')
    queue.settle(req.reqId, { ok: true, data: {} })
    const r = await out
    assert.equal(r.ok, true, op + ' -> ' + JSON.stringify(r))
  }
})

// ── 0.14.1 块G F6：`screencap -d` 的 id 空间是 SurfaceFlinger token ──────────────
//
// 真因（设备实测：MuMu x86_64 模拟器 / Android 15 / API 35）：
//   `screencap -d <DisplayManager displayId>` → Failed to take screenshot. Status: -2（虚拟屏取不到图）
//   `screencap -d <SurfaceFlinger token>`     → 成功，675x1200 RGBA 非全黑
// 两个 id 空间**不相交**；SF token 还超出 2^53（JS Number）与 2^63-1（Kotlin Long），
// 必须全程字符串比对（数值化会把 11529215046816944610 变成 ...944000）。
// 本组夹具逐字取自设备 `dumpsys SurfaceFlinger` 输出。
const F6_SF_DUMP = [
  '    name="mumuscreen000"',
  'Virtual Display 11529215046816944610',
  '    name="DSH virtual-1"',
].join('\n')
const F6_VTOKEN = '11529215046816944610'   // 已注册虚拟屏（virtual-1）的 SF token
const F6_RTOKEN = '4619827820427265280'    // 真实屏的 SF token
const F6_UNREG = '11529215049621561620'    // 设备上出现过的另一世代 token（当前未注册）

/** F6 判定用的完整选项（displayId=4 + 别名集合 + SF token 配对）。 */
function f6Options() {
  return {
    virtualDisplayIds: [4],
    virtualAliases: ['virtual-1'],
    sfVirtualDisplays: screenTokensFromSfDump(F6_SF_DUMP),
  }
}

test('F6：已注册虚拟屏的 SF token 放行（设备上该 token 确实能出图）', () => {
  const cmd = `screencap -p -d ${F6_VTOKEN} /data/local/tmp/a.png`
  assert.equal(realScreenAdbCommandDenied('virtual-only', cmd, f6Options()), null)
})

test('F6 反证：真实屏的 SF token 必须拒（绝不因「看起来像虚拟屏」放行）', () => {
  const cmd = `screencap -p -d ${F6_RTOKEN} /data/local/tmp/a.png`
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', cmd, f6Options()), null)
})

test('F6 反证：未注册虚拟屏的 SF token 必须拒', () => {
  const cmd = `screencap -p -d ${F6_UNREG} /data/local/tmp/a.png`
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', cmd, f6Options()), null)
})

test('F6 反证：反查不可达一律 fail-closed（空/缺省 token 映射都不得放行）', () => {
  const cmd = `screencap -p -d ${F6_VTOKEN} /data/local/tmp/a.png`
  // 只给 displayId（= F6 之前的旧形态）：token 无从核对 → 必须拒。
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', cmd, { virtualDisplayIds: [4] }), null)
  // 显式空数组（反查失败/虚拟屏已销毁）：同样拒。
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', cmd, {
    virtualDisplayIds: [], virtualAliases: [], sfVirtualDisplays: [],
  }), null)
  // 只有 token 配对、别名集合为空（注册表拿不到）：仍拒。
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', cmd, {
    virtualDisplayIds: [], virtualAliases: [], sfVirtualDisplays: screenTokensFromSfDump(F6_SF_DUMP),
  }), null)
})

test('F6：token 全程字符串（超 2^53/2^63，数值化即失真）', () => {
  assert.equal(typeof screenTokensFromSfDump(F6_SF_DUMP)[0].token, 'string')
  assert.notEqual(String(Number(F6_VTOKEN)), F6_VTOKEN, 'Number(token) 必须与原串不同（精度丢失）')
  assert.ok(BigInt(F6_VTOKEN) > 9007199254740991n, '超出 JS 安全整数')
  assert.ok(BigInt(F6_VTOKEN) > 9223372036854775807n, '超出 Kotlin Long 上界')
  // 真正的防线：字面量比对仍放行（若内部曾 Number 化，这里会误拒）。
  const cmd = `screencap -p -d ${F6_VTOKEN} /data/local/tmp/a.png`
  assert.equal(realScreenAdbCommandDenied('virtual-only', cmd, f6Options()), null)
  // 反证：若把命令写成 Number 化后的值，就**不得**放行（它不是任何真实 token）。
  const distorted = `screencap -p -d ${String(Number(F6_VTOKEN))} /data/local/tmp/a.png`
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', distorted, f6Options()), null)
})

test('F6 回归：F2 既有 displayId 路径与 fail-closed 面都不受影响', () => {
  // displayId 空间仍放行（F2 既有行为）。
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'screencap -p -d 4 /data/local/tmp/a.png', f6Options()), null)
  // 真实屏面一律拒：0 / 无参 / 无 -d 的 dumpsys。
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', 'screencap -p -d 0 /data/local/tmp/a.png', f6Options()), null)
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', 'screencap -p /data/local/tmp/a.png', f6Options()), null)
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', 'dumpsys window', f6Options()), null)
})

test('F6：拒绝文案如实说明拒因（不得再是「不允许访问 real」式假门禁）', () => {
  const text = realScreenAdbCommandDenied('virtual-only', `screencap -p -d ${F6_RTOKEN} /data/local/tmp/a.png`, f6Options())
  assert.ok(typeof text === 'string' && text.length > 0)
  assert.ok(!/不允许访问 real|不允许经 ADB 读取或操作真实屏幕/.test(text),
    '禁止「不允许访问 real」这类与真实判据不符的表述（T3 刚修过同族缺陷）')
  assert.match(text, /未能与壳侧注册表核对上/, '必须如实说明是「目标屏未能与注册表核对」')
  assert.match(text, /virtual-only/, '必须说明当前范围')
})

test('F6：SF 反查命令自身必须能过门，且判定不得退化为「按 displayId 放行」', () => {
  const sfCmd = "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'"

  // ── ① 反查命令自身必须放行 ────────────────────────────────────────────────
  // 本改动的目的只是「让范围判定能核对 SF token」，不是「放宽 shell 命令词面」：
  // 该命令必须**不被**真实屏命令词命中，否则 F6 的反查自己在门内就被拦死，
  // token 集合恒空 → 已注册虚拟屏的 token 也被拒 → F6 形同不存在（fail-closed 恒拒）。
  assert.equal(realScreenAdbCommandDenied('virtual-only', sfCmd, f6Options()), null)

  // ── ② 判别力（本用例此前无判别力，故重写）──────────────────────────────────
  // 缺口：原先只断言「该命令不在命令词面内」。而 `dumpsys SurfaceFlinger` 本就不匹配
  // `dumpsys (window|display|input)`，于是**F2/F6 全量回退时该用例仍绿**——它测的是
  // 「正则恰好没命中」这个无关事实，不是任何一条判据。
  //
  // 改为钉住真正要守的性质：**SF token 只能靠「逐字核对 SF token」放行，
  // 不得退化为「命令里出现数字就按 displayId 放行」**。
  // 若实现被回退成「只要有 -d 且能对上已注册 displayId 就放行」，下面两条必红：
  const byTokenOnly = `screencap -p -d ${F6_VTOKEN} /data/local/tmp/a.png`
  // (a) 只给 displayId 知识、不给 SF 配对（= F6 之前的旧形态）→ SF token 无从核对 → 必须拒。
  //     若实现退化为「按 displayId 放行」，这里会误放行 → 判红。
  assert.notEqual(
    realScreenAdbCommandDenied('virtual-only', byTokenOnly, { virtualDisplayIds: [4] }),
    null,
    'SF token 不得因「存在已注册 displayId」而被放行（那就是退化成按 displayId 放行）',
  )
  // (b) 反向：给了完整 SF 配对 → 必须放行。两条合起来才排除了「恒拒」这种假绿（恒拒也能过 (a)）。
  assert.equal(realScreenAdbCommandDenied('virtual-only', byTokenOnly, f6Options()), null)

  // ── ③ 命令词面不得缩水也不得放宽：真实屏 dumpsys 三个面仍必须拒 ──────────────
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', 'dumpsys display', f6Options()), null)
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', 'dumpsys input', f6Options()), null)
  assert.notEqual(realScreenAdbCommandDenied('virtual-only', 'dumpsys window', f6Options()), null)
})

test('F6：SF 解析对错配/物理屏/空输入都 fail-closed', () => {
  assert.deepEqual(screenTokensFromSfDump(''), [])
  assert.deepEqual(screenTokensFromSfDump('nothing here'), [])
  // 只有物理屏：不得产出任何条目。
  assert.deepEqual(screenTokensFromSfDump('    name="mumuscreen000"'), [])
  // name 与 token 必须成对：物理屏名不得被错配给下一个 token。
  const misordered = [
    'Virtual Display 11111111111111111111',
    '    name="DSH virtual-9"',
    'Virtual Display 22222222222222222222',
    '    name="mumuscreen000"',
  ].join('\n')
  assert.deepEqual(screenTokensFromSfDump(misordered), [{ alias: 'virtual-9', token: '11111111111111111111' }])
})

test('F6：多处壳侧往返必须串行（控制队列单线程，并发会让判定恒拒）', async () => {
  // 反证：本轮实现曾用 Promise.all 并发发壳侧请求，而 ControlQueue.enqueue 在途时直接返回
  // 「已有在途的设备控制请求」⇒ 后一个立即失败 ⇒ token 集合恒空 ⇒ 已注册虚拟屏的 token 也被拒
  // （比不修更糟）。本用例把「必须串行」钉死：每一跳都必须在前一跳 settle **之后**才出现，
  // 且三跳全部走通后判定放行。
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  const cmd = `adb shell screencap -p -d ${F6_VTOKEN} /data/local/tmp/a.png`
  const out = svc.execAdbShell(cmd, { session: TEST_SESSION })

  // ① 第一跳：vdInfo（注册表：displayId + 别名一次取回）
  const vd1 = await takeNext(queue)
  assert.equal(vd1?.op, 'vdInfo', '第一跳必须是 vdInfo')
  queue.settle(vd1.reqId, { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 4 }] } })

  // ② 第二跳：shExec（读 SurfaceFlinger 反查 token）——只有第一跳结束后才应出现。
  const sh = await takeNext(queue)
  assert.equal(sh?.op, 'shExec', '第二跳必须是 shExec（SF token 反查），说明未并发丢失')
  assert.match(String(sh.args.command), /dumpsys SurfaceFlinger/, '反查命令必须点名 SurfaceFlinger')
  queue.settle(sh.reqId, { ok: true, data: { ok: true, stdout: F6_SF_DUMP, exitCode: 0 } })

  // ③ 第三跳：范围门放行后，命令本身被投递为 shExec（这才是真正要执行的命令，不是反查探针）。
  const exec = await takeNext(queue)
  assert.equal(exec?.op, 'shExec', '范围门放行后必须投递真实命令（说明 SF token 核对通过）')
  assert.match(String(exec.args.command), /screencap/, '投递的必须是原命令')
  queue.settle(exec.reqId, { ok: true, data: { ok: true, stdout: '', exitCode: 0 } })

  // ④ 放行（并发实现会在此判红：第一跳后的并发请求被队列拒绝，token 集合恒空 → 拒绝而非投递）。
  const r = await out
  assert.equal(r.ok, true, '已注册虚拟屏的 SF token 必须放行；并发发请求的实现会在此判红：' + JSON.stringify(r))
})

// ── 0.14.1 复审 §8.3 / §8.3b：范围门的两条绕过（选项在前 / 多段洗白） ─────────────────
//
// 缺陷形态（两条都在 0.14.1 刚加固的执行点上，属**新引入**回归）：
//   §8.3  命令词面要求动词**紧跟** `input`（`input\s+(?:tap|swipe|…)`），而 Android CLI 的正式形态是
//         `input [-d DISPLAY_ID] <command>`（选项在**前**）⇒ `input -d 0 tap 500 800` 不进命令词面
//         ⇒ 引擎侧与壳侧**两层同时**放行，输入落在真实屏 display 0。
//   §8.3b 判定只看「命令里出现的每个 -d 值是否都属于虚拟屏」，**不看整条命令是否只作用于那块屏**
//         ⇒ `screencap -p -d <虚拟屏 token> a.png; screencap -p /sdcard/real.png` 被第一段整行洗白。
//
// 修法（两侧同改，见 screen-scope.ts 的家族表 + 段级自证）：命令词在**归一化后**匹配、
// 每段各自自证目标屏、嵌套执行体（反引号 / `$()` / `sh -c`）再切一层、引号不闭合即 fail-closed。

/** 跨语言 fixture（权威源；壳侧 Kotlin 单测读 gen-screen-scope-fixture.mjs 生成的副本）。 */
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'screen-scope-cases.json'), 'utf8'),
)

/** 壳侧副本：两种布局各探一次（协调仓 <根>/dsh-mobile-apk；apk 自包含 <根>）——不得写死单侧路径。 */
function shellFixturePath() {
  const here = dirname(fileURLToPath(import.meta.url))
  const cands = [
    join(here, '..', '..', '..', 'dsh-mobile-apk', 'app', 'src', 'test', 'resources', 'screen-scope', 'screen-scope-cases.json'),
    join(here, '..', '..', '..', 'app', 'src', 'test', 'resources', 'screen-scope', 'screen-scope-cases.json'),
  ].map((p) => p.replace(/[\/]plugins[\/]dsh-android-bridge[\/]test[\/]\.\.[\/]\.\.[\/]/, ''))
  return cands.find((p) => existsSync(p))
}

test('§8.3/§8.3b：fixture 判据逐条成立（两侧同名 verdict）', () => {
  assert.ok(FIXTURE.cases.length >= 20, 'fixture 用例数不得缩水（当前 ' + FIXTURE.cases.length + '）')
  for (const c of FIXTURE.cases) {
    const owned = new Set(c.ownedTargets ?? [])
    const verdict = screenCommandVerdict(c.command, (raw) => owned.has(raw) && raw !== '0')
    assert.equal(verdict, c.expect, c.name + '（' + c.command + '）')
  }
})

test('§8.3/§8.3b：壳侧 fixture 副本必须在场且与权威源逐字一致', () => {
  const shell = shellFixturePath()
  assert.ok(shell, '壳侧 fixture 副本缺席——跑 node scripts/gen-screen-scope-fixture.mjs 生成（两种布局各探过一次）')
  const canonical = JSON.stringify(FIXTURE, null, 2) + '\n'
  assert.equal(readFileSync(shell, 'utf8'), canonical,
    '壳侧副本过期：跑 node scripts/gen-screen-scope-fixture.mjs 重新生成并提交')
})

// 反证（判别力）：把**修复前的语义**原样写在测试里，它必须在 §8.3/§8.3b 的用例上给出与 fixture
// **相反**的答案。没有这条，「fixture 全绿」可能只是「用例恰好都在新实现的能力范围内」。
// 旧语义两条：① 命令词要求动词紧跟 input（不归一化目标屏参数）；② 整条命令只需**存在**一个已注册
// 目标值即放行（不看它属于哪一段）。
function legacyVerdict(command, owned) {
  const legacyFace = /\b(?:screencap|screenrecord|uiautomator|input\s+(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent)|wm\s+(?:size|density|overscan)|dumpsys\s+(?:window|display|input)|am\s+(?:start|start-activity|force-stop|kill)|monkey)\b/i
  if (!legacyFace.test(command)) return 'allow'
  const tokens = [...command.matchAll(/(?:^|[\s=])(?:-d|--display|--display-id)[\s=]+(\d+)/g)].map((m) => m[1])
  if (tokens.length === 0) return 'deny-uncertified-target'
  return tokens.every((t) => owned.has(t)) ? 'allow' : 'deny-uncertified-target'
}

test('反证：修复前的语义在 §8.3/§8.3b 用例上给出相反答案（fixture 有判别力）', () => {
  const cases = FIXTURE.cases.filter((c) => /^(S-1|S-2)/.test(c.name))
  assert.ok(cases.length >= 10, '§8.3/§8.3b 覆盖用例不得缩水（当前 ' + cases.length + '）')
  const flipped = cases.filter((c) => {
    const owned = new Set(c.ownedTargets ?? [])
    return legacyVerdict(c.command, owned) === 'allow' && c.expect !== 'allow'
  })
  assert.ok(flipped.length >= 6,
    '旧语义必须在多数绕过用例上判「放行」（否则这些用例抓不到本次修的缺陷）：实测翻转为 '
    + flipped.length + ' 条 -> ' + flipped.map((c) => c.name).join('、'))
  // 反向对照：旧语义在「合法目标屏」用例上同样放行 —— 说明上面那条不是因为旧语义恒拒。
  const legit = FIXTURE.cases.filter((c) => c.expect === 'allow' && c.command.includes('-d '))
  assert.ok(legit.length >= 2)
  for (const c of legit) {
    const owned = new Set(c.ownedTargets ?? [])
    assert.equal(legacyVerdict(c.command, owned), 'allow', '旧语义在合法用例上不得为拒：' + c.name)
  }
})

test('§8.3/§8.3b：两条绕过在公开 API 上（带注册表真值）也必须拒，且合法目标仍放行', () => {
  const VTOKEN = '11529215046816944610'
  const opts = {
    virtualDisplayIds: [7],
    virtualAliases: ['virtual-1'],
    sfVirtualDisplays: [{ alias: 'virtual-1', token: VTOKEN }],
  }
  // 复算命令（审查附录 A6）：修复前前三条输出 null（放行）。
  for (const command of [
    'input -d 0 tap 500 800',
    'input --display 0 tap 500 800',
    'input --display=0 tap 500 800',
    'input -d 9999 tap 500 800',
    `screencap -p -d ${VTOKEN} /sdcard/a.png; screencap -p /sdcard/real.png`,
    `echo -d ${VTOKEN} ; uiautomator dump /sdcard/real.xml`,
    `sh -c "screencap -d ${VTOKEN}; input tap 100 200"`,
    `echo -d ${VTOKEN}; cat /sdcard/secret.png`,
    `screencap -p -d ${VTOKEN} /sdcard/a.png && input tap 1 2`,
    'am start -d 7 -n com.example/.Main',
  ]) {
    assert.notEqual(realScreenAdbCommandDenied('virtual-only', command, opts), null, command)
  }
  // 放宽面不得被这次修法吃掉（修成「全拒」同样是缺陷）。
  for (const command of [
    `screencap -p -d ${VTOKEN} /sdcard/a.png`,
    'screencap -p -d 7 /sdcard/a.png',
    'input -d 7 tap 100 200',
    'am start --display 7 -n com.example/.Main',
    "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
    'getprop ro.product.model',
  ]) {
    assert.equal(realScreenAdbCommandDenied('virtual-only', command, opts), null, command)
  }
})

// N-5：两侧「逐字同源」的正则其实不等价的两处（本次同批修掉）。
test('N-5：目标屏参数的空白类只认 ASCII（JS 的 \s 含 Unicode 空白，会让两侧正则不等价）', () => {
  // 全角空格（U+3000）不是 shell 的分隔符：`input\u3000-d 0 tap` 是一整条 argv[0]，不会被执行。
  assert.deepEqual(adbCommandDisplayTokens('input\u3000-d 0 tap 1 2'), [],
    'Unicode 空白不得被当作参数分隔符（否则判定看到的命令与 shell 执行的不是同一条）')
  assert.deepEqual(adbCommandDisplayTokens('input -d 0 tap 1 2'), ['0'])
  assert.deepEqual(adbCommandDisplayTokens('input\t-d 0 tap 1 2'), ['0'], '制表符是合法分隔符')
})

test('N-5：SF 反查输出容忍行尾空白（设备 dumpsys 常见尾随空格）', () => {
  const withTrailing = 'Virtual Display 11529215046816944610   \n    name="DSH virtual-1"   \n'
  assert.deepEqual(screenTokensFromSfDump(withTrailing), [{ alias: 'virtual-1', token: '11529215046816944610' }])
  assert.deepEqual(screenTokensFromSfDump('Virtual Display 111\t\n'), [],
    'token 行有尾随空白仍须被识别（不得因行尾空白丢掉整条配对）')
})

// ── 审查 §5.1 / S-5：授权门从**调用方**下沉到**服务面** ────────────────────────────────
//
// 缺陷形态：`gateFor(session)` 与危险命令黑名单此前只在工具壳里，服务面 `controlExec` /
// `execAdbShell` 自身不判档位 ⇒ 任何能 `ctx.get('androidPrivilege')` 的引擎侧代码（含市场装的
// 第三方插件）都能直接驱动 uid 2000 特权 shell，与用户选的会话档位无关。in-tree 反例是 manage
// 的动画开关（同类命令经工具走会被黑名单拒，内部直连却畅通）——说明黑名单是**工具壳的属性**。

test('S-5 反证：无会话的特权调用在服务面被拒（fail-closed），且不投递任何请求', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  // 旧实现：直接畅通（这就是「授权门在调用方」的形态）。
  const r = await svc.execAdbShell('getprop ro.product.model')
  assert.equal(r.ok, false, '无会话的特权 shell 调用必须被拒')
  assert.match(String(r.guidance), /缺少调用方会话/, '文案必须点明是「缺会话」而不是别的')
  assert.equal(await takeNext(queue, 80), null, '被拒的调用不得进入控制队列')

  const c = await svc.controlExec('shExec', { command: 'getprop ro.product.model' })
  assert.equal(c.ok, false, 'controlExec(shExec) 同样必须在服务面拒绝无会话调用')
})

test('S-5 反证：会话档位不足（非 danger-full-access）时特权面拒绝', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue, 'workspace-write')
  const r = await svc.execAdbShell('getprop ro.product.model', { session: TEST_SESSION })
  assert.equal(r.ok, false)
  assert.match(String(r.guidance), /danger-full-access/, '文案必须说明档位要求')
  assert.equal(await takeNext(queue, 80), null)
})

test('S-5 反证：危险命令黑名单在服务面生效（工具壳之外同样拒）', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  // 这正是审查里的 in-tree 反例命令（manage 用内部直连写系统动画开关）。
  const r = await svc.execAdbShell('settings put global window_animation_scale 0', { session: TEST_SESSION })
  assert.equal(r.ok, false, '系统写面命令必须在服务面被黑名单拦下')
  assert.match(String(r.guidance), /危险检查拦截/)
  assert.equal(await takeNext(queue, 80), null, '被黑名单拦下的命令不得进入控制队列')
})

test('S-5：内部白名单按**命令形态**校验，不是名字对了就放行', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  // ① 形态合法的动画命令 → 放行（进入队列）。
  const okCmd = 'settings put global window_animation_scale 0; settings put global transition_animation_scale 0'
  const okRun = svc.execAdbShell(okCmd, { internal: 'animation-scales' })
  const enqueued = await takeNext(queue)
  assert.equal(enqueued?.op, 'shExec', '内部白名单的合法形态必须放行到执行面')
  queue.settle(enqueued.reqId, { ok: true, data: { ok: true, stdout: '' } })
  assert.equal((await okRun).ok, true, JSON.stringify(await okRun))

  // ② 同一个白名单名字 + 形态外命令 → 拒（若实现是「名字对了就放行」，这里会判红）。
  for (const bad of [
    'pm grant com.example android.permission.CAMERA',
    'settings put global window_animation_scale 0; rm -rf /sdcard/Download',
    'settings put secure enabled_accessibility_services x',
  ]) {
    const r = await svc.execAdbShell(bad, { internal: 'animation-scales' })
    assert.equal(r.ok, false, '白名单名字不得成为任意命令的通行证：' + bad)
  }
  // ③ 未登记的名字 → 拒。
  const unknown = await svc.execAdbShell('getprop ro.product.model', { internal: 'no-such-call' })
  assert.equal(unknown.ok, false, '未登记的内部调用名必须拒')
  assert.equal(await takeNext(queue, 80), null)
})

test('S-5：SF token 反查（判定自身的一部分）经内部白名单可用，且与档位无关', async () => {
  a11yOnlinePrefs()
  useScope('virtual-only')
  const queue = new ControlQueue()
  const svc = service(queue)
  // 无会话、无档位：SF 反查仍必须能跑（否则范围判定自己就转不动了）。
  // 注意**先取活再 await**：反查的 promise 挂着等壳侧回填，先 await 会把请求等到超时。
  const pendingSf = svc.shellSfVirtualDisplayTokens()
  const req = await takeNext(queue)
  assert.equal(req?.op, 'shExec', 'SF 反查必须能投递')
  assert.match(String(req.args.command), /dumpsys SurfaceFlinger/)
  queue.settle(req.reqId, { ok: true, data: { ok: true, stdout: F6_SF_DUMP, exitCode: 0 } })
  assert.deepEqual(await pendingSf, [{ alias: 'virtual-1', token: F6_VTOKEN }])
})

test('S-5：bindSession 把会话绑到当前异步上下文（工具层的用法），且不跨上下文泄漏', async () => {
  a11yOnlinePrefs()
  useScope('all')
  const queue = new ControlQueue()
  const svc = service(queue)
  // 工具层形态：入口绑定一次，其余嵌套 helper 自动继承（manage 有 40+ 处私有面调用点）。
  await new Promise((resolve) => {
    svc.bindSession(TEST_SESSION)
    resolve(undefined)
  })
  const bound = svc.execAdbShell('getprop ro.product.model')
  const req = await takeNext(queue)
  assert.equal(req?.op, 'shExec', '绑定的会话必须让嵌套调用通过服务面门')
  queue.settle(req.reqId, { ok: true, data: { ok: true, stdout: 'ok' } })
  assert.equal((await bound).ok, true)
})

test('S-6：超时口径必须 shellTimeout < engineTimeout（否则假失败 + 二次执行）', () => {
  assert.ok(SHELL_EXEC_TIMEOUT_MS < SHELL_QUEUE_TIMEOUT_MS,
    '壳侧执行时限必须小于引擎入队时限：反了会出现「引擎超时但壳侧已执行」→ 模型重试即二次执行（非幂等 op）')
  assert.equal(SHELL_EXEC_TIMEOUT_MS, 20_000)
  assert.equal(SHELL_QUEUE_TIMEOUT_MS, 25_000)
})
