// ui-probe.mjs — device UI probe that survives page reloads.
// Usage: node ui-probe.mjs <port> text|items|click <label>
const port = process.argv[2]
const cmd = process.argv[3]
const arg = process.argv[4]

async function wsUrl() {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find(i => i.type === 'page' && i.url.startsWith('http://127.0.0.1'))
  if (!page) throw new Error('no engine page')
  return page.webSocketDebuggerUrl
}
async function call(method, params) {
  const url = await wsUrl()
  const sock = new WebSocket(url)
  return await new Promise((ok, no) => {
    sock.onopen = () => sock.send(JSON.stringify({ id: 1, method, params }))
    sock.onerror = () => no(new Error('ws failed'))
    sock.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { sock.close(); ok(m) } }
  })
}
async function evalIn(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  const ex = r.result?.exceptionDetails
  if (ex) return { error: ex.exception?.description ?? ex.text }
  return r.result?.result?.value
}
// innerText 只算可见文本；textContent 会把 <script> 源码也计进去（本轮踩过）。
const TEXT_LEN = "document.body ? String(document.body.innerText || '').length : -1"
const TEXT_HEAD = "(document.body ? String(document.body.innerText || '') : '').replace(/[\\s\\u00a0]+/g, ' ').slice(0, 800)"

async function waitDom(maxMs) {
  const end = Date.now() + (maxMs || 30000)
  while (Date.now() < end) {
    const v = await evalIn(TEXT_LEN).catch(() => -1)
    if (typeof v === "number" && v > 0) return v
    await new Promise(r => setTimeout(r, 500))
  }
  return -1
}

if (cmd === "text") {
  await waitDom()
  console.log(await evalIn(TEXT_HEAD))
} else if (cmd === "items") {
  await waitDom()
  const expr = "[...document.querySelectorAll('[role=menuitem],[role=button],button,a')]" +
    ".map(e => ({ t: String(e.textContent || '').trim().replace(/[\\s\\u00a0]+/g, ' ').slice(0, 30)," +
    " x: Math.round(e.getBoundingClientRect().x + e.getBoundingClientRect().width/2)," +
    " y: Math.round(e.getBoundingClientRect().y + e.getBoundingClientRect().height/2) }))" +
    ".filter(i => i.t && i.x > 0 && i.y > 0 && i.x < innerWidth && i.y < innerHeight).slice(0, 30)"
  console.log(JSON.stringify(await evalIn(expr), null, 1))
} else if (cmd === "click") {
  await waitDom()
  // 匹配顺序：aria-label 精确 > 文本精确 > 文本包含。仅靠 textContent 找不到图标按钮（本轮踩过）。
  const finder = "[...document.querySelectorAll('*')].find(e => {" +
    "  const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false;" +
    "  const label = String(e.getAttribute('aria-label') || '').trim();" +
    "  const text = String(e.textContent || '').trim();" +
    "  return label === " + JSON.stringify(arg) + " || text === " + JSON.stringify(arg) + " || (text.length < 40 && text.indexOf(" + JSON.stringify(arg) + ") >= 0);" +
    "})"
  const pos = await evalIn("(() => { const el = " + finder + "; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } })()")
  if (!pos) { console.log("NOT_FOUND " + arg); process.exit(0) }
  for (const type of ["mousePressed", "mouseReleased"]) {
    await call("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", clickCount: 1 })
  }
  const len = await waitDom(40000)
  console.log(JSON.stringify({ clicked: arg, at: pos, bodyLen: len, head: await evalIn(TEXT_HEAD) }, null, 1))
} else {
  console.log("usage: ui-probe.mjs <port> text|items|click <label>")
}
