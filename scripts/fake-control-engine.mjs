// fake-control-engine.mjs — 设备侧「假引擎」：在 127.0.0.1:3080 上扮演控制队列服务端，
// 直接驱动壳侧 ControlPoller（0.13.8 批 F1b 引入；验证工具，不进产线路径）。
//
// 为什么需要它：无障碍控制通道的调用方是**模型工具**（android_ui_*），没有可用模型时
// 这条链路根本无法端到端验证——而它恰恰是最需要实测的一环（跨进程、跨语言、跨权限）。
// 本脚本把「引擎侧服务端」用 30 行 HTTP 顶替掉，就能在没有 LLM 的条件下跑真机真树。
//
// 用途：不依赖 LLM 会话即可端到端验证无障碍控制通道——
//   ① 壳侧 ControlProtocolV2 编码的真实载荷（真机真树）；
//   ② `row` 行句柄寻址（动作回指改 row 之后的真实点击）；
//   ③ 413 降级阶梯 L1（壳侧收到 413 后自动改 view=target 重发）。
//
// 剧本：pending#1 → snapshot(args={view:all})；result#1 → 回 413 too_large；
//       result#2（壳侧自动重试，data.view 应为 target）→ 200；
//       pending#2 → click(args={row:<载荷里第一个可点行>, gen:<载荷 gen>})；result#3 → 200 并收工。
//
// 用法（设备内，root）：node fake-engine.mjs /data/local/tmp/fake-engine-out.ndjson
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? '/data/local/tmp/fake-engine-out.ndjson'
writeFileSync(OUT, '')

const CAPTURE = (tag, value) => {
  appendFileSync(OUT, JSON.stringify({ tag, at: Date.now(), value }) + '\n')
  console.log('[' + tag + '] ' + JSON.stringify(value).slice(0, 300))
}

let pendingCount = 0
let resultCount = 0
let clickIssued = false

const readBody = (req) => new Promise((resolve) => {
  let data = ''
  req.on('data', (chunk) => { data += chunk })
  req.on('end', () => {
    try { resolve(JSON.parse(data)) } catch { resolve({ __parse_error: data.slice(0, 200) }) }
  })
})

const json = (res, code, obj, headers = {}) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const body = await readBody(req)
  if (req.url === '/api/android/ui/pending') {
    pendingCount++
    CAPTURE('pending#' + pendingCount, { tokenLen: String(body.token ?? '').length, waitMs: body.waitMs })
    if (pendingCount === 1) {
      return json(res, 200, {
        ok: true,
        pollHintMs: 200,
        req: { reqId: 'fake-req-1', op: 'snapshot', args: {} },
      })
    }
    if (pendingCount === 2 && clickIssued) {
      const shot = globalThis.__snapshot
      if (!shot) return json(res, 200, { ok: true, req: null, pollHintMs: 500 })
      // 取第一个可操作行（f & (clickable|scrollable|editable)）
      let row = -1
      const n = shot.n
      const pick = (arr, i) => (arr.length === 1 && n > 1 ? arr[0] : arr[i])
      for (let i = 0; i < n; i++) {
        if ((pick(shot.f, i) & 7) !== 0) { row = i; break }
      }
      if (row < 0) {
        CAPTURE('no-actionable-row', { n })
        return json(res, 200, { ok: true, req: null, pollHintMs: 500 })
      }
      CAPTURE('click-request', { row, gen: shot.gen })
      return json(res, 200, {
        ok: true,
        pollHintMs: 200,
        req: { reqId: 'fake-req-2', op: 'click', args: { row, gen: shot.gen } },
      })
    }
    // 其余：空活（长轮询语义）
    return json(res, 200, { ok: true, req: null, pollHintMs: 300 })
  }
  if (req.url === '/api/android/ui/result') {
    resultCount++
    const ok = body.ok === true
    CAPTURE('result#' + resultCount, {
      ok,
      pv: body.pv,
      caps: body.caps,
      error: body.error,
      view: ok ? body.data?.view : undefined,
      n: ok ? body.data?.n : undefined,
      raw: ok ? body.data?.raw : undefined,
      gen: ok ? body.data?.gen : undefined,
      truncated: ok ? body.data?.truncated : undefined,
      bytes: JSON.stringify(body).length,
      data: ok ? body.data : undefined,
    })
    if (resultCount === 1) {
      // 故意回 413：验证壳侧 L1 阶梯（自动改 view=target 重发）
      return json(res, 413, { ok: false, error: 'too_large (fake engine injected)' },
        { 'X-DSH-Control-Code': 'too_large', 'X-DSH-Control-Bytes': String(JSON.stringify(body).length), 'X-DSH-Control-Limit': '1048576' })
    }
    if (resultCount === 2) {
      globalThis.__snapshot = body.data
      clickIssued = true
      return json(res, 200, { ok: true, reason: 'settled' })
    }
    if (resultCount >= 3) {
      json(res, 200, { ok: true, reason: 'settled' })
      res.on('finish', () => {
        CAPTURE('done', { results: resultCount, pendings: pendingCount })
        setTimeout(() => process.exit(0), 200)
      })
      return
    }
    return json(res, 200, { ok: true, reason: 'settled' })
  }
  json(res, 404, { ok: false, error: 'unknown ' + req.url })
})

server.listen(3080, '127.0.0.1', () => console.log('fake engine listening on 127.0.0.1:3080'))
setTimeout(() => { console.log('timeout, exiting'); process.exit(2) }, 120000)
