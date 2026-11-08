// 样本计划与兼容证据比较器的接缝测试。
//
// 目的：证明「样本清单 -> 证据骨架 -> 比较器」这条链是通的，并且
// 骨架在没有实测时一定被判未决，不会被当成通过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PLAN, toEvidenceSamples, validatePlan } from './check-plugin-test-samples.mjs'
import { compareBundles, validateBundle } from './verify-plugin-compat-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const plan = JSON.parse(readFileSync(DEFAULT_PLAN, 'utf8'))

test('样本计划本身通过结构校验', () => {
  assert.deepEqual(validatePlan(plan), [])
})

test('样本数不少于 8，低热度样本不少于 4', () => {
  assert.ok(plan.samples.length >= 8, '样本数 ' + plan.samples.length)
  const low = plan.samples.filter((s) => s.heat.monthlyDownloads <= plan.selection.lowHeatMaxMonthlyDownloads)
  assert.ok(low.length >= plan.selection.minLowHeatSamples, '低热度 ' + low.length)
})

test('必需类别都有样本覆盖', () => {
  const have = new Set(plan.samples.map((s) => s.category))
  for (const cat of plan.selection.requiredCategories) assert.ok(have.has(cat), '缺类别 ' + cat)
})

test('每个样本都是精确版本且带 64 位制品哈希', () => {
  for (const s of plan.samples) {
    assert.match(s.plugin.version, /^\d+\.\d+\.\d+/, s.id)
    assert.match(s.plugin.artifactSha256, /^[0-9a-f]{64}$/, s.id)
    assert.ok(s.plugin.tarball.includes('-' + s.plugin.version + '.tgz'), s.id)
  }
})

test('每个样本都带 install 与宿主装配用例，功能判据不止一条', () => {
  for (const s of plan.samples) {
    const ids = s.cases.map((c) => c.id)
    assert.ok(ids.includes('install'), s.id + ' 缺 install')
    assert.ok(ids.includes('activate-host'), s.id + ' 缺 activate-host')
    assert.ok(s.cases.length >= 3, s.id + ' 判据过少')
  }
})

test('客户端条目用例只出现在声明了 dsh.client 的样本上', () => {
  for (const s of plan.samples) {
    const hasClientCase = s.cases.some((c) => c.id === 'activate-client')
    assert.equal(hasClientCase, typeof s.surfaces.client === 'string', s.id)
  }
})

test('清单里有 host-only 样本，用来验证服务端工具无条目也属正常', () => {
  const hostOnly = plan.samples.filter((s) => typeof s.surfaces.client !== 'string')
  assert.ok(hostOnly.length >= 1, '至少一个 host-only 样本')
  for (const s of hostOnly) {
    assert.ok(s.surfaces.tools.length > 0, s.id + ' host-only 样本必须带工具面')
    assert.ok(!s.cases.some((c) => c.id === 'activate-client'), s.id + ' 不得有客户端条目用例')
    assert.ok(s.cases.some((c) => c.id === 'activate-host'), s.id + ' 必须有宿主装配用例')
  }
})

test('条目 id 来自补丁行，包名出现在条目 url 里', () => {
  for (const s of plan.samples) {
    if (typeof s.surfaces.client !== 'string') continue
    assert.ok(s.surfaces.clientEntryIds.length > 0, s.id + ' 缺条目 id')
    const expect = s.cases.find((c) => c.id === 'activate-client').expect
    assert.ok(expect.includes('entries'), s.id + ' 必须按 entries 数组判定')
    assert.ok(expect.includes(s.plugin.name + '/client'), s.id + ' 必须按 url 核对包名')
    assert.ok(!/__DSH_BOOT__\.ids/.test(expect), s.id + ' 不得引用不存在的 ids')
  }
})

test('宿主装配用例按 listPlugins 的 moduleName 判定', () => {
  for (const s of plan.samples) {
    const expect = s.cases.find((c) => c.id === 'activate-host').expect
    assert.ok(expect.includes('pluginManager/listPlugins'), s.id)
    assert.ok(expect.includes(s.plugin.name), s.id)
    assert.ok(expect.includes('fiberPhase'), s.id)
  }
})

test('异常来源都在 notes 里说明', () => {
  for (const s of plan.samples) {
    if (s.source.gitHeadStatus === 'unresolvable') {
      assert.ok(s.notes.some((n) => /gitHead/i.test(n)), s.id + ' 缺 gitHead 说明')
    }
    if (s.metadata.licenseFile === 'absent') {
      assert.ok(s.notes.some((n) => /LICENSE/.test(n)), s.id + ' 缺许可证说明')
    }
  }
})

const bundle = (side) => ({
  schema: 1,
  side,
  label: side + ' fixture',
  upstream: { repo: 'deepseek-harness', commit: plan.engine.commit, baseline: plan.engine.baseline },
  apk: {
    abi: 'x86_64',
    versionName: '0.14.11',
    versionCode: 61,
    apkSha256: 'a'.repeat(64),
    snapshotFingerprint: 'b'.repeat(64),
  },
  environment: {
    androidApi: 34,
    webviewVersion: '120.0.6099.230',
    emulator: true,
    deviceModel: 'MuMu',
    androidBuild: 'fixture-build',
    testPlanSha256: 'c'.repeat(64),
  },
  samples: toEvidenceSamples(plan).map((s) => ({
    ...s,
    config: { patchSha256: 'd'.repeat(64), settingsSha256: 'e'.repeat(64) },
  })),
})

test('骨架满足比较器的结构校验', () => {
  assert.deepEqual(validateBundle(bundle('baseline'), 'baseline'), [])
  assert.deepEqual(validateBundle(bundle('candidate'), 'candidate'), [])
})

test('没有实测时判未决，不会被当成通过', () => {
  const result = compareBundles(bundle('baseline'), bundle('candidate'))
  assert.equal(result.verdict, 'INCONCLUSIVE')
  assert.equal(result.exitCode, 2)
  assert.equal(result.counts.pass, 0)
  assert.equal(result.counts.baselinePass, 0)
  assert.ok(result.reasons.some((r) => r.includes('没有可保护的功能面')), '理由要写清为什么不可下结论')
})

test('基线全过、候选全未测时逐条记 unmeasured', () => {
  const base = bundle('baseline')
  for (const s of base.samples) for (const c of s.cases) { c.status = 'pass'; c.evidence = ['base.log'] }
  const result = compareBundles(base, bundle('candidate'))
  assert.equal(result.verdict, 'INCONCLUSIVE')
  assert.equal(result.exitCode, 2)
  assert.ok(result.counts.unmeasured > 0)
  assert.equal(result.counts.pass, 0)
})

test('候选缺一个样本即判红（静默丢功能）', () => {
  const base = bundle('baseline')
  const cand = bundle('candidate')
  for (const s of base.samples) for (const c of s.cases) { c.status = 'pass'; c.evidence = ['x.log'] }
  cand.samples = cand.samples.slice(1)
  const result = compareBundles(base, cand)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.exitCode, 1)
})

test('换插件版本即判不可比', () => {
  const base = bundle('baseline')
  const cand = bundle('candidate')
  cand.samples[0].plugin.version = '9.9.9'
  const result = compareBundles(base, cand)
  assert.equal(result.exitCode, 2)
  assert.ok(result.mismatches.length > 0 || result.counts.samplesIncomparable > 0)
})

test('CLI 正样本退出 0，改动后的计划退出 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-samples-'))
  try {
    const ok = execFileSync(process.execPath, [join(HERE, 'check-plugin-test-samples.mjs')], { cwd: ROOT, encoding: 'utf8' })
    assert.match(ok, /PLUGIN-TEST-SAMPLES OK/)

    const bad = JSON.parse(JSON.stringify(plan))
    bad.samples[0].metadata.mainExists = false
    const badFile = join(dir, 'bad.json')
    writeFileSync(badFile, JSON.stringify(bad, null, 2))
    let code = 0
    let out = ''
    try {
      execFileSync(process.execPath, [join(HERE, 'check-plugin-test-samples.mjs'), '--plan', badFile], { cwd: ROOT, encoding: 'utf8' })
    } catch (e) {
      code = e.status
      out = String(e.stdout)
    }
    assert.equal(code, 1)
    assert.match(out, /mainExists/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
