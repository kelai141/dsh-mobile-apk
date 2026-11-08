#!/usr/bin/env node
// verify-plugin-sample-device.mjs — 第三方插件真实功能用例的设备适配器。
//
// 回答一个问题：装好的第三方插件，它的**真实功能面**在设备上是不是真的能用。
// 本脚本只做观测与判定：不改第三方插件、不改产物、不伪造结果。
//
// 首个用例：dsh-task-ledger 0.1.8 的只读端点 GET /api/task-ledger/identity。
// 判据见 scripts/lib/plugin-sample-task-ledger-identity.mjs（CASE_EXPECT）。
//
// 三层取值，缺一层即为未验：
//   1) 组件面：pluginManager/listPlugins 里有该插件的行，enabled=true 且 fiberPhase=active；
//   2) 功能面：页面上下文里请求该端点，返回 200 与可解析 JSON（纯函数判定见上）；
//   3) 证据面：原始响应、判定结果、环境信息逐条落盘。
//
// 设备层可注入：--self-test 与 --from-fixture 都**不调用 adb**、不连接任何设备，
// 因此不会占用他人的 ADB 实例。真实模式必须显式给 --serial。
//
// 用法：
//   node scripts/verify-plugin-sample-device.mjs --self-test
//   node scripts/verify-plugin-sample-device.mjs --from-fixture <dir>
//   node scripts/verify-plugin-sample-device.mjs --serial <adb-serial> [--timeout 60] [--out <dir>]
//   node scripts/verify-plugin-sample-device.mjs --serial <s> --evidence <evidence.json>   # 把实测结论写进证据格子
// 退出码：0 全绿 / 1 判红 / 2 未验或不满足前置（不得当通过）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CASE_EXPECT,
  IDENTITY_ROUTE,
  judgeIdentity,
  pickInstalledRow,
  toEvidenceCase,
} from './lib/plugin-sample-task-ledger-identity.mjs'
import { applyCase } from './lib/plugin-sample-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLAN = join(HERE, 'plugin-test-samples.json')
const SAMPLE_ID = 's05-task-ledger'
const MODULE_NAME = 'dsh-task-ledger'
const PKG = 'com.dsharnessmobile.shell'

const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? '') : '' }
const has = (n) => argv.includes('--' + n)

/**
 * 页面上取端点结果。
 *
 * 走页面自身的 fetch：引擎的 /api 需要浏览器签名的 cookie，页面已持有，脚本不去伪造鉴权。
 * @param {string} route 端点路径。
 * @returns {Promise<{status: number|null, body: string|null, error: string|null}>}
 */
export const PAGE_PROBE = (route) => [
  '(async () => {',
  '  try {',
  '    const res = await fetch(' + JSON.stringify(route) + ', { cache: \'no-store\', credentials: \'same-origin\' })',
  '    const text = await res.text()',
  '    return { status: res.status, body: text, error: null }',
  '  } catch (e) {',
  '    return { status: null, body: null, error: String((e && e.message) || e) }',
  '  }',
  '})()',
].join('\n')

export const PAGE_LIST_PLUGINS = [
  '(async () => {',
  '  try {',
  "    const res = await fetch('/api/pluginManager/listPlugins', {",
  "      method: 'POST',",
  "      credentials: 'same-origin',",
  "      headers: { 'content-type': 'application/json' },",
  "      body: JSON.stringify({ type: 'client-request', rpcId: 'plugin-sample-list', method: 'pluginManager/listPlugins', payload: { args: {} } }),",
  "    })",
  '    const text = await res.text()',
  '    return { status: res.status, body: text, error: null }',
  '  } catch (e) {',
  '    return { status: null, body: null, error: String((e && e.message) || e) }',
  '  }',
  '})()',
].join('\n')

/**
 * 从 listPlugins 的响应文本里取行数组。
 *
 * 两种形态都接受：RPC 信封（result.value 是数组）与直接数组。
 * @param {unknown} text 响应体。
 * @returns {any[]|null} 行数组；拿不到返回 null（不是空数组）。
 */
export function rowsFromListPlugins(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (Array.isArray(parsed)) return parsed
  const value = parsed?.result?.value
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  return null
}

/**
 * 把一次完整观测折成结论。
 *
 * 三层缺一即未验：没有组件面证据，功能面即使 200 也不能证明插件在跑。
 * @param {{rows: any[]|null, probe: any}} observation 观测。
 * @returns {{verdict: string, detail: string, layers: object}}
 */
export function judgeSample(observation) {
  const rows = observation?.rows ?? null
  const probe = observation?.probe ?? null
  const row = rows === null ? { found: false, enabled: null, phase: null, entryId: null } : pickInstalledRow(rows, MODULE_NAME)
  const functional = judgeIdentity(probe)

  const layers = {
    component: rows === null
      ? { verdict: 'INCONCLUSIVE', detail: '取不到组件清单' }
      : row.found
        ? (row.enabled === true && row.phase === 'active'
          ? { verdict: 'PASS', detail: 'entryId=' + row.entryId + ' enabled=true fiberPhase=active' }
          : { verdict: 'FAIL', detail: 'entryId=' + row.entryId + ' enabled=' + row.enabled + ' fiberPhase=' + row.phase })
        : { verdict: 'FAIL', detail: '组件清单里没有 moduleName=' + MODULE_NAME + ' 的行' },
    functional,
  }

  const failed = Object.values(layers).find((l) => l.verdict === 'FAIL')
  if (failed) return { verdict: 'FAIL', detail: failed.detail, layers }
  const unmeasured = Object.values(layers).find((l) => l.verdict !== 'PASS')
  if (unmeasured) return { verdict: 'INCONCLUSIVE', detail: unmeasured.detail, layers }
  return { verdict: 'PASS', detail: '组件面与功能面都通过：' + functional.detail, layers }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const writeEvidence = (dir, name, value) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}

/** 从固定夹具目录读观测（离线，不碰设备）。 */
const readFixture = (dir) => {
  const rowsFile = join(dir, 'list-plugins.json')
  const probeFile = join(dir, 'identity-response.json')
  const rows = existsSync(rowsFile) ? rowsFromListPlugins(readFileSync(rowsFile, 'utf8')) : null
  const probe = existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, 'utf8')) : null
  return { rows, probe, files: { rowsFile, probeFile } }
}

const report = (result, outDir, inputs) => {
  const lines = []
  lines.push('PLUGIN-SAMPLE ' + result.verdict + '（' + SAMPLE_ID + ' ' + MODULE_NAME + '）')
  lines.push('  期望：' + CASE_EXPECT)
  for (const [name, layer] of Object.entries(result.layers ?? {})) {
    lines.push('  ' + layer.verdict.padEnd(12) + name + ' :: ' + layer.detail)
  }
  lines.push('  结论：' + result.detail)
  const text = lines.join('\n') + '\n'
  if (outDir) {
    writeEvidence(outDir, 'verdict.txt', text)
    const evidenceCase = toEvidenceCase({ verdict: result.verdict, detail: result.detail, reason: result.verdict === 'FAIL' ? 'layer-failed' : undefined }, ['verdict.txt', 'observation.json'])
    writeEvidence(outDir, 'evidence-case.json', evidenceCase)
    // --evidence：把实测结论写进证据文件的对应格子。默认不写，输入永远保持未测。
    const evidenceFile = argOf('evidence')
    if (evidenceFile !== '') {
      const file = resolve(evidenceFile)
      const evidence = JSON.parse(readFileSync(file, 'utf8'))
      applyCase(evidence, SAMPLE_ID, evidenceCase)
      writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n')
      process.stdout.write('  已写入证据：' + file + '（' + evidenceCase.status + '）\n')
    }
    writeEvidence(outDir, 'observation.json', {
      sample: SAMPLE_ID,
      moduleName: MODULE_NAME,
      route: IDENTITY_ROUTE,
      expect: CASE_EXPECT,
      inputs,
      verdict: result.verdict,
      detail: result.detail,
      layers: result.layers,
    })
  }
  process.stdout.write(text)
}

const selfTest = () => {
  const cases = []
  const ok = (name, cond, extra) => cases.push({ name, ok: !!cond, extra })
  const good = { status: 200, body: JSON.stringify({ uuid: null, name: null, initCommand: 'x' }), error: null }
  const initialized = { status: 200, body: JSON.stringify({ uuid: 'a'.repeat(8), name: 'kelai', initCommand: '' }), error: null }
  const rowsOk = [{ entryId: 'dsh-task-ledger', moduleName: 'dsh-task-ledger', enabled: true, fiberPhase: 'active' }]

  ok('正样本：未初始化身份判通过', judgeIdentity(good).verdict === 'PASS', judgeIdentity(good).detail)
  ok('正样本：已初始化身份判通过', judgeIdentity(initialized).verdict === 'PASS')
  ok('负控：404 判红（路由不存在）', judgeIdentity({ status: 404, body: 'Not Found', error: null }).verdict === 'FAIL')
  ok('负控：200 但空体判红', judgeIdentity({ status: 200, body: '  ', error: null }).verdict === 'FAIL')
  ok('负控：200 但非 JSON 判红', judgeIdentity({ status: 200, body: '<html>', error: null }).verdict === 'FAIL')
  ok('负控：缺 uuid 键判红', judgeIdentity({ status: 200, body: JSON.stringify({ name: null }), error: null }).verdict === 'FAIL')
  ok('负控：身份自相矛盾判红', judgeIdentity({ status: 200, body: JSON.stringify({ uuid: 'a', name: null }), error: null }).verdict === 'FAIL')
  ok('未验：401 不得当通过', judgeIdentity({ status: 401, body: '', error: null }).verdict === 'INCONCLUSIVE')
  ok('未验：传输错误不得当通过', judgeIdentity({ status: null, body: null, error: 'Failed to fetch' }).verdict === 'INCONCLUSIVE')
  ok('未验：没有观测不得当通过', judgeIdentity(null).verdict === 'INCONCLUSIVE')

  ok('正样本：两层都过判通过', judgeSample({ rows: rowsOk, probe: good }).verdict === 'PASS')
  ok('负控：插件未装判红', judgeSample({ rows: [], probe: good }).verdict === 'FAIL')
  ok('负控：插件装了但未激活判红', judgeSample({ rows: [{ entryId: 'dsh-task-ledger', moduleName: 'dsh-task-ledger', enabled: true, fiberPhase: 'pending' }], probe: good }).verdict === 'FAIL')
  ok('负控：插件被禁用判红', judgeSample({ rows: [{ entryId: 'dsh-task-ledger', moduleName: 'dsh-task-ledger', enabled: false, fiberPhase: 'active' }], probe: good }).verdict === 'FAIL')
  ok('负控：组件在但端点 404 判红', judgeSample({ rows: rowsOk, probe: { status: 404, body: 'x', error: null } }).verdict === 'FAIL')
  ok('未验：拿不到组件清单不得当通过', judgeSample({ rows: null, probe: good }).verdict === 'INCONCLUSIVE')

  ok('负控：listPlugins 空响应解析为 null 而不是空数组', rowsFromListPlugins('') === null)
  ok('正样本：RPC 信封解析出数组', Array.isArray(rowsFromListPlugins(JSON.stringify({ result: { value: rowsOk } }))))
  ok('正样本：裸数组解析出数组', Array.isArray(rowsFromListPlugins(JSON.stringify(rowsOk))))
  ok('负控：moduleName 不同名不得命中', pickInstalledRow([{ moduleName: 'dsh-memory', enabled: true }], 'dsh-task-ledger').found === false)

  ok('证据：未验写成 unmeasured', toEvidenceCase({ verdict: 'INCONCLUSIVE', detail: 'x' }, []).status === 'unmeasured')
  ok('证据：判红必须带 failureKey', typeof toEvidenceCase({ verdict: 'FAIL', detail: 'x', reason: 'route-missing' }, []).failureKey === 'string')

  const failed = cases.filter((c) => !c.ok)
  for (const c of cases) process.stdout.write((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : ' :: ' + c.extra) + '\n')
  process.stdout.write(failed.length === 0
    ? 'PLUGIN-SAMPLE-DEVICE SELF-TEST PASS (' + cases.length + ' cases)\n'
    : 'PLUGIN-SAMPLE-DEVICE SELF-TEST FAIL (' + failed.length + '/' + cases.length + ')\n')
  process.exitCode = failed.length === 0 ? 0 : 1
}

const main = async () => {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
  const sample = plan.samples.find((s) => s.id === SAMPLE_ID)
  if (sample === undefined) {
    process.stderr.write('样本清单里没有 ' + SAMPLE_ID + '\n')
    process.exitCode = 2
    return
  }
  const identity = { name: sample.plugin.name, version: sample.plugin.version, artifactSha256: sample.plugin.artifactSha256 }

  if (has('self-test')) return selfTest()

  const fixture = argOf('from-fixture')
  if (fixture !== '') {
    const obs = readFixture(resolve(fixture))
    const result = judgeSample({ rows: obs.rows, probe: obs.probe })
    const out = argOf('out') || join(ROOT, '.deploy-tmp', 'plugin-sample-device', stamp())
    report(result, out, { mode: 'fixture', fixture: resolve(fixture), ...identity })
    process.exitCode = result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2
    return
  }

  const serial = argOf('serial')
  if (serial === '') {
    process.stderr.write('用法：--self-test | --from-fixture <dir> | --serial <adb-serial> [--out <dir>]\n')
    process.stderr.write('真实模式必须显式给 --serial；本脚本不会自行挑选设备。\n')
    process.exitCode = 2
    return
  }

  // 真实模式：只使用调用方指定的这一台设备，用完不卸载、不改插件。
  const adb = (args) => spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const state = adb(['get-state'])
  if (!String(state.stdout).includes('device')) {
    process.stderr.write('设备不可用：' + (state.stderr || state.stdout) + '\n')
    process.exitCode = 2
    return
  }

  const out = argOf('out') || join(ROOT, '.deploy-tmp', 'plugin-sample-device', stamp())
  const pidr = adb(['shell', 'pidof', PKG])
  const pid = String(pidr.stdout).trim()
  if (pid === '') {
    process.stderr.write('取不到 ' + PKG + ' 进程号；请先启动 App\n')
    process.exitCode = 2
    return
  }

  const cdpPort = 29325
  adb(['forward', 'tcp:' + cdpPort, 'localabstract:webview_devtools_remote_' + pid])
  let rows = null
  let probe = null
  let page = null
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    const wsUrl = list?.[0]?.webSocketDebuggerUrl
    if (!wsUrl) throw new Error('CDP 列表为空（WebView 尚未加载完成）')
    page = await connect(wsUrl)
    const rowsReply = await page.evaluate(PAGE_LIST_PLUGINS, 15000)
    rows = rowsFromListPlugins(rowsReply?.body ?? '')
    probe = await page.evaluate(PAGE_PROBE(IDENTITY_ROUTE), 15000)
    writeEvidence(out, 'list-plugins.json', rowsReply?.body ?? '')
    writeEvidence(out, 'identity-response.json', JSON.stringify(probe ?? {}, null, 2) + '\n')
  } catch (error) {
    writeEvidence(out, 'transport-error.txt', String(error?.message ?? error) + '\n')
  } finally {
    try { page?.close() } catch { /* 已关闭 */ }
    adb(['forward', '--remove', 'tcp:' + cdpPort])
  }

  const result = judgeSample({ rows, probe })
  report(result, out, { mode: 'device', serial, androidBuild: adb(['shell', 'getprop', 'ro.build.fingerprint']).stdout?.trim(), ...identity })
  process.exitCode = result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2
}

/** 最小 CDP 客户端：只做 Runtime.evaluate。 */
const connect = (url) => new Promise((resolvePromise, rejectPromise) => {
  const ws = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  ws.onerror = () => rejectPromise(new Error('CDP 连接失败'))
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data)
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); p(msg) }
    } catch { /* 忽略非 JSON 帧 */ }
  }
  ws.onopen = () => resolvePromise({
    evaluate: (expression, timeoutMs) => new Promise((res) => {
      const id = nextId++
      const timer = setTimeout(() => { if (pending.delete(id)) res({ value: null }) }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.error) return res({ value: null, error: msg.error })
        res({ value: msg.result?.result?.value, error: null })
      })
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    }),
    close: () => { try { ws.close() } catch { /* 已关闭 */ } },
  })
})

// 只在直接运行时执行；被测试 import 时只导出纯函数，不触发任何设备访问。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()

