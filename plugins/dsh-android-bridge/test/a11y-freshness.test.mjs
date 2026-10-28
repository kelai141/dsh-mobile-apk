// 无障碍在线的判定口径与来源标注。
//
// 历史：ST-23 曾用「控制队列心跳 OR 独立心跳」两条口径判在线。**#648 推翻了其中一条**，
// 下面是为什么，留给下一个看到这个 diff 的人（否则会以为谁把测试改松了）。
//
// 旧口径：a11ySource() 里 `pollAgeMs < A11Y_FRESH_MS` 即返回 'queue'，判 a11y 在线。
// 为什么错：轮询与无障碍是**两条独立的生命线**，而且轮询设计上就是 a11y 关着也能跑——
//   1. ControlCarrier 由 EngineService.kt:63 启动，与 a11y 服务无关（0.14.0 承载拆离，
//      ControlCarrier.kt:8 原文「把长轮询从无障碍服务拆出——a11y 关着也能跑」）；
//   2. 心跳写端有 a11y 守卫：ControlCarrier.kt:84 `if (a11y != null) heartbeat(...)`；
//      **轮询写端没有**：control-queue.ts:170 每轮无条件刷新 lastTakeAt。
//   这个不对称意味着「轮询活着」在 a11y 已死时**恒为真**，于是旧判定把它的存活当成了
//   a11y 存活的证据，报 queue → a11yEnabled=true，而每条 a11y op 实际都返回
//   a11y-unavailable。设备上实测（16544）：dumpsys 的 Bound services 为空、
//   系统 enabled_accessibility_services 为 null，但 EngineService 还活着、轮询新鲜。
//
// New diagnostics distinguish fresh, disabled, stale, and unobserved states; routing accepts only fresh heartbeats.
// 轮询新鲜度仍有诊断价值，但它是另一件事，改由 gates.polling = { active, ageMs } 暴露。
//
// 判据（必须一直成立）：
//   - 轮询新鲜 + 心跳陈旧 + prefs=true  → a11y **离线**（旧代码在这里会误判在线）；
//   - 心跳新鲜                          → a11y 在线，来源 'heartbeat'；
//   - prefs 未声明 / 心跳陈旧            → 离线（fail-closed）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  A11Y_FRESH_MS,
  AndroidPrivilegeService,
  a11yStatusText,
  buildPrivilegeStatusToolPayload,
  parseAdbPrefsXml,
} from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

const saved = process.env.DSH_ADB_PREFS_PATH
after(() => {
  if (saved === undefined) delete process.env.DSH_ADB_PREFS_PATH
  else process.env.DSH_ADB_PREFS_PATH = saved
})

/** 队列陈旧（pollAgeMs 远超窗口）的替身。 */
const staleQueue = {
  pollAgeMs: () => 10 * 60 * 1000,
  stats: () => ({ waiting: false, served: 0, failed: 0, lastTakeAt: 0, lastResultAt: 0, protocol: { ok: true, shell: 1, engine: 2, reason: 'test' } }),
}

function prefs(inner) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a11y-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, '<map>\n' + inner + '</map>\n')
  process.env.DSH_ADB_PREFS_PATH = file
  return file
}

function service(queue) {
  return new AndroidPrivilegeService({}, () => 'danger-full-access', undefined, undefined, queue)
}

/** 真实的 ControlQueue，刚取过活 → pollAgeMs 新鲜（模拟壳侧轮询在跑）。 */
function freshQueue() {
  const queue = new ControlQueue()
  queue.enqueue('snapshot', {})
  queue.take()
  return queue
}

// ── 核心：#648 的误报形态 ─────────────────────────────────────────────

test('#648：轮询新鲜但心跳陈旧 → a11y 判离线（旧口径会误报 queue）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + (Date.now() - 5 * 60 * 1000) + '" />\n')
  const svc = service(freshQueue())
  // 先确认前提真的成立：队列确实新鲜。若这条不成立，下面的断言就测不到东西。
  assert.ok(svc.pollingFacts().active === true, '前提：队列必须新鲜')
  assert.equal(svc.a11ySource(), 'stale', '轮询活着不代表 a11y 活着；陈旧心跳应保留为独立状态')
  assert.equal(svc.a11yEnabled(), false)
  // 但轮询这个事实本身不能被丢掉。
  assert.equal(svc.gateFacts().polling.active, true, '轮询在线这一诊断事实必须保留')
  assert.ok(svc.gateFacts().a11yHeartbeatAgeMs >= 5 * 60 * 1000)
})

test('#648：误报形态走真实工具出口也判离线（不是只测 helper）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + (Date.now() - 5 * 60 * 1000) + '" />\n')
  const svc = service(freshQueue())
  // 打真实出口，不绕过调用链。
  const payload = buildPrivilegeStatusToolPayload(svc, undefined, false)
  const gates = payload.gates
  assert.equal(gates.a11yEnabled, false, 'gates.a11yEnabled 不得因轮询新鲜而变真')
  assert.equal(gates.a11ySource, 'stale')
  assert.ok(gates.a11yHeartbeatAgeMs >= 5 * 60 * 1000)
  assert.equal(gates.polling.active, true, 'gates.polling 仍如实报告轮询在线')
  assert.match(payload.route.snapshot.alternative.missing, /心跳陈旧/)
  assert.equal(payload.route.snapshot.alternative.source, 'stale')
  assert.equal('available' in payload.route.snapshot.alternative, false, 'stale must not be exposed as confirmed unavailable')
  // Route execution remains fail-closed; the diagnostic alternative stays explicitly unconfirmed.
  for (const [, route] of Object.entries(payload.route)) {
    const alt = route.alternative
    assert.equal('available' in alt, false, 'stale a11y must not be represented as a confirmed false')
    assert.equal(alt.source, 'stale')
    assert.match(String(alt.missing), /无障碍/, '缺什么要如实写')
  }
})

// ── 正常路径：不能因为收紧而把真的在线判成离线 ──────────────────────

test('心跳新鲜 → 判在线，来源 heartbeat（队列陈旧也不影响）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'heartbeat')
  assert.equal(svc.a11yEnabled(), true)
  const gates = svc.gateFacts()
  assert.equal(gates.a11yEnabled, true)
  assert.equal(gates.a11ySource, 'heartbeat')
})

test('心跳新鲜 + 队列也新鲜 → 来源仍是 heartbeat（queue 不再是来源值）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(freshQueue())
  assert.equal(svc.a11ySource(), 'heartbeat')
  assert.equal(svc.gateFacts().polling.active, true)
})

test('心跳与队列都陈旧 → 离线（fail-closed）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + (Date.now() - 5 * 60 * 1000) + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'stale')
  assert.equal(svc.a11yEnabled(), false)
  assert.equal(svc.gateFacts().a11ySource, 'stale')
  assert.equal(svc.gateFacts().polling.active, false)
})

test('explicit disablement remains distinct from a stale heartbeat', () => {
  prefs('<boolean name="a11yEnabled" value="false" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'disabled')
  assert.equal(svc.a11yEnabled(), false)
  assert.equal(svc.gateFacts().a11yHeartbeatAgeMs, null)
  const payload = buildPrivilegeStatusToolPayload(svc, undefined, false)
  assert.equal(payload.route.snapshot.alternative.source, 'disabled')
  assert.equal(payload.route.snapshot.alternative.available, false)
})

test('missing a11y declaration remains unknown and fails closed', () => {
  prefs('<boolean name="allowSwitch" value="false" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'unknown')
  assert.equal(svc.a11yEnabled(), false)
  assert.equal(svc.gateFacts().a11yHeartbeatAgeMs, null)
  assert.equal(parseAdbPrefsXml('<map><boolean name="allowSwitch" value="false" /></map>').a11yEnabled, undefined)
  const payload = buildPrivilegeStatusToolPayload(svc, undefined, false)
  assert.equal(payload.route.snapshot.alternative.source, 'unknown')
  assert.equal('available' in payload.route.snapshot.alternative, false)
})

test('无 prefs 文件 → 离线且队列在场也不假装在线', () => {
  process.env.DSH_ADB_PREFS_PATH = join(tmpdir(), 'definitely-missing-dsh-a11y.xml')
  const svc = service(freshQueue())
  assert.equal(svc.a11ySource(), 'unknown')
  assert.equal(svc.a11yEnabled(), false)
})

test('enabled pref without a heartbeat stays fail-closed but reports a stale state', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'stale')
  assert.equal(svc.a11yEnabled(), false)
  assert.equal(svc.gateFacts().a11yHeartbeatAgeMs, null)
})

test('privilege status text distinguishes disabled, stale, and unknown states', () => {
  const disabled = a11yStatusText('disabled', null)
  const stale = a11yStatusText('stale', 45_000)
  const staleWithoutAge = a11yStatusText('stale', null)
  const unknown = a11yStatusText('unknown', null)
  assert.match(disabled, /明确关闭/)
  assert.match(stale, /心跳已过期 45 秒/)
  assert.match(staleWithoutAge, /心跳缺失/)
  assert.match(unknown, /状态未知/)
  assert.equal(new Set([disabled, stale, staleWithoutAge, unknown]).size, 4)
})

test('轮询诊断面：从未轮询时 ageMs 为 null 且 active=false', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n')
  const svc = service({ pollAgeMs: () => Number.POSITIVE_INFINITY, stats: staleQueue.stats })
  const polling = svc.gateFacts().polling
  assert.equal(polling.active, false)
  assert.equal(polling.ageMs, null, 'Infinity 不能直接透传成 JSON（lossless 要求）')
})

test('a11ySource 不再产生 queue（口径已收窄）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(freshQueue())
  assert.notEqual(svc.a11ySource(), 'queue', 'queue 已从来源枚举中删除')
})

test('窗口常量是 20s（两处共用，改动必须同批）', () => {
  assert.equal(A11Y_FRESH_MS, 20_000)
})
