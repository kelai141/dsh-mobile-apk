// verify-plugin-sample-device.test.mjs — 设备适配器的离线回归。
//
// 只跑纯逻辑与夹具，全程不调用 adb，不连接设备。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CASE_EXPECT,
  IDENTITY_ROUTE,
  judgeIdentity,
  pickInstalledRow,
  toEvidenceCase,
} from './lib/plugin-sample-task-ledger-identity.mjs'
import { judgeSample, rowsFromListPlugins } from './verify-plugin-sample-device.mjs'
import { validateBundle } from './verify-plugin-compat-evidence.mjs'
import { applyCase, buildEvidence } from './lib/plugin-sample-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PLAN = JSON.parse(readFileSync(join(HERE, 'plugin-test-samples.json'), 'utf8'))

const rowsOk = [{ entryId: 'dsh-task-ledger', moduleName: 'dsh-task-ledger', enabled: true, fiberPhase: 'active' }]
const okProbe = { status: 200, body: JSON.stringify({ uuid: null, name: null, initCommand: 'x' }), error: null }

test('用例绑定到样本清单里的真实插件身份', () => {
  const sample = PLAN.samples.find((s) => s.id === 's05-task-ledger')
  assert.ok(sample, '清单里必须有 s05-task-ledger')
  assert.equal(sample.plugin.name, 'dsh-task-ledger')
  assert.match(sample.plugin.version, /^\d+\.\d+\.\d+$/)
  assert.ok(sample.surfaces.clientEntryIds.includes('dsh-task-ledger'))
  assert.equal(IDENTITY_ROUTE, '/api/task-ledger/identity')
})

test('端点路径来自插件源码而不是臆造', () => {
  // 与 dsh-task-ledger 0.1.8 dist/host/routes.js 的 API_PREFIX + registerRead("/identity") 一致。
  assert.ok(IDENTITY_ROUTE.startsWith('/api/task-ledger/'))
  assert.ok(CASE_EXPECT.includes(IDENTITY_ROUTE))
  assert.ok(CASE_EXPECT.includes('uuid'))
  assert.ok(CASE_EXPECT.includes('name'))
})

test('正样本通过，未初始化身份是合法结果', () => {
  const r = judgeIdentity(okProbe)
  assert.equal(r.verdict, 'PASS')
  assert.match(r.detail, /未初始化身份/)
})

test('未初始化与已初始化都算通过', () => {
  assert.equal(judgeIdentity({ status: 200, body: JSON.stringify({ uuid: 'abc12345', name: 'kelai' }), error: null }).verdict, 'PASS')
})

test('判红：路由缺失、空体、非 JSON、缺键、自相矛盾', () => {
  assert.equal(judgeIdentity({ status: 404, body: 'Not Found', error: null }).reason, 'route-missing')
  assert.equal(judgeIdentity({ status: 200, body: '   ', error: null }).reason, 'empty-body')
  assert.equal(judgeIdentity({ status: 200, body: '<html></html>', error: null }).reason, 'not-json')
  assert.equal(judgeIdentity({ status: 200, body: JSON.stringify({ name: null }), error: null }).reason, 'missing-fields')
  assert.equal(judgeIdentity({ status: 200, body: JSON.stringify({ uuid: 'a', name: null }), error: null }).reason, 'identity-mismatch')
})

test('未验：鉴权、传输失败、无观测都不得当通过', () => {
  assert.equal(judgeIdentity({ status: 401, body: '', error: null }).verdict, 'INCONCLUSIVE')
  assert.equal(judgeIdentity({ status: null, body: null, error: 'Failed to fetch' }).verdict, 'INCONCLUSIVE')
  assert.equal(judgeIdentity(null).verdict, 'INCONCLUSIVE')
})

test('组件面：按 moduleName 匹配，不按条目 id', () => {
  assert.equal(pickInstalledRow(rowsOk, 'dsh-task-ledger').found, true)
  assert.equal(pickInstalledRow([{ moduleName: 'dsh-memory', enabled: true, fiberPhase: 'active' }], 'dsh-task-ledger').found, false)
  assert.equal(pickInstalledRow([{ entryId: 'dsh-task-ledger', enabled: true }], 'dsh-task-ledger').found, false)
})

test('两层都过才判通过', () => {
  assert.equal(judgeSample({ rows: rowsOk, probe: okProbe }).verdict, 'PASS')
  assert.equal(judgeSample({ rows: [], probe: okProbe }).verdict, 'FAIL')
  assert.equal(judgeSample({ rows: null, probe: okProbe }).verdict, 'INCONCLUSIVE')
  assert.equal(judgeSample({ rows: rowsOk, probe: { status: 404, body: 'x', error: null } }).verdict, 'FAIL')
  assert.equal(judgeSample({ rows: [{ ...rowsOk[0], fiberPhase: 'pending' }], probe: okProbe }).verdict, 'FAIL')
})

test('listPlugins 解析：空响应是 null，不是空数组', () => {
  assert.equal(rowsFromListPlugins(''), null)
  assert.equal(rowsFromListPlugins('not json'), null)
  assert.deepEqual(rowsFromListPlugins(JSON.stringify({ result: { value: rowsOk } })), rowsOk)
  assert.deepEqual(rowsFromListPlugins(JSON.stringify(rowsOk)), rowsOk)
})

test('证据条目：只认实测状态', () => {
  assert.equal(toEvidenceCase({ verdict: 'PASS', detail: 'x' }, ['a.json']).status, 'pass')
  assert.equal(toEvidenceCase({ verdict: 'FAIL', detail: 'x', reason: 'route-missing' }, ['a.json']).failureKey, 'route-missing')
  const unmeasured = toEvidenceCase({ verdict: 'INCONCLUSIVE', detail: 'x' }, [])
  assert.equal(unmeasured.status, 'unmeasured')
  assert.deepEqual(unmeasured.evidence, [])
})

test('证据条目能进比较器而不被判结构错误', () => {
  const bundle = {
    schema: 1,
    side: 'baseline',
    label: 'fixture',
    upstream: { repo: 'deepseek-harness', commit: PLAN.engine.commit, baseline: PLAN.engine.baseline },
    apk: { abi: 'x86_64', versionName: '0.14.11', versionCode: 61, apkSha256: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64) },
    environment: { androidApi: 34, webviewVersion: '120', emulator: true, deviceModel: 'MuMu', androidBuild: 'x', testPlanSha256: 'c'.repeat(64) },
    samples: [{
      id: 's05-task-ledger',
      plugin: { name: 'dsh-task-ledger', version: '0.1.8', artifactSha256: 'd'.repeat(64) },
      config: { patchSha256: 'e'.repeat(64), settingsSha256: 'f'.repeat(64) },
      cases: [toEvidenceCase({ verdict: 'PASS', detail: '端点可用' }, ['verdict.txt'])],
    }],
  }
  assert.deepEqual(validateBundle(bundle, 'baseline'), [])
  // 用例 id 必须与清单一致，否则比较器判缺用例。
  const planCase = PLAN.samples.find((s) => s.id === 's05-task-ledger').cases.find((c) => c.id === 'identity-api')
  assert.ok(planCase, '清单里必须有 identity-api 用例')
  assert.equal(bundle.samples[0].cases[0].id, 'identity-api')
})

test('同为 HTTP 500 的不同错误码不会归为同一个已知缺陷', () => {
  const reply = code => ({ status: 500, body: JSON.stringify({ code, error: 'fixture' }) })
  const key = code => toEvidenceCase(judgeIdentity(reply(code)), ['observation.json']).failureKey
  assert.equal(key('LEDGER_SCRIPT_FAILED'), 'status-500-ledger-script-failed')
  assert.notEqual(key('LEDGER_SCRIPT_FAILED'), key('LEDGER_STORAGE_FAILED'))
})

test('证据骨架默认全部未测', () => {
  const meta = {
    side: 'baseline',
    label: 'fixture',
    apk: { abi: 'x86_64', versionName: '0.14.11', versionCode: 61, apkSha256: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64) },
    environment: { androidApi: 34, webviewVersion: '120', emulator: true, deviceModel: 'MuMu', androidBuild: 'x', testPlanSha256: 'c'.repeat(64) },
    patchSha256: 'd'.repeat(64),
    settingsSha256: 'e'.repeat(64),
  }
  const evidence = buildEvidence(PLAN, meta)
  const cases = evidence.samples.flatMap((s) => s.cases)
  assert.equal(cases.length, PLAN.samples.reduce((n, s) => n + s.cases.length, 0))
  assert.ok(cases.every((c) => c.status === 'unmeasured' && c.evidence.length === 0))
  assert.deepEqual(validateBundle(evidence, 'baseline'), [])
})

test('只改目标用例，其余保持未测', () => {
  const meta = {
    side: 'candidate',
    label: 'fixture',
    apk: { abi: 'x86_64', versionName: '0.14.11', versionCode: 61, apkSha256: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64) },
    environment: { androidApi: 34, webviewVersion: '120', emulator: true, deviceModel: 'MuMu', androidBuild: 'x', testPlanSha256: 'c'.repeat(64) },
    patchSha256: 'd'.repeat(64),
    settingsSha256: 'e'.repeat(64),
  }
  const evidence = buildEvidence(PLAN, meta)
  applyCase(evidence, 's05-task-ledger', toEvidenceCase({ verdict: 'PASS', detail: '端点可用' }, ['verdict.txt']))
  const sample = evidence.samples.find((s) => s.id === 's05-task-ledger')
  assert.equal(sample.cases.find((c) => c.id === 'identity-api').status, 'pass')
  const rest = evidence.samples.flatMap((s) => s.cases).filter((c) => !(c.id === 'identity-api' && c.status === 'pass'))
  assert.ok(rest.every((c) => c.status === 'unmeasured'))
})

test('拒绝写入清单里没有的用例', () => {
  const evidence = buildEvidence(PLAN, {
    side: 'candidate',
    label: 'fixture',
    apk: { abi: 'x86_64', versionName: 'x', versionCode: 1, apkSha256: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64) },
    environment: { androidApi: 34, webviewVersion: '120', emulator: true, deviceModel: 'x', androidBuild: 'x', testPlanSha256: 'c'.repeat(64) },
    patchSha256: 'd'.repeat(64),
    settingsSha256: 'e'.repeat(64),
  })
  assert.throws(() => applyCase(evidence, 's05-task-ledger', { id: 'made-up', kind: 'ui', status: 'pass' }), /没有用例/)
  assert.throws(() => applyCase(evidence, 'no-such-sample', { id: 'identity-api', kind: 'ui', status: 'pass' }), /没有样本/)
})

test('CLI：夹具正样本 exit 0，判红 exit 1，未验 exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sample-'))
  const write = (name, rows, probe) => {
    const d = join(dir, name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'list-plugins.json'), JSON.stringify({ result: { value: rows } }))
    writeFileSync(join(d, 'identity-response.json'), JSON.stringify(probe))
    return d
  }
  const run = (fixture) => {
    try {
      const out = execFileSync(process.execPath, [join(HERE, 'verify-plugin-sample-device.mjs'), '--from-fixture', fixture, '--out', join(dir, 'out-' + Date.now())], { cwd: ROOT, encoding: 'utf8' })
      return { code: 0, out }
    } catch (e) {
      return { code: e.status, out: String(e.stdout) }
    }
  }
  try {
    const pass = write('pass', rowsOk, okProbe)
    const fail = write('fail', rowsOk, { status: 404, body: 'Not Found', error: null })
    const inconclusive = write('inconclusive', rowsOk, { status: 401, body: '', error: null })

    const a = run(pass)
    assert.equal(a.code, 0)
    assert.match(a.out, /PLUGIN-SAMPLE PASS/)

    const b = run(fail)
    assert.equal(b.code, 1)
    assert.match(b.out, /PLUGIN-SAMPLE FAIL/)

    const c = run(inconclusive)
    assert.equal(c.code, 2)
    assert.match(c.out, /PLUGIN-SAMPLE INCONCLUSIVE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('无 --serial 时拒绝运行，不自行挑设备', () => {
  try {
    execFileSync(process.execPath, [join(HERE, 'verify-plugin-sample-device.mjs')], { cwd: ROOT, encoding: 'utf8' })
    assert.fail('应当以非零退出拒绝')
  } catch (e) {
    assert.equal(e.status, 2)
    assert.match(String(e.stderr), /--serial/)
  }
})
