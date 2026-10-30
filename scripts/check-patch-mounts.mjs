#!/usr/bin/env node
// check-patch-mounts.mjs — 权威 patch 挂载集 vs 注入集**双向**校验（防 P1-F2 类回归 + ST-06 反向缺席）。
//
// 背景（2026-08-23 审校 C4）：profile-web.cordis.patch.yml 曾缺 android-linux-env——
// inject-snapshot.py 把它注进快照但 patch 未挂载 → 功能静默不装载，且 update-snapshot-patch.py
// 不校验该方向，门禁拦不住。本脚本补上：patch 中 `name:` 包名集合必须 ⊇ 注入包集合。
//
// 反向差集（0.13.8-b ST-06 / F-ENV-05）：只做单向 `注入 ⊆ 挂载` 抓不到相反方向——
// 从注入清单（scripts/plugin-dirs.json）删掉一个包而权威 patch 仍挂载它时，快照里那个包
// 就不再被注入（或注入旧版），上游只报「模块找不到」，而单向门禁**全绿**。
// 判定：挂载集里的**本仓注入面**必须都在注入集内。`@deepseek-ai/*` 由引擎树自带（不在注入集
// 内，属合法差异）；其余挂载项（`@dsh-android/*` 与 vendor 固化包）都是本仓注入面。
//
// 0.14.2（D12）条目级解析：旧实现用 `/^\s+name:` 抓任意深度的 `name:`，于是设备实装的 patch
// （带 `- id: llm-pi-ai` + 36 个模型定义）会把 36 个**模型显示名**（`MiMo 2.5` 等）读成
// 挂载包 → 直接跑设备文件**误报 39 项**、exit 1。现在只认**装配条目**（与壳侧
// `PluginMounts.entryNames` / `FactoryProfilePatch.blockIds` 同源判据）：
//   - 顶层条目 = 列 0 的 `- id:` / `- name:`；其余键（含 `name:`）按「键缩进 = 0 + 2」归属该条目；
//   - insert 组的一层子条目 = 组内**最浅缩进**的 `- id:` / `- name:`；`name:` 限于「子条目缩进 + 2」；
//   - 配置块内更深的 `id:` / `name:` 不是条目，不计入。
//
// 用法：node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...
//       加 --self-test 跑内置正反控（不读文件）。
// 退出码：0 = 双向一致；1 = 任一方向有缺失（打印缺失清单）；2 = 用法错误。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const TOP_ITEM = /^-(?:\s|$)/
const TOP_ENTRY = /^(?:-\s+id:|-\s+name:)/
const ENTRY_ITEM = /^(\s*)-\s+(id|name):\s*(.*)$/
const KEY_NAME = /^(\s*)name:\s*(.*)$/

/** SKIP 计数器（check-gate-skips.mjs 要求每条 SKIP 行自带 (#n) 计数）。 */
let skipped = 0

/** 去掉 YAML 标量的引号与行尾注释。 */
function scalar(value) {
  let v = String(value).trim()
  const hash = v.indexOf(' #')
  if (hash >= 0) v = v.slice(0, hash).trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
  return v.trim()
}

/**
 * 从 patch 文本提取**插件条目**：返回 `{ id, name }` 数组（name 缺失时为 null）。
 *
 * 判据见文首注释。纯函数、无副作用，供 `--self-test` 与真检共用。
 * @param text - patch 文件全文。
 * @returns 条目数组，按出现顺序。
 */
export function parseEntries(text) {
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  let current = null
  for (const line of lines) {
    if (TOP_ITEM.test(line)) {
      current = { head: line, lines: [line] }
      blocks.push(current)
    } else if (current !== null) {
      current.lines.push(line)
    }
  }
  const entries = []
  for (const block of blocks) {
    /* 组头认 YAML 注释（#1036 复现 4）：原来要求**裸** `- insert:`，于是
     * `- insert:  # group` 不被当成 insert 组 ⇒ 整组子条目一条都不解析 ⇒ 11 个注入包
     * 全部报「缺少挂载」。一个纯注释就能让整组从判据里消失，而这既不是语法错误也不是
     * 真实缺挂载——它是**判据只认一种写法**。判法：剥掉行尾注释再比对。 */
    const headNoComment = block.head.replace(/\s+#.*$/, '').trimEnd()
    const isInsert = /^-\s+insert:\s*$/.test(headNoComment)
    let entryIndent = 0
    if (isInsert) {
      let min = -1
      for (const line of block.lines) {
        const m = ENTRY_ITEM.exec(line)
        if (m === null) continue
        const indent = m[1].length
        if (indent === 0) continue
        if (min < 0 || indent < min) min = indent
      }
      if (min < 0) continue
      entryIndent = min
    } else if (!TOP_ENTRY.test(headNoComment)) {
      continue
    }
    let entry = null
    for (const line of block.lines) {
      const m = ENTRY_ITEM.exec(line)
      if (m !== null && m[1].length === entryIndent) {
        entry = { id: null, name: null }
        if (m[2] === 'id') entry.id = scalar(m[3])
        else entry.name = scalar(m[3])
        entries.push(entry)
        continue
      }
      if (entry === null) continue
      const k = KEY_NAME.exec(line)
      if (k !== null && k[1].length === entryIndent + 2 && entry.name === null) entry.name = scalar(k[2])
    }
  }
  return entries.filter((e) => e.id !== null || e.name !== null)
}

/** 条目名集合（只认条目，不认配置块内的显示名）。遍历用；重数与 id 判据见 entryProblems。 */
export function mountedNames(text) {
  const out = new Set()
  for (const entry of parseEntries(text)) if (entry.name !== null && entry.name !== '') out.add(entry.name)
  return out
}

/**
 * 条目级**集合退化**判据（#1036 复现 1/2/5）：只比包名 Set 会丢掉重数，也完全不看 id。
 *
 * 三件事在 Set 里全部不可见，而它们在**装配期**是硬冲突（cordis 按 id 定位条目）：
 *   · 同一 **id** 出现两次 —— 后者只覆盖/抢占前者，先挂的那个静默不生效；
 *   · 同一 **包名** 挂两次 —— 同一插件被装配两遍（服务重复注册 / 工具面重复）；
 *   · 一个 id 只出现一次但被两个**不同**包名共用 —— 同上，第一个静默让位。
 * 这三种形态的共同点：包名集合完全正确，双向差集一条不报，门禁全绿，而设备上少一块或双注册。
 *
 * @param text patch 文件全文。
 * @returns 问题描述数组（空数组 = 无冲突）。
 */
export function entryProblems(text) {
  const problems = []
  const ids = new Map()
  const names = new Map()
  for (const entry of parseEntries(text)) {
    if (entry.id !== null && entry.id !== '') ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1)
    if (entry.name !== null && entry.name !== '') names.set(entry.name, (names.get(entry.name) ?? 0) + 1)
  }
  for (const [id, n] of ids) if (n > 1) problems.push('条目 id 重复 ' + n + ' 次: ' + id + '（cordis 按 id 定位，后者抢前者，先挂的静默不生效）')
  for (const [name, n] of names) if (n > 1) problems.push('包名重复挂载 ' + n + ' 次: ' + name + '（同一插件被装配两遍 = 服务/工具面重复注册）')
  return problems
}

/**
 * `@deepseek-ai/*` 前缀豁免的**边界**（#1036 复现 3）。
 *
 * 原实现是 `!n.startsWith('@deepseek-ai/')` 就豁免——于是 patch 里挂一个全仓不存在的
 * `@deepseek-ai/dsh-retired-xyz` 也全绿：上游删包后留下的空挂载没有任何人说话，
 * 设备上那一行只是「找不到模块」，而门禁说「双向一致」。
 * 边界 = 引擎 overlay 的 packages 清单（`scripts/snapshot-config/engine-overlay.json`）——
 * 那正是注入链要装进快照的引擎包集合，是这条豁免唯一有据可依的判据。
 *
 * @param names 挂载包名。
 * @param known 引擎 overlay 登记的 @deepseek-ai 包名集合（读不到时传 null ⇒ 不判，由调用方报 SKIP）。
 * @returns 前缀合法但 overlay 里没有的包名。
 */
export function unknownEnginePackages(names, known) {
  if (known === null) return []
  return [...names].filter((n) => n.startsWith('@deepseek-ai/') && !known.has(n))
}

if (process.argv.includes('--self-test')) {
  // 正控：条目形态（顶层行 / insert 子条目 / 引号）都要认出来；
  // 反控：配置块内的 id/name（llm-pi-ai 的模型表）一个都不许进集合。
  const fixture = [
    '# comment',
    '- id: bash-sandbox',
    '  disabled: true',
    '- insert:',
    "    - id: shell-termux",
    "      name: '@dsh-android/dsh-shell-termux'",
    '    - id: host-web-compat',
    "      name: '@dsh-android/dsh-host-web-compat'",
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        models:',
    '          - id: mimo-v2.5',
    '            name: MiMo 2.5',
    '            contextWindow: 262144',
    '- id: office-to-pdf',
    '  disabled: true',
  ].join('\n')
  const got = mountedNames(fixture)
  const want = new Set(['@dsh-android/dsh-shell-termux', '@dsh-android/dsh-host-web-compat', '@deepseek-ai/dsh-llm-pi-ai'])
  const missing = [...want].filter((x) => !got.has(x))
  const extra = [...got].filter((x) => !want.has(x))
  const cases = []
  cases.push(['条目形态与配置块内显示名', missing.length === 0 && extra.length === 0 && got.size === 3,
    '条目名 ' + got.size + ' / 期望 3；缺 ' + JSON.stringify(missing) + '；多 ' + JSON.stringify(extra)])

  /* ── #1036：四条「Set 看不见」的形态 ────────────────────────────────────────
   * 这四条的共同点是**包名集合完全正确**，而装配期行为已经错了：
   * id 冲突 / 包名挂两次 / 前缀豁免挂不存在的包 / 组头带注释让整组消失。
   * 前三条在原实现里全绿（Set 丢掉重数，也没人看 id），第四条整组不解析 ⇒ 反方向假红。 */
  const TWO_GROUPS = [
    '- insert:',
    "    - id: shell-termux",
    "      name: '@dsh-android/dsh-shell-termux'",
    '- insert:',
    "    - id: host-web-compat",
    "      name: '@dsh-android/dsh-host-web-compat'",
  ].join('\n')
  cases.push(['#1036 合规双 insert 组：无条目级冲突', entryProblems(TWO_GROUPS).length === 0, JSON.stringify(entryProblems(TWO_GROUPS))])

  const dupId = TWO_GROUPS.replace('- insert:\n    - id: host-web-compat', '- insert:\n    - id: shell-termux')
  cases.push(['#1036 反证：两个条目同一个 id ⇒ 判红（cordis 按 id 定位，后者抢前者）',
    entryProblems(dupId).some((p) => p.includes('条目 id 重复')), JSON.stringify(entryProblems(dupId))])

  const dupName = TWO_GROUPS.replace("    - id: host-web-compat\n      name: '@dsh-android/dsh-host-web-compat'",
    "    - id: host-web-compat-dup\n      name: '@dsh-android/dsh-shell-termux'")
  cases.push(['#1036 反证：同一包名挂两次 ⇒ 判红（同一插件装配两遍）',
    entryProblems(dupName).some((p) => p.includes('包名重复挂载')), JSON.stringify(entryProblems(dupName))])

  const commentedHead = '- insert:  # group\n    - id: shell-termux\n      name: \'@dsh-android/dsh-shell-termux\''
  cases.push(['#1036 反证：insert 组头带 YAML 注释 ⇒ 子条目仍要解析出来（原实现整组消失）',
    mountedNames(commentedHead).has('@dsh-android/dsh-shell-termux'), JSON.stringify([...mountedNames(commentedHead)])])

  const engineNames = new Set(['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-base'])
  cases.push(['#1036 反证：@deepseek-ai/* 前缀无边界 ⇒ 挂未登记包判红',
    unknownEnginePackages(new Set(['@deepseek-ai/dsh-retired-xyz']), engineNames).length === 1,
    JSON.stringify(unknownEnginePackages(new Set(['@deepseek-ai/dsh-retired-xyz']), engineNames))])
  cases.push(['#1036 放行例：@deepseek-ai/* 前缀在 overlay 清单内 ⇒ 不判红',
    unknownEnginePackages(new Set(['@deepseek-ai/dsh-base']), engineNames).length === 0,
    JSON.stringify(unknownEnginePackages(new Set(['@deepseek-ai/dsh-base']), engineNames))])
  cases.push(['#1036 放行例：非 @deepseek-ai 包不受前缀豁免边界约束（由双向差集判定）',
    unknownEnginePackages(new Set(['@dsh-android/x', 'dshmarketplace-plugin']), engineNames).length === 0,
    JSON.stringify(unknownEnginePackages(new Set(['@dsh-android/x', 'dshmarketplace-plugin']), engineNames))])

  let bad = 0
  for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  -> ' + detail))
    if (!ok) bad += 1
  }
  console.log(bad === 0
    ? 'PATCH-MOUNTS SELF-TEST PASSED（' + cases.length + ' 项）'
    : 'PATCH-MOUNTS SELF-TEST FAILED（' + bad + '/' + cases.length + ' 项）')
  if (bad !== 0) process.exit(1)
  process.exit(0)
}
const [patchPath, ...dirs] = process.argv.slice(2)
if (!patchPath || dirs.length === 0) {
  console.error('用法: node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...')
  process.exit(2)
}

const patch = readFileSync(patchPath, 'utf8')
// patch 挂载集：**插件条目**的 `name:` 包名（含 `@scope/` 形式；配置块内的显示名不计）。
const mounted = mountedNames(patch)

/* 条目级集合退化（id 重复 / 包名重复挂载）：包名 Set 看不见，双向差集也一条不报。 */
const entryIssues = entryProblems(patch)

/* @deepseek-ai/* 的豁免边界：以引擎 overlay 的 packages 清单为准。
 * overlay 读不到时不判（SKIP 计数），而不是默默放行——「判据看不见输入」必须显式说出来。 */
const OVERLAY = join(dirname(fileURLToPath(import.meta.url)), 'snapshot-config', 'engine-overlay.json')
let engineKnown = null
if (existsSync(OVERLAY)) {
  try {
    engineKnown = new Set(Object.keys(JSON.parse(readFileSync(OVERLAY, 'utf8')).packages ?? {}))
  } catch { engineKnown = null }
}
if (engineKnown === null) {
  skipped += 1
  console.log('SKIP(#' + skipped + ') @deepseek-ai/* 豁免边界未判（引擎 overlay 不在场或不可解析：snapshot-config/engine-overlay.json）')
}
const ghostEngine = unknownEnginePackages(mounted, engineKnown)

const injected = new Set()
for (const d of dirs) {
  try {
    const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    injected.add(pkg.name)
  } catch {
    injected.add(d.split(/[\\/]/).pop())
  }
}

// 正向：注入集 ⊆ 挂载集（注入进快照却未挂载 = 功能静默不装载）
const missing = [...injected].filter((n) => !mounted.has(n))
// 反向：挂载集 ∩ 本仓注入面 ⊆ 注入集（挂载了但清单/调用方没注入 = 装配失败或旧版残留）
const ENGINE_SCOPE = '@deepseek-ai/'
const unmounted = [...mounted].filter((n) => !injected.has(n) && !n.startsWith(ENGINE_SCOPE))

if (entryIssues.length > 0) {
  for (const p of entryIssues) console.error('patch 条目级冲突: ' + p)
}
if (ghostEngine.length > 0) {
  console.error('@deepseek-ai/* 挂载了引擎 overlay 里不存在的包: ' + ghostEngine.join(', '))
  console.error('（上游删包/改名后留下的空挂载：设备上那一行只会「找不到模块」，'
    + '而包名双向差集一条都不报。核对 scripts/snapshot-config/engine-overlay.json 的 packages，'
    + '确认包名后再决定是改名还是删条目）')
}

if (missing.length === 0 && unmounted.length === 0 && entryIssues.length === 0 && ghostEngine.length === 0) {
  // 收口行带 SKIP= 是 check-gate-skips 的纪律：本脚本有「引擎 overlay 不在场」这一处 SKIP，
  // 汇总必须把它的计数写出来，否则聚合链分不清「没有 SKIP」与「SKIP 了但没人记」。
  console.log('patch mounts ok (双向 + 条目级): ' + injected.size + ' 个注入包全部挂载（' + [...injected].sort().join(', ') + '）'
    + '；条目 ' + parseEntries(patch).length + ' 条无 id/包名冲突'
    + (engineKnown === null ? '' : '；@deepseek-ai 前缀 ' + engineKnown.size + ' 个包内有界')
    + '；SKIP=' + skipped)
  process.exit(0)
}
if (missing.length > 0) {
  console.error('patch 挂载集缺少注入包: ' + missing.join(', '))
  console.error('（注入进快照却未挂载 = 功能静默不装载；请补 profile-web.cordis.patch.yml 条目）')
}
if (unmounted.length > 0) {
  console.error('权威 patch 挂载了注入面之外的包（反向差集）: ' + unmounted.join(', '))
  console.error('（清理单里删了包/patch 多挂了条目 = 快照缺该包或版本停留旧值；'
    + '请把包补回 scripts/plugin-dirs.json 对应链，或从 profile-web.cordis.patch.yml 删条目）')
}
process.exit(1)