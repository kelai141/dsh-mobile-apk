// auto-approve.mjs — connect to the phone engine mux stream and auto-approve
// every pending approval (test harness only; real usage goes through the UI).
const BASE = process.env.DSH_ENGINE_URL ?? 'http://127.0.0.1:3081'
const WS = BASE.replace(/^http/, 'ws') + '/api/events.mux'

const ws = new WebSocket(WS)
let approved = 0

function respond(frame) {
  const { rpcId, payload } = frame
  const { sessionId, approvalId } = payload
  const resp = {
    type: 'client-response',
    rpcId,
    result: { ok: true, value: { sessionId, approvalId, outcome: 'allowed-once' } },
  }
  fetch(BASE + '/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resp),
  }).then(r => r.text()).then(t => {
    approved++
    console.log('[auto-approve] approved', approvalId, '->', t.slice(0, 80))
  }).catch(e => console.error('[auto-approve] respond failed', e))
}

ws.onopen = () => console.log('[auto-approve] mux connected', WS)
ws.onerror = (e) => console.error('[auto-approve] ws error', e.message ?? e)
ws.onclose = (e) => { console.log('[auto-approve] ws closed', e.code, e.reason); process.exit(0) }
ws.onmessage = (ev) => {
  try {
    const frame = JSON.parse(String(ev.data))
    if (frame.type === 'server-request' && frame.payload?.type === 'approval/requested') {
      respond(frame)
    }
  } catch (e) { /* ignore non-JSON frames */ }
}
setInterval(() => { console.log('[auto-approve] alive, approved so far:', approved) }, 30000)
