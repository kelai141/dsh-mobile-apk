import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { adoptionCheck } from './check-harness-adoption.mjs'

const sha = char => char.repeat(64)
const old = { commit: 'a'.repeat(40), version: '1.0.0-rc.1', packageManager: 'pnpm@11.0.1', enginesNode: '>=24' }
const next = { ...old, commit: 'b'.repeat(40), version: '1.0.0-rc.2' }
const plugin = { name: 'fixture', version: '1.2.3', artifactSha256: sha('c') }
const cases = [{ id: 'actual', kind: 'functional' }, { id: 'install', kind: 'install' }]
const planBytes = Buffer.from(JSON.stringify({
  engine: { commit: old.commit, baseline: old.version },
  samples: [{ id: 'one', plugin, cases }, { id: 'two', plugin: { ...plugin, name: 'second-fixture' }, cases }],
}))
const planSha = createHash('sha256').update(planBytes).digest('hex')
const audit = { schemaVersion: 1, decision: 'requires-validation', baseline: old, candidate: next }
function bundle(abi, side) {
  const source = side === 'baseline' ? old : next
  return {
    schema: 1, side, label: abi + side,
    upstream: { repo: 'deepseek-harness', commit: source.commit, baseline: source.version },
    apk: { abi, versionName: 'test', versionCode: 61, apkSha256: sha(side === 'baseline' ? 'a' : 'b'), snapshotFingerprint: sha('d') },
    environment: { emulator: true, androidApi: 35, devicePrimaryAbi: abi, deviceModel: 'Fixture',
      androidBuild: 'fixture', webviewVersion: '124', testPlanSha256: planSha },
    samples: JSON.parse(planBytes).samples.map(sample => ({
      ...sample, config: { patchSha256: sha('e'), settingsSha256: sha('f') },
      cases: sample.cases.map(item => ({ ...item, status: 'pass', evidence: ['fixture.log'] })),
    })),
  }
}
const fixture = (modify = () => {}) => ({
  baseline: old, candidate: next, planBytes, audit,
  readPair(abi) {
    const pair = [bundle(abi, 'baseline'), bundle(abi, 'candidate')]
    modify(pair, abi)
    return pair
  },
})

test('ordinary APK work does not need adoption evidence', () => {
  const input = { baseline: old, candidate: { ...old }, readPair: () => assert.fail('must not read evidence') }
  assert.equal(adoptionCheck(input).state, 'unchanged')
  input.candidate.enginesNode = '>=25'
  assert.throws(() => adoptionCheck(input), /Pinned commit unchanged/)
})

test('a real contract transition checks both ABIs and every stable sample', () => {
  assert.deepEqual(adoptionCheck(fixture()).results.map(r => r.abi), ['x86_64', 'arm64'])
  assert.throws(() => adoptionCheck(fixture((pair, abi) => {
    if (abi === 'arm64') throw new Error('missing arm64 pair')
  })), /missing arm64 pair/)
  assert.throws(() => adoptionCheck(fixture(pair => {
    pair.forEach(side => side.samples.pop())
  })), /every stable sample/)
  assert.throws(() => adoptionCheck(fixture(pair => {
    pair.forEach(side => side.samples[0].cases.pop())
  })), /every stable case/)
  assert.throws(() => adoptionCheck(fixture(([, side], abi) => {
    if (abi === 'arm64') side.environment.devicePrimaryAbi = 'x86_64'
  })), /matching Android emulator primary ABI/)
})

test('wrong upstream provenance, plan drift and unresolved functionality block adoption', () => {
  assert.throws(() => adoptionCheck({ ...fixture(), audit: { ...audit, candidate: old } }), /Official upstream trees/)
  assert.throws(() => adoptionCheck(fixture(([, right]) => {
    right.environment.testPlanSha256 = sha('0')
  })), /sample plan digest differs/)
  assert.throws(() => adoptionCheck(fixture(([, right]) => {
    Object.assign(right.samples[0].cases[0], { status: 'unmeasured', evidence: [] })
  })), /INCONCLUSIVE/)
  assert.throws(() => adoptionCheck(fixture(([, right]) => {
    Object.assign(right.samples[0].cases[0], { status: 'fail', failureKey: 'fixture-regression' })
  })), /adoption FAIL/)
})
