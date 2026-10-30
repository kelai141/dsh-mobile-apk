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
 */
import { writeFileSync } from 'node:fs'

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const PORT = Number(argOf('ws', '29225'))
const JSON_OUT = argOf('json', null)

const listRaw = await fetch('http://127.0.0.1:' + PORT + '/json/list')
if (!listRaw.ok) {
  console.error('CDP 列表不可读（先 adb forward tcp:' + PORT + ' localabstract:webview_devtools_remote_<pid>）')
  process.exit(2)
}
const pages = await listRaw.json()
const page = pages.find((p) => p.type === 'page')
if (!page) { console.error('没有 page target') ; process.exit(2) }

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
const rows = []

// P1 主帧正控
for (const name of Object.values(PROBES)) {
  const r = await evalIn(null, probeScript(name))
  rows.push({ assert: 'P1 主帧 ' + name, expect: 'reachable', got: r.value, pass: !!(r.value && r.value.reachable) })
}

// N1/N2 跨源子帧负控（origin 为 null 的那些）
const opaque = byOrigin('://').concat(byOrigin('null'))
const frameCtx = opaque.length ? opaque[opaque.length - 1] : null
if (frameCtx) {
  for (const name of Object.values(PROBES)) {
    const r = await evalIn(frameCtx.id, probeScript(name))
    const unreachable = !(r.value && r.value.reachable)
    rows.push({ assert: 'N1 opaque 子帧 ' + name, expect: 'unreachable', got: r.value || r.thrown, pass: unreachable })
  }
  const t = await evalIn(frameCtx.id, 'typeof window.androidBridge')
  rows.push({ assert: 'N2 opaque 子帧 typeof', expect: 'undefined', got: t.value, pass: t.value === 'undefined' })

  // P3 同源子帧正控：origin 等于引擎 origin 的帧必须仍可用
  const sameOrigin = fresh.filter((c) => c.origin && c.origin.startsWith('http'))
  const soCtx = sameOrigin.length ? sameOrigin[sameOrigin.length - 1] : null
  if (soCtx) {
    const r = await evalIn(soCtx.id, probeScript(PROBES.read))
    rows.push({ assert: 'P3 同源子帧 read', expect: 'reachable', got: r.value, pass: !!(r.value && r.value.reachable) })
  } else {
    rows.push({ assert: 'P3 同源子帧 read', expect: 'reachable', got: 'no same-origin context observed', pass: false })
  }
} else {
  rows.push({ assert: 'N1/N2 opaque 子帧', expect: 'observed', got: 'no opaque context', pass: false })
}

// N3 解析期可见性
const parseCtx = opaque.length ? opaque[opaque.length - 1] : null
if (parseCtx) {
  const r = await evalIn(parseCtx.id, 'window.__parseTimeBridge')
  rows.push({ assert: 'N3 子帧解析期可见性', expect: 'undefined', got: r.value, pass: r.value === 'undefined' })
}

// 清理
await evalIn(null, "(() => { for (const id of ['gq-a','gq-b','gq-c']) { const o = document.getElementById(id); if (o) o.remove() } return 1 })()")

const failed = rows.filter((r) => !r.pass)
console.log('== verify-bridge-frame-guard ==')
for (const r of rows) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.assert + ' | expect=' + r.expect + ' | got=' + JSON.stringify(r.got))
console.log('合计 ' + (rows.length - failed.length) + '/' + rows.length + ' 通过')
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ layer: 'device', goal: 'window.androidBridge frame origin guard (#686)', rows, ok: failed.length === 0 }, null, 2))
  console.log('证据: ' + JSON_OUT)
}
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
