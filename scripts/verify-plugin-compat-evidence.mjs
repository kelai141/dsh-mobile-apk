#!/usr/bin/env node
// verify-plugin-compat-evidence.mjs — 第三方插件 A/B 兼容证据比较器（离线，不产生设备结果）。
//
// 它回答一个问题：基线（baseline）能通过的功能，候选（candidate）是否仍然通过。
//
// 它不做什么：不安装 APK、不连接设备、不调用 adb、不访问网络、不生成任何“通过”结果。
// 证据必须由设备验收套件产出（见 docs/AGENTS/emulator-test-protocol.md）；本脚本只做判定。
// 缺实测、外部阻塞、前置不满足一律判 INCONCLUSIVE，绝不当通过。
//
// 可比性判据（缺一条即 INCOMPARABLE，exit 2）：
//   1) 上游身份相同；追版对照显式传入巡检报告，身份必须分别对应旧基线和候选；
//   2) ABI 相同：apk.abi（arm64-v8a / aarch64 归一为 arm64，x64 / amd64 归一为 x86_64）；
//   3) 环境相同：系统构建、WebView、设备和测试方案；快照指纹是产物身份，允许两边不同；
//   4) 样本集相同：samples[].id 双向一致；候选缺样本 = 静默丢功能，判红；
//   5) 每个样本的插件身份相同：plugin.name / version / artifactSha256；
//   6) 每个样本的配置摘要相同：config.patchSha256 / settingsSha256。
//
// 用例判定：
//   baseline=pass, candidate=pass        -> pass
//   baseline=pass, candidate=fail        -> regression（红；这正是“兼容性只增不减”要拦的）
//   baseline=fail, candidate=fail        -> original（原版问题，记录但不判回归）
//   baseline=fail, candidate=pass        -> improved（改善，记录）
//   candidate=blocked / external         -> 外部阻塞（INCONCLUSIVE，不得当通过）
//   candidate=unmeasured                 -> 缺实测（INCONCLUSIVE）
//   candidate 缺该用例                    -> missing（红；静默丢功能）
//
// 退出码：0 = 无回归且无未决项；1 = 有回归或缺用例/缺样本；2 = 不可比、证据不足或用法错误。
//
// 用法：
//   node scripts/verify-plugin-compat-evidence.mjs --baseline <a.json> --candidate <b.json>
//   node scripts/verify-plugin-compat-evidence.mjs ... --json
//   node scripts/verify-plugin-compat-evidence.mjs ... --report <result.json>
//   node scripts/verify-plugin-compat-evidence.mjs --self-test
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { writeAtomic } from './lib/atomic-write.mjs'

/** 证据文件格式版本。结构变化必须抬版本，旧文件按不可比处理。 */
export const SCHEMA = 1

/** 用例状态。没有“跳过”这一档：没跑就是 unmeasured。 */
export const CASE_STATUSES = new Set(['pass', 'fail', 'blocked', 'external', 'unmeasured'])

/** 参与可比性判定的环境键。少一个都不可比。 */
export const ENV_KEYS = ['androidApi', 'webviewVersion', 'emulator', 'deviceModel', 'androidBuild', 'testPlanSha256']

const VALID_ABIS = new Set(['arm64', 'x86_64'])
const HEX64 = /^[0-9a-f]{64}$/i
const COMMIT = /^[0-9a-f]{40}$/i
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
const isSha256 = (v) => typeof v === 'string' && HEX64.test(v)
const isCommit = (v) => typeof v === 'string' && COMMIT.test(v)
const isId = (v) => typeof v === 'string' && ID_RE.test(v)

/**
 * ABI 归一化。只做等价拼写归一，不猜未知值。
 * @param {unknown} value 原始 ABI 字符串。
 * @returns {string} 归一后的 ABI；未知值原样返回（由校验判红）。
 */
export function normalizeAbi(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'arm64-v8a' || v === 'aarch64' || v === 'arm64') return 'arm64'
  if (v === 'x86_64' || v === 'x64' || v === 'amd64') return 'x86_64'
  return v
}

/**
 * 结构校验。返回问题清单；空数组 = 可进入比较。
 * 这里刻意不接受“缺字段但大致能猜”的形态：猜出来的证据就是伪造的证据。
 * @param {unknown} bundle 已解析的证据对象。
 * @param {string} label 报错用的侧名（baseline / candidate）。
 * @returns {string[]} 问题清单。
 */
export function validateBundle(bundle, label = 'bundle') {
  const problems = []
  const push = (message) => problems.push(label + ': ' + message)
  if (!isObject(bundle)) { push('不是 JSON 对象'); return problems }
  if (bundle.schema !== SCHEMA) push('schema 必须是 ' + SCHEMA)
  if (label === 'baseline' || label === 'candidate') {
    if (bundle.side !== label) push('side 必须是 ' + label)
  } else if (bundle.side !== 'baseline' && bundle.side !== 'candidate') {
    push('side 必须是 baseline 或 candidate')
  }
  if (!nonEmpty(bundle.label)) push('label 不能为空')

  if (!isObject(bundle.upstream)) push('缺 upstream 对象')
  else {
    if (!nonEmpty(bundle.upstream.repo)) push('upstream.repo 不能为空')
    if (!isCommit(bundle.upstream.commit)) push('upstream.commit 必须是 40 位十六进制')
    if (!nonEmpty(bundle.upstream.baseline)) push('upstream.baseline 不能为空')
  }

  if (!isObject(bundle.apk)) push('缺 apk 对象')
  else {
    if (!VALID_ABIS.has(normalizeAbi(bundle.apk.abi))) push('apk.abi 必须是 arm64 或 x86_64')
    if (!nonEmpty(bundle.apk.versionName)) push('apk.versionName 不能为空')
    if (!Number.isInteger(bundle.apk.versionCode) || bundle.apk.versionCode <= 0) push('apk.versionCode 必须是正整数')
    if (!isSha256(bundle.apk.apkSha256)) push('apk.apkSha256 必须是 64 位十六进制')
    if (!isSha256(bundle.apk.snapshotFingerprint)) push('apk.snapshotFingerprint 必须是 64 位十六进制')
  }

  if (!isObject(bundle.environment)) push('缺 environment 对象')
  else {
    const env = bundle.environment
    if (!Number.isInteger(env.androidApi) || env.androidApi < 21) push('environment.androidApi 必须是 >= 21 的整数')
    if (!nonEmpty(env.webviewVersion)) push('environment.webviewVersion 不能为空')
    if (typeof env.emulator !== 'boolean') push('environment.emulator 必须是布尔值')
    if (!nonEmpty(env.deviceModel)) push('environment.deviceModel 不能为空')
    if (!nonEmpty(env.androidBuild)) push('environment.androidBuild 不能为空')
    if (!isSha256(env.testPlanSha256)) push('environment.testPlanSha256 必须是 64 位十六进制')
  }

  if (!Array.isArray(bundle.samples) || (bundle.side === 'baseline' && bundle.samples.length === 0)) {
    push('samples 必须是数组；基线不能为空')
    return problems
  }
  const sampleIds = new Set()
  bundle.samples.forEach((sample, index) => {
    const at = 'samples[' + index + ']'
    if (!isObject(sample)) { push(at + ' 不是对象'); return }
    if (!isId(sample.id)) push(at + '.id 非法')
    else if (sampleIds.has(sample.id)) push('samples 里 id 重复：' + sample.id)
    else sampleIds.add(sample.id)

    if (!isObject(sample.plugin)) push(at + ' 缺 plugin 对象')
    else {
      if (!nonEmpty(sample.plugin.name)) push(at + '.plugin.name 不能为空')
      if (!nonEmpty(sample.plugin.version)) push(at + '.plugin.version 不能为空')
      if (!isSha256(sample.plugin.artifactSha256)) push(at + '.plugin.artifactSha256 必须是 64 位十六进制')
    }

    if (!isObject(sample.config)) push(at + ' 缺 config 对象')
    else {
      if (!isSha256(sample.config.patchSha256)) push(at + '.config.patchSha256 必须是 64 位十六进制')
      if (!isSha256(sample.config.settingsSha256)) push(at + '.config.settingsSha256 必须是 64 位十六进制')
    }

    if (!Array.isArray(sample.cases) || (bundle.side === 'baseline' && sample.cases.length === 0)) {
      push(at + '.cases 必须是数组；基线不能为空')
      return
    }
    const caseIds = new Set()
    sample.cases.forEach((item, caseIndex) => {
      const caseAt = at + '.cases[' + caseIndex + ']'
      if (!isObject(item)) { push(caseAt + ' 不是对象'); return }
      if (!isId(item.id)) push(caseAt + '.id 非法')
      else if (caseIds.has(item.id)) push(at + ' 里用例 id 重复：' + item.id)
      else caseIds.add(item.id)
      if (!nonEmpty(item.kind)) push(caseAt + '.kind 不能为空')
      if (!CASE_STATUSES.has(item.status)) {
        push(caseAt + '.status 必须是 pass / fail / blocked / external / unmeasured')
      }
      if (item.detail !== undefined && typeof item.detail !== 'string') push(caseAt + '.detail 必须是字符串')
      if (item.evidence !== undefined
        && (!Array.isArray(item.evidence) || item.evidence.some((entry) => !nonEmpty(entry)))) {
        push(caseAt + '.evidence 必须是非空字符串组成的数组')
      }
      if (['pass', 'fail'].includes(item.status) && !item.evidence?.length) {
        push(caseAt + '.evidence 缺实测记录')
      }
      if (item.status === 'fail' && !nonEmpty(item.failureKey)) {
        push(caseAt + '.failureKey 缺失败特征')
      }
    })
  })
  return problems
}

/** 空计数表。所有分类都必须显式出现，避免“没写就是 0”的静默。 */
function emptyCounts() {
  return {
    samples: 0,
    samplesMissing: 0,
    samplesExtra: 0,
    samplesIncomparable: 0,
    cases: 0,
    baselinePass: 0,
    pass: 0,
    regression: 0,
    original: 0,
    improved: 0,
    external: 0,
    blocked: 0,
    unmeasured: 0,
    missing: 0,
    divergent: 0,
    baselineUnusable: 0,
    changedFailure: 0,
  }
}

function inconclusive(reasons, extra = {}) {
  return {
    verdict: 'INCONCLUSIVE',
    exitCode: 2,
    comparable: false,
    mismatches: [],
    reasons,
    counts: emptyCounts(),
    cases: [],
    ...extra,
  }
}

/**
 * 比较两份证据。纯函数，不做 I/O。
 * @param {unknown} baseline 基线证据对象。
 * @param {unknown} candidate 候选证据对象。
 * @param {{upstreamAudit?: object}} options 仅追版对照传入上游巡检报告。
 * @returns {{verdict: string, exitCode: number, comparable: boolean, mismatches: string[],
 *   reasons: string[], counts: object, cases: object[]}} 判定结果。
 */
export function compareBundles(baseline, candidate, { upstreamAudit } = {}) {
  const problems = [
    ...validateBundle(baseline, 'baseline'),
    ...validateBundle(candidate, 'candidate'),
  ]
  if (problems.length > 0) return inconclusive(problems)

  const mismatches = []
  const eq = (label, left, right) => {
    if (left !== right) mismatches.push(label + '：baseline=' + left + ' candidate=' + right)
  }
  eq('upstream.repo', baseline.upstream.repo, candidate.upstream.repo)
  if (upstreamAudit === undefined) {
    eq('upstream.commit', baseline.upstream.commit.toLowerCase(), candidate.upstream.commit.toLowerCase())
    eq('upstream.baseline', baseline.upstream.baseline, candidate.upstream.baseline)
  } else {
    const old = upstreamAudit?.baseline
    const next = upstreamAudit?.candidate
    if (upstreamAudit?.schemaVersion !== 1 || upstreamAudit?.decision !== 'requires-validation'
      || !isCommit(old?.commit) || !isCommit(next?.commit)
      || old.commit.toLowerCase() === next.commit.toLowerCase()
      || !nonEmpty(old.version) || !nonEmpty(next.version)) {
      return inconclusive(['上游巡检报告缺失或不是一对待验证的不同提交'])
    }
    for (const [side, evidence, pinned] of [['baseline', baseline, old], ['candidate', candidate, next]]) {
      eq(side + '.upstream.commit', evidence.upstream.commit.toLowerCase(), pinned.commit.toLowerCase())
      eq(side + '.upstream.baseline', evidence.upstream.baseline, pinned.version)
    }
    if (baseline.apk.apkSha256.toLowerCase() === candidate.apk.apkSha256.toLowerCase()) {
      mismatches.push('追版对照必须使用两份不同的 APK 制品')
    }
  }
  eq('apk.abi', normalizeAbi(baseline.apk.abi), normalizeAbi(candidate.apk.abi))
  for (const key of ENV_KEYS) {
    const left = baseline.environment[key]
    const right = candidate.environment[key]
    eq('environment.' + key, key.endsWith('Sha256') ? left.toLowerCase() : left,
      key.endsWith('Sha256') ? right.toLowerCase() : right)
  }
  if (mismatches.length) return inconclusive(mismatches, { mismatches })

  const counts = emptyCounts()
  const rows = []
  const reasons = []
  const baselineSamples = new Map(baseline.samples.map((sample) => [sample.id, sample]))
  const candidateSamples = new Map(candidate.samples.map((sample) => [sample.id, sample]))

  for (const id of baselineSamples.keys()) {
    if (!candidateSamples.has(id)) {
      counts.samplesMissing += 1
      reasons.push('候选缺样本：' + id + '（缺失要求的覆盖，判红）')
    }
  }
  for (const id of candidateSamples.keys()) {
    if (!baselineSamples.has(id)) {
      counts.samplesExtra += 1
      reasons.push('候选多出样本：' + id + '（两侧证据集不一致，无法比较）')
    }
  }

  for (const [id, left] of baselineSamples) {
    const right = candidateSamples.get(id)
    if (right === undefined) continue
    const sampleProblems = []
    const sampleEq = (label, a, b) => {
      if (a !== b) sampleProblems.push(id + ' ' + label + '：baseline=' + a + ' candidate=' + b)
    }
    sampleEq('plugin.name', left.plugin.name, right.plugin.name)
    sampleEq('plugin.version', left.plugin.version, right.plugin.version)
    sampleEq('plugin.artifactSha256', String(left.plugin.artifactSha256).toLowerCase(),
      String(right.plugin.artifactSha256).toLowerCase())
    sampleEq('config.patchSha256', String(left.config.patchSha256).toLowerCase(),
      String(right.config.patchSha256).toLowerCase())
    sampleEq('config.settingsSha256', String(left.config.settingsSha256).toLowerCase(),
      String(right.config.settingsSha256).toLowerCase())
    if (sampleProblems.length > 0) {
      // 样本身份漂移同样是“不可比”，必须进 mismatches：
      // 它和上游 SHA 漂移是同一类事实（换了东西就不是同一组对照），
      // 只写进 reasons 会让按 mismatches 判读的调用方误以为可比。
      counts.samplesIncomparable += 1
      mismatches.push(...sampleProblems)
      reasons.push(...sampleProblems)
      continue
    }
    counts.samples += 1

    const rightCases = new Map(right.cases.map((item) => [item.id, item]))
    for (const leftCase of left.cases) {
      const rightCase = rightCases.get(leftCase.id)
      if (leftCase.status === 'pass') counts.baselinePass += 1
      let outcome
      if (rightCase === undefined) outcome = 'missing'
      else if (leftCase.kind !== rightCase.kind) {
        outcome = 'divergent'
        reasons.push('用例类型变化：' + id + '/' + leftCase.id)
      }
      else if (leftCase.status === 'blocked' || leftCase.status === 'external'
        || leftCase.status === 'unmeasured') outcome = 'baselineUnusable'
      else if (leftCase.status === 'pass') {
        if (rightCase.status === 'pass') outcome = 'pass'
        else if (rightCase.status === 'fail') outcome = 'regression'
        else if (rightCase.status === 'blocked') outcome = 'blocked'
        else if (rightCase.status === 'external') outcome = 'external'
        else outcome = 'unmeasured'
      } else if (rightCase.status === 'pass') outcome = 'improved'
      else if (rightCase.status === 'fail') {
        outcome = leftCase.failureKey === rightCase.failureKey ? 'original' : 'changedFailure'
      }
      else if (rightCase.status === 'blocked') outcome = 'blocked'
      else if (rightCase.status === 'external') outcome = 'external'
      else outcome = 'unmeasured'

      counts[outcome] += 1
      counts.cases += 1
      rows.push({
        sample: id,
        id: leftCase.id,
        kind: leftCase.kind,
        baseline: leftCase.status,
        candidate: rightCase === undefined ? 'missing' : rightCase.status,
        baselineEvidence: leftCase.evidence ?? [],
        candidateEvidence: rightCase?.evidence ?? [],
        baselineFailure: leftCase.failureKey ?? null,
        candidateFailure: rightCase?.failureKey ?? null,
        outcome,
      })
    }

    const leftCases = new Map(left.cases.map((item) => [item.id, item]))
    for (const rightCase of right.cases) {
      if (leftCases.has(rightCase.id)) continue
      counts.divergent += 1
      reasons.push('候选多出用例：' + id + '/' + rightCase.id + '（两侧证据集不一致）')
      rows.push({
        sample: id,
        id: rightCase.id,
        kind: rightCase.kind,
        baseline: 'missing',
        candidate: rightCase.status,
        outcome: 'divergent',
      })
    }
  }

  // 基线一条都没通过时，“无回归”是空集恒真：必须显式判为不可下结论，
  // 且理由要写出来，否则报告会显示 INCONCLUSIVE 却不说明为什么。
  if (counts.baselinePass === 0) {
    reasons.push('基线没有任何通过的用例：没有可保护的功能面，不能判通过')
  }
  if (mismatches.length > 0 || counts.samplesIncomparable > 0) {
    return {
      verdict: 'INCONCLUSIVE',
      exitCode: 2,
      comparable: false,
      mismatches,
      reasons,
      counts,
      cases: rows,
    }
  }

  let verdict
  let exitCode
  if (counts.regression > 0 || counts.missing > 0 || counts.samplesMissing > 0) {
    verdict = 'FAIL'
    exitCode = 1
  } else if (counts.divergent > 0 || counts.external > 0 || counts.blocked > 0
    || counts.unmeasured > 0 || counts.baselineUnusable > 0 || counts.samplesExtra > 0
    || counts.changedFailure > 0) {
    verdict = 'INCONCLUSIVE'
    exitCode = 2
  } else if (counts.baselinePass === 0) {
    verdict = 'INCONCLUSIVE'
    exitCode = 2
  } else {
    verdict = 'PASS'
    exitCode = 0
  }
  return { verdict, exitCode, comparable: true, mismatches, reasons, counts, cases: rows }
}

/**
 * 文本报告。每一条非 pass 用例都单独列一行，避免“汇总绿了但某条没跑”的静默。
 * @param {object} result compareBundles 的返回值。
 * @param {object} meta 侧标签 { baseline, candidate }。
 * @returns {string} 可直接贴进 PR 的报告。
 */
export function renderReport(result, meta = {}) {
  const lines = ['PLUGIN-COMPAT EVIDENCE']
  if (meta.baseline) lines.push('  baseline  ' + meta.baseline)
  if (meta.candidate) lines.push('  candidate ' + meta.candidate)
  lines.push('  pairing   ' + (result.comparable ? 'COMPARABLE' : 'INCOMPARABLE'))
  const c = result.counts
  lines.push('  samples   compared=' + c.samples + ' missing=' + c.samplesMissing
    + ' extra=' + c.samplesExtra + ' incomparable=' + c.samplesIncomparable)
  lines.push('  cases     total=' + c.cases + ' baselinePass=' + c.baselinePass
    + ' pass=' + c.pass + ' regression=' + c.regression + ' original=' + c.original
    + ' improved=' + c.improved)
  lines.push('  evidence  external=' + c.external + ' blocked=' + c.blocked
    + ' unmeasured=' + c.unmeasured + ' missing=' + c.missing + ' divergent=' + c.divergent
    + ' baselineUnusable=' + c.baselineUnusable)
  for (const row of result.cases) {
    if (row.outcome === 'pass') continue
    lines.push('  - [' + row.outcome.toUpperCase() + '] ' + row.sample + '/' + row.id
      + ' (' + row.kind + ') baseline=' + row.baseline + ' candidate=' + row.candidate)
  }
  for (const reason of result.reasons) lines.push('  ! ' + reason)
  lines.push('  verdict   ' + result.verdict)
  lines.push('PLUGIN-COMPAT EVIDENCE ' + result.verdict
    + '（regression=' + c.regression + ' missing=' + c.missing + ' external=' + c.external
    + ' blocked=' + c.blocked + ' unmeasured=' + c.unmeasured + '）')
  return lines.join('\n')
}

function readBundle(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: path + '：' + String(error?.message ?? error) }
  }
}

function fixture() {
  return {
    schema: SCHEMA,
    side: 'baseline',
    label: 'fixture baseline',
    upstream: { repo: 'deepseek-harness', commit: 'a'.repeat(40), baseline: '0.2.2-rc.1' },
    apk: { abi: 'x86_64', versionName: '0.14.10', versionCode: 54, apkSha256: 'b'.repeat(64), snapshotFingerprint: 'f'.repeat(64) },
    environment: {
      androidApi: 34, webviewVersion: '120.0.0.0', emulator: true, deviceModel: 'MuMu',
      androidBuild: 'fixture-build', testPlanSha256: '1'.repeat(64),
    },
    samples: [{
      id: 'sample-theme',
      plugin: { name: 'dsh-theme-sample', version: '1.2.0', artifactSha256: 'c'.repeat(64) },
      config: { patchSha256: 'd'.repeat(64), settingsSha256: 'e'.repeat(64) },
      cases: [
        { id: 'install', kind: 'install', status: 'pass', evidence: ['fixture-install.log'] },
        { id: 'theme-render', kind: 'ui', status: 'pass', evidence: ['fixture-render.log'] },
      ],
    }],
  }
}

function runSelfTest() {
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const baseline = fixture()
  const candidate = clone(baseline)
  candidate.side = 'candidate'
  candidate.label = 'fixture candidate'
  candidate.apk.apkSha256 = '9'.repeat(64)

  const mutate = (fn) => {
    const copy = clone(candidate)
    fn(copy)
    return copy
  }
  const bothFail = clone(baseline)
  const failTheme = (b) => Object.assign(b.samples[0].cases[1], { status: 'fail', failureKey: 'fixture-render' })
  failTheme(bothFail)

  const cases = [
    ['positive: identical functional results -> PASS', baseline, candidate, 0],
    ['negative: baseline passes, candidate fails -> FAIL', baseline,
      mutate(failTheme), 1],
    ['negative: candidate blocked -> INCONCLUSIVE', baseline,
      mutate((b) => { b.samples[0].cases[1].status = 'blocked' }), 2],
    ['negative: candidate unmeasured -> INCONCLUSIVE', baseline,
      mutate((b) => { b.samples[0].cases[1].status = 'unmeasured' }), 2],
    ['negative: upstream commit differs -> INCONCLUSIVE', baseline,
      mutate((b) => { b.upstream.commit = '0'.repeat(40) }), 2],
    ['negative: ABI differs -> INCONCLUSIVE', baseline,
      mutate((b) => { b.apk.abi = 'arm64' }), 2],
    ['negative: plugin artifact hash differs -> INCONCLUSIVE', baseline,
      mutate((b) => { b.samples[0].plugin.artifactSha256 = '7'.repeat(64) }), 2],
    ['negative: config digest differs -> INCONCLUSIVE', baseline,
      mutate((b) => { b.samples[0].config.patchSha256 = '6'.repeat(64) }), 2],
    ['negative: candidate misses a case -> FAIL', baseline,
      mutate((b) => { b.samples[0].cases.pop() }), 1],
    ['negative: candidate misses a sample -> FAIL', baseline,
      mutate((b) => { b.samples = [] }), 1],
    ['positive: both fail -> PASS (original issue, not a regression)', bothFail,
      mutate(failTheme), 0],
  ]

  let bad = 0
  for (const [name, left, right, want] of cases) {
    const result = compareBundles(left, right)
    const ok = result.exitCode === want
    console.log((ok ? 'PASS  ' : 'FAIL  ') + 'self-test ' + name + ' -> ' + result.verdict
      + ' exit=' + result.exitCode + (ok ? '' : ' (want exit=' + want + ')'))
    if (!ok) bad += 1
  }
  console.log('PLUGIN-COMPAT EVIDENCE SELF-TEST ' + (bad === 0 ? 'PASSED' : 'FAILED'))
  process.exit(bad === 0 ? 0 : 1)
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    baseline: { type: 'string' }, candidate: { type: 'string' }, report: { type: 'string' },
    'upstream-audit': { type: 'string' }, json: { type: 'boolean' }, 'self-test': { type: 'boolean' },
  } })
  if (values['self-test']) { runSelfTest(); return }
  const baselinePath = values.baseline
  const candidatePath = values.candidate
  if (baselinePath === undefined || candidatePath === undefined) {
    console.error('用法：node scripts/verify-plugin-compat-evidence.mjs --baseline <a.json> --candidate <b.json>'
      + ' [--upstream-audit <upstream-report.json>] [--json] [--report <result.json>] [--self-test]')
    process.exit(2)
  }
  const left = readBundle(baselinePath)
  const right = readBundle(candidatePath)
  if (left.error !== undefined || right.error !== undefined) {
    const reasons = [left.error, right.error].filter(Boolean)
    for (const reason of reasons) console.error('PLUGIN-COMPAT EVIDENCE INCONCLUSIVE：' + reason)
    process.exit(2)
  }
  const auditPath = values['upstream-audit']
  const upstreamAudit = auditPath === undefined ? undefined : JSON.parse(readFileSync(auditPath, 'utf8'))
  const result = compareBundles(left.value, right.value, { upstreamAudit })
  const payload = {
    schema: SCHEMA,
    ...(auditPath === undefined ? {} : { comparison: 'upstream-adoption' }),
    baseline: { label: left.value?.label ?? baselinePath, upstream: left.value?.upstream, apk: left.value?.apk },
    candidate: { label: right.value?.label ?? candidatePath, upstream: right.value?.upstream, apk: right.value?.apk },
    ...result,
  }
  const reportPath = values.report
  if (reportPath !== undefined) {
    writeAtomic(reportPath, JSON.stringify(payload, null, 2) + '\n')
    console.error('report written: ' + reportPath)
  }
  if (values.json) console.log(JSON.stringify(payload, null, 2))
  else console.log(renderReport(result, {
    baseline: payload.baseline.label,
    candidate: payload.candidate.label,
  }))
  process.exit(result.exitCode)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error('PLUGIN-COMPAT EVIDENCE INCONCLUSIVE：' + error.message)
    process.exitCode = 2
  }
}
