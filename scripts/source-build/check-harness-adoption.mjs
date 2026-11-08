import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { compareBundles, normalizeAbi } from '../verify-plugin-compat-evidence.mjs'
import { auditHarnessUpstream } from './audit-harness-upstream.mjs'
import { readHarnessIdentity } from './harness-identity.mjs'

const MATRIX = ['x86_64', 'arm64']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }

export function adoptionCheck({ baseline, candidate, planBytes, audit, readPair }) {
  if (baseline.commit === candidate.commit) {
    for (const key of ['version', 'packageManager', 'enginesNode']) {
      if (baseline[key] !== candidate[key]) fail('Pinned commit unchanged but upstream ' + key + ' differs')
    }
    return { state: 'unchanged', results: [] }
  }
  const plan = JSON.parse(planBytes)
  const planSha = hash(planBytes)
  if (plan.engine?.commit !== baseline.commit || plan.engine?.baseline !== baseline.version) {
    fail('Evidence must use the sample plan from the previous stable baseline')
  }
  if (!plan.samples?.length) fail('Stable sample plan has no cases')
  if (audit?.decision !== 'requires-validation' || audit.baseline?.commit !== baseline.commit
    || audit.baseline?.version !== baseline.version || audit.candidate?.commit !== candidate.commit
    || audit.candidate?.version !== candidate.version
    || audit.candidate?.packageManager !== candidate.packageManager
    || audit.candidate?.enginesNode !== candidate.enginesNode) {
    fail('Official upstream trees disagree with the stable and candidate contracts')
  }

  const results = []
  for (const abi of MATRIX) {
    const [left, right] = readPair(abi)
    for (const [side, bundle] of [['baseline', left], ['candidate', right]]) {
      const at = abi + '/' + side
      if (bundle?.upstream?.repo !== 'deepseek-harness') fail(at + ' upstream repo differs')
      if (normalizeAbi(bundle?.apk?.abi) !== abi
        || normalizeAbi(bundle?.environment?.devicePrimaryAbi) !== abi
        || bundle?.environment?.emulator !== true) {
        fail(at + ' must be recorded on a matching Android emulator primary ABI')
      }
      if (bundle.environment.testPlanSha256?.toLowerCase() !== planSha) fail(at + ' sample plan digest differs')
      if (!Array.isArray(bundle.samples) || bundle.samples.length !== plan.samples.length) {
        fail(at + ' must contain every stable sample')
      }
      for (const expected of plan.samples) {
        const actual = bundle.samples.find(item => item?.id === expected.id)
        if (actual?.plugin?.name !== expected.plugin.name
          || actual?.plugin?.version !== expected.plugin.version
          || actual?.plugin?.artifactSha256?.toLowerCase() !== expected.plugin.artifactSha256.toLowerCase()) {
          fail(at + ' sample identity differs: ' + expected.id)
        }
        if (!Array.isArray(actual.cases) || actual.cases.length !== expected.cases.length
          || !expected.cases.every(item => actual.cases.some(c => c?.id === item.id && c.kind === item.kind))) {
          fail(at + ' must contain every stable case for ' + expected.id)
        }
      }
    }
    const result = compareBundles(left, right, { upstreamAudit: audit })
    if (result.verdict !== 'PASS') {
      fail(abi + ' adoption ' + result.verdict + ': '
        + [...result.reasons, ...result.mismatches, ...result.cases.filter(c => c.outcome !== 'pass')
          .map(c => c.sampleId + '/' + c.id + '=' + c.outcome)].slice(0, 12).join('; '))
    }
    results.push({ abi, counts: result.counts })
  }
  return { state: 'validated', results }
}

function main() {
  const { values } = parseArgs({ options: {
    'base-contract': { type: 'string' }, 'head-contract': { type: 'string' },
    'plan': { type: 'string' }, 'repo': { type: 'string' }, 'evidence-root': { type: 'string' },
  } })
  if (!values['base-contract'] || !values['head-contract']) fail('Pass --base-contract and --head-contract')
  const baseline = readHarnessIdentity(values['base-contract'])
  const candidate = readHarnessIdentity(values['head-contract'])
  const changed = baseline.commit !== candidate.commit
  if (changed && (!values.repo || !values.plan || !values['evidence-root'])) {
    fail('New upstream pin requires --repo, --plan and --evidence-root')
  }
  const result = adoptionCheck({
    baseline, candidate,
    planBytes: changed ? readFileSync(values.plan) : undefined,
    audit: changed ? auditHarnessUpstream(values.repo, baseline, candidate.commit) : undefined,
    readPair: abi => ['baseline', 'candidate'].map(side => JSON.parse(readFileSync(
      join(values['evidence-root'], candidate.commit, abi, side + '.json'), 'utf8',
    ))),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main() } catch (error) {
    console.error('HARNESS ADOPTION FAIL: ' + error.message)
    process.exitCode = 1
  }
}
