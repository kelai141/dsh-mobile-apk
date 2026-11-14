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
import { pathToFileURL } from 'node:url'

const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

const argv = process.argv.slice(2)
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? def) : def }
const SELF_TEST = argv.includes('--self-test')
const SERIAL = argOf('serial', '')
const PKG = argOf('pkg', 'com.dsharnessmobile.shell')
const WS = argOf('ws', '')
/**
 * CDP 转发用的 **host 端口**。
 *
 * 坑（2026-10-06 实测）：此处原先硬编码 `tcp:29225`。`adb forward` 的 host 端口属于 **adb server 全局**，
 * 并不随 `-s <serial>` 隔离 —— 于是本套件为 B 设备跑一次，就会把指向 A 设备的 `host:29225` 映射
 * 静默改指到 B。并行跑两台设备时，A 的后续 CDP 解析会连到 B 且**不报错**（拿到一个合法 ws）。
 * 现改为按 serial 派生独立端口，并允许 `--port` 显式指定；退出时移除该转发。
 */
const CDP_PORT = (() => {
  const explicit = Number(argOf('port', ''))
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  if (!SERIAL) return 29225
  let h = 0
  for (const ch of SERIAL) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return 29225 + (h % 100)
})()

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

/** 页面观测只执行调用方给出的只读表达式；缺桥不等于权限 false。 */
export function makeCdp(getWsUrl, {
  WebSocketImpl = globalThis.WebSocket, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let current = null
  let generation = 0
  let nextId = 1
  let forceResolve = false
  let lastDiagnostic = null
  const pending = new Map()
  const note = (kind, detail) => { lastDiagnostic = { kind, detail } }
  const reset = (reason = 'reset') => {
    const old = current
    current = null
    generation += 1
    forceResolve = true
    if (old) {
      old.cancelConnect?.()
      for (const [id, p] of pending) if (p.generation === old.generation) { pending.delete(id); p.finish({ retryable: true, reason }) }
      try { old.socket?.close() } catch { /* 已关闭 */ }
    }
  }
  const connect = async (timeoutMs) => {
    if (current) return current.ready
    const connection = { generation: ++generation, socket: null, ready: null, cancelConnect: null }
    current = connection
    const forced = forceResolve
    forceResolve = false
    connection.ready = new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimer(timer)
        connection.cancelConnect = null
        if (error) reject(error); else resolve(connection)
      }
      connection.cancelConnect = () => finish(new Error('CDP connection superseded'))
      timer = setTimer(() => {
        note('transport-not-ready', 'CDP connection timeout')
        finish(new Error('CDP connection timeout'))
        // 先结算真实原因，再reset；否则cancelConnect会把timeout误报成superseded。
        if (current === connection) reset('connect-timeout')
      }, timeoutMs)
      Promise.resolve().then(() => getWsUrl(forced)).then(url => {
        if (current !== connection) { finish(new Error('CDP connection superseded')); return }
        const socket = connection.socket = new WebSocketImpl(url)
        socket.onopen = () => current === connection ? finish() : finish(new Error('CDP connection superseded'))
        socket.onerror = () => {
          note('transport', 'CDP 连接失败（ws 不可达或目标已消失）')
          finish(new Error(lastDiagnostic.detail))
          if (current === connection) reset('socket-error')
        }
        socket.onclose = () => {
          // 旧 socket 的迟到 close 不能清掉已重解析的新 target，也不能结算新代次 pending。
          if (current !== connection) return
          finish(new Error('CDP target closed'))
          reset('target-closed')
        }
        socket.onmessage = event => {
          if (current !== connection) return
          try {
            const message = JSON.parse(event.data)
            const entry = pending.get(message.id)
            if (entry?.generation === connection.generation) { pending.delete(message.id); entry.finish(message) }
          } catch { /* 非 JSON 帧忽略 */ }
        }
      }).catch(error => { finish(error); if (current === connection) reset('resolve-failed') })
    })
    return connection.ready
  }
  const once = async (expression, timeoutMs) => {
    const deadline = now() + timeoutMs
    let connection
    try { connection = await connect(timeoutMs) } catch (error) {
      const detail = error.message ?? String(error)
      note('transport-not-ready', detail)
      return { retryable: true, reason: detail }
    }
    if (current !== connection) return { retryable: true, reason: 'superseded' }
    const remaining = deadline - now()
    if (remaining <= 0) return { retryable: true, reason: 'evaluate-budget-exhausted' }
    const id = nextId++
    const reply = await new Promise(resolve => {
      let timer
      const finish = value => { clearTimer(timer); resolve(value) }
      pending.set(id, { generation: connection.generation, finish })
      timer = setTimer(() => { if (pending.delete(id)) finish({ retryable: true, reason: 'evaluate-timeout' }) }, remaining)
      try {
        connection.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      } catch { pending.delete(id); finish({ retryable: true, reason: 'send-failed' }) }
    })
    if (reply.retryable) return reply
    if (reply.error) {
      const detail = 'CDP 错误: ' + JSON.stringify(reply.error)
      note('protocol-error', detail)
      if (/Cannot find context|Execution context.*(destroyed|not found)|Inspected target navigated|Session closed/i.test(detail)) return { retryable: true, reason: detail }
      throw new Error(detail)
    }
    if (reply.result?.exceptionDetails) {
      const detail = 'CDP JS exception: ' + JSON.stringify(reply.result.exceptionDetails)
      note('javascript-exception', detail)
      if (/Cannot find context|Execution context.*(destroyed|not found)|Inspected target navigated/i.test(detail)) return { retryable: true, reason: detail }
      // 信任/安全拒绝及真实 getter 异常必须显式失败，不能被当成 false 或静默重试。
      throw new Error(detail)
    }
    return { value: reply.result?.result?.value }
  }
  const evaluate = async (expression, { readOnlyBoolean = false, timeoutMs = 6000 } = {}) => {
    const deadline = now() + timeoutMs
    let result
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - now()
      if (remaining <= 0) break
      result = await once(expression, Math.min(3000, remaining))
      if (!result.retryable && (!readOnlyBoolean || typeof result.value === 'boolean')) return result.value
      note(result.retryable ? 'context-not-ready' : 'bridge-not-ready', result.reason ?? '只读 Boolean getter 未就绪（非 Boolean 回包）')
      reset(lastDiagnostic.kind)
    }
    return undefined
  }
  return { evaluate, reset, close: () => reset('closed'), diagnostic: () => lastDiagnostic }
}

/** 端点文件仅作精确 target 筛选，不是监听器归属/鉴权证明；getter 仍受壳侧可信帧门。 */
export function selectEngineTarget(list, engineOrigin) {
  const origin = new URL(engineOrigin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password) throw new Error('Invalid engine origin')
  const candidates = Array.isArray(list) ? list.filter(target => {
    try {
      const url = new URL(target.url)
      return target.type === 'page' && url.origin === origin.origin && url.pathname === '/' && typeof target.webSocketDebuggerUrl === 'string'
    } catch { return false }
  }) : []
  if (candidates.length !== 1) throw new Error('Engine main WebView target not ready or ambiguous (matches=' + candidates.length + ')')
  return candidates[0].webSocketDebuggerUrl
}

/**
 * 壳偏好 upsert 命令（单字符串 → 由 adb 交给设备 shell，避免嵌套引号被二次解析）：
 * 键在场则改值；键缺席则先在 </map> 前插入该键再改值（本轮实测 immersive_mode 在场、dev_log_enabled 缺席）。
 * 文件缺席（该设备从未用过对应开关，例如横屏机的 dsh_prefs.xml）时先落一个合法空 `<map>` 骨架再 upsert——
 * 与 SharedPreferences 自身写出的结构同形，读侧 `getBoolean(key, false)` 语义不变。
 * 路径 = 应用数据根下的 shared_prefs/<prefsName>.xml（ShellState.PREFS="dsh_settings"）。
 */
export function prefsUpsertCommand(key, on, prefsName = 'dsh_settings') {
  const value = on ? 'true' : 'false'
  const file = 'shared_prefs/' + prefsName + '.xml'
  const ensure = "[ -f " + file + " ] || { mkdir -p shared_prefs; printf '%s\\n' '<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\" ?>' '<map>' '</map>' > " + file + " ; } ; "
  const esc = "(grep -q 'name=\"" + key + "\"' " + file + " || sed -i 's#</map>#    <boolean name=\"" + key + "\" value=\"false\" />\\n</map>#' " + file + ") && " +
    "sed -i 's#name=\"" + key + "\" value=\"[a-z]*\"#name=\"" + key + "\" value=\"" + value + "\"#' " + file
  return 'run-as ' + PKG + ' sh -c "' + (ensure + esc).replace(/"/g, '\\"') + '"'
}

/** 用例表：每条只动外部真源，再读我方 getter（展示值 + 判定值同源）。 */
export const CASES = [
  {
    id: 'ST-01 all-files-access（权限类）',
    st: ['ST-01'],
    source: 'system: appops MANAGE_EXTERNAL_STORAGE',
    mutate: (adb, on) => adb(['appops', 'set', PKG, 'MANAGE_EXTERNAL_STORAGE', on ? 'allow' : 'deny']),
    observe: (page, options) => page.evaluate("window.androidBridge?.hasAllFilesAccess?.()", { ...options, readOnlyBoolean: true }),
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
    observe: (page, options) => page.evaluate("window.androidBridge?.getOverlayEnabled?.()", { ...options, readOnlyBoolean: true }),
    expect: (on) => on,
    convergeMs: 3000,
  },
  {
    id: 'ST-10 immersive-mode（配置类，壳偏好）',
    st: ['ST-10'],
    source: 'shell prefs: shared_prefs/dsh_settings.xml (immersive_mode；键可能缺席，故 upsert)',
    mutate: (adb, on) => adb([prefsUpsertCommand('immersive_mode', on)]),
    restartApp: true,
    observe: (page, options) => page.evaluate("window.androidBridge?.getImmersiveMode?.()", { ...options, readOnlyBoolean: true }),
    expect: (on) => on,
    convergeMs: 5000,
  },
  {
    id: 'ST-11 dev-log-enabled（配置类，壳偏好）',
    st: ['ST-11'],
    source: 'shell prefs: shared_prefs/dsh_settings.xml (dev_log_enabled；键可能缺席，故 upsert)',
    mutate: (adb, on) => adb([prefsUpsertCommand('dev_log_enabled', on, 'dsh_prefs')]),
    restartApp: true,
    observe: (page, options) => page.evaluate("window.androidBridge?.getDevLogEnabled?.()", { ...options, readOnlyBoolean: true }),
    expect: (on) => on,
    convergeMs: 5000,
  },
  {
    id: 'ST-12 a11y-control-channel（系统服务类）',
    st: ['ST-12'],
    source: 'system: settings put secure enabled_accessibility_services',
    mutate: (adb, on) => adb(['settings', 'put', 'secure', 'enabled_accessibility_services', on ? PKG + '/com.dsharnessmobile.shell.DeviceControlService' : 'null']),
    observe: (page, options) => page.evaluate("(function(){ const raw = window.androidBridge?.a11yStatus?.(); return raw === undefined ? undefined : JSON.parse(raw).enabled })()", { ...options, readOnlyBoolean: true }),
    expect: (on) => on,
    convergeMs: 3000,
  },
]

/** 跑一条用例：改真源 -> 轮询观测 -> 报 PASS/FAIL 与收敛耗时。 */
export async function runCase(c, deps, on) {
  const now = deps.now ?? Date.now
  const pause = deps.pause ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  const t0 = now()
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
  while (now() < deadline) {
    try {
      seen = await c.observe(deps.page, { timeoutMs: Math.min(6000, deadline - now()) })
      lastError = null
    } catch (e) {
      lastError = e.message
      seen = '<observe error>'
    }
    if (seen === c.expect(on)) return { id: c.id, ok: true, ms: now() - t0, detail: 'observed=' + seen, diagnostic: deps.page.diagnostic?.() ?? null }
    await pause(Math.min(250, Math.max(0, deadline - now())))
  }
  return { id: c.id, ok: false, ms: now() - t0,
    detail: '未收敛：期望 ' + c.expect(on) + '，实测 ' + String(JSON.stringify(seen)) + (lastError === null ? '' : '（观察错误: ' + lastError + '）'),
    diagnostic: deps.page.diagnostic?.() ?? null }
}

export async function runAll(cases, deps) {
  const results = []
  for (const c of cases) {
    for (const on of [true, false]) {
      const r = await runCase(c, deps, on)
      r.on = on
      results.push(r)
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + c.id + ' [真源=' + (on ? 'on' : 'off') + '] ' + r.ms + 'ms  ' + r.detail + (r.diagnostic ? '；诊断=' + JSON.stringify(r.diagnostic) : ''))
    }
  }
  return results
}

if (IS_MAIN && SELF_TEST) {
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
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + c.id + ' [真源=' + (on ? 'on' : 'off') + '] ' + r.ms + 'ms  ' + r.detail + (r.diagnostic ? '；诊断=' + JSON.stringify(r.diagnostic) : ''))
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

// ── 设备状态快照/还原（队列卫生）：每条用例都收在 off，会把 a11y/权限/偏好留在关闭态并影响后续设备测试 ──
export function captureExternalState(adb) {
  // appops get 的真实输出**带尾部元数据**，例如：
  //   SYSTEM_ALERT_WINDOW: allow; time=+1h40m49s830ms ago (running)
  //   MANAGE_EXTERNAL_STORAGE: deny; time=+9d2h16m55s675ms ago; rejectTime=+2h22m19s323ms ago
  // 旧实现用 /:\s*([a-z]+)\s*$/（要求行尾就是裸模式名），对以上两种真实形态**恒返回 null** ——
  // 于是 captureExternalState 的 allFilesAccess/overlay 恒为 null，restoreExternalState 的
  // `if (snap.overlay)` 恒为假，两个 appop **永不还原**，而末尾那行「设备状态已还原到初始值」照常打印，
  // 形成「看起来绿、实际漏还原」的假绿。改为取第一个冒号后的模式 token（可后接 ; 或空白或行尾）。
  const modeOf = (out) => {
    const m = /^[A-Z_]+:\s*([a-z]+)(?:\s*;|\s*$)/m.exec(out.trim())
    return m ? m[1] : null
  }
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
  // 捕获为 null = 我们没能读到升级前的值 ⇒ 不能假装还原过：显式记入 actions 以便在结论行里可见。
  // （旧实现在此静默跳过，是 D1 假绿的另一半成因。）
  for (const [label, key] of [['MANAGE_EXTERNAL_STORAGE', 'allFilesAccess'], ['SYSTEM_ALERT_WINDOW', 'overlay']]) {
    const v = snap[key]
    if (v) { adb(['appops', 'set', PKG, label, v]); actions.push('appops ' + label + '=' + v) }
    else actions.push('appops ' + label + '=未还原（捕获值为 null）')
  }
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

if (IS_MAIN && !SELF_TEST) {
if (!SERIAL) { console.error('用法：--self-test 或 --serial <adb-serial> [--ws <cdp-ws-url>]'); process.exit(2) }
const adb = makeAdb(SERIAL)
const state = adb.raw(['get-state'])
if (!state.out.includes('device')) { console.error('adb 设备不可用: ' + (state.err || state.out)); process.exit(2) }
/** 解析当前 WebView CDP 地址：进程号会随应用重启变化，故每次（重）连都要重取 pid 与 forward。 */
const resolveWsUrl = async (force = false) => {
  if (WS && !force) return WS
  const process = adb(['pidof', PKG])
  const pid = process.out.trim()
  if (process.status !== 0 || !/^[0-9]+$/.test(pid)) throw new Error('主进程 PID 缺失或不唯一；WebView 尚未就绪')
  const forwarded = adb.raw(['forward', 'tcp:' + CDP_PORT, 'localabstract:webview_devtools_remote_' + pid])
  if (forwarded.status !== 0) throw new Error('CDP forward 失败: ' + forwarded.err)
  const saved = adb(['cat', 'files/.engine-endpoint.json'], { runAs: true })
  const endpoint = saved.status === 0 ? JSON.parse(saved.out) : null
  if (endpoint?.schema !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('引擎端点偏好尚不可读，不能猜 target 端口')
  const response = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list', { signal: AbortSignal.timeout(2500) })
  if (!response.ok) throw new Error('CDP target 列表 HTTP ' + response.status)
  return selectEngineTarget(await response.json(), 'http://127.0.0.1:' + endpoint.port)
}
const page = makeCdp((force) => resolveWsUrl(force))
await page.evaluate('1').catch((e) => { console.error('CDP 初始化失败：' + e.message); process.exit(2) })
/** 应用重启/页面重载后由 runCase 调用：丢弃旧连接（下次求值自动重新解析 target）。 */
const refreshPage = async () => { try { page.close() } catch { /* 已关闭 */ } return page }
/** 每条用例观测前把 App 拉回前台（§4.1.5 步骤 ② 的「回到 App」）。 */
const ensureForeground = () => adb(['am', 'start', '-n', PKG + '/.MainActivity'])
/**
 * 权限类改写（appops deny）会杀死宿主进程，WebView 与 CDP target 同时消失。
 *
 * 这里只做「进程不在就把它拉起来」这一件设备事实驱动的补救：返回 true 表示本次重建过，
 * 调用方据此丢弃旧 CDP 连接；进程本来就活着时返回 false，不打断正常运行的同一次观测。
 */
const ensureAlive = async () => {
  const pid = adb(['shell', 'pidof', PKG])
  if (pid.status === 0 && String(pid.out).trim() !== '') return false
  adb(['am', 'start', '-W', '-n', PKG + '/.MainActivity'])
  // 冷启动到引擎 LISTEN 本机实测约 18s：给足预算，避免把「还没起来」误判成「值不对」。
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const again = adb(['shell', 'pidof', PKG])
    if (again.status === 0 && String(again.out).trim() !== '') { await new Promise(r => setTimeout(r, 1500)); return true }
    await new Promise(r => setTimeout(r, 500))
  }
  return true
}
const pageProxy = { evaluate: (expr, options) => page.evaluate(expr, options), diagnostic: () => page.diagnostic() }
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
  try { adb.raw(['forward', '--remove', 'tcp:' + CDP_PORT]) } catch { /* 未建立或已被移除 */ }
  page.close()
}

}
