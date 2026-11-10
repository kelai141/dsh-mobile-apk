#!/usr/bin/env node
// verify-linux-environment.mjs — Linux 环境的 CDP 层验收（设备侧判据）。
//
// 为什么不能只看一个接口：`/api/android/linux-environment/status` 是引擎归一化后的**自述**，
// 只能证明「引擎说装好了」；`linuxAssetPrepare` 是壳侧唯一的资产落盘入口，只看桥的返回也只能
// 证明「桥被调用了」。本脚本把两者串起来，并用**错误摘要负控**证明壳侧真的在验摘要：
// 只有「准备失败 + 稳定错误码 + 没有发布产物」同时成立，才能排除「下载成功就算成功」。
//
// 用法：
//   node scripts/verify-linux-environment.mjs --serial 127.0.0.1:16384 [--port 29225] [--json]
//
// 判据（逐条打印 PASS/FAIL）：
//   a) GET /api/android/linux-environment/status 返回 installed=true 且 runtime.healthy=true
//   b) runtime.version 非空，且 runtimes[] 中存在 installed=true 的 runtime
//   c) 经页面内 window.androidBridge 用错误 sha256 预置 plugins.bootstrap，轮询到 failed，
//      断言 code === 'linux-asset-digest-mismatch' 且 stagedPath 为空
//   d) 错误 sha 与声明 sha 不同（负控自身可信）
//
// 退出码：0 全部 PASS；1 任一 FAIL；2 环境前置缺失（adb 设备/CDP 页面连不上等），不判红。
// 注意：`window.androidBridge` 缺席算 FAIL——它是被测壳侧的一部分，不是环境前置。
//
// --json：stdout 只输出一份 JSON 报告，逐条 PASS/FAIL 的人读行改走 stderr（便于管道消费）。

import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => { const index = argv.indexOf('--' + name); return index >= 0 ? (argv[index + 1] ?? fallback) : fallback }
const SERIAL = argOf('serial', '')
const PORT = Number(argOf('port', '29225'))
const JSON_OUTPUT = argv.includes('--json')

if (!SERIAL) {
  console.error('用法：node scripts/verify-linux-environment.mjs --serial <adb-serial> [--port <cdp-port>] [--json]')
  process.exit(2)
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('--port 必须是 1..65535 的整数')
  process.exit(2)
}

const APP_ID = 'com.dsharnessmobile.shell'
/** 负控要真的下完一个资产才算数，给足下载时间；正常只需数秒。 */
const ASSET_TIMEOUT_MS = 15 * 60 * 1000

const report = {
  script: 'verify-linux-environment',
  serial: SERIAL,
  port: PORT,
  page: null,
  checks: [],
  result: null,
  error: null,
  exitCode: null,
}

/** --json 时人读行让位给 stdout 的 JSON，统一走 stderr。 */
const say = (line) => { if (JSON_OUTPUT) console.error(line); else console.log(line) }
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

class EnvironmentError extends Error {}

const preview = (value, max = 300) => {
  let text
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
  if (text === undefined) text = String(value)
  return text.length > max ? text.slice(0, max) + '…' : text
}

const parseJson = (value) => {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 翻转摘要首字符：只要声明摘要是 64 位十六进制，翻转结果必然与它不同（由判据 d 兜底）。 */
const flipFirstCharacter = (sha) => (sha[0] === '0' ? '1' : '0') + sha.slice(1)

/** adb 封装：返回原始结果，调用方自己决定哪一步算前置失败。 */
const adb = (args) => {
  const result = spawnSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 20_000 })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

const assertDeviceOnline = () => {
  const state = adb(['get-state'])
  if (state.error) throw new EnvironmentError('adb 不可用：' + state.error.message)
  if (state.status !== 0 || state.stdout.trim() !== 'device') {
    throw new EnvironmentError('设备 ' + SERIAL + ' 不可达（adb get-state=' + (state.stdout.trim() || state.stderr.trim() || 'unknown') + '）')
  }
}

/** 应用主进程号：webview_devtools_remote_<pid> 的 pid 就是它。 */
const appPid = () => {
  const direct = adb(['shell', 'pidof', APP_ID])
  const candidate = direct.stdout.trim().split(/\s+/).find((item) => /^\d+$/.test(item))
  if (candidate !== undefined) return candidate
  // 少数设备没有 pidof：退回 ps -A，按包名找。列序 USER PID ...，PID 在第 2 列。
  const ps = adb(['shell', 'ps', '-A'])
  const line = ps.stdout.split(/\r?\n/).find((item) => item.includes(APP_ID))
  const pid = line?.trim().split(/\s+/)[1]
  if (pid === undefined || !/^\d+$/.test(pid)) {
    throw new EnvironmentError('应用未运行：找不到 ' + APP_ID + ' 的进程（先启动应用并等引擎页面加载完）')
  }
  return pid
}

/**
 * 把 CDP 端口重新绑到 --serial 指向的这台设备。
 *
 * `/json/list` 只是本机端口，不校验设备身份；端口若还挂在上一台机器上，后面的断言会全部
 * 打到错误的设备上。重新 forward 是唯一能把「serial」和「页面」绑在一起的动作。
 */
const forwardCdp = (pid) => {
  adb(['forward', '--remove', 'tcp:' + PORT])
  const forwarded = adb(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid])
  if (forwarded.status !== 0) {
    throw new EnvironmentError('adb forward 失败：' + (forwarded.stderr.trim() || forwarded.stdout.trim() || 'unknown'))
  }
}

const readTargets = async () => {
  const response = await fetch('http://127.0.0.1:' + PORT + '/json/list', { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const list = await response.json()
  if (!Array.isArray(list)) throw new Error('target list 不是数组')
  return list
}

const waitForTargets = async (pid) => {
  let lastError = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await readTargets() } catch (error) { lastError = error; await sleep(500) }
  }
  const sockets = adb(['shell', 'cat', '/proc/net/unix'])
  const present = sockets.stdout.includes('webview_devtools_remote_' + pid)
  throw new EnvironmentError(
    'CDP 端口 ' + PORT + ' 不可达：' + (lastError?.message ?? 'unknown') +
    (present ? '' : '（设备上没有 webview_devtools_remote_' + pid + '，WebView 调试未开启或 WebView 还没初始化）'),
  )
}

/** 优先选 http://127.0.0.1 的引擎根页面，避免误选 devtools 或其它内嵌页。 */
const scoreTarget = (target) => {
  let score = target.url.startsWith('http://127.0.0.1') ? 2 : 0
  try { if (new URL(target.url).pathname === '/') score += 1 } catch { /* URL 不合规就不加分 */ }
  return score
}

const openSocket = async (url) => {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new EnvironmentError('CDP WebSocket 连接超时')) }, 8_000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new EnvironmentError('CDP WebSocket 连接失败')) }, { once: true })
  })
  return ws
}

/** 一次一个 Runtime.evaluate；每个 id 独立等自己的回包，异常/超时都拒绝。 */
const makeEvaluator = (ws) => {
  let sequence = 0
  return (expression, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = ++sequence
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      fn(value)
    }
    const onMessage = (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.id !== id) return
      if (message.error) { finish(reject, new Error('CDP error: ' + JSON.stringify(message.error))); return }
      if (message.result?.exceptionDetails) {
        finish(reject, new Error('页面抛异常：' + (message.result.exceptionDetails.text ?? 'unknown')))
        return
      }
      finish(resolve, message.result?.result?.value)
    }
    const onClose = () => finish(reject, new Error('CDP WebSocket 在求值期间关闭'))
    const timer = setTimeout(() => finish(reject, new Error('CDP evaluate 超时（' + timeoutMs + 'ms）')), timeoutMs)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

// 页内取数一律与设置页 transport.ts 同形：同源、带 cookie、no-store、只读 GET。
// 不给 /api 加任何自定义头——页面自己能读到的，验收也必须能读到；加头会掩盖真实鉴权/路由问题。
const STATUS_EXPR = `(async () => {
  try {
    const response = await fetch('/api/android/linux-environment/status', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    let payload = null
    try { payload = await response.json() } catch {}
    return { status: response.status, payload }
  } catch (error) {
    return { status: 0, error: String(error && error.message || error) }
  }
})()`

const MANIFEST_EXPR = `(async () => {
  try {
    const response = await fetch('/api/android/linux-environment/manifest', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    let payload = null
    try { payload = await response.json() } catch {}
    return { status: response.status, payload }
  } catch (error) {
    return { status: 0, error: String(error && error.message || error) }
  }
})()`

// 只在 manifest 为空时补一次手动 check（与设置页行为一致）；check 不需要 confirmed 体。
const CHECK_EXPR = `(async () => {
  try {
    const response = await fetch('/api/android/linux-environment/check', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    let payload = null
    try { payload = await response.json() } catch {}
    return { status: response.status, payload }
  } catch (error) {
    return { status: 0, error: String(error && error.message || error) }
  }
})()`

const PREPARE_STATUS_EXPR = `(() => {
  try {
    if (!window.androidBridge || typeof window.androidBridge.linuxAssetPrepareStatus !== 'function') {
      return JSON.stringify({ phase: 'error', code: 'linux-asset-bridge-missing', detail: 'window.androidBridge.linuxAssetPrepareStatus 不可用' })
    }
    return String(window.androidBridge.linuxAssetPrepareStatus())
  } catch (error) {
    return JSON.stringify({ phase: 'error', code: 'linux-asset-bridge-threw', detail: String(error && error.message || error) })
  }
})()`

const prepareExpr = (specJson) => `(() => {
  try {
    const bridge = window.androidBridge
    if (!bridge || typeof bridge.linuxAssetPrepare !== 'function') {
      return { supported: false, code: 'linux-asset-bridge-missing', detail: 'window.androidBridge.linuxAssetPrepare 不可用' }
    }
    return { supported: true, raw: String(bridge.linuxAssetPrepare(${JSON.stringify(specJson)})) }
  } catch (error) {
    return { supported: true, code: 'linux-asset-bridge-threw', detail: String(error && error.message || error) }
  }
})()`

/** 读取 manifest；为空时补一次 check 再读，返回 `manifest` 对象本身。 */
const readManifest = async (evaluate) => {
  let result = await evaluate(MANIFEST_EXPR, 30_000)
  if (!result || result.status !== 200) {
    throw new Error('manifest 请求失败：HTTP ' + (result?.status ?? 0) + ' ' + preview(result?.payload ?? result?.error))
  }
  let manifest = result.payload?.manifest ?? null
  if (manifest === null) {
    const checked = await evaluate(CHECK_EXPR, 180_000)
    if (!checked || checked.status !== 200) {
      throw new Error('manifest 为空，补 POST /check 也失败：HTTP ' + (checked?.status ?? 0) + ' ' + preview(checked?.payload ?? checked?.error))
    }
    result = await evaluate(MANIFEST_EXPR, 30_000)
    if (!result || result.status !== 200) throw new Error('check 后重读 manifest 失败：HTTP ' + (result?.status ?? 0))
    manifest = result.payload?.manifest ?? null
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest 为空：引擎没有 pinned/available 清单，取不到真实资产')
  }
  return manifest
}

const recordCheck = async (id, title, body) => {
  const startedAt = Date.now()
  try {
    const detail = await body()
    report.checks.push({ id, title, status: 'PASS', detail: detail ?? '', ms: Date.now() - startedAt })
    say('PASS ' + id + ' ' + title + (detail ? '  -> ' + detail : ''))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    report.checks.push({ id, title, status: 'FAIL', detail, ms: Date.now() - startedAt })
    say('FAIL ' + id + ' ' + title + '  -> ' + detail)
  }
}

let activeSocket = null

const run = async () => {
  assertDeviceOnline()
  const pid = appPid()
  forwardCdp(pid)
  const targets = await waitForTargets(pid)

  const candidates = targets.filter((target) => target
    && target.type === 'page'
    && typeof target.url === 'string'
    && target.url.includes('127.0.0.1'))
  if (candidates.length === 0) {
    throw new EnvironmentError('CDP 列表里没有 url 含 127.0.0.1 的 page target（看到：' + preview(targets.map((target) => target.type + ' ' + target.url), 500) + '）')
  }
  const page = candidates.slice().sort((left, right) => scoreTarget(right) - scoreTarget(left))[0]
  if (typeof page.webSocketDebuggerUrl !== 'string' || page.webSocketDebuggerUrl === '') {
    throw new EnvironmentError('目标页面没有 webSocketDebuggerUrl：' + preview(page))
  }
  report.page = { title: page.title ?? null, url: page.url }
  say('TARGET ' + (page.title ?? '(untitled)') + ' ' + page.url)

  activeSocket = await openSocket(page.webSocketDebuggerUrl)
  const evaluate = makeEvaluator(activeSocket)

  let statusProbe = null
  let declaredSha = ''
  let wrongSha = ''

  // 判据 a：installed 是 bootstrap 落盘状态，runtime.healthy 是运行时管理器对实例的实测探针
  // （launcher/rootfs/backend 在不在、能不能起）。只看 installed 会把「装过但起不来」判绿；
  // 反过来只看 healthy 又会在未安装时混过去，所以两条都要。
  // 不拿 status.error 当红线：历史失败会留在该字段里，会制造假红（实测设备上就带着旧错误）。
  await recordCheck('a', 'status 报 installed=true 且 runtime.healthy=true', async () => {
    statusProbe = await evaluate(STATUS_EXPR, 30_000)
    if (!statusProbe || typeof statusProbe !== 'object') throw new Error('status 接口没有返回可解析的对象')
    if (statusProbe.error) throw new Error('status 请求失败：' + statusProbe.error)
    if (statusProbe.status !== 200) throw new Error('status HTTP ' + statusProbe.status + '：' + preview(statusProbe.payload))
    const body = statusProbe.payload
    if (body === null || typeof body !== 'object') throw new Error('status 响应不是 JSON 对象')
    if (body.installed !== true) throw new Error('installed=' + JSON.stringify(body.installed) + '（环境未安装或状态没落盘）')
    const runtime = body.runtime
    if (runtime === null || typeof runtime !== 'object') throw new Error('runtime 字段缺失：' + preview(runtime))
    if (runtime.healthy !== true) {
      throw new Error('runtime.healthy=' + JSON.stringify(runtime.healthy) + '，state=' + JSON.stringify(runtime.state) + '（运行时实例实测不健康）')
    }
    return 'installed=true, runtime.healthy=true, state=' + (runtime.state ?? '?')
  })

  // 判据 b：version 来自已激活的 runtime（安装产物），runtimes[] 是设置页可选的清单。
  // 空 version = 运行时没有真的报告版本（桥接/实例断了）；runtimes[] 全不是 installed
  // = 安装记录与运行时清单脱节，用户即使看到「已安装」也无法在设置页选中/重装。
  await recordCheck('b', 'runtime.version 非空且 runtimes[] 中有 installed=true', async () => {
    const body = statusProbe?.payload
    if (body === null || body === undefined) throw new Error('没有可用的 status 响应（判据 a 未取到数据）')
    const runtime = body.runtime
    const version = typeof runtime?.version === 'string' ? runtime.version.trim() : ''
    if (version === '') throw new Error('runtime.version 为空：' + preview(runtime?.version))
    const runtimes = Array.isArray(body.runtimes) ? body.runtimes : []
    const installed = runtimes.filter((entry) => entry && entry.installed === true).map((entry) => entry.id ?? '?')
    if (installed.length === 0) throw new Error('runtimes[] 中没有 installed=true：' + preview(runtimes))
    return 'runtime.version=' + version + ', installed=[' + installed.join(',') + ']'
  })

  // 判据 c：负控，不是正控。真实资产 + 错误摘要，宿主必须下载完整字节、算摘要、发现不符、
  // 失败关闭。任何一环被省略都会让本条变红：
  //   - phase=ok            => 摘要校验根本没生效（错误字节被当成可用产物）；
  //   - code 不是 digest    => 失败原因不对（例如根本没下到字节，只证明网络坏了）；
  //   - stagedPath 非空     => 失败后仍留下「看似可安装」的产物，是更危险的假绿。
  // 选 plugins.bootstrap 是因为它体量最小（数十 KB），负控秒级完成，不碰 rootfs 和用户数据。
  // 前置：本条要求设备真的能取回 manifest 资产。debug 构建若配置了 `debug-download-origin`，
  // 本地回放服务必须在场；不在场时失败码是 linux-asset-download-failed。脚本仍按 FAIL 处理：
  // 「取不到字节」不能证明摘要校验正确，下载路径本身也是被测能力。
  await recordCheck('c', '错误 sha256 预置 plugins.bootstrap 必须 digest-mismatch 且不发布产物', async () => {
    const manifest = await readManifest(evaluate)
    const asset = manifest.plugins?.bootstrap
    if (asset === null || typeof asset !== 'object') throw new Error('manifest.plugins.bootstrap 缺失')
    if (typeof asset.url !== 'string' || asset.url === '') throw new Error('plugins.bootstrap.url 缺失')
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error('plugins.bootstrap.sha256 不是 64 位小写十六进制：' + preview(asset.sha256))
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error('plugins.bootstrap.size 非法：' + preview(asset.size))
    declaredSha = asset.sha256
    wrongSha = flipFirstCharacter(declaredSha)

    const specJson = JSON.stringify({ url: asset.url, sha256: wrongSha, size: asset.size, kind: 'plugin' })
    const startDeadline = Date.now() + 120_000
    let answer = null
    for (;;) {
      const started = await evaluate(prepareExpr(specJson), 30_000)
      if (!started || started.supported !== true) {
        throw new Error('window.androidBridge.linuxAssetPrepare 不可用：' + preview(started))
      }
      if (started.code) throw new Error('linuxAssetPrepare 抛错：' + started.detail)
      answer = parseJson(started.raw)
      if (answer === null) throw new Error('linuxAssetPrepare 返回不可解析：' + preview(started.raw))
      if (answer.ok === true) break
      if (answer.code === 'linux-asset-busy' && Date.now() < startDeadline) { await sleep(1_000); continue }
      throw new Error('linuxAssetPrepare 拒绝了负控：' + preview(answer))
    }

    const deadline = Date.now() + ASSET_TIMEOUT_MS
    let snapshot = null
    for (;;) {
      const raw = await evaluate(PREPARE_STATUS_EXPR, 30_000)
      snapshot = parseJson(raw)
      if (snapshot === null) throw new Error('linuxAssetPrepareStatus 返回不可解析：' + preview(raw))
      const phase = typeof snapshot.phase === 'string' ? snapshot.phase : ''
      if (phase === 'failed') break
      if (phase === 'ok') {
        throw new Error('错误摘要居然准备成功（phase=ok, stagedPath=' + preview(snapshot.stagedPath) + '）：摘要校验没有生效')
      }
      if (phase === 'idle') throw new Error('负控状态丢失（phase=idle）：桥侧没有保留这次准备')
      if (phase === 'error') throw new Error('linuxAssetPrepareStatus 出错：' + preview(snapshot))
      if (phase === '') throw new Error('linuxAssetPrepareStatus 没有 phase：' + preview(snapshot))
      if (Date.now() > deadline) throw new Error('等待 failed 超时（最后 phase=' + phase + '）')
      await sleep(1_000)
    }

    if (snapshot.code !== 'linux-asset-digest-mismatch') {
      throw new Error('失败码不是 linux-asset-digest-mismatch：' + preview({ code: snapshot.code, detail: snapshot.detail }))
    }
    if (snapshot.stagedPath !== null && snapshot.stagedPath !== undefined && snapshot.stagedPath !== '') {
      throw new Error('失败后仍发布了暂存产物：stagedPath=' + snapshot.stagedPath)
    }
    return 'code=linux-asset-digest-mismatch, stagedPath 为空, detail=' + preview(snapshot.detail)
  })

  // 判据 d：负控自身的可信度。若翻转没有改变摘要（或清单摘要非法），c 就变成「用正确摘要预置」
  // 的正控，失败码永远等不到 digest-mismatch，整条负控失去意义——先钉死这一点。
  await recordCheck('d', '错误 sha 与声明 sha 不同（负控自身不能是同值）', async () => {
    if (declaredSha === '' || wrongSha === '') throw new Error('没有从 manifest 拿到 bootstrap 的 sha256')
    if (!/^[a-f0-9]{64}$/.test(declaredSha)) throw new Error('声明 sha256 格式异常：' + preview(declaredSha))
    if (!/^[a-f0-9]{64}$/.test(wrongSha)) throw new Error('错误 sha256 格式异常：' + preview(wrongSha))
    if (declaredSha === wrongSha) throw new Error('翻转后仍与声明相同：' + declaredSha)
    return 'declared=' + declaredSha.slice(0, 12) + '…, wrong=' + wrongSha.slice(0, 12) + '…'
  })

  return report.checks.every((entry) => entry.status === 'PASS') ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await run()
} catch (error) {
  const environment = error instanceof EnvironmentError
  report.error = error.message
  exitCode = environment ? 2 : 1
  say((environment ? 'ENVIRONMENT: ' : 'ERROR: ') + error.message)
} finally {
  if (activeSocket !== null) { try { activeSocket.close() } catch { /* 已关闭 */ } }
}

report.exitCode = exitCode
report.result = exitCode === 0 ? 'pass' : exitCode === 2 ? 'environment' : 'fail'
report.error = report.error ?? null

if (JSON_OUTPUT) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else if (exitCode === 0) {
  console.log('VERIFY-LINUX-ENVIRONMENT PASSED')
} else if (exitCode === 1) {
  console.error('VERIFY-LINUX-ENVIRONMENT FAILED')
}

process.exitCode = exitCode
