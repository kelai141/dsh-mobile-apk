#!/usr/bin/env node
// verify-state-sync.mjs — 「只改真源、完全不碰我方 UI」设备用例集（0.13.8-b ST-32 / 计划 §4.1.5）。
//
// 判据（§4.1.5 三步形态）：① 只改外部真源（系统权限 / 壳偏好 / settings.yaml，经 ADB）；
// ② 回到 App 或等一个轮询周期；③ 断言**展示值 + 判定值都要收敛**。
// 时间口径：权限/授权类 ≤3s（或回前台即刻）；配置类 ≤5s。
//
// 设备侧脚本，按 §8.3 C 口径**不计入**五接线面（属 L2 设备门禁，PR 前必跑）。
//
// 用法：
//   node scripts/verify-state-sync.mjs --self-test                 # 无设备：桩驱动，含故意失败样本
//   node scripts/verify-state-sync.mjs --serial 127.0.0.1:16416 [--pkg com.dsharnessmobile.shell] [--ws <cdp-ws-url>]
// 退出码：0 = 全部用例 PASS；1 = 有用例 FAIL；2 = 用法/前置不满足。
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? def) : def }
const SELF_TEST = argv.includes('--self-test')
const SERIAL = argOf('serial', '')
const PKG = argOf('pkg', 'com.dsharnessmobile.shell')
const WS = argOf('ws', '')

/** 设备原语：函数体 = adb shell（可 run-as），`.raw` = adb 级命令（get-state/forward/install 等）。
 *  真实模式用 spawnSync；自检模式注入桩（桩只需可调用，不必有 .raw）。 */
export function makeAdb(serial) {
  const raw = (adbArgs) => {
    const r = spawnSync('adb', ['-s', serial, ...adbArgs], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
  }
  const shell = (args, { runAs = false } = {}) => raw(runAs ? ['shell', 'run-as', PKG, ...args] : ['shell', ...args])
  shell.raw = raw
  return shell
}

/** 页面观测：CDP Runtime.evaluate（WebView 页面里读桥=getter 事实值）。 */
export function makeCdp(getWsUrl) {
  let ws = null
  let nextId = 1
  const pending = new Map()
  // 每次（重）连都重新解析目标：页面重载/应用重启后 target id 与进程号都会变，旧 ws URL 恒 404。
  const connect = () => Promise.resolve().then(getWsUrl).then((url) => new Promise((resolve, reject) => {
    ws = new WebSocket(url)
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('CDP 连接失败（ws 不可达或目标已消失）'))
    // 页面重载 / 应用重启会关掉旧 target：清空 pending 并标记可重连，不抛错（否则一次重启即中止整轮）。
    ws.onclose = () => {
      ws = null
      for (const [id, p] of pending) { pending.delete(id); p({ retryable: true }) }
    }
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data)
        const p = pending.get(msg.id)
        if (p) { pending.delete(msg.id); p(msg) }
      } catch { /* 非 JSON 帧忽略 */ }
    }
  }))
  const once = async (expression, timeoutMs) => {
    if (ws === null) await connect()
    const id = nextId++
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve)
      try {
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      } catch { pending.delete(id); resolve({ retryable: true }); return }
      setTimeout(() => { if (pending.delete(id)) resolve({ retryable: true }) }, timeoutMs)
    })
    if (reply.retryable) return { retryable: true }
    if (reply.error) throw new Error('CDP 错误: ' + JSON.stringify(reply.error))
    return { value: reply.result?.result?.value }
  }
  /** 单次求值可重试（3s）；连续两次失败返回 undefined——调用方按「本轮未收敛」重试，不中止整轮。 */
  const evaluate = async (expression) => {
    let r = await once(expression, 3000)
    if (r.retryable) {
      try { await connect() } catch { /* 下一轮再试 */ }
      r = await once(expression, 3000)
    }
    return r.retryable ? undefined : r.value
  }
  return { evaluate, close: () => { try { ws?.close() } catch { /* 已关闭 */ } } }
}

/**
 * 壳偏好 upsert 命令（单字符串 → 由 adb 交给设备 shell，避免嵌套引号被二次解析）：
 * 键在场则改值；键缺席则先在 </map> 前插入该键再改值（本轮实测 immersive_mode 在场、dev_log_enabled 缺席）。
 * 路径 = 应用数据根下的 shared_prefs/dsh_settings.xml（ShellState.PREFS="dsh_settings"）。
 */
export function prefsUpsertCommand(key, on, prefsName = 'dsh_settings') {
  const value = on ? 'true' : 'false'
  const file = 'shared_prefs/' + prefsName + '.xml'
  const esc = "(grep -q 'name=\"" + key + "\"' " + file + " || sed -i 's#</map>#    <boolean name=\"" + key + "\" value=\"false\" />\\n</map>#' " + file + ") && " +
    "sed -i 's#name=\"" + key + "\" value=\"[a-z]*\"#name=\"" + key + "\" value=\"" + value + "\"#' " + file
  return 'run-as ' + PKG + ' sh -c "' + esc.replace(/"/g, '\\"') + '"'
}

/** 用例表：每条只动外部真源，再读我方 getter（展示值 + 判定值同源）。 */
export const CASES = [
  {
    id: 'ST-01 all-files-access（权限类）',
    st: ['ST-01'],
    source: 'system: appops MANAGE_EXTERNAL_STORAGE',
    mutate: (adb, on) => adb(['appops', 'set', PKG, 'MANAGE_EXTERNAL_STORAGE', on ? 'allow' : 'deny']),
    observe: (page) => page.evaluate("window.androidBridge?.hasAllFilesAccess?.()"),
    expect: (on) => on,
    convergeMs: 3000,
  },
  {
    id: 'ST-02 overlay-enabled（权限类）',
    st: ['ST-02'],
    source: 'system: appops SYSTEM_ALERT_WINDOW + shell prefs shared_prefs/dsh-overlay.xml (enabled)',
    // 判定 = 偏好 && 系统权限 && 服务在场（ST-02）：只改系统权限腿不会翻转任何可观测值（getOverlayEnabled 返偏好，
    // 已登记在 bridge-symmetry-baseline 的 preferenceGetters），故本条同时改两处**外部真源**后再观测。
    mutate: (adb, on) => {
      adb(['appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', on ? 'allow' : 'deny'])
      return adb([prefsUpsertCommand('enabled', on, 'dsh-overlay')])
    },
    restartApp: true,
    observe: (page) => page.evaluate("window.androidBridge?.getOverlayEnabled?.()"),
    expect: (on) => on,
    convergeMs: 3000,
  },
  {
    id: 'ST-10 immersive-mode（配置类，壳偏好）',
    st: ['ST-10'],
    source: 'shell prefs: shared_prefs/dsh_settings.xml (immersive_mode；键可能缺席，故 upsert)',
    mutate: (adb, on) => adb([prefsUpsertCommand('immersive_mode', on)]),
    restartApp: true,
    observe: (page) => page.evaluate("window.androidBridge?.getImmersiveMode?.()"),
    expect: (on) => on,
    convergeMs: 5000,
  },
  {
    id: 'ST-11 dev-log-enabled（配置类，壳偏好）',
    st: ['ST-11'],
    source: 'shell prefs: shared_prefs/dsh_settings.xml (dev_log_enabled；键可能缺席，故 upsert)',
    mutate: (adb, on) => adb([prefsUpsertCommand('dev_log_enabled', on, 'dsh_prefs')]),
    restartApp: true,
    observe: (page) => page.evaluate("window.androidBridge?.getDevLogEnabled?.()"),
    expect: (on) => on,
    convergeMs: 5000,
  },
  {
    id: 'ST-12 a11y-control-channel（系统服务类）',
    st: ['ST-12'],
    source: 'system: settings put secure enabled_accessibility_services',
    mutate: (adb, on) => adb(['settings', 'put', 'secure', 'enabled_accessibility_services', on ? PKG + '/com.dsharnessmobile.shell.DeviceControlService' : 'null']),
    observe: (page) => page.evaluate("(function(){ try { return JSON.parse(window.androidBridge?.a11yStatus?.() ?? '{}').enabled } catch { return null } })()"),
    expect: (on) => on,
    convergeMs: 3000,
  },
]

/** 跑一条用例：改真源 -> 轮询观测 -> 报 PASS/FAIL 与收敛耗时。 */
export async function runCase(c, deps, on) {
  const t0 = Date.now()
  // 重启类用例必须先停应用再改盘上真源：运行中的进程会在 stop 时回写 SharedPreferences，把外部改写冲掉。
  if (c.restartApp) deps.adb(['am', 'force-stop', PKG])
  const mut = c.mutate(deps.adb, on)
  if (mut && mut.status !== 0) return { id: c.id, ok: false, ms: 0, detail: '真源改写失败: ' + (mut.err || mut.out) }
  if (c.restartApp) {
    deps.adb(['am', 'start', '-W', '-n', PKG + '/.MainActivity'])
    // 应用重启后 WebView target 与进程号都会换：由调用方重建 CDP 连接（自检模式无此钩子）。
    if (typeof deps.refreshPage === 'function') { try { await deps.refreshPage() } catch { /* 下一轮重试 */ } }
  }
  // 真源改写（appops/settings 变更）可能重启进程或把 App 挤到后台：观测前先拉回前台（§4.1.5 步骤 ②）。
  if (typeof deps.ensureForeground === 'function') { try { deps.ensureForeground() } catch { /* 下一轮重试 */ } }
  let seen = null
  let lastError = null
  // 重启类用例还要覆盖「引擎重新 LISTEN」的冷启动预算（本机实测 ~18s）：否则机制对了也会误报未收敛。
  const deadline = t0 + c.convergeMs + 7000 + (c.restartApp ? 25000 : 0)
  while (Date.now() < deadline) {
    try {
      seen = await c.observe(deps.page)
      lastError = null
    } catch (e) {
      lastError = e.message
      seen = '<observe error>'
    }
    if (seen === c.expect(on)) return { id: c.id, ok: true, ms: Date.now() - t0, detail: 'observed=' + seen }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { id: c.id, ok: false, ms: Date.now() - t0,
    detail: '未收敛：期望 ' + c.expect(on) + '，实测 ' + JSON.stringify(seen) + (lastError === null ? '' : '（观察错误: ' + lastError + '）') }
}

export async function runAll(cases, deps) {
  const results = []
  for (const c of cases) {
    for (const on of [true, false]) {
      const r = await runCase(c, deps, on)
      r.on = on
      results.push(r)
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + c.id + ' [真源=' + (on ? 'on' : 'off') + '] ' + r.ms + 'ms  ' + r.detail)
    }
  }
  return results
}

if (SELF_TEST) {
  // 桩驱动：观测值跟随「当前真源改写方向」，但 OVERLAY 在 on=true 时**故意返回错值**——
  // 证明脚本能把「只改真源但判定值没收敛」如实判红（脚本自身可红的故意失败样本）。
  const state = { on: true, failOverlayOn: true }
  const stubPage = {
    evaluate: async (expr) => {
      if (expr.includes('getOverlayEnabled')) {
        if (state.on && state.failOverlayOn) return false
        return state.on
      }
      if (expr.includes('a11yStatus')) return JSON.stringify({ enabled: state.on })
      return state.on
    },
  }
  const stubAdb = () => ({ status: 0, out: '', err: '' })
  const cases = [CASES[0], { ...CASES[1], convergeMs: 400 }, { ...CASES[2], convergeMs: 400 }]
  const results = []
  for (const c of cases) {
    for (const on of [true, false]) {
      state.on = on
      const r = await runCase(c, { adb: stubAdb, page: stubPage }, on)
      r.on = on
      results.push(r)
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + c.id + ' [真源=' + (on ? 'on' : 'off') + '] ' + r.ms + 'ms  ' + r.detail)
    }
  }
  const failed = results.filter((r) => !r.ok)
  const ok = failed.length === 1 && failed[0].id.includes('ST-02') && failed[0].on === true
  console.log('')
  console.log('SELF-TEST ' + (ok ? 'PASSED' : 'FAILED')
    + '（用例 ' + results.length + ' 条：PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length + '）')
  console.log('  FAIL 计数 = ' + failed.length + '（期望 1：ST-02 的桩返回与期望不符——故意失败样本被正确捕获）')
  process.exit(ok ? 0 : 1)
}

if (!SERIAL) { console.error('用法：--self-test 或 --serial <adb-serial> [--ws <cdp-ws-url>]'); process.exit(2) }
const adb = makeAdb(SERIAL)
const state = adb.raw(['get-state'])
if (!state.out.includes('device')) { console.error('adb 设备不可用: ' + (state.err || state.out)); process.exit(2) }
/** 解析当前 WebView CDP 地址：进程号会随应用重启变化，故每次（重）连都要重取 pid 与 forward。 */
const resolveWsUrl = async (force = false) => {
  if (WS && !force) return WS
  const pid = adb(['pidof', PKG]).out.trim()
  if (!pid) throw new Error('取不到 ' + PKG + ' 进程号；请先启动 App')
  adb.raw(['forward', 'tcp:29225', 'localabstract:webview_devtools_remote_' + pid])
  const list = JSON.parse(await (await fetch('http://127.0.0.1:29225/json/list')).text())
  if (!list[0]?.webSocketDebuggerUrl) throw new Error('CDP 列表为空（WebView 尚未加载完成）')
  return list[0].webSocketDebuggerUrl
}
let page = makeCdp(() => resolveWsUrl())
await page.evaluate('1').catch((e) => { console.error('CDP 初始化失败：' + e.message); process.exit(2) })
/** 应用重启/页面重载后由 runCase 调用：丢弃旧连接（下次求值自动重新解析 target）。 */
const refreshPage = async () => { try { page.close() } catch { /* 已关闭 */ } return page }
/** 每条用例观测前把 App 拉回前台（§4.1.5 步骤 ② 的「回到 App」）。 */
const ensureForeground = () => adb(['am', 'start', '-n', PKG + '/.MainActivity'])
// ── 设备状态快照/还原（队列卫生）：每条用例都收在 off，会把 a11y/权限/偏好留在关闭态并影响后续设备测试 ──
export function captureExternalState(adb) {
  const modeOf = (out) => { const m = /:\s*([a-z]+)\s*$/.exec(out.trim()); return m ? m[1] : null }
  const prefs = {}
  for (const [key, name] of [['immersive_mode', 'dsh_settings'], ['enabled', 'dsh-overlay'], ['dev_log_enabled', 'dsh_prefs']]) {
    const xml = adb(['run-as', PKG, 'cat', 'shared_prefs/' + name + '.xml']).out
    const m = new RegExp('name="' + key + '" value="([a-z]+)"').exec(xml)
    prefs[name + '/' + key] = m ? m[1] === 'true' : null
  }
  return {
    allFilesAccess: modeOf(adb(['appops', 'get', PKG, 'MANAGE_EXTERNAL_STORAGE']).out),
    overlay: modeOf(adb(['appops', 'get', PKG, 'SYSTEM_ALERT_WINDOW']).out),
    a11y: adb(['settings', 'get', 'secure', 'enabled_accessibility_services']).out.trim(),
    prefs,
  }
}
export function restoreExternalState(adb, snap) {
  const actions = []
  if (snap.allFilesAccess) { adb(['appops', 'set', PKG, 'MANAGE_EXTERNAL_STORAGE', snap.allFilesAccess]); actions.push('appops MANAGE_EXTERNAL_STORAGE=' + snap.allFilesAccess) }
  if (snap.overlay) { adb(['appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', snap.overlay]); actions.push('appops SYSTEM_ALERT_WINDOW=' + snap.overlay) }
  if (snap.a11y === 'null' || snap.a11y === '') adb(['settings', 'delete', 'secure', 'enabled_accessibility_services'])
  else adb(['settings', 'put', 'secure', 'enabled_accessibility_services', snap.a11y])
  actions.push('a11y=' + (snap.a11y || 'null'))
  for (const [k, v] of Object.entries(snap.prefs)) {
    if (v === null) continue
    const [name, key] = k.split('/')
    adb([prefsUpsertCommand(key, v, name)])
    actions.push(name + '/' + key + '=' + v)
  }
  return actions
}

const pageProxy = { evaluate: (expr) => page.evaluate(expr) }
const before = captureExternalState(adb)
console.log('设备初始真源快照：' + JSON.stringify(before))
try {
  const results = await runAll(CASES, { adb, page: pageProxy, refreshPage, ensureForeground })
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log('VERIFY-STATE-SYNC ' + (failed.length === 0 ? 'PASSED' : 'FAILED')
    + '（用例 ' + CASES.length + ' 条 × on/off = ' + results.length + ' 次断言：PASS '
    + (results.length - failed.length) + ' / FAIL ' + failed.length + '）')
  console.log('覆盖的 ST 条目：' + [...new Set(CASES.flatMap((c) => c.st))].join(', '))
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  try {
    const actions = restoreExternalState(adb, before)
    console.log('设备状态已还原到初始值：' + actions.join('；'))
  } catch (e) {
    console.error('设备状态还原失败（请人工核对 a11y/权限/偏好，避免影响后续设备测试）：' + e.message)
  }
  page.close()
}
