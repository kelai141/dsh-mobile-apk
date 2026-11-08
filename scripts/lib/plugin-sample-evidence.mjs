// plugin-sample-evidence.mjs — 把设备适配器的单条结论并入兼容证据文件。
//
// 只做「填格子」：不产生结果、不猜状态。没有 --case 文件时该用例保持 unmeasured。
// 这样默认输入永远是未测，只有真的跑过适配器才会变成 pass / fail。
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 构造一份证据文件骨架。
 * @param {any} plan 样本计划。
 * @param {{side: string, label: string, apk: object, environment: object}} meta 证据元信息。
 * @returns {any} 证据对象，全部用例 unmeasured。
 */
export function buildEvidence(plan, meta) {
  return {
    schema: 1,
    side: meta.side,
    label: meta.label,
    upstream: { repo: 'deepseek-harness', commit: plan.engine.commit, baseline: plan.engine.baseline },
    apk: meta.apk,
    environment: meta.environment,
    samples: plan.samples.map((s) => ({
      id: s.id,
      plugin: { name: s.plugin.name, version: s.plugin.version, artifactSha256: s.plugin.artifactSha256 },
      config: { patchSha256: meta.patchSha256, settingsSha256: meta.settingsSha256 },
      cases: s.cases.map((c) => ({ id: c.id, kind: c.kind, status: 'unmeasured', evidence: [] })),
    })),
  }
}

/**
 * 把一条实测结论写进对应样本的对应用例。
 *
 * 目标不存在时抛错，不新建：防止把结论塞进一个清单里没有的样本。
 * @param {any} evidence 证据对象（会被就地修改）。
 * @param {string} sampleId 样本 id。
 * @param {any} entry 适配器产出的 cases[] 条目。
 * @returns {any} 修改后的证据对象。
 */
export function applyCase(evidence, sampleId, entry) {
  const sample = evidence.samples.find((s) => s.id === sampleId)
  if (sample === undefined) throw new Error('证据里没有样本 ' + sampleId)
  const index = sample.cases.findIndex((c) => c.id === entry.id)
  if (index < 0) throw new Error(sampleId + ' 没有用例 ' + entry.id + '（不允许新增用例，否则两侧用例集不同）')
  sample.cases[index] = { ...sample.cases[index], ...entry }
  return evidence
}

