// verify-plugin-compat-evidence.test.mjs — A/B 兼容证据比较器的判别力测试。
//
// 这个比较器唯一的价值是“判得出回归”。所以这里既测纯函数的分类矩阵，
// 也真跑一次 CLI（写两份临时证据文件），证明退出码与落盘报告都真的生效。
//
// 关键判据：
//   ① 基线通过、候选失败 = 红（exit 1），这是“兼容性只增不减”的落点；
//   ② 缺测 / 阻塞 / 外部问题 / 不可比 = exit 2，绝不当通过；
//   ③ 两侧都失败 = 原版问题，不误判成我们的回归；
//   ④ 候选缺用例、缺样本、多出用例 = 红或不可比，不得静默丢功能。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENV_KEYS, SCHEMA, compareBundles, normalizeAbi, renderReport, validateBundle,
} from './verify-plugin-compat-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'verify-plugin-compat-evidence.mjs')

const sha = (ch) => ch.repeat(64)

/** 一份合法的基线证据。字段全给，避免测试靠“缺字段也能过”。 */
function baseline() {
  return {
    schema: SCHEMA,
    side: 'baseline',
    label: 'baseline 0.14.10 x86_64',
    upstream: { repo: 'deepseek-harness', commit: 'a'.repeat(40), baseline: '0.2.2-rc.1' },
    apk: { abi: 'x86_64', versionName: '0.14.10', versionCode: 54, apkSha256: sha('b'), snapshotFingerprint: sha('f') },
    environment: {
      androidApi: 34,
      webviewVersion: '120.0.0.0',
      emulator: true,
      deviceModel: 'MuMu',
      androidBuild: 'fixture-build',
      testPlanSha256: sha('1'),
    },
    samples: [{
      id: 'theme-sample',
      plugin: { name: 'dsh-theme-sample', version: '1.2.0', artifactSha256: sha('c') },
      config: { patchSha256: sha('d'), settingsSha256: sha('e') },
      cases: [
        { id: 'install', kind: 'install', status: 'pass', evidence: ['fixture-install.log'] },
        { id: 'theme-render', kind: 'ui', status: 'pass', evidence: ['fixture-theme.png'] },
        { id: 'uninstall', kind: 'lifecycle', status: 'pass', evidence: ['fixture-uninstall.log'] },
      ],
    }],
  }
}

function candidate() {
  const value = baseline()
  value.side = 'candidate'
  value.label = 'candidate rust x86_64'
  value.apk = { ...value.apk, versionName: '0.15.0-rust', versionCode: 60, apkSha256: sha('9'), snapshotFingerprint: sha('8') }
  return value
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const withCase = (status, index = 1) => {
  const value = candidate()
  value.samples[0].cases[index].status = status
  if (status === 'fail') value.samples[0].cases[index].failureKey = 'fixture-theme-missing'
  return value
}

test('ABI normalization accepts equivalent spellings only', () => {
  assert.equal(normalizeAbi('arm64-v8a'), 'arm64')
  assert.equal(normalizeAbi('aarch64'), 'arm64')
  assert.equal(normalizeAbi('x86_64'), 'x86_64')
  assert.equal(normalizeAbi('amd64'), 'x86_64')
  assert.equal(normalizeAbi('armeabi-v7a'), 'armeabi-v7a')
  assert.equal(normalizeAbi(''), '')
})

test('a complete pair passes with no unmeasured or external cases', () => {
  const result = compareBundles(baseline(), candidate())
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.exitCode, 0)
  assert.equal(result.comparable, true)
  assert.equal(result.counts.cases, 3)
  assert.equal(result.counts.pass, 3)
  assert.equal(result.counts.regression, 0)
})

test('upstream adoption compares only the exact audited pair and keeps regression checks', () => {
  const left = baseline()
  const right = candidate()
  right.upstream.commit = 'b'.repeat(40)
  right.upstream.baseline = '0.2.2-rc.2'
  const audit = {
    schemaVersion: 1, decision: 'requires-validation',
    baseline: { commit: left.upstream.commit, version: left.upstream.baseline },
    candidate: { commit: right.upstream.commit, version: right.upstream.baseline },
  }
  const options = { upstreamAudit: audit }
  assert.equal(compareBundles(left, right).exitCode, 2, 'Rust A/B still requires identical upstream')
  assert.equal(compareBundles(left, right, options).exitCode, 0)

  const wrong = clone(right)
  wrong.upstream.commit = 'c'.repeat(40)
  assert.equal(compareBundles(left, wrong, options).exitCode, 2, 'wrong candidate SHA')
  const sameApk = clone(right)
  sameApk.apk.apkSha256 = left.apk.apkSha256
  assert.equal(compareBundles(left, sameApk, options).exitCode, 2, 'same APK cannot prove an upgrade')
  const regressed = clone(right)
  regressed.samples[0].cases[1].status = 'fail'
  regressed.samples[0].cases[1].failureKey = 'theme-entry-missing'
  assert.equal(compareBundles(left, regressed, options).exitCode, 1, 'cross-version regressions remain red')
  const missed = clone(right)
  missed.samples[0].cases[1].status = 'unmeasured'
  assert.equal(compareBundles(left, missed, options).exitCode, 2, 'unmeasured remains inconclusive')
  assert.equal(compareBundles(left, right, { upstreamAudit: null }).exitCode, 2, 'invalid audit')

  const dir = mkdtempSync(join(tmpdir(), 'plugin-upstream-'))
  try {
    const files = ['baseline', 'candidate', 'audit'].map(name => join(dir, name + '.json'))
    for (const [i, value] of [left, right, audit].entries()) writeFileSync(files[i], JSON.stringify(value))
    const result = spawnSync(process.execPath, [
      SCRIPT, '--baseline', files[0], '--candidate', files[1], '--upstream-audit', files[2], '--json',
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.comparison, 'upstream-adoption')
    assert.equal(report.candidate.upstream.commit, right.upstream.commit)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('baseline pass + candidate fail is a regression and exits 1', () => {
  const result = compareBundles(baseline(), withCase('fail'))
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.equal(result.counts.regression, 1)
  assert.equal(result.cases.find((row) => row.outcome === 'regression').id, 'theme-render')
})

test('candidate blocked or external is inconclusive, never a pass', () => {
  for (const status of ['blocked', 'external']) {
    const result = compareBundles(baseline(), withCase(status))
    assert.equal(result.verdict, 'INCONCLUSIVE', status)
    assert.equal(result.exitCode, 2, status)
    assert.equal(result.counts[status], 1, status)
  }
})

test('candidate unmeasured is inconclusive', () => {
  const result = compareBundles(baseline(), withCase('unmeasured'))
  assert.equal(result.verdict, 'INCONCLUSIVE')
  assert.equal(result.exitCode, 2)
  assert.equal(result.counts.unmeasured, 1)
})

test('a baseline that never passed proves nothing and cannot pass', () => {
  const left = baseline()
  for (const item of left.samples[0].cases) item.status = 'unmeasured'
  const right = candidate()
  for (const item of right.samples[0].cases) item.status = 'unmeasured'
  const result = compareBundles(left, right)
  assert.equal(result.verdict, 'INCONCLUSIVE')
  assert.equal(result.exitCode, 2)
  assert.ok(result.reasons.some((reason) => reason.includes('基线没有任何通过的用例')))
})

test('both sides failing is the original issue, not a regression', () => {
  const left = baseline()
  left.samples[0].cases[1].status = 'fail'
  left.samples[0].cases[1].failureKey = 'fixture-theme-missing'
  const result = compareBundles(left, withCase('fail'))
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.exitCode, 0)
  assert.equal(result.counts.original, 1)
  assert.equal(result.counts.regression, 0)
})

test('baseline fail + candidate pass is recorded as improved', () => {
  const left = baseline()
  left.samples[0].cases[1].status = 'fail'
  left.samples[0].cases[1].failureKey = 'fixture-theme-missing'
  const result = compareBundles(left, candidate())
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.counts.improved, 1)
})

test('a missing case is a red, not a silent pass', () => {
  const right = candidate()
  right.samples[0].cases.pop()
  const result = compareBundles(baseline(), right)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.equal(result.counts.missing, 1)
})

test('an extra case on the candidate side makes the pair incomparable', () => {
  const right = candidate()
  right.samples[0].cases.push({ id: 'extra-probe', kind: 'ui', status: 'pass', evidence: ['fixture-extra.log'] })
  const result = compareBundles(baseline(), right)
  assert.equal(result.verdict, 'INCONCLUSIVE')
  assert.equal(result.exitCode, 2)
  assert.equal(result.counts.divergent, 1)
})

test('a missing sample is a red: silent feature loss', () => {
  const right = candidate()
  right.samples = [{
    ...clone(right.samples[0]),
    id: 'other-sample',
  }]
  const result = compareBundles(baseline(), right)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.equal(result.counts.samplesMissing, 1)
})

test('identity mismatches make the pair incomparable', () => {
  const cases = [
    ['upstream SHA', (value) => { value.upstream.commit = '0'.repeat(40) }],
    ['upstream baseline', (value) => { value.upstream.baseline = '0.2.1-rc.2' }],
    ['ABI', (value) => { value.apk.abi = 'arm64' }],
    ['plugin version', (value) => { value.samples[0].plugin.version = '1.2.1' }],
    ['plugin artifact', (value) => { value.samples[0].plugin.artifactSha256 = sha('7') }],
    ['patch digest', (value) => { value.samples[0].config.patchSha256 = sha('6') }],
    ['settings digest', (value) => { value.samples[0].config.settingsSha256 = sha('5') }],
  ]
  for (const [label, mutate] of cases) {
    const right = candidate()
    mutate(right)
    const result = compareBundles(baseline(), right)
    assert.equal(result.verdict, 'INCONCLUSIVE', label)
    assert.equal(result.exitCode, 2, label)
    assert.equal(result.comparable, false, label)
    assert.ok(result.mismatches.length > 0, label)
  }
})

test('environment differences are incomparable', () => {
  for (const key of ENV_KEYS) {
    const right = candidate()
    right.environment[key] = key === 'emulator' ? false
      : key === 'deviceModel' ? 'Pixel 8'
        : key === 'testPlanSha256' ? sha('8')
          : right.environment[key] + 1
    const result = compareBundles(baseline(), right)
    assert.equal(result.verdict, 'INCONCLUSIVE', key)
    assert.equal(result.comparable, false, key)
  }
})

test('structural validation rejects guessable but incomplete evidence', () => {
  const broken = baseline()
  delete broken.upstream
  delete broken.environment
  broken.samples[0].config = { patchSha256: 'not-a-hash', settingsSha256: sha('e') }
  const problems = validateBundle(broken, 'baseline')
  assert.ok(problems.some((p) => p.includes('缺 upstream')))
  assert.ok(problems.some((p) => p.includes('缺 environment')))
  assert.ok(problems.some((p) => p.includes('patchSha256')))
  assert.ok(validateBundle(null, 'x').length > 0)
})

test('empty case lists are rejected instead of counting as measured', () => {
  const value = baseline()
  value.samples[0].cases = []
  const problems = validateBundle(value, 'baseline')
  assert.ok(problems.some((p) => p.includes('cases')))
})

test('a measured case requires evidence, the same scenario and the same side assignment', () => {
  const left = baseline()
  const right = candidate()
  assert.equal(compareBundles(right, left).exitCode, 2)
  right.samples[0].cases[1].kind = 'install'
  assert.equal(compareBundles(left, right).exitCode, 2)
  right.samples[0].cases[1].kind = 'ui'
  delete right.samples[0].cases[1].evidence
  assert.equal(compareBundles(left, right).exitCode, 2)
})

test('a new failure signature is not passed off as an original defect', () => {
  const left = baseline()
  Object.assign(left.samples[0].cases[1], { status: 'fail', failureKey: 'fixture-previous-failure' })
  const result = compareBundles(left, withCase('fail'))
  assert.equal(result.exitCode, 2)
  assert.equal(result.counts.changedFailure, 1)
})

test('report lists every non-pass case and ends with a machine verdict', () => {
  const result = compareBundles(baseline(), withCase('fail'))
  const report = renderReport(result, { baseline: 'b.json', candidate: 'c.json' })
  assert.match(report, /\[REGRESSION\] theme-sample\/theme-render/)
  assert.match(report, /PLUGIN-COMPAT EVIDENCE FAIL/)
})

test('CLI writes a report and exits 1 on regression, 2 on incomparable, 0 on clean pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-compat-'))
  try {
    const left = join(dir, 'baseline.json')
    const right = join(dir, 'candidate.json')
    const out = join(dir, 'result.json')
    writeFileSync(left, JSON.stringify(baseline(), null, 2))

    writeFileSync(right, JSON.stringify(withCase('fail'), null, 2))
    const red = spawnSync(process.execPath, [SCRIPT, '--baseline', left, '--candidate', right, '--report', out],
      { encoding: 'utf8' })
    assert.equal(red.status, 1, red.stdout + red.stderr)
    const redReport = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(redReport.verdict, 'FAIL')
    assert.equal(redReport.counts.regression, 1)

    writeFileSync(right, JSON.stringify(withCase('blocked'), null, 2))
    const inconclusive = spawnSync(process.execPath, [SCRIPT, '--baseline', left, '--candidate', right],
      { encoding: 'utf8' })
    assert.equal(inconclusive.status, 2, inconclusive.stdout + inconclusive.stderr)
    assert.match(inconclusive.stdout, /INCONCLUSIVE/)

    writeFileSync(right, JSON.stringify(candidate(), null, 2))
    const green = spawnSync(process.execPath, [SCRIPT, '--baseline', left, '--candidate', right],
      { encoding: 'utf8' })
    assert.equal(green.status, 0, green.stdout + green.stderr)
    assert.match(green.stdout, /PLUGIN-COMPAT EVIDENCE PASS/)

    const missing = spawnSync(process.execPath, [SCRIPT, '--baseline', join(dir, 'nope.json'), '--candidate', right],
      { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /INCONCLUSIVE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the script itself has a passing self-test', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /SELF-TEST PASSED/)
})
