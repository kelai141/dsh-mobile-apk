#!/usr/bin/env node
/**
 * B2 辅助：静态统计冷启动要激活多少条 Loader entry，并拆出本仓贡献了几条。
 *
 * 口径来源（仓库内权威）：scripts/check-boot-budget.mjs:63
 *   「支配项是上游引擎自身激活全部 ~193 条 Loader entry（模块编译/求值链）」
 * 本脚本回答：这 ~193 条里本仓能影响/削减的是哪几条、占多少比例。
 *
 * 输入：从 snapshot.tar.xz 里只抽出这几份装配清单（不解 191MB）：
 *   <root>/home/.dsh/profiles/web/package.json
 *   <root>/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml
 *   <root>/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml
 *   <root>/home/.dsh/profiles/web/cordis.patch.yml
 *
 * 解析规则（按 cordis.patch.yml 的实际书写形态，缩进有语义）：
 *   根序列 `- id: X`（第 0 列）        = 就地覆盖既有 entry（可配 disabled: true 关停）
 *   `- insert:` 段落内的 `- id: X`（缩进） = 新增一条 entry
 * 生效条目 = 新增的 ∪ 覆盖的，再扣掉 disabled: true 的，最后按 id 去重。
 *
 * 用法：node scripts/perf-audit-b/count-loader-entries.mjs <抽取根目录>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/count-loader-entries.mjs <抽取根目录>')
  process.exit(2)
}

const FILES = [
  { key: 'profile-package', path: join(root, 'home/.dsh/profiles/web/package.json'), kind: 'json' },
  {
    key: 'bundle-dsh-base',
    path: join(root, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),
    kind: 'yml',
  },
  {
    key: 'bundle-dsh-web-app',
    path: join(root, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'),
    kind: 'yml',
  },
  { key: 'repo-patch', path: join(root, 'home/.dsh/profiles/web/cordis.patch.yml'), kind: 'yml' },
]

/** 解析一份 cordis.patch.yml，返回 [{id, disabled, inserted, line}]。 */
function parsePatchYml(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let cur = null
  const flush = () => { if (cur !== null) { entries.push(cur); cur = null } }
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const stripped = raw.replace(/\s+#.*$/, '')
    if (stripped.trim() === '' || stripped.trimStart().startsWith('#')) continue
    const indent = stripped.length - stripped.trimStart().length
    const body = stripped.trim()
    const m = /^-\s+id:\s*(.+)$/.exec(body)
    if (m !== null) {
      flush()
      cur = { id: m[1].trim(), disabled: false, inserted: indent > 0, line: i + 1 }
      continue
    }
    if (cur !== null && /^disabled:\s*true\s*$/.test(body)) cur.disabled = true
  }
  flush()
  return entries
}

const report = { root, inputs: [], bundles: [], counts: {} }
const byFile = new Map()
for (const f of FILES) {
  const present = existsSync(f.path)
  report.inputs.push({ key: f.key, path: f.path, present })
  if (!present) continue
  const text = readFileSync(f.path, 'utf8')
  if (f.kind === 'json') {
    const j = JSON.parse(text)
    report.bundles = j.dsh?.profile?.bundles ?? []
    continue
  }
  byFile.set(f.key, parsePatchYml(text))
}

// 装配顺序：bundles 先、本仓 patch 后；同名 id 以最后一次出现为准（与 include 的 applyEntryPatches 一致）
const order = ['bundle-dsh-base', 'bundle-dsh-web-app', 'repo-patch'].filter((k) => byFile.has(k))
/** @type {Map<string, {id: string, disabled: boolean, inserted: boolean, file: string, line: number}>} */
const merged = new Map()
for (const key of order) {
  for (const e of byFile.get(key)) merged.set(e.id, { ...e, file: key })
}

const all = [...merged.values()]
const disabled = all.filter((e) => e.disabled)
const active = all.filter((e) => !e.disabled)
const repoAll = byFile.get('repo-patch') ?? []
const repoRaw = repoAll
const repoInsertedRaw = repoRaw.filter((e) => e.inserted)
const repoDisabledRaw = repoRaw.filter((e) => e.disabled)
const repoInsertedActive = repoInsertedRaw.filter((e) => merged.get(e.id)?.disabled !== true)

report.counts = {
  distinctIdsDeclared: all.length,
  distinctIdsDisabled: disabled.length,
  distinctIdsActive: active.length,
  repoDeclarationsRaw: repoRaw.length,
  repoInsertedRaw: repoInsertedRaw.length,
  repoDisabledRaw: repoDisabledRaw.length,
  repoInsertedStillActive: repoInsertedActive.length,
}
report.repoInsertIds = repoInsertedRaw.map((e) => ({ id: e.id, line: e.line, active: merged.get(e.id)?.disabled !== true }))
report.repoDisabledIds = repoDisabledRaw.map((e) => ({ id: e.id, line: e.line }))
report.overriddenByRepo = repoRaw.filter((e) => !e.inserted).map((e) => ({ id: e.id, line: e.line, disabled: e.disabled }))

process.stdout.write(JSON.stringify(report, null, 2) + '\n')

process.stderr.write([
  'bundles: ' + report.bundles.join(', '),
  '去重后 entry 声明 ' + all.length + ' · 关停 ' + disabled.length + ' · 生效 ' + active.length,
  '本仓 repo-patch: 原始声明 ' + repoRaw.length + '（insert ' + repoInsertedRaw.length
    + ' / 覆盖 ' + (repoRaw.length - repoInsertedRaw.length) + '）',
  '  其中 insert 且仍生效 ' + repoInsertedActive.length,
].join('\n') + '\n')
