#!/usr/bin/env node
/**
 * #686 第二层设备验收：桥帧来源守卫（document-start 按帧封禁 window.androidBridge）。
 *
 * 为什么必须上设备：JS 侧按帧判据（location.origin / window.top）只有真 WebView 的帧模型
 * 能给出真值；jsdom 里所有帧同源，测不出隔离。
 *
 * 断言（对应 issue #686 的验收条件）：
 *   N1 opaque 子帧（sandbox=allow-scripts）对三类方法全部不可达：
 *      a11yStatus（读）/ getPickToken（凭据）/ setImmersiveMode（写）
 *   N2 同样子帧拿到的 typeof androidBridge === 'undefined'
 *   N3 子帧自身内联脚本在解析时看到的也是 undefined（证明无窗口期）
 *   P1 主帧三类方法全部可用
 *   P2 主帧 origin 为 null（不透明上下文）时仍然可用（顶层帧兜底）
 *   P3 同源子帧仍可持有桥（HTML artifact 预览不被误伤）
 *
 * 用法：
 *   node scripts/verify-bridge-frame-guard.mjs --ws 29225 [--json out.json]
 *   node scripts/verify-bridge-frame-guard.mjs --self-test   # 无需设备：只验前置判据本身
 *
 * ── 两个会让人白跑一遍的设备侧前置（都已在下方做断言或说明）──────────────────
 *
 * 1) socket 要 forward 到**主进程**，不是渲染进程。
 *    WebView 会同时暴露多个 `webview_devtools_remote_<pid>`：主进程那个的 /json/list 里
 *    才有引擎 page；渲染进程那个返回**空列表**。挂错了不会报错，只会安静地「什么都没验到」，
 *    看起来很像「应用没起来」。所以本脚本开头有一条前置断言（见 precondition 段），
 *    看不到引擎 page 直接 exit 2 并指出这个可能。
 *
 * 2) 全新安装后，引擎页面前面会挡一个「预览版说明」对话框。
 *    没点掉它，引擎页面根本不会加载，CDP 里自然没有 page。这不是缺陷，是首次启动的说明页。
 *    自动化跑之前先确认这一屏已经点过（`input tap` 那个「继续」），否则同样会撞上上面的空列表。
 */
import { writeFileSync } from 'node:fs'

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const PORT = Number(argOf('ws', '29225'))
const JSON_OUT = argOf('json', null)

/**
 * 引擎页判据。抽成常量，让 --self-test 能对同一份规则做正控/负控，
 * 避免「自检断言的是另一份规则」这种假绿。
 */
const ENGINE_PAGE_RE = /^http:\/\/127\.0\.0\.1:\d+\//

/**
 * --self-test：不需要设备，只验前置判据本身。
 *
 * 为什么值得有：这条前置的全部价值就是「挂错 socket 时立刻停下并说清原因」。
 * 它是判据代码，判据本身就该有正控与负控，否则哪天正则写宽了（比如放行任意 url）
 * 也照样「通过」，等于把假绿的门槛又装回去。
 */
if (process.argv.includes('--self-test')) {
  const cases = [
    { url: 'http://127.0.0.1:4145/', want: true, why: '默认端口引擎页' },
    { url: 'http://127.0.0.1:3080/', want: true, why: '本机实际端口也是引擎页' },
    { url: 'http://127.0.0.1:4145/#/chat', want: true, why: '带 hash 的路由页' },
    { url: 'about:blank', want: false, why: '空白页不是引擎页' },
    { url: 'https://127.0.0.1:4145/', want: false, why: 'https 不是引擎页（引擎是 http）' },
    { url: 'http://localhost:4145/', want: false, why: 'localhost 与 127.0.0.1 不同源，不能放行' },
    { url: 'http://192.168.1.9:4145/', want: false, why: '非回环地址不是引擎页' },
    { url: '', want: false, why: '空 url 不是引擎页' },
  ]
  let failed = 0
  for (const c of cases) {
    const got = ENGINE_PAGE_RE.test(c.url)
    const ok = got === c.want
    if (!ok) failed += 1
    console.log((ok ? 'PASS ' : 'FAIL ') + JSON.stringify(c.url) + ' -> ' + got + '（期望 ' + c.want + '：' + c.why + '）')
  }
  console.log('--self-test: ' + (cases.length - failed) + '/' + cases.length + ' 通过')
  process.exit(failed === 0 ? 0 : 1)
}

let listRaw
try {
  listRaw = await fetch('http://127.0.0.1:' + PORT + '/json/list')
} catch (e) {
  // 端口没 forward 时 fetch 会抛，不接住就是一段栈回溯——既不像判据也不指出下一步。
  console.error(
    '前置不满足：连不上 http://127.0.0.1:' + PORT + '（' + (e && e.message ? e.message : e) + '）。\n' +
    '  先做端口转发：\n' +
    '    adb -s <serial> shell "cat /proc/net/unix" | grep webview_devtools_remote\n' +
    '    adb -s <serial> forward tcp:' + PORT + ' localabstract:webview_devtools_remote_<pid>\n' +
    '  注意 webview_devtools_remote_<pid> 有多个，要选**主进程**那个（渲染进程的空列表）。',
  )
  process.exit(2)
}
if (!listRaw.ok) {
  console.error('前置不满足：CDP 列表不可读（HTTP ' + listRaw.status + '）。先确认 adb forward 到了主进程 socket。')
  process.exit(2)
}
const pages = await listRaw.json()

/**
 * 前置判据（第一道，在连 WS 之前）：/json/list 里必须已经有**引擎页**。
 *
 * 这一道比后面的 Target.getTargets 更早、也更重要：挂错 socket 时最常见的结果就是列表为空，
 * 这时连 WS 都会失败（渲染进程 socket 没有 page），后面的断言根本没机会跑。
 */
const pageList = pages.filter((p) => p.type === 'page')
const engineInList = pageList.find((p) => ENGINE_PAGE_RE.test(p.url || ''))
if (!engineInList) {
  console.error(
    '前置不满足：CDP 列表里没有引擎 page（http://127.0.0.1:<port>/）。\n' +
    '  实际看到：' + (pageList.map((p) => JSON.stringify(p.url)).join(', ') || '<无 page target>') + '\n' +
    '  最可能：--ws ' + PORT + ' forward 到了**渲染进程** socket——那边 page 列表为空，\n' +
    '          连 WS 都连不上，看起来很像「应用没起来」。\n' +
    '  其次：全新安装后的「预览版说明」对话框还没点掉，引擎页因此没加载。\n' +
    '  逐个 socket 试：adb -s <serial> shell "cat /proc/net/unix" | grep webview_devtools_remote\n' +
    '  再 forward 到能列出引擎页的那个。',
  )
  process.exit(2)
}

const page = engineInList
if (!page) {
  console.error(
    '前置不满足：CDP 里没有 page target。\n' +
    '  最可能的原因：--ws ' + PORT + ' forward 到了**渲染进程**的 socket。\n' +
    '  WebView 会同时暴露多个 webview_devtools_remote_<pid>，只有主进程那个的 /json/list\n' +
    '  才有引擎 page；渲染进程那个返回空列表，且不会报错。\n' +
    '  另一个可能：全新安装后的「预览版说明」对话框还没点掉，引擎页因此没加载。\n' +
    '  逐个 socket 试：adb -s <serial> shell "cat /proc/net/unix" | grep webview_devtools_remote\n' +
    '  再 adb -s <serial> forward tcp:' + PORT + ' localabstract:webview_devtools_remote_<pid>',
  )
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const contexts = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')) })
const send = (method, params) => new Promise((res) => {
  const id = ++seq
  pending.set(id, res)
  ws.send(JSON.stringify({ id, method, params }))
})

const evalIn = async (contextId, expression) => {
  const r = await send('Runtime.evaluate', {
    ...(contextId ? { contextId } : {}),
    expression, returnByValue: true, awaitPromise: true,
  })
  if (r.result && r.result.exceptionDetails) {
    return { thrown: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200) }
  }
  return { value: r.result && r.result.result ? r.result.result.value : null }
}

await send('Runtime.enable', {})
await send('Page.enable', {})
await new Promise((r) => setTimeout(r, 500))

/**
 * 前置断言：连上的这个 socket 必须真的能看到**引擎页面**。
 *
 * 为什么要单独断言：仅凭 /json/list 有一个 page 就往下跑是不够的——挂错 socket 时它可能是
 * 空白页或别的 WebView；那样后面所有帧断言都会「通过」，但验的不是引擎页面，属假绿。
 * 这里用 Target.getTargets 再确认一次目标 URL 是引擎 origin，不匹配就 exit 2。
 */
const targets = await send('Target.getTargets', {})
const targetInfos = (targets.result && targets.result.targetInfos) || []
const pageTargets = targetInfos.filter((t) => t.type === 'page')
const engineTarget = pageTargets.find((t) => /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url || ''))
if (!engineTarget) {
  console.error(
    '前置不满足：连上了 CDP，但看不到引擎 page（http://127.0.0.1:<port>/）。\n' +
    '  实际看到：' + (pageTargets.map((t) => JSON.stringify(t.url)).join(', ') || '<无 page target>') + '\n' +
    '  最可能：--ws ' + PORT + ' forward 到了渲染进程 socket（那边 page 列表为空或不是引擎页）。\n' +
    '  其次：全新安装后的「预览版说明」对话框未点掉，引擎页还没加载。',
  )
  process.exit(2)
}
console.log('前置 OK：引擎 page = ' + engineTarget.url)

/** 三类探针：读 / 凭据 / 写。写操作用可逆的 setImmersiveMode，避免副作用。 */
const PROBES = {
  read: 'a11yStatus',
  credential: 'getPickToken',
  write: 'setImmersiveMode',
}
const probeScript = (name) => {
  if (name === PROBES.read) return '(() => { try { var v = window.androidBridge.a11yStatus(); return { reachable: true, sample: String(v).slice(0, 60) } } catch (e) { return { reachable: false, err: String(e).slice(0, 120) } } })()'
  if (name === PROBES.credential) return '(() => { try { var v = window.androidBridge.getPickToken(); return { reachable: true, isReal: typeof v === "string" && v.length > 8, sample: String(v).slice(0, 12) } } catch (e) { return { reachable: false, err: String(e).slice(0, 120) } } })()'
  return '(() => { try { window.androidBridge.setImmersiveMode(false); return { reachable: true } } catch (e) { return { reachable: false, err: String(e).slice(0, 120) } } })()'
}

const before = contexts.length
// 造三类帧：A 跨源（opaque）、B 同源（allow-same-origin）、C 记录自身解析期可见性的 opaque 帧
await evalIn(null, `(() => {
  for (const id of ['gq-a', 'gq-b', 'gq-c']) { const o = document.getElementById(id); if (o) o.remove() }
  const mk = (id, attrs) => { const f = document.createElement('iframe'); f.id = id; for (const k in attrs) f.setAttribute(k, attrs[k]); document.body.appendChild(f); return f }
  mk('gq-a', { sandbox: 'allow-scripts' })
  mk('gq-b', { sandbox: 'allow-scripts allow-same-origin' })
  mk('gq-c', { sandbox: 'allow-scripts' })
  return 1
})()`)
await new Promise((r) => setTimeout(r, 1500))
// 给 gq-c 写一个内联脚本，记录它在解析时看到的桥可见性
await evalIn(null, `(() => {
  const f = document.getElementById('gq-c')
  f.srcdoc = '<html><body><script>window.__parseTimeBridge = (typeof window.androidBridge)<\/script></body></html>'
  return 1
})()`)
await new Promise((r) => setTimeout(r, 1800))

const fresh = contexts.slice(before)
const byOrigin = (o) => fresh.filter((c) => c.origin === o)

/**
 * 5 秒轮询：单点取样证明不了「全程」。
 *
 * 为什么必须轮询：addJavascriptInterface 是 WebView 实例级注入，子帧里它**可能晚于**
 * document-start —— 若守卫先跑，delete 就是空操作，桥随后照旧出现，方案整体失效。
 * 所以要在 load 之后持续取样，确认全程没有一次变成 object。
 */
const POLL_MS = 5000
const POLL_STEP = 250

const pollTypeof = async (contextId, label) => {
  const samples = []
  const started = Date.now()
  while (Date.now() - started < POLL_MS) {
    const r = await evalIn(contextId, 'typeof window.androidBridge')
    samples.push({ t: Date.now() - started, value: r.value === undefined ? 'undefined' : r.value })
    await new Promise((res) => setTimeout(res, POLL_STEP))
  }
  const distinct = [...new Set(samples.map((s) => s.value))]
  return { label, samples: samples.length, distinct, everObject: samples.some((s) => s.value === 'object'), first: samples[0], last: samples[samples.length - 1] }
}

const rows = []

// ── 主帧：canary + 5 秒轮询必须始终 object ──────────────────────────────
const canary = await evalIn(null, "document.documentElement.getAttribute('data-dsh-bridge-guard')")
let canaryObj = null
try { canaryObj = canary.value ? JSON.parse(canary.value) : null } catch { canaryObj = null }
rows.push({ assert: 'C1 主帧 canary 属性存在', expect: 'present', got: canaryObj, pass: !!canaryObj })
if (canaryObj) {
  rows.push({ assert: 'C2 canary.supported', expect: 'true', got: canaryObj.supported, pass: canaryObj.supported === true })
  rows.push({ assert: 'C3 canary.top（主帧）', expect: 'true', got: canaryObj.top, pass: canaryObj.top === true })
  rows.push({ assert: 'C4 canary.applied（主帧应 allowed）', expect: 'allowed', got: canaryObj.applied, pass: canaryObj.applied === 'allowed' })
  rows.push({ assert: 'C5 canary.after（主帧应 object）', expect: 'object', got: canaryObj.after, pass: canaryObj.after === 'object' })
}

const mainPoll = await pollTypeof(null, 'main')
rows.push({
  assert: 'P1 主帧 5 秒轮询必须始终 object（不得出现 undefined）',
  expect: 'all object', got: mainPoll, pass: mainPoll.distinct.length === 1 && mainPoll.distinct[0] === 'object',
})

// 主帧三类方法正控
for (const name of Object.values(PROBES)) {
  const r = await evalIn(null, probeScript(name))
  rows.push({ assert: 'P2 主帧 ' + name, expect: 'reachable', got: r.value, pass: !!(r.value && r.value.reachable) })
}

// ── opaque 子帧：5 秒轮询必须始终 undefined ─────────────────────────────
const opaque = byOrigin('://').concat(byOrigin('null'))
const frameCtx = opaque.length ? opaque[opaque.length - 1] : null
if (!frameCtx) {
  rows.push({ assert: 'N0 opaque 子帧可见', expect: 'observed', got: 'no opaque context', pass: false })
} else {
  const framePoll = await pollTypeof(frameCtx.id, 'opaque-frame')
  rows.push({
    assert: 'N1 opaque 子帧 5 秒轮询必须始终 undefined（不得出现 object）',
    expect: 'all undefined', got: framePoll, pass: framePoll.distinct.length === 1 && framePoll.distinct[0] === 'undefined',
  })

  for (const name of Object.values(PROBES)) {
    const r = await evalIn(frameCtx.id, probeScript(name))
    rows.push({ assert: 'N2 opaque 子帧 ' + name, expect: 'unreachable', got: r.value || r.thrown, pass: !(r.value && r.value.reachable) })
  }

  const t = await evalIn(frameCtx.id, 'typeof window.androidBridge')
  rows.push({ assert: 'N3 opaque 子帧 typeof', expect: 'undefined', got: t.value, pass: t.value === 'undefined' })

  const fc = await evalIn(frameCtx.id, "document.documentElement.getAttribute('data-dsh-bridge-guard')")
  let fcObj = null
  try { fcObj = fc.value ? JSON.parse(fc.value) : null } catch { fcObj = null }
  rows.push({ assert: 'N4 子帧 canary.applied 应为 sealed', expect: 'sealed', got: fcObj && fcObj.applied, pass: !!(fcObj && fcObj.applied === 'sealed') })

  // 子帧解析期内联脚本看到的值（时间轴上的一点，作为补充而非唯一证据）
  const parseProbe = await evalIn(frameCtx.id, 'window.__parseTimeBridge === undefined ? "not-set" : window.__parseTimeBridge')
  rows.push({ assert: 'N5 子帧解析期可见性（补充）', expect: 'undefined', got: parseProbe.value, pass: parseProbe.value === 'undefined' })
}

// ── 同源子帧正控（条件 4：不误伤 HTML artifact 预览）────────────────────
//
// 必须造**真实同源**的 iframe（真实 URL，父子真同源），不能用 srcdoc 模拟：
// 实测 srcdoc + sandbox=allow-same-origin 的帧仍是不透明 origin（location.origin 为 "null"），
// 它的执行上下文虽然报 http origin，但那是父文档的 origin 标签，帧内其实拿不到父的桥。
// 用 srcdoc 当正控会得到一个假 FAIL。
const beforeSame = contexts.length
await evalIn(null, `(() => {
  const old = document.getElementById('gq-so'); if (old) old.remove()
  const f = document.createElement('iframe')
  f.id = 'gq-so'
  f.src = location.origin + '/'
  document.body.appendChild(f)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 4000))

const sameCandidates = contexts
  .slice(beforeSame)
  .filter((c) => c.origin && c.origin.startsWith('http'))

let p3pass = false
let p3got = 'no same-origin context observed'
for (const c of sameCandidates) {
  // 用帧自己的 canary 判定：allowed 且 top=false 才是真正的同源子帧放行。
  const can = await evalIn(c.id, "document.documentElement.getAttribute('data-dsh-bridge-guard')")
  let parsed = null
  try { parsed = can.value ? JSON.parse(can.value) : null } catch { parsed = null }
  if (!parsed || parsed.top !== false) continue
  const r = await evalIn(c.id, probeScript(PROBES.read))
  const t = await evalIn(c.id, 'typeof window.androidBridge')
  p3got = { canary: parsed, probe: r.value, typeofBridge: t.value }
  p3pass = !!(r.value && r.value.reachable) && t.value === 'object' && parsed.allowed === true
  if (p3pass) break
}
rows.push({
  assert: 'P3 真实同源子帧 read 可用（条件 4：不误伤 artifact 预览）',
  expect: 'allowed + reachable',
  got: p3got,
  pass: p3pass,
})

// 清理
await evalIn(null, "(() => { for (const id of ['gq-a','gq-b','gq-c','gq-so']) { const o = document.getElementById(id); if (o) o.remove() } return 1 })()")

const failed = rows.filter((r) => !r.pass)
console.log('== verify-bridge-frame-guard ==')
for (const r of rows) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.assert + ' | expect=' + r.expect + ' | got=' + JSON.stringify(r.got))
console.log('合计 ' + (rows.length - failed.length) + '/' + rows.length + ' 通过')
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ layer: 'device', goal: 'window.androidBridge frame origin guard (#686)', pollMs: POLL_MS, rows, ok: failed.length === 0 }, null, 2))
  console.log('证据: ' + JSON_OUT)
}
ws.close()
process.exit(failed.length === 0 ? 0 : 1)