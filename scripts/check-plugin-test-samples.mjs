#!/usr/bin/env node
// check-plugin-test-samples.mjs — 第三方插件测试样本清单的静态校验器。
//
// 它只校验「输入是否可信、是否覆盖到位、是否可复算」，不产生任何设备结果。
//
// 判据（任一不满足即判红）：
//   1) 结构：schema / engine / selection / samples 齐全，字段类型正确；
//   2) 数量与覆盖：样本数 >= minSamples，低热度样本数 >= minLowHeatSamples，
//      selection.requiredCategories 每个类别至少一个样本；
//   3) 版本固定：每个样本 version 必须是精确版本，不能是 range / latest / tag；
//   4) 来源可复算：artifactSha256 是 64 位十六进制，tarball 是 https 且含该精确版本，
//      integrity 是 sha512- 前缀且长度符合 base64；
//   5) 元数据自洽：mainExists / bundlePatchExists 必须为真，否则该包装上也静默不生效；
//   6) 用例：每个样本必须有 install 与 activate，用例 id 在清单内唯一，kind 非空；
//   7) 判据可观察：expect 必须描述可观察结果，禁止只写「通过」「OK」「正常」这类空话；
//   8) 热度数据带日期，且低热度判定用同一个口径。
//
// 用法：
//   node scripts/check-plugin-test-samples.mjs
//   node scripts/check-plugin-test-samples.mjs --plan <file.json> --json
//   node scripts/check-plugin-test-samples.mjs --emit-samples
//   node scripts/check-plugin-test-samples.mjs --self-test
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PLAN = join(HERE, 'plugin-test-samples.json')

const HEX64 = /^[0-9a-f]{64}$/i
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const VAGUE = /^(通过|pass|ok|okay|正常|成功|可以|能用|works?|fine)$/i

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 校验样本计划。
 * @param {unknown} plan 已解析的计划对象。
 * @returns {string[]} 问题清单；空数组 = 通过。
 */
export function validatePlan(plan) {
  const problems = []
  const push = (m) => problems.push(m)

  if (!isObject(plan)) return ['plan 不是 JSON 对象']
  if (plan.schema !== 1) push('schema 必须是 1')
  if (!nonEmpty(plan.capturedAt)) push('capturedAt 不能为空')
  if (!isObject(plan.observation)) push('缺 observation 对象')
  else {
    for (const key of ['clientGraph', 'hostInventory', 'toolSurface']) {
      if (!nonEmpty(plan.observation[key])) push('observation.' + key + ' 不能为空')
    }
  }

  if (!isObject(plan.engine)) push('缺 engine 对象')
  else {
    if (!nonEmpty(plan.engine.baseline)) push('engine.baseline 不能为空')
    if (!/^[0-9a-f]{40}$/i.test(String(plan.engine.commit ?? ''))) push('engine.commit 必须是 40 位十六进制')
  }

  const sel = plan.selection
  if (!isObject(sel)) push('缺 selection 对象')
  const minSamples = isObject(sel) && Number.isInteger(sel.minSamples) ? sel.minSamples : null
  if (minSamples === null) push('selection.minSamples 必须是整数')
  if (isObject(sel) && (!Number.isInteger(sel.lowHeatMaxMonthlyDownloads) || sel.lowHeatMaxMonthlyDownloads <= 0)) {
    push('selection.lowHeatMaxMonthlyDownloads 必须是正整数')
  }
  if (isObject(sel) && (!Number.isInteger(sel.minLowHeatSamples) || sel.minLowHeatSamples <= 0)) {
    push('selection.minLowHeatSamples 必须是正整数')
  }
  const required = isObject(sel) && Array.isArray(sel.requiredCategories) ? sel.requiredCategories : null
  if (required === null) push('selection.requiredCategories 必须是数组')
  else if (required.length === 0) push('selection.requiredCategories 不能为空')

  if (!Array.isArray(plan.samples)) return problems.concat(['samples 必须是数组'])
  if (minSamples !== null && plan.samples.length < minSamples) {
    push('样本数 ' + plan.samples.length + ' 少于 minSamples ' + minSamples)
  }

  const ids = new Set()
  const categories = new Set()
  let lowHeat = 0
  let hostOnly = 0

  for (const [i, s] of plan.samples.entries()) {
    const at = 'samples[' + i + ']'
    if (!isObject(s)) { push(at + ' 不是对象'); continue }
    if (!nonEmpty(s.id)) push(at + '.id 不能为空')
    else if (ids.has(s.id)) push(at + '.id 重复: ' + s.id)
    else ids.add(s.id)
    if (!nonEmpty(s.category)) push(at + '.category 不能为空')
    else categories.add(s.category)

    const plugin = s.plugin
    if (!isObject(plugin)) { push(at + ' 缺 plugin 对象'); continue }
    if (!nonEmpty(plugin.name)) push(at + '.plugin.name 不能为空')
    if (!EXACT_VERSION.test(String(plugin.version ?? ''))) {
      push(at + '.plugin.version 必须是精确版本，实际 ' + JSON.stringify(plugin.version))
    }
    if (!HEX64.test(String(plugin.artifactSha256 ?? ''))) push(at + '.plugin.artifactSha256 必须是 64 位十六进制')
    if (!Number.isInteger(plugin.artifactBytes) || plugin.artifactBytes <= 0) push(at + '.plugin.artifactBytes 必须是正整数')
    if (!Number.isInteger(plugin.unpackedSize) || plugin.unpackedSize <= 0) push(at + '.plugin.unpackedSize 必须是正整数')
    if (Number.isInteger(plugin.unpackedSize) && Number.isInteger(plugin.artifactBytes) && plugin.unpackedSize < plugin.artifactBytes) {
      push(at + '.plugin.unpackedSize 小于 artifactBytes，注册表字段可疑')
    }
    if (!INTEGRITY.test(String(plugin.integrity ?? ''))) push(at + '.plugin.integrity 必须是完整的 sha512 base64 摘要')
    const tarball = String(plugin.tarball ?? '')
    if (!/^https:\/\//.test(tarball)) push(at + '.plugin.tarball 必须是 https URL')
    if (nonEmpty(plugin.version) && !tarball.includes('-' + plugin.version + '.tgz')) {
      push(at + '.plugin.tarball 未指向固定版本 ' + plugin.version)
    }

    const src = s.source
    if (!isObject(src)) push(at + ' 缺 source 对象')
    else {
      if (!nonEmpty(src.kind)) push(at + '.source.kind 不能为空')
      if (!/^[0-9a-f]{40}$/i.test(String(src.gitHead ?? ''))) push(at + '.source.gitHead 必须是 40 位十六进制')
      if (!['verified', 'unresolvable'].includes(src.gitHeadStatus)) {
        push(at + '.source.gitHeadStatus 必须是 verified 或 unresolvable')
      }
      if (src.gitHeadStatus === 'unresolvable' && !(Array.isArray(s.notes) && s.notes.length > 0)) {
        push(at + ' gitHead 不可核但未在 notes 说明')
      }
    }

    const meta = s.metadata
    if (!isObject(meta)) push(at + ' 缺 metadata 对象')
    else {
      if (meta.mainExists !== true) push(at + '.metadata.mainExists 必须为 true（入口缺失即静默不生效）')
      if (meta.bundlePatchExists !== true) push(at + '.metadata.bundlePatchExists 必须为 true（否则只是普通依赖）')
      if (!nonEmpty(meta.bundlePatch)) push(at + '.metadata.bundlePatch 不能为空')
      if (!nonEmpty(meta.licenseField)) push(at + '.metadata.licenseField 不能为空')
      if (!['MIT', 'absent'].includes(meta.licenseFile)) push(at + '.metadata.licenseFile 必须是 MIT 或 absent')
      if (meta.licenseFile === 'absent' && !(Array.isArray(s.notes) && s.notes.some((n) => /LICENSE/i.test(n)))) {
        push(at + ' 包内缺 LICENSE 但未在 notes 说明')
      }
    }

    const heat = s.heat
    if (!isObject(heat)) push(at + ' 缺 heat 对象')
    else {
      if (!Number.isInteger(heat.monthlyDownloads) || heat.monthlyDownloads < 0) push(at + '.heat.monthlyDownloads 必须是非负整数')
      if (!Number.isInteger(heat.stars) || heat.stars < 0) push(at + '.heat.stars 必须是非负整数')
      if (!nonEmpty(heat.capturedAt)) push(at + '.heat.capturedAt 不能为空')
      if (isObject(sel) && Number.isInteger(sel.lowHeatMaxMonthlyDownloads)
        && Number.isInteger(heat.monthlyDownloads) && heat.monthlyDownloads <= sel.lowHeatMaxMonthlyDownloads) {
        lowHeat += 1
      }
    }

    if (!Array.isArray(s.cases) || s.cases.length === 0) { push(at + '.cases 必须是非空数组'); continue }
    const caseIds = new Set()
    for (const [j, c] of s.cases.entries()) {
      const cat = at + '.cases[' + j + ']'
      if (!isObject(c)) { push(cat + ' 不是对象'); continue }
      if (!nonEmpty(c.id)) push(cat + '.id 不能为空')
      else if (caseIds.has(c.id)) push(cat + '.id 在样本内重复: ' + c.id)
      else caseIds.add(c.id)
      if (!nonEmpty(c.kind)) push(cat + '.kind 不能为空')
      const expect = String(c.expect ?? '').trim()
      if (!nonEmpty(expect)) push(cat + '.expect 不能为空')
      else if (VAGUE.test(expect)) push(cat + '.expect 太空泛，必须写可观察结果: ' + JSON.stringify(expect))
      else if (expect.length < 12) push(cat + '.expect 太短，无法据此判定: ' + JSON.stringify(expect))
      // __DSH_BOOT__ 的条目图是 entries 数组，元素 id 取自补丁行 id。
      // 历史上写成 ids（数组）或拿包名去比 id 都会得到恒假的判据。
      else if (/__DSH_BOOT__\.ids\b/.test(expect)) push(cat + '.expect 引用了不存在的 __DSH_BOOT__.ids：该全局是 entries 数组')
      else if (/__DSH_BOOT__\.entries/.test(expect) && /含该包名|包含该包名/.test(expect)) {
        push(cat + '.expect 拿包名去比 entries 条目：entries[].id 是补丁行 id，包名在 url 里')
      }
    }
    // 装配判据分两面：宿主实例必须有；客户端条目只在包声明了 dsh.client 时才要求。
    // 服务端工具类插件没有客户端条目是正常形态，不能因此判缺测。
    if (!caseIds.has('install')) push(at + '.cases 缺必备用例 install')
    if (!caseIds.has('activate-host')) push(at + '.cases 缺必备用例 activate-host')
    const surfaces = s.surfaces
    if (!isObject(surfaces)) push(at + ' 缺 surfaces 对象')
    else {
      const hasClient = nonEmpty(surfaces.client)
      if (!hasClient) hostOnly += 1
      if (hasClient && !caseIds.has('activate-client')) {
        push(at + ' 声明了客户端入口 ' + surfaces.client + '，但缺 activate-client 用例')
      }
      if (!hasClient && caseIds.has('activate-client')) {
        push(at + ' 没有客户端入口，却有 activate-client 用例（会得到不可判定的空断言）')
      }
      if (hasClient) {
        const ids = surfaces.clientEntryIds
        if (!Array.isArray(ids) || ids.length === 0) push(at + '.surfaces.clientEntryIds 必须是非空数组（客户端条目 id 来自补丁行）')
        else if (ids.some((x) => !nonEmpty(x))) push(at + '.surfaces.clientEntryIds 含空值')
        else if (ids.includes(s.plugin.name) && surfaces.clientEntryIdsSameAsPackage !== true) {
          // 行 id 与包名同名是真实形态（补丁里写 - id: 包名），但必须显式登记，
          // 否则与「把包名当 id 猜」无法区分。
          push(at + '.surfaces.clientEntryIds 与包名同名 ' + s.plugin.name + '：若补丁行确实同名，必须置 clientEntryIdsSameAsPackage=true')
        }
      }
      if (!Array.isArray(surfaces.tools)) push(at + '.surfaces.tools 必须是数组')
    }
  }

  if (isObject(sel) && Number.isInteger(sel.minLowHeatSamples) && lowHeat < sel.minLowHeatSamples) {
    push('低热度样本 ' + lowHeat + ' 个，少于 minLowHeatSamples ' + sel.minLowHeatSamples)
  }
  if (required) {
    for (const cat of required) {
      if (!categories.has(cat)) push('缺少必需类别: ' + cat)
    }
  }
  // 必须至少有一个没有客户端条目的样本：否则「服务端工具没有 entries 也是正常」这条判据
  // 永远不会被样本真正压到，写成文档也只是空话。
  if (isObject(sel) && sel.requireHostOnlySample === true && hostOnly === 0) {
    push('缺 host-only 样本：至少要有一个不声明 dsh.client 的样本，用来验证服务端工具没有客户端条目也属正常')
  }

  return problems
}

/**
 * 构造证据骨架：把计划里的样本映射为 compare 脚本可消费的 samples[]。
 * 所有用例一律 unmeasured —— 没有实测就不能写成 pass。
 * @param {any} plan 已校验的计划。
 * @returns {any[]} 证据样本骨架。
 */
export function toEvidenceSamples(plan) {
  return plan.samples.map((s) => ({
    id: s.id,
    plugin: { name: s.plugin.name, version: s.plugin.version, artifactSha256: s.plugin.artifactSha256 },
    cases: s.cases.map((c) => ({ id: c.id, kind: c.kind, status: 'unmeasured', evidence: [] })),
  }))
}

const readPlan = (file) => JSON.parse(readFileSync(file, 'utf8'))

const selfTest = () => {
  const base = readPlan(DEFAULT_PLAN)
  const clone = () => JSON.parse(JSON.stringify(base))
  const results = []
  const expectPass = (name, plan) => {
    const p = validatePlan(plan)
    results.push({ name, ok: p.length === 0, problems: p })
  }
  const expectFail = (name, plan, needle) => {
    const p = validatePlan(plan)
    const ok = p.length > 0 && (!needle || p.some((x) => x.includes(needle)))
    results.push({ name, ok, problems: p })
  }

  expectPass('正样本：当前清单', clone())

  let m = clone(); m.samples[0].plugin.version = '^0.18.0'
  expectFail('负控：版本写成 range', m, '精确版本')

  m = clone(); m.samples[0].plugin.integrity = 'sha512-short'
  expectFail('负控：integrity 截断', m, 'integrity')

  m = clone(); m.samples[0].metadata.mainExists = false
  expectFail('负控：入口文件缺失', m, 'mainExists')

  m = clone(); m.samples[0].metadata.bundlePatchExists = false
  expectFail('负控：bundle patch 缺失', m, 'bundlePatchExists')

  m = clone(); m.samples[0].cases[2].expect = '通过'
  expectFail('负控：判据空泛', m, '空泛')

  m = clone(); m.samples[0].cases = m.samples[0].cases.filter((c) => c.id !== 'activate-host')
  expectFail('负控：缺宿主装配用例', m, 'activate-host')

  m = clone(); m.samples[0].cases = m.samples[0].cases.filter((c) => c.id !== 'activate-client')
  expectFail('负控：声明了客户端入口却缺条目用例', m, 'activate-client')

  m = clone()
  m.samples[3].surfaces.client = null
  m.samples[3].surfaces.clientEntryIds = []
  m.samples[3].cases.push({ id: 'activate-client', kind: 'activate', expect: '冷启动后 window.__DSH_BOOT__.entries 里存在该插件的条目' })
  expectFail('负控：无客户端入口却写条目用例', m, '没有客户端入口')

  m = clone()
  m.samples[0].surfaces.clientEntryIds = [m.samples[0].plugin.name]
  expectFail('负控：拿包名当 entries id', m, '与包名同名')

  m = clone()
  m.samples[0].cases[1].expect = '冷启动后 window.__DSH_BOOT__.ids 含该包名'
  expectFail('负控：引用不存在的 __DSH_BOOT__.ids', m, '__DSH_BOOT__.ids')

  m = clone()
  m.samples[0].cases[1].expect = '冷启动后 window.__DSH_BOOT__.entries 里含该包名'
  expectFail('负控：用包名比 entries 条目', m, '补丁行 id')

  m = clone(); delete m.observation
  expectFail('负控：缺可观察面说明', m, 'observation')

  m = clone()
  m.samples = m.samples.filter((s) => typeof s.surfaces.client === 'string')
  m.selection.requiredCategories = m.selection.requiredCategories.filter((c) => c !== 'host-tools')
  expectFail('负控：没有 host-only 样本', m, 'host-only')

  m = clone(); m.samples[1].id = m.samples[0].id
  expectFail('负控：样本 id 重复', m, '重复')

  m = clone(); m.samples = m.samples.slice(0, 5)
  expectFail('负控：样本数不足', m, 'minSamples')

  m = clone(); m.samples.forEach((s) => { s.heat.monthlyDownloads = 90000 })
  expectFail('负控：低热度覆盖不足', m, '低热度')

  m = clone(); m.selection.requiredCategories.push('video')
  expectFail('负控：缺必需类别', m, 'video')

  m = clone(); m.samples[7].notes = []; m.samples[7].source.gitHeadStatus = 'unresolvable'
  expectFail('负控：gitHead 不可核却无说明', m, 'gitHead 不可核')

  m = clone(); m.samples[4].notes = []; m.samples[4].metadata.licenseFile = 'absent'
  expectFail('负控：缺 LICENSE 却无说明', m, 'LICENSE')

  m = clone(); m.samples[0].plugin.tarball = m.samples[0].plugin.tarball.replace('0.18.83', '0.18.84')
  expectFail('负控：tarball 指向别的版本', m, 'tarball')

  const evidence = toEvidenceSamples(base)
  const allUnmeasured = evidence.every((s) => s.cases.every((c) => c.status === 'unmeasured' && c.evidence.length === 0))
  results.push({ name: '骨架全部为 unmeasured', ok: allUnmeasured, problems: [] })

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' :: ' + r.problems.slice(0, 2).join(' / ')))
  }
  console.log(failed.length === 0
    ? 'PLUGIN-TEST-SAMPLES SELF-TEST PASS (' + results.length + ' cases)'
    : 'PLUGIN-TEST-SAMPLES SELF-TEST FAIL (' + failed.length + '/' + results.length + ')')
  process.exitCode = failed.length === 0 ? 0 : 1
}

const main = () => {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      json: { type: 'boolean', default: false },
      'emit-samples': { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
    },
  })
  if (values['self-test']) return selfTest()

  const file = values.plan ? resolve(values.plan) : DEFAULT_PLAN
  const plan = readPlan(file)
  const problems = validatePlan(plan)
  if (problems.length === 0 && values['emit-samples']) {
    console.log(JSON.stringify(toEvidenceSamples(plan), null, 2))
    return
  }
  const lowHeat = plan.samples.filter((s) => s.heat.monthlyDownloads <= plan.selection.lowHeatMaxMonthlyDownloads).length

  if (values.json) {
    console.log(JSON.stringify({ file, ok: problems.length === 0, samples: plan.samples.length, lowHeat, problems }, null, 2))
  } else if (problems.length === 0) {
    console.log('PLUGIN-TEST-SAMPLES OK（samples=' + plan.samples.length + ' lowHeat=' + lowHeat + '）')
  } else {
    for (const p of problems) console.log('FAIL ' + p)
    console.log('PLUGIN-TEST-SAMPLES FAIL（problems=' + problems.length + '）')
  }
  process.exitCode = problems.length === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
