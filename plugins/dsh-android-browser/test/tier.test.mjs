// 侧边栏浏览器 host 半回归（离线）：档位判定 / 事实来源三档 / 面板状态路由鉴权。
// 依据 .deploy-tmp/iter-0140/browser-p0.md 的实测事实。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBrowserTier, MEASURED_DEVICE_BASELINE, UA_CH_MIN_WEBVIEW_MAJOR } from '../lib/tier.js'
import { browserTierReport, tierPayload, panelStatus, apply, pickFacts, factsFromEnv, readFacts, factsCacheReset } from '../lib/index.js'
import { BROWSER_OPS, BROWSER_OP_CONTRACTS, BROWSER_ROUTES, BROWSER_TOOL_CONTRACTS, BROWSER_TOOLS, IDENTITY_PROFILES, VIEWPORT_PRESETS } from '../lib/contract.js'

const TOKEN = 'browser-test-token-0123456789'
process.env.DSH_CONTROL_TOKEN_TEST = '1'
process.env.DSH_CONTROL_TOKEN = TOKEN

function makeCtx(connection) {
  const routes = new Map()
  const disposers = []
  const registered = []
  const services = { connection, androidPrivilege: undefined }
  const target = {
    logger: () => ({ warn() {}, info() {} }),
    tools: { register(t) { registered.push(t) } },
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return d },
    get(name) { return services[name] },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  }
  return { ctx: target, routes, disposers, registered, services }
}

async function call(harness, { method = 'GET', headers = {}, token = TOKEN } = {}) {
  const route = harness.routes.get(BROWSER_ROUTES.status)
  assert.ok(route, '状态路由必须注册')
  // 注意：token 默认值不能写成 undefined（解构默认值会补回 TOKEN）；传空串表示"不带令牌头"。
  const req = { method, headers: { host: '127.0.0.1:3080', ...(token ? { 'x-dsh-control-token': token } : {}), ...headers } }
  const res = { code: 0, body: undefined, headers: {}, writeHead(code, h) { this.code = code; this.headers = h ?? {} }, end(b) { this.body = b ?? '' } }
  await route.handler(req, res)
  return res
}

test('P0 设备基线（WebView110 / 无工位 WebView）→ L1-text + S1 + 仅 UA 串，且显式降级', () => {
  const r = resolveBrowserTier(MEASURED_DEVICE_BASELINE)
  assert.equal(r.tier, 'L1-text')
  assert.equal(r.viewportRoute, 'S1')
  assert.equal(r.identityRoute, 'ua-string-only')
  assert.ok(r.degradedNotes.some((n) => n.includes(String(UA_CH_MIN_WEBVIEW_MAJOR))), '必须点明 WebView 版本低于 UA-CH 门槛')
  assert.ok(r.reasons.length >= 3, '判定理由必须落账')
})

test('工位 WebView + density 覆写可用 → L2-native + S2b（首选路线）', () => {
  const r = resolveBrowserTier({ ...MEASURED_DEVICE_BASELINE, browserWebViewAvailable: true, densityOverrideSupported: true })
  assert.equal(r.tier, 'L2-native')
  assert.equal(r.viewportRoute, 'S2b')
})

test('工位 WebView 可用但 density 覆写未证实 → 退 S2，并把光栅放大写进降级说明', () => {
  const r = resolveBrowserTier({ ...MEASURED_DEVICE_BASELINE, browserWebViewAvailable: true, densityOverrideSupported: false })
  assert.equal(r.viewportRoute, 'S2')
  assert.ok(r.degradedNotes.some((n) => n.includes('2')), 'densityDpi=320 → 2 倍光栅说明必须在场')
})

test('调试档开启且工位在场 → L3-cdp-debug（产品面仍走壳桥 op）', () => {
  const r = resolveBrowserTier({ ...MEASURED_DEVICE_BASELINE, browserWebViewAvailable: true, cdpEnabled: true })
  assert.equal(r.tier, 'L3-cdp-debug')
  assert.ok(r.reasons.some((x) => x.includes('S3')), '调试档必须登记 CDP 的 S3 可用性')
})

test('UA-CH 可用 + androidx.webkit 能力门通过 → ua-ch；仅其一通过仍是 ua-string-only', () => {
  const both = resolveBrowserTier({ ...MEASURED_DEVICE_BASELINE, webviewMajor: 120, uaChAvailable: true, androidxWebkitAvailable: true })
  assert.equal(both.identityRoute, 'ua-ch')
  const gateFail = resolveBrowserTier({ ...MEASURED_DEVICE_BASELINE, webviewMajor: 120, uaChAvailable: true, androidxWebkitCompiled: true, androidxWebkitAvailable: false })
  assert.equal(gateFail.identityRoute, 'ua-string-only')
  assert.ok(gateFail.degradedNotes.some((n) => n.includes('no-op')), '已编入但能力门不过时必须说明 no-op 路径')
  const notCompiled = resolveBrowserTier({ ...MEASURED_DEVICE_BASELINE, webviewMajor: 120, uaChAvailable: true, androidxWebkitCompiled: false })
  assert.equal(notCompiled.identityRoute, 'ua-string-only')
  assert.ok(notCompiled.degradedNotes.some((n) => n.includes('未编入')), '未编入与能力门不过必须可区分')
})

test('能力未知一律按不支持处理（fail-safe，不得因为可能支持就上报高能力）', () => {
  const r = resolveBrowserTier({})
  assert.equal(r.tier, 'L1-text')
  assert.equal(r.viewportRoute, 'S1')
  assert.equal(r.identityRoute, 'ua-string-only')
})

test('facts：env 通道优先于实测基线；非法/空值回落基线并标注来源', () => {
  const fromEnv = factsFromEnv({ DSH_BROWSER_FACTS: '{"webviewMajor":120,"browserWebViewAvailable":true}' })
  assert.equal(fromEnv.source, 'shell-env(DSH_BROWSER_FACTS)')
  assert.equal(fromEnv.facts.webviewMajor, 120)
  assert.equal(fromEnv.facts.browserWebViewAvailable, true)
  assert.equal(factsFromEnv({ DSH_BROWSER_FACTS: '{not json' }).source, 'measured-baseline(p0-2026-09-12, MuMu/WebView110)')
  assert.equal(factsFromEnv({}).source, 'measured-baseline(p0-2026-09-12, MuMu/WebView110)')
})

test('facts：壳桥 browserCaps 成功即用真实档位（来源标注 shell-op）', async () => {
  factsCacheReset()
  const control = { controlExec: async (op) => (op === BROWSER_OPS.caps ? { ok: true, data: { webviewMajor: 120, uaChAvailable: true, androidxWebkitCompiled: true, androidxWebkitAvailable: true, browserWebViewAvailable: true, densityOverrideSupported: true, densityDpi: 320 } } : { ok: false }) }
  const r = await readFacts({ env: {}, control, cacheTtlMs: 0 })
  assert.equal(r.source, 'shell-op(' + BROWSER_OPS.caps + ')')
  const report = await browserTierReport({ env: {}, control, cacheTtlMs: 0 })
  assert.equal(report.tier, 'L2-native')
  assert.equal(report.viewportRoute, 'S2b')
  assert.equal(report.identityRoute, 'ua-ch')
  assert.equal(report.factsSource, 'shell-op(' + BROWSER_OPS.caps + ')')
})

test('facts：op 失败/超时/通道缺席一律回落且带 capsNote（不隐藏降级）', async () => {
  factsCacheReset()
  const failing = await readFacts({ env: {}, control: { controlExec: async () => { throw new Error('queue busy') } }, cacheTtlMs: 0 })
  assert.match(failing.source, /measured-baseline/)
  assert.ok(failing.capsNote && failing.capsNote.includes('browserCaps'), '回落必须说明 browserCaps 不可用')
  factsCacheReset()
  const noChannel = await readFacts({ env: {}, control: undefined, cacheTtlMs: 0 })
  assert.ok(noChannel.capsNote && noChannel.capsNote.includes('控制通道不可用'))
})

test('pickFacts：类型不符/无有效字段一律不接受', () => {
  assert.equal(pickFacts(null), undefined)
  assert.equal(pickFacts({ webviewMajor: '110' }), undefined)
  assert.equal(pickFacts({ nope: 1 }), undefined)
  assert.deepEqual(pickFacts({ webviewMajor: 110, bogus: true }), { webviewMajor: 110 })
})

test('工具载荷是 lossless JSON（无 undefined 成员）且字段齐全', async () => {
  factsCacheReset()
  const payload = tierPayload(await browserTierReport({ env: {}, control: undefined, cacheTtlMs: 0 }))
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, '载荷不得含 undefined/不可序列化成员')
  for (const k of ['ok', 'tier', 'viewportRoute', 'identityRoute', 'factsSource', 'uaChAvailable', 'androidxWebkitAvailable', 'densityOverrideSupported', 'browserWebViewAvailable', 'cdpEnabled', 'reasons', 'degradedNotes', 'tools', 'ops', 'routes', 'viewportPresets', 'identityProfiles']) {
    assert.ok(k in payload, '缺字段 ' + k)
    assert.notEqual(payload[k], undefined, k + ' 不得为 undefined')
  }
})

test('面板状态载荷：档位 + 档位清单 + 来源；无 undefined 成员', async () => {
  factsCacheReset()
  const status = panelStatus(await browserTierReport({ env: {}, control: undefined, cacheTtlMs: 0 }))
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
  assert.equal(status.route, BROWSER_ROUTES.status)
  assert.equal(status.available, false, '工位未接入时 available 必须为 false')
  assert.deepEqual(status.viewportPresets.map((p) => p.id), VIEWPORT_PRESETS.map((p) => p.id))
  assert.deepEqual(status.identityProfiles.map((p) => p.id), IDENTITY_PROFILES.map((p) => p.id))
  assert.ok(status.capsNote, '回落时面板必须能看到原因')
})

test('状态路由：无凭据 401 / 伪造 Host 403+空体 / 错令牌 401', async () => {
  factsCacheReset()
  const h = makeCtx(undefined)
  apply(h.ctx)
  const noCred = await call(h, { token: '' })
  assert.equal(noCred.code, 401)
  const forged = await call(h, { headers: { host: 'evil.example' } })
  assert.equal(forged.code, 403)
  assert.equal(forged.body, '', '403 不得回任何正文')
  const wrong = await call(h, { token: 'wrong-token-00000000' })
  assert.equal(wrong.code, 401)
})

test('状态路由：合法令牌 GET → 200 档位 JSON；POST → 405 + allow: GET', async () => {
  factsCacheReset()
  const h = makeCtx(undefined)
  apply(h.ctx)
  const ok = await call(h)
  assert.equal(ok.code, 200)
  const json = JSON.parse(ok.body)
  assert.equal(json.ok, true)
  assert.ok(['L1-text', 'L2-native', 'L3-cdp-debug'].includes(json.tier))
  assert.equal(json.factsSource, 'measured-baseline(p0-2026-09-12, MuMu/WebView110)')
  const post = await call(h, { method: 'POST' })
  assert.equal(post.code, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('状态路由：浏览器会话（上游 connection 栅栏放行）→ 200；连接服务缺席 → 只认令牌', async () => {
  factsCacheReset()
  const withSession = makeCtx({ requestRejection: (req) => (req.headers?.cookie ? undefined : 401) })
  apply(withSession.ctx)
  const browserCall = await call(withSession, { token: '', headers: { cookie: 'dsh-auth=abc' } })
  assert.equal(browserCall.code, 200)
  const noCookie = await call(withSession, { token: '' })
  assert.equal(noCookie.code, 401)
})

test('卸载回收路由；重新装载只有一份注册（无重复 handler）', async () => {
  factsCacheReset()
  const first = makeCtx(undefined)
  apply(first.ctx)
  assert.equal(first.routes.size, 1)
  assert.equal(first.disposers.length, 1, '路由注册必须包一层 ctx.effect')
  for (const d of first.disposers) d()
  assert.equal(first.routes.size, 0)
  const second = makeCtx(undefined)
  apply(second.ctx)
  assert.equal(second.routes.size, 1)
  assert.equal(second.registered.length, 1, '档位工具只注册一次')
})

test('契约冻结：工具名 / op 名 / 路由名 / 档位 id 与方案口径一致', () => {
  assert.equal(BROWSER_TOOLS.tier, 'android_browser_tier')
  assert.equal(BROWSER_OPS.caps, 'browserCaps')
  assert.equal(BROWSER_OPS.viewport, 'browserViewport')
  assert.equal(BROWSER_ROUTES.status, '/api/android/browser/status')
  assert.deepEqual(VIEWPORT_PRESETS.map((p) => p.id), ['phone-portrait', 'tablet', 'desktop-720', 'desktop-1080'])
  assert.deepEqual(IDENTITY_PROFILES.map((p) => p.id), ['android-real', 'linux-desktop', 'windows-desktop'])
  assert.equal(IDENTITY_PROFILES.find((p) => p.id === 'android-real').requiresConfirm, false, '默认真实身份不得要求二次确认')
  for (const id of ['linux-desktop', 'windows-desktop']) {
    assert.equal(IDENTITY_PROFILES.find((p) => p.id === id).requiresConfirm, true, '伪装档必须二次确认')
  }
  assert.ok(Object.values(BROWSER_OPS).every((op) => op.startsWith('browser')), '壳桥 op 一律 browser 前缀')
})

test('契约完备：每个工具名与每个 op 名都有 params/returns/权限档条目', () => {
  for (const name of Object.values(BROWSER_TOOLS)) {
    const c = BROWSER_TOOL_CONTRACTS.find((x) => x.name === name)
    assert.ok(c, '工具缺契约 ' + name)
    assert.ok(c.params && c.returns && c.permission, '契约字段不全 ' + name)
  }
  for (const op of Object.values(BROWSER_OPS)) {
    const c = BROWSER_OP_CONTRACTS.find((x) => x.name === op)
    assert.ok(c, 'op 缺契约 ' + op)
    assert.ok(c.params && c.returns && c.permission, '契约字段不全 ' + op)
  }
  const fullAccess = BROWSER_TOOL_CONTRACTS.filter((t) => t.permission === 'full-access').map((t) => t.name).sort()
  assert.deepEqual(fullAccess, ['browser_screenshot'], '工具面完全访问档只应有截图（JS 属 op 面）')
  const confirm = BROWSER_TOOL_CONTRACTS.filter((t) => t.permission === 'confirm').map((t) => t.name)
  assert.deepEqual(confirm, ['browser_set_identity'], '伪装档必须二次确认')
  const opFull = BROWSER_OP_CONTRACTS.filter((t) => t.permission === 'full-access').map((t) => t.name).sort()
  assert.deepEqual(opFull, ['browserJs', 'browserShot'], 'op 面完全访问档 = browserJs/browserShot（默认失败关闭）')
})
